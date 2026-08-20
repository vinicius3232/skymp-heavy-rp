/**
 * resource-node-service.js
 *
 * **O Resource Node Framework.** Um nó de recurso (veio de minério, árvore) com
 * capacidade, regeneração calculada sob demanda, e uma única operação de
 * escrita — `consume` — que decrementa o nó e entrega o item numa única
 * transação. Nenhuma mineração, corte de árvore ou caça mora aqui: isto é o
 * motor genérico que uma profissão concreta (Minerador, Lenhador) vai chamar
 * depois de já ter checado distância, ferramenta e sessão de coleta — nenhuma
 * dessas três checagens é deste arquivo.
 *
 * ─── Por que `consume` entrega o item na MESMA transação que decrementa o nó ─
 *
 * Se fossem duas transações (decrementa nó, depois `transactionService
 * .giveItem`), uma falha entre as duas deixaria o nó mais pobre e o jogador
 * de mãos vazias — recurso destruído sem ninguém receber. `core
 * /transaction-service.js` já resolve exatamente esse problema para quem
 * precisa commitar dois efeitos juntos: exporta `tx.*`, primitivas que
 * participam da transação **do chamador** em vez de abrir a própria. É o
 * mesmo padrão que `crafting-service.js` usa para consumir ingrediente e
 * entregar resultado numa tacada.
 *
 * ─── Concorrência: por que travar por `id` já é suficiente ──────────────────
 *
 * Ao contrário de `profession-service.grantProfession` (que precisa travar
 * TODAS as linhas ativas do personagem para contar contra um limite),
 * `consume` só precisa da linha do PRÓPRIO nó: `SELECT ... WHERE id = ? FOR
 * UPDATE` serializa dois jogadores disputando o mesmo veio — o segundo lê a
 * capacidade já decrementada pelo primeiro, não a obsoleta. É o §25 do
 * briefing de profissões ("nem capacity = -1 nem duplicação"), resolvido pelo
 * mesmo mecanismo que `core/transaction-service._applyGoldDelta` já usa para
 * ouro.
 */

'use strict';

const database = require('./database');
const transactionService = require('./core/transaction-service');
const professionService = require('./profession-service');
const { isValidType } = require('./core/resource-node-registry');

// ─────────────────────────────────────────────────────────────────────────────
// Forma do FormDesc
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hex SEM prefixo `0x`, dois-pontos, nome do arquivo — a convenção do CLAUDE.md
 * do projeto ("célula e base são '162e2:Skyrim.esm'"). Validada aqui pelo
 * mesmo motivo que o documento a registra: um `0x162e2` não lança erro em
 * lugar nenhum do Papyrus, só deixa de funcionar em jogo.
 */
const FORM_DESC_SHAPE = /^[0-9a-f]{1,8}:[^:]+\.(esm|esp|esl)$/i;

function isValidFormDesc(v) {
  return typeof v === 'string' && FORM_DESC_SHAPE.test(v);
}

// ─────────────────────────────────────────────────────────────────────────────
// Auxiliares
// ─────────────────────────────────────────────────────────────────────────────

function _deps(dependencies = {}) {
  return {
    db: dependencies.db || database,
    transactionService: dependencies.transactionService || transactionService,
    professionService: dependencies.professionService || professionService
  };
}

function _isPositiveInt(v) {
  return Number.isSafeInteger(v) && v > 0;
}

/**
 * Capacidade atual, calculada — nunca gravada aqui. `elapsedMs` desde
 * `last_updated_at`, convertido em unidades por `regen_per_hour`, arredondado
 * para baixo (regenerar 0.9 de uma unidade não é regenerar nada), somado à
 * capacidade gravada, com teto em `max_capacity`.
 *
 * @param {{current_capacity:number, max_capacity:number, regen_per_hour:number, last_updated_at:Date|string}} row
 * @param {number} nowMs
 */
function _computeCapacity(row, nowMs) {
  const gravada = Number(row.current_capacity);
  if (gravada >= row.max_capacity) return row.max_capacity;
  const atualizadoEm = new Date(row.last_updated_at).getTime();
  const elapsedMs = Math.max(0, nowMs - atualizadoEm);
  const regenerado = Math.floor((elapsedMs / 3_600_000) * row.regen_per_hour);
  return Math.min(row.max_capacity, gravada + regenerado);
}

