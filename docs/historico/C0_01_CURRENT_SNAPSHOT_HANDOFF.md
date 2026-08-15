# C0-01 — Snapshot atual e handoff

Data: 2026-08-12. Branch: `fix/voip-proximidade-por-celula`. Commit-base: `112d51bc4f1e4308aebe3ab40881abe328db188e`.

> **Registro histórico, superado:** o snapshot descrito abaixo foi consolidado no commit `c23179d` e publicado no `main`. As menções a árvore dirty, ownership temporário e commit-base descrevem o momento do handoff e não o estado atual do repositório. A suíte do gamemode chegou depois a 547 testes aprovados.

## Escopo preservado

A árvore já estava modificada antes do início de AUTH-001. Este snapshot contém trabalho de UI gateway/rate limit, connection lifecycle, economia transacional, idempotência de market stalls, VOIP e documentação. Nenhum desses arquivos foi revertido ou reformatado durante esta etapa.

Principais grupos:

- `core/ui-event-*`, governance e player panel: contrato CEF e validação progressiva.
- `core/connection-monitor*`: polling de conexão protegido contra resposta assíncrona obsoleta.
- `core/institutional-treasury-service*`, `core/regional-market-transaction-service*`, migrations v11-v13: transação e idempotência.
- `voip-service*`: limite de protocolo, papéis sender/listener e separação por célula.
- `docs/roadmap/TASK_001` a `TASK_006`: estado e testes de cada entrega.

## Verificação do snapshot

| Verificação | Resultado |
|---|---|
| Gamemode `npm test` | 531/531 |
| Gamemode `npm run typecheck` | aprovado |
| Web | 40/40 |
| Game API | 30/30 |
| Bot Discord | 40/40 |
| Launcher | 24/24 |
| `git diff --check` nos documentos da auditoria | aprovado |

Não houve teste in-game nesta etapa. O handoff anterior informa que o schema local havia sido conferido, mas C0-01 não reaplicou migrations nem alterou o banco.

## Arquivos que Claude não deve editar sem novo handoff

- `skymp/gamemode/phase0-basic.js`
- `skymp/gamemode/core/character-state.js`
- `skymp/gamemode/core/connection-monitor.js`
- `skymp/gamemode/core/ui-event-*`
- `skymp/gamemode/voip-service.js`
- `skymp/gamemode/governance-service.js`
- `skymp/gamemode/market-stalls-service.js`
- `skymp/packages/database/schema.sql` e migrations v11-v13

Ownership liberado ao Claude na quinta-feira: `apps/game-api/`, `apps/launcher/`, documentação de distribuição e workflow de release, após ele confirmar o commit-base e seu próprio `git status`.

## Riscos conhecidos

- **No momento deste handoff**, a árvore estava dirty e ainda não tinha commit de consolidação; esse risco foi encerrado pelo commit `c23179d`.
- O launcher escreve um `profileId` derivado do Discord além da sessão opaca. Em produção, `offlineMode=false` faz o SkyMP usar o Master API, mas a redundância vira bypass se a configuração regredir.
- Os nomes ticket/session são ambíguos entre web, fila, launcher e SkyMP.
- O personagem aprovado mais recente é escolhido implicitamente; ainda não existe seleção de slot vinculada à sessão.

## Handoff

```text
Task: C0-01
Implementador: Codex
Commit-base: 112d51bc4f1e4308aebe3ab40881abe328db188e
Arquivos alterados: somente documentação nova desta fase
Invariantes preservados: módulos PARKED desligados; MariaDB oficial; trabalho local intacto
Testes: 531 + 40 + 30 + 40 + 24 aprovados; typecheck aprovado
Testes manuais: servidor/CEF/voz in-game ainda pendentes
Security blockers: profileId derivado no client settings; configuração offlineMode
Próxima ação: AUTH-001/002 e revisão adversarial de Claude
```
