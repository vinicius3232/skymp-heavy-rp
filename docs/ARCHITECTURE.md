# Arquitetura do Sistema (SkyMP Heavy RP)

***Português** · [English](ARCHITECTURE.en.md) · [Русский](ARCHITECTURE.ru.md) · [Español](ARCHITECTURE.es.md)*

O servidor de SkyMP Heavy RP opera utilizando uma arquitetura distribuída, separando os serviços críticos para garantir segurança, estabilidade e aderência rígida à regra de **Autoridade do Servidor**.

## 1. Topologia do Servidor

A infraestrutura é dividida nos seguintes módulos:

### 1.1 Banco de Dados (MariaDB/MySQL)
O **MariaDB** é a fonte absoluta de verdade. Todos os serviços se conectam a ele.
- **Tabelas Principais:** `accounts`, `characters`, `character_inventory`, `audit_logs`, `whitelist_applications`, `staff_roles`, `factions`, `holds`, `properties`, `market_stalls`, `crafting_recipes`, `crafting_ingredients`. O schema completo está em `skymp/packages/database/schema.sql` mais as migrations `v2`–`v16`, aplicadas **em ordem** (v6 = `launch_tickets`, v7 = índices das queries quentes, v8 = `game_sessions`, v9 = `characters.gold`, v10 = Afinidade da Alma, v11 = ledger de tesouros institucionais, v12 = ledger do mercado regional, v13 = idempotência de vendas em barracas, v14 = Inventory Framework, v15 = Economy Framework, v16 = silêncio de staff na voz, que sobrevive ao restart).
- Algumas tabelas existem no schema mas ainda não são lidas por nenhum código ativo (`store_purchases`, `trade_routes`, `magic_licenses`, `magic_violations`, `character_diseases`, `staff_permissions`) — pertencem a módulos PARKED (ver 1.4).
- **Regra Restrita:** Nenhuma alteração de estado no jogo (dinheiro, posições, itens) acontece sem ser gravada ou lida do MariaDB. O Node.js não confia em dados soltos na memória por períodos longos sem persistência.

### 1.2 Aplicativo Web e API (`apps/web`)
Desenvolvido em **Express.js / Node.js**.
- Fornece o Painel Web (Whitelist, Staff, perfis fora do jogo).
- Fornece ao **Launcher** a troca de OAuth do Discord (`POST /api/launcher/oauth/exchange`, que também emite o ticket de lançamento) e o recebimento de crash reports. O manifesto de mods **não** vem daqui — vem do `apps/game-api` e do GitHub Releases (ver 1.3.1 e `LAUNCHER_DISTRIBUTION.md`).
- Autenticação obrigatória utilizando `passport-discord`.
- Não confundir com o **Painel do Jogador in-game** (ver 1.4.2), que roda dentro do próprio HUD do SkyMP, não no navegador.
- **Aplicação de personagem** (`/api/apply`, `apply.html`): além de nome/biografia, coleta `motivations`/`weaknesses`/`social_ties` (rubrica de whitelist Heavy RP — ver `SKYMP_RP_DEVELOPMENT_PLAN.md` 8.1). Uma heurística de palavras-chave (`detectsStrongConcept` em `server.js`) sinaliza `characters.needs_extra_review` pra conceitos fortes (nobreza, vampirismo, lycanthropia, Daedra, liderança de facção) — não é um gate automático, só um aviso pra staff prestar mais atenção na revisão; a staff pode anexar `extra_review_notes` pelo painel (`PATCH /api/whitelist/:id`). `skymp/gamemode/whitelist.js` lê `characters` com `ORDER BY id DESC LIMIT 1` ao liberar spawn.

### 1.2.1 Master API (contrato do SkyMP, servido pelo `apps/web`)
`GET /api/servers/:masterKey/sessions/:session` → `{ user: { id, discordId } }`

Este endpoint não foi inventado por nós: é o que o servidor SkyMP chama quando `offlineMode: false` (ver `skymp5-server/ts/systems/login.ts` upstream). O `user.id` que respondemos **vira o `profileId`** do gamemode.

É a peça que tira a identidade das mãos do cliente. Com `offlineMode: true`, o cliente declara o próprio `profileId` no `skymp_config.json` e o servidor acredita — qualquer um edita o arquivo e vira outra pessoa. Com `offlineMode: false`, o `profileId` vem daqui, do mesmo serviço que autenticou o Discord e aprovou a whitelist.

O `master` padrão do SkyMP é `https://gateway.skymp.net`; apontar para o nosso painel é trocar uma string em `server-settings.json`. `masterKey` precisa ser igual dos dois lados (`MASTER_KEY` no `.env` do painel).

Sessões ficam em `game_sessions`, guardadas como hash SHA-256, com `expires_at`, `revoked_at` (ban imediato sem esperar TTL) e `resolve_count` (contagem alta sugere sessão compartilhada entre máquinas).

