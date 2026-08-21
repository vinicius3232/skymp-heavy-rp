# Relatório de Homologação de Runtime — Minerador

**Data:** 20/08/2026 · **Fecha:** `WORK_ECOSYSTEM_DECISION_SUMMARY.md`/`JOBS_CRAFTING_CHARACTERIZATION_REPORT.md`, próxima etapa: validar em runtime real, não mais arquitetura · **Natureza:** investigação + instrumentação mínima, zero feature nova

> **Segundo adendo (mesma sessão, depois do relatório abaixo).** **Blocker C (`mp.onUiEvent`/`BOUND-004`) foi corrigido** — `core/ui-event-gateway.js` agora usa `mp.makeEventSource('_onUiEvent', ...)` no lugar de `mpApi.onUiEvent = gateway`, e `ui/index.html` (`sendUiEvent`) passou a usar `window.skyrimPlatform.sendMessage(...)` no lugar de `window.mp.trigger`/`window.mp.send` (que também nunca foram confirmados como API real da CEF). Ver `docs/research/SKYMP_INTEGRATION_AUDIT.md` §5 para o registro formal da correção. **O corpo deste relatório abaixo NÃO foi reescrito** — ele documenta o estado no momento da investigação (Blocker C "aberto"), e isso continua sendo informação real sobre o que foi encontrado e por quê. Onde o texto abaixo diz "não corrigido"/"aberto" para Blocker C, leia como **corrigido depois, nesta mesma sessão** — `Blocker D` (nenhum trigger de cliente para `targetType:'object'`) **continua aberto**, não corrigido: a correção de C não implica D, são independentes como o relatório já explica. Sem servidor/SkyMP real disponível nesta sessão, a correção de C não pôde ser validada em runtime — só testada contra mock (`core/ui-event-gateway.test.js`), mesma ressalva de sempre.

