# Relatório de Characterization Tests — jobs-service + crafting-service

**Data:** 20/08/2026 · **Fecha:** `WORK_ECOSYSTEM_DECISION_SUMMARY.md` → "Next Implementation Task" · **Natureza:** rede de segurança, zero mudança de gameplay

---

## Scope

Congelar o comportamento real e atual de `jobs-service.js` e `crafting-service.js` — os dois únicos módulos reativados neste domínio (commits `99c125c`, `2ee7788`) sem cobertura de teste dedicada — antes de qualquer migração arquitetural (Public Work, Specialization). Nenhum bug conhecido foi corrigido. Nenhuma feature nova foi implementada. Nenhum ADR foi reaberto.

---

## Repository State

```
Antes:
Branch:  feat/skyvoice-core-etapa-2 (sincronizada com origin)
HEAD:    48bad04 "docs: jobs/contracts/crafting deixam de ser descritos como PARKED"
Working tree: limpo

Depois:
Modificado: skymp/gamemode/package.json (registro dos 2 testes novos em scripts.test)
Novo:       skymp/gamemode/jobs-service.test.js
Novo:       skymp/gamemode/crafting-service.test.js
Novo:       docs/research/WORK_PROFESSION_ECOSYSTEM_CURRENT_STATE.md (rodadas anteriores, já existente)
Novo:       docs/research/WORK_ECOSYSTEM_TARGET_ARCHITECTURE.md (idem)
Novo:       docs/research/WORK_ECOSYSTEM_DECISION_SUMMARY.md (idem)
Novo:       docs/technical/ADR_007..012_*.md (idem)
Nenhuma migration criada. Nenhum module-registry.js alterado. jobs-service.js
não foi renomeado. Nenhuma entrada do Profession Registry removida.
```

---

## jobs-service

### Behaviors frozen (CURRENT CONTRACT — comportamento que esperamos preservar até a migração)

- `chopWood`/`mineOre`/`catchFish` entregam item exclusivamente via `transactionService.giveItem`, com `{actorId, characterId, baseId, count, reason, module:'jobs', idempotencyKey}`.
- Sem personagem carregado no `actorId`: recusa com `'Personagem nao carregado.'`, nenhum timer agendado, nenhuma entrega.
- Ferramenta ausente (machado/picareta): recusa antes de agendar qualquer coisa, mensagem específica por ferramenta.
- Concorrência: um segundo `chopWood`/`mineOre`/`catchFish` para o mesmo `characterId` **enquanto o primeiro ainda está em andamento** é recusado com `'Você já está ocupado fazendo algo.'` — é lock de sessão (`activeGatherers`), não cooldown.
- Falha de `transactionService.giveItem` (retorna `false`): notifica `'A coleta se perdeu antes de chegar na sua mochila.'`, não reporta sucesso, uma única tentativa (sem retry automático), `characterId` liberado mesmo assim.
- `transactionService.giveItem` lançando exceção: capturada pelo `.catch()` do próprio `jobs-service.js`, nunca propaga para o chamador do comando de chat.
- Proteção contra "session hijack": se o personagem no `actorId` mudar entre início e fim da coleta (outro jogador assumiu o mesmo slot), a entrega é descartada — ninguém recebe, e o `characterId` original é liberado.
- `catchFish` sem peixe (`Math.random() <= 0.2`): libera o slot imediatamente, notifica `'O peixe escapou!'`, **não chama `giveItem`** (não gera idempotencyKey nem tentativa de entrega).
- Comandos: exatamente `/cortarlenha`, `/garimpar`, `/pescar` — confirmado lendo `commandDefs()`, não a documentação.

### Legacy behaviors (LEGACY CHARACTERIZATION — esperamos que desapareçam quando Public Work suceder jobs-service, ADR 011)

