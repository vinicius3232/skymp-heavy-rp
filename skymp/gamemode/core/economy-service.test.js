/**
 * core/economy-service.test.js
 *
 * O que estes testes travam — cada bloco nomeia o achado de
 * `docs/research/ECONOMY_FRAMEWORK_AUDIT.md` que ele impede de voltar:
 *
 *   1. **Duas pernas com o mesmo `transfer_id`** (Achado 1). Sem isso o ledger
 *      volta a não saber dizer quem pagou quem.
 *   2. **Tesouro com ledger** (Achado 2). Imposto que entra por `UPDATE` solto
 *      é dinheiro fora da história.
 *   3. **Recusa ≠ falha** (Achado 7). Saldo insuficiente devolve
 *      `{ok:false, code}`; banco fora do ar **lança**. Trocar um pelo outro é o
 *      bug que produz mandado de prisão por timeout.
 *   4. **Idempotência dentro da transação** (Achados 5 e 6), devolvendo o
 *      resultado original em vez de um erro.
 *   5. **Travas em ordem canônica** (Achado 10).
 *   6. **Escrow libera uma vez só** (briefing §13, "escrow duplicate release").
 *
 * Executa com: node --test core/economy-service.test.js
 */

const assert = require('assert');
const { describe, it } = require('node:test');
const economy = require('./economy-service');

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fila de travas por linha — simula o bloqueio real de `SELECT ... FOR
 * UPDATE` do InnoDB: uma segunda transação pedindo a MESMA linha espera até a
 * primeira liberar (commit/rollback), em vez de ler o valor "ao vivo" sem
 * fila. Sem isto, `Promise.all` de transferências concorrentes sobre a mesma
 * linha nunca contenderia de verdade — o mock passaria mesmo se o código
 * tivesse um lost-update de verdade, porque nada aqui bloquearia a segunda
 * leitura enquanto a primeira transação ainda está "aberta".
 *
 * Existe só para os testes de concorrência (Tarefa 7, §5) — os outros 30
 * testes deste arquivo chamam uma operação de cada vez, então a fila nunca
 * chega a ter uma segunda espera; o comportamento delas não muda.
 */
function makeLockQueue() {
  const tails = new Map(); // rowKey -> promise da última trava pendente/ativa
  return {
    /** Resolve quando a trava é concedida; devolve a função de liberação. */
    async acquire(rowKey) {
      const previousTail = tails.get(rowKey) || Promise.resolve();
      let release;
      const myTurn = new Promise((resolve) => { release = resolve; });
      tails.set(rowKey, previousTail.then(() => myTurn));
      await previousTail;
      return release;
    }
  };
}