### 1.3 Bot do Discord (`apps/bot-discord`)
Desenvolvido em **discord.js**.
- Realiza a ponte entre a conta do Discord do usuário e o seu `profileId` no jogo (`POST /api/sync-role`, chamado pelo painel web na aprovação/rejeição de whitelist).
- **Canais de voz temporários** (`voiceChannels.js`, comandos `/voz-criar <nome>` e `/voz-fechar`, staff-only): alternativa prática de voz enquanto o VOIP nativo in-game (`/voz`, ver 1.4.4) não tiver sido ouvido por ninguém. O patch de client que existia para isso foi **descartado** (`docs/technical/VOICE_CLIENT_PATCH.md`); o caminho de captura que existe hoje é o helper nativo WASAPI fora da CEF (`docs/technical/VOICE_NATIVE_HELPER.md`), e o estado geral da voz está em `docs/technical/SKYVOICE_PRODUCTION_READINESS.md`. Canal é apagado automaticamente ~30s depois de ficar vazio. Os comandos são registrados no boot do bot (`deploy-commands.js` roda no evento `ready`); uma falha ali não derruba o bot, mas grita no log. `npm run deploy-commands` continua existindo pra rodar à mão.
- **Log de moderação** (`moderationLog.js`, endpoint interno `POST /api/moderation-log`): posta um embed num canal configurável (`MODERATION_LOG_CHANNEL_ID`) a cada ação de moderação. Era a intenção original registrada aqui e ficou anos sem implementação; entrou em 07/08/2026.

  **O canal não é o registro — é notificação.** O registro continua sendo `audit_logs`, escrito pelo gamemode e pelo painel no mesmo fluxo da ação, antes de qualquer coisa sair para o Discord. A distinção decide o comportamento em falha: se o Discord estiver fora, a ação de moderação acontece do mesmo jeito, nada é desfeito e nada fica lento. O endpoint responde **202 antes** de falar com o Discord, e nenhum produtor faz `await` do envio.

  | Evento | Produtor | Origem |
  |---|---|---|
  | `kick` | `admin-service.kickPlayer` (`/kick`) | `gamemode` |
  | `permakill` | `admin-service.retireCharacter` (`/permakill`) | `gamemode` |
  | `whitelist_approve` / `whitelist_reject` / `whitelist_reset` | `apps/web` `PATCH /api/whitelist/:id` | `painel` |
  | `ban` | **nenhum** — ver abaixo | — |

  **`ban` está declarado e não tem produtor.** `ban` é uma permissão que os cargos `admin` e `owner` concedem em `admin-service.js` e que **nenhum comando consome**: não existe `/ban` no gamemode nem no painel. O tipo de evento fica declarado (com teste travando o formato) para que o dia em que o comando existir custe uma linha, mas o log não inventa uma ação que o servidor não tem.

  **Por que push e não polling de `audit_logs`.** O bot tem `mysql2` em `dependencies` sem usar, então ler a tabela era possível. Descartado: daria credencial de banco a um terceiro processo para ler o que ele não escreve, em troca de latência de polling. O push sai de onde a ação acontece, e o único segredo que atravessa é o `INTERNAL_API_SECRET` que o painel já compartilha com o bot. O gamemode usa `http.request` do core em vez de `fetch` — a versão do Node embutida no SkyMP não é controlada por nós, e `fetch` global só existe do Node 18 em diante.

  **Canal vazio desliga o envio.** Sem `MODERATION_LOG_CHANNEL_ID` o endpoint continua respondendo 202 e não posta nada; sem `BOT_INTERNAL_URL`/`INTERNAL_API_SECRET` no `.env` do gamemode, o gamemode nem tenta. Servidor que não quer o canal não paga nada e não vê erro. O canal deve ser privado da staff: os embeds carregam motivo de kick e notas de revisão de whitelist.

  Testado com `discord.js` mockado (21 testes), no mesmo padrão dos 19 que já existiam. O que não é coberto: postar no canal de verdade, que precisa de bot e guild reais.

### 1.3.1 API do Jogo (`apps/game-api`)
Express, porta `GAME_API_PORT` (7758) — a porta que o launcher sempre chamou e para a qual não havia servidor. Detalhes em `docs/technical/LAUNCHER_DISTRIBUTION.md`.
- **`GET /mods.json`**: manifesto de paridade de modpack (`{mods, loadOrder}`), gerado offline por `scripts/generate-mods-manifest.js` a partir da pasta `Data/` de referência. Manifesto ausente ou corrompido responde **503**, nunca lista vazia — lista vazia passaria na verificação do launcher e deixaria qualquer modpack entrar.
- **Fila** (`POST /api/queue/join`, `POST /api/queue/status`): capacidade fixa, FIFO, com expiração de reserva pra que quem fecha o launcher depois de admitido não segure o slot para sempre. Autenticada por ticket de uso único emitido pelo painel (`launch_tickets`, migration v6) — `discordId` é público e não serve como prova de identidade.
- **Sessão de jogo**: ao admitir alguém, grava uma linha em `game_sessions` (migration v8) e devolve o token ao launcher, que o escreve como `session` no `skymp_config.json`. É esse token que o servidor SkyMP resolve contra o master API (ver 1.2.1) — é assim que a identidade deixa de ser uma declaração do cliente.
- **`POST /internal/session/resolve` / `/release`** (`X-Internal-Secret`): liberação de slot na desconexão. O `resolve` virou redundante depois que o caminho nativo de sessão passou a existir — mantido só enquanto o teste in-game não confirma o fluxo do master API.

