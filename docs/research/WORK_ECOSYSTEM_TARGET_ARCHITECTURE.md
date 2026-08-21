# Arquitetura-alvo — Ecossistema de Trabalho, Profissão e Economia

**Data:** 20/08/2026 · **Entrada:** [`WORK_PROFESSION_ECOSYSTEM_CURRENT_STATE.md`](WORK_PROFESSION_ECOSYSTEM_CURRENT_STATE.md) (auditoria, mesma data) · **Natureza:** decisão de design, zero código

Este documento **não implementa nada**. Nenhuma migration, nenhum refactor, nenhuma reativação. É a arquitetura-alvo que a auditoria pediu antes de qualquer trabalho de código neste domínio.

Validações pontuais feitas nesta rodada, além da auditoria: `core/server-options.js` confirma `profession.maxPerCharacter` (default 3) e `profession.maxRank` (default 3) como os únicos limites configuráveis de Profession hoje; `governance-service.js` confirma 10 permissões nomeadas de guarda/banca (`GUARD_DUTY`, `GUARD_SEARCH`, `GUARD_DETAIN`, `GUARD_ARREST`, `GUARD_FINE`, `GUARD_WARRANT`, `GUARD_CONFISCATE`, `GUARD_RELEASE`, `STALL_INSPECT`, `STALL_SUSPEND`, `STALL_CONFISCATE`, `STALL_ISSUE_LICENSE`, `STALL_COLLECT_TAX`) — nenhuma delas checa Profession.

> **Revisão de 21/08/2026 (Prompt 3 — Revisão Final + ADR).** As seções §5, §6/§7, §8, §9, §15 e §17 abaixo foram corrigidas em pontos específicos que a revisão encontrou incorretos ou incompletos na primeira versão. As correções estão marcadas inline com **[REVISADO 21/08]** e formalizadas nos ADRs 007–012 (`docs/technical/`). Ver também [`WORK_ECOSYSTEM_DECISION_SUMMARY.md`](WORK_ECOSYSTEM_DECISION_SUMMARY.md) para a lista consolidada do que foi aprovado, do que ficou em aberto, e do que foi rejeitado. Validações de código feitas na revisão: `revokeProfession`/`suspendProfession` confirmados como `UPDATE` de status via `_transition` (`profession-service.js:282-337`), nunca `DELETE` `[CODE]`; `core/economy-service.ACCOUNT_KINDS` confirmado como `{character, city, hold, faction, realm, escrow}` (`core/economy-service.js:57-64`), sem `business` `[CODE]`; `core/inventory-owner.OWNER_TYPES` confirmado como `{CHARACTER, CONTAINER, PROPERTY, FACTION, CORPSE, MARKET, SYSTEM}`, só os 3 primeiros com adaptador implementado, sem `business` `[CODE]`; `contracts-service.js` **já tem** `category`/`CATEGORIES` (`contracts-service.js:69-72`: `mercenary, caravan, delivery, bodyguard, crafting, mining, harvest, hunt, arcane, investigation, generic`) `[CODE]` — a extensão proposta no §10 original já existe, não precisa ser criada.

---

## 1. Executive Decision

**[REVISADO 21/08]** Oito conceitos (ADR 007), um princípio: **cada tabela nova só nasce se nenhuma abstração existente conseguir representar a semântica sem mentir sobre ela.** Aplicando esse teste:

| Conceito | Decisão |
|---|---|
| Profissão | **Preservar como está.** `character_professions` continua sendo conhecimento técnico de longo prazo — nada muda na tabela. |
| Especialização | **Tabela nova (`character_specializations`), pequena, com FK obrigatória para a profissão pai.** Não cabe em `character_professions` porque muda a cardinalidade (uma profissão → N especializações). Sem status/XP próprios — herda do pai (ADR 008). |
| Emprego | **Tabela nova (`employments`), módulo próprio.** Não é Profissão (não é conhecimento, é relação com um empregador) nem Governance (não é autoridade). `positionCode` de catálogo fechado, nunca texto livre (ADR 009). |
| Cargo | **Coluna dentro de Emprego (`positionCode`), não tabela própria** para negócio privado; **continua vivendo em Governance** para instituição pública. Cargo não tem identidade fora do contexto que o define — não é uma entidade, é um atributo de uma relação. |
| Negócio | **Tabela nova (`businesses`), serviço próprio e independente**, mínima nesta fase (dono + nome + tipo) — não extensão de Employment (ADR 010). Empregados moram em Emprego, não em Negócio. |
| Public Work | **Serviço novo, sucessor de `jobs-service`**, com catálogo estático (`PublicWorkDefinition`) e execução persistente (`public_work_runs`) — ver ADR 011, §9 e §19. |
| Contrato | **Nenhuma mudança.** `contracts-service.js` já modela obrigação com escrow corretamente, e **já tem `category`** (confirmado em código) — a única coisa que falta é ele aceitar `context.employmentId`/`businessId` como referência opcional, não uma reescrita. |
| Governança | **Nenhuma mudança.** Continua sendo a única fonte de autoridade institucional (ADR 012) — nenhum dos sete conceitos acima concede poder de prender/revistar/multar/confiscar. |

A decisão central que evita over-engineering (§17 do pedido): **`employments`, `character_specializations`, `businesses` e `public_work_runs` são as quatro tabelas novas desta arquitetura** — nenhuma delas nasce sozinha por conveniência; cada uma responde uma pergunta que nenhuma tabela existente responde (ADR 007). `character_specializations` é satélite de Profession; as outras três têm ciclo de vida e módulo próprios — ver §15.

---

## 2. Current Problem

Da auditoria, resumido em uma frase por achado, sem repetir evidência já levantada lá:

1. `profession_code` é uma lista plana de 13 rótulos que mistura ofício real (`miner`), etiqueta RP sem poder (`guard`), e papel que só faz sentido dentro de um negócio (`innkeeper`, `stablehand`, `courier`).
2. `jobs-service` duplica `mining-service` para o mesmo recurso (minério) com rigor diferente — dois caminhos de verdade para a mesma coisa.
3. Não existe onde representar "Bjorn é cozinheiro-chefe da Taverna Lua Prateada" sem forçar `cook` a carregar informação de emprego que não é dele.
4. Cargo institucional (Governance) e cargo de negócio privado não têm fronteira declarada — risco de um crescer para dentro do espaço do outro.

---

## 3. Target Taxonomy

```
PROFISSÃO        conhecimento técnico de longo prazo, com XP e rank
  └─ ESPECIALIZAÇÃO   ramo dentro de uma profissão, desbloqueado por rank

EMPREGO          relação entre personagem e empregador (instituição | negócio | facção | outro personagem)
  └─ CARGO           posição dentro daquele emprego específico (atributo, não entidade)

NEGÓCIO          entidade econômica que um personagem possui/administra
  └─ (empregados são Emprego, não Negócio)

PUBLIC WORK      trabalho sem profissão, piso econômico, não compete com produção de profissão

CONTRATO         obrigação pontual entre partes, com escrow — não é relação permanente

GOVERNANCE       autoridade legal/institucional — única fonte de poder de guarda/multa/confisco
```

