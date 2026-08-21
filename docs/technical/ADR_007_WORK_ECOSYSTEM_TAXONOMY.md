# ADR 007 — Taxonomia do Ecossistema de Trabalho

**Status:** Aceito · **Data:** 20/08/2026 · **Contexto:** [`WORK_PROFESSION_ECOSYSTEM_CURRENT_STATE.md`](../research/WORK_PROFESSION_ECOSYSTEM_CURRENT_STATE.md), [`WORK_ECOSYSTEM_TARGET_ARCHITECTURE.md`](../research/WORK_ECOSYSTEM_TARGET_ARCHITECTURE.md)

## Decisão

**Profession ≠ Specialization ≠ Employment ≠ Position ≠ Business ≠ Public Work ≠ Contract ≠ Governance.**

Oito conceitos, oito perguntas diferentes, nenhuma respondida por dois sistemas ao mesmo tempo:

| Conceito | Pergunta que responde |
|---|---|
| Profession | O que o personagem sabe fazer |
| Specialization | Qual ramo daquele saber ele aprofundou |
| Employment | Para quem ele trabalha agora |
| Position | Qual é o nível dele naquele emprego |
| Business | Quem é dono de qual entidade econômica |
| Public Work | O que qualquer personagem pode fazer sem saber nada |
| Contract | O que foi combinado uma vez, entre partes nomeadas |
| Governance | Quem tem poder legal sobre quem |

## Motivação

A auditoria (`WORK_PROFESSION_ECOSYSTEM_CURRENT_STATE.md`, `[CODE]`) encontrou apenas dois conceitos reais no código hoje — Profession (`character_professions`, 13 rótulos planos) e Jobs (3 verbos soltos) — e mostrou que `profession_code` mistura ofício real (`miner`), etiqueta sem poder (`guard`) e papel que só existe dentro de um negócio (`innkeeper`, `stablehand`). Sem taxonomia declarada, cada novo requisito de produto tende a ser espremido dentro de `character_professions` por conveniência, repetindo o padrão que o projeto já reverteu uma vez em `PARKED_SERVICES_DECISION.md` (`faction-service` como segunda tabela concorrendo com `governance_memberships`).

## Consequências

- Nenhuma implementação futura deve adicionar campo a `character_professions` para representar emprego, cargo ou negócio.
- Todo módulo novo (Employment, Business, Public Work) declara, no próprio código, qual das oito perguntas ele responde — e só essa.
- Ver ADRs 008–012 para o desenho de cada fronteira.

## Alternativas rejeitadas

- **Estender `character_professions` com colunas opcionais para emprego/cargo/negócio.** Rejeitada: muda a cardinalidade (profissão é 1 por código por personagem; emprego pode trocar de empregador sem perder a profissão) e reintroduz o mesmo erro que motivou apagar `faction-service`.
- **Um único conceito genérico "Role" cobrindo todos os oito.** Rejeitada: a Constituição do projeto (§13) exige baixo acoplamento e domínio separado de infraestrutura; um "Role" genérico obrigaria todo consumidor a filtrar por tipo em runtime, perdendo a garantia de schema que uma tabela dedicada dá.
