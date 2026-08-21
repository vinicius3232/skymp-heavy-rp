# Relatório de QA e Plano de Melhorias — Agosto/2026

***Português** · [English](QA_REPORT_2026-08.en.md) · [Русский](QA_REPORT_2026-08.ru.md) · [Español](QA_REPORT_2026-08.es.md)*

Varredura completa do monorepo: gamemode, painel web, bot do Discord, launcher, schema, scripts e documentação. Escrito depois de rodar os testes existentes, seguir cada caminho de configuração até a origem e conferir se o que a documentação afirma bate com o que o código faz.

**Método e limite:** tudo aqui foi verificado por leitura de código, execução de testes automatizados e checagem estática. **Nada foi validado numa sessão de jogo real** — nenhuma afirmação sobre comportamento in-game deve ser tomada como testada.

*Atualizado depois da primeira rodada de correções: os itens marcados "corrigido"/"resolvido" já estão no código; os marcados **ABERTO** continuam pendentes.*

---

## 1. Estado por componente

| Componente | Testes | Instalável | Estado real |
|---|---|---|---|
| `skymp/gamemode` | 1270/1270 ✅ + 13/13 checks de sistema | ✅ | **Maduro, e agora com um boot real atrás.** Transações atômicas, máquina de estado, registry de módulos, cobertura de teste real. A segunda rodada (2.16–2.25) achou dez defeitos que a suíte não pegava — nove deles de configuração ou de ciclo de vida. O salto de 444 para 1270 é sobretudo voz (SkyVoice, etapas 1–5) e os três frameworks de 13/08. |
| `apps/bot-discord` | 40/40 ✅ | ✅ | **Funcional.** Sync de cargo, canais de voz temporários e, desde 07/08/2026, o log de moderação que a `ARCHITECTURE.md` 1.3 registrava como intenção nunca implementada. |
| `apps/web` | 40/40 ✅ | ✅ | **Funcional.** Ganhou smoke tests nesta rodada. |
| `apps/launcher` | 74/74 ✅ | ✅ | **Estava quebrado ponta a ponta** (ver 2.1) e sem teste nenhum. A lógica de paridade de modpack foi extraída pra `electron/parity.mjs` e testada — achou o buraco do plugin extra (2.15). A distribuição de voz (`electron/voice-dist.mjs`) veio depois, com manifesto, integridade e rollback. O resto do `main.ts` depende de Electron e **nunca foi executado**. |
| `apps/game-api` | 48/48 ✅ | ✅ | **Novo.** Serve a porta 7758 que o launcher sempre chamou e que não existia. O gerador de manifesto ganhou teste e a flag `--only-load-order` (2.26). |
| Tipagem `mp` | `npm run typecheck` | — | `skymp/gamemode/types/mp.d.ts` tipa a API do SkyMP (não há typings públicos upstream). Informativo, não trava build nem teste. Achou 2.13 e 2.14 na primeira execução. |
| Schema / migrations | `npm run check:schema` | — | Consistente **depois da v9**. O checador achou `characters.gold` declarada no `schema.sql` e em migration nenhuma (2.21) — banco novo funcionava, banco migrado não. |

### O que efetivamente roda hoje

**Doze** módulos registrados no `core/module-registry.js`, todos atrás de flag `ENABLE_*` e **todos desligados por padrão**: `interaction`, `npc-cleaner` (core), `death`, `governance`, `market-stalls`, `player-panel`, `soul`, `voip`, `nametag`, `trade`, `fauna-census`, `corpse-probe` (lab). Os dois últimos não são mecânica: são instrumentos de observação da Fase 0 para a questão de mobs hostis — ver [`FAUNA_CENSUS_PROTOCOL.md`](FAUNA_CENSUS_PROTOCOL.md).

> ⚠️ **Até 06/08/2026 as flags não ligavam nada** — o gamemode nunca carregou o próprio `.env` (2.16). O primeiro boot real do servidor aconteceu em 06/08/2026, com quatro módulos ativos e 33 comandos registrados.

**Cinco** serviços existem no disco e **nunca são registrados** — `economy-regional`, `jobs`, `crafting`, `housing`, `horse` (PARKED). O `trade-service` saiu dessa lista: está registrado desde 13/08/2026, sobre o [Inventory Framework](../framework/INVENTORY_FRAMEWORK.md). Outros quatro foram apagados em 06/08/2026 (`economy-service`, `justice`, `faction`, `survival`) e o `disguise-service` numa segunda rodada, por duplicarem sistema ativo ou serem inseguros — ver `PARKED_SERVICES_DECISION.md`. Os que ficaram e mexiam em ouro foram migrados pro `core/transaction-service`.

---

## 2. Achados

### 2.1 🔴 Launcher não carregava configuração nenhuma — *corrigido*