function makeHarness(options = {}) {
  const state = {
    gold: { ...(options.gold || {}) },
    treasury: { ...(options.treasury || {}) },
    escrows: new Map(Object.entries(options.escrows || {})),
    ledger: [],
    locks: [],        // ordem em que as linhas foram travadas (FOR UPDATE)
    events: [],       // begin / commit / rollback / release
    committed: false,
    lockQueue: makeLockQueue()
  };

  function insertLedger(params) {
    // (transaction_id, character_id, owner_type, owner_ref, counterparty_type,
    //  counterparty_ref, transfer_id, actor_character_id, delta, reason,
    //  module, idempotency_key)
    const row = {
      transactionId: params[0], characterId: params[1],
      ownerType: params[2], ownerRef: params[3],
      counterpartyType: params[4], counterpartyRef: params[5],
      transferId: params[6], actorCharacterId: params[7],
      delta: params[8], reason: params[9], module: params[10],
      idempotencyKey: params[11]
    };
    // A UNIQUE de `idempotency_key` é a última linha de defesa e precisa
    // existir no mock: sem ela, um teste de replay passaria por acidente.
    if (row.idempotencyKey && state.ledger.some(l => l.idempotencyKey === row.idempotencyKey)) {
      const err = new Error("Duplicate entry for key 'idempotency_key'");
      err.code = 'ER_DUP_ENTRY';
      throw err;
    }
    state.ledger.push(row);
  }

  /**
   * Cria uma "conexão" nova por chamada de `getConnection()` — como o pool
   * real faz — mas todas compartilham `state`. Cada uma mantém as próprias
   * travas concedidas (`heldLocks`) e as libera no `commit`/`rollback`, nunca
   * antes: é isso que faz uma segunda transação pedindo a MESMA linha
   * bloquear em `acquireRowLock` até a primeira soltar.
   */
  function makeConn() {
    const heldLocks = [];
    // Linhas que ESTA conexão já trava. Sem isto, uma segunda trava da MESMA
    // linha dentro da MESMA transação (ex: `_lockPair` trava o personagem
    // alvo, depois `transaction-service.tx.applyGoldDelta` trava a MESMA
    // linha de novo) esperaria a fila liberar essa linha — e quem a liberaria
    // é o próprio `commit()`, que não roda até esta segunda trava resolver.
    // Autodeadlock. O InnoDB real é reentrante por transação: quem já é dono
    // não espera a própria trava. Isto replica esse comportamento.
    const heldRowKeys = new Set();

    async function acquireRowLock(rowKey) {
      if (heldRowKeys.has(rowKey)) return;
      const release = await state.lockQueue.acquire(rowKey);
      heldRowKeys.add(rowKey);
      heldLocks.push(release);
      state.locks.push(rowKey);
    }

    function releaseAllLocks() {
      while (heldLocks.length > 0) heldLocks.pop()();
    }

    return {
      beginTransaction: async () => { state.events.push('begin'); },
      commit: async () => { state.events.push('commit'); state.committed = true; releaseAllLocks(); },
      rollback: async () => { state.events.push('rollback'); releaseAllLocks(); },
      release: () => { state.events.push('release'); },
      query: async (sql, params = []) => {
        if (options.failOn && new RegExp(options.failOn, 'i').test(sql)) {
          throw new Error('conexao com o banco caiu');
        }

        // ── Ledger ──────────────────────────────────────────────────────────
        if (/FROM gold_transactions WHERE idempotency_key = \? FOR UPDATE/i.test(sql)) {
          const found = state.ledger.find(l => l.idempotencyKey === params[0]);
          return [found ? [{
            transfer_id: found.transferId, delta: found.delta,
            owner_type: found.ownerType, owner_ref: found.ownerRef,
            counterparty_type: found.counterpartyType, counterparty_ref: found.counterpartyRef
          }] : []];
        }
        if (/INSERT INTO gold_transactions/i.test(sql)) {
          insertLedger(params);
          return [{ affectedRows: 1 }];
        }
        if (/INSERT INTO audit_logs/i.test(sql)) {
          state.auditLogs = state.auditLogs || [];
          state.auditLogs.push({ action: params[0], actorAccountId: params[1], targetAccountId: params[2], details: params[3] });
          return [{ affectedRows: 1 }];
        }

        // ── Escrow ──────────────────────────────────────────────────────────
        if (/SELECT escrow_id, balance, status FROM economy_escrow WHERE idempotency_key/i.test(sql)) {
          const found = [...state.escrows.values()].find(e => e.idempotency_key === params[0]);
          return [found ? [{ escrow_id: found.escrow_id, balance: found.balance, status: found.status }] : []];
        }
        if (/SELECT escrow_id, funder_type, funder_ref, balance, status FROM economy_escrow/i.test(sql)) {
          await acquireRowLock(`escrow:${params[0]}`);
          const found = state.escrows.get(params[0]);
          return [found ? [{ ...found }] : []];
        }
        if (/SELECT balance AS balance FROM economy_escrow WHERE escrow_id = \? FOR UPDATE/i.test(sql)) {
          await acquireRowLock(`escrow:${params[0]}`);
          const found = state.escrows.get(params[0]);
          return [found ? [{ balance: found.balance }] : []];
        }
        if (/INSERT INTO economy_escrow/i.test(sql)) {
          state.escrows.set(params[0], {
            escrow_id: params[0], purpose: params[1],
            funder_type: params[2], funder_ref: params[3],
            balance: 0, status: 'held', idempotency_key: params[4]
          });
          return [{ affectedRows: 1 }];
        }
        if (/UPDATE economy_escrow SET balance = balance \+ \?/i.test(sql)) {
          const found = state.escrows.get(params[1]);
          if (!found || found.balance + params[0] < 0) return [{ affectedRows: 0 }];
          found.balance += params[0];
          return [{ affectedRows: 1 }];
        }
        if (/UPDATE economy_escrow SET status = \?/i.test(sql)) {
          const found = state.escrows.get(params[1]);
          if (!found || found.status !== params[2]) return [{ affectedRows: 0 }];
          found.status = params[0];
          return [{ affectedRows: 1 }];
        }

        // ── Personagem ──────────────────────────────────────────────────────
        if (/SELECT gold AS balance FROM characters WHERE id = \? FOR UPDATE/i.test(sql)
          || /SELECT gold FROM characters WHERE id = \? FOR UPDATE/i.test(sql)) {
          await acquireRowLock(`character:${params[0]}`);
          const value = state.gold[params[0]];
          return [value === undefined ? [] : [{ gold: value, balance: value }]];
        }
        if (/UPDATE characters SET gold = gold \+ \?/i.test(sql)) {
          state.gold[params[1]] = (state.gold[params[1]] || 0) + params[0];
          return [{ affectedRows: 1 }];
        }

        // ── Tesouros ────────────────────────────────────────────────────────
        const treasurySelect = /SELECT treasury AS balance FROM (cities|holds|factions|realms) WHERE id = \? FOR UPDATE/i.exec(sql);
        if (treasurySelect) {
          const key = `${treasurySelect[1]}:${params[0]}`;
          await acquireRowLock(key);
          const value = state.treasury[key];
          return [value === undefined ? [] : [{ balance: value }]];
        }
        const treasuryUpdate = /UPDATE (cities|holds|factions|realms) SET treasury = treasury \+ \?/i.exec(sql);
        if (treasuryUpdate) {
          const key = `${treasuryUpdate[1]}:${params[1]}`;
          if (state.treasury[key] === undefined || state.treasury[key] + params[0] < 0) return [{ affectedRows: 0 }];
          state.treasury[key] += params[0];
          return [{ affectedRows: 1 }];
        }

        throw new Error(`SQL inesperado: ${sql}`);
      }
    };
  }

  // Conexão padrão: um único objeto reaproveitado por todo `getConnection()`,
  // como o comportamento original deste harness. Suficiente pra tudo que roda
  // uma operação de cada vez, e é o que o teste de "consulta de replay dentro
  // da transacao" precisa (ele troca `h.conn.query` antes de chamar
  // `economy.transfer` e espera que seja a MESMA conexão usada por dentro).
  const conn = makeConn();

  return {
    state,
    conn,
    // Exposto só para os testes de concorrência: uma `db` cuja
    // `getConnection()` devolve uma conexão NOVA a cada chamada (como o pool
    // real), para que duas `transfer()` concorrentes sejam duas transações
    // de verdade, cada uma com suas próprias travas — ver `makeLockQueue`.
    makeConcurrentDb: () => ({
      getConnection: async () => makeConn(),
      query: async (sql, params = []) => {
        const [rows] = await makeConn().query(sql, params);
        return rows;
      }
    }),
    dependencies: {
      db: {
        getConnection: async () => conn,
        query: async (sql, params = []) => {
          const [rows] = await conn.query(sql, params);
          return rows;
        }
      }
    }
  };
}

