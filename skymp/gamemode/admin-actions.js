/**
 * admin-actions.js
 *
 * O registro de ações administrativas **do gamemode**, e a fiação dele com o
 * pipeline (`core/admin-action.js`).
 *
 * ─── O que este arquivo faz e o que ele recusa fazer ────────────────────────
 *
 * Ele declara, para cada ação: qual capability exige, se tem alvo, se exige
 * motivo, quais parâmetros aceita e **qual serviço de domínio chamar**. O
 * serviço chamado é o mesmo `admin-service` de sempre, com a mesma assinatura,
 * sem uma linha alterada.
 *
 * Isso é deliberado até o ponto de parecer redundante: cada handler continua
 * chamando `hasPermission` por dentro. Não é sobra — é a última linha. O
 * pipeline é a porta da frente e é por onde tudo passa; o handler é o que ainda
 * nega se alguém, um dia, o chamar por fora. Tirar a checagem de lá para
 * "limpar" transformaria doze funções exportadas em doze portas abertas
 * dependendo de ninguém errar.
 *
 * ─── O que muda de comportamento, e por quê ─────────────────────────────────
 *
 * Três ações passaram a exigir motivo. É mudança real e é a correção de uma
 * inconsistência que a auditoria registrou:
 *
 * - **`players.kick`** — o handler aceitava `'Sem motivo'` como padrão do
 *   `commands.js`, enquanto `/permakill` recusava a ação sem motivo. Duas regras
 *   para a mesma classe de ato, porque cada handler decidiu sozinho.
 * - **`economy.adjust`** — mover o patrimônio de alguém sem dizer por quê
 *   produz uma linha de ledger que ninguém consegue arbitrar depois. É o
 *   comando que mais precisa de rastro: ouro que aparece sem origem registrada
 *   é indistinguível de duplicação por bug.
 * - **`identity.reveal`** — a única ação de staff que não se desfaz nem por
 *   outro comando nem pelo tempo. O que torna esse poder aceitável é alguém
 *   conseguir mostrar depois **por que** ele foi usado, e não só que foi.
 *
 * O custo está dito: `/kick <id>`, `/setgold <id> <valor>` e
 * `/revelaridentidade <id>` passam a recusar sem a última parte. É atrito, é
 * aceito, e a mensagem de uso diz o que falta.
 *
 * ─── As cinco ações de voz que ninguém conseguia invocar ────────────────────
 *
 * `voiceMute`, `voiceUnmute`, `voiceDiagnose`, `voiceDisconnect` e
 * `voiceForceReconnect` existem no `admin-service`, têm permissão, auditoria e
 * teste de comportamento — e **nenhum `commandRegistry.register`**. Os
 * docstrings falam de `/calar`, `/vozdiag` e `/vozdesconectar`, o `voip-service`
 * anuncia no log do boot que eles estão disponíveis, e digitar qualquer um deles
 * respondia "Comando desconhecido".
 *
 * Elas entram aqui como ações de primeira classe, e é o registro que passa a
 * declarar o comando — o que faz "a ação existe" e "a ação é alcançável"
 * deixarem de ser duas afirmações independentes.
 */

'use strict';

const {
  SOURCES, REASON,
  createAdminActionRegistry,
  createAdminActionPipeline
} = require('./core/admin-action');

// Sem ciclo com estes dois — profession-service.js não requer admin-actions.js
// nem commands.js no topo do arquivo (só dentro do handler de `/profissoes`,
// depois do boot), então podem ser importados aqui direto, ao contrário de
// `admin-service`/`commands` logo abaixo.
const professionService = require('./profession-service');
const professionRegistry = require('./core/profession-registry');
const moduleRegistry = require('./core/module-registry');

// `require` preguiçoso nos três abaixo, e não no topo: `admin-service` requer
// `commands`, e `commands` vai requerer este arquivo para registrar os comandos.
// Importar no topo fecharia o ciclo. É o mesmo motivo dos requires dentro dos
// handlers de staff do `commands.js`.
const admin = () => require('./admin-service');
const commands = () => require('./commands');

