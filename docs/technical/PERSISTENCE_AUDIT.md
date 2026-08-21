# Auditoria de performance — Persistência de Estado de Célula

Data: 2026-08-21. Escopo: `skymp/gamemode/cell-persistence-service.js`, `migration-v20-world-objects.sql`.

> Mesma disciplina do resto do projeto: o que está medido está marcado como medido, o que é inferência está marcado como inferência, e nada aqui foi visto contra um MariaDB real ou um cliente Skyrim real. Ver `docs/technical/QA_REPORT_2026-08.md` §1 para o padrão.

## 1. O que foi medido, e como

Os 24 testes de `cell-persistence-service.test.js` rodam contra um banco **fake em memória** (um array JS + regex sobre o SQL, não MariaDB), incluindo os três testes de estresse com 100 itens. Isso prova **corretude lógica**: nenhuma linha perdida, nenhum ID duplicado, coordenadas idênticas antes/depois de um "restart" simulado, e reidratação repetida não escreve linha nova. **Não prova nada sobre latência real** — o fake não tem round-trip de rede, connection pool, nem lock de InnoDB. Todo número de performance abaixo é estimativa de código, não benchmark.

## 2. Padrão de escrita

Um `INSERT` por `recordDrop` bem-sucedido, independente de o item persistir para sempre ou ser lixo com TTL — os dois viram linha, só o `expires_at` muda. Cada `recordDrop` também é um `removeItem` (transaction-service, com `beginTransaction`/`commit` próprios) **antes** do INSERT em `world_objects`, então um drop custa **duas idas ao banco em sequência**, não uma. Se a segunda falhar, o código reverte a primeira via `giveItem` — mais uma ida ao banco no caminho de erro (ver `recordDrop`, bloco `catch`).

Volume esperado: cada drop de jogador é uma ação deliberada (comando de chat), não um evento de física por quadro — a ordem de grandeza é "dezenas por jogador por sessão", não "por segundo". Não há hoje nenhum caminho que gere `world_objects` em lote (ex.: um NPC morto derramando inventário) — se um sistema desses for adicionado depois, esta análise de volume precisa ser refeita.

## 3. Padrão de leitura

Um `SELECT` por reidratação de célula, filtrado por `cell_id` + `state='active'` + `expires_at`, coberto pelo índice `idx_world_objects_cell (cell_id, state)`. A reidratação é **por processo**, não por jogador: `_rehydratedCells` (Set em memória) garante que a segunda pessoa entrando na mesma célula, enquanto o servidor está de pé, não gera outro SELECT — só o primeiro a chegar paga o custo. Isso é bom para carga de banco e é exatamente o motivo de o teste "carga do banco não cresce por reidratação repetida" existir.

**O reverso é o risco:** se a call `mp.get(actorId, 'locationalData')` mentir sobre `cellOrWorldDesc` uma única vez (bug de engine, corrida de estado), `_rehydratedCells` pode achar que uma célula com gente dentro nunca foi hidratada, ou vice-versa — e não há caminho pra forçar reidratação manual hoje. Não medido; listado como risco de design, não como bug encontrado.

## 4. O tick (2s)

`tick()` roda a cada `TICK_INTERVAL_MS` (2000ms, mesmo intervalo de `nametag-service` e `voip-service` — não coincidência, é o mesmo raciocínio de custo O(n²)/O(n) que já levou a esse número nos outros dois) e faz, por ator ativo:

1. Uma leitura de `locationalData` (property já em cache do servidor, sem ida ao Papyrus — mesmo argumento de custo que `safe-zones.js` já usa).
2. Comparação de string contra o cache local (`Map`, O(1)).
3. Só se a célula mudou: o SELECT da seção 3.

Ao final do tick, sempre roda `sweepExpired()` — um `DELETE` incondicional, coberto pelo índice `idx_world_objects_expiry (expires_at)`. **Este é o ponto de maior incerteza de custo:** o `sweepExpired` roda a cada tick **globalmente**, não por célula — com N jogadores conectados em N células diferentes, ainda é um `DELETE` só, mas ele varre a tabela inteira (via índice) mesmo se nenhuma célula ativa tiver lixo expirado naquele instante. Não medido quantas linhas de lixo se acumulam entre varreduras sob uso real; a suíte de teste só prova que o DELETE remove o que deveria e preserva o resto.

