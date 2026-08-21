# ADR 012 — Fronteira de Autoridade da Governança

**Status:** Aceito · **Data:** 20/08/2026 · **Depende de:** ADR 007

## Decisão

**Somente `governance-service.js`, via `PERMISSIONS` nomeadas, concede autoridade institucional.** Nunca Profession, nunca Employment (nenhum `employer_type`, inclusive `'institution'`), nunca Position (`position_code`), nunca Business.

Confirmado em código nesta revisão: `governance-service.js` define 13 permissões relevantes a poder de guarda e banca — `GUARD_DUTY`, `GUARD_SEARCH`, `GUARD_DETAIN`, `GUARD_ARREST`, `GUARD_FINE`, `GUARD_WARRANT`, `GUARD_CONFISCATE`, `GUARD_RELEASE`, `STALL_INSPECT`, `STALL_SUSPEND`, `STALL_CONFISCATE`, `STALL_ISSUE_LICENSE`, `STALL_COLLECT_TAX` `[CODE]`. Nenhuma delas é hoje, nem deve no futuro ser, checada contra `hasProfession`, `Employment.position_code` ou posse de `Business`.

Um "Guarda de Solitude" no sistema-alvo é modelado por **duas linhas independentes**, cada uma respondendo sua própria pergunta (ADR 007):
```
employments:            {character_id, employer_type:'institution', employer_ref:'solitude', position_code:'guard'}
governance_memberships:  {character_id, role: cargo com GUARD_* em DEFAULT_ROLES}
```
A primeira diz "ele trabalha para a Guarda de Solitude" (RH). A segunda diz "ele pode prender gente" (autoridade). As duas podem existir sem a outra: um funcionário recém-contratado (`employment` ativo) sem ainda ter sido empossado (`governance_membership` pendente) não tem poder nenhum até a segunda linha existir.

## Motivação

A auditoria já havia identificado que `profession-registry.guard` é hoje puramente decorativo, e nomeou o risco: "nada impede um consumidor futuro de errar e checar a fonte errada". Esta ADR formaliza a regra para que a checagem correta seja **a única opção sancionada**, não uma convenção implícita — mesmo objetivo que motivou nomear `PERMISSIONS` explicitamente em vez de nível numérico legado (`PARKED_SERVICES_DECISION.md` §7.4, onde `hasPermission(actorId, 20)` negava sempre e silenciosamente).

## Consequências

- Todo módulo novo deste domínio (Employment, Business, Public Work) que precisar de uma ação de poder (prender, revistar, multar, confiscar) importa `governance-service.hasPermission`/`PERMISSIONS` diretamente — nunca reimplementa a checagem nem a deriva de `position_code`/profissão.
- Code review de qualquer PR que toque Employment/Business/Position deve recusar qualquer `if (position_code === 'guard')` ou equivalente usado para autorizar ação — é o mesmo padrão de erro já corrigido uma vez neste projeto.
- Cargo institucional continua vivendo exclusivamente em `governance_memberships`/`DEFAULT_ROLES` — Employment nunca ganha uma cópia de cargo institucional; quando `employer_type='institution'`, `Employment.position_code` é só rótulo de RH (ex. `'guard'`, `'herald'`), redundante por design com o cargo real que vive em Governance, e nunca a fonte de autorização.

## Alternativas rejeitadas

- **`Employment.position_code='guard'` concedendo `GUARD_*` automaticamente quando `employer_type='institution'`.** Rejeitada — recria exatamente a segunda fonte de verdade que esta ADR existe para impedir; contratação e investidura de poder são dois eventos distintos no mundo real do RP (a Constituição do projeto, §6, pede "consequência" e "risco" — um "novato contratado" sem poder ainda é uma história melhor que poder automático por contrato).
- **Um campo `grantsAuthority: boolean` em `position_code`.** Rejeitada — reintroduziria decisão de autoridade fora de `governance-service.js`, ainda que como flag em vez de checagem direta.
