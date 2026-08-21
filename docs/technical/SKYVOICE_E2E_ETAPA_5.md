# SkyVoice — Etapa 5: a costura entre o launcher e o microfone

**Data:** 2026-08-14 (noite)
**Branch:** `feat/skyvoice-core-etapa-2`
**Estado de partida:** `3ea1895`
**Objetivo da rodada:** primeiro end-to-end REAL, dois clientes Skyrim.

---

## VEREDITO

# ⚠️ NÃO TESTADO EM SKYRIM

Nenhum cliente Skyrim rodou nesta rodada, e ninguém ouviu voz nenhuma. O
critério do §30 do roteiro **não foi atingido** e nada aqui deve ser lido como
"SkyVoice pronto".

O que esta rodada fez foi diferente, e é o que faltava para o teste com gente ser
possível:

> **O caminho do launcher até o microfone estava quebrado em três lugares, e os
> três estavam verdes.** Os testes passavam, o typecheck passava, o painel diria
> `CONNECTED` — e o `voice-helper.exe` morria 40 ms depois de subir, em toda
> execução, desde sempre.

Agora a cadeia
`launcher → pareamento → helper → microfone WASAPI → voip-service → política →
ouvinte` roda de ponta a ponta **com áudio real medido**, sem mock em lugar
nenhum. O que continua faltando para o §30 está no §4 (o mensageiro) e no §5 (o
LiveKit não tem cliente).

---

## 1. Estado inicial — o mapa que a Etapa 1 pedia

Nada aqui foi presumido: cada linha foi lida no código do branch.

### 1.1 Como o jogador abre o jogo

```
launcher (Electron)
   │ ipcMain.handle('launch-game')            main.ts:1403
   ├─ escreve skymp_config.json (session, serverAddress, discordId)
   ├─ startVoiceHelper(folderPath)            main.ts:680      ← o furo estava aqui
   ├─ escreve config.voice (helperControlUrl, pairingToken)
   └─ spawn skse64_loader.exe
```

### 1.2 Quem inicia o helper, e com o quê

| Pergunta | Resposta encontrada no código |
|---|---|
| Quem inicia | `startVoiceHelper`, do `main.ts`, **antes** do jogo |
| Argumentos | `helperArgs()` → `--control-host --control-port --pair --log-level --ptt` |
| Como acha o microfone | `ma_device_init(nullptr, …)` — dispositivo padrão do sistema, WASAPI compartilhado |
| Como recebe identidade | Não recebia. `--actor-id` é do modo de bancada |
| Como recebe credencial | **Não recebia.** Era o blocker |
| Como conhece o LiveKit | **Não conhece.** O helper fala o relay legado, não o SFU |
| Ao launcher fechar | `stopVoiceHelper()` em `before-quit`, `closed` e `kill-game` |
| Ao Skyrim fechar | idem, pelo `kill-game` |
| Em caso de crash do launcher | **Nada.** `detached:false` não mata o filho no Windows |

### 1.3 A conclusão que muda a estratégia da rodada

O `VoiceEndpoint` prevê três transportes (`SKYVOICE_LIVEKIT_AUDIT.md` §7.4). O
estado real deles:

| Endpoint | Publica | Assina | Cliente existe? |
|---|---|---|---|
| `legacy-relay` | helper nativo | `index.html` | **sim** |
| `cef-livekit` | — | — | não |
| `native-livekit` | — | — | não |

**Nenhum cliente LiveKit existe** — nem para publicar, nem para assinar. Todo o
gateway, a política de assinatura e o `verify:livekit` do commit `3ea1895` estão
do lado do servidor de uma ponte cuja outra margem não foi construída. Um teste
"A fala e B ouve pelo LiveKit" não é uma tarefa pendente desta rodada: é
estruturalmente impossível hoje, e nenhuma quantidade de teste de gateway muda
isso.

Por isso a rodada fechou o caminho que **tem** cliente, e mediu a cadeia inteira
por ele.

---

## 2. Bugs descobertos

### BUG-1 🔴 — O launcher subia um helper que recusava os próprios argumentos

**Sintoma.** Nenhum. É o que o torna caro.

**Evidência.** Os argumentos exatos que `helperArgs()` monta, contra o binário
compilado em 07/08/2026:

```
$ voice-helper.exe --control-host 127.0.0.1 --control-port 51234 --pair aabb… --log-level info --ptt
[helper] argumento desconhecido: --control-host
EXIT=2
```

