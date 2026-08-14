/**
 * admin-service.js
 * Comandos de Staff com auditoria obrigatória.
 *
 * IMPORTANTE: A autoridade de staff é derivada EXCLUSIVAMENTE da tabela `staff_roles`.
 * O campo `vip_level` em `accounts` é SOMENTE para monetização (VIP/Apoiador).
 * NUNCA usar vip_level como critério de permissão administrativa.
 */
const db = require('./database');
const commands = require('./commands');
const identity = require('./identity-service');
const moderationLog = require('./core/moderation-log');
// O registro COMPARTILHADO do processo. O Voice Core lê o mesmo; passá-lo entre
// os dois exigiria que o sistema de staff conhecesse o de voz, o que é a
// dependência na direção errada. Ver core/voice/voice-staff-mute.js.
const { sharedVoiceStaffMute: voiceStaffMute } = require('./core/voice/voice-staff-mute');
const { actorRef } = require('./core/papyrus');
const skymp = require('./core/skymp-adapter');

// Roles e permissões por nível
//
// `manage_recipes` existe separada de `add_item` de propósito. `add_item` é um
// ato pontual e auditado — "dê este item a este jogador", raio de alcance de uma
// pessoa. Uma receita é uma regra permanente que **todo** jogador usa, quantas
// vezes quiser: é uma casa da moeda, não um presente. Reaproveitar `add_item`
// para receita faria quem auditasse "quem pode add_item?" receber a resposta
// errada sobre quem pode reformar a economia de crafting — que é a mesma classe
// do nível numérico que esta tabela já pagou caro para eliminar: uma permissão
// que significa outra coisa que não o que o nome diz.
//
// `reveal_identity` (07/08/2026) nasce pelo mesmo critério e contra o mesmo
// candidato fácil. O óbvio seria pendurar a revelação de identidade em
// `view_audit` — "staff lendo registro" —, e é errado por duas razões
// independentes: `view_audit` significa ler o que a STAFF fez, não furar o
// anonimato de um JOGADOR, então quem auditasse "quem pode view_audit?"
// receberia a resposta errada sobre quem pode desmascarar; e `view_audit` é de
// moderador, então reaproveitá-la alargaria o poder para a linha de frente
// inteira sem que ninguém tivesse decidido isso.
//
// Fica em `admin`/`owner`, fora do moderador, pelo mesmo andar de `add_item`,
// `set_gold` e `retire_character`. O argumento não é o de patrimônio da §7.4 —
// revelar não move nada. É que **nenhuma outra ação de staff é irreversível do
// jeito que esta é**: um kick acaba quando a pessoa reconecta, ouro dado volta
// por outro `/setgold`, e até o `/permakill` é soft-delete. Uma identidade
// revelada não desrevela — ela passa a morar na cabeça de quem leu, e o
// `audit_logs` registra que aconteceu sem poder desfazer. O valor do sistema de
// anonimato é inversamente proporcional a quantas pessoas conseguem contorná-lo,
// e moderador é o cargo mais numeroso e menos filtrado.
//
// O que fica em aberto, no formato da PARKED_SERVICES_DECISION.md §7.4: se a
// operação real mostrar que denúncia de metagaming chega mais rápido do que
// admin responde, a resposta NÃO é dar `reveal_identity` ao moderador — é
// desenhar uma variante com escopo (revelar só quem é parte de uma denúncia
// aberta). Alargar o cargo resolveria a fila criando o problema que a permissão
// existe para evitar.
//
// `run_world_probe` (08/08/2026) cobre os instrumentos de observação da Fase 0 —
// `/censofauna` e `/sondacadaver`, as Peças 1 e 2 da §16 do
// `HOSTILE_MOB_ACTIVATION_DECISION.md`. Nasce pelo mesmo critério das duas
// acima, e contra o mesmo candidato fácil.
//
// O óbvio seria `view_audit` — "staff olhando o servidor" —, e é errado pela
// razão de sempre: `view_audit` significa ler o que a STAFF fez, não vasculhar o
// mundo nem escrever no inventário de um ator. Quem auditasse "quem pode
// view_audit?" receberia a resposta errada sobre quem pode esvaziar um cadáver.
//
// Fica fora do moderador porque uma das duas ferramentas **escreve**: a sonda
// esvazia o inventário do ator alvo para provar que a escrita funciona, e
// restaura em seguida. A restauração pode falhar. O censo, sozinho, seria
// inofensivo o bastante para moderador — mas separar em duas permissões daria a
// este projeto uma permissão a mais para justificar sem que ninguém tivesse
// pedido, e as duas ferramentas rodam na mesma sessão, pela mesma pessoa.
//
// `voice_mute` fica no MODERADOR, ao lado de `kick`. É a ferramenta de quem
// modera uma cena: silenciar quem está gritando por cima de todo mundo é
// menos grave que expulsar, e exigir um admin para isso faria a moderação
// escolher entre não fazer nada e expulsar. Ela não escreve no mundo nem no
// banco — o silêncio vive em memória (ver core/voice/voice-staff-mute.js).
const ROLE_PERMISSIONS = {
  moderator: ['kick', 'teleport', 'view_audit', 'manage_whitelist', 'voice_mute'],
  admin:     ['kick', 'teleport', 'view_audit', 'manage_whitelist', 'ban', 'add_item', 'set_gold', 'retire_character', 'manage_recipes', 'reveal_identity', 'run_world_probe', 'voice_mute'],
  owner:     ['kick', 'teleport', 'view_audit', 'manage_whitelist', 'ban', 'add_item', 'set_gold', 'manage_staff', 'retire_character', 'manage_recipes', 'reveal_identity', 'run_world_probe', 'voice_mute']
};

