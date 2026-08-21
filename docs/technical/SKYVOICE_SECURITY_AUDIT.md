# SkyVoice — auditoria de segurança

**Data:** 2026-08-14
**Branch:** `feat/skyvoice-core-etapa-2`
**Escopo:** auditoria completa da superfície de segurança da voz, e as correções
que ela produziu. Etapa 4.

## Como ler as marcas

| Marca | Significa |
|---|---|
| **VERIFICADO** | Executado nesta máquina, com teste ou número. |
| **INFERIDO** | Deduzido de leitura de código, sem execução. |
| **NÃO TESTADO** | Não exercitado. |

> **Ninguém ouviu a voz deste projeto ainda.** Nada nesta auditoria muda isso.
> Ela trata de quem *poderia* ouvir o quê se a voz funcionasse — que é uma
> pergunta diferente e igualmente necessária.

> **Não existe rádio por voz neste projeto.** Há teste automatizado que reprova
> se `VoiceRadioService`, `radioChannel`, `radioFrequency`, `frequência` ou
> `voiceChannel` aparecerem em qualquer arquivo de voz
> (`voice-privacy.test.js`).

---

## 1. Achados

Ordenados por gravidade.

**Estado em 2026-08-14, depois da rodada contra um SFU real:** SV-01 a SV-05 e
SV-07 corrigidos; SV-06 parcialmente mitigado (depende do lado C++); SV-08
mitigado com limite declarado.

O SV-05 foi **reclassificado de 🟡 para 🔴** quando deixou de ser leitura de
código e virou medição — a correção mais importante desta rodada, e a que só um
servidor real produziria.

### 🔴 SV-01 — O gateway do LiveKit nunca falou com o SFU. **CORRIGIDO**

**O defeito.** `livekit-gateway._call()` recusa toda chamada quando não recebe um
emissor de token de operador:

```js
if (typeof mintAdminToken !== 'function') {
  return { ok: false, skipped: true, reason: 'sem emissor de token de operador' };
}
```

**Nenhum caminho de produção passava um.** `voice-core.js` construía o gateway com
`createVoiceLiveKitGateway({ metrics, logger, now })` — sem `mintAdminToken`. Só
os testes passavam um lambda. Verificado por busca: as únicas ocorrências do
símbolo, antes desta etapa, estavam no próprio gateway e no teste dele.

**Por que passou despercebido.** O retorno é `skipped: true`, não uma falha. Não
conta para o circuito, não incrementa `gateway.failure`, não vira log. O
`describe()` do gateway reportava `DISABLED`, que é indistinguível de "LiveKit
não configurado" — que era verdade, então ninguém olhou duas vezes.

**Consequência.** `UpdateSubscriptions`, `RemoveParticipant` e
`MutePublishedTrack` **nunca saíam do processo**. A assinatura seletiva — a razão
técnica de existir um SFU — não aconteceria. O jogo continuaria correto (o ganho
vem do `proximity_update`), e a conta de banda seria a de entregar todas as
faixas a todo mundo.

**Correção.** `livekit-token.mintAdminToken()`, novo, e a fiação em
`voice-core.js`. O token de operador é deliberadamente diferente do de jogador:

| | Jogador | Operador |
|---|---|---|
| `roomJoin` | `true` | **`false`** — não entra na sala |
| `roomAdmin` | `false` | **`true`** |
| `canPublish`/`canSubscribe` | conforme papel | **`false`** |
| TTL | 360 s | **60 s** |
| Quem recebe | o cliente | **ninguém** — fica num header |

**VERIFICADO** por 8 testes em `voice-auth-hardening.test.js`, incluindo um que
monta o Voice Core como produção o monta e confirma que a chamada chega ao
transporte com um JWT de `roomAdmin`.

---

### 🔴 SV-02 — Todo token de jogador saía com `canPublish: true`. **CORRIGIDO**

**O defeito.** `voice-session.open()` chamava `mintAccessToken` sem passar
`canPublish`, e o padrão é `true`. Um jogador silenciado pela staff recebia um
token que **autoriza publicar no SFU**.

