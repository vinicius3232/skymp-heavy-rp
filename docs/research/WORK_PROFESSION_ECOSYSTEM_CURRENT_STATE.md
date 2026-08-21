# Auditoria — Ecossistema de Profissões, Trabalhos e Economia

**Data:** 20/08/2026 · **Branch auditada:** `feat/skyvoice-core-etapa-2` (HEAD `48bad04`, working tree limpa, sincronizada com `origin`) · **Autor:** auditoria assistida (sem implementação)

**Legenda de evidência:** `[CODE]` lido diretamente no arquivo · `[TEST]` confirmado por teste existente · `[MIGRATION]` confirmado no `.sql` versionado · `[CONFIG]` `module-registry`/`.env`/`server-options` · `[DOC]` afirmado só em documentação, não confirmado em código · `[GIT HISTORY]` `git log` · `[INFERENCE]` dedução minha, marcada como tal · `[EXTERNAL]` não usado nesta rodada (item 29 do pedido: pesquisa externa fica para depois)

Este relatório **não implementa nada**. É levantamento de fatos para decisão do dono do produto.

---

## 0. Estado do repositório local

```
[GIT HISTORY]
Branch:        feat/skyvoice-core-etapa-2 (up to date with origin)
Working tree:  limpo, nada para commitar
HEAD:          48bad04 "docs: jobs/contracts/crafting deixam de ser descritos como PARKED"
```

Últimos 5 commits, todos deste domínio:

| Commit | O quê |
|---|---|
| `48bad04` | docs: atualiza status jobs/contracts/crafting (PARKED → LAB reativado) |
| `2ee7788` | feat(crafting): reativa `crafting-service` com gate de profissão/rank por receita |
| `99c125c` | feat(trabalhos): reativa `jobs-service` e `contracts-service` como módulos lab |
| `9b26f27` | feat: profissões, nós de recurso, minerador com distância e pipeline de admin/auditoria |
| `0ee7bbc` | docs: QA_REPORT desatualizado (444→1270 testes) |

**Conclusão do item 2 do pedido:** o repositório local **é** a referência — não há divergência do GitHub a compensar; a série de reativações (profissões → minerador → jobs/contracts → crafting) é recentíssima, toda de hoje e de ontem, e a doc que descrevia esses três módulos como PARKED só foi corrigida no commit de topo. Isso explica por que alguns documentos lidos abaixo (`PROFESSION_FRAMEWORK.md`, `CONTRACTS.md`) ainda têm frases residuais da versão anterior ao `48bad04` — sinalizado onde encontrado.

---

## 1. Resumo executivo

O que existe: um **Profession Core** genérico (grant/revoke/rank/XP, sem gameplay por trás), um **Resource Node Framework** genérico (nó com capacidade/regen/gate, sem mundo por trás), e um primeiro consumidor real dos dois — o **Minerador MVP** — que é hoje a única cadeia ponta-a-ponta (profissão → nó → distância real → inventário → XP) que existe no projeto. Ao lado, um **Economy Framework** (`core/economy-service.js` + `core/transaction-service.js`) maduro e testado que é a porta única de dinheiro, e um **Inventory Framework** (`core/inventory.js`) equivalente do lado de item — ambos nascidos de correções de bugs reais de dinheiro/item sumindo em módulos antigos.

O que está ativo: **nada, em produção.** Todo módulo deste domínio nasce com a flag em `false` — `[CONFIG]` confirmado linha a linha em `phase0-basic.js`. "Ativo" neste projeto significa "registrado no `module-registry`, testado localmente, nunca visto com um jogador dentro" — frase que se repete, quase idêntica, no cabeçalho de `jobs-service.js`, `contracts-service.js`, `trade-service.js`, `crafting-service.js` e no `CRAFTING_SYSTEM.md`/`CONTRACTS.md`/`TRADE_SYSTEM.md`. `[CODE]` `[DOC]`

O que está LAB: `profession`, `mining`, `jobs`, `contracts`, `crafting`, `trade`, `market-stalls`, `governance`, `player-panel` — todos registrados, com `initialize()` funcional, atrás de env flag. `[CONFIG]`

O que está PARKED: `economy-regional.js`, `housing-service.js`, `horse-service.js` — existem no disco, **não** estão no `module-registry`, não sobem nem com a flag em `true`. `[CODE]` `[CONFIG]`

O que foi apagado (não existe mais): `economy-service.js` antigo, `justice-service`, `faction-service`, `survival-service`, `disguise-service` — documentado em `PARKED_SERVICES_DECISION.md`, confirmado por ausência no disco. `[DOC]` `[CODE]`

O que falta, em uma frase: **tudo que liga o núcleo genérico ao mundo do Skyrim continua não-validado em jogo**, e a taxonomia de produto (profissão × emprego × cargo × negócio × trabalho livre) **não existe como conceito no código** — o que hoje existe é "Profession" (catálogo fechado de 13 rótulos, todos tratados igual) e "Jobs" (três verbos de coleta sem estrutura), sem nenhuma camada entre eles ou acima deles. Ver §14.

---

## 2. Current State Matrix

| Sistema | Estado | Implementado | Gameplay real | Testes | In-game | Próxima análise |
|---|---|---|---|---|---|---|
| Profession Core | LAB | Grant/revoke/rank/XP `[CODE][TEST]` | Nenhuma das 13 profissões `[DOC]` (`profession-registry.js` linhas 27-33) | 484+113 linhas, cobre concorrência/lock `[TEST]` | Não | §3 |
| Resource Node Core | LAB (sem flag própria — é biblioteca) | Nó, capacidade, regen sob demanda, `consume()` atômico `[CODE][TEST]` | Só via Minerador `[CODE]` | 374+32 linhas `[TEST]` | Não | §5 |
| Mining (Minerador) | LAB | Interação `object`, distância, ferramenta, XP `[CODE][TEST]` | Sim — único fim-a-fim completo | 233 linhas, roda contra Interaction Framework real `[TEST]` | **Não** — suposição de `locationalData` em objeto comum não validada `[CODE]` (cabeçalho `mining-service.js` linhas 25-29) | §6 |
| Lenhador/Fazendeiro/Caçador/Pescador | Não existe | — | — | — | — | §7 |
| Crafting | LAB (reativado 20/08) | Receita, ingrediente, gate profissão/rank `[CODE][MIGRATION]` | Parcial — sem receita de forja cadastrada, sem estação real | **Nenhum** — sem `crafting-service.test.js` no disco `[CODE]` (busca confirmada) | Não | §8 |
| jobs-service | LAB (reativado 20/08) | 3 verbos de coleta livre, sem estrutura própria `[CODE]` | Sim, mas raso — `Math.random()` decide raridade | **Nenhum** — sem `jobs-service.test.js` no disco `[CODE]` | Não | §9 |
| contracts-service | LAB (reativado 20/08) | Máquina de estados completa, escrow | Sim | 512 linhas `[TEST]` | Não | §11 |
| trade-service | LAB | Troca P2P versionada | Sim, sem ouro | 438 linhas `[TEST]` | Não | — |
| market-stalls | LAB | Loja de jogador, imposto, fiscalização | Sim | **Raso** — só unicidade de comando e toggle, não testa compra/venda `[CODE]` (156 linhas) | Não | §12 |
| Economy Framework | CORE (via `transaction`/`economy-service`) | Sim, maduro | — (é infra) | 4 arquivos de teste `[TEST]` | Não | §7 |
| Inventory Framework | CORE | Sim, maduro | — (é infra) | `[TEST]` | Não | §8 |
| Interaction Framework | CORE | Pipeline completo, 2 tipos de alvo reais (`player`,`object`) | — (é infra) | 3 arquivos `[TEST]` | Não | §9 |
| Governance | LAB | Permissões, cargos, guarda IC | Sim | **Raso** — 48 linhas, só unicidade de comando `[CODE]` | Não | §10 |
| economy-regional | PARKED | Oferta/demanda por Hold | Sim, mas com vazamento conhecido | Nenhum teste próprio | Não | §13 |
| housing-service | PARKED | Contêiner, propriedade | Parcial — `buyProperty` ainda não migrado | Nenhum | Não | §13 |
| horse-service | PARKED | Cavalo persistente | Sim, com débito de transação | Nenhum | Não | §13 |

---

## 3. Profession Core — estado completo

**Arquivos:** `core/profession-registry.js` (237 l., catálogo puro) + `profession-service.js` (550 l., ciclo de vida). `[CODE]`

