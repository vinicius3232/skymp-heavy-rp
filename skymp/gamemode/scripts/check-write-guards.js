#!/usr/bin/env node
/**
 * check-write-guards.js
 *
 * Guardas de escrita para as armadilhas que este projeto conhece pelo nome e
 * que **falham em silêncio**.
 *
 * Por que hook e não teste
 * ────────────────────────
 * Um teste pega o defeito quando alguém roda a suíte. Estas duas classes não
 * chegam à suíte: a primeira não lança erro nenhum — ela só não funciona em
 * jogo, e o jogo nunca rodou —, e a segunda é sobre um arquivo `.sql` que
 * nenhum teste carrega. O hook pega no instante da escrita, que é o único
 * momento em que quem escreveu ainda tem o contexto na cabeça.
 *
 * É o mesmo raciocínio do `check-test-registry.js`, que é irmão deste.
 *
 * ─── Guarda 1: FormDesc com prefixo `0x` ────────────────────────────────────
 *
 * Célula e base no SkyMP são FormDesc: hex **sem prefixo**, dois-pontos, nome
 * do arquivo — `"162e2:Skyrim.esm"`. Um `"0x162e2"` não lança erro, não aparece
 * em log, não quebra teste. Ele só não funciona em jogo.
 *
 * A distinção que importa e que a regra respeita:
 *
 *     const RESPAWN_CELL_FORM_ID = 0x162e2;      // NÚMERO — correto
 *     { cellId: '0x162e2' }                      // STRING num campo de célula — errado
 *     resolveTarget('player', '0xff01')          // actorId — correto, não é célula
 *
 * Por isso o padrão exige as duas coisas juntas: um **campo de célula ou
 * FormDesc** recebendo uma **string** que começa com `0x`. Um `0x` solto não é
 * flagrado — actorId em hexadecimal é o que a staff digita nos comandos, e
 * flagrar aquilo tornaria o guard ruído que se aprende a ignorar.
 *
 * ─── Guarda 2: migration sem teste que a leia ───────────────────────────────
 *
 * As migrations deste projeto são aplicadas **à mão** e nada garante que foram
 * todas aplicadas — um banco meio-migrado é a falha mais cara que ele tem,
 * porque tudo *quase* funciona.
 *
 * O `check-schema-drift` compara o banco com o que as migrations declaram, mas
 * ele não sabe se a migration faz o que o código espera. A `v17` só está segura
 * porque alguém escreveu um teste que compara o SQL do backfill com o
 * classificador em JS — se os dois divergirem, um classifica uma coisa e o
 * outro classifica outra sobre a mesma linha. Isso foi disciplina, não regra.
 *
 * O guard não exige um teste dedicado: exige que **algum** teste do gamemode
 * mencione o arquivo da migration. É um piso baixo de propósito — ele pega o
 * caso "ninguém olhou", não julga a qualidade de quem olhou.
 *
 * Uso
 * ───
 *   node scripts/check-write-guards.js <arquivo>   confere um arquivo; sai 1 se houver problema
 *   node scripts/check-write-guards.js --all       varre o repositório
 *   node scripts/check-write-guards.js --hook      modo hook: lê JSON no stdin
 */

'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..', '..');

// ─────────────────────────────────────────────────────────────────────────────
// Guarda 1 — FormDesc
// ─────────────────────────────────────────────────────────────────────────────

/** Os campos que de fato carregam FormDesc. Fechado de propósito. */
const CAMPOS_FORMDESC = [
  'cellId', 'cell_id', 'cellOrWorldDesc', 'worldOrCellDesc',
  'baseDesc', 'cellOrWorldSpaceId', 'RESPAWN_CELL', 'prison_cell_id'
];

const FORMDESC_RUIM = new RegExp(
  `(?:${CAMPOS_FORMDESC.join('|')})["']?\\s*[:=]\\s*["']0x[0-9a-fA-F]+["']`
);