const CHAR_A = 101;
const CHAR_B = 202;

function baseHarness(extra = {}) {
  return makeHarness({
    gold: { [CHAR_A]: 1000, [CHAR_B]: 50 },
    treasury: { 'cities:whiterun': 200, 'holds:whiterun': 0 },
    ...extra
  });
}

// ─────────────────────────────────────────────────────────────────────────────

describe('economy-service — transferência', () => {
  it('move o saldo e grava as duas pernas com o mesmo transfer_id', async () => {
    const h = baseHarness();
    const result = await economy.transfer({
      from: { type: 'character', ref: CHAR_A },
      to: { type: 'character', ref: CHAR_B },
      amount: 300,
      reason: 'trade_payment',
      module: 'trade',
      idempotencyKey: 'pagamento-0001'
    }, h.dependencies);

    assert.deepStrictEqual(
      { ok: result.ok, replayed: result.replayed, amount: result.amount },
      { ok: true, replayed: false, amount: 300 }
    );
    assert.strictEqual(h.state.gold[CHAR_A], 700);
    assert.strictEqual(h.state.gold[CHAR_B], 350);

    assert.strictEqual(h.state.ledger.length, 2, 'toda transferencia grava duas pernas');
    const [debito, credito] = h.state.ledger;

    // Achado 1: sem `transfer_id` compartilhado, as duas linhas são dois
    // eventos soltos e "quem pagou quem" volta a ser adivinhação.
    assert.strictEqual(debito.transferId, credito.transferId);
    assert.strictEqual(debito.transferId, result.transferId);

    assert.deepStrictEqual(
      { t: debito.ownerType, r: debito.ownerRef, ct: debito.counterpartyType, cr: debito.counterpartyRef, d: debito.delta },
      { t: 'character', r: String(CHAR_A), ct: 'character', cr: String(CHAR_B), d: -300 }
    );
    assert.deepStrictEqual(
      { t: credito.ownerType, r: credito.ownerRef, ct: credito.counterpartyType, cr: credito.counterpartyRef, d: credito.delta },
      { t: 'character', r: String(CHAR_B), ct: 'character', cr: String(CHAR_A), d: 300 }
    );
    // A perna de débito carrega a chave crua; é ela que o replay consulta.
    assert.strictEqual(debito.idempotencyKey, 'pagamento-0001');
    assert.strictEqual(credito.idempotencyKey, 'pagamento-0001#in');
  });

  it('credita tesouro de cidade COM ledger dos dois lados (Achado 2)', async () => {
    const h = baseHarness();
    const result = await economy.transfer({
      from: { type: 'character', ref: CHAR_A },
      to: { type: 'city', ref: 'whiterun' },
      amount: 40,
      reason: 'stall_tax',
      module: 'market-stalls',
      idempotencyKey: 'imposto-0001'
    }, h.dependencies);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(h.state.treasury['cities:whiterun'], 240);
    assert.strictEqual(h.state.gold[CHAR_A], 960);

    const credito = h.state.ledger.find(l => l.ownerType === 'city');
    assert.ok(credito, 'o tesouro precisa de linha de ledger — sem ela o saldo dele nao e auditavel');
    assert.strictEqual(credito.ownerRef, 'whiterun');
    assert.strictEqual(credito.delta, 40);
    assert.strictEqual(credito.characterId, null, 'titular que nao e personagem grava character_id nulo');
  });

  it('registra o ator quando quem pediu nao e o titular', async () => {
    const h = baseHarness();
    await economy.transfer({
      from: { type: 'character', ref: CHAR_A },
      to: { type: 'city', ref: 'whiterun' },
      amount: 25,
      reason: 'guard_fine',
      module: 'governance',
      actorCharacterId: CHAR_B,
      idempotencyKey: 'multa-0001'
    }, h.dependencies);

    for (const leg of h.state.ledger) {
      assert.strictEqual(leg.actorCharacterId, CHAR_B, 'as duas pernas nomeiam quem mandou');
    }
  });
});

