/**
 * core/economy-physical-sync.js
 *
 * **Anti-cheat, não sincronização de saldo.** `characters.gold` (via
 * `core/transaction-service.js`/`core/economy-service.js`) é a única fonte de
 * verdade do dinheiro do jogador e **nunca** existiu como `Gold001` físico no
 * inventário do Skyrim — `addGold`/`removeGold` (`transaction-service.js`
 * linhas 516-584) nunca chamam `_applyToClient`, diferente de `giveItem`/
 * `removeItem`, que aplicam item de verdade. Ouro neste projeto é 100%
 * virtual, de propósito.
 *
 * ─── Por que este arquivo existe, então ─────────────────────────────────────
 *
 * O brief original pedia "sincronização física: o servidor corrige o
 * inventário quando diverge do banco". Isso pressupõe ouro dual-representado
 * — exatamente o modelo que este projeto **não** usa, e tornar ouro físico
 * abriria a superfície que esta tarefa existe para fechar (ouro arrastável,
 * largável, vendável a um NPC vanilla sem passar pelo ledger). Confirmado com
 * o dono do produto antes de implementar.
 *
 * O que sobra de útil é o inverso: se `Gold001` aparece no inventário de um
 * personagem, isso não pode ter vindo de nenhum caminho legítimo deste
 * gamemode — é evidência de injeção externa (cheat engine, editor de save,
 * exploit de outro mod). `reconcileOnLogin` verifica isso uma vez por login,
 * remove o item físico (nunca mexe em `characters.gold` — o saldo real nunca
 * esteve errado) e deixa rastro em `audit_logs` para a staff investigar.
 *
 * ─── Por que só no login, não em heartbeat ──────────────────────────────────
 *
 * Uma chamada Papyrus custa 13-35ms (`docs/technical/PAPYRUS_USAGE_POLICY.md`
 * linha 142). Rodar isto em loop para todo jogador oneraria o mesmo orçamento
 * que `docs/CONSTITUICAO.md` §A.5 já alerta para NPCs. Login é o momento de
 * maior valor por menor custo: é exatamente quando um personagem editado
 * offline (save alterado, item injetado enquanto desconectado) entra no
 * mundo pela primeira vez nesta sessão.
 */

'use strict';

const moduleRegistry = require('./module-registry');
const papyrus = require('./skymp-adapter/papyrus-catalog');
const { actorRef } = require('./papyrus');
const database = require('../database');

const MODULE_ID = 'economy-physical-sync';

/**
 * FormID de `Gold001` — item base do Skyrim.esm. Constante vanilla universal
 * (não um FormDesc de célula/base específico de save; é o mesmo em todo
 * mundo Skyrim, é literalmente o exemplo que `player.additem f 100` ensina em
 * qualquer tutorial de console do jogo). Número, não string — não cai na
 * guarda de `scripts/check-write-guards.js` (que fiscaliza FormDesc em campos
 * de célula, não FormID numérico de item).
 */
const GOLD_BASE_ID = 0x0000000f;

/** @param {object} dependencies */
function _deps(dependencies = {}) {
  return {
    db: dependencies.db || database,
    moduleRegistry: dependencies.moduleRegistry || moduleRegistry,
    mp: dependencies.mp !== undefined ? dependencies.mp : (typeof mp !== 'undefined' ? mp : undefined),
    logger: dependencies.logger || console
  };
}

function _isModuleEnabled(deps) {
  return deps.moduleRegistry.isEnabled(MODULE_ID);
}

async function _auditAnomaly(deps, { actorId, characterId, count }) {
  try {
    await deps.db.query(
      'INSERT INTO audit_logs (action, actor_account_id, target_account_id, details) VALUES (?, ?, ?, ?)',
      [
        'economy:physical_gold_anomaly',
        null,
        null,
        JSON.stringify({ characterId, actorId: actorId != null ? actorId.toString(16) : null, removedCount: count })
      ]
    );
  } catch (err) {
    deps.logger.error(`[economy-physical-sync] Falha ao gravar audit_logs (anomalia não perdida, só não registrada): ${err.message}`);
  }
}

/**
 * Verifica e corrige `Gold001` físico no inventário de um personagem recém-
 * logado. Nunca lança, nunca bloqueia login — mesmo padrão de
 * `grantStartingGold` em `whitelist.js`.
 * @param {number} actorId
 * @param {number} characterId
 * @param {object} [dependencies]
 */
async function reconcileOnLogin(actorId, characterId, dependencies = {}) {
  const deps = _deps(dependencies);
  if (!_isModuleEnabled(deps)) return;
  if (typeof deps.mp === 'undefined' || !deps.mp) return;

  if (!papyrus.isKnownPapyrusFunction('method', 'ObjectReference', 'GetItemCount')) {
    deps.logger.warn('[economy-physical-sync] ObjectReference.GetItemCount não está em papyrus-catalog.js — anti-cheat de ouro físico inativo.');
    return;
  }

  let count;
  try {
    count = deps.mp.callPapyrusFunction('method', 'ObjectReference', 'GetItemCount', actorRef(actorId), [GOLD_BASE_ID]);
  } catch (err) {
    deps.logger.error(`[economy-physical-sync] Falha ao ler GetItemCount para ${characterId}: ${err.message}`);
    return;
  }

  if (!Number.isFinite(count) || count <= 0) return;

  deps.logger.warn(
    `[economy-physical-sync] Ouro físico anômalo detectado: char=${characterId} actor=${actorId != null ? actorId.toString(16) : '?'} count=${count}. ` +
    'Nenhum caminho legítimo deste gamemode concede Gold001 físico — removendo e registrando em audit_logs.'
  );

  try {
    if (papyrus.isKnownPapyrusFunction('method', 'ObjectReference', 'RemoveItem')) {
      deps.mp.callPapyrusFunction('method', 'ObjectReference', 'RemoveItem', actorRef(actorId), [GOLD_BASE_ID, count, true, null]);
    }
  } catch (err) {
    deps.logger.error(`[economy-physical-sync] Falha ao remover Gold001 físico de ${characterId}: ${err.message}`);
  }

  await _auditAnomaly(deps, { actorId, characterId, count });
}

function healthCheck() {
  return true;
}

module.exports = {
  MODULE_ID,
  GOLD_BASE_ID,
  reconcileOnLogin,
  healthCheck
};
