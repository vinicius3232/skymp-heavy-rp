/**
 * core/voice/livekit-gateway.js
 *
 * VoiceLiveKitGateway — a única porta por onde o gamemode fala com o SFU.
 *
 * ## A promessa deste arquivo
 *
 * **Se o LiveKit cair, o VOIP pode falhar. O jogo não pode.**
 *
 * Toda função pública daqui é `async` e **nunca rejeita**. Não é descuido com
 * erro: é o contrato. Quem chama é o laço de proximidade, que roda a cada
 * ~150 ms dentro do processo do gamemode; uma rejeição não tratada ali é um
 * `unhandledRejection`, e um `unhandledRejection` derruba o servidor de jogo
 * inteiro por causa de um SFU que não respondeu. O erro vira estado
 * (`FAILED`), contador e log — nunca exceção subindo.
 *
 * ## Por que ele não importa SDK nenhum
 *
 * O `livekit-server-sdk` não entra aqui pelo mesmo motivo que não entrou no
 * `livekit-token.js`: o gamemode roda no Node embutido pelo SkyMP, e cada
 * dependência nova é uma a auditar, empacotar e atualizar. O transporte HTTP é
 * injetado (`fetchImpl`), com `globalThis.fetch` como padrão — que existe no
 * Node moderno e não custa nada.
 *
 * A consequência honesta: **a serialização do corpo das chamadas de sala do
 * LiveKit (Twirp/protobuf-JSON) não foi verificada contra um servidor real
 * nesta etapa.** O que está travado por teste é o comportamento que o gamemode
 * depende — não chamar quando não mudou nada, não derrubar o jogo quando falha,
 * abrir o circuito depois de N falhas. Ver §"Estado de prova" no documento da
 * etapa.
 *
 * ## Circuito, e por que ele existe
 *
 * Sem circuito, um SFU fora do ar vira uma tentativa de HTTP a cada tick — dez
 * por segundo, cada uma esperando um timeout, dentro do processo que também
 * precisa mover NPCs. O circuito abre depois de `failureThreshold` falhas
 * seguidas e só volta a tentar depois de `cooldownMs`. Enquanto aberto, as
 * chamadas retornam `{ok: false, skipped: true}` imediatamente e de graça.
 *
 * O jogo, nesse período, continua exatamente igual: a proximidade é calculada,
 * o `proximity_update` continua saindo, o ganho continua correto. O que para é
 * a otimização de banda, não a regra.
 */

const { nullMetrics } = require('./voice-metrics');
const { resolveLiveKitConfig } = require('./voice-session');

/** Estados do gateway. Espelham os de sessão de propósito — é o mesmo vocabulário. */
const GATEWAY_STATES = Object.freeze({
  DISABLED: 'DISABLED',
  CONNECTING: 'CONNECTING',
  CONNECTED: 'CONNECTED',
  RECONNECTING: 'RECONNECTING',
  FAILED: 'FAILED'
});

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 15000;
const DEFAULT_TIMEOUT_MS = 2000;

/**
 * URL HTTP da API de sala, derivada da `LIVEKIT_URL` (que é `ws://`/`wss://`).
 *
 * A mesma origem serve WebSocket e HTTP no `livekit-server`; o cliente usa o
 * esquema `ws`, a API de servidor usa `http`. Traduzir aqui evita uma segunda
 * variável de ambiente que teria que ser mantida coerente com a primeira à mão
 * — e duas configurações que precisam concordar é uma que vai divergir.
 *
 * @param {string} wsUrl
 */
function httpBaseFrom(wsUrl) {
  if (typeof wsUrl !== 'string' || wsUrl === '') return '';
  return wsUrl.replace(/^ws:/i, 'http:').replace(/^wss:/i, 'https:').replace(/\/+$/, '');
}

/**
 * @param {object} [deps]
 * @param {() => NodeJS.ProcessEnv} [deps.env]
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {(opts: object) => string} [deps.mintAdminToken] emissor do token de operador
 * @param {ReturnType<typeof import('./voice-metrics').createVoiceMetrics>} [deps.metrics]
 * @param {Pick<Console,'log'|'warn'|'error'>} [deps.logger]
 * @param {() => number} [deps.now]
 * @param {number} [deps.failureThreshold]
 * @param {number} [deps.cooldownMs]
 * @param {number} [deps.timeoutMs]
 */
