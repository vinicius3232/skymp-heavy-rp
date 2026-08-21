/**
 * core/permissions.js
 *
 * **A fonte única de verdade sobre quem pode o quê no servidor.**
 *
 * Antes deste arquivo havia dois sistemas que liam a mesma tabela e chegavam a
 * respostas diferentes: o `admin-service` derivava 13 permissões nomeadas de
 * `ROLE_PERMISSIONS`, e o `apps/web` perguntava só "tem linha em `staff_roles`?"
 * e liberava tudo. A granularidade existia do lado que ninguém consegue usar
 * hoje. Ver `docs/admin/SKYADMIN_CURRENT_STATE.md` §1.
 *
 * Este módulo não substitui aquele RBAC — ele **é** aquele RBAC, extraído para
 * um lugar que o painel, o bot e qualquer ferramenta futura consigam importar.
 * O `admin-service` continua sendo a porta de entrada do gamemode; ele passou a
 * perguntar aqui em vez de responder sozinho.
 *
 * ─── Por que aqui e não em `skymp/packages/rbac/` ───────────────────────────
 *
 * `skymp/packages/database/` estabeleceu que `packages/` é o lugar do que é
 * compartilhado, e a primeira versão disto morava lá. O que decidiu contra foi
 * o cabeçalho do `phase0-basic.js`: o SkyMP copia o arquivo de entrada para
 * `%TEMP%` e executa de lá, e a árvore que sabidamente sobrevive a isso é
 * `skymp/gamemode/`. Um require que sobe para `../packages/` funciona hoje e
 * depende de uma suposição sobre o layout de deploy que ninguém verificou com o
 * servidor de verdade rodando — e o custo de descobrir que ela é falsa é o
 * gamemode inteiro morrer no boot, que é exatamente o acidente que aquele
 * cabeçalho registra ter acontecido uma vez.
 *
 * O caminho inverso já existe e já funciona: `apps/web/server.js:5` lê
 * `../../skymp/gamemode/.env` desde sempre. Este módulo usa a mesma travessia,
 * na mesma direção, que já está em produção.
 *
 * ─── Capability-based, e o que isso muda na prática ─────────────────────────
 *
 * O nome de uma permissão passa a ser `dominio.acao`. Não é cosmética: os nomes
 * antigos eram verbos soltos (`kick`, `teleport`, `ban`), e verbo solto não
 * responde "sobre o quê?". Foi assim que `playAnimation` acabou guardada por
 * `teleport` — quem auditasse "quem pode `teleport`?" recebia a resposta errada
 * sobre quem pode fazer um personagem executar animações. Com `players.teleport`
 * e `players.animate` a pergunta tem uma resposta só.
 *
 * Os nomes antigos continuam funcionando (ver `LEGACY_ALIASES`). Eles são
 * traduzidos antes de qualquer validação, então nenhum sítio de chamada
 * existente quebra — inclusive os dos módulos PARKED, que ninguém está olhando.
 *
 * ─── `reserved`: o defeito que este arquivo recusa a repetir ────────────────
 *
 * A auditoria encontrou três permissões (`ban`, `view_audit`, `manage_whitelist`)
 * concedidas a cargos e **verificadas em lugar nenhum**. `ban` é a pior: está
 * concedida a `admin` e `owner` desde sempre, e não existe comando de ban, nem
 * endpoint, nem tabela. Uma permissão assim descreve um poder inexistente — e o
 * `hasPermission` já recusava o caso simétrico (nome desconhecido "cria uma
 * porta que nunca abre") sem enxergar este.
 *
 * A resposta aqui não é apagar os nomes: apagá-los faria a próxima pessoa
 * inventar um nome rival para a mesma coisa, e aí passam a existir dois
 * vocabulários. A resposta é declarar o nome com `status: 'reserved'` —
 * reservado, **concedido a ninguém**, negando para todo mundo inclusive `owner`,
 * com um motivo legível no log. O nome fica tomado; o poder, não.
 *
 * Duas invariantes de teste sustentam isso (`permissions.test.js`):
 *   - toda capability `active` é concedida a pelo menos um cargo;
 *   - toda capability `reserved` é concedida a nenhum.
 *
 * Promover uma reservada a ativa é, portanto, uma mudança que não passa
 * despercebida: exige tocar o catálogo, os cargos e a matriz de teste na mesma
 * linha de raciocínio.
 *
 * ─── As quatro negações ─────────────────────────────────────────────────────
 *
 * Cargo desconhecido, permissão desconhecida, permissão malformada e permissão
 * reservada negam — todas, sempre, para todo cargo. `owner` não é exceção de
 * nenhuma delas. Negar é o padrão e negar é barulhento: cada uma tem um código
 * de motivo que o chamador pode auditar, em vez do `false` mudo de antes.
 */

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Forma do nome
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `dominio.acao`, minúsculo, sem espaço, exatamente um ponto.
 *
 * A forma é validada e não só documentada porque um nome malformado é
 * indistinguível de um nome desconhecido no resultado (os dois negam), mas não
 * na causa: `Players.Kick` é erro de digitação de quem escreveu a chamada, e
 * `players.explode` é uma permissão que alguém acha que existe. Separar os dois
 * no log é a diferença entre corrigir em um minuto e procurar por meia hora.
 */
