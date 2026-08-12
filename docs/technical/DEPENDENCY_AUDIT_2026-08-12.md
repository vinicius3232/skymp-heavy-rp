# Auditoria de dependências — 12/08/2026

**Status atual:** correções compatíveis aplicadas; bot e launcher com 0 vulnerabilidades reportadas.

Esta fotografia foi produzida durante a restauração das dependências para o preflight da Fase 0. Os números vieram do `npm audit` executado pelo `npm ci` em cada aplicativo.

| Pacote | Resultado | Observação |
|---|---:|---|
| `skymp/gamemode` | 0 vulnerabilidades | 18 pacotes auditados após adicionar `@types/ws` |
| `apps/web` | 0 vulnerabilidades | `passport-discord@0.1.4` está depreciado e sem manutenção |
| `apps/game-api` | 0 vulnerabilidades | Nenhuma vulnerabilidade reportada |
| `apps/bot-discord` | 3 moderadas → **0** | `discord.js` atualizado para `^14.27.0`; override de `undici` elevado para `6.28.0` |
| `apps/launcher` | 10 altas, 1 moderada → **0** | Correções do lockfile e mínimos diretos de `concurrently`/`react-router-dom` atualizados |

No launcher, o relatório inicial apontou `concurrently` e `react-router-dom` entre as dependências diretas afetadas. Entre as transitivas apareceram `brace-expansion`, `fast-uri`, `js-yaml`, `nanoid`, `postcss`, `react-router`, `shell-quote`, `tar` e `undici`.

## Correção aplicada

- bot: `discord.js` `14.26.5` → `14.27.0`, `@discordjs/rest` `2.6.1` → `2.6.3` e `undici` `6.27.0` → `6.28.0`;
- launcher: correções compatíveis em 17 instalações do grafo, incluindo `concurrently` `10.0.3` → `10.0.4`, `react-router-dom`/`react-router` `7.18.1` → `7.18.2`, `undici` `7.28.0` → `7.29.0` e as versões corrigidas das transitivas registradas acima;
- nenhum upgrade principal e nenhum `npm audit fix --force` foi usado.

Verificação após a correção:

- bot: 40/40 testes e `npm audit --audit-level=moderate` verde;
- launcher: 24/24 testes, `tsc -b`, `oxlint`, build Vite dos bundles web/Electron e `npm audit --audit-level=moderate` verdes. O empacotamento do instalador ainda depende da configuração real.

## Decisão operacional

- As vulnerabilidades conhecidas deixaram de bloquear a distribuição. O launcher ainda depende de `.env` real, build do instalador e smoke test do artifact antes de ser entregue a testadores.
- Não executar `npm audit fix --force`: ele pode atravessar versões principais e quebrar o build ou o runtime.
- Tratar o aviso de `passport-discord` como dívida de manutenção, mesmo sem CVE reportada.
- Preservar os lockfiles e verificar cada atualização com testes, build e nova auditoria.

## Manutenção futura

1. repetir `npm audit` antes de cada build distribuível;
2. manter correções dentro da versão principal em pacotes pequenos e verificáveis;
3. tratar upgrades principais (`express` 5, TypeScript 7 e outros) como migrações separadas;
4. substituir `passport-discord` quando houver adapter mantido e testado para o fluxo atual.

Este documento registra o estado observado, não substitui uma análise de explorabilidade do código empacotado.
