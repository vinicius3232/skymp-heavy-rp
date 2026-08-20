# SkyAdmin — estado atual da plataforma administrativa

**Data:** 2026-08-15 · **Branch:** `feat/skyvoice-core-etapa-2` · **Tipo:** auditoria, nenhum código alterado.

**Escopo medido:** `apps/web`, `apps/game-api`, `apps/bot-discord`, `apps/launcher`,
`skymp/gamemode/admin-service.js` e todo módulo que chame `hasPermission` ou escreva
`audit_logs`, `skymp/packages/database/schema.sql` + migrations `v2`–`v16`.

> ### ⚠️ Parte desta auditoria já foi corrigida, no mesmo dia
>
> A rodada de autorização que se seguiu a este documento fechou os achados de
> **acesso** e deixou os de **registro** e **funcionalidade ausente** abertos. O
> inventário do que ficou está em [`AUTHORIZATION_MATRIX.md`](AUTHORIZATION_MATRIX.md).
>
> | Achado | Estado |
> |---|---|
> | §4.1 rotas só com `requireStaff` | ✅ **corrigido** — `requireStaff` não existe mais; 11 rotas com capability |
> | §4.2 cargo desconhecido libera o painel | ✅ **corrigido** — nega dos dois lados, pelo mesmo catálogo |
> | §4.3 ações sem permissão específica | ✅ **corrigido** no painel e em `/anim`; `/status` segue mal rotulado |
> | §4.4 negação nunca registrada | ✅ **corrigido** — `authz:denied` com motivo em código estável |
> | §4.12 conta banida entra no painel | ✅ **corrigido** — status da conta nega antes da permissão |
> | Bot: quarta fonte de autoridade | ✅ **corrigido** — `STAFF_ROLE_ID` removido; o bot pergunta ao painel |
> | §3 três permissões sem porta | ✅ **corrigido** — `view_audit` e `manage_whitelist` passaram a ser verificadas; `ban` virou reservada |
> | §4.5 auditoria fail-open | ❌ **aberto** |
> | §4.6 `manage_staff` faz bypass sem marca na auditoria | ❌ **aberto** |
> | §4.7 mutações diretas / §4.8 escritores espalhados | ❌ **aberto** |
> | §4.9 ban, gestão de staff, painel operacional | ❌ **aberto** |
> | §4.10 tabelas mortas ainda lidas | ❌ **aberto** |
> | Sessão em `MemoryStore`, CSRF, CSP | ❌ **aberto** |
>
> As seções abaixo descrevem o estado **anterior** à correção. Elas ficam porque
> são o registro de por que cada mudança foi feita — e porque o que continua
> aberto continua descrito com precisão.

---

## 0. O que este documento é, e o que ele não repete

Existe uma auditoria anterior: [`ADMIN_PLATFORM_AUDIT.md`](../research/ADMIN_PLATFORM_AUDIT.md),
de **13/08/2026**. Ela continua correta em tudo que mediu — reconferi rota por rota e
linha por linha, e o `apps/web/server.js` não mudou um caractere desde então.

Este documento existe por três razões, e não para reescrever aquele:

1. **Dois dias de trabalho de voz entraram depois dela.** A superfície administrativa
   ganhou **cinco comandos novos** e uma **13ª permissão** (`voice_mute`), mais a
   migration `v16`. A auditoria de 13/08 lista doze permissões e não conhece nenhuma
   delas — não por erro, por data.
2. **O escopo pedido aqui é maior**: prisão, facções, ficha criminal, morte/abatido,
   inventário, economia, métricas, logs de aplicação e o bot do Discord não estavam
   no recorte de 13/08.
3. **Ele mede o estado, não a intenção.** `docs/skyadmin/` e `docs/admin/RBAC.md`
   descrevem um sistema que ainda não existe; este arquivo descreve o que roda hoje.

**Método:** tudo abaixo foi lido nesta árvore. Onde um documento discorda do código,
o código ganha. **Nada foi observado em jogo** — a Fase 0 continua sem uma sessão com
jogador conectado ([`PHASE_0_TEST_LOG.md`](../historico/PHASE_0_TEST_LOG.md)), então
todo comportamento in-game está marcado como *não observado*.

---

## 1. O desenho real, em uma figura

Não há um sistema de permissão. Há **três**, e só um deles é bom.

```
┌─ EIXO OOC (staff) ────────────────────────────────────────────────────────┐
│                                                                            │
│  Discord OAuth ──► apps/web  requireStaff()          server.js:167         │
│                    SELECT role FROM staff_roles                            │
│                    tem linha? ─► ACESSO TOTAL A TUDO      ◄── binário      │
│                    não tem?   ─► 403                                       │
│                          ▲                                                 │
│                          │  mesma tabela, duas leituras que não se falam   │
│                          ▼                                                 │
│  SkyMP login ────► gamemode  admin-service           admin-service.js:79   │
│                    SELECT role FROM staff_roles                            │
│                    ROLE_PERMISSIONS[role] ─► Set<13 strings>  ◄── granular │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
                          │
                          │  manage_staff (só `owner`) ─── ponte de bypass
                          ▼
┌─ EIXO IC (personagem) ────────────────────────────────────────────────────┐
│  governance-service   25 permissões, no BANCO, com escopo e plantão        │
│  governance_roles × governance_role_permissions × governance_memberships   │
│  hasPermission() abre com `if (isStaffGovernor) return true` :283          │
└────────────────────────────────────────────────────────────────────────────┘
```

Três observações que decorrem da figura e importam mais do que qualquer item da lista:

- **O gamemode tem RBAC de verdade; o painel tem um `if`.** A granularidade que
  existe está do lado errado do muro — do lado onde ninguém consegue chegar hoje,
  porque ninguém nunca conectou.
- **O eixo IC é o único RBAC com o mapa cargo→permissão no banco.** É exatamente o
  desenho que a [ADR 005](../technical/ADR_005_ADMIN_RBAC.md) quer para o eixo OOC — e
  já está construído, testado e rodando, a dois arquivos de distância.
- **Os dois eixos não são duplicação.** Um responde "quem administra o servidor", o
  outro "quem manda dentro da ficção". A única coisa que os acopla é `manage_staff`,
  e ela é uma porta de bypass total (§4.6).

---

## 2. Mapa por funcionalidade

Legenda: **READY** funciona e está protegido · **PARTIAL** existe pela metade ·
**LEGACY** existe e é sobra de um sistema morto · **INSECURE** funciona e expõe ·
**MISSING** não existe.

---

### `RBAC DE STAFF NO GAMEMODE` — READY

