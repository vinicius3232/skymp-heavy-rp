# Sistema de crafting

**Estado: ATIVO (lab), reativado em 20/08/2026.** `crafting-service.js` está
registrado em `core/module-registry.js` como módulo `crafting`
(`ENABLE_CRAFTING_SERVICE`, nasce desligado como todo `lab`). A reativação
ganhou o que faltava desde a migração para o Inventory Framework: comandos de
chat (`/craft`, `/receitas`, `/addrecipe`, `/addingredient`) e um gate real de
profissão/rank por receita (`required_profession`/`required_rank`,
migration-v20-crafting-profession-gate.sql), checado dentro de `craftItem()` —
ao contrário de `requires_perk`, que continua lido e nunca comparado. Nenhuma
receita muda comportamento sozinha: o gate é NULL (livre) por padrão, e é a
staff que amarra via `/addrecipe`. Subiu no boot local sem erro; **nunca
rodou numa sessão real com cliente conectado.**

Arquivo: [`crafting-service.js`](../../skymp/gamemode/crafting-service.js).

---

## 1. O que a auditoria encontrou

Três coisas, em ordem de gravidade
([auditoria §5 e §11](../research/INVENTORY_TRADE_CRAFTING_AUDIT.md)):

### 1.1 A chave de idempotência não deduplicava nada

```js
// ANTES
// 3. Uma chave por (personagem, receita, instante) — se o comando for
// reenviado, o ledger recusa a segunda gravacao em vez de craftar duas vezes.
const idempotencyKey = `craft_${characterId}_${recipeId}_${Date.now()}`;
```

O comentário afirmava uma proteção que o `Date.now()` tornava impossível: dois
`/craft` seguidos produziam **duas chaves diferentes**, o `UNIQUE` não era
violado, e o craft acontecia duas vezes.

Uma chave de idempotência vem de **quem pede** (o `requestId` do cliente) ou de
um estado estável. Nunca do relógio de quem executa.

**Corrigido:** `craftItem` aceita `opts.requestId`; sem ele, gera um com
`inventory.newRequestId`, que é aleatório e não temporal.

### 1.2 O cabeçalho anunciava validações que não existiam

> *"O servidor valida ingredientes, station proximity e perks."*

Ingrediente sim, pelo `FOR UPDATE`. **Estação: nunca** — `craftItem` sequer
carregava a estação, então `/craft` funcionava do outro lado do mapa. **Perk:
nunca** — `requires_perk` é lido em `listRecipes` e nunca comparado com nada.

**Corrigido:** o cabeçalho diz a verdade, e `craftItem` passou a conferir que a
estação **declarada** é a da receita. Isso não é proximidade (§5).

### 1.3 A dívida de transação já tinha sido paga na Fase 3

A correção de 07/08/2026 juntou consumo e entrega numa transação pelas
primitivas `tx.*`, e estava certa. O que esta rodada mudou não é atomicidade — é
que o outro lado de cada movimento passou a ter nome no razão.

---

## 2. Como o craft funciona hoje

```
/craft <recipeId>
      │
      ├─ 1. carrega a receita
      ├─ 2. estação declarada == recipe.station_type?      (não é proximidade)
      ├─ 3. carrega os ingredientes
      │      receita sem ingrediente cadastrado é RECUSADA — criaria item do nada
      ├─ 4. requestId (de quem pediu, ou gerado sem relógio)
      └─ 5. inventory.exchange, duas pernas, uma transação:
               personagem      → system:consume    (ingredientes)
               system:craft    → personagem        (resultado)
```

A checagem de estoque não tem passo próprio: o `applyStackDelta` lê com
`FOR UPDATE` e lança se faltar. É estritamente melhor que um `hasItem` antes —
aquele leria fora da transação, e entre a checagem e o consumo o item podia ter
saído por outro caminho.

As duas pernas nomeiam a contraparte `system`, o que faz a soma dos deltas do
razão fechar em zero por `transfer_id` e torna respondível *"de onde saiu este
item?"*.

---

## 3. O modelo de receita

O que existe no banco (`schema.sql`, inalterado nesta rodada):

```sql
crafting_recipes     ( id, name, station_type, result_base_id, result_count, requires_perk )
crafting_ingredients ( id, recipe_id, base_id, count )
```

O §14 do pedido descreve um modelo maior:

| Campo | Estado |
|---|---|
| `id`, `name`, `ingredients`, `output`, `station` | **existe** |
| `requirements` (perk) | coluna existe, **nunca é lida** |
| `duration` | **não existe** — ver §6 |
| profissão, skill, facção, conhecimento, licença, afinidade mágica | **não existem** |

