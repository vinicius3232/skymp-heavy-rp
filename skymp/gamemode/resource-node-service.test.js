/**
 * resource-node-service.test.js
 *
 * Executa com: node --test resource-node-service.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { describe, it } = require('node:test');

const resourceNodeService = require('./resource-node-service');

const FORM_DESC = '4a2f0:Skyrim.esm';
const CHAR_A = 101;
const RESOURCE_ID = 0x0005ace4;

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

function makeHarness(options = {}) {
  const state = {
    nodes: (options.nodes || []).map((n) => ({ ...n })),
    nextId: options.nextId || 1,
    inventory: { ...(options.inventory || {}) },
    ledger: [],
    clientCalls: [],
    events: [],
    locks: []
  };

  function findByFormDesc(formDesc) {
    return state.nodes.find((n) => n.form_desc === formDesc) || null;
  }

  const conn = {
    beginTransaction: async () => { state.events.push('begin'); },
    commit: async () => { state.events.push('commit'); },
    rollback: async () => { state.events.push('rollback'); },
    release: () => { state.events.push('release'); },
    query: async (sql, params = []) => {
      if (options.failOn && new RegExp(options.failOn, 'i').test(sql)) {
        throw new Error('conexao com o banco caiu');
      }
      if (/SELECT \* FROM resource_nodes WHERE form_desc = \? FOR UPDATE/i.test(sql)) {
        state.locks.push(`node:${params[0]}`);
        const row = findByFormDesc(params[0]);
        return [row ? [{ ...row }] : []];
      }
      if (/UPDATE resource_nodes SET current_capacity = \?, last_updated_at = \? WHERE id = \?/i.test(sql)) {
        const row = state.nodes.find((n) => n.id === params[2]);
        row.current_capacity = params[0];
        row.last_updated_at = params[1];
        return [{ affectedRows: 1 }];
      }
      throw new Error(`SQL inesperado (conn.query) no harness: ${sql}`);
    }
  };

  const db = {
    getConnection: async () => conn,
    query: async (sql, params = []) => {
      if (/SELECT id FROM resource_nodes WHERE form_desc = \?/i.test(sql)) {
        const row = findByFormDesc(params[0]);
        return row ? [{ id: row.id }] : [];
      }
      if (/INSERT INTO resource_nodes/i.test(sql)) {
        const row = {
          id: state.nextId++,
          form_desc: params[0], type: params[1], resource_base_id: params[2],
          yield_per_action: params[3], max_capacity: params[4], current_capacity: params[5],
          regen_per_hour: params[6], required_profession: params[7], required_rank: params[8],
          enabled: 1, last_updated_at: new Date()
        };
        state.nodes.push(row);
        return { insertId: row.id, affectedRows: 1 };
      }
      if (/UPDATE resource_nodes SET enabled = \? WHERE form_desc = \?/i.test(sql)) {
        const row = findByFormDesc(params[1]);
        if (!row) return { affectedRows: 0 };
        row.enabled = params[0];
        return { affectedRows: 1 };
      }
      if (/SELECT \* FROM resource_nodes WHERE form_desc = \?/i.test(sql)) {
        const row = findByFormDesc(params[0]);
        return row ? [{ ...row }] : [];
      }
      throw new Error(`SQL inesperado (db.query) no harness: ${sql}`);
    }
  };

  const transactionServiceFake = {
    tx: {
      applyInventoryDelta: async (_conn, characterId, baseId, delta) => {
        state.inventory[`${characterId}:${baseId}`] = (state.inventory[`${characterId}:${baseId}`] || 0) + delta;
      },
      recordInventoryLedger: async (_conn, opts) => { state.ledger.push(opts); },
      applyToClient: (actorId, baseId, delta) => { state.clientCalls.push({ actorId, baseId, delta }); }
    }
  };

  const professionServiceFake = {
    hasProfession: async (characterId, code) => {
      const set = options.professions && options.professions[characterId];
      return !!set && set.has(code);
    },
    getProfessionState: async (characterId, code) => {
      const ranks = options.ranks && options.ranks[characterId];
      if (!ranks || ranks[code] === undefined) return null;
      return { characterId, professionCode: code, status: 'active', rank: ranks[code], xp: 0 };
    }
  };

  return {
    state,
    dependencies: { db, transactionService: transactionServiceFake, professionService: professionServiceFake }
  };
}

function baseNode(overrides = {}) {
  return {
    id: 1,
    form_desc: FORM_DESC,
    type: 'ORE',
    resource_base_id: RESOURCE_ID,
    yield_per_action: 1,
    max_capacity: 10,
    current_capacity: 10,
    regen_per_hour: 0,
    required_profession: null,
    required_rank: null,
    enabled: 1,
    last_updated_at: new Date(),
    ...overrides
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// isValidFormDesc
// ─────────────────────────────────────────────────────────────────────────────

describe('resource-node-service — isValidFormDesc', () => {
  it('aceita hex sem prefixo + nome do arquivo', () => {
    assert.strictEqual(resourceNodeService.isValidFormDesc('4a2f0:Skyrim.esm'), true);
    assert.strictEqual(resourceNodeService.isValidFormDesc('162e2:MeuMod.esp'), true);
  });

  it('recusa 0x como prefixo — a armadilha documentada no CLAUDE.md do projeto', () => {
    assert.strictEqual(resourceNodeService.isValidFormDesc('0x4a2f0:Skyrim.esm'), false);
  });

  it('recusa sem arquivo ou sem hex', () => {
    assert.strictEqual(resourceNodeService.isValidFormDesc('4a2f0'), false);
    assert.strictEqual(resourceNodeService.isValidFormDesc(':Skyrim.esm'), false);
    assert.strictEqual(resourceNodeService.isValidFormDesc(42), false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createNode
// ─────────────────────────────────────────────────────────────────────────────

describe('resource-node-service — createNode', () => {
  it('cria um nó válido', async () => {
    const h = makeHarness();
    const r = await resourceNodeService.createNode({
      formDesc: FORM_DESC, type: 'ORE', resourceBaseId: RESOURCE_ID, maxCapacity: 10, regenPerHour: 5
    }, h.dependencies);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(h.state.nodes.length, 1);
    assert.strictEqual(h.state.nodes[0].current_capacity, 10, 'nasce com capacidade cheia');
  });

  it('recusa FormDesc inválido, type inválido, ou duplicado', async () => {
    const h = makeHarness();
    assert.strictEqual((await resourceNodeService.createNode({ formDesc: '0x4a2f0:Skyrim.esm', type: 'ORE', resourceBaseId: 1, maxCapacity: 10 }, h.dependencies)).code, 'invalid_form_desc');
    assert.strictEqual((await resourceNodeService.createNode({ formDesc: FORM_DESC, type: 'MITHRIL', resourceBaseId: 1, maxCapacity: 10 }, h.dependencies)).code, 'invalid_type');

    await resourceNodeService.createNode({ formDesc: FORM_DESC, type: 'ORE', resourceBaseId: RESOURCE_ID, maxCapacity: 10 }, h.dependencies);
    const dup = await resourceNodeService.createNode({ formDesc: FORM_DESC, type: 'ORE', resourceBaseId: RESOURCE_ID, maxCapacity: 10 }, h.dependencies);
    assert.deepStrictEqual(dup, { ok: false, code: 'form_desc_taken' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getNode / cálculo de regeneração
// ─────────────────────────────────────────────────────────────────────────────

describe('resource-node-service — regeneração calculada sob demanda', () => {
  it('não regenera acima de max_capacity', () => {
    const row = baseNode({ current_capacity: 10, max_capacity: 10, regen_per_hour: 100, last_updated_at: new Date(Date.now() - 999_999_999) });
    assert.strictEqual(resourceNodeService._computeCapacity(row, Date.now()), 10);
  });

  it('regenera proporcionalmente ao tempo decorrido, arredondado para baixo', () => {
    const umaHoraAtras = Date.now() - 3_600_000;
    const row = baseNode({ current_capacity: 0, max_capacity: 10, regen_per_hour: 5, last_updated_at: new Date(umaHoraAtras) });
    assert.strictEqual(resourceNodeService._computeCapacity(row, Date.now()), 5);
  });

  it('meia hora regenera metade, arredondado para baixo (nunca fração)', () => {
    const meiaHoraAtras = Date.now() - 1_800_000;
    const row = baseNode({ current_capacity: 0, max_capacity: 10, regen_per_hour: 5, last_updated_at: new Date(meiaHoraAtras) });
    assert.strictEqual(resourceNodeService._computeCapacity(row, Date.now()), 2);
  });

  it('getNode nunca escreve — capacidade regenerada só aparece na leitura', async () => {
    const umaHoraAtras = new Date(Date.now() - 3_600_000);
    const h = makeHarness({ nodes: [baseNode({ current_capacity: 0, regen_per_hour: 5, last_updated_at: umaHoraAtras })] });
    const estado = await resourceNodeService.getNode(FORM_DESC, h.dependencies);
    assert.strictEqual(estado.capacity, 5);
    assert.strictEqual(h.state.nodes[0].current_capacity, 0, 'getNode não deveria persistir nada');
    assert.strictEqual(h.state.nodes[0].last_updated_at.getTime(), umaHoraAtras.getTime());
  });

  it('devolve null para nó inexistente', async () => {
    const h = makeHarness();
    assert.strictEqual(await resourceNodeService.getNode(FORM_DESC, h.dependencies), null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// consume
// ─────────────────────────────────────────────────────────────────────────────

describe('resource-node-service — consume', () => {
  it('decrementa o nó e entrega o item na MESMA transação', async () => {
    const h = makeHarness({ nodes: [baseNode({ current_capacity: 10, yield_per_action: 2 })] });
    const r = await resourceNodeService.consume({ characterId: CHAR_A, actorId: 0xff01, formDesc: FORM_DESC }, h.dependencies);

    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.data.capacity, 8);
    assert.strictEqual(h.state.inventory[`${CHAR_A}:${RESOURCE_ID}`], 2);
    assert.strictEqual(h.state.ledger.length, 1);
    assert.strictEqual(h.state.ledger[0].delta, 2);
    assert.deepStrictEqual(h.state.clientCalls[0], { actorId: 0xff01, baseId: RESOURCE_ID, delta: 2 });
    assert.deepStrictEqual(h.state.events, ['begin', 'commit', 'release']);
  });

  it('recusa nó esgotado, sem entregar item nem alterar o inventário', async () => {
    const h = makeHarness({ nodes: [baseNode({ current_capacity: 0, regen_per_hour: 0 })] });
    const r = await resourceNodeService.consume({ characterId: CHAR_A, formDesc: FORM_DESC }, h.dependencies);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'depleted');
    assert.strictEqual(h.state.inventory[`${CHAR_A}:${RESOURCE_ID}`], undefined);
    assert.ok(h.state.events.includes('commit'), 'esgotado ainda commita a capacidade recalculada');
  });

  it('recusa nó inexistente', async () => {
    const h = makeHarness();
    const r = await resourceNodeService.consume({ characterId: CHAR_A, formDesc: FORM_DESC }, h.dependencies);
    assert.deepStrictEqual(r, { ok: false, code: 'not_found' });
  });

  it('recusa nó desativado', async () => {
    const h = makeHarness({ nodes: [baseNode({ enabled: 0 })] });
    const r = await resourceNodeService.consume({ characterId: CHAR_A, formDesc: FORM_DESC }, h.dependencies);
    assert.deepStrictEqual(r, { ok: false, code: 'node_disabled' });
    assert.ok(h.state.events.includes('rollback'));
  });

  it('recusa characterId inválido sem tocar o banco', async () => {
    const h = makeHarness({ nodes: [baseNode()] });
    const r = await resourceNodeService.consume({ characterId: -1, formDesc: FORM_DESC }, h.dependencies);
    assert.deepStrictEqual(r, { ok: false, code: 'invalid_character' });
    assert.deepStrictEqual(h.state.events, []);
  });

  it('respeita required_profession — recusa quem não tem a profissão', async () => {
    const h = makeHarness({
      nodes: [baseNode({ required_profession: 'miner' })],
      professions: { [CHAR_A]: new Set() }
    });
    const r = await resourceNodeService.consume({ characterId: CHAR_A, formDesc: FORM_DESC }, h.dependencies);
    assert.deepStrictEqual(r, { ok: false, code: 'profession_required', data: { required: 'miner' } });
  });

  it('respeita required_rank — recusa rank insuficiente', async () => {
    const h = makeHarness({
      nodes: [baseNode({ required_profession: 'miner', required_rank: 2 })],
      professions: { [CHAR_A]: new Set(['miner']) },
      ranks: { [CHAR_A]: { miner: 1 } }
    });
    const r = await resourceNodeService.consume({ characterId: CHAR_A, formDesc: FORM_DESC }, h.dependencies);
    assert.deepStrictEqual(r, { ok: false, code: 'rank_too_low', data: { required: 2, current: 1 } });
  });

  it('libera quando profissão e rank batem', async () => {
    const h = makeHarness({
      nodes: [baseNode({ required_profession: 'miner', required_rank: 2 })],
      professions: { [CHAR_A]: new Set(['miner']) },
      ranks: { [CHAR_A]: { miner: 2 } }
    });
    const r = await resourceNodeService.consume({ characterId: CHAR_A, formDesc: FORM_DESC }, h.dependencies);
    assert.strictEqual(r.ok, true);
  });

  it('travou a linha do nó por FOR UPDATE antes de decidir (§25 do briefing — duas colheitas, um veio)', async () => {
    const h = makeHarness({ nodes: [baseNode()] });
    await resourceNodeService.consume({ characterId: CHAR_A, formDesc: FORM_DESC }, h.dependencies);
    assert.ok(h.state.locks.includes(`node:${FORM_DESC}`));
  });

  it('esvazia exatamente no limite: última unidade some, próxima recusa', async () => {
    const h = makeHarness({ nodes: [baseNode({ current_capacity: 1, yield_per_action: 1 })] });
    const primeira = await resourceNodeService.consume({ characterId: CHAR_A, formDesc: FORM_DESC }, h.dependencies);
    assert.strictEqual(primeira.ok, true);
    assert.strictEqual(primeira.data.capacity, 0);

    const segunda = await resourceNodeService.consume({ characterId: CHAR_A, formDesc: FORM_DESC }, h.dependencies);
    assert.strictEqual(segunda.ok, false);
    assert.strictEqual(segunda.code, 'depleted');
  });

  it('falha de infraestrutura LANÇA e faz rollback, nunca entrega item parcial', async () => {
    const h = makeHarness({ nodes: [baseNode()], failOn: 'UPDATE resource_nodes' });
    await assert.rejects(() => resourceNodeService.consume({ characterId: CHAR_A, formDesc: FORM_DESC }, h.dependencies));
    assert.ok(h.state.events.includes('rollback'));
    assert.strictEqual(h.state.inventory[`${CHAR_A}:${RESOURCE_ID}`], undefined);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// setNodeEnabled
// ─────────────────────────────────────────────────────────────────────────────

describe('resource-node-service — setNodeEnabled', () => {
  it('liga e desliga um nó existente', async () => {
    const h = makeHarness({ nodes: [baseNode()] });
    const r = await resourceNodeService.setNodeEnabled(FORM_DESC, false, h.dependencies);
    assert.deepStrictEqual(r, { ok: true });
    assert.strictEqual(h.state.nodes[0].enabled, 0);
  });

  it('devolve ok:false para nó inexistente', async () => {
    const h = makeHarness();
    const r = await resourceNodeService.setNodeEnabled(FORM_DESC, false, h.dependencies);
    assert.deepStrictEqual(r, { ok: false });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A migration bate com o que o serviço lê e escreve
// ─────────────────────────────────────────────────────────────────────────────

describe('a migration-v19 declara toda coluna que resource-node-service usa', () => {
  const sql = fs.readFileSync(
    path.resolve(__dirname, '..', 'packages', 'database', 'migration-v19-resource-nodes.sql'),
    'utf8'
  );
  const criacao = sql.slice(
    sql.indexOf('CREATE TABLE IF NOT EXISTS `resource_nodes`'),
    sql.indexOf('ALTER TABLE')
  );

  const COLUNAS_USADAS = [
    'id', 'form_desc', 'type', 'resource_base_id', 'yield_per_action',
    'max_capacity', 'current_capacity', 'regen_per_hour', 'last_updated_at',
    'required_profession', 'required_rank', 'enabled'
  ];

  for (const coluna of COLUNAS_USADAS) {
    it(`declara a coluna '${coluna}'`, () => {
      assert.ok(criacao.includes(`\`${coluna}\``), `coluna '${coluna}' usada em resource-node-service.js mas ausente da migration-v19`);
    });
  }

  it('tem a UNIQUE de form_desc — um objeto do mundo só pode ser um nó', () => {
    assert.ok(/UNIQUE KEY .*\(`form_desc`\)/.test(criacao));
  });
});