`electron/main.ts` lia `process.env.VITE_DISCORD_CLIENT_ID`, `VITE_SERVER_IP`, `VITE_API_PORT`, `VITE_GITHUB_DIST_REPO`. **Nada colocava esses valores em `process.env`**: não havia `dotenv`, nem `loadEnv`, nem `define` no `vite.config.ts`. O Vite carrega `.env` para `import.meta.env` (renderer), não para o processo Node do main — e o app empacotado não tem `.env` do lado.

Consequência: todos caíam no fallback vazio/`127.0.0.1`. Login do Discord impossível (`client_id=''`), servidor sempre localhost, updater desligado. O `.env.example` documentava sete variáveis que nunca tiveram efeito.

**Corrigido:** `vite.config.ts` agora usa `loadEnv` + `define` pra substituir esses acessos em tempo de build, que é o único mecanismo que sobrevive ao empacotamento.

### 2.2 🔴 Client secret do Discord embutido no instalador — *corrigido*

`VITE_DISCORD_CLIENT_SECRET` era usado direto na troca de `code` por token dentro do launcher. Corrigir só o 2.1 teria **piorado** isso: o secret passaria a ser inlined no bundle e distribuído a todo jogador que baixasse o instalador.

**Corrigido:** a troca virou `POST /api/launcher/oauth/exchange` no painel web, que já guarda o secret. O launcher manda `{code, redirect_uri}` e recebe só o perfil público — nem o access token. O painel valida o `redirect_uri` contra allowlist, com rate limit.

### 2.3 🔴 Aprovar whitelist ressuscitava personagem morto permanentemente — *corrigido*

`PATCH /api/whitelist/:id` fazia `UPDATE characters SET status='approved'` juntando por conta, **sem filtrar por status**. Um jogador que levasse `/permakill` (`status='retired'`), criasse ficha nova e fosse aprovado tinha o personagem aposentado revertido para `approved` — desfazendo a consequência e apagando o efeito do audit log.

**Corrigido:** `AND c.status='pending'` no `UPDATE` (e no de `extra_review_notes`).

### 2.4 🟠 `.env` fora do `.gitignore` em dois apps — *corrigido*

`apps/web` e `skymp/gamemode` tinham `.gitignore` próprio cobrindo `.env`. **`apps/bot-discord` não tinha `.gitignore` nenhum** (é onde vive `DISCORD_BOT_TOKEN` e `INTERNAL_API_SECRET`) e `apps/launcher` ignorava `*.local` mas não `.env`. Nenhum `.env` real chegou a ser commitado, mas um `git add .` bastaria.

**Corrigido:** regra `.env` / `!.env.example` no `.gitignore` da raiz, cobrindo os quatro.

### 2.5 🟠 `electron/` nunca foi typechecked — *corrigido*

`tsconfig.node.json` incluía só `vite.config.ts`; `tsconfig.app.json`, só `src`. O `npm run build` roda `tsc`, mas `tsc` não olhava para o processo main — e o `vite-plugin-electron` usa esbuild, que transpila sem checar tipo. Erro de tipo em `main.ts` (1.200+ linhas, a parte mais complexa do launcher) ia direto pro instalador.

**Corrigido:** `electron` adicionado ao include. A checagem pegou um import morto na primeira execução.

### 2.6 🟠 Três tabelas de raio de proximidade divergentes — *corrigido*

`rp-chat-service.js` (450/1200/1500/2000/3500), `voip-service.js` (200/1200/3000) e `server-options.*.example.json` (350/1400/3000) discordavam. Efeito de RP: quem estava dentro do alcance do sussurro **escrito** ficava fora do sussurro **falado** — o mesmo gesto de chegar perto funcionava ou não dependendo do canal.

**Corrigido:** `core/proximity-ranges.js` como fonte única; chat, voz e o raio de evidência de morte derivam dela.

### 2.7 🟠 Endpoint de manifesto morto com hash falso — *corrigido*

`GET /api/launcher/manifest` no painel devolvia `hash: "dummy_hash_for_testing"` e uma URL fake. **Nenhum código o consumia** — o launcher usa GitHub Releases. Pior: `MANIFEST_VS_NEXUS_COLLECTIONS.md` argumentava a fundo sobre esse endpoint como se fosse o mecanismo real, e creditava SHA-256 a um caminho de código que usa MD5.

**Corrigido:** endpoint removido; a documentação foi reescrita como `LAUNCHER_DISTRIBUTION.md`, descrevendo os canais que existem de verdade.

### 2.8 🟠 `/api/apply` sem validação de entrada — *corrigido*

Aceitava nome vazio, biografia de um caractere ou texto maior que a coluna (virando 500 sem explicação). Os campos que a rubrica de whitelist trata como eliminatórios (motivações, fraquezas, laços sociais) eram `required` só no HTML — trivial de contornar.

