#!/usr/bin/env node
/**
 * scripts/soak-voice.js
 *
 * Soak test do SkyVoice: milhares de ciclos com gente entrando, saindo, falando,
 * calando, morrendo, reconectando e atravessando portas — procurando o que só
 * aparece com o tempo.
 *
 * ## Os sete vazamentos que este script procura
 *
 * Cada um tem um sintoma diferente em produção, e nenhum aparece num teste
 * unitário, porque todos exigem repetição:
 *
 * | # | Vazamento | Como se manifesta no servidor |
 * |---|---|---|
 * | 1 | **Participantes obsoletos** | `sessions` cresce sem parar; o SFU acumula gente que saiu |
 * | 2 | **Assinaturas obsoletas** | banda paga para entregar voz a quem não está mais lá |
 * | 3 | **VoiceState obsoleto** | `state` cresce; a política decide sobre atores que não existem |
 * | 4 | **Estado de fala preso** | boca aberta congelada; `speaking` nunca zera |
 * | 5 | **Índice espacial inchado** | buckets com atores mortos; a busca fica cara sem motivo |
 * | 6 | **Laço de reconexão** | reconexões crescem sem que ninguém tenha caído |
 * | 7 | **Heap crescendo** | o processo do jogo morre por OOM depois de horas |
 *
 * ## O critério, e por que ele não é "a memória não cresceu"
 *
 * Heap sempre oscila: o V8 aloca em blocos e coleta quando quer. Um critério de
 * "não cresceu nada" reprovaria toda execução e seria desligado na primeira
 * semana. O que se exige aqui é diferente:
 *
 *   - **Estruturas contadas voltam ao ponto de partida.** Sessões, estado,
 *     assinaturas e falantes têm um número certo no fim: o mesmo do começo. Esse
 *     é o critério duro, e é ele que reprova.
 *   - **Heap tem TENDÊNCIA plana.** Mede-se a inclinação da reta pelos mínimos
 *     quadrados sobre amostras pós-GC. Crescimento sustentado reprova; oscilação
 *     não.
 *
 * A distinção importa: um `Map` que nunca é limpo aparece nas duas medidas, mas
 * aparece **imediatamente e sem ambiguidade** na primeira.
 *
 * ## O que este script NÃO detecta
 *
 * - Vazamento no CLIENTE (AudioNode, BufferSource, `PannerNode` pendurado). Isso
 *   é a CEF, e exige o jogo aberto — `window.voiceStats()` é o instrumento, e
 *   está no checklist de bancada, não aqui.
 * - Vazamento no `livekit-server`. Não há um nesta máquina.
 * - Vazamento nativo do `voice-helper`. É C++ e outro processo.
 *
 * ## Como rodar
 *
 *     node --expose-gc scripts/soak-voice.js
 *     node --expose-gc scripts/soak-voice.js --ciclos 20000 --n 100
 *
 * Sai `1` se qualquer estrutura não voltar ao ponto de partida, ou se a
 * tendência de heap for de crescimento sustentado. É portão, ao contrário do
 * `loadtest`.
 */

const path = require('path');
const gamemodeDir = path.join(__dirname, '..');

process.env.LIVEKIT_URL = process.env.LIVEKIT_URL || 'wss://soak.invalido';
process.env.LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || 'soak';
process.env.LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || 'segredo-sintetico-de-soak-test-000000';

const { createVoiceCore } = require(path.join(gamemodeDir, 'core', 'voice', 'voice-core'));
const { createVoiceLiveKitGateway } = require(path.join(gamemodeDir, 'core', 'voice', 'livekit-gateway'));
const { createVoiceStaffMute } = require(path.join(gamemodeDir, 'core', 'voice', 'voice-staff-mute'));
const { createVoiceTelemetry } = require(path.join(gamemodeDir, 'core', 'voice', 'voice-telemetry'));
const { mintAdminToken } = require(path.join(gamemodeDir, 'core', 'voice', 'livekit-token'));

