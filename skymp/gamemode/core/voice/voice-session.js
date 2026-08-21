/**
 * core/voice/voice-session.js
 *
 * VoiceSessionService — a costura entre uma sessão do SkyMP e um participante
 * do LiveKit.
 *
 * ## O que ele guarda, e por que precisa existir
 *
 * O SkyMP conhece `actorId`. O LiveKit conhece `identity`. Enquanto ninguém
 * escrever a ponte entre os dois num lugar só, ela é escrita de novo em cada
 * arquivo que precisar dela — e uma ponte reescrita é uma ponte que diverge.
 * O modo de divergir é sempre o mesmo: alguém aceita a `identity` que o cliente
 * mandou, porque é o dado que está à mão, e a partir daí o cliente escolhe
 * quem ele é.
 *
 * Aqui a identidade é **derivada** (`actor-<actorId>-<nonce>`) e o mapa
 * `identity → actorId` é do servidor. `resolveActor()` só responde por
 * identidades que este serviço emitiu e que ainda estão vivas; qualquer outra
 * é `null`, e `null` não vira ator nenhum.
 *
 * ## Estados, e a promessa que eles cumprem
 *
 * ```
 *   DISABLED ──open()──► CONNECTING ──confirmConnected()──► CONNECTED
 *      ▲                     │                                 │
 *      │                     └──markFailed()──► FAILED         │
 *      │                                          │            │
 *      └──────────── close() ────────────┬────────┴── markReconnecting()
 *                                        │                     │
 *                                        └───── RECONNECTING ──┘
 * ```
 *
 * **Se o LiveKit cair, o VOIP pode falhar; o jogo não pode.** Nenhum caminho
 * daqui lança para quem chama: falta de configuração vira `DISABLED`, falha de
 * conexão vira `FAILED`, e os dois são estados normais de um servidor rodando.
 * `DISABLED` é o estado de um servidor sem LiveKit configurado — que é a
 * maioria dos servidores hoje — e mantê-lo distinto de `FAILED` é o que
 * impede "voz não configurada" de aparecer no log como incidente.
 *
 * ## Uma sala, não uma por célula
 *
 * A sala é uma só para o servidor. Uma sala por célula tornaria o isolamento
 * estrutural em vez de calculado, o que soa melhor — e custaria uma reconexão
 * WebRTC completa a cada porta que alguém atravessa, com renegociação de ICE e
 * um buraco de áudio de segundos numa ação que no jogo leva um quadro. O
 * isolamento entre células é feito pelas assinaturas
 * (`voice-route-engine.js`), que mudam sem derrubar transporte nenhum.
 *
 * ## Participante duplicado
 *
 * O LiveKit trata `identity` como chave única na sala: um segundo participante
 * com a mesma identidade **derruba o primeiro**. Isso corta nos dois sentidos, e
 * este serviço usa os dois:
 *
 *   - `open()` no mesmo ator gera um **nonce novo**, então a sessão que está
 *     entrando não expulsa a que ainda pode estar viva por acidente. A antiga é
 *     marcada como superada e sai por um comando explícito de despejo — decisão
 *     do servidor, com registro, e não um efeito colateral de colisão de chave.
 *   - `renew()` mantém a **mesma identidade**, porque uma reconexão é a mesma
 *     pessoa voltando: manter a identidade preserva as assinaturas que os
 *     outros já têm dela e evita que a volta pareça uma chegada.
 */

const crypto = require('crypto');
const livekitToken = require('./livekit-token');
const { CONNECTION_STATES } = require('./voice-state');
const { nullMetrics } = require('./voice-metrics');

/** Sala padrão. Ver "Uma sala, não uma por célula" no cabeçalho. */
const DEFAULT_ROOM = 'skyvoice';

/**
 * @typedef {object} VoiceSession
 * @property {number} actorId
 * @property {number|null} characterId
 * @property {string} identity
 * @property {string} room
 * @property {string} state       um de CONNECTION_STATES
 * @property {number} openedAt
 * @property {number} tokenExpiresAt
 * @property {number} generation  quantas vezes este ator abriu sessão
 * @property {string|null} lastError
 * @property {boolean} canPublish   permissão DURÁVEL de publicar (papel, staff mute)
 * @property {boolean} canSubscribe permissão durável de assinar
 */

