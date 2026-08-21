const db = require('./database');
const commands = require('./commands');
const inventoryService = require('./inventory-service');
const adminService = require('./admin-service');
const characterState = require('./core/character-state');
const serverOptions = require('./core/server-options');
const transactionService = require('./core/transaction-service');
// NOTA: nenhum módulo PARKED é importado aqui. Eles são inicializados
// exclusivamente pelo module-registry quando a flag ENABLE_* correspondente
// está ligada — importar direto no boot os faria rodar sem passar pelo registry.

function allowLocalAutoWhitelist(profileId) {
  if (process.env.NODE_ENV === 'production') return false;
  if (process.env.ALLOW_LOCAL_AUTOWHITELIST !== 'true') return false;
  return profileId === 1 || profileId === 2;
}

// In online mode, SkyMP gets `profileId` from `user.id` in the Master API.
// Our Master API deliberately returns `accounts.id`; it is not a Discord ID.
function accountIdFromProfileId(profileId) {
  const accountId = Number(profileId);
  return Number.isSafeInteger(accountId) && accountId > 0 ? accountId : null;
}

/**
 * Concede o ouro inicial (`economy.startingGold`) uma única vez por personagem.
 *
 * A garantia de "uma vez só" vem da `idempotency_key` UNIQUE de
 * `gold_transactions`: a chave é derivada do characterId, então a segunda
 * tentativa é ignorada pelo próprio `transaction-service`. Sem isso, o ouro
 * seria concedido a cada login e viraria uma fonte infinita de dinheiro —
 * exatamente o tipo de coisa que a economia server-authoritative existe pra
 * impedir.
 *
 * Personagens criados pelo painel (`apps/web`) nascem com o default do banco;
 * é aqui, no primeiro spawn, que a opção de gameplay é aplicada.
 */
async function grantStartingGold(characterId) {
  const startingGold = serverOptions.get('economy.startingGold');
  if (startingGold <= 0) return;

  try {
    await transactionService.addGold({
      characterId,
      amount: startingGold,
      reason: 'starting_gold',
      module: 'whitelist',
      idempotencyKey: `starting_gold:${characterId}`
    });
  } catch (err) {
    // Não bloqueia o spawn: entrar sem o ouro inicial é um problema pequeno
    // perto de não conseguir entrar.
    console.error(`[whitelist] Falha ao conceder ouro inicial para ${characterId}:`, err.message);
  }
}

/**
 * Deriva a alma e entrega o primeiro sinal (`SOUL_AFFINITY.md` §II.1).
 *
 * É aqui e não no `initialize()` do módulo porque o sinal é do **primeiro
 * spawn**, não do boot do servidor: "todo personagem recebe o primeiro sinal na
 * primeira sessão" resolve o problema mais mortal de servidor de RP, que não é
 * balanceamento — é a primeira hora ser vazia.
 *
 * O require é preguiçoso e atrás do `isEnabled`, pela mesma razão da nota no
 * topo deste arquivo: importar no topo faria o módulo carregar mesmo com
 * `ENABLE_SOUL_SERVICE` desligado, e o `soul-service` lança no boot quando falta
 * `SOUL_SECRET`. Com a flag desligada nada aqui roda, nem o require.
 *
 * Não bloqueia o spawn — mesma escolha do ouro inicial: entrar sem o sinal é um
 * problema pequeno perto de não conseguir entrar.
 */
async function revelarPrimeiroSinal(characterId) {
  const moduleRegistry = require('./core/module-registry');
  if (!moduleRegistry.isEnabled('soul')) return;

  try {
    await require('./soul-service').onFirstSpawn(characterId);
  } catch (err) {
    console.error(`[whitelist] Falha ao revelar o primeiro sinal para ${characterId}:`, err.message);
  }
}

