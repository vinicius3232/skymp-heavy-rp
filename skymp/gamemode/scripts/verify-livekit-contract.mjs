/**
 * scripts/verify-livekit-contract.mjs
 *
 * O contrato entre o `livekit-gateway` e um `livekit-server` DE VERDADE.
 *
 * ## Por que este arquivo existe
 *
 * `npm test` roda com `fetch` falso. Isso é correto — a suíte não pode exigir um
 * SFU para rodar — mas tem um limite que custou caro: **um teste com `fetch`
 * falso afirma o corpo que o código monta, e o código montava o corpo errado.**
 *
 * O corpo antigo de `UpdateSubscriptions` era
 * `participant_tracks: [{ participant_sid: <identity> }]`. Contra o servidor
 * real ele recebe **HTTP 200, corpo `{}`, e não assina nada**. Todos os
 * indicadores do gamemode ficariam verdes — circuito fechado, `gateway.ok`
 * subindo, painel saudável — enquanto nenhuma assinatura seletiva acontecia e o
 * SFU entregava todas as faixas a todo mundo. Ver `SKYVOICE_SECURITY_AUDIT.md`
 * §SV-05.
 *
 * Este script é o antídoto: ele mede **efeito**, não código HTTP. A pergunta que
 * ele faz não é "o SFU aceitou?", é "o ouvinte passou a receber a faixa?".
 *
 * ## Como rodar
 *
 * ```
 * livekit-server --dev --bind 127.0.0.1
 * npm run verify:livekit
 * ```
 *
 * Fora de `npm test` de propósito: exigir um SFU para a suíte passar tornaria o
 * projeto impossível de testar numa máquina limpa.
 *
 * Sai 0 se tudo passou, 1 se algo falhou, 2 se não deu para rodar (sem SFU, sem
 * cliente de mídia) — três saídas distintas porque "não rodou" e "rodou e falhou"
 * não podem parecer a mesma coisa num CI.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const aqui = path.dirname(fileURLToPath(import.meta.url));
const raizGamemode = path.resolve(aqui, '..');
const requireGamemode = createRequire(path.join(raizGamemode, 'package.json'));

const URL_SFU = process.env.LIVEKIT_URL || 'ws://127.0.0.1:7880';
const API_KEY = process.env.LIVEKIT_API_KEY || 'devkey';
const API_SECRET = process.env.LIVEKIT_API_SECRET || 'secret';
const SALA = process.env.LIVEKIT_ROOM || 'skyvoice-contract';

/**
 * O cliente de mídia mora no spike, não no gamemode — o gamemode é servidor e
 * não tem por que carregar um SDK de WebRTC. Resolver de lá mantém a dependência
 * fora do processo de produção sem impedir esta verificação.
 */
function carregarClienteRtc() {
  const spike = path.resolve(raizGamemode, '../../spikes/skyvoice-livekit/package.json');
  try {
    return createRequire(spike)('@livekit/rtc-node');
  } catch {
    return null;
  }
}

const resultados = [];
function verificar(nome, condicao, detalhe = '') {
  resultados.push({ nome, ok: condicao === true, detalhe });
  const marca = condicao === true ? 'PASSOU' : 'FALHOU';
  console.log(`  [${marca}] ${nome}${detalhe ? `  — ${detalhe}` : ''}`);
}

