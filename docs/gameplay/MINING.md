# Minerador — MVP

**Estado: implementado, distância medida pelo Interaction Framework — com uma
suposição não validada em jogo.** Primeiro consumidor real do
[Profession Core](PROFESSION_FRAMEWORK.md) e do
[Resource Node Framework](RESOURCE_NODE_FRAMEWORK.md), e o primeiro módulo do
projeto a registrar uma interação de alvo `object`. O jogador mira um veio no
mundo, o cliente reporta o FormId do que está mirando (via menu contextual, o
mesmo caminho já usado pela governança e pelas barracas), e o servidor mede
distância, checa profissão e ferramenta, entrega o minério atomicamente e
credita XP.

Arquivos: [`mining-service.js`](../../skymp/gamemode/mining-service.js),
[`core/interaction-targets.js`](../../skymp/gamemode/core/interaction-targets.js)
(resolvedor `object`, novo neste ciclo).
Módulo: `mining`, `enabledBy: 'ENABLE_MINING_SERVICE'`, `phase: 'lab'`,
depende de `profession` e `interaction` (ver `phase0-basic.js`).

---

## 1. Como a distância deixou de ser um gap

A primeira versão deste módulo tinha `/minerar <formDesc>` como comando de
chat: o jogador digitava o FormDesc à mão, e nada verificava proximidade. Isso
não era descuido — `core/interaction-targets.js` só resolvia alvo `player`
(usa `mp.get(actorId, 'locationalData')`, uma API de **ator**), e não existia
API confirmada no projeto para posição de uma `MpObjectReference` comum. A
decisão registrada naquele momento foi implementar tudo o mais e deixar a
distância documentada como gap bloqueante.

A correção não foi "adicionar uma checagem" — foi trocar a interface errada
pela certa:

1. `core/interaction-targets.js` ganhou um resolvedor para `object`: o
   cliente reporta o **FormId** do que está mirando (nunca um FormDesc
   digitado), do mesmo jeito que já fazia para `actorId` em `player`.
2. `rangeUtils.assertRange(fromActorId, targetId, maxRange)` já era genérico
   sobre o segundo id — nunca exigiu que fosse um ator. `target.assertRange`
   do resolvedor `object` reaproveita a função sem modificação nenhuma.
3. `core/interaction-service.js` mede essa distância no estágio `DISTANCE`,
   **antes** de `execute` rodar — o mesmo pipeline que já protegia `player`.
4. `mining.mine` é registrado com `target: 'object'` e
   `distance: server-options 'mining.maxDistance'` — fora desse alcance, a
   ação nem chega a `execute`.

**A suposição que continua em aberto:** `mp.get(formId, 'locationalData')`
contra uma `MpObjectReference` comum é **[DOC]** em `types/mp.d.ts` — a
interface `LocationalData` é descrita como posição "de um objeto", não "de um
ator", e `get()` é tipado genericamente sobre `FormId` — mas **nunca foi
exercitada em jogo por este projeto**. A decisão, tomada explicitamente com o
usuário, foi confiar na documentação oficial e implementar, marcando isto
como assumido. **Validar manualmente contra um servidor real antes de tirar
`ENABLE_MINING_SERVICE` do desligado por padrão.**

---

## 2. O que É real

| Checagem | Como |
|---|---|
| Distância até o veio | `mining.mine` registrado com `target: 'object'` e `distance: mining.maxDistance` (default 200) no Interaction Framework — medida pelo core, não pelo módulo |
| O alvo é de fato um veio | `canSee` consulta `resourceNodeService.getNode(formDesc)`; sem nó cadastrado ali, a ação nem aparece no menu |
| Profissão `miner` ativa, rank, nó habilitado/esgotado | 100% de `resourceNodeService.consume()` — única fonte de verdade, revalidada no `execute`, nunca duplicada em `mining-service.js` |
| Ferramenta (picareta) | `Actor.GetItemCount` via Papyrus — client-trusted só para decidir se a ação **começa**, nunca o que o jogador recebe |
| Anti-spam | `activeGatherers` chaveado por `characterId`, não `actorId` (slot reciclável) |
| Entrega do minério | 100% `resource-node-service.consume()`: atômico com o decremento do nó, nenhum item nasce fora do banco |
| XP de profissão | `professionService.addProfessionXp(...)`, valor de `server-options` (`mining.xpPerGather`, default 2) — só depois do `consume()` confirmar sucesso |
| Auditoria | Nível `ECONOMY` no Interaction Framework — grava quem, alvo, resultado, se a distância foi verificada |

