/**
 * core/economy-service.js
 *
 * A porta única do dinheiro. Todo septim que muda de titular passa por aqui.
 *
 * ─── Como isto se relaciona com o transaction-service ───────────────────────
 *
 * O `core/transaction-service.js` continua sendo o **motor** de
 * `characters.gold` — ele é o único arquivo que escreve aquela coluna, e nada
 * aqui desfaz isso. O que muda é quem fica no topo:
 *
 *     modulo de dominio  →  economy-service  →  transaction-service.tx.*
 *                                            →  tesouros (cities/holds/...)
 *                                            →  economy_escrow
 *
 * Módulo de domínio (governança, barraca, contrato, aluguel) chama **este**
 * arquivo. Chamar `tx.applyGoldDelta` direto continua funcionando e continua
 * errado: são as primitivas do motor, não a API da economia.
 *
 * ─── O que este arquivo resolve ────────────────────────────────────────────
 *
 * Decisão: `docs/technical/ADR_004_ECONOMY_ACCOUNTS_AND_LEDGER.md`
 * Evidência: `docs/research/ECONOMY_FRAMEWORK_AUDIT.md`
 *
 *   Achado 1  — o ledger passa a nomear os dois lados, com `transfer_id`.
 *   Achado 2  — tesouro deixa de ser `UPDATE` solto e ganha ledger.
 *   Achado 7  — resultado tipado: recusa é `{ok:false, code}`, falha de
 *               infraestrutura **lança**. `false` nunca mais significa três
 *               coisas.
 *   Achado 10 — travas em ordem canônica, não na ordem "pagador, recebedor".
 *   Achado 11 — `escrow` é um titular de verdade, capaz de segurar valor.
 *
 * ─── Conta é uma referência, não uma linha de saldo ────────────────────────
 *
 * `{ type, ref }`. O serviço resolve o par para onde o saldo realmente mora —
 * não existe tabela `accounts` duplicando valor que já existe (ADR 004 §2.1 e
 * a alternativa rejeitada §4.1).
 */

const crypto = require('crypto');
const database = require('../database');
const transactionService = require('./transaction-service');
const serverOptions = require('./server-options');

const MODULE_DEFAULT = 'economy';

/**
 * Onde o saldo de cada tipo de titular realmente mora.
 *
 * ─── Por que é uma lista fechada ───────────────────────────────────────────
 *
 * `_lockBalance` e `_applyDelta` interpolam nome de tabela e de coluna no SQL —
 * um `?` não funciona para identificador. A lista fechada é o que torna essa
 * interpolação segura por construção: nenhum nome vindo de payload, de
 * configuração ou de módulo chega ao SQL. Um titular novo entra editando este
 * objeto, sob revisão. Mesmo critério do `STACK_TABLES` do transaction-service.
 */
const ACCOUNT_KINDS = Object.freeze({
  character: Object.freeze({ table: 'characters', keyColumn: 'id', balanceColumn: 'gold', numericRef: true }),
  city: Object.freeze({ table: 'cities', keyColumn: 'id', balanceColumn: 'treasury', numericRef: false }),
  hold: Object.freeze({ table: 'holds', keyColumn: 'id', balanceColumn: 'treasury', numericRef: false }),
  faction: Object.freeze({ table: 'factions', keyColumn: 'id', balanceColumn: 'treasury', numericRef: true }),
  realm: Object.freeze({ table: 'realms', keyColumn: 'id', balanceColumn: 'treasury', numericRef: false }),
  escrow: Object.freeze({ table: 'economy_escrow', keyColumn: 'escrow_id', balanceColumn: 'balance', numericRef: false })
});

/**
 * `system` é a fronteira declarada por onde ouro entra e sai do mundo: ouro
 * inicial de whitelist, penalidade de morte, ajuste de staff, venda para NPC.
 *
 * Ele **não tem saldo** de propósito — não há coluna, e `SUM(delta)` de
 * `system` não bate com nada. O que ele dá é a lista completa de criação e
 * destruição de septim, que é o que faltava: hoje a penalidade de morte
 * destrói patrimônio sem contraparte, e um dreno não declarado é
 * indistinguível de ouro sumindo por bug (auditoria §9).
 */
const SYSTEM_TYPE = 'system';

const MAX_AMOUNT = transactionService.tx.MAX_GOLD;

