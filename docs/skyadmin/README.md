# SkyAdmin — centro de documentação

Este diretório é o ponto de entrada para construir o painel administrativo e de staff do SkyMP Heavy RP. Ele não substitui a documentação existente: organiza as decisões e indica a fonte de verdade de cada tema.

> **Leia antes: [`../admin/SKYADMIN_CURRENT_STATE.md`](../admin/SKYADMIN_CURRENT_STATE.md) (15/08/2026)** — o mapa funcionalidade a funcionalidade do que roda hoje, incluindo a administração de voz — e a auditoria que o precede, [`../research/ADMIN_PLATFORM_AUDIT.md`](../research/ADMIN_PLATFORM_AUDIT.md) (13/08/2026).
> Este diretório descreve **intenção**; a auditoria mediu o **estado**. A §7 dela reconcilia marco a marco — dos seis marcos do [plano](IMPLEMENTATION_PLAN.md), só o Marco 1 tem entrega verificável. A única frase deste diretório que descreve o presente é a lista de "Estado atual" logo abaixo.
> Os desdobramentos da auditoria vivem em [`../admin/`](../admin/ADMIN_PLATFORM.md) e em [ADR 005](../technical/ADR_005_ADMIN_RBAC.md), que decide o RBAC do Marco 2.

## Estado atual

- Base: `apps/web` (Express), `apps/game-api`, `apps/bot-discord`, `apps/launcher`, `skymp/gamemode` e MariaDB.
- Identidade online: `Discord -> accounts.id -> game session -> profileId SkyMP -> personagem/actor`.
- Marco AUTH-003 concluído: `whitelist.js` resolve o `profileId` como `accounts.id`; não como Discord ID.
- Não existe ainda RBAC granular no painel, pipeline unificado de ações, Agent remoto, bans persistentes ou interface operacional completa.

## Ordem de leitura

1. [PROJECT_CHARTER.md](PROJECT_CHARTER.md) — escopo, objetivo e limites.
2. [ARCHITECTURE.md](ARCHITECTURE.md) — arquitetura alvo e contratos.
3. [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) — marcos, entregáveis e critérios de aceite.
4. [SECURITY_MODEL.md](SECURITY_MODEL.md) — ameaças, controles e regras não negociáveis.
5. [OPERATIONS_AND_TESTING.md](OPERATIONS_AND_TESTING.md) — execução, migração, testes e staging.
6. [REFERENCE_CATALOG.md](REFERENCE_CATALOG.md) — referências externas, estudo e engenharia reversa permitida.
7. [DECISIONS.md](DECISIONS.md) — decisões arquiteturais vigentes.

## Fontes existentes que permanecem canônicas

| Tema | Documento ou código |
|---|---|
| Visão geral do servidor | [../ARCHITECTURE.md](../ARCHITECTURE.md) |
| Identidade e sessão | [../technical/CHR_001_ACCOUNT_SESSION_CHARACTER_IDENTITY.md](../technical/CHR_001_ACCOUNT_SESSION_CHARACTER_IDENTITY.md), [../technical/ADR_001_ONLINE_PROFILE_ID_IS_ACCOUNT_ID.md](../technical/ADR_001_ONLINE_PROFILE_ID_IS_ACCOUNT_ID.md) |
| Limites de confiança | [../technical/AUTH_001_TRUST_BOUNDARY_INVENTORY.md](../technical/AUTH_001_TRUST_BOUNDARY_INVENTORY.md) |
| Operação do SkyMP | [../technical/OPERATIONS.md](../technical/OPERATIONS.md), [../technical/SKYMP_SERVER_SETUP.md](../technical/SKYMP_SERVER_SETUP.md) |
| Critério de whitelist | [../staff/WHITELIST_RUBRIC.md](../staff/WHITELIST_RUBRIC.md) |
| Migrations e schema | `skymp/packages/database/schema.sql` e migrations `v2`–`v16` |
| Regras do servidor | [../rules/HEAVY_RP_RULES.md](../rules/HEAVY_RP_RULES.md) |

## Convenção

Toda mudança de comportamento administrativo deve atualizar, no mínimo: contrato de API, permissão exigida, efeito no banco/jogo, auditoria, teste automatizado e este índice quando alterar a arquitetura.
