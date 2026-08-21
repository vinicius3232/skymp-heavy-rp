# Plano de implementação — Codex + Claude

Data-base: 2026-08-12. Entrada do Claude: quinta-feira, 2026-08-13. Este plano coordena a execução; não ativa módulos PARKED e não substitui o roadmap principal.

## Objetivo do ciclo

Entregar uma fundação segura para autenticação, personagem e distribuição do modpack antes de iniciar facções ou propriedades. O ciclo termina quando sessão e identidade não dependem de dados confiados ao cliente, o manifesto do client pack tem contrato determinístico e há uma decisão técnica de voz baseada em medições.

## Regras de colaboração

1. Uma tarefa tem um único responsável por implementação e outro por revisão.
2. Codex e Claude não editam simultaneamente o mesmo arquivo.
3. Antes de começar, registrar no quadro abaixo: status, branch/commit-base e arquivos reservados.
4. Mudanças de banco usam somente MariaDB/MySQL, `mysql2/promise`, migration versionada e atualização de `skymp/packages/database/schema.sql`.
5. Nenhum código é copiado diretamente de forks sem revisão de licença. Forks servem como referência arquitetural.
6. Toda entrada de cliente/CEF é hostil. O servidor resolve session, character, permissão, target, preço e ownership.
7. Cada entrega inclui testes negativos, `npm test`, typecheck pertinente, `git diff --check` e nota de handoff.
8. Módulos PARKED permanecem sem registro até um gate explícito aprovado pelo usuário.

## Estado inicial que deve ser preservado

O snapshot das tarefas `TASK_001` a `TASK_006` foi consolidado no commit `c23179d` e publicado no `main`. UI gateway, connection monitor, economia transacional, idempotência de barracas e proteções de VOIP fazem parte da base versionada. Trabalho futuro deve partir desse commit ou de um descendente, sem reabrir as decisões já registradas nos documentos de tarefa.

## Divisão de ownership

| Trilha | Implementador primário | Revisor | Arquivos reservados durante a tarefa |
|---|---|---|---|
| Auth/session e character binding | Codex | Claude | `whitelist.js`, auth/character core, testes correspondentes |
| Manifesto, assinatura e launcher | Claude | Codex | `apps/game-api/`, `apps/launcher/`, release workflow |
| MariaDB/schema e migrations de character | Codex | Claude | `skymp/packages/database/`, database adapters |
| Threat model, licença e documentação de contrato | Claude | Codex | `docs/technical/`, docs da task |
| VOIP benchmark/spike | Codex executa harness; Claude revisa LiveKit | revisão cruzada | `voip-service.js`, `voice-helper/`, relatório; sem migração nesta fase |
| Facções e propriedades | Só após gates P0/P1 | alternado por fatia | novos módulos; nunca editar o serviço antigo PARKED em paralelo |

## Fase 0 — hoje, antes da volta do Claude

Responsável: Codex.

### C0-01 — Congelar e validar o snapshot atual

- Revisar as mudanças de `TASK_001` a `TASK_006` sem reescrevê-las.
- Rodar todas as suítes, typecheck e schema list/check disponível.
- Separar falhas reais de dependências externas.
- Produzir um handoff com arquivos modificados, decisões e pendências de teste real.
- Gate: snapshot recuperável e nenhuma mudança do usuário perdida.

### C0-02 — AUTH-001: inventário de trust boundaries

- Mapear account, Discord ID, session token, launch ticket, `profileId`, actorId, characterId, role e slot.
- Documentar emissor, transporte, validador, consumidor, TTL e redaction.
- Marcar qualquer aceitação de identidade vinda do cliente como `SECURITY-BLOCKER`.
- Entrega: documento técnico e testes de caracterização, sem alterar protocolo ainda.

### C0-03 — AUTH-002: contrato de ticket opaco v1

