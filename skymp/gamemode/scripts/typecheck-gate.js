#!/usr/bin/env node
/**
 * Gate de tipagem do gamemode ativo.
 *
 * O `tsc` ainda enxerga módulos PARKED porque o governance-service contém um
 * require defensivo para economy-regional. Esses módulos não podem ser
 * tratados como saudáveis, mas também não podem tornar inútil a checagem do
 * código que realmente sobe no phase0-basic.js.
 *
 * Este script executa o tsc completo e classifica cada diagnóstico:
 *   - ativo: falha o gate;
 *   - dependência: falha o gate;
 *   - PARKED: continua visível, mas não bloqueia a sessão da Fase 0.
 *
 * `npm run typecheck:all` preserva o retorno bruto e não passa enquanto houver
 * qualquer diagnóstico, inclusive nos módulos PARKED.
 */

const path = require('path');
const { spawnSync } = require('child_process');

const PARKED_FILES = new Set([
  'economy-regional.js',
  'crafting-service.js',
  'housing-service.js',
  'jobs-service.js',
  'horse-service.js',
  'trade-service.js'
]);

const DIAGNOSTIC_RE = /^(.*\.(?:js|ts|d\.ts))\((\d+),(\d+)\): error (TS\d+): (.*)$/;

/**
 * @param {string} output
 * @returns {Array<{file: string, line: number, column: number, code: string, message: string, raw: string}>}
 */
function parseDiagnostics(output) {
  const diagnostics = [];
  for (const line of output.split(/\r?\n/)) {
    const match = DIAGNOSTIC_RE.exec(line.trim());
    if (!match) continue;
    diagnostics.push({
      file: match[1],
      line: Number(match[2]),
      column: Number(match[3]),
      code: match[4],
      message: match[5],
      raw: line.trim()
    });
  }
  return diagnostics;
}

/** @param {{file: string}} diagnostic */
function classifyDiagnostic(diagnostic) {
  const normalized = diagnostic.file.replace(/\\/g, '/');
  if (normalized.includes('/node_modules/') || normalized.startsWith('node_modules/')) {
    return 'dependency';
  }
  if (PARKED_FILES.has(path.basename(normalized))) {
    return 'parked';
  }
  return 'active';
}

/**
 * @param {number} tscStatus
 * @param {ReturnType<typeof parseDiagnostics>} diagnostics
 * @param {string} rawOutput
 */
function evaluateGate(tscStatus, diagnostics, rawOutput) {
  const groups = { active: [], parked: [], dependency: [] };
  for (const diagnostic of diagnostics) {
    groups[classifyDiagnostic(diagnostic)].push(diagnostic);
  }

  const unparsedErrors = rawOutput
    .split(/\r?\n/)
    .filter(line => /error TS\d+:/.test(line) && !DIAGNOSTIC_RE.test(line.trim()));

  const passed = tscStatus === 0 || (
    groups.active.length === 0 &&
    groups.dependency.length === 0 &&
    unparsedErrors.length === 0 &&
    groups.parked.length > 0
  );

  return { passed, groups, unparsedErrors };
}

function printGroup(title, diagnostics) {
  console.log(`\n${title}: ${diagnostics.length}`);
  for (const diagnostic of diagnostics) console.log(`  ${diagnostic.raw}`);
}

function main() {
  const tscBin = require.resolve('typescript/bin/tsc');
  const result = spawnSync(process.execPath, [tscBin, '--noEmit', '-p', 'jsconfig.json', '--pretty', 'false'], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8'
  });

  const rawOutput = `${result.stdout || ''}${result.stderr || ''}`;
  const diagnostics = parseDiagnostics(rawOutput);
  const evaluation = evaluateGate(result.status ?? 1, diagnostics, rawOutput);

  printGroup('Erros no código ATIVO (bloqueiam)', evaluation.groups.active);
  printGroup('Erros de DEPENDÊNCIA (bloqueiam)', evaluation.groups.dependency);
  printGroup('Dívida em módulos PARKED (visível, não bloqueia G0)', evaluation.groups.parked);

  if (evaluation.unparsedErrors.length > 0) {
    console.log(`\nErros não classificados (bloqueiam): ${evaluation.unparsedErrors.length}`);
    for (const line of evaluation.unparsedErrors) console.log(`  ${line}`);
  }

  if (evaluation.passed) {
    console.log('\n[typecheck] Código ativo aprovado. Use `npm run typecheck:all` para exigir zero dívida inclusive em PARKED.');
    process.exitCode = 0;
    return;
  }

  if (diagnostics.length === 0 && result.status !== 0) {
    console.error('\n[typecheck] tsc falhou sem diagnóstico classificável. Saída bruta:');
    console.error(rawOutput || '(vazia)');
  }
  console.error('\n[typecheck] Gate do código ativo REPROVADO.');
  process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { PARKED_FILES, parseDiagnostics, classifyDiagnostic, evaluateGate };
