# Serviços PARKED: análise e recomendação

Onze arquivos de serviço vivem em `skymp/gamemode/` e **nunca são registrados** no `core/module-registry.js` — cerca de 2.000 linhas que não rodam. Isso está documentado como intencional, mas "estacionado" virou um estado permanente sem revisão.

Este documento existe pra que a decisão seja tomada com dados em vez de por acúmulo.

**Status: executado em 06/08/2026.** Quatro serviços foram apagados (`economy`, `justice`, `faction`, `survival`) e os sete restantes continuam estacionados. O que segue é a análise que embasou a decisão — o histórico do git guarda o código removido.

**Segunda rodada, 06/08/2026 (§7).** Os três classificados como "independentes, coerentes" — `crafting`, `jobs`, `disguise` — foram reavaliados com dado que não existia na primeira: o `identity-service` ganhou testes, o `player-panel-service` passou a existir com aba Social, e a Afinidade da Alma fechou o desenho. Resultado: `disguise-service` **apagado** (quinto), `crafting` e `jobs` mantidos estacionados mas **com a mesma dívida do item 2, em item em vez de ouro**. A §6 abaixo está corrigida por §7 — leia as duas.

**Terceira rodada, 20/08/2026 — reativação.** `jobs-service`, `contracts-service` e `crafting-service` deixaram de ser PARKED: os três estão registrados em `core/module-registry.js` (fase `lab`, flag própria, desligados por padrão) e ganharam a camada de comando/gate que faltava desde §7 — `jobs` e `crafting` já tinham a dívida de item corrigida, mas nenhum dos três tinha comando de chat nem, no caso de `crafting`, gate de profissão real. Ver [`CRAFTING_SYSTEM.md`](../gameplay/CRAFTING_SYSTEM.md) e [`CONTRACTS.md`](../gameplay/CONTRACTS.md) para o estado atual de cada um. `contracts-service` não estava nesta lista original — nunca foi avaliado nas duas primeiras rodadas, só existia no disco. Nenhum dos três foi visto num servidor com gente dentro ainda; a análise abaixo (§1–§9) descreve o estado ANTES da reativação e continua correta para o histórico — a tabela no item "Situação" está desatualizada quanto a PARKED, não quanto ao resto.

Levantado em 05/08/2026.

---

## O quadro

| Serviço | Linhas | Último commit | Situação |
|---|---|---|---|
| ~~`justice-service.js`~~ | 293 | 11/07 | (X) **Apagado.** Superseded por `governance-service.js` |
| ~~`economy-service.js`~~ | 104 | 11/07 | (X) **Apagado.** Ouro sem atomicidade nem ledger |
| ~~`faction-service.js`~~ | 222 | 12/07 | (X) **Apagado.** Modelo de membros concorrente com `governance_memberships` |
| `economy-regional.js` | 302 | 04/08 | Mantido. Migrado pro `transaction-service` |
| ~~`survival-service.js`~~ | 236 | 11/07 | (X) **Apagado.** Mexe em ActorValue, que o death-service lê |
| `crafting-service.js` | 139 | 11/07 | Mantido. **Corrigido por §7:** dívida do item 2 em item |
| `housing-service.js` | 187 | 11/07 | Independente, coerente |
| `jobs-service.js` | 159 | 12/07 | Mantido. **Corrigido por §7:** cria item sem banco nem ledger |
| `horse-service.js` | 179 | 12/07 | Independente, coerente |
| `trade-service.js` | 90 | 11/07 | Independente, coerente |
| ~~`disguise-service.js`~~ | 149 | 12/07 | (X) **Apagado (§7).** Segunda autoridade sobre nome exibido |

Todos exceto `economy-regional` estão parados desde julho.

---

## 1. `justice-service.js` — **apagado**

É a implementação anterior de algemas, prisão e ficha criminal. Cada função dele tem equivalente no `governance-service.js`, que está ativo e é mais completo:

| `justice-service` | `governance-service` (ativo) |
|---|---|
| `restrain` / `unrestrain` | `detainTarget` / `releaseTarget` |
| `arrest` / `releasePrisoner` | `arrestTarget` / `releaseExpiredPrisoners` |
| `setBounty` | `issueWarrant` + `fineTarget` |
| `showCriminalRecord` | `showCriminalRecord` |
| `isRestrained` / `isImprisoned` | `core/character-state.js` (`RESTRAINED`/`IMPRISONED`) |