→ **BACKEND** `skymp/gamemode/admin-service.js:79-168`. `ROLE_PERMISSIONS` (3 cargos ×
13 permissões), `staffCache` em memória por `actorId`, `hasPermission(actorId, nome)`.
→ **FRONTEND** nenhum. É só chat in-game.
→ **PERMISSION** ele *é* a permissão. Recusa argumento numérico legado e nome
desconhecido, negando **e** gritando no log (`:150-163`).
→ **AUDIT** `auditLog()` (`:183`) grava `audit_logs`. **Negação não gera nada.**
→ **DATABASE** lê `staff_roles`. Não escreve.
→ **STATUS** **READY** — a peça mais bem construída de toda a plataforma.
→ **PROBLEMA** o cache é chaveado por `actorId`, que o SkyMP reaproveita entre sessões;
a limpeza existe (`commands.js:70`) e está comentada, mas depende de
`removeActiveCharacter` ser chamado. **Não observado com jogador real.**

---

### `CONCESSÃO E REVOGAÇÃO DE CARGO DE STAFF` — MISSING

→ **BACKEND** nenhum. Busca por `INSERT INTO staff_roles` / `UPDATE staff_roles` /
`DELETE FROM staff_roles` em `apps/` e `skymp/gamemode/`: **zero resultados.**
→ **FRONTEND** nenhum.
→ **PERMISSION** `manage_staff` existe, é só de `owner`, e **não guarda nenhuma
concessão de cargo** — ela é usada só como bypass (§4.6).
→ **AUDIT** nenhum. Promover alguém não deixa rastro.
→ **DATABASE** `staff_roles` tem `granted_by_account_id` e `granted_at`, ambos
preenchíveis, nunca preenchidos por código. Falta `expires_at`, `revoked_at`,
`revoked_by`. `account_id` é `UNIQUE` — uma pessoa, um cargo, para sempre.
→ **STATUS** **MISSING**.
→ **PROBLEMA** promover é `INSERT` na mão; despromover é `DELETE` na mão — e o `DELETE`
apaga junto *quem concedeu* e *quando*. É o padrão que o `CONTRIBUTING.md` §3.7 já
proibiu para personagem ("nunca `DELETE`, use status"), ainda não aplicado à staff.
`role` é `VARCHAR(32)` sem `CHECK`: inserir `role='support'` cria uma conta com
**acesso total ao painel e zero poder em jogo**, em silêncio (§4.2).

---

### `staff_permissions` (TABELA) — LEGACY

→ **BACKEND** nenhum. **Zero referências em todo o código**, verificado por busca.
→ **FRONTEND** nenhum.
→ **PERMISSION** —
→ **AUDIT** —
→ **DATABASE** `schema.sql:353` e `migration-v2.sql:48`. Vazia.
→ **STATUS** **LEGACY** — código morto no schema.
→ **PROBLEMA** a FK aponta para `staff_roles.id`, que é **a linha de uma pessoa**, não
o cargo. Preenchê-la como está transformaria permissão em concessão individual: cada
staff com seu conjunto, nenhuma matriz auditável, e "quem pode `set_gold`?" viraria
uma varredura. É a tabela certa para o problema errado.

---

### `PAINEL WEB — AUTENTICAÇÃO` — READY

→ **BACKEND** `apps/web/server.js:133-192`. Discord OAuth via `passport-discord`,
escopo `identify` apenas. Tokens OAuth **não** são persistidos (nota explícita em
`schema.sql:23`).
→ **FRONTEND** `public/index.html:13-20`, botão único.
→ **PERMISSION** `requireAuth` (`:159`) para rotas de jogador.
→ **AUDIT** login não é auditado.
→ **DATABASE** cria `accounts` + `discord_identities` no primeiro login.
→ **STATUS** **READY**.
→ **PROBLEMA** `express-session` sem `store` → `MemoryStore`: toda sessão de staff
morre a cada deploy e o Express avisa que vaza memória em produção. Ver §4.9.

---

### `PAINEL WEB — AUTORIZAÇÃO` — INSECURE

→ **BACKEND** `requireStaff` (`apps/web/server.js:167-178`). Lê o cargo, guarda em
`req.staff.role`, **e nenhuma rota jamais o consulta**.
→ **FRONTEND** `public/index.html` monta as 8 abas incondicionalmente. Não existe
conceito de cargo no cliente.
→ **PERMISSION** **nenhuma**, em nenhuma das 12 rotas de staff.
→ **AUDIT** o `403` não é registrado. Sondagem de permissão é invisível.
→ **DATABASE** `SELECT role FROM staff_roles ... LIMIT 1`.
→ **STATUS** **INSECURE**.
→ **PROBLEMA** um `moderator` recém-promovido lê o ranking de ouro, a ficha criminal de
todo mundo, o `audit_logs` inteiro e os crash reports com Discord ID de cada jogador —
e **aprova whitelist** — exatamente como o `owner`. O gamemode já decidiu que
`view_audit` e `manage_whitelist` são permissões nomeadas; o painel não pergunta nem
uma coisa nem outra.

---

### `WHITELIST — APLICAÇÃO (JOGADOR)` — READY

→ **BACKEND** `POST /api/apply` (`server.js:258`), com `validateApplication`
(`:242`): seis campos obrigatórios com mínimo e máximo alinhados ao schema, e
bloqueio de reenvio com aplicação pendente/aprovada.
→ **FRONTEND** `public/apply.html`.
→ **PERMISSION** `requireAuth`. Correto — é rota de jogador.
→ **AUDIT** a submissão não gera `audit_logs`. Aceitável: ela cria a própria linha.
→ **DATABASE** `characters` (status `pending`) + `whitelist_applications`.
`needs_extra_review` é heurística de conceito forte (`:209`), sinalizadora, não portão.
→ **STATUS** **READY**.
→ **PROBLEMA** nenhum relevante.

---

### `WHITELIST — REVISÃO (STAFF)` — INSECURE

→ **BACKEND** `PATCH /api/whitelist/:id` (`server.js:349`). **A única rota mutável de
staff que existe hoje em toda a plataforma.**
→ **FRONTEND** `index.html:207-266`, botões Aprovar/Rejeitar.
→ **PERMISSION** só `requireStaff`. `manage_whitelist` existe e não é consultada.
→ **AUDIT** ✅ grava `whitelist:approve|reject|reset` com o revisor. É a rota de painel
mais bem auditada — e mesmo ela não registra o cargo nem o valor anterior.
→ **DATABASE** `UPDATE whitelist_applications` + `UPDATE characters` com
`WHERE c.status='pending'` — a cláusula é obrigatória e está lá com comentário: sem
ela, aprovar uma ficha nova ressuscitava um personagem `retired` por `/permakill`.
→ **STATUS** **INSECURE** (pela permissão), **READY** no resto.
→ **PROBLEMA** além da permissão: responde `ok:true` para aplicação inexistente
(`UPDATE` afeta 0 linhas), gravando `audit_logs` com `target_account_id = null` e
notificando o Discord como `aplicação #<id>`. Ruído no registro, não falha de acesso.

---

### `BANS` — MISSING