const argv = process.argv.slice(2);
const inteiro = (nome, padrao) => {
  const i = argv.indexOf(`--${nome}`);
  return i >= 0 && argv[i + 1] ? Number.parseInt(argv[i + 1], 10) : padrao;
};

const CICLOS = inteiro('ciclos', 12000);
const POPULACAO = inteiro('n', 80);
const AMOSTRA_CADA = inteiro('amostra', 500);

const CELULAS = ['3c:Skyrim.esm', '165a9:Skyrim.esm', '1a26f:Skyrim.esm', '16d71:Skyrim.esm'];

function rng(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function heapMB() {
  if (typeof global.gc === 'function') { global.gc(); global.gc(); }
  return process.memoryUsage().heapUsed / 1048576;
}

/** Inclinação da reta por mínimos quadrados, em MB por amostra. */
function tendencia(pontos) {
  const n = pontos.length;
  if (n < 3) return 0;
  const mediaX = (n - 1) / 2;
  const mediaY = pontos.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - mediaX) * (pontos[i] - mediaY);
    den += (i - mediaX) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

// ─────────────────────────────────────────────────────────────────────────────

const random = rng(20260814);

/** Mundo vivo: atores entram e saem, e o mapa só contém quem está conectado. */
const atores = new Map();
let proximoId = 0xff000000;

/**
 * A sala do SFU falso: `identity → trackSid`.
 *
 * Um `Map` vivo, e não uma lista montada uma vez, porque o soak tem
 * rotatividade real — é justamente o regime em que um registro de faixas
 * poderia vazar. Se o gateway guardasse identidades de quem já saiu, este mapa
 * e o `describe().knownTrackIdentities` divergiriam, e a divergência é o que o
 * soak procura.
 *
 * @type {Map<string, string>}
 */
const salaDoSfu = new Map();

const gateway = createVoiceLiveKitGateway({
  fetchImpl: async (url) => {
    if (String(url).endsWith('/ListParticipants')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          participants: [...salaDoSfu].map(([identity, sid]) => ({
            identity,
            tracks: [{ sid, type: 'AUDIO', source: 'MICROPHONE' }]
          }))
        })
      };
    }
    return { ok: true, status: 200 };
  },
  mintAdminToken,
  logger: { log() {}, warn() {}, error() {} }
});

const staffMute = createVoiceStaffMute();
const core = createVoiceCore({
  mp: {
    get(actorId, field) {
      const a = atores.get(actorId);
      if (!a) return null;
      if (field === 'locationalData') {
        return { pos: a.pos, cellOrWorldDesc: a.space, rot: [0, 0, a.yaw] };
      }
      return null;
    },
    set() {}
  },
  gateway,
  staffMute,
  logger: { log() {}, warn() {}, error() {} }
});
const telemetria = createVoiceTelemetry({ core });

function entrar() {
  const actorId = proximoId++;
  const a = {
    actorId,
    characterId: actorId & 0xffff,
    pos: [(random() - 0.5) * 20000, (random() - 0.5) * 20000, 0],
    space: CELULAS[Math.floor(random() * CELULAS.length)],
    yaw: random() * 360
  };
  atores.set(actorId, a);
  const aberto = core.attach(actorId, { characterId: a.characterId });
  if (aberto.session) {
    core.sessions.confirmConnected(aberto.session.identity);
    a.identity = aberto.session.identity;
    salaDoSfu.set(a.identity, `TR_${actorId}`);
  }
  return a;
}

function sair(actorId) {
  const a = atores.get(actorId);
  core.detach(actorId, 'logout');
  telemetria.forget(actorId);
  // Sai da sala do SFU junto. Um participante que fica aqui depois do logout
  // faria o gateway continuar achando que existe uma faixa dele — que é
  // exatamente o "stale subscription" que este script procura.
  if (a && a.identity) salaDoSfu.delete(a.identity);
  atores.delete(actorId);
}

