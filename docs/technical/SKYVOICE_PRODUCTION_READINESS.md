# SkyVoice — relatório de prontidão para produção

**Data:** 2026-08-14
**Branch:** `feat/skyvoice-core-etapa-2`
**Etapa:** 4 (final de produção)

---

## VEREDITO

# ❌ NÃO É PRODUCTION-READY

**Motivo, em uma linha:** ninguém nunca ouviu a voz deste projeto, e nenhum
cliente Skyrim real jamais conectou a ele.

Os blockers #1 e #2 da Etapa 1 continuam abertos e **nada nesta etapa os toca** —
eles não são resolvíveis por código. Toda a Etapa 4 é preparação para o dia em
que forem resolvidos: segurança, deploy, launcher, observabilidade, diagnóstico,
administração, carga, confiabilidade.

**O que esta etapa entrega é um sistema pronto para ser testado com gente**, com
a superfície de segurança auditada e cinco defeitos reais corrigidos.

### O que a segunda rodada acrescentou (2026-08-14, tarde)

Um `livekit-server 1.13.5` real foi baixado, conferido por SHA-256 e executado
nesta máquina. Ele derrubou uma suposição que nenhum teste com `fetch` falso
poderia derrubar:

> **`UpdateSubscriptions` respondia `HTTP 200` e não assinava nada.**
> O circuito contava sucesso, a métrica contava `gateway.ok`, o painel mostrava
> `CONNECTED` — e a assinatura seletiva, que é a razão inteira de o LiveKit
> existir neste projeto, estava desligada. O sintoma em produção não seria "a voz
> quebrou"; seria a conta de banda, meses depois.

Isso reclassificou o SV-05 de 🟡 para 🔴 e é o achado mais importante da etapa.
Junto vieram: a correção, um teste de regressão que exercita o corpo antigo
contra o servidor de verdade, a persistência do silêncio de staff (SV-07), a
fiação de voz no `main.ts` do launcher, e a descoberta de que o `loadtest` e o
`soak` teriam **parado de medir a assinatura** em silêncio.

---

## 1. Tabela de features

Vocabulário restrito a **VERIFICADO · PARCIAL · NÃO TESTADO · BLOCKED**.

### 1.1 Segurança

| FEATURE | STATUS | TEST | RESULT | RISK |
|---|---|---|---|---|
| LiveKit token — formato e assinatura | VERIFICADO | `voice-auth-hardening.test.js` + spike Etapa 1 contra SFU real | Aceito por `livekit-server 1.13.5`; secret errado → 401 | Baixo |
| TTL do token de jogador (360 s) | VERIFICADO | teste de `exp - nbf` | 370 s com folga de relógio | Baixo |
| **Token de operador** (novo) | VERIFICADO | 8 casos | `roomJoin:false`, `roomAdmin:true`, TTL 60 s | Baixo |
| **Gateway fala com o SFU** (SV-01) | VERIFICADO | `verify:livekit`, 10/10 contra `livekit-server 1.13.5` | Chamada aceita, e com **efeito medido** | Baixo |
| Participant identity derivada no servidor | VERIFICADO | 5 casos | Identidade no `opts` é ignorada | Baixo |
| Actor binding | VERIFICADO | `resolveActor` recusa identidade não emitida | `actor-301-deadbeef` → `null` | Baixo |
| Character binding | VERIFICADO | leitura de `getActiveCharacterData` | Sem caminho de cliente | Baixo |
| Room permissions | VERIFICADO | teste de payload | `roomAdmin/Create/List` = `false` | Baixo |
| **Publish permissions** (SV-02) | VERIFICADO | 7 casos | Staff mute → `canPublish:false` no token, na sessão viva | Baixo |
| **Subscribe permissions** (SV-05) | VERIFICADO | 5 corpos testados contra SFU real, por **efeito** | Assina em 173 ms; desassina (300 → **0 quadros**) | Baixo |
| Spoofing | VERIFICADO | 4 casos | Formato bater não basta | Baixo |
| Replay | PARCIAL | TTL e `jti` testados | LiveKit não guarda `jti`; token vale até expirar | Médio |
| Unauthorized participants | VERIFICADO | `confirmConnected` | Identidade desconhecida recusada | Baixo |
| Microphone permission (CEF) | NÃO TESTADO | varredura de flags proibidas | Nenhuma flag insegura no código; handler **não compilado** | **Alto** |
| CEF origin restriction | PARCIAL | 5 casos de `checkOrigin` | Lógica ok; `Origin` ausente aceita (declarado) | Médio |
| Secrets — nunca no cliente | VERIFICADO | 4 camadas, 3 testadas | Varredura por valor, não por nome | Baixo |
| Environment variables | VERIFICADO | 17 casos | 9 regras; fatal derruba o boot | Baixo |
| **TLS** | NÃO TESTADO | auditoria exige `wss://` em produção | **Nada saiu de `127.0.0.1`** | **Alto** |