/**
 * Lê a configuração do LiveKit do ambiente, **por chamada**.
 *
 * Por chamada e não uma vez no load, pelo mesmo motivo do `VOICE_BACKEND`: uma
 * configuração que só muda reiniciando o servidor é uma configuração que alguém
 * deixa no estado errado para não ter que reiniciar de novo. Custa três leituras
 * de `process.env` por `/voz`, que é um comando humano.
 *
 * @param {NodeJS.ProcessEnv} [env]
 */
function resolveLiveKitConfig(env = process.env) {
  const url = env.LIVEKIT_URL || '';
  const apiKey = env.LIVEKIT_API_KEY || '';
  const apiSecret = env.LIVEKIT_API_SECRET || '';
  const room = env.LIVEKIT_ROOM || DEFAULT_ROOM;
  const missing = [];
  if (!url) missing.push('LIVEKIT_URL');
  if (!apiKey) missing.push('LIVEKIT_API_KEY');
  if (!apiSecret) missing.push('LIVEKIT_API_SECRET');
  return { url, apiKey, apiSecret, room, configured: missing.length === 0, missing };
}

/**
 * @param {object} [deps]
 * @param {ReturnType<typeof import('./voice-state').createVoiceStateService>} [deps.state]
 * @param {typeof livekitToken} [deps.tokenIssuer]
 * @param {() => NodeJS.ProcessEnv} [deps.env]
 * @param {() => number} [deps.now]
 * @param {() => string} [deps.nonce]
 * @param {ReturnType<typeof import('./voice-metrics').createVoiceMetrics>} [deps.metrics]
 * @param {Pick<Console,'log'|'warn'|'error'>} [deps.logger]
 */