**Por que isso importa mesmo com a rota cortando.** O silêncio dependia
inteiramente da camada de assinatura (`UpdateSubscriptions`). Essa camada é
justamente a que o `livekit-gateway` **desliga de propósito** quando o SFU falha
— o circuito abre para não derrubar o jogo. Com o circuito aberto, um jogador
silenciado voltaria a ser ouvido por todo mundo na sala, e nada no servidor
reclamaria.

Somado ao SV-01, o quadro real era: a camada de assinatura nunca funcionou, e a
única defesa contra a voz de um punido era um `if` no motor de rotas do próprio
processo.

**Correção.**

1. `voice-session.open()` aceita e propaga `canPublish`/`canSubscribe`, e os
   guarda na sessão (para o diagnóstico responder sem decodificar JWT).
2. `voice-core.publishGrantFor()` deriva a permissão **durável** do registro de
   silêncio de staff.
3. `voice-staff-mute.onChange()` — novo observador. O Voice Core assina e
   reemite o token de quem já está conectado, então `/calar` vale **agora** e não
   só na próxima conexão.
4. `voice-session.renew()` preserva a permissão: reconectar deixa de ser a forma
   trivial de desfazer a punição.

**O que deliberadamente NÃO entra no token:** morte, mordaça, abatimento e PTT.
São estados que mudam em segundos; reemitir token a cada um seria um handshake
WebRTC por morte. Eles continuam sendo rota, que é o mecanismo desenhado para
mudar rápido.

**VERIFICADO** por 7 testes de sessão + 3 de diagnóstico.

---

### 🟠 SV-03 — Nenhum guarda impedia um ambiente indefensável de subir. **CORRIGIDO**

As decisões de segurança dos módulos estavam certas. Nada disso protege contra a
classe de erro que de fato acontece em produção, que é **a configuração**:

- subir com `VOIP_DEBUG_EXPOSE_TICKET=true` esquecido de uma bancada — o arquivo
  `.voip-debug-ticket.json` guarda, em texto puro, uma credencial que autentica
  como aquele jogador;
- apontar `LIVEKIT_URL` para `ws://` em vez de `wss://`, e mandar o access token
  legível pela internet;
- trocar `VOIP_BIND_HOST` para `0.0.0.0` e expor um WebSocket de voz sem TLS.

**Correção.** `core/voice/voice-security.js` — `audit(env)` puro, chamado por
`enforceAtBoot()` no `initialize` do módulo de voz. Nove regras, com três
severidades.

O nível depende de `NODE_ENV`, e essa é a razão de haver três e não dois:
`ws://127.0.0.1` numa bancada é o certo, e em produção é o access token de todo
jogador em texto puro. A mesma linha é `note` num ambiente e `fatal` no outro.

| ID | O quê | Bancada | Produção |
|---|---|---|---|
| SEC-001 | `VOIP_DEBUG_EXPOSE_TICKET=true` | warn | **fatal** |
| SEC-002 | `VOICE_BACKEND=livekit` sem URL | fatal | fatal |
| SEC-003 | LiveKit em `ws://` | note (loopback) / warn | **fatal** |
| SEC-004 | Credencial do LiveKit incompleta | fatal | fatal |
| SEC-005 | `LIVEKIT_API_SECRET` < 32 chars | warn | **fatal** |
| SEC-006 | WS de voz em `0.0.0.0` sem TLS | warn | **fatal** |
| SEC-007 | Sem allowlist de origem | note | note |
| SEC-008 | `ALLOW_LOCAL_AUTOWHITELIST` | — | **fatal** |
| SEC-009 | Qualquer variável de vídeo no sistema de voz | fatal | fatal |

**Achado FATAL derruba o processo no boot.** Isso não contradiz "voz falhando
nunca derruba o jogo": aquela regra é de **runtime**. Um SFU fora do ar não pode
tirar o servidor do ar; um ambiente que vaza credencial não deve chegar a ter
runtime. Subir com o aviso no log seria subir, e ninguém lê o log de boot de um
servidor que subiu.

**VERIFICADO** por 17 testes.