→ **BACKEND** nenhum. Não existe comando, endpoint nem função.
→ **FRONTEND** nenhum.
→ **PERMISSION** `ban` está concedida a `admin` e `owner` desde sempre
(`admin-service.js:81-82`) e **não é verificada em lugar nenhum**.
→ **AUDIT** —
→ **DATABASE** não existe tabela de ban. **Os dois pontos de aplicação já existem e
funcionam**: `accounts.status != 'active'` bloqueia o login (`whitelist.js:124`) e a
fila (`game-api/server.js:185`); `game_sessions.revoked_at IS NULL` invalida a sessão
no master API (`server.js:700`). **Ninguém escreve nenhum dos dois** — `revoked_at`
nunca recebeu um `UPDATE`, apesar do comentário "Preenchido ao banir/expulsar" na
`migration-v8`.
→ **STATUS** **MISSING**.
→ **PROBLEMA** banir hoje é `UPDATE accounts SET status='banned'` na mão: sem motivo,
sem prazo, sem quem baniu, sem auditoria e sem desfazer que não seja outro `UPDATE`.
**Limite honesto:** revogar a sessão não expulsa quem já está conectado — o SkyMP
consulta o master **na conexão**, não continuamente. Ban de jogador online exige kick,
e kick a partir do painel exige a ponte que não existe (§4.10).

---

### `KICK` — PARTIAL

→ **BACKEND** `admin-service.kickPlayer` (`:297`). Notifica o alvo, espera 3 s,
chama `skymp.kick` pelo adaptador (que converte FormID → `userId`).
→ **FRONTEND** nenhum. Só `/kick <actorId> <motivo>` no chat.
→ **PERMISSION** ✅ `kick`, moderador+. Testada por comportamento.
→ **AUDIT** ✅ `staff:kick` + notificação ao Discord (manda-e-esquece, correto).
→ **DATABASE** só `audit_logs`.
→ **STATUS** **PARTIAL** — funciona in-game, **inalcançável do painel**.
→ **PROBLEMA** o motivo cai para `'Sem motivo'` quando omitido (`commands.js:415`),
diferente de `/permakill`, que exige motivo. Duas regras para a mesma classe de ato.

---

### `TELEPORT E ANIMAÇÃO` — PARTIAL

→ **BACKEND** `teleportTo` (`:278`), `playAnimation` (`:198`).
→ **FRONTEND** nenhum.
→ **PERMISSION** ✅ `teleport` — **as duas**.
→ **AUDIT** ✅ `staff:teleport`, `staff:playAnimation`.
→ **DATABASE** só `audit_logs`. O teleporte não persiste posição.
→ **STATUS** **PARTIAL**.
→ **PROBLEMA** `playAnimation` é guardada por `teleport`. É uma permissão que
significa outra coisa que não o que o nome diz — exatamente o defeito que o cabeçalho
do próprio `admin-service.js:20-78` gasta 60 linhas argumentando contra, ao justificar
por que `manage_recipes` e `reveal_identity` **não** foram penduradas em permissões
existentes. Quem auditar "quem pode `teleport`?" recebe a resposta errada sobre quem
pode fazer um personagem executar animações. Além disso: só teleporta a staff **até** o
alvo; não existe trazer o alvo, nem ir a coordenada.

---

### `PERSONAGENS — LISTAGEM E APOSENTADORIA` — PARTIAL / READY

→ **BACKEND** listagem `GET /api/characters` (`server.js:443`); aposentadoria
`admin-service.retireCharacter` (`:418`).
→ **FRONTEND** `index.html:268-298`, tabela somente-leitura com busca.
→ **PERMISSION** listagem: **nenhuma**. `/permakill`: ✅ `retire_character`, admin+,
nunca moderador.
→ **AUDIT** ✅ `staff:retireCharacter` com motivo + Discord.
→ **DATABASE** `UPDATE characters SET status='retired'` — **soft-delete, nunca
`DELETE`**. `whitelist.js` só faz spawn com `status='approved'`, então a consequência
é automática.
→ **STATUS** aposentadoria **READY**; painel de personagens **PARTIAL**.
→ **PROBLEMA** o painel lista e não faz nada: nenhuma ação de personagem existe pela
web. E o `UPDATE` de `retireCharacter` é uma mutação direta no banco a partir do
`admin-service` — é a única mutação de estado de personagem que não passa por serviço
próprio (§4.7).

---

### `INVENTÁRIO — /additem` — READY

→ **BACKEND** `giveItemAdmin` (`:220`).
→ **FRONTEND** nenhum.
→ **PERMISSION** ✅ `add_item`, admin+.
→ **AUDIT** ✅ `staff:addItem` **e** linha no ledger `inventory_transactions` via
`transaction-service`.
→ **DATABASE** nunca escreve `character_inventory` direto — passa pelo
`transaction-service`.
→ **STATUS** **READY**.
→ **PROBLEMA** nenhum de segurança. Valida o FormID contra os plugins carregados
(`core/espm.js`) antes de gravar, e só nega quando tem certeza. Bom desenho.
Falta o inverso: **não existe `/removeitem`** nem inspeção de inventário pela staff.

---

### `ECONOMIA — /setgold, HOLDS, TOP-GOLD, IMPOSTOS` — READY / PARTIAL / LEGACY

→ **BACKEND** `admin-service.setGold` (`:356`); leituras `GET /api/economy/holds` e
`/top-gold` (`server.js:478,491`); `economy-regional.setTaxRate` (**PARKED**, não
registrado no boot); `governance.setTax` (`:969`, eixo IC, escreve `cities`/`realms`).
→ **FRONTEND** `index.html:300-329`, duas tabelas somente-leitura.
→ **PERMISSION** `/setgold`: ✅ `set_gold`. `setTaxRate`: ✅ `set_gold` (mas o módulo
está PARKED). Rotas do painel: **nenhuma**. `governance.setTax`: ✅ `manage_taxes` IC.
→ **AUDIT** ✅ `staff:setGold` com `anterior=` e `delta=`, **e** linha em
`gold_transactions` com `reason='staff_setgold'`.
→ **DATABASE** o valor absoluto pedido pela staff vira delta sob lock; `NaN` e negativo
são recusados antes do banco.
→ **STATUS** `/setgold` **READY** · painel de economia **PARTIAL** · `setTaxRate`
**LEGACY** (PARKED, e concorre com `governance.setTax` por outra tabela).
→ **PROBLEMA** dois sistemas de imposto: `economy-regional` escreve `holds.tax_rate`,
`governance` escreve `cities.tax_rate` / `realms.tax_rate`. O painel lê **`holds`** —
ou seja, mostra o imposto do sistema estacionado, não o do sistema vivo.

---

### `FICHAS CRIMINAIS` — LEGACY

→ **BACKEND** `GET /api/criminal` (`server.js:505`). Leituras também em
`governance-service.js:904,948` e `player-panel-service`.
→ **FRONTEND** `index.html:349-367`, tabela.
→ **PERMISSION** **nenhuma** no painel. IC: `view_records`.
→ **AUDIT** consultar ficha criminal pelo painel não é registrado.
→ **DATABASE** `criminal_records` (`schema.sql:156`). **Zero escritores em todo o
código** — verificado por busca de `INSERT`/`UPDATE`/`DELETE`.
→ **STATUS** **LEGACY**.
→ **PROBLEMA** a tabela é sobra do `justice-service`, apagado em 06/08/2026. O
substituto (`governance-service`) registra em `warrants`, `fines`, `guard_detentions` e
`custody_records` — **nunca** em `criminal_records`. A aba "Fichas Criminais" do painel
está permanentemente vazia e vai continuar vazia, e três consumidores leem uma tabela
que ninguém alimenta.

