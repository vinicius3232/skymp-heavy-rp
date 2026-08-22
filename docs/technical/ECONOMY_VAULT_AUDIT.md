# Economy Vault Audit — os 3 gaps sobre a infraestrutura já existente (§15 da Constituição)

Código: [`core/economy-physical-sync.js`](../../skymp/gamemode/core/economy-physical-sync.js) (novo),
[`core/economy-service.js`](../../skymp/gamemode/core/economy-service.js) (`_auditLargeTransfer`),
[`core/economy-service.test.js`](../../skymp/gamemode/core/economy-service.test.js) (describe `concorrência`).

Como em [`ENVIRONMENT_AUDIT.md`](ENVIRONMENT_AUDIT.md), os 15 pontos vivem
neste documento, não no cabeçalho do código — precedente já estabelecido nesta
sessão e consistente com o resto do repositório.

**Escopo real desta tarefa**, confirmado com o dono do produto antes de
implementar: o brief pedia um `Economy-Service` do zero. A arqueologia de
código mostrou que `transferFunds` atômico com ledger já existe
(`core/economy-service.js`, formalizado em
[`ADR_004_ECONOMY_ACCOUNTS_AND_LEDGER.md`](ADR_004_ECONOMY_ACCOUNTS_AND_LEDGER.md)),
construído sobre `core/transaction-service.js` depois que um `economy-service.js`
mais antigo foi apagado por mexer em ouro sem transação
([`PARKED_SERVICES_DECISION.md`](PARKED_SERVICES_DECISION.md)). Reimplementar
do zero teria repetido esse erro. O que faltava eram três coisas pontuais —
este documento foca a §15 nelas, com ênfase pedida explicitamente pelo usuário
em **inflação** e **exploits de duplicação**.

## 1. Objetivo

Fechar os três gaps reais sobre a infraestrutura de dinheiro já madura:
(a) detectar ouro físico anômalo no inventário (evidência de cheat), (b)
marcar transferências grandes para auditoria de staff sem tabela nova, (c)
provar por teste que transferências concorrentes não perdem nem duplicam
saldo.

## 2. Problema que resolve

- Hoje nada observa se um jogador injetou `Gold001` físico via cheat
  engine/editor de save — o servidor confiaria cegamente em
  `characters.gold` sem checar se o cliente também "inventou" ouro visível
  (mesmo que isso não afete o saldo real, é sinal de manipulação externa que
  a staff quer saber).
- `gold_transactions` registra tudo, mas nada MARCA o que é grande o
  suficiente para revisão de staff — auditoria dependeria de alguém lembrar
  de somar o ledger manualmente.
- Não havia teste provando que N transferências concorrentes para o mesmo
  alvo, ou do mesmo remetente para alvos diferentes, preservam a integridade
  do saldo.

## 3. Problemas que cria

- Uma chamada Papyrus a mais por login (13-35ms,
  `docs/technical/PAPYRUS_USAGE_POLICY.md:142`) — mitigado por rodar só uma
  vez por login, não em heartbeat (ver §10).
- `_auditLargeTransfer` roda dentro da transação de TODA transferência que
  cruza o limiar — se `economy.largeTransactionThreshold` for configurado
  baixo demais, todo movimento médio vira uma linha de auditoria, poluindo
  `audit_logs` com ruído que a staff aprende a ignorar (mesmo risco que
  `core/ui-event-rate-limiter.js` já documenta para métrica sem uso real).

## 4. Exploits

- **O que este trabalho NÃO abre**: manter ouro virtual (não tornar
  `Gold001` físico) fecha de propósito o maior exploit que "sincronização
  física" literal abriria — ouro largável/vendável a NPC vanilla sem passar
  pelo ledger seria uma segunda via de duplicação, pior que a que existe
  hoje. Essa foi a decisão central desta tarefa.
- **Anti-cheat como sinal, não como correção de saldo**: `reconcileOnLogin`
  nunca mexe em `characters.gold` — só remove o item físico anômalo. Um
  exploit que tentasse usar isso para GANHAR ouro (ex: induzir o servidor a
  creditar `characters.gold` pelo valor do item físico "encontrado") não
  existe, porque a função nunca faz esse crédito.
