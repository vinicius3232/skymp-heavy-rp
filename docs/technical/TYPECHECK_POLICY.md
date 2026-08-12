# Política de typecheck do gamemode

**Status:** ativo desde 12/08/2026  
**Escopo:** `skymp/gamemode`  

## Objetivo

O gamemode continua JavaScript puro, carregado diretamente pelo SkyMP. O typecheck não cria build nem transpila arquivos; ele verifica contratos JSDoc, uso da API `mp` e erros detectáveis pelo TypeScript antes da sessão in-game.

O projeto contém seis serviços deliberadamente `PARKED`. Eles continuam no disco para possível reengenharia, mas não são registrados em `phase0-basic.js`. Alguns carregam defeitos conhecidos que devem permanecer visíveis sem esconder regressões do código ativo.

## Comandos

### `npm run typecheck`

Gate da Fase 0 e do código ativo.

- Executa o `tsc` sobre o projeto completo.
- Falha se houver diagnóstico no código ativo.
- Falha se houver diagnóstico em dependência.
- Exibe os diagnósticos dos módulos `PARKED`, mas não bloqueia a sessão por eles.
- Falha se o `tsc` retornar erro que o classificador não reconhece.

O classificador está em `skymp/gamemode/scripts/typecheck-gate.js` e possui testes próprios. A lista de arquivos estacionados é comparada automaticamente com a seção `PARKED` de `phase0-basic.js`; adicionar ou remover um serviço sem atualizar a classificação quebra a suíte.

### `npm run typecheck:all`

Auditoria de dívida completa.

- Preserva o retorno bruto do `tsc`.
- Falha por qualquer diagnóstico, inclusive em módulo `PARKED`.
- Deve ser usado antes de propor a reativação de qualquer serviço estacionado.

Não é permitido transformar este comando em `exit 0`, `continue-on-error` ou filtrar mensagens sem classificação explícita.

## Baseline de 12/08/2026

Resultado do gate ativo:

- código ativo: 0 erros;
- dependências: 0 erros;
- dívida `PARKED`: 3 erros, todos em `economy-regional.js`.

Dívida registrada:

1. `governance.getMembership` é chamado, mas não é exportado pelo `governance-service`;
2. `factionInfo` não existe no primeiro uso dentro de `withdrawHoldTreasury`;
3. `factionInfo` não existe no segundo uso da mesma operação.

Esses três erros não serão “corrigidos para o typecheck passar”. A operação também move tesouro institucional em duas escritas sem transação, conforme `PARKED_SERVICES_DECISION.md`. Reativar exige primeiro decidir autoridade, ledger e atomicidade do patrimônio de Hold/facção.

## Alterações que fecharam o código ativo

- Os estados de `core/character-state.js` receberam o tipo `CharacterState`, sem mudança de runtime.
- As opções de `core/command-registry.js` foram alinhadas ao comportamento real: `opts` e `opts.module` são opcionais e usam fallback seguro.
- `@types/ws` foi adicionado como dependência de desenvolvimento; isso substitui a inferência incorreta sobre o JavaScript interno do pacote `ws` e tipa `WebSocketServer`/`WebSocket` usados pelo VOIP.

## Regra para módulos concluídos

Ao concluir um módulo ou pacote de trabalho:

1. executar o teste específico;
2. executar `npm test`;
3. executar `npm run typecheck`;
4. atualizar o documento técnico do módulo e o quadro do plano de execução;
5. executar `npm run typecheck:all` se o módulo estava `PARKED` ou toca código estacionado;
6. registrar o que ainda depende de sessão real.