const PERMISSION_SHAPE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

/** @param {unknown} name */
function isWellFormed(name) {
  return typeof name === 'string' && PERMISSION_SHAPE.test(name);
}

/**
 * A forma dos nomes antigos: um verbo solto, sem ponto (`kick`, `manage_staff`).
 *
 * Existe para separar duas causas que a checagem de forma sozinha confunde, e
 * que mandam quem lê o log para lados opostos:
 *
 *   - `manage_factions` — alguém inventou um nome no vocabulário ANTIGO que
 *     nenhum alias cobre. A pessoa acha que criou uma regra e criou uma porta
 *     que nunca abre. O conserto é escolher uma capability que existe.
 *   - `Players.Kick` — alguém errou a digitação do vocabulário NOVO. O conserto
 *     é minúsculo e um ponto.
 *
 * Chamar as duas de "malformada" faria a primeira ser lida como erro de
 * digitação, e quem a corrigisse escreveria `manage.factions` — que continua
 * não existindo, e agora com a forma certa.
 */
const LEGACY_SHAPE = /^[a-z][a-z0-9_]*$/;

// ─────────────────────────────────────────────────────────────────────────────
// O catálogo
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `active`   — existe ponto de aplicação no código, hoje.
 * `reserved` — o nome está tomado, o poder não existe. Nega para todos.
 *
 * `enforcedAt` é prosa de propósito, não caminho de arquivo: caminho envelhece
 * em silêncio no primeiro rename, e uma frase errada é visível na revisão.
 *
 * @typedef {{description: string, status: 'active'|'reserved', enforcedAt: string}} Capability
 * @type {Record<string, Capability>}
 */
