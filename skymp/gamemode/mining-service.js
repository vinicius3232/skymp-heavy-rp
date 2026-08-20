/**
 * mining-service.js
 *
 * **Minerador MVP.** O primeiro consumidor real do Profession Core e do
 * Resource Node Framework — e o primeiro módulo do projeto a registrar uma
 * interação de alvo `object` no `core/interaction-registry.js`.
 *
 * ─── Como a checagem de distância deixou de ser um gap ───────────────────────
 *
 * A primeira versão deste arquivo tinha `/minerar <formDesc>` como comando de
 * chat: o jogador digitava o FormDesc à mão, e nada verificava se ele estava
 * perto do veio. Esse comando nunca existiu por acidente — era a forma mais
 * simples de entregar profissão + ferramenta + entrega atômica + XP,
 * deixando a distância documentada como gap bloqueante até este módulo poder
 * usar o Interaction Framework (`docs/gameplay/MINING.md` §1, versão anterior).
 *
 * A correção não foi "adicionar uma checagem de distância" — foi trocar a
 * interface errada pela certa. `core/interaction-targets.js` agora resolve
 * alvo `object`: o CLIENTE reporta o FormId do que está mirando (não uma
 * string digitada), o `core/interaction-service.js` mede a distância com
 * `target.assertRange` (o mesmo mecanismo genérico que já protegia `player`)
 * ANTES de `execute` rodar, e só resolve a ação se o veio estiver dentro de
 * `mining.maxDistance`.
 *
 * ⚠️ **`mp.get(formId, 'locationalData')` contra uma `MpObjectReference`
 * comum é [DOC] em `types/mp.d.ts`, mas nunca foi validado em jogo por este
 * projeto** (decisão tomada com o usuário: confiar na documentação oficial e
 * implementar, marcando como assumido). Validar manualmente em servidor real
 * antes de tirar `ENABLE_MINING_SERVICE` do desligado por padrão.
 *
 * ─── O que É real aqui ───────────────────────────────────────────────────────
 *
 * - Distância via Interaction Framework (`mining.maxDistance`, ver acima).
 * - Menu só mostra "Minerar" se o FormId mirado tiver uma linha ativa em
 *   `resource_nodes` (`canSee`) — mas quem decide de verdade é sempre
 *   `resource-node-service.consume()`, revalidado no `execute`.
 * - Checa ferramenta (picareta) via `Actor.GetItemCount` — client-trusted só
 *   para decidir se a ação COMEÇA, nunca o que o jogador recebe (mesma
 *   ressalva que `jobs-service.js` já documentava para o machado de lenhador).
 * - Entrega do minério é 100% `resource-node-service.consume()`, que já é
 *   atômico com o decremento do nó (nenhum item nasce fora do banco). O gate
 *   de profissão/rank também é dele — não duplicado aqui.
 * - Anti-spam por `characterId` (não `actorId`, que é slot reciclável) — mesmo
 *   padrão de `jobs-service.activeGatherers`.
 */

'use strict';

const professionService = require('./profession-service');
const resourceNodeService = require('./resource-node-service');
const serverOptions = require('./core/server-options');
const interactionRegistry = require('./core/interaction-registry');
const { actorRef } = require('./core/papyrus');

const MODULE = 'mining';
const PROFESSION_CODE = 'miner';

// Mesmo FormID que jobs-service.js (PARKED) já usava — vetado por aquela
// rodada, não reinventado aqui.
const ITEM_PICKAXE = 0x000e3c16;

/**
 * Chaveado por `characterId`, nunca por `actorId` — o SkyMP reaproveita
 * `actorId` entre sessões, e a chave errada já produziu bug real neste
 * projeto (ver o comentário equivalente em `jobs-service.js` e em
 * `commands.js:activeCharacters`).
 * @type {Set<number>}
 */
const activeGatherers = new Set();

const FAILURE_MESSAGES = Object.freeze({
  depleted: 'Este veio está esgotado. Volte mais tarde.',
  node_disabled: 'Este veio não está disponível.',
  not_found: 'Não há nada para minerar aqui.',
  profession_required: 'Você precisa ser Minerador para isso.',
  rank_too_low: 'Seu rank de Minerador ainda não é suficiente para este veio.',
  invalid_character: 'Personagem inválido.',
  invalid_form_desc: 'Alvo inválido.'
});