describe('economy-service — recusa nao e falha (Achado 7)', () => {
  it('saldo insuficiente devolve code e nao move nada', async () => {
    const h = baseHarness();
    const result = await economy.transfer({
      from: { type: 'character', ref: CHAR_B },
      to: { type: 'character', ref: CHAR_A },
      amount: 500,
      reason: 'trade_payment',
      idempotencyKey: 'sem-saldo-0001'
    }, h.dependencies);

    assert.deepStrictEqual(result, { ok: false, code: 'insufficient_funds', balance: 50 });
    assert.strictEqual(h.state.gold[CHAR_B], 50);
    assert.strictEqual(h.state.gold[CHAR_A], 1000);
    assert.strictEqual(h.state.ledger.length, 0, 'recusa nao deixa rastro de movimento');
  });

  it('falha de infraestrutura LANCA — nao vira {ok:false}', async () => {
    // Esta é a asserção que impede o bug do `governance-service`: com
    // `boolean`, um timeout de banco vira "multa nao paga" e mandado de prisao.
    const h = makeHarness({
      gold: { [CHAR_A]: 1000, [CHAR_B]: 50 },
      failOn: 'INSERT INTO gold_transactions'
    });

    await assert.rejects(
      economy.transfer({
        from: { type: 'character', ref: CHAR_A },
        to: { type: 'character', ref: CHAR_B },
        amount: 10,
        reason: 'trade_payment',
        idempotencyKey: 'infra-0001'
      }, h.dependencies),
      /banco caiu/
    );
    assert.ok(h.state.events.includes('rollback'), 'falha precisa dar rollback');
    assert.strictEqual(h.state.committed, false);
  });

  it('conta inexistente e recusa, nao excecao', async () => {
    const h = baseHarness();
    const result = await economy.transfer({
      from: { type: 'character', ref: CHAR_A },
      to: { type: 'city', ref: 'inexistente' },
      amount: 10,
      reason: 'tax',
      idempotencyKey: 'cidade-fantasma-1'
    }, h.dependencies);
    assert.deepStrictEqual(result, { ok: false, code: 'to_account_not_found' });
    assert.strictEqual(h.state.gold[CHAR_A], 1000);
  });
});

