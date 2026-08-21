# Auditoria da fronteira com o SkyMP

Data: **2026-08-14**. Base upstream lida: `skyrim-multiplayer/skymp@d85f18d8` (main, 06/08/2026), clone raso completo.

**Procedência de tudo que está aqui: leitura de código-fonte upstream.** Nada nesta auditoria vem de documentação oficial, e nada foi confirmado em jogo. Onde a documentação oficial contradiz o código, o código venceu e a divergência está registrada.

> **Atualização de 20/08/2026**: achado nº 4 (`BOUND-004`, `mp.onUiEvent`) corrigido — ver nota em §5. Reconfirmado nesta data que a busca contra o upstream continua zero ocorrências, direto contra o `main` atual (não só o commit `d85f18d8` desta auditoria).

---

## 1. O que esta auditoria foi procurar, e o que achou

A pergunta era a do briefing: **quais problemas do Heavy RP realmente exigem alterar o SkyMP?**

A resposta curta é *nenhum*. A resposta longa é pior e mais útil: procurando onde precisávamos de patch, o que apareceu foi **código nosso chamando API que não existe**. Seis defeitos, todos invisíveis para a suíte de testes porque o `mp` mockado aceita qualquer coisa.

| # | Achado | Onde | Gravidade | Camada da correção | Estado |
|---|---|---|---|---|---|
| 1 | `Actor.GetActorValue` não existe no servidor. A rede de segurança do `death-service` derruba **todo jogador conectado** em até 2 s | `death-service.js:244` | 🔴 **Bloqueia a Fase 0** | gamemode | aberto (`BOUND-001`) |
| 2 | `Actor.Resurrect` não existe. `/socorrer` e o respawn não ressuscitam ninguém | `death-service.js:340,434` | 🔴 Alta | gamemode | aberto (`BOUND-002`) |
| 3 | `mp.kick(actorId)` — `kick` recebe `userId`, não FormID. Kick de staff e permadeath não desconectam ninguém | `admin-service.js`, `death-service.js` | 🔴 Alta | adapter | ✅ **corrigido nesta entrega** |
| 4 | `mp.onUiEvent` não existe em lugar nenhum do SkyMP. **Todo o caminho CEF → servidor está ligado num callback que nunca é chamado** | `core/ui-event-gateway.js:77` | 🔴 Alta | client extension | ✅ **corrigido em 20/08/2026** (`BOUND-004`) — ver nota abaixo |
| 5 | `Actor.GetItemCount` só resolve se `Actor.pex` estiver nos `archives` | `jobs-service.js:94` | 🟡 Condicional | gamemode + config | aberto (`BOUND-006`) |
| 6 | `whitelist.js` expulsa depois do login em vez de recusar no `onLoginAttempt` | `whitelist.js` (5 sítios) | 🟡 Média | gamemode | aberto (`BOUND-005`) |

**Zero deles precisa de patch.** Todos se resolvem no nosso lado da fronteira. Ver §7 para a escada de decisão aplicada item a item.

**O nº 3 foi corrigido junto com esta auditoria** (14/08), porque era troca de chamada com teste. **O nº 4 foi corrigido em 20/08/2026** (ver §5) — troca de mecanismo com teste do lado servidor, sem exercitar o snippet de cliente contra CEF real. Os outros quatro exigem decidir o que colocar no lugar — e o nº 1 exige apagar código que existe como rede de segurança, o que merece revisão de quem escreveu.

E o resultado negativo que economiza mais trabalho: **os seis candidatos a patch do briefing — spawn hooks, death events, NPC sync, combate, UI custom, transição de célula — já têm resposta upstream.** A §3 mostra qual.

---

## 2. A superfície real da API `mp`

Fonte: `skymp5-server/cpp/addon/ScampServer.cpp`, bloco de `InstanceMethod` (linhas 90–142). São **40 métodos**. A documentação oficial (`docs/docs_serverside_scripting_reference.md`) descreve cinco.

### O que usamos