/**
 * `mp.getDescFromId` é [USO] mas já é a forma padrão deste gamemode de
 * converter FormId→FormDesc (ver `core/papyrus.js`); sem `mp`, não há como
 * saber o FormDesc, e o chamador trata `null` como "não é um veio".
 * @param {number} formId
 * @returns {string|null}
 */
function _formDescOf(formId) {
  if (typeof mp === 'undefined') return null;
  return mp.getDescFromId(formId);
}

/**
 * @param {number} formId
 * @returns {Promise<object|null>}
 */
async function _nodeAt(formId) {
  const formDesc = _formDescOf(formId);
  if (!formDesc) return null;
  return resourceNodeService.getNode(formDesc);
}

/**
 * Client-trusted só para decidir se a ação COMEÇA — o que o jogador recebe é
 * inteiramente decidido por `resource-node-service.consume()`, no banco.
 * @param {number} actorId
 * @returns {boolean}
 */
function _hasPickaxe(actorId) {
  if (typeof mp === 'undefined') return true;
  const count = mp.callPapyrusFunction('method', 'Actor', 'GetItemCount', actorRef(actorId), [ITEM_PICKAXE]);
  return count > 0;
}

/**
 * Registra `mining.mine` no Interaction Framework. Chamado do `initialize()`
 * do módulo — precisa do framework pronto, daí `dependencies: ['interaction']`
 * em `phase0-basic.js`.
 */
function registerMiningInteractions() {
  interactionRegistry.register({
    id: 'mining.mine',
    module: MODULE,
    target: interactionRegistry.TARGET_TYPES.OBJECT,
    label: 'Minerar',
    // Alcance físico do veio, medido pelo servidor via `target.assertRange`
    // antes de `execute` rodar — é isto que fecha o gap de distância.
    distance: serverOptions.get('mining.maxDistance'),
    audit: interactionRegistry.AUDIT_LEVELS.ECONOMY,
    // Só aparece no menu se o FormId mirado for de fato um veio ativo. Quem
    // decide de verdade continua sendo `consume()`, revalidado abaixo.
    canSee: async ctx => Boolean(await _nodeAt(ctx.target.formId)),
    execute: async ctx => {
      if (activeGatherers.has(ctx.characterId)) {
        return { message: 'Você já está ocupado fazendo algo.' };
      }
      if (!_hasPickaxe(ctx.actorId)) {
        return { message: 'Você precisa de uma picareta.' };
      }

      const formDesc = _formDescOf(ctx.target.formId);
      if (!formDesc) return { message: FAILURE_MESSAGES.not_found };

      activeGatherers.add(ctx.characterId);
      try {
        const resultado = await resourceNodeService.consume({
          characterId: ctx.characterId,
          actorId: ctx.actorId,
          formDesc
        });

        if (!resultado.ok) {
          return { message: FAILURE_MESSAGES[resultado.code] || 'Não foi possível minerar agora.' };
        }

        const xpPorColeta = serverOptions.get('mining.xpPerGather');
        if (xpPorColeta > 0) {
          await professionService.addProfessionXp({
            characterId: ctx.characterId,
            professionCode: PROFESSION_CODE,
            amount: xpPorColeta,
            context: 'mining_gather'
          });
        }

        return {
          message: `Você minerou ${resultado.data.yield}x (restam ${resultado.data.capacity}/${resultado.data.maxCapacity} no veio).`,
          data: resultado.data
        };
      } finally {
        activeGatherers.delete(ctx.characterId);
      }
    }
  });
}

function initMiningService() {
  registerMiningInteractions();
}

/** Espelha o padrão de `market-stalls-service.shutdownMarketStallsService`. */
function shutdownMiningService() {
  interactionRegistry.unregisterModule(MODULE);
}

module.exports = {
  MODULE,
  PROFESSION_CODE,
  ITEM_PICKAXE,
  initMiningService,
  shutdownMiningService,
  registerMiningInteractions,
  FAILURE_MESSAGES,
  // Exposto só para teste.
  activeGatherers
};