/**
 * Linha que é só comentário não conta.
 *
 * Sem isto, o guard reprovaria o cabeçalho do `death-service.js`, que cita
 * `RESPAWN_CELL = '0x162e2'` para explicar por que aquilo estava errado.
 * Reprovar quem documenta o defeito é a forma mais rápida de fazer alguém
 * desligar o guard.
 */
function ehComentario(linha) {
  const t = linha.trimStart();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('--');
}

function guardaFormDesc(arquivo, conteudo) {
  if (!/\.(js|mjs|ts|json|sql)$/.test(arquivo)) return [];
  // Teste que exercita o formato errado de propósito é o comportamento certo:
  // `safe-zones.test.js` existe justamente para provar que `"0x162e2"` é
  // recusado.
  if (/\.test\.(js|mjs|ts)$/.test(arquivo)) return [];

  const achados = [];
  conteudo.split('\n').forEach((linha, i) => {
    if (ehComentario(linha)) return;
    if (FORMDESC_RUIM.test(linha)) {
      achados.push({
        linha: i + 1,
        texto: linha.trim().slice(0, 120),
        problema:
          'FormDesc com prefixo `0x`. A forma canônica é hex SEM prefixo, `:`, nome do arquivo — ' +
          '`"162e2:Skyrim.esm"`. Um `0x162e2` não lança erro e não funciona em jogo. ' +
          'Ver o cabeçalho de skymp/gamemode/death-service.js.'
      });
    }
  });
  return achados;
}

// ─────────────────────────────────────────────────────────────────────────────
// Guarda 2 — migration sem teste
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A última migration que existia quando este guard nasceu.
 *
 * Treze migrations anteriores não são mencionadas por teste nenhum. Isso é
 * dívida real e está registrada — `node scripts/check-write-guards.js --all` a
 * lista inteira. O que ela **não** pode ser é motivo para bloquear quem edita
 * uma delas hoje: um guard que dispara sobre o passivo inteiro vira ruído, e
 * ruído se desliga.
 *
 * A linha de corte é declarada em vez de silenciosa. Subir o número aqui é
 * quitar dívida; a `v17` já nasceu do outro lado dela, com teste que compara o
 * SQL do backfill com o classificador em JS.
 */
const MIGRATION_BASELINE = 16;

