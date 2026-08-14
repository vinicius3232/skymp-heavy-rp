/**
 * core/voice/voice-route-engine.js
 *
 * VoiceRouteEngine — quem ouve quem, a que volume, e **o que mudou desde a
 * última vez**.
 *
 * ## As duas saídas, e por que são duas
 *
 * Um recompute produz coisas diferentes para dois consumidores diferentes:
 *
 *   - **`routesByListener`** — o mapa completo de volume por ouvinte. É o que
 *     vira `proximity_update` no fio e ajusta o ganho. Estado inteiro, sempre.
 *   - **`diff`** — só as entradas e saídas de alcance. É o que vira
 *     `subscribe`/`unsubscribe` no LiveKit.
 *
 * A distinção não é estética. **Volume muda o tempo todo** — cada passo que
 * alguém dá muda o ganho de todo mundo por perto. **Assinatura quase nunca
 * muda** — só quando alguém cruza a borda do alcance. Se as duas viajassem pelo
 * mesmo caminho, cada passo viraria uma chamada de API ao SFU, e a instrução
 * de não fazer chamada redundante seria quebrada cinquenta vezes por segundo
 * por pessoa andando.
 *
 * Então: volume vai no payload (barato, já existe um por tick), assinatura vai
 * no diff (cara, só na borda). O cache que torna isso possível é o
 * `_subscriptions` abaixo.
 *
 * ## O que é uma "rota"
 *
 * Uma aresta dirigida `locutor → ouvinte` com um volume. É dirigida porque a
 * relação não é simétrica: o alcance vem do modo de voz **de quem fala**. Se A
 * grita e B sussurra, A alcança B sem que B alcance A — e é assim que tem que
 * ser, senão gritar faria o outro gritar de volta.
 *
 * ## Uma faixa lógica, `voice.local`
 *
 * Toda rota deste motor é da faixa `voice.local`. Não existe segunda faixa, e
 * o campo existe para que o consumidor do diff nomeie o que assina sem
 * inventar a string em três lugares. **Não há sistema de rádio neste projeto**
 * — nem frequência, nem canal, nem faixa alternativa —, e este comentário está
 * aqui para que a constante abaixo não seja lida como um começo de um.
 */

const { nullMetrics } = require('./voice-metrics');
const { directionFor, quantizeDirection } = require('./voice-spatial');
const { VOICE_EFFECTS } = require('./voice-conditions');

/** A única faixa lógica de voz que existe. Ver o cabeçalho. */
const LOCAL_TRACK = 'voice.local';

/**
 * @typedef {object} VoiceRoute
 * @property {number} speaker
 * @property {number} listener
 * @property {number} volume
 * @property {number} distance
 * @property {string} effect
 * @property {[number, number, number]} dir  direção da fonte no referencial do ouvinte
 */

/**
 * @param {object} deps
 * @param {ReturnType<typeof import('./voice-state').createVoiceStateService>} deps.state
 * @param {ReturnType<typeof import('./voice-policy').createVoicePolicyEngine>} deps.policy
 * @param {ReturnType<typeof import('./voice-spatial-index').createVoiceSpatialIndex>} deps.index
 * @param {ReturnType<typeof import('./voice-metrics').createVoiceMetrics>} [deps.metrics]
 * @param {boolean} [deps.spatial] calcular direção por rota. Padrão: ligado.
 */