- **`Math.random()` é a única origem de quantidade e raridade**, em todos os três verbos: `chopWood` (`floor(rand*3)+1`, 1–3 lenha), `mineOre` (`chance` decide ferro/corundum/ébano por faixa; `amount` = `floor(rand*2)+1`), `catchFish` (faixa por `chance`, quantidade fixa 1).
- **`mineOre` não consulta `profession-service` nem `resource-node-service`, não valida distância, não valida o Interaction Framework** — confirmado por duas vias: teste estrutural (grep no código-fonte) e teste comportamental (a chamada funciona sem nenhum mock desses três módulos existir no arquivo de teste). Esta é a duplicação exata com `mining-service` que a auditoria (`WORK_PROFESSION_ECOSYSTEM_CURRENT_STATE.md` §15) já havia identificado.
- **Sem cooldown de serviço.** `allows_repeated_work_calls_without_service_cooldown_current_behavior`: duas chamadas de `chopWood` em sequência imediata (a segunda só depois que a primeira já terminou) são ambas aceitas. Nenhum estado registra "quando foi a última vez que este personagem trabalhou".
- **`catchFish` não exige ferramenta hoje** — `toolBaseId` é `null` no código (o próprio arquivo tem um `TODO` pedindo o FormID correto da vara de pescar).
- **Comandos de coleta direta via chat**, sem UI, sem Interaction Framework, sem verificação de posição no mundo além da checagem de ferramenta client-trusted (que só decide se a ação *começa*, nunca o que é entregue).

### Gaps explicitly NOT fixed

`Math.random()` não determinístico · ausência de cooldown · ausência de Interaction Framework · duplicação `jobs.mineOre` × `mining-service` · `catchFish` sem ferramenta exigida. Todos caracterizados, nenhum corrigido, conforme instrução explícita desta rodada.

---

## crafting-service

### Behaviors frozen (CURRENT CONTRACT)

- `craftItem` carrega a receita por `id`; inexistente → `false`, `'Receita não encontrada.'`, nenhuma chamada a `inventory.exchange`.
- Receita sem ingrediente cadastrado (janela real entre `/addrecipe` e `/addingredient`) → `false`, nenhuma chamada a `exchange` — recusa criar item do nada.
- `station_type`: se `opts.stationType` vier preenchido e divergir de `recipe.station_type`, recusa antes de tocar o inventário. **Se `opts.stationType` vier ausente/vazio, a checagem inteira é pulada** — craft passa sem station declarada nenhuma.
- `required_profession`: `null` não consulta `profession-service.hasProfession` (confirmado por instrumentação — o mock nem é chamado). Preenchido e ausente no personagem → bloqueia antes de `exchange`. Preenchido e presente → permite.
- `required_rank`: `null`/`undefined` não consulta `getProfessionState`. Preenchido: `rank >= required_rank` permite (inclusive na igualdade exata), abaixo bloqueia antes de `exchange`. `getProfessionState` devolvendo `null` (nenhum estado) é tratado como insuficiente, sem comparar números.
- **Ordem confirmada**: validação de receita → station → profession gate → rank gate → ingredientes cadastrados → `inventory.exchange`. Em nenhum cenário testado a mutação de inventário acontece antes de qualquer gate — nunca o inverso.
- **Atomicidade observável**: consumo de ingredientes e entrega do resultado são **uma única chamada** de `core/inventory.exchange`, com duas pernas (`personagem→system(consume)`, `system(craft)→personagem`), `reason:'craft'`, `module:'crafting'`, `requestId`.
- `exchange` falhando (`ok:false`): não entrega produto, `craftItem` devolve `false`, notifica o motivo, XP não creditado.
- `exchange` devolvendo `duplicate:true` (reenvio do mesmo `requestId`): devolve `true` **sem craftar de novo**, avisa "já havia sido concluído" em vez de "você criou".
- XP só é creditado quando a receita tem `required_profession` preenchido **e** `crafting.xpPerCraft > 0` — craft livre (sem profissão) nunca progride nenhuma profissão.
- `addRecipe`/`addIngredient`: sem a permissão `manage_recipes`, não inserem nada; `addRecipe` devolve `null`.
- Comandos: exatamente `/receitas`, `/craft`, `/addrecipe`, `/addingredient`.

### Gates confirmed

`required_profession` e `required_rank` são checados de verdade dentro de `craftItem()`, sempre antes de qualquer mutação de inventário — confirmado por teste de ordem dedicado, não presumido.

### Transaction behavior

Uma única chamada a `core/inventory.exchange` cobre as duas pernas (consumo + entrega). Não existe cenário nos testes onde ingrediente é consumido sem produto entregue, ou vice-versa — porque não existem duas transações separadas: é uma chamada lógica só, e a falha dela não move nada.

### Legacy/dead fields

