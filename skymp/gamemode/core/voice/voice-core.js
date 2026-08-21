/**
 * core/voice/voice-core.js
 *
 * VoiceCore — a raiz de composição do sistema de voz.
 *
 * ## O que ele é, e o que ele deliberadamente não é
 *
 * Ele **liga** os módulos e **controla o tempo**. Não decide permissão (é da
 * `policy`), não guarda estado de ator (é do `state`), não calcula vizinhança
 * (é do `index`), não fala com o SFU (é do `gateway`). O que sobra é o que
 * ninguém mais pode fazer: **ler o mundo** e **decidir quando recalcular**.
 *
 * Ler o mundo é a fronteira de autoridade inteira. `sample()` é o único lugar
 * do Voice Core que toca `mp`, e é dele que saem `pos`, `space` e nada mais.
 * Posição, célula e worldspace entram no sistema por aqui, medidos pelo
 * servidor, e nenhuma mensagem de cliente tem caminho para alterá-los.
 *
 * ## Os dois relógios
 *
 * A instrução separava o que precisa ser imediato do que pode esperar, e o
 * desenho tem exatamente dois caminhos:
 *
 * ```
 *  movimento normal ─────────────► tick espacial (VOICE_TICK_MS, padrão 150 ms)
 *
 *  teleporte      ┐
 *  troca de cell  │
 *  troca de world ├──► markCritical() ──► recompute no próximo `setImmediate`
 *  voiceMode      │                        (coalescido, com piso de intervalo)
 *  mute / PTT     │
 *  disconnect     │
 *  logout         ┘
 * ```
 *
 * Teleporte e troca de célula são **detectados aqui**, comparando a amostra com
 * a anterior — o SkyMP não emite evento para eles, e esperar por um evento que
 * não existe seria a forma mais silenciosa de nunca implementar o requisito. O
 * resto chega por chamada, de quem recebeu a mensagem ou o evento de sessão.
 *
 * ## Por que o imediato tem piso de intervalo
 *
 * `markCritical` é alcançável por mensagem de cliente (`voice_mode`, `mute`,
 * PTT). Sem piso, um cliente alternando modo num laço apertado forçaria um
 * recompute por mensagem — o cliente escolhendo a carga de CPU do servidor, que
 * é a mesma classe de furo que o teto de `audio_frame` fechou no relay.
 *
 * Com piso, o primeiro pedido roda na hora e os seguintes dentro da janela são
 * **coalescidos numa única execução agendada**. A mudança nunca é perdida — só
 * agrupada —, e o custo por cliente fica limitado por construção.
 *
 * ## Falha do transporte não derruba o jogo
 *
 * O `gateway` já promete não rejeitar; o `tick` ainda assim envolve a entrega
 * num `catch`, porque o que este laço não pode fazer é morrer. Um `setInterval`
 * cujo callback lança perde o tick e continua agendado — mas com um
 * `unhandledRejection` no caminho, e este projeto roda dentro do processo do
 * servidor de jogo.
 */

const rangeUtils = require('../range-utils');
const { createVoiceMetrics } = require('./voice-metrics');
const { createVoiceStateService, CONNECTION_STATES } = require('./voice-state');
const { createVoicePolicyEngine } = require('./voice-policy');
const { createVoiceSpatialIndex } = require('./voice-spatial-index');
const { createVoiceRouteEngine } = require('./voice-route-engine');
const { createVoiceSessionService } = require('./voice-session');
const livekitToken = require('./livekit-token');
const { createVoiceLiveKitGateway } = require('./livekit-gateway');
const { createVoiceCharacterAdapter } = require('./voice-character-adapter');
const { createVoiceOcclusion } = require('./voice-occlusion');
const { createVoiceSpeakingState } = require('./voice-speaking-state');
const { createVoiceSpeechAnimation } = require('./voice-speech-animation');
const { effectSettings, VOICE_CONDITIONS } = require('./voice-conditions');
const serverOptions = require('../server-options');