---

### `PRISÃO` — PARTIAL

→ **BACKEND** `GET /api/prison` (`server.js:533`, leitura). Escrita só IC:
`governance.arrest` (`:819`) e a liberação por tempo cumprido (`:873-875`).
→ **FRONTEND** `index.html:369-393`, com barra de progresso de pena.
→ **PERMISSION** painel: **nenhuma**. IC: `guard_arrest` / `guard_release`, com
`on_duty = 1` obrigatório.
→ **AUDIT** ✅ IC (`governance:guard:arrest`, `guard:release`). Painel: consulta não
auditada.
→ **DATABASE** `prison_records` + `character_restraints` + `character-state`.
→ **STATUS** **PARTIAL**.
→ **PROBLEMA** o painel mostra presos e **não pode soltar ninguém**. A staff que
descobre uma prisão indevida pelo painel precisa entrar no jogo, achar o ator e usar um
comando IC — ou editar o banco na mão.

---

### `FACÇÕES` — PARTIAL, com leitura errada

→ **BACKEND** `GET /api/factions` (`server.js:519`). Criação só IC:
`governance.createFaction` (`:379`).
→ **FRONTEND** `index.html:331-347`.
→ **PERMISSION** painel: **nenhuma**. IC: `manage_faction`.
→ **AUDIT** ✅ IC (`governance:faction:create`).
→ **DATABASE** `factions` ✅ escrita pelo governance. **`faction_members` é referenciada
uma única vez em todo o repositório — no `LEFT JOIN` desta rota (`server.js:525`) — e
não tem nenhum escritor.** A filiação real vive em `governance_memberships`.
→ **STATUS** **PARTIAL** / o `member_count` é **LEGACY**.
→ **PROBLEMA** a coluna "Membros" do painel mostra **0 para toda facção, sempre**. Não
é bug de dado: é a rota consultando a tabela do `faction-service`, apagado em
06/08/2026 e substituído por `governance_memberships`. O painel ainda não sabe.

---

### `REVELAÇÃO DE IDENTIDADE` — READY

→ **BACKEND** `admin-service.revealIdentity` (`:524`).
→ **FRONTEND** nenhum.
→ **PERMISSION** ✅ `reveal_identity`, admin+, **nunca moderador** — com justificativa
escrita (`:31-56`): é a única ação de staff que não se desfaz nem por outro comando nem
pelo tempo.
→ **AUDIT** ✅ `identity:staff_reveal`, gravado **antes** da notificação de propósito:
se o banco cair, a staff não recebe o nome, em vez de receber sem rastro.
→ **DATABASE** só `audit_logs`. **Não escreve `character_known_identities`** — a
revelação é OOC e gravá-la ali faria o personagem da staff passar a chamar o alvo pelo
nome real no chat local para sempre.
→ **STATUS** **READY**. Melhor exemplar de desenho administrativo do projeto.
→ **PROBLEMA** nenhum. A auditoria é fail-open como todas as outras (§4.5), o que aqui
é mais grave que em qualquer outro lugar — mas o defeito é do `auditLog`, não deste
comando.

---

### `MORTE E ABATIDO (DOWNED)` — READY como evidência, MISSING como ferramenta

→ **BACKEND** `death-service.js`. Grava snapshot de quem estava por perto no momento
da morte, atribuição provável de causa, e marcação explícita de conflito (`/iniciar`).
→ **FRONTEND** nenhum. Não aparece no painel.
→ **PERMISSION** **nenhuma** — e corretamente: são eventos do sistema, não ações de
staff. `/iniciar` é comando de jogador.
→ **AUDIT** ✅ **cinco `INSERT INTO audit_logs` diretos** (`:113,405,506,531,582`),
sem passar por `admin.auditLog`.
→ **DATABASE** `audit_logs` + `characters.status`.
→ **STATUS** **READY** para produzir evidência de RDM; **MISSING** para consumi-la.
→ **PROBLEMA** o serviço produz exatamente a trilha que uma arbitragem de RDM precisa —
e ela desaparece dentro de `audit_logs.details`, texto livre, num painel que mostra as
últimas 200 linhas sem filtro nenhum. A evidência existe e é ilegível.

---

### `ADMINISTRAÇÃO DE VOIP` — READY in-game / MISSING no painel

*(inteiramente posterior à auditoria de 13/08.)*

→ **BACKEND** cinco ações em `admin-service.js`: `voiceMute` (`:602`), `voiceUnmute`
(`:652`), `voiceDiagnose` (`:726`), `voiceDisconnect` (`:762`), `voiceForceReconnect`
(`:802`). O diagnóstico é **injetado** pelo `voip-service` no boot
(`bindVoiceDiagnostics`) — o `admin-service` não importa o Voice Core, e a direção da
dependência está certa.
→ **FRONTEND** nenhum. Nem no painel, nem na CEF.
→ **PERMISSION** ✅ `voice_mute` nas cinco, moderador+. **Inclusive na consulta** —
decisão declarada: "num sistema de moderação, quem olhou também é registro".
→ **AUDIT** ✅ cinco ações auditadas, e `voiceDisconnect` registra **também a tentativa
falha** ("um audit log que só grava sucesso esconde metade do que a staff fez").
→ **DATABASE** `voice_staff_mutes` (`migration-v16`). Persiste, com expiração conferida
**na leitura**; hidratado no boot antes de o servidor de voz abrir.
→ **STATUS** **READY** in-game · **MISSING** no painel.
→ **PROBLEMA** um comentário obsoleto: `admin-service.js:592-595` afirma *"O silêncio
some no restart do servidor"* e manda ler o cabeçalho de `voice-staff-mute.js` — que
diz o **oposto** desde que o SV-07 fechou. A frase descreve o comportamento anterior à
`migration-v16`. É só documentação, e é a documentação que a staff leria para decidir
se uma punição precisa ser reaplicada.

---

### `AUDIT LOGS` — PARTIAL / INSECURE

