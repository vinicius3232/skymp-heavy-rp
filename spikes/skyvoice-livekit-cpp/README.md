# SPIKE — cliente LiveKit em C++

> **Isto é um spike, não é produção.** Ele não vive dentro do `voice-helper/` de
> propósito: arrasta o SDK C++ do LiveKit, que o helper ainda não arrasta.
> Misturar os dois faria o único caminho de captura provado do projeto passar a
> depender de um SDK que ainda não tinha provado nada.

Ele responde as perguntas que decidiram a arquitetura do cliente. Ver
[`docs/technical/SKYVOICE_CLIENT_ARCHITECTURE.md`](../../docs/technical/SKYVOICE_CLIENT_ARCHITECTURE.md)
e [`ADR_006`](../../docs/technical/ADR_006_SKYVOICE_CLIENT_RTC.md).

## O que ele prova

Medido contra um `livekit-server` 1.13.5 real, com tokens emitidos pelo módulo
do gamemode (`core/voice/livekit-token.js`):

| Verificação | Medido |
|---|---|
| B recebe áudio de A pelo SFU | 179 quadros, RMS **0.20540** |
| O sinal é o que A mandou | 440 Hz **5135×** o controle em 1 kHz |
| PTT solto (`mute()`) → silêncio | RMS **0.00000**, sem sair da sala |
| PTT apertado (`unmute()`) → volta | RMS **0.21312** |
| **Sem ordem do servidor, B não ouve** | **0 quadros** |
| Depois do `UpdateSubscriptions` do gateway | 250 quadros, RMS **0.21214** |
| Depois da revogação | **0 quadros** |
| Microfone real capturado e transportado | 300 quadros/3 s, RMS 0.0007–0.0036 |

O último item é ruído de sala, não fala julgada por ninguém — ver abaixo.

## O que ele NÃO prova

- **Voz inteligível a um ouvido humano.** Continua sendo o blocker #1 do
  projeto, aberto desde a Fase 1. Nenhum número aqui o fecha.
- Qualquer coisa dentro do **Skyrim**. Nenhum client jamais conectou.
- Rede real: fora de `127.0.0.1` não há latência, perda, jitter, TURN nem NAT.

## Duas armadilhas que ele registra

**1. Quadro que chega não é áudio que chega.** Durante o `mute()`, B continuou
recebendo **250 quadros** por janela com RMS **0.00000**. Contar quadros e
concluir "está passando voz" teria dado verde num sistema mudo. Por isso toda
verificação aqui olha RMS e energia em 440 Hz, não contagem.

**2. A ordem não vale no mesmo instante.** `mute()` deixa ~70 ms de áudio em voo;
`UpdateSubscriptions` de revogação deixa ~440 ms, porque desfaz a assinatura e
renegocia. Medir colado ao comando reprova comportamento correto — e, fora do
spike, significa que soltar o PTT ou sair do alcance não emudece no mesmo quadro.

## Pré-requisitos

**SDK.** Baixe `livekit-sdk-windows-x64-1.7.0.zip` do
[release oficial](https://github.com/livekit/client-sdk-cpp/releases/tag/v1.7.0)
e descompacte onde quiser. Ele **não** é versionado aqui: são 26 MB de DLL.

SHA-256 conferido nesta bancada em 14/08/2026:

```
bed6a0a50943c5217ed0769213467fb1354d6b2f3770655ead5cc6b55944928a
```

> O release do LiveKit **não publica `checksums.txt`** para este projeto (o
> `livekit-server` publica). O valor acima é o que esta máquina baixou por
> HTTPS do repositório oficial, registrado para que uma troca silenciosa
> apareça. Não é uma assinatura do fornecedor.

**Toolchain.** MSVC 2022 (BuildTools serve), CMake ≥ 3.21, vcpkg. **Não** é
preciso Rust: o binário pré-compilado já traz o `livekit_ffi`.

**SFU.** `livekit-server` oficial, checksum conferido contra o `checksums.txt`
da release.

```yaml
# livekit-spike.yaml
port: 7880
bind_addresses: [127.0.0.1]
rtc:
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 50060
  use_external_ip: false
keys:
  skyvoice_spike: <um segredo qualquer para a bancada>
```

## Build

```bash
cmake -S . -B build -A x64 -DCMAKE_TOOLCHAIN_FILE=C:/vcpkg/scripts/buildsystems/vcpkg.cmake -DLIVEKIT_SDK_ROOT=<caminho do SDK descompactado>
```

```bash
cmake --build build --config Release
```

Compila limpo em `/W4`. As DLLs são copiadas para junto do executável no
post-build — sem isso o processo morre sem mensagem nenhuma.

## Rodar

Com o `livekit-server` no ar noutro terminal:

```bash
LIVEKIT_URL=ws://127.0.0.1:7880 LIVEKIT_API_KEY=skyvoice_spike LIVEKIT_API_SECRET=<o mesmo> node run-spike.mjs
```

Plano de controle — o ouvinte entra sem assinar nada e só ouve depois de o
`livekit-gateway.js` mandar:

```bash
LIVEKIT_URL=ws://127.0.0.1:7880 LIVEKIT_API_KEY=skyvoice_spike LIVEKIT_API_SECRET=<o mesmo> node run-spike.mjs --control-plane
```

Microfone e fone reais — **este precisa de uma pessoa**, e é o que fecha o
blocker #1:

```bash
LIVEKIT_URL=ws://127.0.0.1:7880 LIVEKIT_API_KEY=skyvoice_spike LIVEKIT_API_SECRET=<o mesmo> node run-spike.mjs --mic --playout
```

Sai `0` se todas as verificações passarem. O modo humano não tem veredito
automático de propósito: "chegou som" e "entendi a frase" são coisas diferentes,
e só a segunda conta.

## Como ele é dirigido

Nenhum segredo entra por `argv` — mesma regra dura do `voice-helper`. O runner
Node emite os tokens com o módulo do gamemode e escreve **uma linha de JSON** no
stdin do binário. Depois conduz por comandos (`MEASURE <ms>`, `MUTE`, `UNMUTE`,
`QUIT`), o que permite ao `livekit-gateway.js` conceder a assinatura **entre duas
medições** — a diferença entre elas é a prova.
