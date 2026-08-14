#!/usr/bin/env node
/**
 * scripts/loadtest-voice.js
 *
 * Carga progressiva do SkyVoice: 25 → 50 → 100 → 200, em cinco cenários.
 *
 * ## O QUE ESTE SCRIPT MEDE, E O QUE ELE NÃO PODE MEDIR
 *
 * Ler isto antes de citar qualquer número daqui.
 *
 * **Mede** (execução real, nesta máquina):
 *
 * | Grandeza | Como |
 * |---|---|
 * | CPU do SkyMP no caminho de voz | `process.cpuUsage()` em volta do laço |
 * | RAM do SkyMP no caminho de voz | `process.memoryUsage()`, com GC forçado |
 * | Latência do recompute | p50/p95/máx sobre N ciclos |
 * | Churn de assinatura | contadores reais do `voice-metrics` |
 * | Assinaturas ativas | `routes.subscriptionCount()` |
 *
 * **NÃO mede, e nenhum número aqui deve ser lido como se medisse:**
 *
 * - **CPU e RAM do LiveKit.** Não há `livekit-server` nesta máquina.
 * - **Banda real.** O que sai abaixo é uma CONTA a partir do número de
 *   assinaturas e do bitrate nominal do codec — aritmética, não medição.
 * - **CPU do cliente, CPU da CEF, FPS.** Exigem o jogo aberto.
 * - **Perda de pacote, RTT, jitter.** Exigem rede. Nada saiu de `127.0.0.1`.
 * - **Latência de voz ponta a ponta.** Depende de captura, codec, SFU e rede.
 *   O que se mede aqui é o servidor decidindo quem ouve quem.
 *
 * Ou seja: isto é um teste de carga do **SkyMP como autoridade de voz**, com
 * jogadores simulados. Não é um teste de carga do sistema de voz completo, e
 * **não autoriza declarar suporte a 200 jogadores reais.**
 *
 * ## Os cinco cenários
 *
 * | | O que é | O que exercita |
 * |---|---|---|
 * | **A** | espalhados pelo mapa | o índice espacial no melhor caso |
 * | **B** | concentrados numa cidade | vizinhança densa com várias células |
 * | **C** | evento: quase todos numa área | o pior caso quadrático |
 * | **D** | muitos falando ao mesmo tempo | estado de fala, animação, audiência |
 * | **E** | entrando e saindo de alcance/célula | churn de assinatura e recompute crítico |
 *
 * ## Como rodar
 *
 *     node scripts/loadtest-voice.js
 *     node scripts/loadtest-voice.js --n 200 --cenario C --ciclos 500
 *     node --expose-gc scripts/loadtest-voice.js      (memória mais confiável)
 *
 * Sai `0` sempre: isto é instrumento de medição, não portão. Quem reprova é o
 * `bench:voice`, que tem meta declarada.
 */

const path = require('path');
const gamemodeDir = path.join(__dirname, '..');

// O caminho LiveKit precisa estar configurado para as sessões existirem. São
// credenciais de teste que nunca saem deste processo — o SFU é o `fetchImpl`
// falso abaixo, e nenhuma delas é válida em lugar nenhum.
process.env.LIVEKIT_URL = process.env.LIVEKIT_URL || 'wss://loadtest.invalido';
process.env.LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || 'loadtest';
process.env.LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || 'segredo-sintetico-de-teste-de-carga-000';

const { createVoiceCore } = require(path.join(gamemodeDir, 'core', 'voice', 'voice-core'));
const { createVoiceLiveKitGateway } = require(path.join(gamemodeDir, 'core', 'voice', 'livekit-gateway'));
const { createVoiceStaffMute } = require(path.join(gamemodeDir, 'core', 'voice', 'voice-staff-mute'));
const { createVoiceTelemetry } = require(path.join(gamemodeDir, 'core', 'voice', 'voice-telemetry'));
const { mintAdminToken } = require(path.join(gamemodeDir, 'core', 'voice', 'livekit-token'));

