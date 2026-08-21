# Voz por Proximidade — Helper Nativo (Fase 1: prova de conceito)

> **Status:** o **helper compila e captura áudio real** (§8.3, §8.4), o servidor
> aguenta um jogador falando e ouvindo ao mesmo tempo (§10), e existe um caminho
> para um testador pegar o ticket (§11). Falta **uma pessoa escutar** e dizer se
> a voz sai inteligível (§8.2) — não falta código para isso.
> Substitui o caminho de [`VOICE_CLIENT_PATCH.md`](VOICE_CLIENT_PATCH.md), que
> fica no repositório como registro de por que foi descartado.

## 1. Por que este documento existe

O `voip-service.js` estava implementado e testado desde antes: sinalização
WebRTC, autenticação por ticket, volume por distância. E nunca produziu áudio
nenhum, porque o navegador embutido do client SkyMP (CEF) recusa
`getUserMedia({audio:true})` com `NotAllowedError`.

> **Correção de causa — 14/08/2026.** A recusa é real, mas o motivo registrado
> aqui estava incompleto, e a versão da CEF citada mais abaixo (Chromium ~70)
> está **errada**: o SkyMP usa **CEF 108.4.13 / Chromium 108.0.5359.125**.
>
> A causa exata, lida no fonte da CEF 108: o runtime alloy chama
> `CefPermissionHandler::OnRequestMediaAccessPermission` e, **na ausência de um
> handler**, nega por padrão (`default_disallow=true` em
> `alloy_browser_host_impl.cc`). O `OverlayClient` do SkyMP não implementa
> `GetPermissionHandler`. Ou seja: não falta versão de CEF — falta um handler
> que a versão em uso já oferece.
>
> Isso **não invalida nada abaixo**. O helper nativo continua sendo um caminho
> válido e é o Plano B da migração; a captura WASAPI medida na §8.4 continua
> valendo, e este arquivo não deve ser apagado. O que muda é que o caminho pela
> CEF volta a ser possível **sem** enfraquecer o cliente.
> Ver [`SKYVOICE_LIVEKIT_AUDIT.md`](SKYVOICE_LIVEKIT_AUDIT.md) §5.

A explicação que circulava — e que estava escrita em comentário no
`skymp/ui/index.html` até 07/08/2026 — era que "falta um patch em
`MyChromiumApp.cpp` que nunca foi mergeado upstream", como se fosse
esquecimento dos mantenedores.

Não é. O release notes da **SkyrimPlatform 2.1** (o SkyMP hoje usa a 2.6)
registra a remoção com todas as letras:

> "Removed Chromium flag that gives the ability to listen to recording devices
> via browser-side JavaScript"

Foi uma **remoção deliberada**, e a razão dela é sólida. O client SkyMP abre a
URL que o servidor mandar. Com a flag ligada, qualquer JavaScript servido por
qualquer servidor SkyMP captaria o microfone do jogador **em silêncio, sem
prompt de permissão do sistema**. Reverter isso num build distribuído não
resolveria um risco do nosso servidor — criaria um risco permanente, do client
inteiro, em qualquer servidor que aquele jogador conectasse depois.

Por isso o caminho mudou.

## 2. A decisão de arquitetura

**A captura sai do navegador. A reprodução fica.**

Um executável separado (`voice-helper/`), rodando ao lado do jogo, captura o
microfone pela API de áudio do Windows e manda os quadros para o `voip-service`.
O servidor decide por proximidade quem ouve e com que volume, e retransmite. O
navegador do jogo apenas **toca** o que chega — e tocar áudio recebido nunca foi
bloqueado pela CEF. Só a captura era.

```
  helper nativo            voip-service (gamemode)              index.html
  ┌──────────────┐         ┌───────────────────────┐         ┌──────────────┐
  │ WASAPI       │ audio_  │ tickProximity() 2s    │ audio_  │ decodifica   │
  │ (compartilh.)│ frame   │   → audiência         │ frame   │ Web Audio    │
  │ PCM s16 48k  ├────────►│ relay + volume anexado├────────►│ gain=volume  │
  │ quadros 20ms │  ws     │ (não olha os bytes)   │  ws     │ → destination│
  └──────────────┘         └───────────────────────┘         └──────────────┘
```

### Efeito colateral bom: NAT/CGNAT

A troca de WebRTC P2P (malha de `RTCPeerConnection` entre pares) por relay
central resolve de graça um problema que o caminho antigo teria em produção:
dois jogadores em redes residenciais diferentes, ambos atrás de CGNAT, não
fecham conexão direta nem com STUN — precisariam de um TURN, que é um servidor
de relay com outro nome. Aqui tudo passa pelo servidor, que já é alcançável por
todo mundo porque é nele que o jogo conecta.

### O que o servidor não faz

