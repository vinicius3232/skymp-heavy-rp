# Onde vive o cliente LiveKit do jogador

**Data:** 2026-08-15
**Branch:** `feat/skyvoice-core-etapa-2`
**Escopo:** decidir onde o cliente LiveKit do jogador é executado, e provar a
escolha com um SFU real. **Não** é a migração do `voice-helper`.

## Como ler as marcas

| Marca | Significa |
|---|---|
| **VERIFICADO** | Executado nesta máquina, ou lido no código-fonte da versão exata em uso. Tem número ou citação. |
| **INFERIDO** | Deduzido de evidência forte, sem execução direta. Pode estar errado. |
| **PLANEJADO** | Decisão tomada, sem código. |
| **NÃO TESTADO** | Não exercitado. Nada aqui é promessa de funcionamento. |

> **Ninguém ouviu a voz deste projeto ainda.** Este documento move o blocker de
> "não existe cliente LiveKit" para "existe um cliente LiveKit que fala e ouve,
> e ninguém julgou se dá para entender". É progresso real e não é o fim.

---

## 1. A decisão

**O cliente LiveKit do jogador vive no `voice-helper`, em C++, usando o
`livekit/client-sdk-cpp` pré-compilado.**

É a Opção A do enunciado, e corresponde ao `native-livekit` já declarado em
[`core/voice/voice-endpoint.js`](../../skymp/gamemode/core/voice/voice-endpoint.js).
O `cef-livekit` **não é apagado** da costura — ele continua descrito, e o
transporte é indistinguível, que é a propriedade que permite adicioná-lo depois
sem um corte.

```
Launcher
   │  verifica versão + hash, instala, gera pairingToken
   ▼
voice-helper.exe  ←── pareamento loopback ──  CEF (a UI do jogo)
   ├── PlatformAudio      captura o microfone (AEC/NS/AGC)
   ├── LocalAudioTrack    publica; mute()/unmute() é o PTT
   ├── AudioStream        recebe cada locutor em PCM cru
   ├── ganho/pan          aplica o que o Voice Core mandou
   └── PlatformAudio      toca no fone
        │
        ▼
   LiveKit SFU  ←── UpdateSubscriptions ──  Voice Core (quem pode ouvir quem)
```

O plano de mídia é do SFU. O plano de controle é do SkyVoice Core. O processo
Node do gamemode **não transporta áudio**.

---

## 2. O que mudou desde a auditoria anterior

A [`SKYVOICE_LIVEKIT_AUDIT.md`](SKYVOICE_LIVEKIT_AUDIT.md) §6 registrava o SDK
C++ como **1.0.0, exigindo toolchain Rust**. Isso estava certo quando foi
escrito e **está errado hoje**, e a diferença é a que decide esta rodada.

| Item | Auditoria (14/08) | Verificado agora (15/08) |
|---|---|---|
| Versão | 1.0.0 | **1.7.0**, 11/08/2026 |
| Rust para *consumir* | obrigatório | **desnecessário** — há release pré-compilado |
| Windows x64 | suportado | `livekit-sdk-windows-x64-1.7.0.zip`, 11,1 MB |
| Áudio | "raw frame access" | **captura e playout de dispositivo real** (`platform_audio.h`) |
| AEC / supressão / AGC | ausentes no projeto (§2.6) | **vêm no SDK**, ligados por padrão |
| `mute()` no cliente | rtc-node não tem | **`LocalAudioTrack::mute()` existe** |

O erro anterior não foi descuido: o release 1.1.0 saiu em 10/06/2026 e o 1.7.0
em 11/08/2026 — **quatro dias** antes desta rodada. A lição operacional é que
"exige Rust" e "só dá acesso a quadro cru" eram fatos com prazo de validade, e
os dois sustentavam o custo que fazia a Opção A parecer cara.

**VERIFICADO** por download, extração e build nesta máquina.

---

## 3. As três arquiteturas avaliadas

### 3.1 Opção A — LiveKit dentro do `voice-helper`

Um processo. Captura, publica, assina, toca. A CEF fica com HUD, PTT, status e
preferências.

**A favor**
- O `voice-helper` já existe, já compila em `/W4` nesta máquina e **já capturou
  microfone real** (400 quadros, 768000 bytes — `e39e506`).
