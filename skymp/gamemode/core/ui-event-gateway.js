/**
 * Ponte testavel entre a CEF (browser embutido no cliente) e o gamemode.
 *
 * ─── `mp.onUiEvent` nunca existiu — BOUND-004 ───────────────────────────────
 *
 * Ate 20/08/2026 este arquivo fazia `mpApi.onUiEvent = gateway`. O SkyMP
 * **nunca chama essa property** — busca em `skymp5-client/src`,
 * `skymp5-server/cpp`, `skymp5-front/src` e `skymp5-functions-lib/src` por
 * `onUiEvent`: zero ocorrencias, confirmado duas vezes (14/08 e 20/08/2026,
 * a segunda direto contra o `main` do upstream via `gh api`). Ver
 * `docs/research/SKYMP_INTEGRATION_AUDIT.md` §5 (`BOUND-004`) para a
 * investigacao completa. Ate aqui, `ui-event-router`, `ui-event-rate-limiter`,
 * os schemas de `governance`/`player-panel` e o menu de interacao inteiro
 * estavam ligados a um callback morto — nenhum evento da CEF jamais chegava
 * ao servidor pelo caminho normal.
 *
 * O caminho real, documentado oficialmente
 * (`docs/skyrim_platform/browser.md` upstream) e tres saltos:
 *
 *   1. **CEF -> cliente.** A pagina chama `window.skyrimPlatform.sendMessage(...)`.
 *      O Skyrim Platform emite o evento `browserMessage`, com os argumentos
 *      em `e.arguments`.
 *   2. **Cliente -> servidor.** `mp.makeEventSource('_onUiEvent', <snippet>)`
 *      injeta um trecho que roda no cliente, assina `ctx.sp.on('browserMessage', ...)`
 *      e repassa via `ctx.sendEvent(...)`.
 *   3. **Servidor -> gamemode.** O SkyMP dispara `mp._onUiEvent(pcFormId, ...args)`
 *      — nome de evento customizado TEM que comecar com `_`.
 *
 * Mesma tecnica ja usada em `core/hit-events.js` para `_onHitReported` —
 * `mp.makeEventSource` esta confirmada num servidor real desde 06/08/2026
 * (ver cabecalho daquele arquivo). O snippet de cliente daqui, como o de la,
 * **nao foi exercitado contra CEF real** nesta correcao — so a parte
 * server-side (registro do event source + despacho) tem teste automatizado.
 *
 * `ui/index.html` foi corrigido junto: `sendUiEvent` mandava
 * `window.mp.trigger(...)`/`window.mp.send(...)` — `window.mp` nao e injetado
 * na CEF do SkyMP (a busca por `window.mp` no upstream so aparece em
 * `skymp5-front`, o painel administrativo separado, nao no cliente de jogo).
 * Passou a usar `window.skyrimPlatform.sendMessage({ type, data })` — um
 * unico argumento, para que `ctx.sendEvent(...e.arguments)` repasse o
 * envelope inteiro como `args[0]` do lado do servidor.
 *
 * Este modulo continua sem conhecer `mp`, banco ou gameplay: recebe as
 * dependencias e devolve o callback — a diferenca e so onde ele e pendurado.
 */

/**
 * @param {{
 *   uiEventRouter: {isValidEventEnvelope: Function, dispatch: Function},
 *   handleChatInput: Function,
 *   rateLimiter?: {observe: Function},
 *   logger?: Pick<Console, 'log'|'warn'|'error'>
 * }} dependencies
 * @returns {(actorId: number, uiEvent: unknown) => boolean}
 */