### 1.4 Servidor Nativo SkyMP (Gamemode)
Localizado em `skymp/gamemode/`.
- Executado em Node.js usando as bibliotecas internas do SkyMP (`mp.events`, `mp.players`).
- Lida com o ciclo de vida do jogador: conexão, desconexão, spawn, combate, comandos de chat e persistência de itens em tempo real.
- Delega regras de negócio aos serviços ativos hoje (`governance-service.js`, `market-stalls-service.js`, `death-service.js`, `player-panel-service.js`, `voip-service.js`, `soul-service.js`, `trade-service.js`, `nametag-service.js`). **Cinco** outros serviços existem no disco (`economy-regional.js`, `crafting-service.js`, `jobs-service.js`, `housing-service.js`, `horse-service.js`) mas estão **PARKED** — nunca registrados em `core/module-registry.js`, logo nunca rodam em produção (ver comentário em `phase0-basic.js`). O `trade-service` saiu dessa lista em 13/08/2026, quando passou a rodar sobre o Inventory Framework (`docs/framework/INVENTORY_FRAMEWORK.md`). Outros cinco (`economy-service`, `justice-service`, `faction-service`, `survival-service`, `disguise-service`) foram **apagados** por duplicarem sistemas ativos ou por serem inseguros — ver `docs/technical/PARKED_SERVICES_DECISION.md`.
- Módulos são registrados e ligados/desligados via `core/module-registry.js` (flags `ENABLE_*` no `.env`), que também cuida de dependências entre módulos e do registro automático de comandos no `core/command-registry.js`.
- **Configuração de gameplay** vem de `skymp/config/server-options.<env>.json`, carregada e validada por `core/server-options.js`. Só as opções listadas na `SPEC` daquele arquivo fazem efeito — o loader avisa no boot se encontrar uma opção ainda não implementada, e **aborta o boot** se um valor for de tipo errado ou fora do intervalo. Ver `docs/technical/SERVER_OPTIONS_SCHEMA.md`.
- **Domínio da Afinidade da Alma** em `core/soul.js` — gerador com orçamento fixo, bandas, semente derivada da ficha aprovada e resolução em quatro resultados. É **função pura**: não abre banco, não toca `mp`, não tem efeito colateral. Existe antes do serviço justamente por isso — é provável fora do servidor, e é onde estar errado sai mais caro depois. Desenho em [`docs/design/SOUL_AFFINITY.md`](design/SOUL_AFFINITY.md); o **serviço** que fala com o mundo (`soul-service.js` — sinais, marcas, árvore) existe desde 07/08/2026, registrado atrás de `ENABLE_SOUL_SERVICE`, fase `lab`, **desligado por padrão**: como `hit-events`/`espm`/`safe-zones`, está confirmado por teste automatizado e **não** confirmado em sessão real (Etapa 9.4 do `FASE_0_ROTEIRO.md`).
- **Tipagem da API `mp`**: `skymp/gamemode/types/mp.d.ts` (o SkyMP não publica typings). `npm run typecheck` é informativo — o gamemode continua JS puro carregado direto pelo servidor, sem passo de build.
- **Três módulos `core/` vindos do estudo do Red House** (`hit-events`, `espm`, `safe-zones` — ver 1.4.5 a 1.4.7). Não são serviços e não aparecem no `module-registry`: são camadas que outros módulos consomem. Os três seguem o mesmo princípio, e é o que os separa da origem: **o Red House usa esses mecanismos como autoridade** (recalcula dano, aplica efeito direto); **aqui eles são evidência ou validação de digitação, nunca fonte de verdade sobre estado de jogo.** Atribuição de licença nos cabeçalhos, conforme `docs/technical/LICENSE_AND_AFFILIATION_POLICY.md` §4.

#### 1.4.1 Bridge de UI (CEF)
A comunicação entre o gamemode e a UI CEF (`skymp/ui/`) usa duas properties SkyMP registradas em `phase0-basic.js`:
- **`browserModal`**: canal de modais pontuais (menu de interação, toasts de notificação). `updateOwner` executa `ctx.sp.browser.executeJavaScript('window.handleServerModal(...)')` no cliente.
- **`panelData`**: canal dedicado do Painel do Jogador, no formato `{ channel, data }` — o cliente despacha para `window.handlePanelData(...)` e cada aba (`status`, `governance`, `economy`, `social`) renderiza seu próprio bloco.

No sentido UI→servidor, `mp.onUiEvent` despacha todo evento através de `core/ui-event-router.js`, que roteia pelo prefixo do `uiEvent.type` (ex: `governance:*` → `governance-service.js`, `panel:*` → `player-panel-service.js`). Novos módulos que precisem de UI só chamam `uiEventRouter.register('<prefixo>', handler)` no seu `initialize()` — não é preciso editar `phase0-basic.js` para cada novo tipo de evento.

**Desde 13/08/2026 o roteamento é só isso.** Até então o `dispatch` chamava o handler do prefixo e **depois todos os outros, incondicionalmente** — então `panel:social:rename` chegava ao `governance-service` e `governance:interaction:execute` chegava ao `player-panel-service`. Nenhum dos dois agia sobre evento alheio (os dois recusam o que não reconhecem), mas a proteção era a boa educação de cada handler e não o roteador, e o custo de cada evento crescia com o número de módulos em vez do de eventos. Um evento sem dono agora é registrado uma vez por prefixo — o `type` é escolhido pelo cliente, e um log por ocorrência seria um jeito de encher o disco do servidor de fora.

#### 1.4.1.1 Interaction Framework (`core/interaction-*.js`)
Três módulos `core/` que formam o pipeline de ações contextuais — o menu de "o que dá para fazer com este alvo". Contrato completo em [`framework/INTERACTION_FRAMEWORK.md`](framework/INTERACTION_FRAMEWORK.md); a decisão e as alternativas recusadas em [`technical/ADR_002_INTERACTION_FRAMEWORK.md`](technical/ADR_002_INTERACTION_FRAMEWORK.md).

- **`core/interaction-registry.js`** — o catálogo. Função pura: não toca `mp`, banco, ator nem permissão. Um módulo chama `register({id, target, canSee, canExecute, execute, ...})` no `initialize()` dele.
- **`core/interaction-targets.js`** — traduz o `targetId` que o cliente manda no registro que o servidor já tinha. Só `player` tem resolvedor; os outros seis tipos são vocabulário reservado e falham fechados, com `registerResolver` como ponto de extensão.
- **`core/interaction-service.js`** — o pipeline: rate limit → alvo → schema → permissão → `action-policy` → distância → `canSee` → `canExecute` → deduplicação por `requestId` → `execute` → auditoria.

**A inversão é o ponto.** Antes, para uma barraca aparecer no menu, o `governance-service.js` precisava `require('./market-stalls-service')` por nome fixo dentro de `getInteractionActions` — e `market-stalls` já declarava `dependencies: ['governance']`, então a seta apontava para os dois lados. Hoje quem tem a ação a declara, e a governança não conhece mais o módulo de barracas.