**Corrigido:** validação server-side com mínimos e máximos por campo.

### 2.9 🔴 não existia servidor na porta 7758 — *resolvido, com uma ponta solta*

O launcher chama `http://<SERVER_IP>:7758/mods.json` (paridade de modpack) e `/api/queue/status` + `/api/queue/join` (fila). **Nenhum serviço deste repositório escuta nessa porta.**

Isso significa que a verificação de paridade de mods — a coisa que sustenta todo o contrato de FormID e a regra de autoridade do servidor — **nunca rodou**.

**Resolvido:** `apps/game-api` serve os três endpoints, com gerador de manifesto (`scripts/generate-mods-manifest.js`) e 24 testes. Detalhes em `LAUNCHER_DISTRIBUTION.md`. Junto veio 1.1b: a fila passou a exigir ticket emitido pelo painel em vez do `discordId` que o cliente informa.

**Ponta solta — resolvida pelo caminho nativo:** a pesquisa no `skymp5-server/ts/systems/login.ts` mostrou que o SkyMP já resolve isso sozinho. Com `offlineMode: false`, ele não lê o `profileId` do cliente: resolve `gameData.session` contra um master API e usa o `id` que vier de lá.

O `apps/web` passou a servir esse contrato (`GET /api/servers/:masterKey/sessions/:session`), o `apps/game-api` grava a sessão em `game_sessions` (migration v8) ao admitir na fila, e o launcher já escreve o token como `session`. Resultado: `whitelist.js` não precisou mudar — o `profileId` que chega **já é** o `accountId` validado.

Isso tornou o `/internal/session/resolve` que construímos redundante. Ficou no `game-api` só até o teste in-game confirmar o fluxo nativo.

### 2.10 🟡 `server-options.json` não era lido por ninguém — *resolvido em parte*

`Initialize-LocalConfig.ps1` gera o arquivo, `SERVER_OPTIONS_SCHEMA.md` documenta 112 linhas de opções, e **nenhum código lê**. Configuração que parece existir e não faz nada é pior que configuração ausente: alguém vai ajustar `permadeathEnabled` ou `startingGold` e concluir que o servidor está bugado.

**Resolvido:** `core/server-options.js` carrega, valida e aplica. Oito opções estão ligadas de verdade (raios de chat/voz, `oocEnabled`, rate limit, `permadeathEnabled`, `playerRespawnSeconds`, `startingGold`) — as demais continuam inertes, mas agora o loader **avisa no boot** quando encontra uma delas no arquivo, e **aborta o boot** se um valor for de tipo errado ou fora do intervalo.

O princípio adotado: só entra na `SPEC` opção que realmente muda comportamento. Declarar as 24 e ligar 8 recriaria o mesmo problema, só que mais difícil de perceber — porque aí o arquivo *é* lido, e a pessoa tem menos motivo pra desconfiar. Há um teste que impede o exemplo de ganhar chave nova sem alguém classificá-la. 18 testes em `core/server-options.test.js`.

### 2.11 🟡 `apps/web` sem dependências instaladas e sem testes — *resolvido*

`node_modules` ausente. `Start-AllServices.ps1` só checava a existência do `.env`, então o painel morria no `require('dotenv')` numa janela separada e a orquestração reportava sucesso. Era também o único serviço com lógica de negócio (autorização de staff, aprovação de whitelist, troca de OAuth) **sem nenhum teste**.

**Resolvido:** dependências instaladas; 29 smoke tests em `server.test.js` (guard de autenticação em 12 rotas, validação da ficha, allowlist de `redirect_uri`, hash do ticket); `Start-AllServices.ps1` agora pré-checa entrada, `.env` e `node_modules` de cada serviço e reporta o que não subiu em vez de mentir "concluída".

### 2.12 🟡 bot do Discord não registrava comandos automaticamente — *resolvido*

`/voz-criar` e `/voz-fechar` só existiam depois de rodar `npm run deploy-commands` à mão. Nada avisava se isso fosse esquecido; o comando simplesmente não aparecia no Discord.

**Resolvido:** `deploy-commands.js` virou módulo e roda no `ready` do bot. Falha ali **não derruba o bot** — o sync de whitelist é a função crítica e funciona sem os comandos de voz —, mas grita no log dizendo exatamente o que não vai aparecer. Continua funcionando standalone (`npm run deploy-commands`), onde aí sim sai com código de erro. 6 testes novos.

### 2.13 🔴 duas formas incompatíveis de chamar Papyrus — *resolvido por evidência upstream*

Achado ao tipar a API `mp` (`skymp/gamemode/types/mp.d.ts`). O parâmetro `self` de `mp.callPapyrusFunction('method', ...)` é passado de duas maneiras diferentes no mesmo código:

| Forma | Onde |
|---|---|
| `{ type: 'form', desc: mp.getDescFromId(actorId) }` | `death-service.js`, `player-panel-service.js` — **2 arquivos** |
| `actorId` cru (um `number`) | **22 pontos**, incluindo `core/transaction-service.js`, `inventory-service.js`, `npc-cleaner.js`, `governance-service.js`, `market-stalls-service.js` |

As duas nasceram no **mesmo commit** (`82625d2`, 11/07/2026): não houve migração de uma para outra, é inconsistência desde a origem. A documentação do SkyMP não especifica o formato, e nenhuma das duas foi exercitada em jogo.

**Por que isso é grave:** se só a forma de objeto for válida, 22 chamadas falham em silêncio — e entre elas está a entrega de item do `core/transaction-service.js`. O banco registraria a transação corretamente e o inventário do jogador ficaria vazio. O mesmo vale para remoção de NPC (`npc-cleaner`), sincronização de inventário no spawn (`inventory-service`) e as algemas da governança (`SetActorValue SpeedMult`).

**Resolvido:** a pesquisa no upstream achou `misc/tests/` — nove testes de integração que rodam contra um servidor real. **Todos usam a forma de objeto, exclusivamente**, inclusive para argumentos que sejam referências. Isso deixou de ser palpite.

As 22 chamadas foram convertidas, com um helper (`core/papyrus.js`: `actorRef`/`baseRef`) pra não repetir a construção. Os testes existentes não exercitavam esses caminhos (os mocks não definem `mp`, então os guards `typeof mp === 'undefined'` protegiam) — por isso `core/papyrus.test.js` passou a olhar o **argumento** passado, não só o resultado. 5 testes novos.

Ainda vale conferir in-game, mas agora como confirmação, não como investigação.

### 2.14 🟡 módulos PARKED chamam `hasPermission` com número — *resolvido na raiz*

`admin-service.hasPermission(actorId, permission)` faz `staff.permissions.has(permission)`, onde `permissions` é um `Set` de **strings**. Doze chamadas passam um número (nível de staff: `10`, `20`):

`crafting-service` (2), `disguise-service` (1), `economy-regional` (1), `faction-service` (4), `justice-service` (4)

`Set.has(20)` num Set de strings é sempre `false`, então **toda** verificação de permissão nesses módulos nega sempre. Não há impacto hoje — os cinco estão PARKED — mas significa que eles estão mais quebrados do que "apenas não registrados": ligar a flag não os faria funcionar, apenas travaria toda ação de staff dentro deles.

**Resolvido:** em vez de remendar 12 chamadas em código que não roda, `hasPermission` passou a validar o próprio argumento. Nível numérico e nome de permissão inexistente agora **negam e registram erro no log** com a lista do que é válido.

Escolha deliberada de não lançar exceção: isso derrubaria o comando do jogador por um erro de programação. Negar é o resultado seguro; o log é o que faz alguém corrigir. Pega também o caso oposto — quem escreve `hasPermission(id, 'manage_factions')` acha que criou uma regra e criou uma porta que nunca abre. 4 testes novos.

**Fechado na raiz e nas folhas em 07/08/2026.** As doze chamadas acabaram: `disguise-service`, `faction-service` e `justice-service` foram apagados, e as três que sobravam (`/addrecipe`, `/addingredient`, `/settax`) passaram a permissão nomeada — `manage_recipes` (nova) e `set_gold`. O raciocínio de qual permissão cada comando exige está na [§7.4 do `PARKED_SERVICES_DECISION.md`](PARKED_SERVICES_DECISION.md); uma varredura estática em `parked-staff-permissions.test.js` reprova se qualquer arquivo de produção do gamemode voltar a passar número.

### 2.15 🔴 Cliente com plugin extra passava na verificação de paridade — *corrigido*

Achado ao extrair a lógica do launcher para teste. As duas verificações de paridade percorriam **a lista do servidor** perguntando "o jogador tem isto?". Nenhuma percorria a do jogador perguntando "o servidor conhece isto?".

Consequência: um cliente com **todos** os mods certos, com o hash certo, **mais um `.esp` a mais**, passava nas duas. E um plugin a mais na load order ocupa um índice e desloca todos os seguintes — o `HeavyRP.esm` que é `02` no servidor vira `03` nele, e **todo `base_id` gravado no banco passa a apontar para outro registro na tela daquele jogador**.

É exatamente a falha que o contrato de FormID existe para impedir (`MODS_AND_GAMEMODE_CONTRACT.md` §3), e ela não produz erro nenhum: produz um baú com outra coisa dentro.