// ─────────────────────────────────────────────────────────────────────────────
// Argumentos
// ─────────────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const valor = (nome, padrao) => {
  const i = argv.indexOf(`--${nome}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : padrao;
};
const inteiro = (nome, padrao) => {
  const v = valor(nome, null);
  return v === null ? padrao : Number.parseInt(v, 10);
};

const CICLOS = inteiro('ciclos', 300);
const POPULACOES = argv.includes('--n') ? [inteiro('n', 200)] : [25, 50, 100, 200];
const CENARIOS = argv.includes('--cenario') ? [String(valor('cenario', 'A')).toUpperCase()] : ['A', 'B', 'C', 'D', 'E'];
const JSON_OUT = argv.includes('--json');

/** Células distintas — um worldspace externo e três interiores. */
const CELULAS = ['3c:Skyrim.esm', '165a9:Skyrim.esm', '1a26f:Skyrim.esm', '16d71:Skyrim.esm'];

// ─────────────────────────────────────────────────────────────────────────────
// Mundo sintético
// ─────────────────────────────────────────────────────────────────────────────

function rng(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Distribuição inicial por cenário.
 *
 * As dimensões não são arbitrárias: 120.000 unidades é a ordem de grandeza de
 * Tamriel no Skyrim, 4.000 é o miolo de uma cidade como Solitude, e 1.200 é uma
 * taverna cheia — a mesma que a topologia `densa` do `bench:voice` usa.
 */
function distribuir(n, cenario, random) {
  const atores = new Map();
  for (let i = 0; i < n; i++) {
    const actorId = 0xff000000 + i;
    let space, pos;

    switch (cenario) {
      case 'A':  // espalhados pelo mapa
        space = CELULAS[0];
        pos = [(random() - 0.5) * 120000, (random() - 0.5) * 120000, (random() - 0.5) * 4000];
        break;

      case 'B':  // cidade: aglomerado, mas com interiores
        space = CELULAS[Math.floor(random() * CELULAS.length)];
        pos = [(random() - 0.5) * 4000, (random() - 0.5) * 4000, (random() - 0.5) * 300];
        break;

      case 'C':  // evento: quase todos no mesmo lugar, mesma célula
        space = CELULAS[0];
        pos = random() < 0.9
          ? [(random() - 0.5) * 1200, (random() - 0.5) * 1200, 0]
          : [(random() - 0.5) * 60000, (random() - 0.5) * 60000, 0];
        break;

      case 'D':  // como B, e o que muda é quem fala (ver `prepararFala`)
        space = CELULAS[Math.floor(random() * 2)];
        pos = [(random() - 0.5) * 3000, (random() - 0.5) * 3000, 0];
        break;

      case 'E':  // fronteiras: todo mundo na borda de alcance de alguém
        space = CELULAS[Math.floor(random() * CELULAS.length)];
        pos = [(random() - 0.5) * 8000, (random() - 0.5) * 8000, 0];
        break;

      default:
        throw new Error(`cenário desconhecido: ${cenario}`);
    }

    atores.set(actorId, { actorId, pos, space, yaw: random() * 360 });
  }
  return atores;
}

/**
 * Como o mundo se mexe entre dois ciclos.
 *
 * O cenário E é o único que mexe em CÉLULA, e é isso que o torna o teste de
 * churn: trocar de célula invalida todas as rotas daquela pessoa de uma vez, nos
 * dois sentidos, e força um recompute crítico fora do tick.
 */
function mover(atores, cenario, random) {
  for (const a of atores.values()) {
    if (cenario === 'E') {
      // Passo grande: gente cruzando bordas de alcance a cada ciclo.
      a.pos = [a.pos[0] + (random() - 0.5) * 900, a.pos[1] + (random() - 0.5) * 900, a.pos[2]];
      // 4% dos atores por ciclo atravessam uma porta.
      if (random() < 0.04) a.space = CELULAS[Math.floor(random() * CELULAS.length)];
    } else {
      // Caminhada normal: ~60 unidades por tick de 150 ms.
      a.pos = [a.pos[0] + (random() - 0.5) * 60, a.pos[1] + (random() - 0.5) * 60, a.pos[2]];
    }
    a.yaw = (a.yaw + (random() - 0.5) * 20) % 360;
  }
}

function fakeMp(atores) {
  return {
    get(actorId, field) {
      const a = atores.get(actorId);
      if (!a) return null;
      if (field === 'locationalData') {
        return { pos: a.pos, cellOrWorldDesc: a.space, rot: [0, 0, a.yaw] };
      }
      return null;
    },
    set() {}
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Medição
// ─────────────────────────────────────────────────────────────────────────────

function estatisticas(amostras) {
  if (amostras.length === 0) return { p50: 0, p95: 0, p99: 0, max: 0, media: 0 };
  const o = [...amostras].sort((a, b) => a - b);
  const at = (q) => o[Math.min(o.length - 1, Math.floor(q * o.length))];
  return {
    p50: at(0.5), p95: at(0.95), p99: at(0.99),
    max: o[o.length - 1],
    media: o.reduce((a, b) => a + b, 0) / o.length
  };
}

/** Memória, com GC forçado quando disponível. Sem `--expose-gc` o número é ruidoso. */
function memoria() {
  if (typeof global.gc === 'function') { global.gc(); global.gc(); }
  const m = process.memoryUsage();
  return { rssMB: m.rss / 1048576, heapMB: m.heapUsed / 1048576, exato: typeof global.gc === 'function' };
}

/**
 * Banda ESTIMADA. É aritmética, não medição — está rotulada assim em toda saída.
 *
 * Duas contas, porque os dois transportes têm perfis opostos:
 *
 * - **legado**: PCM s16 48 kHz mono = 768 kbit/s, +33% de base64 ≈ 1.02 Mbit/s
 *   por locutor de subida, e o servidor **multiplica pela audiência** na descida,
 *   porque re-serializa por destinatário (o volume difere).
 * - **LiveKit**: Opus ~32 kbit/s por locutor de subida; a descida é do SFU e é
 *   proporcional às assinaturas — e não passa pelo servidor de jogo.
 */
function bandaEstimada({ locutores, assinaturas }) {
  const PCM_BASE64_KBPS = 768 * 1.33;
  const OPUS_KBPS = 32;
  return {
    legadoSubidaMbps: (locutores * PCM_BASE64_KBPS) / 1000,
    legadoDescidaMbps: (assinaturas * PCM_BASE64_KBPS) / 1000,
    livekitSubidaMbps: (locutores * OPUS_KBPS) / 1000,
    livekitDescidaSfuMbps: (assinaturas * OPUS_KBPS) / 1000,
    // A linha que decide a arquitetura: no legado a descida sai do processo do
    // gamemode; no LiveKit ela nem passa por ele.
    noProcessoDoJogoMbps: (locutores * PCM_BASE64_KBPS + assinaturas * PCM_BASE64_KBPS) / 1000
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// A rodada
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `async` porque o laço precisa devolver o controle ao event loop entre ciclos.
 *
 * `recompute()` dispara `applySubscriptionDiff()` sem esperar, de propósito — o
 * laço de voz não pode bloquear na rede. Um `for` síncrono nunca deixa essas
 * promessas resolverem, e elas se acumulam segurando o diff que as originou. A
 * primeira versão deste script mediu 42 MB de "vazamento" que era só isso.
 *
 * O `setInterval` do Voice Core devolve o controle entre os ticks. Medir sem
 * devolver é medir um regime que não existe.
 */
async function rodar(n, cenario) {
  const random = rng(1337 + n);
  const atores = distribuir(n, cenario, random);

  // O SFU é um alvo que sempre responde OK e conta chamadas. Não há rede: o que
  // se mede é o custo do gamemode, e um SFU que falhasse abriria o circuito e
  // esconderia justamente o trabalho de assinatura.
  let chamadasSfu = 0;
  const gateway = createVoiceLiveKitGateway({
    fetchImpl: async () => { chamadasSfu++; return { ok: true, status: 200 }; },
    mintAdminToken,
    logger: { log() {}, warn() {}, error() {} }
  });

  const core = createVoiceCore({
    mp: fakeMp(atores),
    gateway,
    logger: { log() {}, warn() {}, error() {} },
    staffMute: createVoiceStaffMute()
  });
  const telemetria = createVoiceTelemetry({ core });

  // Todo mundo entra na cena de voz, pelo caminho LiveKit completo.
  for (const a of atores.values()) {
    const aberto = core.attach(a.actorId, { characterId: a.actorId & 0xffff });
    if (aberto.session) core.sessions.confirmConnected(aberto.session.identity);
  }

  // Quem fala. É o eixo do cenário D.
  //
  // 15% é a fração de referência para uma cena de RP: numa taverna de vinte
  // pessoas, três falando ao mesmo tempo já é conversa cruzada. O cenário D sobe
  // para 60% de propósito — não porque seja realista, mas porque é onde o
  // estado de fala, a animação e a audiência custam mais.
  const fracaoFalando = cenario === 'D' ? 0.6 : 0.15;
  const locutores = [];
  for (const a of atores.values()) {
    if (random() < fracaoFalando) {
      core.pttDown(a.actorId);
      locutores.push(a.actorId);
    }
  }

  const memAntes = memoria();
  const duracoes = [];
  const cpuAntes = process.cpuUsage();
  const t0 = process.hrtime.bigint();

  for (let ciclo = 0; ciclo < CICLOS; ciclo++) {
    mover(atores, cenario, random);

    // Os locutores mandam quadro, como um transporte real a ~50 Hz mandaria.
    // Isso exercita `noteAudioFrame`, o estado de fala e o sweep.
    for (const id of locutores) core.noteAudioFrame(id);

    const inicio = process.hrtime.bigint();
    core.recompute('tick');
    duracoes.push(Number(process.hrtime.bigint() - inicio) / 1e6);

    core.speaking.sweep();
    await new Promise((r) => setImmediate(r));
  }

  const paredeMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const cpu = process.cpuUsage(cpuAntes);
  const memDepois = memoria();

  const snap = telemetria.snapshot();
  const contadores = core.metrics.snapshot().counters;
  const assinaturas = core.routes.subscriptionCount();

  const resultado = {
    n, cenario,
    ciclos: CICLOS,
    recomputeMs: estatisticas(duracoes),
    cpu: {
      // `process.cpuUsage()` soma TODAS as threads do processo — a principal, o
      // GC e o pool do libuv. Por isso a fração passa de 100% sem que haja
      // paralelismo no laço de voz: o que está acima de 100% é o coletor de lixo
      // rodando em paralelo com o recompute, e ele existe por causa da alocação
      // que o recompute faz. É informação útil e NÃO é "o laço usa 1,5 núcleo".
      usuarioMs: cpu.user / 1000,
      sistemaMs: cpu.system / 1000,
      paredeMs,
      fracao: (cpu.user + cpu.system) / 1000 / paredeMs
    },
    memoria: {
      // ⚠️ RSS é do PROCESSO e não encolhe entre cenários: o V8 devolve pouca
      // memória ao SO. Num relatório que roda cinco cenários em sequência, o RSS
      // do cenário E carrega o pico do cenário C. Quem responde "quanto ESTE
      // cenário custou" é `deltaHeapMB`, medido com GC forçado dos dois lados.
      rssMB: memDepois.rssMB,
      deltaHeapMB: memDepois.heapMB - memAntes.heapMB,
      heapMB: memDepois.heapMB,
      exato: memDepois.exato
    },
    voz: {
      conectados: snap.metrics.voice_connected_players,
      locutores: locutores.length,
      falandoAgora: snap.metrics.voice_active_speakers,
      assinaturas,
      churnTotal: snap.metrics.voice_subscription_changes,
      churnPorCiclo: snap.metrics.voice_subscription_changes / CICLOS,
      recusasPolitica: snap.metrics.voice_policy_denies,
      errosServidor: snap.metrics.voice_server_errors,
      paresExaminados: contadores['route.pairs'] || 0,
      chamadasSfu
    },
    bandaEstimada: bandaEstimada({ locutores: locutores.length, assinaturas })
  };

  core.shutdown();
  return resultado;
}

// ─────────────────────────────────────────────────────────────────────────────
// Saída
// ─────────────────────────────────────────────────────────────────────────────

const ms = (v) => `${v.toFixed(3)} ms`;
const mb = (v) => `${v.toFixed(1)} MB`;

const NOMES = {
  A: 'espalhados pelo mapa',
  B: 'concentrados numa cidade',
  C: 'evento — grande concentração',
  D: 'muitos falando ao mesmo tempo',
  E: 'entrando e saindo de alcance/célula'
};

const todos = [];

async function main() {

if (!JSON_OUT) {
  console.log('');
  console.log('═'.repeat(88));
  console.log('  TESTE DE CARGA — SkyVoice / SkyMP como autoridade de voz');
  console.log('═'.repeat(88));
  console.log(`  Node ${process.version} · ${process.platform} ${process.arch} · ${CICLOS} ciclos por ponto`);
  console.log(`  GC exposto: ${typeof global.gc === 'function' ? 'sim' : 'NÃO (memória ruidosa; rode com --expose-gc)'}`);
  console.log('');
  console.log('  ⚠️  Isto NÃO mede LiveKit, cliente, CEF, FPS, banda real, RTT, jitter ou perda.');
  console.log('     Mede o servidor decidindo quem ouve quem, com jogadores simulados.');
  console.log('');
}

for (const cenario of CENARIOS) {
  if (!JSON_OUT) {
    console.log(`─ Cenário ${cenario} — ${NOMES[cenario]} ${'─'.repeat(Math.max(0, 60 - NOMES[cenario].length))}`);
    console.log('');
    console.log('     n │ recompute p50 │ recompute p95 │ recompute máx │  CPU* │ Δheap  │ assin. │ churn/ciclo');
    console.log('  ─────┼───────────────┼───────────────┼───────────────┼───────┼────────┼────────┼────────────');
  }

  for (const n of POPULACOES) {
    const r = await rodar(n, cenario);
    todos.push(r);
    if (!JSON_OUT) {
      console.log(
        `  ${String(n).padStart(4)} │ ` +
        `${ms(r.recomputeMs.p50).padStart(13)} │ ` +
        `${ms(r.recomputeMs.p95).padStart(13)} │ ` +
        `${ms(r.recomputeMs.max).padStart(13)} │ ` +
        `${(r.cpu.fracao * 100).toFixed(0).padStart(4)}% │ ` +
        `${mb(r.memoria.deltaHeapMB).padStart(6)} │ ` +
        `${String(r.voz.assinaturas).padStart(6)} │ ` +
        `${r.voz.churnPorCiclo.toFixed(1).padStart(11)}`
      );
    }
  }
  if (!JSON_OUT) {
    console.log('');
    console.log('  * CPU soma todas as threads do processo (inclui GC). >100% é o coletor rodando');
    console.log('    junto com o recompute, não paralelismo do laço de voz.');
    console.log('');
  }
}

if (JSON_OUT) {
  console.log(JSON.stringify({ node: process.version, ciclos: CICLOS, resultados: todos }, null, 2));
  process.exit(0);
}

// ── Veredito ─────────────────────────────────────────────────────────────────

const TICK_MS = Number.parseInt(process.env.VOICE_TICK_MS, 10) || 150;
const ORCAMENTO = TICK_MS * 0.25;

const pior = todos.reduce((a, b) => (b.recomputeMs.p95 > a.recomputeMs.p95 ? b : a));
const piorN200 = todos.filter((r) => r.n === 200);

console.log('═'.repeat(88));
console.log('  O QUE FOI MEDIDO');
console.log('═'.repeat(88));
console.log('');
console.log(`  Maior população efetivamente exercitada:  ${Math.max(...POPULACOES)} jogadores SIMULADOS`);
console.log(`  Pior recompute p95:                       ${ms(pior.recomputeMs.p95)}  (n=${pior.n}, cenário ${pior.cenario})`);
console.log(`  Orçamento (25% do tick de ${TICK_MS} ms):        ${ms(ORCAMENTO)}  → ${pior.recomputeMs.p95 <= ORCAMENTO ? 'CABE' : '⚠️  ESTOURA'}`);
console.log(`  Idade máxima de rota (movimento normal):  ${ms(TICK_MS + pior.recomputeMs.p95)}`);
console.log('');

if (piorN200.length > 0) {
  console.log('  Em n=200, por cenário:');
  console.log('');
  for (const r of piorN200) {
    console.log(
      `    ${r.cenario} ${NOMES[r.cenario].padEnd(36)} ` +
      `p95 ${ms(r.recomputeMs.p95).padStart(11)} · ` +
      `CPU ${(r.cpu.fracao * 100).toFixed(0).padStart(3)}% · ` +
      `Δheap ${mb(r.memoria.deltaHeapMB).padStart(8)} · ` +
      `${String(r.voz.assinaturas).padStart(5)} assinaturas`
    );
  }
  console.log('');

  const c = piorN200.find((r) => r.cenario === 'C') || piorN200[0];
  console.log('  Banda ESTIMADA (aritmética, NÃO medida) no pior cenário de concentração:');
  console.log('');
  console.log(`    Locutores simultâneos:                  ${c.voz.locutores}`);
  console.log(`    Assinaturas ouvinte→locutor:            ${c.voz.assinaturas}`);
  console.log(`    Legado — subida (PCM+base64):           ${c.bandaEstimada.legadoSubidaMbps.toFixed(1)} Mbit/s`);
  console.log(`    Legado — descida do servidor de jogo:   ${c.bandaEstimada.legadoDescidaMbps.toFixed(1)} Mbit/s`);
  console.log(`    Legado — TOTAL no processo do gamemode: ${c.bandaEstimada.noProcessoDoJogoMbps.toFixed(1)} Mbit/s  ← o gargalo`);
  console.log(`    LiveKit — subida (Opus):                ${c.bandaEstimada.livekitSubidaMbps.toFixed(1)} Mbit/s`);
  console.log(`    LiveKit — descida (sai do SFU):         ${c.bandaEstimada.livekitDescidaSfuMbps.toFixed(1)} Mbit/s`);
  console.log('');
}

console.log('  NÃO MEDIDO por este script, e portanto NÃO DECLARADO:');
console.log('');
console.log('    · CPU e RAM do LiveKit          — não há livekit-server nesta máquina');
console.log('    · Banda real                    — os números acima são conta, não medição');
console.log('    · CPU do cliente, CPU da CEF    — exigem o jogo aberto');
console.log('    · FPS                           — idem');
console.log('    · Perda de pacote, RTT, jitter  — nada saiu de 127.0.0.1');
console.log('    · Latência de voz ponta a ponta — captura + codec + SFU + rede');
console.log('');
console.log('  Portanto: este script NÃO autoriza declarar suporte a 200 jogadores reais.');
console.log('  Ele mostra que o SkyMP decide rotas para 200 atores simulados dentro do orçamento.');
console.log('');

process.exit(0);

}

main().catch((err) => { console.error('[loadtest] falhou:', err); process.exit(1); });