const ESCROW_PURPOSES = Object.freeze(['contract', 'auction', 'rent_deposit', 'wager']);

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalização de entrada
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Aceita `{ type, ref }` e devolve a forma canônica, ou `null` se inválida.
 * `ref` sempre vira string — é assim que ele é gravado no ledger, e comparar
 * `7` com `'7'` em dois lugares diferentes é como um titular vira dois.
 */
function normalizeAccount(value) {
  if (!value || typeof value !== 'object') return null;
  const type = typeof value.type === 'string' ? value.type.trim() : '';
  if (type === SYSTEM_TYPE) {
    const ref = typeof value.ref === 'string' ? value.ref.trim() : '';
    // O rótulo do `system` é obrigatório e vai para o ledger: `system:mint`
    // não diz nada, `system:whitelist_grant` diz de onde o ouro veio.
    if (!/^[a-z0-9_]{3,48}$/.test(ref)) return null;
    return { type, ref };
  }
  const kind = ACCOUNT_KINDS[type];
  if (!kind) return null;
  if (kind.numericRef) {
    const ref = typeof value.ref === 'string' ? Number(value.ref) : value.ref;
    if (!Number.isSafeInteger(ref) || ref <= 0) return null;
    return { type, ref: String(ref) };
  }
  const ref = typeof value.ref === 'string' ? value.ref.trim() : '';
  if (ref.length === 0 || ref.length > 64) return null;
  return { type, ref };
}

function normalizeAmount(value) {
  if (typeof value === 'string' && !/^[1-9]\d*$/.test(value)) return null;
  const amount = typeof value === 'string' ? Number(value) : value;
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_AMOUNT) return null;
  return amount;
}

function normalizeIdempotencyKey(value) {
  if (value === undefined || value === null) return uuid();
  if (typeof value !== 'string') return null;
  const key = value.trim();
  // O teto deixa espaço para o sufixo `#in` da perna de crédito dentro do
  // VARCHAR(128) de `gold_transactions.idempotency_key`.
  return key.length >= 8 && key.length <= 96 ? key : null;
}

function normalizeReason(value) {
  if (typeof value !== 'string') return null;
  const reason = value.trim();
  return reason.length > 0 && reason.length <= 64 ? reason : null;
}

/** Chave de ordenação canônica das travas — ver `_lockPair`. */
function lockKey(account) {
  return `${account.type}:${account.ref}`;
}

function sameAccount(a, b) {
  return a.type === b.type && a.ref === b.ref;
}

// ─────────────────────────────────────────────────────────────────────────────
// Saldo
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lê e trava o saldo de uma conta dentro da transação do chamador.
 *
 * @returns {Promise<{found:boolean, balance:number|null}>} `balance` é `null`
 *          para `system`, que não tem saldo por definição.
 */
async function _lockBalance(conn, account) {
  if (account.type === SYSTEM_TYPE) return { found: true, balance: null };
  const kind = ACCOUNT_KINDS[account.type];
  const ref = kind.numericRef ? Number(account.ref) : account.ref;
  const [rows] = await conn.query(
    `SELECT ${kind.balanceColumn} AS balance FROM ${kind.table} WHERE ${kind.keyColumn} = ? FOR UPDATE`,
    [ref]
  );
  if (rows.length === 0) return { found: false, balance: null };
  return { found: true, balance: Number(rows[0].balance) };
}

/**
 * Trava as duas contas de uma transferência em **ordem canônica**.
 *
 * Achado 10: `buyItem` e `transfer()` travavam na ordem "pagador, recebedor".
 * O personagem 7 comprando da barraca do 12 enquanto o 12 compra da barraca do
 * 7 produz `7→12` numa transação e `12→7` na outra: deadlock do InnoDB, que o
 * detector resolve matando uma — e o jogador lê "não foi possível concluir a
 * compra" por um motivo que não tem nada a ver com ele.
 *
 * Ordenar por `type:ref` faz as duas transações pedirem as travas na mesma
 * ordem, e a segunda espera em vez de cruzar.
 */
async function _lockPair(conn, from, to) {
  const ordered = [from, to].sort((a, b) => (lockKey(a) < lockKey(b) ? -1 : 1));
  const balances = new Map();
  for (const account of ordered) {
    balances.set(lockKey(account), await _lockBalance(conn, account));
  }
  return balances;
}