---

### 🟠 SV-04 — Nada verificava que segredo não vaza para o cliente. **CORRIGIDO**

`assertNoSecretsIn(payload)` varre por **valor**, não por nome — é o valor que
vaza. Um `JSON.stringify` de um objeto que por descuido carregue `apiSecret`
produz a string do segredo, não a palavra `LIVEKIT_API_SECRET`.

Aplicado em `voip-service.requestVoiceConnection`, no ponto exato onde o payload
sai para a CEF. Não protege contra o payload de hoje — ele é curto e obviamente
limpo. Protege contra a versão dele daqui a seis meses, quando alguém espalhar um
objeto de configuração ali dentro.

Piso de 8 caracteres para o valor procurado: sem ele, um segredo mal configurado
como `"1"` acusaria toda mensagem que contenha o dígito 1, e um detector com
alarme falso constante é um detector desligado.

**VERIFICADO** por 5 testes.

---

### 🔴 SV-05 — `UpdateSubscriptions` recebia 200 e não assinava nada. **CORRIGIDO**

**Reclassificado de 🟡 para 🔴 quando foi medido.** A suspeita da revisão
anterior estava certa; a gravidade estava subestimada, e o motivo é o que este
achado tem de mais útil.

O corpo antigo era:

```js
participant_tracks: bucket.subscribe.map((identity) => ({ participant_sid: identity }))
```

Contra um `livekit-server` 1.13.5 real ele responde **`HTTP 200`, corpo `{}` — e
não assina nada.** Não é um erro que aparece: o circuito do gateway conta
sucesso, a métrica conta `gateway.ok`, o painel de diagnóstico mostra
`CONNECTED`. **Todos os indicadores ficariam verdes com a assinatura seletiva
desligada**, e o LiveKit entregaria todas as faixas a todo mundo. O sintoma não
seria "a voz quebrou"; seria a conta de banda do SFU, meses depois.

Era 🟡 sob a hipótese de que um corpo errado viraria erro. Ele não vira.

#### Como foi medido

A sonda testou **cinco** corpos e mediu **efeito** — o ouvinte passou a receber a
faixa? — e não código HTTP. **Os cinco devolveram `HTTP 200`:**

| corpo | efeito |
|---|---|
| `participant_tracks:[{participant_sid: <identity>}]` — o antigo | **nenhum** |
| `participant_tracks:[{participant_sid: <SID>, track_sids:[…]}]` | assina |
| `track_sids:[…]` no topo | assina |
| idem, em camelCase | assina |
| `participant_sid` **errado** + `track_sids` | **assina** |

A última linha isola a causa: **quem decide é `track_sids`.** Com ele preenchido,
o `participant_sid` nem é consultado — o que explica por que o corpo antigo,
que não o preenchia, não fazia nada.

#### A correção

`track_sids` no topo, a forma mais curta das que funcionam. O preço é que o
gamemode precisa saber o track SID, que é atribuído pelo SFU: o gateway ganhou um
registro `identity → [trackSid]` alimentado por `ListParticipants` e recarregado
**só quando aparece uma identidade desconhecida** — quando alguém entra na cena,
não a cada tick.

#### Um segundo achado, do mesmo tamanho

`UpdateSubscriptions(subscribe:false)` **desassina de verdade**, mas o
`@livekit/rtc-node` **não emite `TrackUnsubscribed`** quando quem desassina é o
servidor. Medido pelos quadros, que é o que paga a conta de banda:

```
   assinado    : 300 quadros em 3 s
   desassinado :   0 quadros em 3 s
```

Um teste escrito em cima do evento concluiria que o desassinar está quebrado e
trocaria um sistema correto por um errado. Fica registrado como o tipo de
evidência que este projeto não aceita — pelo mesmo motivo do controle de câmera
da Etapa 1.

#### Prova

`npm run verify:livekit` — **10/10** contra `livekit-server 1.13.5`
(SHA-256 `3ec7eaa7…a8906`, conferido contra o `checksums.txt` da release). Roda
fora do `npm test` de propósito: exigir um SFU tornaria a suíte impossível numa
máquina limpa.

