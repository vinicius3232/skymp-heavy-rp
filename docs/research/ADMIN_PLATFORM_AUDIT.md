# Auditoria da plataforma administrativa

**Data:** 2026-08-13 · **Branch:** `research/platform-infrastructure-audit-2026-08-13`
**Escopo:** `apps/web`, `apps/game-api`, `apps/bot-discord`, `skymp/gamemode/admin-service.js`,
`whitelist.js`, tabelas `staff_roles` / `staff_permissions` / `audit_logs` / `whitelist_applications` / `game_sessions`.
**Documentos irmãos:** [`PLATFORM_INFRASTRUCTURE_AUDIT.md`](PLATFORM_INFRASTRUCTURE_AUDIT.md) (launcher, fila, modpack),
[`docs/skyadmin/`](../skyadmin/README.md) (plano SkyAdmin, escrito antes desta auditoria).

---

## 1. Procedência: o que foi verificado, e como

Tudo abaixo foi lido no código desta árvore, não inferido de documentação. Onde
esta auditoria discorda de um documento existente, o código ganha.

| Verificação | Como |
|---|---|
| Rotas do painel | leitura integral de `apps/web/server.js` (846 linhas) |
| Guardas de autorização | busca por `requireAuth`/`requireStaff` em todas as rotas |
| Permissões do gamemode | leitura de `admin-service.js` + busca por `hasPermission(` em todo o gamemode |
| Tabelas reais | `npm run check:schema:list` no gamemode — **63 tabelas** declaradas pelas migrations |
| Cobertura de teste | `apps/web/server.test.js`, `permissions.behavior.test.js`, `parked-staff-permissions.test.js`, `admin-service.test.js` |
| Capacidade do runtime | `skymp/gamemode/types/mp.d.ts` + `core/connection-monitor.js` |
| Discord | `apps/bot-discord/index.js`, `voiceChannels.js`, `moderationLog.js` |

**O que esta auditoria NÃO fez:** não subiu banco, não conectou jogador, não
mediu latência. A [memória do projeto vale aqui](../historico/PHASE_0_TEST_LOG.md):
a Fase 0 ainda não teve uma sessão real com jogador conectado, então tudo que
depende de comportamento em jogo está marcado como **não observado**.

---

## 2. O que existe hoje, dito sem eufemismo

Existem **dois sistemas de permissão que não se conhecem**:

```
                    ┌──────────────────────────────────────┐
  Discord OAuth ──► │ apps/web  requireStaff()             │
                    │   SELECT role FROM staff_roles       │
                    │   → tem linha?  ACESSO TOTAL         │  ← binário
                    │   → não tem?    403                  │
                    └──────────────────────────────────────┘
                                    ▲
                                    │  mesma tabela,
                                    │  leituras independentes
                                    ▼
                    ┌──────────────────────────────────────┐
  SkyMP login ────► │ gamemode  admin-service              │
                    │   SELECT role FROM staff_roles       │
                    │   → ROLE_PERMISSIONS[role]           │  ← granular
                    │   → Set<string> em memória           │
                    └──────────────────────────────────────┘
```

O gamemode tem RBAC de verdade — 12 permissões nomeadas, matriz testada, recusa
de argumento numérico legado, negação com log. O painel web tem um `if`.

---

## 3. Inventário: rotas do painel e o que as protege

`apps/web/server.js`, todas as rotas, na ordem em que aparecem:

| Rota | Guarda | Permissão exigida | Muta estado? |
|---|---|---|---|
| `GET /api/auth/discord` + callback | — | — | cria `accounts` + `discord_identities` |
| `POST /api/auth/logout` | — | — | destrói sessão |
| `GET /api/me` | `requireAuth` | — | não |
| `POST /api/apply` | `requireAuth` | — | **sim** (cria personagem + aplicação) |
| `GET /api/dashboard` | `requireStaff` | **nenhuma** | não |
| `GET /api/whitelist` | `requireStaff` | **nenhuma** | não |
| `PATCH /api/whitelist/:id` | `requireStaff` | **nenhuma** | **sim** |
| `GET /api/characters` | `requireStaff` | **nenhuma** | não |
| `GET /api/audit` | `requireStaff` | **nenhuma** | não |
| `GET /api/economy/holds` | `requireStaff` | **nenhuma** | não |
| `GET /api/economy/top-gold` | `requireStaff` | **nenhuma** | não |
| `GET /api/criminal` | `requireStaff` | **nenhuma** | não |
| `GET /api/factions` | `requireStaff` | **nenhuma** | não |
| `GET /api/prison` | `requireStaff` | **nenhuma** | não |
| `POST /api/crashes/client` | rate limit | — | grava arquivo |
| `GET /api/crashes` | `requireStaff` | **nenhuma** | não |
| `GET /api/servers/:masterKey/sessions/:session` | `masterKey` + rate limit | — | incrementa `resolve_count` |
| `POST /api/launcher/oauth/exchange` | rate limit | — | emite `launch_tickets` |
| `GET *` | — | — | devolve `index.html` |

