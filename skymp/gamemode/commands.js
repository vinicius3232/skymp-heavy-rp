const db = require('./database');
const identity = require('./identity-service');
const { createRpChatService } = require('./rp-chat-service');
const commandRegistry = require('./core/command-registry');
const characterState = require('./core/character-state');
const inventoryService = require('./inventory-service');

// Cache em memoria dos personagens ativos no servidor
// Chave: actorId (number), Valor: { characterId, firstName, lastName, accountId, profileId }
const activeCharacters = new Map();

function registerActiveCharacter(actorId, character, accountId, profileId) {
  activeCharacters.set(actorId, {
    characterId: character.id,
    firstName: character.first_name,
    lastName: character.last_name,
    accountId: accountId,
    profileId: profileId
  });
  console.log(`[commands] Cached character name for actor ${actorId.toString(16)}: ${character.first_name} ${character.last_name}`);
  identity.loadKnownIdentities(character.id);
}

function getActiveCharacterData(actorId) {
  return activeCharacters.get(actorId) || null;
}

/**
 * actorIds com personagem carregado, agora.
 *
 * O `death-service` responde a mesma pergunta varrendo até 50 profileIds com
 * `mp.getActorsByProfileId` — o que custa uma ida à API por profileId e devolve
 * também quem não tem personagem. Este mapa já sabe a resposta exata e de graça:
 * ele é escrito no login e limpo no `removeActiveCharacter`.
 *
 * Devolve cópia: quem itera não pode segurar referência para o Map interno, que
 * é mutado por login e logout no meio de qualquer laço.
 */
function listActiveActorIds() {
  return [...activeCharacters.keys()];
}

function getActiveActorByCharacterId(characterId) {
  for (const [actorId, character] of activeCharacters.entries()) {
    if (character.characterId === characterId) {
      return actorId;
    }
  }
  return null;
}

function removeActiveCharacter(actorId) {
  if (activeCharacters.has(actorId)) {
    const char = activeCharacters.get(actorId);
    console.log(`[commands] Removed cached character for actor ${actorId.toString(16)}: ${char.firstName} ${char.lastName}`);
    identity.forgetKnownIdentities(char.characterId);
    characterState.cleanup(char.characterId);
    inventoryService.clearSyncCache(char.characterId);

    // O staffCache do admin-service e chaveado por actorId, nao por conta — e o
    // SkyMP reaproveita actorId entre sessoes. Sem limpar aqui, o cargo ficava
    // preso ao slot: quem entrasse depois no mesmo actorId herdava `ban`,
    // `set_gold` e `retire_character` de um admin que ja tinha saido.
    // `registerStaffRole` so e chamado no login (whitelist.js), entao nada
    // reescrevia a entrada obsoleta pra um jogador comum.
    //
    // require preguicoso pelo mesmo motivo dos handlers de staff abaixo:
    // admin-service requer este modulo no topo, entao importar la em cima
    // fecharia o ciclo.
    require('./admin-service').removeStaffRole(actorId);

    // Mesma classe de problema, mesmo motivo de require preguicoso
    // (death-service requer este modulo no topo): `_lastHealth` guarda a ultima
    // leitura de vida por actorId, e o slot reaproveitado fazia o primeiro tick
    // do jogador seguinte virar um `damage_spike` falso no contexto de morte —
    // evidencia de RDM contra quem nao levou golpe nenhum. Ver a explicacao
    // completa em death-service.cleanup().
    require('./death-service').cleanup(actorId);

    // A alma em cache e chaveada por characterId, entao nao sofre do
    // reaproveitamento de slot — mas cache que so cresce e vazamento, e reler no
    // proximo login custa uma query. Atras do isEnabled porque o soul-service
    // lanca no boot quando falta SOUL_SECRET: com a flag desligada, nem o
    // require acontece.
    if (require('./core/module-registry').isEnabled('soul')) {
      require('./soul-service').cleanup(char.characterId);
    }

    activeCharacters.delete(actorId);
  }
}

function getCharacterName(actorId) {
  if (activeCharacters.has(actorId)) {
    const char = activeCharacters.get(actorId);
    return `${char.firstName} ${char.lastName}`;
  }
  return `Player_${actorId.toString(16)}`;
}