O script inclui um caso de **regressão** que manda o corpo antigo e exige que ele
continue não assinando. Sem ele, alguém "simplificando" o gateway de volta para
`participant_tracks` passaria em toda a suíte com `fetch` falso.

**VERIFICADO.**

> ⚠️ **Limite que continua valendo.** Assinatura seletiva só decide alguma coisa
> se o cliente conectar com `autoSubscribe: false`. Com o padrão (`true`), o SFU
> entrega tudo na entrada e estas chamadas ficam correndo atrás do próprio
> servidor. **Nenhum cliente deste projeto fala LiveKit ainda** — a UI é só o
> caminho legado. Quando falar, isto é requisito de conexão, não detalhe.

---

### 🟡 SV-06 — Microfone aberto para clientes que não declaram PTT. **PARCIALMENTE MITIGADO**

Dívida herdada da Etapa 2. Um cliente que autentica sem `ptt: true` recebe
concessão permanente de transmissão, para não silenciar o `voice-helper.exe`
legado — o único caminho de captura provado do projeto.

**Mitigação desta etapa:** `voice-dist.helperArgs()` inclui `--ptt` sempre. Todo
helper que vier pelo launcher declara PTT, e a concessão deixa de alcançá-lo.

**O que continua aberto:** o lado C++ precisa entender `--ptt` e falar
`ptt_down`/`ptt_up`. Não implementado, não compilado, **NÃO TESTADO**. Quem rodar
o helper à mão, fora do launcher, continua com microfone aberto.

---

### 🟡 SV-07 — Silêncio de staff não persistia. **CORRIGIDO**

Herdado da Etapa 3. O registro vivia na memória do processo, e reiniciar devolvia
a voz de todo mundo. Desde que a punição passou a mexer no token (SV-02), o
efeito era pior: um restart não só devolvia a voz como **reemitia tokens com
`canPublish: true`**. Na prática, a forma mais barata de escapar de uma punição
era esperar o próximo restart do servidor.

**`migration-v16-voice-staff-mute.sql`** — uma linha por personagem, com
`muted_until` em epoch ms.

A decisão sobre expiração que estava em aberto: **conferida na leitura**, no SQL
e em JS. Nunca por evento agendado — um job que expira punições precisa rodar, e
um job que não rodou deixa alguém calado além da conta sem que ninguém perceba.
Lendo, a punição expira sozinha mesmo com o servidor desligado no meio.

**O banco nunca entra no caminho crítico.** A ordem é sempre: aplicar em memória
→ notificar → gravar, sem `await`. Um MySQL lento atrasa a durabilidade da
punição; não abre uma janela em que a staff manda calar e nada acontece. Banco
fora do ar deixa a punição valendo nesta execução, com aviso no log — e não
lança, porque uma exceção subindo de dentro de um comando de staff é o servidor
de jogo caindo por causa do MySQL.

Não há histórico nesta tabela: uma linha por personagem, substituída. O histórico
de quem calou quem vive no `moderation_log`, que é onde ele é imutável. Duas
versões da mesma verdade divergem.

**VERIFICADO** — 9 casos novos em `voice-staff-mute.test.js`, incluindo o
restart, o banco fora do ar, o `hydrate` que falha sem derrubar o boot, e o
`unmute` que alcança o banco com a memória já limpa.

---

### 🟢 SV-08 — Sem allowlist de origem no WebSocket. **MITIGADO, com limite declarado**

`checkOrigin()` + `verifyClient` no `WebSocketServer`, configurável por
`VOICE_ALLOWED_ORIGINS`. Vazio = aceita tudo (o padrão de hoje).

**`Origin` ausente é ACEITA, e isso é decisão.** O `voice-helper.exe` não é um
navegador e não manda o header. Recusar fecharia o único caminho de captura
provado — e não protegeria de nada, porque quem escolhe o header escolhe omiti-lo.