describe('economy-service — idempotencia (Achados 5 e 6)', () => {
  it('repetir a mesma chave devolve o resultado original sem mover de novo', async () => {
    const h = baseHarness();
    const primeiro = await economy.transfer({
      from: { type: 'character', ref: CHAR_A },
      to: { type: 'character', ref: CHAR_B },
      amount: 100,
      reason: 'trade_payment',
      idempotencyKey: 'repetida-0001'
    }, h.dependencies);

    const segundo = await economy.transfer({
      from: { type: 'character', ref: CHAR_A },
      to: { type: 'character', ref: CHAR_B },
      amount: 100,
      reason: 'trade_payment',
      idempotencyKey: 'repetida-0001'
    }, h.dependencies);

    // `ok: true` é o ponto. O `transfer()` do transaction-service devolve
    // `false` aqui — indistinguível de "saldo insuficiente" para quem chamou.
    assert.strictEqual(segundo.ok, true);
    assert.strictEqual(segundo.replayed, true);
    assert.strictEqual(segundo.transferId, primeiro.transferId);
    assert.strictEqual(segundo.amount, 100);

    assert.strictEqual(h.state.gold[CHAR_A], 900, 'o segundo pedido nao pode cobrar de novo');
    assert.strictEqual(h.state.gold[CHAR_B], 150);
    assert.strictEqual(h.state.ledger.length, 2, 'e nem gravar de novo');
  });

  it('a consulta de replay acontece DENTRO da transacao', async () => {
    // Mutação que reprova aqui: mover a checagem para antes do
    // `beginTransaction` (como fazem `addGold`/`removeGold`). Fora da
    // transação, duas chamadas concorrentes leem vazio e ambas seguem.
    const h = baseHarness();
    const ordem = [];
    const original = h.conn.query;
    h.conn.query = async (sql, params) => {
      if (/FROM gold_transactions WHERE idempotency_key/i.test(sql)) ordem.push('replay');
      return original(sql, params);
    };
    h.conn.beginTransaction = async () => { ordem.push('begin'); h.state.events.push('begin'); };

    await economy.transfer({
      from: { type: 'character', ref: CHAR_A },
      to: { type: 'character', ref: CHAR_B },
      amount: 10,
      reason: 'trade_payment',
      idempotencyKey: 'ordem-0001'
    }, h.dependencies);

    assert.deepStrictEqual(ordem, ['begin', 'replay']);
  });
});

describe('economy-service — ordem canonica de travas (Achado 10)', () => {
  it('trava sempre na mesma ordem, independente de quem paga', async () => {
    const pagaAparaB = baseHarness();
    await economy.transfer({
      from: { type: 'character', ref: CHAR_A },
      to: { type: 'character', ref: CHAR_B },
      amount: 10, reason: 'trade_payment', idempotencyKey: 'trava-0001'
    }, pagaAparaB.dependencies);

    const pagaBparaA = baseHarness();
    await economy.transfer({
      from: { type: 'character', ref: CHAR_B },
      to: { type: 'character', ref: CHAR_A },
      amount: 10, reason: 'trade_payment', idempotencyKey: 'trava-0002'
    }, pagaBparaA.dependencies);

    const primeiraTrava = locks => locks[0];
    assert.strictEqual(
      primeiraTrava(pagaAparaB.state.locks),
      primeiraTrava(pagaBparaA.state.locks),
      'A→B e B→A precisam pedir a MESMA trava primeiro, ou uma compra cruzada vira deadlock'
    );
    // `character:101` < `character:202` como string.
    assert.strictEqual(primeiraTrava(pagaAparaB.state.locks), `character:${CHAR_A}`);
  });
});

describe('economy-service — validacao de entrada', () => {
  const invalidos = [
    ['zero', 0, 'invalid_amount'],
    ['negativo', -5, 'invalid_amount'],
    ['NaN', NaN, 'invalid_amount'],
    ['fracionario', 1.5, 'invalid_amount'],
    ['string nao numerica', 'muito', 'invalid_amount'],
    ['acima do teto do INT', 2147483648, 'invalid_amount']
  ];

  for (const [nome, amount, code] of invalidos) {
    it(`recusa valor ${nome}`, async () => {
      const h = baseHarness();
      const result = await economy.transfer({
        from: { type: 'character', ref: CHAR_A },
        to: { type: 'character', ref: CHAR_B },
        amount, reason: 'trade_payment', idempotencyKey: `invalido-${nome}`
      }, h.dependencies);
      assert.strictEqual(result.code, code);
      assert.strictEqual(h.state.ledger.length, 0);
    });
  }

  it('recusa transferencia para a propria conta', async () => {
    const h = baseHarness();
    const result = await economy.transfer({
      from: { type: 'character', ref: CHAR_A },
      to: { type: 'character', ref: CHAR_A },
      amount: 10, reason: 'trade_payment', idempotencyKey: 'espelho-0001'
    }, h.dependencies);
    assert.deepStrictEqual(result, { ok: false, code: 'same_account' });
  });

  it('recusa tipo de titular desconhecido', async () => {
    const h = baseHarness();
    const result = await economy.transfer({
      from: { type: 'character', ref: CHAR_A },
      to: { type: 'banco_central', ref: '1' },
      amount: 10, reason: 'trade_payment', idempotencyKey: 'tipo-0001'
    }, h.dependencies);
    assert.deepStrictEqual(result, { ok: false, code: 'invalid_to_account' });
  });

  it('recusa system sem rotulo legivel', async () => {
    const h = baseHarness();
    const result = await economy.transfer({
      from: { type: 'system', ref: '' },
      to: { type: 'character', ref: CHAR_A },
      amount: 10, reason: 'grant', idempotencyKey: 'system-0001'
    }, h.dependencies);
    assert.deepStrictEqual(result, { ok: false, code: 'invalid_from_account' });
  });

  it('recusa credito que estoura o INT do saldo', async () => {
    const h = makeHarness({ gold: { [CHAR_A]: 1000, [CHAR_B]: economy.MAX_AMOUNT - 5 } });
    const result = await economy.transfer({
      from: { type: 'character', ref: CHAR_A },
      to: { type: 'character', ref: CHAR_B },
      amount: 100, reason: 'trade_payment', idempotencyKey: 'estouro-0001'
    }, h.dependencies);
    assert.strictEqual(result.code, 'balance_overflow');
    assert.strictEqual(h.state.gold[CHAR_A], 1000, 'nada sai quando o destino nao cabe');
  });
});

