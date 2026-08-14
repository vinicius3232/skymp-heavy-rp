#!/usr/bin/env node
/**
 * scripts/bench-voice-proximity.js
 *
 * Mede a latência de proximidade do Voice Core. **Não** configura um timer e
 * declara vitória.
 *
 * ## O que "latência de proximidade" quer dizer aqui
 *
 * Duas coisas diferentes, e confundi-las é como se declara sucesso sem ter:
 *
 *   1. **Custo do recompute** — quanto tempo o servidor gasta para recalcular
 *      quem ouve quem. É o que este script mede diretamente, em p50/p95/máx.
 *   2. **Idade da rota** — quanto tempo uma mudança leva para chegar ao
 *      ouvinte. Para movimento normal é `intervalo do tick + custo do
 *      recompute`; para mudança crítica é só o custo, porque o ciclo é
 *      forçado na hora.
 *
 * A meta pedida (~100–250 ms) é sobre (2). Ela só é atingível se (1) couber com
 * folga dentro do intervalo — um recompute de 300 ms num tick de 150 ms não
 * entrega uma rota a cada 150 ms, entrega um servidor engasgado. Por isso as
 * duas aparecem lado a lado no relatório, e o veredito confere as duas.
 *
 * ## A comparação com o caminho antigo
 *
 * O baseline reimplementa o laço aninhado do `tickProximity` original — par a
 * par, distância 3D, comparação de célula. Não é um espantalho: é o algoritmo
 * que estava em produção, e é contra ele que a mudança precisa se justificar.
 *
 * ## Como rodar
 *
 *     node scripts/bench-voice-proximity.js
 *     node scripts/bench-voice-proximity.js --densa --n 200 --iteracoes 300
 *
 * Sai `0` se o veredito passar, `1` se a meta não for atingida — para que isto
 * possa virar um portão de CI sem virar um número que alguém lê e esquece.
 */

const path = require('path');
const gamemodeDir = path.join(__dirname, '..');

const { VOICE_RANGES } = require(path.join(gamemodeDir, 'core', 'proximity-ranges'));
const { createVoiceStateService, CONNECTION_STATES } = require(path.join(gamemodeDir, 'core', 'voice', 'voice-state'));
const { createVoicePolicyEngine, distance3D } = require(path.join(gamemodeDir, 'core', 'voice', 'voice-policy'));
const { createVoiceSpatialIndex } = require(path.join(gamemodeDir, 'core', 'voice', 'voice-spatial-index'));
const { createVoiceRouteEngine } = require(path.join(gamemodeDir, 'core', 'voice', 'voice-route-engine'));
const { DEFAULT_TICK_MS } = require(path.join(gamemodeDir, 'core', 'voice', 'voice-core'));

// ─────────────────────────────────────────────────────────────────────────────
// Argumentos
// ─────────────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (nome) => argv.includes(`--${nome}`);
const valor = (nome, padrao) => {
  const i = argv.indexOf(`--${nome}`);
  return i >= 0 && argv[i + 1] ? Number.parseInt(argv[i + 1], 10) : padrao;
};

const ITERACOES = valor('iteracoes', 200);
const POPULACOES = flag('n') ? [valor('n', 100)] : [10, 25, 50, 100, 200];

/**
 * Duas topologias, porque elas exercitam coisas opostas.
 *
 * `espalhada` é o servidor comum: gente distribuída por um worldspace inteiro.
 * O índice brilha aqui, e é o caso que justifica a estrutura.
 *
 * `densa` é a taverna cheia — todo mundo dentro do alcance de todo mundo. É o
 * pior caso do índice, porque não há o que descartar: a resposta É quadrática,
 * e nenhuma estrutura de dados a torna menor. Medir só a topologia favorável
 * seria escolher o resultado antes de medir.
 */
const TOPOLOGIAS = flag('densa') ? ['densa'] : ['espalhada', 'densa', 'mista'];