const CAPABILITIES = Object.freeze({
  // ── players ────────────────────────────────────────────────────────────────
  'players.view': {
    description: 'Ver a lista de jogadores conectados e o estado de sessão deles.',
    status: 'reserved',
    enforcedAt: 'nenhum — não existe ponte painel→servidor de jogo, e a lista de online é derivada de polling interno.'
  },
  'players.kick': {
    description: 'Expulsar um jogador da sessão, com motivo.',
    status: 'active',
    enforcedAt: 'admin-service.kickPlayer'
  },
  'players.ban': {
    description: 'Impedir uma conta de entrar, com motivo e prazo.',
    status: 'reserved',
    enforcedAt: 'nenhum — não existe comando, endpoint nem tabela de ban. Os três pontos de aplicação existem e ninguém escreve neles.'
  },
  'players.teleport': {
    description: 'Teleportar-se até um jogador.',
    status: 'active',
    enforcedAt: 'admin-service.teleportTo'
  },
  'players.animate': {
    description: 'Fazer um ator executar uma animação (eventos de RP).',
    status: 'active',
    enforcedAt: 'admin-service.playAnimation'
  },

  // ── whitelist ──────────────────────────────────────────────────────────────
  'whitelist.view': {
    description: 'Ler as aplicações de whitelist e o conteúdo das fichas.',
    status: 'active',
    enforcedAt: 'painel GET /api/whitelist'
  },
  'whitelist.review': {
    description: 'Aprovar, rejeitar ou reabrir uma aplicação de whitelist.',
    status: 'active',
    enforcedAt: 'painel PATCH /api/whitelist/:id'
  },

  // ── characters ─────────────────────────────────────────────────────────────
  'characters.view': {
    description: 'Listar e buscar personagens.',
    status: 'active',
    enforcedAt: 'painel GET /api/characters'
  },
  'characters.manage': {
    description: 'Alterar dados de um personagem (nome, status, posição).',
    status: 'reserved',
    enforcedAt: 'nenhum — o painel não tem nenhuma rota que mute personagem fora da revisão de whitelist.'
  },
  'characters.retire': {
    description: 'Encerrar um personagem permanentemente (soft-delete, motivo obrigatório).',
    status: 'active',
    enforcedAt: 'admin-service.retireCharacter'
  },

  // ── inventory ──────────────────────────────────────────────────────────────
  'inventory.view': {
    description: 'Inspecionar o inventário de um personagem.',
    status: 'reserved',
    enforcedAt: 'nenhum — não existe leitura de inventário alheio por staff.'
  },
  'inventory.grant': {
    description: 'Entregar item a um personagem (passa pelo ledger).',
    status: 'active',
    enforcedAt: 'admin-service.giveItemAdmin'
  },
  'inventory.remove': {
    description: 'Retirar item de um personagem (passaria pelo ledger).',
    status: 'reserved',
    enforcedAt: 'nenhum — não existe /removeitem.'
  },

  // ── economy ────────────────────────────────────────────────────────────────
  'economy.view': {
    description: 'Ver tesouros regionais, impostos e a distribuição de patrimônio.',
    status: 'active',
    enforcedAt: 'painel GET /api/economy/holds e /api/economy/top-gold'
  },
  'economy.adjust': {
    description: 'Mover o ouro de um personagem por decisão de staff (passa pelo ledger).',
    status: 'active',
    enforcedAt: 'admin-service.setGold; economy-regional.setTaxRate (PARKED)'
  },
  'economy.recipes': {
    description: 'Criar e alterar receitas de crafting — regra permanente, não ato pontual.',
    status: 'active',
    enforcedAt: 'crafting-service.addRecipe e .addIngredient (PARKED)'
  },

  // ── audit ──────────────────────────────────────────────────────────────────
  'audit.view': {
    description: 'Ler o registro de auditoria.',
    status: 'active',
    enforcedAt: 'painel GET /api/audit'
  },
  'audit.export': {
    description: 'Extrair o registro de auditoria em massa, para fora do painel.',
    status: 'reserved',
    enforcedAt: 'nenhum — não existe exportação. Separada de audit.view de propósito: ler 200 linhas na tela e levar o histórico inteiro embora são atos de risco diferente.'
  },

  // ── identity ───────────────────────────────────────────────────────────────
  'identity.reveal': {
    description: 'Revelar à staff o nome real por trás de um personagem. Irreversível.',
    status: 'active',
    enforcedAt: 'admin-service.revealIdentity'
  },

  // ── governance (registros IC: prisão, ficha criminal, facções) ─────────────
  'governance.view': {
    description: 'Ler os registros institucionais do mundo: presos, fichas criminais, facções.',
    status: 'active',
    enforcedAt: 'painel GET /api/prison, /api/criminal e /api/factions'
  },

  // ── voice ──────────────────────────────────────────────────────────────────
  'voice.mute': {
    description:
      'Moderar a voz de um jogador: silenciar, devolver, consultar o diagnóstico, derrubar e reemitir o transporte. ' +
      'Uma capability só para as cinco — ver a nota em ROLE_CAPABILITIES.',
    status: 'active',
    enforcedAt: 'admin-service.voiceMute, .voiceUnmute, .voiceDiagnose, .voiceDisconnect e .voiceForceReconnect; bot /voz-criar e /voz-fechar'
  },

  // ── world ──────────────────────────────────────────────────────────────────
  'world.probe': {
    description: 'Rodar os instrumentos de observação do mundo. Uma das duas ferramentas ESCREVE no ator alvo.',
    status: 'active',
    enforcedAt: 'fauna-census e corpse-probe'
  },

  // ── staff ──────────────────────────────────────────────────────────────────
  'staff.view': {
    description: 'Ver quem é staff, com que cargo e desde quando.',
    status: 'reserved',
    enforcedAt: 'nenhum — não existe rota de listagem de staff.'
  },
  'staff.manage': {
    description: 'Conceder e revogar cargo de staff. Hoje serve também de bypass da governança IC.',
    status: 'active',
    enforcedAt: 'governance-service.isStaffGovernor; market-stalls-service.hasStallPermission. NÃO guarda concessão de cargo — isso não existe.'
  },

  // ── security ───────────────────────────────────────────────────────────────
  'security.view': {
    description: 'Ler material de diagnóstico que carrega dado pessoal — crash reports com Discord ID e username.',
    status: 'active',
    enforcedAt: 'painel GET /api/crashes'
  },
  'security.review': {
    description: 'Analisar alertas de segurança e negações acumuladas.',
    status: 'reserved',
    enforcedAt: 'nenhum — a negação passou a ser auditada, mas não existe superfície que a apresente.'
  },
  'security.enforce': {
    description: 'Aplicar medida de segurança: revogar sessão, bloquear conta, invalidar ticket.',
    status: 'reserved',
    enforcedAt: 'nenhum — game_sessions.revoked_at nunca recebeu um UPDATE.'
  },

  // ── profession ─────────────────────────────────────────────────────────────
  // Cinco capabilities para sete ações (profession-service.js): `assign` cobre
  // conceder e reativar (as duas "dão" a profissão), `revoke` cobre revogar e
  // suspender (as duas "tiram"). Ver docs/gameplay/PROFESSION_FRAMEWORK.md.
  'profession.view': {
    description: 'Consultar as profissões de um personagem.',
    status: 'active',
    enforcedAt: 'admin-actions.js: profession.view (/profissaoinfo)'
  },
  'profession.assign': {
    description: 'Conceder uma profissão a um personagem, ou reativar uma suspensa.',
    status: 'active',
    enforcedAt: 'admin-actions.js: profession.assign, profession.reactivate'
  },
  'profession.revoke': {
    description: 'Revogar ou suspender a profissão de um personagem.',
    status: 'active',
    enforcedAt: 'admin-actions.js: profession.revoke, profession.suspend'
  },
  'profession.rank': {
    description: 'Definir o rank de um personagem numa profissão.',
    status: 'active',
    enforcedAt: 'admin-actions.js: profession.rank'
  },
  'profession.xp': {
    description: 'Ajustar manualmente o XP de profissão de um personagem.',
    status: 'active',
    enforcedAt: 'admin-actions.js: profession.xp'
  },

  // ── server ─────────────────────────────────────────────────────────────────
  'server.view': {
    description: 'Ver o estado agregado do servidor: contadores, saúde, fila.',
    status: 'active',
    enforcedAt: 'painel GET /api/dashboard'
  },
  'server.manage': {
    description: 'Operar o servidor: reiniciar, ligar e desligar módulo a quente.',
    status: 'reserved',
    enforcedAt: 'nenhum — e ADMIN_PLATFORM.md já decidiu que restart e toggle a quente ficam fora do painel.'
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Cargos
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cada cargo lista o conjunto **completo** do que pode. Não há herança.
 *
 * Herança (`admin = moderator + X`) economiza linhas e cobra caro na única hora
 * que importa: ler a lista e saber o que um cargo pode exige seguir a corrente
 * inteira, e ampliar a base amplia todo mundo acima sem que ninguém tenha
 * decidido isso. É a mesma razão pela qual a §4 do `docs/admin/RBAC.md` já
 * tinha registrado a decisão.
 *
 * ═══ Por que cada linha está no andar em que está ═══════════════════════════
 *
 * Este bloco morava no `admin-service.js` e veio junto com a tabela. Ele é o
 * registro de por que a fronteira do moderador está onde está — e a razão de
 * cada item resistir ao candidato fácil que teria evitado criar uma permissão.
 *
 * **`economy.recipes` é separada de `inventory.grant`** (eram `manage_recipes` e
 * `add_item`). Entregar um item é ato pontual e auditado, com raio de alcance de
 * uma pessoa. Uma receita é regra permanente que **todo** jogador usa, quantas
 * vezes quiser: é casa da moeda, não presente. Reaproveitar a de item faria quem
 * auditasse "quem pode dar item?" receber a resposta errada sobre quem pode
 * reformar a economia de crafting.
 *
 * **`identity.reveal` fica em `admin`/`owner`** (07/08/2026). O candidato fácil
 * era pendurá-la em `audit.view` — "staff lendo registro" —, errado por duas
 * razões independentes: `audit.view` significa ler o que a STAFF fez, não furar
 * o anonimato de um JOGADOR; e `audit.view` é de moderador, então reaproveitá-la
 * alargaria o poder para a linha de frente inteira sem que ninguém tivesse
 * decidido isso.
 *
 * Fora do moderador não pelo argumento de patrimônio — revelar não move nada.
 * É que **nenhuma outra ação de staff é irreversível do jeito que esta é**: um
 * kick acaba quando a pessoa reconecta, ouro dado volta por outro ajuste, e até
 * o permakill é soft-delete. Uma identidade revelada não desrevela — ela passa a
 * morar na cabeça de quem leu, e o `audit_logs` registra que aconteceu sem poder
 * desfazer. O valor do sistema de anonimato é inversamente proporcional a
 * quantas pessoas conseguem contorná-lo, e moderador é o cargo mais numeroso e
 * menos filtrado.
 *
 * O que fica em aberto, no formato da `PARKED_SERVICES_DECISION.md` §7.4: se a
 * operação mostrar que denúncia de metagaming chega mais rápido do que admin
 * responde, a resposta NÃO é dar `identity.reveal` ao moderador — é desenhar uma
 * variante com escopo (revelar só quem é parte de uma denúncia aberta). Alargar
 * o cargo resolveria a fila criando o problema que a permissão existe para
 * evitar.
 *
 * **`world.probe` fica fora do moderador** (08/08/2026) porque uma das duas
 * ferramentas **escreve**: a sonda esvazia o inventário do ator alvo para provar
 * que a escrita funciona, e restaura em seguida. A restauração pode falhar. O
 * censo, sozinho, seria inofensivo o bastante para moderador — mas separar em
 * duas permissões daria a este projeto uma a mais para justificar sem que
 * ninguém tivesse pedido, e as duas rodam na mesma sessão, pela mesma pessoa.
 *
 * **`voice.mute` e `voice.diagnose` ficam no MODERADOR**, ao lado de
 * `players.kick`. Silenciar quem está gritando por cima de todo mundo é menos
 * grave que expulsar, e exigir um admin para isso faria a moderação escolher
 * entre não fazer nada e expulsar. As duas são reversíveis pelo mesmo cargo e
 * mexem no transporte de voz, nunca na presença no jogo — quem pode calar pode
 * destravar; expulsar é outra conversa.
 *
 * ─── As duas linhas que o moderador PERDEU nesta rodada ─────────────────────
 *
 * Até aqui o painel não perguntava nada, então "moderador" significava, na web,
 * o mesmo que "owner". Duas capabilities ficaram deliberadamente fora dele ao
 * fechar essa porta:
 *
 * - **`economy.view`** — o ranking de patrimônio e os tesouros regionais. Saber
 *   quem são os dez mais ricos do servidor não ajuda a moderar uma cena, e é
 *   material de metagaming pronto na mão do cargo mais numeroso.
 * - **`security.view`** — os crash reports carregam Discord ID e username de
 *   cada jogador que crashou. Era a rota com o pior par risco/permissão do
 *   painel inteiro.
 *
 * Tudo o mais que o moderador enxergava, ele continua enxergando.
 *
 * @type {Record<string, readonly string[]>}
 */
const ROLE_CAPABILITIES = Object.freeze({
  moderator: Object.freeze([
    'players.kick',
    'players.teleport',
    'players.animate',
    'whitelist.view',
    'whitelist.review',
    'characters.view',
    'audit.view',
    'governance.view',
    'voice.mute',
    'server.view'
  ]),

  admin: Object.freeze([
    'players.kick',
    'players.teleport',
    'players.animate',
    'whitelist.view',
    'whitelist.review',
    'characters.view',
    'characters.retire',
    'inventory.grant',
    'economy.view',
    'economy.adjust',
    'economy.recipes',
    'audit.view',
    'identity.reveal',
    'governance.view',
    'voice.mute',
    'world.probe',
    'security.view',
    'server.view',
    'profession.view',
    'profession.assign',
    'profession.revoke',
    'profession.rank',
    'profession.xp'
  ]),

  owner: Object.freeze([
    'players.kick',
    'players.teleport',
    'players.animate',
    'whitelist.view',
    'whitelist.review',
    'characters.view',
    'characters.retire',
    'inventory.grant',
    'economy.view',
    'economy.adjust',
    'economy.recipes',
    'audit.view',
    'identity.reveal',
    'governance.view',
    'voice.mute',
    'world.probe',
    'security.view',
    'server.view',
    'staff.manage',
    'profession.view',
    'profession.assign',
    'profession.revoke',
    'profession.rank',
    'profession.xp'
  ])
});

/** Cargos que existem. Qualquer outro valor em `staff_roles.role` nega tudo. */
const ROLES = Object.freeze(Object.keys(ROLE_CAPABILITIES));

// ─────────────────────────────────────────────────────────────────────────────
// Compatibilidade com os nomes antigos
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Os 13 nomes que o gamemode usava, traduzidos.
 *
 * Existem para que nenhum sítio de chamada precise mudar no mesmo commit que
 * troca o vocabulário — incluindo os dos módulos PARKED (`crafting-service`,
 * `economy-regional`), que ninguém está olhando e que já foram, uma vez, o
 * lugar onde um bug de permissão sobreviveu a uma suíte inteira.
 *
 * Três merecem nota, porque a tradução não é um para um:
 *
 * - `teleport` guardava DUAS ações (teleportar e animar). Ele traduz para
 *   `players.teleport`, e `playAnimation` passou a pedir `players.animate`. Os
 *   dois cargos que tinham `teleport` receberam as duas capabilities, então
 *   ninguém perdeu poder — o que mudou é que agora a pergunta "quem pode
 *   animar?" tem resposta própria.
 *
 * - `ban`, `view_audit` e `manage_whitelist` eram as três órfãs. `view_audit`
 *   e `manage_whitelist` traduzem para capabilities **ativas**, porque o painel
 *   passou a verificá-las de verdade neste commit — elas deixaram de ser órfãs.
 *   `ban` continua sem porta e traduz para uma `reserved`: quem chamar
 *   `hasPermission(actorId, 'ban')` recebe `false` e um log dizendo por quê,
 *   em vez do `true` silencioso de antes.
 *
 * @type {Record<string, string>}
 */
const LEGACY_ALIASES = Object.freeze({
  kick: 'players.kick',
  teleport: 'players.teleport',
  ban: 'players.ban',
  add_item: 'inventory.grant',
  set_gold: 'economy.adjust',
  retire_character: 'characters.retire',
  reveal_identity: 'identity.reveal',
  run_world_probe: 'world.probe',
  manage_recipes: 'economy.recipes',
  manage_staff: 'staff.manage',
  view_audit: 'audit.view',
  manage_whitelist: 'whitelist.review',
  voice_mute: 'voice.mute'
});

// ─────────────────────────────────────────────────────────────────────────────
// Resolução
// ─────────────────────────────────────────────────────────────────────────────

/** Motivos de negação. Códigos estáveis: eles vão para o `audit_logs`. */
const DENIAL = Object.freeze({
  NO_ROLE: 'no_role',
  UNKNOWN_ROLE: 'unknown_role',
  UNKNOWN_PERMISSION: 'unknown_permission',
  MALFORMED_PERMISSION: 'malformed_permission',
  RESERVED_PERMISSION: 'reserved_permission',
  NOT_GRANTED: 'not_granted'
});

/**
 * Traduz um nome legado, se for um. Devolve o nome original caso contrário.
 * @param {unknown} name
 * @returns {{name: unknown, wasLegacy: boolean}}
 */
function normalize(name) {
  if (typeof name === 'string' && Object.prototype.hasOwnProperty.call(LEGACY_ALIASES, name)) {
    return { name: LEGACY_ALIASES[name], wasLegacy: true };
  }
  return { name, wasLegacy: false };
}

/**
 * A decisão, com o motivo. É a função que todo o resto chama.
 *
 * A ordem das checagens é deliberada: **a permissão é validada antes do cargo**.
 * Um nome errado é erro de programação e vale ser gritado mesmo quando quem
 * chamou não tinha cargo nenhum — se o cargo fosse checado primeiro, a chamada
 * `hasPermission(jogadorComum, 'players.explod')` responderia "sem cargo" e o
 * erro de digitação ficaria escondido atrás de uma negação legítima até o dia
 * em que um admin de verdade tentasse usar aquela porta.
 *
 * @param {string|null|undefined} role  o valor cru de `staff_roles.role`
 * @param {unknown} permission
 * @returns {{allowed: boolean, reason: string|null, permission: string|null, given: unknown, role: string|null, legacy: boolean}}
 */
function decide(role, permission) {
  const { name, wasLegacy } = normalize(permission);
  const base = {
    allowed: false,
    permission: typeof name === 'string' ? name : null,
    // O que o chamador realmente passou, preservado para o log. Sem isto, um
    // `hasPermission(actorId, 20)` produz uma mensagem sobre `null`, e quem lê
    // não descobre que o problema é um nível numérico legado.
    given: permission,
    role: typeof role === 'string' ? role : null,
    legacy: wasLegacy
  };

  if (!isWellFormed(name)) {
    // Nome no vocabulário antigo que nenhum alias cobre é DESCONHECIDO, não
    // malformado. Ver `LEGACY_SHAPE`.
    const pareceLegado = typeof name === 'string' && LEGACY_SHAPE.test(name);
    return { ...base, reason: pareceLegado ? DENIAL.UNKNOWN_PERMISSION : DENIAL.MALFORMED_PERMISSION };
  }
  const capability = CAPABILITIES[/** @type {string} */ (name)];
  if (!capability) {
    return { ...base, reason: DENIAL.UNKNOWN_PERMISSION };
  }
  if (capability.status === 'reserved') {
    return { ...base, reason: DENIAL.RESERVED_PERMISSION };
  }

  if (typeof role !== 'string' || role === '') {
    return { ...base, reason: DENIAL.NO_ROLE };
  }
  const granted = ROLE_CAPABILITIES[role];
  if (!granted) {
    return { ...base, reason: DENIAL.UNKNOWN_ROLE };
  }
  if (!granted.includes(/** @type {string} */ (name))) {
    return { ...base, reason: DENIAL.NOT_GRANTED };
  }

  return { ...base, allowed: true, reason: null };
}

/**
 * Frase de log para uma negação. Existe para que os quatro consumidores
 * (gamemode, painel, bot, testes) digam a mesma coisa sobre a mesma causa —
 * e para que o motivo `reserved_permission` não seja lido como "sem cargo",
 * que é a confusão mais cara possível aqui.
 *
 * @param {ReturnType<typeof decide>} decision
 */
function explain(decision) {
  const nome = decision.permission ?? '(malformada)';
  switch (decision.reason) {
    case DENIAL.MALFORMED_PERMISSION:
      // O caso não-string tem redação própria porque tem causa própria e é a
      // que já custou caro uma vez: doze chamadas passavam nível numérico
      // contra um `Set` de strings e negavam tudo em silêncio, inclusive para
      // `owner`.
      if (typeof decision.given !== 'string') {
        return (
          `recebeu ${typeof decision.given} (${JSON.stringify(decision.given)}) em vez de um nome de permissão. ` +
          `Provavelmente um nível numérico legado — use uma destas: ${activePermissions().join(', ')}`
        );
      }
      return (
        `permissão malformada '${decision.given}': esperado 'dominio.acao' minúsculo, com exatamente um ponto`
      );
    case DENIAL.UNKNOWN_PERMISSION:
      return (
        `permissão desconhecida '${nome}': nenhum cargo a concede, então isso nega sempre. ` +
        `Ativas: ${activePermissions().join(', ')}`
      );
    case DENIAL.RESERVED_PERMISSION:
      return `permissão '${nome}' está RESERVADA: o nome existe, o poder ainda não — ${CAPABILITIES[nome]?.enforcedAt || 'sem ponto de aplicação'}`;
    case DENIAL.UNKNOWN_ROLE:
      return `cargo desconhecido '${decision.role}': não está em staff_roles conhecidos (${ROLES.join(', ')}); nega tudo`;
    case DENIAL.NO_ROLE:
      return `sem cargo de staff`;
    case DENIAL.NOT_GRANTED:
      return `cargo '${decision.role}' não tem '${nome}'`;
    default:
      return 'permitido';
  }
}

/**
 * Atalho booleano. Use `decide` quando precisar do motivo — o painel precisa,
 * porque ele audita a negação.
 *
 * @param {string|null|undefined} role
 * @param {unknown} permission
 */
function roleHasPermission(role, permission) {
  return decide(role, permission).allowed;
}

/**
 * As capabilities de um cargo, já resolvidas. Devolve `[]` para cargo
 * desconhecido — que é o mesmo resultado de negar tudo, e é o certo.
 *
 * @param {string|null|undefined} role
 * @returns {string[]}
 */
function capabilitiesForRole(role) {
  if (typeof role !== 'string') return [];
  return [...(ROLE_CAPABILITIES[role] || [])];
}

/** @param {unknown} name */
function isKnownPermission(name) {
  const { name: resolved } = normalize(name);
  return typeof resolved === 'string' && Object.prototype.hasOwnProperty.call(CAPABILITIES, resolved);
}

/** Nomes ativos, ordenados. Usado em mensagem de erro e nos testes. */
function activePermissions() {
  return Object.keys(CAPABILITIES).filter((name) => CAPABILITIES[name].status === 'active').sort();
}

/** Nomes reservados, ordenados. */
function reservedPermissions() {
  return Object.keys(CAPABILITIES).filter((name) => CAPABILITIES[name].status === 'reserved').sort();
}

module.exports = {
  CAPABILITIES,
  ROLE_CAPABILITIES,
  ROLES,
  LEGACY_ALIASES,
  DENIAL,
  PERMISSION_SHAPE,
  isWellFormed,
  isKnownPermission,
  normalize,
  decide,
  explain,
  roleHasPermission,
  capabilitiesForRole,
  activePermissions,
  reservedPermissions
};
