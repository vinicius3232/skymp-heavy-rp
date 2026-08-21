# Handoff para Claude — implementações e pesquisa SkyMP Heavy RP

**Atualizado em:** 2026-08-11  
**Escopo:** pesquisa de forks SkyMP, hardening do gamemode, economia, CEF/UI,
conexão e voz.  
**Regra de leitura:** este documento descreve o que foi realmente implementado
e validado. Não trate código existente no disco como funcional em produção sem
confirmar se o módulo está registrado no `core/module-registry.js`.

> ⚠️ **Registro histórico, superado (14/08/2026).** Descreve o estado de
> 11/08/2026 e é preservado porque explica *por que* as fronteiras de confiança,
> a economia transacional e a idempotência das barracas foram feitas na ordem em
> que foram. **Não use como estado atual.** O que mudou desde então, e que este
> texto contradiz: a voz deixou de ser "relay PCM/WebSocket próprio" e virou o
> Voice Core com política de personagem e gateway LiveKit (cinco etapas — ver
> [`SKYVOICE_PRODUCTION_READINESS.md`](../technical/SKYVOICE_PRODUCTION_READINESS.md));
> o `trade-service` deixou de ser PARKED e está registrado; e o `profileId`
> online passou a resolver `accounts.id` no servidor. Para o estado real de cada
> componente, leia [`QA_REPORT_2026-08.md`](../technical/QA_REPORT_2026-08.md).

## Resumo executivo

O trabalho priorizou segurança e consistência antes de ativar novos sistemas:

1. A fronteira CEF -> gamemode ganhou validação de envelope, logs sem payload
   bruto, gateway testável e medição de taxa.
2. As operações econômicas que movem mais de um recurso passaram a ter limites
   transacionais e idempotência persistida.
3. O mercado regional foi corrigido no código, mas permanece **PARKED**. Não
   deve ser ativado até a homologação de concorrência e ciclo de vida.
4. As barracas de jogadores são ativas e agora tratam retries de UI como replay,
   não como nova compra.
5. O VOIP atual continua sendo relay PCM/WebSocket próprio; recebeu limites de
   payload e taxa. A pesquisa do fork `skymp-vgr` é referência arquitetural,
   não uma integração pronta.

## Onde encontrar o plano e a pesquisa completa

| Assunto | Documento |
| --- | --- |
| Contrato CEF/UI | `docs/roadmap/TASK_001_UI_EVENT_CONTRACT.md` |
| Typecheck e realidade dos módulos | `docs/roadmap/TASK_002_CORE_TYPECHECK.md` |
| Ciclo de conexão | `docs/roadmap/TASK_003_CONNECTION_LIFECYCLE.md` |
| Economia regional/institucional | `docs/roadmap/TASK_004_ECONOMY_TRANSACTION_BOUNDARY.md` |
| Capacidade e segurança do VOIP | `docs/roadmap/TASK_005_VOIP_CAPACITY_AND_SECURITY.md` |
| Idempotência de barracas | `docs/roadmap/TASK_006_MARKET_STALL_IDEMPOTENCY.md` |
| Estudo dos forks SkyMP | `docs/technical/REFERENCE_STUDY_SKYMP_FORKS_2026-08-11.md` |
| Auditoria específica de voz no fork | `docs/technical/VOICE_FORK_AUDIT_SKYMP_VGR_2026-08-11.md` |
| Decisão sobre módulos estacionados | `docs/technical/PARKED_SERVICES_DECISION.md` |

Não editar `docs/technical/REVISAO_REALIDADE_COMPARTILHADA.md` como parte de
uma correção incidental: há edição paralela de outro agente nesse arquivo.

## Estado de ativação dos módulos

### Ativos e relevantes aqui

- `governance-service.js`
- `market-stalls-service.js`
- `player-panel-service.js`
- `voip-service.js`
- `soul-service.js`

### PARKED: não registrar sem revisão explícita

`economy-regional.js`, `crafting-service.js`, `jobs-service.js`,
`housing-service.js`, `horse-service.js` e `trade-service.js` existem no
repositório, mas não são descritores ativos do boot. Em particular,
`economy-regional.js` agora tem uma implementação transacional melhor, mas não
tem autorização implícita para ser ativado.