async function checkWhitelist(userId, profileId, actorId) {
  try {
    console.log(`[whitelist] Running check for User:${userId}, Profile:${profileId}, Actor:${actorId.toString(16)}`);

    // 1. In online mode, profileId is the account id resolved by the Master API.
    // Never resolve it through discord_identities: that confuses two namespaces.
    const accountId = accountIdFromProfileId(profileId);
    if (!accountId) {
      console.log(`[whitelist] Invalid account profileId: ${profileId}. Kicking user ${userId}...`);
      if (typeof mp !== 'undefined') mp.kick(userId);
      return false;
    }

    let accountRows = await db.query(
      `SELECT a.id, a.status, a.vip_level 
       FROM accounts a
       WHERE a.id = ?`,
      [accountId]
    );

    let account = null;
    if (accountRows.length === 0) {
      if (!allowLocalAutoWhitelist(profileId)) {
        console.log(`[whitelist] Account not found for profileId: ${profileId}. Kicking user ${userId}...`);
        if (typeof mp !== 'undefined') mp.kick(userId);
        return false;
      }
      console.log(`[whitelist] Account not found for profileId: ${profileId}. Auto-registering local account...`);
      // Apenas para laboratório local. NUNCA em produção.
      await db.query(`INSERT INTO accounts (id, status) VALUES (?, 'active')`, [accountId]);
      await db.query(
        `INSERT INTO discord_identities (discord_id, account_id, username) VALUES (?, ?, ?)`,
        [profileId.toString(), accountId, `Player_${profileId}`]
      );
      account = { id: accountId, status: 'active', vip_level: 0 };
    } else {
      account = accountRows[0];
    }

    // 2. Verificar se a conta está ativa
    if (account.status !== 'active') {
      console.log(`[whitelist] Account ${account.id} is NOT active (status: ${account.status}). Kicking user ${userId}...`);
      if (typeof mp !== 'undefined') mp.kick(userId);
      return false;
    }

    // 3. Verificar aprovação de Whitelist
    let wlRows = await db.query(
      `SELECT status FROM whitelist_applications WHERE account_id = ? AND status = 'approved'`,
      [account.id]
    );

    if (wlRows.length === 0) {
      if (allowLocalAutoWhitelist(profileId)) {
        console.log(`[whitelist] Auto-approving whitelist application for profileId ${profileId}...`);
        await db.query(
          `INSERT INTO whitelist_applications (account_id, status, reviewer_notes) VALUES (?, 'approved', 'Auto-approved for local test')`,
          [account.id]
        );
      } else {
        console.log(`[whitelist] User ${userId} (profileId: ${profileId}) has no approved Whitelist. Kicking...`);
        if (typeof mp !== 'undefined') mp.kick(userId);
        return false;
      }
    }

    // 4. Personagem: resolve pelo bind da game_session (AUTH-003/CHR-001) —
    // não mais "o approved mais recente". A conta prova quem é a PESSOA; a
    // sessão, gravada por apps/game-api no momento do join da fila, fixa
    // qual PERSONAGEM. Ver migration-v19-game-session-character-bind.sql.
    let character = null;
    const boundRows = await db.query(
      `SELECT c.* FROM game_sessions gs
        JOIN characters c ON c.id = gs.character_id
       WHERE gs.account_id = ? AND gs.character_id IS NOT NULL
         AND gs.revoked_at IS NULL AND gs.expires_at > NOW()
       ORDER BY gs.last_resolved_at DESC, gs.id DESC LIMIT 1`,
      [account.id]
    );

    if (boundRows.length > 0) {
      character = boundRows[0];
    } else {
      // Rede de segurança de migração, não um segundo jeito permanente de
      // escolher personagem: cobre (a) sessões emitidas antes da
      // migration-v19 (sem bind, expiram sozinhas em horas) e (b) o
      // laboratório local, que nunca tem game_sessions porque é 100% offline.
      let charRows = await db.query(
        `SELECT * FROM characters WHERE account_id = ? AND status = 'approved' ORDER BY id DESC LIMIT 1`,
        [account.id]
      );

      if (charRows.length === 0) {
        if (allowLocalAutoWhitelist(profileId)) {
          const firstName = profileId === 2 ? 'Jarl' : 'Jon';
          const lastName = profileId === 2 ? 'Balgruuf' : 'Battleborn';
          console.log(`[whitelist] Auto-creating approved character: ${firstName} ${lastName}...`);
          const insertChar = await db.query(
            `INSERT INTO characters (account_id, first_name, last_name, status, pos_x, pos_y, pos_z, angle_z, cell_id)
             VALUES (?, ?, ?, 'approved', 35, -165, -189, 180, '0x162e2')`,
            [account.id, firstName, lastName]
          );
          character = {
            id: insertChar.insertId,
            first_name: firstName,
            last_name: lastName,
            pos_x: 35,
            pos_y: -165,
            pos_z: -189,
            angle_z: 180,
            cell_id: '0x162e2'
          };
        } else {
          console.log(`[whitelist] User ${userId} has no approved characters. Kicking...`);
          if (typeof mp !== 'undefined') mp.kick(userId);
          return false;
        }
      } else {
        character = charRows[0];
        if (!allowLocalAutoWhitelist(profileId)) {
          console.warn(
            `[whitelist] Conta ${account.id} sem game_session vinculada (AUTH-003) — ` +
            'usando o fallback de migração. Se isto persistir fora de uma janela de deploy, o bind em apps/game-api está quebrado.'
          );
        }
      }
    }

    console.log(`[whitelist] Whitelist check passed! Welcome, ${character.first_name} ${character.last_name}`);
    
    // Registrar na memória cache de comandos
    commands.registerActiveCharacter(actorId, character, account.id, profileId);

    // Registrar cargo de staff (carregado de staff_roles, não de vip_level)
    await adminService.registerStaffRole(actorId, account.id);
    
    // Inicializar máquina de estados (carrega IMPRISONED/RESTRAINED do banco)
    await characterState.initialize(character.id);

    await grantStartingGold(character.id);
    await revelarPrimeiroSinal(character.id);

    // 5. Atualizar posição do jogador in-game a partir do banco de dados
    if (typeof mp !== 'undefined' && actorId) {
      console.log(`[whitelist] Moving actor ${actorId.toString(16)} to db location: pos=[${character.pos_x}, ${character.pos_y}, ${character.pos_z}] cell=${character.cell_id}`);
      
      const locData = {
        pos: [character.pos_x, character.pos_y, character.pos_z],
        rot: [0, 0, character.angle_z],
        cellOrWorldDesc: character.cell_id
      };
      
      try {
        mp.set(actorId, 'locationalData', locData);
        mp.set(actorId, 'browserVisible', true);
        console.log(`[whitelist] Spawn locData applied successfully for ${character.first_name} ${character.last_name}`);
        
        // Sincroniza o Inventário do Banco de Dados para o Cliente (com reconciliação)
        await inventoryService.syncInventoryToClient(actorId, character.id);
        
      } catch (err) {
        console.error(`[whitelist] Failed to apply locationalData:`, err.message);
      }
    }

    return true;
  } catch (err) {
    console.error(`[whitelist] Exception checking whitelist for user ${userId}:`, err);
    if (typeof mp !== 'undefined') mp.kick(userId);
    return false;
  }
}

module.exports = {
  checkWhitelist,
  accountIdFromProfileId
};