**Causa.** O `voice-dist.mjs` foi escrito em `3623cce` já documentando, no
próprio cabeçalho, que *"o lado do helper é C++ e NÃO está implementado"*. O
`main.ts` foi ligado a ele em `3ea1895`. O `ParseArgs` do `main.cpp` conhecia
`--actor-id`, `--ticket`, `--host` e `--port`, e **rejeita argumento
desconhecido**.

**Efeito.** Toda execução do launcher iniciava um processo que morria com código
2 antes da primeira linha de log — e, por causa do BUG-2, o launcher escrevia no
config do jogo uma URL de controle que ninguém escutava. O primeiro `/voz` da
sessão não teria para onde mandar o ticket, e o jogador leria um HUD dizendo que
a voz está ligada.

**Correção.** `voice-helper/src/main.cpp` reescrito com dois modos (§3).

**Teste de regressão.** `voice-dist.test.mjs` — *"os argumentos são exatamente os
que o main.cpp aceita"*: a lista do `ParseArgs` está no teste, e qualquer lado
que mude sozinho quebra a suíte em vez de quebrar uma sessão com jogadores.

---

### BUG-2 🟠 — `started: true` para um processo já morto

**Causa.** `startVoiceHelper` devolvia sucesso logo depois do `spawn`. `spawn` só
falha se o executável não puder ser **criado**; um processo que sobe e morre em
seguida — argumento recusado (2), porta de controle ocupada por um órfão (1) —
passava como sucesso.

**Efeito.** O launcher gravava `helperRunning: true`, `helperControlUrl` e o
`pairingToken` no `skymp_config.json`. O diagnóstico chegaria três camadas
depois, como *"digitei /voz e não aconteceu nada"*.

**Correção.** `main.ts:680` — 400 ms de carência, e a saída precoce vira motivo
por extenso, com o código 2 nomeado como incompatibilidade de versão entre
launcher e helper.

---

### BUG-3 🔴 — A ferramenta de diagnóstico matava o servidor ao ser perguntada

**Sintoma.** `GET /state` no `e2e-harness.js` derrubava o processo inteiro — e
com ele o `voip-service` e todas as conexões vivas.

```
TypeError: Cannot read properties of undefined (reading 'entries')
    at e2e-harness.js:114   →   voip._audienceByActor.entries()
```

