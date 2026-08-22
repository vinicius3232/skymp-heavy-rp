/**
 * profession-service.test.js
 *
 * O harness é deliberadamente burro: um SELECT ... FOR UPDATE devolve a linha
 * inteira do estado em memória, não só as colunas pedidas — o que importa aqui
 * é a SEQUÊNCIA de operações (lock → decide → escreve → commit) e os códigos
 * de recusa, não simular o MySQL de verdade. Concorrência real (duas
 * transações disputando a mesma linha) não é provável com um mock síncrono —
 * só um teste de integração contra um MySQL real prova isso; o que os testes
 * de concorrência abaixo provam é que a ORDEM das queries (lock antes de
 * contar, contar antes de decidir) está certa, que é a mesma limitação que
 * `core/economy-service.test.js` já assume.
 *
 * Executa com: node --test profession-service.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { describe, it, beforeEach } = require('node:test');

const professionService = require('./profession-service');
const professionRegistry = require('./core/profession-registry');

const { STATUS } = professionService;

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

function makeHarness(options = {}) {
  const state = {
    rows: (options.rows || []).map((r) => ({ ...r })),
    nextId: options.nextId || 1,
    locks: [],
    events: []
  };

  function findRow(characterId, professionCode) {
    return state.rows.find((r) => r.character_id === characterId && r.profession_code === professionCode) || null;
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

      if (/SELECT id,? ?.*FROM character_professions WHERE character_id = \? AND status = 'active' FOR UPDATE/i.test(sql)) {
        const ativos = state.rows.filter((r) => r.character_id === params[0] && r.status === STATUS.ACTIVE);
        state.locks.push(`active:${params[0]}`);
        return [ativos.map((r) => ({ id: r.id }))];
      }

      if (/SELECT .*FROM character_professions WHERE character_id = \? AND profession_code = \? FOR UPDATE/i.test(sql)) {
        state.locks.push(`row:${params[0]}:${params[1]}`);
        const row = findRow(params[0], params[1]);
        return [row ? [{ ...row }] : []];
      }

      if (/UPDATE character_professions SET status = 'active', granted_by_character_id = \?, joined_at = CURRENT_TIMESTAMP WHERE id = \?/i.test(sql)) {
        const row = state.rows.find((r) => r.id === params[1]);
        row.status = STATUS.ACTIVE;
        row.granted_by_character_id = params[0];
        return [{ affectedRows: 1 }];
      }

      if (/INSERT INTO character_professions/i.test(sql)) {
        const row = {
          id: state.nextId++,
          character_id: params[0],
          profession_code: params[1],
          status: STATUS.ACTIVE,
          rank: 0,
          xp: 0,
          granted_by_character_id: params[2],
          joined_at: new Date(),
          updated_at: new Date()
        };
        state.rows.push(row);
        return [{ affectedRows: 1, insertId: row.id }];
      }

      if (/UPDATE character_professions SET status = \? WHERE id = \?/i.test(sql)) {
        const row = state.rows.find((r) => r.id === params[1]);
        row.status = params[0];
        return [{ affectedRows: 1 }];
      }

      if (/UPDATE character_professions SET rank = \? WHERE id = \?/i.test(sql)) {
        const row = state.rows.find((r) => r.id === params[1]);
        row.rank = params[0];
        return [{ affectedRows: 1 }];
      }

      if (/UPDATE character_professions SET xp = \? WHERE id = \?/i.test(sql)) {
        const row = state.rows.find((r) => r.id === params[1]);
        row.xp = params[0];
        return [{ affectedRows: 1 }];
      }

      throw new Error(`SQL inesperado no harness: ${sql}`);
    }
  };

  const db = {
    getConnection: async () => conn,
    query: async (sql, params = []) => {
      if (/SELECT \* FROM character_professions WHERE character_id = \? AND profession_code = \?/i.test(sql)) {
        const row = findRow(params[0], params[1]);
        return row ? [{ ...row }] : [];
      }
      if (/SELECT \* FROM character_professions WHERE character_id = \? ORDER BY profession_code/i.test(sql)) {
        return state.rows.filter((r) => r.character_id === params[0]).map((r) => ({ ...r }));
      }
      throw new Error(`SQL inesperado (db.query) no harness: ${sql}`);
    }
  };

  const moduleRegistryFake = { isEnabled: () => options.moduleEnabled !== false };
  const serverOptionsFake = {
    get: (key) => {
      if (key === 'profession.maxPerCharacter') return options.maxPerCharacter ?? 3;
      if (key === 'profession.maxRank') return options.maxRank ?? 3;
      throw new Error(`server-options desconhecida no harness: ${key}`);
    }
  };

  return {
    state,
    dependencies: { db, moduleRegistry: moduleRegistryFake, serverOptions: serverOptionsFake, registry: professionRegistry }
  };
}

const CHAR_A = 101;

beforeEach(() => {
  professionRegistry._reset();
  professionRegistry.registerBuiltins();
});

// ─────────────────────────────────────────────────────────────────────────────
// grantProfession
// ─────────────────────────────────────────────────────────────────────────────

describe('profession-service — grantProfession', () => {
  it('recusa quando o módulo está desligado (ENABLE_PROFESSION_SERVICE)', async () => {
    const h = makeHarness({ moduleEnabled: false });
    const r = await professionService.grantProfession({ characterId: CHAR_A, professionCode: 'miner' }, h.dependencies);
    assert.deepStrictEqual(r, { ok: false, code: 'module_disabled' });
  });

  it('recusa profissão desconhecida', async () => {
    const h = makeHarness();
    const r = await professionService.grantProfession({ characterId: CHAR_A, professionCode: 'does_not_exist' }, h.dependencies);
    assert.deepStrictEqual(r, { ok: false, code: 'unknown_profession' });
  });

  it('recusa profissão desativada no catálogo', async () => {
    professionRegistry.register({ code: 'fisher', label: 'Pescador', category: 'gathering', enabled: false });
    const h = makeHarness();
    const r = await professionService.grantProfession({ characterId: CHAR_A, professionCode: 'fisher' }, h.dependencies);
    assert.deepStrictEqual(r, { ok: false, code: 'profession_disabled' });
  });

  it('concede a profissão e persiste o estado', async () => {
    const h = makeHarness();
    const r = await professionService.grantProfession(
      { characterId: CHAR_A, professionCode: 'miner', grantedByCharacterId: 900 },
      h.dependencies
    );
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.data.status, STATUS.ACTIVE);
    assert.strictEqual(r.data.rank, 0);
    assert.strictEqual(r.data.xp, 0);
    assert.strictEqual(r.data.grantedByCharacterId, 900);

    const estado = await professionService.getProfessionState(CHAR_A, 'miner', h.dependencies);
    assert.strictEqual(estado.status, STATUS.ACTIVE);
  });

  it('recusa concessão duplicada (já ativa)', async () => {
    const h = makeHarness({ rows: [{ id: 1, character_id: CHAR_A, profession_code: 'miner', status: STATUS.ACTIVE, rank: 0, xp: 0 }] });
    const r = await professionService.grantProfession({ characterId: CHAR_A, professionCode: 'miner' }, h.dependencies);
    assert.deepStrictEqual(r, { ok: false, code: 'already_active' });
  });

  it('recusa conceder por cima de uma suspensa — direciona para reactivateProfession', async () => {
    const h = makeHarness({ rows: [{ id: 1, character_id: CHAR_A, profession_code: 'miner', status: STATUS.SUSPENDED, rank: 1, xp: 50 }] });
    const r = await professionService.grantProfession({ characterId: CHAR_A, professionCode: 'miner' }, h.dependencies);
    assert.deepStrictEqual(r, { ok: false, code: 'suspended_use_reactivate' });
  });

  it('reconcede uma profissão revogada, reaproveitando rank/xp como histórico', async () => {
    const h = makeHarness({ rows: [{ id: 1, character_id: CHAR_A, profession_code: 'miner', status: STATUS.REVOKED, rank: 2, xp: 300 }] });
    const r = await professionService.grantProfession({ characterId: CHAR_A, professionCode: 'miner' }, h.dependencies);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.data.status, STATUS.ACTIVE);
    assert.strictEqual(r.data.rank, 2, 'rank antigo deveria ser preservado na reconcessão');
    assert.strictEqual(r.data.xp, 300, 'xp antigo deveria ser preservado na reconcessão');
    assert.strictEqual(h.state.rows.length, 1, 'não deveria criar uma segunda linha');
  });

  it('respeita profession.maxPerCharacter (§7 do briefing)', async () => {
    const h = makeHarness({
      maxPerCharacter: 2,
      rows: [
        { id: 1, character_id: CHAR_A, profession_code: 'miner', status: STATUS.ACTIVE, rank: 0, xp: 0 },
        { id: 2, character_id: CHAR_A, profession_code: 'lumberjack', status: STATUS.ACTIVE, rank: 0, xp: 0 }
      ]
    });
    const r = await professionService.grantProfession({ characterId: CHAR_A, professionCode: 'hunter' }, h.dependencies);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'max_professions_reached');
    assert.deepStrictEqual(r.data, { max: 2, active: 2 });
  });

  it('profissão suspensa NÃO conta contra o limite', async () => {
    const h = makeHarness({
      maxPerCharacter: 1,
      rows: [{ id: 1, character_id: CHAR_A, profession_code: 'miner', status: STATUS.SUSPENDED, rank: 0, xp: 0 }]
    });
    const r = await professionService.grantProfession({ characterId: CHAR_A, professionCode: 'lumberjack' }, h.dependencies);
    assert.strictEqual(r.ok, true, 'suspensa não deveria ocupar a vaga do limite');
  });

  it('trava as linhas ativas ANTES de decidir — ordem que sustenta a concorrência (§25)', async () => {
    const h = makeHarness();
    await professionService.grantProfession({ characterId: CHAR_A, professionCode: 'miner' }, h.dependencies);
    assert.ok(h.state.locks.includes(`row:${CHAR_A}:miner`));
    assert.ok(h.state.locks.includes(`active:${CHAR_A}`));
    assert.deepStrictEqual(h.state.events, ['begin', 'commit', 'release']);
  });

  it('caracterId inválido é recusado sem tocar o banco', async () => {
    const h = makeHarness();
    const r = await professionService.grantProfession({ characterId: -1, professionCode: 'miner' }, h.dependencies);
    assert.deepStrictEqual(r, { ok: false, code: 'invalid_character' });
    assert.deepStrictEqual(h.state.events, []);
  });

  it('falha de infraestrutura LANÇA, não devolve {ok:false}', async () => {
    const h = makeHarness({ failOn: 'FOR UPDATE' });
    await assert.rejects(
      () => professionService.grantProfession({ characterId: CHAR_A, professionCode: 'miner' }, h.dependencies)
    );
    assert.ok(h.state.events.includes('rollback'), 'deveria fazer rollback antes de propagar');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// revoke / suspend / reactivate
// ─────────────────────────────────────────────────────────────────────────────

describe('profession-service — ciclo de vida', () => {
  it('revoga uma profissão ativa', async () => {
    const h = makeHarness({ rows: [{ id: 1, character_id: CHAR_A, profession_code: 'miner', status: STATUS.ACTIVE, rank: 1, xp: 10 }] });
    const r = await professionService.revokeProfession({ characterId: CHAR_A, professionCode: 'miner' }, h.dependencies);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.data.status, STATUS.REVOKED);
  });

  it('revoga uma profissão suspensa também', async () => {
    const h = makeHarness({ rows: [{ id: 1, character_id: CHAR_A, profession_code: 'miner', status: STATUS.SUSPENDED, rank: 1, xp: 10 }] });
    const r = await professionService.revokeProfession({ characterId: CHAR_A, professionCode: 'miner' }, h.dependencies);
    assert.strictEqual(r.ok, true);
  });

  it('recusa revogar profissão inexistente', async () => {
    const h = makeHarness();
    const r = await professionService.revokeProfession({ characterId: CHAR_A, professionCode: 'miner' }, h.dependencies);
    assert.deepStrictEqual(r, { ok: false, code: 'not_found' });
  });

  it('recusa revogar profissão já revogada', async () => {
    const h = makeHarness({ rows: [{ id: 1, character_id: CHAR_A, profession_code: 'miner', status: STATUS.REVOKED, rank: 0, xp: 0 }] });
    const r = await professionService.revokeProfession({ characterId: CHAR_A, professionCode: 'miner' }, h.dependencies);
    assert.deepStrictEqual(r, { ok: false, code: 'already_revoked', data: { currentStatus: STATUS.REVOKED } });
  });

  it('suspende uma profissão ativa', async () => {
    const h = makeHarness({ rows: [{ id: 1, character_id: CHAR_A, profession_code: 'miner', status: STATUS.ACTIVE, rank: 1, xp: 10 }] });
    const r = await professionService.suspendProfession({ characterId: CHAR_A, professionCode: 'miner' }, h.dependencies);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.data.status, STATUS.SUSPENDED);
    assert.strictEqual(r.data.rank, 1, 'suspender preserva o histórico');
  });

  it('recusa suspender profissão que não está ativa', async () => {
    const h = makeHarness({ rows: [{ id: 1, character_id: CHAR_A, profession_code: 'miner', status: STATUS.REVOKED, rank: 0, xp: 0 }] });
    const r = await professionService.suspendProfession({ characterId: CHAR_A, professionCode: 'miner' }, h.dependencies);
    assert.deepStrictEqual(r, { ok: false, code: 'not_active', data: { currentStatus: STATUS.REVOKED } });
  });

  it('reativa uma profissão suspensa', async () => {
    const h = makeHarness({ rows: [{ id: 1, character_id: CHAR_A, profession_code: 'miner', status: STATUS.SUSPENDED, rank: 2, xp: 80 }] });
    const r = await professionService.reactivateProfession({ characterId: CHAR_A, professionCode: 'miner' }, h.dependencies);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.data.status, STATUS.ACTIVE);
    assert.strictEqual(r.data.rank, 2);
  });

  it('recusa reativar quando o limite já está ocupado por outra profissão', async () => {
    const h = makeHarness({
      maxPerCharacter: 1,
      rows: [
        { id: 1, character_id: CHAR_A, profession_code: 'miner', status: STATUS.SUSPENDED, rank: 0, xp: 0 },
        { id: 2, character_id: CHAR_A, profession_code: 'lumberjack', status: STATUS.ACTIVE, rank: 0, xp: 0 }
      ]
    });
    const r = await professionService.reactivateProfession({ characterId: CHAR_A, professionCode: 'miner' }, h.dependencies);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'max_professions_reached');
  });

  it('recusa reativar profissão que não está suspensa', async () => {
    const h = makeHarness({ rows: [{ id: 1, character_id: CHAR_A, profession_code: 'miner', status: STATUS.ACTIVE, rank: 0, xp: 0 }] });
    const r = await professionService.reactivateProfession({ characterId: CHAR_A, professionCode: 'miner' }, h.dependencies);
    assert.deepStrictEqual(r, { ok: false, code: 'not_suspended', data: { currentStatus: STATUS.ACTIVE } });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rank
// ─────────────────────────────────────────────────────────────────────────────

describe('profession-service — setProfessionRank', () => {
  it('define um rank válido', async () => {
    const h = makeHarness({ rows: [{ id: 1, character_id: CHAR_A, profession_code: 'miner', status: STATUS.ACTIVE, rank: 0, xp: 0 }] });
    const r = await professionService.setProfessionRank({ characterId: CHAR_A, professionCode: 'miner', rank: 2 }, h.dependencies);
    assert.deepStrictEqual(r, { ok: true, data: { previousRank: 0, rank: 2 } });
  });

  it('recusa rank negativo', async () => {
    const h = makeHarness({ rows: [{ id: 1, character_id: CHAR_A, profession_code: 'miner', status: STATUS.ACTIVE, rank: 0, xp: 0 }] });
    const r = await professionService.setProfessionRank({ characterId: CHAR_A, professionCode: 'miner', rank: -1 }, h.dependencies);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'invalid_rank');
  });

  it('recusa rank acima de profession.maxRank', async () => {
    const h = makeHarness({ maxRank: 3, rows: [{ id: 1, character_id: CHAR_A, profession_code: 'miner', status: STATUS.ACTIVE, rank: 0, xp: 0 }] });
    const r = await professionService.setProfessionRank({ characterId: CHAR_A, professionCode: 'miner', rank: 4 }, h.dependencies);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'invalid_rank');
  });

  it('recusa rank não-inteiro (spoof do tipo)', async () => {
    const h = makeHarness({ rows: [{ id: 1, character_id: CHAR_A, profession_code: 'miner', status: STATUS.ACTIVE, rank: 0, xp: 0 }] });
    const r = await professionService.setProfessionRank({ characterId: CHAR_A, professionCode: 'miner', rank: 1.5 }, h.dependencies);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'invalid_rank');
  });

  it('recusa rank de profissão não ativa', async () => {
    const h = makeHarness({ rows: [{ id: 1, character_id: CHAR_A, profession_code: 'miner', status: STATUS.SUSPENDED, rank: 0, xp: 0 }] });
    const r = await professionService.setProfessionRank({ characterId: CHAR_A, professionCode: 'miner', rank: 1 }, h.dependencies);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'not_active');
  });

  it('recusa rank de personagem sem a profissão', async () => {
    const h = makeHarness();
    const r = await professionService.setProfessionRank({ characterId: CHAR_A, professionCode: 'miner', rank: 1 }, h.dependencies);
    assert.deepStrictEqual(r, { ok: false, code: 'not_found' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// XP
// ─────────────────────────────────────────────────────────────────────────────

describe('profession-service — addProfessionXp', () => {
  it('soma XP positivo', async () => {
    const h = makeHarness({ rows: [{ id: 1, character_id: CHAR_A, profession_code: 'miner', status: STATUS.ACTIVE, rank: 0, xp: 10 }] });
    const r = await professionService.addProfessionXp({ characterId: CHAR_A, professionCode: 'miner', amount: 5 }, h.dependencies);
    assert.deepStrictEqual(r, { ok: true, data: { previousXp: 10, xp: 15, delta: 5 } });
  });

  it('recusa XP negativo sem staffCharacterId — client nunca reduz XP por conta própria', async () => {
    const h = makeHarness({ rows: [{ id: 1, character_id: CHAR_A, profession_code: 'miner', status: STATUS.ACTIVE, rank: 0, xp: 10 }] });
    const r = await professionService.addProfessionXp({ characterId: CHAR_A, professionCode: 'miner', amount: -5 }, h.dependencies);
    assert.deepStrictEqual(r, { ok: false, code: 'negative_requires_admin' });
  });

  it('aceita XP negativo quando staffCharacterId está presente (ajuste administrativo)', async () => {
    const h = makeHarness({ rows: [{ id: 1, character_id: CHAR_A, profession_code: 'miner', status: STATUS.ACTIVE, rank: 0, xp: 10 }] });
    const r = await professionService.addProfessionXp(
      { characterId: CHAR_A, professionCode: 'miner', amount: -5, staffCharacterId: 900 },
      h.dependencies
    );
    assert.deepStrictEqual(r, { ok: true, data: { previousXp: 10, xp: 5, delta: -5 } });
  });

  it('nunca deixa XP negativo — clampa no chão', async () => {
    const h = makeHarness({ rows: [{ id: 1, character_id: CHAR_A, profession_code: 'miner', status: STATUS.ACTIVE, rank: 0, xp: 10 }] });
    const r = await professionService.addProfessionXp(
      { characterId: CHAR_A, professionCode: 'miner', amount: -1000, staffCharacterId: 900 },
      h.dependencies
    );
    assert.strictEqual(r.data.xp, 0);
  });

  it('recusa amount zero ou não-inteiro', async () => {
    const h = makeHarness({ rows: [{ id: 1, character_id: CHAR_A, profession_code: 'miner', status: STATUS.ACTIVE, rank: 0, xp: 10 }] });
    assert.strictEqual((await professionService.addProfessionXp({ characterId: CHAR_A, professionCode: 'miner', amount: 0 }, h.dependencies)).code, 'invalid_amount');
    assert.strictEqual((await professionService.addProfessionXp({ characterId: CHAR_A, professionCode: 'miner', amount: 1.5, staffCharacterId: 1 }, h.dependencies)).code, 'invalid_amount');
  });

  it('recusa XP de profissão suspensa', async () => {
    const h = makeHarness({ rows: [{ id: 1, character_id: CHAR_A, profession_code: 'miner', status: STATUS.SUSPENDED, rank: 0, xp: 10 }] });
    const r = await professionService.addProfessionXp({ characterId: CHAR_A, professionCode: 'miner', amount: 5 }, h.dependencies);
    assert.strictEqual(r.code, 'not_active');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Consultas
// ─────────────────────────────────────────────────────────────────────────────

describe('profession-service — consultas', () => {
  it('hasProfession é true só quando status é active', async () => {
    const h = makeHarness({
      rows: [
        { id: 1, character_id: CHAR_A, profession_code: 'miner', status: STATUS.ACTIVE, rank: 0, xp: 0 },
        { id: 2, character_id: CHAR_A, profession_code: 'lumberjack', status: STATUS.SUSPENDED, rank: 0, xp: 0 }
      ]
    });
    assert.strictEqual(await professionService.hasProfession(CHAR_A, 'miner', h.dependencies), true);
    assert.strictEqual(await professionService.hasProfession(CHAR_A, 'lumberjack', h.dependencies), false, 'suspensa não autoriza gameplay');
    assert.strictEqual(await professionService.hasProfession(CHAR_A, 'hunter', h.dependencies), false);
  });

  it('getCharacterProfessions devolve todo o histórico, qualquer status', async () => {
    const h = makeHarness({
      rows: [
        { id: 1, character_id: CHAR_A, profession_code: 'miner', status: STATUS.ACTIVE, rank: 0, xp: 0 },
        { id: 2, character_id: CHAR_A, profession_code: 'lumberjack', status: STATUS.REVOKED, rank: 3, xp: 500 }
      ]
    });
    const estados = await professionService.getCharacterProfessions(CHAR_A, h.dependencies);
    assert.strictEqual(estados.length, 2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A migration bate com o que o serviço lê e escreve
// ─────────────────────────────────────────────────────────────────────────────

describe('a migration-v18 declara toda coluna que profession-service usa', () => {
  const sql = fs.readFileSync(
    path.resolve(__dirname, '..', 'packages', 'database', 'migration-v18-professions.sql'),
    'utf8'
  );
  const criacao = sql.slice(
    sql.indexOf('CREATE TABLE IF NOT EXISTS `character_professions`'),
    sql.indexOf('ALTER TABLE')
  );

  const COLUNAS_USADAS = [
    'id', 'character_id', 'profession_code', 'status', 'rank', 'xp',
    'granted_by_character_id', 'joined_at', 'updated_at'
  ];

  for (const coluna of COLUNAS_USADAS) {
    it(`declara a coluna '${coluna}'`, () => {
      assert.ok(criacao.includes(`\`${coluna}\``), `coluna '${coluna}' usada em profession-service.js mas ausente da migration-v18`);
    });
  }

  it('tem a UNIQUE que impede duplicar (character_id, profession_code) — §7 do briefing', () => {
    assert.ok(/UNIQUE KEY .*\(`character_id`, `profession_code`\)/.test(criacao));
  });

  it('tem FOREIGN KEY para characters em character_id', () => {
    assert.ok(/FOREIGN KEY\s+\(`character_id`\)\s+REFERENCES `characters`/.test(criacao));
  });
});
