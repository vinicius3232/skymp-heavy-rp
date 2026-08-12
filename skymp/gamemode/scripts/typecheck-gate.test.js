const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { describe, it } = require('node:test');

const gate = require('./typecheck-gate');

describe('typecheck-gate — classificação explícita', () => {
  it('separa código ativo, PARKED e dependência', () => {
    const output = [
      "core/character-state.js(10,2): error TS2345: ativo",
      "economy-regional.js(20,3): error TS2304: parked",
      "node_modules/ws/index.js(1,1): error TS2339: dependencia"
    ].join('\n');

    const diagnostics = gate.parseDiagnostics(output);
    assert.equal(diagnostics.length, 3);
    assert.equal(gate.classifyDiagnostic(diagnostics[0]), 'active');
    assert.equal(gate.classifyDiagnostic(diagnostics[1]), 'parked');
    assert.equal(gate.classifyDiagnostic(diagnostics[2]), 'dependency');
  });

  it('aprova G0 quando a única dívida está em PARKED', () => {
    const output = "trade-service.js(5,7): error TS2304: parked";
    const diagnostics = gate.parseDiagnostics(output);
    const result = gate.evaluateGate(1, diagnostics, output);
    assert.equal(result.passed, true);
    assert.equal(result.groups.parked.length, 1);
  });

  it('reprova qualquer erro no código ativo', () => {
    const output = "core/transaction-service.js(5,7): error TS2304: ativo";
    const diagnostics = gate.parseDiagnostics(output);
    assert.equal(gate.evaluateGate(1, diagnostics, output).passed, false);
  });

  it('reprova erro de dependência em vez de escondê-lo', () => {
    const output = "node_modules/ws/index.js(5,7): error TS2304: dependencia";
    const diagnostics = gate.parseDiagnostics(output);
    assert.equal(gate.evaluateGate(1, diagnostics, output).passed, false);
  });

  it('reprova falha do tsc sem diagnóstico reconhecido', () => {
    const result = gate.evaluateGate(1, [], 'falha inesperada');
    assert.equal(result.passed, false);
  });

  it('a classificação PARKED acompanha a lista do phase0-basic', () => {
    const phase0 = fs.readFileSync(path.resolve(__dirname, '..', 'phase0-basic.js'), 'utf8');
    const section = phase0.split('// PARKED')[1].split('// APAGADOS')[0];
    const declared = [...section.matchAll(/^\/\/ - ([\w-]+)/gm)]
      .map(match => `${match[1]}.js`)
      .sort();
    const classified = [...gate.PARKED_FILES].sort();
    assert.deepEqual(classified, declared);
  });
});
