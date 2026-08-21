# Resumo de Decisão — Ecossistema de Trabalho

**Data:** 20/08/2026 · **Fecha:** auditoria (`WORK_PROFESSION_ECOSYSTEM_CURRENT_STATE.md`) → arquitetura-alvo (`WORK_ECOSYSTEM_TARGET_ARCHITECTURE.md`) → revisão + ADRs 007–012 (`docs/technical/`) · **Natureza:** decisão congelada, zero código

---

## Approved Decisions

1. **Taxonomia de oito conceitos, sem sobreposição** (ADR 007): Profession, Specialization, Employment, Position, Business, Public Work, Contract, Governance — cada um responde uma pergunta que nenhum outro responde.
2. **Profession preservada exatamente como está** — `profession-service.js`, `core/profession-registry.js`, `character_professions`, sem mudança de schema nem de forma.
3. **Specialization é satélite de Profession** (ADR 008): sem XP/rank/status próprios, herda tudo da profissão pai por junção; nunca apagada por `DELETE`, indisponível por herança quando o pai é suspenso/revogado — confirmado em código que `revokeProfession`/`suspendProfession` são `UPDATE` de status, nunca `DELETE`.
4. **Employment com `positionCode` de catálogo fechado, nunca texto livre** (ADR 009) — corrigido nesta rodada a partir da proposta original.
5. **Business é serviço próprio e independente**, não extensão de Employment (ADR 010) — corrigido nesta rodada; escopo mínimo (`create`/`get`/`close`/`changeOwner`/`validateOwnership`); funcionários vivem em Employment, nunca duplicados dentro de Business.
6. **Public Work com execução assíncrona via `PublicWorkRun`** (ADR 011) — corrigido nesta rodada; `PublicWorkDefinition` (catálogo, código) separado de `PublicWorkRun` (execução, tabela); idempotência por `requestId`, expiração por varredura periódica no padrão já usado em `contracts-service`/`market-stalls-service`.
7. **Regra fundamental de Public Work mantida sem alteração**: nunca produz diretamente o recurso econômico primário de uma profissão. `jobs.mineOre` é `REMOVE`; `chopWood`/`catchFish` são no máximo caminho legado temporário, removidos quando Lenhador/Pescador existirem.
8. **Autoridade institucional é monopólio de Governance** (ADR 012): nenhuma permissão de prender/revistar/multar/confiscar pode vir de Profession, Employment (nenhum `employerType`), Position ou Business — confirmado em código as 13 permissões nomeadas relevantes (`GUARD_*`, `STALL_*`), nenhuma checando Profession hoje.
9. **Duas trilhas de implementação paralelas, sem dependência técnica cruzada**: Gameplay/Economic Loop (Mining validation → Public Work → Lumberjack/Fishing → Crafting) e Social/Economic Organizations (Employment → Business → Payroll → Contracts integration) — corrigido nesta rodada; a versão anterior tratava Employment como pré-requisito de Public Work.
10. **`contracts-service.js` já tem `category`** (confirmado em código: `CATEGORIES = [mercenary, caravan, delivery, bodyguard, crafting, mining, harvest, hunt, arcane, investigation, generic]`) — nenhuma extensão de schema necessária para os tipos de contrato futuros citados (`delivery`, `crafting order`, etc.); só `context.employmentId`/`businessId` opcional é novo.
11. **Reclassificação candidata das 13 profissões registrada** (`WORK_ECOSYSTEM_TARGET_ARCHITECTURE.md` §4) — nenhuma remoção real, só mudança de "caminho recomendado" quando Employment/Business existirem.
12. **Gather Session genérica: não construir agora** — abstração prematura com um único consumidor (Minerador) ainda não validado em jogo.
13. **Nenhuma tabela existente sofre `ALTER` destrutivo** — todas as extensões propostas (`required_specialization` em `crafting_recipes`) são aditivas, nullable, e não alteram comportamento de dado já existente.

---

## Open Decisions

Do dono do produto, sem resposta nesta rodada (ver `WORK_ECOSYSTEM_TARGET_ARCHITECTURE.md` §21 para a lista completa; os itens abaixo são os que a revisão de hoje não fechou):

1. Aprovar ou rejeitar a reclassificação de `guard`/`courier`/`innkeeper`/`stablehand`/`smelter`/`tanner`.
2. Escopo real de `Business` na v1 — este documento propõe mínimo; se o produto já sabe que precisa de mais desde o início, isso muda o desenho.
3. Se `employments.employerType='character'` (emprego informal entre jogadores, sem instituição nem negócio) entra na v1 ou fica para depois — é o caso com maior risco de abuso e o mais fácil de adiar.
4. Priorização entre as duas trilhas (§17 da arquitetura) — tecnicamente independentes, mas provavelmente concorrem pela mesma banda de equipe.
5. Aprovar o nome `public-work-service` (ou escolher outro) e confirmar que `chopWood`/`catchFish` são `REMOVE` definitivo, não `ADAPT` temporário — depende de quando Lenhador/Pescador entram na fila real.
6. Quando (se) `business` vira um 7º `ACCOUNT_KIND` em `core/economy-service.js` — só quando Payroll/Business Economy virar trilha ativa, não decidido nesta rodada.

