# Resource Node Framework

**Estado: núcleo implementado, com um primeiro consumidor completo.** O
Minerador MVP ([MINING.md](MINING.md)) chama `consume()` com gate de
profissão, checagem de ferramenta e distância medida pelo Interaction
Framework (alvo `object`, novo em `core/interaction-targets.js`) — a única
suposição em aberto é `mp.get(formId,'locationalData')` contra objeto comum,
documentada como não validada em jogo. Isto continua sendo o motor genérico:
um nó com capacidade, regeneração calculada sob demanda, e uma operação
atômica de coleta.

Arquivos: [`core/resource-node-registry.js`](../../skymp/gamemode/core/resource-node-registry.js),
[`resource-node-service.js`](../../skymp/gamemode/resource-node-service.js).

Consome: [Profession Core](PROFESSION_FRAMEWORK.md) (gate por
`required_profession`/`required_rank`), `core/transaction-service.js`
(entrega do item, atômica com o decremento do nó).

---

## 1. O que existe e o que não existe

| Existe | Não existe (Minerador MVP e além) |
|---|---|
| `resource_nodes` (migration v19): capacidade, regen, gate opcional | Nó ligado a um objeto real no mundo com interação de jogador |
| `consume()` atômico: decrementa nó + entrega item numa transação | Sessão de coleta (distância, ferramenta, animação, cancelamento) |
| Regeneração calculada sob demanda (`_computeCapacity`) | Job/tick regenerando nós em background |
| Gate por profissão/rank, reaproveitando `profession-service.js` | Gate por ferramenta equipada (`Actor.GetItemCount`) |
| `createNode`/`setNodeEnabled` (funções puras, sem UI) | Comando de staff para criar/editar nó em jogo |
| 5 categorias fechadas (ORE/TREE/HERB/CROP/FISHING) | Lenhador, Caçador, Pescador (só Minerador existe) |
| Minerador consumindo `consume()` (profissão, ferramenta, distância) | Validação em jogo de `locationalData` em objeto comum ([MINING.md §1](MINING.md#1-como-a-distância-deixou-de-ser-um-gap)) |

---

## 2. Por que não existe uma tabela de "tipo de nó"

Mesma decisão de `migration-v18-professions.sql` para `professions`: um veio
de ferro e um veio de prata são o mesmo `type` (`ORE`) com configuração
diferente — e essa configuração (capacidade, regen, item entregue) mora na
INSTÂNCIA, não num catálogo. `core/resource-node-registry.js` só fecha a
categoria (5 valores), pelo mesmo motivo que `core/audit-event.CATEGORIES` é
fechado: comportamento é decidido por ela, e categoria livre vira quatro
grafias da mesma coisa.

## 3. Por que `required_tool` não é uma coluna

A Fase 0 encontrou `crafting_recipes.requires_perk` — um campo **lido e nunca
comparado com nada**, um cabeçalho afirmando uma validação que não existia.
Este framework não repete isso. "O jogador tem a picareta equipada" exige
`Actor.GetItemCount` ao vivo contra o cliente — checagem de gameplay concreto
(Minerador), não deste framework genérico. `required_profession` e
`required_rank` entram na tabela porque **são** checados, dentro de
`consume()`, contra `profession-service.js`. Adicionar `required_tool` agora
seria criar o mesmo campo morto de novo.

---

## 4. Regeneração: calculada, nunca por tick

```
capacidade_atual = min(max_capacity,
                        capacidade_gravada + floor(ms_decorridos / 3600000 * regen_per_hour))
```

`getNode()` é leitura pura — calcula e devolve, **não grava**. Só `consume()`
grava a capacidade recalculada, porque só ele tem motivo para travar a linha.
Um nó parado por dias sem ninguém tentando colher nunca gera um `UPDATE`
sozinho: o cálculo é sempre "desde o último valor gravado", nunca "desde
sempre", então não há job de fundo, tick por nó, nem custo de servidor
proporcional ao número de nós ociosos — a mesma escolha de desenho que o §26
do briefing de profissões pediu.

`regen_per_hour` é inteiro (não float) — mesma disciplina de rank/XP/gold em
todo o resto do projeto.

---

## 5. Atomicidade de `consume()`

```
BEGIN
  SELECT ... FOR UPDATE          -- trava a linha do nó
  valida enabled, profissão, rank
  recalcula capacidade
  se capacidade < yield:  grava capacidade recalculada, COMMIT, devolve 'depleted'
  senão:
    UPDATE resource_nodes SET current_capacity = capacidade - yield
    transactionService.tx.applyInventoryDelta(conn, ...)   -- mesma transação
    transactionService.tx.recordInventoryLedger(conn, ...) -- mesma transação
  COMMIT
applyToClient(...)               -- depois do commit, banco já é fonte de verdade
```

Duas transações separadas (decrementa nó, depois `giveItem`) deixariam uma
falha no meio destruir o recurso sem entregar o item. Uma só, usando as
primitivas `tx.*` que `core/transaction-service.js` já exporta para isso —
mesmo padrão que `crafting-service.js` usa para consumir ingrediente e
entregar resultado juntos.

## 6. Concorrência

`SELECT ... WHERE form_desc = ? FOR UPDATE` trava a linha do próprio nó.
Duas colheitas concorrentes do mesmo veio serializam: a segunda lê a
capacidade já decrementada pela primeira, nunca a obsoleta — resolve
diretamente o cenário do §25 do briefing ("veio com 1 unidade, dois
jogadores terminam quase no mesmo momento").

---

## 7. API

```js
const resourceNodeService = require('./resource-node-service');

await resourceNodeService.createNode({
  formDesc: '4a2f0:Skyrim.esm', type: 'ORE', resourceBaseId: 0x0005ace4,
  maxCapacity: 20, yieldPerAction: 1, regenPerHour: 2,
  requiredProfession: 'miner', requiredRank: 0
});

await resourceNodeService.getNode('4a2f0:Skyrim.esm');
// → {id, formDesc, type, resourceBaseId, yieldPerAction, capacity, maxCapacity,
//    regenPerHour, requiredProfession, requiredRank, enabled, state}

await resourceNodeService.consume({ characterId, actorId, formDesc: '4a2f0:Skyrim.esm' });
// → {ok:true, data:{formDesc, resourceBaseId, yield, capacity, maxCapacity}}
// → {ok:false, code: 'depleted'|'node_disabled'|'not_found'|'profession_required'|'rank_too_low'|'invalid_character'|'invalid_form_desc'}
```

`createNode`/`setNodeEnabled` não têm capability nem admin-action nesta fase —
não existe hoje nenhuma ferramenta em jogo para posicionar nó. Até uma fase
futura precisar disso de verdade, são chamadas por script de seed (mesmo
padrão de `crafting_recipes` via `seed-forging.sql`).

---

## 8. Testes

`node --test core/resource-node-registry.test.js resource-node-service.test.js`
— cria/valida, regeneração (teto, proporção, arredondamento), leitura pura
não escreve, consumo atômico, esgotamento exato no limite, gate de
profissão/rank, ordem de lock, falha de infraestrutura faz rollback sem
entregar item parcial. `resource-node-service.test.js` também lê
`migration-v19-resource-nodes.sql` e falha se alguma coluna usada pelo
serviço sumir de lá.

Mesma ressalva de `profession-service.test.js`: concorrência real (duas
transações MySQL disputando a mesma linha) não é provável com mock síncrono —
os testes provam a ORDEM das queries, não o comportamento do MySQL de
verdade sob carga.

---

## 9. NOT IMPLEMENTED YET

- Validação em jogo do resolvedor `object` do Interaction Framework contra
  uma `MpObjectReference` real — ver [MINING.md §1](MINING.md#1-como-a-distância-deixou-de-ser-um-gap)
- Sessão de coleta com duração/animação, cancelamento por
  desconexão/morte/movimento
- Lenhador, Caçador, Pescador (só Minerador existe)
- Comando/UI de staff para posicionar nó em jogo
- Fadiga ligada à atividade de coleta (o projeto não tem sistema de fadiga —
  ver §16 do briefing original de profissões)
