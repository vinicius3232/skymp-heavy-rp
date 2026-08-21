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

// ─────────────────────────────────────────────────────────────────────────────
// Diagnóstico de runtime — ENABLE_MINING_RUNTIME_DIAGNOSTICS
//
// Existe só para a homologação registrada em
// docs/research/MINING_RUNTIME_VALIDATION_REPORT.md: correlacionar, por uma
// única linha de log por estágio, o que o cliente reportou como alvo, o que
// `mp.get(formId,'locationalData')` devolveu de verdade em servidor real, o
// resultado da checagem de ferramenta e o resultado de `consume()` — sem
// precisar instrumentar cada arquivo na hora do teste manual.
//
// Mesmo padrão de flag do resto do projeto (`process.env.X === 'true'`, ver
// `voip-service.js` e `VOIP_DEBUG_EXPOSE_TICKET`). Desligado por padrão: como
// todo módulo `lab`, isto não deve rodar em produção — é andaime de teste, não
// gameplay. Não muda NENHUM resultado de `canSee`/`execute`; só observa.
//
// `correlationId` agrupa as linhas de uma mesma tentativa de minerar: gerado
// uma vez por `execute()`, carregado em todo `_diag()` daquela chamada. Não
// loga posição/coordenada do jogador em texto (só do alvo, que é público —
// veio de mineração não é dado sensível de personagem).
function _diagnosticsEnabled() {
  return process.env.ENABLE_MINING_RUNTIME_DIAGNOSTICS === 'true';
}

function _diag(correlationId, stage, payload) {
  if (!_diagnosticsEnabled()) return;
  console.log(`[mining:diag] ${correlationId} ${stage} ${JSON.stringify(payload)}`);
}

function _newCorrelationId(characterId) {
  return `mine-${characterId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

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
    canSee: async ctx => {
      const no = await _nodeAt(ctx.target.formId);
      if (_diagnosticsEnabled()) {
        _diag('n/a', 'target_received', { formId: `0x${ctx.target.formId.toString(16)}`, targetType: ctx.target.type });
        _diag('n/a', 'target_resolved', { nodeFound: Boolean(no), rawNode: no || null });
      }
      return Boolean(no);
    },
    execute: async ctx => {
      const correlationId = _newCorrelationId(ctx.characterId);
      _diag(correlationId, 'execute_start', {
        characterId: ctx.characterId,
        actorId: `0x${ctx.actorId.toString(16)}`,
        targetFormId: `0x${ctx.target.formId.toString(16)}`,
        requestId: ctx.requestId || null
      });

      if (activeGatherers.has(ctx.characterId)) {
        _diag(correlationId, 'blocked_concurrent', {});
        return { message: 'Você já está ocupado fazendo algo.' };
      }

      const temPicareta = _hasPickaxe(ctx.actorId);
      _diag(correlationId, 'tool_check', { hasPickaxe: temPicareta, source: 'Actor.GetItemCount (client-trusted, só decide inicio)' });
      if (!temPicareta) {
        return { message: 'Você precisa de uma picareta.' };
      }

      const formDesc = _formDescOf(ctx.target.formId);
      _diag(correlationId, 'form_desc_resolved', { formDesc });
      if (!formDesc) return { message: FAILURE_MESSAGES.not_found };

      activeGatherers.add(ctx.characterId);
      try {
        const resultado = await resourceNodeService.consume({
          characterId: ctx.characterId,
          actorId: ctx.actorId,
          formDesc
        });
        _diag(correlationId, 'resource_node_consume', { ok: resultado.ok, code: resultado.code || null, data: resultado.data || null });

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
          _diag(correlationId, 'profession_xp_granted', { professionCode: PROFESSION_CODE, amount: xpPorColeta });
        }

        return {
          message: `Você minerou ${resultado.data.yield}x (restam ${resultado.data.capacity}/${resultado.data.maxCapacity} no veio).`,
          data: resultado.data
        };
      } finally {
        activeGatherers.delete(ctx.characterId);
        _diag(correlationId, 'execute_end', {});
      }
    }
  });
}

/**
 * Confere, por reflexão real do VM Papyrus do servidor (`mp._sp3ListMethods`,
 * `[UPSTREAM CODE]` `ScampServer::SP3ListMethods` → `GetPapyrusVm().ListMethods`),
 * se `GetItemCount` está registrado nas classes que `_hasPickaxe` chama.
 *
 * Existe para responder em milissegundos, sem precisar de um jogador
 * conectado nem de teste manual, a pergunta que
 * `docs/research/SKYMP_INTEGRATION_AUDIT.md` (achado nº 5, `BOUND-006`)
 * deixou em aberto: `Actor.GetItemCount` está mesmo disponível neste
 * servidor, do jeito que ele está configurado hoje (`archives` vazio,
 * `skymp/server/data/scripts/` sem `Actor.pex`)? Isto distingue
 * **PAPYRUS FUNCTION NOT AVAILABLE** (a classe/método não está no VM — é
 * questão de configuração de archive, resolve-se carregando o `.pex`) de
 * **PAPYRUS FUNCTION AVAILABLE BUT CALL FAILED** (o método existe, o problema
 * é outro — argumento errado, `self` inválido, etc.) — as duas produzem o
 * mesmo sintoma para quem só olha o resultado de `_hasPickaxe`, mas pedem
 * correção completamente diferente.
 *
 * Só roda com a flag de diagnóstico ligada — é reflexão, não gameplay, e
 * `_sp3*` só existe em servidor real (sem `mp`, não há o que checar).
 */
function _diagnoseItemCountAvailability() {
  if (!_diagnosticsEnabled()) return;
  if (typeof mp === 'undefined' || typeof mp._sp3ListMethods !== 'function') {
    _diag('boot', 'itemcount_availability_check_skipped', { reason: 'mp._sp3ListMethods indisponivel (sem mp real, ou versao do SkyMP sem introspeccao _sp3)' });
    return;
  }
  for (const className of ['Actor', 'ObjectReference']) {
    try {
      const methods = mp._sp3ListMethods(className) || [];
      const registrado = methods.includes('GetItemCount');
      _diag('boot', 'itemcount_availability_check', { className, registrado, totalMetodos: methods.length });
    } catch (err) {
      _diag('boot', 'itemcount_availability_check_error', { className, error: err.message });
    }
  }
}

function initMiningService() {
  registerMiningInteractions();
  _diagnoseItemCountAvailability();
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
  activeGatherers,
  _diagnoseItemCountAvailability
};