Junto veio um segundo caso: quando o servidor não informava load order, o código caía para a ordem **local** — comparando o jogador consigo mesmo e respondendo `ok` sempre. A pior resposta possível, porque parece aprovação.

**Corrigido:** lógica extraída para `apps/launcher/electron/parity.mjs` (sem `fs`, sem `http`, sem `electron`), com 24 testes. A verificação passou a rodar nas duas direções, usa o `plugins.txt` para saber o que está de fato ativo (plugin presente e desativado não desloca nada), e load order ausente agora **reprova**.

---

## 2-bis. Segunda rodada (06-07/08/2026)

A primeira rodada leu codigo. Esta **instalou o servidor e o ligou**, e a diferenca aparece em quais defeitos cada uma acha: nove dos dez abaixo sao de configuracao ou de ciclo de vida — a classe que nenhum teste unitario toca, porque nao ha o que testar num arquivo que ninguem le.

### 2.16 🔴 O gamemode nunca carregou o proprio `.env` — *corrigido*

`dotenv` estava em `dependencies`, o `.env.example` existia, e tanto o `CONTRIBUTING.md` §1 quanto o `FASE_0_ROTEIRO.md` mandavam preencher `skymp/gamemode/.env`. **Nenhum arquivo do gamemode chamava `require('dotenv')`** — quem lia esse arquivo era o `apps/web/server.js`, para si mesmo, o que tornava a falha invisivel.

Efeito: `module-registry.bootAll()` via `process.env[ENABLE_*]` sempre indefinido, entao governanca, barracas, morte, painel e VOIP ficavam desligados de forma permanente. Sem erro — o log dizia `DESATIVADO (... nao definido)`, exatamente o que diria se a pessoa tivesse escolhido desligar.

O check `flags de ambiente` dava `[PASS]` o tempo todo porque so conferia que a string existia no `.env.example`: provava que alguem escreveu a linha, nao que ligar a linha fazia algo.

### 2.17 🔴 Cargo de staff sobrevivia a desconexao — *corrigido*

`admin-service.removeStaffRole` existia, era exportada e tinha teste, e **nenhum caminho de producao a chamava**. O cache e chaveado por `actorId`, que o SkyMP reaproveita entre sessoes, e `registerStaffRole` so roda no login: quem entrasse no `actorId` de um admin que saiu herdava `ban`, `set_gold` e `retire_character`.

Nao aparecia em nenhum teste de permissao porque o cargo estava correto nos dois momentos — o defeito era de sessao, nao de autorizacao.

### 2.18 🔴 `npc-cleaner` apagava NPCs vitais, e implementava a opcao rejeitada — *corrigido*

Varria `mp.getActorsByProfileId(0)` e chamava `disable` **e `delete`** em todo ator, pulando so os de uma allowlist — que estava vazia. Mercadores, guardas e NPCs de quest, a cada 60 s, e `delete` numa referencia persistente nao volta.

O `NPC_POLICY_DECISION.md` avaliou tres opcoes e escolheu a **C (Spawn Seletivo)**; o codigo implementava a B, rejeitada, na forma mais extrema. Alem disso, `safeRadius` era declarado com o comentario "limpa apenas NPCs longe dos players" e **nunca lido**.

A lista virou de bloqueio (vazia = remove nada), o raio passou a existir, e o `delete` saiu.

### 2.19 🟠 `/setgold` era o unico caminho de dinheiro fora do ledger — *corrigido*

`UPDATE characters SET gold = ?` direto, sem transacao e sem linha em `gold_transactions` — o padrao que motivou apagar o `economy-service.js`. E o comando que mais precisa de rastro: ouro sem origem registrada e indistinguivel de duplicacao por bug, e quem pode fazer isso e a staff.

Junto veio um guard que faltava: `/setgold <id>` sem valor passava `NaN`, que o MySQL grava como `0` — um erro de digitacao zerava o patrimonio do jogador em silencio.

### 2.20 🟠 A compra em barraca reimplementava o `transaction-service` — *corrigido*

`buyItem` escrevia o SQL de saldo e de inventario a mao. Era atomico e com ledger, entao nao era inseguro; era uma segunda implementacao fora do arquivo que existe para ser a unica, com o `FOR UPDATE` e a guarda de saldo negativo duplicados.

Nao dava para resolver com as funcoes publicas do servico (cada uma abre a propria transacao, e a compra precisa commitar estoque, ouro, imposto e item juntos). As primitivas internas — que ja recebiam a conexao — passaram a ser exportadas como `tx.*`, com contrato explicito.

`buyItem` nao tinha **nenhum** teste de comportamento; ganhou 10.

### 2.21 🔴 `characters.gold` nao existia em banco migrado — *corrigido (migration v9)*