**Doze rotas de staff. Zero verificações de permissão.** A única rota mutável de
staff que existe hoje é `PATCH /api/whitelist/:id` — e um `moderator` recém-promovido
a aprova exatamente como o `owner`.

---

## 4. Achados

Severidade: 🔴 corrigir antes de qualquer staff usar o painel · 🟡 corrigir antes de crescer a equipe · 🔵 dívida declarada.

### 4.1 🔴 `requireStaff` é binário, e a granularidade que existe fica do outro lado do muro

`apps/web/server.js:167` resolve o cargo e joga fora a informação:

```js
const rows = await db('SELECT role FROM staff_roles WHERE account_id = ? LIMIT 1', [...]);
if (rows.length === 0) return res.status(403).json({ error: 'Acesso staff negado' });
req.staff = { role: rows[0].role };   // lido, guardado, nunca consultado
return next();
```

`req.staff.role` não é lido por nenhuma rota. Um `moderator` lê o ranking de
ouro, a ficha criminal de todo mundo, o log de auditoria inteiro e os crash
reports com Discord ID de cada jogador — e aprova whitelist.

O gamemode já decidiu que `manage_whitelist` é permissão de moderador e que
`view_audit` também é. O painel não pergunta nem uma coisa nem outra.

### 4.2 🔴 Três das doze permissões não existem em lugar nenhum — e são justamente as do painel

Busca por cada nome de `KNOWN_PERMISSIONS` em todo o gamemode e em `apps/`:

| Permissão | Onde é verificada |
|---|---|
| `kick` | `admin-service.kickPlayer` |
| `teleport` | `admin-service.playAnimation`, `teleportTo` |
| `add_item` | `admin-service.giveItemAdmin` |
| `set_gold` | `admin-service.setGold`, `economy-regional.js:251` |
| `retire_character` | `admin-service.retireCharacter` |
| `reveal_identity` | `admin-service.revealIdentity` |
| `run_world_probe` | `fauna-census.js` (×2), `corpse-probe.js` |
| `manage_recipes` | `crafting-service.js` (×2) |
| `manage_staff` | `governance-service.js:204`, `market-stalls-service.js` (×2) |
| **`ban`** | **nenhum lugar** |
| **`view_audit`** | **nenhum lugar** (só em comentários) |
| **`manage_whitelist`** | **nenhum lugar** |