O registro e o ciclo de vida são decididos por `core/module-registry.js` e
`phase0-basic.js`, não por uma variável de ambiente lida diretamente por um
módulo. Manter essa separação impede inicialização parcial, timers sem shutdown
e comandos sem dependências.

## Implementações realizadas

### 1. CEF/UI: fronteira comum e validação de intenção

Arquivos principais:

- `skymp/gamemode/core/ui-event-router.js`
- `skymp/gamemode/core/ui-event-gateway.js`
- `skymp/gamemode/core/ui-event-rate-limiter.js`
- `skymp/gamemode/governance-service.js`
- `skymp/gamemode/player-panel-service.js`

O callback global de UI valida que o evento é objeto simples e que `type` é uma
string não vazia de até 128 caracteres antes de rotear. Ele não registra o
payload bruto; só registra o tipo e a categoria de `data`.

Cada domínio continua sendo responsável pelo próprio schema. Exemplos já
fechados:

- `panel:social:rename` exige `targetCharacterId` inteiro seguro e apelido
  textual limitado e sanitizado;
- `governance:interaction:execute` só aceita namespace `guard.*`, `stall.*` ou
  `npc.*`, actor/FormID completo e objeto plano;
- multas, prisão e confisco rejeitam coerção parcial;
- `stall.buy` exige `itemId` e quantidade válidos; se receber `requestId`, ele
  deve ser string de 8 a 48 caracteres.

O rate limiter observa por `actorId + type`. Por padrão só mede. Para ativar
rejeição depois de medir uma sessão CEF real, definir ambos:

```text
UI_EVENT_RATE_LIMIT_MAX_EVENTS=<limite>
UI_EVENT_RATE_LIMIT_WINDOW_MS=<janela_em_ms>
```

### 2. Conexão e whitelist

`skymp/gamemode/core/connection-monitor.js` protege o caminho de conexão contra
respostas assíncronas obsoletas: se o ator desconecta/reconecta enquanto a
whitelist ainda consulta, a resposta antiga não pode limpar ou expulsar a nova
sessão. Há retry quando actor/profile ainda não foram publicados pela engine.

### 3. Economia: tesouro institucional

Arquivos:

- `skymp/gamemode/core/institutional-treasury-service.js`
- `skymp/packages/database/migration-v11-institutional-treasury.sql`

O saque Hold -> facção acontece em uma transação: bloqueia o Hold, consulta a
autoridade de governança na mesma conexão, verifica tesouro, debita Hold,
credita facção e grava ledger antes do commit. `idempotency_key` única devolve
replay sem retirar ouro novamente.

### 4. Economia: mercado regional NPC (PARKED)

Arquivos:

- `skymp/gamemode/core/regional-market-transaction-service.js`
- `skymp/gamemode/economy-regional.js`
- `skymp/packages/database/migration-v12-regional-market-ledger.sql`

Compra e venda foram separadas em um serviço de transação explícito:

- **Compra:** trava `market_prices`, verifica/reproduz request anterior,
  debita ouro, entrega inventário, reduz estoque, grava ledger de ouro,
  ledger de inventário e histórico regional; só então commita e atualiza o
  cliente Papyrus.
- **Venda:** trava Hold e preço, remove item, credita ouro líquido, credita
  imposto ao tesouro, atualiza estoque e grava os mesmos rastros no mesmo
  commit.
- `regional_market_transactions.idempotency_key` é única. A chave usada pela UI
  aceita até 48 caracteres porque os ledgers derivados usam sufixos e as tabelas
  regionais usam `VARCHAR(64)`.
- O cache regional é refrescado após commit em modo tolerante a falha: cache
  atrasado não transforma uma compra já confirmada em erro para o jogador.

**Importante:** o banco é a autoridade para preço/estoque nessas operações; o
cache só serve leitura e apresentação. Não restabelecer as antigas sequências
de `removeGold()`/`giveItem()`/`UPDATE` separadas.

### 5. Mercado de jogadores: idempotência de barraca ativa

Arquivos:

- `skymp/gamemode/market-stalls-service.js`
- `skymp/packages/database/migration-v13-market-stall-idempotency.sql`

Antes desta alteração, `buyItem()` criava um UUID em cada chamada. Portanto, um
retry de UI era uma compra nova, apesar de a compra isolada já ser atômica.