function getDisplayNameForObserver(sourceActorId, observerActorId) {
  const sourceCharacter = getActiveCharacterData(sourceActorId);
  const observerCharacter = getActiveCharacterData(observerActorId);
  return identity.getDisplayName(observerCharacter, sourceCharacter);
}

async function logRpChatEvent(event) {
  const details = JSON.stringify({
    type: event.type,
    actorId: `0x${event.actorId.toString(16)}`,
    characterId: event.characterId || null,
    message: event.message,
    radius: event.radius
  });

  try {
    await db.query(
      'INSERT INTO audit_logs (action, actor_account_id, target_account_id, details) VALUES (?, ?, ?, ?)',
      [`rp_chat:${event.type}`, event.accountId || null, null, details]
    );
  } catch (err) {
    console.log(`[rp-chat-log] ${details}`);
  }
}

// Envia uma notificação PRIVADA (só a tela do próprio actorId) via o canal
// browserModal (isVisibleByOwner=true, isVisibleByNeighbors=false — ver
// phase0-basic.js). Antes disso usava Debug.Notification 'global', que a
// engine transmite pra TODOS os clientes conectados — vazando ficha
// criminal, inventário revistado e mensagens de staff pra tela de todo
// mundo. Renderizado como toast pela UI (index.html: handleServerModal).
function sendNotification(actorId, message) {
  if (typeof mp === 'undefined') return;
  try {
    mp.set(actorId, 'browserModal', { type: 'toast', data: { message }, sentAt: Date.now() });
  } catch (err) {
    console.error(`[commands] Failed to send notification to actor ${actorId.toString(16)}:`, err.message);
  }
}

// Transmite a mensagem para o autor e vizinhos dentro de um raio de proximidade
function renderMessageForRecipient(message, recipientActorId) {
  return typeof message === 'function' ? message(recipientActorId) : message;
}

function broadcastProximityMessage(sourceActorId, message, radius = 1500) {
  const logMessage = typeof message === 'function' ? message(sourceActorId) : message;
  console.log(`[chat-log] Broadcast: "${logMessage}"`);
  
  // 1. Mostrar para o próprio autor
  sendNotification(sourceActorId, renderMessageForRecipient(message, sourceActorId));

  if (typeof mp === 'undefined') return;

  // 2. Mostrar para os vizinhos
  try {
    const neighbors = mp.get(sourceActorId, 'neighbors') || [];
    const sourceLoc = mp.get(sourceActorId, 'locationalData');
    if (!sourceLoc || !sourceLoc.pos) return;
    
    const sourcePos = sourceLoc.pos;
    const sourceCell = sourceLoc.cellOrWorldSpaceId || sourceLoc.cellId || sourceLoc.worldOrCell;

    for (const neighborId of neighbors) {
      if (mp.get(neighborId, 'type') === 'MpActor' && neighborId !== sourceActorId) {
        const neighborLoc = mp.get(neighborId, 'locationalData');
        if (neighborLoc && neighborLoc.pos) {
          const neighborCell = neighborLoc.cellOrWorldSpaceId || neighborLoc.cellId || neighborLoc.worldOrCell;
          if (sourceCell && neighborCell && sourceCell !== neighborCell) {
            continue;
          }

          const neighborPos = neighborLoc.pos;
          
          // Distância Euclidiana 3D
          const dx = sourcePos[0] - neighborPos[0];
          const dy = sourcePos[1] - neighborPos[1];
          const dz = sourcePos[2] - neighborPos[2];
          const distance = Math.sqrt(dx*dx + dy*dy + dz*dz);
          
          if (distance <= radius) {
            sendNotification(neighborId, renderMessageForRecipient(message, neighborId));
          }
        }
      }
    }
  } catch (err) {
    console.error(`[commands] Failed to broadcast message:`, err.message);
  }
}

const rpChat = createRpChatService({
  getCharacterName,
  getDisplayName: getDisplayNameForObserver,
  getCharacterData: getActiveCharacterData,
  sendNotification,
  broadcastProximityMessage,
  logEvent: logRpChatEvent
});

function parseActorId(raw) {
  if (!raw) return NaN;
  const normalized = raw.toLowerCase().startsWith('0x') ? raw.slice(2) : raw;
  return Number.parseInt(normalized, 16);
}

// ─────────────────────────────────────────────────────────────────────────────
// Comandos CORE (sempre ativos, independente de módulos)
// ─────────────────────────────────────────────────────────────────────────────

