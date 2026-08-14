/**
 * core/voice/livekit-gateway.test.js
 *
 * A promessa deste módulo é negativa: **nunca rejeitar**. Quase todo caso aqui
 * é sobre uma falha que não vira exceção.
 *
 * Um teste de rejeição escrito com `assert.rejects` provaria o contrário do que
 * se quer. O padrão usado é `await` direto: se a promessa rejeitar, o próprio
 * caso quebra com a exceção original, que é exatamente o modo de falha que o
 * gamemode não pode ter.
 *
 * Executa com: node --test core/voice/livekit-gateway.test.js
 */

const assert = require('assert');
const { describe, it, beforeEach } = require('node:test');

const {
  createVoiceLiveKitGateway, GATEWAY_STATES, httpBaseFrom, DEFAULT_FAILURE_THRESHOLD
} = require('./livekit-gateway');
const { LOCAL_TRACK } = require('./voice-route-engine');

const CONFIGURADO = {
  LIVEKIT_URL: 'ws://127.0.0.1:7880',
  LIVEKIT_API_KEY: 'k',
  LIVEKIT_API_SECRET: 's'
};

const silencioso = { log: () => {}, warn: () => {}, error: () => {} };
const identityOf = (actorId) => `actor-${actorId}-aa`;

/** Gateway com fetch controlado pelo teste. */
function montar({ env = CONFIGURADO, responder, now = () => Date.now(), ...extra } = {}) {
  const chamadas = [];
  const gateway = createVoiceLiveKitGateway({
    env: () => env,
    now,
    logger: silencioso,
    mintAdminToken: () => 'token-de-operador',
    fetchImpl: async (url, init) => {
      chamadas.push({ url, body: JSON.parse(init.body) });
      return responder ? responder(chamadas.length) : { ok: true, status: 200 };
    },
    ...extra
  });
  return { gateway, chamadas };
}

const diff = (subscribe = [], unsubscribe = []) => ({
  subscribe: subscribe.map(([listener, speaker]) => ({ listener, speaker, track: LOCAL_TRACK })),
  unsubscribe: unsubscribe.map(([listener, speaker]) => ({ listener, speaker, track: LOCAL_TRACK }))
});

describe('livekit-gateway — a URL', () => {
  it('traduz o esquema WebSocket para HTTP em vez de pedir uma segunda variável', () => {
    assert.strictEqual(httpBaseFrom('ws://127.0.0.1:7880'), 'http://127.0.0.1:7880');
    assert.strictEqual(httpBaseFrom('wss://voz.exemplo.com'), 'https://voz.exemplo.com');
    assert.strictEqual(httpBaseFrom('wss://voz.exemplo.com/'), 'https://voz.exemplo.com');
    assert.strictEqual(httpBaseFrom(''), '');
    assert.strictEqual(httpBaseFrom(undefined), '');
  });
});

describe('livekit-gateway — nenhuma chamada redundante', () => {
  it('diff VAZIO não toca a rede', async () => {
    const { gateway, chamadas } = montar();
    const r = await gateway.applySubscriptionDiff(diff(), identityOf);

    assert.strictEqual(r.calls, 0);
    assert.strictEqual(r.skipped, true);
    assert.strictEqual(chamadas.length, 0, 'um tick sem mudança não pode gerar HTTP');
  });

  it('diff nulo também não toca a rede', async () => {
    const { gateway, chamadas } = montar();
    await gateway.applySubscriptionDiff(null, identityOf);
    assert.strictEqual(chamadas.length, 0);
  });

  it('agrupa por OUVINTE — dez faixas para a mesma pessoa é UMA chamada', async () => {
    const { gateway, chamadas } = montar();
    const arestas = [];
    for (let i = 0; i < 10; i++) arestas.push([100, 200 + i]);

    await gateway.applySubscriptionDiff(diff(arestas), identityOf);

    assert.strictEqual(chamadas.length, 1, 'dez faixas, uma ida à rede');
    assert.strictEqual(chamadas[0].body.identity, identityOf(100));
    assert.strictEqual(chamadas[0].body.participant_tracks.length, 10);
    assert.strictEqual(chamadas[0].body.subscribe, true);
  });

  it('assinar e desassinar para o mesmo ouvinte são duas chamadas, com o sinal certo', async () => {
    const { gateway, chamadas } = montar();
    await gateway.applySubscriptionDiff(diff([[1, 2]], [[1, 3]]), identityOf);

    assert.strictEqual(chamadas.length, 2);
    assert.strictEqual(chamadas[0].body.subscribe, true);
    assert.strictEqual(chamadas[1].body.subscribe, false);
  });

  it('ouvintes distintos viram chamadas distintas', async () => {
    const { gateway, chamadas } = montar();
    await gateway.applySubscriptionDiff(diff([[1, 9], [2, 9]]), identityOf);
    assert.strictEqual(chamadas.length, 2);
  });

  it('aresta cujo participante não tem identidade é ignorada, não quebra o lote', async () => {
    const { gateway, chamadas } = montar();
    const parcial = (actorId) => (actorId === 999 ? null : `actor-${actorId}-aa`);
    await gateway.applySubscriptionDiff(diff([[1, 999], [1, 2]]), parcial);

    assert.strictEqual(chamadas.length, 1);
    assert.deepStrictEqual(chamadas[0].body.participant_tracks, [{ participant_sid: 'actor-2-aa' }]);
  });
});