Agora `stall.buy` pode encaminhar `requestId`; a compra grava a chave em
`market_stall_sales.idempotency_key`, que é única. Dentro da transação ela faz
`SELECT ... FOR UPDATE` pela chave antes de mover qualquer recurso. Um replay:

- não altera ouro;
- não entrega item de novo ao cliente;
- não reduz estoque;
- não grava novo ledger/auditoria;
- responde que a compra anterior já foi confirmada.

O rate limit de dois segundos continua bloqueando novas chaves, mas permite
repetir a mesma chave durante a janela para que um retry legítimo obtenha o
resultado persistido.

### 6. VOIP atual e resultado da pesquisa de forks

O VOIP local não é LiveKit/WebRTC de ponta a ponta: ele usa helper nativo,
frames PCM em base64 e relay WebSocket com proximidade calculada no servidor.

Hardening aplicado em `skymp/gamemode/voip-service.js`:

- token bucket por conexão para `audio_frame` (60 frames/s, burst 12);
- payload WebSocket limitado a 32 KiB;
- frames só são aceitos do socket autenticado e ativo para aquele papel;
- emissor mutado, sem audiência ou fora de célula não é retransmitido.

O fork mais útil encontrado foi `Metadraconis/skymp-vgr`. Ele traz referência de
arquitetura para tokens de voz, cliente TypeScript, plugin C++, LiveKit, agente
Go e Terraform. Não copiar cegamente: a auditoria encontrou que o
`proximityLoop` não era iniciado, havia endpoint de posição público com CORS
aberto e não foi encontrado o produtor de posição do game server. Portanto,
LiveKit/fork é uma fase de arquitetura, infraestrutura e segurança própria;
não é correção de uma linha para o relay atual.

## Banco de dados local

As migrations abaixo já foram aplicadas ao banco local configurado em
`skymp/config/database.local.json`:

| Migration | Objeto |
| --- | --- |
| v11 | `institutional_treasury_transactions` |
| v12 | `regional_market_transactions` |
| v13 | `market_stall_sales.idempotency_key` e índice único |

Em outro ambiente, aplicar as migrations versionadas antes de iniciar qualquer
versão que contenha estes serviços. Não copiar manualmente DDL parcial.

## Verificação já executada

No diretório `skymp/gamemode`:

```powershell
npm test
npm run typecheck
npm run check:schema
git diff --check
```

Resultado na última execução deste handoff:

- `npm test`: **531 testes aprovados**;
- `npm run typecheck`: aprovado sem erros;
- `npm run check:schema`: banco local e migrations alinhados;
- `git diff --check`: sem erros de whitespace (os avisos CRLF de arquivos já
  modificados no worktree não são falhas de conteúdo).

Não foi iniciado o servidor SkyMP nesta rodada. Para teste de servidor, seguir
o procedimento interno de execução e não inferir que a suíte Node substitui um
teste in-game.

## Próximos passos recomendados, em ordem

1. Homologar no MySQL/InnoDB com dois clientes reais:
   - dois cliques com o mesmo `requestId` em barraca;
   - duas compras da última unidade, com IDs distintos;
   - duas compras/vendas regionais concorrentes quando o módulo tiver ambiente
     de homologação;
   - dois saques concorrentes do mesmo tesouro de Hold.
2. Manter `economy-regional` PARKED até revisar descriptor, dependências,
   comandos, shutdown e resultado dessa homologação.
3. Coletar métricas CEF antes de ativar o rate limit global; não escolher teto
   arbitrário.
4. Para voz, escolher explicitamente entre endurecer o relay PCM atual ou abrir
   projeto separado de LiveKit com autenticação, publicação de posição interna,
   observabilidade, TURN/TLS e testes de escala.
5. Antes de editar código, executar `git status --short`: há alterações e
   documentos de trabalho paralelos no repositório que não devem ser revertidos
   nem sobrescritos sem revisar a autoria.

## Anti-padrões a não reintroduzir

- Não ativar módulo PARKED somente por uma variável de ambiente solta.
- Não mover ouro + item + estoque em transações independentes.
- Não usar `parseInt` permissivo em payload controlado por CEF.
- Não registrar payload CEF bruto em logs.
- Não chamar efeitos Papyrus antes de `COMMIT`.
- Não transformar retry de UI em operação econômica nova.
- Não expor ticket de voz, posição de jogador ou endpoint interno sem
  autenticação e limite de taxa.