O servidor **não decodifica, não mistura e não transcodifica** — anexa o volume
e repassa os bytes. Mixagem no servidor economizaria banda de descida, mas
exigiria decodificar e somar N fluxos por ouvinte a cada 20ms. Numa prova de
conceito isso é trocar um problema já provado por um que não foi.

## 3. Decisão: PCM cru, não Opus (nesta fase)

**Escolhido:** PCM 16-bit little-endian, mono, 48kHz, quadros de 20ms.

O motivo é isolar falhas. Codec e transporte quebram de formas parecidas do lado
de quem escuta — sai silêncio, ou sai ruído. Depurando os dois ao mesmo tempo,
não dá para saber se o áudio saiu errado porque o quadro chegou truncado ou
porque o encoder foi alimentado errado. Com PCM, "os bytes que entraram são os
bytes que saíram" é verificável com uma conta.

Os parâmetros:

- **48kHz** é o padrão do WASAPI em modo compartilhado. Pedir outra coisa faria
  o Windows reamostrar antes de a gente ver o áudio — mais uma etapa capaz de
  errar em silêncio.
- **Quadros de 20ms** é o quadro nativo do Opus. Escolher isso agora significa
  que a Fase 2 troca o codec sem mexer no enquadramento.
- **Mono** porque a voz é posicionada pelo volume da proximidade; estéreo do
  microfone seria descartado do outro lado de qualquer forma.

**O preço, medido:** 48000 × 2 bytes = 96 kB/s = **768 kbit/s por locutor**, e
base64 (§4) infla 33% → **~1 Mbit/s de subida**. Na descida, o relay multiplica
pelo número de ouvintes em alcance. Isso é caro e é sabido — é aceitável para
uma prova de conceito em rede local e **não é aceitável em produção**.

**Fase 2: Opus** (`libopus`, disponível no vcpkg). A 24 kbit/s a voz fica
transparente e o consumo cai ~30x, o que também torna irrelevante o desperdício
do base64.

## 4. Decisão: mesma porta, mesmo ticket, JSON com base64

**Escolhido:** o helper conecta na porta do `voip-service` (7778) e autentica com
o mesmo `{type:'auth', actorId, ticket}` que o `index.html` já usa.

Não há um segundo sistema de autenticação porque não há um segundo problema. O
handshake por ticket existente já resolve exatamente isto — provar que quem
conecta é o dono daquele `actorId` — e já é testado. Inventar outro dobraria a
superfície de ataque em troca de nada.

**Formato da mensagem:**

```jsonc
// helper → servidor
{ "type": "audio_frame", "seq": 41, "data": "<base64 de PCM s16le>" }

// servidor → cada ouvinte em alcance
{ "type": "audio_frame", "fromActorId": 4278192658, "volume": 0.75,
  "seq": 41, "data": "<os mesmos bytes>" }
```

**Base64 em JSON, e não quadro binário do WebSocket.** O binário economizaria os
33%, mas exigiria um cabeçalho próprio para carregar `fromActorId`/`volume`/`seq`
— um segundo formato de fio, com seu próprio parser, do lado do servidor e do
navegador. Todo o resto deste socket é JSON. Com Opus na Fase 2 os 33% incidem
sobre 24 kbit/s, e a economia deixa de pagar a complexidade.

**Teto de 8192 caracteres no payload.** O `audio_frame` é o único ponto onde um
cliente autenticado faz o servidor escrever dados controlados por ele nos
sockets de *outros* jogadores. Sem teto, um quadro de megabytes é multiplicado
pela audiência inteira — amplificação, e a memória que estoura é a do servidor.
8192 dá folga de 3x sobre o quadro nominal.

## 5. Reuso do tick de proximidade

O relay **não recalcula proximidade por quadro**. `tickProximity()` já roda a
cada 2s e já calcula, para cada par, o volume que um ouve o outro; o que faltava
era guardar. Agora ele monta `_audienceByActor` — a transposta do que já era
calculado e jogado fora:

```
actorId do locutor → [{ actorId: ouvinte, volume }]
```

Proximidade é O(n²) de distância 3D. Um quadro chega a 50/s por locutor;
recalcular por quadro seria pagar esse O(n²) cinquenta vezes por segundo por
pessoa falando.

**A audiência tem até 2s de idade**, e isso é herdado, não introduzido: o
`proximity_update` que ajusta o ganho do WebRTC sempre teve a mesma defasagem.
Consequência prática — quem sai do alcance continua ouvindo por até 2s, e quem
*entra* fica mudo por até 2s. Em velocidade de corrida do Skyrim (~350 unidades/s)
isso são ~700 unidades contra um alcance de fala de 1200. Ver §9.

**O mesmo número, não uma cópia dele.** O volume que vai anexado no `audio_frame`
sai da mesma conta que alimenta o `proximity_update`. Se fossem dois cálculos, a
mesma pessoa poderia soar em dois volumes diferentes dependendo do transporte
que a entregou. Há teste travando a igualdade.

