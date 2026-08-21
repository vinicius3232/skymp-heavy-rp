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
/** O SFU atribui o track SID; aqui ele é determinístico para o teste poder afirmar. */
const trackSidOf = (actorId) => `TR_${actorId}`;

/**
 * `ListParticipants` como o `livekit-server` 1.13.5 realmente responde — a forma
 * foi copiada de um dump do servidor real, não inventada. Se ela divergir do
 * servidor, o registro de faixas para de resolver e o gateway para de assinar,
 * que é o defeito que o SV-05 era.
 */
function participantes(actorIds) {
  return {
    participants: actorIds.map((actorId) => ({
      sid: `PA_${actorId}`,
      identity: identityOf(actorId),
      state: 'ACTIVE',
      tracks: [{ sid: trackSidOf(actorId), type: 'AUDIO', source: 'MICROPHONE', muted: false }]
    }))
  };
}

/**
 * Gateway com fetch controlado pelo teste.
 *
 * `povoar` são os atores que o SFU vai dizer que existem. O padrão cobre a faixa
 * usada pelos casos; um teste que precise de registro vazio passa `[]`.
 */
function montar({ env = CONFIGURADO, responder, now = () => Date.now(), povoar, ...extra } = {}) {
  const chamadas = [];
  const presentes = povoar === undefined
    ? Array.from({ length: 400 }, (_, i) => i)
    : povoar;

  const gateway = createVoiceLiveKitGateway({
    env: () => env,
    now,
    logger: silencioso,
    mintAdminToken: () => 'token-de-operador',
    fetchImpl: async (url, init) => {
      chamadas.push({ url, body: JSON.parse(init.body) });
      const resposta = responder ? responder(chamadas.length) : { ok: true, status: 200 };
      if (resposta.ok && String(url).endsWith('/ListParticipants')) {
        return { ...resposta, json: async () => participantes(presentes) };
      }
      return resposta;
    },
    ...extra
  });
  return { gateway, chamadas };
}

/** As chamadas de assinatura, sem o ruído das recargas de registro. */
const assinaturas = (chamadas) => chamadas.filter((c) => String(c.url).endsWith('/UpdateSubscriptions'));

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

    const subs = assinaturas(chamadas);
    assert.strictEqual(subs.length, 1, 'dez faixas, uma ida à rede');
    assert.strictEqual(subs[0].body.identity, identityOf(100));
    assert.strictEqual(subs[0].body.track_sids.length, 10);
    assert.strictEqual(subs[0].body.subscribe, true);
  });

  it('assinar e desassinar para o mesmo ouvinte são duas chamadas, com o sinal certo', async () => {
    const { gateway, chamadas } = montar();
    await gateway.applySubscriptionDiff(diff([[1, 2]], [[1, 3]]), identityOf);

    const subs = assinaturas(chamadas);
    assert.strictEqual(subs.length, 2);
    assert.strictEqual(subs[0].body.subscribe, true);
    assert.strictEqual(subs[1].body.subscribe, false);
  });

  it('ouvintes distintos viram chamadas distintas', async () => {
    const { gateway, chamadas } = montar();
    await gateway.applySubscriptionDiff(diff([[1, 9], [2, 9]]), identityOf);
    assert.strictEqual(assinaturas(chamadas).length, 2);
  });

  it('aresta cujo participante não tem identidade é ignorada, não quebra o lote', async () => {
    const { gateway, chamadas } = montar();
    const parcial = (actorId) => (actorId === 999 ? null : `actor-${actorId}-aa`);
    await gateway.applySubscriptionDiff(diff([[1, 999], [1, 2]]), parcial);

    const subs = assinaturas(chamadas);
    assert.strictEqual(subs.length, 1);
    assert.deepStrictEqual(subs[0].body.track_sids, [trackSidOf(2)]);
  });
});

/**
 * O SV-05 em forma de teste.
 *
 * O corpo antigo — `participant_tracks:[{participant_sid: identity}]` — recebia
 * **HTTP 200 do SFU real e não assinava nada**. Não havia como o teste anterior
 * pegar isso: ele afirmava o corpo que o código montava, e o código montava o
 * corpo errado. Estes casos travam a forma que foi MEDIDA contra o
 * `livekit-server` 1.13.5, e o teste de ponta a ponta que a mediu está em
 * `scripts/verify-livekit-contract.mjs`.
 */