A versão da governança também tem o que a antiga não tem: checagem de alcance (`assertRange`), exigência de plantão (`on_duty`), auditoria e permissões nomeadas.

Manter as duas é um risco concreto: alguém revive a antiga achando que é a atual, e passa a ter duas fontes de verdade sobre quem está preso.

**Não há nada a salvar.** Está no histórico do git se alguém precisar consultar.

## 2. `economy-service.js` — **apagado** (era o mais urgente)

104 linhas que mexem em ouro **sem atomicidade e sem ledger**:

```js
await db.query('UPDATE characters SET gold = gold + ? WHERE id = ?', [amount, characterId]);
```

Compare com `core/transaction-service.js`, que faz `BEGIN` / `SELECT ... FOR UPDATE` / `COMMIT`, grava em `gold_transactions` e aceita chave de idempotência. A função `transfer` do serviço antigo é pior ainda: `removeGold` seguido de `addGold`, sem transação — se a segunda falhar, o ouro simplesmente desaparece.

O risco não é teórico: **seis módulos PARKED importam este arquivo** (`economy-regional`, `faction`, `horse`, `housing`, `trade`). Reativar qualquer um deles hoje traria a economia insegura junto, silenciosamente, contornando toda a proteção que o `transaction-service` existe pra dar.

Qualquer módulo que voltar deve usar `core/transaction-service`. Apagar o antigo é o que garante isso — enquanto ele existisse, o caminho fácil continuaria sendo o errado.

**Os três que ficaram e o importavam foram migrados** (`economy-regional`, `horse`, `housing`): `economy.addGold(id, n)` virou `transactionService.addGold({characterId, amount, reason, module})`, que é atômico e grava em `gold_transactions`. O `trade-service` importava sem usar — o import morto saiu junto.

## 3. `faction-service.js` — **apagado**

`governance-service.createFaction` já existe e está ativo. O `faction-service` tem a sua própria, além de convite, expulsão e tesouro de facção.

O que ele tem de único (tesouro, membros com rank) sobrepõe conceitualmente `governance_memberships` e `governance_roles`, que já estão em uso. São dois modelos concorrentes de "quem pertence a quê e com qual poder".

**Decidido: facção é um escopo dentro da governança.** O schema já dizia isso (`governance_memberships.scope_type` aceita o valor `faction`), e `governance.createFaction` é estritamente mais completo que o do serviço antigo — cria a facção, monta os cargos padrão via `ensureDefaultRoles`, registra o criador como líder, audita e exige permissão.

O que o `faction-service` tinha de único (tesouro, controle de hold) era construído sobre o `economy-service` inseguro e sobre um segundo modelo de associação. Manter os dois significaria duas respostas possíveis pra pergunta "quem manda nesta facção" — e é assim que se perde o controle de quem manda em quê.

Quando tesouro de facção voltar, nasce dentro da governança, sobre o escopo que já está ativo. O `economy-regional.js` já foi migrado: a checagem de "é o líder do hold?" agora usa `governance.getMembership(characterId, 'faction', holdFactionId)`.

## 4. `survival-service.js` — **apagado**

Aplica fome/sede/fadiga mexendo em `ActorValue` (`StaminaRate`, `CarryWeight`). Dois problemas:

- `docs/MODDING_GUIDELINES.md` lista scripts de sobrevivência na **lista negra do cliente**, e o `MODS_AND_GAMEMODE_CONTRACT.md` explica por quê: mod que mexe em ActorValue interfere no `death-service`, que lê ActorValue pra detectar `DOWNED`. Este serviço faz exatamente isso — do lado do servidor, mas com o mesmo efeito colateral.
- O backlog descreve sobrevivência como fase Alfa Avançada, "nunca bloqueando gameplay". A implementação atual não tem essa salvaguarda.

Se sobrevivência voltar, precisa nascer depois do `death-service` estar validado em jogo, e ciente dele.

## 5. `economy-regional.js` — **manter estacionado**, é o único com desenho ainda válido