`callPapyrusFunction` (79×) · `set` (49×) · `get` (34×) · `getDescFromId` (18×) · `kick` (11×) · `getActorsByProfileId` (11×) · `lookupEspmRecordById` (7×) · `makeProperty` (6×) · `makeEventSource` (6×) · `getIdFromDesc` (3×) · `place` (2×) · `isConnected` (2×) · `getUserActor` (2×) · `onDeath` (hook)

### O que existe e nunca usamos — e o que cada um destravaria

| Método | O que destrava |
|---|---|
| `createBot()` | Cliente headless de rede, dentro do processo do servidor. É como o upstream roda os nove testes de `misc/tests/`. **É o caminho para automatizar parte da Fase 0** |
| `setPacketHistoryRecording` / `getPacketHistory` / `requestPacketHistoryPlayback` | Gravar e reproduzir o tráfego de um jogador. Repro determinística de bug de sessão |
| `getNeighborsByPosition` | Vizinhança por posição, calculada pelo motor. O `voip-service` faz distância 3D à mão em JS a cada 2 s para todos os pares |
| `getActorCellOrWorld` | Célula/worldspace de um ator sem passar por Papyrus |
| `getEspmLoadOrder` | A ordem de plugins que o **servidor** carregou, em runtime. É a metade que falta do gate de paridade — ver [`PLUGIN_LOAD_ORDER_STRATEGY.md`](../technical/PLUGIN_LOAD_ORDER_STRATEGY.md) |
| `registerPapyrusFunction` | Registrar função nativa nova no VM Papyrus, a partir do gamemode. Ver [`PAPYRUS_USAGE_POLICY.md`](../technical/PAPYRUS_USAGE_POLICY.md) §5 |
| `getAllForms`, `findFormsByPropertyValue` | Varredura e índice de forms por property |
| `sendCustomPacket` | Servidor → cliente, fora do sistema de properties |
| `getUserByActor` | **O conversor que falta no achado nº 3** |
| `getPrometheusMetrics` | Métricas do motor no nosso endpoint |
| `_sp3ListClasses`, `_sp3ListMethods`, `_sp3GetFunctionImplementation`, … | Reflexão sobre o VM Papyrus **em runtime**. Permite descobrir, no boot, exatamente quais funções existem — em vez de descobrir em produção |

Seis capacidades ociosas, e duas delas (`createBot`, `_sp3*`) atacam diretamente o problema estrutural do projeto: *nada foi exercitado fora do mock*.

### Os hooks de gamemode

Fonte: `skymp5-server/cpp/server_guest_lib/gamemode_events/*.cpp`, método `GetName()`. Esta é a lista completa:

`onActivate` · `onCraft` · `onDeath` · `onDropItem` · `onEatItem` · `onPapyrusEvent:<Nome>` · `onPutItem` · `onReadBook` · `onRespawn` · `onTakeItem` · `onUpdateAppearanceAttempt` · `onUpdateEquipmentAttempt`

Mais `onLoginAttempt`, que não é C++ — vive em `skymp5-server/ts/systems/login.ts:...` e é chamado antes do spawn.

**Usamos exatamente um: `onDeath`.** Os onze restantes cobrem inventário (`onDropItem`, `onPutItem`, `onTakeItem`), consumo (`onEatItem`), crafting (`onCraft`), livros (`onReadBook`) e — o mais relevante — os dois `*Attempt`, cujo sufixo indica veto: aparência e equipamento passam pelo gamemode **antes** de serem aceitos.

---

## 3. Os seis candidatos a patch do briefing

O briefing §3 listou o que "aparentemente exige alteração do SkyMP". Cada um foi verificado contra o código.

### 3.1 Spawn hooks — **não precisa de patch, e o patch do Divine Comedy não serviria**

`skymp5-server/ts/systems/spawn.ts` resolve o spawn inteiro dentro do sistema, sem hook. Confirmado em `d85f18d8`: o `onPlayerSpawn` que o Divine Comedy adiciona por patch **continua não existindo upstream**.