**`canSee` não autoriza nada**: ele decide um menu montado num instante anterior, na máquina de outra pessoa. `execute` refaz o pipeline inteiro. Isso já era verdade por acidente do desenho antigo (as funções de domínio revalidam sozinhas) e virou contrato testado.

**É o único caminho desde 13/08/2026.** O legado saiu inteiro na mesma frente: `governance-service.js` perdeu `getInteractionActions`, `handleInteractionAction`, `validateUiInteractionPayload` e o próprio `handleUiEvent` — a governança **não registra mais prefixo nenhum** no roteador de eventos, porque deixou de ter UI própria. `market-stalls-service.js` perdeu os hooks equivalentes. As funções de domínio (`stopTarget`, `fineTarget`, `arrestTarget`, `buyItem`, …) ficaram intactas e continuam revalidando permissão e alcance por conta própria.

⚠️ **Nunca rodou numa sessão real** — 96 testes verdes, zero jogadores. Mesmo peso que *"ninguém ouviu ainda"* tem na voz (1.4.4). A CEF foi reescrita para `interaction:*` e passa em `node --check`; nenhuma linha dela rodou dentro de um CEF.

Desde 11/08/2026, `core/ui-event-gateway.js` possui o callback global e valida o envelope antes de rotear; `core/ui-event-rate-limiter.js` mede e, quando configurado, limita volume por ator e tipo. `core/connection-monitor.js` controla polling, reconexão e invalidação de respostas antigas da whitelist. Credenciais opacas são geradas, hasheadas e redigidas por `core/opaque-credential.js`. Na economia, `core/institutional-treasury-service.js` e `core/regional-market-transaction-service.js` executam saldo, estoque e ledger na mesma transação; a migration v13 torna retries de barracas idempotentes. Essas fronteiras estão testadas, mas os módulos PARKED continuam fora do boot.