function _rowToState(row, nowMs) {
  if (!row) return null;
  const capacity = _computeCapacity(row, nowMs);
  return {
    id: row.id,
    formDesc: row.form_desc,
    type: row.type,
    resourceBaseId: row.resource_base_id,
    yieldPerAction: row.yield_per_action,
    capacity,
    maxCapacity: row.max_capacity,
    regenPerHour: row.regen_per_hour,
    requiredProfession: row.required_profession,
    requiredRank: row.required_rank,
    enabled: !!row.enabled,
    state: capacity > 0 ? 'available' : 'depleted'
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Criação / administração
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Registra um nó novo. Não passa por capability nem admin-action nesta fase —
 * não existe hoje nenhuma ferramenta em jogo para posicionar nó (isso é
 * trabalho de uma fase futura, quando Minerador precisar de verdade); até lá
 * isto é chamado por script de seed, sob revisão, como `crafting_recipes` já é
 * semeado por `seed-forging.sql`.
 *
 * @param {object} opts
 * @param {string} opts.formDesc
 * @param {string} opts.type um de core/resource-node-registry.NODE_TYPES
 * @param {number} opts.resourceBaseId
 * @param {number} opts.maxCapacity
 * @param {number} [opts.yieldPerAction] padrão 1
 * @param {number} [opts.regenPerHour] padrão 0
 * @param {string|null} [opts.requiredProfession]
 * @param {number|null} [opts.requiredRank]
 * @param {object} [dependencies]
 */
async function createNode(opts, dependencies = {}) {
  const deps = _deps(dependencies);
  const {
    formDesc, type, resourceBaseId, maxCapacity,
    yieldPerAction = 1, regenPerHour = 0,
    requiredProfession = null, requiredRank = null
  } = opts || {};

  if (!isValidFormDesc(formDesc)) return { ok: false, code: 'invalid_form_desc' };
  if (!isValidType(type)) return { ok: false, code: 'invalid_type' };
  if (!_isPositiveInt(resourceBaseId)) return { ok: false, code: 'invalid_resource_base_id' };
  if (!_isPositiveInt(maxCapacity)) return { ok: false, code: 'invalid_max_capacity' };
  if (!Number.isSafeInteger(yieldPerAction) || yieldPerAction <= 0) return { ok: false, code: 'invalid_yield' };
  if (!Number.isSafeInteger(regenPerHour) || regenPerHour < 0) return { ok: false, code: 'invalid_regen' };
  if (requiredRank !== null && (!Number.isInteger(requiredRank) || requiredRank < 0)) {
    return { ok: false, code: 'invalid_required_rank' };
  }

  const existing = await deps.db.query('SELECT id FROM resource_nodes WHERE form_desc = ?', [formDesc]);
  if (existing.length > 0) return { ok: false, code: 'form_desc_taken' };

  const result = await deps.db.query(
    `INSERT INTO resource_nodes
      (form_desc, type, resource_base_id, yield_per_action, max_capacity, current_capacity,
       regen_per_hour, required_profession, required_rank)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [formDesc, type, resourceBaseId, yieldPerAction, maxCapacity, maxCapacity, regenPerHour, requiredProfession, requiredRank]
  );

  return { ok: true, data: { id: result.insertId } };
}

/** @param {string} formDesc @param {boolean} enabled @param {object} [dependencies] */
async function setNodeEnabled(formDesc, enabled, dependencies = {}) {
  const deps = _deps(dependencies);
  const result = await deps.db.query('UPDATE resource_nodes SET enabled = ? WHERE form_desc = ?', [enabled ? 1 : 0, formDesc]);
  return { ok: result.affectedRows > 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// Consulta
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Estado atual do nó, com a capacidade JÁ recalculada — leitura pura, não
 * grava nada. @param {string} formDesc @param {object} [dependencies]
 */
async function getNode(formDesc, dependencies = {}) {
  const deps = _deps(dependencies);
  const rows = await deps.db.query('SELECT * FROM resource_nodes WHERE form_desc = ?', [formDesc]);
  return rows.length > 0 ? _rowToState(rows[0], Date.now()) : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Consumo
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Consome uma coleta do nó e entrega o item, atomicamente.
 *
 * Resultado tipado, mesma convenção de `profession-service.js`: `{ok:true,
 * data}` para sucesso, `{ok:false, code}` para recusa esperada (nó esgotado,
 * desativado, gate de profissão/rank), e LANÇA para falha de infraestrutura.
 *
 * @param {object} opts
 * @param {number} opts.characterId
 * @param {number} [opts.actorId] necessário só para refletir no cliente (ver
 *   `transactionService.tx.applyToClient`); omitido, o item fica correto no
 *   banco e é reconciliado no próximo login, mesmo comportamento de
 *   `transaction-service.giveItem`.
 * @param {string} opts.formDesc
 * @param {object} [dependencies]
 */
async function consume(opts, dependencies = {}) {
  const deps = _deps(dependencies);
  const { characterId, actorId = null, formDesc } = opts || {};

  if (!_isPositiveInt(characterId)) return { ok: false, code: 'invalid_character' };
  if (!isValidFormDesc(formDesc)) return { ok: false, code: 'invalid_form_desc' };

  const conn = await deps.db.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query('SELECT * FROM resource_nodes WHERE form_desc = ? FOR UPDATE', [formDesc]);
    const row = rows[0] || null;
    if (!row) {
      await conn.rollback();
      return { ok: false, code: 'not_found' };
    }
    if (!row.enabled) {
      await conn.rollback();
      return { ok: false, code: 'node_disabled' };
    }

    if (row.required_profession) {
      const tem = await deps.professionService.hasProfession(characterId, row.required_profession, { db: deps.db });
      if (!tem) {
        await conn.rollback();
        return { ok: false, code: 'profession_required', data: { required: row.required_profession } };
      }
      if (row.required_rank !== null) {
        const estado = await deps.professionService.getProfessionState(characterId, row.required_profession, { db: deps.db });
        if (!estado || estado.rank < row.required_rank) {
          await conn.rollback();
          return { ok: false, code: 'rank_too_low', data: { required: row.required_rank, current: estado ? estado.rank : 0 } };
        }
      }
    }

    const nowMs = Date.now();
    const capacidadeAtual = _computeCapacity(row, nowMs);
    if (capacidadeAtual < row.yield_per_action) {
      // Ainda grava a capacidade recalculada — sem isso, um nó parado (sem
      // ninguém tentando colher) nunca avança `last_updated_at`, e a próxima
      // tentativa recalcularia desde um instante cada vez mais antigo. Isso é
      // inofensivo matematicamente (o cálculo é sempre "desde o último valor
      // gravado", não "desde sempre"), mas gravar aqui mantém o dado em disco
      // honesto para quem consultar `getNode` direto no banco.
      await conn.query(
        'UPDATE resource_nodes SET current_capacity = ?, last_updated_at = ? WHERE id = ?',
        [capacidadeAtual, new Date(nowMs), row.id]
      );
      await conn.commit();
      return { ok: false, code: 'depleted', data: { capacity: capacidadeAtual } };
    }

    const novaCapacidade = capacidadeAtual - row.yield_per_action;
    await conn.query(
      'UPDATE resource_nodes SET current_capacity = ?, last_updated_at = ? WHERE id = ?',
      [novaCapacidade, new Date(nowMs), row.id]
    );

    // Mesma transação: o recurso só sai do nó se o item entrar no inventário.
    await deps.transactionService.tx.applyInventoryDelta(conn, characterId, row.resource_base_id, row.yield_per_action);
    await deps.transactionService.tx.recordInventoryLedger(conn, {
      characterId,
      baseId: row.resource_base_id,
      delta: row.yield_per_action,
      reason: `resource_node:${formDesc}`,
      module: 'resource-node'
    });

    await conn.commit();

    // Depois do commit, igual a `transaction-service.giveItem` — banco é a
    // fonte de verdade, cliente é reconciliado se isto falhar.
    deps.transactionService.tx.applyToClient(actorId, row.resource_base_id, row.yield_per_action);

    return {
      ok: true,
      data: {
        formDesc,
        resourceBaseId: row.resource_base_id,
        yield: row.yield_per_action,
        capacity: novaCapacidade,
        maxCapacity: row.max_capacity
      }
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = {
  isValidFormDesc,
  createNode,
  setNodeEnabled,
  getNode,
  consume,
  // Exposto só para teste.
  _computeCapacity,
  _rowToState
};