Só que o patch deles também não nos serviria. O `Spawn` registra o listener em `ctx.gm.on("spawnAllowed", listenerFn)`, e `ctx.gm` é um `new EventEmitter()` criado em `index.ts` e **nunca exposto ao gamemode** — o gamemode recebe só `globalThis.mp = server`. A linha seguinte, `(ctx.svr as any)._onSpawnAllowed = listenerFn`, pendura a mesma função no objeto do servidor, e é aí que mora a armadilha:

> **`mp._onSpawnAllowed` é legível e chamável pelo gamemode, mas sobrescrevê-lo não intercepta nada.** O emitter guarda a referência da função original; trocar a property não desregistra o listener.

O que dá para fazer sem patch: **chamar** `mp._onSpawnAllowed(userId, profileId, roles, discordId)` para forçar carregamento de personagem, e corrigir posição depois do fato com `mp.set(actorId, 'pos' | 'worldOrCellDesc', …)`. É o que já fazemos desde `cd1fb6a`.

**Veredito: `UPSTREAM` + correção pós-fato. Nenhum patch.**

### 3.2 Death events — **existe, e é melhor que o nosso polling**

`mp.onDeath = (actorId, killerId) => {}` existe, entrega o autor, e já está ligado no `core/death-events.js`. `mp.onRespawn` também existe e não usamos.

O problema não é o hook: é a "rede de segurança" que o acompanha. Ver §4.

**Veredito: `UPSTREAM`. O trabalho é remover o polling, não adicionar API.**

### 3.3 NPC sync — **é configuração, não código**

`server-settings.json` aceita `npcEnabled` (padrão **`false`**) e `npcSettings`, com controle por arquivo de origem e por interior/exterior:

```json5
"npcSettings": {
  "default":     { "spawnInInterior": true, "spawnInExterior": false },
  "Skyrim.esm":  { "spawnInInterior": true, "spawnInExterior": false }
}
```

Isso já tinha mordido o projeto uma vez — o [handoff de 12/08](../roadmap/MOBS_LOOT_LAB_HANDOFF_2026-08-12.md) registra NPCs desabilitados por ausência de `npcEnabled`. O que a auditoria acrescenta é o `npcSettings`: **a decisão de fauna do [`HOSTILE_MOB_ACTIVATION_DECISION.md`](../technical/HOSTILE_MOB_ACTIVATION_DECISION.md) é expressável em configuração**, por plugin e por tipo de célula, sem uma linha de gamemode.

**Veredito: `UPSTREAM` (configuração). Nenhum patch.**

### 3.4 Combate — **servidor já é autoritativo**

O servidor tem fórmula de dano própria (`damageMultFormulaSettings`), modificadores de stamina por keyword de arma (`weaponStaminaModifiers`), e o pacote OnHit documentado em `docs/docs_onhit_and_damage.md`. O `core/hit-events.js` complementa com evidência de cliente, e o próprio arquivo já declara que é evidência e não enforcement.

Vale registrar o contraste com o Red House: eles **reverteram** exatamente essa camada — ver [`SKYMP_FORK_DIFF_MATRIX.md`](SKYMP_FORK_DIFF_MATRIX.md) §4.

**Veredito: `UPSTREAM`. Nenhum patch.**

### 3.5 UI custom — **o caminho existe, e não é o que implementamos**

Este é o achado nº 4 e merece a §5 inteira.

### 3.6 Transição de célula — **não há hook, e a alternativa é barata**

Não existe evento de mudança de célula na lista de `gamemode_events`. O que existe:

- `mp.getActorCellOrWorld(actorId)` — leitura direta, sem Papyrus;
- a property built-in `worldOrCellDesc`, legível por `mp.get`;
- `Cell.IsInterior` / `Cell.IsAttached` no VM Papyrus.

Detectar transição vira comparar `worldOrCellDesc` entre ticks, ou — melhor — um `makeEventSource` que assina `ctx.sp.on('cellFullyLoaded'|'locationChanged', …)` no cliente. Isso é extensão de cliente, não patch.

**Veredito: `ADAPTER` para o caso barato, `CLIENT EXTENSION` para o caso preciso. Nenhum patch.**

### 3.7 Voz — sem mudança