## 3. O que NÃO é real

- Validação em jogo de `mp.get(formId, 'locationalData')` contra objeto
  comum (§1) — é o motivo de `ENABLE_MINING_SERVICE` continuar desligado por
  padrão mesmo com este ciclo fechado
- Comando de staff para criar/posicionar nó em jogo (nós continuam sendo
  criados via `resource-node-service.createNode()`, chamada de script/seed)
- Qualquer outra profissão de coleta (Lenhador, Caçador, Pescador)
- Sessão de coleta com duração/animação — a ação é instantânea, decisão
  deliberada para manter o MVP pequeno, não uma limitação técnica

---

## 4. Fluxo

1. Cliente abre o menu contextual sobre um objeto do mundo → `interaction:query`
   com `targetType: 'object'`, `targetId: <FormId>`.
2. `mining.mine` aparece na lista só se aquele FormId tiver um nó ativo em
   `resource_nodes` (`canSee`).
3. Cliente escolhe "Minerar" → `interaction:execute` com `action: 'mining.mine'`,
   `targetId: <FormId>`.
4. `core/interaction-service.js` revalida tudo do zero: resolve o alvo, mede
   distância, roda `canSee`/`canExecute`, só então chama `execute`.
5. `execute` checa concorrência, ferramenta, converte FormId→FormDesc
   (`mp.getDescFromId`), chama `resourceNodeService.consume()`, credita XP se
   houve sucesso.

Mensagens de recusa (`FAILURE_MESSAGES`, mapeadas 1:1 dos códigos de
`resource-node-service.consume()`) e as recusas locais (picareta, ocupado)
voltam como `message` do resultado de `interaction:execute` — o cliente as
mostra como notificação, mesmo canal que qualquer outra interação usa.

---

## 5. Testes

- `node --test core/interaction-targets.test.js` — resolvedor `object`:
  parsing de FormId (numérico, hex com/sem `0x`), não exige personagem
  carregado, `assertRange` delega em `rangeUtils` sem modificação. Cobre
  também `player` (regressão) e o vocabulário sem resolvedor.
- `node --test mining-service.test.js` — roda contra o Interaction Framework
  de verdade (`interaction-registry` + `interaction-targets` +
  `interaction-service`, sem mock), só intercepta `profession-service`,
  `resource-node-service` e `server-options` via `Module._load`: menu some
  sem nó cadastrado, distância recusa no estágio `DISTANCE` sem chamar
  `consume()`, sucesso completo (consume com os argumentos certos, XP
  creditado, mensagem formatada, `activeGatherers` liberado no `finally`),
  cada código de falha de `consume()` mapeado, XP não creditado quando
  `mining.xpPerGather` é 0, e liberação do `characterId` mesmo quando
  `consume()` lança.

Nenhuma migration nova neste ciclo — `mining-service.js` não tem tabela
própria, só consome `resource_nodes` (migration v19) e
`character_professions` (migration v18) através dos serviços que já as
possuem.

---

## 6. NOT IMPLEMENTED YET

- Validação manual em servidor real de `mp.get(formId, 'locationalData')`
  contra `MpObjectReference` comum (§1 — bloqueante para produção)
- Sessão de coleta com duração/cancelamento por movimento, morte ou desconexão
- Comando/UI de staff para posicionar nó de mineração em jogo
- Qualquer outra profissão de coleta (Lenhador, Caçador, Pescador)
- Fadiga ligada à atividade de coleta (o projeto não tem sistema de fadiga)