## 6. O que mudou no `index.html`

Adiciona, não substitui. `getUserMedia`, `RTCPeerConnection`, `createPeerConnection`,
`initiateCall`, `handleOffer`, `state.voiceFatal` e as mensagens de erro do
microfone continuam todos lá — é o que roda no client oficial de quem não tem o
helper, e o encaminhamento pro Discord segue válido pra essa pessoa.

Três mudanças merecem registro:

1. **O `AudioContext` saiu de dentro do `initMicrophone()`.** Nascer junto com a
   captura fazia sentido quando a única fonte era WebRTC. Agora tocar não depende
   de capturar — e no client oficial capturar *sempre* falha, que é exatamente o
   caso em que este caminho precisa funcionar.

2. **O WebSocket não é mais fechado quando o microfone falha.** Antes era, com o
   argumento de que "sem microfone não há como publicar nem faz sentido manter a
   sinalização aberta". O argumento era correto enquanto o socket só levasse
   sinalização. Este PR põe áudio de outras pessoas nele: fechar ali desligaria
   a **escuta** junto com a captura, garantindo que ninguém nunca ouça nada
   justamente no client onde a captura falha sempre. `voiceFatal` continua
   marcado e a mensagem específica continua na tela.

3. **Chip de estado âmbar, `OUVINDO — SEM MICROFONE`.** Sem isso o jogador lê
   "VOZ INDISPONÍVEL" enquanto ouve alguém falando — a tela contradizendo a caixa
   de som. Verde mentiria (não dá pra falar) e vermelho também (dá pra ouvir).

As fontes de relay ficam em `state.relayPeers`, separadas de `state.peers`. Toda
entrada de `peers` tem um `RTCPeerConnection` e `removePeer` chama `pc.close()`;
uma fonte de relay não tem `pc`, e misturar as duas transformaria cada uso de
`peers` num campo minado de `if (peer.pc)`.

## 7. Resultado do teste ponta a ponta

Feito em 07/08/2026, com `voice-helper/tools/e2e-harness.js` (sobe o
`voip-service` real com `mp` mockado e posições controláveis por HTTP) e
`voice-helper/tools/frame-probe.js` (fala o protocolo do helper, gerando um tom
de 440Hz em vez de capturar microfone).

O ouvinte foi o **`skymp/ui/index.html` real**, carregado num navegador comum.
O navegador **bloqueou o microfone da página** — a mesma `NotAllowedError` do
CEF, o que deu ao teste a condição exata do client oficial.

### ✅ O que foi verificado

| O quê | Medido |
|---|---|
| Relay servidor→servidor | 1920 bytes por quadro, byte-a-byte idênticos |
| Enquadramento no navegador | 960 amostras, 20ms, 48kHz por buffer |
| Fidelidade do PCM | pico **0.3000** = amplitude exata do tom gerado |
| Sinal decodificado | RMS **0.2107** vs 0.2121 teórico de senoide 0.3 (0,7%) |
| Frequência | energia em 440Hz **6300× maior** que o controle em 1000Hz |
| Volume por proximidade (600 de 1200) | ganho **0.5**, saída pico **0.15** = 0.3 × 0.5 |
| Volume por proximidade (300 de 1200) | ganho **0.75**, saída pico **0.225** = 0.3 × 0.75 |
| Saída medida no grafo de áudio | RMS 0.1586 vs 0.1591 esperado; FFT em 445Hz (bin de 23,4Hz) |
| Corte por distância | ouvinte a 2000 com locutor ativo: **0 buffers agendados** |
| Retomada ao entrar no alcance | 0 → **461 buffers**, HUD em 75% |
| Socket sobrevive à falha de microfone | ✅ sem a mudança do §6.2, zero quadros chegariam |
| Erros de decodificação | **nenhum** em ~1300 quadros |

O sinal foi medido no `AnalyserNode` ligado à saída da cadeia de ganho que
alimenta o `destination` — depois do volume da proximidade, não antes. Cada
medição confirma, no mesmo instante, que havia tráfego: sem essa checagem uma
leitura de silêncio é ambígua (várias medições intermediárias leram zero
simplesmente porque a sonda tinha encerrado, e por um momento isso foi lido como
defeito). O controle é injetar um buffer conhecido no mesmo nó de ganho: ele
mede 0.225, provando que o caminho de medição funciona quando há o que medir.

### ⚠️ Achado: re-bufferização audível quando a fonte é mais lenta que o tempo real

Instrumentando o agendamento, a folga entre `nextPlayTime` e o relógio do
`AudioContext` **encolhe ~10ms por quadro** e reinicia em 60ms ao esgotar —
**4 re-bufferizações a cada 25 quadros**. A causa medida é a sonda: ela entrega
um quadro a cada **30,8ms** em vez de 20ms, porque `setInterval` do Node não
tem essa precisão. Ou seja, é limitação da *sonda*, não do transporte — o helper
nativo é dirigido pelo relógio do dispositivo WASAPI, que entrega em tempo real
por construção.