// Cache em memória: actorId → { role, permissions: Set<string> }
// Carregado na whitelist a partir da tabela staff_roles (não de vip_level)
const staffCache = new Map();

/**
 * Carrega o cargo de staff de uma conta a partir do banco.
 * Chamado no login pelo whitelist.js.
 *
 * @param {number} actorId
 * @param {number} accountId - ID da conta (não o vip_level!)
 */
async function registerStaffRole(actorId, accountId) {
  try {
    const rows = await db.query(
      `SELECT role FROM staff_roles WHERE account_id = ?`,
      [accountId]
    );

    if (rows.length === 0) {
      // Conta não tem cargo de staff
      return;
    }

    const role = rows[0].role;
    const permissions = new Set(ROLE_PERMISSIONS[role] || []);
    staffCache.set(actorId, { role, permissions });
    console.log(`[admin] Actor ${actorId.toString(16)} registrado como staff (role: ${role}, permissões: ${[...permissions].join(', ')})`);
  } catch (err) {
    console.error(`[admin] Erro ao carregar cargo de staff para account ${accountId}:`, err.message);
  }
}

/**
 * Remove o cache de staff ao desconectar.
 * @param {number} actorId
 */
function removeStaffRole(actorId) {
  staffCache.delete(actorId);
}

/** Toda permissão que existe, derivada dos cargos. Fonte da validação abaixo. */
const KNOWN_PERMISSIONS = new Set(Object.values(ROLE_PERMISSIONS).flat());

/**
 * Verifica se um ator tem uma permissão específica.
 *
 * @param {number} actorId
 * @param {string} permission - 'kick', 'ban', 'teleport', 'add_item', 'set_gold', etc.
 * @returns {boolean}
 *
 * Sobre a validação do argumento: doze chamadas nos módulos PARKED passam um
 * NÚMERO (`hasPermission(actorId, 20)`), herança de um modelo antigo de níveis
 * de staff. Como `permissions` é um `Set` de strings, `Set.has(20)` é sempre
 * `false` — a checagem "funcionava" no sentido de nunca explodir, e negava
 * tudo em silêncio.
 *
 * Um nome de permissão que não existe é igualmente perigoso na direção
 * oposta: quem escreve `hasPermission(actorId, 'manage_factions')` acha que
 * criou uma regra, e criou uma porta que nunca abre.
 *
 * Nos dois casos preferimos gritar no log a negar caladamente. Não lançamos
 * exceção porque isso derrubaria o comando do jogador por um erro de
 * programação — negar é o resultado seguro, o log é o que faz alguém corrigir.
 */
