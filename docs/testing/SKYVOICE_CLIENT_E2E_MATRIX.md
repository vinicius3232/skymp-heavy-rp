# Matriz E2E — cliente RTC do SkyVoice

**Data:** 2026-08-15
**Arquitetura:** [`ADR_006`](../technical/ADR_006_SKYVOICE_CLIENT_RTC.md) — cliente LiveKit no `voice-helper` (C++)
**Bancada:** [`spikes/skyvoice-livekit-cpp/`](../../spikes/skyvoice-livekit-cpp/)

## Como ler

**Coluna não executada fica vazia.** Não há "provavelmente passa" aqui — um
espaço em branco é informação, e preenchê-lo por otimismo é o que faz um projeto
achar que testou o que não testou.

| Marca | Significa |
|---|---|
| ✅ | Executado e passou, com número registrado |
| ❌ | Executado e falhou |
| — | **Não executado** |
| n/a | Não se aplica a esta camada |

**As colunas não são intercambiáveis.** "LiveKit real" é um SFU de verdade com
áudio medido; "Humano" é uma pessoa dizendo que entendeu a frase. Nenhuma
substitui a outra, e a última é a única que fecha o blocker #1.

---

## A matriz

| Caso | Unit | Integration | LiveKit real | Skyrim | Humano |
|---|:--:|:--:|:--:|:--:|:--:|
| Pairing | ✅ | ✅ | n/a | — | — |
| Auth (token do nosso emissor) | ✅ | ✅ | ✅ | — | — |
| Publish | — | — | ✅ | — | — |
| Subscribe | ✅ | ✅ | ✅ | — | — |
| A→B | — | — | ✅ | — | — |
| B→A | — | — | — | — | — |
| PTT | ✅ | ✅ | ✅ | — | — |
| Distance | ✅ | ✅ | — | — | — |
| Cell | ✅ | ✅ | — | — | — |
| Spatial | ✅ | ✅ | — | — | — |
| Reconnect | ✅ | ✅ | — | — | — |

---

## O que cada ✅ vale, com o número

### Auth — LiveKit real
Token emitido por `core/voice/livekit-token.js`, identidade
`actor-4278192641-spike01` derivada do `actorId`. Aceito por um `livekit-server`
1.13.5 real. O token do locutor leva `canSubscribe: false` e o do ouvinte
`canPublish: false` — nenhum dos dois é o token do outro.

### Publish — LiveKit real
`LocalAudioTrack` publicado com `TrackSource::SOURCE_MICROPHONE`. Dois modos
exercitados: tom sintético (`AudioSource`) e **microfone real** (`PlatformAudio`,
dispositivos `Logi C270 HD WebCam` e `Fuxi-H3` enumerados pelo ADM do WebRTC).

### Subscribe — LiveKit real
Com `auto_subscribe = false`: **0 quadros** antes de qualquer ordem. Depois do
`applySubscriptionDiff` do `livekit-gateway.js`: 250 quadros, RMS **0.21214**.
Depois da revogação: **0 quadros**. É a assinatura autoritativa medida por
efeito.

### A→B — LiveKit real
179 quadros, RMS **0.20540** (teórico do sinal: 0.2121), energia em 440 Hz
**5135×** a do controle em 1 kHz. Atravessou Opus e o SFU.

### PTT — LiveKit real
`LocalAudioTrack::mute()` → RMS **0.00000**, sem sair da sala e sem
renegociação. `unmute()` → RMS **0.21312**.

### Distance / Cell / Spatial / Reconnect — Unit e Integration
Cobertos pela suíte do Voice Core (PR #28: equivalência do índice espacial com a
força bruta em 400 atores × 3 raios × 4 tipos de espaço; equivalência entre
`canHear` e `audienceProbe` em >1000 comparações). São **regras de servidor**, e
é por isso que passam sem LiveKit — o transporte não participa da decisão.

---

## O que os vazios significam

**B→A — nada.** Só o sentido A→B foi medido. Inverter é trabalho de bancada, não
de arquitetura, mas continua não feito e por isso está vazio.

**Distance / Cell / Spatial contra LiveKit real — nada.** A decisão de audiência
foi provada contra o SFU (linha *Subscribe*), mas com uma aresta montada à mão.
Ligar o `voice-core` inteiro — posições, raios de `VOICE_RANGES`, células — a
clientes C++ reais é o terceiro spike do enunciado, e não foi feito.

**Reconnect contra LiveKit real — nada.** Há eventos (`onReconnecting`,
`onReconnected`, `onDisconnected`) ligados no spike, e nenhuma queda foi
provocada.

**A coluna Skyrim, inteira.** Nenhum client Skyrim jamais conectou a este
projeto. É o blocker #2, ambiental, e é o da Fase 0 inteira — não só o da voz.

**A coluna Humano, inteira.** É o blocker #1, aberto desde a Fase 1. O microfone
real foi capturado e transportado (300 quadros por janela de 3 s, RMS
0.0007–0.0036), mas era **ruído de sala** e **ninguém escutou**. "Chegou som" e
"entendi a frase" são coisas diferentes.

---

## Os 17 casos em Skyrim (§27 do enunciado)

Nenhum foi executado. Estão listados para que a lista exista antes de haver
tentação de resumi-la.

| # | Caso | Estado |
|---|---|---|
| 1 | whisper | — |
| 2 | normal | — |
| 3 | shout | — |
| 4 | aproximação | — |
| 5 | afastamento | — |
| 6 | fora do alcance | — |
| 7 | mesma posição, células diferentes | — |
| 8 | PTT | — |
| 9 | esquerda | — |
| 10 | direita | — |
| 11 | frente | — |
| 12 | atrás | — |
| 13 | DOWNED | — |
| 14 | DEAD | — |
| 15 | gagged | — |
| 16 | staff mute | — |
| 17 | reconnect | — |

---

## Diagnóstico esperado (§29–§30)

O spike já emite por etapa; o helper de produção deverá emitir o mesmo conjunto,
para que "não ouvi ninguém" tenha resposta melhor que `VOICE ERROR`.

```
MIC        OK    Logi C270 HD WebCam
PAIR       OK
AUTH       OK    actor-4278192641-spike01
ROOM       OK    skyvoice
PUBLISH    OK
TRACK      TR_AMvQTtcG9hVFgR
POLICY     ALLOWED
SUBSCRIBE  OK
RECEIVE    100 quadros/s
PLAYBACK   —
```

Duas leituras que **não** valem como diagnóstico verde, medidas nesta bancada:

- **`RECEIVE` alto com áudio mudo.** Durante o `mute()`, 250 quadros por janela
  chegaram com RMS 0.00000. Contagem de quadro não é evidência de voz.
- **`SUBSCRIBE OK` recém-emitido.** A ordem leva ~440 ms para fazer efeito na
  revogação (~70 ms no mute). Ler o estado colado ao comando mostra o mundo
  anterior.

---

## Como reproduzir

Pré-requisitos e build em
[`spikes/skyvoice-livekit-cpp/README.md`](../../spikes/skyvoice-livekit-cpp/README.md).

Transporte e PTT:

```bash
node run-spike.mjs
```

Assinatura autoritativa pelo gateway do gamemode:

```bash
node run-spike.mjs --control-plane
```

Microfone e fone reais — **precisa de uma pessoa**:

```bash
node run-spike.mjs --mic --playout
```
