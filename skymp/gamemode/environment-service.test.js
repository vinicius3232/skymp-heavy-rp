/**
 * environment-service.test.js
 *
 * Cobre a persistência do estado criado em `skymp/packages/database/
 * migration-v19-environment-time.sql` (world_time_state) e o requisito mais
 * concreto do serviço: uma falha de escrita no banco durante o heartbeat
 * NUNCA faz `gameDaysPassed` regredir enquanto o processo está vivo — só a
 * leitura do boot importa, e ela acontece uma única vez.
 *
 * Executa com: node --test environment-service.test.js
 */

'use strict';

const assert = require('assert');
const { describe, it, beforeEach, afterEach } = require('node:test');

const environmentService = require('./environment-service');

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

function makeHarness(options = {}) {
  const state = {
    row: options.row ? { ...options.row } : null,
    persistCalls: []
  };

  const db = {
    query: async (sql, params = []) => {
      if (options.failOn && new RegExp(options.failOn, 'i').test(sql)) {
        throw new Error('conexao com o banco caiu');
      }

      if (/SELECT \* FROM world_time_state WHERE id = 1/i.test(sql)) {
        return state.row ? [{ ...state.row }] : [];
      }

      if (/INSERT INTO world_time_state/i.test(sql)) {
        state.row = { id: 1, game_days_passed: 0, timescale: params[0], updated_at: new Date() };
        return [{ affectedRows: 1 }];
      }

      if (/UPDATE world_time_state SET game_days_passed = \?, timescale = \? WHERE id = 1/i.test(sql)) {
        state.persistCalls.push({ gameDaysPassed: params[0], timeScale: params[1] });
        state.row = { ...state.row, game_days_passed: params[0], timescale: params[1] };
        return [{ affectedRows: 1 }];
      }

      throw new Error(`SQL inesperado no harness: ${sql}`);
    }
  };

  const moduleRegistryFake = { isEnabled: () => options.moduleEnabled !== false };

  let clock = options.startClock ?? 0;
  const logs = { warn: [], error: [] };
  const logger = {
    log: () => {},
    warn: (...args) => logs.warn.push(args.join(' ')),
    error: (...args) => logs.error.push(args.join(' '))
  };

  return {
    state,
    logs,
    dependencies: {
      db,
      moduleRegistry: moduleRegistryFake,
      mp: options.mp !== undefined ? options.mp : null,
      now: () => clock,
      logger
    },
    advanceClock: (ms) => { clock += ms; }
  };
}

beforeEach(() => {
  environmentService._resetForTest();
  delete process.env.INITIAL_TIMESCALE;
});

afterEach(() => {
  environmentService._resetForTest();
  delete process.env.INITIAL_TIMESCALE;
});

// ─────────────────────────────────────────────────────────────────────────────
// Boot / persistência inicial
// ─────────────────────────────────────────────────────────────────────────────