function hasPermission(actorId, permission) {
  if (typeof permission !== 'string') {
    console.error(
      `[admin] hasPermission recebeu ${typeof permission} (${JSON.stringify(permission)}) em vez de um nome de permissão. ` +
      `Provavelmente um nível numérico legado — use um destes: ${[...KNOWN_PERMISSIONS].join(', ')}. Negando.`
    );
    return false;
  }
  if (!KNOWN_PERMISSIONS.has(permission)) {
    console.error(
      `[admin] hasPermission recebeu a permissão desconhecida '${permission}'. ` +
      `Nenhum cargo a concede, então isso nega sempre. Conhecidas: ${[...KNOWN_PERMISSIONS].join(', ')}.`
    );
    return false;
  }

  const staff = staffCache.get(actorId);
  if (!staff) return false;
  return staff.permissions.has(permission);
}

/**
 * Retorna o cargo de staff de um ator, ou null se não for staff.
 * @param {number} actorId
 * @returns {string|null}
 */
function getRole(actorId) {
  const staff = staffCache.get(actorId);
  return staff ? staff.role : null;
}

/**
 * Registra uma ação de staff no audit_log.
 */
async function auditLog(actorAccountId, targetAccountId, action, details) {
  try {
    await db.query(
      'INSERT INTO audit_logs (action, actor_account_id, target_account_id, details) VALUES (?, ?, ?, ?)',
      [action, actorAccountId, targetAccountId || null, details || null]
    );
  } catch (err) {
    console.error('[admin] Failed to write audit_log:', err.message);
  }
}

/**
 * /anim [actorId] [animName] - Reproduz animação em ator (para eventos RP)
 * Permissão: 'teleport' (nível moderador+)
 */
async function playAnimation(actorId, targetActorId, animName) {
  if (!hasPermission(actorId, 'teleport')) {
    sendDenied(actorId);
    return;
  }
  if (typeof mp !== 'undefined') {
    mp.callPapyrusFunction('method', 'Actor', 'PlayIdle', actorRef(targetActorId), [animName]);
  }
  const charData = commands.getActiveCharacterData(actorId);
  const targetData = commands.getActiveCharacterData(targetActorId);
  await auditLog(
    charData?.accountId, targetData?.accountId,
    'staff:playAnimation',
    `role=${getRole(actorId)} anim=${animName} target=${targetActorId.toString(16)}`
  );
  console.log(`[admin] ${actorId.toString(16)} (${getRole(actorId)}) played animation '${animName}' on ${targetActorId.toString(16)}`);
}

/**
 * /additem [actorId] [baseId] [count] - Entrega item a jogador (eventos, testes)
 * Permissão: 'add_item' (nível admin+)
 */
async function giveItemAdmin(actorId, targetActorId, baseId, count) {
  if (!hasPermission(actorId, 'add_item')) {
    sendDenied(actorId);
    return;
  }
  const transactionService = require('./core/transaction-service');
  const targetChar = commands.getActiveCharacterData(targetActorId);
  if (!targetChar) {
    sendDenied(actorId);
    return;
  }

  // Confere o FormID contra os plugins carregados antes de gravar.
  //
  // `/additem <actorId> <baseId> <count>` recebe o baseId digitado à mão, em
  // hexadecimal, no meio de uma linha de chat. Um dígito errado cai em
  // qualquer record do jogo — uma célula, uma quest, um som — e antes disto o
  // servidor gravava `character_inventory` do mesmo jeito: o item nunca
  // aparecia in-game, mas ocupava linha no banco e no ledger, e ninguém
  // descobria até alguém conferir inventário à mão.
  //
  // A checagem só nega quando tem certeza (ver core/espm.js): se a API não
  // estiver disponível, deixa passar.
  const espm = require('./core/espm');
  const veredito = espm.pareceItem(baseId);
  if (!veredito.ok) {
    commands.sendNotification(actorId, `[Staff] Item invalido: ${veredito.motivo}.`);
    console.warn(`[admin] ${actorId.toString(16)} tentou dar 0x${baseId.toString(16)}: ${veredito.motivo}`);
    return;
  }

  const success = await transactionService.giveItem({
    actorId: targetActorId,
    characterId: targetChar.characterId,
    baseId,
    count,
    reason: 'admin_give',
    module: 'admin'
  });

  if (!success) {
    commands.sendNotification(actorId, '[Staff] Falha ao entregar item.');
    return;
  }

  const charData = commands.getActiveCharacterData(actorId);
  await auditLog(
    charData?.accountId, targetChar.accountId,
    'staff:addItem',
    `role=${getRole(actorId)} baseId=0x${baseId.toString(16)} count=${count}`
  );
  console.log(`[admin] ${actorId.toString(16)} (${getRole(actorId)}) gave 0x${baseId.toString(16)} x${count} to ${targetActorId.toString(16)}`);
}