describe('economy-service — escrow', () => {
  it('trava o valor no post: sai do bolso do criador e fica no escrow', async () => {
    const h = baseHarness();
    const result = await economy.openEscrow({
      funder: { type: 'character', ref: CHAR_A },
      amount: 250,
      purpose: 'contract',
      reason: 'contract_escrow',
      module: 'contracts',
      idempotencyKey: 'escrow-0001'
    }, h.dependencies);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(h.state.gold[CHAR_A], 750, 'o valor sai na criacao, nao na entrega');
    const escrow = h.state.escrows.get(result.escrowId);
    assert.strictEqual(escrow.balance, 250);
    assert.strictEqual(escrow.status, 'held');
  });

  it('nao abre escrow sem saldo — falha vira SEM escrow, nunca escrow impagavel', async () => {
    const h = baseHarness();
    const result = await economy.openEscrow({
      funder: { type: 'character', ref: CHAR_B },
      amount: 5000,
      purpose: 'contract',
      reason: 'contract_escrow',
      idempotencyKey: 'escrow-0002'
    }, h.dependencies);

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'insufficient_funds');
    assert.strictEqual(h.state.gold[CHAR_B], 50);
    assert.strictEqual(h.state.ledger.length, 0);
  });

  it('libera para o beneficiario e fecha', async () => {
    const h = baseHarness();
    const aberto = await economy.openEscrow({
      funder: { type: 'character', ref: CHAR_A },
      amount: 250, purpose: 'contract', reason: 'contract_escrow',
      idempotencyKey: 'escrow-0003'
    }, h.dependencies);

    const fechado = await economy.closeEscrow({
      escrowId: aberto.escrowId,
      beneficiary: { type: 'character', ref: CHAR_B },
      reason: 'contract_settlement',
      idempotencyKey: 'escrow-0003-release'
    }, h.dependencies);

    assert.strictEqual(fechado.ok, true);
    assert.strictEqual(fechado.outcome, 'released');
    assert.strictEqual(h.state.gold[CHAR_B], 300);
    assert.strictEqual(h.state.escrows.get(aberto.escrowId).balance, 0);
    assert.strictEqual(h.state.escrows.get(aberto.escrowId).status, 'released');
  });

  it('devolver ao financiador marca refunded, nao released', async () => {
    const h = baseHarness();
    const aberto = await economy.openEscrow({
      funder: { type: 'character', ref: CHAR_A },
      amount: 250, purpose: 'contract', reason: 'contract_escrow',
      idempotencyKey: 'escrow-0004'
    }, h.dependencies);

    const fechado = await economy.closeEscrow({
      escrowId: aberto.escrowId,
      beneficiary: { type: 'character', ref: CHAR_A },
      reason: 'contract_cancelled',
      idempotencyKey: 'escrow-0004-refund'
    }, h.dependencies);

    assert.strictEqual(fechado.outcome, 'refunded');
    assert.strictEqual(h.state.gold[CHAR_A], 1000, 'devolveu tudo');
    assert.strictEqual(h.state.escrows.get(aberto.escrowId).status, 'refunded');
  });

  it('liberar duas vezes com chaves diferentes e recusado', async () => {
    // O exploit óbvio de escrow. A segunda liberação usa outra chave — não é
    // retry, é uma segunda tentativa de sacar o mesmo dinheiro.
    const h = baseHarness();
    const aberto = await economy.openEscrow({
      funder: { type: 'character', ref: CHAR_A },
      amount: 250, purpose: 'contract', reason: 'contract_escrow',
      idempotencyKey: 'escrow-0005'
    }, h.dependencies);

    await economy.closeEscrow({
      escrowId: aberto.escrowId,
      beneficiary: { type: 'character', ref: CHAR_B },
      reason: 'contract_settlement', idempotencyKey: 'escrow-0005-r1'
    }, h.dependencies);

    const segundo = await economy.closeEscrow({
      escrowId: aberto.escrowId,
      beneficiary: { type: 'character', ref: CHAR_B },
      reason: 'contract_settlement', idempotencyKey: 'escrow-0005-r2'
    }, h.dependencies);

    assert.deepStrictEqual(segundo, { ok: false, code: 'escrow_not_held', status: 'released' });
    assert.strictEqual(h.state.gold[CHAR_B], 300, 'o beneficiario recebeu uma vez so');
  });

  it('reenviar a MESMA liberacao devolve replay, nao escrow_not_held', async () => {
    // Mutação que reprova aqui: checar `status !== 'held'` antes de consultar o
    // ledger. Um retry legítimo por timeout de rede receberia erro, e o
    // chamador concluiria que o trabalhador não foi pago — Achado 7 de novo,
    // dentro da própria correção dele.
    const h = baseHarness();
    const aberto = await economy.openEscrow({
      funder: { type: 'character', ref: CHAR_A },
      amount: 250, purpose: 'contract', reason: 'contract_escrow',
      idempotencyKey: 'escrow-0006'
    }, h.dependencies);

    const chave = 'escrow-0006-release';
    const primeiro = await economy.closeEscrow({
      escrowId: aberto.escrowId, beneficiary: { type: 'character', ref: CHAR_B },
      reason: 'contract_settlement', idempotencyKey: chave
    }, h.dependencies);
    const repetido = await economy.closeEscrow({
      escrowId: aberto.escrowId, beneficiary: { type: 'character', ref: CHAR_B },
      reason: 'contract_settlement', idempotencyKey: chave
    }, h.dependencies);

    assert.strictEqual(repetido.ok, true);
    assert.strictEqual(repetido.replayed, true);
    assert.strictEqual(repetido.transferId, primeiro.transferId);
    assert.strictEqual(h.state.gold[CHAR_B], 300, 'e sem pagar duas vezes');
  });

  it('recusa proposito fora da lista', async () => {
    const h = baseHarness();
    const result = await economy.openEscrow({
      funder: { type: 'character', ref: CHAR_A },
      amount: 10, purpose: 'lavagem', reason: 'x_reason',
      idempotencyKey: 'escrow-0007'
    }, h.dependencies);
    assert.deepStrictEqual(result, { ok: false, code: 'invalid_purpose' });
  });
});

