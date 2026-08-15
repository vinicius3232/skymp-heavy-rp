# ADR 006 — O cliente RTC do SkyVoice vive no `voice-helper`

**Status:** aceita
**Data:** 2026-08-15
**Contexto:** Etapa 6 do SkyVoice, branch `feat/skyvoice-core-etapa-2`
**Substitui:** nada. **Complementa:** [`SKYVOICE_LIVEKIT_AUDIT.md`](SKYVOICE_LIVEKIT_AUDIT.md) §7.5
**Detalhamento:** [`SKYVOICE_CLIENT_ARCHITECTURE.md`](SKYVOICE_CLIENT_ARCHITECTURE.md)

## Contexto

O SkyVoice tinha servidor e não tinha cliente. O Voice Core decide quem ouve
quem, o `livekit-gateway.js` traduz isso para o SFU, e o `livekit-token.js` emite
credencial — mas **nenhum processo do lado do jogador publicava ou assinava
áudio no LiveKit**. O caminho que funcionava era o legado: PCM cru por WebSocket
retransmitido dentro do processo Node do gamemode, que não escala (≈5,3 Gbit/s
para 200 jogadores) e nunca foi ouvido por ninguém.

A pergunta desta ADR é uma só: **onde o cliente LiveKit do jogador é executado?**

Três candidatos: dentro do `voice-helper` nativo; dentro da CEF do jogo; ou num
sidecar RTC novo.

## Decisão

**O cliente LiveKit vive no `voice-helper`, em C++, com o
`livekit/client-sdk-cpp` v1.7.0 pré-compilado (Apache-2.0).**

O helper passa a capturar, publicar, assinar e tocar. A CEF fica com HUD, PTT,
status e preferências. O gamemode não transporta áudio.

O endpoint `cef-livekit` **continua declarado** em `voice-endpoint.js`. Os dois
endpoints são indistinguíveis no transporte, e é essa propriedade que permite
adicionar o caminho CEF depois sem um corte.

## Por quê

**1. É a única opção que pôde ser exercitada.** Contra um `livekit-server`
1.13.5 real, com tokens do nosso emissor e um cliente C++ compilado aqui:
9/9 verificações. B recebeu áudio de A (RMS 0.20540, 440 Hz a 5135× o controle);
o PTT por `mute()`/`unmute()` produziu silêncio exato e volta de sinal sem sair
da sala; e, com `auto_subscribe = false`, o ouvinte recebeu **0 quadros** até o
`livekit-gateway.js` conceder — e **0 de novo** depois de revogar. A CEF não pode
ser exercitada: nenhum client Skyrim jamais conectou neste projeto.

**2. O custo que reprovava esta opção deixou de existir.** A auditoria de 14/08
registrava o SDK C++ como 1.0.0 exigindo toolchain Rust e dando só acesso a
quadro cru. O release 1.7.0, de 11/08, traz binário Windows x64 pré-compilado
(11,1 MB), e `platform_audio.h` entrega captura **e** playout de dispositivo real
com AEC, supressão de ruído e AGC — três coisas que o caminho legado nunca teve.

**3. A infraestrutura já está paga.** O `voice-helper` compila em `/W4`, já
capturou microfone real, já tem pareamento loopback com segredo efêmero, guarda
de órfão e distribuição pelo launcher com versão e hash. Nenhuma máquina nova.

**4. Isolamento de crash já estava resolvido.** O helper já é um processo fora do
jogo. Voz que cai não derruba o jogador do servidor.

## Alternativas rejeitadas

### CEF recebe o áudio (Opção B)

Rejeitada. Tocar na CEF dispensa `getUserMedia`, mas não dispensa mexer no
`OnBeforeCommandLineProcessing` do client (autoplay) — ou seja, fork registrado,
build, assinatura e distribuição de client, o blocker #3 que segue aberto. Pior:
helper publicando e CEF assinando faz **cada jogador virar dois participantes**
com identidades distintas, e o `UpdateSubscriptions` endereça o ouvinte por
identidade — o Voice Core passaria a manter duas identidades por ator para
sempre. E colocaria a decodificação dentro do processo do jogo, contra a regra de
que falha de voz não é falha de jogo.

### Sidecar RTC separado (Opção C)

Rejeitada por não comprar nada. O benefício alegado é isolamento de crash, que o
helper já dá. E `@livekit/rtc-node` — a variante com binário pronto, que já roda
aqui — **não abre dispositivo de áudio**: ainda precisaria do helper para
microfone e fone, com PCM cru atravessando IPC entre dois processos e um runtime
Node (+50 MB) no instalador. Um terceiro processo, mais superfície, mesmo
benefício.

## Consequências

**Boas**
- AEC, supressão de ruído e AGC entram de graça; a auditoria §2.6 os listava como
  ausentes.
- O áudio sai do processo Node do gamemode.
- O PTT deixa de depender de concessão negociada no handshake: vira `mute()`
  local **mais** ausência de audiência no servidor.

**Custos aceitos**
- +26,3 MB de DLL por jogador (`livekit_ffi.dll` 23,4 MB, `livekit.dll` 2,9 MB).
- Espacialização é código nosso em C++.
- Mais uma dependência versionada a acompanhar, num SDK jovem (1.7.0 saiu quatro
  dias antes desta decisão). Versão pinada, SHA-256 registrado, sem `latest`.

**Dívidas abertas, com nome**
- **20 ms versus 10 ms.** O projeto inteiro fala quadros de 20 ms; o
  `captureFrame` direto do SDK aceita **só 10 ms**, e o AEC também. Achado
  rodando, não lendo. A migração terá que reenquadrar na fronteira.
- **Espacialização versus AEC.** Se misturarmos e espacializarmos fora do ADM, o
  AEC perde o sinal de referência. Há saída (`processReverseStream` alimentado à
  mão), não exercitada.
- **Binário sem assinatura** — mesma dívida do `voice-helper.exe` atual.

## Rollback

O `voice-helper` de produção **não foi alterado**. `VOICE_BACKEND` continua em
`legacy` por padrão e o caminho legado está intacto. Reverter é apagar
`spikes/skyvoice-livekit-cpp/` e os documentos; nada em produção depende deles.

## O que esta ADR não decide

Não declara a voz pronta. **Ninguém ouviu a voz deste projeto ainda** — o
microfone real foi capturado e transportado, medido em ruído de sala, e nenhuma
pessoa julgou se dá para entender uma frase. Esse continua sendo o blocker #1, e
nenhuma linha de código o fecha.