Regra de não-sobreposição, testável: **Profissão responde "o que o personagem sabe fazer". Emprego responde "para quem ele trabalha agora". Cargo responde "qual é o nível dele lá". Negócio responde "quem é dono disto". Public Work responde "o que qualquer um pode fazer sem saber nada". Contrato responde "o que foi combinado uma vez, entre duas partes específicas". Governance responde "quem tem poder sobre quem, por lei".** Nenhuma pergunta é respondida por dois sistemas ao mesmo tempo — esse é o critério de aceite de todo o resto deste documento.

---

## 4. Profession

**Preservar `profession-service.js` + `core/profession-registry.js` + `character_professions` exatamente como estão.** A auditoria já confirmou que este é o sistema mais bem desenhado do domínio — mexer nele sem necessidade violaria a própria regra do item 17 do pedido.

### Classificação das 13 entradas atuais

| Profissão | Classificação | Justificativa |
|---|---|---|
| `miner` | **KEEP AS PROFESSION** | Único com gameplay real hoje; ofício de coleta clássico |
| `lumberjack` | **KEEP AS PROFESSION** | Família de nó estático, mesmo padrão do Minerador (§11) |
| `hunter` | **KEEP AS PROFESSION** | Ofício real; a atividade em si (caça) precisa de framework próprio (alvo móvel), mas a *profissão* continua sendo profissão |
| `farmer` | **KEEP AS PROFESSION** | Idem — ofício real; mecânica de plantio é outra discussão (§11), a profissão em si não muda |
| `smelter` | **KEEP AS PROFESSION, candidato a virar ESPECIALIZAÇÃO de `blacksmith`** | Fundir minério é etapa da cadeia do Ferreiro em quase toda tradição de crafting; hoje é profissão irmã e não sub-ramo. Não é erro grave, mas se `blacksmith → Metalurgia/Fundição` for adotado (§5 do pedido original), `smelter` deveria fundir-se ali em vez de continuar paralela |
| `blacksmith` | **KEEP AS PROFESSION**, pai de especializações Armeiro/Metalurgia | Ofício central de crafting; framework já tem gate pronto (`migration-v20`) |
| `tanner` | **KEEP AS PROFESSION, candidato a virar ESPECIALIZAÇÃO de `hunter`** | O pedido original já sugere `Caçador → Curtidor`; hoje é profissão irmã sem relação declarada com `hunter` |
| `enchanter` | **KEEP AS PROFESSION** | Ofício central, mencionado explicitamente na Constituição §10 como raro/com mercado próprio — não deve virar Public Work nem Business Role |
| `cook` | **KEEP AS PROFESSION**, pai de especializações Cervejeiro/Panificação | Ofício real; a *posição* "cozinheiro-chefe da Taverna X" é Emprego+Cargo, não a profissão em si |
| `stablehand` | **MOVE TO EMPLOYMENT/BUSINESS ROLE** | "Tratador de estábulo" é um papel que só existe dentro de um negócio (estábulo) ou emprego institucional — não é conhecimento técnico autônomo do jeito que `blacksmith` é. Confirmado pelo próprio exemplo do pedido do usuário (§5, "tratador de estábulo" está listado como Emprego) |
| `innkeeper` | **MOVE TO BUSINESS ROLE** | "Taberneiro" é dono/gerente de um Negócio (taverna), não um ofício ensinável com XP/rank no mesmo sentido de Ferreiro. O pedido original já usa `innkeeper` como exemplo de Negócio (§7: "Dono de taverna"), não de Profissão |
| `courier` | **MOVE TO PUBLIC WORK ou EMPLOYMENT, dependendo do contexto** | "Mensageiro" tem duas formas conforme o próprio pedido (§5: "Mensageiro da Coroa" é Emprego institucional; §8 lista "Courier"/"Supply Runner" como Public Work correto). Não é uma profissão de conhecimento técnico de longo prazo — é uma atividade, que pode ser ocasional (Public Work) ou formal (Emprego) |
| `guard` | **MOVE TO EMPLOYMENT** (institucional), poder permanece **exclusivamente** em Governance | Já confirmado pela auditoria: `guard` não concede poder hoje. A etiqueta RP faz mais sentido como Emprego ("Guarda de Solitude" é literalmente o exemplo do pedido §5 para Emprego) do que como Profissão — não há XP/rank de "saber ser guarda" no sentido de ofício técnico |

**Nenhuma remoção proposta aqui é execução — são candidatos, ver Deprecation Plan (§18) para a diferença entre "classificar diferente" e "remover".**

---

## 5. Specialization

### Respostas às 10 perguntas do pedido

1. **Registry próprio?** Sim, mas **pequeno e estático em código**, no mesmo padrão de `core/profession-registry.js` — não um catálogo dinâmico via admin tool nesta fase. Motivo: mesma razão pela qual Profession não tem tabela `professions` — o catálogo é decisão de design, não dado editável em produção ainda.
2. **Tabela `character_specializations`?** Sim — cardinalidade é o motivo: uma profissão pode ter 0 a N especializações escolhidas, e "escolhida" precisa de estado próprio (quando escolheu, se pode trocar).
3. **XP próprio?** **Não, nesta fase.** XP de especialização competindo com XP de profissão pai cria duas barras de progresso para a mesma atividade — a Constituição §5 proíbe "progressão linear" redundante implicitamente ao pedir "dependência entre profissões", não duplicação de métrica.
4. **Rank próprio?** **Não.** Ver resposta 5 — herda da profissão pai.
5. **Desbloqueia por rank da profissão pai, ou XP/rank próprio?** **Desbloqueia por rank da profissão pai.** É o modelo mais simples que resolve o caso de uso central (Ferreiro rank 3 pode escolher Armeiro) sem inventar uma segunda economia de progressão. Comparação formal abaixo.
6. **Pode existir sem profissão pai ativa?** **[REVISADO 21/08]** Sim, tecnicamente — a linha persiste, mas fica **indisponível para uso**. Correção da versão anterior: `character_professions` usa `status IN ('active','suspended','revoked')`, e `revokeProfession()`/`suspendProfession()` são confirmadas em código (`profession-service.js:282-337`, função `_transition`) como `UPDATE character_professions SET status=?` dentro de `SELECT...FOR UPDATE` — **nunca `DELETE`** `[CODE]`. Não há `ON DELETE CASCADE` disparando aqui, porque não há `DELETE`. `character_specializations` segue a mesma disciplina: revogar a profissão pai não apaga a especialização, só a torna indisponível (ver pergunta 7). Delete/cascade físico só ocorre no caso hoje inexistente de a própria linha `character_professions` ser fisicamente removida do banco.
7. **O que acontece se a profissão for suspensa ou revogada?** Especialização fica **indisponível por herança nos dois casos**, sem `DELETE` — não precisa de campo `status` próprio; a leitura sempre junta com `character_professions.status` da linha pai. Evita um segundo lugar para a mesma informação ficar dessincronizada, e preserva histórico (uma profissão suspensa e depois reativada recupera a especialização automaticamente, sem re-escolha). Ver ADR 008.
8. **Quantas especializações por personagem?** Configurável via `server-options.js`, no mesmo padrão de `profession.maxPerCharacter` — ex. `specialization.maxPerProfession` (proposta: default 1, para forçar escolha real, não coleção).
9. **Mentor/aprendiz entra depois?** Não modelado nesta fase — fica como extensão futura de `character_specializations` (campo `taught_by_character_id`, mesmo padrão de `granted_by_character_id` em Profession), sem necessidade de tabela nova quando chegar a vez.
10. **Como receitas consultariam especialização?** `crafting_recipes.required_specialization` — coluna nova, mesmo padrão de `required_profession`/`required_rank` já existente (migration-v20). Ver §13.

