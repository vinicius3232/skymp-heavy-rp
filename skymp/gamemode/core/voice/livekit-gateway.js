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
 * O corpo das chamadas de sala (Twirp/protobuf-JSON) **foi verificado contra o
 * `livekit-server` 1.13.5 real** na Etapa 4 — ver `SKYVOICE_SECURITY_AUDIT.md`
 * §SV-05. O que essa medição derrubou está registrado abaixo, porque é o tipo de
 * erro que nenhum teste com `fetch` falso pega.
 *
 * ## O que `UpdateSubscriptions` realmente exige (medido, não deduzido)
 *
 * A versão anterior deste arquivo mandava:
 *
 * ```js
 * participant_tracks: [{ participant_sid: <identity> }]
 * ```
 *
 * O SFU responde **`HTTP 200` com corpo `{}`** a isso — e não assina nada. É o
 * pior formato de falha possível: o circuito conta sucesso, a métrica conta
 * `gateway.ok`, e o painel mostra um gateway saudável enquanto **nenhuma
 * assinatura é aplicada**. Em produção isso não apareceria como "a voz quebrou";
 * apareceria como a conta de banda do SFU, meses depois, porque sem assinatura
 * seletiva o LiveKit entrega todas as faixas a todo mundo.
 *
 * A sonda testou cinco corpos contra o servidor real e mediu **efeito** (o
 * ouvinte recebeu `TrackSubscribed`?), não código HTTP — os cinco devolveram 200:
 *
 * | corpo | efeito |
 * |---|---|
 * | `participant_tracks:[{participant_sid: identity}]` | **nenhum** |
 * | `participant_tracks:[{participant_sid: SID, track_sids:[...]}]` | assina |
 * | `track_sids:[...]` no topo | assina |
 * | idem em camelCase | assina |
 * | `participant_sid` **errado** + `track_sids` | **assina** |
 *
 * A última linha é a que ensina: **quem decide é `track_sids`.** Com ele
 * preenchido, o `participant_sid` nem é olhado. Por isso este arquivo usa a forma
 * de cima — `track_sids` no topo, sem `participant_tracks` — que é a mais curta
 * das que funcionam e a única que não exige rastrear SID de participante.
 *
 * ## O preço: o gamemode precisa saber o track SID
 *
 * Track SID é atribuído pelo SFU, não por nós. O gamemode conhece `actorId` e
 * deriva `identity`; a ponte `identity → trackSid` só existe no servidor de
 * mídia. Daí o registro abaixo, alimentado por `ListParticipants` e recarregado
 * **só quando aparece uma identidade desconhecida** — que é quando alguém entra
 * na cena, não a cada tick.
 *
 * ## Limite que continua valendo
 *
 * Assinatura seletiva só decide alguma coisa se o cliente conectar com
 * `autoSubscribe: false`. Com o padrão (`true`), o SFU entrega tudo no momento da
 * entrada e estas chamadas ficam correndo atrás. **Nenhum cliente deste projeto
 * fala LiveKit ainda**; quando falar, é requisito de conexão, não detalhe.
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

  /**
   * `identity → [trackSid]`, a ponte que só o SFU sabe construir.
   *
   * Só faixas de **microfone**. Uma faixa de vídeo aqui seria um bug em outro
   * lugar (o token nega `canPublishSources` fora de `microphone`), e assinar uma
   * por engano gastaria banda que este módulo existe para economizar.
   *
   * @type {Map<string, string[]>}
   */
  const _tracksByIdentity = new Map();
  let _registryRefreshes = 0;

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

      // O corpo só interessa para `ListParticipants`. Falha de parse não é falha
      // de chamada: `UpdateSubscriptions` responde `{}` e um `{}` ilegível não
      // muda o fato de o SFU ter aceitado.
      let data = null;
      if (typeof response.json === 'function') {
        try { data = await response.json(); } catch { data = null; }
      }

      _onSuccess();
      done();
      metrics.count('gateway.ok');
      return { ok: true, skipped: false, data };
    } catch (err) {
      done();
      _onFailure(err);
      return { ok: false, skipped: false, reason: _lastError };
    }
  }

  /**
   * Recarrega `identity → [trackSid]` a partir da verdade do SFU.
   *
   * Nunca rejeita, como tudo aqui. Se a chamada falhar, o registro fica como
   * estava: uma assinatura que não sai é banda desperdiçada, e uma exceção aqui
   * seria o servidor de jogo caindo — a troca não é próxima de justa.
   */
  async function refreshTrackRegistry() {
    const result = await _call('ListParticipants', { room: resolveLiveKitConfig(env()).room });
    if (!result.ok || !result.data || !Array.isArray(result.data.participants)) {
      return { ok: false, known: _tracksByIdentity.size };
    }

    _tracksByIdentity.clear();
    for (const participant of result.data.participants) {
      if (!participant || typeof participant.identity !== 'string') continue;
      const sids = [];
      for (const track of (participant.tracks || [])) {
        // `type: 'AUDIO'` e `source: 'MICROPHONE'` são o que o servidor devolve
        // para a faixa que o nosso token permite publicar. Filtrar pelos dois é
        // redundante de propósito: se um dia o token afrouxar, o desperdício não
        // começa aqui em silêncio.
        if (track && track.type === 'AUDIO' && track.source === 'MICROPHONE' && track.sid) {
          sids.push(track.sid);
        }
      }
      if (sids.length > 0) _tracksByIdentity.set(participant.identity, sids);
    }

    _registryRefreshes++;
    metrics.count('gateway.trackRegistryRefresh');
    return { ok: true, known: _tracksByIdentity.size };
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

    // UMA recarga por lote, no máximo, e só se alguém que precisa ser ASSINADO
    // for desconhecido. Quem vai ser desassinado e sumiu do registro já não tem
    // assinatura no SFU — recarregar por causa dele seria uma ida à rede para
    // descobrir que não há nada a fazer.
    const precisaRecarregar = diff.subscribe.some((edge) => {
      const identity = identityOf(edge.speaker);
      return identity && !_tracksByIdentity.has(identity);
    });
    // Uma recarga que falha não é um lote vazio. Se o SFU não respondeu, o
    // gamemode pediu assinaturas e NÃO conseguiu — devolver `ok: true` aqui
    // faria o chamador registrar sucesso justamente no tick em que a voz parou
    // de ser roteada, que é o mesmo engano que o SV-05 era.
    let refreshFailed = false;
    if (precisaRecarregar) {
      const recarga = await refreshTrackRegistry();
      refreshFailed = recarga.ok !== true;
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

    /** Quantas arestas morreram por falta de faixa conhecida — vira diagnóstico. */
    let unresolved = 0;
    const empurrar = (edge, alvo) => {
      const identity = identityOf(edge.speaker);
      if (!identity) return;
      const sids = _tracksByIdentity.get(identity);
      if (!sids || sids.length === 0) { unresolved++; return; }
      bucketFor(edge.listener)[alvo].push(...sids);
    };

    for (const edge of diff.subscribe) empurrar(edge, 'subscribe');
    for (const edge of diff.unsubscribe) empurrar(edge, 'unsubscribe');

    let calls = 0;
    let failures = 0;
    for (const [listener, bucket] of byListener) {
      const listenerIdentity = identityOf(listener);
      if (!listenerIdentity) continue;

      for (const subscribe of [true, false]) {
        const sids = subscribe ? bucket.subscribe : bucket.unsubscribe;
        if (sids.length === 0) continue;
        calls++;
        // `track_sids` no topo — a forma medida contra o SFU real. Ver o
        // cabeçalho deste arquivo para as cinco variantes testadas e por que
        // `participant_tracks` saiu.
        const result = await _call('UpdateSubscriptions', {
          room: resolveLiveKitConfig(env()).room,
          identity: listenerIdentity,
          track_sids: sids,
          subscribe
        });
        if (!result.ok) failures++;
      }
    }

    if (unresolved > 0) metrics.count('gateway.unresolvedTracks', unresolved);
    metrics.count('gateway.subscriptionCalls', calls);
    return {
      ok: failures === 0 && !refreshFailed,
      calls, failures, unresolved, refreshFailed, skipped: false
    };
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
    // Fora da sala, fora do registro. Manter a entrada faria o próximo lote
    // mandar `track_sids` de uma faixa que não existe mais — e, pior, faria o
    // gateway NÃO recarregar quando a pessoa voltasse com uma faixa nova.
    _tracksByIdentity.delete(identity);
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
      circuitOpenUntil: _state === GATEWAY_STATES.FAILED ? _openedAt + cooldownMs : 0,
      knownTrackIdentities: _tracksByIdentity.size,
      trackRegistryRefreshes: _registryRefreshes
    };
  }

  function reset() {
    _state = GATEWAY_STATES.DISABLED;
    _consecutiveFailures = 0;
    _openedAt = 0;
    _lastError = null;
    _tracksByIdentity.clear();
    _registryRefreshes = 0;
  }

  return {
    applySubscriptionDiff, removeParticipant, mutePublishedTrack,
    refreshTrackRegistry, describe, reset,
    /** Só para teste e diagnóstico: o que o gateway acha que existe no SFU. */
    trackSidsFor(identity) { return _tracksByIdentity.get(identity) || null; },
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
