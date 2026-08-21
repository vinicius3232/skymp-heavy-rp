# Matriz de autorização

**Data:** 2026-08-15 · **Estado:** implementado e coberto por teste.
**Fonte única:** [`skymp/gamemode/core/permissions.js`](../../skymp/gamemode/core/permissions.js)

Este documento é o inventário de **toda rota HTTP dos três serviços** e do que a
protege. Ele descreve o que roda, não o que se pretende: cada linha foi lida no
código, e a matriz do painel é verificada por
[`apps/web/permissions.test.js`](../../apps/web/permissions.test.js), que reprova
quem adicionar rota sem passar por aqui.

Antecedentes: [estado da plataforma](SKYADMIN_CURRENT_STATE.md) ·
[auditoria de 13/08](../research/ADMIN_PLATFORM_AUDIT.md) ·
[ADR 005](../technical/ADR_005_ADMIN_RBAC.md)

---

## 1. Como ler

- **Permission** é uma *capability* `dominio.acao`. Não existe rota protegida por
  cargo: nenhum código pergunta `role === 'admin'`, em lugar nenhum.
- **Role mínimo** é derivado, não declarado. Ele é consequência de quem tem a
  capability no catálogo; mudá-lo significa mudar o catálogo, e isso quebra a
  matriz de teste até que alguém declare a intenção.
- **`requireAuth`** significa "qualquer jogador logado" — rota de jogador, não de
  staff.
- **`requireInternal` / `X-Internal-Secret`** é fronteira máquina-a-máquina. Não
  é RBAC e não deve virar: quem apresenta o segredo é um processo nosso, não uma
  pessoa com cargo.

---

## 2. Painel web (`apps/web`)

### 2.1 Rotas de staff

| Route | Method | Permission | Role mínimo | Audita |
|---|---|---|---|---|
| `/api/dashboard` | GET | `server.view` | moderator | negação |
| `/api/whitelist` | GET | `whitelist.view` | moderator | negação |
| `/api/whitelist/:id` | PATCH | `whitelist.review` | moderator | negação + a decisão de whitelist |
| `/api/characters` | GET | `characters.view` | moderator | negação |
| `/api/audit` | GET | `audit.view` | moderator | negação **e concessão** |
| `/api/criminal` | GET | `governance.view` | moderator | negação |
| `/api/factions` | GET | `governance.view` | moderator | negação |
| `/api/prison` | GET | `governance.view` | moderator | negação |
| `/api/economy/holds` | GET | `economy.view` | **admin** | negação |
| `/api/economy/top-gold` | GET | `economy.view` | **admin** | negação **e concessão** |
| `/api/crashes` | GET | `security.view` | **admin** | negação **e concessão** |

**As três "concessão" são deliberadas e são as únicas.** A regra vem do módulo de
voz, que já tinha decidido que consultar o estado de um jogador é registro:
quem leu o `audit_logs` inteiro, quem leu o ranking de patrimônio e quem leu
crash reports com Discord ID deixam rastro. O contador do dashboard não.
Auditar toda leitura produziria um log que ninguém lê, que é o mesmo que não
auditar.

**As três linhas em negrito são o que mudou de fato para o moderador.** Antes
não havia verificação nenhuma, então "moderador" significava, na web, o mesmo
que "owner". Ao fechar a porta, duas coisas ficaram fora dele:

- **`economy.view`** — o ranking de patrimônio e os tesouros regionais não
  ajudam a moderar uma cena, e são metagaming pronto na mão do cargo mais
  numeroso e menos filtrado.
- **`security.view`** — crash reports carregam Discord ID e username de cada
  jogador que crashou. Era a rota com o pior par risco/permissão do painel.

Todo o resto que o moderador enxergava, ele continua enxergando.

### 2.2 Rotas de jogador e públicas

| Route | Method | Guard | Por quê não é RBAC |
|---|---|---|---|
| `/api/auth/discord` (+ `/callback`) | GET | — | é o próprio login |
| `/api/auth/logout` | POST | — | destrói a própria sessão |
| `/api/me` | GET | `requireAuth` | devolve os dados de quem pergunta |
| `/api/apply` | POST | `requireAuth` | o jogador cria a própria ficha |
| `/api/crashes/client` | POST | rate limit | o launcher reporta antes de haver sessão |
| `/api/servers/:masterKey/sessions/:session` | GET | `masterKey` + rate limit | contrato do SkyMP; o chamador é o servidor de jogo |
| `/api/launcher/oauth/exchange` | POST | rate limit + allowlist de `redirect_uri` | acontece antes de existir conta |
| `/internal/authorize` | POST | `X-Internal-Secret` + rate limit | é o **resolvedor**; ver §4 |
| `*` | GET | — | serve o `index.html` da SPA |