async function handleIntroduceCommand(actorId, args) {
  const targetActorId = parseActorId(args);
  const sourceCharacter = getActiveCharacterData(actorId);
  const targetCharacter = getActiveCharacterData(targetActorId);

  if (!sourceCharacter) {
    sendNotification(actorId, 'Seu personagem ainda nao esta carregado.');
    return;
  }
  if (!targetCharacter || targetActorId === actorId) {
    sendNotification(actorId, 'Uso correto: /apresentar <actorId>');
    return;
  }

  const realName = identity.getCharacterFullName(sourceCharacter);
  await identity.upsertKnownIdentity(
    targetCharacter.characterId,
    sourceCharacter.characterId,
    realName,
    'introduced'
  );
  await identity.auditIdentityEvent(
    sourceCharacter.accountId,
    targetCharacter.accountId,
    'identity:introduce',
    `sourceCharacterId=${sourceCharacter.characterId} targetCharacterId=${targetCharacter.characterId}`
  );

  sendNotification(actorId, `Voce se apresentou para ${getDisplayNameForObserver(targetActorId, actorId)}.`);
  sendNotification(targetActorId, `${realName} se apresentou a voce.`);
  broadcastProximityMessage(
    actorId,
    (observerActorId) => `* ${getDisplayNameForObserver(actorId, observerActorId)} se apresenta.`,
    450
  );
}

async function handleAliasCommand(actorId, args) {
  const parts = args.split(' ');
  const targetActorId = parseActorId(parts[0]);
  const alias = identity.sanitizeDisplayName(parts.slice(1).join(' '));
  const sourceCharacter = getActiveCharacterData(actorId);
  const targetCharacter = getActiveCharacterData(targetActorId);

  if (!sourceCharacter || !targetCharacter || targetActorId === actorId || !alias) {
    sendNotification(actorId, 'Uso correto: /apelido <actorId> <nome conhecido>');
    return;
  }

  await identity.upsertKnownIdentity(
    sourceCharacter.characterId,
    targetCharacter.characterId,
    alias,
    'alias'
  );
  await identity.auditIdentityEvent(
    sourceCharacter.accountId,
    targetCharacter.accountId,
    'identity:alias',
    `observerCharacterId=${sourceCharacter.characterId} targetCharacterId=${targetCharacter.characterId} alias=${alias}`
  );

  sendNotification(actorId, `Voce passara a reconhecer essa pessoa como: ${alias}.`);
}

