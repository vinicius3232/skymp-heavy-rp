/**
 * core/voice/voice-route-engine.test.js
 *
 * Entrar e sair de alcance, e — o mais importante — **o que NÃO vira chamada**.
 *
 * A instrução era explícita sobre não fazer chamada redundante e manter cache do
 * estado atual. Um teste que só verifica "A entrou no alcance ⇒ subscribe"
 * passaria numa implementação que emite subscribe a cada tick. O que separa as
 * duas é o segundo tick: com A ainda no alcance, o diff tem que vir vazio.
 *
 * Executa com: node --test core/voice/voice-route-engine.test.js
 */

const assert = require('assert');
const { describe, it, beforeEach } = require('node:test');

const { VOICE_RANGES } = require('../proximity-ranges');
const { createVoiceStateService, CONNECTION_STATES } = require('./voice-state');
const { createVoicePolicyEngine } = require('./voice-policy');
const { createVoiceSpatialIndex } = require('./voice-spatial-index');
const { createVoiceRouteEngine, LOCAL_TRACK } = require('./voice-route-engine');

const A = 0xff00d001;
const B = 0xff00d002;
const C = 0xff00d003;
const CELL = '162e2:Skyrim.esm';
const OUTRA = '1a2b3:Skyrim.esm';

function montar() {
  const state = createVoiceStateService();
  const policy = createVoicePolicyEngine({ state });
  const index = createVoiceSpatialIndex();
  const routes = createVoiceRouteEngine({ state, policy, index });
  return { state, policy, index, routes };
}

/** Ator conectado, com personagem e PTT apertado. */
function falante(state, policy, actorId, mode = 'normal') {
  state.ensure(actorId, { characterId: actorId });
  state.setConnectionState(actorId, CONNECTION_STATES.CONNECTED);
  state.setVoiceMode(actorId, mode);
  policy.pttDown(actorId);
}

/** Ator conectado que só escuta. */
function ouvinte(state, actorId) {
  state.ensure(actorId, { characterId: actorId });
  state.setConnectionState(actorId, CONNECTION_STATES.CONNECTED);
}

const em = (actorId, x, space = CELL) => ({ actorId, space, pos: [x, 0, 0] });

describe('voice-route-engine — rotas', () => {
  let ctx;
  beforeEach(() => { ctx = montar(); });

  it('quem fala alcança quem está perto, com volume', () => {
    falante(ctx.state, ctx.policy, A);
    ouvinte(ctx.state, B);

    const r = ctx.routes.recompute([em(A, 0), em(B, 100)]);

    const audiencia = r.audienceBySpeaker.get(A);
    assert.strictEqual(audiencia.length, 1);
    assert.strictEqual(audiencia[0].actorId, B);
    assert.ok(audiencia[0].volume > 0);
    assert.strictEqual(r.routesByListener.get(B).get(A), audiencia[0].volume);
  });

  it('quem está com o PTT solto não gera rota nenhuma', () => {
    falante(ctx.state, ctx.policy, A);
    ouvinte(ctx.state, B);
    ctx.policy.pttUp(A);

    const r = ctx.routes.recompute([em(A, 0), em(B, 100)]);
    assert.strictEqual(r.routeCount, 0);
    assert.strictEqual(r.audienceBySpeaker.size, 0);
  });

  it('quem está mutado não gera rota nenhuma', () => {
    falante(ctx.state, ctx.policy, A);
    ouvinte(ctx.state, B);
    ctx.policy.requestMute(A, true);

    const r = ctx.routes.recompute([em(A, 0), em(B, 100)]);
    assert.strictEqual(r.routeCount, 0);
  });

  it('células diferentes não produzem rota, por mais perto que estejam', () => {
    falante(ctx.state, ctx.policy, A);
    ouvinte(ctx.state, B);

    const r = ctx.routes.recompute([em(A, 0, CELL), em(B, 0, OUTRA)]);
    assert.strictEqual(r.routeCount, 0);
  });

  it('a rota é dirigida: A grita para B sem B sussurrar de volta', () => {
    falante(ctx.state, ctx.policy, A, 'shout');
    falante(ctx.state, ctx.policy, B, 'whisper');

    const distancia = VOICE_RANGES.whisper + 100;
    const r = ctx.routes.recompute([em(A, 0), em(B, distancia)]);

    assert.strictEqual(r.audienceBySpeaker.get(A).length, 1, 'A alcança B');
    assert.strictEqual(r.audienceBySpeaker.has(B), false, 'B não alcança A');
  });
});