→ **BACKEND** **cinco escritores independentes**: `admin-service.auditLog` (o
"oficial"), `apps/web/server.js:400` (`INSERT` cru), `commands.js:151` (`rp_chat:*`),
`death-service` (×5, crus), `identity-service:110` (cru). Mais um sexto caminho:
`market-stalls-service` escreve na própria `market_stall_audit` e só cai em
`admin.auditLog` quando aquela falha.
→ **FRONTEND** `GET /api/audit` + `index.html:395-418`. Últimas **200 linhas**, sem
filtro, sem paginação, sem busca.
→ **PERMISSION** **nenhuma**. `view_audit` existe e nunca é consultada.
→ **AUDIT** o log não audita quem o leu.
→ **DATABASE** `audit_logs (id, action, actor_account_id, target_account_id, details
TEXT, created_at)`. Faltam: `permission`, `outcome`, `before`/`after`, `request_id`,
`reason` estruturado.
→ **STATUS** **PARTIAL** como registro · **INSECURE** como controle.
→ **PROBLEMA** três, em ordem de peso:
  1. **Fail-open.** `auditLog` (`:189`) e `auditIdentityEvent` (`:113`) capturam o erro
     e seguem com um `console.error`. A ação de staff acontece; o rastro, não. Para
     `revealIdentity` isso significa que a única coisa que torna o poder aceitável
     pode falhar em silêncio.
  2. **Negação nunca é registrada.** `sendDenied()` manda notificação e escreve nada; o
     `403` do painel escreve nada. "Alguém está sondando permissões que não tem?" é
     hoje impossível de responder — e é o sinal que se quer ver *antes* do incidente.
  3. **`details` é texto livre com formato por autor.** `role=admin anim=X`,
     `sourceCharacterId=1 targetCharacterId=2`, JSON no caso do `rp_chat`. Nenhum
     filtro do painel funciona sobre motivo, alvo secundário ou valor.

---

### `LOGS DE APLICAÇÃO` — MISSING

→ **BACKEND** `console.log` / `console.error`. **42 chamadas** só nos três `server.js`;
centenas no gamemode. Nenhuma biblioteca de log — busca por `winston|pino|bunyan|morgan`
nos `package.json`: zero.
→ **FRONTEND** nenhum.
→ **PERMISSION** —
→ **AUDIT** —
→ **DATABASE** —
→ **STATUS** **MISSING**.
→ **PROBLEMA** sem nível, sem correlação entre processos, sem rotação, sem destino que
não seja o stdout de quem abriu o `.bat`. Um incidente que atravesse painel → game-api
→ gamemode não tem como ser reconstruído: são três stdouts sem identificador comum.
O único acerto é o `ui-event-gateway`, que **nunca registra o payload bruto** do
cliente (`:47`) — a decisão certa, tomada num lugar só.

---

### `MÉTRICAS` — PARTIAL, construídas e não plugadas

→ **BACKEND** `core/voice/voice-metrics.js` (contadores e histogramas com janela) e
`voice-telemetry.js`, que tem `snapshot()`, `explain()`, **`renderPrometheus()`** e
`logLine()`.
→ **FRONTEND** nenhum.
→ **PERMISSION** —
→ **AUDIT** —
→ **DATABASE** memória, com janela.
→ **STATUS** **PARTIAL**.
→ **PROBLEMA** **`renderPrometheus` e `logLine` não têm nenhum consumidor** — busca em
todo o repositório fora dos testes: zero. O próprio cabeçalho do arquivo (`:40`) diz
que "quem serve é quem já tem servidor — hoje o `apps/game-api`, que já expõe `/health`
e já tem autenticação interna". O plano está escrito no arquivo e não foi executado.
Fora da voz **não há métrica nenhuma**: nem jogadores online, nem latência de banco,
nem taxa de erro de rota.

---

### `BOT DO DISCORD` — PARTIAL, mas na direção certa

→ **BACKEND** `apps/bot-discord/index.js`. Dois endpoints internos: `/api/sync-role`
(painel → cargo de whitelist) e `/api/moderation-log` (notificação de canal). Mais
canais de voz temporários (`voiceChannels.js`, gate por `STAFF_ROLE_ID` do Discord).
→ **FRONTEND** Discord.
→ **PERMISSION** `X-Internal-Secret` em tempo constante + rate limit, e bind em
`127.0.0.1` explícito ("API interna: nunca expor em todas as interfaces").
→ **AUDIT** nenhum próprio — e correto: o registro é `audit_logs`, isto é notificação.
→ **DATABASE** nenhum acesso. Bom.
→ **STATUS** **PARTIAL**.
→ **PROBLEMA** nenhum de segurança, e um acerto que merece nome: **o caminho inverso
não existe**. Cargo do Discord nunca vira poder no jogo; o bot só recebe ordem. O
limite: `/voz-criar` e `/voz-fechar` são gateados por cargo do **Discord**
(`STAFF_ROLE_ID`), que é uma quarta fonte de autoridade — inconsequente hoje porque só
cria canal de voz, mas é precedente a não repetir.

---

### `GAME API (FILA E PARIDADE DE MODPACK)` — READY

→ **BACKEND** `apps/game-api/server.js`. Fila, tickets de uso único, paridade de mods.
→ **FRONTEND** launcher.
→ **PERMISSION** `requireInternal` nos endpoints internos; público nos de fila, mas o
ticket **é** a credencial.
→ **AUDIT** nenhum. Entrada e saída de fila não deixam rastro.
→ **DATABASE** `launch_tickets`, `game_sessions` — **só o hash**, nunca o token.
→ **STATUS** **READY**.
→ **PROBLEMA** nenhum administrativo. Duas notas: `/mods.json` responde **503** quando
o manifesto falta, e não lista vazia — uma lista vazia passaria na verificação do
launcher e deixaria qualquer modpack entrar. E a `isEligible` reconfere a conta **na
entrada da fila**, então um ban aplicado depois do login no launcher pega.

---

### `LAUNCHER` — READY (não é superfície administrativa)

→ **BACKEND** `apps/launcher/electron/main.ts`.
→ **FRONTEND** React.
→ **PERMISSION** nenhuma de staff — e é o certo: o launcher é aplicativo de jogador
distribuído publicamente.
→ **AUDIT** crash reports vão para `POST /api/crashes/client` (rate-limited, tamanho
limitado, com poda por idade e por contagem).
→ **DATABASE** nenhum acesso direto.
→ **STATUS** **READY**.
→ **PROBLEMA** nenhum administrativo. `contextIsolation: true`, `nodeIntegration:
false`, `webSecurity: true` nas duas janelas. O `client_secret` do Discord foi movido
para o painel (`/api/launcher/oauth/exchange`) com allowlist de `redirect_uri`.
**Nota de privacidade:** `GET /api/crashes` expõe Discord ID e username de cada
jogador que crashou, protegido apenas por `requireStaff` — é a rota de painel com o
pior par risco/permissão.

---

### `PONTE PAINEL → SERVIDOR DE JOGO` — MISSING

→ **BACKEND** nenhum. Nada em `apps/web` fala com o processo do SkyMP. O único socket
do gamemode é o WebSocket de voz; do `game-api` o gamemode é **cliente**, não servidor.
→ **FRONTEND** —
→ **PERMISSION** —
→ **AUDIT** —
→ **DATABASE** —
→ **STATUS** **MISSING**.
→ **PROBLEMA** **este é o teto de tudo.** Nenhuma ação sobre jogador conectado pode
partir do painel: nem kick, nem mute, nem teleporte, nem aviso. Nenhuma quantidade de
interface muda isso. E o que a API `mp` oferece precisa ser dito sem invenção:
`kick`, `isConnected`, `getUserActor`, `get/set` de posição, `callPapyrusFunction` e
`triggerClient` **existem**; evento de conexão, lista de online, **ping, freeze e
spectate não existem**. A lista de online é derivada de *polling* a cada 2 s
(`core/connection-monitor.js`), com `DEFAULT_MAX_USER_ID = 10` — padrão de
laboratório: um servidor com 11 conectados não enxerga o décimo primeiro.