// ─────────────────────────────────────────────────────────────────────────────
// SESSION — quem está pedindo
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve a sessão a partir do handle da superfície.
 *
 * No gamemode a superfície é o chat, e o handle é o `actorId` que o próprio
 * motor entregou no `onUiEvent` — o dado mais confiável que este processo tem.
 * Mesmo assim, **nada além dele é aceito**: cargo, `characterId` e `accountId`
 * são lidos aqui, agora.
 *
 * Isso não é cerimônia. O SkyMP reaproveita `actorId` entre sessões, e foi essa
 * reutilização que já fez um cargo de admin ficar preso a um slot e ser herdado
 * por quem entrasse depois. Um `characterId` "que a superfície já sabia" seria
 * do jogador anterior.
 *
 * @param {string} source
 * @param {any} sourceRef  o `actorId`
 */
async function resolveSession(source, sourceRef) {
  if (source !== SOURCES.COMMAND) return null;
  const actorId = Number(sourceRef);
  if (!Number.isFinite(actorId)) return null;

  const cargo = admin().getRole(actorId);
  if (!cargo) return null; // não é staff: nem chega a existir sessão administrativa

  const personagem = commands().getActiveCharacterData(actorId);

  return {
    // Identifica a sessão de jogo, não a pessoa. É o que permite ligar duas
    // ações da mesma sessão sem expor conta no registro.
    sessionId: `actor:${actorId.toString(16)}`,
    staffAccountId: personagem ? personagem.accountId : null,
    staffCharacterId: personagem ? personagem.characterId : null,
    role: cargo,
    // Extra do gamemode: os handlers de domínio falam em `actorId`.
    actorId
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// TARGET — contra quem
// ─────────────────────────────────────────────────────────────────────────────

function parseActorId(bruto) {
  if (typeof bruto === 'number') return bruto;
  if (typeof bruto !== 'string') return NaN;
  const limpo = bruto.trim().toLowerCase().startsWith('0x') ? bruto.trim().slice(2) : bruto.trim();
  return Number.parseInt(limpo, 16);
}

/**
 * Resolve o alvo a partir do texto que a staff digitou.
 *
 * O `characterId` e o `accountId` do alvo saem **daqui**, do cache de
 * personagens ativos do servidor — nunca do pedido. É o que impede uma
 * superfície de pedir uma ação contra a ficha de outra pessoa mandando um
 * `characterId` escolhido a dedo.
 *
 * @param {string} kind
 * @param {unknown} ref  o `actorId` em hexadecimal, como a staff o digitou
 */
async function resolveTarget(kind, ref) {
  if (kind !== 'player') return null;
  const actorId = parseActorId(ref);
  if (!Number.isFinite(actorId)) return null;

  const personagem = commands().getActiveCharacterData(actorId);
  if (!personagem) return null;

  const nome = `${personagem.firstName || ''} ${personagem.lastName || ''}`.trim();
  return {
    actorId,
    characterId: personagem.characterId,
    accountId: personagem.accountId,
    // `label` é o que vai para o registro: nome legível mais o id que a staff
    // digita nos comandos, para que uma linha de auditoria seja acionável sem
    // ter que procurar o id de novo.
    label: nome ? `${nome}(0x${actorId.toString(16)})` : `0x${actorId.toString(16)}`
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AUDIT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * O escritor deste processo. Grava em `audit_events`.
 *
 * ─── Por que não continua em `audit_logs` ───────────────────────────────────
 *
 * `audit_logs` tem seis colunas e recebe treze escritores que não gravam a
 * mesma coisa. `rp_chat:*` grava uma linha por FALA de cada jogador, e o
 * `GET /api/audit` do painel lê `ORDER BY created_at DESC LIMIT 200` — com o
 * servidor cheio, a última ação de staff sai da tela em minutos, sem nada
 * quebrar. Ver o cabeçalho de `core/audit-event.js`.
 *
 * O envelope do pipeline já carrega tudo que a tabela nova pede; o que faltava
 * era uma tabela que soubesse guardar. `severity` sai do catálogo a partir da
 * ação e do desfecho — um `identity.reveal` **negado** é mais interessante que
 * um executado, e a regra eleva por desfecho.
 *
 * `metadata` guarda o que não é coluna: os parâmetros da ação e a etapa em que
 * o pipeline parou. `before`/`after` ficam `null` por enquanto — nenhum serviço
 * de domínio devolve o estado anterior hoje, e inventá-lo a partir do que o
 * comando pediu seria gravar a intenção como se fosse o fato.
 */
const auditStore = () => require('./core/audit-event').createAuditEventStore(require('./database'));

async function audit(entrada) {
  await auditStore().record({
    eventId: entrada.actionId,
    correlationId: entrada.correlationId,
    sessionId: entrada.sessionId,
    staffAccountId: entrada.staffAccountId,
    staffCharacterId: entrada.staffCharacterId,
    targetAccountId: entrada.target ? entrada.target.accountId : null,
    targetCharacterId: entrada.target ? entrada.target.characterId : null,
    action: entrada.action,
    permission: entrada.permission,
    outcome: entrada.outcome,
    source: entrada.source,
    reason: entrada.reason,
    metadata: {
      stage: entrada.stage,
      parameters: entrada.parameters,
      target: entrada.target ? entrada.target.label : null,
      detail: entrada.detail || null
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// As ações
// ─────────────────────────────────────────────────────────────────────────────

const registry = createAdminActionRegistry();

/** `/kick` */
registry.register({
  id: 'players.kick',
  permission: 'players.kick',
  description: 'Expulsa um jogador da sessão',
  target: 'player',
  reason: REASON.REQUIRED,
  execute: async ({ session, target, reason }) => {
    await admin().kickPlayer(session.actorId, target.actorId, reason);
    return { ok: true };
  }
});

/** `/tp` */
registry.register({
  id: 'players.teleport',
  permission: 'players.teleport',
  description: 'Teleporta a staff até um jogador',
  target: 'player',
  reason: REASON.NONE,
  execute: async ({ session, target }) => {
    await admin().teleportTo(session.actorId, target.actorId);
    return { ok: true };
  }
});

/** `/anim` */
registry.register({
  id: 'players.animate',
  permission: 'players.animate',
  description: 'Reproduz uma animação num ator',
  target: 'player',
  reason: REASON.NONE,
  parameters: {
    animName: { type: 'string', required: false, default: 'IdleStop', maxLength: 64 }
  },
  execute: async ({ session, target, parameters }) => {
    await admin().playAnimation(session.actorId, target.actorId, parameters.animName);
    return { ok: true };
  }
});

/** `/additem` */
registry.register({
  id: 'inventory.grant',
  permission: 'inventory.grant',
  description: 'Entrega item a um jogador',
  target: 'player',
  reason: REASON.OPTIONAL,
  parameters: {
    // A forma é validada aqui; que o FormID EXISTA nos plugins carregados
    // continua sendo do `core/espm.js`, dentro do serviço de domínio. São duas
    // perguntas diferentes e a segunda precisa do jogo carregado.
    baseId: { type: 'formId', required: true },
    count: { type: 'integer', required: false, default: 1, min: 1, max: 10000 }
  },
  execute: async ({ session, target, parameters }) => {
    await admin().giveItemAdmin(session.actorId, target.actorId, parameters.baseId, parameters.count);
    return { ok: true };
  },
  auditDetail: (ctx) => `baseId=0x${ctx.parameters.baseId.toString(16)}`
});

/** `/setgold` */
registry.register({
  id: 'economy.adjust',
  permission: 'economy.adjust',
  description: 'Define o ouro de um jogador',
  target: 'player',
  reason: REASON.REQUIRED,
  parameters: {
    amount: { type: 'integer', required: true, min: 0 }
  },
  execute: async ({ session, target, parameters }) => {
    await admin().setGold(session.actorId, target.actorId, parameters.amount);
    return { ok: true };
  }
});

/** `/permakill` */
registry.register({
  id: 'characters.retire',
  permission: 'characters.retire',
  description: 'Encerra um personagem permanentemente (soft-delete)',
  target: 'player',
  reason: REASON.REQUIRED,
  execute: async ({ session, target, reason }) => {
    await admin().retireCharacter(session.actorId, target.actorId, reason);
    return { ok: true };
  }
});

/** `/revelaridentidade` */
registry.register({
  id: 'identity.reveal',
  permission: 'identity.reveal',
  description: 'Revela à staff o nome real por trás de um personagem',
  target: 'player',
  reason: REASON.REQUIRED,
  execute: async ({ session, target }) => {
    await admin().revealIdentity(session.actorId, target.actorId);
    return { ok: true };
  }
});

/** `/calar` */
registry.register({
  id: 'voice.mute',
  permission: 'voice.mute',
  description: 'Silencia a voz de um personagem',
  target: 'player',
  reason: REASON.REQUIRED,
  parameters: {
    durationMinutes: { type: 'integer', required: false, min: 1, max: 60 * 24 * 30 }
  },
  execute: async ({ session, target, parameters, reason }) => {
    const r = await admin().voiceMute(session.actorId, target.actorId, reason, parameters.durationMinutes ?? null);
    return r && r.ok === false ? { ok: false, reason: r.reason } : { ok: true };
  }
});

/** `/descalar` */
registry.register({
  id: 'voice.unmute',
  permission: 'voice.mute',
  description: 'Devolve a voz de um personagem',
  target: 'player',
  reason: REASON.OPTIONAL,
  execute: async ({ session, target }) => {
    const r = await admin().voiceUnmute(session.actorId, target.actorId);
    return r && r.ok === false ? { ok: false, reason: r.reason } : { ok: true, data: { changed: r && r.changed } };
  }
});

/** `/vozdiag` */
registry.register({
  id: 'voice.diagnose',
  permission: 'voice.mute',
  description: 'Consulta o estado de voz de um jogador',
  target: 'player',
  reason: REASON.NONE,
  execute: async ({ session, target }) => {
    const r = await admin().voiceDiagnose(session.actorId, target.actorId);
    return r && r.ok === false ? { ok: false, reason: r.reason } : { ok: true, data: r && r.report };
  }
});

/** `/vozdesconectar` */
registry.register({
  id: 'voice.disconnect',
  permission: 'voice.mute',
  description: 'Derruba a conexão de voz sem tirar o jogador do jogo',
  target: 'player',
  reason: REASON.REQUIRED,
  execute: async ({ session, target, reason }) => {
    const r = await admin().voiceDisconnect(session.actorId, target.actorId, reason);
    // `ok: false` aqui é "não havia voz a derrubar", que é estado do mundo e
    // não falha. O `admin-service` já registra a TENTATIVA por conta própria —
    // um audit log que só grava sucesso esconde metade do que a staff fez.
    return r && r.ok === false ? { ok: false, reason: r.reason } : { ok: true };
  }
});

/** `/vozreconectar` */
registry.register({
  id: 'voice.reconnect',
  permission: 'voice.mute',
  description: 'Reemite o token de voz mantendo a identidade',
  target: 'player',
  reason: REASON.NONE,
  execute: async ({ session, target }) => {
    const r = await admin().voiceForceReconnect(session.actorId, target.actorId);
    return r && r.ok === false ? { ok: false, reason: r.reason } : { ok: true };
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Profissão — Profession Core (§14 do briefing de profissões)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Códigos conhecidos no momento do boot. Uma profissão registrada depois
 * (via `professionRegistry.register`, fora das treze builtins) não entra
 * nesta lista até o próximo boot — aceitável nesta fase, porque nenhum
 * caminho de produção registra profissão em runtime; só testes o fazem.
 */
function _professionCodes() {
  return professionRegistry.list().map((p) => p.code);
}

/**
 * O interruptor de "este servidor ligou o framework" (§17 do briefing).
 * Vive como `precondition` — etapa STATE do pipeline — porque não é uma
 * pergunta de QUEM pode, é uma pergunta de SE o mundo permite agora. A mesma
 * checagem também vive dentro de `profession-service.js`: esta aqui evita que
 * a ação nem chegue ao serviço; a de lá protege um consumidor futuro que
 * chame o serviço sem passar pelo pipeline.
 */
function _professionModulePrecondition() {
  if (!moduleRegistry.isEnabled('profession')) {
    return { ok: false, reason: 'módulo profession desativado (ENABLE_PROFESSION_SERVICE)' };
  }
  return { ok: true };
}

/** Traduz o `{ok:false, code}` do serviço de domínio para o `execute` do pipeline. */
function _fromServiceResult(resultado) {
  if (resultado.ok === false) return { ok: false, reason: resultado.code };
  return { ok: true, data: resultado.data };
}

/** `/profissaoinfo` */
registry.register({
  id: 'profession.view',
  permission: 'profession.view',
  description: 'Lista as profissões de um personagem',
  target: 'player',
  reason: REASON.NONE,
  precondition: _professionModulePrecondition,
  execute: async ({ target }) => {
    const data = await professionService.getCharacterProfessions(target.characterId);
    return { ok: true, data };
  }
});

/** `/setprofissao` */
registry.register({
  id: 'profession.assign',
  permission: 'profession.assign',
  description: 'Concede uma profissão a um personagem',
  target: 'player',
  reason: REASON.OPTIONAL,
  parameters: {
    professionCode: { type: 'string', required: true, oneOf: _professionCodes(), maxLength: 32 }
  },
  precondition: _professionModulePrecondition,
  execute: async ({ session, target, parameters }) => {
    const r = await professionService.grantProfession({
      characterId: target.characterId,
      professionCode: parameters.professionCode,
      grantedByCharacterId: session.staffCharacterId
    });
    return _fromServiceResult(r);
  },
  auditDetail: (ctx) => `profession=${ctx.parameters.professionCode}`
});

/** `/removeprofissao` */
registry.register({
  id: 'profession.revoke',
  permission: 'profession.revoke',
  description: 'Revoga a profissão de um personagem',
  target: 'player',
  reason: REASON.REQUIRED,
  parameters: {
    professionCode: { type: 'string', required: true, oneOf: _professionCodes(), maxLength: 32 }
  },
  precondition: _professionModulePrecondition,
  execute: async ({ target, parameters }) => {
    const r = await professionService.revokeProfession({
      characterId: target.characterId,
      professionCode: parameters.professionCode
    });
    return _fromServiceResult(r);
  },
  auditDetail: (ctx) => `profession=${ctx.parameters.professionCode}`
});

/** `/suspenderprofissao` */
registry.register({
  id: 'profession.suspend',
  permission: 'profession.revoke',
  description: 'Suspende temporariamente a profissão de um personagem',
  target: 'player',
  reason: REASON.REQUIRED,
  parameters: {
    professionCode: { type: 'string', required: true, oneOf: _professionCodes(), maxLength: 32 }
  },
  precondition: _professionModulePrecondition,
  execute: async ({ target, parameters }) => {
    const r = await professionService.suspendProfession({
      characterId: target.characterId,
      professionCode: parameters.professionCode
    });
    return _fromServiceResult(r);
  },
  auditDetail: (ctx) => `profession=${ctx.parameters.professionCode}`
});

/** `/reativarprofissao` */
registry.register({
  id: 'profession.reactivate',
  permission: 'profession.assign',
  description: 'Reativa uma profissão suspensa',
  target: 'player',
  reason: REASON.OPTIONAL,
  parameters: {
    professionCode: { type: 'string', required: true, oneOf: _professionCodes(), maxLength: 32 }
  },
  precondition: _professionModulePrecondition,
  execute: async ({ target, parameters }) => {
    const r = await professionService.reactivateProfession({
      characterId: target.characterId,
      professionCode: parameters.professionCode
    });
    return _fromServiceResult(r);
  },
  auditDetail: (ctx) => `profession=${ctx.parameters.professionCode}`
});

/** `/setprofissaorank` */
registry.register({
  id: 'profession.rank',
  permission: 'profession.rank',
  description: 'Define o rank de um personagem numa profissão',
  target: 'player',
  reason: REASON.OPTIONAL,
  parameters: {
    professionCode: { type: 'string', required: true, oneOf: _professionCodes(), maxLength: 32 },
    // O teto de verdade é `profession.maxRank` (server-options), lido dentro
    // de profession-service.js. Aqui é só a forma — um número razoável — e a
    // recusa "fora da faixa configurada" acontece no serviço, como
    // `resultado.code === 'invalid_rank'`.
    rank: { type: 'integer', required: true, min: 0, max: 20 }
  },
  precondition: _professionModulePrecondition,
  execute: async ({ target, parameters }) => {
    const r = await professionService.setProfessionRank({
      characterId: target.characterId,
      professionCode: parameters.professionCode,
      rank: parameters.rank
    });
    return _fromServiceResult(r);
  },
  auditDetail: (ctx) => `profession=${ctx.parameters.professionCode} rank=${ctx.parameters.rank}`
});

/** `/profissaoxp` */
registry.register({
  id: 'profession.xp',
  permission: 'profession.xp',
  description: 'Ajusta manualmente o XP de profissão de um personagem',
  target: 'player',
  reason: REASON.REQUIRED,
  parameters: {
    professionCode: { type: 'string', required: true, oneOf: _professionCodes(), maxLength: 32 },
    amount: { type: 'integer', required: true, min: -1000000, max: 1000000 }
  },
  precondition: _professionModulePrecondition,
  execute: async ({ session, target, parameters }) => {
    const r = await professionService.addProfessionXp({
      characterId: target.characterId,
      professionCode: parameters.professionCode,
      amount: parameters.amount,
      // Presente sempre: só este caminho existe hoje para dar XP, e é
      // inteiramente administrativo. `addProfessionXp` usa a presença deste
      // campo para decidir se aceita `amount` negativo (§10 do briefing).
      staffCharacterId: session.staffCharacterId
    });
    return _fromServiceResult(r);
  },
  auditDetail: (ctx) => `profession=${ctx.parameters.professionCode} amount=${ctx.parameters.amount}`
});

// ─────────────────────────────────────────────────────────────────────────────
// O pipeline deste processo
// ─────────────────────────────────────────────────────────────────────────────

const pipeline = createAdminActionPipeline({ registry, resolveSession, resolveTarget, audit });

/**
 * Como cada ação é invocada pelo chat.
 *
 * O registro é a única declaração: nome do comando, ordem dos argumentos e como
 * eles viram parâmetros. Antes isso morava espalhado por doze `commandRegistry
 * .register` no `commands.js`, cada um com o próprio `parseInt`, o próprio
 * tratamento de argumento faltando, e — em cinco casos — em lugar nenhum.
 *
 * `rest: true` significa "o resto da linha vira motivo".
 *
 * @type {Array<{names: string|string[], action: string, usage: string, args?: string[], rest?: 'reason'}>}
 */
const COMMANDS = [
  { names: '/kick', action: 'players.kick', usage: '/kick <actorId> <motivo>', rest: 'reason' },
  { names: '/tp', action: 'players.teleport', usage: '/tp <actorId>' },
  { names: '/anim', action: 'players.animate', usage: '/anim <actorId> [animName]', args: ['animName'] },
  { names: '/additem', action: 'inventory.grant', usage: '/additem <actorId> <baseId> [count]', args: ['baseId', 'count'] },
  { names: '/setgold', action: 'economy.adjust', usage: '/setgold <actorId> <valor> <motivo>', args: ['amount'], rest: 'reason' },
  { names: '/permakill', action: 'characters.retire', usage: '/permakill <actorId> <motivo>', rest: 'reason' },
  { names: ['/revelaridentidade', '/revealidentity'], action: 'identity.reveal', usage: '/revelaridentidade <actorId> <motivo>', rest: 'reason' },
  { names: '/calar', action: 'voice.mute', usage: '/calar <actorId> <motivo>', rest: 'reason' },
  { names: '/descalar', action: 'voice.unmute', usage: '/descalar <actorId>' },
  { names: '/vozdiag', action: 'voice.diagnose', usage: '/vozdiag <actorId>' },
  { names: '/vozdesconectar', action: 'voice.disconnect', usage: '/vozdesconectar <actorId> <motivo>', rest: 'reason' },
  { names: '/vozreconectar', action: 'voice.reconnect', usage: '/vozreconectar <actorId>' },

  { names: '/profissaoinfo', action: 'profession.view', usage: '/profissaoinfo <actorId>' },
  { names: '/setprofissao', action: 'profession.assign', usage: '/setprofissao <actorId> <code>', args: ['professionCode'] },
  { names: '/removeprofissao', action: 'profession.revoke', usage: '/removeprofissao <actorId> <code> <motivo>', args: ['professionCode'], rest: 'reason' },
  { names: '/suspenderprofissao', action: 'profession.suspend', usage: '/suspenderprofissao <actorId> <code> <motivo>', args: ['professionCode'], rest: 'reason' },
  { names: '/reativarprofissao', action: 'profession.reactivate', usage: '/reativarprofissao <actorId> <code>', args: ['professionCode'] },
  { names: '/setprofissaorank', action: 'profession.rank', usage: '/setprofissaorank <actorId> <code> <rank>', args: ['professionCode', 'rank'] },
  { names: '/profissaoxp', action: 'profession.xp', usage: '/profissaoxp <actorId> <code> <valor> <motivo>', args: ['professionCode', 'amount'], rest: 'reason' }
];

/**
 * Traduz uma linha de chat em um pedido do pipeline.
 *
 * Nenhuma validação acontece aqui de propósito — nem de tipo, nem de
 * obrigatoriedade. Este é o adaptador da superfície, e a superfície não decide
 * nada. Ele reparte a string e entrega; quem recusa é a etapa VALIDATION.
 */
function parseCommandArgs(def, args) {
  const partes = String(args || '').trim().split(/\s+/).filter(Boolean);
  const pedido = { targetRef: partes[0], parameters: {} };

  let i = 1;
  for (const nome of def.args || []) {
    if (partes[i] !== undefined) pedido.parameters[nome] = partes[i];
    i += 1;
  }
  if (def.rest === 'reason') pedido.reason = partes.slice(i).join(' ');

  return pedido;
}

/**
 * Mensagem para quem digitou. O `Result` do pipeline é estruturado; isto é a
 * tradução dele para uma linha de chat.
 */
function describeResult(resultado, usage) {
  switch (resultado.outcome) {
    case 'executed':  return null; // o serviço de domínio já notificou
    case 'denied':    return '[Staff] Permissão negada.';
    case 'invalid':   return `[Staff] ${resultado.detail}. Uso: ${usage}`;
    case 'blocked':   return `[Staff] ${resultado.detail}.`;
    case 'duplicate': return '[Staff] Essa ação ja foi aplicada.';
    default:          return '[Staff] Nao foi possivel executar. O erro foi registrado.';
  }
}

/**
 * Registra os comandos de staff no `commandRegistry`.
 *
 * Chamado pelo `commands.js`, que continua sendo quem conhece o registro de
 * comandos. Este arquivo não o importa — a seta aponta para cá, não daqui.
 *
 * @param {{register: Function}} commandRegistry
 * @param {(actorId: number, mensagem: string) => void} notify
 */
function registerCommands(commandRegistry, notify) {
  for (const def of COMMANDS) {
    const acao = registry.get(def.action);
    commandRegistry.register(def.names, (actorId, args) => {
      const pedido = parseCommandArgs(def, args);
      pipeline.run({
        action: def.action,
        source: SOURCES.COMMAND,
        sourceRef: actorId,
        ...pedido
      }).then((resultado) => {
        const mensagem = describeResult(resultado, def.usage);
        if (mensagem) notify(actorId, mensagem);
      }).catch((err) => {
        // O pipeline já trata o que o serviço de domínio lança. Cair aqui é
        // defeito do próprio pipeline, e não pode virar silêncio.
        console.error(`[admin-actions] pipeline quebrou em '${def.action}':`, err.message);
        notify(actorId, '[Staff] Falha interna. O erro foi registrado.');
      });
    }, {
      module: 'admin',
      phase: 'core',
      description: `[Staff] ${acao.description}`,
      usage: def.usage
    });
  }
}

module.exports = {
  registry,
  pipeline,
  registerCommands,
  COMMANDS,
  // Exposto para teste: são as três funções que resolvem identidade, e a única
  // forma de provar que elas NÃO leem o pedido é chamá-las direto.
  resolveSession,
  resolveTarget,
  parseCommandArgs
};
