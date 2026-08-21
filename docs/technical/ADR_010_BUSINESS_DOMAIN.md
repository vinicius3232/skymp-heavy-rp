# ADR 010 — Domínio de Business

**Status:** Aceito · **Data:** 20/08/2026 · **Depende de:** ADR 007, ADR 009 · **Revisa:** proposta original de `WORK_ECOSYSTEM_TARGET_ARCHITECTURE.md` §15, que sugeria Business como extensão de `employment-service`

## Decisão

Business é **semanticamente independente de Employment** e nasce como **serviço próprio, mínimo** (`business-service.js`), não como extensão de `employment-service.js` nem de `market-stalls-service.js`.

Responsabilidades do serviço nesta fase, e só elas:

```
create(ownerCharacterId, name, type)
get(businessId)
close(businessId)
changeOwner(businessId, newOwnerCharacterId)
validateOwnership(businessId, characterId)
```

Tabela `businesses`: `id`, `name`, `type` (catálogo fechado: `tavern | forge | mine | farm | stable | shop | caravan`), `owner_character_id`, `status`.

**Business não contém lista própria de funcionários.** Funcionários são sempre `employments` com `employer_type='business'` e `employer_ref=business.id`. `Employment` referencia `Business`; `Business` nunca referencia `Employment` de volta como lista embutida.

## Motivação

A correção obrigatória (item C do prompt de revisão) reverteu a proposta original: colocar o ciclo de vida de Business dentro de `employment-service` misturaria duas perguntas diferentes ("quem trabalha para quem" vs. "quem é dono de qual entidade econômica") no mesmo serviço, violando a própria ADR 007 que este documento depende. Business também não é Profissão (Ragnar pode possuir a Taverna Lua Prateada sem ter `cook`) nem propriedade física (`housing-service.js`, PARKED, é sobre imóvel; Business é sobre a operação econômica que pode ocupar um imóvel).

## Consequências

- `business-service.js` é módulo novo próprio no `module-registry`, com flag própria — não herda a flag de Employment nem de Market Stalls.
- `businesses.owner_character_id` é a única fonte de verdade de posse — `validateOwnership()` é a função que qualquer consumidor externo (Market Stalls, Contracts) deve chamar antes de agir em nome do negócio, nunca reimplementar a checagem.
- Extensões futuras (conta econômica própria, estoque próprio) entram como colunas/tabelas adicionais **só quando um consumidor real precisar**, não antecipadas nesta fase — evita repetir o over-reach que a auditoria encontrou em `housing-service`/`horse-service`.
- `core/economy-service.ACCOUNT_KINDS` hoje é `{character, city, hold, faction, realm, escrow}` `[CODE]`, confirmado em `core/economy-service.js:57-64` — não inclui `business`. Adicionar `business` como 7º tipo é estruturalmente igual às entradas existentes (tabela própria com coluna de saldo) e não quebra nenhuma invariante das 5 já existentes, mas **fica fora do escopo do serviço mínimo desta ADR** — entra só quando Business precisar de conta própria (Payroll, ver `WORK_ECOSYSTEM_DECISION_SUMMARY.md`).

## Alternativas rejeitadas

- **Business como extensão de `employment-service.js`** (proposta original). Rejeitada nesta revisão — mistura duas perguntas (ADR 007).
- **Business como extensão de `market-stalls-service.js`.** Rejeitada — Market Stalls é sobre uma banca de venda, uma unidade menor e mais específica; um negócio (ferraria, mina) pode nunca ter uma banca e ainda assim empregar gente.
- **Lista de funcionários embutida em `businesses`.** Rejeitada explicitamente pelo prompt de revisão — duplicaria `employments` filtrado por `employer_type='business'`.