Único mexido recentemente (04/08) e o único com justificativa de design registrada no README: spread punitivo em NPCs pra empurrar comércio entre jogadores.

Depende do `economy-service` (item 2). Reativar exige migrar pra `core/transaction-service` primeiro.

## 6. Os cinco independentes — **manter estacionados**

> ⚠️ **Corrigido pela §7.** Esta seção afirmou que os cinco "não duplicam nada ativo", e isso continua verdade no nível de *serviço*. A segunda rodada mostrou que `crafting` e `jobs` duplicam um **padrão** (mexer em item fora do `transaction-service`), e que `disguise` duplicava sim um serviço ativo. Leia a §7 antes de agir sobre esta seção.

`crafting`, `housing`, `jobs`, `horse`, `trade`. Não duplicam nada ativo, são coerentes internamente e correspondem a fases futuras do backlog. O custo de mantê-los é baixo: ninguém os importa, e o `module-registry` garante que não rodem por acidente.

Os três que mexem em ouro (`housing`, `horse`, `trade`) carregam a mesma dívida do item 2 — precisam migrar pro `transaction-service` antes de qualquer reativação.

### Nota para quem reativar o `trade-service`

**Existe uma referência de UI já estudada.** O Red House (`alekcey0211/red-house-public`, GPL-3.0) tem uma janela de troca em `front/src/features/systems/trade` — é uma das duas únicas coisas que o front-end deles tem e este projeto não (a outra é a lista de animações). Ver [`REFERENCE_STUDY_SKYMP_RED_HOUSE.md`](REFERENCE_STUDY_SKYMP_RED_HOUSE.md), "O front-end deles não vale a pena".

Isto é um ponteiro, **não uma recomendação de portar**. O que ele resolve é o custo de partir do zero no desenho da tela: troca player-to-player é uma superfície de exploit conhecida (quem confirma primeiro, o que acontece se um desconecta no meio), e ver uma implementação que rodou num servidor real vale mais como lista de casos a cobrir do que como código.

Três coisas que precisam estar decididas **antes** de abrir aquele repositório, senão a UI dita o desenho do servidor em vez do contrário:

- O backlog pede **commit duplo** ("Comercio player-to-player com commit duplo", Pós-Alfa). A janela deles é de 2021 e não necessariamente faz isso — conferir, não presumir.
- Ouro passa pelo `core/transaction-service` (item 2 acima). Sem exceção, e a compra em barraca já mostrou como se faz troca atômica de várias pernas usando as primitivas `tx.*`.
- Se algo for portado de fato, entra a atribuição da [`LICENSE_AND_AFFILIATION_POLICY.md`](LICENSE_AND_AFFILIATION_POLICY.md) §4 — projeto, autor, licença e commit no cabeçalho e no changelog. O formato já usado nos três arquivos do gamemode que vieram de lá (`core/hit-events.js`, `core/espm.js`, `core/safe-zones.js`) serve de modelo.

Nada foi portado nesta rodada, e **ler o `trade` deles antes da reativação é tempo gasto em código que talvez nunca seja usado** — o `trade-service` continua estacionado por decisão de escopo, não por falta de referência.

---

## 7. Segunda rodada (06/08/2026) — os três "independentes", reavaliados

A primeira rodada classificou `crafting`, `jobs` e `disguise` como "independentes, coerentes" e parou aí. Essa avaliação foi feita **antes** de três coisas: o `identity-service` ganhar testes (QA 4.3), o `player-panel-service` existir com aba Social, e a Afinidade da Alma fechar o desenho que explica disfarce como consequência de marca.

A pergunta é a mesma que eliminou `justice`/`faction`/`survival`: **algum deles duplica ou compete com algo que já está ativo?** Para dois, a resposta mudou.

### 7.1 `disguise-service.js` — **apagado**

Sobrepõe o `identity-service`, que está ativo e testado. Mas o problema não é só duplicação: é que as duas implementações **não têm a mesma forma**, e a dele é a errada.

| | `identity-service` (ativo) | `disguise-service` |
|---|---|---|
| Chave | `(observador, alvo)` | `alvo` |
| Autoridade sobre o nome | `getDisplayName(observador, alvo)` | `getPublicName(alvo, observador)` — ignora o observador |
| Persistência | `character_known_identities` | `disguises` |
| Padrão de desconhecido | `Desconhecido` | nome real |