O registry declara três flags independentes por profissão: `registered`, `enabled`, `gameplayImplemented`. Citação literal do cabeçalho, linhas 27-33: **"Nenhuma das treze profissões desta fase tem [gameplayImplemented]... Registrar `miner` não significa que existe mineração."** `[CODE]`

O serviço expõe: `grantProfession`, `revokeProfession`, `suspendProfession`, `reactivateProfession`, `setProfessionRank`, `addProfessionXp`, `hasProfession`, `getProfessionState`, `getCharacterProfessions`. Limite por personagem e rank máximo vêm de `core/server-options.js` (`profession.maxPerCharacter`, `profession.maxRank`) — configuráveis, não hardcoded. `[CODE]`

Concorrência: concessão usa `SELECT ... FOR UPDATE` nas linhas ativas antes de contar contra o limite (linhas 44-51, 177-183) — mesmo padrão de lock usado em `resource-node-service.consume()` e `contracts-service`. `[CODE][TEST]`

XP negativo só é aceito com `staffCharacterId` presente (linha 445) — path administrativo auditável, não path de jogador. `[CODE]`

Persistência: tabela `character_professions` — `migration-v18-professions.sql`. `[MIGRATION]`

```sql
[MIGRATION] migration-v18-professions.sql
character_professions (
  id, character_id FK→characters ON DELETE CASCADE,
  profession_code VARCHAR(32), status VARCHAR(16) [active|suspended|revoked],
  rank TINYINT UNSIGNED, xp INT UNSIGNED,
  granted_by_character_id INT FK→characters ON DELETE SET NULL,
  joined_at, updated_at,
  UNIQUE(character_id, profession_code)
)
```

Não existe tabela `professions` — decisão deliberada, documentada no comentário da migration: o catálogo é fixo em código, não em dado. `[MIGRATION]`

### Tabela de profissões

| Profissão | Registered | Enabled | Gameplay real | Consumidores atuais |
|---|---|---|---|---|
| `miner` | sim | sim | **sim** — `mining-service.js`, `resource-node-service` | mining |
| `lumberjack` | sim | sim | não | nenhum |
| `hunter` | sim | sim | não | nenhum |
| `farmer` | sim | sim | não | nenhum |
| `smelter` | sim | sim | não | nenhum |
| `blacksmith` | sim | sim | não (crafting-service gate pronto, zero receita cadastrada) `[CODE]` `[DOC]` CRAFTING_SYSTEM.md §7 | crafting (potencial, não usado hoje) |
| `tanner` | sim | sim | não | nenhum |
| `enchanter` | sim | sim | não | nenhum |
| `cook` | sim | sim | não | nenhum |
| `stablehand` | sim | sim | não | nenhum |
| `innkeeper` | sim | sim | não | nenhum |
| `courier` | sim | sim | não | nenhum |
| `guard` | sim | sim | não (é etiqueta RP, ver §4) | nenhum sistema de poder |

`[CODE]` (`core/profession-registry.js`) — todas as 13 têm `registered: true, enabled: true`; nenhuma tem `gameplayImplemented: true` além do que `mining-service.js` chama por fora (o registry em si não marca `miner` como diferente das outras 12 — é o consumidor externo que faz a diferença real).

**Integração com staff:** 7 ações administrativas (`/setprofissao` etc.) sempre registradas em `admin-actions.js`, independentes da flag `ENABLE_PROFESSION_SERVICE` — a flag controla se `profession-service.js` **aceita executá-las** (`_professionModulePrecondition`) e se o comando de jogador `/profissoes` existe. `[CODE]` (comentário em `phase0-basic.js` linhas 222-227).

---

## 4. "Guard" — investigação dedicada

`guard` **existe** no Profession Registry como uma das 13 profissões, `registered: true, enabled: true`. `[CODE]`

O comentário do próprio arquivo, linha 209, responde a pergunta diretamente: **"Ocupação/RP. NÃO é a autoridade da guarda — essa é `governance-service.js`."** `[CODE]`

Comparação:

| | `profession-registry.guard` | `governance-service.js` |
|---|---|---|
| O que é | Rótulo RP no personagem (`character_professions.profession_code='guard'`) | Sistema de permissões nomeadas (`PERMISSIONS`), cargos, escopo, plantão |
| Concede poder de revistar/deter/prender/multar/confiscar? | **Não** — nenhuma checagem no `mining-service`, `market-stalls-service` ou em qualquer lugar consulta `hasProfession(...,'guard')` para autorizar ação de poder `[CODE]` (busca confirmada não achou nenhum consumidor de `guard`) | **Sim** — `PERMISSIONS` inclui `GUARD_ARREST`, `MANAGE_TREASURY`, `STALL_INSPECT` e ~27 outras, checadas via `admin.hasPermission`/`governance` em `market-stalls-service.js`, `governance-service.js` |
| Fonte de verdade | Nenhuma — não é consultado por ninguém hoje | `governance_memberships` + `DEFAULT_ROLES` |

**Veredito:** `guard` como profissão é hoje **puramente decorativo** — grava um rótulo, não desbloqueia nada. Os dois sistemas "não se falam" por design explícito no código. A fonte de verdade real para revistar/deter/prender/multar/confiscar é **exclusivamente** `governance-service.js` via permissões nomeadas, nunca a Profession. Isso é uma separação correta hoje, mas é frágil: nada no código impede que um consumidor futuro erre e cheque `hasProfession('guard')` em vez de `hasPermission('GUARD_ARREST')` — a única barreira é convenção, não tipo nem teste de regressão cruzando os dois módulos.

---

## 5. Resource Node Framework — estado completo

**Arquivos:** `core/resource-node-registry.js` (57 l., vocabulário) + `resource-node-service.js` (309 l., motor). `[CODE]`

O registry fecha **5 categorias**: `ORE`, `TREE`, `HERB`, `CROP`, `FISHING` — decisão explícita de não ter catálogo rico tipo Profession, porque "veio de ferro" e "veio de prata" são a mesma instância configurada diferente, não tipos distintos. `[CODE]`

```sql
[MIGRATION] migration-v19-resource-nodes.sql
resource_nodes (
  id, form_desc VARCHAR(64) UNIQUE, type VARCHAR(16), resource_base_id INT,
  yield_per_action INT, max_capacity INT, current_capacity INT, regen_per_hour INT,
  last_updated_at DATETIME(3),
  required_profession VARCHAR(32) NULL, required_rank TINYINT UNSIGNED NULL,
  enabled TINYINT(1), created_at
)
```

**O que existe** `[CODE][TEST]`:
- Capacidade **calculada sob demanda**, nunca por tick de background: `capacidade_atual = min(max_capacity, gravada + floor(ms_decorridos/3600000 * regen_per_hour))` — só `consume()` grava, `getNode()` é leitura pura.
- `consume()` atômico: `SELECT...FOR UPDATE` trava a linha do nó → valida `enabled`/profissão/rank → recalcula capacidade → decrementa OU marca `depleted` → `tx.applyInventoryDelta` + `tx.recordInventoryLedger` **na mesma transação** do decremento do nó.
- Gate por `required_profession`/`required_rank`, reaproveitando `profession-service.hasProfession`/`getProfessionState`.
- Concorrência: duas colheitas do mesmo nó serializam pelo lock de linha; a segunda sempre lê a capacidade já decrementada pela primeira — resolve o cenário "veio com 1 unidade, dois jogadores terminam quase juntos". `[CODE]` `[TEST]` confirma pela ordem de queries; **não** confirma sob carga MySQL real (ressalva explícita do próprio doc, §8 abaixo).

**O que não existe** `[DOC]` (`RESOURCE_NODE_FRAMEWORK.md` §1, §9) `[CODE]` confirma ausência:
- Nó ligado a objeto real do mundo com interação de jogador **fora** do caminho do Minerador especificamente.
- Sessão de coleta com duração/animação/cancelamento.
- Job/tick regenerando em background (deliberado — ver acima).
- Gate por ferramenta equipada (isso vive na camada `mining-service.js`, não aqui).
- Comando/UI de staff para criar nó em jogo — hoje só via script de seed.
- Fadiga (o projeto não tem sistema de fadiga).

**Cadeia real, confirmada no código (não presumida):**