- Especificar formato canônico, subject interno, audience, nonce, issued-at, expiry, key id e character slot.
- Definir consumo, replay, revogação, clock skew, rotação e comportamento de reconnect.
- Criar vetores de teste independentes da implementação.
- Gate para quinta: Claude consegue revisar o contrato sem precisar redescobrir o fluxo atual.

## Fase 1 — quinta-feira: trabalho paralelo sem conflito

### Trilha Codex A — sessão e personagem

1. Implementar `AUTH-003` atrás de feature/config gate fail-closed.
2. Adicionar repository MariaDB para resolução de sessão; nunca aceitar `profileId` do payload de gameplay.
3. Implementar `AUTH-004` com replay, expiração, revogação, audience e reconnect concorrente.
4. Iniciar `CHR-001` somente após os testes de sessão passarem.

Arquivos de ownership: gamemode auth/whitelist, character core, MariaDB schema/migration e testes. Codex não toca no launcher durante esta trilha.

### Trilha Claude B — manifesto e launcher

1. Revisar AUTH-001/002 como adversarial reviewer e registrar objeções antes de Codex concluir AUTH-003.
2. Implementar `MOD-001`: manifesto canônico v1 e test vectors.
3. Implementar `MOD-002`: gerador assinado com key id e segredo fora do repositório.
4. Preparar desenho de `MOD-003`, sem editar arquivos reservados por Codex.

Arquivos de ownership: `apps/game-api/`, documentação de distribuição e workflow de release. Claude não toca em `whitelist.js`, schema ou character core nesta trilha.

### Sincronização no fim de quinta

- Codex entrega ao Claude: diff, invariantes, testes e riscos residuais de AUTH-003/004.
- Claude entrega ao Codex: formato byte-a-byte do manifesto, test vectors, política de chaves e diff.
- Cada um revisa a trilha do outro sem fazer refactor incidental.
- O usuário decide se as duas entregas entram no mesmo release ou em releases separados.

## Fase 2 — integração controlada

### Codex

- `CHR-001`: formalizar `Account -> Session -> Character -> Identity`.
- `CHR-002`: bind autoritativo do slot e snapshot de reconnect.
- Revisar `MOD-001/002` de Claude, com foco em path traversal, canonicalização Windows e compatibilidade com o launcher atual.

### Claude

- `MOD-003`: verify-before-launch, mensagens de reparo e redaction.
- `MOD-004`: staging, atomic swap e rollback limitado ao managed root.
- Revisar `CHR-001/002`, com foco em migration, cardinalidade e character hopping.

### Gate de saída da Fase 2

- Sessão não aceita identidade arbitrária do cliente.
- Character slot é vinculado no servidor e sobrevive a reconnect conforme contrato.
- Manifesto alterado, truncado, fora de ordem ou assinado por chave errada impede launch.
- Rollback não apaga arquivos fora do diretório gerenciado.
- Todas as suítes passam e há teste E2E local documentado.

## Fase 3 — primeira vertical Heavy RP

Somente após o gate da Fase 2.

### Facções — Codex implementa, Claude revisa

| Ordem | Task | Resultado |
|---:|---|---|
| 1 | FAC-001 | membership e invariantes |
| 2 | FAC-002 | rank hierarchy e permission resolver deny-by-default |
| 3 | FAC-003 | repository MariaDB e audit log |
| 4 | FAC-004 | invite/promote/demote idempotentes |

Não criar UI de facção antes de FAC-003. Não restaurar o antigo `faction-service.js` removido.

### Propriedades — Claude implementa, Codex revisa

| Ordem | Task | Resultado |
|---:|---|---|
| 1 | PROP-001 | catálogo server-side de targets físicos |
| 2 | PROP-002 | ownership e AccessGrant revogável |
| 3 | PROP-003 | enforcement de porta/container |
| 4 | PROP-004 | E2E A/B/C, transfer, revoke, reconnect e confisco |

Claude cria módulos novos; não registra `housing-service.js` PARKED. Chaves físicas representam grants, não a autoridade final.