Quatro consequências, em ordem de peso:

**1. Duas fontes de verdade para "que nome o observador X vê do alvo Y".** É literalmente o motivo pelo qual o `justice-service` foi apagado (§1), aplicado a identidade em vez de prisão. Nada liga os dois arquivos: reativar o disfarce criaria duas respostas possíveis pra mesma pergunta, e a do `disguise` venceria ou perderia dependendo de quem chamasse primeiro.

**2. A forma dele não expressa o único caso que importa.** Sob o `identity-service`, quem não te conheceu já te vê como `Desconhecido` — **anonimato é o padrão**, não uma feature. O que o disfarce precisa resolver é o caso oposto: parecer *outra pessoa específica* pra quem **já te conhece**. Isso é necessariamente por observador, e `activateDisguise` grava um nome falso global. Não há o que migrar: a estrutura de dados está errada para o requisito.

**3. O lugar certo já existe e já está preparado.** `character_known_identities.source` aceita o valor `'disguise'` desde o `schema.sql` (linha 73), e `skymp/ui/player-panel.js` já rotula esse valor como "disfarce" na aba Social. O [`NAMETAG_IDENTITY_SYSTEM.md`](NAMETAG_IDENTITY_SYSTEM.md) também já registra o requisito na forma certa — *"disfarce ativo deve poder sobrescrever nome público sem alterar conhecimento real"* — como uma **regra dentro da escada de exibição**, não como um serviço paralelo. O trabalho pendente é um degrau em `getDisplayName()`, não um arquivo.

**4. A rolagem de detecção contradiz um desenho já fechado.** `detectDisguise` faz `Math.random()` contra uma DC:

- [`SOUL_AFFINITY.md`](../design/SOUL_AFFINITY.md) §4.2 e §14.3 exigem que **toda rolagem oculta** seja determinística, semeada e reproduzível em `audit_logs`, para que a staff possa provar um resultado contestado. `Math.random()` é irreproduzível por construção — não é um detalhe a ajustar, é a propriedade contrária à exigida.
- §II.0 e §II.2 fecharam que **o dado nunca diz não**. A falha aqui devolve *"Você não consegue identificar nada suspeito"* — o "silêncio" que aquele documento lista como um dos quatro assassinos de diversão.
- §15 posiciona o disfarce como ligação do `identity-service` (*"vampiro descoberto = identidade revelada; conecta ao disfarce"*), isto é, consequência de marca. Não um sistema à parte com DC própria.

**5. Nunca foi exercitado, e dá pra provar lendo.** Três defeitos que qualquer sessão real teria mostrado no primeiro minuto:

- `staffReveal` monta a mensagem com `commands.getActiveCharacterData(actorId)` — a **própria staff** —, então `/revealid` responde *"X é na verdade \<nome de quem digitou o comando\>"*. O parâmetro `targetActorId` é usado pra achar o disfarce e ignorado pra achar o nome.
- Em `detectDisguise`, a mensagem do detector e o aviso *"alguém percebeu seu disfarce"* saem os dois por `Debug.notification` com `self = null`, que é global: o disfarçado nunca é avisado e todo mundo é.
- `getPublicName` calcula `obsData` na linha 26 e não usa (o próprio comentário abaixo admite que o bypass de staff "é feito no commands.js").

**Nada depende dele** — a única citação fora do arquivo era o comentário de PARKED no `phase0-basic.js`. **A tabela `disguises` fica**, pelo mesmo critério das seis órfãs abaixo: tabela vazia não tem caminho de execução e o requisito continua válido, só muda de dono.

### 7.2 `crafting-service.js` — **mantido estacionado, mas entra na fila de migração**

Não mexe em ouro e nunca importou o `economy-service` — pela pergunta literal da primeira rodada, passava. Mas carrega **a mesma dívida do item 2, transposta de ouro para item**, e ela estava escondida atrás de um comentário que afirma o contrário.

