# voice-helper

Executável Windows que captura o microfone **fora do navegador embutido do
client SkyMP** e envia os quadros para o `voip-service` do gamemode, que
retransmite por proximidade.

Existe porque o CEF do client não libera `getUserMedia`, e a flag do Chromium que
liberava foi **removida de propósito** na SkyrimPlatform 2.1 — revertê-la
exporia o microfone do jogador a qualquer servidor SkyMP que ele conectasse
depois. A arquitetura e o porquê estão em
[`docs/technical/VOICE_NATIVE_HELPER.md`](../docs/technical/VOICE_NATIVE_HELPER.md).

> ✅ **Compilado e executado em 07/08/2026.** O primeiro build de verdade passou
> (MSVC 19.44, CMake 4.4.2, vcpkg 2026-07-27) e o helper **capturou áudio real**:
> 50,1 quadros/s contra 50 nominal, enquadramento exato, zero descartes. Números
> e o erro de link que apareceu no caminho: VOICE_NATIVE_HELPER.md §8.3 e §8.4.
>
> ⚠️ **Ainda ninguém escutou.** Que a captura entrega sinal está medido; que a
> voz sai **inteligível** não — isso precisa de uma pessoa (§8.2). É o passo 6 da
> etapa 8.2 do `FASE_0_ROTEIRO.md`.

## Limitações desta fase (deliberadas)

- ~~**O ticket é passado à mão**, por linha de comando.~~ **Resolvido em
  14/08/2026.** O helper tem um canal de controle em loopback (`--control-port`
  + `--pair`) e recebe o ticket por POST, sem passar por humano nem por disco.
  Ver SKYVOICE_E2E_ETAPA_5.md §3. O modo de linha de comando continua existindo
  para bancada.
  **O que ainda falta é o mensageiro:** quem deveria fazer esse POST é a CEF, e
  o `index.html` ainda não o faz (§4 do mesmo documento).
- ~~**O helper e a UI do mesmo jogador não coexistem.**~~ **Resolvido em
  07/08/2026.** O `auth` passou a levar `role` (`listener` para a UI, `sender`
  para o helper) e o `voip-service` guarda as duas conexões por ator. O helper
  manda `role: "sender"` sozinho — não há nada a fazer na linha de comando. Ver
  VOICE_NATIVE_HELPER.md §10.
- **Sem UI, sem bandeja, sem serviço.** É um processo de terminal; sai com Ctrl+C.
- **Sem cancelamento de eco.** Use fone, ou sua voz volta pra cena.
- **PCM cru** (~1 Mbit/s de subida). Opus fica pra Fase 2.

## Compilar