## Fase 4 — estudos sem bloquear o core

### VOI-001

- Codex mede o stack atual: 10/30/50/100 jogadores simulados, CPU, memória, banda, p95, packet loss e reconnect.
- Claude audita o vertical LiveKit/theZebco: tokens, rooms, agent, infraestrutura, custo e cell transitions.
- Entrega conjunta: ADR `KEEP_UDP`, `MIGRATE_LIVEKIT` ou `RESEARCH_MORE`.
- Nenhuma segunda stack permanente é introduzida.

### OPS-001

- Claude desenha doctor/config validation/redaction.
- Codex implementa supervisor/backoff/health checks nos scripts PowerShell oficiais de `scripts/phase0/`.
- Gate: port ocupado, DB down, config inválida, crash loop e graceful shutdown cobertos.

## Backlog explicitamente bloqueado

Economia regional, trade, profissões, crafting, survival, mounts e persistent objects não entram em implementação paralela durante as Fases 0–2. Eles dependem de identidade estável, transação, inventário e/ou decisão de produto. Market stalls e governance existentes podem receber correções, mas não expansão de escopo incidental.

## Template obrigatório de handoff

```text
Task:
Implementador:
Commit-base:
Arquivos alterados:
Invariantes preservados:
Decisões tomadas:
Testes executados e resultado:
Testes ainda manuais:
Riscos/security blockers:
Licenças/notices:
Próxima ação recomendada:
Arquivos liberados para o outro agente:
```

## Quadro de execução

| Task | Responsável | Revisor | Status inicial | Dependência |
|---|---|---|---|---|
| C0-01 snapshot/handoff | Codex | Claude | DONE_AWAITING_REVIEW | nenhuma |
| AUTH-001 | Codex | Claude | DONE_AWAITING_REVIEW | C0-01 |
| AUTH-002 | Codex | Claude | DRAFT_AWAITING_REVIEW | AUTH-001 |
| AUTH-003 | Codex | Claude | BLOCKED | AUTH-002 aprovado |
| AUTH-004 | Codex | Claude | BLOCKED | AUTH-003 |
| MOD-001 | Claude | Codex | READY_THURSDAY | C0-01 |
| MOD-002 | Claude | Codex | BLOCKED | MOD-001 |
| MOD-003 | Claude | Codex | BLOCKED | MOD-002 |
| MOD-004 | Claude | Codex | BLOCKED | MOD-003 |
| CHR-001 | Codex | Claude | DESIGN_READY_BLOCKED | AUTH-003/004 |
| CHR-002 | Codex | Claude | BLOCKED | CHR-001 |
| FAC-001..004 | Codex | Claude | BLOCKED | Fase 2 |
| PROP-001..004 | Claude | Codex | BLOCKED | Fase 2 + FAC-003 |
| VOI-001 | conjunto | conjunto | PLANNED | capacidade de laboratório |
| OPS-001 | conjunto | conjunto | PLANNED | MOD-001 |

Preparação adicional concluída em 2026-08-12: ADR de identidade online, auditoria de atomicidade do launch ticket, biblioteca isolada de credenciais opacas, config doctor e desenho de CHR-001. O estado detalhado e os gates de revisão estão em [`../historico/CODEX_PRE_CLAUDE_HANDOFF_2026-08-12.md`](../historico/CODEX_PRE_CLAUDE_HANDOFF_2026-08-12.md) (registro histórico).

## Definição de pronto do ciclo conjunto

O ciclo não está concluído apenas porque o código compila. É necessário:

- implementação no owner correto e revisão cruzada concluída;
- testes unitários, integração MariaDB e negativos;
- teste A/B/C e reconnect quando houver estado compartilhado;
- documentação do protocolo e migration/rollback;
- `npm test`, typecheck e `git diff --check` limpos;
- nenhum segredo ou token em logs;
- nenhum módulo PARKED ativado por acidente;
- handoff preenchido e arquivos liberados.