---

### `GOVERNANÇA IC (GUARDA, MULTA, MANDADO, CONFISCO)` — READY, eixo separado

→ **BACKEND** `governance-service.js` (1356 linhas). 25 permissões, 4 cargos padrão,
escopo `realm`/`city`/`faction`, exigência de `on_duty` para as ações de guarda.
→ **FRONTEND** menu de interação in-game (Interaction Framework) + painel do jogador.
→ **PERMISSION** ✅ no **banco** (`governance_role_permissions`), com escopo e plantão —
o desenho que a ADR 005 quer para o eixo OOC, já pronto e rodando.
→ **AUDIT** ✅ tudo passa por `audit()` → `admin.auditLog` com prefixo `governance:`.
→ **DATABASE** 11 tabelas da `migration-v3`.
→ **STATUS** **READY** (módulo `lab`, ligado por `ENABLE_GOVERNANCE_SERVICE`).
→ **PROBLEMA** o bypass da §4.6, e o fato de que o painel administrativo **não enxerga
nada disso**: nenhuma rota lê `warrants`, `fines`, `guard_detentions`,
`custody_records`, `confiscations` ou `governance_memberships`. O painel mostra as
tabelas mortas (`criminal_records`, `faction_members`) e ignora as vivas.

---

### `SEGURANÇA — SESSÃO WEB, CSRF, CSP` — INSECURE

→ **BACKEND** `apps/web/server.js:115-124`.
→ **FRONTEND** —
→ **PERMISSION** —
→ **AUDIT** —
→ **DATABASE** nenhuma persistência de sessão.
→ **STATUS** **INSECURE**.
→ **PROBLEMA** `MemoryStore` (sessão morre a deploy, vaza memória em produção); sem
`helmet`, sem CSP; sem token CSRF. Sendo preciso em vez de alarmista: o cookie é
`sameSite: 'lax'`, o que **já bloqueia** cookie em `PATCH` cross-site, e `PATCH
/api/whitelist/:id` é a única rota mutável hoje. O risco é a ausência de defesa em
profundidade, e o custo cresce a cada rota mutável nova.

---

### `SEGURANÇA — AUDITORIA DE AMBIENTE` — READY

→ **BACKEND** `core/voice/voice-security.js` (`enforceAtBoot`, 9 achados
codificados `VOICE-SEC-001..009`, `FATAL` derruba o processo) e
`scripts/check-server-config.js` (`offlineMode`, HTTPS do master, força da
`masterKey`, hot reload do Papyrus em produção).
→ **FRONTEND** —
→ **PERMISSION** —
→ **AUDIT** achados vão para o log de boot.
→ **DATABASE** —
→ **STATUS** **READY**.
→ **PROBLEMA** nenhum. É o modelo a copiar: *"um SFU fora do ar não pode tirar o
servidor do ar; um ambiente que vaza credencial não deve chegar a ter runtime"*.
Nada equivalente existe para o painel — `apps/web` não tem auditoria de ambiente
nenhuma além do `requireEnv` de três variáveis.

---

## 3. As 13 permissões, e o que cada uma de fato guarda

| Permissão | moderator | admin | owner | Verificada em | Estado |
|---|:-:|:-:|:-:|---|---|
| `kick` | ✅ | ✅ | ✅ | `admin-service.kickPlayer` | READY |
| `teleport` | ✅ | ✅ | ✅ | `teleportTo`, `playAnimation` | READY (nome impreciso) |
| `voice_mute` | ✅ | ✅ | ✅ | 5 ações de voz | READY |
| `add_item` | — | ✅ | ✅ | `giveItemAdmin` | READY |
| `set_gold` | — | ✅ | ✅ | `setGold`; `economy-regional:251` (PARKED) | READY |
| `retire_character` | — | ✅ | ✅ | `retireCharacter` | READY |
| `reveal_identity` | — | ✅ | ✅ | `revealIdentity` | READY |
| `run_world_probe` | — | ✅ | ✅ | `fauna-census` ×2, `corpse-probe` ×1 | READY |
| `manage_recipes` | — | ✅ | ✅ | `crafting-service` ×2 (PARKED) | PARTIAL |
| `manage_staff` | — | — | ✅ | `governance:284`, `market-stalls:305,478` | **INSECURE** (§4.6) |
| **`ban`** | — | ✅ | ✅ | **nenhum lugar** | **MISSING** |
| **`view_audit`** | ✅ | ✅ | ✅ | **nenhum lugar** | **MISSING** |
| **`manage_whitelist`** | ✅ | ✅ | ✅ | **nenhum lugar** | **MISSING** |

Três das treze são declarações sem porta. `permissions.behavior.test.js` não pega isso:
ele garante que "todo handler exportado está na matriz", nunca que "toda permissão
declarada tem handler".

---

## 4. Achados, na ordem que o pedido enumerou

Severidade: 🔴 antes de qualquer staff usar o painel · 🟡 antes de crescer a equipe ·
🔵 dívida declarada.

### 4.1 ~~🔴~~ ✅ Rotas protegidas só por `requireStaff` — CORRIGIDO

**Doze**, todas: `/api/dashboard`, `/api/whitelist` (GET e **PATCH**), `/api/characters`,
`/api/audit`, `/api/economy/holds`, `/api/economy/top-gold`, `/api/criminal`,
`/api/factions`, `/api/prison`, `/api/crashes`. Zero verificações de permissão.
`req.staff.role` é resolvido em `server.js:172`, guardado, e nunca lido.

### 4.2 ~~🔴~~ ✅ Cargo desconhecido = painel liberado, jogo negado — CORRIGIDO

`staff_roles.role` é `VARCHAR(32)` sem `CHECK`, sem `ENUM`, sem FK. O gamemode faz
`ROLE_PERMISSIONS[role] || []` → `Set` vazio → nega tudo **em silêncio**. O painel, na
mesma linha do banco, faz `rows.length !== 0` → **libera tudo**. Qualquer cargo novo
inserido antes de uma migration cai exatamente nesse buraco.

### 4.3 ~~🔴~~ ✅ Ações administrativas sem permissão específica — CORRIGIDO (menos `/status`)

Todas as do painel (§4.1). No gamemode, uma: `playAnimation` guardada por `teleport`.
E `/status` (`commands.js:452`) está rotulada `[Staff]` na descrição e **não verifica
nada** — só mostra o estado do próprio personagem de quem digitou, então não é
escalação, mas é um comando que se anuncia como de staff e não é.

### 4.4 🟡 Ações sem auditoria — parcialmente corrigido (negação passou a ser registrada)