/**
 * /tp [actorId] - Teleporta para jogador
 * Permissão: 'teleport'
 */
async function teleportTo(actorId, targetActorId) {
  if (!hasPermission(actorId, 'teleport')) {
    sendDenied(actorId);
    return;
  }
  if (typeof mp !== 'undefined') {
    const targetPos = mp.get(targetActorId, 'locationalData');
    if (targetPos) {
      mp.set(actorId, 'locationalData', targetPos);
    }
  }
  const charData = commands.getActiveCharacterData(actorId);
  await auditLog(charData?.accountId, null, 'staff:teleport', `role=${getRole(actorId)} target=${targetActorId.toString(16)}`);
}

/**
 * /kick [actorId] [motivo] - Expulsa jogador com motivo e audit
 * Permissão: 'kick'
 */
async function kickPlayer(actorId, targetActorId, reason) {
  if (!hasPermission(actorId, 'kick')) {
    sendDenied(actorId);
    return;
  }
  const charData = commands.getActiveCharacterData(actorId);
  const targetData = commands.getActiveCharacterData(targetActorId);
  await auditLog(charData?.accountId, targetData?.accountId, 'staff:kick', `role=${getRole(actorId)} reason=${reason}`);
  commands.sendNotification(targetActorId, `Você foi expulso: ${reason}`);
  if (typeof mp !== 'undefined') {
    setTimeout(() => {
      // `mp.kick` recebe `userId`, nao FormID; o adaptador converte. Ver
      // docs/research/SKYMP_INTEGRATION_AUDIT.md §6.
      if (typeof mp !== 'undefined') skymp.kick(targetActorId);
    }, 3000);
  }
  console.log(`[admin] ${actorId.toString(16)} (${getRole(actorId)}) kicked ${targetActorId.toString(16)}: ${reason}`);

  // Notificacao, nao registro: `audit_logs` acima ja e o registro. Nao e
  // `await`ado de proposito — o kick nao pode ficar lento nem falhar porque o
  // Discord esta fora. Ver core/moderation-log.js.
  moderationLog.notify({
    kind: 'kick',
    target: nomeParaLog(targetData, targetActorId),
    moderator: nomeParaLog(charData, actorId),
    reason
  });
}

