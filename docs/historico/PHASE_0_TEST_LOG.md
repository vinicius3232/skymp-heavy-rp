# Fase 0 - Log de Testes

> ⚠️ **Registro histórico (11/07/2026).** É a evidência do **primeiro boot de
> servidor** do projeto, com `offlineMode=true` e o gamemode mínimo
> `phase0-basic.js`. Preservado porque é a única prova documental daquele boot —
> mas **não é o registro que se preenche hoje**. O roteiro em vigor é
> [`FASE_0_ROTEIRO.md`](../technical/FASE_0_ROTEIRO.md) e o log ativo é
> [`FASE_0_LOG_2026-08-06.md`](../roadmap/FASE_0_LOG_2026-08-06.md).
> Não acrescente linhas aqui.

Use este arquivo para registrar evidencias reais dos testes SkyMP.

## Ambiente

- Data: 2026-07-11
- Responsavel: Codex/Vinicius
- Maquina: Windows local
- Skyrim versao: Steam SE/AE `1.6.1170.0`, verificado diretamente pelo executavel.
- SkyMP build: GitHub Actions artifact `server-dist`
- SkyMP origem: `skyrim-multiplayer/skymp`, workflow `PR Windows Flatrim (AE/SE)`, run `29137896242`
- Commit/tag: `dbbc6b7e4bb33f79c45387a144eaa513aa88030c`
- Cliente usado: GitHub Actions artifact `dist/client`, instalado via `scripts/phase0/Install-SkyMPClient.ps1`
- `databaseDriver`: `file`
- Porta principal: UDP `7777`
- Porta UI: TCP `3000`
- Observacao: `offlineMode=true` foi usado apenas para laboratorio local com `profileId`.

## Teste 0.1 - Boot do Servidor

- Resultado esperado: servidor inicia sem erro critico.
- Resultado real: servidor inicializou, carregou `dataDir`, storage `file`, gamemode minimo `phase0-basic.js` e ficou ativo sem erros criticos.
- Logs relevantes:
  - `Hot reload is disabled for Papyrus`
  - `Using data dir '..\data'`
  - `Using file with name '..\world'`
  - `Gamemode path is "D:\Documents\New project\skymp\gamemode\phase0-basic.js"`
  - `[phase0] SkyMP Heavy RP gamemode loaded`
  - `[phase0] mp API available`
  - `Server resources folder is listening on 3000`
- Status: aprovado.

## Teste 0.2 - Conexao Cliente 1

- Resultado esperado: primeiro cliente conecta e spawna.
- Resultado real: cliente conectou com `profileId=1` e `offlineMode=true`. O spawn inicial em `[0,0,0]` causou queda/morte. Apos ajuste para interior seguro, o spawn visual foi confirmado pelo jogador.
- Logs relevantes:
  - `ServerState::Connect: assigning guid for userId=1`
  - `Connecting a user 1 with ip 127.0.0.1`
  - `Loading character ff000000`
  - `1 logged as 1`
- Status: aprovado para laboratorio local.

## Teste 0.3 - Conexao Cliente 2

- Resultado esperado: segundo cliente conecta com perfil separado.
- Resultado real: cliente com `profileId=2` conectou no servidor local, autenticou como `userId=2` e criou/carregou personagem separado.
- Logs relevantes:
  - `ServerState::Connect: assigning guid for userId=2`
  - `Connecting a user 2 with ip 127.0.0.1`
  - `Creating character ff000001`
  - `2 logged as 2`
- Status: aprovado por log local.

## Teste 0.4 - Sincronizacao Basica

- Resultado esperado: dois clientes ficam conectados simultaneamente e se veem em movimento.
- Resultado real: conexoes de `userId=1` e `userId=2` se sobrepuseram no servidor por curto periodo. Como o teste foi no mesmo PC e a Steam limita dois clientes graficos simultaneos, a validacao visual de movimento mutuo ainda nao foi concluida.
- Logs relevantes:
  - `connect 2`
  - `2 logged as 2`
  - `disconnect 1`
- Status: parcialmente aprovado para rede; pendente para validacao visual com dois ambientes.

## Teste 0.5 - Morte e Respawn

- Resultado esperado: servidor detecta morte e programa respawn.
- Resultado real: no spawn inicial inadequado, o jogador morreu por queda. O servidor detectou o evento e agendou respawn com delay.
- Logs relevantes:
  - `EvaluateDeathItem ff000000 - No death item found, skipping add`
  - `MpActor::RespawnWithDelay ff000000 - finally, respawn after 25 seconds`