| Ação | Audita? |
|---|---|
| Login no painel | ❌ |
| Toda leitura de staff (audit, criminal, prisão, personagens, ouro, crashes) | ❌ |
| `403` do painel | ❌ |
| `sendDenied()` do gamemode | ❌ |
| Entrada/saída de fila | ❌ |
| Concessão de cargo de staff | ❌ (não existe) |
| Consulta de diagnóstico de voz | ✅ — a única leitura auditada do projeto |

A assimetria diz o essencial: o eixo de voz decidiu que consultar é registro; o painel
não decidiu nada.

### 4.5 🔴 Auditoria fail-open

`admin-service.auditLog:189` e `identity-service.auditIdentityEvent:113` capturam a
exceção, escrevem no console e **retornam normalmente**. A ação de staff prossegue sem
rastro. O `revealIdentity` chega a ordenar `await` da auditoria *antes* da notificação
justamente para que o banco caído impeça a revelação — mas o `auditLog` engole o erro,
então a ordem correta protege contra menos do que o comentário promete.

### 4.6 🔴 `manage_staff` é bypass total do eixo IC

`governance-service.js:283` abre com `if (isStaffGovernor(actorId)) return { allowed:
true, source: 'staff' }` — antes de qualquer consulta ao banco, antes do escopo, antes
do plantão. Um `owner` tem as 25 permissões de governança em todo escopo, o tempo todo.
O mesmo em `market-stalls-service.js:305` e `:478` (recolher barraca alheia).

Não é acidente: o caso `staff` é tratado explicitamente em `fineCreditor` (`:637`),
que destrói o ouro contra `system:staff_fine` em vez de creditar instituição nenhuma —
desenho cuidadoso. O problema é outro: **o bypass não é distinguível na auditoria**. A
linha gravada é `governance:guard:arrest` idêntica à de um guarda IC legítimo. Quem
auditar depois não consegue separar "a guarda prendeu" de "um admin usou poder OOC".

### 4.7 🟡 Mutações diretas no banco

O projeto é rigoroso onde decidiu ser: **ouro e item nunca** são escritos direto —
`transaction-service` é o único caminho, e `/setgold` foi reescrito para isso. Fora
dali:

| Mutação direta | Onde | Grave? |
|---|---|---|
| `UPDATE characters SET status='retired'` | `admin-service:434` | não — soft-delete auditado |
| `UPDATE whitelist_applications` + `UPDATE characters` | `apps/web:354,386` | não — auditado |
| `INSERT INTO accounts` (auto-whitelist local) | `whitelist.js:113` | não — bloqueado em produção |
| `DELETE FROM character_restraints` | `governance:507,829` | 🔵 `DELETE` onde o resto usa status |
| `UPDATE prison_records SET status='released'` | `governance:875` | não |
| Banir / desbanir | **na mão, no MySQL** | 🔴 §4.9 |
| Promover / despromover staff | **na mão, no MySQL** | 🔴 §4.9 |

### 4.8 🟡 Funções administrativas espalhadas

**Escrita de `audit_logs`: cinco módulos, quatro formatos.** `admin-service.auditLog`
(oficial), `apps/web` (cru), `commands.js` (cru, JSON), `death-service` (cru, ×5),
`identity-service` (cru). `market-stalls` tem tabela própria (`market_stall_audit`).

**Ações de staff: três arquivos.** `admin-service.js` (13 comandos), `fauna-census.js` +
`corpse-probe.js` (`run_world_probe`), `crafting-service.js` + `economy-regional.js`
(PARKED). O `parked-staff-permissions.test.js` existe precisamente porque essa dispersão
já deixou um bug passar por uma suíte inteira: três handlers fora do alcance da matriz
passavam **nível numérico** para `hasPermission`, e `Set.has(20)` negava tudo em
silêncio, inclusive para `owner`. Há hoje uma varredura estática guardando essa classe.

### 4.9 🔴 Funcionalidades incompletas

| O que | O que falta |
|---|---|
| **Ban** | tudo que escreve. Os três pontos de aplicação já existem e funcionam |
| **Gestão de staff** | tudo. Nenhum código toca `staff_roles` |
| **Painel operacional** | toda ação. 12 rotas, 11 são `SELECT` |
| **Cargo temporário** | `staff_roles.account_id` é `UNIQUE`; sem `expires_at` |
| **Métricas** | o `renderPrometheus` existe e ninguém o serve |

### 4.10 🔵 Código morto e sistemas mortos ainda lidos

- `staff_permissions` — tabela, zero referências.
- `criminal_records` — três leitores, **zero escritores**. Sobra do `justice-service`.
- `faction_members` — um leitor (o painel), **zero escritores**. Sobra do
  `faction-service`.
- `holds.tax_rate` — escrito só pelo `economy-regional` (PARKED); o sistema vivo escreve
  `cities`/`realms`. O painel lê `holds`.
- `voice-telemetry.renderPrometheus` / `logLine` — sem consumidor.
- `admin-service.js:592-595` — comentário que descreve o comportamento anterior à
  `migration-v16`.

### 4.11 🔵 Planejados e não integrados

