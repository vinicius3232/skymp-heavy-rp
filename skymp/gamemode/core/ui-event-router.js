/**
 * core/ui-event-router.js
 *
 * Roteamento centralizado de eventos vindos da UI (CEF) para os módulos.
 * Substitui o hardcode de um handler chamando um único módulo por vez. O
 * evento chega até aqui via `core/ui-event-gateway.js`, que recebe da CEF
 * por `mp.makeEventSource('_onUiEvent', ...)` — não por `mp.onUiEvent`
 * (property que o SkyMP nunca chamou; ver BOUND-004 no cabeçalho daquele
 * arquivo e em `docs/research/SKYMP_INTEGRATION_AUDIT.md` §5).
 *
 * Cada módulo registra um prefixo (a parte do uiEvent.type antes do primeiro ':'),
 * ex: 'governance:interaction:actions' → prefixo 'governance'.
 *
 * Uso:
 *   uiEventRouter.register('governance', governance.handleUiEvent);
 *   uiEventRouter.register('panel', playerPanel.handleUiEvent);
 *   ...
 *   uiEventRouter.dispatch(actorId, uiEvent); // despacha para todos os handlers registrados
 *
 * Um handler retorna true se tratou o evento.
 *
 * ─── O despacho a todos os handlers foi removido (13/08/2026) ───────────────
 *
 * Até aqui, `dispatch` chamava o handler do prefixo e **depois todos os
 * outros**, incondicionalmente. O comentário original chamava isso de
 * compatibilidade com eventos `governance:interaction:*` tratados por handlers
 * que não seguiam o próprio prefixo.
 *
 * Aquele caso não existe mais: os dois handlers registrados hoje
 * (`governance-service` e `player-panel-service`) só agem sobre o próprio
 * prefixo, e os dois recusam o resto com `return false` — a proteção era a boa
 * educação de cada handler, não o roteador. O custo era real: **todo módulo com
 * UI via o payload de todo evento de UI de todo jogador**, e o preço de cada
 * evento crescia com o número de módulos, não com o de eventos.
 *
 * Foi o que a auditoria classificou como REFACTOR
 * (`docs/research/CORE_FRAMEWORK_AUDIT.md` §3): não era falha de segurança —
 * nenhum handler agia sobre evento alheio —, era a superfície onde a próxima
 * nasceria, e o acoplamento que o Interaction Framework existe para eliminar.
 *
 * Um evento sem dono agora é registrado uma vez por tipo, e não a cada
 * ocorrência: o `type` é escolhido pelo cliente, e um log por evento seria um
 * jeito de encher o disco do servidor de fora.
 */

// Mapa de prefixo → handler(actorId, uiEvent) => boolean | Promise<boolean>
const _handlers = new Map();
const MAX_EVENT_TYPE_LENGTH = 128;

// Tipos já reportados como sem dono. Limitado para que um cliente hostil não
// transforme o diagnóstico em vazamento de memória.
const _semDono = new Set();
const MAX_TIPOS_SEM_DONO_REPORTADOS = 64;

/**
 * Valida o envelope minimo que cruza a fronteira CEF -> gamemode.
 *
 * Isto nao valida o `data`: cada modulo e dono do schema do seu comando.
 * O objetivo aqui e impedir que um payload malformado chegue a handlers que
 * assumem `uiEvent.type` como string.
 *
 * @param {unknown} uiEvent
 * @returns {boolean}
 */
function isValidEventEnvelope(uiEvent) {
  /** @type {{ type?: unknown } | null} */
  const event = uiEvent && typeof uiEvent === 'object' && !Array.isArray(uiEvent)
    ? uiEvent
    : null;

  return Boolean(
    event &&
    typeof event.type === 'string' &&
    event.type.length > 0 &&
    event.type.length <= MAX_EVENT_TYPE_LENGTH
  );
}

/**
 * Registra um handler para um prefixo de evento.
 * @param {string} prefix - Prefixo do uiEvent.type (ex: 'governance', 'panel')
 * @param {Function} handler - async (actorId, uiEvent) => boolean
 */
function register(prefix, handler) {
  if (!prefix) throw new Error('[ui-event-router] Handler sem prefixo');
  if (typeof handler !== 'function') throw new Error(`[ui-event-router] Handler '${prefix}' inválido`);
  _handlers.set(prefix, handler);
}

/**
 * Remove um handler registrado.
 * @param {string} prefix
 */
function unregister(prefix) {
  _handlers.delete(prefix);
}

/**
 * Despacha um uiEvent para o handler cujo prefixo bate com uiEvent.type.
 *
 * Só para ele. Um evento sem handler registrado para o seu prefixo não é
 * oferecido a mais ninguém — ver a nota no topo deste arquivo.
 *
 * @param {number} actorId
 * @param {object} uiEvent - { type: string, data?: object }
 * @returns {Promise<boolean>} true se o handler tratou o evento
 */
async function dispatch(actorId, uiEvent) {
  if (!isValidEventEnvelope(uiEvent)) return false;

  const prefix = uiEvent.type.split(':')[0];
  const handler = _handlers.get(prefix);

  if (!handler) {
    if (!_semDono.has(prefix) && _semDono.size < MAX_TIPOS_SEM_DONO_REPORTADOS) {
      _semDono.add(prefix);
      console.warn(`[ui-event-router] Nenhum handler registrado para o prefixo '${prefix}' (primeira ocorrência).`);
    }
    return false;
  }

  try {
    // A exceção de um handler não sobe até o gateway: lá em cima ela viraria um
    // `return false` genérico e o nome do módulo culpado se perderia.
    return Boolean(await handler(actorId, uiEvent));
  } catch (err) {
    console.error(`[ui-event-router] Erro no handler '${prefix}':`, err.message);
    return false;
  }
}

function list() {
  return Array.from(_handlers.keys());
}

module.exports = { register, unregister, dispatch, list, isValidEventEnvelope };
