# Prontidão para o stress test da Fase 0 — Auth, Persistence, Interaction

Data: 2026-08-21. Escopo: AUTH-003/AUTH-04a (PR #42), Persistência de célula + pickup (PR #43, Tarefas 2/5), Interaction Framework (core, já em `main`).

> Mesma disciplina do resto do projeto: nada aqui foi medido contra 10 jogadores reais. Isto é revisão de código com foco em concorrência — acha pontos de falha únicos por leitura e raciocínio, não por carga real. `docs/technical/PERSISTENCE_AUDIT.md` §1 explica por que essa distinção importa.

## Pergunta do pedido: existe SPOF se 10 jogadores usarem o Interaction-Service simultaneamente?

Resposta curta: **um achado real e corrigido** (tick sobreposto em `cell-persistence-service.js`), **um risco não medido e não mitigado** (limite do pool de conexões), e **nada mais encontrado** nas partes que dão pra avaliar por leitura.

### 1. Achado real, CORRIGIDO nesta revisão: tick sobreposto em `cell-persistence-service.js`

`initCellPersistenceService` chama `setInterval(() => tick()..., TICK_INTERVAL_MS)` — 2000ms fixos, **sem esperar o tick anterior terminar**. Com poucos jogadores, um tick conclui bem antes dos 2s. Sob carga — 10 jogadores, cada um podendo disparar um `SELECT` de reidratação ao trocar de célula — um tick pode ultrapassar 2s, e o próximo dispara em cima dele.

**Cenário concreto:** dois jogadores A e B entram na MESMA célula nova dentro da janela de um tick lento. O primeiro tick processa A, marca `_lastCellByActor` (protegendo A contra reprocessamento), e começa a `await rehydrateCell(cell, A)` — só alcança B depois que essa `await` resolver. Se um SEGUNDO tick dispara nesse meio-tempo e também alcança B (que o primeiro tick ainda não processou), os dois ticks podem chamar `rehydrateCell` pra uma célula que nenhum dos dois ainda marcou em `_rehydratedCells` — dois `SELECT`, duas rodadas de `PlaceAtMe` pros mesmos objetos. Resultado: referências duplicadas no mundo, uma delas órfã (o segundo `UPDATE ref_desc` sobrescreve o rastro da primeira, e a referência mais antiga fica sem dono, sem poder ser pega nem despawnada por `removeObject`).

**Corrigido:** guarda `_tickInFlight` — um segundo tick que dispara enquanto o primeiro ainda roda é pulado (com aviso no log), não executado em paralelo. Isso é seguro porque pular só atrasa a detecção de troca de célula até o próximo ciclo (2s depois); nunca perde uma troca, porque `_lastCellByActor` continua correto pro próximo tick avaliar. Testado (`cell-persistence-service.test.js`, describe "tick sobreposto"): um SELECT artificialmente lento (50ms) com dois `tick()` disparados em sequência sem aguardar o primeiro produz **exatamente uma** chamada de `PlaceAtMe`, não duas.

### 2. Risco não medido: tamanho do pool de conexões MariaDB

`apps/game-api/server.js` usa `connectionLimit: 5`; `skymp/gamemode/database.js` usa `connectionLimit: 10`. Cada drop (`recordDrop`) faz uma transação em `transaction-service` (que já abre e fecha sua própria conexão) mais um `INSERT` em `world_objects` — duas idas ao banco. Cada pickup (`removeObject`) faz um `UPDATE` condicional, um `SELECT` de fallback (só quando o cache falha) e o `giveItem` do `transaction-service` — até três.

Com 10 jogadores fazendo drop/pickup **ao mesmo tempo**, é plausível que o pool de 10 conexões do gamemode fique momentaneamente saturado. O `mysql2` com `waitForConnections: true` (ambos os pools) **não falha** nessa situação — enfileira a próxima query até uma conexão liberar. Isso significa que o pior caso não é erro, é **latência**: um pickup que deveria ser instantâneo pode esperar na fila do pool atrás de outras 9 operações.

**Não medido, porque não há como medir sem carga real.** Fica registrado como candidato a gargalo de latência, não como bug — a mesma recomendação de `PERSISTENCE_AUDIT.md` §9 ("medir antes de limitar") vale aqui: não subir o `connectionLimit` às cegas antes de ter um número real de quanto 10 jogadores simultâneos de fato geram de tráfego de banco.

### 3. Interaction Framework em si: nenhum SPOF novo encontrado

- **Deduplicação de `requestId`** (`core/interaction-service.js`, `seen` Map): TTL de 120s, chave é `(actorId, requestId)`. Dez jogadores diferentes não colidem entre si — cada um tem seu próprio espaço de chave. Sem crescimento sem limite: `sweepDedup` varre por TTL a cada chamada.
- **Rate limiter** (`core/ui-event-rate-limiter.js`, compartilhado entre `ui-event-gateway` e `interaction-service`): teto **desligado por padrão** (`UI_EVENT_RATE_LIMIT_MAX_EVENTS` vazio = só mede, não bloqueia — documentado assim de propósito, "medir antes de limitar"). Isso significa que, na configuração padrão, **nada impede 10 jogadores de gerar `interaction:query` sem limite** — não é um SPOF (o pipeline resolve cada consulta independentemente, sem lock compartilhado), mas é uma ausência de proteção que a própria arquitetura já assume como decisão consciente, não descoberta nova.
- **Resolvedor de `TARGET_TYPES.OBJECT`** (Tarefa 5): leitura pura de `Map` em memória (`_activeObjectsById`), O(1), sem I/O. Não é gargalo mesmo sob concorrência alta.
- **`world_object.pickup.execute`**: já analisado na Tarefa 5 — o `UPDATE ... WHERE state='active'` condicional é o que resolve concorrência real (dois jogadores pegando o mesmo item), não uma fila ou lock explícito. InnoDB serializa o `UPDATE` na mesma linha; um dos dois sempre vê `affectedRows=0`. Nenhum SPOF aqui além do pool de conexões já citado no item 2.

### 4. Auth (`apps/game-api`, PR #42): revisitando com a lente de concorrência

Já documentado na revisão adversarial do AUTH-002 (`docs/technical/AUTH_002_OPAQUE_TICKET_V1.md`), mas vale repetir no contexto de 10 jogadores: `queue.js` e `pollGrants.js` são `Map`s em memória de um processo único — não há lock explícito porque Node é single-threaded e cada handler HTTP roda até o próximo `await` sem interleaving no meio de uma seção crítica síncrona. Dez jogadores entrando na fila ao mesmo tempo não corrompem o estado da fila; a ordem de admissão pode variar (não há garantia FIFO estrita sob concorrência de rede), mas isso já era esperado, não é um SPOF novo.

## Conclusão

Um achado real corrigido (tick sobreposto), um risco de latência documentado e deliberadamente não mitigado sem dados (pool de conexões), nada além disso descoberto por leitura. **Isto não substitui o teste de dois clientes reais** — só reduz a chance de ele encontrar um bug de concorrência óbvio que já dava pra ver no código. Ver `FASE_0_TWO_CLIENT_TEST_PROTOCOL.md` para o protocolo real.