A coluna esta declarada no `schema.sql` e em **nenhuma migration**. Banco novo funciona; quem criou o banco antes dela e aplicou `v2`->`v8` em ordem, como o CONTRIBUTING manda, nunca a recebe. A v2 chega a criar a `gold_transactions` — o ledger — sem garantir a coluna de saldo que ele acompanha.

Nao quebra o boot: quebra na primeira operacao de ouro, que e todo o `transaction-service`. No roteiro da Fase 0, o teste morreria na **etapa 5.6**, depois de cinco etapas dando certo, com duas pessoas e o Skyrim abertos.

Achado pelo `npm run check:schema` (4.1 do plano) — exatamente a classe de problema para a qual ele foi escrito.

### 2.22 🟠 `core/soul.js` guardava dois caracteres invisiveis com significado — *corrigido*

O arquivo contava como binario para o `grep` e para o `file`. A causa nao era a que parecia: alem da classe de marcas combinantes crua no `normalize()`, havia um **byte NUL** no separador do material assinado, que se le na tela como `].join('')`.

O NUL e a escolha **certa** (nao sobrevive ao `normalize()`, entao ninguem consegue digita-lo na ficha; com separador digitavel, `'ab'+'c'` e `'a'+'bc'` assinariam o mesmo material e duas fichas nasceriam com a mesma alma). O problema era ele estar invisivel: qualquer editor que limpe caracteres de controle ao salvar mudaria a semente de **toda alma ja derivada**.

Verificado que as sementes nao mudaram, e a derivacao ganhou teste de valores dourados.

### 2.23 🔴 Dois defeitos que so o primeiro boot revelou — *corrigidos*

**`Cannot find module 'dotenv'`, e o gamemode nao carregava.** O SkyMP copia o arquivo de entrada para o `%TEMP%` e executa de la — esta escrito no topo do proprio arquivo, e e por isso que todos os requires dele usam caminho absoluto. O do dotenv, adicionado ao corrigir 2.16, era o unico nu, e especificador nu resolve a partir do diretorio do arquivo em execucao.

Passou nos 366 testes e no CI porque os dois rodam a partir de `skymp/gamemode/`. **E o exemplo mais limpo do que o cabecalho do `ci.yml` ja avisava:** *"CI verde significa que nao quebrou o que ja era verificado, nao que funciona em jogo"*.

**Nenhuma opcao de gameplay era lida.** O `.env.example` definia `NODE_ENV=development`, o loader monta `server-options.<NODE_ENV>.json`, e o projeto so tem `local` e `production`. Mexer em `permadeathEnabled`, nos raios de chat ou no `startingGold` nao fazia nada.

### 2.24 🟡 `database.js` nao tinha `close()` — *corrigido*

O `verify-governance-market-stalls.js` ja chamava `db.close()` atras de um guard, e a funcao nunca existiu: o guard nunca disparava e o pool do mysql2 segurava o event loop. `RUN_DB_CHECK=1 npm run test:systems` imprimia `10/10 passaram` e **ficava pendurado para sempre** (exit 124 por timeout; agora exit 0). Num CI com banco, o job so terminaria no timeout e o relatorio diria "cancelado".

### 2.25 🟠 Modulo PARKED podia ser ligado por fora do registry — *corrigido*

O `governance-service` decidia se o `economy-regional` roda lendo `process.env.ENABLE_REGIONAL_ECONOMY` direto, em dois pontos: a flag bastava para carregar e **executar** um modulo estacionado sem resolucao de dependencia, sem registro de comando e sem shutdown. O `CONTRIBUTING.md` §3.3 proibe exatamente isso, e a secao "Nao fazer" deste relatorio tambem.

### 2.26 🟡 O gerador de `mods.json` nao tinha teste — *corrigido*

Sendo o que decide o contrato de FormID — a coisa que, quando erra, nao produz erro: produz um bau com outra coisa dentro. Ganhou 6 testes e a flag `--only-load-order`, que permite rodar a Fase 0 antes de o modpack existir: sem ela, gerar o manifesto de uma `Data/` de trabalho produz um arquivo que exige a maquina de quem gerou.

---

## 2-ter. Aproveitamento do Red House (06-07/08/2026)

Os quatro itens que o `REFERENCE_STUDY_SKYMP_RED_HOUSE.md` §4.1 listou como aproveitaveis foram implementados. **Em tres deles o servidor real foi sondado antes de escrever** — assumir formato de API e o que causou 2.13 e 2.23.