Não há nada de voz no upstream, e a nossa arquitetura (captura WASAPI fora do CEF, relay pelo servidor) é deliberadamente externa. Registrado em [`VOICE_NATIVE_HELPER.md`](../technical/VOICE_NATIVE_HELPER.md). A auditoria não mudou nada aqui.

### 3.8 ESL e índices de plugin — **o único item que é limitação real**

`libespm` e o servidor **não têm nenhum tratamento de ESL / light master**. Busca por `esl`, `light master`, `0xFE`, `isLight` em `libespm/` e `skymp5-server/cpp/`: zero ocorrências.

`FormDesc::ToFormId` é aritmética de índice de um byte, e nada mais:

```cpp
realFormId = fileIdx * 0x01000000 + shortFormId;   // FormDesc.cpp
```

Isso é limitação de arquitetura, não bug. Tem consequência de produto e está tratado em [`PLUGIN_LOAD_ORDER_STRATEGY.md`](../technical/PLUGIN_LOAD_ORDER_STRATEGY.md).

**Veredito: `UPSTREAM ISSUE` — cabe PR, mas é grande. Enquanto isso, política de modpack.**

---

## 4. O achado que bloqueia a Fase 0

**`death-service.js` derruba todo jogador conectado em até dois segundos.** Não é atraso, não é falha de detecção: é queda garantida, em cadeia, para todo mundo.

O mecanismo, passo a passo, todo verificável no fonte:

1. `death-service.js:243` chama `mp.callPapyrusFunction('method', 'Actor', 'getActorValue', actorRef(actorId), ['Health'])`.
2. O VM do servidor não tem `GetActorValue` registrado. `PapyrusActor.cpp` registra 27 métodos; `GetActorValue` não é um deles — só `GetActorValuePercentage`. Busca por `"GetActorValue"` em `skymp5-server/` e `papyrus-vm/`: **zero ocorrências**.
3. `VirtualMachine::CallMethod` percorre os Pex ativos, depois a cadeia de classes nativas, não acha, **loga um erro e devolve `VarValue::None()`** (`VirtualMachine.cpp:335`). Não lança.
4. `VarValue()` é `kType_Object` com ponteiro nulo (`VarValue.h:50`). `GetJsObjectFromPapyrusObject` devolve `env.Null()` para ponteiro nulo (`PapyrusUtils.h`).
5. O gamemode recebe **`null`**.
6. `const currentlyDead = (health <= 0)` — e em JavaScript **`null <= 0` é `true`**, porque a comparação relacional converte `null` para `0`.

Resultado: no primeiro tick do laço de 2 s, todo ator com personagem ativo entra em `handlePlayerDowned` → estado `DOWNED`, mensagem de proximidade *"O corpo cai ao chão, ferido e sangrando"*, e um timer de bleed-out que termina em `executeRespawn` ou permadeath.

`_downedPlayers` garante que acontece **uma vez por personagem**. Uma vez basta.

### Por que a suíte não viu

Os testes injetam `mp` mockado, e o mock devolve o número que o teste quiser. É o mesmo mecanismo que escondeu as 22 chamadas Papyrus com `self` cru por meses — documentado no cabeçalho de `core/papyrus.js`, encontrado uma vez, e a classe do problema continuou aberta.

**A lição não é "escreva mais testes". É que um mock que aceita tudo não é fronteira**, e é exatamente por isso que a §8 propõe uma.

### A ironia

O laço existe como *rede de segurança* para o caso de `mp.onDeath` não disparar. O comentário no código diz: *"Se ele não disparar como esperado, o polling ainda pega a queda — com atraso, mas pega."*

`onDeath` está implementado e correto. A rede de segurança é o que quebra.

### Correção

Remover o laço. `mp.onDeath` já cobre a queda e traz o autor; `mp.onRespawn` cobre a volta. O que se perde é `checkDamageSpike`, que é heurística de agressão-sem-morte — e cuja substituição correta é o `hit-events` por `makeEventSource`, já escrito.

Se um leitor de vida for mesmo necessário, o método que existe é `GetActorValuePercentage`, que devolve fração de 0 a 1 — **outra semântica**, não substituição drop-in.

---

## 5. O caminho CEF → servidor, e por que o nosso não existe