O que a allowlist barra de verdade é o navegador: uma página carregada na CEF
**carrega `Origin` obrigatoriamente**, e a página não consegue removê-lo. A
defesa é eficaz exatamente contra quem ela consegue identificar, e não finge
proteger contra o resto. A defesa real contra cliente arbitrário continua sendo o
ticket de uso único de 30 s.

---

## 2. A matriz completa

Os quinze itens pedidos.

| # | Superfície | Estado | Como se sabe |
|---|---|---|---|
| 1 | **LiveKit tokens** | ✅ | HS256, secret nunca sai do processo. Aceito por servidor real no spike da Etapa 1. **VERIFICADO** |
| 2 | **TTL** | ✅ | 360 s jogador, 60 s operador. Travado por teste. **VERIFICADO** |
| 3 | **Participant identity** | ✅ | `actor-<id>-<nonce>`, derivada no servidor. `open()` ignora identidade vinda no `opts`. **VERIFICADO** |
| 4 | **Actor binding** | ✅ | `byIdentity` só contém o que este serviço emitiu. Formato bater não basta. **VERIFICADO** |
| 5 | **Character binding** | ✅ | `characterId` vem de `getActiveCharacterData`; não há caminho de cliente. **VERIFICADO** |
| 6 | **Room permissions** | ✅ | `roomJoin`+`room` prendem a uma sala; `roomAdmin`/`roomCreate`/`roomList` negados explicitamente. **VERIFICADO** |
| 7 | **Publish permissions** | ✅ | `canPublishSources: ['microphone']`; `canPublish` derivado de staff mute (SV-02). **VERIFICADO** |
| 8 | **Subscribe permissions** | ✅ | `canSubscribe` no token ✅; o controle por assinatura foi medido contra SFU real — assina, desassina, e o corpo antigo (que não fazia nada) tem teste de regressão (SV-05). **VERIFICADO** |
| 9 | **Spoofing** | ✅ | Identidade bem formada que não emitimos não resolve. **VERIFICADO** |
| 10 | **Replay** | 🟡 | Ticket legado é de uso único. Token LiveKit tem `jti` e TTL curto, mas o LiveKit **não** guarda `jti` — um token capturado vale até expirar. Mitigado pela identidade única (o replay derrubaria a sessão original, o que é detectável). **INFERIDO** |
| 11 | **Unauthorized participants** | ✅ | `confirmConnected` recusa identidade desconhecida; `RemoveParticipant` existe e agora funciona (SV-01). **VERIFICADO** |
| 12 | **Microphone permission** | 🟡 | Nenhuma flag insegura de CEF no código (teste automatizado). O `CefPermissionHandler` continua **PLANEJADO**, não compilado. **NÃO TESTADO** |
| 13 | **CEF origin restriction** | 🟢 | `VOICE_ALLOWED_ORIGINS`, com o limite do SV-08. **VERIFICADO** (a lógica) |
| 14 | **Secrets** | ✅ | Guarda de vazamento por valor + auditoria de força no boot. **VERIFICADO** |
| 15 | **Environment variables** | ✅ | Nove regras, três severidades, fatal derruba o boot. **VERIFICADO** |
| 16 | **TLS** | 🟡 | Auditado e exigido em produção pelo boot. **Nenhum TLS foi executado** — nada saiu de `127.0.0.1`. **NÃO TESTADO** |

---

## 3. `LIVEKIT_API_SECRET` no cliente: as camadas que o impedem

A regra é absoluta e tem quatro camadas independentes:

1. **Arquitetural.** O secret entra por `process.env` no gamemode e só é lido por
   `crypto.createHmac`. O que viaja é o JWT, que é o *resultado* da assinatura.
2. **Estrutural.** `voiceConfigForClient()` (launcher) tem teste que reprova se
   `LIVEKIT` ou `secret` aparecerem no objeto que vai ao cliente.
3. **Em runtime.** `assertNoSecretsIn()` varre o payload por valor antes de
   `mp.set(actorId, 'voipTicket', …)`.
4. **No boot.** `VOICE-SEC-005` reprova um secret fraco o bastante para ser
   quebrado offline a partir de um token capturado.

**VERIFICADO** por teste nas camadas 2, 3 e 4.

---

