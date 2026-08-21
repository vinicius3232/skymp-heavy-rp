# ADR 009 — Employment e Position

**Status:** Aceito · **Data:** 20/08/2026 · **Depende de:** ADR 007, ADR 012

## Decisão

Employment representa relação trabalhista entre personagem e empregador. Nasce como **módulo próprio** (`employment`) no `module-registry`, com tabela `employments`:

```
employments
  character_id
  employer_type   → 'institution' | 'business' | 'faction' | 'character'
  employer_ref     → referência polimórfica, mesmo padrão {type, ref} de core/inventory-owner.js
  position_code    → catálogo fechado EM CÓDIGO, não texto livre (ex.: head_cook, manager, worker, forge_master)
  status            → 'active' | 'suspended' | 'terminated'
  started_at / ended_at
```

**Position não é entidade — é `position_code`, coluna dentro de `employments`.** Catálogo fechado em código (mesmo padrão de `core/profession-registry.js`/`core/resource-node-registry.js`), com label de apresentação separado do código interno — evita que texto livre digitado em algum lugar vire regra de negócio em outro.

**Position nunca concede autoridade institucional**, em nenhum `employer_type`, inclusive `'institution'`. Ver ADR 012.

## Motivação

A auditoria já tinha identificado esta lacuna: não existe hoje onde representar "Bjorn é cozinheiro-chefe da Taverna X" sem forçar `character_professions.profession_code='cook'` a carregar informação de emprego que não é dela. A correção obrigatória (item B do prompt de revisão) trocou a proposta original de `position` como texto livre por `position_code` com catálogo fechado — mesma razão pela qual `resource-node-registry.js` fechou categorias em vez de aceitar string livre: "categoria livre vira quatro grafias da mesma coisa" `[CODE]`, citação do próprio comentário daquele arquivo.

## Consequências

- Employment é módulo novo com ciclo de vida próprio (`initialize`, `commands`, possivelmente `healthCheck`), atrás de flag própria (`ENABLE_EMPLOYMENT_SERVICE`), como todo módulo `lab` do projeto.
- `employer_ref` é uma referência fraca por `{employer_type, employer_ref}` — o serviço de Employment nunca precisa conhecer a estrutura interna de `businesses` ou `governance_memberships`, só a chave.
- **Employment NÃO é dependência técnica obrigatória de nenhum outro módulo deste domínio** (ver ADR 011 — Public Work não depende de Employment existir).
- Position codes conhecidos nascem pequenos e crescem por decisão de design, não por digitação livre em produção — mudança de catálogo é revisão de código, não dado editável em jogo nesta fase.

## Alternativas rejeitadas

- **`position` como `VARCHAR` livre.** Rejeitada explicitamente nesta revisão — abre a mesma classe de erro que `crafting_recipes.requires_perk` já demonstrou neste projeto (campo livre, nunca comparado de forma confiável).
- **Cargo como tabela própria (`employment_positions`).** Rejeitada na arquitetura-alvo anterior e mantida aqui: cargo não tem identidade fora do emprego que o define; uma tabela própria replicaria o erro já documentado em `PARKED_SERVICES_DECISION.md` para `faction-service`.