function createUiEventGateway({ uiEventRouter, handleChatInput, rateLimiter, logger = console }) {
  if (!uiEventRouter || typeof uiEventRouter.isValidEventEnvelope !== 'function' || typeof uiEventRouter.dispatch !== 'function') {
    throw new Error('[ui-event-gateway] uiEventRouter invalido');
  }
  if (typeof handleChatInput !== 'function') {
    throw new Error('[ui-event-gateway] handleChatInput invalido');
  }
  if (rateLimiter && typeof rateLimiter.observe !== 'function') {
    throw new Error('[ui-event-gateway] rateLimiter invalido');
  }

  return (actorId, uiEvent) => {
    try {
      if (!uiEventRouter.isValidEventEnvelope(uiEvent)) {
        logger.warn(`[phase0] Ignoring malformed UI event from ${actorId.toString(16)}`);
        return false;
      }

      /** @type {{type: string, data?: unknown}} */
      const event = /** @type {any} */ (uiEvent);

      if (rateLimiter) {
        const result = rateLimiter.observe(actorId, event.type);
        if (!result || result.allowed !== true) {
          logger.warn(`[phase0] UI event rate limited from ${actorId.toString(16)}: type=${event.type}`);
          return false;
        }
      }

      // Nunca registrar o payload bruto: ele e controlado pelo cliente e pode
      // conter texto privado ou dados que nao sao necessarios para diagnostico.
      logger.log(
        `[phase0] onUiEvent callback from ${actorId.toString(16)}: ` +
        `type=${event.type} data=${describeEventData(event.data)}`
      );
      Promise.resolve(uiEventRouter.dispatch(actorId, event)).catch(err =>
        logger.error('[phase0] ui-event-router dispatch failed:', err.message)
      );

      if (event.type === 'cef::chat:send') {
        handleChatInput(actorId, event.data);
      }
      return true;
    } catch (err) {
      logger.error('[phase0] Error in onUiEvent:', err.message);
      return false;
    }
  };
}

/** Nome do event source — TEM que comecar com `_` (ActionListener::OnCustomEvent). */
const NOME_DO_EVENTO = '_onUiEvent';

/**
 * O trecho que roda NO CLIENTE, dentro do Skyrim Platform. Escrito como
 * string porque e isso que `makeEventSource` recebe — nada aqui tem acesso ao
 * escopo deste arquivo, so ao `ctx` que o SkyMP fornece.
 *
 * `e.arguments` e o array que `window.skyrimPlatform.sendMessage(...)` mandou
 * do lado da CEF. `ui/index.html` manda sempre UM argumento (o envelope
 * `{type, data}`), entao `...e.arguments` aqui vira sempre uma chamada de um
 * argumento so — e do lado do servidor `args[0]` e esse envelope.
 */
const SNIPPET_DO_CLIENTE = `
  ctx.sp.on('browserMessage', (e) => {
    try {
      ctx.sendEvent(...e.arguments);
    } catch (err) {
      // Erro aqui roda no cliente e nao tem pra onde ir — engolir e o mesmo
      // criterio de core/hit-events.js: derrubar o snippet mataria todo
      // evento de UI seguinte daquele jogador, nao so este.
    }
  });
`;

/**
 * Registra o event source `_onUiEvent` e liga o despacho a ele. Mantido
 * testavel sem precisar carregar o bootstrap inteiro — recebe `mpApi` em vez
 * de importar `mp` global.
 *
 * @param {{makeEventSource?: Function, [key: string]: any}} mpApi
 * @param {Parameters<typeof createUiEventGateway>[0]} dependencies
 * @returns {(actorId: number, uiEvent: unknown) => boolean} o gateway puro, para teste direto
 */
function installUiEventGateway(mpApi, dependencies) {
  if (!mpApi || typeof mpApi !== 'object') throw new Error('[ui-event-gateway] mp invalido');
  const gateway = createUiEventGateway(dependencies);
  const logger = (dependencies && dependencies.logger) || console;

  if (typeof mpApi.makeEventSource !== 'function') {
    logger.warn('[ui-event-gateway] mp.makeEventSource indisponivel — nenhum evento de UI sera recebido.');
    return gateway;
  }

  mpApi.makeEventSource(NOME_DO_EVENTO, SNIPPET_DO_CLIENTE);
  mpApi[NOME_DO_EVENTO] = (pcFormId, ...args) => gateway(pcFormId, args[0]);
  return gateway;
}

/**
 * Devolve somente a categoria de um payload recebido da UI, sem vazar seu
 * conteudo nos logs do servidor.
 * @param {unknown} data
 * @returns {string}
 */
function describeEventData(data) {
  if (data === undefined) return 'absent';
  if (data === null) return 'null';
  if (Array.isArray(data)) return 'array';
  return typeof data;
}

module.exports = { createUiEventGateway, installUiEventGateway, NOME_DO_EVENTO, SNIPPET_DO_CLIENTE };