describe('voice-route-engine — entrar e sair de alcance', () => {
  let ctx;
  beforeEach(() => {
    ctx = montar();
    falante(ctx.state, ctx.policy, A);
    ouvinte(ctx.state, B);
  });

  it('ENTRAR no alcance emite exatamente um subscribe, na faixa voice.local', () => {
    const longe = ctx.routes.recompute([em(A, 0), em(B, VOICE_RANGES.normal + 500)]);
    assert.strictEqual(longe.diff.subscribe.length, 0);

    const perto = ctx.routes.recompute([em(A, 0), em(B, 100)]);
    assert.deepStrictEqual(perto.diff.subscribe, [{ listener: B, speaker: A, track: LOCAL_TRACK }]);
    assert.strictEqual(perto.diff.unsubscribe.length, 0);
  });

  it('SAIR do alcance emite exatamente um unsubscribe', () => {
    ctx.routes.recompute([em(A, 0), em(B, 100)]);
    const saiu = ctx.routes.recompute([em(A, 0), em(B, VOICE_RANGES.normal + 500)]);

    assert.deepStrictEqual(saiu.diff.unsubscribe, [{ listener: B, speaker: A, track: LOCAL_TRACK }]);
    assert.strictEqual(saiu.diff.subscribe.length, 0);
  });

  it('FICAR no alcance não emite NADA — é o cache fazendo o trabalho dele', () => {
    ctx.routes.recompute([em(A, 0), em(B, 100)]);

    for (let tick = 0; tick < 20; tick++) {
      const r = ctx.routes.recompute([em(A, 0), em(B, 100 + tick)]);
      assert.strictEqual(r.diff.subscribe.length, 0, `tick ${tick} emitiu subscribe redundante`);
      assert.strictEqual(r.diff.unsubscribe.length, 0, `tick ${tick} emitiu unsubscribe redundante`);
    }
  });

  it('o volume MUDA a cada passo sem que a assinatura mude — é o ponto da separação', () => {
    ctx.routes.recompute([em(A, 0), em(B, 100)]);
    const perto = ctx.routes.recompute([em(A, 0), em(B, 200)]);
    const longe = ctx.routes.recompute([em(A, 0), em(B, 800)]);

    assert.ok(perto.routesByListener.get(B).get(A) > longe.routesByListener.get(B).get(A));
    assert.strictEqual(perto.diff.subscribe.length + perto.diff.unsubscribe.length, 0);
    assert.strictEqual(longe.diff.subscribe.length + longe.diff.unsubscribe.length, 0);
  });

  it('mudar de modo de voz reflete na assinatura quando cruza a borda', () => {
    // B está fora do sussurro e dentro da fala normal.
    const distancia = VOICE_RANGES.whisper + 50;
    const normal = ctx.routes.recompute([em(A, 0), em(B, distancia)]);
    assert.strictEqual(normal.diff.subscribe.length, 1);

    ctx.state.setVoiceMode(A, 'whisper');
    const sussurro = ctx.routes.recompute([em(A, 0), em(B, distancia)]);
    assert.strictEqual(sussurro.diff.unsubscribe.length, 1, 'sussurrar tira B do alcance');

    ctx.state.setVoiceMode(A, 'shout');
    const grito = ctx.routes.recompute([em(A, 0), em(B, distancia)]);
    assert.strictEqual(grito.diff.subscribe.length, 1, 'gritar traz B de volta');
  });
});