### 1.2 Gameplay de voz

| FEATURE | STATUS | TEST | RESULT | RISK |
|---|---|---|---|---|
| PTT | VERIFICADO | `voice-policy.test.js` | Concede, recusa, corta entre recomputes | Médio — nunca ouvido |
| Whisper / normal / shout | VERIFICADO | alcances derivados de `VOICE_RANGES` | Sem número escrito à mão | Médio — nunca ouvido |
| Proximity | VERIFICADO | equivalência com força bruta, 400 atores | Idêntico ao laço O(n²) | Médio — nunca ouvido |
| Spatial audio | VERIFICADO | `voice-spatial.test.js`, frente/trás separados de L/R | Matemática correta | **Alto** — percepção nunca validada |
| Cell isolation | VERIFICADO | coordenadas idênticas em células distintas | Sem rota | Baixo |
| Gameplay states (morto/abatido/amordaçado) | VERIFICADO | varredura de 64 pares × 5 superfícies | Vereditos idênticos | Médio |
| Oclusão nível 1 (célula) | VERIFICADO | 7 casos | Ativo | Baixo |
| Oclusão nível 2 (portas) | NÃO TESTADO | encaixe testado, sem provedor | Sem tabela de portas | Baixo |
| Oclusão nível 3 (raycast) | BLOCKED | — | Não há API de raycast no servidor | — |
| Reconnect | VERIFICADO | 3 casos de falha | Identidade preservada | Médio |
| **Voz inteligível a um ouvido humano** | **BLOCKED** | — | **Blocker #1** | **Crítico** |

### 1.3 Operação

| FEATURE | STATUS | TEST | RESULT | RISK |
|---|---|---|---|---|
| Métricas (10 `voice_*`) | VERIFICADO | 17 casos | Prometheus + `logLine()`; sem identificador de pessoa | Baixo |
| SkyAdmin — 13 campos de diagnóstico | VERIFICADO | 20 casos | Todos presentes; motivo incluído | Baixo |
| SkyAdmin — Staff Mute | VERIFICADO | matriz de permissão por cargo | Audit log obrigatório | Baixo |
| SkyAdmin — Voice Disconnect | VERIFICADO | idem | Tira voz, não tira do jogo | Baixo |
| SkyAdmin — Force Reconnect | VERIFICADO | idem | Identidade preservada, grants recalculados | Baixo |
| SkyAdmin — Diagnostics | VERIFICADO | idem | **A consulta também é auditada** | Baixo |
| Audit log em toda ação | VERIFICADO | 12 casos na matriz | Inclusive tentativas falhas | Baixo |
| **Staff mute sobrevive ao restart** (SV-07) | VERIFICADO | 9 casos + `migration-v16` | Expira na leitura; banco fora não impede a punição | Baixo |
| Launcher — manifesto e integridade | VERIFICADO | 34 casos | Hash ausente aborta; HTTPS obrigatório | Baixo |
| Launcher — rollback | VERIFICADO | teste dedicado | Local à frente do publicado **desce** | Baixo |
| Launcher — startup/shutdown do helper | PARCIAL | lógica 34 casos; `main.ts` typecheck limpo | **Fiação feita**, nunca executada (exige Electron) | Médio |
| **Launcher — handoff de credencial** | **BLOCKED** | lógica testada | **Lado C++ (`--pair`) não existe** | **Alto** |
| Deploy reproduzível | PARCIAL | binário `livekit-server 1.13.5` subiu e serviu 2 clientes | **`docker compose up` nunca executado** (Docker não sobe nesta máquina) | **Alto** |
| Health checks | VERIFICADO | `GET /` → `200 OK` | Mesmo endpoint que o compose usa | Baixo |
| Self-hosted ↔ Cloud sem tocar gameplay | PARCIAL | leitura de código | Nenhum módulo de regra importa transporte | Baixo |