/**
 * Intervalo do tick espacial.
 *
 * 150 ms é o meio da faixa pedida (100–250 ms) e é **alvo, não prova**: o que
 * torna a meta atingida é o recompute caber com folga dentro dele, e isso é
 * medido em `scripts/bench-voice-proximity.js`, não afirmado aqui.
 *
 * O valor antigo era 2000 ms, e a razão de ter sido tão alto está registrada no
 * `voip-service.js`: o tick era O(n²) e ninguém queria pagá-lo com frequência.
 * Com o índice espacial o custo caiu, e o intervalo pôde cair junto — nesta
 * ordem, e não na inversa.
 */
const DEFAULT_TICK_MS = 150;

/**
 * Deslocamento entre duas amostras que caracteriza teleporte, em unidades.
 *
 * 1000 unidades em 150 ms é ~6.700 u/s. Um jogador correndo no Skyrim faz uma
 * ordem de grandeza menos que isso, então movimento normal não dispara; um
 * `moveTo` entre cidades passa com folga. O número existe para o caso em que a
 * célula **não** muda (teleporte dentro do mesmo worldspace) — quando ela muda,
 * a troca de célula já é o gatilho.
 */
const DEFAULT_TELEPORT_THRESHOLD = 1000;

/** Piso entre recomputes forçados. Ver "por que o imediato tem piso". */
const DEFAULT_MIN_CRITICAL_INTERVAL_MS = 20;

/**
 * @param {object} [deps]
 * @param {any} [deps.mp] a API do SkyMP; ausente = modo sem mundo (testes, boot cedo)
 * @param {number} [deps.tickMs]
 * @param {number} [deps.teleportThreshold]
 * @param {number} [deps.minCriticalIntervalMs]
 * @param {number} [deps.bucketSize]
 * @param {Pick<Console,'log'|'warn'|'error'>} [deps.logger]
 * @param {() => number} [deps.now]
 * @param {(fn: () => void) => any} [deps.schedule] como agendar o recompute imediato
 * @param {(fn: () => void, ms: number) => any} [deps.defer] como adiar o recompute até o piso passar
 * @param {any} [deps.metrics]
 * @param {any} [deps.state]
 * @param {any} [deps.policy]
 * @param {any} [deps.index]
 * @param {any} [deps.routes]
 * @param {any} [deps.sessions]
 * @param {any} [deps.gateway]
 * @param {any} [deps.conditions] adapter para os estados reais do personagem
 * @param {any} [deps.occlusion]
 * @param {any} [deps.speaking]
 * @param {any} [deps.speechAnimation]
 * @param {any} [deps.staffMute] registro de silêncio de staff; padrão é o compartilhado
 * @param {boolean} [deps.spatial]
 */