describe('initialize', () => {
  it('cria a linha default quando o banco ainda não tem estado (primeiro boot)', async () => {
    const h = makeHarness({ row: null });
    process.env.INITIAL_TIMESCALE = '20';

    await environmentService.initialize(h.dependencies, 999999);
    await environmentService.shutdown(h.dependencies);

    const estado = h.state.row;
    assert.strictEqual(Number(estado.game_days_passed), 0);
    assert.strictEqual(Number(estado.timescale), 20);
  });

  it('carrega o estado existente do banco em vez de resetar', async () => {
    const h = makeHarness({ row: { id: 1, game_days_passed: 42.5, timescale: 20 } });

    await environmentService.initialize(h.dependencies, 999999);
    const estado = environmentService.getWorldTime(h.dependencies);

    assert.strictEqual(estado.gameDaysPassed, 42.5);
    assert.strictEqual(estado.timeScale, 20);
  });

  it('getWorldTime devolve null quando o módulo está desabilitado', async () => {
    const h = makeHarness({ row: { id: 1, game_days_passed: 42.5, timescale: 20 }, moduleEnabled: false });
    await environmentService.initialize(h.dependencies, 999999);

    assert.strictEqual(environmentService.getWorldTime(h.dependencies), null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// _tick — avanço do relógio
// ─────────────────────────────────────────────────────────────────────────────

describe('_tick', () => {
  it('avança gameDaysPassed proporcionalmente ao tempo real decorrido e à timeScale', async () => {
    const h = makeHarness({ row: { id: 1, game_days_passed: 0, timescale: 20 } });
    await environmentService.initialize(h.dependencies, 999999);

    // 1 hora real (3.600.000 ms) com timeScale 20 -> 20 horas de jogo = 20/24 dias
    h.advanceClock(3600000);
    await environmentService._tick(h.dependencies);

    const estado = environmentService.getWorldTime(h.dependencies);
    assert.ok(Math.abs(estado.gameDaysPassed - 20 / 24) < 1e-9);
  });

  it('não avança nada no primeiro tick após o boot (lastTickAt acabou de ser fixado)', async () => {
    const h = makeHarness({ row: { id: 1, game_days_passed: 5, timescale: 20 } });
    await environmentService.initialize(h.dependencies, 999999);

    await environmentService._tick(h.dependencies);

    const estado = environmentService.getWorldTime(h.dependencies);
    assert.strictEqual(estado.gameDaysPassed, 5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// O requisito central: falha de persistência nunca reverte o relógio
// ─────────────────────────────────────────────────────────────────────────────

describe('persistência e falha de banco', () => {
  it('persiste depois de DEFAULT_PERSIST_EVERY_N_TICKS ticks', async () => {
    const h = makeHarness({ row: { id: 1, game_days_passed: 0, timescale: 20 } });
    await environmentService.initialize(h.dependencies, 999999);

    for (let i = 0; i < environmentService.DEFAULT_PERSIST_EVERY_N_TICKS; i++) {
      h.advanceClock(1000);
      await environmentService._tick(h.dependencies);
    }

    assert.strictEqual(h.state.persistCalls.length, 1);
  });

  it('uma falha de escrita no banco NÃO reverte gameDaysPassed em memória', async () => {
    const h = makeHarness({ row: { id: 1, game_days_passed: 10, timescale: 20 } });
    await environmentService.initialize(h.dependencies, 999999);

    // Faz o próximo _persist falhar.
    h.dependencies.db.query = async (sql, params = []) => {
      if (/UPDATE world_time_state/i.test(sql)) {
        throw new Error('conexao com o banco caiu');
      }
      throw new Error(`SQL inesperado: ${sql}`);
    };

    for (let i = 0; i < environmentService.DEFAULT_PERSIST_EVERY_N_TICKS; i++) {
      h.advanceClock(3600000);
      await environmentService._tick(h.dependencies);
    }

    // O relógio em memória continuou avançando apesar da falha de persistência.
    const estado = environmentService.getWorldTime(h.dependencies);
    assert.ok(estado.gameDaysPassed > 10, 'gameDaysPassed deveria ter avançado mesmo com a persistência falhando');
  });

  it('shutdown persiste uma última vez', async () => {
    const h = makeHarness({ row: { id: 1, game_days_passed: 0, timescale: 20 } });
    await environmentService.initialize(h.dependencies, 999999);

    h.advanceClock(1000);
    await environmentService._tick(h.dependencies);
    await environmentService.shutdown(h.dependencies);

    assert.strictEqual(h.state.persistCalls.length, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Correção de deriva via Papyrus (GLOBAL_FORM_DESC não confirmado)
// ─────────────────────────────────────────────────────────────────────────────

describe('_applyCorrection', () => {
  it('não chama callPapyrusFunction — GlobalVariable.SetValue não está em papyrus-catalog.js', async () => {
    const calls = [];
    const mp = { callPapyrusFunction: (...args) => calls.push(args) };
    const h = makeHarness({ row: { id: 1, game_days_passed: 0, timescale: 20 }, mp });
    await environmentService.initialize(h.dependencies, 999999);

    h.advanceClock(1000);
    await environmentService._tick(h.dependencies);

    assert.strictEqual(calls.length, 0);
    assert.ok(h.logs.warn.some((msg) => msg.includes('papyrus-catalog.js')));
  });

  it('avisa só uma vez, mesmo com vários ticks', async () => {
    const mp = { callPapyrusFunction: () => {} };
    const h = makeHarness({ row: { id: 1, game_days_passed: 0, timescale: 20 }, mp });
    await environmentService.initialize(h.dependencies, 999999);

    for (let i = 0; i < 3; i++) {
      h.advanceClock(1000);
      await environmentService._tick(h.dependencies);
    }

    assert.strictEqual(h.logs.warn.length, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// healthCheck
// ─────────────────────────────────────────────────────────────────────────────

describe('healthCheck', () => {
  it('false antes do initialize, true depois, false depois do shutdown', async () => {
    assert.strictEqual(environmentService.healthCheck(), false);

    const h = makeHarness({ row: { id: 1, game_days_passed: 0, timescale: 20 } });
    await environmentService.initialize(h.dependencies, 999999);
    assert.strictEqual(environmentService.healthCheck(), true);

    await environmentService.shutdown(h.dependencies);
    assert.strictEqual(environmentService.healthCheck(), false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Nota de rastreabilidade para scripts/check-write-guards.js (guarda de
// migration sem teste): este arquivo exercita o estado criado por
// migration-v19-environment-time.sql.
// ─────────────────────────────────────────────────────────────────────────────