Mas o achado sobre o **nosso** código é real: a política atual de underrun
(`nextPlayTime < now` → pula para `now + 60ms`) insere um silêncio de ~48ms toda
vez que a fonte atrasa. Numa rede real com jitter, isso vira picotamento em vez
de degradação suave. Um buffer adaptativo (que cresce sob jitter em vez de
resetar) é item da Fase 2 — ver §9.11. Nada disso foi exercitado fora de
`127.0.0.1`.

### ✅ Conexão dupla, verificada em 07/08/2026 (rodada "pronto para teste")

Depois da §10, o fluxo dos dois papéis foi exercitado contra o `voip-service`
**real** subido pelo `e2e-harness`, por sockets reais e pela rota HTTP de ticket
— não em teste unitário. Alice com helper (`sender`) **e** UI (`listener`) ao
mesmo tempo, Bob a meio alcance:

| Verificado | Resultado |
|---|---|
| Helper e UI da Alice autenticam juntos | ✅ (era impossível antes) |
| Bob recebe o áudio do helper da Alice | 1 quadro, `fromActorId` correto |
| Volume a meio alcance (600 de 1200) | **0.5** exato |
| Bytes do payload | idênticos |
| Alice ouve a própria voz | **não** — 0 quadros no `listener` dela |
| Helper recebe áudio ou `proximity_update` | **não** — 0 dos dois |
| UI da Alice recebe `proximity_update` | sim |
| Bob no `proximity_update` | aparece **1 vez**, não 2 |
| Fechar o helper | UI segue aberta, **nenhum** `peer_left` |
| Ticket de `listener` usado como `sender` | `auth_failed` |

Isso valida o servidor e o protocolo. **Não valida a captura** — quem gerou os
quadros foi a sonda, não um microfone.

### ❌ O que NÃO foi verificado

1. ~~**Captura WASAPI. O helper C++ nunca foi compilado nem executado.**~~
   **Resolvido em 07/08/2026 — ver §8.3 (build) e §8.4 (captura medida).** Os
   números da tabela acima continuam sendo da sonda; a captura tem os seus, na
   §8.4.

2. **Ninguém ouviu o áudio com o ouvido.** Continua valendo, e é agora o único
   bloqueio de verdade. Não há saída de áudio audível neste ambiente, e quem
   executou a rodada é um agente (§8.2). O que existe é medição — do sinal no
   `destination` do Web Audio (sonda) e do que a captura entrega (§8.4). É
   forte, e não é a mesma coisa que escutar.

3. **Dois clientes Skyrim reais.** Posições vieram do `mp` mockado.

4. **Qualquer coisa fora de `127.0.0.1`.** Latência, perda e jitter de rede real
   não foram exercitados; o jitter buffer de 60ms nunca viu um pacote atrasado.

## 8. Bloqueio: não há toolchain C++ nesta máquina

O helper não foi compilado porque **o ambiente não tem com o que compilar**.
Verificado em 07/08/2026:

```
where cmake                 → (nada)
where vcpkg                 → (nada)
where cl                    → INFORMAÇÕES: não foi possível localizar arquivos
where msbuild               → INFORMAÇÕES: não foi possível localizar arquivos
$VCPKG_ROOT                 → vazio
```

- `C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe` **não
  existe** — sem ele nem o instalador do VS está presente.