### 1.4 Privacidade

| FEATURE | STATUS | TEST | RESULT | RISK |
|---|---|---|---|---|
| Não gravar voz | VERIFICADO | varredura de código + ausência de Egress | 2 camadas | Baixo |
| Não persistir frames | VERIFICADO | varredura de `writeFileSync` perto de áudio | Nenhum | Baixo |
| Não logar conteúdo | VERIFICADO | código de erro higienizado, 48 chars | Sem texto livre | Baixo |
| Mostrar mic ativo | VERIFICADO | teste do HUD (Etapa 3) | Chip `MIC · <modo>` | Baixo |
| PTT padrão | VERIFICADO | `transmitting:false` inicial + `--ptt` | 2 camadas | Médio (SV-06) |
| Câmera proibida | VERIFICADO | `canPublishSources` + varredura de flags | Controle no spike: 10 s vs 65 ms | Baixo |
| Output volume | VERIFICADO | `sanitizeVoicePreferences` | Local, 0..1 | Baixo |
| **Output device** | **BLOCKED** | — | **`setSinkId` é Chromium 110; a CEF é 108** | — |
| Lista de microfones / mic test | NÃO TESTADO | — | Só pelo helper (WASAPI); não implementado | Médio |
| **Não existe rádio** | VERIFICADO | varredura de 5 padrões em 19 arquivos | Nenhuma ocorrência | Baixo |

### 1.5 Confiabilidade

| FEATURE | STATUS | TEST | RESULT | RISK |
|---|---|---|---|---|
| LiveKit restart | VERIFICADO | `voice-failure.test.js` | Circuito abre, jogo segue, volta sozinho | Baixo |
| Perda de rede | VERIFICADO | 20 ticks com rede morta | Nenhum lançou | Baixo |
| Latência alta / timeout | VERIFICADO | chamada que nunca responde | Abortada em < 2 s | Baixo |
| Token expiry | VERIFICADO | renovação | Identidade preservada | Baixo |
| Client crash | VERIFICADO | detach sem aviso | Boca fecha, estado sai | Baixo |
| SkyMP disconnect | VERIFICADO | durante a fala | Sem rota órfã | Baixo |
| CEF reload | VERIFICADO | attach duplo | Uma pessoa, uma sessão | Baixo |
| Packet loss | VERIFICADO | quadros param, PTT apertado | Sweep fecha a boca | Baixo |
| Reconnect loop | VERIFICADO | 100 ciclos + 30 flaps | Zero vazamento; circuito não abre | Baixo |
| **VOICE FAILURE ≠ GAME FAILURE** | **VERIFICADO** | **15 casos, detector de `unhandledRejection` em todos** | **Nenhum derruba o processo** | Baixo |
| Memory leaks | VERIFICADO | soak 12 000 ciclos | Heap plano (+0.008 MB/amostra) | Baixo |
| Stale participants | VERIFICADO | soak, volta ao repouso | 0 sessões | Baixo |
| Stale subscriptions | VERIFICADO | idem | 0 assinaturas | Baixo |
| Stale VoiceState | VERIFICADO | idem | 0 atores | Baixo |
| **AudioNode leaks** | **NÃO TESTADO** | — | **É CEF; exige o jogo aberto** | **Alto** |

