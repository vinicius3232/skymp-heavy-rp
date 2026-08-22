/**
 * core/profession-registry.test.js
 *
 * Executa com: node --test core/profession-registry.test.js
 */

'use strict';

const assert = require('assert');
const { describe, it, beforeEach } = require('node:test');
const registry = require('./profession-registry');

describe('profession-registry — catálogo inicial', () => {
  it('registra as treze profissões planejadas', () => {
    const codes = registry.list().map((p) => p.code).sort();
    const esperados = registry.BUILTIN_PROFESSIONS.map((p) => p.code).sort();
    assert.deepStrictEqual(codes, esperados);
    assert.strictEqual(codes.length, 13);
  });

  it('nenhuma profissão builtin tem gameplay implementado', () => {
    for (const p of registry.list()) {
      assert.strictEqual(p.gameplayImplemented, false, `${p.code} não deveria ter gameplay ainda`);
    }
  });

  it('todas as builtins nascem enabled', () => {
    for (const p of registry.list()) {
      assert.strictEqual(p.enabled, true, `${p.code} deveria estar enabled por padrão`);
    }
  });

  it('guard existe apenas como etiqueta, category institutional', () => {
    const guard = registry.get('guard');
    assert.ok(guard);
    assert.strictEqual(guard.category, 'institutional');
  });
});

describe('profession-registry — register()', () => {
  beforeEach(() => {
    registry._reset();
    registry.registerBuiltins();
  });

  it('rejeita code em formato inválido', () => {
    assert.throws(() => registry.register({ code: 'Pescador', label: 'Pescador', category: 'gathering' }));
    assert.throws(() => registry.register({ code: 'pescador ruim', label: 'x', category: 'gathering' }));
  });

  it('rejeita categoria fora do catálogo', () => {
    assert.throws(() => registry.register({ code: 'fisher', label: 'Pescador', category: 'aquatic' }));
  });

  it('rejeita registro duplicado', () => {
    assert.throws(() => registry.register({ code: 'miner', label: 'Minerador 2', category: 'gathering' }));
  });

  it('permite adicionar profissão nova sem tocar nas builtins (§33 do briefing)', () => {
    registry.register({ code: 'fisher', label: 'Pescador', category: 'gathering' });
    assert.ok(registry.isRegistered('fisher'));
    assert.strictEqual(registry.list().length, 14);
  });
});

describe('profession-registry — isEnabled / isGameplayImplemented', () => {
  beforeEach(() => {
    registry._reset();
    registry.registerBuiltins();
  });

  it('devolve false para profissão desconhecida, sem lançar', () => {
    assert.strictEqual(registry.isEnabled('does_not_exist'), false);
    assert.strictEqual(registry.isGameplayImplemented('does_not_exist'), false);
    assert.strictEqual(registry.isRegistered('does_not_exist'), false);
  });

  it('respeita enabled:false de um descritor customizado', () => {
    registry.register({ code: 'fisher', label: 'Pescador', category: 'gathering', enabled: false });
    assert.strictEqual(registry.isEnabled('fisher'), false);
    assert.strictEqual(registry.isRegistered('fisher'), true);
  });
});

describe('profession-registry — validate()', () => {
  beforeEach(() => {
    registry._reset();
    registry.registerBuiltins();
  });

  it('aceita profissão registrada e enabled', () => {
    const v = registry.validate('miner');
    assert.strictEqual(v.ok, true);
    assert.strictEqual(v.profession.code, 'miner');
  });

  it('recusa profissão desconhecida com motivo nomeado', () => {
    const v = registry.validate('does_not_exist');
    assert.deepStrictEqual(v, { ok: false, reason: 'unknown_profession' });
  });

  it('recusa profissão desativada com motivo nomeado, distinto de desconhecida', () => {
    registry.register({ code: 'fisher', label: 'Pescador', category: 'gathering', enabled: false });
    const v = registry.validate('fisher');
    assert.deepStrictEqual(v, { ok: false, reason: 'profession_disabled' });
  });

  it('recusa entrada não-string sem lançar', () => {
    const v = registry.validate(42);
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.reason, 'unknown_profession');
  });
});