| Item | O que mudou | Estado |
|---|---|---|
| Polling do painel | Lia 3 ActorValues por painel aberto a cada 2 s, inclusive de quem estava na aba Social (~450 ms por janela com 10 paineis). A UI ja mandava a aba ativa e o servidor descartava | ✅ |
| `isInSafeLocation` | A `action-policy` passa a bloquear por **lugar**, nao so por estado. Regra dos dois lados incluida | ✅ mecanismo; lista de zonas nasce vazia (§15 da Constituicao) |
| `lookupEspmRecordById` | Valida `base_id` contra os plugins carregados, em `/additem` e no anuncio de barraca | ✅ formato confirmado por sonda |
| `_onHit` | Agressao relatada pelo cliente vira evidencia de combate, substituindo a heuristica de damage spike | ✅ registrado; **snippet de cliente aguarda a Fase 0** |

**Uma diferenca deliberada em relacao a eles:** o Red House recalcula dano a partir do evento de hit e aplica. Nos nao — quem manda o evento e a maquina do jogador, e o `CONTRIBUTING.md` §3.6 e explicito sobre evento de cliente ser dica e nao prova. Vira evidencia para arbitragem de RDM, e a linha gravada declara de onde veio.

**Correcao de licenca:** o §4.1 do estudo afirmava "GPL-3.0 — nao da pra copiar codigo". Estava errado, e a `LICENSE_AND_AFFILIATION_POLICY.md` §4 ja dizia o contrario: somos `AGPL-3.0-or-later`, a GPLv3 §13 permite a combinacao, e da para aproveitar codigo de la com atribuicao. O erro empurrava para reescrever do zero o que dava para portar.

---

## 3. Plano de melhorias

Ordenado por **o que desbloqueia o quê**. Os itens da Fase 1 são pré-requisito pra qualquer teste com jogadores reais.

### Fase 1 — Fechar o caminho até "dois jogadores conectados"

| # | Item | Por quê |
|---|---|---|
| 1.1 | ✅ **Feito** — `apps/game-api` serve `/mods.json`, `/api/queue/join` e `/api/queue/status` | |
| 1.1b | ✅ **Feito** — a fila exige ticket emitido pelo painel (`launch_tickets`, migration v6), de uso único e guardado como hash | |
| 1.2 | ✅ **Feito** — `apps/game-api/scripts/generate-mods-manifest.js` | |
| 1.3 | ✅ **Feito** — `Start-AllServices.ps1` pré-checa cada serviço e reporta o que não subiu | |
| 1.4 | ✅ **Feito** — 29 smoke tests em `apps/web/server.test.js` | |
| 1.5 | **Rodar o [roteiro da Fase 0](FASE_0_ROTEIRO.md)** — passo a passo, ~50 min, 2 pessoas | **Etapa 0 concluída em 06/08/2026** (ambiente, banco migrado, servidor instalado, primeiro boot real — ver [o registro](../roadmap/FASE_0_LOG_2026-08-06.md)). Falta credencial do Discord, o painel no ar na 3001, e uma segunda pessoa. **Continua sendo o único bloqueio real.** |
| 1.5a | ✅ **Resolvido sem servidor** — os testes oficiais do SkyMP responderam. As 22 chamadas foram convertidas. Confirmar in-game continua valendo, mas como checagem, não investigação | |
| 1.6 | ✅ **Feito** — `apps/web` serve o master API, `game_sessions` (v8) guarda a sessão, `offlineMode: false` nos exemplos. Falta confirmar in-game | |
| 1.7 | ✅ **Feito** — `mp.onDeath` é o gatilho primário e a autoria vai pra `audit_logs` (`death:killer`). O polling continua como rede de segurança até o hook ser confirmado in-game | |
| 1.8 | **Tirar o polling do `death-service` de vez** assim que o `onDeath` for confirmado in-game | Deixou de ser só elegância: o Red House mediu ~15 ms por ida e volta ao Papyrus (`REFERENCE_STUDY_SKYMP_RED_HOUSE.md` 4.1). Nosso laço varre até 50 profileIds a cada 2 s — com 40 jogadores isso come ~600 ms de cada janela, sincronamente. Não escala. Vale rever o `player-panel-service` pelo mesmo motivo. |

### Fase 2 — Tirar a configuração-fantasma do caminho

| # | Item | Por quê |
|---|---|---|
| 2.1 | ✅ **Feito** — `core/server-options.js` com 8 opções ligadas, validação que aborta o boot e aviso pras inertes | |
| 2.2 | ✅ **Feito** — registro no `ready` do bot, sem derrubar o processo em caso de falha | |
| 2.3 | ✅ **Feito** — quatro apagados (`economy-service`, `justice`, `faction`, `survival`), sete mantidos como PARKED. Registrado em `PARKED_SERVICES_DECISION.md` | O mais urgente era `economy-service.js`: mexia em ouro sem atomicidade nem ledger, e 6 módulos PARKED o importavam — reativar qualquer um traria a economia insegura junto. Os importadores foram migrados pro `core/transaction-service` **antes** da remoção. |
| 2.4 | ✅ **Decidido** — manter e documentar como reservadas (`ARCHITECTURE.md` 1.1). Tabela vazia não tem caminho de execução nem duplica lógica; o custo de remover superaria o ganho | |

