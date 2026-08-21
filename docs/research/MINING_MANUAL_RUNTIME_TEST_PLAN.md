# Plano de Teste Manual — Minerador em Runtime Real

**Companheiro de:** [`MINING_RUNTIME_VALIDATION_REPORT.md`](MINING_RUNTIME_VALIDATION_REPORT.md) · **Motivo de existir:** esta sessão não teve acesso a MySQL real, SkyMP rodando nem cliente Skyrim (ver "Runtime Environment" naquele relatório) — este roteiro é o que falta para sair de `RUNTIME_BLOCKED` com evidência real, não suposição. **Branch fixa: `feat/skyvoice-core-etapa-2`** — confirmado nesta sessão (`git fetch origin` + `git diff --stat feat/skyvoice-core-etapa-2...origin/main` vazio) que não há conteúdo de `main` faltando aqui; a divergência de 23 commits à frente / 1 atrás é só topologia de merge (PR #27).

**Dois pré-requisitos que este plano assume e explica** (ver relatório, "Bloqueadores, nomeados"):

1. **Blocker C** (`mp.onUiEvent` morto, `BOUND-004`, já rastreado desde 14/08 em `SKYMP_INTEGRATION_AUDIT.md`, ainda aberto): o caminho normal CEF→servidor pode simplesmente não entregar nada ao servidor, para NENHUMA interação deste projeto — não é específico do Minerador. **Step 0.5** abaixo testa isto primeiro, antes de qualquer coisa sobre mineração especificamente.
2. **Blocker D**: o cliente shipado (`skymp/ui/index.html`) não tem detecção de crosshair — `mining.mine` nunca é disparado pela UI normal mesmo que C funcione. Este plano usa o DevTools da CEF para simular manualmente o que uma futura feature de cliente faria — é uma ponte de teste, não uma correção do gap, e só funciona SE Blocker C também não estiver bloqueando.

Se o Step 0.5 mostrar que Blocker C está bloqueando de verdade, os passos de "Client A/B Steps" abaixo **não vão funcionar** até `BOUND-004` ser corrigido separadamente (fora do escopo deste plano) — pare ali e registre o resultado, não invente workaround na hora.

---

## Preparation

1. Servidor SkyMP local funcionando com MySQL real conectado (`scripts/phase0/Start-Phase0Server.ps1`, conforme `docs/technical/SKYMP_SERVER_SETUP.md`).
2. Cliente SkyMP instalado (`scripts/phase0/Install-SkyMPClient.ps1` / `Start-SkyMPClient.ps1`).
3. Acesso de leitura ao MySQL (`mysql -u <user> -p <database>` ou equivalente) para os "Database Checks" abaixo — **não** execute nenhum `UPDATE`/`DELETE` manual durante o teste; só leitura, para não mascarar o que o código realmente fez.
4. Um objeto estático/interativo do mundo já conhecido (formId decimal e hex, cela) para servir de veio — qualquer `MpObjectReference` existente no mapa vanilla serve para o teste de leitura de posição; não precisa ser minério de verdade até a etapa de nó real.

## Server Flags

Em `skymp/gamemode/.env` (não committar):

```
ENABLE_INTERACTION_FRAMEWORK=true
ENABLE_PROFESSION_SERVICE=true
ENABLE_MINING_SERVICE=true
ENABLE_MINING_RUNTIME_DIAGNOSTICS=true
```

`ENABLE_MINING_RUNTIME_DIAGNOSTICS=true` liga o log estruturado adicionado nesta rodada (`[mining:diag] <correlationId> <estágio> <json>`) — é o que permite correlacionar o que o cliente reportou com o que o servidor decidiu, sem precisar instrumentar nada na hora. **Desligue depois do teste** — é andaime, não gameplay (mesmo espírito de `ENABLE_FAUNA_CENSUS`/`ENABLE_CORPSE_PROBE`).

## DB Seed

Conceder a profissão `miner` ao personagem de teste (substitua `<characterId>`):

```sql
-- Confirme o characterId do personagem de teste primeiro:
SELECT id, account_id, name FROM characters WHERE account_id = <seuAccountId>;

-- Conceder via comando de staff é preferível (audita quem concedeu), mas se
-- for inserir direto para acelerar o setup:
INSERT INTO character_professions (character_id, profession_code, status, rank, xp, joined_at, updated_at)
VALUES (<characterId>, 'miner', 'active', 0, 0, NOW(), NOW());
```

Preferível: usar o comando de staff real (`/setprofissao <characterId> miner grant`, ou o equivalente que `admin-actions.js` expõe) — isso também exercita o caminho de concessão real, não só o dado.

## Step 0 — Blocker B: `Actor.GetItemCount` está registrado? (sem precisar de jogador)

Com `ENABLE_MINING_RUNTIME_DIAGNOSTICS=true` e o servidor apenas **subindo** (não precisa de nenhum cliente conectado — `initMiningService()` roda no boot do módulo), procure no log:

```
[mining:diag] boot itemcount_availability_check {"className":"Actor","registrado":<true|false>,"totalMetodos":N}
[mining:diag] boot itemcount_availability_check {"className":"ObjectReference","registrado":<true|false>,"totalMetodos":N}
```

Isto substitui a "conferência de dez minutos" que `docs/research/SKYMP_INTEGRATION_AUDIT.md` (achado nº 5, `BOUND-006`) deixou em aberto desde 14/08/2026. Leia o resultado:

- `registrado:false` nas duas linhas → **PAPYRUS FUNCTION NOT AVAILABLE**. É `Actor.pex` (ou o script que registra `GetItemCount` em `ObjectReference`) ausente dos `archives`/scripts carregados — confirme `server-settings.json`/`server-settings-merged.json` (`archives`) e `data/scripts/`. Não adianta prosseguir para testar picareta com jogador — vai falhar sempre, por motivo de configuração, não de lógica de `mining-service.js`.
- `registrado:true` para `ObjectReference` mas `false` para `Actor` → achado a registrar: o dispatcher do VM aparentemente não resolve por herança de classe Papyrus. `mining-service.js:_hasPickaxe` chama com `className:'Actor'` — precisaria mudar para `'ObjectReference'` (mudança de uma linha, só depois deste resultado confirmar que é necessário).
- `registrado:true` para `Actor` → Blocker B **não é o problema**. Qualquer falha de `_hasPickaxe` em teste posterior é **TOOL NOT PRESENT** (personagem sem picareta de verdade) ou **PAPYRUS FUNCTION AVAILABLE BUT CALL FAILED** (argumento errado, `self` malformado) — nunca falta de registro.

Se `mp._sp3ListMethods` não existir nesta versão do SkyMP, a linha `itemcount_availability_check_skipped` aparece em vez disso — registre a versão do SkyMP rodando, pode ser uma diferença de build.

## Step 0.5 — Blocker C: o caminho CEF→servidor está vivo?

Antes de tentar qualquer coisa sobre mineração: confirme que o servidor recebe ALGUMA coisa da CEF, testando com uma interação mais simples que já existe (ex.: abrir o painel do jogador, `/painel`, ou qualquer ação de `governance` já registrada).

1. Com um cliente conectado, dispare qualquer ação que já use `interaction:query`/`interaction:execute` pela UI normal (não pelo truque do DevTools ainda).
2. Procure no log do servidor por `[phase0] onUiEvent callback from <actorId>: type=...`.
3. **Se a linha aparecer**: Blocker C não está bloqueando (ou já foi corrigido por outra via) — prossiga normalmente para os passos de Cliente A/B abaixo.
4. **Se a linha NUNCA aparecer**, mesmo com o cliente claramente interagindo pela UI: Blocker C está confirmado bloqueando ao vivo — `BOUND-004` (`mp.onUiEvent` morto) é real neste servidor. **Pare aqui.** Registre isto como o achado principal desta rodada de teste manual — não force o truque do DevTools abaixo, ele vai reproduzir o mesmo silêncio, não é bug do Minerador especificamente.

## Node Setup

Crie um nó de teste com capacidade pequena e observável (evite números grandes — o objetivo é ver esgotamento e regeneração rápido, não simular economia real):

```sql
INSERT INTO resource_nodes
  (form_desc, type, resource_base_id, yield_per_action, max_capacity, current_capacity, regen_per_hour, required_profession, required_rank, enabled, last_updated_at, created_at)
VALUES
  ('<hexSemPrefixo>:Skyrim.esm', 'ORE', <resourceBaseIdDecimalOuHex>, 1, 3, 3, 60, 'miner', 0, 1, NOW(3), NOW());
```

- `form_desc`: o FormDesc do objeto físico escolhido no Preparation — **sem `0x`**, formato `"<hex>:<arquivo>"` (ver `CLAUDE.md` do projeto — `0x162e2` é o erro clássico que não lança e só falha em silêncio).
- `regen_per_hour: 60` é deliberadamente alto só para o Teste 10 (regeneração) terminar em minutos, não em horas — reverta para um valor de produção depois, isto não é decisão de balanceamento, é conveniência de teste.
- Se preferir, use `resource-node-service.createNode(...)` via um script Node pontual em vez de `INSERT` direto — mais fiel ao caminho real (`isValidFormDesc`/`isValidType` validam antes de gravar).

## Client A Steps

1. Conectar ao servidor, carregar o personagem com a profissão `miner` concedida.
2. Andar até o objeto físico escolhido (o mesmo `form_desc` do seed) e ficar bem perto (dentro de `mining.maxDistance`, default 200 unidades ≈ alguns metros).
3. **Abrir o DevTools da CEF** (atalho padrão do SkyMP para inspecionar a UI — geralmente uma tecla configurável no client `settings.json`; se não souber qual, procure `debugCef`/`cefDebug` na config do launcher).
4. No console do DevTools, obtenha o FormId do objeto mirado. Se não houver forma direta pela UI, use o FormId que você já sabe (o mesmo do seed, convertido para decimal).
5. Dispare a consulta manualmente, no console:
   ```js
   sendUiEvent('interaction:query', { targetType: 'object', targetId: <formIdDecimalOuHex> });
   ```
6. Observe a resposta (`updateInteractionActions`/`state.interaction.sections` no DevTools, ou o log do servidor). Se `mining.mine` aparecer nas ações, o `canSee` funcionou — **primeira confirmação real de que `locationalData` resolveu o objeto**.
7. Execute a ação:
   ```js
   sendUiEvent('interaction:execute', { action: 'mining.mine', targetType: 'object', targetId: <mesmoFormId> });
   ```
8. Anote a mensagem de retorno e o horário exato (para casar com os logs do servidor no passo seguinte).

## Client B Steps (Teste 12 — dois jogadores reais)

**Alternativa a considerar antes de coordenar dois clientes Skyrim de verdade**: `mp.createBot()` (`[UPSTREAM CODE]`, ver `MINING_RUNTIME_VALIDATION_REPORT.md` "`createBot()` — o que ele reduziria") cria um segundo ator autenticado dentro do próprio processo do servidor, sem precisar de uma segunda instalação de Skyrim — suficiente para os Testes 11/12 especificamente (concorrência em `resource_node_consume`), mas **não** prova nada sobre CEF, `locationalData` visual ou inventário Skyrim real. Se o objetivo desta rodada é só a concorrência de `SELECT...FOR UPDATE`, um script com dois `createBot()` chamando a interação diretamente é mais barato que coordenar dois humanos — mas não substitui este roteiro para os demais testes.

1. Repita "Client A Steps" 1–3 com um segundo cliente, mesmo nó, ao mesmo tempo que o Cliente A está por perto.
2. **Cenário capacidade=2**: seed o nó com `max_capacity=2, current_capacity=2`. Ambos os clientes executam `mining.mine` em sequência (não precisa ser exatamente simultâneo). Esperado: os dois recebem 1 cada, capacidade final 0.
3. **Cenário capacidade=1**: reseed para `current_capacity=1`. Os dois clientes disparam `interaction:execute` o mais próximo possível um do outro (peça para os dois pressionarem Enter no DevTools ao mesmo tempo, contando "3, 2, 1"). Esperado: **exatamente um** recebe o minério; o outro recebe a mensagem de `depleted`. Nunca os dois com sucesso.
4. Anote os `correlationId` de cada tentativa (do log `[mining:diag]`) e os timestamps — é o que permite reconstruir a ordem real depois.

## Database Checks

Antes de cada mineração, registre o estado:

```sql
SELECT id, form_desc, current_capacity, max_capacity, last_updated_at FROM resource_nodes WHERE form_desc = '<formDesc>';
SELECT count FROM character_inventory WHERE character_id = <characterId> AND base_id = <resourceBaseId>;
SELECT rank, xp, status FROM character_professions WHERE character_id = <characterId> AND profession_code = 'miner';
```

Depois de cada mineração bem-sucedida, confirme:

- `resource_nodes.current_capacity` caiu exatamente `yield_per_action` (Teste 6).
- `character_inventory.count` subiu exatamente `yield_per_action` — se a linha não existia antes, ela deve existir agora com `count = yield_per_action` (Teste 6/7).
- `character_professions.xp` subiu exatamente `mining.xpPerGather` (default 2) — **só** se `required_profession` do nó bater com a profissão do personagem (Teste 8).
- Ledger da transação:
  ```sql
  SELECT * FROM inventory_transactions
  WHERE owner_type='character' AND owner_ref='<characterId>'
    AND counterparty_type='system'
  ORDER BY id DESC LIMIT 5;
  ```
  Confirme **uma linha só** por mineração (não duas, não zero) — isso é o Teste 15 (duplicate request) na prática: se você repetir a MESMA `interaction:execute` (mesmo `requestId`, se o cliente gerar um) e ver **duas** linhas de ledger para o mesmo evento, o gap de idempotência documentado no relatório se materializou — capture a evidência (prints das duas linhas + os dois `correlationId`) em vez de "corrigir" ali; é achado, registre.

Para o Teste 9 (depletion) e Teste 18 (node disabled), repita a leitura acima após a segunda tentativa: capacidade não deve mudar, inventário não deve mudar, XP não deve mudar, mensagem deve ser a de esgotado/desabilitado.

Para o Teste 19 (rank gate), rode três minerações com o mesmo nó (`required_rank=2`) em três personagens/estados diferentes: rank 1 (deve recusar), rank 2 (deve permitir), rank 3 (deve permitir) — confirme com:
```sql
UPDATE character_professions SET rank = <valor> WHERE character_id = <characterId> AND profession_code = 'miner';
```
(único `UPDATE` direto justificável neste roteiro — é para forçar o cenário de teste, não para "corrigir" nada).

## Expected Logs

Com `ENABLE_MINING_RUNTIME_DIAGNOSTICS=true`, cada tentativa de minerar produz, no log do servidor, linhas como:

```
[mining:diag] n/a target_received {"formId":"0x...","targetType":"object"}
[mining:diag] n/a target_resolved {"nodeFound":true,"rawNode":{...}}
[mining:diag] mine-42-xxxxx-yyyyyy execute_start {"characterId":42,"actorId":"0x...","targetFormId":"0x...","requestId":null}
[mining:diag] mine-42-xxxxx-yyyyyy tool_check {"hasPickaxe":true,"source":"Actor.GetItemCount (client-trusted, só decide inicio)"}
[mining:diag] mine-42-xxxxx-yyyyyy form_desc_resolved {"formDesc":"..."}
[mining:diag] mine-42-xxxxx-yyyyyy resource_node_consume {"ok":true,"code":null,"data":{...}}
[mining:diag] mine-42-xxxxx-yyyyyy profession_xp_granted {"professionCode":"miner","amount":2}
[mining:diag] mine-42-xxxxx-yyyyyy execute_end {}
```

`target_received`/`target_resolved` sempre carregam `n/a` (não pertencem a uma tentativa específica — `canSee` roda tanto na consulta quanto de novo dentro de `execute`, ver relatório). Todas as linhas de UM `execute()` carregam o MESMO `correlationId` (`mine-<characterId>-<timestamp>-<random>`) — é isso que permite filtrar o log de uma tentativa específica em meio a outras.

## Failure Signatures

| Sintoma | Onde olhar primeiro |
|---|---|
| `interaction:query` não devolve `mining.mine` nas ações | `target_resolved` no log — `nodeFound:false` significa `form_desc` do seed não bate com o que `mp.getDescFromId` calculou para o `formId` enviado. Confira o `form_desc` gravado contra o formato canônico (`docs/technical/SKYMP_UPSTREAM_REFERENCE.md` §8.5) |
| Erro não tratado no console do servidor ao consultar objeto distante/inexistente | Se isto acontecer, a correção desta rodada (`core/range-utils.js`) tem um bug — capture o stack trace completo, é uma regressão do que os 5 testes novos deveriam ter coberto |
| `execute` devolve sucesso mas `character_inventory` não mudou | Verifique `resource_node_consume` no log — se `ok:false`, o servidor já recusou (comportamento correto, mensagem deveria ter refletido isso ao jogador; se a UI mostrou sucesso mesmo assim, é bug de UI, não de servidor) |
| Dois jogadores, capacidade 1, os dois recebem item | **Achado crítico** — a garantia de `SELECT...FOR UPDATE` não se sustentou sob MySQL real. Capture os dois `correlationId`, os dois logs `resource_node_consume`, e a linha de `resource_nodes` antes/depois. Não tente corrigir no calor do teste. |
| XP não muda mesmo com `required_profession` batendo | Confira `mining.xpPerGather` em `server-options`/`.env` — se for `0`, o comportamento é o esperado (código já recusa creditar XP=0) |

## PASS Criteria

- `mining.mine` aparece no menu quando o objeto certo é mirado, some quando não é.
- Execução dentro de `mining.maxDistance` entrega item + XP; fora recusa no estágio de distância.
- `formId` forjado/inexistente recusa de forma limpa (não derruba o servidor, não aparece stack trace de exceção não tratada no console).
- Capacidade decrementa exatamente `yield_per_action`, nunca mais, nunca menos, mesmo sob dois clientes concorrentes na capacidade=1.
- Inventário e XP no banco batem exatamente com o que o log de diagnóstico registrou.
- Nó esgotado/desabilitado nunca entrega item nem XP na segunda tentativa.
- Gate de rank comporta-se conforme a tabela do Teste 19.

## FAIL Criteria

- Qualquer exceção não tratada no console do servidor durante o fluxo normal.
- Dois jogadores recebendo item da mesma unidade de capacidade (duplicação real).
- Item ou XP creditado sem a profissão/rank exigidos.
- Capacidade não decrementando, ou decrementando errado.
- Mensagem de sucesso ao jogador sem mudança correspondente no banco.

## Evidence To Save

- Cópia bruta do log do servidor da sessão inteira (com `ENABLE_MINING_RUNTIME_DIAGNOSTICS=true`).
- Resultado das queries de "Database Checks" antes/depois de cada teste, com timestamp.
- Para o Teste 12 (dois clientes): os dois `correlationId` e a ordem real observada.
- Prints/gravação do DevTools mostrando a resposta de `interaction:query`/`interaction:execute`.
- Se algo falhar: o `MINING_RUNTIME_VALIDATION_REPORT.md` deve ser atualizado com o resultado real (`[SkyMP real]`/`[Skyrim real]`/`[2 clientes]` nas linhas da matriz que passarem a ter evidência), não só este plano.

---

*Este plano não foi executado nesta sessão — nenhum ambiente com MySQL real, SkyMP real e cliente Skyrim estava disponível. Classificação permanece `RUNTIME_BLOCKED`/`RUNTIME_NOT_EXECUTED` até alguém rodar isto e atualizar o relatório com os resultados reais.*