### Comparação de modelos

| | **Modelo A — XP/rank próprios** | **Modelo B — herda da profissão pai (recomendado)** |
|---|---|---|
| Complexidade de schema | Alta — duplica toda a máquina de rank/XP | Baixa — reaproveita a leitura de rank já existente |
| Risco de dessincronia | Alto — duas fontes de "quão bom Bjorn é em cozinha" | Nenhum — uma fonte |
| Alinhamento com Constituição §6 ("dependência entre profissões") | Fraco — especialização vira profissão disfarçada | Forte — especialização é literalmente dependente |
| Custo de implementação futura | Alto | Baixo |

**Recomendação: Modelo B.**

---

## 6. Employment

Desenho conceitual (sem SQL, conforme pedido):

```
Employment
  character            → quem trabalha
  employerType          → 'institution' | 'business' | 'faction' | 'character'
  employerRef           → id do empregador, dentro do tipo acima
  positionCode           → [REVISADO 21/08] catálogo fechado EM CÓDIGO, não string livre — ver correção abaixo
  status                 → 'active' | 'suspended' | 'terminated'
  startedAt / endedAt
  compensationPolicy     → referência a como é pago (ver integração com Economy, §10)
```

**[REVISADO 21/08] Correção sobre `position`:** a versão anterior deste documento propunha "string livre ou catálogo pequeno" para cargo. Isso foi corrigido para **`positionCode` obrigatoriamente de catálogo fechado em código** (ex.: `head_cook`, `manager`, `worker`, `forge_master`), com label de apresentação separado do código interno. Texto livre como regra de negócio repetiria a classe de erro que este mesmo projeto já viveu com `crafting_recipes.requires_perk` (campo lido, nunca comparado de forma confiável) — ver ADR 009.

**Employer types**, cada um com autoridade de quem gerencia a relação:
- `institution` (governo/facção pública) — quem contrata/demite é Governance, via permissão nomeada existente (não uma nova).
- `business` — quem contrata/demite é o dono do Negócio (§7).
- `faction` (não-governamental, ex. guilda) — mesma lógica de `governance_memberships`, mas fora do escopo de poder legal.
- `character` — emprego informal, um personagem contrata outro diretamente (ex. "Ragnar contratou Bjorn" antes mesmo de existir Business formal).

**Por que não cabe em `character_professions`:** cardinalidade e semântica erradas — Profissão é "o que eu sei", Employment é "para quem eu trabalho agora"; um Ferreiro pode trocar de empregador sem perder a profissão, e a tabela atual não tem onde guardar "empregador" sem forçar uma coluna que não pertence à ideia de profissão.

**Por que não cabe em `governance_memberships`:** essa tabela é para instituições **de governança** (facções com autoridade política), e Employment precisa cobrir negócio privado e emprego informal — que não têm autoridade nenhuma, só relação trabalhista.

---

## 7. Position / Cargo

**Cargo não é uma tabela.** É um campo (`Employment.positionCode`, catálogo fechado — ver correção do §6) — porque não tem identidade fora do emprego que o define: "Sargento" só significa algo dentro do contexto de "sargento de quê". Isto responde diretamente à pergunta central do pedido §6 (evitar segunda fonte de verdade):

| Contexto | Onde vive o cargo | Quem decide o cargo | Quem decide o poder que vem com ele |
|---|---|---|---|
| Instituição governamental (Guarda de Solitude, Sargento, Capitão) | `governance_memberships` (já existe, não muda) | Governance | **Governance, sempre** — `PERMISSIONS` nomeadas, nunca o cargo em si |
| Negócio privado (Mestre da Forja, Gerente) | `Employment.positionCode` (novo, catálogo fechado) | Dono do Negócio | **Ninguém automaticamente** — cargo de negócio privado não concede poder institucional nenhum. Um "Gerente" da ferraria não pode prender, revistar ou confiscar |

**A regra que evita a segunda autoridade, formalizada:** poder de guarda/revista/prisão/multa/confisco **só** pode vir de uma permissão nomeada checada contra `governance-service.hasPermission`. Nenhum código futuro deve checar `Employment.position === 'guard'` ou `Employment.employerType === 'institution'` como substituto disso — o mesmo risco já identificado na auditoria para `profession.guard` se repete aqui se não for declarado explicitamente. **Este documento formaliza a regra; a auditoria já tinha achado o risco.**

---

## 8. Business

**[REVISADO 21/08]** A versão anterior deste documento propunha Business como extensão de `employment-service.js`/`market-stalls-service.js` (§15 original). A revisão corrigiu isso: **Business é semanticamente independente de Employment e nasce como serviço próprio e mínimo (`business-service.js`)** — colocar o ciclo de vida de Business dentro de Employment misturaria "quem trabalha para quem" com "quem é dono do quê", violando a própria fronteira que a ADR 007 define. Ver ADR 010 para a decisão formal.

Desenho mínimo, deliberadamente pequeno para não repetir o erro que a auditoria encontrou em `housing-service`/`horse-service` (over-reach de escopo antes de estabilizar o básico):

```
Business
  id
  name                 → "Taverna Lua Prateada"
  type                 → catálogo pequeno: tavern | forge | mine | farm | stable | shop | caravan
  ownerCharacterId      → dono; pode não ter a profissão correspondente (Ragnar não precisa de `cook`)
  status                → 'active' | 'closed'
```

Responsabilidades do serviço, e só elas nesta fase: `create`, `get`, `close`, `changeOwner`, `validateOwnership`.

Empregados **não** vivem em `Business` — vivem em `Employment` com `employerType='business'` e `employerRef=business.id`. Isso é a resposta direta ao exemplo do pedido: Bjorn é `Employment{employerType:'business', employerRef: tavernaLuaPrateada.id, positionCode:'head_cook'}`, e sua Profissão (`cook`) continua sendo uma linha independente em `character_professions` — as duas nunca se misturam.