- `C:\Program Files (x86)\Microsoft Visual Studio\` contém **apenas `Shared\`**.
- `C:\Program Files\MSBuild\` contém apenas `Microsoft\Windows Workflow
  Foundation\v3.0` e `v3.5` — resíduo do .NET Framework, não do MSVC.
- Nenhum `gcc`, `g++` ou `clang` no PATH. Nenhum diretório `vcpkg`.

Ou seja: **nenhuma dependência do vcpkg chegou a ser resolvida**, porque não há
vcpkg para resolvê-las. O `vcpkg.json` e o `CMakeLists.txt` estão escritos com
base na documentação das portas (`miniaudio`, `ixwebsocket`, `nlohmann-json`) e
**não foram validados contra um `vcpkg install` real**. Quem tiver a máquina
deve tratá-los como não verificados até o primeiro build passar, e registrar
aqui o erro exato se alguma port não resolver — sem trocar de biblioteca sem
anotar o motivo.

> **Superado em 07/08/2026.** O toolchain foi instalado e o helper **compilou e
> capturou áudio real** — ver §8.3. As §8.1 e §8.2 abaixo ficam como registro do
> que estava bloqueado e por quê.

### 8.1 Reverificação em 07/08/2026 (rodada "pronto para teste")

Esta rodada começou com a informação de que a máquina agora teria Visual Studio
e vcpkg. **Não tinha** — o toolchain foi instalado depois, nesta mesma rodada
(§8.3). A varredura foi refeita, mais ampla que a da Fase 1, e o resultado era o
mesmo da Fase 1:

| Verificação | Resultado |
|---|---|
| `vswhere.exe` no caminho canônico | não existe |
| `C:\Program Files\Microsoft Visual Studio\` | diretório não existe |
| `C:\Program Files (x86)\Microsoft Visual Studio\` | só `Shared\` |
| `cl.exe` recursivo em ambos os `Program Files` (profundidade 6) | nenhum |
| `cmake.exe` recursivo em ambos os `Program Files` (profundidade 5) | nenhum |
| `gcc` / `g++` / `clang` / `clang++` / `cl` / `msbuild` no PATH | todos ausentes |
| `C:\vcpkg`, `$VCPKG_ROOT`, qualquer diretório `*vcpkg*` em `C:\` | nenhum |
| `dotnet` | presente (`C:\Program Files\dotnet\dotnet.exe`) — .NET, não MSVC |
| `winget` | presente |
| `node` / `npm` | v25.5.0 / 11.8.0 |

O que existia era `winget`, ou seja o build era **alcançável**. A instalação foi
feita em seguida (§8.3).

### 8.2 Nem esta rodada nem a Fase 1 ouviram o áudio

A Fase 1 registrou "ninguém ouviu com o ouvido" como limitação de ambiente. Ela
continua valendo, e por um motivo mais básico do que a falta de compilador:
**quem executou esta rodada é um agente, sem ouvido e sem saída de áudio.** A
máquina tem cinco dispositivos de áudio (`Dispositivo de áudio USB`, três
controladoras AMD, Realtek), então o hardware está lá — o que falta é a pessoa.

Isso não é contornável com mais medição. Medir amplitude, frequência e RMS já foi
feito na Fase 1 e é forte (§7); **inteligibilidade não é uma medida, é um
julgamento**, e um sinal pode bater todos os números e ainda sair irreconhecível
(inversão de fase, endianness trocada num canal, reamostragem sutil). Por isso o
passo 6 da etapa 8.2 do `FASE_0_ROTEIRO.md` pede "voz **inteligível**, não só
'tem sinal'": é a única verificação do roteiro de voz que exige uma pessoa e não
pode ser delegada.

### 8.3 Primeiro build de verdade — 07/08/2026

Toolchain instalado nesta rodada: **VS Build Tools 2022** (MSVC 19.44.35228,
toolset 14.44.35207), **CMake 4.4.2**, **vcpkg 2026-07-27**, Windows SDK
10.0.26100.

> O `winget` do VS Build Tools terminou com **exit 1603**, e ainda assim o
> toolset ficou funcional (`cl.exe`, `vcvars64.bat` e `MSBuild.exe` presentes e
> operantes; `vswhere` registra a instância). O 1603 foi de algum componente
> "recomendado", não do workload de C++. **O código de saída do instalador não é
> a prova** — `cl.exe` compilando é.

**As três ports resolveram**, com os nomes exatos que estavam no `vcpkg.json`
desde a Fase 1: `miniaudio` 0.11.25, `ixwebsocket` 12.0.1, `nlohmann-json`
3.12.0#2. Compilaram em 1,2 min. Aquele arquivo deixa de ser "não verificado".

**A falha antecipada no `README.md` não aconteceu.** A hipótese era símbolo
duplicado do `miniaudio` caso a port entregasse uma biblioteca já compilada. Ela
é **header-only** — o `portfile.cmake` instala só o `miniaudio.h` —, então o
`#define MINIAUDIO_IMPLEMENTATION` do `main.cpp` está certo e o `main.cpp`
compilou de primeira. O `find_package(unofficial-miniaudio CONFIG QUIET)` do
`CMakeLists.txt` falha (não há config a achar) e cai no `find_path`, que era
exatamente o fallback previsto. A precaução estava certa; o palpite, errado.

**O erro real foi outro, e no link:**

```
mbedcrypto.lib(entropy_poll.c.obj) : error LNK2019: símbolo externo não
resolvido, BCryptGenRandom, referenciado na função mbedtls_platform_entropy_poll
voice-helper.exe : fatal error LNK1120: 1 externo não resolvidos
```

O `ixwebsocket` arrasta o `mbedtls` para ter TLS, e o `entropy_poll` do
`mbedcrypto` chama `BCryptGenRandom`, que mora em `bcrypt.lib`. O
`CMakeLists.txt` linkava `ws2_32 ole32 winmm` e não ela. **Não usamos TLS em
lugar nenhum** — o helper fala `ws://` puro —, mas isso não isenta: o objeto
entra junto com a biblioteca inteira, não só o que a gente chama.

**Correção:** `bcrypt` no `target_link_libraries` do bloco `WIN32`. Uma linha,
nenhuma troca de biblioteca. Com ela o build passa e sai
`build/Release/voice-helper.exe` (1,37 MB).