`core/ui-event-gateway.js:77` faz `mpApi.onUiEvent = gateway`.

Busca por `onUiEvent` em `skymp5-client/src`, `skymp5-server/cpp`, `skymp5-front/src` e `skymp5-functions-lib/src`: **zero ocorrências**. O SkyMP nunca chama essa property. `ui-event-router`, `ui-event-rate-limiter`, os schemas de `governance` e `player-panel`, o menu de interação — tudo isso está ligado a um callback morto.

[`TASK_001`](../roadmap/TASK_001_UI_EVENT_CONTRACT.md) declara "validação CEF real pendente" e diz aplicar a camada "sem substituir o protocolo do SkyMP". **Não havia protocolo a preservar.**

### O caminho que existe

Três saltos, todos lidos no fonte:

1. **CEF → cliente.** A página chama `window.skyrimPlatform.sendMessage(...)`; o SkyrimPlatform emite o evento `browserMessage`, com os argumentos em `e.arguments`. O `browserService.ts` upstream trata só `"front-loaded"` e ignora o resto.
2. **Cliente → servidor.** `mp.makeEventSource("_nome", "<JS de cliente>")` injeta um trecho que roda no cliente com um `ctx` que tem `sp` (o SkyrimPlatform), `state` e `sendEvent(...args)`. `sendEvent` serializa cada argumento e manda uma `CustomEventMessage` (`gamemodeEventSourceService.ts:97`).
3. **Servidor → gamemode.** `ActionListener::OnCustomEvent` **exige que o nome comece com `_`** (`ActionListener.cpp:747`), monta o array de argumentos e dispara `mp._nome(pcFormId, ...args)`.

Ou seja, a correção é de tamanho de bilhete:

```js
mp.makeEventSource('_onUiEvent', `
  ctx.sp.on('browserMessage', (e) => { ctx.sendEvent(...e.arguments); });
`);
mp._onUiEvent = (pcFormId, ...args) => gateway(pcFormId, args[0]);
```

Nada de patch, nada de fork. **Toda a validação, o rate limiting e os schemas que a `TASK_001` construiu continuam valendo** — muda só o fio que os alimenta.

### Três coisas que essa descoberta traz junto, e nenhuma é boa notícia

**O cliente pode desligar qualquer event source.** `gamemodeEventSourceService.ts` filtra por `settings["skymp5-client"]["blockedEventSources"]`, um array no arquivo de configuração **do jogador**. Quem editar aquilo desliga o nosso `_onUiEvent`, o `hit-events` e qualquer outro. Event source é canal de conveniência, **nunca de autoridade** — o que já era a nossa regra, agora com mecanismo nomeado.

**O JS enviado pelo servidor pode exigir assinatura.** `ServerJsVerificationService.verifyServerJs` rejeita o snippet se o peer alvo declarar `publicKeys` e a última linha não for `// skymp:sig:y:<keyId>:<base64>` com assinatura válida. Se `publicKeys` estiver ausente, a verificação é pulada. As chaves vêm de `settings["skymp5-client"]["server-public-keys"]` mescladas com as do peer padrão — **configuração de cliente**. Consequência prática: se o `getTargetPeer` ainda não resolveu, **todos os event sources falham com `target peer not ready`** e nada é dito ao servidor.

**Hot reload não alcança quem já está conectado.** `enableGamemodeDataUpdatesBroadcast` nasce `false`: mudança de gamemode vale no servidor, mas os event sources só chegam a quem logar depois. Isso entra no procedimento de atualização — ver [`SKYMP_COMPATIBILITY_MATRIX.md`](../technical/SKYMP_COMPATIBILITY_MATRIX.md) §4.

### ✅ Corrigido em 20/08/2026