## 4. Privacidade

Executável, não declarativa. `voice-privacy.test.js` lê o código de voz de
verdade — os 17 módulos de `core/voice/`, o `voip-service.js` e o `index.html` —
tira os comentários e reprova se aparecer:

| Padrão | Por quê |
|---|---|
| `MediaRecorder`, `createMediaStreamDestination` | as duas formas de virar bytes guardáveis |
| `getDisplayMedia` | captura de tela |
| `video: true`, `camera` em `canPublishSources` | o mesmo erro visto de dois lados |
| `enable-media-stream`, `auto-accept-camera-and-microphone-capture`, `use-fake-ui-for-media-stream`, `use-fake-device-for-media-stream`, `disable-web-security` | as flags dos forks (§5.5 da auditoria da Etapa 1) |
| `writeFileSync`/`createWriteStream` perto de `audio`/`pcm`/`frame` | gravação de quadro em disco |
| `VoiceRadioService`, `radioChannel`, `frequência`, `voiceChannel` | rádio |

**Os comentários são removidos antes da varredura, de propósito.** Eles
*precisam* citar o que é proibido — é onde está registrado por que
`use-fake-device-for-media-stream` foi recusado. Uma varredura que não separasse
comentário de código transformaria a documentação da decisão na prova de que ela
foi violada.

`frequency` sozinho **não** entra na lista: é o `AudioParam` do
`BiquadFilterNode` que a passa-baixa da mordaça usa. Proibi-lo reprovaria o
áudio espacial legítimo e ensinaria a próxima pessoa a apagar o teste em vez de
ler o motivo.

No lado da infraestrutura, o `deploy/livekit/livekit.yaml` **não instala o
Egress** — o componente separado que o LiveKit exige para gravar. Sem ele, nenhum
token e nenhuma configuração conseguem iniciar gravação. `roomRecord: false` no
token é a segunda camada.

| Exigência | Estado |
|---|---|
| não gravar voz | ✅ **VERIFICADO** por varredura + ausência de Egress |
| não persistir frames | ✅ **VERIFICADO** |
| não armazenar conteúdo em log | ✅ código de erro de cliente é higienizado e truncado em 48 chars |
| mostrar mic ativo | ✅ chip `MIC · <modo>` no HUD (Etapa 3 §8.2) |
| PTT padrão | ✅ `transmitting: false` inicial + `--ptt` no launcher |
| câmera proibida | ✅ duas camadas: `canPublishSources` e ausência de flag |
| microphone permission restrita | 🟡 desenho pronto, `CefPermissionHandler` não compilado |
| opção de mute | ✅ `voice-state.setMuted`, por ATOR |
| output volume | ✅ preferência local, `sanitizeVoicePreferences` |
| input device | 🟡 só pelo helper (WASAPI). Ver §5 |

---

## 5. O que a CEF 108 **não** permite, e o que isso custa

A versão da CEF do SkyMP é a **108** (`SKYVOICE_LIVEKIT_AUDIT.md` §5.1). Isso
decide o que é implementável no cliente, e três das configurações de áudio
pedidas esbarram nela:

| Pedido | Viável na CEF 108? | Onde fica |
|---|---|---|
| lista de microfones | **não** de forma útil — `enumerateDevices()` só devolve rótulos depois de uma permissão de mídia concedida, e ela é negada (§5.3) | **helper**, por WASAPI |
| microfone selecionado | **não** pelo mesmo motivo | **helper**, `inputDeviceId` |
| **output device** | **NÃO** — `setSinkId` chegou no **Chromium 110** | impossível; sai pelo dispositivo padrão do SO |
| output volume | **sim** — `GainNode` | UI + preferência local |
| input gain | **não** na UI (não há captura na CEF) | **helper** |
| mic test | **não** na UI | **helper** |

`setSinkId` é o item que não tem contorno: escolher a saída de áudio dentro da
CEF 108 não é possível, e qualquer implementação que pareça funcionar estará
mudando o volume, não o dispositivo. Registrado aqui para que ninguém o
reimplemente achando que é esquecimento.