const CELLS = ['3c:Skyrim.esm', '162e2:Skyrim.esm', '1a2b3:Skyrim.esm', '4b1c:Skyrim.esm'];

// ─────────────────────────────────────────────────────────────────────────────
// Cenários
// ─────────────────────────────────────────────────────────────────────────────

function rng(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function cenario(n, topologia, seed = 42) {
  const random = rng(seed);
  const samples = [];
  for (let i = 0; i < n; i++) {
    const actorId = 0x10000 + i;
    let space, pos;
    if (topologia === 'densa') {
      // Todos na mesma célula, dentro de ~1200 unidades: a taverna cheia.
      space = CELLS[1];
      pos = [(random() - 0.5) * 1200, (random() - 0.5) * 1200, (random() - 0.5) * 200];
    } else if (topologia === 'espalhada') {
      space = CELLS[0];
      pos = [(random() - 0.5) * 120000, (random() - 0.5) * 120000, (random() - 0.5) * 4000];
    } else {
      // Mista: metade num aglomerado, metade espalhada, em células variadas.
      const aglomerado = i % 2 === 0;
      space = CELLS[Math.floor(random() * CELLS.length)];
      pos = aglomerado
        ? [(random() - 0.5) * 2000, (random() - 0.5) * 2000, 0]
        : [(random() - 0.5) * 120000, (random() - 0.5) * 120000, 0];
    }
    samples.push({ actorId, space, pos });
  }
  return samples;
}

/** Estado com todo mundo conectado, falando, em modos variados. */
function montarEstado(samples, seed = 7) {
  const random = rng(seed);
  const state = createVoiceStateService();
  const modos = Object.keys(VOICE_RANGES);
  for (const s of samples) {
    state.ensure(s.actorId, { characterId: s.actorId });
    state.setConnectionState(s.actorId, CONNECTION_STATES.CONNECTED);
    state.setVoiceMode(s.actorId, modos[Math.floor(random() * modos.length)]);
    state.setTransmitting(s.actorId, true);
  }
  return state;
}

// ─────────────────────────────────────────────────────────────────────────────
// O baseline: o `tickProximity` original, laço aninhado
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reimplementação fiel do algoritmo que estava em produção, para comparação.
 * Ver `voip-service.tickProximity` antes desta etapa.
 */
function tickProximityLegado(samples, state) {
  const audiencia = new Map();
  let pares = 0;
  for (const client of samples) {
    for (const peer of samples) {
      if (peer.actorId === client.actorId) continue;
      pares++;
      if (client.space && peer.space && client.space !== peer.space) continue;
      const dist = distance3D(client.pos, peer.pos);
      const peerState = state.get(peer.actorId);
      const range = VOICE_RANGES[peerState.voiceMode] || VOICE_RANGES.normal;
      const volume = dist >= range ? 0 : Math.max(0, Math.min(1, 1 - dist / range));
      if (volume > 0) {
        let lista = audiencia.get(peer.actorId);
        if (!lista) { lista = []; audiencia.set(peer.actorId, lista); }
        lista.push({ actorId: client.actorId, volume });
      }
    }
  }
  return { audiencia, pares };
}

// ─────────────────────────────────────────────────────────────────────────────
// Medição
// ─────────────────────────────────────────────────────────────────────────────

function estatisticas(amostras) {
  const ordenadas = [...amostras].sort((a, b) => a - b);
  const at = (q) => ordenadas[Math.min(ordenadas.length - 1, Math.floor(q * ordenadas.length))];
  const soma = ordenadas.reduce((a, b) => a + b, 0);
  return { p50: at(0.5), p95: at(0.95), max: ordenadas[ordenadas.length - 1], media: soma / ordenadas.length };
}

/** Move todo mundo um passo, como um tick real faria. */
function passo(samples, random) {
  for (const s of samples) {
    s.pos = [s.pos[0] + (random() - 0.5) * 60, s.pos[1] + (random() - 0.5) * 60, s.pos[2]];
  }
}

function medir(n, topologia) {
  const samples = cenario(n, topologia);
  const state = montarEstado(samples);
  const policy = createVoicePolicyEngine({ state });
  const index = createVoiceSpatialIndex();
  const routes = createVoiceRouteEngine({ state, policy, index });

  // Aquecimento: o JIT precisa ver o caminho quente antes de a medição valer.
  const aquecimento = rng(1);
  for (let i = 0; i < 30; i++) { passo(samples, aquecimento); routes.recompute(samples); }

  const random = rng(2026);
  const novo = [];
  const legado = [];
  let paresNovo = 0;
  let paresLegado = 0;
  let rotas = 0;
  let assinaturasEmitidas = 0;
  let ticksSemMudanca = 0;

  for (let i = 0; i < ITERACOES; i++) {
    passo(samples, random);

    const t0 = performance.now();
    const r = routes.recompute(samples);
    novo.push(performance.now() - t0);

    paresNovo += r.pairsExamined;
    rotas += r.routeCount;
    const emitidas = r.diff.subscribe.length + r.diff.unsubscribe.length;
    assinaturasEmitidas += emitidas;
    if (emitidas === 0) ticksSemMudanca++;

    const t1 = performance.now();
    const l = tickProximityLegado(samples, state);
    legado.push(performance.now() - t1);
    paresLegado += l.pares;
  }

  return {
    n, topologia,
    novo: estatisticas(novo),
    legado: estatisticas(legado),
    paresNovo: Math.round(paresNovo / ITERACOES),
    paresLegado: Math.round(paresLegado / ITERACOES),
    rotas: Math.round(rotas / ITERACOES),
    assinaturasPorTick: assinaturasEmitidas / ITERACOES,
    ticksSemMudanca: (ticksSemMudanca / ITERACOES) * 100,
    espacial: index.describe()
  };
}

/**
 * Latência de uma mudança crítica: do instante em que ela acontece até a rota
 * refletir. É o número que a instrução pedia para teleporte, troca de célula e
 * troca de modo.
 */
function medirCritico(n, topologia) {
  const samples = cenario(n, topologia);
  const state = montarEstado(samples);
  const policy = createVoicePolicyEngine({ state });
  const index = createVoiceSpatialIndex();
  const routes = createVoiceRouteEngine({ state, policy, index });

  const aquecimento = rng(3);
  for (let i = 0; i < 30; i++) { passo(samples, aquecimento); routes.recompute(samples); }

  const amostras = [];
  const alvo = samples[0];
  for (let i = 0; i < ITERACOES; i++) {
    // A mudança crítica: o alvo troca de célula.
    alvo.space = CELLS[i % CELLS.length];
    const t0 = performance.now();
    routes.recompute(samples);
    amostras.push(performance.now() - t0);
  }
  return estatisticas(amostras);
}

// ─────────────────────────────────────────────────────────────────────────────
// Saída
// ─────────────────────────────────────────────────────────────────────────────

const ms = (v) => `${v.toFixed(3)} ms`;

console.log('');
console.log('═'.repeat(88));
console.log('  BENCH — latência de proximidade do Voice Core');
console.log('═'.repeat(88));
console.log(`  Node ${process.version} · ${ITERACOES} iterações por caso`);
console.log(`  Tick espacial configurado: ${DEFAULT_TICK_MS} ms · meta de idade de rota: 100–250 ms`);
console.log(`  Raios (core/proximity-ranges.js): ${JSON.stringify(VOICE_RANGES)}`);
console.log('');

const resultados = [];
for (const topologia of TOPOLOGIAS) {
  console.log(`─ topologia: ${topologia} ${'─'.repeat(70 - topologia.length)}`);
  console.log('');
  console.log('    n │ recompute p50 │ recompute p95 │  legado p95  │ ganho │  pares (novo/legado)');
  console.log('  ────┼───────────────┼───────────────┼──────────────┼───────┼─────────────────────');
  for (const n of POPULACOES) {
    const r = medir(n, topologia);
    resultados.push(r);
    const ganho = r.legado.p95 / Math.max(r.novo.p95, 1e-9);
    console.log(
      `  ${String(n).padStart(3)} │ ${ms(r.novo.p50).padStart(13)} │ ${ms(r.novo.p95).padStart(13)} │ ` +
      `${ms(r.legado.p95).padStart(12)} │ ${(`${ganho.toFixed(1)}×`).padStart(5)} │ ` +
      `${String(r.paresNovo).padStart(7)} / ${String(r.paresLegado).padEnd(8)}`
    );
  }
  console.log('');

  const ultimo = resultados[resultados.length - 1];
  console.log(`  Assinaturas emitidas por tick (n=${ultimo.n}): ${ultimo.assinaturasPorTick.toFixed(2)}`);
  console.log(`  Ticks sem NENHUMA mudança de assinatura: ${ultimo.ticksSemMudanca.toFixed(1)}%`);
  console.log(`  Índice: ${ultimo.espacial.spaces} espaços, ${ultimo.espacial.buckets} buckets, ` +
    `maior bucket ${ultimo.espacial.largestBucket}`);
  console.log('');
}

console.log('─ mudança crítica (troca de célula → rota atualizada) ' + '─'.repeat(34));
console.log('');
const maiorN = POPULACOES[POPULACOES.length - 1];
for (const topologia of TOPOLOGIAS) {
  const c = medirCritico(maiorN, topologia);
  console.log(`  ${topologia.padEnd(12)} n=${maiorN}: p50 ${ms(c.p50)} · p95 ${ms(c.p95)} · máx ${ms(c.max)}`);
}
console.log('');

// ─────────────────────────────────────────────────────────────────────────────
// Veredito
// ─────────────────────────────────────────────────────────────────────────────

console.log('═'.repeat(88));
console.log('  VEREDITO');
console.log('═'.repeat(88));

const piorRecompute = Math.max(...resultados.map((r) => r.novo.p95));
const casoPior = resultados.find((r) => r.novo.p95 === piorRecompute);

// O recompute precisa caber com FOLGA no tick. 25% é o orçamento: acima disso o
// laço de voz começa a competir com o resto do gamemode, que roda no mesmo
// processo e tem mais o que fazer do que calcular quem ouve quem.
const ORCAMENTO = DEFAULT_TICK_MS * 0.25;
const idadeMaxima = DEFAULT_TICK_MS + piorRecompute;

const cabe = piorRecompute <= ORCAMENTO;
const dentroDaMeta = idadeMaxima >= 100 && idadeMaxima <= 250;

console.log('');
console.log(`  Pior recompute p95 medido: ${ms(piorRecompute)}  ` +
  `(n=${casoPior.n}, topologia ${casoPior.topologia})`);
console.log(`  Orçamento (25% de ${DEFAULT_TICK_MS} ms):  ${ms(ORCAMENTO)}  → ${cabe ? 'CABE' : 'NÃO CABE'}`);
console.log('');
console.log(`  Idade máxima de rota, movimento normal: ${ms(idadeMaxima)}`);
console.log(`  Faixa pedida: 100–250 ms                → ${dentroDaMeta ? 'DENTRO' : 'FORA'}`);
console.log('');
console.log(`  Antes desta etapa o tick era 2000 ms, e a idade de rota, ~2 s.`);
console.log('');

if (!cabe || !dentroDaMeta) {
  console.log('  ✖ A meta NÃO foi atingida. Nada aqui deve ser lido como se tivesse sido.');
  console.log('');
  process.exit(1);
}

console.log('  ✔ Medido, não configurado.');
console.log('');
console.log('  O que este número NÃO diz: nada sobre a latência que uma PESSOA ouve.');
console.log('  Isto mede o servidor decidindo quem ouve quem. A latência de áudio ponta a');
console.log('  ponta depende de captura, codec, SFU e rede, e nenhuma delas foi medida —');
console.log('  ver a seção de itens não validados no documento da etapa.');
console.log('');
process.exit(0);