describe('economy-service — ajuste de staff (briefing §12)', () => {
  it('credita contra system e deixa o ator no ledger', async () => {
    const h = baseHarness();
    const result = await economy.adjust({
      target: { type: 'character', ref: CHAR_B },
      amount: 500,
      reason: 'compensacao_bug',
      actorCharacterId: CHAR_A,
      idempotencyKey: 'ajuste-0001'
    }, h.dependencies);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(h.state.gold[CHAR_B], 550);
    const origem = h.state.ledger.find(l => l.ownerType === 'system');
    assert.ok(origem, 'ouro criado pela staff precisa ter system do outro lado');
    assert.strictEqual(origem.ownerRef, 'staff_adjust');
    assert.strictEqual(origem.actorCharacterId, CHAR_A);
    assert.strictEqual(origem.delta, -500);
  });

  it('debita contra system quando o valor e negativo', async () => {
    const h = baseHarness();
    await economy.adjust({
      target: { type: 'character', ref: CHAR_A },
      amount: -200, reason: 'estorno_dupe', actorCharacterId: CHAR_B,
      idempotencyKey: 'ajuste-0002'
    }, h.dependencies);
    assert.strictEqual(h.state.gold[CHAR_A], 800);
    const destino = h.state.ledger.find(l => l.ownerType === 'system');
    assert.strictEqual(destino.delta, 200);
  });

  it('exige ator — ajuste anonimo nao existe', async () => {
    const h = baseHarness();
    const result = await economy.adjust({
      target: { type: 'character', ref: CHAR_A },
      amount: 100, reason: 'sem_ator', idempotencyKey: 'ajuste-0003'
    }, h.dependencies);
    assert.deepStrictEqual(result, { ok: false, code: 'invalid_actor' });
  });
});