async function main() {
  console.log('== Contrato SkyVoice <-> livekit-server ==');
  console.log(`   SFU: ${URL_SFU}   sala: ${SALA}\n`);

  const rtc = carregarClienteRtc();
  if (!rtc) {
    console.error('NAO DEU PARA RODAR: @livekit/rtc-node ausente.');
    console.error('  cd spikes/skyvoice-livekit && npm install');
    process.exit(2);
  }

  const base = URL_SFU.replace(/^ws:/i, 'http:').replace(/^wss:/i, 'https:').replace(/\/+$/, '');
  try {
    const ping = await fetch(`${base}/`, { signal: AbortSignal.timeout(3000) });
    if (!ping.ok) throw new Error(`HTTP ${ping.status}`);
  } catch (err) {
    console.error(`NAO DEU PARA RODAR: SFU inalcançável em ${base} (${err.message}).`);
    console.error('  livekit-server --dev --bind 127.0.0.1');
    process.exit(2);
  }
  console.log('  [PASSOU] health check HTTP do SFU respondeu\n');

  const {
    Room, RoomEvent, AudioSource, AudioStream, AudioFrame,
    LocalAudioTrack, TrackPublishOptions, TrackSource
  } = rtc;
  const token = requireGamemode('../gamemode/core/voice/livekit-token.js');
  const { createVoiceLiveKitGateway } = requireGamemode('../gamemode/core/voice/livekit-gateway.js');

  // Dois atores do mundo, e a tradução actorId -> identity que o gamemode usa.
  const ATOR_LOCUTOR = 4001;
  const ATOR_OUVINTE = 4002;
  const identidades = new Map([
    [ATOR_LOCUTOR, token.participantIdentity(ATOR_LOCUTOR, 'c0ffee01')],
    [ATOR_OUVINTE, token.participantIdentity(ATOR_OUVINTE, 'c0ffee02')]
  ]);
  const identityOf = (actorId) => identidades.get(actorId) || null;

  const tokenDeJogador = (identity) => token.mintAccessToken({
    apiKey: API_KEY, apiSecret: API_SECRET, room: SALA, identity
  });

  const salaLocutor = new Room();
  const salaOuvinte = new Room();

  let assinadas = 0;
  /**
   * Quadros de áudio que chegaram no ouvinte.
   *
   * É a única medida honesta de "parou de receber". O evento `TrackUnsubscribed`
   * do `@livekit/rtc-node` **não dispara** quando quem desassina é o servidor —
   * medido nesta mesma bancada: `UpdateSubscriptions(subscribe:false)` derruba o
   * fluxo (300 quadros em 3 s → 0 quadros em 3 s) sem emitir o evento. Um teste
   * escrito em cima do evento concluiria que o desassinar não funciona, e trocaria
   * um sistema correto por um errado.
   */
  let quadros = 0;
  salaOuvinte.on(RoomEvent.TrackSubscribed, (track) => {
    assinadas++;
    const fluxo = new AudioStream(track);
    (async () => { for await (const _q of fluxo) quadros++; })();
  });

  // `autoSubscribe: false` NÃO é detalhe de teste: é a única configuração em que
  // assinatura seletiva decide alguma coisa. Com o padrão `true`, o SFU entrega
  // tudo na entrada e o gateway fica correndo atrás do próprio servidor.
  await salaLocutor.connect(URL_SFU, tokenDeJogador(identityOf(ATOR_LOCUTOR)), { autoSubscribe: false });
  await salaOuvinte.connect(URL_SFU, tokenDeJogador(identityOf(ATOR_OUVINTE)), { autoSubscribe: false });
  verificar('locutor e ouvinte entraram com token emitido pelo gamemode', true);

  const fonte = new AudioSource(48000, 1);
  const opcoes = new TrackPublishOptions();
  opcoes.source = TrackSource.SOURCE_MICROPHONE;
  const publicacao = await salaLocutor.localParticipant.publishTrack(
    LocalAudioTrack.createAudioTrack('mic', fonte), opcoes
  );
  // Um tom contínuo, para que "parou de receber" seja distinguível de "nunca
  // teve o que receber". Sem sinal, zero quadros passaria como sucesso mesmo com
  // o desassinar quebrado.
  let gerando = true;
  (async () => {
    const N = 480;
    let fase = 0;
    while (gerando) {
      const amostras = new Int16Array(N);
      for (let i = 0; i < N; i++) {
        amostras[i] = Math.round(8000 * Math.sin(fase));
        fase += (2 * Math.PI * 440) / 48000;
      }
      try { await fonte.captureFrame(new AudioFrame(amostras, 48000, 1, N)); } catch { gerando = false; }
    }
  })();

  await sleep(1500);
  verificar('locutor publicou faixa de microfone', typeof publicacao.sid === 'string', publicacao.sid);

  // ── O gateway REAL, com fetch REAL ──────────────────────────────────────────
  const ambiente = {
    LIVEKIT_URL: URL_SFU,
    LIVEKIT_API_KEY: API_KEY,
    LIVEKIT_API_SECRET: API_SECRET,
    LIVEKIT_ROOM: SALA,
    VOICE_BACKEND: 'livekit'
  };
  const gateway = createVoiceLiveKitGateway({
    env: () => ambiente,
    mintAdminToken: token.mintAdminToken,
    logger: { log: () => {}, warn: () => {}, error: () => {} }
  });

  const aresta = (listener, speaker) => ({ listener, speaker, track: 'microphone' });

  // 1. ASSINAR
  const antesDeAssinar = assinadas;
  const rAssinar = await gateway.applySubscriptionDiff(
    { subscribe: [aresta(ATOR_OUVINTE, ATOR_LOCUTOR)], unsubscribe: [] }, identityOf
  );
  await sleep(2500);

  verificar('o gateway descobriu o track SID sozinho, via ListParticipants',
    gateway.describe().trackRegistryRefreshes === 1,
    `recargas=${gateway.describe().trackRegistryRefreshes}`);
  verificar('applySubscriptionDiff relatou sucesso', rAssinar.ok === true,
    `calls=${rAssinar.calls} unresolved=${rAssinar.unresolved}`);
  verificar('EFEITO: o ouvinte passou a receber a faixa', assinadas - antesDeAssinar === 1,
    `eventos TrackSubscribed=${assinadas - antesDeAssinar}`);

  // Áudio realmente atravessando: a assinatura vale pelo que ela entrega.
  const marcoAssinado = quadros;
  await sleep(3000);
  const quadrosAssinado = quadros - marcoAssinado;
  verificar('EFEITO: quadros de áudio chegam ao ouvinte', quadrosAssinado > 100,
    `${quadrosAssinado} quadros em 3 s`);

  // 2. DESASSINAR
  const rDesassinar = await gateway.applySubscriptionDiff(
    { subscribe: [], unsubscribe: [aresta(ATOR_OUVINTE, ATOR_LOCUTOR)] }, identityOf
  );
  await sleep(3000);
  verificar('desassinar relatou sucesso', rDesassinar.ok === true);

  const marcoDesassinado = quadros;
  await sleep(3000);
  const quadrosDepois = quadros - marcoDesassinado;
  verificar('EFEITO: o áudio PAROU de atravessar — é isto que paga a conta de banda',
    quadrosDepois === 0, `${quadrosDepois} quadros em 3 s`);

  // 3. REGRESSÃO: o corpo ANTIGO precisa continuar sendo inútil
  //
  // Este caso é o que impede o SV-05 de voltar. Se um dia alguém "simplificar" o
  // gateway de volta para `participant_tracks` com identity, o teste com fetch
  // falso continuaria passando — este aqui não.
  const antesDoAntigo = assinadas;
  const jwtOperador = token.mintAdminToken({ apiKey: API_KEY, apiSecret: API_SECRET, room: SALA });
  const respostaAntiga = await fetch(`${base}/twirp/livekit.RoomService/UpdateSubscriptions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwtOperador}` },
    body: JSON.stringify({
      room: SALA,
      identity: identityOf(ATOR_OUVINTE),
      participant_tracks: [{ participant_sid: identityOf(ATOR_LOCUTOR) }],
      subscribe: true
    })
  });
  await sleep(2500);
  verificar('o corpo ANTIGO recebe HTTP 200 do SFU', respostaAntiga.status === 200,
    `status=${respostaAntiga.status}`);
  verificar('...e mesmo assim NAO assina nada — o 200 era mentiroso',
    assinadas - antesDoAntigo === 0,
    `eventos TrackSubscribed=${assinadas - antesDoAntigo}`);

  gerando = false;
  await salaLocutor.disconnect();
  await salaOuvinte.disconnect();

  const falhas = resultados.filter((r) => !r.ok);
  console.log(`\n== ${resultados.length - falhas.length}/${resultados.length} verificações passaram ==`);
  if (falhas.length > 0) {
    console.log('FALHOU:');
    for (const f of falhas) console.log(`  - ${f.nome}`);
  }
  process.exit(falhas.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('erro inesperado:', err);
  process.exit(1);
});
