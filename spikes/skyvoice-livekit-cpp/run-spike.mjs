// Runner do spike C++ — mede EFEITO, não código de retorno.
//
// Ele existe por três motivos, e nenhum deles é conveniência:
//
// 1. **Os tokens têm que vir do nosso emissor.** Um spike que assinasse os
//    próprios tokens provaria que o LiveKit aceita tokens do LiveKit, que não é
//    a pergunta. Aqui eles saem de `core/voice/livekit-token.js` — o mesmo
//    módulo do gamemode, com o mesmo `participantIdentity`.
//
// 2. **Nenhum segredo em argv.** O binário recebe a configuração por UMA linha
//    de JSON no stdin. É a mesma regra do `voice-helper`, e vale no spike
//    porque um andaime que viola a regra vira o exemplo que alguém copia.
//
// 3. **O plano de controle é JavaScript.** Quem decide audiência é o Voice
//    Core; o `livekit-gateway.js` traduz isso em `UpdateSubscriptions`. Para
//    provar que a decisão do servidor chega ao ouvinte, é preciso um processo
//    que fale as duas línguas — e este é ele.
//
// Uso:
//   node run-spike.mjs                 transporte + PTT, automático
//   node run-spike.mjs --control-plane assinatura server-authoritative
//   node run-spike.mjs --mic --playout microfone e fone reais (humano)

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import readline from 'node:readline';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const GAMEMODE = path.resolve(HERE, '../../skymp/gamemode');

const livekitToken = require(path.join(GAMEMODE, 'core/voice/livekit-token.js'));
const { createVoiceLiveKitGateway } = require(
  path.join(GAMEMODE, 'core/voice/livekit-gateway.js')
);

const args = new Set(process.argv.slice(2));
const MODE_CONTROL = args.has('--control-plane');
const USE_MIC = args.has('--mic');
const USE_PLAYOUT = args.has('--playout');

const URL_ = process.env.LIVEKIT_URL || '';
const API_KEY = process.env.LIVEKIT_API_KEY || '';
const API_SECRET = process.env.LIVEKIT_API_SECRET || '';
const ROOM = process.env.LIVEKIT_ROOM || 'skyvoice';

if (!URL_ || !API_KEY || !API_SECRET) {
  console.error(
    'Faltam LIVEKIT_URL, LIVEKIT_API_KEY e/ou LIVEKIT_API_SECRET.\n' +
    'Este spike NAO roda contra mock: ele precisa de um livekit-server real.'
  );
  process.exit(2);
}

const EXE = process.env.SKYVOICE_SPIKE_EXE ||
  path.join(HERE, 'build', 'Release', 'skyvoice-spike.exe');
if (!fs.existsSync(EXE)) {
  console.error(`Executavel nao encontrado: ${EXE}\nVer README.md para o build.`);
  process.exit(2);
}

// Dois atores. Os IDs são arbitrários aqui porque o spike não tem mundo — no
// gamemode eles vêm do SkyMP.
const ACTOR_A = 0xff000a01;
const ACTOR_B = 0xff000a02;
const identityA = livekitToken.participantIdentity(ACTOR_A, 'spike01');
const identityB = livekitToken.participantIdentity(ACTOR_B, 'spike02');
const TRACK_NAME = 'skyvoice-mic';

function mint(identity, { canPublish, canSubscribe }) {
  return livekitToken.mintAccessToken({
    apiKey: API_KEY, apiSecret: API_SECRET, room: ROOM,
    identity, canPublish, canSubscribe
  });
}

// ── verificações ──────────────────────────────────────────────────────────
const checks = [];
function check(nome, passou, detalhe) {
  checks.push({ nome, passou, detalhe });
  console.log(`${passou ? '  ok  ' : ' FALHA'}  ${nome}${detalhe ? ` — ${detalhe}` : ''}`);
}

// ── o processo ────────────────────────────────────────────────────────────
const child = spawn(EXE, [], { stdio: ['pipe', 'pipe', 'inherit'] });
const out = readline.createInterface({ input: child.stdout });

const pending = [];
out.on('line', (line) => {
  if (!line.startsWith('RESULT ')) { console.log(`[spike] ${line}`); return; }
  const payload = JSON.parse(line.slice(7));
  const waiter = pending.shift();
  if (waiter) waiter(payload);
  else console.log('[spike] evento sem quem esperasse:', payload);
});

function expect() {
  return new Promise((resolve) => pending.push(resolve));
}
// Tempo para a ordem atravessar o SFU e o que já estava no ar acabar de chegar.
//
// Não é folga arbitrária: medido nesta bancada, um `mute()` deixa uma cauda de
// ~70 ms de áudio em voo (jitter buffer + rede). Medir colado no comando faz a
// cauda entrar na janela e o teste reprovar um comportamento correto. O número
// importa fora do spike: soltar o PTT NÃO corta a voz no mesmo instante.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SETTLE_MS = 700;
function send(cmd) {
  child.stdin.write(`${cmd}\n`);
}
async function measure(ms) {
  const p = expect();
  send(`MEASURE ${ms}`);
  return p;
}

function summarize(w) {
  return `${w.frames} quadros, RMS ${w.rms.toFixed(5)}, ` +
    `440Hz ${w.toneEnergy.toFixed(1)} vs 1kHz ${w.controlEnergy.toFixed(1)}`;
}