/**
 * /setgold [actorId] [valor] - Define ouro de um jogador
 * Permissão: 'set_gold' (nível admin+)
 *
 * ─── Por que isto passou a ser um delta ─────────────────────────────────────
 *
 * A versão anterior fazia `UPDATE characters SET gold = ?` direto — sem
 * transação, sem `SELECT ... FOR UPDATE` e, principalmente, **sem linha em
 * `gold_transactions`**. Era o único caminho de dinheiro do gamemode que
 * escapava do ledger, e é exatamente o padrão que motivou apagar o
 * `economy-service.js` em 06/08/2026 (ver `CONTRIBUTING.md` §3.1 e
 * `PARKED_SERVICES_DECISION.md` §2).
 *
 * O custo não era teórico: `/setgold` é o comando que mais precisa de rastro.
 * Ouro que aparece na conta de um jogador sem nenhum registro de origem é
 * indistinguível de duplicação por bug — e a única pessoa capaz de fazer isso
 * é a staff, que é justamente de quem a auditoria precisa proteger o servidor.
 * O `audit_logs` registrava a intenção do comando; o ledger da economia não
 * registrava nada, então o saldo deixava de fechar com a soma das transações.
 *
 * `transaction-service` só move saldo por delta (é o que permite
 * `gold = gold + ?` sob lock, sem sobrescrever escrita concorrente). Um "set
 * absoluto" vira leitura + delta. A leitura fora da transação é aceitável aqui
 * e em nenhum outro lugar: se o saldo mudar entre o `getGold` e o
 * `addGold`/`removeGold`, o resultado é o valor pedido pela staff com um
 * desvio do tamanho da operação concorrente — e o ledger mostra as duas linhas,
 * então a divergência é visível em vez de silenciosa. Travar a linha por fora
 * exigiria expor a conexão do transaction-service, que é o encapsulamento que
 * mantém esse arquivo como o único lugar que sabe mexer em ouro.
 */
async function setGold(actorId, targetActorId, amount) {
  if (!hasPermission(actorId, 'set_gold')) {
    sendDenied(actorId);
    return;
  }
  const targetChar = commands.getActiveCharacterData(targetActorId);
  if (!targetChar) return;

  const alvo = Number(amount);
  if (!Number.isFinite(alvo) || alvo < 0) {
    // `parseInt(parts[1])` no handler devolve NaN pra `/setgold <id>` sem
    // valor. Antes isso virava `SET gold = NaN`, que o MySQL grava como 0 —
    // um erro de digitação zerava o patrimônio do jogador em silêncio.
    commands.sendNotification(actorId, '[Staff] Valor invalido. Uso: /setgold <actorId> <valor>');
    return;
  }

  const transactionService = require('./core/transaction-service');
  const saldoAtual = await transactionService.getGold(targetChar.characterId);
  const delta = alvo - saldoAtual;

  if (delta !== 0) {
    const ok = delta > 0
      ? await transactionService.addGold({
        characterId: targetChar.characterId,
        amount: delta,
        reason: 'staff_setgold',
        module: 'admin'
      })
      : await transactionService.removeGold({
        characterId: targetChar.characterId,
        amount: -delta,
        reason: 'staff_setgold',
        module: 'admin'
      });

    if (!ok) {
      commands.sendNotification(actorId, '[Staff] Falha ao ajustar o ouro. Nada foi alterado.');
      return;
    }
  }

  commands.sendNotification(actorId, `[Staff] Ouro definido para ${alvo} Septims.`);
  const charData = commands.getActiveCharacterData(actorId);
  await auditLog(
    charData?.accountId, targetChar.accountId,
    'staff:setGold',
    `role=${getRole(actorId)} amount=${alvo} anterior=${saldoAtual} delta=${delta}`
  );
  console.log(`[admin] ${actorId.toString(16)} (${getRole(actorId)}) set gold=${alvo} (delta ${delta}) for char ${targetChar.characterId}`);
}

/**
 * /permakill [actorId] [motivo] - Aposenta (soft-delete) um personagem permanentemente.
 * Permissão: 'retire_character' (nível admin+, nunca moderador — morte permanente
 * exige revisão da staff sênior, não decisão de linha de frente).
 *
 * Nunca faz DELETE — characters.status vira 'retired'. whitelist.js só permite
 * spawn com status='approved', então um personagem retired nunca mais entra em
 * jogo, sem precisar de nenhuma outra mudança. O jogador precisa criar um
 * personagem novo (nova aplicação de whitelist).
 */