### 8.4 Primeira captura WASAPI — o helper capturou áudio real

Binário real contra `voip-service` real (harness), autenticando com o novo
`role: "sender"` da §10, e um ouvinte instrumentado do outro lado medindo o que
chegou. 12 segundos de sala silenciosa:

| Medido | Resultado | Significa |
|---|---|---|
| Autenticação | `auth_ok` como `sender` | a §10 funciona com o binário, não só em teste |
| Quadros recebidos | 598 em 11,94s | — |
| **Taxa** | **50,1 quadros/s** (nominal 50) | tempo real, sem deriva |
| Amostras | 574080 = **exatamente** 598 × 960 | enquadramento certo, nada truncado |
| Descartes na fila do helper | **0** | a rede acompanhou a captura |
| Pico / RMS | 0.1677 / 0.01002 | ruído de sala — sinal real, não silêncio digital |
| Amostras clipadas | **0** | sem saturação no nível ambiente |
| Quadros ~silêncio | 376 de 598 | coerente com sala quieta |

**Isto encerra o achado de re-bufferização da §7 como sendo da sonda.** Lá a
fonte entregava a cada 30,8ms (limitação do `setInterval` do Node) e a folga do
jitter buffer encolhia ~10ms por quadro. O helper entrega a **50,1/s**, ou seja
19,96ms por quadro: é o relógio do dispositivo WASAPI, e a política de underrun
não é provocada por ele. O item §9.11 (buffer adaptativo) continua válido para
jitter de **rede real**, que segue não exercitado fora de `127.0.0.1`.

**O que isto ainda NÃO prova:** que a voz sai inteligível. Ninguém falou no
microfone e ninguém escutou a saída — vale integralmente a §8.2. O que está
provado é que a captura abre, entrega em tempo real, com enquadramento exato e
sem saturar. O julgamento de inteligibilidade continua sendo o passo 6 da etapa
8.2 do `FASE_0_ROTEIRO.md`, e continua precisando de uma pessoa.

Escolha do `miniaudio` sobre WASAPI/COM cru: header-only, licença permissiva
(MIT/domínio público), e evita ~400 linhas de `IMMDeviceEnumerator`/`IAudioClient`
que seriam código nosso para manter sem ganho nenhum sobre o que a biblioteca já
faz. Escolha do `ixwebsocket`: API pequena e síncrona o bastante para caber num
executável de terminal, sem arrastar Boost.

### 8.5 Reverificação em 20/08/2026 — sem regressão

Rodada de verificação independente, do zero (`build_verify/`, descartado depois),
não reaproveitando nenhum binário antigo.

| Verificado | Resultado |
|---|---|
| `vcpkg install` das três ports contra o `vcpkg.json` atual | resolve, ~700ms |
| Link com `bcrypt` (fix da §8.3) | continua no `CMakeLists.txt`, build limpo |
| `voice-helper.exe` roda e fala `--help`/uso | sim, e expõe um modo não documentado aqui: `--control-port` + `--pair` (pareamento com o launcher, ver `SKYVOICE_E2E_ETAPA_5.md`) |
| `e2e-harness.js` (código de produção do `voip-service`, não mock) + `voice-helper.exe` capturando microfone real, dois atores a 300 de 1200 de alcance | `proximity_update` com `volume: 0.75` (matematicamente exato: `1 - 300/1200`), 500 quadros relayados ao `frame-probe.js --listen`, zero descarte |
| `npm test` do gamemode | 1623/1623, incluindo `voip-service.test.js` |

Nada regrediu desde a §8.3/§8.4. **O que continua exatamente igual:** ninguém
ouviu o áudio com o ouvido — a §8.2 segue de pé, palavra por palavra, e vale
tanto para este helper quanto para o spike de LiveKit em
`spikes/skyvoice-livekit-cpp/` (commit `79dd5bd`), que fechou pelo mesmo
motivo: "NINGUÉM OUVIU" como blocker #1. É julgamento humano, não medição, e
continua sendo o único passo do roteiro que não pode ser feito por um agente.

## 9. Próxima rodada — listado, não implementado

Nada abaixo foi feito neste PR.

**Bloqueadores de uso real**

1. ~~**Um socket por `actorId` impede helper e UI de coexistirem.**~~
   **Resolvido em 07/08/2026 — ver §10.**
2. **Handoff automático do ticket.** Hoje é copiar e colar na linha de comando.
   ~~Pior: `issueTicket` sobrescreve o ticket pendente daquele ator, então um
   `/voz` não serve para os dois lados.~~ A sobrescrita foi resolvida junto com
   a §10 (o ticket agora é por papel, e um `/voz` emite os dois); o handoff
   automático continua aberto e é Fase 3. O andaime temporário que destrava o
   teste manual está na §11.
3. **Empacotamento e assinatura do executável**, e integração com o launcher —
   mesma exigência de carimbo de tempo já registrada em
   [`LAUNCHER_DISTRIBUTION.md` §6](LAUNCHER_DISTRIBUTION.md).