function guardaMigration(arquivo, { apenasNovas = false } = {}) {
  const base = path.basename(arquivo);
  if (!/^migration-v\d+.*\.sql$/.test(base)) return [];

  if (apenasNovas) {
    const versao = Number.parseInt(base.match(/^migration-v(\d+)/)[1], 10);
    if (versao <= MIGRATION_BASELINE) return [];
  }

  const dirTestes = path.join(REPO, 'skymp', 'gamemode');
  let mencionada = false;

  const varrer = (dir) => {
    if (mencionada) return;
    let entradas;
    try {
      entradas = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entradas) {
      if (mencionada) return;
      if (e.name === 'node_modules') continue;
      const alvo = path.join(dir, e.name);
      if (e.isDirectory()) { varrer(alvo); continue; }
      if (!/\.test\.js$/.test(e.name)) continue;
      try {
        if (fs.readFileSync(alvo, 'utf8').includes(base)) mencionada = true;
      } catch { /* arquivo sumiu no meio: não é problema do guard */ }
    }
  };
  varrer(dirTestes);

  if (mencionada) return [];
  return [{
    linha: 1,
    texto: base,
    problema:
      `A migration \`${base}\` não é mencionada por nenhum teste do gamemode. ` +
      'As migrations aqui são aplicadas À MÃO, e um banco meio-migrado é a falha mais cara ' +
      'do projeto porque tudo *quase* funciona. Um teste que leia o SQL — nem que seja para ' +
      'conferir que ele não altera tabela existente — é o que impede a próxima de nascer sem ninguém olhar.'
  }];
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {string} arquivo
 * @param {{apenasNovas?: boolean}} [opts] `apenasNovas` liga a linha de corte de
 *   migration. O HOOK usa; a varredura não, porque ela existe justamente para
 *   mostrar a dívida inteira.
 */
function conferir(arquivo, opts = {}) {
  let conteudo = '';
  try {
    conteudo = fs.readFileSync(arquivo, 'utf8');
  } catch {
    return [];
  }
  return [...guardaFormDesc(arquivo, conteudo), ...guardaMigration(arquivo, opts)];
}

function relatar(arquivo, achados) {
  const rel = path.relative(REPO, arquivo) || arquivo;
  for (const a of achados) {
    process.stderr.write(`${rel}:${a.linha}\n  ${a.texto}\n  → ${a.problema}\n\n`);
  }
}

// ── Modo varredura ───────────────────────────────────────────────────────────

function varrerTudo() {
  const raizes = [path.join(REPO, 'skymp'), path.join(REPO, 'apps')];
  let total = 0;
  let bloqueantes = 0;

  const anda = (dir) => {
    let entradas;
    try {
      entradas = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entradas) {
      if (['node_modules', 'artifacts', 'dist', '.git'].includes(e.name)) continue;
      const alvo = path.join(dir, e.name);
      if (e.isDirectory()) { anda(alvo); continue; }
      if (!/\.(js|mjs|ts|json|sql)$/.test(e.name)) continue;
      const achados = conferir(alvo);
      if (achados.length) {
        relatar(alvo, achados);
        total += achados.length;
        bloqueantes += conferir(alvo, { apenasNovas: true }).length;
      }
    }
  };
  raizes.forEach(anda);

  if (total === 0) {
    console.log('OK: nenhuma armadilha conhecida encontrada.');
    return 0;
  }
  // A varredura mostra tudo, inclusive a dívida herdada — mas só REPROVA pelo
  // que o hook bloquearia. Reprovar pelo passivo deixaria o CI cronicamente
  // vermelho por algo que ninguém desta rodada causou, e CI cronicamente
  // vermelho é CI que se aprende a ignorar.
  process.stderr.write(
    `${total} ocorrência(s), das quais ${bloqueantes} bloqueariam uma escrita nova.\n`
  );
  if (bloqueantes === 0) {
    process.stderr.write(
      `Nenhuma é nova: as migrations até a v${MIGRATION_BASELINE} são dívida declarada. ` +
      'Ver o comentário de MIGRATION_BASELINE.\n'
    );
  }
  return bloqueantes > 0 ? 1 : 0;
}

// ── Modo hook ────────────────────────────────────────────────────────────────

function modoHook() {
  let bruto = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { bruto += c; });
  process.stdin.on('end', () => {
    let tocado;
    try {
      const payload = JSON.parse(bruto);
      tocado = payload && payload.tool_input && payload.tool_input.file_path;
    } catch {
      // Payload que não é JSON não é motivo para atrapalhar a edição.
      process.exit(0);
    }
    if (!tocado) process.exit(0);

    const abs = path.resolve(tocado);
    if (path.relative(REPO, abs).startsWith('..')) process.exit(0);

    // `apenasNovas`: o hook bloqueia migration NOVA sem teste, e não indicia
    // quem está editando uma das treze antigas por outro motivo.
    const achados = conferir(abs, { apenasNovas: true });
    if (achados.length === 0) process.exit(0);

    // Saída 2 devolve a mensagem ao Claude, e não ao usuário: quem acabou de
    // escrever é quem tem contexto para corrigir agora.
    relatar(abs, achados);
    process.exit(2);
  });
}

if (process.argv.includes('--hook')) {
  modoHook();
} else if (process.argv.includes('--all')) {
  process.exit(varrerTudo());
} else {
  const alvo = process.argv[2];
  if (!alvo) {
    console.error('Uso: check-write-guards.js <arquivo> | --all | --hook');
    process.exit(1);
  }
  const achados = conferir(path.resolve(alvo));
  if (achados.length === 0) { console.log('OK'); process.exit(0); }
  relatar(path.resolve(alvo), achados);
  process.exit(1);
}