---

## 2. Os números medidos

### 2.1 Maior população efetivamente testada

# 200 jogadores SIMULADOS

**Nunca com jogadores reais. Nunca com áudio. Nunca com um SFU.**

O que rodou: 200 atores sintéticos, num mundo falso, com o Voice Core real
decidindo rotas, sessões, estado de fala e assinaturas — dentro de um único
processo Node, com o SFU substituído por um `fetchImpl` que sempre responde OK.

### 2.2 Latência do servidor (recompute) — `npm run loadtest:voice`

Node v25.5.0 · win32 x64 · **400 ciclos por ponto**

Medido **depois** da correção do SV-05 — o gateway agora resolve `identity →
trackSid` e manda `track_sids`, então estes números incluem o custo real da
assinatura seletiva.

| Cenário | n=25 p95 | n=50 p95 | n=100 p95 | **n=200 p95** |
|---|---|---|---|---|
| **A** espalhados pelo mapa | 0.052 ms | 0.089 ms | 0.161 ms | **0.238 ms** |
| **B** cidade | 0.077 ms | 0.161 ms | 0.335 ms | **0.858 ms** |
| **C** evento concentrado | 0.134 ms | 0.301 ms | 1.361 ms | **5.456 ms** |
| **D** muitos falando | 0.164 ms | 0.447 ms | 1.699 ms | **6.139 ms** |
| **E** churn de alcance/célula | 0.086 ms | 0.146 ms | 0.324 ms | **0.568 ms** |

```
  Pior recompute p95:                  6.139 ms  (n=200, cenário D)
  Orçamento (25% do tick de 150 ms):  37.500 ms  → CABE, com ~6× de folga
  Idade máxima de rota:              156.139 ms  → dentro da faixa 100–250 ms
```

⚠️ **Há variância grande entre execuções, e ela é maior que a diferença entre
versões do código.** A rodada anterior desta mesma tabela deu 11.73 ms no cenário
D; esta deu 6.14 ms. **Isso não é ganho de desempenho da correção** — é uma
máquina sem isolamento de CPU medindo duas vezes. O que as duas rodadas
sustentam é a ordem de grandeza (unidades de milissegundo) e a folga
confortável para o orçamento. **Os dígitos depois da vírgula não são citáveis.**

### 2.3 CPU e RAM — SkyMP (n=200, 400 ciclos)

| Cenário | CPU* | Δheap | Assinaturas | Churn/ciclo |
|---|---|---|---|---|
| A | 126% | 0.0 MB | 1 | 0.0 |
| B | 120% | 0.4 MB | 288 | 10.0 |
| C | 117% | 2.4 MB | **5 443** | 86.9 |
| D | 104% | −1.5 MB | 4 020 | **121.2** |
| E | 119% | 1.8 MB | 19 | 25.6 |

Δheap negativo é GC coletando mais do que o cenário alocou — não é memória
"recuperada" pelo teste, é ruído do coletor, e é a razão de o soak medir
**tendência** e não delta pontual.

\* `process.cpuUsage()` soma todas as threads do processo, incluindo GC. Acima de
100% é o coletor rodando em paralelo com o recompute — **não** é "o laço de voz
usa 2 núcleos".

**Soak (12 000 ciclos, ~80 jogadores, rotatividade real):**

```
  Heap inicial:   7.84 MB
  Heap final:     9.05 MB   (em repouso, todo mundo desconectado)
  Tendência:     +0.0086 MB por amostra de 500 ciclos   → plano
  Estruturas em repouso: TODAS em zero
  Churn de assinatura:  19 739
  Reconexões:              279
  Erros de servidor durante o soak: 0
```