> **Adendo pós-Prompt-4 (mesma sessão).** Antes de pesquisar mais upstream, este relatório foi revisado contra `docs/research/SKYMP_INTEGRATION_AUDIT.md` (auditoria de 14/08/2026, já existente no projeto, base `skyrim-multiplayer/skymp@d85f18d8`) — por instrução explícita de não refazer pesquisa que o projeto já fez. Essa leitura mudou a conclusão central deste relatório: apareceu um bloqueador mais fundamental que os dois já registrados (`locationalData`, gap de cliente para `object`). Ver "Blocker C" abaixo. Também confirmado: `git fetch origin` + `git log --left-right origin/main...feat/skyvoice-core-etapa-2` mostra só divergência de topologia (merge commit `990f0c4` da PR #27 do lado de `main`) — `git diff --stat` entre as duas pontas está **vazio**. Nenhum conteúdo de `main` falta nesta branch; nada a mesclar antes de prosseguir.

**Legenda de evidência:** `[LOCAL CODE]` lido no repositório atual · `[UPSTREAM CODE]` lido ao vivo do `main` de `github.com/skyrim-multiplayer/skymp` via `gh api` nesta sessão · `[UPSTREAM DOC]` docs/ do próprio repositório upstream · `[LOCAL DOC]` já pesquisado e registrado em sessão anterior deste projeto (`SKYMP_UPSTREAM_REFERENCE.md`) · `[TEST]` confirmado por teste automatizado neste repositório · `[MOCK ONLY]` só provado contra mock, nunca contra runtime real · `[INFERENCE]` dedução minha, marcada como tal · `[EXTERNAL]` conhecimento de modding do Creation Engine, não específico do SkyMP · `[NOT TESTED]` hipótese identificada, nenhuma evidência de runtime real coletada nesta sessão

---

## Scope

Responder, com evidência — não presunção — se o Minerador funciona quando conectado a um objeto real do Skyrim através do SkyMP: `Player → Interaction Framework → Skyrim object → posição real → distance validation → tool validation → Mining Service → Resource Node → Inventory → Profession XP`. Não implementa Lenhador, Pescador, Fazendeiro, Caçador, Gather Session, Public Work, Specialization, Employment, Business, nova profissão, nem generaliza o Resource Node/Interaction Framework. Não decide balanceamento, animação, cooldown, fadiga.

---

## Repository State

```
Antes desta rodada:
Branch: feat/skyvoice-core-etapa-2 (sincronizada com origin)
HEAD:   8f1567a "test(jobs,crafting): characterization tests antes da primeira migracao"
Working tree: limpo

Depois:
Modificado: skymp/gamemode/core/range-utils.js  (fix pequeno, ver "Changes Applied")
Modificado: skymp/gamemode/mining-service.js     (instrumentação atrás de flag + _sp3ListMethods)
Modificado: skymp/gamemode/mining-service.test.js (+7 testes de instrumentação)
Modificado: skymp/gamemode/.env.example          (documenta 3 flags que faltavam)
Modificado: skymp/gamemode/package.json          (registra core/range-utils.test.js)
Novo:       skymp/gamemode/core/range-utils.test.js (+5 testes, primeiro teste deste arquivo)
Novo:       docs/research/MINING_RUNTIME_VALIDATION_REPORT.md (este arquivo)
Novo:       docs/research/MINING_MANUAL_RUNTIME_TEST_PLAN.md

Nenhum ADR reaberto. Nenhuma migration criada. Nenhum module-registry.js
alterado. jobs-service.js intocado. Nenhum novo módulo/serviço criado —
Lenhador/Pescador/Public Work/Gather Session não foram iniciados.
```

Suíte completa: **1717 → 1726 testes, 0 falhas.** `npm run test:systems`: 13/13. `check-test-registry.js`: OK, 85 testes listados.

---

## Runtime Environment

Confirmado nesta sessão, não presumido:

| Recurso | Disponível nesta execução? |
|---|---|
| Node.js | Sim (v25.5.0) — todos os testes automatizados rodam nele |
| MySQL/MariaDB real | **Não** — `mysql`/`mysqld`/`mariadbd` ausentes do PATH, nenhum serviço local |
| Docker | **Não** — daemon não está rodando (`docker ps` falhou ao conectar) |
| SkyMP server real (processo game rodando) | Não iniciado nesta sessão — o artefato existe em `skymp/server/` (`gamemode.js`, `dist_back`), mas subir e conectar exige o cliente Skyrim, que este ambiente não tem |
| Cliente Skyrim + SkyMP client | **Não disponível neste ambiente** — sem GUI de jogo |
| Acesso à internet / GitHub | **Sim** — `gh api` funcionou, usado para ler código-fonte C++ do upstream ao vivo |

**Consequência direta, declarada sem meio-termo:** esta sessão **não pôde** executar os Testes 1, 2 (parcial), 3, 6–13, 15 (parcial), 16–19 contra Skyrim/SkyMP/MySQL reais. O que segue é (a) investigação de código-fonte upstream real (não mock, não suposição), (b) testes automatizados contra o pipeline real do gamemode com `mp`/`db` mockados (mesmo padrão já estabelecido no projeto), e (c) instrumentação + roteiro para um humano executar o que só pode ser executado com Skyrim/SkyMP/MySQL de verdade. Nenhuma conclusão abaixo declara "PASS" para o que não foi executado contra o sistema real — ver §"Runtime Not Executed" nas tabelas.

---

## Assumptions Tested — Runtime Assumption Map

| Hipótese | Código que depende dela | Mock cobre? | Runtime comprovado? |
|---|---|---|---|
| `ObjectReference` (não-ator) possui a property `locationalData` | `core/interaction-targets.js` (resolvedor `object`), `core/range-utils.js` | Sim, mock sempre devolveu o que o teste pediu | **Sim — `[UPSTREAM CODE]`**, ver §"SkyMP API Investigation". `LocationalDataBinding::Get` opera sobre `MpObjectReference` genérico, não `MpActor`. Confirmado por leitura do C++ da `main` upstream, não por teste em jogo — mas é a evidência mais forte possível sem abrir o jogo: é o próprio código que roda no servidor. |
| `locationalData` devolve `{pos:[x,y,z], rot:[x,y,z], cellOrWorldDesc}` | idem | Sim | **Sim — `[UPSTREAM CODE]`**, mesma fonte, formato batendo exatamente com `types/mp.d.ts` |
| `mp.get(formId,'locationalData')` **nunca lança** para qualquer `formId` | `core/range-utils.getLoc` (antes desta rodada) | Não — mock nunca simulava exceção | **Falsa — `[UPSTREAM CODE]`**. `ScampServer::Get`→`WorldState::GetFormAt<MpObjectReference>` lança `std::runtime_error("Form with id {} doesn't exist")` para FormId ausente de `WorldState`, e o addon rejoga como `Napi::Error` — um `throw` síncrono em JS. **Corrigido nesta rodada** (ver Changes Applied) — `[TEST]` cobre o comportamento novo |
| O CLIENTE envia `targetType:'object'` com o FormId do que o jogador está mirando | Todo o fluxo `interaction:query`/`interaction:execute` para `mining.mine` | N/A (é o cliente, não tem mock porque não tem chamador nenhum) | **Falsa hoje — `[LOCAL CODE]`**. `skymp/ui/index.html:1558` fixa `const INTERACTION_TARGET_TYPE = 'player';` e nenhum lugar do repositório (`ui/`, client scripts) resolve crosshair ou envia `targetType:'object'`. Ver §"Object Resolution" — **este é o bloqueador real**, não `locationalData` |
| `Interaction Framework` mede distância ANTES de `execute` rodar | `core/interaction-service.js` (`buildContext`, estágio `DISTANCE`) | Sim, exaustivamente | **Sim — `[TEST]`** contra o pipeline REAL (não mockado) em `mining-service.test.js`, herdado de sessão anterior |
| `assertRange` compara a mesma unidade dos dois lados | `core/range-utils.distanceBetween` | Sim (unidades arbitrárias no mock) | **Parcial.** A fórmula é euclidiana pura sobre `pos` — sem conversão de unidade nenhuma. O valor vem direto de `refr.GetPos()`/`NiPoint3` nativo do Creation Engine (`[UPSTREAM CODE]`), então os dois lados SEMPRE estão na mesma unidade (game units do motor) por construção — não há como divergir. **O que não está confirmado** é se `mining.maxDistance=200` (default) é um valor sensato em metros — ver §"Distance Validation" |
| `Actor.GetItemCount` reporta posse real de picareta | `mining-service._hasPickaxe` | Sim (mock sempre responde o configurado) | **`[NOT TESTED]` contra runtime real.** Classificado como CLIENT TRUSTED — ver §"Tool Validation" |
| `resource_base_id` entregue aparece no cliente do jogador | `core/transaction-service.tx.applyToClient` | Sim (mock só registra a chamada) | **`[NOT TESTED]`** — exige cliente Skyrim conectado |
| DB de inventário permanece sincronizado após reconexão | `core/inventory.js`, `commands.js` (sync no login) | Não testado por este relatório | **`[NOT TESTED]`** |
| XP persiste corretamente | `profession-service.addProfessionXp` + `character_professions.xp` | Sim (mock) | **`[TEST]` contra mock; `[NOT TESTED]` contra MySQL real** |
| `SELECT...FOR UPDATE` serializa duas coletas concorrentes do mesmo nó, sem duplicar | `resource-node-service.consume` | Sim, mas só ORDEM de query em mock síncrono | **`[MOCK ONLY]`** — herdado de `resource-node-service.test.js`; nunca testado contra MySQL real nesta ou em sessão anterior |
| Regeneração calculada sob demanda bate com o relógio real do MySQL (`NOW()`, `DATETIME(3)`) | `resource-node-service._computeCapacity` | Sim, com `Date.now()` mockado | **`[MOCK ONLY]`** |

---

## SkyMP API Investigation

Metodologia: `gh api repos/skyrim-multiplayer/skymp/contents/<caminho>` contra a branch `main`, nesta sessão (20/08/2026) — evidência fresca, não reaproveitada de cache ou de post antigo.

### `locationalData` — leitura, para `MpObjectReference` genérico

`[UPSTREAM CODE]` `skymp5-server/cpp/addon/property_bindings/LocationalDataBinding.cpp` (lido ao vivo):

```cpp
Napi::Value LocationalDataBinding::Get(Napi::Env env, ScampServer& scampServer, uint32_t formId)
{
  auto& partOne = scampServer.GetPartOne();
  auto& refr = partOne->worldState.GetFormAt<MpObjectReference>(formId);   // ← genérico, NÃO MpActor

  locationalData.Set("cellOrWorldDesc", Napi::String::New(env, refr.GetCellOrWorld().ToString()));
  auto& niPoint3 = refr.GetPos();        // MpObjectReference::GetPos(), não MpActor::GetPos()
  ...
  auto& niPoint3Angle = refr.GetAngle(); // idem
  ...
}
```

**Isto resolve a hipótese principal da auditoria.** `GetFormAt<MpObjectReference>` é o método de acesso ao form pedindo o tipo-base comum a `MpActor` e a qualquer referência de objeto do mundo — `refr.GetPos()`/`GetAngle()`/`GetCellOrWorld()` são métodos de `MpObjectReference`, herdados por `MpActor`, não o inverso. Não há checagem `if (!refr.AsActor()) throw` no caminho de leitura — essa checagem **existe**, mas só no caminho de **escrita**:

```cpp
void LocationalDataBinding::Set(...) {
  ...
  if (auto actor = refr.AsActor()) {
    Apply(*actor, locationalData);
  } else {
    throw std::runtime_error("mp.set can only change '" + GetPropertyName() + "' for actors, not for refrs");
  }
}
```

**Classificação: RESULTADO A — `locationalData` funciona exatamente como esperado**, para leitura, contra `MpObjectReference` comum. `types/mp.d.ts` já descrevia o formato certo (`[LOCAL CODE]`, escrito em sessão anterior a partir de `[UPSTREAM DOC]`) — confirmado agora contra o C++ primário, não só a doc.

**O que isso NÃO prova**: que o `formId` que o servidor recebe do cliente corresponde de fato ao objeto físico correto no mundo, nem que esse `formId` está carregado em `WorldState` no momento da chamada. Os dois pontos seguintes tratam disso.

### `GetFormAt` lança para form inexistente — achado novo, não estava na auditoria original

`[UPSTREAM CODE]` `skymp5-server/cpp/server_guest_lib/WorldState.h:133-139`:

```cpp
F& GetFormAt(uint32_t formId) {
  const std::shared_ptr<MpForm>& form = LookupFormById(formId);
  if (!form) {
    throw std::runtime_error(fmt::format("Form with id {:#x} doesn't exist", formId));
  }
  ...
}
```

E `[UPSTREAM CODE]` `skymp5-server/cpp/addon/ScampServer.cpp:997-1020` (`ScampServer::Get`, o que `mp.get` chama) envolve tudo num `try { ... } catch (std::exception& e) { throw Napi::Error::New(...); }` — ou seja, um `formId` desconhecido faz `mp.get(formId,'locationalData')` **lançar em JavaScript**, não devolver `null`/`undefined`.

`core/range-utils.js` nunca precisou lidar com isso até `object` virar tipo de alvo: todo `actorId` que passava por `getLoc()` já existia em `WorldState` por definição (é um jogador conectado). `object` é o primeiro caminho que entrega um `formId` **escolhido pelo cliente e nunca validado pelo servidor antes de perguntar a posição** — inclusive um `formId` forjado ou de algo nunca carregado. **Corrigido nesta rodada** — ver Changes Applied.

### `mp.getDescFromId` NÃO valida existência

`[UPSTREAM CODE]` `ScampServer.cpp:1249-1258` — `GetDescFromId` chama só `FormDesc::FromFormId(formId, espmFileNames)`, um cálculo puro sobre load order, sem tocar `WorldState`. **Consequência**: `mining-service._formDescOf(formId)` sempre devolve uma string plausível para qualquer `formId`, mesmo um que nunca existiu no mundo — o `canSee`/`execute` de `mining-service.js` não recusam por aí; quem recusa é a consulta a `resource_nodes` (fail-closed via banco, não via `mp`). Isso está correto por desenho (a auditoria já disse: "quem decide de verdade é sempre `resource-node-service.consume()`") — mas explica por que o `formId` forjado só quebra em `assertRange`, não em `_nodeAt`.

### Classificação final desta investigação: **RESULTADO A**, com uma ressalva nova documentada e corrigida

`locationalData` funciona exatamente como a doc — e agora o código upstream — descrevem, para objeto comum. **Manter** (não há alternativa a pesquisar, RESULTADO C/D não se aplicam). A única correção necessária era de robustez contra `formId` inválido, não de API errada.

---

## Bloqueadores, nomeados (A/B/C/D)

Antes de entrar em cada um: os quatro são **independentes entre si** — corrigir um não corrige os outros, e a ordem de descoberta (auditoria original → esta sessão → releitura de `SKYMP_INTEGRATION_AUDIT.md`) não é a ordem de severidade real. Ordenados por onde travam na cadeia `Player → Interaction Framework → Skyrim object → ... → Profession XP`:

| | O quê | Trava em | Status | Evidência |
|---|---|---|---|---|
| **Blocker C** | `mp.onUiEvent` não é hook real do SkyMP — todo o caminho CEF→servidor (`interaction:query`/`execute`, não só mining) está preso a um callback nunca chamado | Antes do primeiro passo — nada do cliente chega ao servidor | **Confirmado, ainda aberto** (`BOUND-004`, já rastreado desde 14/08) | `[UPSTREAM CODE]`, reconfirmado nesta sessão |
| **Blocker D** | Nenhuma UI/script de cliente monta ou envia `targetType:'object'` | Mesmo se C estivesse corrigido, nada dispara `mining.mine` | Confirmado nesta sessão | `[LOCAL CODE]` |
| **Blocker A** | `locationalData` contra `MpObjectReference` comum | Seria o próximo passo, depois de C e D resolvidos | **Resolvido — funciona** | `[UPSTREAM CODE]`, primário, lido ao vivo |
| **Blocker B** | `Actor.GetItemCount` — disponibilidade real no VM Papyrus deste servidor | Dentro de `execute()`, depois de C e D | **Evidência conflitante, não resolvido** — ver abaixo | `[UPSTREAM CODE]` + `[LOCAL CODE]`, contraditórios entre si |

### Blocker C — `mp.onUiEvent` é um callback morto (BOUND-004, já rastreado, ainda aberto)

`docs/research/SKYMP_INTEGRATION_AUDIT.md` linha 194, citação literal: **"Busca por `onUiEvent` em `skymp5-client/src`, `skymp5-server/cpp`, `skymp5-front/src` e `skymp5-functions-lib/src`: zero ocorrências. O SkyMP nunca chama essa property. `ui-event-router`, `ui-event-rate-limiter`, os schemas de `governance` e `player-panel`, o menu de interação — tudo isso está ligado a um callback morto."** `[UPSTREAM CODE]`, já registrado em 14/08/2026.

**Reconfirmado nesta sessão, de forma independente e fresca**: `gh api search/code -f q='onUiEvent repo:skyrim-multiplayer/skymp'` e o mesmo contra `skyrim-multiplayer/skymp5-functions-lib` — **zero resultados nos dois**, agora. E `core/ui-event-gateway.js:77` continua fazendo `mpApi.onUiEvent = gateway`, sem mudança desde a auditoria de 14/08. `BOUND-004` está marcado "sim" (bloqueia Fase 0) na tabela daquela auditoria e continua **aberto**.

**Por que isto muda a classificação do Minerador especificamente**: a auditoria de 14/08 tratou isto como um problema do Interaction Framework/governance/player-panel em geral — `mining-service.js`, criado depois (20/08), nunca cruzou essa referência. Mas `mining.mine` **também** depende inteiramente de `interaction:query`/`interaction:execute` chegando ao servidor. Se `BOUND-004` não foi corrigido, **nenhuma interação deste projeto — não só mineração — chega ao servidor pelo caminho normal da CEF**, independente do Blocker D (crosshair) ser corrigido ou não. Blocker D corrige "o cliente sabe o que mirar"; Blocker C corrige "o que o cliente manda chega ao servidor". Faltam os dois, não um.

**Fix conhecido, já documentado, não implementado por mim** (fora do escopo desta tarefa — é `client extension`, cross-cutting, não é "resolver mínimo do Minerador"): `SKYMP_INTEGRATION_AUDIT.md` linhas 203-212 já especifica `mp.makeEventSource('_onUiEvent', <snippet>)` + `mp._onUiEvent = (pcFormId, ...args) => gateway(pcFormId, args[0])` como a correção. Fica registrado, não corrigido — `BOUND-004` já é item de backlog rastreado, e corrigi-lo aqui misturaria uma correção de infraestrutura cross-módulo dentro de uma tarefa que devia ficar restrita ao Minerador.

**Consequência prática para o roteiro manual**: o truque do DevTools (`sendUiEvent(...)` manual) proposto na primeira versão deste relatório **pode não funcionar** enquanto `BOUND-004` estiver aberto — `sendUiEvent` client-side chama `window.mp.trigger`/`window.mp.send` (API da CEF, injetada pelo Skyrim Platform, diferente do `mp` server-side), e o caminho que o servidor escuta (`mpApi.onUiEvent`) nunca é invocado pelo motor. `MINING_MANUAL_RUNTIME_TEST_PLAN.md` foi atualizado com o teste de verificação **primeiro**, antes de qualquer outro passo.

### Blocker D — Object Resolution: nenhum trigger de cliente para `object`

A auditoria original tratou `locationalData` como a única incerteza séria do Minerador. A investigação desta sessão encontrou uma incerteza anterior e mais grave, **confirmada por leitura direta do código do próprio projeto, sem precisar de Skyrim para saber**:

`[LOCAL CODE]` `skymp/ui/index.html:1556-1558`:

```js
// O unico tipo de alvo com resolvedor no servidor hoje. Quando `container` ou
// `door` ganharem um, quem abre o menu passa o tipo junto.
const INTERACTION_TARGET_TYPE = 'player';
```

Esse comentário está desatualizado desde que `mining-service.js` registrou o resolvedor `object` em `core/interaction-targets.js` — mas **o cliente nunca foi atualizado**. `openInteractionMenu()` (linha 1588) só popula `state.interaction.targetActorId`, e o único `sendUiEvent('interaction:query', ...)` do arquivo usa `INTERACTION_TARGET_TYPE` fixo. Busquei em todo `skymp/ui/` por `crosshair`/`GetCrosshairRef`/qualquer string `'object'` fora do JSON solto de `typeof msg.effects === 'object'` (não relacionado) — **nada existe**.

**Consequência prática, sem ambiguidade:** hoje, um jogador real, apontando para um veio de minério real, com `ENABLE_MINING_SERVICE=true`, **nunca vê o menu "Minerar"**, porque o cliente nunca pergunta ao servidor sobre um alvo `object` — a UI shipada não tem crosshair detection nem envia esse tipo de evento. E `mining-service.js` não registra nenhum comando de chat (`commands: []` em `phase0-basic.js`), então também não há atalho de texto. **O único caminho de disparo hoje é chamar `sendUiEvent` manualmente pelo DevTools da CEF** — que é exatamente o que o roteiro manual (`MINING_MANUAL_RUNTIME_TEST_PLAN.md`) instrui, para poder testar o resto da cadeia sem depender de uma feature de cliente que nunca foi construída.

**Isto não é uma correção "pequena" no sentido do §33 desta tarefa** — construir detecção de crosshair no lado Skyrim Platform e ligá-la ao menu existente é trabalho de feature de cliente, não um ajuste de resolver server-side. Fica registrado como **FUTURE DESIGN GAP**, não implementado.

---

## Position / locationalData

Coberto integralmente em "SkyMP API Investigation" acima. Resumo: **RESULTADO A**, `[UPSTREAM CODE]`, leitura funciona para `MpObjectReference` comum; exceção para `formId` inexistente agora tratada (`[TEST]`).

---

## Distance Validation

`[TEST]` (mock, pipeline real): `mining-service.test.js` já provava, de sessão anterior, que a distância é medida **antes** de `execute` rodar (`assertRange` no estágio `DISTANCE` de `buildContext`), com um caso de "longe do veio, execute recusa no estágio de distância e não consome". Isso continua verdadeiro e agora tem cobertura adicional para o caso de `formId` inválido (`core/range-utils.test.js`, novo nesta rodada).

**Unidade de distância**: `[UPSTREAM CODE]` confirma que `pos`/pos comparados vêm direto de `NiPoint3` nativo (`refr.GetPos()`), sem nenhuma conversão em nenhuma camada do addon — então os dois lados de `distanceBetween` (jogador e nó) estão sempre na mesma unidade por construção; não há como divergir por bug de conversão. `mining.maxDistance=200` (default, `core/server-options.js:74`) é um **valor de julgamento de game design**, registrado como tal no próprio comentário do arquivo ("não descoberto em nenhuma fonte SkyMP"). O Creation Engine (motor do Skyrim, não específico do SkyMP) usa **`[EXTERNAL]`** aproximadamente 69,99 unidades por metro — se essa constante valer aqui (não confirmada contra o SkyMP especificamente, mas o valor é passthrough direto do motor), `200` unidades ≈ **2,86 metros**. Isto não foi validado em jogo nesta sessão; fica registrado como leitura de referência, não como fato confirmado — o §4 do pedido original pede só "provar consistência", não "corrigir balanceamento", e não há indício de inconsistência.

**Teste 3 (posição do jogador, distâncias progressivas 1/3/5/10m) e Teste 13 (fora de distância, execute revalida): `[NOT TESTED]` contra Skyrim real** — roteiro completo no plano manual.

---

## Tool Validation

`[LOCAL CODE]` `mining-service.js:141-145` (agora também instrumentado, ver Changes Applied):

```js
function _hasPickaxe(actorId) {
  if (typeof mp === 'undefined') return true;
  const count = mp.callPapyrusFunction('method', 'Actor', 'GetItemCount', actorRef(actorId), [ITEM_PICKAXE]);
  return count > 0;
}
```

**Classificação da fronteira de confiança: CLIENT TRUSTED, com blast radius limitado por desenho.**

`callPapyrusFunction` executa Papyrus **no cliente do próprio jogador** (`[LOCAL DOC]` `types/mp.d.ts`, confirmado `[UPSTREAM CODE]` pela assinatura de `ScampServer::CallPapyrusFunctionImpl`, que só define o transporte, não valida o resultado) — o valor de retorno vem do cliente, então um cliente modificado poderia responder `count > 0` sem ter a picareta de verdade. **Isso é aceito por desenho**, e o próprio código já documenta por quê: "client-trusted só para decidir se a ação COMEÇA — o que o jogador recebe é inteiramente decidido por `resource-node-service.consume()`, no banco". Verificado: `consume()` não recebe nem consulta posse de ferramenta — a entrega do minério não depende de `_hasPickaxe` de nenhuma forma indireta. **Risco real e aceito**: um cliente adulterado pode pular a "animação"/mensagem de picareta e chegar direto no `execute`, mas não ganha item extra nem pula profissão/distância — essas continuam server-authoritative.

Cenários A/B/C do pedido (tem picareta / não tem / troca no meio): A e B são cobertos por `[TEST]` (mock) desde a sessão anterior. C ("remove/equipa item entre chamadas") não é um cenário real neste desenho — a checagem é síncrona, um único `callPapyrusFunction` por tentativa, sem janela de tempo para trocar de item no meio (diferente de `jobs-service.chopWood`, que tem 10s de `setTimeout` entre início e fim). `[NOT TESTED]` contra cliente Skyrim real — a garantia de que o RETORNO do cliente é honesto nunca pode ser testada do lado servidor; é matematicamente cliente-confiável por definição.

### Blocker B — `Actor.GetItemCount` está mesmo registrado? Evidência conflitante

`docs/research/SKYMP_INTEGRATION_AUDIT.md`, achado nº 5 (linha 21): **"`Actor.GetItemCount` só resolve se `Actor.pex` estiver nos `archives`"** — classificado 🟡 Condicional, `BOUND-006`, **aberto**, nota explícita: "é uma conferência de dez minutos que não foi feita" (linha 300).

**Verificado localmente nesta sessão, sem precisar de servidor rodando** — três fatos, todos checáveis por leitura de arquivo:

1. `skymp/server/server-settings.json` **e** `server-settings-merged.json`: `"archives": []` — vazio nos dois.
2. `skymp/server/data/scripts/`: exatamente **um** `.pex` solto, `ActiveMagicEffect.pex` — **`Actor.pex` não está presente**.
3. `[UPSTREAM CODE]`, fresco desta sessão: `PapyrusObjectReference::GetItemCount` (`skymp5-server/cpp/server_guest_lib/script_classes/PapyrusObjectReference.cpp:303-330`) é uma implementação **nativa em C++**, registrada via `AddMethod(vm, "GetItemCount", &PapyrusObjectReference::GetItemCount)` — não depende de nenhum `.pex` carregado para o CORPO do método existir. Isto está em tensão direta com a premissa do achado nº 5 da auditoria de 14/08.

**A tensão não está resolvida por leitura de código, e não tentei resolvê-la escavando mais C++** (`PapyrusActor::Register`, lido nesta sessão, registra 27 métodos próprios e **não** re-registra `GetItemCount` sob o nome de classe `"Actor"` — a chamada de `mining-service.js` usa `className:'Actor'`, não `'ObjectReference'`, e não ficou claro pela leitura dos dois `Register()` se o dispatcher do VM do SkyMP resolve por hierarquia de classe ou por nome literal). Aprofundar exigiria ler o dispatcher da `VirtualMachine` inteiro — custo alto para uma pergunta que o próprio SkyMP já sabe responder em runtime.

**Resolvido de outra forma nesta sessão**: implementada a reflexão que o Prompt 5 pediu (`_sp3ListMethods`), em vez de continuar escavando C++. `mining-service.js` ganhou `_diagnoseItemCountAvailability()` (ver Changes Applied) — no boot, com `ENABLE_MINING_RUNTIME_DIAGNOSTICS=true` e servidor real rodando, chama `mp._sp3ListMethods('Actor')` e `mp._sp3ListMethods('ObjectReference')` (`[UPSTREAM CODE]` `ScampServer::SP3ListMethods` → `GetPapyrusVm().ListMethods(className)`, assinatura confirmada nesta sessão) e loga se `'GetItemCount'` aparece em cada lista. **Isto substitui a "conferência de dez minutos" da auditoria de 14/08 por uma linha de log no próximo boot** — sem precisar de jogador conectado, sem precisar de picareta física, sem teste manual algum. Ver `MINING_MANUAL_RUNTIME_TEST_PLAN.md`, "Step 0".

Classificação exigida pelo Prompt 5, aplicada ao resultado que **ainda não temos** (sem servidor rodando nesta sessão para chamar `_sp3ListMethods` de verdade):
- Se o log mostrar `registrado:false` para `'Actor'` **e** para `'ObjectReference'`: **PAPYRUS FUNCTION NOT AVAILABLE** — é configuração de archive (`BOUND-006` confirmado), resolve-se carregando `Actor.pex` ou equivalente, não é incompatibilidade de API.
- Se mostrar `registrado:true` para `'ObjectReference'` mas `false` para `'Actor'`: achado novo — sugere que o dispatcher do VM **não** resolve por herança de classe, e `mining-service.js` precisaria chamar `className:'ObjectReference'` em vez de `'Actor'` (mudança de uma linha, mas só depois de confirmado, não antes).
- Se mostrar `registrado:true` para `'Actor'`: achado nº 5 da auditoria de 14/08 estava errado para este método especificamente (pode valer para outros, como `GetActorValue`, que é um caso diferente) — **TOOL NOT PRESENT** vira a única causa possível de falha (picareta física ausente do inventário do ator, não da API).

**`[NOT TESTED]` — resultado real pendente de servidor rodando.** Não simulei o resultado; a instrumentação está pronta e testada `[TEST]` contra `mp._sp3ListMethods` mockado (comportamento correto do lado do gamemode, confirmado), o dado real do VM não.

---

## Resource Node

`[TEST]` `[MOCK ONLY]`: toda a suíte `resource-node-service.test.js` (herdada) prova atomicidade, gate de profissão/rank, esgotamento exato, regeneração — contra mock síncrono de MySQL. Nenhuma mudança nesta rodada. **`[NOT TESTED]` contra MySQL real** — sem instância disponível nesta sessão (ver Runtime Environment).

## Inventory Persistence

`[TEST]` `[MOCK ONLY]` via `core/inventory.test.js`/`core/transaction-service.test.js` (herdados). `[NOT TESTED]` contra MySQL real nesta sessão.

## Skyrim Inventory Projection

`[NOT TESTED]` — exige cliente Skyrim conectado recebendo `applyToClient`. Roteiro no plano manual (§"Client A Steps").

## Profession XP

`[TEST]` `[MOCK ONLY]`: `profession-service.test.js` cobre grant/revoke/suspend/rank/XP exaustivamente contra mock. `mining-service.test.js` confirma que `addProfessionXp` é chamado com os parâmetros certos após um `consume()` bem-sucedido, e que XP=0 não gera chamada. `[NOT TESTED]` contra MySQL real: suspensão/revogação durante uma tentativa de minerar em curso, gate de rank contra dado real.

## Depletion / Regen

`[TEST]` `[MOCK ONLY]`: esgotamento exato no limite e cálculo de regeneração proporcional já cobertos em `resource-node-service.test.js` (herdado, com `Date.now()` mockado). `[NOT TESTED]` contra `DATETIME(3)` real do MySQL.

## MySQL Concurrency

**`[NOT TESTED]`.** Sem MySQL disponível nesta sessão (ver Runtime Environment) para o Teste 11 (duas transações reais disputando `SELECT...FOR UPDATE` na mesma linha). O que existe é `[MOCK ONLY]`: a suíte já prova a ORDEM das queries num mock síncrono, o que — como o próprio `RESOURCE_NODE_FRAMEWORK.md` §8 já registrava antes desta rodada — não prova comportamento sob concorrência real. Roteiro exato (duas conexões Node reais contra um MySQL real, SQL para inspecionar o resultado) no plano manual, para execução futura quando houver banco disponível.

## Multiplayer Test

**`[NOT TESTED]`.** Nenhum cliente Skyrim disponível nesta sessão. Roteiro completo (Cliente A / Cliente B) no plano manual.

### `createBot()` — o que ele reduziria, e o que ele NUNCA prova

`docs/research/SKYMP_INTEGRATION_AUDIT.md` linha 44 (`[UPSTREAM CODE]`, já catalogado): `createBot()` cria um **cliente de rede headless, dentro do próprio processo do servidor** — é como o upstream roda os nove testes oficiais de `misc/tests/`. `BOUND-008` (linha 319) já registra a mesma ideia para este projeto: "Se o gamemode puder rodar como teste dentro de um servidor real, com ESM carregado e VM Papyrus de verdade, a classe inteira de defeito desta auditoria... deixa de conseguir chegar em produção."

**O que `createBot()` reduziria, especificamente para o Minerador**: os Testes 11 (concorrência MySQL real) e 12 (dois jogadores) **não precisam de Skyrim renderizado** — precisam de dois `formId` reais autenticados batendo em `interaction:execute` ao mesmo tempo contra um servidor com MySQL real por trás. Dois bots via `createBot()` fazem isso sem precisar de duas instalações de Skyrim, dois monitores, dois humanos coordenando "3, 2, 1". Isto **reduziria** a dependência de "2 clientes" reais para esses dois testes especificamente.

**O que `createBot()` NUNCA prova**, e não deve ser usado para simular: se `Actor.GetItemCount` responde certo contra o inventário real de um personagem no jogo (um bot não tem inventário Skyrim de verdade do mesmo jeito que um cliente renderizado tem), se a projeção de item no cliente (`applyToClient`) chega visualmente à tela, se a UI da CEF dispara `interaction:query` corretamente (bot não roda CEF), ou qualquer coisa que dependa do motor Creation Engine renderizando. Classificação obrigatória, sempre separada:

| | `createBot()` | REAL SKYMP (servidor + MySQL real) | REAL SKYRIM CLIENT |
|---|---|---|---|
| Prova protocolo de rede/autenticação real | Sim | Sim | Sim |
| Prova `resource-node-service.consume()` sob concorrência MySQL real | **Sim — reduziria Teste 11/12** | Sim | Sim |
| Prova `locationalData`/posição real de objeto no mundo | Não — bot não tem posição de motor renderizado da mesma forma | Parcial | Sim |
| Prova `Actor.GetItemCount` contra inventário Skyrim real | **Não** | Não (sem cliente) | Sim, único caminho |
| Prova UI CEF disparando `interaction:query` | **Não** — bot não roda CEF | Não | Sim, único caminho |
| Prova projeção visual de item no jogo | **Não** | Não | Sim, único caminho |

**Não implementado nesta sessão** — `createBot()` só roda dentro de um processo SkyMP real (precisa do addon C++ carregado), que não está disponível neste ambiente (ver Runtime Environment). Fica registrado como opção real para reduzir o roteiro manual dos Testes 11/12 especificamente, não como substituto de Skyrim real — `BOUND-008` já existe como item de backlog próprio, mais amplo que este relatório (harness de integração para o projeto inteiro, não só Minerador).

## Abuse / Negative Tests

| Cenário | Status |
|---|---|
| `formId` inexistente/forjado como alvo | **`[TEST]` — corrigido e coberto nesta rodada** (`core/range-utils.test.js`) |
| `formId` de objeto não registrado como node | `[TEST]` `[MOCK ONLY]` — já coberto (`canSee` devolve `false`, `consume` devolve `not_found`) |
| Node `disabled` | `[TEST]` `[MOCK ONLY]` — já coberto |
| Execução fora de distância revalidada no `execute` (não só `canSee`) | `[TEST]` contra pipeline real (mock de `mp`) — já coberto |
| Replay/duplicate request | **Gap confirmado, não corrigido** — ver abaixo |
| Disconnect durante mineração | N/A ao fluxo atual — ver abaixo |
| Death/downed tentando minerar | `[NOT TESTED]` — `death-service.js` não foi integrado a `mining-service.js`; nenhuma checagem de estado "morto/downed" existe em `mining-service.js` hoje. Classificação: **undefined** (nem bloqueado nem permitido explicitamente — simplesmente não é checado) |

### Replay / duplicate request — gap real, confirmado em código, não corrigido

`[LOCAL CODE]`: `interactionRegistry.register({...})` em `mining-service.js:153-161` **não** declara `idempotent: true`. Conferido em `core/interaction-service.js:358-360` — `requiresRequestId: entry.idempotent` — e no bloco de dedup (`core/interaction-service.js:410-450`), que só roda quando o cliente manda `requestId` **e** a interação é `idempotent`. Como `mining.mine` não é, o framework **nunca deduplica** duas execuções com o mesmo `requestId` para esta interação especificamente — cada chamada de `execute()` roda `resource-node-service.consume()` de novo, do zero. `resource-node-service.consume()` também não tem idempotência própria (não recebe nem verifica `requestId`). **Duas chamadas de rede idênticas (retry de cliente, replay de payload) consomem o nó duas vezes e entregam item duas vezes.** Isto é diferente de duplo-clique no menu (que `activeGatherers` já bloqueia enquanto uma tentativa está em voo) — é sobre a MESMA requisição sendo processada mais de uma vez.

Não corrigido nesta rodada: adicionar `idempotent: true` exigiria também o cliente gerar e enviar `requestId` — e o cliente, como documentado acima, nem chega a disparar `mining.mine` hoje. Corrigir só o lado servidor sem o cliente enviar nada seria mudança sem efeito observável, e o critério do §33 pede evidência + mudança pequena + sem arquitetura nova; aqui a "arquitetura" (idempotência ponta-a-ponta) já existe no framework — só falta ligar os dois lados, o que depende da mesma feature de cliente ausente da seção anterior. **Registrado como achado, não corrigido.**

### Disconnect durante mineração

`[LOCAL CODE]`: a execução de `mining.mine` é **síncrona** — um único `await resourceNodeService.consume(...)` dentro de `execute()`, sem `setTimeout` nem estado "em progresso" exposto entre requisição e resposta (diferente de `jobs-service.chopWood`, que tem 10s de espera real). **`disconnect during mining = não aplicável ao fluxo atual`** — não há janela de tempo em que o servidor considera alguém "minerando" além da duração de uma única chamada de rede + uma transação MySQL, que ou completa ou não. Confirmado por leitura do código, não presumido.

---

## Changes Required

1. `core/range-utils.js`: `getLoc()` não tratava exceção de `mp.get()` para `formId` inexistente — comprovadamente errado contra o comportamento real do addon upstream, mudança pequena, testável, sem arquitetura nova. **Critério do §33 satisfeito nos 5 pontos.**
2. Nada mais atende aos 5 critérios do §33 simultaneamente. Os outros dois achados relevantes (ausência de trigger de cliente para `object`, ausência de idempotência ponta-a-ponta) são **documentados, não corrigidos** — o primeiro é feature de cliente fora do escopo de "resolver mínimo"; o segundo depende do primeiro para ter efeito observável.

## Changes Applied

| Mudança | Arquivo | Tipo de commit sugerido (§44) |
|---|---|---|
| `getLoc()` captura exceção de `mp.get()`, devolve `null` (mesmo contrato de "não sei onde isto está" que já existia) | `core/range-utils.js` | `fix/runtime resolver` |
| 5 testes novos provando o comportamento antes-inexistente (lança → agora falha limpa) | `core/range-utils.test.js` (novo arquivo, primeiro teste deste módulo) | mesmo commit do fix, ou separado — ver Next Safe Step |
| Instrumentação `ENABLE_MINING_RUNTIME_DIAGNOSTICS`: loga (nunca decide) `target_received`/`target_resolved`/`execute_start`/`tool_check`/`form_desc_resolved`/`resource_node_consume`/`profession_xp_granted`/`execute_end`, correlacionados por tentativa | `mining-service.js` | `test/runtime instrumentation` |
| `_diagnoseItemCountAvailability()`: no boot, com a flag ligada, chama `mp._sp3ListMethods('Actor'\|'ObjectReference')` e loga se `GetItemCount` está registrado — resolve o Blocker B em runtime real sem teste manual | `mining-service.js` | mesmo commit da instrumentação |
| 7 testes provando que a instrumentação (incluindo `_sp3ListMethods`) está desligada por padrão, correlaciona corretamente, reporta `registrado:true/false` por classe, e não muda nenhum resultado de gameplay | `mining-service.test.js` | mesmo commit da instrumentação |
| Documenta `ENABLE_PROFESSION_SERVICE`, `ENABLE_MINING_SERVICE` (faltavam) e `ENABLE_MINING_RUNTIME_DIAGNOSTICS` (novo) | `.env.example` | mesmo commit da instrumentação |
| Registro dos testes novos | `package.json` | acompanha cada commit correspondente |

Suíte completa depois das mudanças: **1717 → 1729 testes, 0 falhas** (`npm test`), `test:systems` 13/13, `check-test-registry.js` OK (85 testes listados).

---

## What Is Proven

- `locationalData` funciona para `MpObjectReference` comum exatamente como documentado — por leitura do C++ upstream real, a evidência mais forte disponível sem abrir o jogo. `[UPSTREAM CODE]`.
- O pipeline server-side inteiro (Profession gate → Resource Node → Interaction distance → Inventory → XP) está correto **no nível de unidade/integração contra mocks fiéis ao contrato observado das dependências** — 1726 testes, incluindo os 19 de `mining-service.test.js` rodando contra o Interaction Framework real (não mockado).
- Um `formId` inexistente/forjado como alvo agora falha de forma limpa (estágio `DISTANCE`, mensagem específica) em vez de escapar como exceção genérica — `[TEST]`, comportamento novo.
- O gap de idempotência de `mining.mine` é real e está documentado, não hipotético.

## What Is Not Proven

- Que um jogador real consegue, hoje, abrir o menu "Minerar" olhando para um veio — **não consegue**, porque o cliente nunca envia `targetType:'object'`. Isto não é "não testado", é **confirmado negativo** por leitura de código.
- Toda a cadeia contra MySQL real: concorrência (`SELECT...FOR UPDATE` sob carga real), regeneração contra `DATETIME(3)` real, persistência de XP/inventário sobrevivendo a reconexão.
- Toda a cadeia contra Skyrim real: se o item aparece no inventário do jogo, se a animação (comentada, nunca ativa) importa, se `Actor.GetItemCount` responde no formato esperado num cliente de verdade.
- Multiplayer real — dois jogadores, mesmo nó, capacidade 1.
- Comportamento com personagem morto/downed — nem testado nem decidido.

---

## Final Runtime Classification

# **RUNTIME_BLOCKED**

Não por uma causa — por **duas causas independentes empilhadas**, nenhuma delas API server-side incorreta: (Blocker C) o callback que o servidor escuta para eventos de CEF (`mp.onUiEvent`) nunca é chamado pelo SkyMP — achado já rastreado pelo projeto desde 14/08 (`BOUND-004`), reconfirmado nesta sessão contra o upstream ao vivo; e (Blocker D, novo desta sessão) mesmo que C não existisse, nenhuma UI de cliente shipada monta ou envia um alvo `object`. Os dois precisam ser resolvidos, em qualquer ordem, antes de um jogador real conseguir sequer abrir o menu "Minerar".

Não por falha de API — a API central (`locationalData`) está confirmada correta. **Bloqueado porque não existe hoje nenhum caminho de disparo do lado do jogador**: o cliente shipado nunca envia `targetType:'object'` (nenhuma detecção de crosshair, `INTERACTION_TARGET_TYPE` fixo em `'player'`), e `mining-service.js` não registra comando de chat como alternativa. O pipeline server-side por trás disso tem evidência forte de estar correto, mas é inacessível a partir do jogo tal como está hoje.

Isto **não é** `RUNTIME_PARTIAL` no sentido "algumas partes falharam" — é mais específico: **todas as partes server-side investigadas têm evidência favorável (mock consistente + confirmação upstream para a peça mais incerta), e a cadeia trava num ponto anterior a qualquer uma delas, do lado do cliente.**

## Blockers

Ordenados por onde travam na cadeia (ver tabela "Bloqueadores, nomeados" acima para a versão completa):

1. **Blocker C — `mp.onUiEvent` é callback morto (`BOUND-004`, já rastreado desde 14/08, ainda aberto).** Trava ANTES de qualquer outro — sem isto, nenhuma interação deste projeto (não só mining) chega ao servidor pelo caminho da CEF. Não corrigido — cross-cutting, já é item de backlog próprio, fora do escopo de "resolver mínimo do Minerador" (§32/§33).
2. **Blocker D — nenhuma UI/script de cliente envia `targetType:'object'`.** Mesmo com C corrigido, nada dispara `mining.mine` especificamente. Não corrigido — feature de cliente, fora do escopo desta tarefa.
3. **Blocker B — evidência conflitante sobre `Actor.GetItemCount` estar registrado no VM deste servidor** (`BOUND-006`, já rastreado desde 14/08, ainda aberto). Instrumentação nova (`_diagnoseItemCountAvailability`) resolve isto no próximo boot real, sem teste manual — resultado ainda pendente.
4. **MySQL real**: nenhuma instância disponível nesta sessão para os Testes 6, 9, 10, 11, 18, 19 contra banco de verdade. `createBot()` (`BOUND-008`) reduziria — não elimina — a dependência de 2 clientes reais para os Testes 11/12 especificamente.
5. **Cliente Skyrim real**: nenhum disponível nesta sessão para os Testes 1–3, 5, 7, 12, 17. `createBot()` nunca substitui isto para os testes que dependem de CEF/renderização/inventário Skyrim real (ver tabela de classificação).
6. **Idempotência ponta-a-ponta ausente** para `mining.mine` — risco de item duplicado por replay, condicional aos Blockers C e D serem resolvidos primeiro (sem cliente disparando a ação de verdade, o risco é teórico, não explorável hoje).

**Blocker A — `locationalData` — não é mais bloqueador.** Confirmado funcionando (`[UPSTREAM CODE]`), listado na tabela só para completar a nomenclatura A/B/C/D pedida.

## Next Safe Step

Não decidido aqui — depende de qual bloqueador o dono do produto prioriza, mas a ordem de dependência técnica agora é clara:

- **Blocker C (`mp.onUiEvent`/`BOUND-004`) é pré-requisito de tudo que envolve o jogador real** — inclusive de validar Blocker D depois de corrigido. Se o objetivo é "o Minerador é jogável", este é o primeiro item, não o segundo — e não é exclusivo do Minerador: corrigi-lo destrava governance/player-panel/trade/market-stalls/contracts igualmente, o que muda o cálculo de prioridade do dono do produto (é infraestrutura compartilhada, não custo pago só pelo Minerador).
- **Blocker B (`Actor.GetItemCount`) resolve sozinho no próximo boot com a flag de diagnóstico ligada** — nenhuma decisão de produto necessária, só rodar o servidor uma vez e ler o log.
- **Se o objetivo é "confirmar que o server-side está pronto"**: o próximo passo seguro é `MINING_MANUAL_RUNTIME_TEST_PLAN.md` Step 0 (checar Blocker B) e Step 0.5 (checar se Blocker C já foi corrigido em paralelo, testando se `sendUiEvent` produz qualquer log do lado servidor) — ambos não dependem de decisão de produto, só de rodar o servidor.
- A feature de cliente para D (crosshair detection) continua fora do escopo deste pipeline server-side — trabalho de Skyrim Platform/cliente, precisa de rodada própria, e só faz sentido DEPOIS de C estar resolvido (testar D sem C corrigido não provaria nada, porque o evento nunca chegaria ao servidor de qualquer forma).
- **Se o objetivo é "confirmar que o server-side está pronto para quando o cliente existir"**: o próximo passo seguro é executar `MINING_MANUAL_RUNTIME_TEST_PLAN.md` num servidor com MySQL real e o SkyMP real rodando (sem precisar do cliente Skyrim completo — o roteiro usa o truque do DevTools da CEF para simular o clique que o crosshair ainda não sabe disparar), o que resolveria os bloqueadores 2, 3 e valida boa parte do pipeline sem esperar a feature de cliente.

Qualquer um dos dois é razoável; nenhum foi iniciado nesta rodada, conforme pedido (§46, "PARE").

---

## Matriz de Homologação — MINING_RUNTIME_VALIDATION_MATRIX

| Componente | Unit/Mock | Real MySQL | SkyMP real | Skyrim real | 2 clientes | Veredito |
|---|---|---|---|---|---|---|
| Profession gate | PASS | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | Mock-proven; server-side lógica correta |
| Object resolution (cliente→servidor) | N/A | N/A | N/A | N/A | N/A | **FAIL — dois motivos independentes: `mp.onUiEvent` morto (Blocker C, `BOUND-004`) + nenhum trigger de cliente para `object` (Blocker D)** |
| Object resolution (servidor: FormId→node) | PASS | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | Mock-proven |
| Object position (`locationalData`) | PASS (mock) | N/A | NOT TESTED | NOT TESTED | NOT TESTED | **Confirmado por upstream code — evidência forte sem precisar de mock nem de jogo** |
| Distance (cálculo) | PASS | N/A | NOT TESTED | NOT TESTED | NOT TESTED | Mock-proven, pipeline real |
| Distance (formId inválido) | PASS (novo) | N/A | NOT TESTED | NOT TESTED | NOT TESTED | Corrigido e testado nesta rodada |
| Tool check | PASS (mock) | N/A | **NOT TESTED — evidência conflitante sobre registro no VM (Blocker B, `BOUND-006`), diagnóstico novo pendente de boot real** | NOT TESTED | NOT TESTED | Classificado CLIENT TRUSTED por desenho, risco aceito; disponibilidade da API ainda incerta |
| Resource consume (atomicidade) | PASS | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | Mock-proven, ordem de query só |
| Inventory DB | PASS | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | Mock-proven |
| Inventory Skyrim (projeção no cliente) | N/A | N/A | N/A | NOT TESTED | NOT TESTED | Nenhuma evidência |
| XP | PASS | NOT TESTED | NOT TESTED | NOT TESTED | NOT TESTED | Mock-proven |
| Depletion | PASS | NOT TESTED | N/A | N/A | NOT TESTED | Mock-proven |
| Regen | PASS | NOT TESTED | N/A | N/A | N/A | Mock-proven, `Date.now()` mockado |
| Concurrent consume | PASS (ordem, não concorrência) | NOT TESTED | N/A | N/A | NOT TESTED | **`[MOCK ONLY]`, nunca provado sob carga real** |
| Duplicate request | **FAIL (gap confirmado)** | N/A | N/A | N/A | N/A | Sem idempotência ponta-a-ponta para `mining.mine` |

Nenhuma linha recebeu PASS sem teste correspondente citado acima.

---

*Fim do relatório desta rodada. Nenhum Lenhador, Pescador, Fazendeiro, Caçador, Gather Session, Public Work, Specialization, Employment, Business ou expansão de crafting foi iniciado.*