**Qualidade**

4. **Opus** no lugar do PCM cru (§3). ~30x menos banda.
5. **Cancelamento de eco e supressão de ruído.** Sem AEC, quem usa caixa de som
   em vez de fone realimenta a própria voz na cena.
6. **Primeiros ~2s de fala são perdidos** enquanto o tick não monta a audiência
   do locutor recém-conectado (medido: 45 de 195 quadros no primeiro teste).
   Montar a audiência no `auth` ou reduzir o intervalo do tick resolve.
7. **Serialização por ouvinte.** O payload é re-serializado para cada
   destinatário porque o `volume` difere. Com Opus o custo vira irrelevante.

**Limpeza**

8. **Remover o WebRTC do `index.html`** (`createPeerConnection`, `initiateCall`,
   `handleOffer`, relay de `offer`/`answer`/`ice` no servidor). Só depois que o
   helper estiver distribuído — hoje é o único caminho que existe para quem não
   o tem.
9. **`--list-devices` no helper**, para quem tem mais de um microfone.
10. **Teste com rede real**, não `127.0.0.1`.
11. **Jitter buffer adaptativo.** A política atual pula para `now + 60ms` quando
    esgota, inserindo ~48ms de silêncio a cada atraso da fonte (medido no §7).
    Um buffer que cresce sob jitter degrada suave em vez de picotar.

## 10. Decisão: papel na conexão (`listener` / `sender`)

**O problema.** `voipClients` era `Map<actorId, conexão>` — uma conexão por ator.
Enquanto a captura morava no navegador isso estava certo: falar e ouvir saíam
pelo mesmo socket. A captura saiu (§2), e o índice ficou errado. Helper e UI do
**mesmo jogador** autenticam com o mesmo `actorId` e brigavam pelo mesmo slot:
quem chegasse por último derrubava o outro. A bancada da Fase 1 contornou usando
dois atores distintos (helper = A, navegador = B), que é exatamente o arranjo que
**não** é o de um jogador real.

**Escolhido:** `auth` ganha `role`, e `voipClients` passa a
`Map<actorId, { listener, sender, voiceMode, muted }>`.

```jsonc
// UI (index.html) — não manda o campo
{ "type": "auth", "actorId": 4278192658, "ticket": "…" }

// helper nativo — manda explicitamente
{ "type": "auth", "actorId": 4278192658, "ticket": "…", "role": "sender" }
```

**`listener` é o padrão, e isso não é só compatibilidade.** O `index.html` atual
não manda `role` e não precisa passar a mandar — mas o motivo de o padrão ser
esse é que *quem só escuta é um listener*. A compatibilidade cai fora como
consequência, em vez de custar um ramo de código só para ela.

### O que é por conexão e o que é por ator

Esta é a parte que decide o comportamento, e por isso está escrita aqui e não só
no código:

| Estado | Vive em | Por quê |
|---|---|---|
| socket, log de frame grande | conexão | é o socket que se comporta mal |
| `voiceMode` | ator | define o alcance com que a pessoa é ouvida; quem fala (helper) não é quem tem o seletor (UI) |
| `muted` | **ator** | ver abaixo |

**Mutar é do ator, não da conexão.** Se `muted` vivesse na conexão, o mute
clicado na UI valeria só para o socket da UI — e o helper continuaria
transmitindo. A pessoa se veria mutada na tela e seguiria sendo ouvida na cena.
Num controle de microfone esse é o pior defeito possível: não é perder uma
função, é a interface mentir sobre privacidade. Há teste travando isso.

### Auditoria dos call sites

Todos os pontos que assumiam uma conexão por ator:

- **`tickProximity`** — a posição é lida **uma vez por ator**, não por conexão.
  Iterar conexões faria um jogador com os dois papéis abertos entrar duas vezes
  na lista: apareceria duplicado no `proximity_update` dos outros e cada quadro
  seria entregue **em dobro** no `listener` dele — voz sobreposta a si mesma, que
  soa como flanger, não como defeito de rede. O `proximity_update` sai só para o
  `listener`: o `sender` não tem ganho para ajustar.
- **`relayAudioFrame`** — a audiência é sempre a conexão `listener` dos outros
  atores, nunca um `sender` deles (que descartaria). A audiência já exclui o
  próprio locutor, então o `listener` de quem fala não recebe a própria voz.
- **`close`** — limpa **só o slot daquele papel**, e só se ele ainda for daquele
  socket. Sem essa checagem de identidade, uma reconexão no mesmo papel se
  autodestrói: o `close` atrasado da conexão velha chega depois de a nova já
  estar registrada e apaga a nova. `peer_left` sai **só quando cai o
  `listener`** — fechar o helper significa parar de falar, não sair da cena;
  quem fecha a UI é que de fato saiu. A entrada do ator só é removida quando os
  dois papéis se foram.