// Comandos de Staff (CORE — disponíveis independente de módulos)
function registerCoreCommands() {
  commandRegistry.register(['/apresentar', '/introduce'], (actorId, args) => {
    handleIntroduceCommand(actorId, args).catch(err => {
      console.error('[identity] Failed to introduce character:', err.message);
      sendNotification(actorId, 'Nao foi possivel registrar a apresentacao.');
    });
  }, { module: 'identity', phase: 'core', description: 'Apresenta seu personagem a outro', usage: '/apresentar <actorId>' });

  commandRegistry.register(['/apelido', '/alias'], (actorId, args) => {
    handleAliasCommand(actorId, args).catch(err => {
      console.error('[identity] Failed to set alias:', err.message);
      sendNotification(actorId, 'Nao foi possivel registrar o apelido.');
    });
  }, { module: 'identity', phase: 'core', description: 'Define como você reconhece outra pessoa', usage: '/apelido <actorId> <nome>' });

  commandRegistry.register('/anim', (actorId, args) => {
    if (args) {
      const parts = args.split(' ');
      const adminService = require('./admin-service');
      adminService.playAnimation(actorId, parseInt(parts[0], 16), parts[1] || 'IdleStop');
    }
  }, { module: 'admin', phase: 'core', description: '[Staff] Reproduz animação em ator', usage: '/anim <actorId> <animName>' });

  commandRegistry.register('/additem', (actorId, args) => {
    if (args) {
      const parts = args.split(' ');
      require('./admin-service').giveItemAdmin(actorId, parseInt(parts[0], 16), parseInt(parts[1], 16), parseInt(parts[2]) || 1);
    }
  }, { module: 'admin', phase: 'core', description: '[Staff] Entrega item a jogador', usage: '/additem <actorId> <baseId> <count>' });

  commandRegistry.register('/tp', (actorId, args) => {
    if (args) require('./admin-service').teleportTo(actorId, parseInt(args, 16));
  }, { module: 'admin', phase: 'core', description: '[Staff] Teleporta para jogador', usage: '/tp <actorId>' });

  commandRegistry.register('/kick', (actorId, args) => {
    if (args) {
      const parts = args.split(' ');
      const reason = parts.slice(1).join(' ') || 'Sem motivo';
      require('./admin-service').kickPlayer(actorId, parseInt(parts[0], 16), reason);
    }
  }, { module: 'admin', phase: 'core', description: '[Staff] Expulsa jogador', usage: '/kick <actorId> <motivo>' });

  commandRegistry.register('/permakill', (actorId, args) => {
    if (args) {
      const parts = args.split(' ');
      const reason = parts.slice(1).join(' ');
      require('./admin-service').retireCharacter(actorId, parseInt(parts[0], 16), reason);
    }
  }, { module: 'admin', phase: 'core', description: '[Staff] Encerra um personagem permanentemente (soft-delete)', usage: '/permakill <actorId> <motivo>' });

  commandRegistry.register('/setgold', (actorId, args) => {
    if (args) {
      const parts = args.split(' ');
      require('./admin-service').setGold(actorId, parseInt(parts[0], 16), parseInt(parts[1]));
    }
  }, { module: 'admin', phase: 'core', description: '[Staff] Define ouro de jogador', usage: '/setgold <actorId> <valor>' });

  // Alias técnico em inglês pelo mesmo padrão de /apresentar → /introduce.
  // `parseActorId` (e não `parseInt(args, 16)` como os outros de staff) porque
  // este é o comando que a staff digita copiando um id de um log ou do painel,
  // onde ele aparece com o prefixo `0x`.
  commandRegistry.register(['/revelaridentidade', '/revealidentity'], (actorId, args) => {
    const targetActorId = parseActorId(args);
    if (!Number.isFinite(targetActorId)) {
      sendNotification(actorId, 'Uso correto: /revelaridentidade <actorId>');
      return;
    }
    require('./admin-service').revealIdentity(actorId, targetActorId).catch(err => {
      console.error('[identity] Falha ao revelar identidade:', err.message);
      sendNotification(actorId, '[Staff] Nao foi possivel revelar a identidade.');
    });
  }, { module: 'admin', phase: 'core', description: '[Staff] Revela o nome real de um personagem (auditado)', usage: '/revelaridentidade <actorId>' });

  // /status — diagnóstico de estado do personagem (staff)
  commandRegistry.register('/status', (actorId, args) => {
    const charData = getActiveCharacterData(actorId);
    if (!charData) return;
    const state = characterState.get(charData.characterId);
    const meta = characterState.getMetadata(charData.characterId);
    sendNotification(actorId, `[Staff] Estado: ${state} | ${JSON.stringify(meta)}`);
  }, { module: 'admin', phase: 'core', description: '[Staff] Exibe estado atual do personagem', usage: '/status' });
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler principal de input do chat
// ─────────────────────────────────────────────────────────────────────────────

function handleChatInput(actorId, text) {
  if (!text || typeof text !== 'string') return;

  // 1. Tentar o rp-chat-service (comandos /falar, /me, /do, etc.)
  if (rpChat.handleChatInput(actorId, text)) {
    return;
  }

  // 2. Tentar o command-registry (comandos de módulos)
  if (text.startsWith('/')) {
    const parts = text.split(' ');
    const command = parts[0].toLowerCase();
    const args = parts.slice(1).join(' ');

    const handled = commandRegistry.dispatch(actorId, command, args);
    if (!handled) {
      sendNotification(actorId, `Comando desconhecido: ${command}`);
    }
    return;
  }

  // 3. Chat padrão (falar no local)
  const charName = getCharacterName(actorId);
  broadcastProximityMessage(actorId, `${charName} diz: ${text}`, 1200);
}

// Registrar comandos CORE ao carregar o módulo
registerCoreCommands();

module.exports = {
  registerActiveCharacter,
  removeActiveCharacter,
  getActiveCharacterData,
  getActiveActorByCharacterId,
  listActiveActorIds,
  handleChatInput,
  broadcastProximityMessage,
  sendNotification
};