`ban` está concedida a `admin` e `owner` desde sempre. Não existe comando de ban,
não existe endpoint de ban, não existe tabela de ban. É uma permissão que
descreve um poder inexistente — a mesma classe de defeito que o próprio
`hasPermission` documenta e recusa (permissão desconhecida "cria uma porta que
nunca abre"), só que na direção oposta: uma porta que existe e não leva a lugar
nenhum.

O teste `permissions.behavior.test.js` não pega isso: ele cobre "todo handler
exportado está na matriz", não "toda permissão declarada tem handler".

### 4.3 🔴 Um cargo que o gamemode não conhece dá acesso total ao painel e zero em jogo

`staff_roles.role` é `VARCHAR(32)` sem `CHECK`, sem `ENUM`, sem FK. O gamemode faz:

```js
const permissions = new Set(ROLE_PERMISSIONS[role] || []);   // admin-service.js:98
staffCache.set(actorId, { role, permissions });
```

Cargo desconhecido → `Set` vazio → nega tudo, **em silêncio**. O painel, na mesma
linha do banco, → `rows.length !== 0` → **libera tudo**.

Isso não é hipotético: os cargos que este briefing pede (`SUPPORT`,
`GAMEMASTER`, `DEVELOPER`, `SUPERADMIN`) caem exatamente nesse buraco se forem
inseridos antes da migration. Quem inserir `role='support'` cria um cargo com
acesso total ao painel web e nenhum poder em jogo, e nada avisa.

### 4.4 🔴 Não existe ban, mas os dois pontos de aplicação já existem

O ban está construído pela metade, e a metade que falta é a que escreve:

| Peça | Estado |
|---|---|
| `accounts.status = 'banned'` bloqueia login em jogo | ✅ `whitelist.js:124` |
| `accounts.status != 'active'` bloqueia entrada na fila | ✅ `game-api/server.js:185` |
| `game_sessions.revoked_at` invalida a sessão no master API | ✅ `apps/web/server.js:700` (`revoked_at IS NULL`) |
| Alguém que **escreva** `status='banned'` | ❌ não existe |
| Alguém que **escreva** `revoked_at` | ❌ não existe — a coluna nunca recebeu um `UPDATE` |
| Registro de ban (motivo, duração, quem baniu, unban) | ❌ não existe tabela |

A coluna `revoked_at` até traz o comentário *"Preenchido ao banir/expulsar sem
esperar o TTL"* na `migration-v8`. Nada preenche.

Consequência prática: banir hoje é `UPDATE accounts SET status='banned'` na mão,
sem motivo, sem prazo, sem auditoria e sem forma de desfazer que não seja outro
`UPDATE` na mão.

**Limite honesto:** revogar a sessão não expulsa quem já está conectado. O SkyMP
consulta o master API **na conexão**, não continuamente. Ban de jogador online
precisa de um kick, e kick precisa da ponte da §4.8.

### 4.5 🟡 `staff_permissions` existe no schema, vazia, e é a tabela certa para o problema errado

```sql
CREATE TABLE staff_permissions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  staff_role_id INT NOT NULL,          -- FK para staff_roles.id (a LINHA, não o cargo)
  permission VARCHAR(64) NOT NULL,
  UNIQUE KEY uk_role_perm (staff_role_id, permission)
);
```

`PARKED_SERVICES_DECISION.md` §237 já a classificou como "definida no schema e
referenciada por nenhum código", com a leitura de que seria "permissões de staff
por conta". Essa leitura está certa e é o problema: a FK aponta para
`staff_roles.id`, que é **a linha de uma pessoa**, não o cargo. Preenchê-la como
está transforma permissão em concessão individual — cada staff com seu conjunto,
nenhuma matriz auditável, e a pergunta "quem pode `set_gold`?" vira uma varredura.

O RBAC de verdade precisa de uma tabela `role → permission` (cargo, não pessoa) e,
separadamente, de overrides por pessoa quando forem necessários. Ver
[ADR 005](../technical/ADR_005_ADMIN_RBAC.md).

### 4.6 🟡 `staff_roles` não suporta cargo temporário nem revogação rastreável

```sql
account_id INT NOT NULL UNIQUE      -- uma pessoa, um cargo, para sempre
granted_by_account_id INT           -- quem concedeu ✅
granted_at TIMESTAMP                -- quando ✅
-- ausentes: expires_at, revoked_at, revoked_by, revoke_reason
```

Revogar cargo hoje é `DELETE` — que apaga também *quem concedeu* e *quando*. O
histórico de "fulano foi admin entre março e maio" não sobrevive à própria
revogação. É o mesmo padrão que o `CONTRIBUTING.md` §3.7 já proibiu para
personagem ("nunca `DELETE`, use status"), ainda não aplicado à staff.

O `UNIQUE` em `account_id` também impede a única coisa que o briefing §13 pede
por nome: **cargo temporário**. Não dá para ter "moderator permanente + gamemaster
até domingo" na mesma conta.

### 4.7 🟡 `audit_logs` registra o que aconteceu, não o suficiente para arbitrar

```sql
audit_logs (id, action, actor_account_id, target_account_id, details TEXT, created_at)
```

Contra a lista do briefing §9:

| Campo pedido | Existe? |
|---|---|
| actor | ✅ `actor_account_id` |
| action | ✅ `action` |
| target | ✅ `target_account_id` |
| reason | ⚠️ dentro de `details`, texto livre, formato por chamador |
| timestamp | ✅ `created_at` |
| **permission** | ❌ — o cargo vai no `details` como `role=admin`, a permissão nunca |
| **before / after** | ❌ — só `setGold` grava `anterior=` no texto, por convenção de um autor |
| **requestId** | ❌ |

E o buraco maior: **negação não é auditada**. `sendDenied()` manda notificação ao
jogador e não escreve nada; o `403` do painel não escreve nada. A pergunta
"alguém está sondando permissões que não tem?" é hoje impossível de responder — o
que é exatamente o sinal que se quer ver antes de um incidente, não depois.

`details` ser texto livre também significa que nenhum filtro do painel funciona
sobre motivo, alvo secundário ou valor.

### 4.8 🟡 Não existe canal do painel para o servidor de jogo

Nada em `apps/web` fala com o processo do SkyMP. O único socket do gamemode é o
WebSocket de voz (`voip-service.js`). O `game-api` tem endpoints internos, mas o
gamemode é **cliente** deles, não servidor.

Isso é o teto de tudo na §6 do briefing (kick, warn, freeze, spectate, teleport a
partir do painel): **nenhuma ação em jogador conectado pode partir do painel
hoje**, e nenhuma quantidade de UI muda isso.

O que a `mp` de fato oferece, conforme `types/mp.d.ts` (procedência marcada lá):

| Capacidade | Existe? |
|---|---|
| `mp.kick(userIdOrActorId)` | ✅ `[DOC]` |
| `mp.isConnected(userId)` / `getUserActor(userId)` | ✅ `[DOC]` |
| `mp.getActorsByProfileId(profileId)` | ✅ `[DOC]` |
| `mp.get/set(actorId, prop)` — posição, célula | ✅ `[DOC]` |
| `mp.callPapyrusFunction`, `mp.triggerClient` | ✅ |
| Evento de conexão/desconexão | ❌ — `connection-monitor.js` faz **polling** a cada 2 s sobre `userId` 0..10 |
| Lista de jogadores online | ❌ — derivada do polling acima |
| **Ping / latência** | ❌ não existe na API |
| **Mute / freeze / spectate** | ❌ não existem; teriam de ser construídos sobre Papyrus + `triggerClient` |

O briefing §6 pede para "não fingir que APIs inexistentes funcionam". Este é o
parágrafo que cumpre isso: **kick e teleport são reais; ping, mute, freeze e
spectate não existem** e entram no painel só depois de alguém construí-los em
jogo e observá-los numa sessão real.

Nota de escala: `maxUserId` padrão do monitor é **10**. Um servidor com mais de
10 conectados hoje não enxerga os demais — é configurável, mas o padrão é de
laboratório, não de produção.

### 4.9 🟡 Sessão web em `MemoryStore`, sem CSRF explícito e sem CSP

`express-session` sem `store` configurado usa o `MemoryStore` padrão. Consequências:
toda sessão de staff morre a cada deploy, e o Express avisa em produção que isso
vaza memória. `docs/skyadmin/REFERENCE_CATALOG.md` já indicou `express-mysql-session`;
não foi feito.

Sobre CSRF, sendo preciso em vez de alarmista: o cookie é `sameSite: 'lax'`, o que
**já bloqueia** o envio de cookie em `PATCH` cross-site. O risco residual é a
ausência de defesa em profundidade — nenhum token, nenhum cabeçalho customizado
exigido — e o fato de `PATCH /api/whitelist/:id` ser hoje a única rota mutável.
Cada rota mutável nova aumenta o custo de não ter isso resolvido de forma
sistemática. Não há `helmet` nem CSP.

### 4.10 🔵 O painel não checa se a própria conta da staff continua ativa

`requireStaff` consulta `staff_roles` e nada mais. Uma conta com
`status = 'banned'` que tenha linha em `staff_roles` continua entrando no painel:
o ban bloqueia o **jogo** (`whitelist.js`, `game-api`), não o **painel**.

### 4.11 🔵 Rate limit em memória, sem poda

`rateLimitBuckets` (nos três serviços) nunca remove chaves. Cada IP novo é uma
entrada permanente até o restart. Não é exploit interessante — é crescimento
silencioso que ninguém vai notar até virar problema de memória.

### 4.12 🔵 `PATCH /api/whitelist/:id` responde `ok:true` para aplicação inexistente

O `UPDATE` afeta 0 linhas e a rota responde sucesso, grava `audit_logs` com
`target_account_id = null` e notifica o Discord com `aplicação #<id>`. Não é
falha de segurança; é ruído no registro que confunde quem for auditar depois.

### 4.13 🔵 O catch-all devolve HTML para rota de API inexistente

`app.get('*')` responde `index.html` com 200 para `/api/qualquer-coisa`. Cliente
que espera JSON recebe `<!DOCTYPE`.

---

## 5. O que já está certo, e não deve ser mexido

Esta seção existe porque reescrever o que funciona é o risco real de um briefing
com 24 seções.

1. **`vip_level` nunca é critério de permissão.** Está dito em comentário nos
   dois lados (`admin-service.js:5`, `server.js:164`) e cumprido no código.
2. **A matriz de permissões do gamemode é testada por comportamento, não por
   mock de retorno.** `permissions.behavior.test.js` invoca o comando de verdade
   e verifica o efeito (ledger escrito, status mudado, auditoria gravada), e
   ainda exige que todo handler exportado esteja na matriz.
3. **Nível numérico legado é recusado com log.** `hasPermission` nega `20` e nega
   nome desconhecido, gritando no console — a escolha certa entre negar em
   silêncio e derrubar o comando do jogador.
4. **`/permakill` é soft-delete com motivo obrigatório.** Nunca `DELETE`.
5. **Identidade não vem do cliente.** Master API resolve `profileId` a partir de
   `game_sessions`; tickets guardam só hash; `masterKey` compara em tempo constante.
6. **Toda query do painel é parametrizada.** Nenhuma concatenação de SQL foi
   encontrada em `apps/web`, `apps/game-api` ou `apps/bot-discord`.
7. **Discord já não é autoridade sobre gameplay.** O bot só *recebe* ordem do
   painel (`/api/sync-role`) e adiciona/remove o cargo de whitelist. O caminho
   inverso — cargo do Discord virar poder no jogo — **não existe**, que é
   exatamente o que a §4 do briefing pede.
8. **O log de moderação no Discord é notificação, não registro.** `notify()` não
   é aguardado e engole erro; o registro é `audit_logs`. Está documentado nos
   dois arquivos e é a separação correta.
9. **Ouro de staff passa pelo ledger.** `setGold` virou delta via
   `transaction-service` justamente para não ser o único caminho de dinheiro fora
   do razão.

---

## 6. Referências externas: o que serve e o que não serve

`PLATFORM_INFRASTRUCTURE_AUDIT.md` §5 já classificou Crows RP, TESV-RP e
F02K/SkyMP-Launcher para o eixo de launcher/infra. Esta auditoria acrescenta
apenas o eixo administrativo, e sem copiar interface nem código:

| Referência | O que é aproveitável | O que **não** transfere |
|---|---|---|
| **txAdmin** | vocabulário de player manager: histórico por identificador, warn/kick/ban com motivo obrigatório, ação sempre ligada a um ator | tudo que depende do console do FXServer e de `txAdmin:events` — o SkyMP não tem console de comando remoto nem stdin interativo |
| **QBCore admin** | granularidade de permissão por ação e a ideia de "comando de staff é um comando registrado, não um `if` espalhado" | permissões por ACE/principal do FiveM; `QBCore.Functions.HasPermission` assume um runtime que aqui não existe |
| **Ferramentas de admin FiveM em geral** | UX de confirmação para ação destrutiva | quase todo o resto: FiveM tem eventos de conexão nativos, o SkyMP tem polling |
| **Server managers de SkyMP** | nenhum dos forks estudados publica painel administrativo; o campo está vazio | — |
| **GameAP / Pterodactyl Wings** (já em `REFERENCE_CATALOG.md`) | o desenho de *agent com conexão de saída* é a resposta certa para a §4.8 num host Windows atrás de NAT | o ciclo de vida de container inteiro; aqui o processo é um `.bat` |

**Aviso que vale repetir**, porque o `REFERENCE_CATALOG.md` já o dá e o briefing
convida ao erro: *API FiveM não é API SkyMP*. Metade do valor dessas referências
é de vocabulário e de UX; a outra metade não atravessa.

---

## 7. Reconciliação com `docs/skyadmin/`

O diretório `docs/skyadmin/` já contém um plano coerente (charter, arquitetura,
modelo de segurança, marcos, decisões SA-001..SA-008) escrito antes desta
auditoria. Esta auditoria **não o substitui**. Correções que ela obriga:

| Item do skyadmin | Estado real medido |
|---|---|
| Marco 1 — `profileId === accountId` | ✅ confirmado em `whitelist.js` |
| Marco 1 — runner de migrations + drift | ⚠️ existe `check:schema:drift`; runner único não |
| Marco 2 — RBAC no banco | ❌ não iniciado. `staff_permissions` continua vazia |
| Marco 2 — `requirePermission(permission)` | ❌ não existe |
| Marco 3 — pipeline de ação/outbox | ❌ nenhuma das quatro tabelas existe |
| Marco 4 — ban persistente, kick, bridge | ❌ nenhum. Ver §4.4 e §4.8 |
| Marco 6 — sessão MariaDB, CSRF, CSP | ❌ nenhum. Ver §4.9 |
| SA-005 — "ações passam por catálogo e fila" | decisão registrada, zero implementação |

A afirmação do `skyadmin/README.md` — *"Não existe ainda RBAC granular no painel,
pipeline unificado de ações, Agent remoto, bans persistentes ou interface
operacional completa"* — **continua verdadeira e é a única frase daquele
diretório que descreve o presente**. O resto descreve intenção. Quem ler aqueles
arquivos deve lê-los como projeto, não como estado.

---

## 8. O que esta auditoria produz

| Documento | Papel |
|---|---|
| [`docs/admin/ADMIN_PLATFORM.md`](../admin/ADMIN_PLATFORM.md) | módulos do painel, fases e o que cada uma destrava |
| [`docs/admin/RBAC.md`](../admin/RBAC.md) | catálogo de permissões, cargos, modelo de dados e contrato do middleware |
| [`docs/admin/MODERATION_WORKFLOW.md`](../admin/MODERATION_WORKFLOW.md) | casos, ações, whitelist e regra de irreversibilidade |
| [`docs/testing/ADMIN_SECURITY_MATRIX.md`](../testing/ADMIN_SECURITY_MATRIX.md) | o que precisa passar antes de qualquer staff usar isto |
| [`docs/technical/ADR_005_ADMIN_RBAC.md`](../technical/ADR_005_ADMIN_RBAC.md) | a decisão: permissão granular no banco, cargo é agrupamento |

**Nenhum código foi alterado nesta rodada.** A `CONSTITUICAO.md` §14 é explícita
— entender, questionar, achar falhas, achar exploits, comparar alternativas,
documentar, e *só então* escrever código. Os cinco documentos acima são os passos
1–14; o passo 15 é a próxima sessão.

---

## 9. Ordem recomendada de trabalho

Derivada da severidade acima, não da ordem do briefing:

1. **Migration de RBAC** — `staff_role_permissions` (cargo→permissão),
   `staff_roles` com `expires_at`/`revoked_at`, `CHECK` no nome do cargo.
   Fecha §4.3, §4.5, §4.6.
2. **`requirePermission()` no painel** + auditoria de negação. Fecha §4.1, §4.7 parcial.
3. **Alinhar as três permissões órfãs**: implementar ou remover `ban`,
   `view_audit`, `manage_whitelist`. Fecha §4.2.
4. **Ban de verdade** — tabela `bans`, escrita de `accounts.status` e
   `game_sessions.revoked_at` na mesma transação, com motivo e prazo. Fecha §4.4.
5. **`audit_logs` v2** — `permission`, `request_id`, `before`/`after`, `outcome`.
   Fecha §4.7.
6. **Sessão em MariaDB, CSRF, helmet/CSP.** Fecha §4.9.
7. **Só então** a ponte com o servidor de jogo (§4.8), que é a peça grande e a
   única que exige desenho de protocolo novo.

Os itens 1–6 não dependem de sessão em jogo. O item 7 depende, e o
[bloqueio da Fase 0](../historico/PHASE_0_TEST_LOG.md) continua sendo o que ele
sempre foi: **ninguém nunca conectou**.