O passo 4 do `craftItem` diz `// 4. Consome ingredientes (transação segura: tudo ou nada)`. Não é. É um laço de `removeItem()` independentes, seguido de um `giveItem()` — e cada uma dessas funções **abre a própria transação** no `core/transaction-service`. Uma receita de três ingredientes são quatro transações separadas: se a segunda falhar, a primeira já commitou, o jogador perdeu o ingrediente e não recebeu nada.

É `economy-service.transfer` (`removeGold` seguido de `addGold`, sem transação) com outro substantivo. E a solução já existe e já foi exercitada: as primitivas `tx.*` (`applyInventoryDelta`, `recordInventoryLedger`), que a compra em barraca usa exatamente porque move várias pernas e precisa commitar junto.

**Entra na Fase 3**, junto com os que mexem em ouro. Continua PARKED depois disso — migrar não é reativar.

### 7.3 `jobs-service.js` — **mantido estacionado, e é o mais grave dos três**

Também não mexe em ouro. Não mexe em banco **nenhum**: importa só `commands` e `core/papyrus`.

Ele entrega item chamando `mp.callPapyrusFunction('method', 'ObjectReference', 'AddItem', ...)` direto no ator — contornando `inventory-service` e `core/transaction-service` inteiros. Consequência: lenha, minério e peixe nascem **sem linha em `character_inventory` e sem linha no ledger**. Não existem para o servidor.

Isso é mais forte que o achado do `/setgold` (ouro que aparecia sem origem registrada, mas ao menos mudava o saldo no banco). Aqui o item existe apenas no cliente até a próxima sincronização, e o `syncInventoryToClient` reconcilia a partir do **banco** — que nunca soube do item. Inverte a regra que o resto do projeto segue: *inventário só existe se o MariaDB confirmar*.

Dois problemas menores, registrados para quem migrar:

- `Math.random()` decide quantidade e raridade (ferro/corundum/ébano). Não é rolagem oculta de alma, então não cai sob a §14.3 da Afinidade — mas produção de recurso irreproduzível é um problema de economia à parte.
- `activeGatherers` é `Set` chaveado por `actorId` com liberação por `setTimeout` de 10–20 s. Se o jogador cai no meio, o timer ainda dispara e o `AddItem` vai para o ator seguinte do slot reaproveitado. É a classe de bug da auditoria estática §5, e some sozinha quando a entrega passar pelo `transaction-service`, que trabalha por `characterId`.

**Entra na Fase 3** pelo mesmo motivo do `crafting`.

### 7.4 Decidido em 07/08/2026: permissão numérica em três lugares

> Esta seção era "candidato registrado, não decidido". A decisão foi tomada e está abaixo; o histórico do problema fica porque ele explica a escolha.

**O problema.** Encontrado pelo `npm run typecheck` durante a migração da Fase 3. `crafting-service.js` (linhas 162 e 183) e `economy-regional.js` (linha 238) chamavam `adminService.hasPermission(actorId, 20)` — um **nível numérico**, herança de um modelo antigo. O `admin-service` hoje trabalha com permissões nomeadas e trata esse caso explicitamente: grita no log e **nega**. O `disguise-service` tinha a mesma coisa (`hasPermission(actorId, 10)`) e saiu junto com o arquivo.

Consequência: `/addrecipe`, `/addingredient` e `/settax` **negavam sempre**, para todo mundo, inclusive para `owner`. Como os dois serviços estão PARKED, ninguém sentia — e é justamente esse o risco: o dia em que alguém reativasse um deles, os três comandos estariam quebrados em silêncio, sem nada no caminho de quem reativou que apontasse para cá.

**A decisão.**

| Comando | Permissão | Cargos |
|---|---|---|
| `/addrecipe`, `/addingredient` (`crafting-service.js`) | `manage_recipes` — **nova** | `admin`, `owner` |
| `/settax` (`economy-regional.js`) | `set_gold` — reaproveitada | `admin`, `owner` |

**Por que `manage_recipes` nova e não `add_item`.** `add_item` era o candidato óbvio e é o errado. Ele significa "dê este item a este jogador": ato pontual, auditado, raio de alcance de uma pessoa. Uma receita é uma regra permanente que **todo** jogador usa, quantas vezes quiser — é uma casa da moeda, não um presente. Reaproveitar `add_item` faria quem auditasse *"quem pode `add_item`?"* receber a resposta errada sobre quem pode reformar a economia de crafting. Isso é a mesma classe do nível numérico que estamos consertando: uma permissão que significa outra coisa que não o que o nome diz.