**Conta econômica própria (`economyAccountRef`) fica fora do escopo mínimo desta fase** — confirmado em código que `core/economy-service.ACCOUNT_KINDS` hoje é `{character, city, hold, faction, realm, escrow}` `[CODE]`, sem `business`; adicionar um 7º tipo é estruturalmente igual aos existentes (tabela própria + coluna de saldo) e não quebra nenhuma invariante das 5 já existentes, mas só entra quando Payroll/Business Economy virar trilha ativa (ver Decision Summary).

### Integrações futuras, com fronteira declarada

| Sistema | Integração | Fronteira |
|---|---|---|
| property/housing | `Business` pode referenciar um `housing`/propriedade como local físico | Business não *é* a propriedade; propriedade é onde o negócio funciona, e pode trocar sem recriar o negócio |
| market-stalls | Uma banca pode pertencer a um `Business` em vez de só a um personagem | Extensão de `market-stalls-service`, não fusão — banca continua sendo unidade de venda, negócio é a entidade dona |
| economy | `Business.economyAccountRef` usa `ACCOUNT_KINDS` de `core/economy-service.js` | Precisa avaliar se `business` vira um 7º tipo de conta ali (hoje são `character/city/hold/faction/realm/escrow`) — decisão pontual, não estrutural |
| treasury/account | Mesmo ponto acima — negócio tem caixa próprio, separado do dono | Evita repetir o erro de `economy-service` antigo (dinheiro do negócio sumindo dentro do dinheiro do personagem) |
| employment | Empregados do negócio são `Employment` com `employerType='business'` | Já coberto acima |
| contracts | Negócio pode ser parte de um contrato (ex. "Ferraria X se compromete a entregar 10 espadas") | `contracts-service` ganharia `partyType='business'` opcional, sem mudar a máquina de estados |
| taxes | Já existe em `market-stalls-service` (imposto na venda) | Reaproveitar o mecanismo existente, não inventar um segundo sistema de imposto |
| inventory/container | Negócio pode ter estoque próprio via `core/inventory-owner.js` | O tipo `property` já está **reservado** em `inventory-owner.js` sem implementação — `business` seria um tipo novo similar, não uma mudança no framework |

---

## 9. Public Work

Regra fundamental do pedido, adotada sem alteração: **Public Work nunca produz diretamente o recurso valioso de uma profissão.**

Aplicando isso às três funções atuais de `jobs-service` (ver §19 para o plano de migração completo):

- `mineOre` → **viola a regra diretamente.** Minério é o produto central da profissão `miner` + Resource Node/Minerador. Não deve sobreviver como Public Work.
- `chopWood` → **viola a regra se madeira for o produto central de `lumberjack`.** Mesma lógica do minério — se Lenhador for ativado seguindo a família de nó estático (§11), `chopWood` como Public Work concorre com ele.
- `catchFish` → mesma análise de `chopWood`, para `hunter`/pesca.

**Conclusão: nenhum dos três verbos atuais de `jobs-service` sobrevive como está.** O catálogo correto de Public Work são os exemplos que o próprio pedido lista — entrega, transporte, ajuda — nunca coleta do recurso primário. Exemplos adotados como catálogo-alvo: `hay_delivery`, `firewood_delivery`, `courier_run`, `porter`, `dock_worker`, `supply_runner`, `farm_helper`, `stable_helper`, `caravan_helper`.

Características técnicas do serviço `public-work-service` (nome proposto, não decisão de nomear já — ver §19):
- Sem slot de profissão, sem XP profissional (usa o mesmo padrão de recompensa direta que `jobs-service` já tem via `transactionService.giveItem`/ouro).
- Cooldown obrigatório — **gap que `jobs-service` atual não tem**, precisa ser corrigido na migração, não herdado.
- Determinístico ou, se houver variação, com semente auditável — corrige a pendência do `Math.random()` que a auditoria encontrou.
- Server-authoritative: usa Interaction Framework (alvo `object` ou `player`, conforme o trabalho) em vez de comando de chat cru — corrige a ausência de verificação de posição que `jobs-service` também não tem hoje.

**[REVISADO 21/08] Correção sobre execução síncrona.** A versão anterior deste documento presumiu execução síncrona para todo Public Work. Isso está incorreto para trabalhos com origem/destino separados (`hay_delivery`, `firewood_delivery`, `courier_run`, `supply_runner`) — eles têm início e conclusão em momentos diferentes, e tratá-los como síncronos deixaria sem onde guardar "já peguei a carga, ainda não entreguei", abrindo fake completion e double payout. Correção adotada (ADR 011): separar **`PublicWorkDefinition`** (catálogo estático em código — tipo de trabalho, origem/destino possíveis, recompensa, cooldown) de **`PublicWorkRun`** (instância persistente da execução):

```
PublicWorkRun
  id
  characterId
  workType            → referencia um PublicWorkDefinition
  origin / destination
  status               → 'assigned' | 'in_progress' | 'completed' | 'cancelled' | 'expired'
  startedAt / completedAt
  cargoToken           → identifica a carga específica desta corrida — evita completar sem ter pego
  requestId            → idempotência, mesmo padrão de contracts-service/economy-service
```

Comportamento em restart: toda `PublicWorkRun` em `assigned`/`in_progress` no boot é candidata a `expired` por varredura periódica — reaproveita o padrão já usado por `contracts-service.sweepExpired` e `market-stalls-service` (timer de expiração), não inventa mecanismo novo. Validação de cargo/rota/destino acontece na transição para `completed`, nunca na criação — o servidor confirma no fim, não confia na declaração do cliente no início.

**Employment não é dependência técnica de Public Work.** As duas trilhas — Gameplay/Economic Loop (Mining → Public Work → Lumberjack/Fishing → Crafting) e Social/Economic Organizations (Employment → Business → Payroll → Contracts) — avançam em paralelo; nenhuma bloqueia a outra no `module-registry`. Ver Decision Summary para as duas trilhas formalizadas.

---

## 10. Contracts

`contracts-service.js` **não muda de forma**. A única extensão proposta é opcional e aditiva: `Contract.context` podendo referenciar `{employmentId}` ou `{businessId}` quando o contrato nascer de uma relação de emprego ou negócio (ex. "Ferraria X promete entregar via contrato formal, não via emprego direto") — sem que a máquina de estados (`open→accepted→delivered→settled/disputed`) precise saber o que é Employment ou Business.

| Integração | Deve existir? | Como, sem acoplar |
|---|---|---|
| Contracts × Profession | **Não diretamente.** Um contrato pode *exigir* que quem entrega tenha uma profissão (ex. "só Ferreiro pode aceitar"), mas isso é uma checagem feita no momento de `accept()`, não uma FK estrutural | Checagem opcional em `accept()`, mesmo padrão de gate que `crafting-service` já usa contra `profession-service.hasProfession` |
| Contracts × Employment | **Opcional, referência fraca** | `context.employmentId` nullable |
| Contracts × Business | **Opcional, referência fraca** | `context.businessId` nullable, permite "negócio X" ser parte contratante |
| Contracts × Public Work | **Não.** Contrato é obrigação combinada entre partes nomeadas; Public Work é atividade aberta a qualquer um. Misturar os dois quebra a semântica de ambos | Fronteira mantida por design, não por falta de caso de uso |
| Contracts × Inventory | **Já existe implicitamente** — entrega de contrato hoje é só ouro (escrow), a auditoria não achou movimentação de item. Se contratos de entrega física (§ pedido, "delivery"/"crafting order") avançarem, a extensão natural é `core/inventory.exchange`, já pronto | Sem mudança de framework, só de uso |
| Contracts × Economy | **Já existe** — é o uso central do serviço hoje (escrow) | Sem mudança |