function createVoiceLiveKitGateway(deps = {}) {
  const {
    env = () => process.env,
    fetchImpl = (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null),
    mintAdminToken = null,
    metrics = nullMetrics(),
    logger = console,
    now = () => Date.now(),
    failureThreshold = DEFAULT_FAILURE_THRESHOLD,
    cooldownMs = DEFAULT_COOLDOWN_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS
  } = deps;

  /** @type {string} */
  let _state = GATEWAY_STATES.DISABLED;
  let _consecutiveFailures = 0;
  let _openedAt = 0;
  let _lastError = null;

  /** O circuito está aberto (recusando chamadas) neste instante? */
  function circuitOpen() {
    if (_state !== GATEWAY_STATES.FAILED) return false;
    if (now() - _openedAt >= cooldownMs) {
      // Meia-abertura: deixa UMA chamada passar para descobrir se voltou. Se
      // falhar, `_openedAt` é reiniciado e o circuito fecha de novo por mais um
      // cooldown — sem uma enxurrada de tentativas no meio.
      _state = GATEWAY_STATES.RECONNECTING;
      metrics.count('gateway.halfOpen');
      return false;
    }
    return true;
  }

  function _onSuccess() {
    _consecutiveFailures = 0;
    _lastError = null;
    if (_state !== GATEWAY_STATES.CONNECTED) {
      _state = GATEWAY_STATES.CONNECTED;
      metrics.count('gateway.connected');
    }
  }

  function _onFailure(err) {
    _consecutiveFailures++;
    _lastError = err && err.message ? err.message : String(err);
    metrics.count('gateway.failure');
    if (_consecutiveFailures >= failureThreshold) {
      if (_state !== GATEWAY_STATES.FAILED) {
        logger.warn(
          `[voice-gateway] ${_consecutiveFailures} falhas seguidas (${_lastError}); ` +
          `circuito aberto por ${cooldownMs} ms. A voz degrada; o jogo segue.`
        );
        metrics.count('gateway.circuitOpen');
      }
      _state = GATEWAY_STATES.FAILED;
      _openedAt = now();
    } else {
      _state = GATEWAY_STATES.RECONNECTING;
    }
  }

  /**
   * Chamada crua à API de sala. Nunca rejeita — devolve `{ok, ...}`.
   *
   * @param {string} method nome do método Twirp (`UpdateSubscriptions`, ...)
   * @param {object} body
   */
  async function _call(method, body) {
    const config = resolveLiveKitConfig(env());
    if (!config.configured) {
      _state = GATEWAY_STATES.DISABLED;
      return { ok: false, skipped: true, reason: 'LiveKit não configurado' };
    }
    if (!fetchImpl) {
      _state = GATEWAY_STATES.DISABLED;
      return { ok: false, skipped: true, reason: 'sem implementação de fetch' };
    }
    if (circuitOpen()) {
      metrics.count('gateway.skippedByCircuit');
      return { ok: false, skipped: true, reason: 'circuito aberto' };
    }
    if (typeof mintAdminToken !== 'function') {
      // Sem emissor de token de operador não há como autenticar a chamada de
      // servidor. É configuração faltando, não falha de rede — não conta para
      // o circuito, senão uma instalação incompleta pareceria um SFU caindo.
      return { ok: false, skipped: true, reason: 'sem emissor de token de operador' };
    }

    const base = httpBaseFrom(config.url);
    const done = metrics.timer('gateway.call');
    try {
      const token = mintAdminToken({
        apiKey: config.apiKey,
        apiSecret: config.apiSecret,
        room: config.room
      });

      // `AbortSignal.timeout` em vez de esperar o timeout padrão do SO: uma
      // chamada pendurada por 30 s dentro do laço de proximidade é o mesmo
      // problema que o circuito resolve, só que sem o circuito perceber.
      const response = await fetchImpl(`${base}/twirp/livekit.RoomService/${method}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify(body),
        signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout
          ? AbortSignal.timeout(timeoutMs)
          : undefined
      });

      if (!response || response.ok !== true) {
        const status = response ? response.status : 'sem resposta';
        throw new Error(`${method} respondeu ${status}`);
      }

      _onSuccess();
      done();
      metrics.count('gateway.ok');
      return { ok: true, skipped: false };
    } catch (err) {
      done();
      _onFailure(err);
      return { ok: false, skipped: false, reason: _lastError };
    }
  }

  /**
   * Aplica o diff de assinaturas produzido pelo `VoiceRouteEngine`.
   *
   * **Diff vazio não vira chamada.** É a linha que cumpre "não realizar chamadas
   * redundantes": num tick em que ninguém cruzou a borda de alcance — que é a
   * esmagadora maioria deles — este método retorna sem tocar na rede.
   *
   * @param {{subscribe: {listener:number,speaker:number,track:string}[], unsubscribe: {listener:number,speaker:number,track:string}[]}} diff
   * @param {(actorId: number) => string|null} identityOf tradutor actorId → identity
   */
  async function applySubscriptionDiff(diff, identityOf) {
    if (!diff || (diff.subscribe.length === 0 && diff.unsubscribe.length === 0)) {
      metrics.count('gateway.noop');
      return { ok: true, calls: 0, skipped: true };
    }

    // Agrupado por OUVINTE porque `UpdateSubscriptions` é por participante: uma
    // chamada com dez faixas custa uma ida à rede; dez chamadas com uma faixa
    // custam dez. O agrupamento é a diferença entre um tick que faz uma chamada
    // e um que faz uma por pessoa que se mexeu.
    /** @type {Map<number, {subscribe: string[], unsubscribe: string[]}>} */
    const byListener = new Map();
    const bucketFor = (listener) => {
      let bucket = byListener.get(listener);
      if (!bucket) {
        bucket = { subscribe: [], unsubscribe: [] };
        byListener.set(listener, bucket);
      }
      return bucket;
    };

    for (const edge of diff.subscribe) {
      const identity = identityOf(edge.speaker);
      if (identity) bucketFor(edge.listener).subscribe.push(identity);
    }
    for (const edge of diff.unsubscribe) {
      const identity = identityOf(edge.speaker);
      if (identity) bucketFor(edge.listener).unsubscribe.push(identity);
    }

    let calls = 0;
    let failures = 0;
    for (const [listener, bucket] of byListener) {
      const listenerIdentity = identityOf(listener);
      if (!listenerIdentity) continue;

      if (bucket.subscribe.length > 0) {
        calls++;
        const result = await _call('UpdateSubscriptions', {
          room: resolveLiveKitConfig(env()).room,
          identity: listenerIdentity,
          participant_tracks: bucket.subscribe.map((identity) => ({ participant_sid: identity })),
          subscribe: true
        });
        if (!result.ok) failures++;
      }
      if (bucket.unsubscribe.length > 0) {
        calls++;
        const result = await _call('UpdateSubscriptions', {
          room: resolveLiveKitConfig(env()).room,
          identity: listenerIdentity,
          participant_tracks: bucket.unsubscribe.map((identity) => ({ participant_sid: identity })),
          subscribe: false
        });
        if (!result.ok) failures++;
      }
    }

    metrics.count('gateway.subscriptionCalls', calls);
    return { ok: failures === 0, calls, failures, skipped: false };
  }

  /**
   * Remove um participante da sala. Usado no despejo de sessão superada e no
   * cleanup de logout.
   * @param {string} identity
   */
  async function removeParticipant(identity) {
    if (!identity) return { ok: false, skipped: true, reason: 'identidade ausente' };
    const result = await _call('RemoveParticipant', {
      room: resolveLiveKitConfig(env()).room,
      identity
    });
    if (result.ok) metrics.count('gateway.removeParticipant');
    return result;
  }

  /**
   * Silencia à força a faixa de um participante.
   *
   * Existe porque mute de gameplay não pode depender do cliente obedecer: se o
   * servidor decidiu que alguém não fala, a última palavra é do SFU. Hoje o
   * corte primário é a rota (o `VoiceRouteEngine` não dá audiência a quem não
   * pode falar), e isto é a segunda camada.
   *
   * @param {string} identity
   * @param {string} trackSid
   * @param {boolean} muted
   */
  async function mutePublishedTrack(identity, trackSid, muted) {
    return _call('MutePublishedTrack', {
      room: resolveLiveKitConfig(env()).room,
      identity,
      track_sid: trackSid,
      muted: muted === true
    });
  }

  function describe() {
    const config = resolveLiveKitConfig(env());
    return {
      state: config.configured ? _state : GATEWAY_STATES.DISABLED,
      configured: config.configured,
      missing: config.missing,
      consecutiveFailures: _consecutiveFailures,
      lastError: _lastError,
      circuitOpenUntil: _state === GATEWAY_STATES.FAILED ? _openedAt + cooldownMs : 0
    };
  }

  function reset() {
    _state = GATEWAY_STATES.DISABLED;
    _consecutiveFailures = 0;
    _openedAt = 0;
    _lastError = null;
  }

  return {
    applySubscriptionDiff, removeParticipant, mutePublishedTrack,
    describe, reset,
    get state() { return _state; }
  };
}

module.exports = {
  createVoiceLiveKitGateway,
  GATEWAY_STATES,
  httpBaseFrom,
  DEFAULT_FAILURE_THRESHOLD,
  DEFAULT_COOLDOWN_MS
};