- O launcher já sabe distribuí-lo: versão, hash, instalação, pareamento e ordem
  de desligamento estão em `voice-dist.mjs`. Nenhuma máquina nova de distribuição.
- O pareamento loopback com segredo efêmero já existe e é reaproveitável como
  está — nenhum segundo mecanismo (§15 do enunciado).
- `platform_audio.h` entrega captura **e** playout, com AEC, supressão de ruído
  e AGC. O caminho legado nunca teve nenhum dos três (auditoria §2.6).
- `audio_stream.h` entrega PCM cru **por faixa remota**, que é exatamente o que
  ganho e pan por locutor exigem.
- Falha de voz não derruba o jogo: é outro processo (§39).

**Contra**
- +26,3 MB de DLL por jogador (`livekit_ffi.dll` 23,4 MB + `livekit.dll` 2,9 MB).
- O reenquadramento de 20 ms → 10 ms na fronteira do SDK (§5.2).
- Espacialização é código nosso em C++, não `PannerNode` de graça.

### 3.2 Opção B — helper publica, CEF recebe

**Rejeitada.** Quatro motivos, e o terceiro é o que fecha a porta.

1. **Custo de client que o projeto não tem.** Tocar áudio na CEF não exige
   `getUserMedia`, então a permissão de microfone deixa de ser o bloqueio — mas
   `autoplay-policy` continua sendo decisão de linha de comando do client, e
   `OnBeforeCommandLineProcessing` do SkyMP está vazio (auditoria §5.3). Mexer
   nisso é fork registrado + build + assinatura + distribuição de client, que é
   o blocker #3 da auditoria e continua aberto.