- **Limiar de auditoria conhecido**: um jogador que souber o valor de
  `economy.largeTransactionThreshold` pode fatiar uma transferência grande
  em várias abaixo do limiar para evitar o flag. Isso é uma limitação
  conhecida e aceita — a mitigação real é a soma do ledger por período
  (`economy-service.reconcile`), que continua disponível para investigação
  manual; o flag automático é um sinal de triagem, não a única defesa.

## 5. Impacto econômico — inflação

- Nenhuma das três mudanças cria ou destrói septims. `_auditLargeTransfer` só
  observa; `reconcileOnLogin` só remove um item físico que nunca deveria
  existir (não afeta `characters.gold`); os testes de concorrência não movem
  dinheiro fora de `economy.transfer()`.
- A garantia contra inflação por duplicação já vem do `_applyDelta`/
  `_lockPair` existentes (`FOR UPDATE` em ordem canônica) — os novos testes
  de concorrência (§6 abaixo) são a prova de que essa garantia se sustenta
  sob carga, não uma mudança nela.

## 6. Impacto político / militar / religioso

Nenhum. Infraestrutura de auditoria e anti-cheat não altera governança,
facções ou clero.

## 7. Impacto social

Baixo, indireto: staff com um sinal automático de transferências grandes
reage mais rápido a RMT suspeito, o que preserva a percepção de economia
"limpa" entre jogadores — mas o efeito depende de alguém de fato revisar
`audit_logs`, que este trabalho não automatiza (não existe um dashboard).

## 8. Impacto narrativo

Nenhum direto — é infraestrutura de confiança, não mecânica de RP.

## 9. Impacto técnico

- `core/economy-service.js` passa a importar `core/server-options.js` (sem
  ciclo — `server-options.js` não importa `economy-service`).
- Novo módulo `lab` (`economy-physical-sync`), flag `false` por padrão, sem
  dependências.
- Sem migration nova, sem tabela nova — `audit_logs` e `gold_transactions`
  já cobrem a necessidade real (mesmo critério de minimalismo de `ADR_004`).

## 10. Como gera histórias / como é abusado / como balancear

- **Gera história**: um jogador pego com ouro físico anômalo no login vira
  gancho de RP de investigação de staff (contrabando, feitiçaria de
  duplicação) em vez de só um ban silencioso.
- **Como é abusado**: ver §4 (fatiamento abaixo do limiar). Mitigação:
  `economy.largeTransactionThreshold` não é a única defesa; `reconcile()`
  (já existente) permanece disponível para auditoria por período.
- **Como balancear**: `economy.largeTransactionThreshold` é um
  `server-option` (`core/server-options.js`), ajustável sem redeploy —
  default `5000`, mesmo padrão de `profession.maxPerCharacter` etc.
- **Anti-cheat só no login, nunca em loop**: decisão deliberada de custo
  (§3, §9) — rodar em heartbeat para todo jogador pagaria o mesmo preço que
  `docs/CONSTITUICAO.md` §A.5 já alerta para polling de Papyrus por ator.

## 11. Como integra ao mundo

`economy-physical-sync` é chamado do único ponto de produção onde um
personagem vira ativo (`whitelist.js`, logo após
`commands.registerActiveCharacter`), mesmo lugar de `grantStartingGold` —
não introduz um novo gancho de ciclo de vida, reaproveita o existente.
`_auditLargeTransfer` vive dentro do caminho que TODA transferência de
dinheiro já passa (`transferInTransaction`), então cobre barraca, contrato,
aluguel e qualquer consumidor futuro sem precisar que cada um lembre de
chamá-lo.

## Confirmado por teste, não confirmado em sessão real

Os 32 testes de `economy-service.test.js` (incluindo os 2 novos de
concorrência, que usam uma fila de travas por linha que simula o bloqueio
real de `SELECT ... FOR UPDATE` do InnoDB — não apenas incremento relativo
sem contenção) provam a lógica contra um banco mockado. `reconcileOnLogin`
nunca rodou contra um SkyMP real; `ObjectReference.GetItemCount`/`RemoveItem`
estão confirmados em `papyrus-catalog.js` (diferente do caso de
tempo/clima da Tarefa 6), mas ninguém validou o comportamento em jogo.
