#!/usr/bin/env node
/**
 * check-test-registry.js
 *
 * Confere que todo arquivo `.test.js` está registrado no `scripts.test` do
 * package.json do gamemode.
 *
 * Por que isto existe
 * ───────────────────
 * A suíte do gamemode não é descoberta por glob: é uma lista de caminhos
 * escrita à mão. Isso é uma escolha deliberada — `node --test` com glob varre
 * `node_modules` e a ordem deixa de ser previsível — mas tem um custo que não
 * aparece em lugar nenhum: um `.test.js` novo que ninguém adicionou à lista
 * **não roda, e o CI fica verde**.
 *
 * É a mesma classe de falha das 22 chamadas Papyrus com argumento errado que
 * passaram meses com a suíte verde: o sinal existe, ninguém está lendo. A
 * diferença é que aqui o teste nem chega a ser executado — não há nem o que ler.
 *
 * O que ele compara
 * ─────────────────
 * Varre o disco (e não `git ls-files`: teste recém-criado ainda não está
 * rastreado, e é exatamente esse o caso que interessa) sob `skymp/gamemode/` e
 * `skymp/ui/`, e confronta com a lista:
 *
 *   - arquivo no disco fora da lista → nunca roda; falha silenciosa
 *   - entrada na lista sem arquivo   → `node --test` quebra ao subir
 *
 * Uso
 * ───
 *   node scripts/check-test-registry.js          confere tudo; sai 1 se houver problema
 *   node scripts/check-test-registry.js --hook   modo hook: lê JSON no stdin e
 *                                                só reclama do arquivo tocado
 */

'use strict';

const fs = require('fs');
const path = require('path');

const GAMEMODE_DIR = path.resolve(__dirname, '..');
const PKG_PATH = path.join(GAMEMODE_DIR, 'package.json');

// As raízes varridas. `skymp/ui/` entra porque a lista do gamemode já alcança
// lá (`../ui/voice-audio.test.js`) — se a varredura parasse no gamemode, um
// teste de UI novo seria órfão sem ninguém notar.
const ROOTS = [GAMEMODE_DIR, path.resolve(GAMEMODE_DIR, '..', 'ui')];

const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build']);

/** Caminhos listados no `scripts.test`, resolvidos a partir do gamemode. */
function listedTests() {
  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
  const script = (pkg.scripts && pkg.scripts.test) || '';
  return script
    .replace(/^node\s+--test\s+/, '')
    .split(/\s+/)
    .filter((entry) => entry.endsWith('.test.js'))
    .map((entry) => ({ entry, abs: path.resolve(GAMEMODE_DIR, entry) }));
}

/** Todo `.test.js` presente no disco, sob as raízes varridas. */
function testsOnDisk() {
  const found = [];
  for (const root of ROOTS) {
    if (!fs.existsSync(root)) continue;
    walk(root, found);
  }
  return found;
}

function walk(dir, acc) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (item.isDirectory()) {
      if (IGNORED_DIRS.has(item.name)) continue;
      walk(path.join(dir, item.name), acc);
    } else if (item.name.endsWith('.test.js')) {
      acc.push(path.join(dir, item.name));
    }
  }
}

/** Caminho relativo ao gamemode, com `/` — a forma usada no package.json. */
function asEntry(abs) {
  return path.relative(GAMEMODE_DIR, abs).split(path.sep).join('/');
}

function analyze() {
  const listed = listedTests();
  const listedAbs = new Set(listed.map((l) => l.abs));

  const orphans = testsOnDisk()
    .filter((abs) => !listedAbs.has(abs))
    .map(asEntry)
    .sort();

  const dead = listed
    .filter((l) => !fs.existsSync(l.abs))
    .map((l) => l.entry)
    .sort();

  return { listed, orphans, dead };
}

/** Modo hook: só reclama se o arquivo tocado for um teste não registrado. */
function runHook() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    raw += chunk;
  });
  process.stdin.on('end', () => {
    let touched;
    try {
      const payload = JSON.parse(raw);
      touched = payload && payload.tool_input && payload.tool_input.file_path;
    } catch {
      // Payload que não é JSON não é motivo para atrapalhar a edição.
      process.exit(0);
    }
    if (!touched || !touched.endsWith('.test.js')) process.exit(0);

    const abs = path.resolve(touched);
    const dentroDeUmaRaiz = ROOTS.some(
      (root) => !path.relative(root, abs).startsWith('..')
    );
    if (!dentroDeUmaRaiz) process.exit(0);

    const { orphans } = analyze();
    const entry = asEntry(abs);
    if (!orphans.includes(entry)) process.exit(0);

    // Saída 2 devolve a mensagem ao Claude, não ao usuário: quem acabou de
    // criar o arquivo é quem tem contexto para registrá-lo agora.
    process.stderr.write(
      `O teste \`${entry}\` não está no \`scripts.test\` de ` +
        `skymp/gamemode/package.json — do jeito que está, ele nunca roda e o ` +
        `CI passa mesmo assim. Adicione o caminho à lista.\n`
    );
    process.exit(2);
  });
}

function runFullCheck() {
  const { listed, orphans, dead } = analyze();

  for (const entry of orphans) {
    console.error(`fora da lista: ${entry} — existe no disco e nunca roda`);
  }
  for (const entry of dead) {
    console.error(`sem arquivo:   ${entry} — listado, mas não existe`);
  }

  if (orphans.length === 0 && dead.length === 0) {
    console.log(
      `OK: ${listed.length} testes listados, todos presentes, nenhum órfão.`
    );
    return 0;
  }

  console.error(
    `\n${orphans.length} órfão(s) e ${dead.length} entrada(s) morta(s). ` +
      `A lista fica em scripts.test de skymp/gamemode/package.json.`
  );
  return 1;
}

if (process.argv.includes('--hook')) {
  runHook();
} else {
  process.exit(runFullCheck());
}