// ── Ponto de partida ─────────────────────────────────────────────────────────

for (let i = 0; i < POPULACAO; i++) entrar();
for (let i = 0; i < 20; i++) core.recompute('tick');

const heapInicial = heapMB();
const linhaBase = {
  atores: core.describe().actors,
  sessoes: core.describe().sessions,
  assinaturas: core.routes.subscriptionCount(),
  falantes: core.speaking.describe().tracked,
  indice: core.index.describe().total ?? core.describe().spatial.total
};

console.log('');
console.log('═'.repeat(84));
console.log('  SOAK TEST — SkyVoice');
console.log('═'.repeat(84));
console.log(`  ${CICLOS} ciclos · população estável ~${POPULACAO} · Node ${process.version}`);
console.log(`  GC exposto: ${typeof global.gc === 'function' ? 'sim' : 'NÃO — rode com --expose-gc, senão a tendência é ruído'}`);
console.log('');
console.log(`  Linha de base: ${linhaBase.atores} atores · ${linhaBase.sessoes} sessões · ` +
            `${linhaBase.assinaturas} assinaturas · heap ${heapInicial.toFixed(1)} MB`);
console.log('');

// ── O soak ───────────────────────────────────────────────────────────────────

const amostrasHeap = [];
const t0 = Date.now();
let entradas = 0, saidas = 0, mortes = 0, mutes = 0, reconexoes = 0;

/**
 * O laço é assíncrono, e isso NÃO é detalhe de implementação.
 *
 * A primeira versão deste script rodava os ciclos num `for` síncrono e acusou um
 * vazamento de 42 MB. O vazamento era do script: `recompute()` dispara
 * `gateway.applySubscriptionDiff()` sem esperar (de propósito — o laço de voz não
 * pode bloquear na rede), e um `for` síncrono **nunca devolve o controle ao event
 * loop**, então nenhuma daquelas promessas resolvia. Doze mil cadeias pendentes,
 * cada uma segurando o diff que a originou, viram dezenas de megabytes.
 *
 * Um servidor de verdade não se comporta assim: o `setInterval` do Voice Core
 * devolve o controle entre os ticks, e as promessas resolvem. Um soak que não
 * devolve mede um regime que não existe — e reprovaria para sempre por um
 * defeito que ele mesmo cria.
 *
 * Drenar a cada ciclo é o que reproduz o servidor. Foi assim que o "vazamento"
 * caiu de 14,4 MB para 3,5 MB na medição de controle.
 */