#### 1.4.2 Painel do Jogador (in-game)
`player-panel-service.js` — módulo `player-panel` (`ENABLE_PLAYER_PANEL_SERVICE`), ativado pelo comando `/painel`. Não duplica lógica de negócio: só agrega leituras de outros serviços já existentes.
- **Status**: vida/magicka/stamina lidas via `mp.callPapyrusFunction('method', 'Actor', 'getActorValue', ...)` (mesmo padrão de `death-service.js`), ouro via `core/transaction-service.js`, estado RP via `core/character-state.js`. Atualizado por polling de 2s enquanto o painel está aberto, só reenviando quando o valor muda.
- **Governança**: `governance-service.getMyGovernanceSummary()`.
- **Economia**: `market-stalls-service.getMyEconomySummary()`.
- **Social**: lista de `character_known_identities` do próprio personagem.
- UI em `skymp/ui/player-panel.css` / `player-panel.js`, com identidade visual espelhando o [Prisma UI](https://prismaui.dev) (glass card preto, glow violeta, chip de status, navegação em pílulas com runas Elder Futhark como ícone de cada aba).
- **Atualização proativa**: `core/panel-refresh-bus.js` é um `EventEmitter` desacoplado — `governance-service.js` chama `panelRefreshBus.requestRefresh(actorId, 'governance'|'status')` após multa, mandado ou prisão, e o `player-panel-service.js` (assinante único, registrado em `initPlayerPanelService`) reenvia a seção correspondente **só se o painel daquele jogador já estiver aberto**. Existe pra evitar que `governance-service.js` precise depender de `player-panel-service.js` (que já depende dele), sem forçar o painel a abrir sozinho na tela do jogador.
- **Ação direta na aba Social**: cada pessoa conhecida tem um botão "Apelidar" que abre um mini-formulário inline (`skymp/ui/player-panel.js`, `socialRow`/`bindSocialRenameHandlers`) e envia `panel:social:rename` com `{ targetCharacterId, alias }`. `player-panel-service.renameKnownPerson` chama `identity-service.upsertKnownIdentity` diretamente pelos characterIds — funciona mesmo com o alvo desconectado, já que `character_known_identities` não depende de um actorId ativo.

#### 1.4.3 Morte e Consequência (`death-service.js`)
Módulo `death` (`ENABLE_DEATH_SERVICE`), fase `lab`. Existe pra que "morrer" tenha peso mecânico e social, não seja um non-event — princípio central de Heavy RP do `SKYMP_RP_DEVELOPMENT_PLAN.md` (seção 8.1, "Morte e Consequências").
- Morte → `core/character-state.js` vira `DOWNED`, o que já bloqueia gameplay/combate/fala via `core/action-policy.js` sem trabalho extra. O gatilho primário é o hook nativo **`mp.onDeath(actorId, killerId)`**, que dispara no frame da morte; o polling de 2s continua como rede de segurança enquanto o hook não é confirmado numa sessão real (`handlePlayerDowned` é idempotente por personagem, então os dois caminhos juntos não duplicam nada). **O hook pertence a `core/death-events.js`**, não ao `death-service`: um barramento pequeno e nomeado, no modelo do `panel-refresh-bus`, que atribui `mp.onDeath` uma vez só e despacha para assinantes nomeados, cada um isolado por `try/catch`. Existe porque `mp.onDeath = ...` direto é posse exclusiva — o segundo módulo que precisasse do mesmo evento apagaria o primeiro **em silêncio**, e o polling disfarçaria a perda com dois segundos de atraso. O segundo consumidor já está previsto (`hunting-service`, ver [`HOSTILE_MOB_ACTIVATION_DECISION.md`](technical/HOSTILE_MOB_ACTIVATION_DECISION.md) §7.3).
- **Autoria**: `mp.onDeath` entrega `killerId` — quem matou, `0` quando não há autor. Gravado em `audit_logs` como `death:killer` e carregado até o bleed-out, que acontece minutos depois. É atribuição, diferente da proximidade do `logDeathContext`, que é circunstancial: numa briga de cinco pessoas, cinco nomes aparecem e a staff decide no olho.
- **Socorro**: `/socorrer <actorId>` (qualquer jogador, dentro de `RESCUE_RANGE`) cancela o sangramento e estabiliza o alvo de volta pra `NORMAL` com vida parcial (`STABILIZE_HEALTH`). Alcance validado por `core/range-utils.js` (extraído de `governance-service.js`, usado por ambos).
- **Bleed-out**: se ninguém socorre dentro de `BLEED_OUT_MS` (4min), o personagem vira `DEAD`, uma penalidade de ouro é aplicada via `core/transaction-service.removeGold` (atômico — nunca deixa saldo negativo), e só então o respawn acontece no ponto seguro de sempre.
- **Evidência anti-RDM**: no momento do bleed-out, `logDeathContext` grava em `audit_logs` (`action='death:context'`) um snapshot de quem estava por perto (mesmo raio de proximidade do chat `say`) — é circunstancial, não atribuição. A atribuição de quem matou vem do `killerId` do `mp.onDeath` (ver acima); o snapshot de proximidade continua útil porque mostra **quem estava na cena**, que é a pergunta que a staff faz numa denúncia de RDM em grupo.
- Cada transição (`DOWNED`/socorrido/penalizado/respawnado) chama `panelRefreshBus.requestRefresh(actorId, 'status')`, refletindo em tempo real no `/painel`.
- **Camada mínima de RP pro combate**: sem hook nativo confiável de "quem atacou quem" nesta base, então o escopo é evidência, não enforcement. `/iniciar <actorId> <motivo>` grava uma marcação explícita de abertura de conflito IC em `audit_logs` (`combat:initiate`). Em paralelo, o mesmo polling de HP que detecta `DOWNED` também roda `checkDamageSpike` a cada tick — uma queda de vida `>= DAMAGE_SPIKE_THRESHOLD` (heurística, 25 pontos) num único tick de 2s dispara `logDeathContext(..., 'damage_spike')`, criando um rastro de proximidade mesmo quando ninguém usa `/iniciar`. `core/range-utils.js` ganhou `nearbyActors()` pra não duplicar a lógica de varredura de vizinhos entre o contexto de morte e o de dano.

**Morte permanente (soft-delete):** `admin-service.retireCharacter(actorId, targetActorId, reason)`, comando `/permakill` (permissão `retire_character`, tiers `admin`/`owner` apenas — nunca moderador). Nunca faz `DELETE` — só `UPDATE characters SET status='retired'`, motivo obrigatório e audit log. `whitelist.js` só permite spawn com `status='approved'`, então um personagem `retired` nunca mais entra em jogo sem precisar de nenhuma outra mudança.

#### 1.4.4 Voz por Proximidade (`voip-service.js`)
Módulo `voip` (`ENABLE_VOIP_SERVICE`), fase `lab`. Sinalização WebRTC (offer/answer/ICE) por WebSocket próprio (porta `VOIP_PORT`, padrão 7778) — o áudio em si é P2P entre clientes depois do handshake, o servidor só troca a sinalização e calcula volume por distância a cada 2s. Os raios vêm de `core/proximity-ranges.js`, que é a fonte única de chat **e** voz — antes as duas tabelas divergiam (voz sussurrava a 200, chat a 450), então o mesmo gesto de chegar perto pra falar baixo funcionava ou não dependendo do canal escolhido.

**Desde 07/08/2026 há um segundo caminho, e ele é o que vai valer.** O WebRTC P2P acima nunca produziu áudio: o CEF do client recusa `getUserMedia`, e a flag do Chromium que liberava foi *removida de propósito* na SkyrimPlatform 2.1 — revertê-la exporia o microfone do jogador a qualquer servidor SkyMP que ele conectasse depois. Agora um helper nativo (`voice-helper/`) captura fora do navegador e manda `audio_frame` pelo mesmo socket e o mesmo ticket; o servidor **retransmite** por proximidade com o volume anexado, reaproveitando o resultado do tick de 2s, e o navegador só toca. Isso também resolve NAT/CGNAT, que travaria a malha P2P. Os dois caminhos convivem: a Fase 2 remove o antigo. Ver [`technical/VOICE_NATIVE_HELPER.md`](technical/VOICE_NATIVE_HELPER.md).

**Antes desta revisão o recurso existia só no papel** — nada em `phase0-basic.js` chamava `startVoipServer()`, e o listener `mp.events.add('voip:connect', ...)` no cliente nunca disparava porque nenhum código do servidor faz `mp.trigger`/emit desse evento em lugar nenhum do gamemode. Não era um indicador visível quebrado (o chip de status é `display:none` até `setStatus()` rodar, e isso nunca acontecia) — a feature estava simplesmente ausente, silenciosamente.

- **Opt-in via `/voz`** (não é forçado — e desde 07/08/2026 **voz nativa não é pré-requisito de lançamento**: a decisão está fechada na seção 13 do `SKYMP_RP_DEVELOPMENT_PLAN.md`, que classifica este módulo como opcional/Pós-Alfa e aponta os canais de voz do Discord (1.3) como a solução real da Alfa e da Beta fechada). O comando chama `requestVoiceConnection`, que emite um ticket de uso único (`issueTicket`, TTL de 30s) e empurra `{actorId, ticket, host, port}` pro cliente via a property `voipTicket` (mesmo padrão comprovado de `browserModal`/`panelData`).
- **Autenticação por ticket**: o handshake WebSocket (`{type:'auth', actorId, ticket}`) exige que o ticket bata com o que foi emitido pra aquele `actorId` — sem isso, qualquer processo que conectasse em `ws://127.0.0.1:7778` podia reivindicar o `actorId` de outro jogador e sequestrar o slot de voz dele. Ticket é consumido no primeiro uso (replay falha).
- **Host dinâmico**: como `skymp/ui/index.html` é um arquivo estático sem templating, ele não tem como saber o IP público do servidor sozinho — por isso o servidor manda `host`/`port` no próprio payload do ticket (`VOIP_PUBLIC_HOST`/`VOIP_PORT` no `.env`), em vez do cliente ter `ws://127.0.0.1:7778` fixo no código (o que só funcionava com jogador e servidor na mesma máquina).
- `VOIP_BIND_HOST` (padrão `127.0.0.1`) controla em quais interfaces o `WebSocketServer` escuta — não confundir com `VOIP_PUBLIC_HOST`, que é o que o cliente recebe pra conectar.
- **O caminho de falha é parte do desenho, não um resto.** No client oficial `getUserMedia` devolve `NotAllowedError` (ver `docs/technical/VOICE_CLIENT_PATCH.md`), e é isso que o jogador vai encontrar até a decisão da seção 13 ser revisitada — então esse é o caminho comum, não a exceção. `skymp/ui/index.html` fecha a sinalização e mostra o motivo em dois lugares: o chip de status (estado) e o `chat-log` (o porquê, apontando `/voz-criar` no Discord). O `onclose` não pode sobrescrever um motivo terminal já exibido — sozinho ele diria "VOZ DESCONECTADA", que lê como instabilidade de servidor e manda o jogador abrir o ticket errado.

#### 1.4.5 Evidência de Combate (`core/hit-events.js`)
Não é módulo do registry: é uma camada que o `death-service` consome. Origem no Red House (`docs/technical/REFERENCE_STUDY_SKYMP_RED_HOUSE.md` §4.1), com atribuição de licença no cabeçalho do arquivo.

- **O mecanismo**: `mp.makeEventSource('_onHitReported', <snippet>)` injeta no cliente um trecho que escuta `ctx.sp.on('hit', ...)` do Skyrim Platform e reporta `{target, aggressor, isPowerAttack, isSneakAttack, isBashAttack, isHitBlocked}`. Existe porque o SkyMP **recusou** expor o pacote de hit ao gamemode (issue #1338) — o evento é reconstruído do lado do cliente.
- **É evidência, não enforcement, e essa é a decisão central.** O Red House recalcula o dano a partir deste evento e escreve no ActorValue; aqui isso não acontece e não deve passar a acontecer. Quem manda o evento é a máquina do jogador, e o `CONTRIBUTING.md` §3.6 é explícito: evento de cliente é *"uma dica, não uma prova"*. Usar isto para decidir dano entregaria o combate a quem controla o cliente. A própria linha gravada carrega `origem: 'cliente (makeEventSource) — evidencia, nao prova'`, para que ninguém a trate como prova numa arbitragem.
- **Agrega em episódio, não grava golpe a golpe.** O episódio abre no primeiro golpe entre um par `agressor:alvo` e fecha por silêncio (`JANELA_MS`, 10 s sem golpe novo); só então o `death-service` grava uma linha em `audit_logs` (`action='combat:episode'`) com contagem, tipos de golpe e duração. Uma briga gera dezenas de eventos — gravar por golpe inutilizaria a tabela justamente quando a staff mais precisa dela.
- **Descarta dano em si mesmo** (`agressor === alvo`): queda, veneno e fogo amigo do próprio feitiço não são agressão entre pessoas e não interessam a arbitragem de RDM. Teto de `MAX_GOLPES_POR_EPISODIO` (200) — passado esse ponto o número exato deixa de importar.
- **O snippet de cliente é mantido curto de propósito** e engole os próprios erros: ele roda no loop do jogo da máquina de outra pessoa, sem depuração remota, e derrubá-lo mataria o rastro de todos os golpes seguintes daquele jogador. Agregação, throttling e decisão ficam do lado do servidor.
- **Substitui o `checkDamageSpike`** do `death-service` (ver 1.4.3), que chama de agressão qualquer queda de 25 de vida num tick de 2 s — não distingue combate de queda de penhasco e não sabe quem bateu. **Os dois coexistem hoje**; a heurística só sai quando a Fase 0 confirmar que o evento chega.
- **Estado de validação**: `mp.makeEventSource` foi confirmada num servidor real (o boot registra o evento), mas **o snippet de cliente nunca rodou** — ele só executa quando alguém conecta. É a Fase 0 (`FASE_0_ROTEIRO.md`, etapa 9).

#### 1.4.6 Validação de Item contra os Plugins (`core/espm.js`)
`mp.lookupEspmRecordById(baseId)` deixa o servidor ler os records dos ESMs carregados, então dá para conferir se um `base_id` existe e é mesmo um item — em vez de gravar qualquer número no inventário. Descoberta pelo estudo do Red House; **o formato do retorno foi lido de um servidor real, não inferido.**

- **Ligado nos dois pontos onde um `base_id` novo entra no sistema**: `/additem` e o anúncio em barraca. Nos dois o valor vem digitado à mão em hexadecimal, e antes disto um dígito errado gravava `character_inventory` do mesmo jeito — o item nunca aparecia in-game, mas ocupava linha no banco e no ledger, e ninguém descobria até alguém conferir inventário à mão. Na barraca é pior: alguém paga por uma linha que nunca vira item na tela.
- **O detalhe que uma implementação adivinhada erraria**: FormID inválido devolve `{}` — objeto vazio e **truthy** —, então `if (r)` faria o Player passar como item. A checagem correta é `r && r.record`, e há teste de mutação para isso.
- **Lista de permissão, não de bloqueio**: `TIPOS_DE_INVENTARIO` (`WEAP`, `ARMO`, `MISC`, `ALCH`, `AMMO`, `BOOK`, `INGR`, `KEYM`, `SLGM`, `SCRL`, `LIGH`). Um FormID digitado errado cai em qualquer record do jogo — célula, quest, som, perk — e a pergunta certa é "isto é um item?", não "isto é uma das coisas que eu lembrei de proibir".
- **Deixa passar quando não dá pra saber.** Se a API não existe (servidor antigo, ambiente de teste) ou falhou, o retorno é marcado `indisponivel` e `pareceItem` responde `ok`. Só nega quando a API respondeu **e** respondeu que aquele FormID não é item — senão a validação viraria uma quebra de `/additem` em vez de um diagnóstico. **É validação de digitação, não autoridade** — mesma escolha de 1.4.5, pelo mesmo motivo.
- **Cache** por `baseId`, guardando só `type` e `editorId`: o retorno cru traz todos os fields do record em bytes, e a load order não muda em runtime.
- Assinatura documentada em `types/mp.d.ts` marcada como `[USO]`, com a procedência.

#### 1.4.7 Zonas Seguras (`core/safe-zones.js`)
A `core/action-policy.js` passa a bloquear **por lugar**, não só por estado do personagem. Origem no Red House, que checa a property `isInSafeLocation` antes de aplicar dano.

- **Responde onde alguém está e o que aquele lugar proíbe.** `zoneOf(actorId)` lê `mp.get(actorId, 'locationalData')` e casa com a config; `blocksCategory` responde por categoria da `action-policy`. A `canPerform` ganhou essa dimensão usando o `context` que já estava declarado como "para validações futuras".
- **A regra dos dois lados**, com teste próprio: uma ação entre duas pessoas é barrada se **qualquer uma** estiver protegida (`blocksBetween`). Proteger só o alvo deixaria alguém atirar de dentro da zona para fora dela.
- **Estado é checado antes de lugar.** Para quem está algemado dentro de uma zona segura, *"você está algemado"* é a explicação útil.
- **A lista de zonas nasce vazia.** Config em `skymp/config/safe-zones.json`; ausente ou com `enabled !== true`, o módulo responde "não há zona nenhuma" e nada muda — mesmo padrão do `npc-cleaner`, pelo mesmo motivo: config ausente não pode virar comportamento surpresa. **O mecanismo está entregue, a política não**: zona segura é mecânica de mundo, e a Constituição §15 pede as 15 perguntas antes. As quatro que mais mudam o desenho estão em `skymp/config/safe-zones.example.json` — a principal é se cidade sob trégua deve ser zona segura ou acordo IC que a guarda faz cumprir (a segunda gera história, a primeira gera regra).
- **Config quebrada fica inerte e grita.** JSON inválido não vira "tudo é zona segura" (desligaria o combate do servidor) nem "nada é" em silêncio; categoria desconhecida numa zona é ignorada com erro no log — categoria que não existe é uma regra que quem escreveu acha que criou e não criou —, e zona que não proíbe nada é descartada.
- **Sem `pos`/`radius` válidos, a zona é a célula inteira.** É grosseiro de propósito: "a taverna toda" é uma decisão mais fácil de acertar que um raio em unidades do Skyrim, e não exige medir nada in-game.
- **Custo**: `locationalData` é leitura de property servida do cache do servidor, não ida ao Papyrus — não paga os 13–35 ms medidos pelo Red House. Por isso dá para consultar a cada ação sem orçamento especial.
- **Nenhum chamador atual mudou de comportamento**, e isso tem teste: a checagem de lugar só acontece quando quem chama informa `context.actorId`, e nenhum dos quatro chamadores existentes informa. Uma regressão aí ligaria zona segura no servidor inteiro sem ninguém pedir.

#### 1.4.8 Etiqueta de Identidade (`nametag-service.js`) e revelação por staff
Módulo `nametag` (`ENABLE_NAMETAG_SERVICE`), fase `lab`, **desligado por padrão**. Prova de conceito da etiqueta acima da cabeça — o degrau que faltava do [`technical/NAMETAG_IDENTITY_SYSTEM.md`](technical/NAMETAG_IDENTITY_SYSTEM.md).

- **A projeção mundo→tela roda no cliente, não no servidor.** `worldPointToScreenPoint` é função nativa do processo do jogo, chamada pelo snippet que o servidor injeta via `mp.makeProperty`/`updateOwner`. O bloqueio histórico — "nametag por quadro inviabiliza o servidor" — vinha das medições do Red House (13–35 ms por chamada Papyrus), que são **ida e volta pela rede** entre servidor e cliente. Este caminho não paga isso, então o argumento que bloqueava a feature não se aplica a ele.
- **Duas frequências, porque são duas grandezas.** Nome e alvo a cada 2 s (o mesmo tick da voz — nome só muda quando alguém se apresenta); posição na tela até 20 Hz no cliente, porque a 2 s a etiqueta não parece atrasada, parece quebrada. Não é por quadro: o custo não é a projeção, é o `executeJavaScript` atravessando para a CEF — **não medido**, então o padrão é conservador.
- **Uma etiqueta, a do mais próximo.** Dez provariam o mesmo e multiplicariam por dez um custo de CEF que ninguém mediu.
- **Não chama `getDisplayName()` por dentro** — é requisito, não conveniência. Quando o disfarce virar degrau daquela função, a etiqueta passa a mostrar o nome disfarçado sem uma linha de mudança.
- **`/revelaridentidade`** (permissão `reveal_identity`, `admin` e `owner`) é **comando explícito, não estado passivo**: "staff sempre vê o nome real" não tem evento para auditar, e a regra da escada de exibição pede auditoria. Fora do moderador porque revelar é a única ação de staff que **não desfaz** — kick acaba na reconexão, ouro volta por outro `/setgold`, `/permakill` é soft-delete; identidade revelada mora na cabeça de quem leu. Não escreve em `character_known_identities`: aquilo é conhecimento IC, e gravá-lo faria a staff chamar o alvo pelo nome real no chat para sempre.

⚠️ **A projeção nunca foi executada.** `worldPointToScreenPoint` nunca foi chamada — que seja alcançável por este caminho é **inferência**, não observação. A convenção dos eixos não foi verificada, ponto atrás da câmera é buraco conhecido, o custo a 20 Hz não foi medido, e ninguém validou com dois clientes. Tem o mesmo peso que *"ninguém ouviu ainda"* tem na voz nativa (1.4.4).

#### 1.4.9 Instrumentos de observação da Fase 0 (`fauna-census.js`, `corpse-probe.js`)
Módulos `fauna-census` (`ENABLE_FAUNA_CENSUS`) e `corpse-probe` (`ENABLE_CORPSE_PROBE`), fase `lab`, **desligados por padrão**, os dois atrás da permissão `run_world_probe` (`admin` e `owner`). São as Peças 1 e 2 da §16 do [`technical/HOSTILE_MOB_ACTIVATION_DECISION.md`](technical/HOSTILE_MOB_ACTIVATION_DECISION.md); protocolo de sessão em [`technical/FAUNA_CENSUS_PROTOCOL.md`](technical/FAUNA_CENSUS_PROTOCOL.md).

**São a razão de o `module-registry` ter dez módulos e esta seção descrever oito mecânicas: nenhum dos dois é mecânica.** Não dão item, não mudam estado de personagem, não entram em cadeia de gameplay nenhuma. Existem para responder duas perguntas que decidem se a mecânica de caça pode existir, e devem sair do registry quando as responderem.

- **`/censofauna` é somente-leitura, e é a única regra que ele tem.** Varre `mp.getActorsByProfileId(0)`, lê `baseDesc` e distância, agrega por record e escreve em `skymp/artifacts/`. **Nenhum `callPapyrusFunction` no laço** — e o argumento não é o custo (embora 13–35 ms × centenas de atores baste): um instrumento de observação que chama função no motor deixou de ser observação. A leitura cara fica isolada em `/censofauna alvo <actorId>`, um ator por vez.
- **`/sondacadaver <actorId>` escreve, e por isso tem flag própria.** Quatro passos — ler, esvaziar, **reler**, restaurar. O terceiro separa *"`mp.set` não lançou"* de *"`mp.set` funcionou"*: uma API que aceita a chamada e ignora o valor em silêncio é o caso mais provável de todos, e o único que checar exceção nunca pegaria. O quarto devolve o mundo ao estado anterior e prova a escrita duas vezes.
- **Recusa dupla e independente: a sonda nunca toca inventário de jogador.** `getActiveCharacterData` cobre quem tem personagem carregado; a varredura de `profileId` 1..50 cobre quem conectou e ainda não escolheu. Uma sozinha deixaria janela — e `mp.set(id,'inventory',{entries:[]})` num ator de jogador apaga meses de coisa que passou pelo `transaction-service`.

⚠️ **Nenhum dos dois rodou.** `mp.get(id,'inventory')` e `mp.set(...)` são **[DOC]** (`technical/SKYMP_UPSTREAM_REFERENCE.md` §2.5) e nunca foram exercitadas por este projeto — **nem o formato de retorno é conhecido**, por isso o relatório o grava verbatim. Mesmo peso que *"ninguém ouviu ainda"* tem na voz (1.4.4) e a projeção não executada tem na etiqueta (1.4.8).

### 1.5 Launcher do Cliente (`apps/launcher`)
Desenvolvido em **Electron / React**. Detalhes completos em `docs/technical/LAUNCHER_DISTRIBUTION.md`.
- **Atualização** de cliente e modpack vem de **GitHub Releases** (`VITE_GITHUB_DIST_REPO`), com SHA-256 obrigatório — manifesto sem hash aborta a instalação em vez de instalar sem verificar. Não vem do `apps/web`: o `GET /api/launcher/manifest` que existia lá era um stub com hash falso que ninguém consumia, e foi removido.
- **Paridade em tempo de conexão** (`verify-mods` + `analyze-plugins`) compara hash de cada arquivo em `Data/` e valida masters/load order contra `http://<SERVER_IP>:<VITE_API_PORT>/mods.json`. Esse endpoint é servido pelo `apps/game-api` (ver 1.3.1) — quando este documento dizia que ele não existia, era verdade: o launcher chamava uma porta sem serviço e o passo sempre falhava como "servidor offline". O serviço passou a existir em 05/08/2026. **Ainda não foi exercitado contra um launcher empacotado**, só por teste automatizado.
- **Login**: o launcher só captura o `code` do Discord; a troca por token é feita pelo painel web (`POST /api/launcher/oauth/exchange`), porque qualquer segredo embutido num app distribuído aos jogadores pode ser extraído do instalador.
- Configuração vem de variáveis `VITE_*` embutidas em **tempo de build** pelo `define` do `vite.config.ts` — não existe `.env` do lado do app empacotado.

## 2. Fluxo de Decisão (A Regra de Ouro)

No nosso servidor, a autoridade nunca é delegada ao cliente.

**Exemplo de Fluxo (Pescaria ou Forja):**
1. O jogador (Cliente) aperta um botão para interagir.
2. O Gamemode (Servidor) recebe a requisição, checa se ele tem a vara/recurso e a habilidade necessária no Banco de Dados.
3. O Servidor altera o banco, salva o novo item.
4. O Servidor dispara o `mp.callPapyrusFunction` apenas para o cliente fazer a animação e receber o aviso visual de sucesso.
*(Se um mod local tentar pular a etapa 2, ele falha silenciosamente, protegendo a economia).*

O detalhamento técnico dessa regra — o que um mod consegue e não consegue tocar, por que scripts Papyrus de mod não produzem estado, e o contrato de FormID que obriga paridade de load order — está em `docs/technical/MODS_AND_GAMEMODE_CONTRACT.md`.