Requisitos: Windows, Visual Studio 2022 (workload "Desenvolvimento para desktop
com C++"), CMake ≥ 3.21 e vcpkg.

**0. Se a máquina não tiver o toolchain** (é o caso da máquina de
desenvolvimento até 07/08/2026 — ver VOICE_NATIVE_HELPER.md §8.1). Cada comando
pede elevação; o primeiro baixa ~5–8 GB e demora:

```bash
winget install --id Microsoft.VisualStudio.2022.BuildTools --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

```bash
winget install --id Kitware.CMake
```

Depois abra um terminal novo (o PATH só vale a partir dele) e confirme com
`where cmake` e `where cl` antes de seguir. Se `cl` não aparecer, use o
"Developer Command Prompt for VS 2022" em vez do terminal comum.

**1. vcpkg, se ainda não houver**

```bash
git clone https://github.com/microsoft/vcpkg C:/vcpkg
```

```bash
C:/vcpkg/bootstrap-vcpkg.bat
```

**2. Configurar** (a partir de `voice-helper/`). O `vcpkg.json` está em modo
manifesto: as dependências (`miniaudio`, `ixwebsocket`, `nlohmann-json`) são
baixadas e compiladas nesta etapa, sem `vcpkg install` separado.

```bash
cmake -B build -S . -DCMAKE_TOOLCHAIN_FILE=C:/vcpkg/scripts/buildsystems/vcpkg.cmake -DVCPKG_TARGET_TRIPLET=x64-windows
```

**3. Compilar**

```bash
cmake --build build --config Release
```

O binário sai em `build/Release/voice-helper.exe`.

Isso também compila `reframe-10ms-test.exe` — lógica pura de reenquadramento
de PCM (20ms → 10ms), sem depender de miniaudio nem de ixwebsocket. Roda com
`ctest` ou direto:

```bash
build/Release/reframe-10ms-test.exe
```

Se alguma port não resolver, **anote o erro exato em VOICE_NATIVE_HELPER.md §8
antes de trocar de biblioteca** — a decisão de usar `miniaudio` está registrada
com motivo, e trocá-la em silêncio apagaria o motivo junto.

**O que de fato aconteceu no primeiro build (07/08/2026).** As três ports
resolveram com os nomes que já estavam no `vcpkg.json`.

A falha que este README antecipava — símbolo duplicado do `miniaudio` se a port
viesse pré-compilada — **não aconteceu**: a port é header-only (instala só o
`miniaudio.h`), então o `#define MINIAUDIO_IMPLEMENTATION` está certo e o
`find_path` do `CMakeLists.txt` é o caminho correto.

O erro real foi no **link**, e de outra dependência:

```
mbedcrypto.lib(entropy_poll.c.obj) : error LNK2019: símbolo externo não
resolvido, BCryptGenRandom
```

O `ixwebsocket` arrasta `mbedtls`, que precisa de `bcrypt.lib` no Windows —
mesmo sem usarmos TLS. Corrigido adicionando `bcrypt` ao `target_link_libraries`.
Detalhe em VOICE_NATIVE_HELPER.md §8.3.

## Rodar

Dois modos, e eles são exclusivos — misturar argumentos dos dois é erro de
argumento, não uma escolha silenciosa.

### Modo pareado (o que o launcher usa)

```bash
voice-helper.exe --control-port 51997 --pair <segredo> --ptt --parent-pid <pid do launcher>
```

| Argumento | Obrigatório | Padrão | O quê |
|---|---|---|---|
| `--control-port` | sim | — | porta de loopback do canal de controle |
| `--pair` | sim | — | segredo desta execução do launcher (≥ 16 chars) |
| `--control-host` | não | `127.0.0.1` | só aceita loopback; existe para ser explícito |
| `--pair-ttl` | não | `43200` | validade do pareamento, em segundos |
| `--ptt` | não | desligado | declara que este cliente é governado por push-to-talk |
| `--parent-pid` | não | — | o helper sai quando esse processo morrer |
| `--log-level` | não | `info` | |

Aqui **não se passa ticket**: ele não existe ainda quando o launcher sobe o
helper. Quem o entrega é a CEF, por:

```bash
curl -X POST http://127.0.0.1:51997/ticket \
  -d '{"pair":"<segredo>","actorId":4278194194,"ticket":"<token>","host":"127.0.0.1","port":7778}'
```

O microfone **só abre depois desse POST**, e fecha quando a sessão cai.

### Modo direto (bancada)

```bash
voice-helper.exe --actor-id 0xFF000A12 --ticket 753f03d8fa3c944a4c7b1dff7e7a08fb --host 127.0.0.1 --port 7778
```

| Argumento | Obrigatório | Padrão | O quê |
|---|---|---|---|
| `--actor-id` | sim | — | formID do ator, decimal ou `0x`-hex |
| `--ticket` | sim | — | token de uso único emitido pelo `/voz` |
| `--host` | não | `127.0.0.1` | host do `voip-service` |
| `--port` | não | `7778` | porta do `voip-service` |

**O ticket vale 30 segundos e serve uma vez só.** Auth recusada quase sempre é
ticket vencido entre o `/voz` e o comando — rode `/voz` de novo e use o novo.

O servidor precisa estar com `ENABLE_VOIP_SERVICE=true`.

## Testar sem compilar nada

`tools/` tem as duas ferramentas que validaram a Fase 1. As duas usam o `ws` do
gamemode; nenhuma tem `node_modules` próprio.

**Harness** — sobe o `voip-service` real com posições falsas e serve o
`index.html` de verdade:

```bash
node voice-helper/tools/e2e-harness.js --voip-port 7778 --http-port 8099
```

> ⚠️ O harness emite ticket de voz para qualquer `actorId` que pedir, **sem
> autenticação** — é exatamente o furo que o handshake por ticket fecha. Só em
> `127.0.0.1`, em máquina de desenvolvimento.

Rotas: `/` (a UI), `/ticket?actorId=&role=`, `/move?actorId=&x=&y=&z=`, `/state`.

O `role` do `/ticket` é `listener` (padrão, o que a página busca) ou `sender` (o
que a sonda e o helper usam). São tickets diferentes de propósito — um não serve
no lugar do outro, e é isso que deixa os dois papéis do mesmo jogador conectados
ao mesmo tempo. Ver VOICE_NATIVE_HELPER.md §10.

**Sonda** — fala o mesmo protocolo do helper, com um tom de 440Hz no lugar do
microfone. É o que isola falha de captura de falha de transporte:

```bash
node voice-helper/tools/frame-probe.js --actor-id 0xFF000A12 --ticket <token de sender> --seconds 10
```

```bash
node voice-helper/tools/frame-probe.js --listen --actor-id 0xFF000A13 --ticket <token de listener>
```

O papel segue o modo: gerando tom ela autentica como `sender` (o que o helper
faz), com `--listen` como `listener` (o que a UI faz). `--role` força o contrário,
pra testar o lado errado de propósito. Peça ao harness o ticket do papel certo —
`/ticket?actorId=0xFF000A12&role=sender` — ou a auth é recusada.

Roteiro completo do teste e os números medidos: VOICE_NATIVE_HELPER.md §7.

## Formato do fio

PCM 16-bit little-endian, mono, 48kHz, quadros de 20ms (960 amostras = 1920
bytes → 2560 chars em base64).

O mesmo formato aparece em três arquivos e os três precisam concordar; divergir
faz o áudio sair em velocidade errada em vez de falhar limpo:

- `src/main.cpp` — `kSampleRate`, `kChannels`, `kFrameMs`
- `skymp/gamemode/voip-service.js` — `AUDIO_SAMPLE_RATE`, `AUDIO_CHANNELS`, `AUDIO_FRAME_MS`
- `skymp/ui/index.html` — `RELAY_SAMPLE_RATE`