describe('livekit-gateway — SV-05: o corpo que o SFU real obedece', () => {
  it('manda track_sids, e NUNCA participant_tracks com identity', async () => {
    const { gateway, chamadas } = montar();
    await gateway.applySubscriptionDiff(diff([[1, 2]]), identityOf);

    const corpo = assinaturas(chamadas)[0].body;
    assert.deepStrictEqual(corpo.track_sids, [trackSidOf(2)]);
    assert.strictEqual(corpo.participant_tracks, undefined,
      'participant_tracks com identity devolve 200 e não assina — o pior modo de falha possível');
    assert.strictEqual(corpo.identity, identityOf(1), 'identity é do OUVINTE, não do locutor');
  });

  it('identidade desconhecida provoca UMA recarga do registro, não uma por aresta', async () => {
    const { gateway, chamadas } = montar();
    await gateway.applySubscriptionDiff(diff([[1, 2], [1, 3], [1, 4]]), identityOf);

    const recargas = chamadas.filter((c) => String(c.url).endsWith('/ListParticipants'));
    assert.strictEqual(recargas.length, 1);
    assert.strictEqual(gateway.describe().trackRegistryRefreshes, 1);
  });

  it('registro quente não recarrega — o tick normal não paga ListParticipants', async () => {
    const { gateway, chamadas } = montar();
    await gateway.applySubscriptionDiff(diff([[1, 2]]), identityOf);
    const aposPrimeiro = chamadas.filter((c) => String(c.url).endsWith('/ListParticipants')).length;

    await gateway.applySubscriptionDiff(diff([[5, 2]]), identityOf);
    const aposSegundo = chamadas.filter((c) => String(c.url).endsWith('/ListParticipants')).length;

    assert.strictEqual(aposSegundo, aposPrimeiro, 'a segunda vez já sabe o track SID');
  });

  it('locutor que o SFU não conhece não vira chamada — e é contado', async () => {
    const { gateway, chamadas } = montar({ povoar: [] });
    const r = await gateway.applySubscriptionDiff(diff([[1, 2]]), identityOf);

    assert.strictEqual(assinaturas(chamadas).length, 0,
      'assinar uma faixa que não existe é uma ida à rede para receber erro');
    assert.strictEqual(r.unresolved, 1);
  });

  it('desassinar NÃO recarrega o registro', async () => {
    const { gateway, chamadas } = montar({ povoar: [] });
    await gateway.applySubscriptionDiff(diff([], [[1, 2]]), identityOf);

    assert.strictEqual(chamadas.length, 0,
      'quem sumiu do registro já não tem assinatura no SFU; recarregar por ele é ida à rede à toa');
  });

  it('só faixa de microfone entra no registro', async () => {
    const { gateway } = montar({ povoar: [] });
    const gatewayComVideo = createVoiceLiveKitGateway({
      env: () => CONFIGURADO,
      logger: silencioso,
      mintAdminToken: () => 't',
      fetchImpl: async () => ({
        ok: true, status: 200,
        json: async () => ({
          participants: [{
            identity: 'actor-9-aa',
            tracks: [
              { sid: 'TR_cam', type: 'VIDEO', source: 'CAMERA' },
              { sid: 'TR_tela', type: 'VIDEO', source: 'SCREEN_SHARE' },
              { sid: 'TR_mic', type: 'AUDIO', source: 'MICROPHONE' }
            ]
          }]
        })
      })
    });

    await gatewayComVideo.refreshTrackRegistry();
    assert.deepStrictEqual(gatewayComVideo.trackSidsFor('actor-9-aa'), ['TR_mic']);
    assert.strictEqual(gateway.trackSidsFor('inexistente'), null);
  });

  it('removeParticipant esquece as faixas — senão a volta da pessoa não recarrega', async () => {
    const { gateway } = montar();
    await gateway.applySubscriptionDiff(diff([[1, 2]]), identityOf);
    assert.notStrictEqual(gateway.trackSidsFor(identityOf(2)), null);

    await gateway.removeParticipant(identityOf(2));
    assert.strictEqual(gateway.trackSidsFor(identityOf(2)), null);
  });

  it('ListParticipants que falha não derruba nada e preserva o registro anterior', async () => {
    let vivo = true;
    const gateway = createVoiceLiveKitGateway({
      env: () => CONFIGURADO,
      logger: silencioso,
      mintAdminToken: () => 't',
      fetchImpl: async (url) => {
        if (!vivo) throw new Error('SFU fora');
        if (String(url).endsWith('/ListParticipants')) {
          return { ok: true, status: 200, json: async () => participantes([2]) };
        }
        return { ok: true, status: 200 };
      }
    });

    await gateway.applySubscriptionDiff(diff([[1, 2]]), identityOf);
    assert.deepStrictEqual(gateway.trackSidsFor(identityOf(2)), [trackSidOf(2)]);

    vivo = false;
    // Sem try/catch: se rejeitar, o caso quebra — que é o ponto do módulo.
    const r = await gateway.refreshTrackRegistry();
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(gateway.trackSidsFor(identityOf(2)), [trackSidOf(2)],
      'perder o registro por uma falha de rede faria a voz sumir por um timeout');
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
    // Com o SFU fora, quem morre primeiro é a recarga do registro — antes de
    // qualquer `UpdateSubscriptions` sair. `failures` fica em 0 porque nenhuma
    // assinatura chegou a ser tentada, e é `refreshFailed` que carrega a
    // verdade. Um `ok: true` aqui seria o gateway relatando sucesso no tick em
    // que parou de rotear voz.
    assert.strictEqual(r.refreshFailed, true);
    assert.strictEqual(r.calls, 0);
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