---

## 3. Game API (`apps/game-api`)

| Route | Method | Guard | Permission | Role mínimo |
|---|---|---|---|---|
| `/mods.json` | GET | — | — | — |
| `/api/queue/join` | POST | ticket de uso único + rate limit | — | — |
| `/api/queue/status` | POST | ticket de uso único + rate limit | — | — |
| `/internal/session/resolve` | POST | `requireInternal` | — | — |
| `/internal/session/release` | POST | `requireInternal` | — | — |
| `/health` | GET | — | — | — |

**A Game API não tem nenhuma rota de staff, e isto não é uma omissão a corrigir.**
Ela atende jogador (fila, paridade de modpack) e processo (endpoints internos). O
ticket **é** a credencial — ele prova quem é a pessoa —, e `isEligible` reconfere
a conta na entrada da fila, então uma conta desativada entre o login no launcher
e a fila é barrada.

Inventar aqui uma rota de staff para "usar o RBAC" seria construir uma porta para
justificar uma chave. O que este trabalho lhe dá é a regra de que, **quando** uma
rota de staff existir, ela usa o mesmo catálogo — nunca uma noção própria de
staff. A alternativa que foi considerada e recusada: expor `renderPrometheus()`
do `voice-telemetry` aqui sob `server.view`. É uma funcionalidade nova, não uma
correção de autorização, e entra pela porta dela.

`/health` continua público de propósito: `queue.snapshot()` devolve só agregados
(capacidade, ocupados, conectados, esperando) — nenhum identificador de jogador.

---

## 4. Bot do Discord (`apps/bot-discord`)

| Superfície | Guard | Permission | Role mínimo |
|---|---|---|---|
| `POST /api/sync-role` | `X-Internal-Secret` + rate limit | — | — |
| `POST /api/moderation-log` | `X-Internal-Secret` + rate limit | — | — |
| `/voz-criar` (slash) | `POST /internal/authorize` do painel | `voice.mute` | moderator |
| `/voz-fechar` (slash) | `POST /internal/authorize` do painel | `voice.mute` | moderator |

**O que mudou:** os dois slash commands eram gateados por `isStaffMember`, que
aceitava quem tivesse o cargo `STAFF_ROLE_ID` **do Discord** ou a permissão
`Administrator` da guild. Era uma quarta fonte de autoridade fora de
`staff_roles`: promover alguém no Discord dava poder que o servidor de jogo não
reconhecia, e revogar no banco não tirava nada no bot.

O efeito prático era pequeno — criar canal de voz temporário. O precedente não
era: era a porta pela qual "cargo do Discord vira poder" entraria de novo na
funcionalidade seguinte, contra uma regra que o projeto já tinha.

**A correção não foi dar banco ao bot.** Ele é o processo mais exposto (fala com
API de terceiro, roda com um token que circula) e o único que não lê nem escreve
nada do servidor — isso é uma qualidade. O painel, que já autentica Discord e já
lê `staff_roles`, responde por ele em `POST /internal/authorize`.

**O cliente é fail-closed**, ao contrário do `moderationLog`, que é
manda-e-esquece. A diferença é a direção da dependência: no log de moderação a
ação já aconteceu e o Discord é notificação; aqui a resposta é a **condição** da
ação. Painel fora do ar, timeout, resposta malformada, segredo ausente: tudo
nega. `STAFF_ROLE_ID` foi removido do `.env.example`.

---

## 5. Gamemode (comandos de chat)

Não são rotas HTTP, e entram na mesma matriz porque saem do mesmo catálogo.
Verificados por comportamento real em
[`permissions.behavior.test.js`](../../skymp/gamemode/permissions.behavior.test.js).

| Comando | Handler | Permission | Role mínimo |
|---|---|---|---|
| `/kick` | `kickPlayer` | `players.kick` | moderator |
| `/tp` | `teleportTo` | `players.teleport` | moderator |
| `/anim` | `playAnimation` | **`players.animate`** | moderator |
| `/calar`, `/descalar` | `voiceMute`, `voiceUnmute` | `voice.mute` | moderator |
| `/vozdiag`, `/vozdesconectar`, `/vozreconectar` | diagnóstico de voz | `voice.mute` | moderator |
| `/additem` | `giveItemAdmin` | `inventory.grant` | admin |
| `/setgold` | `setGold` | `economy.adjust` | admin |
| `/permakill` | `retireCharacter` | `characters.retire` | admin |
| `/revelaridentidade` | `revealIdentity` | `identity.reveal` | admin |
| `/censofauna`, `/sondacadaver` | censo e sonda | `world.probe` | admin |
| `/addrecipe`, `/addingredient` | crafting (PARKED) | `economy.recipes` | admin |
| `/settax` | economia regional (PARKED) | `economy.adjust` | admin |
| bypass da governança IC | `isStaffGovernor`, `hasStallPermission` | `staff.manage` | owner |