describe('voice-route-engine — desconexão e limpeza', () => {
  let ctx;
  beforeEach(() => {
    ctx = montar();
    falante(ctx.state, ctx.policy, A);
    ouvinte(ctx.state, B);
    ouvinte(ctx.state, C);
  });

  it('o ouvinte sumindo da amostra gera unsubscribe', () => {
    ctx.routes.recompute([em(A, 0), em(B, 100)]);
    const semB = ctx.routes.recompute([em(A, 0)]);
    assert.deepStrictEqual(semB.diff.unsubscribe, [{ listener: B, speaker: A, track: LOCAL_TRACK }]);
  });

  it('forget limpa o cache SEM gerar comando para um participante que já saiu', () => {
    ctx.routes.recompute([em(A, 0), em(B, 100), em(C, 100)]);
    assert.strictEqual(ctx.routes.subscriptionCount(), 2);

    // B saiu da sala. As assinaturas dele morreram junto: desassiná-las seria
    // citar uma identidade que não existe mais.
    const removidas = ctx.routes.forget(B);
    assert.ok(removidas > 0);

    const depois = ctx.routes.recompute([em(A, 0), em(C, 100)]);
    assert.strictEqual(depois.diff.unsubscribe.length, 0, 'forget não pode deixar unsubscribe pendente');
    assert.strictEqual(depois.diff.subscribe.length, 0, 'C continua assinado');
  });

  it('forget do LOCUTOR limpa as assinaturas que apontavam para ele', () => {
    ctx.routes.recompute([em(A, 0), em(B, 100), em(C, 100)]);
    ctx.routes.forget(A);
    assert.strictEqual(ctx.routes.subscriptionCount(), 0);
    assert.deepStrictEqual(ctx.routes.subscriptionsOf(B), []);
  });

  it('reset zera o cache inteiro', () => {
    ctx.routes.recompute([em(A, 0), em(B, 100)]);
    ctx.routes.reset();
    assert.strictEqual(ctx.routes.subscriptionCount(), 0);
    // Depois do reset, a mesma cena é uma entrada nova — e deve ser.
    const r = ctx.routes.recompute([em(A, 0), em(B, 100)]);
    assert.strictEqual(r.diff.subscribe.length, 1);
  });
});

describe('voice-route-engine — cena com três pessoas', () => {
  it('cada ouvinte recebe só quem o alcança', () => {
    const ctx = montar();
    falante(ctx.state, ctx.policy, A, 'whisper');
    falante(ctx.state, ctx.policy, B, 'shout');
    ouvinte(ctx.state, C);

    // C está longe do sussurro de A e perto o bastante do grito de B.
    const longe = VOICE_RANGES.whisper + 200;
    const r = ctx.routes.recompute([em(A, 0), em(B, 10), em(C, longe)]);

    assert.deepStrictEqual([...r.routesByListener.get(C).keys()], [B], 'C só ouve quem grita');
    assert.ok(r.routesByListener.get(B).has(A), 'B está encostado em A e ouve o sussurro');
  });

  it('pairsExamined fica muito abaixo de n² numa cena espalhada', () => {
    const ctx = montar();
    const samples = [];
    for (let i = 0; i < 60; i++) {
      const id = 0x2000 + i;
      falante(ctx.state, ctx.policy, id, 'whisper');
      samples.push({ actorId: id, space: CELL, pos: [i * 5000, 0, 0] });
    }
    const r = ctx.routes.recompute(samples);
    // n² seria 3600. Com todo mundo isolado a 5000 unidades e sussurrando,
    // nenhum par sequer chega a ser avaliado além do próprio bucket.
    assert.ok(r.pairsExamined < 200, `pairsExamined=${r.pairsExamined}, esperava bem abaixo de 3600`);
    assert.strictEqual(r.routeCount, 0);
  });
});