/**
 * Aplica o delta no saldo. Não grava ledger — quem chama é responsável pelos
 * dois, e a separação existe porque as duas pernas compartilham `transfer_id`.
 */
async function _applyDelta(conn, account, delta, dependencies) {
  if (account.type === SYSTEM_TYPE) return;

  if (account.type === 'character') {
    // O `characters.gold` continua tendo uma porta só, e ela não é esta.
    const tx = dependencies.tx || transactionService.tx;
    await tx.applyGoldDelta(conn, Number(account.ref), delta);
    return;
  }

  const kind = ACCOUNT_KINDS[account.type];
  const ref = kind.numericRef ? Number(account.ref) : account.ref;
  // A guarda `>= 0` no próprio UPDATE é redundante com a checagem feita sob a
  // trava — e é de propósito. Se alguém acrescentar um caminho que pule a
  // checagem, o banco recusa em vez de gravar tesouro negativo.
  const [result] = await conn.query(
    `UPDATE ${kind.table} SET ${kind.balanceColumn} = ${kind.balanceColumn} + ?
      WHERE ${kind.keyColumn} = ? AND ${kind.balanceColumn} + ? >= 0`,
    [delta, ref, delta]
  );
  if (result.affectedRows !== 1) {
    throw new Error(`[economy] saldo de ${lockKey(account)} recusou delta ${delta}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Ledger
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Grava as duas pernas de uma transferência.
 *
 * A chave crua vai na perna de **débito**, sempre — é ela que
 * `_findReplay` consulta. A perna de crédito recebe `#in`, porque a `UNIQUE` de
 * `idempotency_key` não aceita as duas iguais.
 *
 * Isso corrige o Achado 5: o `transfer()` do transaction-service consultava a
 * chave crua e gravava só chaves derivadas (`_item_from`, `_gold_to`), então a
 * checagem dele nunca casava com nada — era código morto, e o que impedia a
 * duplicação era a `UNIQUE` do banco, ao preço de o chamador receber `false`
 * numa operação que tinha dado certo.
 */
async function _recordLegs(conn, params, dependencies) {
  const tx = dependencies.tx || transactionService.tx;
  const common = {
    delta: 0,
    reason: params.reason,
    module: params.module,
    transferId: params.transferId,
    actorCharacterId: params.actorCharacterId
  };

  await tx.recordGoldLedger(conn, {
    ...common,
    delta: -params.amount,
    characterId: params.from.type === 'character' ? Number(params.from.ref) : null,
    ownerType: params.from.type,
    ownerRef: params.from.ref,
    counterpartyType: params.to.type,
    counterpartyRef: params.to.ref,
    idempotencyKey: params.idempotencyKey
  });

  await tx.recordGoldLedger(conn, {
    ...common,
    delta: params.amount,
    characterId: params.to.type === 'character' ? Number(params.to.ref) : null,
    ownerType: params.to.type,
    ownerRef: params.to.ref,
    counterpartyType: params.from.type,
    counterpartyRef: params.from.ref,
    idempotencyKey: `${params.idempotencyKey}#in`
  });
}

/**
 * Registra uma transferência grande em `audit_logs` — o mesmo lugar que
 * `admin-service.auditLog` escreve, para a staff olhar dinheiro e ações de
 * staff no mesmo lugar. Não cria tabela nova: `gold_transactions` já tem a
 * história completa (Achado 1), o que faltava era marcar o que passa de um
 * limiar configurável (`economy.largeTransactionThreshold`) num lugar que já
 * é rotina de auditoria olhar, sem precisar somar o ledger toda vez.
 *
 * Escreve na MESMA `conn`/transação do movimento — atômico com o ledger, sem
 * janela entre "moveu dinheiro" e "registrou que moveu muito dinheiro". Mas o
 * `INSERT` em si nunca propaga erro: uma falha aqui não pode reverter uma
 * transferência de dinheiro válida, mesma filosofia de `_applyToClient` em
 * `transaction-service.js` ("BD já está correto, o resto é melhor-esforço").
 *
 * @param {object} conn conexão com transação ativa
 * @param {object} params
 * @param {object} [dependencies]
 */
async function _auditLargeTransfer(conn, params, dependencies = {}) {
  const so = dependencies.serverOptions || serverOptions;
  const logger = dependencies.logger || console;
  const threshold = so.get('economy.largeTransactionThreshold');
  if (params.amount < threshold) return;

  try {
    await conn.query(
      'INSERT INTO audit_logs (action, actor_account_id, target_account_id, details) VALUES (?, ?, ?, ?)',
      [
        'economy:large_transfer',
        null,
        null,
        JSON.stringify({
          from: params.from, to: params.to, amount: params.amount,
          transferId: params.transferId, reason: params.reason,
          module: params.module, actorCharacterId: params.actorCharacterId || null
        })
      ]
    );
  } catch (err) {
    logger.error(`[economy] Falha ao gravar audit_logs para transferência grande ${params.transferId} (transferência já aplicada, só a auditoria falhou): ${err.message}`);
  }
}

/**
 * Procura um movimento já gravado com esta chave, **dentro** da transação.
 *
 * Achado 6: as funções públicas do transaction-service consultam a
 * idempotência numa conexão do pool e só depois abrem a transação. Duas
 * chamadas concorrentes leem vazio, ambas seguem, e a `UNIQUE` derruba a
 * segunda — resultado correto, mensagem errada. Aqui a leitura acontece sob a
 * mesma transação e com `FOR UPDATE`, então a segunda chamada **espera** e
 * enxerga a primeira. É o padrão que `market-stalls`, `regional-market` e
 * `institutional-treasury` já usam.
 */
async function _findReplay(conn, idempotencyKey) {
  const [rows] = await conn.query(
    `SELECT transfer_id, delta, owner_type, owner_ref, counterparty_type, counterparty_ref
       FROM gold_transactions WHERE idempotency_key = ? FOR UPDATE`,
    [idempotencyKey]
  );
  return rows[0] || null;
}

function replayResult(row) {
  return {
    ok: true,
    replayed: true,
    transferId: row.transfer_id,
    amount: Math.abs(Number(row.delta))
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Transferência
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Move septims de uma conta para outra, **dentro da transação do chamador**.
 *
 * ─── Contrato ──────────────────────────────────────────────────────────────
 *
 * - Quem chama abre, commita e faz rollback. Esta função não faz nenhuma das três.
 * - Recusa de regra devolve `{ok:false, code}` **sem ter escrito nada** — só
 *   travas foram tomadas, então commitar ou dar rollback é seguro.
 * - Falha de infraestrutura **lança**. Ela não vira `ok:false`, e essa é a
 *   distinção que o Achado 7 existe para restaurar: hoje um timeout de banco
 *   vira multa não paga e mandado de prisão em `governance-service`.
 *
 * @param {object} conn conexão com transação ativa
 * @param {object} request
 * @param {{type:string, ref:string|number}} request.from
 * @param {{type:string, ref:string|number}} request.to
 * @param {number|string} request.amount
 * @param {string} request.reason
 * @param {string} [request.module]
 * @param {number} [request.actorCharacterId] quem pediu o movimento, quando não é o titular
 * @param {string} [request.idempotencyKey]
 */
async function transferInTransaction(conn, request, dependencies = {}) {
  const from = normalizeAccount(request?.from);
  const to = normalizeAccount(request?.to);
  const amount = normalizeAmount(request?.amount);
  const reason = normalizeReason(request?.reason);
  const idempotencyKey = normalizeIdempotencyKey(request?.idempotencyKey);

  if (!from) return { ok: false, code: 'invalid_from_account' };
  if (!to) return { ok: false, code: 'invalid_to_account' };
  if (!amount) return { ok: false, code: 'invalid_amount' };
  if (!reason) return { ok: false, code: 'invalid_reason' };
  if (!idempotencyKey) return { ok: false, code: 'invalid_idempotency_key' };
  // Transferir para si mesmo grava duas linhas que se anulam e um `transfer_id`
  // que não conta história nenhuma. É sempre erro de cálculo do chamador.
  if (sameAccount(from, to)) return { ok: false, code: 'same_account' };
  // Ouro nascendo e morrendo na mesma linha não é transferência.
  if (from.type === SYSTEM_TYPE && to.type === SYSTEM_TYPE) return { ok: false, code: 'system_to_system' };

  const prior = await _findReplay(conn, idempotencyKey);
  if (prior) return replayResult(prior);

  const balances = await _lockPair(conn, from, to);
  const origem = balances.get(lockKey(from));
  const destino = balances.get(lockKey(to));

  if (!origem.found) return { ok: false, code: 'from_account_not_found' };
  if (!destino.found) return { ok: false, code: 'to_account_not_found' };
  if (origem.balance !== null && origem.balance < amount) {
    return { ok: false, code: 'insufficient_funds', balance: origem.balance };
  }
  if (destino.balance !== null && destino.balance + amount > MAX_AMOUNT) {
    return { ok: false, code: 'balance_overflow', balance: destino.balance };
  }

  const transferId = uuid();
  await _applyDelta(conn, from, -amount, dependencies);
  await _applyDelta(conn, to, amount, dependencies);
  await _recordLegs(conn, {
    from, to, amount, transferId, idempotencyKey,
    reason,
    module: request.module || MODULE_DEFAULT,
    actorCharacterId: request.actorCharacterId
  }, dependencies);
  await _auditLargeTransfer(conn, {
    from, to, amount, transferId, reason,
    module: request.module || MODULE_DEFAULT,
    actorCharacterId: request.actorCharacterId
  }, dependencies);

  return { ok: true, replayed: false, transferId, amount };
}

/**
 * Move septims abrindo a própria transação. Use quando a operação for isolada;
 * use `transferInTransaction` quando ela precisar commitar junto com outra coisa
 * (compra em barraca, liquidação de contrato).
 */
async function transfer(request, dependencies = {}) {
  const db = dependencies.db || database;
  const conn = await db.getConnection();
  let committed = false;
  try {
    await conn.beginTransaction();
    const result = await transferInTransaction(conn, request, dependencies);
    await conn.commit();
    committed = true;
    return result;
  } catch (err) {
    if (!committed) await _safeRollback(conn);
    throw err;
  } finally {
    conn.release();
  }
}

async function _safeRollback(conn) {
  try { await conn.rollback(); } catch { /* preserva o erro original */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// Escrow
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Trava valor de um titular numa conta de escrow.
 *
 * ─── Trava no post, não na entrega ─────────────────────────────────────────
 *
 * O valor sai do bolso de quem promete **no momento da promessa**. Uma falha
 * aqui produz **sem escrow e sem contrato**, nunca um contrato que ninguém pode
 * pagar. É a mesma filosofia fail-closed do `server-options`, e é o conceito
 * que o Mereth descreve (ver `SKYMP_ECOSYSTEM_DEEP_DIVE.md` §4 — sem licença e
 * sem código público: só a ideia foi usada).
 */
async function openEscrowInTransaction(conn, request, dependencies = {}) {
  const funder = normalizeAccount(request?.funder);
  const amount = normalizeAmount(request?.amount);
  const reason = normalizeReason(request?.reason);
  const idempotencyKey = normalizeIdempotencyKey(request?.idempotencyKey);
  const purpose = typeof request?.purpose === 'string' ? request.purpose.trim() : '';

  if (!funder || funder.type === SYSTEM_TYPE) return { ok: false, code: 'invalid_funder' };
  if (!amount) return { ok: false, code: 'invalid_amount' };
  if (!reason) return { ok: false, code: 'invalid_reason' };
  if (!idempotencyKey) return { ok: false, code: 'invalid_idempotency_key' };
  if (!ESCROW_PURPOSES.includes(purpose)) return { ok: false, code: 'invalid_purpose' };

  const [existingRows] = await conn.query(
    'SELECT escrow_id, balance, status FROM economy_escrow WHERE idempotency_key = ? FOR UPDATE',
    [idempotencyKey]
  );
  if (existingRows[0]) {
    return {
      ok: true, replayed: true,
      escrowId: existingRows[0].escrow_id,
      amount: Number(existingRows[0].balance)
    };
  }

  // A conta de escrow nasce com saldo zero e é creditada pela transferência —
  // assim o valor travado tem as mesmas duas pernas de ledger que qualquer
  // outro movimento, em vez de aparecer por `INSERT`.
  const escrowId = uuid();
  await conn.query(
    `INSERT INTO economy_escrow (escrow_id, purpose, funder_type, funder_ref, balance, status, idempotency_key)
     VALUES (?, ?, ?, ?, 0, 'held', ?)`,
    [escrowId, purpose, funder.type, funder.ref, idempotencyKey]
  );

  const moved = await transferInTransaction(conn, {
    from: funder,
    to: { type: 'escrow', ref: escrowId },
    amount,
    reason,
    module: request.module || MODULE_DEFAULT,
    actorCharacterId: request.actorCharacterId,
    idempotencyKey: `${idempotencyKey}~fund`
  }, dependencies);

  if (!moved.ok) return moved;
  return { ok: true, replayed: false, escrowId, amount, transferId: moved.transferId };
}

/**
 * Libera o escrow para um beneficiário e o fecha.
 *
 * `status` vira `released` (ou `refunded`, quando o beneficiário é o próprio
 * financiador). A transição só acontece a partir de `held` — liberar duas vezes
 * é o exploit óbvio de escrow, e o `FOR UPDATE` mais a checagem de status o
 * fecham dentro da mesma transação.
 */
async function closeEscrowInTransaction(conn, request, dependencies = {}) {
  const beneficiary = normalizeAccount(request?.beneficiary);
  const reason = normalizeReason(request?.reason);
  const idempotencyKey = normalizeIdempotencyKey(request?.idempotencyKey);
  const escrowId = typeof request?.escrowId === 'string' ? request.escrowId.trim() : '';

  if (!escrowId) return { ok: false, code: 'invalid_escrow' };
  if (!beneficiary || beneficiary.type === SYSTEM_TYPE) return { ok: false, code: 'invalid_beneficiary' };
  if (!reason) return { ok: false, code: 'invalid_reason' };
  if (!idempotencyKey) return { ok: false, code: 'invalid_idempotency_key' };

  const [rows] = await conn.query(
    'SELECT escrow_id, funder_type, funder_ref, balance, status FROM economy_escrow WHERE escrow_id = ? FOR UPDATE',
    [escrowId]
  );
  const escrow = rows[0];
  if (!escrow) return { ok: false, code: 'escrow_not_found' };

  // ─── Replay antes de status ────────────────────────────────────────────────
  //
  // A ordem importa e o inverso é um bug: um escrow já liberado tem
  // `status = 'released'`, então checar o status primeiro faria um **retry
  // legítimo** (mesma chave, reenviado por timeout de rede) receber
  // `escrow_not_held` — o Achado 7 renascendo dentro da correção dele. O
  // ledger é quem sabe se esta chave já moveu dinheiro; o status só sabe que
  // *alguma* liberação aconteceu.
  const prior = await _findReplay(conn, idempotencyKey);
  if (prior) {
    return {
      ...replayResult(prior),
      escrowId,
      outcome: escrow.status === 'refunded' ? 'refunded' : 'released'
    };
  }

  if (escrow.status !== 'held') {
    return { ok: false, code: 'escrow_not_held', status: escrow.status };
  }

  const amount = Number(escrow.balance);
  if (amount <= 0) return { ok: false, code: 'escrow_empty' };

  const moved = await transferInTransaction(conn, {
    from: { type: 'escrow', ref: escrowId },
    to: beneficiary,
    amount,
    reason,
    module: request.module || MODULE_DEFAULT,
    actorCharacterId: request.actorCharacterId,
    idempotencyKey
  }, dependencies);
  if (!moved.ok) return moved;

  const devolvido = beneficiary.type === escrow.funder_type && beneficiary.ref === String(escrow.funder_ref);
  await conn.query(
    'UPDATE economy_escrow SET status = ? WHERE escrow_id = ? AND status = ?',
    [devolvido ? 'refunded' : 'released', escrowId, 'held']
  );

  return {
    ok: true,
    replayed: moved.replayed,
    escrowId,
    amount,
    transferId: moved.transferId,
    outcome: devolvido ? 'refunded' : 'released'
  };
}

async function openEscrow(request, dependencies = {}) {
  return _withTransaction(dependencies, conn => openEscrowInTransaction(conn, request, dependencies));
}

async function closeEscrow(request, dependencies = {}) {
  return _withTransaction(dependencies, conn => closeEscrowInTransaction(conn, request, dependencies));
}

async function _withTransaction(dependencies, fn) {
  const db = dependencies.db || database;
  const conn = await db.getConnection();
  let committed = false;
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    committed = true;
    return result;
  } catch (err) {
    if (!committed) await _safeRollback(conn);
    throw err;
  } finally {
    conn.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Ajuste de staff
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `economy.adjust` do briefing §12: staff cria ou destrói septims contra
 * `system`, com motivo e ator obrigatórios.
 *
 * **Este arquivo não checa permissão.** Quem chama já sabe quem é a staff e com
 * qual cargo — duplicar a checagem aqui criaria dois lugares para mantê-la em
 * dia. O que este arquivo garante é que o ajuste é **impossível de fazer sem
 * rastro**: `actorCharacterId` e `reason` são obrigatórios, e o outro lado do
 * movimento é sempre `system:staff_adjust`, então um `SELECT` no ledger lista
 * todo ouro que a staff criou ou destruiu.
 */
async function adjust(request, dependencies = {}) {
  const target = normalizeAccount(request?.target);
  const amount = normalizeAmount(Math.abs(Number(request?.amount)));
  const reason = normalizeReason(request?.reason);
  const actorCharacterId = request?.actorCharacterId;
  const direction = Number(request?.amount) >= 0 ? 'credit' : 'debit';

  if (!target || target.type === SYSTEM_TYPE) return { ok: false, code: 'invalid_target' };
  if (!amount) return { ok: false, code: 'invalid_amount' };
  if (!reason) return { ok: false, code: 'invalid_reason' };
  if (!Number.isSafeInteger(actorCharacterId) || actorCharacterId <= 0) {
    return { ok: false, code: 'invalid_actor' };
  }

  const systemAccount = { type: SYSTEM_TYPE, ref: 'staff_adjust' };
  return transfer({
    from: direction === 'credit' ? systemAccount : target,
    to: direction === 'credit' ? target : systemAccount,
    amount,
    reason,
    module: request.module || 'admin',
    actorCharacterId,
    idempotencyKey: request.idempotencyKey
  }, dependencies);
}

// ─────────────────────────────────────────────────────────────────────────────
// Leitura
// ─────────────────────────────────────────────────────────────────────────────

async function getBalance(accountRequest, dependencies = {}) {
  const account = normalizeAccount(accountRequest);
  if (!account) return { ok: false, code: 'invalid_account' };
  if (account.type === SYSTEM_TYPE) return { ok: false, code: 'system_has_no_balance' };
  const db = dependencies.db || database;
  const kind = ACCOUNT_KINDS[account.type];
  const ref = kind.numericRef ? Number(account.ref) : account.ref;
  const rows = await db.query(
    `SELECT ${kind.balanceColumn} AS balance FROM ${kind.table} WHERE ${kind.keyColumn} = ?`,
    [ref]
  );
  if (rows.length === 0) return { ok: false, code: 'account_not_found' };
  return { ok: true, account, balance: Number(rows[0].balance) };
}

/**
 * Confere o saldo guardado contra a soma dos deltas do ledger.
 *
 * Isto é o que a §3 do briefing quer dizer com "saldo pode ser snapshot, ledger
 * é histórico" — e é o que hoje é **impossível** para tesouro, porque imposto
 * entra com `UPDATE` solto e não deixa linha (Achado 2).
 *
 * Só é conclusivo para contas cujo saldo nasceu depois da migration v15.
 * `characters.gold` tem histórico anterior ao ledger e vai divergir por
 * construção — por isso `ledgerSum` é devolvido junto, e não só o veredito.
 */
async function reconcile(accountRequest, dependencies = {}) {
  const balance = await getBalance(accountRequest, dependencies);
  if (!balance.ok) return balance;
  const db = dependencies.db || database;
  const rows = await db.query(
    'SELECT COALESCE(SUM(delta), 0) AS total FROM gold_transactions WHERE owner_type = ? AND owner_ref = ?',
    [balance.account.type, balance.account.ref]
  );
  const ledgerSum = Number(rows[0]?.total || 0);
  return {
    ok: true,
    account: balance.account,
    balance: balance.balance,
    ledgerSum,
    matches: ledgerSum === balance.balance
  };
}

module.exports = {
  transfer,
  transferInTransaction,
  openEscrow,
  openEscrowInTransaction,
  closeEscrow,
  closeEscrowInTransaction,
  adjust,
  getBalance,
  reconcile,

  // Expostos para os serviços de domínio (contratos, dívida) e para teste.
  normalizeAccount,
  normalizeAmount,
  normalizeIdempotencyKey,
  ACCOUNT_KINDS,
  ESCROW_PURPOSES,
  SYSTEM_TYPE,
  MAX_AMOUNT
};