- **`broadcast`** — entrega só a `listener`s. O que passa por ali hoje é
  `peer_left`, que existe para a UI desmontar o áudio de quem saiu; o helper não
  tem o que desmontar.
- **`offer`/`answer`/`ice`** — roteados para o `listener` do alvo. É o navegador
  que tem `RTCPeerConnection`.
- **`audio_frame`** — aceito de **qualquer** papel autenticado, de propósito. Os
  dois sockets provaram a mesma identidade pelo mesmo handshake, então exigir
  `sender` aqui não fecharia furo nenhum; só quebraria a sonda em Node e quem
  ainda autentica sem `role`. O relay continua usando a identidade autenticada,
  nunca o `fromActorId` que veio na mensagem.

### O ticket também virou por papel

`issueTicket` sobrescrevia o pendente daquele ator e o ticket é de uso único.
Consequência: o `/voz` que serve a UI **queima** o ticket que o helper usaria, e
os dois papéis nunca conseguem estar autenticados ao mesmo tempo. A chave passou
a ser `${actorId}:${role}` e um `/voz` emite os dois.

Sem isso a mudança em `voipClients` seria correta e **inútil** — o slot duplo
existiria e ninguém conseguiria ocupar os dois. Um ticket de um papel não vale no
outro, e há teste travando isso: os dois lados autenticam no mesmo endpoint com o
mesmo formato, e um token intercambiável faria o handshake parar de distinguir
exatamente o que esta seção acabou de separar.

### Testado por mutação

12 mutações, 12 reprovações — cada uma é um jeito plausível de errar a separação
de papéis: `peer_left` também ao sair o `sender`; `close` apagando a entrada
inteira; `close` sem conferir a identidade do socket; relay caindo no `sender`
quando não há `listener`; `mute` por conexão; tick iterando conexões; chave de
ticket ignorando o papel; `auth` aceitando qualquer papel; `proximity_update`
para qualquer socket aberto; `/voz` voltando a emitir um ticket só; exposição de
debug ligada por padrão; e o debug gravando o ticket errado.

Quatro delas **sobreviveram na primeira passada** e apontaram buracos reais nos
testes — faltava o caso do ator com **só** `sender` (que não pode receber nada) e
a asserção de duplicidade estava no ator errado (o que tinha um papel só, onde a
duplicação não aparece). Um quinto teste passava pelo motivo errado: emitia
ticket de `listener` e mandava `role: 'admin'`, então a recusa vinha da falta de
ticket, não da validação de papel — passaria igual com a validação removida.

## 11. Andaime temporário: exposição do ticket para teste manual

> ⚠️ **Isto é temporário e deve ser removido.** A Fase 3 (handoff automático,
> jogo → helper, sem intervenção manual — §9.2) substitui isto por completo. Ao
> implementá-la, apague a flag, a função `_exposeDebugTicket`, a entrada no
> `.gitignore` e esta seção.

**O problema.** O ticket emitido por `/voz` ia só para a property `voipTicket`,
lida pelo navegador do jogo. Não havia como um humano lê-lo — e sem lê-lo não há
como passar `--ticket` para o `voice-helper.exe`. Um testador não conseguia
sequer iniciar o teste.

**Escolhido:** `VOIP_DEBUG_EXPOSE_TICKET`, **padrão `false`**. Ligada, o `/voz`
também grava o ticket de `sender` em `skymp/gamemode/.voip-debug-ticket.json`
(ignorado no git) e loga em `warn` a linha de comando já montada.

**Por que atrás de flag e desligada por padrão.** Isso grava em disco, em texto
puro, uma credencial que autentica como aquele jogador na cena de voz. Os 30
segundos de TTL limitam o estrago, e ainda assim quem ler o arquivo dentro da
janela fala pela boca da pessoa. É aceitável numa bancada com um engenheiro
olhando, e em nenhum outro lugar. **Não entra em nenhum `.env.example`**: quem
precisa liga à mão e desliga depois.

Três decisões pequenas que valem registro:

1. **A flag é lida a cada chamada, não uma vez no load.** Uma flag que só pode
   ser desligada reiniciando o servidor é uma flag que alguém vai deixar ligada
   para não ter que reiniciar de novo. Custa um `process.env` por `/voz`, que é
   um comando humano.
2. **Só a string `'true'` liga.** `'1'`, `'yes'` e `'TRUE'` não ligam — o padrão
   seguro tem que ser o caso fácil.
3. **O ticket de `sender` é emitido sempre, esteja ou não exposto.** Emitir é
   barato (expira em 30s sem uso), e assim a **exposição** — que é a parte
   arriscada — fica sendo a única coisa atrás da flag.

O roteiro de uso está em [`FASE_0_ROTEIRO.md` §8.2](FASE_0_ROTEIRO.md), incluindo
o passo de desligar a flag no fim.