`core/ui-event-gateway.js` passou a registrar `mp.makeEventSource('_onUiEvent', ...)` com o snippet exato desta seção (`ctx.sp.on('browserMessage', ...)` → `ctx.sendEvent(...)`), e `ui/index.html` (`sendUiEvent`) passou a chamar `window.skyrimPlatform.sendMessage({type, data})` em vez de `window.mp.trigger`/`window.mp.send` — que também nunca foram confirmados como API real da CEF (busca por `window.mp` no upstream só aparece em `skymp5-front`, o painel administrativo separado, não no cliente de jogo). Os outros usos de `mp.trigger`/`mp.events.add` em `ui/index.html` (voip, trade, `interaction:open`/`close`, todos servidor→cliente ou internos à UI) **não foram tocados nesta correção** — continuam com o mesmo nível de confiança de antes, nem confirmados nem corrigidos. O snippet de cliente novo não foi exercitado contra CEF real (mesma ressalva de `core/hit-events.js`); só o lado servidor (registro do event source + despacho) tem teste automatizado. Ver `docs/research/MINING_RUNTIME_VALIDATION_REPORT.md` para o contexto que motivou a correção.

---

## 6. `mp.kick` recebe `userId`

```cpp
Napi::Value ScampServer::Kick(const Napi::CallbackInfo& info) {
  auto userId = info[0].As<Napi::Number>().Uint32Value();
  server->CloseConnection(userId);
}
```

`userId` é o slot de conexão (0..`maxPlayers`). O conversor é `mp.getUserByActor(formId)`.

Nosso código fazia as duas coisas:

| Sítio | Passava | Estado |
|---|---|---|
| `whitelist.js` (5×) | `userId` | ✅ sempre esteve certo |
| `core/connection-monitor.js:95` | `userId` | ✅ sempre esteve certo |
| `admin-service.js` (kick de staff) | `targetActorId` | ✅ migrado para `skymp.kick` |
| `admin-service.js` (permakill) | `targetActorId` | ✅ migrado |
| `death-service.js` (permadeath) | `actorId` | ✅ migrado |

FormID de ator criado pelo servidor vive em `0xFF000000+`; passar isso para `CloseConnection` fecha um slot que não existe. **Kick de staff, permakill e permadeath não desconectavam ninguém.** As três são ações de moderação, e as três falhavam em silêncio.

É a mesma classe do bug do `self` do Papyrus: dois formatos válidos para a mesma ideia, sem fronteira que force um. É a razão de existir do adaptador da §8, e os três sítios agora chamam `skymp.kick(actorId)`, que converte por `getUserByActor` — ou **recusa**, se o conversor não existir naquele servidor. Chutar aqui significaria desconectar a pessoa errada.

`version-check.js` continua chamando `admin.kickPlayer(0, actorId, …)`, que passa `0` como quem manda: `hasPermission(0, 'kick')` nega, e a expulsão por versão incompatível nunca acontece. É outro defeito, de outra natureza, registrado na [matriz de compatibilidade](../technical/SKYMP_COMPATIBILITY_MATRIX.md) §1 como `COMPAT-002`.

---

## 7. A escada aplicada

A escada do [`SKYMP_PATCH_POLICY.md`](../technical/SKYMP_PATCH_POLICY.md): **upstream → adapter → client extension → patch → fork**, parando no primeiro degrau que resolve.

| Problema | Degrau | O que fazer |
|---|---|---|
| Vida do ator lida por Papyrus inexistente | **upstream** | Apagar o laço; `mp.onDeath` já cobre |
| Ressuscitar ator | **upstream** | `mp.set(id, 'isDead', false)` + `SetActorValue`; `Resurrect` não existe |
| Kick com FormID | **adapter** | `kick(actorId)` converte por `getUserByActor` |
| Eventos de CEF | **client extension** | `makeEventSource('_onUiEvent', …)` |
| Whitelist depois do login | **upstream** | `mp.onLoginAttempt` recusa antes do spawn |
| Ferramenta no inventário | **upstream + config** | `ObjectReference.GetItemCount`; exige `Actor.pex` nos `archives` |
| Transição de célula | **adapter** | `getActorCellOrWorld` ou event source |
| NPC / fauna | **upstream** | `npcEnabled` + `npcSettings` |
| Proximidade de voz | **adapter** | `getNeighborsByPosition` no lugar da distância em JS |
| Paridade de load order | **upstream** | `getEspmLoadOrder` fecha o outro lado do gate |
| ESL / light master | **upstream issue** | Não existe. PR é grande; por ora, política de modpack |
| Par montado (Hijos) | **patch** | Único candidato legítimo. Continua em P6 |