**Causa.** A audiência saiu do `voip-service` para o Voice Core em `5c057ba` (*"a
proximidade sai do voip-service e vira um núcleo que se mede"*). O harness
continuou lendo o `Map` privado antigo, que passou a ser `undefined`.

**Efeito.** A única ferramenta de bancada que responde **"quem ouve quem"** — a
pergunta central do §22 do roteiro — matava o servidor de voz ao ser perguntada.
E como uma exceção em handler de request derruba o Node, a queda não era do
endpoint: era da sessão inteira.

**Correção.** Passa a ler `voip.voiceCore.audienceFor(id)`, que **consulta a
política antes de responder** — então o `/state` mostra a audiência de agora
(PTT, mute, morte e mordaça incluídos), não a última calculada. O handler inteiro
foi embrulhado em `try/catch`: errar ao responder uma pergunta de diagnóstico não
pode custar a sessão que está sendo diagnosticada.

---

### BUG-4 🟠 — A guarda de órfão deixava um órfão

Encontrado ao **testar** a guarda que esta rodada acabara de escrever.

**Sintoma medido.** Matar o processo pai imprimia `[helper] Launcher encerrou;
soltando o microfone.` — e o helper continuava vivo três segundos depois.

**Causa.** A thread da guarda derruba `g_running` e acorda a fila de áudio, mas a
thread principal dormia em `cv_.wait` no canal de controle, esperando um
`notify` que nem o handler de sinal nem a guarda podiam dar com segurança.
O mesmo defeito valia para `Ctrl+C`.

**Correção.** `WaitForCredential` passou a usar `wait_for` de 200 ms em laço, que
reconfere `g_running` sem depender de quem o derrubou.

**Evidência depois da correção:**

```
helper vivo (esperado 1): 1
[mata o processo pai]
helper apos morte do launcher (esperado 0): 0
```

---

### BUG-5 🟡 — O harness não conseguia rotear voz nenhuma

**Sintoma.** Tudo conectava, `/state` dizia `connected`, o PTT respondia — e a
audiência era **sempre vazia**.

**Evidência.** A primeira vez que alguém apertou o PTT contra o harness:

```
[ptt] servidor respondeu: {"transmitting":false,"reason":"personagem não carregado"}
```

**Causa.** `voice-policy.js:244` recusa quem tem `characterId === null`, e o
`getActiveCharacterData` real lê a sessão do banco — que no harness é um stub que
devolve `[]`.

**Correção.** Personagem sintético no harness, com `characterId` derivado do
`actorId` (estável entre reconexões, que é o que permite testar staff mute e
estado de personagem sobrevivendo a um reconnect). O `mp.get` passou a devolver
`cellOrWorldDesc`, e `/move` aceita `&cell=` — sem isso o isolamento por célula
(§13) não tinha o que isolar.

---

## 3. O pareamento, agora que ele existe

```
launcher                        CEF (jogo)                     helper
   │                                │                             │
   │ 1. sorteia pairingToken (192 bits, por execução)             │
   │ 2. pede porta livre ao SO (bind 0)                           │
   │ 3. spawn --control-port --pair --ptt --parent-pid ──────────►│
   │ 4. grava helperControlUrl + token no skymp_config.json       │
   │                                │                    5. escuta 127.0.0.1
   │                                │                       (microfone AINDA FECHADO)
   │                          6. /voz                            │
   │                                │◄── voipTicket (do servidor) │
   │                          7. POST /ticket ──────────────────►│
   │                                │      {pair, actorId, ticket, host, port}
   │                                │                    8. abre o microfone
   │                                │                    9. auth role:sender ptt:true
```

Contra cada exigência do §8 do roteiro:

| Exigência | Como fica | Onde |
|---|---|---|
| Nenhum token permanente em `argv` | O `argv` leva porta, segredo desta execução e pid. O ticket entra pelo POST | `helperArgs` |
| Nenhum secret LiveKit na linha de comando | O helper não conhece o LiveKit | — |
| Nenhum secret em arquivo temporário | Não há arquivo no caminho | — |
| Pairing local | `bind 127.0.0.1` **e** checagem do IP de origem por conexão | `ControlChannel::Handle` |
| Pairing expira | `--pair-ttl`, padrão 12 h, contado do início do processo | `kDefaultPairTtlSeconds` |
| Uso único quando possível | O **ticket** é de uso único (servidor, 30 s). O pareamento aceita repetição de propósito: cada `/voz` após um reconnect emite ticket novo, e recusar o segundo quebraria o §18 | `WaitForCredential` |
| Só o helper legítimo completa | Comparação do segredo em **tempo constante**; teto de 10 tentativas | `SecretEquals` |
| Reiniciar o launcher invalida o antigo | Token novo por execução, e `stopVoiceHelper` antes de subir | `main.ts:681` |
| Helper antigo não assume sessão nova | A porta é única: um segundo helper não sobe, e sair com 1 é reportado | `ControlChannel::Start` |

**O microfone abre no passo 8, não no passo 5.** No modo pareado o helper sobe
junto com o jogo e pode ficar horas sem ninguém rodar `/voz`; manter o WASAPI
aberto esse tempo todo seria um microfone ligado sem sessão de voz — e fecha
junto com a sessão, no mesmo lugar.

`--ptt` deixou de ser um argumento sem efeito: o `auth` agora leva `ptt: true`, e
com isso o caminho do launcher **fecha a concessão de microfone aberto** que o
`voip-service` dava por compatibilidade com o helper da Fase 1 (dívida registrada
em `SKYVOICE_CORE_ETAPA_3.md` §11.2). O log do servidor mostra a diferença:

```
[voip] Actor 0xff001012 connected to VOIP as sender (PTT).
[voip] Actor 0xff001013 autenticou sem declarar 'ptt: true'. Microfone aberto por compatibilidade…
```

---

## 4. O que ainda falta no caminho legado: o mensageiro

O passo 7 do diagrama **não tem quem o execute**. O `skymp/ui/index.html` recebe
o ticket em `window.handleVoipTicket` e o usa para si mesmo (papel `listener`),
mas não o repassa ao helper. E o `helperControlUrl` que o launcher grava no
`skymp_config.json` é lido pelo **binário do client**, não pela página.

Fechar isso exige responder uma pergunta que não se responde por leitura de
código nosso: **o skymp5-client expõe o conteúdo do `skymp_config.json` à CEF?**
Se expõe, o mensageiro são ~15 linhas no `index.html`. Se não expõe, ele exige
build de client — e a decisão passa a ser a mesma do Plano A.

Enquanto isso não fecha, o pareamento é acionável à mão (é o que os testes desta
rodada fizeram) e pelo harness.

---

## 5. O LiveKit nesta rodada

O contrato do gateway foi **reexecutado contra um `livekit-server 1.13.5` real**
(binário oficial, SHA-256 conferido) para garantir que nada desta rodada
regrediu:

```
== 10/10 verificações passaram ==
  [PASSOU] EFEITO: quadros de áudio chegam ao ouvinte  — 300 quadros em 3 s
  [PASSOU] EFEITO: o áudio PAROU de atravessar          — 0 quadros em 3 s
  [PASSOU] o corpo ANTIGO recebe HTTP 200 do SFU        — status=200
  [PASSOU] ...e mesmo assim NAO assina nada             — TrackSubscribed=0
```

**Isso não é progresso de E2E, e não deve ser lido como tal.** É o servidor
conversando com o SFU usando um cliente de mídia Node no lugar do jogo. O §5 do
mapa continua valendo: nenhum cliente publica no SFU a partir de uma máquina de
jogador.

O caminho escolhido para a próxima rodada é o **Plano B** (`native-livekit`):
trocar o destino dos quadros do helper — que já captura áudio real e já tem o
enquadramento certo — do WebSocket do relay para o `client-sdk-cpp`. Não exige
fork do client nem tocar na CEF. O custo conhecido: o SDK arrasta toolchain Rust,
que **esta máquina não tem** (`cargo`/`rustc` ausentes em 2026-08-14).

---

## 6. Evidência

### 6.1 Automatizada

| Suíte | Antes | Depois |
|---|---|---|
| `gamemode` | 1270/1270 | **1270/1270** |
| `launcher` | 71/71 | **74/74** (3 novos) |
| `tsc --noEmit` (gamemode) | limpo | limpo |
| `tsc -b` (launcher) | limpo | limpo |
| build C++ (MSVC, `/W4`) | — | limpo |

### 6.2 Integração — LiveKit real

`verify:livekit` **10/10** contra `livekit-server 1.13.5` rodando localmente.

### 6.3 Integração — a cadeia real, com microfone de verdade

Sem mock: microfone WASAPI da máquina → `voice-helper.exe` pareado →
`voip-service` real → Voice Core → ouvinte.

```
### 1. POST /ticket no canal de controle (o que a CEF faria)
{"ok":true}
[helper] Pareado: ator 0xff001012, voip 127.0.0.1:7778.
[helper] Autenticado (PTT). Capturando.
[helper] 500 quadros enviados (0 descartados na fila).

[probe] <- 0xff001012: 400 quadros, 768000 bytes, volumes 0.9166666666666666
[probe] proximity_update: [{"actorId":4278194194,"volume":0.9166…,
                            "effect":"none","dir":[-1,0,0],"speaking":true}]
```

400 quadros entregues = 8 segundos de áudio real atravessando o servidor,
roteados pela política, com direção e volume calculados.

### 6.4 Política medida por EFEITO

Mesma cadeia, mexendo no mundo e olhando a audiência (nunca o código HTTP):

| Passo | Esperado | Medido |
|---|---|---|
| PTT solto | sem audiência | `VAZIA` |
| PTT apertado, 100 u, mesma célula | audiência com volume alto | `volume 0.9166` |
| B a 1100 u (dentro de 1200) | volume baixo | `volume 0.0833` |
| B a 2000 u (fora) | sem audiência | `VAZIA` |
| B a 100 u, **outra célula** | sem audiência | `VAZIA` |
| B de volta à mesma célula | audiência volta | `volume 0.9166` |

O isolamento por célula é o caso que mais importa aqui: **coordenadas próximas,
células diferentes, silêncio.**

### 6.5 Canal de controle

| Requisição | Esperado | Medido |
|---|---|---|
| `POST /ticket` com `pair` errado | recusa | `403` + tentativa contada |
| `POST /outra` | rota inexistente | `404` |
| `GET /ticket` | método errado | `405` |
| `POST /ticket` correto | aceita | `200 {"ok":true}` |

### 6.6 Ciclo de vida

| Cenário | Esperado | Medido |
|---|---|---|
| Launcher morre (kill à força) | helper sai e solta o microfone | **sai em < 3 s** |
| Segundo helper na mesma porta | não sobe, reporta | sai com 1 |
| Fim de sessão de voz | dispositivo fechado | `ma_device_uninit` no fim de `RunSession` |

### 6.7 Evidência humana

**Nenhuma.** Ninguém ouviu nada. Este é o blocker #1 e continua aberto.

---

## 7. Matriz final

Coluna não executada não recebe marca. `PASS` só onde houve medição.

| Teste | Automatizado | LiveKit real | Skyrim real | Humano | Resultado |
|---|---|---|---|---|---|
| Microfone (captura WASAPI) | PASS | — | — | — | 500 quadros, 0 descartes |
| Pareamento (canal de controle) | PASS | — | — | — | 200/403/404/405 medidos |
| Publicação (relay legado) | PASS | — | — | — | 400 quadros entregues |
| Publicação (LiveKit) | — | — | — | — | **sem cliente** |
| Subscription (gateway ↔ SFU) | PASS | PASS | — | — | 10/10, por efeito |
| Subscription (jogador ↔ SFU) | — | — | — | — | **sem cliente** |
| Voz A→B | PASS | — | — | — | só transporte; ninguém ouviu |
| Voz B→A | — | — | — | — | não executado |
| Whisper | PASS¹ | — | — | — | só teste de unidade |
| Normal | PASS | — | — | — | alcance 1200 medido na cadeia |
| Shout | PASS¹ | — | — | — | só teste de unidade |
| Distância | PASS | — | — | — | 0.9166 → 0.0833 → vazio |
| Cell isolation | PASS | — | — | — | mesma coordenada, sem rota |
| PTT | PASS | — | — | — | solto = sem audiência |
| Spatial L/R | PASS¹ | — | — | — | `dir` chega ao ouvinte; percepção não |
| Spatial frente/trás | PASS¹ | — | — | — | idem |
| DOWNED | PASS¹ | — | — | — | só teste de unidade |
| DEAD | PASS¹ | — | — | — | só teste de unidade |
| Gagged | PASS¹ | — | — | — | só teste de unidade |
| Staff mute | PASS¹ | — | — | — | só teste de unidade + migration v16 |
| Reconnect | PASS² | — | — | — | o helper aceita novo pareamento |
| LiveKit restart | — | — | — | — | não executado |
| Helper crash | PASS | — | — | — | guarda de órfão medida |

¹ Verificado por teste automatizado apenas — **não** exercitado na cadeia real.
² Exercitado no laço do helper; não com um jogador reconectando.

---

## 8. Camadas — onde cada coisa está

| Camada | Estado |
|---|---|
| L0 Microfone / WASAPI | ✅ medido (500 quadros, 0 descartes) |
| L1 voice-helper | ✅ medido |
| L2 pairing | ✅ **implementado nesta rodada** e medido |
| L3 launcher | ⚠️ lógica corrigida e testada; **o Electron real nunca foi executado** |
| L4 token/auth | ✅ relay medido; LiveKit medido no gateway |
| L5 publicação LiveKit | ❌ **sem cliente** |
| L6 Voice Core | ✅ medido por efeito na cadeia real |
| L7 subscription | ✅ gateway↔SFU; ❌ jogador↔SFU |
| L8 LiveKit SFU | ✅ 1.13.5 real, 10/10 |
| L9 cliente Skyrim / CEF | ❌ não executado; falta o mensageiro (§4) |
| L10 AudioContext | ❌ não executado |
| L11 saída física de áudio | ❌ **ninguém ouviu** |

---

## 9. O que fazer na próxima rodada, em ordem

1. **Responder se a CEF enxerga o `skymp_config.json`.** É a pergunta mais barata
   com a maior consequência: ela decide se o mensageiro do §4 são 15 linhas de
   `index.html` ou um build de client.
2. **Executar o launcher Electron de verdade** (§9 do roteiro). A lógica está
   testada; o processo nunca rodou. `npm run dev` em `apps/launcher`.
3. **Dois clientes Skyrim reais**, ainda pelo relay legado. É o único caminho com
   cliente dos dois lados, e é o que produz a primeira evidência humana.
4. **Só então o Plano B**: `client-sdk-cpp` no helper, com o toolchain Rust
   instalado.

O caminho legado **não foi removido nem alterado em comportamento** — continua
sendo a comparação, o fallback de bancada e o instrumento de diagnóstico, como
manda o §20 do roteiro.