async function retireCharacter(actorId, targetActorId, reason) {
  if (!hasPermission(actorId, 'retire_character')) {
    sendDenied(actorId);
    return;
  }
  if (!reason || !reason.trim()) {
    commands.sendNotification(actorId, 'Motivo obrigatorio: /permakill <actorId> <motivo>');
    return;
  }

  const targetChar = commands.getActiveCharacterData(targetActorId);
  if (!targetChar) {
    commands.sendNotification(actorId, 'Alvo nao encontrado ou personagem nao carregado.');
    return;
  }

  await db.query('UPDATE characters SET status = ? WHERE id = ?', ['retired', targetChar.characterId]);

  const charData = commands.getActiveCharacterData(actorId);
  await auditLog(
    charData?.accountId, targetChar.accountId,
    'staff:retireCharacter',
    `role=${getRole(actorId)} characterId=${targetChar.characterId} reason=${reason}`
  );

  commands.sendNotification(targetActorId, `Seu personagem foi permanentemente encerrado pela staff. Motivo: ${reason}`);
  console.log(`[admin] ${actorId.toString(16)} (${getRole(actorId)}) retired character ${targetChar.characterId}: ${reason}`);

  moderationLog.notify({
    kind: 'permakill',
    target: nomeParaLog(targetChar, targetActorId),
    moderator: nomeParaLog(charData, actorId),
    reason
  });

  if (typeof mp !== 'undefined') {
    setTimeout(() => {
      // `mp.kick` recebe `userId`, nao FormID; o adaptador converte. Ver
      // docs/research/SKYMP_INTEGRATION_AUDIT.md §6.
      if (typeof mp !== 'undefined') skymp.kick(targetActorId);
    }, 3000);
  }
}

/**
 * /revelaridentidade [actorId] - Revela à staff o nome real de um personagem.
 * Permissão: 'reveal_identity' (admin+, ver ROLE_PERMISSIONS no topo).
 *
 * ─── Por que é um comando, e não "staff sempre vê o nome real" ──────────────
 *
 * O `NAMETAG_IDENTITY_SYSTEM.md` listava a regra 2 como *"Staff futura: nome
 * real, com permissao auditada"*, e a leitura passiva dessa frase — um terceiro
 * ramo dentro de `getDisplayName()` que devolve o nome real quando o observador
 * é staff — é o desenho errado por quatro motivos, em ordem de peso:
 *
 * 1. **Estado não se audita, só o uso dele.** A própria regra pede "auditada".
 *    Um ramo passivo não tem evento: ninguém consegue responder *quem* furou o
 *    anonimato de *quem* e *quando*, que é exatamente a pergunta de uma
 *    arbitragem contestada. Um comando tem ator, alvo e carimbo de tempo.
 *
 * 2. **Acoplaria a autoridade sobre o nome ao cache de staff.**
 *    `getDisplayName(observador, alvo)` trabalha com PERSONAGENS; o cargo de
 *    staff vive em `staffCache`, chaveado por `actorId`. Um ramo lá dentro
 *    obrigaria o `identity-service` a importar o `admin-service` e a receber um
 *    actorId que ele hoje não precisa — e o efeito apareceria, invisível, em
 *    todos os chamadores de uma vez: chat local, aba Social do painel, e a
 *    nametag da Tarefa 2. É a forma de defeito que a
 *    `PARKED_SERVICES_DECISION.md` §7.1 usou para apagar o `disguise-service`,
 *    aplicada por dentro em vez de por fora.
 *
 * 3. **A staff também joga.** Nome real passivo em todo lugar estraga
 *    permanentemente a cena do personagem de quem é staff — custo contínuo,
 *    pago por todo mundo o tempo todo, para atender um caso raro.
 *
 * 4. **Revelar é raro por desenho.** Se virar rotina, o problema é outro.
 *
 * O preço da escolha, dito por inteiro: investigar custa um comando por pessoa,
 * e a staff precisa do `actorId` em mãos. É atrito real e é aceito — desmascarar
 * deve doer um pouco.
 *
 * ─── O que este comando deliberadamente NÃO faz ─────────────────────────────
 *
 * **Não escreve em `character_known_identities`.** Aquela tabela é conhecimento
 * IC — o que o PERSONAGEM sabe. Uma revelação de staff é OOC, feita pela pessoa
 * que administra, e gravá-la ali faria o personagem da staff passar a chamar o
 * alvo pelo nome real no chat local para sempre, sem que ninguém tivesse
 * apresentado nada a ninguém. Isso transformaria a ferramenta de investigação
 * numa máquina de metagaming com rastro de aparência legítima. A revelação é
 * pontual: uma notificação privada, uma linha de auditoria, e acabou.
 *
 * **Não mexe em `getDisplayName()`.** A escada de exibição continua com os
 * degraus que tinha (você mesmo / conhecido / `Desconhecido`), e continua sendo
 * o caminho padrão de todo mundo — inclusive da staff. Isso importa para além
 * desta rodada: a §7.1 já decidiu que o disfarce, quando voltar, entra como
 * **degrau** naquela função. Um ramo de staff enfiado lá dentro agora obrigaria
 * quem construir o disfarce a negociar com ele.
 *
 * ─── O bug que o `/revealid` antigo tinha, e que este teste cobre ───────────
 *
 * O `disguise-service.staffReveal` (apagado em 06/08/2026) montava a mensagem
 * com `commands.getActiveCharacterData(actorId)` — a PRÓPRIA STAFF — usando o
 * `targetActorId` só para achar o disfarce. O comando respondia *"X é na
 * verdade <nome de quem digitou>"*. Aqui todo dado da resposta e da auditoria
 * sai de `targetChar`; o `actorId` só serve para autorizar, auditar e receber a
 * notificação. Há teste de mutação para isso.
 */