O soak passou a manter uma **sala de SFU falso viva** — participantes entram,
saem e trocam de identidade ao reconectar. Sem isso, a correção do SV-05 teria
deixado o soak medindo um regime em que nenhuma assinatura acontece: o gateway
resolve `identity → trackSid` por `ListParticipants`, e um `fetch` falso que não
responde a essa chamada devolve registro vazio e **zero** chamadas de
assinatura. O mesmo vale para o `loadtest`, corrigido junto.

### 2.4 Banda — **ESTIMADA, não medida**

Aritmética a partir do número de assinaturas e do bitrate nominal do codec.

| | Cenário C, n=200 |
|---|---|
| Locutores simultâneos | 37 |
| Assinaturas ouvinte→locutor | 5 443 |
| **Legado — total no processo do gamemode** | **5 597 Mbit/s** |
| LiveKit — subida (Opus) | 1.2 Mbit/s |
| LiveKit — descida (sai do SFU) | 174.2 Mbit/s |

# ⚠️ O GARGALO ARQUITETURAL

**O relay legado precisaria de ~5,6 Gbit/s dentro do processo Node do gamemode
para servir um evento de 200 pessoas.** Não é uma questão de otimização: é PCM
cru a 48 kHz mais 33% de base64, re-serializado por destinatário, multiplicado
por 5 443 assinaturas.

Isso **decide a arquitetura**: o caminho legado não escala para o alvo de 200
jogadores, e nenhuma quantidade de ajuste o faz escalar. O LiveKit não é
preferência — é o único caminho aritmeticamente viável, e a diferença é de uma
ordem e meia de grandeza (5 597 → 174 Mbit/s), com a descida saindo do SFU e não
do processo que também move NPCs.

A economia depende inteiramente da assinatura seletiva funcionar — e é
exatamente ela que **não funcionava** até o SV-05 ser medido. Com o corpo
antigo, o LiveKit entregaria todas as faixas a todo mundo e a descida do SFU
seria da mesma ordem do relay legado, com todos os indicadores verdes.

**Este número é conta, não medição.** O que ele prova é que a conta não fecha;
ele não prova quanto o LiveKit realmente consome.

---

## 3. O que NÃO foi medido, e portanto NÃO é declarado