function createVoiceCore(deps = {}) {
  const {
    /**
     * A API do SkyMP.
     *
     * Resolvida **a cada leitura**, não capturada no construtor. `mp` é um
     * global que o host injeta, e o Voice Core é instanciado quando o
     * `voip-service` é carregado — que pode ser antes. Capturar no construtor
     * congelava `null` para sempre: o servidor subia, o laço rodava, e ninguém
     * ouvia ninguém, sem erro em lugar nenhum. Custa um `typeof` por tick.
     */
    mp: injectedMp = null,
    tickMs = Number.parseInt(process.env.VOICE_TICK_MS, 10) || DEFAULT_TICK_MS,
    teleportThreshold = DEFAULT_TELEPORT_THRESHOLD,
    minCriticalIntervalMs = DEFAULT_MIN_CRITICAL_INTERVAL_MS,
    bucketSize = Number.parseInt(process.env.VOICE_BUCKET_SIZE, 10) || undefined,
    logger = console,
    now = () => Date.now(),
    schedule = (fn) => setImmediate(fn),
    // Os dois caminhos do `markCritical` são injetáveis porque são dois
    // comportamentos distintos, e um deles — o adiamento pelo piso de intervalo
    // — é justamente o que protege o servidor de um cliente alternando modo num
    // laço. Um caminho de defesa que nenhum teste consegue observar é um
    // caminho de defesa que se pode quebrar sem que nada reclame.
    defer = (fn, ms) => {
      const timer = setTimeout(fn, ms);
      if (typeof timer.unref === 'function') timer.unref();
      return timer;
    }
  } = deps;

  const metrics = deps.metrics || createVoiceMetrics();
  const state = deps.state || createVoiceStateService({ now });

  // O registro de silêncio de staff é resolvido ANTES do adapter, e isso não é
  // arrumação de código.
  //
  // O adapter é quem traduz `STAFF_MUTED` para a política, e ele monta o próprio
  // registro por padrão — o compartilhado do processo. Se o Voice Core resolvesse
  // o dele depois e guardasse outro, existiriam **dois registros de punição**: o
  // que o adapter consulta para recusar a fala, e o que o Voice Core observa para
  // reemitir o token. Eles concordariam em produção (ambos são o compartilhado) e
  // divergiriam em teste — que é o pior arranjo possível, porque o defeito só
  // aparece onde ninguém o procura.
  //
  // Resolvido uma vez, passado ao adapter, observado aqui: um registro só.
  const staffMuteRegistry = deps.staffMute !== undefined
    ? deps.staffMute
    : require('./voice-staff-mute').sharedVoiceStaffMute;

  // O Voice Core é quem liga a política ao personagem REAL. A política sozinha
  // nasce com o adapter nulo (ver `voice-policy`), para que um teste de alcance
  // não precise de banco; aqui, onde há mundo, ela ganha o adapter que lê
  // `core/character-state`.
  const conditions = deps.conditions || createVoiceCharacterAdapter({ staffMute: staffMuteRegistry });
  const occlusion = deps.occlusion || createVoiceOcclusion({ metrics });
  const policy = deps.policy || createVoicePolicyEngine({ state, metrics, conditions, occlusion });
  const index = deps.index || createVoiceSpatialIndex({ bucketSize, metrics });
  const spatialEnabled = deps.spatial !== undefined ? deps.spatial : serverOptions.get('voice.spatial.enabled');
  const routes = deps.routes || createVoiceRouteEngine({ state, policy, index, metrics, spatial: spatialEnabled });
  const sessions = deps.sessions || createVoiceSessionService({ state, metrics, logger, now });
  // `mintAdminToken` é OBRIGATÓRIO aqui, e a ausência dele era um defeito real:
  // o gateway recusa toda chamada sem emissor de token de operador, devolvendo
  // `{ok: false, skipped: true}` — sem erro, sem falha de circuito, sem métrica
  // de falha. Até esta etapa nenhum caminho de produção passava um (só os
  // testes), então `UpdateSubscriptions`, `RemoveParticipant` e
  // `MutePublishedTrack` **nunca saíam do processo**. O gateway se descrevia
  // saudável e não falava com o SFU nenhuma vez.
  const gateway = deps.gateway || createVoiceLiveKitGateway({
    metrics, logger, now,
    mintAdminToken: livekitToken.mintAdminToken
  });
  const speaking = deps.speaking || createVoiceSpeakingState({ policy, now });
  const speechAnimation = deps.speechAnimation || createVoiceSpeechAnimation({ mp: injectedMp, logger, now });

  // A animação é ASSINANTE do estado de fala, não um segundo dono dele. É o que
  // faz as cinco garantias de parada valerem para ela sem serem reimplementadas.
  speechAnimation.bind(speaking);

  // O Voice Core assina o registro de silêncio de staff. A inscrição vive aqui,
  // e não no `admin-service`, porque a dependência tem que apontar de voz para
  // staff — nunca o contrário. Ver `onChange` em `voice-staff-mute.js`.
  if (staffMuteRegistry && typeof staffMuteRegistry.onChange === 'function') {
    staffMuteRegistry.onChange((characterId) => {
      // Encontra o ator daquele personagem. É uma varredura sobre as sessões
      // abertas, e não um índice, porque calar é um ato humano — algumas por
      // hora no pior dia — enquanto um índice seria mais uma estrutura a manter
      // coerente em todo attach, detach e troca de personagem.
      for (const session of sessions.all()) {
        if (session.characterId === characterId) refreshGrants(session.actorId);
      }
    });
  }

  /**
   * O `mp` em vigor: o injetado, ou o global do host no instante da chamada.
   *
   * `mp: null` explícito continua significando "sem mundo" apenas quando não há
   * global — é o que permite os testes de "sem mp" rodarem sem apagar
   * `globalThis.mp` de todo mundo.
   */
  function world() {
    if (injectedMp) return injectedMp;
    // `mp` bare, e não `globalThis.mp`: é assim que `types/mp.d.ts` o declara e
    // como o resto do gamemode o lê (`core/range-utils.js`, `voip-service.js`).
    //
    // O parâmetro se chama `injectedMp` por causa disto: destruturá-lo como
    // `mp` o faria SOMBREAR o global dentro de toda esta função, e `typeof mp`
    // passaria a perguntar sobre o parâmetro — que é `null`. O resultado seria
    // um servidor que sobe, um laço que roda, e ninguém ouvindo ninguém, sem
    // erro em lugar nenhum. Aconteceu; por isso o nome é feio de propósito.
    return typeof mp !== 'undefined' && mp ? mp : null;
  }

  /** Última amostra por ator — a base de comparação para teleporte e troca de célula. */
  /** @type {Map<number, {space: string|null, pos: number[]}>} */
  const lastSample = new Map();

  /** Audiência do último recompute, consultada pelo relay a 50 quadros/s. */
  /** @type {Map<number, {actorId: number, volume: number, distance: number, effect: string}[]>} */
  let audienceBySpeaker = new Map();
  /** @type {Map<number, Map<number, {volume: number, effect: string, dir: number[]|null}>>} */
  let routesByListener = new Map();

  /** @type {((routesByListener: Map<number, Map<number, {volume: number, effect: string, dir: number[]|null}>>, result: object) => void)[]} */
  const routeSubscribers = [];

  let _timer = null;
  let _criticalPending = false;
  let _criticalScheduled = false;
  let _lastCriticalAt = 0;
  /** @type {Set<string>} */
  let _criticalReasons = new Set();

  // ───────────────────────────────────────────────────────────────────────────
  // Leitura do mundo — a única fronteira com `mp`
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Lê posição e célula de todos os atores com estado de voz.
   *
   * Uma leitura por ATOR, nunca por conexão: uma pessoa com helper e UI abertos
   * é uma pessoa num lugar só, e iterar conexões faria a mesma posição aparecer
   * duas vezes na audiência — cada quadro entregue em dobro.
   *
   * Uma leitura que falha **remove** o ator da amostra em vez de reaproveitar a
   * anterior. Rota calculada sobre posição velha entrega voz com base em onde a
   * pessoa estava, e "estava" não é uma regra de jogo defensável.
   *
   * @returns {{samples: import('./voice-spatial-index').VoiceSample[], critical: {actorId: number, reason: string}[]}}
   */
  function sample() {
    const done = metrics.timer('core.sample');
    /** @type {import('./voice-spatial-index').VoiceSample[]} */
    const samples = [];
    /** @type {{actorId: number, reason: string}[]} */
    const critical = [];

    const skymp = world();
    if (!skymp) {
      done();
      return { samples, critical };
    }

    for (const actorId of state.actorIds()) {
      let loc;
      try {
        loc = skymp.get(actorId, 'locationalData');
      } catch {
        lastSample.delete(actorId);
        metrics.count('core.sample.error');
        continue;
      }
      if (!loc || !Array.isArray(loc.pos) || loc.pos.length < 3) {
        lastSample.delete(actorId);
        metrics.count('core.sample.missing');
        continue;
      }

      const space = rangeUtils.getCell(loc);
      const pos = loc.pos;
      // `rot` é lido junto com `pos` porque vem do MESMO `locationalData`: uma
      // ida ao `mp`, dois campos. Ler orientação num segundo `mp.get` dobraria
      // a fronteira mais cara do sistema para buscar um número que já estava no
      // objeto. Ausência é tolerada — `directionFor` trata `rot` faltando como
      // olhando para o norte, e uma leitura sem orientação vale mais que uma
      // pessoa sem rota.
      const rot = Array.isArray(loc.rot) ? loc.rot : [0, 0, 0];
      const previous = lastSample.get(actorId);

      if (previous) {
        if (previous.space !== space) {
          // Cobre troca de célula E troca de worldspace: no SkyMP os dois são o
          // mesmo campo (`cellOrWorldDesc`). Ver `voice-spatial-index.js`.
          critical.push({ actorId, reason: 'spaceChange' });
          metrics.count('core.critical.spaceChange');
        } else if (jumped(previous.pos, pos, teleportThreshold)) {
          critical.push({ actorId, reason: 'teleport' });
          metrics.count('core.critical.teleport');
        }
      }

      lastSample.set(actorId, { space, pos });
      samples.push({ actorId, space, pos, rot });
    }

    // Quem saiu do estado de voz não deve deixar amostra para trás.
    for (const actorId of lastSample.keys()) {
      if (!state.has(actorId)) lastSample.delete(actorId);
    }

    done();
    metrics.observe('core.sampleSize', samples.length);
    return { samples, critical };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Recompute
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Um ciclo completo: ler o mundo, recalcular rotas, entregar.
   *
   * @param {string} [trigger] 'tick' | 'critical' — só para métrica e log
   */
  function recompute(trigger = 'tick') {
    const done = metrics.timer(`core.cycle.${trigger === 'tick' ? 'tick' : 'critical'}`);
    const { samples } = sample();
    const result = routes.recompute(samples, { at: now() });

    audienceBySpeaker = result.audienceBySpeaker;
    routesByListener = result.routesByListener;

    // Fecha a boca de quem parou de falar — e de quem perdeu o direito no meio
    // da frase. É a única das cinco garantias de parada que não tem um evento
    // para pendurar: ninguém emite "você morreu, pare de falar".
    speaking.sweep();

    for (const subscriber of routeSubscribers) {
      try {
        subscriber(routesByListener, result);
      } catch (err) {
        // Um assinante que lança não pode derrubar o ciclo dos outros nem o
        // laço. Ele perde este ciclo e o próximo tenta de novo.
        metrics.count('core.subscriberError');
        logger.error(`[voice-core] Assinante de rotas lançou: ${err.message}`);
      }
    }

    // O gateway não rejeita; o `catch` aqui é para o caso de ele ser
    // substituído por uma implementação que rejeite, e é barato o suficiente
    // para não valer a aposta de que ninguém fará isso.
    Promise.resolve(gateway.applySubscriptionDiff(result.diff, identityOf))
      .catch((err) => {
        metrics.count('core.gatewayError');
        logger.error(`[voice-core] Gateway falhou fora do contrato: ${err.message}`);
      });

    const elapsed = done();
    metrics.observe('core.cycle', elapsed);
    return { ...result, trigger, cycleMs: elapsed };
  }

  /**
   * Marca que algo relevante mudou e o recompute não pode esperar o tick.
   *
   * Coalesce: várias chamadas dentro da mesma janela viram um recompute só.
   * Nunca perde a mudança — se chegar durante o piso, fica agendada.
   *
   * @param {number|null} actorId
   * @param {string} reason
   */
  function markCritical(actorId, reason) {
    _criticalPending = true;
    _criticalReasons.add(reason);
    metrics.count(`core.markCritical.${reason}`);

    if (_criticalScheduled) return;

    const sinceLast = now() - _lastCriticalAt;
    const delay = sinceLast >= minCriticalIntervalMs ? 0 : minCriticalIntervalMs - sinceLast;
    _criticalScheduled = true;

    const run = () => {
      _criticalScheduled = false;
      if (!_criticalPending) return;
      _criticalPending = false;
      _criticalReasons = new Set();
      _lastCriticalAt = now();
      try {
        recompute('critical');
      } catch (err) {
        metrics.count('core.criticalError');
        logger.error(`[voice-core] Recompute crítico falhou: ${err.message}`);
      }
    };

    if (delay === 0) schedule(run);
    else defer(run, delay);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Ciclo de vida de ator
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Coloca um ator na cena de voz e abre a sessão de transporte.
   *
   * `transport: 'legacy'` existe porque o caminho legado **não tem participante
   * no LiveKit**: quem transporta é o WebSocket do `voip-service`, e o
   * handshake por ticket dele já é a conexão. Empurrar esse caminho por
   * `sessions.open` produziria uma sessão `DISABLED` (nenhum servidor legado
   * configura LiveKit), `canSpeak` recusaria todo mundo, e o relay que hoje
   * funciona ficaria mudo — uma regressão no único caminho de captura provado
   * que o projeto tem.
   *
   * A máquina de estados é a mesma nos dois; o que muda é quem a alimenta.
   *
   * @param {number} actorId
   * @param {{characterId?: number|null, name?: string, transport?: 'legacy'|'livekit', canPublish?: boolean}} [opts]
   */
  function attach(actorId, opts = {}) {
    state.ensure(actorId, { characterId: opts.characterId ?? null });

    if (opts.transport === 'legacy') {
      state.setConnectionState(actorId, CONNECTION_STATES.CONNECTED);
      metrics.count('core.attach.legacy');
      markCritical(actorId, 'attach');
      return { ok: true, session: null, transport: 'legacy', evicted: null };
    }

    const opened = sessions.open(actorId, {
      ...opts,
      canPublish: opts.canPublish !== undefined ? opts.canPublish : publishGrantFor(opts.characterId ?? null)
    });

    if (opened.evicted) {
      // Despejo da sessão superada. `forget` primeiro para que o diff do
      // próximo recompute não tente desassinar um participante que já saiu.
      routes.forget(actorId);
      Promise.resolve(gateway.removeParticipant(opened.evicted)).catch(() => {});
      metrics.count('core.evicted');
    }

    markCritical(actorId, 'attach');
    return opened;
  }

  /**
   * Tira um ator da cena de voz: desconexão, logout, cleanup.
   *
   * Ordem deliberada — `forget` antes de `close`. Ao contrário, o diff do
   * próximo recompute produziria unsubscribes citando uma identidade que já não
   * existe: chamada redundante contra um participante que saiu.
   *
   * @param {number} actorId
   * @param {string} [reason]
   */
  function detach(actorId, reason = 'detach') {
    // Antes de tudo: a boca fecha. Sai daqui um `speaking=false` para quem
    // estivesse ouvindo, e a animação para. Depois de `state.remove` a política
    // já não sabe quem é este ator, e um `sweep` posterior não teria como
    // decidir nada sobre ele — a limpeza precisa acontecer enquanto ele existe.
    speaking.forget(actorId);
    speechAnimation.forget(actorId);
    routes.forget(actorId);
    const closed = sessions.close(actorId, reason);
    state.remove(actorId);
    lastSample.delete(actorId);

    if (closed.identity) {
      Promise.resolve(gateway.removeParticipant(closed.identity)).catch(() => {});
    }

    metrics.count(`core.detach.${reason}`);
    markCritical(actorId, 'detach');
    return closed;
  }

  /**
   * A permissão DURÁVEL de publicar deste personagem, para o token.
   *
   * Só o silêncio de staff entra aqui. Morte, mordaça, abatimento e PTT também
   * decidem se sai voz, e **nenhum deles** deve virar permissão de token: são
   * estados que mudam em segundos, e reemitir token a cada um seria um handshake
   * WebRTC por morte. Eles continuam sendo rota — que é o mecanismo desenhado
   * para mudar rápido.
   *
   * O silêncio de staff é diferente em espécie: dura horas ou até alguém
   * desfazer, é uma punição, e é exatamente o caso em que a degradação do
   * gateway (circuito aberto) não pode devolver a voz.
   *
   * @param {number|null} characterId
   */
  function publishGrantFor(characterId) {
    if (!Number.isFinite(characterId)) return true;
    try {
      return !conditions.conditionsOf(characterId).includes(VOICE_CONDITIONS.STAFF_MUTED);
    } catch {
      // Um adapter que lança não pode calar ninguém. Falha de leitura vira
      // "pode falar", e a rota continua sendo a camada que decide de verdade —
      // negar por erro de leitura silenciaria inocentes sem registro nenhum.
      return true;
    }
  }

  /** Identidade LiveKit de um ator, para o gateway traduzir arestas. */
  function identityOf(actorId) {
    const session = sessions.get(actorId);
    return session ? session.identity : null;
  }

  /**
   * Reemite o token da sessão com a permissão durável recalculada.
   *
   * Chamado quando a staff cala ou descala alguém que **já está conectado**. Sem
   * isto, `/calar` só valeria a partir da próxima conexão — e a rota, que é o
   * corte primário, continuaria sendo a única defesa (a que o circuito aberto
   * desliga).
   *
   * Devolve `{ok: false}` sem barulho quando não há sessão LiveKit: no caminho
   * legado não existe token, e o silêncio é aplicado pela rota, que já foi
   * recalculada por `markCritical`. Não é falha; é outro transporte.
   *
   * @param {number} actorId
   * @returns {{ok: boolean, canPublish?: boolean, token?: string, url?: string, reason?: string}}
   */
  function refreshGrants(actorId) {
    const session = sessions.get(actorId);
    if (!session) return { ok: false, reason: 'sem sessão' };
    const canPublish = publishGrantFor(session.characterId);
    const renewed = sessions.renew(actorId, { canPublish });
    // A rota é recalculada de qualquer jeito: ela é o corte que age no tick
    // seguinte, enquanto o token novo só vale quando o cliente o apresentar.
    markCritical(actorId, 'grants');
    if (!renewed.ok) return { ok: false, canPublish, reason: renewed.reason };
    return { ok: true, canPublish, token: renewed.token, url: renewed.url };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Intenções do cliente — sempre validadas antes de virar estado
  // ───────────────────────────────────────────────────────────────────────────

  /** @param {number} actorId @param {unknown} mode */
  function requestVoiceMode(actorId, mode) {
    const result = policy.requestVoiceMode(actorId, mode);
    // Só recalcula quando mudou de verdade. Um cliente reafirmando o modo que
    // já vale não deve custar um recompute — é o mesmo princípio do diff.
    if (result.ok && result.changed) markCritical(actorId, 'voiceMode');
    return result;
  }

  /** @param {number} actorId @param {boolean} muted */
  function requestMute(actorId, muted) {
    const result = policy.requestMute(actorId, muted);
    if (muted === true) speaking.clear(actorId);
    if (result.changed) markCritical(actorId, 'mute');
    return result;
  }

  /** @param {number} actorId */
  function pttDown(actorId) {
    const result = policy.pttDown(actorId);
    if (result.ok && result.changed) markCritical(actorId, 'pttDown');
    return result;
  }

  /** @param {number} actorId */
  function pttUp(actorId) {
    const result = policy.pttUp(actorId);
    // Soltar a tecla fecha a boca no MESMO instante, sem esperar o sweep. O
    // sweep é a rede de segurança para o que não avisa; o PTT avisa.
    speaking.clear(actorId);
    if (result.changed) markCritical(actorId, 'pttUp');
    return result;
  }

  /**
   * Um quadro de áudio chegou deste ator. Chamado pelo transporte a ~50 Hz.
   *
   * Devolve `false` quando a política recusa — e nesse caso o transporte
   * também não deve retransmitir. É a mesma pergunta que `audienceFor` faz;
   * expor as duas separadas seria abrir a chance de o relay perguntar uma e
   * animar pela outra.
   *
   * @param {number} actorId
   * @param {number} [level] 0..1, se algum dia o cliente medir e mandar
   */
  function noteAudioFrame(actorId, level) {
    return speaking.noteFrame(actorId, level);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Consulta
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Audiência de um locutor. É o que o relay consulta a cada quadro.
   *
   * Devolve `[]` para quem não pode falar mesmo que a última rota diga o
   * contrário: entre um recompute e o quadro seguinte o PTT pode ter sido
   * solto, e a tabela é de até um tick atrás. Consultar a política aqui custa
   * um `Map.get` e fecha a janela em que a voz sairia depois de a pessoa
   * soltar a tecla.
   *
   * @param {number} actorId
   */
  function audienceFor(actorId) {
    if (!policy.canSpeak(actorId).ok) return [];
    return audienceBySpeaker.get(actorId) || [];
  }

  /**
   * A audiência do último recompute, **sem** perguntar à política.
   *
   * Existe para um caso só, e é o caso em que `audienceFor` não serve: avisar
   * que alguém PAROU de falar. A parada quase sempre é a própria razão de a
   * política agora recusar — PTT solto, mute, morte — e `audienceFor` devolveria
   * `[]` justamente quando há gente para avisar. O resultado seria uma boca
   * aberta congelada em quem estava ouvindo.
   *
   * Não substitui `audienceFor` em lugar nenhum: aqui não se entrega áudio, se
   * entrega um `false`.
   *
   * @param {number} actorId
   */
  function lastAudienceFor(actorId) {
    return audienceBySpeaker.get(actorId) || [];
  }

  /**
   * O que um ouvinte recebe, no formato do `proximity_update`.
   *
   * `dir` é um vetor **unitário no referencial do ouvinte**, não uma posição:
   * a atenuação por distância continua sendo do servidor e mora em `volume`.
   * Ver `voice-spatial.js` para por que essa separação é obrigatória.
   */
  function peersFor(actorId) {
    const routeMap = routesByListener.get(actorId);
    if (!routeMap) return [];
    return [...routeMap.entries()].map(([speaker, route]) => ({
      actorId: speaker,
      volume: route.volume,
      effect: route.effect,
      dir: route.dir,
      speaking: speaking.isSpeaking(speaker)
    }));
  }

  /** Parâmetros dos efeitos, para viajarem UMA vez no handshake. */
  function effects() {
    return effectSettings();
  }

  /** @param {(routesByListener: Map<number, Map<number, {volume: number, effect: string, dir: number[]|null}>>, result: object) => void} cb */
  function onRoutes(cb) {
    routeSubscribers.push(cb);
    return () => {
      const i = routeSubscribers.indexOf(cb);
      if (i >= 0) routeSubscribers.splice(i, 1);
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Laço
  // ───────────────────────────────────────────────────────────────────────────

  function start() {
    if (_timer) return _timer;
    _timer = setInterval(() => {
      try {
        recompute('tick');
      } catch (err) {
        // O laço não morre. Um tick perdido é um tick; um laço morto é a voz
        // congelada em quem estava perto de quem no instante da exceção.
        metrics.count('core.tickError');
        logger.error(`[voice-core] Tick falhou: ${err.message}`);
      }
    }, tickMs);
    if (typeof _timer.unref === 'function') _timer.unref();
    logger.log(`[voice-core] Tick espacial a cada ${tickMs} ms (bucket ${index.bucketSize} u).`);
    return _timer;
  }

  function stop() {
    if (_timer) clearInterval(_timer);
    _timer = null;
    _criticalPending = false;
    _criticalScheduled = false;
  }

  /** Limpeza completa: sessões fora, rotas zeradas, estado vazio. */
  function shutdown(reason = 'shutdown') {
    stop();
    speechAnimation.clearAll();
    speaking.clearAll();
    const identities = sessions.closeAll(reason);
    for (const identity of identities) {
      Promise.resolve(gateway.removeParticipant(identity)).catch(() => {});
    }
    routes.reset();
    state.clear();
    index.clear();
    lastSample.clear();
    audienceBySpeaker = new Map();
    routesByListener = new Map();
    metrics.count('core.shutdown');
    return identities.length;
  }

  /** Fotografia do sistema inteiro, para log de diagnóstico e para o relatório. */
  function describe() {
    return {
      tickMs,
      running: _timer !== null,
      actors: state.size(),
      sessions: sessions.size(),
      subscriptions: routes.subscriptionCount(),
      spatial: index.describe(),
      spatialAudio: spatialEnabled,
      occlusion: occlusion.describe(),
      speaking: speaking.describe(),
      speechAnimation: speechAnimation.describe(),
      gateway: gateway.describe(),
      metrics: metrics.snapshot()
    };
  }

  return {
    // laço
    start, stop, shutdown, recompute, markCritical, sample,
    // ciclo de vida
    attach, detach, identityOf, refreshGrants, publishGrantFor,
    // intenções do cliente
    requestVoiceMode, requestMute, pttDown, pttUp, noteAudioFrame,
    // consulta
    audienceFor, lastAudienceFor, peersFor, onRoutes, describe, effects,
    // módulos, para quem precisar do de baixo (teste, diagnóstico)
    state, policy, index, routes, sessions, gateway, metrics,
    conditions, occlusion, speaking, speechAnimation,
    tickMs
  };
}

/** Deslocamento maior que o limiar entre duas amostras? */
function jumped(a, b, threshold) {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return (dx * dx + dy * dy + dz * dz) > (threshold * threshold);
}

module.exports = {
  createVoiceCore,
  DEFAULT_TICK_MS,
  DEFAULT_TELEPORT_THRESHOLD,
  DEFAULT_MIN_CRITICAL_INTERVAL_MS,
  CONNECTION_STATES
};
