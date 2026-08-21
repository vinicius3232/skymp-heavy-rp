# ADR 008 — Fronteira entre Profession e Specialization

**Status:** Aceito · **Data:** 20/08/2026 · **Depende de:** ADR 007

## Decisão

`profession-service.js` + `core/profession-registry.js` + `character_professions` **não mudam**. Specialization nasce como satélite:

1. Tabela nova `character_specializations`, com FK obrigatória para a **linha específica** de `character_professions` (não para `character_id` solto).
2. **Sem XP nem rank próprios.** Especialização herda o rank da profissão pai — uma métrica de progresso, não duas.
3. **Sem status próprio.** O status efetivo de uma especialização é o status da profissão pai, lido por junção — nunca um campo `character_specializations.status` sincronizado à mão.
4. **Nunca apagada por revogação/suspensão da profissão pai.** Confirmado em código (`profession-service.js:329-337`, `_transition` de `revokeProfession`): a transição é um `UPDATE character_professions SET status='revoked'` dentro de `SELECT...FOR UPDATE`, nunca um `DELETE` `[CODE]`. `character_specializations` segue a mesma disciplina — fica persistida, indisponível para uso enquanto o pai não estiver `active`, e só é fisicamente removida se a linha pai for fisicamente removida (o que hoje não acontece em nenhum fluxo do `profession-service.js`).

## Motivação

A auditoria pediu confirmação explícita antes de presumir `DELETE` em `revokeProfession`. Confirmado: é transição de status, com histórico preservado. Specialization precisa do mesmo comportamento pelo mesmo motivo que já vale para Profession — a Constituição (§9, "toda rolagem é auditável") e o padrão geral do projeto tratam histórico de personagem como dado que não desaparece.

## Consequências

- `character_specializations` ganha, no mínimo: `id`, `character_profession_id` (FK), `specialization_code`, `chosenAt`. Sem `status`, sem `xp`, sem `rank`.
- Leitura de "especialização disponível para uso" sempre junta com `character_professions.status`, nunca confia num campo espelhado.
- Limite por profissão (`specialization.maxPerProfession`) vive em `core/server-options.js`, no mesmo padrão de `profession.maxPerCharacter`/`profession.maxRank`.
- Vive dentro de `profession-service.js` como extensão — **não é módulo novo no `module-registry`** (ADR 007, mesma flag `ENABLE_PROFESSION_SERVICE`).

## Alternativas rejeitadas

- **XP/rank próprios de especialização.** Rejeitada: duplica a máquina de progressão já existente sem necessidade comprovada; risco de dessincronia entre "rank de Ferreiro" e "rank de Armeiro" sem consumidor real que precise da distinção hoje.
- **`character_specializations.status` próprio, sincronizado por trigger/evento quando a profissão muda.** Rejeitada: cria uma segunda fonte de verdade para a mesma informação, exatamente o padrão que a auditoria já sinalizou como risco em outros pontos do domínio (`guard`/Governance).