async function revealIdentity(actorId, targetActorId) {
  if (!hasPermission(actorId, 'reveal_identity')) {
    sendDenied(actorId);
    return;
  }

  const targetChar = commands.getActiveCharacterData(targetActorId);
  if (!targetChar) {
    commands.sendNotification(actorId, '[Staff] Alvo nao encontrado ou personagem nao carregado.');
    return;
  }

  const staffChar = commands.getActiveCharacterData(actorId);

  // O nome real vem do identity-service, que continua sendo a única autoridade
  // sobre o que é o nome de um personagem. Este arquivo decide QUEM pode ver;
  // ele decide O QUE se vê. Concatenar first/last aqui criaria uma segunda
  // resposta para a mesma pergunta, que é a §7.1 de novo.
  const realName = identity.getCharacterFullName(targetChar);

  // A auditoria vem ANTES da notificação de propósito: se o banco cair, o certo
  // é a staff não receber o nome, e não receber o nome sem rastro. É a mesma
  // ordem que `auditIdentityEvent` já não garante sozinha (ela engole o erro e
  // cai para o console), mas a intenção fica declarada aqui e o teste de
  // mutação reprova quem inverter.
  await identity.auditIdentityEvent(
    staffChar?.accountId,
    targetChar.accountId,
    'identity:staff_reveal',
    `role=${getRole(actorId)} targetCharacterId=${targetChar.characterId} targetActorId=0x${targetActorId.toString(16)}`
  );

  commands.sendNotification(
    actorId,
    `[Staff] 0x${targetActorId.toString(16)} e ${realName} (personagem ${targetChar.characterId}). Revelacao registrada.`
  );
  console.log(`[admin] ${actorId.toString(16)} (${getRole(actorId)}) revelou identidade de ${targetActorId.toString(16)} (char ${targetChar.characterId})`);
}

/**
 * Nome legivel para o log de moderacao.
 *
 * O `actorId` em hexadecimal vai junto de proposito: e o que a staff digita nos
 * comandos, entao uma linha no Discord que traz so o nome obriga a procurar o
 * id de novo pra agir em cima dela.
 */
function nomeParaLog(charData, actorId) {
  const id = `0x${actorId.toString(16)}`;
  if (!charData) return id;
  const nome = `${charData.firstName || ''} ${charData.lastName || ''}`.trim();
  return nome ? `${nome} (${id})` : id;
}

function sendDenied(actorId) {
  commands.sendNotification(actorId, '[Staff] Permissão negada.');
}