async function main() {
  const readyPromise = expect();

  child.stdin.write(`${JSON.stringify({
    url: URL_,
    tokenA: mint(identityA, { canPublish: true, canSubscribe: false }),
    tokenB: mint(identityB, { canPublish: false, canSubscribe: true }),
    identityA,
    trackName: TRACK_NAME,
    // No modo de plano de controle o ouvinte entra SEM assinar nada. É o
    // desenho de produção: quem concede é o Voice Core, não o cliente.
    autoSubscribe: !MODE_CONTROL,
    mic: USE_MIC,
    playout: USE_PLAYOUT
  })}\n`);

  const ready = await readyPromise;
  console.log(`\n[runner] A publicou. trackSid=${ready.trackSid}\n`);

  if (USE_MIC || USE_PLAYOUT) {
    // Modo humano: não há veredito automático. Fala-se, ouve-se, e quem julga
    // é a pessoa. O spike só reporta se ALGO chegou — "chegou som" não é o
    // mesmo que "entendi a frase", e só o segundo fecha o blocker #1.
    console.log('Modo humano. Fale ao microfone; Ctrl+C para sair.');
    console.log('Medindo janelas de 3 s e reportando o que chega:\n');
    for (;;) {
      const w = await measure(3000);
      console.log(`  ${summarize(w)}`);
    }
  }

  if (MODE_CONTROL) {
    // ── plano de controle ────────────────────────────────────────────────
    //
    // Antes: o ouvinte está na sala, o locutor está publicando, e NINGUÉM
    // mandou assinar. Se chegar áudio aqui, a autoridade do servidor é fictícia.
    const antes = await measure(2500);
    check('sem ordem do servidor, B nao recebe nada',
      antes.frames === 0, summarize(antes));

    const gateway = createVoiceLiveKitGateway({
      env: () => process.env,
      mintAdminToken: livekitToken.mintAdminToken
    });

    const identityOf = (actorId) =>
      actorId === ACTOR_A ? identityA : actorId === ACTOR_B ? identityB : null;

    const grant = await gateway.applySubscriptionDiff(
      { subscribe: [{ listener: ACTOR_B, speaker: ACTOR_A, track: TRACK_NAME }],
        unsubscribe: [] },
      identityOf
    );
    check('gateway aplicou o diff de assinatura',
      grant.ok && grant.calls > 0,
      `ok=${grant.ok} calls=${grant.calls} failures=${grant.failures} ` +
      `unresolved=${grant.unresolved}`);

    await sleep(SETTLE_MS);
    const depois = await measure(2500);
    check('depois da ordem do servidor, B recebe audio',
      depois.frames > 0 && depois.toneEnergy > depois.controlEnergy * 10,
      summarize(depois));

    const revoke = await gateway.applySubscriptionDiff(
      { subscribe: [],
        unsubscribe: [{ listener: ACTOR_B, speaker: ACTOR_A, track: TRACK_NAME }] },
      identityOf
    );
    check('gateway aplicou a revogacao', revoke.ok, `calls=${revoke.calls}`);

    // Desassinar demora MAIS que mutar, e é esperado: `mute()` só para de
    // enviar, enquanto `UpdateSubscriptions` desfaz a assinatura e renegocia.
    // Medido aqui: ~440 ms de cauda contra os ~70 ms do mute. Isso tem
    // consequência de jogo — sair do alcance não emudece o outro no mesmo
    // quadro, e é por isso que o ganho por distância também existe no cliente.
    await sleep(2000);
    const revogado = await measure(2500);
    check('depois da revogacao, B volta a nao receber',
      revogado.frames === 0, summarize(revogado));
  } else {
    // ── transporte + PTT ─────────────────────────────────────────────────
    const base = await measure(2500);
    check('B recebe audio de A pelo SFU', base.frames > 0, summarize(base));
    check('o sinal que chega e o que A mandou (440 Hz)',
      base.toneEnergy > base.controlEnergy * 10,
      `440Hz/1kHz = ${(base.toneEnergy / Math.max(base.controlEnergy, 1e-9)).toFixed(1)}x`);

    // PTT solto. `mute()` é a operação oficial: a faixa continua publicada e
    // não há renegociação — o oposto de reconectar a cada tecla.
    //
    // Registrar a espera ANTES de mandar o comando: o `expect()` entra na fila
    // de quem aguarda, e só depois o comando sai. Invertido, o `await` dormiria
    // esperando uma resposta que ainda não foi pedida.
    const muted = expect(); send('MUTE'); await muted;
    await sleep(SETTLE_MS);
    const silencio = await measure(2500);
    check('PTT solto -> silencio em B (sem sair da sala)',
      silencio.rms < 0.001, summarize(silencio));

    const unmuted = expect(); send('UNMUTE'); await unmuted;
    await sleep(SETTLE_MS);
    const volta = await measure(2500);
    check('PTT apertado -> o sinal volta',
      volta.frames > 0 && volta.toneEnergy > volta.controlEnergy * 10,
      summarize(volta));
  }

  send('QUIT');
  child.stdin.end();

  const falhas = checks.filter((c) => !c.passou).length;
  console.log(`\n${checks.length - falhas}/${checks.length} verificacoes passaram.`);
  if (falhas > 0) {
    console.log('\nUm resultado verde aqui prova TRANSPORTE e POLITICA.');
    console.log('Nao prova voz inteligivel, e nao prova nada dentro do Skyrim.');
  }
  process.exit(falhas === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[runner] erro:', err);
  try { child.kill(); } catch { /* ja morreu */ }
  process.exit(1);
});