function createVoiceSessionService(deps = {}) {
  const {
    state = null,
    tokenIssuer = livekitToken,
    env = () => process.env,
    now = () => Date.now(),
    nonce = () => crypto.randomBytes(4).toString('hex'),
    metrics = nullMetrics(),
    logger = console
  } = deps;

  /** @type {Map<number, VoiceSession>} */
  const sessions = new Map();
  /** @type {Map<string, number>} identity → actorId, só de sessões vivas */
  const byIdentity = new Map();
  /** @type {Map<number, number>} actorId → gerações já abertas */
  const generations = new Map();

  /** Espelha o estado da sessão no VoiceStateService, se ele foi injetado. */
  function _mirror(actorId, connection) {
    if (state && state.has(actorId)) state.setConnectionState(actorId, connection);
  }

  /**
   * Abre uma sessão de voz para um ator.
   *
   * `characterId` vem do servidor (o personagem ativo já resolvido). Não há
   * parâmetro por onde o cliente informe identidade, sala ou permissão: os três
   * são derivados aqui.
   *
   * ## `canPublish` é decisão de servidor, e por isso está aqui
   *
   * O token é a primeira camada de defesa contra alguém ser ouvido quando não
   * deveria — e até esta etapa ela não era usada: todo token saía com
   * `canPublish: true`, e o silêncio dependia inteiramente da camada de
   * assinatura (`UpdateSubscriptions`). Isso é frágil de um jeito específico: o
   * `livekit-gateway` **abre o circuito** quando o SFU falha, de propósito, para
   * não derrubar o jogo. Com o circuito aberto, a camada de assinatura para de
   * agir — e um jogador silenciado pela staff voltaria a ser ouvido por todo
   * mundo na sala, sem que nada no servidor reclamasse.
   *
   * Negar `canPublish` no token fecha isso no lugar certo: o próprio SFU recusa
   * a publicação, sem depender de o gamemode conseguir falar com ele.
   *
   * O que **não** entra aqui é PTT nem condição de personagem. Um token não pode
   * mudar cinquenta vezes por segundo; ele carrega a permissão **durável** da
   * sessão (papel e silêncio de staff), e o resto continua sendo rota.
   *
   * @param {number} actorId
   * @param {{characterId?: number|null, name?: string, canPublish?: boolean, canSubscribe?: boolean}} [opts]
   * @returns {{ok: boolean, reason?: string, session: VoiceSession|null, token?: string, url?: string, evicted?: string|null}}
   */
  function open(actorId, opts = {}) {
    if (!Number.isFinite(actorId)) {
      return { ok: false, reason: 'actorId inválido', session: null };
    }

    const config = resolveLiveKitConfig(env());
    if (!config.configured) {
      // Não é falha: é um servidor que não ligou LiveKit. O jogo segue, a voz
      // fica desligada, e o motivo aparece nomeando exatamente o que falta.
      metrics.count('session.disabled');
      const disabled = _record(actorId, opts, config, null);
      disabled.state = CONNECTION_STATES.DISABLED;
      _mirror(actorId, CONNECTION_STATES.DISABLED);
      return {
        ok: false,
        reason: `LiveKit não configurado (falta: ${config.missing.join(', ')})`,
        session: disabled,
        evicted: null
      };
    }

    // Proteção contra participante duplicado: a sessão anterior deste MESMO
    // ator é despejada por decisão explícita, e a nova entra com nonce próprio.
    const previous = sessions.get(actorId);
    let evicted = null;
    if (previous) {
      evicted = previous.identity;
      byIdentity.delete(previous.identity);
      metrics.count('session.superseded');
      logger.warn(
        `[voice-session] Ator 0x${actorId.toString(16)} abriu sessão nova; ` +
        `a anterior (${previous.identity}) será despejada.`
      );
    }

    const session = _record(actorId, opts, config, nonce());

    // A identidade tem que voltar a ser este `actorId` quando lida de volta.
    //
    // Parece redundante — acabamos de montá-la a partir dele — e não é: quem
    // MONTA a identidade é este arquivo, quem a LÊ é `livekit-token`, e o
    // leitor exige um alfabeto (`[0-9a-f]+` no nonce) que o gerador não declara
    // em lugar nenhum. Trocar o gerador de nonce por base64url, ou por algo
    // legível, faria toda identidade parar de resolver — e o sintoma seria
    // "ninguém ouve ninguém", longe daqui, sem erro no caminho.
    //
    // Conferir aqui transforma esse defeito silencioso numa recusa nomeada, no
    // instante em que a sessão é aberta.
    if (tokenIssuer.actorIdFromIdentity(session.identity) !== actorId) {
      session.state = CONNECTION_STATES.FAILED;
      session.lastError = 'identidade não sobrevive à leitura de volta';
      byIdentity.delete(session.identity);
      _mirror(actorId, CONNECTION_STATES.FAILED);
      metrics.count('session.identityRoundTripFailed');
      const reason =
        `[voice-session] A identidade '${session.identity}' não é reconhecida por ` +
        `actorIdFromIdentity. O gerador de nonce precisa produzir hexadecimal minúsculo.`;
      logger.error(reason);
      return { ok: false, reason, session, evicted };
    }

    let token;
    try {
      token = tokenIssuer.mintAccessToken({
        apiKey: config.apiKey,
        apiSecret: config.apiSecret,
        room: config.room,
        identity: session.identity,
        name: opts.name,
        canPublish: session.canPublish,
        canSubscribe: session.canSubscribe
      });
    } catch (err) {
      // Emissão de token falhando é problema de configuração, não do jogo.
      session.state = CONNECTION_STATES.FAILED;
      session.lastError = err.message;
      _mirror(actorId, CONNECTION_STATES.FAILED);
      metrics.count('session.tokenFailed');
      logger.error(`[voice-session] Falha ao emitir token para 0x${actorId.toString(16)}: ${err.message}`);
      return { ok: false, reason: err.message, session, evicted };
    }

    session.state = CONNECTION_STATES.CONNECTING;
    session.tokenExpiresAt = now() + (tokenIssuer.DEFAULT_TTL_SECONDS * 1000);
    _mirror(actorId, CONNECTION_STATES.CONNECTING);
    metrics.count('session.open');

    return { ok: true, session, token, url: config.url, evicted };
  }

  /** Cria/atualiza o registro da sessão. Sem token — quem emite é `open`. */
  function _record(actorId, opts, config, sessionNonce) {
    const generation = (generations.get(actorId) || 0) + 1;
    generations.set(actorId, generation);

    const identity = sessionNonce
      ? tokenIssuer.participantIdentity(actorId, sessionNonce)
      : `actor-${actorId}-disabled`;

    /** @type {VoiceSession} */
    const session = {
      actorId,
      characterId: opts.characterId ?? null,
      identity,
      room: config.room,
      state: CONNECTION_STATES.DISABLED,
      openedAt: now(),
      tokenExpiresAt: 0,
      generation,
      lastError: null,
      // Guardados na sessão, e não só passados ao emissor, porque o
      // diagnóstico da staff precisa responder "por que esta pessoa não é
      // ouvida?" sem decodificar um JWT. `!== false` e não `=== true`: quem não
      // diz nada continua podendo falar e ouvir, que é o caso normal.
      canPublish: opts.canPublish !== false,
      canSubscribe: opts.canSubscribe !== false
    };
    sessions.set(actorId, session);
    if (sessionNonce) byIdentity.set(identity, actorId);
    return session;
  }

  /**
   * Confirma que o participante entrou de fato na sala.
   *
   * A identidade é validada contra o registro do servidor. Uma identidade que
   * este serviço não emitiu — ou que pertence a uma geração já superada — é
   * recusada, e é aqui que "identidade inválida" deixa de ser um cenário de
   * teste e vira um caminho de código.
   *
   * @param {string} identity
   * @returns {{ok: boolean, actorId: number|null, reason?: string}}
   */
  function confirmConnected(identity) {
    const actorId = resolveActor(identity);
    if (actorId === null) {
      metrics.count('session.invalidIdentity');
      return { ok: false, actorId: null, reason: 'identidade desconhecida ou superada' };
    }
    const session = sessions.get(actorId);
    session.state = CONNECTION_STATES.CONNECTED;
    session.lastError = null;
    _mirror(actorId, CONNECTION_STATES.CONNECTED);
    metrics.count('session.connected');
    return { ok: true, actorId };
  }

  /**
   * Resolve identidade → actorId, **só para sessões vivas**.
   *
   * Duas conferências, e a segunda é a que importa: o formato bater
   * (`actorIdFromIdentity`) não prova nada — qualquer um sabe escrever
   * `actor-42-deadbeef`. O que prova é a identidade estar no `byIdentity`, que
   * só recebe o que este serviço emitiu.
   *
   * @param {string} identity
   * @returns {number|null}
   */
  function resolveActor(identity) {
    if (typeof identity !== 'string') return null;
    const registered = byIdentity.get(identity);
    if (registered === undefined) return null;
    // Cinto e suspensório: o parse tem que concordar com o registro. Se
    // divergirem, alguma coisa gravou no mapa por um caminho que não é `open`.
    const parsed = tokenIssuer.actorIdFromIdentity(identity);
    if (parsed !== registered) return null;
    const session = sessions.get(registered);
    if (!session || session.identity !== identity) return null;
    return registered;
  }

  /** @param {number} actorId */
  function markReconnecting(actorId) {
    const session = sessions.get(actorId);
    if (!session) return { ok: false };
    session.state = CONNECTION_STATES.RECONNECTING;
    _mirror(actorId, CONNECTION_STATES.RECONNECTING);
    metrics.count('session.reconnecting');
    return { ok: true, session };
  }

  /**
   * @param {number} actorId
   * @param {string} [reason]
   */
  function markFailed(actorId, reason = 'desconhecido') {
    const session = sessions.get(actorId);
    if (!session) return { ok: false };
    session.state = CONNECTION_STATES.FAILED;
    session.lastError = reason;
    _mirror(actorId, CONNECTION_STATES.FAILED);
    metrics.count('session.failed');
    return { ok: true, session };
  }

  /**
   * Renova o token de uma sessão que já existe, **mantendo a identidade**.
   *
   * É o caminho de reconexão: a mesma pessoa voltando. Manter a identidade é o
   * que faz os outros participantes não verem uma chegada nova — e o que
   * preserva as assinaturas que já apontam para ela.
   *
   * `grants` permite que a renovação **aperte ou solte** a permissão durável:
   * uma reconexão de quem foi silenciado pela staff no meio da sessão precisa
   * voltar sem `canPublish`, senão a reconexão seria a forma trivial de desfazer
   * a punição. Omitir `grants` preserva o que a sessão já tinha.
   *
   * @param {number} actorId
   * @param {{canPublish?: boolean, canSubscribe?: boolean}} [grants]
   * @returns {{ok: boolean, reason?: string, token?: string, url?: string, session?: VoiceSession}}
   */
  function renew(actorId, grants = {}) {
    const session = sessions.get(actorId);
    if (!session) return { ok: false, reason: 'sem sessão aberta' };

    const config = resolveLiveKitConfig(env());
    if (!config.configured) {
      return { ok: false, reason: `LiveKit não configurado (falta: ${config.missing.join(', ')})`, session };
    }

    if (grants.canPublish !== undefined) session.canPublish = grants.canPublish !== false;
    if (grants.canSubscribe !== undefined) session.canSubscribe = grants.canSubscribe !== false;

    try {
      const token = tokenIssuer.mintAccessToken({
        apiKey: config.apiKey,
        apiSecret: config.apiSecret,
        room: session.room,
        identity: session.identity,
        canPublish: session.canPublish,
        canSubscribe: session.canSubscribe
      });
      session.tokenExpiresAt = now() + (tokenIssuer.DEFAULT_TTL_SECONDS * 1000);
      session.state = CONNECTION_STATES.RECONNECTING;
      session.lastError = null;
      _mirror(actorId, CONNECTION_STATES.RECONNECTING);
      metrics.count('session.renew');
      return { ok: true, token, url: config.url, session };
    } catch (err) {
      markFailed(actorId, err.message);
      return { ok: false, reason: err.message, session };
    }
  }

  /**
   * Fecha e limpa a sessão. Idempotente.
   *
   * Devolve a identidade que precisa sair da sala para quem for falar com o
   * LiveKit. Não fala com o LiveKit daqui de propósito: este serviço é registro
   * e regra; quem faz chamada de rede é o `livekit-gateway`, que sabe falhar
   * sem derrubar nada.
   *
   * @param {number} actorId
   * @param {string} [reason]
   * @returns {{ok: boolean, identity: string|null, reason: string}}
   */
  function close(actorId, reason = 'close') {
    const session = sessions.get(actorId);
    if (!session) return { ok: false, identity: null, reason: 'sem sessão' };
    sessions.delete(actorId);
    byIdentity.delete(session.identity);
    _mirror(actorId, CONNECTION_STATES.DISABLED);
    metrics.count('session.close');
    return { ok: true, identity: session.identity, reason };
  }

  /** @param {number} actorId @returns {VoiceSession|null} */
  function get(actorId) {
    return sessions.get(actorId) || null;
  }

  /** @param {number} actorId */
  function isConnected(actorId) {
    const session = sessions.get(actorId);
    return Boolean(session && session.state === CONNECTION_STATES.CONNECTED);
  }

  /** @returns {VoiceSession[]} */
  function all() {
    return [...sessions.values()];
  }

  function size() {
    return sessions.size;
  }

  /** Todas as sessões fora, numa parada de servidor ou num reset de teste. */
  function closeAll(reason = 'shutdown') {
    const identities = [];
    for (const actorId of [...sessions.keys()]) {
      const result = close(actorId, reason);
      if (result.identity) identities.push(result.identity);
    }
    generations.clear();
    return identities;
  }

  return {
    open, renew, close, closeAll,
    confirmConnected, markReconnecting, markFailed,
    resolveActor, get, isConnected, all, size
  };
}

module.exports = {
  createVoiceSessionService,
  resolveLiveKitConfig,
  DEFAULT_ROOM
};