```
[CODE, confirmado lendo mining-service.js + resource-node-service.js]
ResourceNode Core (capacidade/regen)
      ↓
Interaction Framework (alvo `object`, distância via assertRange)   ← só aqui há "World Interaction"
      ↓
mining-service.execute()  ← não existe "Gather Session" genérica; é específica do Minerador
      ↓
checagem de ferramenta (Actor.GetItemCount, client-trusted só p/ iniciar)
      ↓
resource-node-service.consume()
      ↓
core/transaction-service (tx.applyInventoryDelta + recordInventoryLedger, mesma transação)
      ↓
profession-service.addProfessionXp (fora da transação do nó — chamada separada, após sucesso)
```

A cadeia sugerida no pedido do usuário ("ResourceNode → World Interaction → Gather Session → Tool validation → consume() → Inventory → Profession XP") está **correta na ordem geral**, mas "Gather Session" **não é uma camada genérica reutilizável** — é lógica específica escrita dentro de `mining-service.js`. Um segundo consumidor (Lenhador, por exemplo) reescreveria essa camada do zero hoje, não a herdaria de graça. `[CODE]`, confirmado por não haver módulo intermediário entre `interaction-service` e `mining-service.js`.

---

## 6. Minerador — quão longe estamos de funcional

| | Estado | Evidência |
|---|---|---|
| Profissão (`miner`) | JÁ EXISTE | `[CODE][TEST]` |
| Resource Node (nó de minério) | JÁ EXISTE (motor genérico + seed manual) | `[CODE][TEST]` |
| Minério (item entregue) | JÁ EXISTE (via `resource_base_id` configurável por nó) | `[MIGRATION]` |
| Objeto real do Skyrim (alvo `object`) | JÁ EXISTE o resolvedor — **suposição não validada** | `[CODE]` cabeçalho `mining-service.js` l. 25-29: `mp.get(formId,'locationalData')` contra objeto comum é `[DOC]` da SkyMP, nunca chamado em jogo por este projeto |
| Distância | JÁ EXISTE (via `assertRange` do Interaction Framework) | `[CODE][TEST]` — mas depende do item acima ser verdade |
| Ferramenta (picareta) | JÁ EXISTE (`Actor.GetItemCount`) | `[CODE]` — client-trusted só para **iniciar**, não é fonte de verdade de posse |
| Animação | **FALTA** | não encontrado nenhum código de animação em `mining-service.js` |
| Cancelamento (desconexão/morte/movimento) | **FALTA** | não há sessão com estado — a ação é síncrona (query→resposta), não há "em progresso" para cancelar. Anti-spam existe (por `characterId`) mas não é a mesma coisa que cancelamento de sessão longa |
| Inventário | JÁ EXISTE | `[CODE][TEST]` via `resource-node-service.consume()` → transaction-service |
| XP | JÁ EXISTE | `[CODE][TEST]` |
| Regeneração | JÁ EXISTE | `[CODE][TEST]` |
| Concorrência (dois jogadores, mesmo nó) | JÁ EXISTE em teoria (lock de linha), **prova só por ordem de query em mock**, não por MySQL real sob carga | `[TEST]` com ressalva explícita no doc |
| UI/interação | JÁ EXISTE (menu de interação do Interaction Framework) | `[CODE][TEST]` |
| Teste multiplayer | **BLOCKER** — nunca rodou | `[DOC]` explícito em 3 lugares diferentes (cabeçalho do serviço, `MINING.md`, `RESOURCE_NODE_FRAMEWORK.md`) |