/**
 * `/calar [actorId] [motivo]` — silencia a voz de um personagem.
 * Permissão: `voice_mute`.
 *
 * ─── O que ele NÃO é ────────────────────────────────────────────────────────
 *
 * Não é o mute do jogador (`voice-state.setMuted`), que é conforto e a pessoa
 * desfaz sozinha. Não é kick, não é ban, não é estado de personagem. É uma
 * condição de voz, componível com todas as outras, e a pessoa **continua
 * ouvindo** a cena — senão a punição vira desconexão disfarçada.
 *
 * ─── Não persiste, e isso está registrado ───────────────────────────────────
 *
 * O silêncio some no restart do servidor. Ver o cabeçalho de
 * `core/voice/voice-staff-mute.js`.
 *
 * @param {number} actorId staff
 * @param {number} targetActorId alvo
 * @param {string} reason
 * @param {number|null} [durationMinutes] `null` = até `/descalar`
 */
async function voiceMute(actorId, targetActorId, reason, durationMinutes = null) {
  if (!hasPermission(actorId, 'voice_mute')) {
    sendDenied(actorId);
    return { ok: false, reason: 'sem permissão' };
  }

  const charData = commands.getActiveCharacterData(actorId);
  const targetData = commands.getActiveCharacterData(targetActorId);
  if (!targetData) {
    commands.sendNotification(actorId, 'Alvo invalido.');
    return { ok: false, reason: 'alvo sem personagem ativo' };
  }

  const durationMs = Number.isFinite(durationMinutes) && durationMinutes > 0
    ? durationMinutes * 60_000
    : null;

  voiceStaffMute.mute(targetData.characterId, {
    byCharacterId: charData ? charData.characterId : null,
    reason,
    durationMs
  });

  await auditLog(
    charData?.accountId, targetData?.accountId, 'staff:voice_mute',
    `role=${getRole(actorId)} reason=${reason} duration=${durationMinutes ?? 'indefinida'}`
  );

  commands.sendNotification(targetActorId, `Sua voz foi silenciada pela staff: ${reason}`);
  commands.sendNotification(actorId, `Voz de ${nomeParaLog(targetData, targetActorId)} silenciada.`);
  console.log(`[admin] ${actorId.toString(16)} (${getRole(actorId)}) silenciou a voz de ${targetActorId.toString(16)}: ${reason}`);

  moderationLog.notify({
    kind: 'voice_mute',
    target: nomeParaLog(targetData, targetActorId),
    moderator: nomeParaLog(charData, actorId),
    reason
  });

  return { ok: true };
}

/**
 * `/descalar [actorId]` — devolve a voz.
 * Permissão: `voice_mute` — a mesma que tirou. Uma permissão separada para
 * desfazer criaria a situação em que quem silenciou não pode reverter.
 *
 * @param {number} actorId staff
 * @param {number} targetActorId alvo
 */
async function voiceUnmute(actorId, targetActorId) {
  if (!hasPermission(actorId, 'voice_mute')) {
    sendDenied(actorId);
    return { ok: false, reason: 'sem permissão' };
  }

  const charData = commands.getActiveCharacterData(actorId);
  const targetData = commands.getActiveCharacterData(targetActorId);
  if (!targetData) {
    commands.sendNotification(actorId, 'Alvo invalido.');
    return { ok: false, reason: 'alvo sem personagem ativo' };
  }

  const result = voiceStaffMute.unmute(targetData.characterId);
  await auditLog(charData?.accountId, targetData?.accountId, 'staff:voice_unmute', `role=${getRole(actorId)}`);

  if (result.changed) commands.sendNotification(targetActorId, 'Sua voz foi liberada pela staff.');
  commands.sendNotification(actorId, result.changed
    ? `Voz de ${nomeParaLog(targetData, targetActorId)} liberada.`
    : 'Esse personagem nao estava silenciado.');

  return { ok: true, changed: result.changed };
}

module.exports = {
  registerStaffRole,
  removeStaffRole,
  hasPermission,
  getRole,
  auditLog,
  playAnimation,
  giveItemAdmin,
  teleportTo,
  kickPlayer,
  setGold,
  retireCharacter,
  revealIdentity,
  voiceMute,
  voiceUnmute
};