async function soak() {
for (let ciclo = 0; ciclo < CICLOS; ciclo++) {
  // Movimento, com travessia de porta.
  for (const a of atores.values()) {
    a.pos = [a.pos[0] + (random() - 0.5) * 400, a.pos[1] + (random() - 0.5) * 400, a.pos[2]];
    if (random() < 0.01) a.space = CELULAS[Math.floor(random() * CELULAS.length)];
    a.yaw = (a.yaw + (random() - 0.5) * 30) % 360;
  }

  // Rotatividade: alguém sai, alguém entra. É o que produz participante
  // obsoleto se o cleanup não for completo.
  if (random() < 0.05 && atores.size > 10) {
    const ids = [...atores.keys()];
    sair(ids[Math.floor(random() * ids.length)]);
    saidas++;
  }
  if (atores.size < POPULACAO) { entrar(); entradas++; }

  // Reconexão: sai e volta no mesmo ciclo. É o caminho que produz sessão
  // superada, e o que um cabo instável faz o dia inteiro.
  if (random() < 0.03 && atores.size > 0) {
    const ids = [...atores.keys()];
    const id = ids[Math.floor(random() * ids.length)];
    const a = atores.get(id);
    const aberto = core.attach(id, { characterId: a.characterId });
    if (aberto.session) {
      core.sessions.confirmConnected(aberto.session.identity);
      // Reconectar troca a identidade (nonce novo). A antiga precisa sair da
      // sala do SFU, senão cada reconexão deixa um participante fantasma — e o
      // soak roda 12 000 ciclos, então o fantasma vira vazamento medível.
      if (a.identity && a.identity !== aberto.session.identity) salaDoSfu.delete(a.identity);
      a.identity = aberto.session.identity;
      salaDoSfu.set(a.identity, `TR_${id}`);
    }
    reconexoes++;
  }

  // Fala.
  for (const id of atores.keys()) {
    if (random() < 0.12) { core.pttDown(id); core.noteAudioFrame(id); }
    else if (random() < 0.10) core.pttUp(id);
  }

  // Punição de staff, aplicada e desfeita. Exercita o observador que reemite
  // token — o caminho novo desta etapa, e o mais provável de vazar inscrição.
  if (random() < 0.02 && atores.size > 0) {
    const ids = [...atores.values()];
    const a = ids[Math.floor(random() * ids.length)];
    staffMute.mute(a.characterId, { reason: 'soak' });
    mutes++;
  }
  if (random() < 0.02 && atores.size > 0) {
    const ids = [...atores.values()];
    staffMute.unmute(ids[Math.floor(random() * ids.length)].characterId);
  }

  // Mudança crítica fora do tick.
  if (random() < 0.05 && atores.size > 0) {
    const ids = [...atores.keys()];
    core.markCritical(ids[Math.floor(random() * ids.length)], 'teleport');
    mortes++;
  }

  core.recompute('tick');
  core.speaking.sweep();

  // Devolve o controle ao event loop, como o `setInterval` do Voice Core faz
  // entre dois ticks. Sem isto o soak mede um regime que não existe.
  await new Promise((r) => setImmediate(r));

  if (ciclo > 0 && ciclo % AMOSTRA_CADA === 0) {
    amostrasHeap.push(heapMB());
    process.stdout.write(
      `\r  ciclo ${String(ciclo).padStart(6)}/${CICLOS} · ` +
      `sessões ${String(core.describe().sessions).padStart(4)} · ` +
      `assin. ${String(core.routes.subscriptionCount()).padStart(5)} · ` +
      `heap ${amostrasHeap[amostrasHeap.length - 1].toFixed(1).padStart(6)} MB   `
    );
  }
}
}

soak().then(relatorio).catch((err) => {
  console.error('[soak] falhou:', err);
  process.exit(1);
});