`docs/skyadmin/` (marcos 2–6), `docs/admin/RBAC.md` ("desenho aceito, implementação não
iniciada"), [ADR 005](../technical/ADR_005_ADMIN_RBAC.md),
[`ADMIN_SECURITY_MATRIX.md`](../testing/ADMIN_SECURITY_MATRIX.md) ("nenhum teste desta
matriz existe"). Todos honestos sobre o próprio estado — o que é raro e vale registrar.

### 4.12 🔵 Menores

- `GET /api/crashes` expõe Discord ID + username por `requireStaff` (§ launcher).
- `app.get('*')` devolve `index.html` com **200** para `/api/rota-inexistente`.
- `rateLimitBuckets` nunca é podado nos três serviços — cada IP novo é entrada
  permanente até o restart.
- ~~`requireStaff` não confere se a conta da própria staff continua `active`~~ ✅ **corrigido**:
  o middleware novo nega por status da conta antes de olhar permissão.

---

## 5. Cobertura de teste do que é administrativo

| Suíte | Cobre | Não cobre |
|---|---|---|
| `permissions.behavior.test.js` | 13 ações × 4 cargos, **por efeito colateral real** (ledger escrito, status mudado, auditoria gravada), + "todo handler exportado está na matriz" | permissão declarada sem handler |
| `parked-staff-permissions.test.js` | 3 handlers PARKED + varredura estática contra nível numérico | — |
| `admin-service.test.js` | `hasPermission` unitário | — |
| `apps/web/server.test.js` | 12 rotas respondem **401 sem sessão** | **nenhum teste de cargo. Zero. Nunca se verifica que um `moderator` não pode algo** |
| `voice-diagnostics.test.js`, `voice-staff-mute.test.js` | as 5 ações de voz | painel |

A assimetria é o retrato do projeto: o lado que ninguém consegue usar tem matriz de
comportamento com teste de mutação; o lado que a staff vai abrir amanhã tem teste de
401.

---

## 6. Respostas diretas

### 6.1 O que já existe

Uma plataforma de **quatro processos** — painel Express com OAuth do Discord, API de
jogo com fila e paridade de modpack, bot do Discord e launcher Electron — mais um
gamemode com **três sistemas de autorização** (staff OOC em memória, staff no painel
binário, governança IC no banco), **64 tabelas** (`npm run check:schema:list`,
15/08/2026 — a auditoria de 13/08 mediu 63; a `v16` da voz é a diferença),
`audit_logs` central com cinco
escritores, ledger de ouro e de item com idempotência, e uma administração de voz
completa e auditada. O painel tem 8 abas e 12 rotas.

### 6.2 O que está funcional

- **RBAC de staff do gamemode.** 13 permissões nomeadas, matriz testada por
  comportamento, recusa barulhenta de argumento inválido.
- **As 13 ações de staff in-game** — kick, teleporte, item, ouro, permakill, revelação
  de identidade, sondas de mundo e as 5 de voz — todas com permissão **e** auditoria.
- **Autenticação e identidade.** `profileId` vem do master API, nunca do cliente;
  tickets guardam só hash; `masterKey` compara em tempo constante; `vip_level` nunca é
  critério de permissão, nos dois lados.
- **Dinheiro e item de staff passam pelo ledger.** `/setgold` é delta sob lock;
  `/additem` valida o FormID contra os plugins carregados antes de gravar.
- **`/permakill` é soft-delete com motivo obrigatório.** Nunca `DELETE`.
- **Governança IC.** 25 permissões no banco, com escopo e plantão, tudo auditado, multa
  atômica que distingue recusa de falha.
- **Discord é unidirecional.** Cargo do Discord nunca vira poder em jogo.
- **Auditoria de ambiente da voz.** `FATAL` no boot derruba o processo.
- **Toda query é parametrizada.** Nenhuma concatenação de SQL nos quatro apps.

### 6.3 O que está parcial

- **Kick, teleporte e as 5 ações de voz**: funcionam in-game, inalcançáveis do painel.
- **Painel**: 11 das 12 rotas são `SELECT`. Ele observa e não age.
- **Prisão e facções**: escrita IC existe; o painel só lê, e lê a tabela errada nas
  facções.
- **Métricas**: construídas para a voz, sem endpoint. Fora da voz, inexistentes.
- **Bot do Discord**: correto no que faz; `/voz-criar` introduz uma quarta fonte de
  autoridade (cargo do Discord).
- **Morte/abatido**: produz evidência de RDM excelente, ilegível no painel.
- **`manage_recipes`**: verificada corretamente, num módulo que não sobe.

### 6.4 O que está inseguro

1. **`requireStaff` é binário** — 12 rotas, incluindo a única mutável, sem permissão.
2. **Cargo desconhecido libera o painel inteiro** e nega o jogo inteiro, em silêncio.
3. **Auditoria fail-open** — a ação acontece, o rastro pode não.
4. **Negação nunca é registrada** — sondagem de permissão é invisível.
5. **`manage_staff` faz bypass total do eixo IC** e o bypass não aparece na auditoria.
6. **Três permissões declaradas sem porta** (`ban`, `view_audit`, `manage_whitelist`).
7. **Sessão em `MemoryStore`, sem CSRF, sem CSP, sem `helmet`.**
8. **Ban e promoção de staff só existem como `UPDATE` na mão** — sem motivo, sem prazo,
   sem autor, sem auditoria, sem desfazer.
9. **Conta banida com cargo de staff continua entrando no painel.**
10. **`GET /api/crashes` expõe Discord ID de jogadores** ao cargo mais numeroso.

### 6.5 O que realmente falta

Em ordem de dependência, não de desejo:

1. **Migration de RBAC** — `staff_role_permissions` (cargo→permissão, no banco),
   `staff_roles` com `expires_at`/`revoked_at`/`revoked_by`, `CHECK` no nome do cargo,
   fim do `UNIQUE` em `account_id`. Fecha §4.2, §4.9 (parte).
2. **`requirePermission(permission)` no painel**, substituindo `requireStaff` nas 12
   rotas, **com auditoria de negação**. Fecha §4.1, §4.3, §4.4.
3. **Resolver as três permissões órfãs** — implementar ou remover. Fecha §3.
4. **Ban de verdade** — tabela `bans`, escrita de `accounts.status` **e**
   `game_sessions.revoked_at` na mesma transação, com motivo, prazo, autor e unban.
5. **Gestão de staff pelo painel**, guardada por `manage_staff` — que passaria a
   significar o que o nome diz.
6. **`audit_logs` v2** — `permission`, `outcome`, `before`/`after`, `request_id`, e
   **fail-closed** para as ações irreversíveis (revelação, permakill, ban).
7. **Sessão em MariaDB, CSRF, `helmet`/CSP.**
8. **Marcar o bypass de staff na auditoria do eixo IC** — uma palavra em `details`.
9. **Só então a ponte painel → jogo**, que é a peça grande, exige protocolo novo, e é a
   única que depende de uma sessão real acontecer primeiro.

Os itens 1–8 não dependem de jogador conectado. O 9 depende, e
[o bloqueio da Fase 0](../historico/PHASE_0_TEST_LOG.md) continua sendo o que sempre
foi: **ninguém nunca conectou**.

### 6.6 O que deve ser reaproveitado

**Não construir de novo:**

| Peça | Por quê |
|---|---|
| `admin-service.ROLE_PERMISSIONS` + `hasPermission` | é o RBAC correto. O painel deve **consumir** isto, não criar o segundo |
| `permissions.behavior.test.js` | a matriz cargo × ação por efeito real é o portão que já pegou um bug que a suíte inteira deixou passar. O painel precisa da versão dele |
| `governance_roles` × `governance_role_permissions` | o mapa cargo→permissão **no banco** que a ADR 005 quer já existe e roda. Copiar a forma, não inventar |
| `admin-service.auditLog` | o escritor único que os outros cinco deveriam usar |
| `transaction-service` | todo dinheiro e item administrativo já passa por ele. Nenhuma ação nova de painel pode escapar |
| `moderation-log` (gamemode e bot) | a separação notificação × registro está certa e documentada nos dois lados |
| Master API + `launch_tickets` + `game_sessions` | identidade fora das mãos do cliente, hash em vez de token, comparação em tempo constante |
| `voice-security.enforceAtBoot` | o modelo de auditoria de ambiente que `apps/web` não tem |
| `voice-diagnostics` | as 5 ações são o modelo de ação administrativa: permissão, auditoria **inclusive na consulta**, auditoria **inclusive na falha**, injeção em vez de import |
| `core/module-registry` | ciclo de vida com estados, ordenação topológica e limpeza de órfãos. Um módulo `admin` do painel entra por aqui |

**Apagar, não migrar:** `staff_permissions` (FK aponta para a pessoa, não o cargo),
`criminal_records` e o `LEFT JOIN faction_members` do painel (tabelas de sistemas
apagados), e a leitura de `holds.tax_rate` pelo painel.

---

**Fim da auditoria. Nenhum código foi alterado.** A `CONSTITUICAO.md` §14 é explícita:
entender, questionar, achar falhas, comparar, documentar — e só então escrever código.