Por isso `sanitizeVoicePreferences()` guarda `inputDeviceId`, `outputVolume` e
`inputGain` **localmente no launcher**: são preferências de máquina, o helper as
consome, e nenhuma delas vai para o servidor.

---

## 6. Testes desta auditoria

| Arquivo | Casos | O que trava |
|---|---|---|
| `voice-security.test.js` | 17 | as nove regras de ambiente, as três severidades, o vazamento por valor, a allowlist |
| `voice-auth-hardening.test.js` | 23 | token de operador, `canPublish`, spoofing, replay, identidade |
| `voice-privacy.test.js` | 7 | gravação, vídeo, flags de CEF, rádio, PTT padrão |
| `voice-failure.test.js` | 15 | nove modos de falha, e nenhum derruba o jogo |
| `voice-diagnostics.test.js` | 20 | os treze campos, as ações, e o que o painel **não** expõe |
| `voice-telemetry.test.js` | 17 | as dez métricas, e nenhuma carrega identificador de pessoa |
| `voice-dist.test.mjs` (launcher) | 34 | manifesto, hash, rollback, argumentos sem ticket, preferências |
| `livekit-gateway.test.js` | 24 | circuito, agrupamento, e **o corpo do SV-05** (8 casos novos) |
| `voice-staff-mute.test.js` | 19 | expiração, e **a persistência do SV-07** (9 casos novos) |
| `verify-livekit-contract.mjs` | 10 | **contra um SFU real**; fora do `npm test` |

**Suíte do gamemode: 1270 testes, 1270 passam, 0 falham.** `npm run typecheck`
limpo. Launcher: 71/71, `tsc -b` limpo. **VERIFICADO.**

**Dois testes existentes foram alterados**, e é honesto dizer por quê: ambos em
`livekit-gateway.test.js`, e ambos travavam um comportamento que a medição contra
o SFU real provou errado — o corpo `participant_tracks` e a forma como uma falha
de rede se apresenta agora que há uma recarga de registro antes das assinaturas.
Nenhum foi alterado para "passar": o antigo agora é caso de regressão em
`verify-livekit-contract.mjs`.

---

## 7. O que continua sem prova

Sem exceção.

1. **Qualquer coisa fora de `127.0.0.1`.** TLS, TURN, CGNAT, latência, perda.
   O SFU desta rodada rodou em loopback.
2. **`CefPermissionHandler` compilado.** É desenho, não binário.
3. **`getUserMedia` dentro da CEF do SkyMP.**
4. **O lado C++ do `--pair`/`--control-port`.** O launcher gera, passa e desliga;
   o helper não sabe ler.
5. **A composição do `deploy/livekit/`.** Nenhum `docker compose up` foi
   executado contra ela — o Docker Desktop desta máquina não sobe. O que foi
   exercitado é o **binário** `livekit-server 1.13.5`, incluindo o mesmo
   endpoint de health check que o compose usa (`GET /` → `200 OK`).
6. **Um cliente do jogo falando LiveKit.** A UI é só o caminho legado; a
   assinatura seletiva foi provada com dois clientes `@livekit/rtc-node`, não com
   a CEF.
7. **A fiação de voz do launcher em execução.** `main.ts` exige Electron: o que
   há é typecheck limpo e a lógica pura coberta por 34 casos.

---

## Fontes

**Internas:** [`SKYVOICE_LIVEKIT_AUDIT.md`](SKYVOICE_LIVEKIT_AUDIT.md) ·
[`SKYVOICE_CORE_ETAPA_2.md`](SKYVOICE_CORE_ETAPA_2.md) ·
[`SKYVOICE_CORE_ETAPA_3.md`](SKYVOICE_CORE_ETAPA_3.md) ·
[`SKYVOICE_DEPLOYMENT.md`](SKYVOICE_DEPLOYMENT.md) ·
[`ADR_005_ADMIN_RBAC.md`](ADR_005_ADMIN_RBAC.md)

**Código:** `skymp/gamemode/core/voice/` · `apps/launcher/electron/voice-dist.mjs`
· `deploy/livekit/`