**`/anim` é a única mudança de comportamento.** Ele era guardado por `teleport` —
uma permissão que significava outra coisa que não o que o nome diz, que é
exatamente o defeito contra o qual o catálogo argumenta em `economy.recipes` e
`identity.reveal`. Ninguém perdeu poder: os dois cargos que tinham `teleport`
receberam as duas capabilities. O que mudou é que "quem pode animar?" passou a
ter resposta própria.

`/status` continua sem verificação e continua rotulado `[Staff]` na descrição.
Ele mostra só o estado do **próprio** personagem de quem digitou, então não é
escalação — é um rótulo errado, e está registrado como tal.

---

## 6. O catálogo: 20 ativas, 10 reservadas

### 6.1 Ativas

| Capability | moderator | admin | owner |
|---|:-:|:-:|:-:|
| `players.kick` | ✅ | ✅ | ✅ |
| `players.teleport` | ✅ | ✅ | ✅ |
| `players.animate` | ✅ | ✅ | ✅ |
| `whitelist.view` | ✅ | ✅ | ✅ |
| `whitelist.review` | ✅ | ✅ | ✅ |
| `characters.view` | ✅ | ✅ | ✅ |
| `audit.view` | ✅ | ✅ | ✅ |
| `governance.view` | ✅ | ✅ | ✅ |
| `voice.mute` | ✅ | ✅ | ✅ |
| `server.view` | ✅ | ✅ | ✅ |
| `characters.retire` | — | ✅ | ✅ |
| `identity.reveal` | — | ✅ | ✅ |
| `inventory.grant` | — | ✅ | ✅ |
| `economy.adjust` | — | ✅ | ✅ |
| `economy.recipes` | — | ✅ | ✅ |
| `economy.view` | — | ✅ | ✅ |
| `world.probe` | — | ✅ | ✅ |
| `security.view` | — | ✅ | ✅ |
| `staff.manage` | — | — | ✅ |

`voice.mute` cobre as cinco ações de voz — silenciar, devolver, diagnosticar,
derrubar e reemitir o transporte. Foram consideradas duas capabilities e a
divisão foi desfeita: o código já argumentava, por escrito, que são uma
autoridade só ("quem pode calar pode destravar"), e as cinco agem sobre o mesmo
objeto. Isso é diferente de `teleport`/`animate`, que agem sobre objetos
distintos com verbos distintos.

### 6.2 Reservadas — o nome existe, o poder não

**Concedidas a ninguém.** Negam para todo cargo, `owner` incluído, com o motivo
`reserved_permission` no log — nunca "sem cargo", que faria alguém "consertar"
promovendo a pessoa.

| Capability | Por que ainda não existe |
|---|---|
| `players.view` | não existe ponte painel→servidor de jogo |
| `players.ban` | não existe comando, endpoint nem tabela de ban |
| `characters.manage` | nenhuma rota muta personagem fora da revisão de whitelist |
| `inventory.view` | não existe leitura de inventário alheio por staff |
| `inventory.remove` | não existe `/removeitem` |
| `audit.export` | não existe exportação |
| `staff.view` | não existe listagem de staff |
| `security.review` | a negação passou a ser auditada; não há superfície que a apresente |
| `security.enforce` | `game_sessions.revoked_at` nunca recebeu um `UPDATE` |
| `server.manage` | `ADMIN_PLATFORM.md` já decidiu que restart e toggle a quente ficam fora |

Este é o conserto direto do achado do `ban`, que estava **concedida a `admin` e
`owner` desde sempre** e verificada em lugar nenhum. Apagar o nome faria a
próxima pessoa inventar um rival e criar um segundo vocabulário; reservá-lo
mantém o nome tomado e o poder ausente, e duas invariantes de teste impedem que
alguém conceda uma reservada por engano.

---

## 7. As quatro negações

Valem em todos os consumidores, porque saem do mesmo `decide()`.

| Situação | Motivo | Resultado |
|---|---|---|
| Cargo fora do catálogo (`role='support'`) | `unknown_role` | nega **tudo** |
| Sem linha em `staff_roles` | `no_role` | nega tudo |
| Nome que não existe (`manage_factions`) | `unknown_permission` | nega, `owner` incluído |
| Forma errada (`20`, `Players.Kick`) | `malformed_permission` | nega, `owner` incluído |
| Capability reservada | `reserved_permission` | nega, `owner` incluído |
| Cargo válido sem a capability | `not_granted` | nega |

Duas notas sobre a redação, porque elas custam tempo de quem depura:

- **Nome legado inexistente é `unknown_permission`, não `malformed`.**
  `manage_factions` não tem ponto, mas chamá-lo de malformado faz quem lê
  corrigir a *forma* (`manage.factions`) e continuar sem existir.
- **Nível numérico tem redação própria.** `hasPermission(actorId, 20)` já custou
  caro uma vez: doze chamadas negavam tudo em silêncio, inclusive para `owner`.
  O log se identifica.

Duas regras que não estão nesta tabela porque são estruturais:

- **`vip_level` não concede nada.** Ele não aparece em nenhum caminho de decisão;
  `decide()` recebe apenas o cargo.
- **Conta inativa nega antes da permissão.** Uma conta `status='banned'` com
  linha em `staff_roles` entrava no painel normalmente — o ban bloqueava o jogo,
  não a web.

---

## 8. Compatibilidade

Os treze nomes do sistema anterior continuam valendo, traduzidos antes de
qualquer validação. Nenhum sítio de chamada precisou mudar — inclusive os dos
módulos PARKED, que ninguém está olhando e que já foram, uma vez, onde um bug de
permissão sobreviveu a uma suíte inteira.

| Nome antigo | Capability |
|---|---|
| `kick` | `players.kick` |
| `teleport` | `players.teleport` |
| `add_item` | `inventory.grant` |
| `set_gold` | `economy.adjust` |
| `retire_character` | `characters.retire` |
| `reveal_identity` | `identity.reveal` |
| `run_world_probe` | `world.probe` |
| `manage_recipes` | `economy.recipes` |
| `manage_staff` | `staff.manage` |
| `voice_mute` | `voice.mute` |
| `view_audit` | `audit.view` — deixou de ser órfã: o painel a verifica |
| `manage_whitelist` | `whitelist.review` — idem |
| `ban` | `players.ban` — **reservada**, nega agora |

`ban` é a única cujo comportamento muda, e muda para o que já acontecia na
prática: ela era concedida e nada a verificava, então nada acontecia. Agora isso
é declarado em vez de acidental.

---

## 9. Cobertura de teste

| Suíte | O que trava |
|---|---|
| [`core/permissions.test.js`](../../skymp/gamemode/core/permissions.test.js) (96) | forma do catálogo; `active` sem cargo e `reserved` com cargo; as quatro negações; matriz cargo × capability escrita à mão; os 13 aliases; **varredura que reprova toda capability ativa sem sítio de chamada** |
| [`apps/web/permissions.test.js`](../../apps/web/permissions.test.js) (44) | matriz rota × cargo por status HTTP real; negação auditada; cargo desconhecido nega todas as rotas; conta banida barrada; concessão sensível registrada; `requireStaff` não volta; nenhuma rota sem guard; nenhum mapa de cargos no painel |
| [`permissions.behavior.test.js`](../../skymp/gamemode/permissions.behavior.test.js) | cargo × comando **por efeito colateral real** (ledger escrito, status mudado, auditoria gravada) |
| [`parked-staff-permissions.test.js`](../../skymp/gamemode/parked-staff-permissions.test.js) | comandos PARKED; nenhum nível numérico sobrou |
| [`voiceChannels.test.js`](../../apps/bot-discord/voiceChannels.test.js) | o bot pergunta pela capability certa e **nega quando o painel está fora** |

A varredura da primeira linha é a que teria pego o `ban`:
`permissions.behavior.test.js` garante que todo handler exportado está na matriz;
ela garante o inverso, que toda permissão declarada como ativa é exigida em algum
lugar do código de produção. Ela já pegou uma falha real durante este trabalho —
uma capability dividida sem sítio de chamada correspondente.

Todas estão nos `npm test` dos respectivos pacotes, e o CI roda os quatro.

---

## 10. O que este trabalho deliberadamente não fez

- **Não criou tabela de RBAC no banco.** A [ADR 005](../technical/ADR_005_ADMIN_RBAC.md)
  quer o mapa cargo→permissão em tabela, e continua certa. O catálogo em arquivo
  é o passo que fecha a divergência entre os processos sem exigir migration; a
  tabela é a próxima etapa, e o formato de `ROLE_CAPABILITIES` foi escolhido para
  ser semeadura direta dela.
- **Não implementou ban, gestão de staff, nem exportação de auditoria.** As
  capabilities existem reservadas; o poder, não. Implementar qualquer uma é
  promover a capability e conceder a um cargo — as invariantes de teste guiam.
- **Não mexeu em `staff_roles`.** Cargo temporário, `revoked_at` e `CHECK` no
  nome do cargo continuam pendentes, e continuam sendo migration.
- **Não construiu a ponte painel→jogo.** Continua sendo o teto de tudo, e
  continua dependendo de uma sessão real acontecer primeiro.