**Por que `set_gold` reaproveitada e não uma `manage_economy` nova.** `set_gold` já significa "a staff escreve um número da economia por decreto, com audit log". Definir a alíquota de um Hold é exatamente isso, aplicado ao fluxo em vez do saldo — mesmo andar, mesmo tipo de poder, mesmos cargos. Criar um nome para um único sítio de chamada produziria uma permissão que nenhum cargo concede, que é o outro modo de falha que o `hasPermission` grita.

**Por que os dois ficam fora do moderador.** Receita e imposto movem patrimônio de todo mundo, não de um alvo. É o mesmo andar de `add_item` e `set_gold`, que o moderador também não tem.

**O que isto não é.** Não é reativação. Nenhum dos dois serviços entra no `core/module-registry.js`, e o comentário de PARKED no topo dos dois arquivos continua valendo. Corrigir a autorização de um serviço estacionado é reduzir a armadilha que ele guarda para quem o reativar — é o oposto de ligá-lo.

**Cobertura.** `parked-staff-permissions.test.js`, 16 testes: matriz cargo × ação para os três handlers (chamando o handler real e olhando o efeito colateral, nunca o retorno — os três devolvem `undefined` no sucesso e na negação) mais uma varredura estática que reprova se qualquer arquivo de produção do gamemode voltar a passar número para `hasPermission`. Cinco mutações verificadas aplicando e executando, não prevendo: apagar cada uma das três checagens reprova 2; voltar ao nível numérico reprova 3; dar `manage_recipes` ao moderador reprova 3.

**O que continua em aberto:** se `manage_recipes` deve ser de `admin` ou só de `owner` quando o `crafting-service` de fato voltar. Hoje ela segue o andar de `add_item` porque criar receita é trabalho de conteúdo, rotineiro — prender isso ao `owner` faria o servidor depender de uma pessoa para tarefa corriqueira. Se a economia real mostrar que receita é decisão rara e cara, mover para `owner` é uma linha em `ROLE_PERMISSIONS` e uma na MATRIZ do teste, que é onde a mudança fica declarada.

### 7.5 O que esta rodada mostra sobre a pergunta da primeira

A primeira rodada perguntou *"duplica algo ativo?"* e, para os três, respondeu não — corretamente, pelo critério dela. `crafting` e `jobs` de fato não duplicam nenhum serviço.

O que escapou é que **duplicar um serviço não é a única forma de carregar a dívida**: os dois duplicam um *padrão* — "mexer em patrimônio do jogador fora do arquivo que existe pra ser o único caminho" — sem duplicar nenhum serviço. Foi o que o item 2 apagou no ouro, e o filtro daquela rodada (`importa economy-service?`) só pegava a instância em ouro.

Fica registrado como critério para a próxima reavaliação: **a pergunta é "toca patrimônio, estado ou identidade fora do dono desse assunto?", não "importa o arquivo errado?"**.

### 7.6 Candidatos da 3ª varredura (07/08/2026), registrados e não decididos

A auditoria estática por classe de bug conhecida rodou de novo, agora sobre o código que nasceu depois de `26ed196` (a varredura de 06/08). As cinco classes passaram limpas — ver o `CHANGELOG.md`. Estes dois achados apareceram de raspão e **não são membros de nenhuma das cinco**, então seguem a mesma regra da 7.4: registrados aqui em vez de corrigidos por conta própria.

**1. `economy-regional.characterHold` cresce e nunca encolhe.** `Map` de `characterId → holdId` (linha 23), preenchido em `setCharacterHold` e nunca esvaziado. Não é a classe do `_lastHealth`: a chave é `characterId`, então não sofre reaproveitamento de slot e o valor continua correto no reconnect — ninguém recebe o Hold de outra pessoa. É vazamento puro, limitado ao número de personagens distintos que já usaram o comando na vida do processo.