### Fase 3 — Endurecer para produção

| # | Item | Por quê |
|---|---|---|
| 3.1 | ✅ **Feito** — `PANEL_PUBLIC_URL` (aceita lista) define origem do CORS e fallback do callback | |
| 3.2 | ✅ **Feito** — poda por idade **e** por contagem (`CRASH_REPORT_MAX_AGE_DAYS`/`MAX_FILES`), disparada após cada recebimento | Dois limites porque um crash em loop gera centenas de relatórios no mesmo dia, e só a idade não seguraria. |
| 3.3 | ⚙️ **Configurado, falta o certificado.** `win.signtoolOptions` e o workflow `release-launcher.yml` existem e verificam a assinatura de verdade (`Get-AuthenticodeSignature` precisa devolver `Valid` **e** um carimbo de tempo); nenhum instalador assinado foi gerado, porque não há certificado. Ver [`LAUNCHER_DISTRIBUTION.md` §6](LAUNCHER_DISTRIBUTION.md). | Sem assinatura, SmartScreen bloqueia e o jogador não instala. O que falta são dois passos humanos: comprar o certificado (§6.3 compara OV, EV e Azure Trusted Signing) e confirmar o SmartScreen à mão numa máquina limpa — reputação é construída pela Microsoft ao longo de downloads reais e não é automatizável. |
| 3.4 | ✅ **Feito** — migration v7. Junto: `DATE(created_at)=CURDATE()` no dashboard virou comparação por intervalo, porque envolver a coluna numa função impede o uso de índice | |

### Fase 4 — Manutenção (adicionada em 06/08/2026)

Nasceu do estudo de integração com a Chancelaria Real, que roda em produção com práticas que faltavam aqui. Não depende de teste in-game nem de integração nenhuma.

| # | Item | Por quê |
|---|---|---|
| 4.1 | ✅ **Feito** — `npm run check:schema` compara o banco real com as migrations | Banco meio-migrado não quebra o boot; quebra a query que toca a coluna faltante, semanas depois. |
| 4.2 | ✅ **Feito** — `permissions.behavior.test.js`, matriz de cargo × comando contra os handlers reais | O bug `Set.has(20)` atravessou toda a suíte unitária. Esta é a classe que ele pertence. |
| 4.3 | ✅ **Feito** — testes do `identity-service` (firewall de disfarce) | O sistema que decide quem reconhece quem não tinha teste. Vazar o nome civil mata o disfarce sem erro nenhum. |
| 4.4 | ✅ **Feito** — [OPERATIONS.md](OPERATIONS.md) | Havia relatório de QA e nada de operação. |

### Não fazer

- **Migrar os manifestos pra formato Nexus Collections.** Ver `LAUNCHER_DISTRIBUTION.md` §5 — Collections não garante paridade de load order, que é o motivo dos manifestos existirem.
- **Perseguir o VOIP nativo antes do resto.** Continua valendo — **mas o motivo mudou em 07/08/2026 e o antigo não vale mais.** Já não depende de um patch de client: a captura saiu do navegador para um helper nativo, que **compilou e capturou áudio real** (`VOICE_NATIVE_HELPER.md` §8.3 e §8.4). O que sobra é que ninguém ouviu o áudio com o ouvido (§8.2), que o PCM cru custa ~1 Mbit/s de subida por locutor — bancada, não produção —, e que a Fase 0 continua sendo o bloqueio real. Os canais de voz do Discord seguem sendo a solução da Alfa.
- **Reativar módulo PARKED sem passar pelo `module-registry`.** O registry é o que garante flag, dependência e cleanup de comando; contorná-lo devolve o projeto ao estado que gerou boa parte dos bugs já corrigidos.

---

## 4. O que este relatório não cobre

- **Comportamento em jogo.** Nenhum comando (`/painel`, `/socorrer`, `/iniciar`, `/permakill`, `/voz`) foi executado numa sessão real. Os testes usam `mp` mockado. O servidor **subiu** em 06/08/2026 e o gamemode carregou, mas ninguém conectou.
- **O snippet de cliente do `_onHit`.** `mp.makeEventSource` foi confirmada por sonda e o boot registra o evento, mas o trecho que roda no Skyrim Platform só executa quando alguém conecta.
- **Interação real com a API do Discord.** O bot e a nova rota de OAuth não foram exercitados contra bot/guild reais.
- **Build empacotado do launcher.** A correção de `define` foi validada por typecheck, não por instalador gerado.
- **Carga.** Nenhuma medição com múltiplos jogadores, que é onde o polling de 2s do `death-service`/`player-panel`/`voip` tende a aparecer primeiro.