Nenhuma coluna foi adicionada. O §13 do pedido é explícito — *"não implementar
tudo na primeira versão"* — e o critério deste projeto é mais estreito ainda:
coluna sem consumidor é a mesma abstração prematura que seis resolvedores de
alvo adivinhados seriam.

**Quando profissão entrar**, o lugar é uma tabela de ligação
`character_professions` + uma coluna `requires_profession` na receita, e a
checagem entra no passo 2 do fluxo acima, ao lado da estação.

---

## 4. Permissões de staff

Decididas em 07/08/2026 e inalteradas
([`PARKED_SERVICES_DECISION.md`](../technical/PARKED_SERVICES_DECISION.md) §7.4):

| Comando | Permissão | Cargos |
|---|---|---|
| `/addrecipe`, `/addingredient` | `manage_recipes` | `admin`, `owner` |

Não é `add_item`: aquele significa *"dê este item a este jogador"* — ato
pontual, alcance de uma pessoa. Uma receita é uma regra permanente que todo
jogador usa quantas vezes quiser. É casa da moeda, não presente.

---

## 5. Proximidade de estação: o que falta

A checagem que existe compara `opts.stationType` com `recipe.station_type`. Ela
impede forjar uma espada no caldeirão de cozinha. **Ela não impede craftar longe
de qualquer estação**, porque o servidor não sabe onde estão as forjas do mundo:
nenhuma tabela guarda isso e nenhum `formDesc` de estação foi cadastrado.

Proximidade real precisa de duas coisas, nesta ordem:

1. **O resolvedor de alvo `object`** no Interaction Framework
   ([`INTERACTION_FRAMEWORK.md`](../framework/INTERACTION_FRAMEWORK.md) §6). Com
   ele, a estação vira alvo de verdade, o pipeline mede a distância com
   `assertRange` como já faz para jogador, e o `execute` entrega ao
   `craftItem` uma estação **verificada pelo servidor** em vez de declarada
   pelo cliente.
2. Um cadastro de estações (`formDesc` → `station_type`), que hoje não existe.

O §17 do pedido descreve exatamente esse encadeamento:

```
crafting station → interaction → craft.open → receitas permitidas → craft.execute
```

`craft.open` e `craft.execute` **não estão registradas**. Registrá-las hoje
seria registrar ações contra um tipo de alvo sem resolvedor — elas apareceriam
no vocabulário e falhariam em toda chamada.

---

## 6. Fila de crafting: não construída, e é o certo

O §16 do pedido diz *"somente adicionar crafting com tempo se houver
necessidade"*. Não há: nenhuma receita tem duração, nenhuma tela mostra
progresso, e ninguém pediu.

Se entrar, as perguntas que precisam de resposta **antes** da primeira linha:

- **O que acontece na desconexão?** Um craft de 10 minutos com o jogador
  offline ou completa sozinho (e o item aparece do nada, sem ninguém presente)
  ou é perdido (e o ingrediente já foi consumido). As duas são decisões de jogo.
- **Onde os ingredientes ficam durante a fila?** Consumidos na hora, ou em
  custódia? A troca recusou custódia (`TRADE_SYSTEM.md` §6) pelos motivos que
  valem aqui igualmente.
- **O que impede enfileirar 200 crafts?**

Estados seriam `PENDING`/`CRAFTING`/`COMPLETED`/`CANCELLED`, e a fila
precisaria de tabela — porque, diferente da sessão de troca, ela **tem** que
sobreviver ao restart.

---

## 7. O que NÃO está feito

- **Perk não é validado**, apesar da coluna existir.
- **Proximidade de estação não é validada** (§5).
- **Profissão/rank agora É validado** (20/08/2026) — ver o topo deste
  documento e `migration-v20-crafting-profession-gate.sql`. Skill e ferramenta
  continuam de fora (§3).
- **Não há fila nem duração** (§6) — por escolha.
- **Não há interação `craft.open`/`craft.execute`** (§5).
- **Não há UI.**
- **Nenhuma receita de FORJAR arma/armadura existe** — `seed-forging.sql`
  só tem receitas de *derreter* sucata (Fundidor) e uma de curtume
  (Curtidor). O Ferreiro (`blacksmith`) tem o gate pronto e zero receita:
  falta um `result_base_id` de arma/armadura confirmado, não inventado.
- **Nunca rodou numa sessão real.**

## 8. Cobertura

`parked-services-ledger.test.js` exercita o craft pelo caminho real: consumo e
entrega commitam juntos (`['begin','commit']`, não três `begin`), falta de
ingrediente reverte tudo sem nada chegar ao cliente, receita sem ingrediente não
cria item do nada, erro de SQL não vai para a tela, e as seis linhas de razão
somam zero por `transfer_id`.