function createVoiceRouteEngine(deps) {
  const { state, policy, index, metrics = nullMetrics(), spatial = true } = deps || {};
  if (!state || !policy || !index) throw new Error('[voice-route-engine] dependências ausentes (state, policy, index)');

  /**
   * Assinaturas em vigor: ouvinte → conjunto de locutores que ele recebe.
   *
   * Este `Map` é a memória que evita a chamada redundante. Sem ele, "assine A
   * em B" seria emitido a cada tick enquanto A estivesse perto de B — dez vezes
   * por segundo, para dizer o que já era verdade.
   *
   * @type {Map<number, Set<number>>}
   */
  let _subscriptions = new Map();

  let _lastRecomputeAt = 0;

  /**
   * Recalcula todas as rotas a partir das amostras do servidor.
   *
   * As amostras vêm prontas de quem leu o `mp` — este motor **não lê posição**.
   * É a fronteira que garante que nada aqui possa ser influenciado pelo
   * cliente: o que entra já foi medido pelo servidor.
   *
   * @param {import('./voice-spatial-index').VoiceSample[]} samples
   * @param {{at?: number}} [opts]
   */
  function recompute(samples, opts = {}) {
    const done = metrics.timer('route.recompute');
    metrics.count('route.recompute');

    index.rebuild(samples);

    // Abre o ciclo: dentro dele o perfil de condição de cada ator (morto,
    // amordaçado, silenciado) é resolvido UMA vez, não uma por par. Fechado no
    // `finally` para que uma exceção no meio do recompute não deixe o cache
    // aberto — um cache de condição que sobrevive ao ciclo é um cadáver
    // terminando a frase no ciclo seguinte.
    if (typeof policy.beginCycle === 'function') policy.beginCycle();
    try {
      return recomputeInCycle(samples, opts, done);
    } finally {
      if (typeof policy.endCycle === 'function') policy.endCycle();
    }
  }

  /** @param {import('./voice-spatial-index').VoiceSample[]} samples */
  function recomputeInCycle(samples, opts, done) {
    /** @type {Map<number, {actorId: number, volume: number, distance: number, effect: string}[]>} */
    const audienceBySpeaker = new Map();
    /** @type {Map<number, Map<number, {volume: number, effect: string, dir: number[]}>>} */
    const routesByListener = new Map();
    /** @type {Map<number, Set<number>>} */
    const nextSubscriptions = new Map();
    let routeCount = 0;
    let pairsExamined = 0;

    for (const speaker of samples) {
      if (!speaker) continue;

      // Filtro barato antes do caro, e ele é o mesmo que prepara o resto:
      // `audienceProbe` devolve `null` para quem não pode falar — mutado, com o
      // PTT solto, desconectado — e essas pessoas saem do custo por completo.
      // É por isso que o PTT BARATEIA o tick em vez de encarecê-lo: só quem
      // está de fato falando chega a consultar o índice.
      const probe = policy.audienceProbe(speaker);
      if (!probe) continue;

      // `forEachWithin` e não `queryWithin`: numa cena densa a lista de
      // candidatos é quase o servidor inteiro, e materializá-la por locutor
      // seria uma alocação por locutor por tick, sem nada em troca. Ver o
      // comentário em `voice-spatial-index.forEachWithin`.
      index.forEachWithin(speaker, probe.range, (listener) => {
        if (listener.actorId === speaker.actorId) return;
        pairsExamined++;

        const volume = probe(listener);
        if (volume <= 0) return;
        const distance = probe.distance;
        // Lido IMEDIATAMENTE depois da chamada, como `.distance`: os dois são
        // campos mutáveis do closure e valem para o último par avaliado.
        const effect = probe.effect;

        let audience = audienceBySpeaker.get(speaker.actorId);
        if (!audience) {
          audience = [];
          audienceBySpeaker.set(speaker.actorId, audience);
        }
        audience.push({ actorId: listener.actorId, volume, distance, effect });

        let routes = routesByListener.get(listener.actorId);
        if (!routes) {
          routes = new Map();
          routesByListener.set(listener.actorId, routes);
        }
        // A direção é calculada por ROTA, não por par candidato: só quem de
        // fato ouve alguém paga o seno e o cosseno. Numa cena espalhada isso é
        // a diferença entre 149 contas e 39.800.
        routes.set(speaker.actorId, {
          volume,
          effect,
          dir: spatial
            ? quantizeDirection(directionFor(listener.pos, listener.rot, speaker.pos))
            : null
        });

        let subs = nextSubscriptions.get(listener.actorId);
        if (!subs) {
          subs = new Set();
          nextSubscriptions.set(listener.actorId, subs);
        }
        subs.add(speaker.actorId);
        routeCount++;
      });
    }

    const diff = diffSubscriptions(_subscriptions, nextSubscriptions);
    _subscriptions = nextSubscriptions;
    _lastRecomputeAt = opts.at ?? Date.now();

    const durationMs = done();
    metrics.observe('route.pairs', pairsExamined);
    metrics.observe('route.routes', routeCount);
    metrics.count('route.subscribe', diff.subscribe.length);
    metrics.count('route.unsubscribe', diff.unsubscribe.length);
    if (diff.subscribe.length === 0 && diff.unsubscribe.length === 0) {
      // Um tick sem mudança de assinatura é o caso comum, e é exatamente o que
      // não deve virar chamada nenhuma ao SFU. Contá-lo é como se prova isso.
      metrics.count('route.noSubscriptionChange');
    }

    return {
      audienceBySpeaker,
      routesByListener,
      diff,
      routeCount,
      pairsExamined,
      durationMs,
      at: _lastRecomputeAt
    };
  }

  /**
   * Compara dois mapas de assinatura e devolve só a diferença.
   *
   * @param {Map<number, Set<number>>} before
   * @param {Map<number, Set<number>>} after
   */
  function diffSubscriptions(before, after) {
    /** @type {{listener: number, speaker: number, track: string}[]} */
    const subscribe = [];
    /** @type {{listener: number, speaker: number, track: string}[]} */
    const unsubscribe = [];

    for (const [listener, speakers] of after) {
      const previous = before.get(listener);
      for (const speaker of speakers) {
        if (!previous || !previous.has(speaker)) {
          subscribe.push({ listener, speaker, track: LOCAL_TRACK });
        }
      }
    }

    for (const [listener, speakers] of before) {
      const current = after.get(listener);
      for (const speaker of speakers) {
        if (!current || !current.has(speaker)) {
          unsubscribe.push({ listener, speaker, track: LOCAL_TRACK });
        }
      }
    }

    return { subscribe, unsubscribe };
  }

  /**
   * Esquece um ator sem gerar comandos de unsubscribe.
   *
   * Chamado quando a sessão morre (logout, disconnect, cleanup). É diferente de
   * a pessoa sair de alcance: um participante que **não está mais na sala** não
   * precisa ser desassinado — as assinaturas dele morreram junto, e mandá-las
   * seria a chamada redundante que o cache existe para evitar, com o agravante
   * de citar uma identidade que não existe mais.
   *
   * @param {number} actorId
   */
  function forget(actorId) {
    let removed = _subscriptions.delete(actorId) ? 1 : 0;
    for (const speakers of _subscriptions.values()) {
      if (speakers.delete(actorId)) removed++;
    }
    if (removed > 0) metrics.count('route.forget');
    return removed;
  }

  /** Assinaturas em vigor para um ouvinte. Leitura, para diagnóstico e teste. */
  function subscriptionsOf(listenerActorId) {
    const subs = _subscriptions.get(listenerActorId);
    return subs ? [...subs] : [];
  }

  /** Total de arestas assinadas agora. */
  function subscriptionCount() {
    let n = 0;
    for (const speakers of _subscriptions.values()) n += speakers.size;
    return n;
  }

  function reset() {
    _subscriptions = new Map();
    _lastRecomputeAt = 0;
  }

  return {
    recompute, forget, subscriptionsOf, subscriptionCount, reset,
    get lastRecomputeAt() { return _lastRecomputeAt; }
  };
}

module.exports = { createVoiceRouteEngine, LOCAL_TRACK };