| Grandeza | Por quê |
|---|---|
| **CPU do LiveKit** | O SFU rodou com **2 participantes**, não com carga |
| **RAM do LiveKit** | idem |
| **Banda real** | Os números da §2.4 são aritmética |
| **CPU do cliente** | Exige o jogo aberto (blocker #2) |
| **CPU da CEF** | idem |
| **FPS** | idem |
| **Packet loss** | Nada saiu de `127.0.0.1` |
| **RTT** | idem |
| **Jitter** | idem |
| **Latência de voz ponta a ponta** | Captura + codec + SFU + rede — nenhuma medida |
| **AudioNode leaks no cliente** | É CEF; `window.voiceStats()` está instrumentado, não lido |

**O `loadtest:voice` mede o SkyMP como autoridade de voz.** Não é um teste de
carga do sistema de voz completo, e não autoriza declarar suporte a 200
jogadores reais.

---

## 4. Gargalo encontrado

**Um, e é decisivo:** a banda do relay legado (§2.4).

Em segundo lugar, e dentro do orçamento: os cenários C (evento concentrado) e D
(muitos falando) são quadráticos por natureza — com 200 pessoas em alcance
mútuo, a resposta **é** quadrática e nenhuma estrutura de dados a torna menor.
~11.7 ms de p95 cabem nos 37.5 ms disponíveis, com folga de 3,2×. O índice
espacial continua sendo mais
lento que o laço O(n²) nessa topologia, e continua sendo a escolha certa porque
os cenários A, B e E — que são a operação normal — ganham de 10× a 40×.

---

## 5. Regressões

**Nenhuma.**

| | Antes | Depois |
|---|---|---|
| Testes do gamemode | 1135/1135 | **1270/1270** |
| `npm run typecheck` | limpo | limpo |
| `npm run bench:voice` | sai 0 | sai 0 |
| `npm run soak:voice` | passa | passa |
| Testes do launcher | 1 arquivo | 2 arquivos, **71/71** |
| `tsc -b` do launcher | limpo | limpo |

135 testes acrescentados nesta etapa, mais 10 verificações contra um SFU real.

**Três testes existentes foram alterados, e nenhum para "fazer passar".**

Dois em `livekit-gateway.test.js`: ambos travavam o corpo
`participant_tracks: [{participant_sid: <identity>}]`, que a medição contra o
`livekit-server` real provou **não fazer nada** (`HTTP 200`, zero assinaturas). O
teste antigo não podia pegar isso — ele afirmava o corpo que o código montava, e
o código montava o corpo errado. O corpo antigo virou **caso de regressão** em
`verify-livekit-contract.mjs`, onde é exercitado contra o servidor de verdade.

O terceiro é o caso "fetch que LANÇA vira estado": com o SFU fora, quem morre
primeiro agora é a recarga do registro, antes de qualquer assinatura sair. A
promessa do módulo — nunca rejeitar, falha vira estado — continua afirmada; o
que mudou foi qual campo carrega a verdade (`refreshFailed` em vez de
`failures`).

Duas correções de método foram feitas em instrumentos, antes de qualquer número
ser citado:

1. **O `loadtest` e o `soak` teriam parado de medir a assinatura.** Os dois usam
   um `fetch` falso que devolvia `{ok:true}` sem `json()`. Com o gateway
   resolvendo `identity → trackSid` por `ListParticipants`, esse falso devolve
   registro vazio, toda aresta vira `unresolved` e **nenhuma chamada de
   assinatura sai** — os scripts continuariam imprimindo números, de um regime
   que não existe. Os dois ganharam uma sala de SFU falso com participantes de
   verdade; no soak ela é **viva**, com entrada, saída e troca de identidade na
   reconexão.
2. A linha "não há `livekit-server` nesta máquina" saiu do `loadtest`: deixou de
   ser verdade. O motivo real de ele não medir CPU do SFU é que o SFU ali é um
   `fetch` falso, não um processo.

---

## 6. Riscos restantes

| # | Risco | Gravidade | Estado |
|---|---|---|---|
| 1 | **Ninguém ouviu a voz** | 🔴 **Crítico** | Blocker #1, aberto desde a Fase 1 |
| 2 | **Nenhum cliente Skyrim conectou** | 🔴 **Crítico** | Blocker #2, ambiental |
| 3 | **Nenhum cliente do jogo fala LiveKit** | 🔴 Alto | A UI é só o caminho legado. A assinatura seletiva foi provada com `@livekit/rtc-node`, não com a CEF |
| 4 | Nada exercitado fora de `127.0.0.1` | 🔴 Alto | TLS, TURN, CGNAT, jitter |
| 5 | Handoff de credencial: lado C++ não existe | 🔴 Alto | Launcher **fiado e typechecked**, helper não |
| 6 | `CefPermissionHandler` não compilado | 🔴 Alto | Plano A é desenho |
| 7 | `docker compose` nunca executado | 🟠 Alto | O **binário** subiu e serviu 2 clientes; a composição não |
| 8 | AudioNode leaks no cliente | 🟠 Alto | Instrumentado, não lido |
| 9 | Microfone aberto sem `--ptt` (SV-06) | 🟠 Médio | Mitigado pelo launcher, não pelo helper |
| 10 | Fiação de voz do launcher nunca executada | 🟠 Médio | Exige Electron; typecheck limpo, lógica coberta |
| 11 | Replay de token dentro do TTL | 🟡 Médio | Mitigado por identidade única |
| 12 | Output device impossível na CEF 108 | 🟡 Baixo | `setSinkId` é Chromium 110 |
| 13 | Animação de fala com nomes não conferidos | 🟡 Baixo | Nasce desligada |
| ~~3~~ | ~~`UpdateSubscriptions` com corpo duvidoso (SV-05)~~ | ✅ | **Fechado** — medido contra SFU real, corrigido, com teste de regressão |
| ~~10~~ | ~~Silêncio de staff não persiste (SV-07)~~ | ✅ | **Fechado** — `migration-v16`, expira na leitura |

---

## 7. Cleanup de legado — **NADA REMOVIDO**

A instrução condicionava a remoção a "depois de todos os gates validados". **Os
gates não foram validados** — os blockers #1 e #2 estão abertos —, então a
avaliação foi feita e a remoção não.

| Candidato | Veredito | Por quê |
|---|---|---|
| **WebRTC P2P** (`createPeerConnection`, `initiateCall`, `handleOffer`) | **manter** | Nunca produziu áudio, mas é o único caminho para quem não tem o helper. Removê-lo antes de o launcher distribuir o helper deixa esse jogador sem nada |
| **`audio_frame` / PCM relay** | **manter** | É o **único caminho de captura provado** do projeto (598 quadros, 50,1/s, 0 descartes). O LiveKit não capturou áudio nenhuma vez |
| **base64 no transporte** | **manter** | Sai junto com o `audio_frame`; sozinho é uma otimização de 33% num caminho que vai embora inteiro |
| **Signaling antigo** (`offer`/`answer`/`ice`) | **manter** | Acoplado ao WebRTC P2P |
| **`VOIP_DEBUG_EXPOSE_TICKET`** | **manter no código, PROIBIDO em produção** | É o único handoff que funciona hoje. `VOICE-SEC-001` derruba o boot se ele estiver ligado em produção — que é a remoção que importa |
| **`voice-helper`** | **manter** | Base do Plano B e a única captura provada |

**A regra aplicada:** não remover o que ainda é fallback validado. O caminho
legado é o **único** que já produziu áudio real; o LiveKit é o único que já
provou transporte. Apagar um antes de o outro estar completo trocaria dois
sistemas meio-provados por um sistema não-provado.

Nenhuma documentação histórica foi apagada.

---

## 8. Checklist de production-ready

| # | Exigência | Estado |
|---|---|---|
| 1 | dois clients reais testados | ❌ **BLOCKED** |
| 2 | múltiplos clients testados | ❌ **BLOCKED** |
| 3 | PTT funcionando | ⚠️ PARCIAL — por teste, não por ouvido |
| 4 | whisper | ⚠️ PARCIAL — idem |
| 5 | normal | ⚠️ PARCIAL — idem |
| 6 | shout | ⚠️ PARCIAL — idem |
| 7 | proximity | ⚠️ PARCIAL — idem |
| 8 | spatial audio | ⚠️ PARCIAL — matemática ✅, percepção ❌ |
| 9 | cell isolation | ✅ VERIFICADO |
| 10 | gameplay states | ✅ VERIFICADO |
| 11 | reconnect | ✅ VERIFICADO |
| 12 | microphone security | ⚠️ PARCIAL — handler não compilado |
| 13 | auth | ✅ VERIFICADO |
| 14 | metrics | ✅ VERIFICADO |
| 15 | SkyAdmin | ✅ VERIFICADO |
| 16 | launcher | ⚠️ PARCIAL — fiado e typechecked; handoff C++ BLOCKED |
| 17 | load test | ⚠️ PARCIAL — 200 simulados, 2 reais |
| 18 | soak test | ✅ VERIFICADO |
| 19 | failure tests | ✅ VERIFICADO |
| 20 | documentação | ✅ VERIFICADO |

**8 verificados · 9 parciais · 3 bloqueados.** Nenhum sistema com três bloqueios
críticos é production-ready.

O que esta rodada mudou não foi a contagem: foi a **qualidade da evidência** de
um item que estava contado como parcial e escondia um defeito de gravidade alta.
Nenhum dos três bloqueios se moveu, porque nenhum deles é resolvível por código.

---

## 9. A ordem para a próxima etapa

Sem inventar trabalho novo. Os três primeiros destravam tudo o mais.

1. **Uma pessoa escuta.** Passo 6 da etapa 8.2 do `FASE_0_ROTEIRO.md`. Bancada,
   `voice-helper.exe` que já compila, um par de fones. **Destrava o blocker #1**,
   que é pré-requisito de literalmente todo o resto.
2. **Dois clientes Skyrim reais conectam.** Blocker #2. Roda os checklists de
   bancada da Etapa 2 §11 e da Etapa 3 §11.3.
3. **Medir o cliente** — CPU da CEF, FPS, `window.voiceStats()`. É a única parte
   da Etapa 3 que ficou por fazer, e a única forma de fechar o risco #8.
4. **`--control-port`/`--pair` no `voice-helper` (C++).** O launcher já gera o
   segredo, passa os argumentos, escreve o config e desliga o helper antes do
   jogo. Falta só o lado que lê. Fecha o handoff automático e permite proibir o
   `VOIP_DEBUG_EXPOSE_TICKET` de vez.
5. **Um cliente do jogo que fale LiveKit, com `autoSubscribe: false`.** Sem essa
   configuração, a assinatura seletiva corrigida no SV-05 não decide nada — o
   SFU entrega tudo na entrada. É requisito de conexão, e é o risco #3.
6. **Subir o `deploy/livekit/` por `docker compose`.** O binário já foi
   exercitado e o health check já responde; o que falta é a composição, com TLS,
   TURN e firewall. Fecha o risco #7.
7. **Um teste de carga com clientes reais**, começando em 5/10/20 — não em 200.
   `lk load-test` do `livekit-cli` para o lado do SFU, e o
   `npm run loadtest:voice` para o lado do gamemode.
8. **Só então** considerar `VOICE_BACKEND=livekit` em ambiente fechado.

---

## 10. A regra arquitetural, inalterada

```
   LiveKit  =  transporte de mídia
   SkyMP    =  autoridade do mundo
   SkyVoice =  gameplay de voz
```

Nada nesta etapa a moveu. O teste que mais a defende é
`voice-failure.test.js` → *"com o SFU inteiro fora, a REGRA de quem ouve quem
continua certa"*: com o transporte morto, a vedação entre células continua
valendo e quem está perto continua sendo ouvido. O que para é a otimização de
banda, não a regra de mundo.

**E não existe sistema de rádio por voz neste projeto.** Nem direta nem
indiretamente. Há teste automatizado varrendo 19 arquivos.

---

## Fontes

**Internas:** [`SKYVOICE_SECURITY_AUDIT.md`](SKYVOICE_SECURITY_AUDIT.md) ·
[`SKYVOICE_DEPLOYMENT.md`](SKYVOICE_DEPLOYMENT.md) ·
[`SKYVOICE_CORE_ETAPA_3.md`](SKYVOICE_CORE_ETAPA_3.md) ·
[`SKYVOICE_CORE_ETAPA_2.md`](SKYVOICE_CORE_ETAPA_2.md) ·
[`SKYVOICE_LIVEKIT_AUDIT.md`](SKYVOICE_LIVEKIT_AUDIT.md) ·
[`FASE_0_ROTEIRO.md`](FASE_0_ROTEIRO.md)

**Reproduzir os números:**

```bash
cd skymp/gamemode
npm test                    # 1270/1270
npm run typecheck           # limpo
npm run bench:voice         # sai 0
npm run loadtest:voice      # §2.2, §2.3, §2.4
npm run soak:voice          # §2.3, sai 0
```

O contrato contra o SFU real, que exige um `livekit-server` de pé:

```bash
livekit-server --dev --bind 127.0.0.1
```

```bash
cd skymp/gamemode && npm run verify:livekit
```

E o launcher:

```bash
cd apps/launcher && npm test && npm run typecheck
```