---

## Rejected Alternatives

| Alternativa | Por que foi rejeitada | Onde |
|---|---|---|
| Estender `character_professions` com colunas de emprego/cargo/negócio | Muda cardinalidade; repete o erro já revertido de `faction-service` (segunda tabela concorrendo com `governance_memberships`) | ADR 007 |
| Um conceito genérico único ("Role") para os oito domínios | Obrigaria todo consumidor a filtrar por tipo em runtime, perdendo garantia de schema | ADR 007 |
| Specialization com XP/rank/status próprios | Duplica progressão sem consumidor real que precise da distinção; risco de dessincronia | ADR 008 |
| `character_specializations.status` sincronizado por trigger | Recria segunda fonte de verdade para a mesma informação | ADR 008 |
| `Employment.position` como texto livre | Repete a classe de erro já vivida com `crafting_recipes.requires_perk` (campo lido, nunca comparado de forma confiável) | ADR 009 |
| Cargo como tabela própria (`employment_positions`) | Sem identidade fora do emprego que o define; replicaria erro de `faction-service` | ADR 009 |
| Business como extensão de `employment-service.js` (proposta original) | Mistura "quem trabalha para quem" com "quem é dono do quê" | ADR 010 |
| Business como extensão de `market-stalls-service.js` | Banca é unidade menor/mais específica; negócio pode nunca ter banca e ainda empregar gente | ADR 010 |
| Lista de funcionários embutida em `Business` | Duplicaria `employments` filtrado | ADR 010 |
| Public Work 100% síncrono (proposta original) | Não sobrevive a disconnect/reconnect; abre fake completion e double payout para trabalhos com origem/destino | ADR 011 |
| `PublicWorkRun` copiando os dados do catálogo por linha | Duplicação de fonte de verdade; `PublicWorkRun` referencia `workType`, não copia | ADR 011 |
| `public_work_catalog` como tabela dinâmica | ~9 itens não justificam edição em produção nesta fase | ADR 011 (mantida da arquitetura anterior) |
| `Employment.positionCode='guard'` concedendo `GUARD_*` automaticamente | Recria a segunda fonte de autoridade que a ADR 012 existe para impedir | ADR 012 |
| Flag `grantsAuthority` em `positionCode` | Reintroduziria decisão de autoridade fora de `governance-service.js`, ainda que disfarçada de dado | ADR 012 |

---

## Technical Preconditions

Confirmações de código feitas antes de formalizar qualquer ADR (nenhuma presumida):

| Afirmação | Evidência |
|---|---|
| `revokeProfession`/`suspendProfession` são `UPDATE` de status, nunca `DELETE` | `[CODE]` `profession-service.js:282-337`, função `_transition`, `SELECT...FOR UPDATE` + `UPDATE character_professions SET status=?` |
| `core/economy-service.ACCOUNT_KINDS` = `{character, city, hold, faction, realm, escrow}`, sem `business` | `[CODE]` `core/economy-service.js:57-64` |
| `core/inventory-owner.OWNER_TYPES` = `{CHARACTER, CONTAINER, PROPERTY, FACTION, CORPSE, MARKET, SYSTEM}`, só 3 implementados, sem `business` | `[CODE]` `core/inventory-owner.js:59-67` |
| `contracts-service.js` já tem `category`/`CATEGORIES` (11 valores, incluindo `delivery`, `crafting`, `mining`, `harvest`, `hunt`) | `[CODE]` `contracts-service.js:69-72` |
| `module-registry.js` distingue `dependencies` (obrigatória, bloqueia boot) de `optionalDependencies` (consultada só se ativa, não bloqueia) | `[CODE]` `core/module-registry.js:198-227`, `257-336` |
| `governance-service.js` tem 13 permissões nomeadas de guarda/banca, nenhuma checando Profession | `[CODE]` `governance-service.js` (grep confirmado nesta e na rodada anterior) |

Nenhum destes pontos foi assumido por documentação — todos foram lidos diretamente no código-fonte atual antes de qualquer ADR ser escrito, conforme exigido pelo item 2 do prompt de revisão.

---

## Next Implementation Task

**Characterization tests de `jobs-service.js` e `crafting-service.js`.**

Motivo de ser o primeiro passo, não uma escolha entre várias igualmente válidas: é o único item que (a) não depende de nenhuma decisão em aberto do dono do produto, (b) não cria tabela nem módulo novo, (c) reduz risco de todas as trilhas seguintes — tanto a migração de `jobs-service` para Public Work (trilha Gameplay) quanto qualquer extensão futura de `crafting-service` com `required_specialization` (que depende da trilha Social) partem de um comportamento hoje **não coberto por nenhum teste**, achado mais concreto e mais barato de corrigir de toda a auditoria.

Não é ainda a primeira tarefa de *construção* de arquitetura nova (`employments`, `public_work_runs` etc.) — essas aguardam as decisões abertas listadas acima.