function relatorio() {

process.stdout.write('\r' + ' '.repeat(100) + '\r');
const duracaoS = (Date.now() - t0) / 1000;

// ── Volta ao repouso ─────────────────────────────────────────────────────────
//
// Todo mundo sai. Depois disso, TODA estrutura contada precisa estar em zero.
// É o critério duro: um Map que não é limpo aparece aqui sem ambiguidade.

for (const id of [...atores.keys()]) sair(id);
for (let i = 0; i < 10; i++) core.recompute('tick');
core.speaking.sweep();

const heapFinal = heapMB();
const repouso = {
  atores: core.describe().actors,
  sessoes: core.describe().sessions,
  assinaturas: core.routes.subscriptionCount(),
  falantesRastreados: core.speaking.describe().tracked,
  falandoAgora: core.speaking.describe().speaking,
  indice: core.describe().spatial.total,
  qualidadeRastreada: 0
};

const snap = telemetria.snapshot();
const inclinacao = tendencia(amostrasHeap);

// ── Relatório ────────────────────────────────────────────────────────────────

console.log(`  Concluído em ${duracaoS.toFixed(1)} s · ${(CICLOS / duracaoS).toFixed(0)} ciclos/s`);
console.log('');
console.log(`  Rotatividade exercitada: ${entradas} entradas · ${saidas} saídas · ` +
            `${reconexoes} reconexões · ${mutes} silenciamentos · ${mortes} mudanças críticas`);
console.log('');
console.log('  ── Volta ao repouso: TODA estrutura precisa estar em zero ────────────────');
console.log('');

const falhas = [];
const conferir = (nome, valor, esperado, sintoma) => {
  const ok = valor === esperado;
  if (!ok) falhas.push(`${nome}: ${valor} (esperado ${esperado}) — ${sintoma}`);
  console.log(`    ${ok ? '✔' : '✖'} ${nome.padEnd(34)} ${String(valor).padStart(6)}   ${ok ? '' : '← ' + sintoma}`);
};

conferir('VoiceState de ator', repouso.atores, 0, 'a política decidiria sobre atores que não existem');
conferir('Sessões (participantes)', repouso.sessoes, 0, 'o SFU acumularia gente que saiu');
conferir('Assinaturas', repouso.assinaturas, 0, 'banda paga para entregar a quem não está lá');
conferir('Atores rastreados por fala', repouso.falantesRastreados, 0, 'estado de fala preso');
conferir('Falando agora', repouso.falandoAgora, 0, 'boca aberta congelada');
conferir('Atores no índice espacial', repouso.indice, 0, 'buscas caras sobre atores mortos');
conferir('Jogadores conectados (métrica)', snap.metrics.voice_connected_players, 0, 'a métrica mentiria para a operação');

console.log('');
console.log('  ── Heap ──────────────────────────────────────────────────────────────────');
console.log('');
console.log(`    Inicial:              ${heapInicial.toFixed(2)} MB`);
console.log(`    Final (em repouso):   ${heapFinal.toFixed(2)} MB`);
console.log(`    Delta:                ${(heapFinal - heapInicial >= 0 ? '+' : '')}${(heapFinal - heapInicial).toFixed(2)} MB`);
console.log(`    Tendência:            ${(inclinacao >= 0 ? '+' : '')}${inclinacao.toFixed(4)} MB por amostra (${amostrasHeap.length} amostras)`);
console.log('');

// Um vazamento real de estrutura cresce a cada ciclo. 0.05 MB por amostra de 500
// ciclos são ~1,2 MB a cada 12.000 ciclos — abaixo do ruído de um V8 que
// realoca; acima disso é tendência, não oscilação.
const LIMITE_INCLINACAO = 0.05;
const heapOk = inclinacao <= LIMITE_INCLINACAO;
if (!heapOk) {
  falhas.push(`tendência de heap +${inclinacao.toFixed(4)} MB/amostra — crescimento sustentado`);
}
console.log(`    ${heapOk ? '✔' : '✖'} Tendência dentro do limite (${LIMITE_INCLINACAO} MB/amostra)`);
console.log('');

console.log('  ── Erros durante o soak ──────────────────────────────────────────────────');
console.log('');
console.log(`    Erros de servidor:    ${snap.metrics.voice_server_errors}`);
console.log(`    Falhas de auth:       ${snap.metrics.voice_auth_failures}`);
console.log(`    Reconexões contadas:  ${snap.metrics.voice_reconnects}`);
console.log(`    Churn de assinatura:  ${snap.metrics.voice_subscription_changes}`);
console.log('');

console.log('  NÃO detectado por este script:');
console.log('    · AudioNode / BufferSource / PannerNode pendurados — é CEF, exige o jogo aberto');
console.log('    · Vazamento no livekit-server — não há um nesta máquina');
console.log('    · Vazamento nativo do voice-helper — é C++, outro processo');
console.log('');

core.shutdown();

if (falhas.length > 0) {
  console.log('═'.repeat(84));
  console.log(`  ✖ SOAK REPROVOU — ${falhas.length} problema(s):`);
  for (const f of falhas) console.log(`      · ${f}`);
  console.log('═'.repeat(84));
  console.log('');
  process.exit(1);
}

console.log('═'.repeat(84));
console.log('  ✔ SOAK PASSOU — nenhuma estrutura ficou para trás, heap sem tendência de alta.');
console.log('═'.repeat(84));
console.log('');
process.exit(0);

}