O precedente existe e é o `_soulCache`, que ganhou `cleanup()` no `removeActiveCharacter` com o argumento *"cache que só cresce é vazamento, e reler no próximo login custa uma query"*. A diferença é que o `soul` está no `module-registry` e a limpeza fica atrás de `isEnabled('soul')`; `economy-regional` não está registrado em lugar nenhum, então não há flag para consultar. Ligar a limpeza exigiria decidir como o `removeActiveCharacter` conversa com um módulo que o registry não conhece — decisão de arquitetura, não de varredura.

**2. `withdrawHoldTreasury` carrega a forma do defeito do `craftItem`, num caminho que hoje não executa.** Linhas 225–226: `UPDATE holds SET treasury = treasury - ?` seguido de `UPDATE factions SET treasury = treasury + ?`, cada um no próprio `db.query`, sem `BEGIN`. É **exatamente** a forma que o `craftItem` tinha antes da Fase 3 — "cada função abre a própria transação; falhando a segunda, a primeira já commitou". A varredura da classe 1 não o alcança porque a busca é por `characters.gold`, e isto é tesouro de Hold e de facção: outras tabelas, mesmo desenho.

**Mas o ouro não se perde hoje, e é importante ser exato sobre por quê:** a função morre antes de chegar nos dois `UPDATE`. Na linha 213 ela chama `governance.getMembership`, que existe como função mas **não está no `module.exports`** do `governance-service`, e nas linhas 226/231 usa um `factionInfo` que nunca foi declarado. As duas coisas já estavam registradas no comentário de `governance-service.js` (perto da checagem `isEnabled('economy-regional')`) e aparecem no `npm run typecheck` — o que também explica por que o módulo é o exemplo que aquele comentário usa para dizer que importar PARKED direto é a pior ideia possível.

Ou seja: são **dois** defeitos empilhados, e consertar só o de cima seria pior que não mexer — transformaria um caminho que falha alto num caminho que move ouro pela metade em silêncio. Não foi corrigido porque o `core/transaction-service` é dono de **patrimônio de personagem** (ouro e inventário) e não tem primitiva para tesouro institucional. Fazer certo é decidir se `holds.treasury` e `factions.treasury` entram no mesmo ledger, com o mesmo rastro em `gold_transactions`, ou se são outra coisa — a pergunta da 7.5 aplicada a um patrimônio que não é de ninguém em particular. Decisão de economia, igual à da 7.4.

---

## Sobre as 6 tabelas órfãs

`store_purchases`, `trade_routes`, `magic_licenses`, `magic_violations`, `character_diseases`, `staff_permissions` — definidas no schema e **referenciadas por nenhum código**, nem ativo nem PARKED.

Recomendo **manter**. Diferente do código, uma tabela vazia não tem caminho de execução, não pode ser importada por engano e não duplica lógica. O custo é uma linha no schema; o benefício de remover seria estético. `staff_permissions` em especial parece prevista para permissões de staff por conta (hoje só há por cargo, em `ROLE_PERMISSIONS`) — é extensão plausível.

O que **não** se deve fazer é deixá-las sem explicação. Estão listadas em `docs/ARCHITECTURE.md` 1.1 como reservadas.

---

## Resultado

| Ação | Arquivos | Linhas |
|---|---|---|
| **Apagados na 1ª rodada** | `economy-service`, `justice-service`, `faction-service`, `survival-service` | ~855 |
| **Apagado na 2ª rodada (§7)** | `disguise-service` | ~149 |
| **Mantidos estacionados** | `economy-regional`, `crafting`, `housing`, `jobs`, `horse`, `trade` | ~1.056 |

Os seis que ficaram não duplicam nenhum serviço ativo e correspondem a fases futuras do backlog. Os três que mexiam em ouro (`economy-regional`, `housing`, `horse`) foram migrados pro `transaction-service` na 1ª rodada. Os dois que mexem em **item** fora do `transaction-service` (`crafting`, `jobs`) foram identificados na 2ª e migrados na Fase 3 — a dívida era a mesma, o substantivo é que era outro.

Nenhum deles foi registrado no `module-registry.js`: migrar é segurança interna, reativar é decisão de escopo, e misturar as duas é o erro que a Fase 2 do `QA_REPORT` existe pra não repetir.

O código apagado continua no histórico do git.