Tipos futuros de contrato citados no pedido (`delivery`, `procurement`, `crafting order`, `caravan transport`, `construction`, `service`, `employment-related obligation`) **não pedem nova máquina de estados** — todos cabem no `open→accepted→delivered→settled/disputed` já existente, diferenciados só por `Contract.category` (campo que provavelmente já existe ou é trivial de adicionar — não confirmado nesta rodada, fora do escopo de validação necessária).

---

## 11. Gathering Families — Minerador como referência

A cadeia confirmada pela auditoria:

```
Profession (gate) → Resource Node (consume atômico) → Interaction Framework (alvo `object`, distância)
   → tool validation (client-trusted só para iniciar) → Inventory (tx.applyInventoryDelta)
   → Profession XP (chamada separada, pós-sucesso)
```

**Generalizável para Lenhador e Pescador, sem mudança de arquitetura** — ambos são nó estático (`TREE`, `FISHING` já existem como categorias no `resource-node-registry.js`), mesma forma de interação `object`, mesma checagem de ferramenta trocando o item exigido. A auditoria já havia marcado isso como família "nó estático"; este documento formaliza que a *implementação*, não só a categoria de dado, é reaproveitável — trocar `resourceBaseId`/tipo de ferramenta/mensagens, sem trocar o pipeline.

**Não generalizável para Fazendeiro** — precisa de uma ação anterior ("plantar") que não existe no framework atual; `resource-node-service.createNode()` hoje é chamado só por script de seed (staff), não pelo jogador em tempo real. Fazendeiro pediria um `plantNode()` novo, com decisão de design em aberto (quem pode plantar onde, o que acontece se ninguém colher — abandono do nó vira lixo, vira disponível para qualquer um?). **Fora do escopo desta arquitetura** — fica registrado como pergunta aberta, não resolvido aqui.

**Não generalizável para Caçador** — Resource Node modela um nó **estático com capacidade que regenera**; uma criatura é um alvo que se **move e morre**, semântica oposta (não "regenera capacidade", "nasce de novo" em outro lugar/momento, se é que nasce). Precisa de um framework de "alvo vivo" — que não existe, nem como esboço, e não é proposto aqui.

---

## 12. Gather Session — A vs. B

**A. Lógica por profissão** (o que existe hoje — `mining-service.js` inteiro é isso).
**B. Gather Session genérica** (`actor`, `target`, `profession`, `tool`, `startedAt`, `duration`, `movementTolerance`, `cancelOnDeath`, `cancelOnDisconnect`, `animation`, `completion`, `idempotency`).

| Critério | A | B |
|---|---|---|
| Consumidores reais hoje | 1 (Minerador) | 0 |
| Consumidores prováveis após Lenhador/Pescador (§11) | 3, quase idênticos | 3, share de código real |
| Custo de construir agora | Zero (já existe) | Alto — nenhuma das partes citadas (duração, animação, cancelamento) existe em lugar nenhum do código hoje; seria escrito do zero sem nenhum consumidor validado em jogo |
| Risco de abstração prematura | Baixo | **Alto** — a Constituição §14 do projeto ("nunca implementar primeiro") e o padrão já visto em `resource-node-registry.js` (que deliberadamente recusou um catálogo rico "porque só há 5 categorias, não 50") apontam na mesma direção |

**Recomendação: não construir Gather Session agora.** Com 1 consumidor validado (e ainda não confirmado em jogo — bloqueador da própria auditoria) e 0 consumidores adicionais implementados, generalizar é abstração prematura pelo próprio critério do projeto (`module-registry.js` já documentou essa recusa explicitamente para outro caso: "generalizar seria abstração prematura — a mesma que a §15 pede para evitar"). **Revisitar quando Lenhador ou Pescador estiver em construção real** — nesse ponto, com 2 consumidores concretos, a decisão de extrair vira comparação com evidência, não especulação.

---

## 13. Crafting Integration

Sem mudança na forma atual — `crafting_recipes.required_profession`/`required_rank` (migration-v20) continuam funcionando exatamente como estão.

Extensão proposta, aditiva e opcional: `crafting_recipes.required_specialization` (nullable, mesmo padrão das duas colunas existentes). Regra de coexistência:

```
craftItem() hoje:  required_profession null? pula. Senão, checa hasProfession + rank >= required_rank.
craftItem() futuro: required_profession null? pula. Senão, checa hasProfession + rank >= required_rank.
                     required_specialization null? pula. Senão, checa character_specializations
                     (existe linha ativa, herdando status da profissão pai — §5).
```

Nenhuma receita existente quebra: todas as receitas atuais têm `required_specialization` implicitamente null (coluna nova, default null), então o comportamento delas não muda um bit. Isso responde diretamente à pergunta do pedido ("sem quebrar receitas atuais") — é aditivo por construção, não por cuidado extra.

Pipeline-alvo, formalizado:

```
Profession (gate) → Specialization (gate opcional) → Recipe → Workstation (comparação de station_type — ainda não é proximidade real, gap já registrado pela auditoria) → Inventory transaction (core/inventory.exchange) → XP/progression (profession, não specialization — §5)
```

---

## 14. Governance Boundary

Formalização explícita, para fixar em um lugar único:

```
PROFISSÃO    = conhecimento          → nunca concede poder institucional
EMPREGO      = relação trabalhista   → nunca concede poder institucional (mesmo employerType='institution')
CARGO        = posição               → concede poder SÓ quando vive dentro de Governance;
                                        cargo de negócio privado nunca concede poder
GOVERNANCE   = autoridade legal      → única fonte de PERMISSIONS (GUARD_*, STALL_*, MANAGE_TREASURY etc.)
NEGÓCIO      = entidade econômica    → nunca concede poder institucional
```

Um "Guarda de Solitude" com `Employment{employerType:'institution', position:'guard'}` continua **sem nenhum poder** até que exista, separadamente, uma entrada em `governance_memberships` com o cargo correspondente em `DEFAULT_ROLES` carregando as permissões `GUARD_*`. As duas entradas coexistem e descrevem coisas diferentes: uma é "ele trabalha para a Guarda de Solitude" (RH), a outra é "ele pode prender gente" (autoridade). **Isto não é redundância — é a mesma separação que já existe entre `identity-service` e `disguise` que a auditoria citou como precedente correto do próprio projeto.**

---

## 15. Module Boundaries

Aplicando o teste anti-overengineering do §17 do pedido a cada conceito novo:

| Conceito | Vira módulo novo no `module-registry`? | Por quê |
|---|---|---|
| Specialization | **Não** — vive dentro de `profession-service.js` como extensão (novas funções, mesma flag `ENABLE_PROFESSION_SERVICE`) | Não tem ciclo de vida próprio nem consumidor externo que justifique módulo separado; é satélite de Profession |
| Employment | **Sim, módulo novo** (`employment`) | É o único conceito com identidade própria, consumidores múltiplos (Governance, Business, Public Work indiretamente) e ciclo de vida real (contratação/demissão) |
| Business | **[REVISADO 21/08] Sim, módulo novo próprio** (`business`), não mais extensão de Employment/Market Stalls — ver ADR 010 | Business responde uma pergunta diferente de Employment (ADR 007); misturar os dois violaria a própria taxonomia deste documento |
| Public Work | **Sim, módulo novo**, sucessor de `jobs` (nome a decidir, §19) | Já existe como módulo hoje (`jobs`); a decisão é sobre o que ele vira, não se deve existir. **Não declara `employment` como `dependencies` no module-registry** — as duas trilhas (Gameplay/Economic Loop vs. Social/Economic Organizations) avançam em paralelo, sem acoplamento técnico |
| Governance | Sem mudança | Já é módulo, já é a fonte de verdade |
| Contracts | Sem mudança | Já é módulo, extensão é aditiva |

---

## 16. Data Model Proposal

Sem SQL, conceitual apenas — para cada tabela, a pergunta obrigatória do §17 do pedido respondida:

### `character_specializations`
- **Razão de existir:** cardinalidade 1-para-N que `character_professions` não tem espaço para representar sem violar a forma normal (uma profissão pode ter zero ou mais ramos escolhidos).
- **Autoridade:** `profession-service.js` (extensão), não um serviço novo.
- **Relacionamento:** FK obrigatória para a linha específica de `character_professions` (não para `character_id` direto — herda status por essa referência, §5 resposta 7).
- **Por que não cabe em tabela existente:** `character_professions.profession_code` é `VARCHAR(32)` sem hierarquia; forçar "blacksmith:armorsmith" como string composta quebraria toda leitura existente que já compara `profession_code` a valores do registry.

### `employments`
- **Razão de existir:** é o conceito central ausente identificado pela auditoria — relação personagem↔empregador que não é Profissão nem Governance.
- **Autoridade:** `employment-service.js` (novo módulo, §15).
- **Relacionamento:** FK para `character_id`; `employerType` + `employerRef` como referência polimórfica (mesmo padrão já usado em `core/inventory-owner.js` para `{type, ref}` — reaproveita convenção existente do projeto, não inventa uma nova).
- **Por que não cabe em tabela existente:** `character_professions` não tem empregador; `governance_memberships` não cobre negócio privado nem emprego informal entre personagens.

### `businesses`
- **Razão de existir:** entidade dona de um negócio, referenciável por `Employment.employerRef` e por futuras integrações (market-stalls, contracts).
- **Autoridade:** **[REVISADO 21/08]** `business-service.js`, módulo próprio — não mais `employment-service.js`/`market-stalls-service.js` estendido (ADR 010).
- **Relacionamento:** FK `ownerCharacterId` → `characters`; referenciada por `employments.employerRef` quando `employerType='business'`.
- **Por que não cabe em tabela existente:** não há hoje nenhuma tabela que represente "entidade econômica com dono", só posse individual (`housing.buyProperty`, PARKED) ou banca individual (`market-stalls`).

### `public_work_runs` **[NOVO 21/08]**
- **Razão de existir:** instância persistente de uma execução de Public Work com origem/destino separados — evita fake completion, double payout, e define comportamento em restart/disconnect (ADR 011).
- **Autoridade:** `public-work-service.js` (sucessor de `jobs-service.js`).
- **Relacionamento:** FK `characterId` → `characters`; `workType` referencia (por código, não FK de banco) uma entrada do catálogo `PublicWorkDefinition`, que permanece estático em código.
- **Por que não cabe em tabela existente:** não é `character_professions` (Public Work não usa profissão), não é o ledger de `core/transaction-service` (esse grava a transferência de ouro/item já concluída, não o estado "em progresso" de uma corrida).

### Tabelas do pedido **não propostas** (com justificativa de recusa):

- **`employment_positions`** — **recusada.** Cargo não tem identidade própria fora do emprego que o define (§7); é a coluna `Employment.position`, não uma tabela relacional. Criar a tabela replicaria o mesmo erro que `PARKED_SERVICES_DECISION.md` já documentou para `faction-service` ("mantinha uma segunda tabela... concorrendo com governance_memberships") — aqui seria uma segunda tabela concorrendo com a própria `employments` sem ganho de expressividade.
- **`public_work_catalog`** — **recusada nesta fase.** O catálogo de Public Work (§9) é pequeno (~9 itens) e muda por decisão de design, não por conteúdo dinâmico de jogador — mesmo argumento já usado pelo projeto para não ter tabela `professions`: o catálogo (`PublicWorkDefinition`) fica em código até haver necessidade real de edição em produção.
- **`public_work_assignments` / `PublicWorkRun`** — **[REVISADO 21/08] proposta revertida — esta tabela é necessária.** A versão anterior recusou por presumir execução síncrona; a correção do §9 (trabalhos com origem/destino separados) mostra que uma corrida precisa de estado persistente para não permitir fake completion, double payout, nem perder/duplicar em disconnect. Ver ADR 011 para o desenho completo (`PublicWorkRun`, separado de `PublicWorkDefinition`, que continua em código).
- **`business_members`** — **recusada, mantida.** Isto é exatamente `employments` filtrado por `employerType='business'`. Criar as duas seria a duplicação que o §17 do pedido pede para evitar.

---

## 17. Migration Strategy (sem SQL)

Ordem de dependência entre os conceitos novos, não ordem de prioridade de produto (essa é o §22).

**[REVISADO 21/08]** Correção de escopo (item E do prompt de revisão): **Employment não é pré-requisito técnico de Public Work.** São duas trilhas paralelas, sem dependência cruzada no `module-registry`:

```
Trilha Gameplay / Economic Loop:              Trilha Social / Economic Organizations:
  Mining runtime validation                     Employment
  → Public Work (public_work_runs)              → Business
  → Lumberjack/Fishing                          → Payroll / Business Economy
  → Crafting (+ required_specialization)        → Contracts integration (context.employmentId/businessId)
```

Specialization pode avançar em paralelo a ambas assim que Profession estiver confirmada estável (já está).

Dentro de cada trilha:

1. `public_work_runs` pode nascer sozinha, sem depender de `employments` — cobre a trilha Gameplay isoladamente.
2. `employments` pode nascer sozinha — não depende de `businesses` existir (cobre `employerType IN ('institution','faction','character')` primeiro).
3. `character_specializations` pode nascer independentemente das duas trilhas — satélite só de Profession.
4. `businesses` depende de `employments` já existir, porque um negócio sem forma de ter empregado é só uma variação de `housing.buyProperty` (PARKED) sem ganho real.
5. Nenhuma tabela existente (`character_professions`, `crafting_recipes`, `resource_nodes`, `contracts`) precisa de `ALTER` além das extensões aditivas já descritas (`required_specialization` em `crafting_recipes`) — todo o resto é tabela nova, zero risco de quebrar dado existente. **Confirmado nesta revisão que `contracts` já tem `category`** (`contracts-service.js:69-72`, `[CODE]`) — não é uma extensão a fazer, já existe.

---

## 18. Compatibility With Existing Data

`character_professions` não muda de forma — as 13 linhas de catálogo continuam válidas como estão hoje; a reclassificação do §4 é **rótulo de intenção futura, não mudança de dado**. Um personagem que já tem `profession_code='guard'` hoje continua tendo essa linha depois de qualquer decisão sobre `guard`; migrar o *significado* de `guard` para Employment é uma migração de **produto** (criar a entrada equivalente em `employments`), não uma migração de **schema destrutiva**.

### Deprecation Plan

**Nenhuma entrada é removida do Profession Registry nesta rodada** — a regra final do pedido (§21) proíbe isso explicitamente. O plano abaixo é a sequência que se aplicaria **se e quando** o dono do produto aprovar a reclassificação do §4:

| Profissão | Ação futura (não agora) | Pré-condição |
|---|---|---|
| `guard` | Manter `registered:true` no registry (não quebra dado antigo), mas **não é mais o caminho recomendado para novo personagem** — a documentação e o fluxo de staff passam a apontar para `employments` | `employment-service.js` existir e cobrir `employerType='institution'` |
| `courier` | Igual — mantido no registry, mas fluxo novo aponta para Public Work (`courier_run`) ou Employment, conforme o caso | `public-work-service` e `employment-service.js` existirem |
| `innkeeper` | Igual — mantido, fluxo novo aponta para `businesses` (`type='tavern'`) | `businesses` existir |
| `stablehand` | Igual — mantido, fluxo novo aponta para `employments`/`businesses` (`type='stable'`) | idem |
| `smelter` | Igual — mantido, fluxo novo sugere virar especialização de `blacksmith` para personagem novo | `character_specializations` existir com `blacksmith` como pai |
| `tanner` | Igual — mantido, mesma lógica sob `hunter` | idem |

**Em nenhum caso a entrada é apagada do registry** — "deprecated" aqui significa "não é mais o destino recomendado para gameplay novo", nunca "personagem existente perde a profissão". Isso é consistente com o próprio padrão do projeto: `PARKED_SERVICES_DECISION.md` nunca apagou dado de jogador, só código de serviço.

---

## 19. jobs-service Migration Plan

| Parte de `jobs-service.js` hoje | Classificação | Destino |
|---|---|---|
| `transactionService.giveItem` como mecanismo de entrega | **KEEP** | Continua sendo o jeito certo de entregar item — nenhum problema encontrado aqui |
| `mineOre` | **REMOVE** | Viola a regra fundamental do §9 (Public Work não produz recurso valioso de profissão); caminho correto de minério é exclusivamente `mining-service` |
| `chopWood` | **ADAPT ou REMOVE, condicional** | Se Lenhador (§11) for construído seguindo a família de nó estático, `chopWood` vira `REMOVE` pelo mesmo motivo de `mineOre`. Até lá, pode ser `ADAPT` temporário (adicionar cooldown, tirar `Math.random()`) só se o produto decidir manter uma versão fraca de coleta de lenha como ponte — decisão do dono do produto, não default |
| `catchFish` | **ADAPT ou REMOVE, condicional** | Mesma lógica de `chopWood`, espelhando Pescador |
| Comandos de chat (`/cortarlenha`, `/garimpar`, `/pescar`) | **MIGRATE** | Os nomes de comando não sobrevivem (verbos de profissão), mas o padrão de registro de comando é reaproveitável para o catálogo novo de Public Work (`/entregarfeno` etc.) |
| Ausência de cooldown | **N/A — gap a corrigir na migração, não uma "parte" a classificar** | Fica resolvido pelo novo serviço, não herdado |
| `Math.random()` não determinístico | **N/A — mesmo caso acima** | Corrigido no novo serviço |
| Registro no `module-registry` (`id:'jobs'`) | **MIGRATE** | O descriptor (dependencies, commands, initialize) é reaproveitável como esqueleto para `id:'public-work'` — a forma está certa, o conteúdo (as 3 funções) não |

**Nome proposto para o novo serviço: `public-work-service.js` / módulo `public-work`.** Isto é proposta, não execução — a regra final do pedido (§21) proíbe renomear `jobs-service` nesta rodada. O que este documento entrega é o plano; a execução (criar o arquivo novo, aposentar o antigo) é trabalho de uma rodada futura, aprovada separadamente.

---

## 20. Risks

- **Especialização sem XP próprio pode parecer "raso" para o jogador** — se a expectativa de produto for progressão visível dentro do ramo, a decisão do §5 (herdar da profissão pai) precisa ser comunicada como escolha deliberada, não lacuna.
- **`employments.employerType='character'` (emprego informal entre jogadores) é o caso mais fácil de abusar** — sem Governance nem Business como intermediário, dois jogadores podem criar/desfazer relações de emprego sem custo, potencialmente para contornar alguma regra futura amarrada a "ter emprego". Fica registrado como risco, não resolvido aqui (nenhuma trava foi desenhada).
- **`businesses` com escopo mínimo pode ser reaberto cedo demais** — a tentação de adicionar campos (inventário próprio, funcionários direto na tabela) na primeira necessidade real é o mesmo padrão que já custou caro em `housing-service`/`horse-service` (Achado 9, débito de duas escritas sem transação). A recomendação de escopo mínimo (§8) só funciona se for respeitada na implementação.
- **Cargo institucional (Governance) e Cargo de negócio (Employment.position) usam a mesma palavra em português/inglês para conceitos com poder diferente** — risco de confusão de UI/UX e de comunicação com jogador, não só de código. Fica registrado, não é um risco técnico que este documento resolve.
- **`crafting_recipes.required_specialization` como coluna nova repete o padrão de `requires_perk`** (campo lido, potencialmente nunca comparado) **se a implementação futura esquecer de checá-lo** — mesmo risco que já se materializou uma vez neste projeto. Vale nota explícita de vigilância para quando for implementado.

---

## 21. Decisions That Require Product Owner