describe('economy-service — reconciliacao', () => {
  it('soma do ledger bate com o saldo de um tesouro que nasceu depois da v15', async () => {
    const h = makeHarness({ gold: { [CHAR_A]: 1000 }, treasury: { 'cities:whiterun': 0 } });
    await economy.transfer({
      from: { type: 'character', ref: CHAR_A }, to: { type: 'city', ref: 'whiterun' },
      amount: 30, reason: 'stall_tax', idempotencyKey: 'reconc-0001'
    }, h.dependencies);
    await economy.transfer({
      from: { type: 'character', ref: CHAR_A }, to: { type: 'city', ref: 'whiterun' },
      amount: 12, reason: 'stall_tax', idempotencyKey: 'reconc-0002'
    }, h.dependencies);

    // O mock não implementa SUM; conferimos a soma que a query faria.
    const soma = h.state.ledger
      .filter(l => l.ownerType === 'city' && l.ownerRef === 'whiterun')
      .reduce((total, l) => total + l.delta, 0);

    assert.strictEqual(soma, 42);
    assert.strictEqual(h.state.treasury['cities:whiterun'], 42,
      'saldo e ledger precisam contar a mesma historia — e o que o Achado 2 tornava impossivel');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Concorrência (Tarefa 7 — "The Vault", §5: inflação e duplicação)
//
// O harness aplica `UPDATE ... SET gold = gold + ?` como incremento atômico ao
// vivo (lê `state.gold[id]` no MOMENTO da escrita, não um valor lido antes) —
// mesma semântica do `UPDATE` relativo que o MySQL real faz por linha, mesmo
// sem `FOR UPDATE`. O que os dois testes abaixo provam é que a interleaving de
// `Promise.all` (cada `transfer()` faz várias idas assíncronas ao "banco", e o
// event loop intercala as chamadas concorrentes entre esses pontos) não perde
// nenhuma perna do ledger nem deixa o saldo divergir — a garantia concreta que
// a Tarefa 7 pede. Só um teste de integração contra MySQL real prova travas
// (`FOR UPDATE`) de verdade sob concorrência de processo — mesma limitação já
// documentada no topo deste arquivo para os outros blocos de teste.
// ─────────────────────────────────────────────────────────────────────────────

describe('economy-service — concorrência', () => {
  it('5 remetentes transferindo pro MESMO destinatário simultaneamente: nenhum perde', async () => {
    const senders = [301, 302, 303, 304, 305];
    const TARGET = 999;
    const amount = 100;

    const h = makeHarness({
      gold: {
        ...Object.fromEntries(senders.map((id) => [id, 1000])),
        [TARGET]: 0
      }
    });
    const dependencies = { db: h.makeConcurrentDb() };

    const results = await Promise.all(
      senders.map((senderId, i) => economy.transfer({
        from: { type: 'character', ref: senderId },
        to: { type: 'character', ref: TARGET },
        amount,
        reason: 'gift',
        module: 'test',
        idempotencyKey: `concurrent-to-target-${i}`
      }, dependencies))
    );

    assert.ok(results.every((r) => r.ok === true), `todas as 5 deveriam ter sucesso: ${JSON.stringify(results)}`);

    assert.strictEqual(h.state.gold[TARGET], senders.length * amount,
      'o alvo precisa ter recebido a soma exata das 5 transferências — nenhuma perna pode se perder na interleaving');

    for (const senderId of senders) {
      assert.strictEqual(h.state.gold[senderId], 1000 - amount);
    }

    assert.strictEqual(h.state.ledger.length, senders.length * 2, '2 pernas por transferência, nenhuma faltando');
    const transferIds = new Set(h.state.ledger.map((l) => l.transferId));
    assert.strictEqual(transferIds.size, senders.length, 'cada transferência precisa de um transfer_id distinto — sem colisão sob concorrência');
  });

  it('o MESMO remetente não consegue gastar o mesmo saldo duas vezes em transferências concorrentes (duplicação)', async () => {
    const SENDER = 401;
    const TARGET_1 = 501;
    const TARGET_2 = 502;

    // Saldo alcança para UMA transferência de 700, não para as duas.
    const h = makeHarness({ gold: { [SENDER]: 700, [TARGET_1]: 0, [TARGET_2]: 0 } });
    const dependencies = { db: h.makeConcurrentDb() };

    const [resultA, resultB] = await Promise.all([
      economy.transfer({
        from: { type: 'character', ref: SENDER }, to: { type: 'character', ref: TARGET_1 },
        amount: 700, reason: 'race_a', module: 'test', idempotencyKey: 'concurrent-race-a'
      }, dependencies),
      economy.transfer({
        from: { type: 'character', ref: SENDER }, to: { type: 'character', ref: TARGET_2 },
        amount: 700, reason: 'race_b', module: 'test', idempotencyKey: 'concurrent-race-b'
      }, dependencies)
    ]);

    const outcomes = [resultA, resultB];
    const sucessos = outcomes.filter((r) => r.ok);
    const recusas = outcomes.filter((r) => !r.ok);

    assert.strictEqual(sucessos.length, 1, `exatamente uma das duas deveria ter passado: ${JSON.stringify(outcomes)}`);
    assert.strictEqual(recusas.length, 1);
    assert.strictEqual(recusas[0].code, 'insufficient_funds');

    // O saldo do remetente nunca pode ficar negativo — duplicar 700 a partir
    // de 700 e sair com -700 seria o exploit de duplicação que a Tarefa 7
    // existe para impedir.
    assert.strictEqual(h.state.gold[SENDER], 0);
    assert.ok(h.state.gold[SENDER] >= 0, 'saldo nunca pode ficar negativo sob corrida');
  });
});
