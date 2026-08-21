# Handoff pré-Claude — 2026-08-12

> ⚠️ **Registro histórico, superado (14/08/2026).** O escopo abaixo foi entregue
> e absorvido pelo `main`. Preservado porque registra as invariantes acordadas na
> passagem de bastão — elas continuam valendo, o estado descrito não. Os números
> desta página (547/547) são do dia; hoje a suíte do gamemode está em 1270/1270.
> A biblioteca de credenciais opacas, descrita aqui como "ainda sem integração no
> runtime", já está integrada. Estado atual em
> [`QA_REPORT_2026-08.md`](../technical/QA_REPORT_2026-08.md).

## Escopo concluído pelo Codex

- ADR da identidade online: `profileId` representa o `accountId` interno; Discord ID é atributo externo.
- Auditoria do consumo do launch ticket: a operação atual é atômica por `UPDATE` condicional e não faz `SELECT` antes do consumo.
- Biblioteca isolada de credenciais opacas para launch grant, queue grant e game session, ainda sem integração no runtime.
- Config doctor com política fail-closed para staging/produção.
- Desenho de `Account -> Session -> Character -> Identity`, sem migration ou alteração de runtime.
- Testes de caracterização do trust boundary e da atomicidade do ticket.

## Arquivos alterados nesta preparação

- `docs/technical/ADR_001_ONLINE_PROFILE_ID_IS_ACCOUNT_ID.md`
- `docs/technical/AUTH_LAUNCH_TICKET_ATOMICITY_AUDIT.md`
- `docs/technical/CHR_001_ACCOUNT_SESSION_CHARACTER_IDENTITY.md`
- `skymp/gamemode/core/auth-boundary.test.js`
- `skymp/gamemode/core/opaque-credential.js`
- `skymp/gamemode/core/opaque-credential.test.js`
- `skymp/gamemode/scripts/check-server-config.js`
- `skymp/gamemode/scripts/check-server-config.test.js`
- `skymp/gamemode/package.json`

## Invariantes e decisões

1. Nenhum dado de identidade enviado pelo cliente pode autorizar gameplay.
2. O servidor deve resolver account, session, character e actor a partir de credencial opaca validada.
3. Cada credencial tem audience específica e 32 bytes aleatórios; logs e erros devem ser redigidos.
4. Em ambiente diferente de local, `offlineMode=true` é erro de configuração.
5. O personagem ativo deve ser ligado à sessão no servidor; “último personagem aprovado” não é seleção de sessão.
6. As áreas `apps/game-api/` e `apps/launcher/` não foram editadas nesta preparação e permanecem reservadas ao Claude.

## Security blocker para revisão na quinta-feira

O Master API entrega `user.id=accountId`, enquanto `whitelist.js` interpreta o mesmo `profileId` como Discord ID ao consultar `discord_identities.discord_id`. AUTH-003 deve corrigir a resolução para o identificador interno antes de qualquer ativação do protocolo novo.

## Estado das implementações

- A biblioteca de credenciais e o config doctor estão isolados e testados.
- Nenhuma troca de protocolo foi ativada.
- Nenhuma migration de character/session foi criada.
- Nenhum módulo PARKED foi registrado.
- O teste de concorrência contra MariaDB real ainda é necessário; o contrato SQL já está coberto por caracterização estática.

## Validação executada

- Testes focados: 16/16 aprovados.
- Suite completa do gamemode: 547/547 aprovados.
- Typecheck do gamemode: aprovado.
- Config doctor local: aprovado.
- Config doctor com exemplo de staging inseguro: recusado como esperado.
- `git diff --check`: sem erro; somente avisos de normalização CRLF em arquivos preexistentes.

## Revisão solicitada ao Claude

1. Revisar adversarialmente `AUTH_002_OPAQUE_TICKET_V1.md` e o ADR de identidade.
2. Confirmar audience, TTL, reconnect, rotação e revogação antes de AUTH-003.
3. Confirmar que MOD-001/MOD-002 não reutilizam launch grant como game session.
4. Não editar simultaneamente `whitelist.js`, schema ou character core durante a trilha do launcher.

## Próxima ação do Codex após aprovação

Implementar AUTH-003 sob feature gate fail-closed, com repository MariaDB resolvendo `accounts.id`, testes negativos e nenhuma confiança em `profileId` vindo do cliente.