1. Aprovar (ou rejeitar) a reclassificação do §4 — em especial tirar `guard`/`courier`/`innkeeper`/`stablehand` do caminho recomendado de Profissão.
2. Decidir se `smelter`/`tanner` viram especialização de `blacksmith`/`hunter` ou continuam profissões irmãs — é uma escolha de profundidade de crafting, não só de arquitetura.
3. Decidir o escopo real de `Business` na primeira versão — este documento propõe mínimo (dono+nome+tipo); se o produto já sabe que precisa de mais (ex. inventário próprio de negócio) desde o início, isso muda §8 e §16.
4. **[REMOVIDO 21/08]** ~~Decidir se `Business` nasce como módulo próprio ou extensão...~~ — encerrada pela ADR 010: Business é módulo próprio, não extensão de Employment/Market Stalls. Não é mais decisão em aberto.
5. Aprovar o nome `public-work-service` (ou escolher outro) e confirmar que `chopWood`/`catchFish` são `REMOVE` (não `ADAPT` temporário) — depende de quando Lenhador/Pescador entram na fila real.
6. Priorizar entre a trilha Gameplay/Economic Loop e a trilha Social/Economic Organizations (§17) — tecnicamente independentes desde a revisão de 21/08, mas a equipe provavelmente não tem banda para as duas ao mesmo tempo.
7. Decidir se `employments.employerType='character'` (emprego informal) entra na v1 ou fica para depois — é o caso com risco de abuso citado no §20 e o mais fácil de adiar sem perder o valor central do sistema (instituição + negócio já cobrem os exemplos mais citados no pedido original).

---

## 22. Recommended Implementation Order

Ordem derivada de dependência técnica e de risco, não de preferência. **[REVISADO 21/08]** Reorganizada em duas trilhas paralelas (§17) — a numeração agora expressa passos dentro de cada trilha, não uma fila única; ver `WORK_ECOSYSTEM_DECISION_SUMMARY.md` para o próximo passo único recomendado.

1. **ADR de taxonomia** — feito nesta rodada (ADRs 007–012, `docs/technical/`).
2. **Characterization tests de `jobs-service.js` e `crafting-service.js`** — antes de qualquer migração ou extensão, porque hoje são os dois módulos sem rede de segurança nenhuma (achado da auditoria); testar o comportamento atual primeiro evita que a migração de §19 quebre algo silenciosamente. Bloqueia o resto da trilha Gameplay.
3. **Validação in-game do Minerador** — resolve o bloqueador técnico único já identificado (`locationalData` em objeto comum) antes de generalizar a família de nó estático para Lenhador/Pescador. Bloqueia o item 6 da trilha Gameplay.

**Trilha Gameplay / Economic Loop** (não depende da trilha Social):
4. **Public Work** (`public-work-service` + `public_work_runs`, migrando o que presta de `jobs-service`) — resolve a duplicação `jobs.mineOre` vs `mining-service`, achado mais concreto e mais barato de corrigir da auditoria.
5. **Lenhador/Pescador** — só depois do item 3 confirmar que a família de nó estático funciona em jogo de verdade.
6. **Crafting + `required_specialization`** — depende de Specialization (abaixo) existir para ter o que checar; o gate de profissão/rank já funciona sem ele.
7. **Gather Session** — não entra como item obrigatório; revisitar **somente se** o item 5 (Lenhador/Pescador) mostrar duplicação de código real entre os três consumidores, conforme §12.

**Trilha Social / Economic Organizations** (pode começar em paralelo com a trilha Gameplay, a partir do item 3):
8. **`character_specializations`** — depende só de Profession (já pronta); alimenta o item 6 da trilha Gameplay quando ambas chegarem lá.
9. **`employments`** — peça central da trilha Social; não bloqueia nem é bloqueada pela trilha Gameplay.
10. **`businesses`** — depende de `employments` (item 9); maior risco de escopo (§20), por isso por último na trilha.
11. **Payroll / Business Economy + Contracts integration** (`context.employmentId`/`businessId`) — depende de `businesses` (item 10) e `contracts-service.js` já suportar `category` (confirmado que já suporta, `[CODE]`).

Esta ordem prioriza **provar em jogo o que já existe (item 3) e fechar a duplicação mais barata (item 4) antes de expandir schema novo**, mas já não trata a trilha Social como subordinada à Gameplay — correção explícita do item E do prompt de revisão. É leitura conservadora, coerente com o padrão do próprio projeto de não empilhar sistema sobre sistema não validado (a mesma tensão que a Constituição §14/Anexo A.1 já nomeia: "1270 testes verdes, zero sessões com jogador").

---

## Diagrama final

**[REVISADO 21/08]** Diagrama corrigido: Business sai de dentro de Employment e vira ramo próprio de `Character`; Public Work ganha `PublicWorkRun` explícito; as duas trilhas paralelas (§17) ficam marcadas.

```
Character
  │
  ├── Profession (character_professions — SEM MUDANÇA)
  │     └── Specialization (character_specializations — NOVO, satélite, sem status/XP próprios)
  │
  ├──[Trilha Social]── Employment (employments — NOVO, módulo próprio)
  │                       └── positionCode (coluna, catálogo fechado — não texto livre; cargo de negócio privado)
  │
  ├──[Trilha Social]── Business ownership (businesses — NOVO, MÓDULO PRÓPRIO, não dentro de Employment)
  │                       └── employees ARE Employment{employerType:'business'}, não uma lista própria
  │
  ├──[Trilha Gameplay]── Public Work (public-work-service — SUCESSOR de jobs-service)
  │                         ├── PublicWorkDefinition (catálogo estático em código)
  │                         └── PublicWorkRun (NOVO, tabela persistente — status/cargoToken/requestId)
  │
  └── Contracts (contracts-service.js — SEM MUDANÇA DE FORMA; category JÁ EXISTE; context opcional novo)

Governance (governance_memberships + PERMISSIONS — SEM MUDANÇA)
  └── Institutional authority — ÚNICA fonte de GUARD_*/STALL_*/MANAGE_TREASURY (13 permissões confirmadas em código)
      (Employment.positionCode='guard' NUNCA concede isto sozinho, em NENHUM employerType)

Economy (core/economy-service.js + core/transaction-service.js — SEM MUDANÇA)
  └── Money movement — ACCOUNT_KINDS confirmado {character,city,hold,faction,realm,escrow};
      `business` como possível 7º tipo, só quando Payroll virar trilha ativa (não nesta fase)

Inventory (core/inventory.js + core/inventory-owner.js — SEM MUDANÇA)
  └── Item ownership — OWNER_TYPES confirmado {CHARACTER,CONTAINER,PROPERTY,FACTION,CORPSE,MARKET,SYSTEM},
      só os 3 primeiros implementados; `business` como possível 8º tipo, não implementado nesta fase

Interaction (core/interaction-service.js + registry + targets — SEM MUDANÇA)
  └── Gameplay action gateway — Public Work passa a usar isto (jobs-service hoje não usa)

Resource Node (core/resource-node-registry.js + resource-node-service.js — SEM MUDANÇA)
  └── Minerador (existente) ── família reaproveitável ──> Lenhador, Pescador (futuros)
      Fazendeiro e Caçador FICAM FORA desta família (§11) — frameworks próprios, não desenhados aqui
```

---

*Fim do documento. Nenhum código foi escrito, nenhuma migration foi criada, nenhum schema foi alterado, nenhum módulo PARKED foi reativado, `jobs-service` não foi renomeado, nenhuma entrada do Profession Registry foi removida.*
