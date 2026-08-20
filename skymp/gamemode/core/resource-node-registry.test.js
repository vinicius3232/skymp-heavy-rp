/**
 * core/resource-node-registry.test.js
 * Executa com: node --test core/resource-node-registry.test.js
 */

'use strict';

const assert = require('assert');
const { describe, it } = require('node:test');
const registry = require('./resource-node-registry');

describe('resource-node-registry', () => {
  it('expõe as cinco categorias do briefing', () => {
    assert.deepStrictEqual(
      Object.keys(registry.NODE_TYPES).sort(),
      ['CROP', 'FISHING', 'HERB', 'ORE', 'TREE']
    );
  });

  it('isValidType aceita as categorias conhecidas', () => {
    for (const type of Object.values(registry.NODE_TYPES)) {
      assert.strictEqual(registry.isValidType(type), true);
    }
  });

  it('isValidType recusa categoria desconhecida sem lançar', () => {
    assert.strictEqual(registry.isValidType('MITHRIL'), false);
    assert.strictEqual(registry.isValidType('ore'), false, 'case-sensitive: minúsculo não é a mesma categoria');
    assert.strictEqual(registry.isValidType(42), false);
    assert.strictEqual(registry.isValidType(null), false);
  });
});