- **`requires_perk` confirmado como campo morto.** `requires_perk_is_not_enforced_current_behavior`: preencher `requires_perk` com qualquer valor não muda o resultado de `craftItem()` — testado com receita idêntica exceto por esse campo, resultado idêntico nos dois casos.
- **`station_type` não valida distância física.** `station_type_check_does_not_validate_world_distance_current_behavior`: o craft passa com a station declarada correta sem nenhuma checagem de posição no mundo — é comparação de string contra o que o cliente declarou, não proximidade real.
- **Não existe estado "habilitada/desabilitada" de receita.** Confirmado contra `schema.sql`: `crafting_recipes` tem `id, name, station_type, result_base_id, result_count, requires_perk, created_at` (+ `required_profession`/`required_rank` da migration-v20) — nenhuma coluna de ativação/desativação.

---

## Tests Added

| Arquivo | Testes | Suites |
|---|---|---|
| `skymp/gamemode/jobs-service.test.js` | 29 | 7 |
| `skymp/gamemode/crafting-service.test.js` | 46 | 11 |
| **Total** | **75** | **18** |

---

## Test Results

```
Before:
1642 tests (npm test, suíte completa do gamemode)

Added:
75 tests (jobs-service.test.js: 29, crafting-service.test.js: 46)

After:
1717 tests

Failures:
0 / 1717

Suítes adicionais também verdes:
- npm run test:systems  → 13/13 checks
- npm run check:schema:list → roda sem erro (sem RUN_DB_CHECK, comparação contra banco real não executada — igual a antes desta rodada)
- node scripts/check-test-registry.js → OK, 84 testes listados, todos presentes, nenhum órfão
```

Nenhuma regressão pré-existente encontrada — os 1642 testes anteriores continuam passando sem alteração.

---

## What these tests prove

Comportamento do processo Node.js/serviço, isolado, contra mocks que respondem exatamente como o `db`/`core/inventory`/`core/transaction-service`/`profession-service`/`commands`/`admin-service` reais respondem nos contratos observados: ordem de chamadas, argumentos passados, o que acontece em cada ramo de falha, quais mensagens são emitidas, o que `Math.random()` decide e em qual faixa.

## What these tests do NOT prove

- Interação real com o Skyrim (animação, `Debug.SendAnimationEvent`, posição real do ator).
- Runtime Papyrus de verdade — `mp.callPapyrusFunction`/`Actor.GetItemCount` são simulados por um objeto JS, não pelo motor do jogo.
- CEF/UI do cliente — nenhum destes dois módulos tem UI própria; os comandos de chat testados aqui não confirmam que o SkyMP realmente despacha `/craft`/`/garimpar` como texto do jogador até este handler.
- Distância real no mundo — nem `jobs-service` nem `crafting-service` medem distância hoje, e os testes não simulam um mundo 3D para provar ausência disso além de ler o código-fonte.
- Multiplayer — todos os testes rodam um `characterId`/`actorId` por vez, sequencialmente; nenhum cenário de dois jogadores concorrentes foi exercitado aqui (diferente de `resource-node-service.test.js`, que tem um teste de lock de linha).
- Concorrência MySQL real — `db`/`inventory.exchange` são mocks JS síncronos-por-await; nenhuma race condition de banco real é reproduzida.
- Estação física (`station_type`) como objeto do mundo — os testes confirmam que a checagem hoje NÃO é proximidade, não testam uma proximidade que não existe.
- Animação de coleta em `jobs-service.js` (o código relevante está comentado no próprio arquivo, nunca executa).

**Nenhum destes dois módulos está "validado in-game" por causa deste relatório.** A mesma ressalva que a auditoria original já registrava para o projeto inteiro continua valendo integralmente.

---

## Regressions Found

Nenhuma. Todos os 1642 testes pré-existentes permaneceram verdes; os 75 novos passaram na primeira execução completa após a escrita (sem correção de teste incorreto — a única iteração foi escrever, rodar, confirmar).

---

## Next Safe Change

Não determinado nesta rodada — esta tarefa termina na rede de segurança, não na decisão do próximo passo de produto. As decisões em aberto continuam as mesmas listadas em `WORK_ECOSYSTEM_DECISION_SUMMARY.md` ("Open Decisions"), agora com a vantagem de que qualquer uma delas que toque `jobs-service.js`/`crafting-service.js` tem 75 testes que apitam se o comportamento mudar sem intenção.