**Um candidato a patch em doze problemas.** E ele é o mesmo `MOUNT-001` que o roadmap já tinha colocado depois da Fase 0.

---

## 8. Por que existe um adaptador, e por que ele é pequeno

Cinco dos seis defeitos são a mesma doença: **a fronteira entre o gamemode e o motor não é um objeto, é uma convenção não escrita.** `mp` é global, aceita qualquer property, e o mock dos testes também.

O adaptador é [`core/skymp-adapter/`](../../skymp/gamemode/core/skymp-adapter/README.md). Ele cobre só o que esta auditoria provou instável:

- **identidade** — `userId` versus `actorId`, o achado nº 3;
- **Papyrus** — chamada verificada contra a lista real de funções do servidor, os achados nº 1, 2 e 5;
- **capacidades** — `supports(nome)` responde se a API existe *neste* servidor, em vez de espalhar `typeof mp.x === 'function'` pelo código.

E deliberadamente **não** cobre `get`/`set`/`makeProperty`/`place`/`lookupEspmRecordById`: são estáveis, nunca deram problema, e envolvê-las só adicionaria indireção. O briefing §8 diz isso com todas as letras — *"não criar wrapper para cada função do SkyMP, apenas boundaries instáveis"* — e é a regra que impede o adaptador de virar uma segunda API para manter.

---

## 9. O que continua sem prova

Regra da casa, e aqui ela pesa mais que o normal.

- **Nada disto rodou em jogo.** É leitura de fonte de um commit específico. Se o servidor que rodamos não for `d85f18d8`, alguma coisa pode diferir — e é por isso que a [matriz de compatibilidade](../technical/SKYMP_COMPATIBILITY_MATRIX.md) passa a fixar o commit.
- **Os seis defeitos são deduções, não observações.** A cadeia de cada um está escrita acima para que possa ser derrubada por quem discordar. O nº 1 é o mais fácil de verificar em sessão real: se o achado estiver certo, todo mundo cai em dois segundos, e não há como não notar.
- **O caminho CEF nunca foi exercitado.** A correção da §5 é a leitura mais provável do fonte, não uma sessão bem-sucedida.
- **`Actor.pex` nos `archives`** decide o achado nº 5 e não sabemos o estado da nossa configuração. É uma conferência de dez minutos que não foi feita.

---

## 10. Onde isto entra no roadmap

Os achados nº 1 a nº 4 **são pré-requisitos da Fase 0**, não itens de backlog. Um servidor onde todo jogador cai em dois segundos não produz sessão de teste — produz um relatório de bug e uma noite perdida.

Isso não contraria a regra de que nada passa na frente da Fase 0. É o contrário: é a primeira vez que a pesquisa produz algo que **está dentro** dela.

| ID | Tarefa | Bloqueia Fase 0 | Estado |
|---|---|---|---|
| `BOUND-001` | Remover o laço de polling do `death-service` | **sim** | aberto |
| `BOUND-002` | Substituir `Actor.Resurrect` por `isDead` + `SetActorValue` | **sim** | aberto |
| `BOUND-003` | `kick` pelo adaptador nos três sítios | **sim** | ✅ 14/08 |
| `BOUND-004` | `_onUiEvent` por `makeEventSource` | **sim** | ✅ 20/08 |
| `BOUND-005` | Whitelist por `onLoginAttempt` | não | aberto |
| `BOUND-006` | Conferir `Actor.pex` nos `archives` | não | aberto |
| `BOUND-007` | Proximidade de voz por `getNeighborsByPosition` | não | aberto |
| `BOUND-008` | `createBot` + `misc/tests` como harness de integração | não — mas muda o custo de tudo | aberto |

`BOUND-008` é o de maior alcance e o menos urgente. Se o gamemode puder rodar como teste dentro de um servidor real, com ESM carregado e VM Papyrus de verdade, a classe inteira de defeito desta auditoria — *chamamos API que não existe* — deixa de conseguir chegar em produção.