describe('livekit-gateway — o jogo não cai quando o SFU cai', () => {
  it('sem configuração: DISABLED, sem chamada, sem exceção', async () => {
    const { gateway, chamadas } = montar({ env: {} });
    const r = await gateway.applySubscriptionDiff(diff([[1, 2]]), identityOf);

    assert.strictEqual(r.ok, false);
    assert.strictEqual(chamadas.length, 0);
    assert.strictEqual(gateway.describe().state, GATEWAY_STATES.DISABLED);
    assert.strictEqual(gateway.describe().configured, false);
  });

  it('fetch que LANÇA vira estado, não exceção', async () => {
    const gateway = createVoiceLiveKitGateway({
      env: () => CONFIGURADO,
      logger: silencioso,
      mintAdminToken: () => 't',
      fetchImpl: async () => { throw new Error('ECONNREFUSED'); }
    });

    // Sem try/catch de propósito: se rejeitar, o caso quebra — que é o ponto.
    const r = await gateway.applySubscriptionDiff(diff([[1, 2]]), identityOf);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.failures, 1);
    assert.match(gateway.describe().lastError, /ECONNREFUSED/);
  });

  it('resposta HTTP de erro vira estado, não exceção', async () => {
    const { gateway } = montar({ responder: () => ({ ok: false, status: 503 }) });
    const r = await gateway.applySubscriptionDiff(diff([[1, 2]]), identityOf);
    assert.strictEqual(r.ok, false);
    assert.match(gateway.describe().lastError, /503/);
  });

  it('emissor de token de operador ausente: pula sem contar como falha de rede', async () => {
    const gateway = createVoiceLiveKitGateway({
      env: () => CONFIGURADO,
      logger: silencioso,
      mintAdminToken: null,
      fetchImpl: async () => ({ ok: true, status: 200 })
    });
    await gateway.applySubscriptionDiff(diff([[1, 2]]), identityOf);
    assert.strictEqual(gateway.describe().consecutiveFailures, 0,
      'configuração incompleta não pode parecer um SFU caindo');
  });

  it('removeParticipant e mutePublishedTrack também não rejeitam', async () => {
    const gateway = createVoiceLiveKitGateway({
      env: () => CONFIGURADO,
      logger: silencioso,
      mintAdminToken: () => 't',
      fetchImpl: async () => { throw new Error('rede morreu'); }
    });

    assert.strictEqual((await gateway.removeParticipant('actor-1-aa')).ok, false);
    assert.strictEqual((await gateway.mutePublishedTrack('actor-1-aa', 'TR_x', true)).ok, false);
    assert.strictEqual((await gateway.removeParticipant('')).skipped, true);
  });
});

describe('livekit-gateway — circuito', () => {
  let relogio;
  beforeEach(() => { relogio = 1_000_000; });
  const now = () => relogio;

  it(`abre depois de ${DEFAULT_FAILURE_THRESHOLD} falhas seguidas e para de tentar`, async () => {
    const { gateway, chamadas } = montar({ now, responder: () => ({ ok: false, status: 500 }) });

    for (let i = 0; i < DEFAULT_FAILURE_THRESHOLD; i++) {
      await gateway.applySubscriptionDiff(diff([[1, 2]]), identityOf);
    }
    assert.strictEqual(gateway.describe().state, GATEWAY_STATES.FAILED);

    const antes = chamadas.length;
    for (let i = 0; i < 10; i++) {
      await gateway.applySubscriptionDiff(diff([[1, 2]]), identityOf);
    }
    assert.strictEqual(chamadas.length, antes,
      'com o circuito aberto, dez ticks não podem virar dez tentativas de HTTP');
  });

  it('meia-abertura depois do cooldown: UMA tentativa, e fecha de novo se falhar', async () => {
    const cooldownMs = 15000;
    const { gateway, chamadas } = montar({ now, cooldownMs, responder: () => ({ ok: false, status: 500 }) });

    for (let i = 0; i < DEFAULT_FAILURE_THRESHOLD; i++) {
      await gateway.applySubscriptionDiff(diff([[1, 2]]), identityOf);
    }
    const aposAbrir = chamadas.length;

    relogio += cooldownMs + 1;
    await gateway.applySubscriptionDiff(diff([[1, 2]]), identityOf);
    assert.strictEqual(chamadas.length, aposAbrir + 1, 'exatamente uma tentativa de sondagem');

    await gateway.applySubscriptionDiff(diff([[1, 2]]), identityOf);
    assert.strictEqual(chamadas.length, aposAbrir + 1, 'a sondagem falhou; o circuito fecha de novo');
  });

  it('uma resposta boa depois do cooldown volta para CONNECTED e zera as falhas', async () => {
    const cooldownMs = 15000;
    let falhando = true;
    const { gateway } = montar({
      now, cooldownMs,
      responder: () => (falhando ? { ok: false, status: 500 } : { ok: true, status: 200 })
    });

    for (let i = 0; i < DEFAULT_FAILURE_THRESHOLD; i++) {
      await gateway.applySubscriptionDiff(diff([[1, 2]]), identityOf);
    }
    assert.strictEqual(gateway.describe().state, GATEWAY_STATES.FAILED);

    falhando = false;
    relogio += cooldownMs + 1;
    const r = await gateway.applySubscriptionDiff(diff([[1, 2]]), identityOf);

    assert.strictEqual(r.ok, true);
    assert.strictEqual(gateway.describe().state, GATEWAY_STATES.CONNECTED);
    assert.strictEqual(gateway.describe().consecutiveFailures, 0);
  });

  it('sucesso intercalado impede o circuito de abrir', async () => {
    let n = 0;
    const { gateway } = montar({ now, responder: () => ({ ok: (++n % 2 === 0), status: 500 }) });
    for (let i = 0; i < 12; i++) {
      await gateway.applySubscriptionDiff(diff([[1, 2]]), identityOf);
    }
    assert.notStrictEqual(gateway.describe().state, GATEWAY_STATES.FAILED);
  });
});