## 5. Spawn (`PlaceAtMe`)

Custo por chamada não medido — mesma lacuna que `market-stalls-service.spawnStallVisual` já tinha antes desta auditoria. É uma chamada Papyrus (`mp.callPapyrusFunction('method', 'ObjectReference', 'PlaceAtMe', ...)`), da mesma classe de custo que o `REFERENCE_STUDY_SKYMP_RED_HOUSE.md` §4.1 mediu em 13–35ms por chamada **para outras funções** (`getEquipment`, `av.set`) — não para `PlaceAtMe` especificamente. Assumir o mesmo custo é extrapolação, não medição.

**Isto importa para reidratação de célula com muitos objetos:** se uma célula tiver, por exemplo, 50 objetos persistidos e alguém entrar nela, `rehydrateCell` chama `_spawnObject` 50 vezes em sequência, síncrono dentro do `tick()`. Se cada `PlaceAtMe` custar de fato dezenas de ms, isso trava o tick daquele ciclo por ~1-2s de chamadas Papyrus em série — **candidato real a gargalo, não verificado.** Mitigação não implementada: paralelizar ou espaçar os spawns entre ticks. Fica registrado como próximo passo, não como decisão de não fazer.

## 6. Crescimento da tabela sem limite — a lacuna mais séria

`world_objects` só perde linha em duas situações: expiração de lixo (`sweepExpired`) ou uma remoção manual no `state`. **Não existe, nesta entrega, um caminho de "pegar o item do chão" que marque a linha como `looted`/`despawned`.** Isso significa que todo item persistido pela allowlist (arma, armadura, quest, container_loot, ou qualquer coisa acima de `MIN_VALUE_THRESHOLD`) fica na tabela **para sempre**, mesmo depois de outro jogador pegá-lo fisicamente do chão — o objeto seria removido do mundo pelo cliente/engine, mas a linha do banco não sabe disso.

Isto não é omissão silenciosa: é o limite real do escopo pedido ("crie `rehydrateCell`", não "crie o ciclo de vida completo de pickup"). Mas é o item que mais precisa de decisão de produto antes de qualquer ambiente com jogadores reais: sem um consumidor que marque `state='looted'` (ou equivalente) no momento do saque, `world_objects` cresce monotonicamente pelo tempo de vida do servidor, e cada linha extra é peso permanente em todo `SELECT` de reidratação futuro na mesma célula.

## 7. Recomendações, em ordem de custo/benefício

1. **Antes de ligar em qualquer ambiente com jogadores reais:** implementar o caminho de pickup (remover/marcar a linha ao interagir com o objeto no mundo). Sem isso, os números desta auditoria pioram sozinhos com o tempo.
2. **Medir `PlaceAtMe` de verdade** na primeira sessão da Fase 0 que tiver isto ligado — mesmo protocolo que `market-stalls-service` já devia ter feito e não fez. Um objeto só, tempo de chamada, log.
3. **Espaçar spawns de reidratação** se uma célula testada tiver dezenas de objetos e o tick travar visivelmente.
4. **Considerar `sweepExpired` em intervalo próprio**, mais espaçado que 2s, se a tabela crescer o suficiente para o DELETE pesar — hoje é prematuro, sem dado de volume real.

## 8. Checklist do `HEAVY_RP_GAMEPLAY_SYSTEMS_BACKLOG.md`

Nenhum item está satisfeito ainda, mesma situação de nametag/gestos/AUTH:

| Pergunta | Status |
|---|---|
| Funciona com dois clientes? | Não testado |
| O servidor recalcula tudo que importa? | Sim — cliente nunca envia posição de spawn |
| Existe log auditável? | Parcial — erros logam; sucesso não grava em `audit_logs` |
| Existe rollback ou correção manual? | Rollback de inventário sim (`recordDrop`); correção manual de `world_objects` não tem ferramenta |
| Sobrevive a reconexão? | Sim, por design (a linha não depende de sessão) |
| Sobrevive a restart do servidor? | Sim — provado por teste com banco fake; não provado com MariaDB real |
| O cliente consegue duplicar item ou dinheiro? | Não analisado além do que `transaction-service` já garante |
