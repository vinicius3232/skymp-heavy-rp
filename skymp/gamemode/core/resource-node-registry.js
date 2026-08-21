/**
 * core/resource-node-registry.js
 *
 * O vocabulário de tipos de nó de recurso, e nada além disso.
 *
 * ─── Por que isto NÃO é um catálogo rico, ao contrário de profession-registry ──
 *
 * `core/profession-registry.js` guarda treze entradas nomeadas porque
 * "minerador" e "lenhador" têm identidade própria — label, categoria — que se
 * repete em todo personagem que a tem. Um nó de recurso não: um veio de ferro e
 * um veio de prata são o mesmo TIPO (`ORE`) com configuração diferente
 * (capacidade, regeneração, item entregue), e essa configuração mora na
 * INSTÂNCIA (`resource_nodes`, em `resource-node-service.js`), não num
 * catálogo de tipos.
 *
 * Criar uma segunda camada de catálogo aqui — "veio de ferro", "veio de
 * prata", cada um com label e regras — duplicaria o que a linha do banco já
 * guarda, pelo mesmo motivo que `migration-v18-professions.sql` não criou uma
 * tabela `professions`: catálogo sem grau de liberdade a mais é espelho, não
 * abstração.
 *
 * O que precisa ser fechado é só a CATEGORIA (§7 do briefing de profissões:
 * "ORE, TREE, HERB, CROP, FISHING") — fechada porque `resource-node-service.js`
 * decide comportamento por ela (hoje, só validação; no futuro, talvez efeito
 * sonoro ou animação por categoria), e uma categoria livre teria o mesmo
 * destino que `details TEXT` já teve em `audit_logs`: quatro grafias para a
 * mesma coisa.
 */

'use strict';

/**
 * As cinco categorias planejadas no briefing original. Nova categoria entra
 * aqui, sob revisão — é a mesma decisão de design de `core/audit-event
 * .CATEGORIES` e de `core/profession-registry.CATEGORIES`.
 */
const NODE_TYPES = Object.freeze({
  ORE: 'ORE',
  TREE: 'TREE',
  HERB: 'HERB',
  CROP: 'CROP',
  FISHING: 'FISHING'
});

/** @type {Set<string>} */
const VALID_NODE_TYPES = new Set(Object.values(NODE_TYPES));

/** @param {unknown} type */
function isValidType(type) {
  return typeof type === 'string' && VALID_NODE_TYPES.has(type);
}

module.exports = {
  NODE_TYPES,
  VALID_NODE_TYPES,
  isValidType
};