**BLOCKER único e nomeado:** a suposição sobre `mp.get(formId, 'locationalData')` em `MpObjectReference` comum (não `Actor`). Se ela for falsa, **toda a distância do Minerador está quebrada** e a mecânica inteira não funciona apesar de todos os testes passarem — porque o teste usa mock de `mp`, que aceita qualquer coisa (risco #1 do `CLAUDE.md` do projeto, "22 chamadas Papyrus com argumento errado passaram meses despercebidas"). `[CODE]` `[INFERENCE: risco herdado do padrão já documentado no CLAUDE.md do repositório]`

**RISCO adicional:** sem cancelamento de sessão nem animação, a experiência de jogo pode ser "instantânea" (clica, recebe item) — o que pode ou não ser aceitável para RP Estrito, mas é uma lacuna de design não decidida, não só técnica.

---

## 7. Lenhador / Fazendeiro / Caçador / Pescador

Nenhum dos quatro tem uma linha de código de gameplay. `[CODE]` confirmado por ausência total.

Análise de arquitetura, não de implementação, por profissão:

- **Lenhador** (`TREE`): mesma forma do Minerador — nó fixo no mundo, ferramenta (machado), objeto estático. **Pode reusar a cadeia do Minerador quase 1:1** — mesmo alvo `object`, mesma distância, mesma checagem de ferramenta trocando o item. `[INFERENCE]`
- **Fazendeiro** (`CROP`): categoria já existe no registry, mas colheita agrícola tipicamente tem uma dimensão que Minerador não tem — **plantio antes da colheita**, e possivelmente ciclo de crescimento por tempo. Isso é mais parecido com um segundo `regen_per_hour` (o campo já suporta), mas "plantar" é uma ação que não existe em nenhum lugar do framework atual — seria um `createNode` feito pelo próprio jogador, não pela staff via seed. **Não reusa 1:1** — precisa de decisão de design nova (quem pode plantar onde, o que acontece com o nó quando ninguém colhe). `[INFERENCE]`
- **Caçador** (`HERB`?? — na verdade não há categoria `ANIMAL`/`FAUNA` no registry de 5 categorias `ORE/TREE/HERB/CROP/FISHING`): **gap de categoria**. Caça envolve um alvo que se move e pode morrer — fundamentalmente diferente de um nó estático que "regenera". O paralelo mais próximo no projeto não é Resource Node, é `fauna-census.js` (LAB, instrumento de observação, não mecânica) — que o próprio `module-registry.js` documenta como "não são mecânica e não viram mecânica" (linha 437-438). **Não reusa a arquitetura de Resource Node como está** — precisaria de um framework de "criatura como alvo" separado. `[CODE]` `[INFERENCE]`
- **Pescador** (`FISHING`): categoria existe no registry. Pesca tradicionalmente é mini-jogo ou nó de água — se for tratado como nó estático (um ponto de pesca), reusa a cadeia do Minerador quase igual ao Lenhador. `[INFERENCE]`

**Conclusão do item 14 do pedido:** não force todos a usar o mesmo mecanismo. Minerador/Lenhador/Pescador (nó estático) são uma família; Fazendeiro (nó com ciclo + plantio) é outra; Caçador (alvo móvel) é uma terceira que hoje **não tem framework nenhum**, nem esboço.

---

## 8. Crafting-service — estado completo

**Arquivo:** `crafting-service.js`, 398 l. Reativado no commit `2ee7788` (hoje). `[CODE][GIT HISTORY]`

Exports: `listRecipes`, `craftItem`, `addRecipe`, `addIngredient`, `commandDefs()` (`/craft`, `/receitas`, `/addrecipe`, `/addingredient`). `[CODE]`

**Atomicidade — histórico e estado atual:** até `13/08/2026` o cabeçalho **afirmava** validar proximidade e perk, mas nenhuma das duas era verdade — citação literal, linhas 9-20: **"Proximidade de estação: nunca... Perk: nunca — `requires_perk` é lido em `listRecipes` e nunca comparado com nada."** Isso é um caso confirmado exatamente do padrão de risco #3 do `CLAUDE.md` do projeto (documentação mentindo sobre o que o código faz). `[CODE]` cita a própria correção.

Hoje (`[CODE]` linhas 118-125): a checagem real é só "a estação declarada bate com `recipe.station_type`" — **isso não é proximidade física**, é comparação de string. Consumo/entrega usa `core/inventory.exchange` numa transação só. `[CODE]`

Gate de profissão/rank (adicionado hoje, `[MIGRATION]` `migration-v20-crafting-profession-gate.sql`):
```sql
ALTER TABLE crafting_recipes
  ADD COLUMN required_profession VARCHAR(32) DEFAULT NULL,
  ADD COLUMN required_rank TINYINT UNSIGNED DEFAULT NULL;
```
Checado de verdade dentro de `craftItem()` (linhas 137-158). `requires_perk` **continua sem uso** — não é o campo que este gate lê (linha 37, comentário explícito). `[CODE]`

**Testes: ZERO.** Confirmado por busca no disco — não há `crafting-service.test.js`, e o script `test` do `package.json` **não** o lista. `CRAFTING_SYSTEM.md` §8 cita cobertura indireta via `parked-services-ledger.test.js`, o que **não é o mesmo** que testar `craftItem()` diretamente. `[CODE]` `[CONFIG]`

**Resposta à pergunta do pedido — "pode ser a base para Ferreiro/Cozinheiro/Alquimista/Alfaiate/Encantador?":**
- **Sim, estruturalmente** — o mecanismo (receita, ingrediente, estação por nome, gate de profissão/rank, transação atômica) é genérico o bastante para as 5 profissões de crafting. `[CODE]` confirma que nada no `craftItem()` é hardcoded para uma profissão específica.
- **Não, no estado de dados** — zero receitas cadastradas hoje para `blacksmith` (confirmado em `CRAFTING_SYSTEM.md` §7: "nenhuma receita de FORJAR arma/armadura existe"). O framework existe; o conteúdo não. `[DOC]`
- **Gap real de proximidade** — "estação por nome" não é o mesmo que "estação como objeto no mundo com distância real". Um crafting completo precisaria do mesmo resolvedor `object` que o Minerador usa, hoje não conectado a `crafting-service.js`. `[CODE]` confirma que `crafting-service.js` não importa `interaction-registry`/`interaction-targets`.

---

## 9. jobs-service — estado completo

**Arquivo:** `jobs-service.js`, 284 l. Reativado no commit `99c125c` (ontem/hoje). `[CODE][GIT HISTORY]`

### O que ele foi criado para fazer

Cabeçalho, linha 3: **"Trabalho livre — sem profissão fixa, qualquer personagem carregado pode fazer."** `[CODE]`

### Verbos que possui

`chopWood`, `mineOre`, `catchFish` — três funções, cada uma um "job" completo (não há catálogo de jobs, não há tabela `jobs`; são três funções JS hardcoded). `[CODE]`

### Como começa/valida/entrega

Não há sessão nem validação de conclusão distinta do Minerador — é uma chamada síncrona: personagem executa comando → função roda → item entregue. Não checa distância de nó nem objeto real do mundo (ao contrário do Minerador). `[CODE]`

### Usa o quê

| Pergunta do pedido | Resposta | Evidência |
|---|---|---|
| Usa Papyrus diretamente? | **Não mais** — usava até a correção documentada no próprio cabeçalho (ver abaixo) | `[CODE]` `[GIT HISTORY]` |
| Usa MariaDB? | Sim, via `transactionService.giveItem` | `[CODE]` |
| Usa Inventory Framework? | Indiretamente — `transactionService.giveItem`, não `core/inventory.js` direto | `[CODE]` |
| Usa Economy Framework? | Não movimenta ouro | `[CODE]` |
| Usa Profession Framework? | **Não** — nenhuma checagem de `hasProfession`/rank | `[CODE]`, confirmado por ausência de `require('./profession-service')` |
| Usa Resource Node? | **Não** — não consulta `resource-node-service` nem `resource_nodes` | `[CODE]` |
| Usa Interaction Framework? | **Não** — os 3 comandos são `/cortarlenha`, `/garimpar`, `/pescar`, chat direto, sem `interaction-registry` | `[CODE]` |
| Possui cooldown? | Não encontrado no arquivo lido | `[CODE]` — ausência confirmada |
| Possui XP? | Não | `[CODE]` |
| Possui profissão própria? | Não | `[CODE]` |
| Registrado no Module Registry? | Sim, `id: 'jobs'`, `enabledBy: 'ENABLE_JOBS_SERVICE'`, `phase: 'lab'` | `[CONFIG]` |
| Está PARKED? | **Não mais** — foi PARKED, reativado hoje | `[GIT HISTORY]` `[CONFIG]` |

### Defeito histórico (por que ficou PARKED)

`PARKED_SERVICES_DECISION.md` §7.3, citação: **"o mais grave dos três"** — entregava item via `AddItem` do Papyrus **direto no ator**, contornando `inventory-service` e `core/transaction-service` inteiros. O item existia só no cliente até sincronizar; **nunca existia no banco nem no ledger.** `[DOC]` confirmado pelo próprio cabeçalho atual do arquivo, que descreve a correção nas linhas 13-24. `[CODE]`

Correção aplicada (`b49d1a7`, `[GIT HISTORY]`): passou a usar `transactionService.giveItem`.

### Pendência documentada, não resolvida

Cabeçalho, linhas 31-36: **"`Math.random()` decide quantidade e raridade"** — não determinístico, "produção de recurso irreproduzível é um problema de economia por si só", registrado e não resolvido. `[CODE]`

Não checa profissão nem rank — "deliberadamente mais fraco que a mineração via `mining-service`" (linha 251). `[CODE]`

### História (git)

```
[GIT HISTORY] git log --all -- jobs-service.js
82625d2  feat(phase1): implement npc cleaner, death hook and chopwood job         (origem)
a97e9bf  feat: Implementação de jobs (Pesca/Mineração), orquestração de serviços   (expande p/ 3 jobs)
44b678c  fix(gamemode): padroniza chamadas Papyrus e absorve pesquisa do upstream  (ainda Papyrus-direto)
3ea6473  refactor(gamemode): fecha os residuos da forma antiga de chamada Papyrus
b49d1a7  refactor(gamemode): crafting e jobs passam a mexer em item pelo transaction-service  (CORREÇÃO — sai do AddItem Papyrus)
99c125c  feat(trabalhos): reativa jobs-service e contracts-service como modulos lab (REATIVAÇÃO, hoje)
```

Não há, na história do arquivo, nenhum commit que registre explicitamente "isto vira PARKED" — a decisão de estacionar está registrada em `PARKED_SERVICES_DECISION.md`, não em um commit de código dedicado; a correção do bug (`b49d1a7`) e o "estacionamento" parecem ter sido decisões documentais separadas do trabalho de código. `[INFERENCE]`

---

## 10. Governance / Employment — estado relevante

`governance-service.js`, 1356 l. `PERMISSIONS` com 30+ capabilities nomeadas (`GUARD_ARREST`, `MANAGE_TREASURY`, `STALL_INSPECT`, etc.) e `DEFAULT_ROLES`. `[CODE]`

Não existe conceito de "Employment" (personagem trabalha PARA uma organização com contrato formal) em lugar nenhum do código — o que existe é **Membership** (`governance_memberships`), que é participação política/de facção, não relação de emprego. `[CODE]` confirmado por ausência de tabela ou serviço equivalente a "employment"/"employer".

O ouro de multa passou a usar `core/economy-service.js` direto (migração de 13/08/2026, ADR 004 §2.3) — não há mais caminho de multa passando por `transaction-service` cru. `[CODE][DOC]`

Teste: 48 linhas, só unicidade de `commandDefs()` — o comentário do próprio arquivo (linhas 23-45) documenta que 5 testes de interação legada foram removidos porque a cobertura migrou para `core/interaction-service.test.js`. `[CODE][TEST]`

---

## 11. Contracts — estado completo

**Arquivo:** `contracts-service.js`, 832 l. Reativado hoje (`99c125c`). `[CODE][GIT HISTORY]`

Máquina de estados: `open → accepted → delivered → settled/disputed`, saídas `cancelled`/`expired`. Exports: `create`, `accept`, `deliver`, `dispute`, `settle`, `cancel`, `expire`, `sweepExpired`, `sweepReviewed`, `listOpen`, `getContract`, `history`. `[CODE]`

**Integração confirmada:**
| Com | Confirmado? | Evidência |
|---|---|---|
| Economy escrow | **Sim** — `core/economy-service.openEscrowInTransaction`/`closeEscrowInTransaction` | `[CODE]` |
| Inventory | Não diretamente — o contrato move ouro (escrow), não item, na leitura feita | `[CODE]` — sem `require('./core/inventory')` no arquivo |
| Jobs | Não | `[CODE]` — sem referência cruzada |
| Profession | Não | `[CODE]` — sem referência cruzada |
| Government | Não diretamente, mas usa o mesmo `PERMISSIONS`/`admin-service` para staff | `[INFERENCE]` a partir do padrão comum do projeto |

Escrow trava no `create` — "criação inteira é fail-closed" (linhas 40-42). `disputed` é terminal para automação: **"consequência irreversível não se automatiza"** (linhas 46-47). `[CODE]`

Cabeçalho, linhas 12-13: **"Nada aqui foi visto num servidor com gente dentro até 20/08/2026."** `[CODE]`

**Teste:** 512 linhas, banco em memória, testa efeito real (escrow no post, ninguém recebe duas vezes, `disputed` não move dinheiro). É o teste mais robusto de todo este domínio. `[TEST]`

**Inconsistência de doc encontrada:** `CONTRACTS.md` §9 ainda diz "Não há comando de chat nem painel" — contradiz o próprio topo do mesmo arquivo, que afirma 8 comandos adicionados em 20/08/2026. Parece trecho não atualizado após a reativação de hoje. `[DOC]` — sinalizado, não corrigido (fora do escopo desta auditoria).

Relevância futura citada pelo usuário (procurement, delivery, crafting orders, caravanas, employment): a máquina de estados é genérica o bastante para servir de base a essas coisas — mas hoje ela só move **ouro via escrow**, não item nem obrigação de serviço estruturada. `[INFERENCE]`

---

## 12. Businesses / Trade — estado relevante

**`market-stalls-service.js`** (1408 l., o maior arquivo do domínio): loja de jogador — monta banca, lista item (some do inventário, vira estoque da banca), compra com imposto, fiscalização/confisco pela guarda. `[CODE]`

**`trade-service.js`** (576 l.): troca P2P entre dois jogadores, versão de oferta invalida confirmação, ouro na troca **"possível e não feito"** (linha 37, `core/inventory.js` não expõe primitiva de ouro dentro da mesma transação de item). `[CODE]`

**Não existe** doc `MARKET_STALLS.md` dedicado em `docs/gameplay/` — confirmado por grep (`docs/gameplay/CONTRACTS.md:190` é a única menção, de passagem). `[CODE]`

**Pergunta do pedido — "modelo atual suporta Cozinheiro+dono-de-taverna sem misturar profissão com propriedade do negócio?":**

Hoje **não há conceito de "negócio" como entidade** no código — `market-stalls-service.js` é uma banca individual amarrada a um personagem, não uma empresa com dono/funcionários. `housing-service.js` (PARKED) tem `buyProperty`, que é posse de imóvel, não de negócio. Não há tabela nem serviço que represente "esta taverna pertence a este personagem e tem N funcionários". **Profession** (`cook`) e **posse de propriedade** (`housing`, PARKED) já são, coincidentemente, dois sistemas separados hoje — o que é bom sinal para não misturar — mas nenhum dos dois **fala com o outro**, então a combinação pedida (Cozinheiro trabalha numa taverna que outro personagem possui) não tem nenhuma modelagem hoje, nem os dados para representá-la. `[CODE]` `[INFERENCE]`

---

## 13. PARKED modules — motivos e reaproveitamento

| Módulo | Por que ficou PARKED | O motivo ainda existe? | Parte reaproveitável | Framework que o supersede |
|---|---|---|---|---|
| `economy-regional.js` | Nunca foi apagado — `PARKED_SERVICES_DECISION.md` §5 chama de "o único com desenho ainda válido". Ficou fora por causa de 2 achados da 3ª varredura (§7.6): `characterHold` (Map em memória que cresce e nunca encolhe) e `withdrawHoldTreasury` com 2 `UPDATE` sem transação | **Parcialmente** — a versão atual do arquivo já usa `institutionalTreasury.transferHoldTreasury` com `governance.getMembership(...,conn)` dentro de transação, o que sugere que o segundo achado foi corrigido depois de `PARKED_SERVICES_DECISION.md` ser escrito; **não confirmei em teste dedicado** se isso ainda vale — sinalizado como pendência de verificação, não decisão | Modelo de oferta/demanda por Hold, spread punitivo em NPC | Nenhum — é o único módulo econômico deste tipo |
| `housing-service.js` | `depositItem` fazia `removeItem()` + 2 `db.query` soltos sem transação — corrigido via `core/inventory.transfer` em 13/08/2026. **Mas continua PARKED por decisão deliberada**, mesmo migrado: cabeçalho, linha 17: "Migrar não é reativar" | **Parcialmente** — `buyProperty` (linhas 260-278) ainda tem o padrão antigo (ouro isolado + `UPDATE` solto), confirmado por `ECONOMY_FRAMEWORK.md` §10 "Achado 9" como pendente | `openContainer`/`depositItem`/`withdrawItem` (já no padrão novo) | `core/inventory.js` já cobre o lado de item; falta portar `buyProperty` para `core/economy-service` |
| `horse-service.js` | Não tem cabeçalho "PARKED" explícito no arquivo, mas confirmado fora do registry | Sim — `buyHorse` (linhas 151-178) ainda faz `removeGold`+`addGold` em duas chamadas separadas, mesmo achado 9 do `ECONOMY_FRAMEWORK.md` §10 | Lógica de nomeação/chamado/venda de cavalo | `core/economy-service.transferInTransaction` resolveria o `buyHorse` |

**Apagados (não há mais código para reaproveitar, só a decisão registrada):** `economy-service.js` antigo (substituído por `core/transaction-service.js` + `core/economy-service.js` novo), `justice-service` (substituído por `governance-service`), `faction-service` (facção virou escopo de `governance_memberships`), `survival-service` (mexia em `ActorValue` que `death-service` já lê — depende de `death-service` estar validado antes de voltar), `disguise-service` (segunda autoridade sobre nome, com chave errada — `identity-service` já cobre isso melhor). `[DOC]` `PARKED_SERVICES_DECISION.md`

---

## 14. Taxonomia atual × taxonomia desejada

| Conceito desejado | Onde está hoje | Problema |
|---|---|---|
| **Profissão** (conhecimento de longo prazo, XP, rank) | `profession-service.js` + `core/profession-registry.js` — existe de verdade, com XP/rank/persistência | Nenhum — este conceito **está bem modelado**. `[CODE]` |
| **Especialização** (ramo dentro de uma profissão, ex. Ferreiro→Armeiro) | **Não existe.** `profession-registry.js` é uma lista fechada de 13 rótulos planos, sem hierarquia nem sub-rank por ramo | Um "Armeiro" hoje só poderia ser modelado criando `blacksmith_weaponsmith` como 14ª profissão plana — não há relação pai/filho no schema (`character_professions.profession_code` é `VARCHAR(32)` sem FK para uma tabela de árvore) `[MIGRATION]` |
| **Emprego** (relação com organização/empregador) | **Não existe.** `governance_memberships` é participação política/facção, não contrato de trabalho | Sem tabela nem serviço equivalente a "personagem X é funcionário da organização Y, remunerado por Z" `[CODE]` confirmado por ausência |
| **Cargo** (posição hierárquica numa organização) | Parcialmente — `governance_memberships` + `DEFAULT_ROLES` tem cargo dentro de **governança política** (Recruta/Guarda/Sargento equivalentes existem como conceito de facção), mas não para negócios privados | Cargo hoje só existe no domínio de governança/facção, não no de emprego privado (ex. "Mestre da Forja" numa ferraria de jogador não tem onde morar) `[CODE]` |
| **Negócio / Atividade Econômica** (jogador possui/administra) | Parcialmente — `market-stalls-service.js` (banca individual) e `housing-service.js` PARKED (`buyProperty`) tocam o tema separadamente, mas não há entidade "negócio" com dono+funcionários+local | Banca de mercado é do personagem, não de um "negócio" com identidade própria; taverna/ferraria como entidade não existe |
| **Public Work / Trabalho Livre** | `jobs-service.js` — mas é 3 funções hardcoded, sem catálogo, sem estrutura, sem cooldown, sem XP, sem tabela dedicada | Não modela "categoria de trabalho livre" como conceito — é código imperativo, não dado |
| **Atividade Ilegal** (emergente, não rótulo) | **Não existe nenhum mecanismo hoje** — nem para emergir nem para impedir | Não há como avaliar "problema" porque não há tentativa de implementação a criticar; é gap puro |

### MODELO ATUAL — resposta à pergunta central do item 6

**MODELO ATUAL:** o código distingue **apenas dois conceitos**, e são ortogonais entre si, não uma hierarquia: **Profession** (rótulo de longo prazo com XP/rank, tratando `miner`, `blacksmith`, `innkeeper`, `courier` e `guard` todos como a mesma "forma" de coisa) e **Jobs** (verbos soltos de trabalho livre, sem rótulo nenhum, e hoje limitados a 3: cortar lenha, minerar, pescar). Não existe `job = miner`/`job = guard`/`job = tavernkeeper` no sentido que o usuário temia — **os dois sistemas já são fisicamente separados no código** (arquivos diferentes, tabelas diferentes) — mas **dentro de** Profession, as 13 entradas misturam categorias conceitualmente distintas sob o mesmo formato: `miner`/`lumberjack`/`hunter` são profissões-ofício reais; `guard` é etiqueta RP sem poder; `innkeeper`/`stablehand` são mais "papel em um negócio" que "ofício"; `courier` é mais "trabalho de entrega" que ofício de longo prazo. `[CODE]`

**PROBLEMA:** o `profession_code` é um `VARCHAR(32)` plano — o schema não tem coluna nem tabela que diga "isto é ofício", "isto é papel-em-negócio", "isto é cargo institucional". Um consumidor futuro que precise diferenciar (por exemplo, dar XP e rank real só para ofícios, mas não para `guard`) tem que **hardcodar a lista** em vez de consultar um campo. `[CODE]`

**IMPACTO:** baixo hoje (só `miner` tem consumidor), mas cresce a cada profissão que ganhar gameplay — se Emprego/Cargo/Negócio forem construídos futuramente reaproveitando `character_professions` por conveniência (em vez de tabelas próprias), a mistura vira dívida real, porque a tabela não tem os campos que essas outras categorias precisam (empregador, local do negócio, cargo dentro de organização).

**CAMINHO POSSÍVEL** (não decisão, só o que o código sugere como natural): `character_professions` continua servindo só ao conceito "Profissão" (ofício, XP, rank) tal como está — está bem desenhado para isso. Emprego/Cargo/Negócio pedem **tabelas e serviços próprios**, no padrão já estabelecido pelo projeto (ver `institutional-treasury-service.js` como exemplo de "não force uma coisa nova a caber num serviço existente que tem semântica diferente" — comentário do próprio arquivo: "ouro de Hold... não deve usar `gold_transactions`... cria sua própria fronteira"). `[INFERENCE, mas ancorada num padrão já usado no próprio código]`

---

## 15. Duplicações arquiteturais

| Conflito | Classificação | Evidência |
|---|---|---|
| `jobs.mineOre` vs `mining-service` (via Minerador) | **IMPORTANT** — dois caminhos para "minerar" com regras diferentes: um checa profissão/nó/distância/ferramenta (`mining-service`), o outro não checa nada disso e usa `Math.random()` (`jobs-service.mineOre`) | `[CODE]` confirmado — ambos existem simultaneamente e ambos podem estar `ENABLE_*=true` ao mesmo tempo, sem exclusão mútua declarada em `module-registry` |
| `profession.guard` vs `governance` | **NONE hoje** (não se falam, por design), mas **CRITICAL como risco latente** — nada impede um consumidor futuro de checar a fonte errada | `[CODE]` §4 |
| `crafting` (`core/inventory.exchange`) vs Inventory Framework | **NONE** — `crafting-service.js` já usa a API central corretamente | `[CODE]` |
| Papyrus inventory vs MariaDB inventory | **RESOLVIDO no jobs-service atual** (era CRITICAL, virou NONE após `b49d1a7`); **ainda MINOR/IMPORTANT em `housing.buyProperty` e `horse-service.buyHorse`** — ambos PARKED, ambos com débito de transação de ouro (não de item Papyrus, mas o mesmo padrão de "duas escritas sem atomicidade") | `[CODE]` `ECONOMY_FRAMEWORK.md` §10 Achado 9 |
| `jobs reward` vs `economy` | **NONE** — jobs não movimenta ouro, só item, via `transactionService.giveItem` | `[CODE]` |
| Duas listas de profissões possíveis (Minerador oficial via `mining-service` + trabalho livre via `jobs.mineOre`) | Já contado acima — mesma linha | — |

---

## 16. Dívida técnica

1. **Zero cobertura de teste em `crafting-service.js` e `jobs-service.js`**, os dois módulos mais recentemente reativados neste domínio. Todo outro sistema comparável (`contracts`, `trade`, `mining`, `profession`, `resource-node`) tem teste dedicado; estes dois não têm nenhum. `[CODE]` confirmado por busca.
2. **`requires_perk` em `crafting_recipes` é campo morto** — lido, nunca comparado, desde a criação da coluna original até hoje (o gate novo de 20/08 usa `required_profession`/`required_rank`, colunas diferentes). `[CODE]`
3. **`jobs-service` usa `Math.random()` não-determinístico e não-auditável** para quantidade/raridade — registrado no próprio cabeçalho como pendência não resolvida. `[CODE]`
4. **`market-stalls-service.js` (1408 linhas) tem teste raso** — 156 linhas cobrindo só unicidade de comando e toggle de init/shutdown, não o fluxo de compra/venda/confisco que é o corpo real do arquivo. `[CODE][TEST]`
5. **`governance-service.js` (1356 linhas) também tem teste raso** — 48 linhas, mesma limitação, com nota própria explicando que a cobertura "migrou" para outro arquivo (parcialmente verdade, mas não cobre a lógica de negócio de permissões/cargos em si).
6. **`buyProperty` (housing, PARKED) e `buyHorse` (horse-service, PARKED)** continuam com o padrão de duas escritas sem transação — Achado 9 do `ECONOMY_FRAMEWORK.md`, nunca corrigido porque os módulos estão parados.
7. **Falta de "Gather Session" genérica** — a lógica de sessão de coleta vive dentro de `mining-service.js`, não é reaproveitável por um segundo consumidor sem duplicação.

---

## 17. Riscos de segurança/economia (por módulo, sem correção — só identificação, item 27)

| Módulo | Risco | Estado |
|---|---|---|
| `mining-service.js` | **Fake location** — depende inteiramente da suposição não validada de `locationalData`; se o cliente puder influenciar o valor lido, a distância inteira é forjável | Não avaliado em jogo — risco aberto, não mitigado nem descartado `[CODE][DOC]` |
| `mining-service.js` | **Fake tool** — `Actor.GetItemCount` é lido do cliente; o próprio comentário do código já assume isso como "client-trusted só para decidir se a ação COMEÇA" (linha 104), ou seja, o servidor não valida de novo depois — se isso for a única barreira, é potencialmente contornável | Mitigação parcial reconhecida no próprio código; não testado contra spoofing real |
| `jobs-service.js` | **XP farming / reward duplication** — sem cooldown identificado no arquivo, sem checagem de posição no mundo (não usa Interaction Framework), item entregue por comando de chat repetível | Nenhuma mitigação encontrada além do `Math.random()` reduzir previsibilidade — que não é proteção contra repetição |
| `resource-node-service.consume()` | **Race condition / duplicação** | **Mitigado** — lock de linha (`SELECT...FOR UPDATE`) confirmado por teste de ordem de query `[TEST]`; não confirmado sob concorrência real de MySQL |
| `contracts-service.js` | **Double-settle / gold duplication** | **Mitigado** — testado explicitamente ("ninguém recebe duas vezes") `[TEST]` |
| `trade-service.js` | **Replay/double-click em confirmação de troca** | **Mitigado** — versão de oferta invalida confirmação anterior, testado `[TEST]` |
| `crafting-service.js` | **Cooldown bypass / disconnect durante craft** | Não avaliado — sem teste, sem sessão de craft com estado, então não há "durante" para interromper (execução é síncrona) — reduz superfície mas não prova ausência de exploit em outro eixo |
| `market-stalls-service.js` | **Duplicate reward / race em compra concorrente** | Não avaliado — teste não cobre este caminho `[TEST]` confirma lacuna |
| Todos os módulos LAB deste domínio | **Nunca observados sob carga real ou multiplayer** | Risco sistêmico compartilhado — mocks de `mp` aceitam qualquer coisa, conforme já documentado no `CLAUDE.md` do projeto |

---

## 18. Gaps para gameplay real

- Validação em jogo de `locationalData` contra objeto comum (bloqueador do Minerador e de qualquer coleta baseada em nó).
- Sessão de coleta genérica (duração, animação, cancelamento) — hoje só existe execução síncrona.
- Categoria de alvo "criatura móvel" para Caçador — Resource Node não serve para isso.
- Framework de "plantio" para Fazendeiro.
- Receitas reais de crafting cadastradas (framework existe, conteúdo não).
- Proximidade real de estação de crafting (hoje é comparação de string, não distância).
- Conceito de Emprego/Cargo/Negócio — não existe nem como esboço de schema.
- Ouro dentro de `trade-service` (item já reconhecido, não feito).
- `characterHold` sem vazamento em `economy-regional.js` (achado antigo, status de correção não confirmado nesta rodada).

---

## 19. Reuse Matrix

| Parte | Decisão | Motivo |
|---|---|---|
| `profession-service.js` / `profession-registry.js` | **KEEP** | Bem desenhado, testado, sem dívida conhecida |
| `resource-node-service.js` / `registry` | **KEEP** | Idem — motor genérico correto |
| `mining-service.js` | **KEEP**, com **EXTEND** pendente (validação em jogo) | Único fim-a-fim; falta só a prova de campo |
| `core/transaction-service.js`, `core/economy-service.js`, `core/inventory.js` | **KEEP** | Infra madura, correta, é a fundação que tudo mais deve usar |
| `contracts-service.js` | **KEEP** | Bem testado, escrow correto |
| `trade-service.js` | **KEEP**, **EXTEND** (ouro) | Correto no que faz; falta escopo |
| `crafting-service.js` (motor) | **KEEP** | Gate e transação corretos hoje |
| `crafting-service.js` (conteúdo/receitas) | **DO NOT BUILD ainda** — depende da decisão de taxonomia (§14) antes de cadastrar receita de Ferreiro/Cozinheiro em massa | Evita content debt sobre um modelo que pode mudar |
| `jobs-service.js` (as 3 funções atuais) | **ADAPT** — o mecanismo de entrega (via `transactionService.giveItem`) está correto; a ausência de estrutura, cooldown e determinismo pede redesenho antes de virar Public Work oficial | Ver §9 e resposta obrigatória #3 abaixo |
| `jobs-service.js` catálogo/comandos | **MIGRATE** para uma futura camada Public Work, se essa camada nascer, em vez de crescer dentro do arquivo atual | Evita que "trabalho livre" vire um segundo lugar de verdade concorrente com Profession |
| `market-stalls-service.js` | **KEEP**, teste **EXTEND** obrigatório antes de qualquer mudança | Lógica de negócio grande e não testada é risco, não só dívida |
| `governance-service.js` | **KEEP**, teste **EXTEND** | Idem |
| `economy-regional.js` (PARKED) | **REACTIVATE CANDIDATE**, condicional a confirmar se o achado do Map crescente foi corrigido | Único PARKED com "desenho ainda válido" segundo a própria decisão histórica |
| `housing-service.js` (PARKED) | **ADAPT** antes de reativar (`buyProperty` precisa migrar para `core/economy-service`) | Resto já está no padrão novo |
| `horse-service.js` (PARKED) | **ADAPT** antes de reativar (`buyHorse` precisa de transação atômica) | Mesmo padrão de débito que housing |
| Conceito "Employment/Cargo/Negócio" | **DO NOT BUILD ainda** — não existe nem desenho | É a pergunta de arquitetura em aberto mais cara, não deveria nascer dentro de um sistema existente |
| `disguise-service`, `justice-service`, `faction-service`, `survival-service`, `economy-service` antigo | **REMOVE** — já removidos, decisão ratificada, nada a reconsiderar aqui | `PARKED_SERVICES_DECISION.md` |

---

## Mapa de relacionamento (estado real, não aspiracional)

```
[CODE, confirmado por leitura direta de imports/requires]

Profession Core (grant/revoke/rank/XP)
   │
   ├─consultado por→ Resource Node (gate required_profession/rank)
   │                      │
   │                      └─consumido por→ mining-service (único consumidor real)
   │                                            │
   │                                            └─usa→ Interaction Framework (alvo `object`)
   │                                            └─usa→ core/transaction-service (tx.applyInventoryDelta)
   │
   ├─consultado por→ crafting-service (gate required_profession/rank, v20)
   │                      └─usa→ core/inventory.exchange (não tx.* diretamente)
   │
   └─NÃO consultado por→ governance-service (guard não fala com governança — decisão deliberada)

jobs-service (paralelo, independente)
   │
   └─usa→ transactionService.giveItem (não usa Profession, Resource Node, nem Interaction)

contracts-service (paralelo, independente)
   │
   └─usa→ core/economy-service (openEscrowInTransaction/closeEscrowInTransaction)

trade-service (paralelo, independente)
   │
   ├─usa→ Interaction Framework (alvo `player`)
   └─usa→ core/inventory.exchange

market-stalls-service (paralelo, independente)
   │
   ├─usa→ governance-service (permissões STALL_INSPECT etc.)
   ├─usa→ core/economy-service + core/transaction-service
   └─usa→ Interaction Framework

governance-service
   │
   └─usa→ core/economy-service (multa, migrado 13/08)
   └─usa→ debt-service

Interaction Framework (core, sem gameplay)
   │
   └─servido por→ interaction-registry + interaction-service + interaction-targets
       (2 tipos de alvo reais hoje: `player`, `object`)

core/economy-service ←── porta única de ouro ──→ core/transaction-service (motor)
core/inventory.js    ←── porta única de item ──→ core/transaction-service (tx.* primitives)
```

**Achado do mapa:** não existe hoje nenhuma aresta entre `jobs-service`/`contracts-service`/`trade-service` e `Profession Core` ou `Resource Node` — os três "trabalhos" (livre, contrato, troca) são domínios **paralelos e desconectados** de "profissão"/"coleta". Isso confirma, por grafo de dependência real (não por leitura de doc), que o projeto hoje tem **dois universos separados**: (1) Profissão→Recurso→Minerador, e (2) tudo o mais (jobs/contracts/trade/market-stalls), que giram em torno de Economy/Inventory mas não de Profession. `[CODE]`

---

## 20. Dependency Map (module-registry, completo)

| Módulo | Fase | Flag | Dependências | Estado hoje |
|---|---|---|---|---|
| `interaction` | core | `ENABLE_INTERACTION_FRAMEWORK` | — | DISABLED (flag false) |
| `npc-cleaner` | core | `ENABLE_NPC_CLEANER` | — | DISABLED |
| `death` | lab | `ENABLE_DEATH_SERVICE` | — | DISABLED |
| `governance` | lab | `ENABLE_GOVERNANCE_SERVICE` | `interaction` (obrig.), `economy-regional` (opcional) | DISABLED |
| `profession` | lab | `ENABLE_PROFESSION_SERVICE` | — | DISABLED |
| `mining` | lab | `ENABLE_MINING_SERVICE` | `profession`, `interaction` | DISABLED |
| `market-stalls` | lab | `ENABLE_MARKET_STALLS_SERVICE` | `governance`, `interaction` | DISABLED |
| `player-panel` | lab | `ENABLE_PLAYER_PANEL_SERVICE` | `governance` | DISABLED |
| `soul` | lab | `ENABLE_SOUL_SERVICE` | — | DISABLED |
| `voip` | lab | `ENABLE_VOIP_SERVICE` | — | DISABLED |
| `nametag` | lab | `ENABLE_NAMETAG_SERVICE` | — | DISABLED |
| `fauna-census` | lab | `ENABLE_FAUNA_CENSUS` | — | DISABLED |
| `corpse-probe` | lab | `ENABLE_CORPSE_PROBE` | — | DISABLED |
| `trade` | lab | `ENABLE_TRADE_SERVICE` | `interaction` | DISABLED |
| `jobs` | lab | `ENABLE_JOBS_SERVICE` | — | DISABLED |
| `contracts` | lab | `ENABLE_CONTRACTS_SERVICE` | — | DISABLED |
| `crafting` | lab | `ENABLE_CRAFTING_SERVICE` | — | DISABLED |
| `economy-regional` | — | — | — | **NÃO REGISTRADO** (parked) |
| `housing` | — | — | — | **NÃO REGISTRADO** (parked) |
| `horse` | — | — | — | **NÃO REGISTRADO** (parked) |

**Observação estrutural:** `mining` depende de `profession` — a única dependência de módulo cruzando o domínio deste relatório. Nenhum outro módulo listado (`jobs`, `contracts`, `crafting`, `trade`, `market-stalls`) declara `profession` como dependência, confirmando de novo o achado do mapa acima. `[CONFIG]`

---

## 21. Ordem recomendada de análise posterior (não implementação)

Derivada do estado real, não de preferência estética — cada item resolve um bloqueador do próximo:

1. **Fechar o modelo Profissão × Especialização × Emprego × Cargo × Negócio × Public Work** (§14) — toda decisão de schema abaixo depende disso; adiar isso e cadastrar receitas/jobs mesmo assim é acumular dívida sobre uma taxonomia que ainda pode mudar.
2. **Decidir o destino do `jobs-service`** (resposta obrigatória #3) — ele é o único módulo cuja identidade está em disputa (ofício fraco? Public Work? entra em §1?).
3. **Validar em jogo a suposição de `locationalData`** — bloqueador técnico único e nomeado do Minerador; sem isso nenhum framework de coleta (Lenhador, Pescador) pode avançar com confiança.
4. **Cobrir `crafting-service.js` e `jobs-service.js` com teste** antes de qualquer expansão de conteúdo — os dois módulos mais recentes deste domínio são os dois sem rede de segurança.
5. **Desenhar Public Work formalmente**, só depois de (1) e (2) resolvidos.
6. **Estender Resource Node para Lenhador/Pescador** (arquitetura próxima, reuso alto) — antes de Fazendeiro/Caçador, que pedem desenho novo.
7. **Decidir Fazendeiro (nó com plantio) e Caçador (alvo móvel)** como frameworks separados — não forçar dentro de Resource Node.
8. **Cadastrar conteúdo real de crafting** (receitas de forja etc.) só depois do modelo de profissão estar fechado — evita recadastrar.
9. **ItemInstance/durabilidade** (§ abaixo) — depende de crafting ter conteúdo real para fazer sentido testar contra ele.
10. **Revisar `economy-regional`/`housing`/`horse` para reativação**, por último — são PARKED por dívida pontual, não por decisão de arquitetura em aberto; não bloqueiam nada do resto.

---

## ItemInstance / Durabilidade — leitura de compatibilidade (sem implementar)

**Sistemas que já justificariam ItemInstance hoje:** `crafting-service.js` (quem fabricou, com que ingredientes — hoje o item entregue é só uma stack genérica via `core/inventory.exchange`, sem metadado de origem `[CODE]`); `contracts-service.js` (rastrear item específico entregue vs. genérico); mercado negro/receptação (§ item 5 do pedido do usuário — precisaria de "stolen status" por instância).

**O que o Inventory Framework atual já prepara:** `core/inventory.js` opera sobre **stacks** (`getStack`, `exchange`, `mint`, `burn`) — não há conceito de item único e endereçável por ID próprio hoje; o histórico (`history()`) registra movimentação de stack, não de instância. `[CODE]`

**DEPENDÊNCIAS:** uma tabela nova (`item_instances` ou equivalente) com FK para o item base, mais uma revisão de `core/inventory.exchange` para aceitar granularidade de instância além de stack — mudança estrutural no core, não incremental.

**MUDANÇAS NECESSÁRIAS:** todo consumidor que hoje assume "item = stack fungível" (`crafting-service`, `resource-node-service`, `market-stalls-service`, `trade-service`) precisaria decidir, caso a caso, se o item que produz/move é fungível ou por instância — não é uma migração automática.

**RISCOS:** é uma mudança de fundação, do mesmo porte histórico que a criação de `core/inventory.js` e `core/economy-service.js` foram (ambas nasceram de bug de dinheiro/item sumindo) — fazer errado aqui tem o mesmo risco documentado repetidamente neste relatório: dívida silenciosa que só aparece quando alguém tenta usar.

---

## Respostas obrigatórias

**1. O sistema atual diferencia corretamente Profissão / Especialização / Emprego / Cargo / Negócio / Public Work?**
Não. Diferencia com clareza só **Profissão** (bem modelada) de **tudo o mais** (que hoje é só `jobs-service`, um conjunto pequeno e desestruturado de trabalho livre). Especialização, Emprego, Cargo e Negócio **não existem como conceito no código** — nem mal-modelados, simplesmente ausentes. `[CODE]`

**2. O que exatamente é o `jobs-service` hoje?**
Três funções JS hardcoded (`chopWood`, `mineOre`, `catchFish`) que entregam item via `transactionService.giveItem` a qualquer personagem, sem checar profissão, nó, distância ou ferramenta, com quantidade/raridade decidida por `Math.random()` não determinístico e não auditado. Corrigido no passado para não escrever mais direto no cliente via Papyrus; nunca testado; sem cooldown identificado. `[CODE]`

**3. Ele deve ser mantido / adaptado / virar Public Work / ser dividido / ou removido?**
Não decido isso aqui — é decisão do dono do produto (ver #10). O que a auditoria mostra: o mecanismo de entrega está correto (usa a porta certa do Inventory/Economy); a **identidade** do módulo está em tensão com a existência paralela de `mining-service` fazendo a mesma coisa (minerar) com mais rigor. As opções plausíveis, com o que cada uma custaria:
   - **Manter como está**: barato, mas perpetua a duplicação com `mining-service` e o `Math.random()` não resolvido.
   - **Adaptar** (cooldown + determinismo, sem virar Public Work formal): médio custo, resolve os dois problemas técnicos sem esperar a decisão de taxonomia de §14.
   - **Virar Public Work formal**: correto conceitualmente segundo a taxonomia do usuário (§5 do pedido original — "sem profissão obrigatória, sem XP, piso econômico"), mas depende de §14 estar fechado primeiro.
   - **Dividir**: ex. `mineOre` deveria desaparecer (redundante com `mining-service`), `chopWood`/`catchFish` sobrevivem como Public Work até Lenhador/Pescador terem framework próprio.
   - **Remover**: descartaria a única implementação (ainda que fraca) de "trabalho sem profissão" que o projeto tem hoje — parece o pior custo-benefício das opções.

**4. Quão pronto está Minerador?**
Sem percentual único (enganoso dado o tipo de trabalho restante). Por camada:
   - **Core (Profession + Resource Node):** pronto e testado.
   - **World integration (distância real contra objeto comum):** existe o código, **suposição não validada** — é o bloqueador único.
   - **Sessão de coleta (duração, animação, cancelamento):** falta, não iniciado.
   - **Multiplayer validation:** falta, zero sessões reais até hoje.

**5. Quão pronto está Crafting?**
   - **Motor (receita, gate, transação):** pronto e correto (com histórico de bug corrigido, documentado no próprio código).
   - **Testes:** zero — pior cobertura do domínio inteiro.
   - **Proximidade real de estação:** não existe (é comparação de string, não distância).
   - **Conteúdo (receitas reais para as 5 profissões de crafting):** zero receitas cadastradas.
   - **Multiplayer validation:** falta.

**6. Que fundações NÃO devemos criar novamente?**
`core/transaction-service.js`, `core/economy-service.js`, `core/inventory.js`, `core/interaction-service.js`/`registry`/`targets`, `core/profession-registry.js`, `core/resource-node-registry.js`/`resource-node-service.js`. Todos maduros, testados, e cada um já nasceu de um bug real que ele resolveu — recriar qualquer um deles do zero repetiria uma classe de erro já paga.

**7. Quais módulos PARKED possuem código ainda valioso?**
Todos os três (`economy-regional`, `housing`, `horse`) — nenhum foi apagado por estar conceitualmente errado (ao contrário de `justice-service`/`faction-service`/`disguise-service`, que **foram** apagados por isso). Os três PARKED restantes têm dívida técnica pontual e localizada (§13), não erro de design.

**8. Qual é o maior conflito arquitetural atual?**
A ausência de qualquer relação entre `jobs-service`/`contracts-service`/`trade-service`/`market-stalls-service` e `Profession Core`/`Resource Node` (mapa da §"Mapa de relacionamento") — o projeto tem dois universos de gameplay econômico que não se falam, e a duplicação `jobs.mineOre` vs `mining-service` é o sintoma concreto disso hoje.

**9. Qual é o primeiro sistema que deveríamos desenhar depois desta auditoria?**
A taxonomia de Profissão × Especialização × Emprego × Cargo × Negócio × Public Work (§14) — é a única decisão que todo o resto (destino do jobs-service, Public Work, expansão de Resource Node, conteúdo de crafting) depende dela para não ser refeito depois.

**10. Quais decisões dependem de mim, dono do produto?**
   - O destino de `jobs-service` (#3 acima).
   - Se Especialização vira sub-árvore de Profissão ou conceito separado.
   - Se Emprego/Cargo/Negócio nascem como sistema novo agora ou ficam adiados até depois do Minerador ser validado em jogo.
   - Se vale investir em cobrir `crafting-service`/`jobs-service` com teste antes ou depois da decisão de taxonomia (ordem de trabalho, não só conteúdo).
   - Se `economy-regional`/`housing`/`horse` entram na fila de reativação agora ou ficam parados até o resto do domínio estabilizar.
   - Prioridade entre "validar Minerador em jogo" (prova técnica) e "fechar taxonomia" (decisão de design) — ambos são pré-requisito de coisas diferentes e podem, em princípio, correr em paralelo.

---

*Fim do relatório. Nenhuma feature foi criada, nenhum módulo foi reativado, nenhuma migration foi alterada, nenhum commit foi feito por esta auditoria.*