- Status: aprovado para morte/respawn nativo; pendente teste controlado com dois clientes.

## Teste 0.6 - Persistencia

- Resultado esperado: estado de mundo/personagem e mantido apos restart.
- Resultado real: apos restart do servidor, o storage `file` carregou personagem persistido.
- Logs relevantes:
  - `AttachSaveStorage took 0 seconds and 1 milliseconds, loaded 1 ChangeForms (Including 1 player characters)`
  - `Loading character ff000000`
- Status: aprovado para personagem basico; pendente repetir apos inventario/equipamento.

## Teste 0.7 - Chat Local

- Resultado esperado: mensagens por proximidade.
- Resultado real: prototipo server-side implementado para comandos RP locais, com parser, alcance por tipo de fala, anti-spam simples, logs e fallback para console. Ainda nao foi validado em jogo com dois clientes.
- Comandos cobertos: `/me`, `/do`, `/ooc`, `/b`, `/s`, `/sussurrar`, `/g`, `/gritar`, `/roll`, `/try`, `/report`, `/apresentar`, `/apelido` e chat local padrao.
- Evidencia local: `npm test` em `skymp/gamemode` cobre parser, alcance, rolagem, report, anti-spam e resolucao de nome desconhecido/conhecido.
- Identidade social: `character_known_identities` aplicada no banco local com `node skymp/gamemode/setup-db.js`.
- Status: implementado em laboratorio; pendente validacao funcional em jogo.

## Teste 0.8 - Boot Fase 0 Limpo

- Data: 2026-07-12
- Resultado esperado: servidor inicia por 15 segundos, abre portas principais e nao gera erro critico de schema ou servicos avancados.
- Resultado real: servidor ficou vivo apos 15 segundos.
- Portas observadas:
  - TCP `127.0.0.1:3000`
  - UDP `127.0.0.1:7777`
- Logs relevantes:
  - `Gamemode path is "D:\Documents\New project\skymp\gamemode\phase0-basic.js"`
  - `[phase0] SkyMP Heavy RP gamemode loaded`
  - `[database] MySQL connection pool initialized successfully`
  - `[phase0] Database pool initialized`
  - `[phase0] mp API available`
  - `Server resources folder is listening on 3000`
- Observacao: servicos avancados de RP ficam desligados por padrao na Fase 0 para evitar dependencias prematuras de schema, VOIP, economia regional, faccoes, justica e death polling customizado.
- Status: aprovado para boot tecnico local.

## Testes Ainda Obrigatorios Para Fechar Fase 0

- Dois clientes em maquinas/ambientes separados.
- Visibilidade e movimento entre jogadores.
- Troca de celula interior/exterior.
- Inventario e equipamento.
- Morte/respawn controlado.
- Persistencia apos restart depois de alterar inventario/equipamento.

## Bugs Encontrados

```text
ID: BUG-001
Data: 2026-07-11
Build: dbbc6b7
Ambiente: Local
Passos: Spawnar com coordenadas iniciais [0,0,0].
Resultado esperado: personagem nascer no chao de forma estavel.
Resultado real: personagem spawnou no ar e morreu por queda.
Gravidade: media.
Solucao: alterar spawn inicial para celula interior segura.
Bloqueia progresso? nao, mitigado por configuracao.
```

```text
ID: BUG-002
Data: 2026-07-12
Ambiente: Local
Passos: Rodar boot rapido com gamemode carregando servicos avancados por padrao.
Resultado esperado: Fase 0 iniciar limpa para teste de rede/spawn.
Resultado real: unhandledRejection por tabelas ausentes como holds, faction_members e prison_records; death polling tambem gerava erro de propriedade/metodo.
Gravidade: alta para Fase 0.
Solucao: desligar servicos avancados por padrao e habilitar somente por flags explicitas no ambiente.
Bloqueia progresso? mitigado; proximo bloqueio e validacao com dois clientes reais.
```

## Decisao Atual da Fase 0

- Continuar: sim.
- Corrigir antes de avancar: validar dois clientes com visibilidade real e completar testes de celula/inventario/equipamento.
- Trocar abordagem: nao.
- Justificativa: a base SkyMP inicial funciona, mas ainda nao ha evidencia suficiente para desenvolver sistemas complexos como economia, casas, prisao, faccoes, VOIP completo ou launcher completo.