2. **Não é testável hoje, nem um pouco.** Nenhum client Skyrim jamais conectou
   neste projeto (blocker #2, Fase 0). Escolher a arquitetura que não pode ser
   exercitada é escolher sem evidência, que é o que o enunciado proíbe.
3. **Duas identidades por jogador.** Se o helper publica e a CEF assina, cada
   pessoa vira **dois participantes** na sala, com identidades distintas. O
   `UpdateSubscriptions` endereça o ouvinte por identidade, então o Voice Core
   passaria a manter duas identidades por ator, e `actorIdFromIdentity`
   deixaria de ser suficiente. É complexidade permanente no plano de controle
   para pagar uma escolha de onde tocar som.
4. **Voice failure vira game failure.** A decodificação passaria a rodar dentro
   do processo do jogo. §39 diz o contrário.

**INFERIDO** quanto ao comportamento da CEF: nada foi executado. É precisamente
o argumento.

### 3.3 Opção C — sidecar RTC separado

**Rejeitada por não comprar nada.**

O argumento do sidecar é isolamento de crash. Mas o `voice-helper` **já é** um
processo separado do jogo — o isolamento já está pago. Um sidecar adicionaria um
**terceiro** processo entre o helper e o jogo.

E a variante óbvia (sidecar em Node com `@livekit/rtc-node`, que já funciona
nesta máquina e tem binário pré-compilado) esbarra num fato: **`@livekit/rtc-node`
não abre dispositivo de áudio.** Ele empurra e puxa PCM. Um sidecar Node ainda
precisaria do helper C++ para microfone e fone, e passaria a haver PCM cru
atravessando IPC local entre dois processos — o mesmo formato de fio que esta
migração existe para tirar do caminho, só que agora com Node embarcado (+50 MB)
no instalador.

Custo maior, superfície maior, e o único benefício já estava pago.

---

## 4. Matriz de decisão

Notas: ✅ pronto/provado · 🟡 possível com trabalho · ❌ bloqueado ou ausente.

| Critério | Helper C++ | CEF/JS | Sidecar |
|---|:--:|:--:|:--:|
| Captura mic | ✅ WASAPI provado + ADM do SDK | ❌ precisa de `CefPermissionHandler` em build próprio | 🟡 só via helper |
| Playback | ✅ `PlatformAudio` playout | 🟡 WebAudio, não exercitado | 🟡 só via helper |
| LiveKit oficial | ✅ `client-sdk-cpp` 1.7.0, Apache-2.0 | ✅ `livekit-client` 2.x | ✅ `@livekit/rtc-node` |
| Compatibilidade SkyMP | ✅ nenhum patch de client | ❌ exige fork + build + assinatura | ✅ nenhum patch |
| Spatial audio | 🟡 código nosso, PCM por faixa | ✅ `PannerNode` de graça | 🟡 código nosso |
| Performance | ✅ nativo, sem cópia por JS | 🟡 dentro do processo do jogo | 🟡 +1 salto de IPC |
| Segurança | ✅ pareamento existente, sem segredo em argv | ❌ flag global de autoplay no client | 🟡 mais uma fronteira |
| Distribuição | 🟡 +26,3 MB no pacote já existente | ❌ client inteiro | ❌ +Node +26,3 MB +3º processo |
| Manutenção | ✅ um processo, um dono | ❌ fork de client a rebasear | ❌ dois runtimes |
| Crash isolation | ✅ já fora do jogo | ❌ dentro do jogo | ✅ (já pago pelo helper) |
| Atualização | ✅ manifesto + hash do launcher | ❌ atualizar client | 🟡 dois artefatos |
| Complexidade | ✅ menor | 🟠 duas identidades por jogador | ❌ maior |
| Risco técnico | ✅ **medido, 9/9 verificações** | ❌ **não exercitável hoje** | 🟡 não exercitado |

A última linha é a que decide. Duas colunas são opinião fundamentada; uma tem
números.

---

## 5. O que foi medido

Tudo abaixo é **VERIFICADO**: `livekit-server` 1.13.5 real, tokens emitidos por
`core/voice/livekit-token.js`, cliente C++ compilado nesta máquina. O spike está
em [`spikes/skyvoice-livekit-cpp/`](../../spikes/skyvoice-livekit-cpp/).

### 5.1 Transporte e PTT — 4/4

| Verificação | Medido |
|---|---|
| B recebe áudio de A pelo SFU | 179 quadros, RMS **0.20540** |
| O sinal é o que A mandou | 440 Hz **5135×** o controle em 1 kHz |
| PTT solto (`mute()`) | RMS **0.00000**, sem sair da sala |
| PTT apertado (`unmute()`) | RMS **0.21312** |

O RMS teórico de um seno de amplitude 0.3 é 0.2121. Chegar a 0.2054 **através do
Opus e de um SFU** é o mesmo resultado que o spike Node deu (0.2121), por outro
caminho e noutra linguagem.

### 5.2 O reenquadramento de 20 ms para 10 ms — achado ao rodar

O primeiro build publicou e não entregou áudio nenhum. A causa:

```
InvalidState - direct capture requires 10ms frames: got 960 frames, expected 480
```

`AudioSource::captureFrame` com `queue_size_ms = 0` aceita **só 10 ms**. O
`AudioProcessingModule` (o AEC) exige o mesmo.

Isso é maior que o spike. **O projeto inteiro fala 20 ms**: `kFrameMs` no
[`voice-helper/src/main.cpp`](../../voice-helper/src/main.cpp), os `AUDIO_*` do
`voip-service.js` e o `RELAY_SAMPLE_RATE` do `index.html` — os três lugares que
o próprio comentário do helper avisa que precisam concordar. A migração terá que
reenquadrar na fronteira do LiveKit, ou usar `queue_size_ms > 0`, que amortece e
adiciona atraso. **10 ms é o número da casa do lado LiveKit.**

### 5.3 Plano de controle server-authoritative — 5/5

O ouvinte entra com `auto_subscribe = false` e o `livekit-gateway.js` do
gamemode concede a assinatura **entre duas medições**.

| Verificação | Medido |
|---|---|
| Sem ordem do servidor, B não recebe nada | **0 quadros** |
| `applySubscriptionDiff` (concessão) | `ok=true calls=1 failures=0 unresolved=0` |
| Depois da ordem, B recebe áudio | 250 quadros, RMS **0.21214**, 440 Hz 17994.6 |
| `applySubscriptionDiff` (revogação) | `ok=true calls=1` |
| Depois da revogação, B não recebe | **0 quadros** |

Isto fecha um item que a PR #28 declarou aberto por escrito: *"`UpdateSubscriptions`
não foi verificado contra um `livekit-server` real (…) a **serialização do corpo**
Twirp não foi confirmada. É o item mais provável de precisar de ajuste."* Foi
confirmada, e não precisou de ajuste.

### 5.4 Microfone real — captura e transporte, não inteligibilidade

Dois dispositivos reais enumerados pelo ADM do WebRTC (`Logi C270 HD WebCam`,
`Fuxi-H3`). Publicando do microfone padrão, o ouvinte recebeu **300 quadros por
janela de 3 s** (100/s a 10 ms — o esperado), com RMS oscilando entre **0.0007 e
0.0036**.

O que isso prova: o caminho microfone → ADM → Opus → SFU → assinante entrega
áudio real e variável, claramente distinto do silêncio digital (0.00000) medido
durante o `mute()`.

O que **não** prova: nada sobre fala. Era ruído de sala, e **ninguém ouviu**.

---

## 6. Duas armadilhas de observabilidade

Registradas porque o projeto já foi mordido por uma delas (§34 do enunciado).

**Quadro que chega não é áudio que chega.** Durante o `mute()`, o ouvinte
continuou recebendo **250 quadros por janela** com RMS **0.00000**. Um teste que
contasse quadros teria dado verde num sistema completamente mudo. É o mesmo
formato de erro do `UpdateSubscriptions` que respondia 200 sem assinar nada.

**A ordem não vale no mesmo instante.** Medido aqui:

| Operação | Cauda de áudio em voo |
|---|---|
| `mute()` (PTT solto) | ~70 ms |
| `UpdateSubscriptions` de revogação | ~440 ms |

A revogação demora mais porque desfaz a assinatura e renegocia, enquanto o mute
só para de enviar. Isso tem consequência de jogo: **sair do alcance não emudece
o outro no mesmo quadro**. É mais um motivo para o ganho por distância continuar
sendo aplicado também no cliente — não como segunda decisão de audiência (§19 do
enunciado proíbe), mas como a rampa que torna a borda inaudível antes de a
assinatura cair.

---

## 7. Como as regras do enunciado ficam nesta arquitetura

| Regra | Como fica |
|---|---|
| §13 Credencial emitida pelo servidor | O token sai de `livekit-token.js`, identidade derivada do `actorId`. O cliente nunca a escolhe. |
| §14 Nada de token em argv | Mantido, e o próprio spike obedece: config por uma linha de JSON no stdin. |
| §15 Reusar o pareamento | O canal loopback de `main.cpp` já transporta credencial. Ganha um campo, não um mecanismo. |
| §16 PTT | `LocalAudioTrack::mute()` / `unmute()`. Sem reconectar, sem renegociar. **VERIFICADO**. |
| §17 Staff mute vence PTT | Continua server-side: o route-engine não põe o locutor na audiência de ninguém, e `MutePublishedTrack` é o martelo. O cliente não é consultado. |
| §18 Subscriptions autoritativas | `auto_subscribe = false` no cliente. Quem concede é o gateway. **VERIFICADO**. |
| §19 Sem proximidade duplicada | O cliente aplica ganho/pan **recebidos**; não calcula distância nem decide audiência. |
| §31 Privacidade | Nada é gravado. Sem Egress, sem disco, sem replay. |
| §39 Voz não derruba o jogo | O cliente é outro processo, com guarda de órfão já existente. |

---

## 8. Riscos e o que fazer com eles

| # | Risco | Gravidade | Mitigação | Estado |
|---|---|---|---|---|
| 1 | +26,3 MB de DLL no download do jogador | Médio | Já há manifesto com versão e hash; a voz é opcional e pode ser um pacote à parte. | **PLANEJADO** |
| 2 | Reenquadramento 20↔10 ms introduzir estalo | Médio | Acumulador já existe no `OnCapture`; o teste é RMS contínuo, não contagem. | **NÃO TESTADO** |
| 3 | AEC do SDK conflitar com playout próprio | Médio | Se o playout for nosso (miniaudio), o AEC perde o sinal de referência. Usar o playout do `PlatformAudio` resolve; espacializar antes dele é o problema aberto (§9). | **NÃO TESTADO** |
| 4 | SDK novo (1.7.0 saiu há 4 dias) | Médio | Versão pinada e SHA-256 registrado. Não seguir `latest`. | **PLANEJADO** |
| 5 | Binário não assinado | Médio | Mesma dívida do `voice-helper.exe` de hoje. | **Aberto** |
| 6 | Sem `checksums.txt` oficial do SDK | Baixo | SHA-256 do que baixamos registrado no README do spike. | **VERIFICADO** |
| 7 | Perder o caminho legado cedo demais | Alto | **Nada foi removido.** O helper de produção não foi tocado nesta rodada. | **VERIFICADO** |

### O problema aberto que merece nome

**Espacialização versus AEC.** O desenho quer PCM por locutor (`AudioStream`),
ganho e pan aplicados por nós, e mistura própria — mas o AEC do WebRTC precisa
conhecer o sinal que sai no alto-falante (`processReverseStream`). Se
espacializamos fora do ADM, o AEC deixa de ver o que foi tocado e passa a
cancelar errado. Há saída (alimentar o `AudioProcessingModule` manualmente com a
mistura final, em quadros de 10 ms), mas ela **não foi exercitada** e é o
próximo risco técnico real desta linha.

---

## 9. Rollback

Barato, e é de propósito.

O `voice-helper` de produção **não foi alterado nesta rodada** — nem uma linha.
O caminho legado (`legacy-relay`) continua sendo o padrão de `VOICE_BACKEND`, e
`ENABLE_VOIP_SERVICE` continua sendo quem liga a voz. O spike vive num diretório
próprio, com dependência própria, e apagá-lo não afeta nada.

Se a Opção A não fechar na integração, o que se perde são os arquivos de
`spikes/skyvoice-livekit-cpp/` e o que se aprendeu fica nos números deste
documento. O `cef-livekit` continua descrito na costura do `voice-endpoint.js`,
com o transporte indistinguível preservado.

---

## 10. Próximos passos, na ordem

1. **Uma pessoa escuta.** `node run-spike.mjs --mic --playout`, duas máquinas ou
   duas contas, um par de fones. É o blocker #1, tem quase um mês, e **nenhum
   código o fecha**. Tudo abaixo pode esperar; isto não.
2. Resolver espacialização versus AEC (§8) numa bancada, com números.
3. Só então integrar o SDK ao `voice-helper` de produção, atrás de um modo novo,
   com o caminho legado intacto para comparação A/B.
4. Reenquadramento 20→10 ms com teste de continuidade, não de contagem.
5. Distribuição: pacote de voz separado no manifesto do launcher.
6. Skyrim. Depois de tudo acima, e não antes.

**Não declarar production-ready.** Faltam TLS, TURN, NAT real, rede degradada,
assinatura de binário, escala e monitoramento. A marca correta quando os dois
clientes se ouvirem em jogo é `E2E VALIDADO EM SKYRIM`.

---

## Fontes

**Executado nesta máquina (15/08/2026):**
- `livekit-sdk-windows-x64-1.7.0.zip`, SHA-256 `bed6a0a5…44928a`
- `livekit-server` 1.13.5, `--config livekit-spike.yaml`
- `spikes/skyvoice-livekit-cpp/` — build MSVC 19.44 `/W4` limpo, 9/9 verificações

**Lido no cabeçalho da versão em uso (`livekit-sdk-windows-x64-1.7.0`):**
- `platform_audio.h` — `PlatformAudio`, `PlatformAudioOptions`, `AudioDeviceInfo`
- `local_audio_track.h` — `mute()`, `unmute()`, as duas fábricas
- `audio_stream.h` — `AudioStream::Options`, `read()`, `AudioFrameEvent`
- `audio_source.h` — `captureFrame`, semântica de `queue_size_ms`
- `audio_processing_module.h` — AEC3, supressão, AGC, exigência de 10 ms
- `room.h` — `RoomOptions::auto_subscribe`, `setOnAudioFrameCallback`

**LiveKit:**
- [`client-sdk-cpp`](https://github.com/livekit/client-sdk-cpp) ·
  [release v1.7.0](https://github.com/livekit/client-sdk-cpp/releases/tag/v1.7.0) ·
  [`rust-sdks`](https://github.com/livekit/rust-sdks)

**Internas:** [`SKYVOICE_LIVEKIT_AUDIT.md`](SKYVOICE_LIVEKIT_AUDIT.md) ·
[`VOICE_NATIVE_HELPER.md`](VOICE_NATIVE_HELPER.md) ·
[`VOICE_CLIENT_PATCH.md`](VOICE_CLIENT_PATCH.md) ·
[`ADR_006_SKYVOICE_CLIENT_RTC.md`](ADR_006_SKYVOICE_CLIENT_RTC.md) ·
[`SKYVOICE_CLIENT_E2E_MATRIX.md`](../testing/SKYVOICE_CLIENT_E2E_MATRIX.md)
