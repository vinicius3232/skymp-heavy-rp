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
a superfície de segurança auditada e três defeitos reais corrigidos.

---

## 1. Tabela de features

Vocabulário restrito a **VERIFICADO · PARCIAL · NÃO TESTADO · BLOCKED**.

### 1.1 Segurança

| FEATURE | STATUS | TEST | RESULT | RISK |
|---|---|---|---|---|
| LiveKit token — formato e assinatura | VERIFICADO | `voice-auth-hardening.test.js` + spike Etapa 1 contra SFU real | Aceito por `livekit-server 1.13.5`; secret errado → 401 | Baixo |
| TTL do token de jogador (360 s) | VERIFICADO | teste de `exp - nbf` | 370 s com folga de relógio | Baixo |
| **Token de operador** (novo) | VERIFICADO | 8 casos | `roomJoin:false`, `roomAdmin:true`, TTL 60 s | Baixo |
| **Gateway fala com o SFU** (SV-01) | PARCIAL | teste com `fetchImpl` falso | Chamada sai com JWT correto; **nunca contra SFU real** | **Alto** — ver SV-05 |
| Participant identity derivada no servidor | VERIFICADO | 5 casos | Identidade no `opts` é ignorada | Baixo |
| Actor binding | VERIFICADO | `resolveActor` recusa identidade não emitida | `actor-301-deadbeef` → `null` | Baixo |
| Character binding | VERIFICADO | leitura de `getActiveCharacterData` | Sem caminho de cliente | Baixo |
| Room permissions | VERIFICADO | teste de payload | `roomAdmin/Create/List` = `false` | Baixo |
| **Publish permissions** (SV-02) | VERIFICADO | 7 casos | Staff mute → `canPublish:false` no token, na sessão viva | Baixo |
| Subscribe permissions | PARCIAL | token ✅; `UpdateSubscriptions` ✗ | Formato do corpo não verificado | **Alto** |
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
| Launcher — manifesto e integridade | VERIFICADO | 34 casos | Hash ausente aborta; HTTPS obrigatório | Baixo |
| Launcher — rollback | VERIFICADO | teste dedicado | Local à frente do publicado **desce** | Baixo |
| Launcher — startup/shutdown do helper | PARCIAL | `helperArgs`, `shutdownOrder` testados | Fiação no `main.ts` pendente | Médio |
| **Launcher — handoff de credencial** | **BLOCKED** | lógica testada | **Lado C++ (`--pair`) não existe** | **Alto** |
| Deploy reproduzível | NÃO TESTADO | — | **Nenhum `docker compose up` executado** | **Alto** |
| Health checks | NÃO TESTADO | — | Definidos, nunca executados | Médio |
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

| Cenário | n=25 p95 | n=50 p95 | n=100 p95 | **n=200 p95** | n=200 máx |
|---|---|---|---|---|---|
| **A** espalhados pelo mapa | 0.067 ms | 0.111 ms | 0.155 ms | **0.389 ms** | 0.949 ms |
| **B** cidade | 0.075 ms | 0.203 ms | 0.362 ms | **1.182 ms** | 5.774 ms |
| **C** evento concentrado | 0.132 ms | 0.288 ms | 1.743 ms | **11.693 ms** | 20.827 ms |
| **D** muitos falando | 0.243 ms | 0.604 ms | 2.615 ms | **11.734 ms** | 21.916 ms |
| **E** churn de alcance/célula | 0.116 ms | 0.215 ms | 0.402 ms | **0.784 ms** | 5.422 ms |

```
  Pior recompute p95:                  11.734 ms  (n=200, cenário D)
  Orçamento (25% do tick de 150 ms):   37.500 ms  → CABE, com 3,2× de folga
  Idade máxima de rota:               161.734 ms  → dentro da faixa 100–250 ms
```

⚠️ **Há variância entre execuções.** Uma rodada de 200 ciclos deu p95 de 10.75 ms
no cenário C e 0.586 ms no A; a de 400 ciclos, acima, deu 11.69 ms e 0.389 ms. A
ordem de grandeza é estável e a folga para o orçamento é grande; **os dígitos
depois da vírgula não são.** Citar estes números como precisos seria dar a eles
uma confiança que uma única máquina, sem isolamento de CPU, não sustenta.

### 2.3 CPU e RAM — SkyMP (n=200, 400 ciclos)

| Cenário | CPU* | Δheap | Assinaturas | Churn/ciclo |
|---|---|---|---|---|
| A | 183% | 0.0 MB | 1 | 0.0 |
| B | 122% | 0.7 MB | 287 | 9.9 |
| C | 106% | 4.1 MB | **5 117** | 82.4 |
| D | 104% | −2.9 MB | 3 833 | **116.7** |
| E | 97% | 2.0 MB | 14 | 21.4 |

Δheap negativo é GC coletando mais do que o cenário alocou — não é memória
"recuperada" pelo teste, é ruído do coletor, e é a razão de o soak medir
**tendência** e não delta pontual.

\* `process.cpuUsage()` soma todas as threads do processo, incluindo GC. Acima de
100% é o coletor rodando em paralelo com o recompute — **não** é "o laço de voz
usa 2 núcleos".

**Soak (12 000 ciclos, ~80 jogadores, rotatividade real):**

```
  Heap inicial:   7.81 MB
  Heap final:     8.95 MB   (em repouso, todo mundo desconectado)
  Tendência:     +0.0081 MB por amostra de 500 ciclos   → plano
  Estruturas em repouso: TODAS em zero
  Erros de servidor durante o soak: 0
```

### 2.4 Banda — **ESTIMADA, não medida**

Aritmética a partir do número de assinaturas e do bitrate nominal do codec.

| | Cenário C, n=200 |
|---|---|
| Locutores simultâneos | 37 |
| Assinaturas ouvinte→locutor | 5 117 |
| **Legado — total no processo do gamemode** | **5 264 Mbit/s** |
| LiveKit — subida (Opus) | 1.2 Mbit/s |
| LiveKit — descida (sai do SFU) | 163.7 Mbit/s |

# ⚠️ O GARGALO ARQUITETURAL

**O relay legado precisaria de ~5,3 Gbit/s dentro do processo Node do gamemode
para servir um evento de 200 pessoas.** Não é uma questão de otimização: é PCM
cru a 48 kHz mais 33% de base64, re-serializado por destinatário, multiplicado
por 5 117 assinaturas.

Isso **decide a arquitetura**: o caminho legado não escala para o alvo de 200
jogadores, e nenhuma quantidade de ajuste o faz escalar. O LiveKit não é
preferência — é o único caminho aritmeticamente viável, e a diferença é de uma
ordem e meia de grandeza (5 264 → 164 Mbit/s), com a descida saindo do SFU e não
do processo que também move NPCs.

**Este número é conta, não medição.** O que ele prova é que a conta não fecha;
ele não prova quanto o LiveKit realmente consome.

---

## 3. O que NÃO foi medido, e portanto NÃO é declarado

| Grandeza | Por quê |
|---|---|
| **CPU do LiveKit** | Não há `livekit-server` nesta máquina |
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
| Testes do gamemode | 1135/1135 | **1253/1253** |
| `npm run typecheck` | limpo | limpo |
| `npm run bench:voice` | sai 0 | sai 0 |
| Testes do launcher | 1 arquivo | 2 arquivos, **+34 casos** |

118 testes acrescentados nesta etapa. Nenhum teste existente foi alterado para
passar; as duas mudanças em `permissions.behavior.test.js` foram **acréscimos**
(três ações novas na matriz, e a injeção do diagnóstico).

Duas correções de método foram feitas em instrumentos **desta etapa**, antes de
qualquer número ser citado:

1. O soak acusou 42 MB de vazamento que era do próprio script — um laço síncrono
   nunca devolve o controle ao event loop, e as promessas de
   `applySubscriptionDiff` se acumulavam sem resolver. Com o laço drenando, como
   um servidor real drena entre ticks, o heap ficou plano. O mesmo defeito foi
   corrigido no `loadtest`.
2. A coluna de memória do `loadtest` reportava RSS, que é do processo e não
   encolhe entre cenários — o cenário E carregava o pico do C. Trocada por
   `Δheap` com GC forçado dos dois lados.

---

## 6. Riscos restantes

| # | Risco | Gravidade | Estado |
|---|---|---|---|
| 1 | **Ninguém ouviu a voz** | 🔴 **Crítico** | Blocker #1, aberto desde a Fase 1 |
| 2 | **Nenhum cliente Skyrim conectou** | 🔴 **Crítico** | Blocker #2, ambiental |
| 3 | `UpdateSubscriptions` com corpo de formato duvidoso (SV-05) | 🔴 Alto | Sem SFU para verificar |
| 4 | Nada exercitado fora de `127.0.0.1` | 🔴 Alto | TLS, TURN, CGNAT, jitter |
| 5 | Handoff de credencial: lado C++ não existe | 🔴 Alto | Launcher pronto, helper não |
| 6 | `CefPermissionHandler` não compilado | 🔴 Alto | Plano A é desenho |
| 7 | Deploy nunca executado | 🟠 Alto | `deploy/livekit/` é ponto de partida |
| 8 | AudioNode leaks no cliente | 🟠 Alto | Instrumentado, não lido |
| 9 | Microfone aberto sem `--ptt` (SV-06) | 🟠 Médio | Mitigado pelo launcher, não pelo helper |
| 10 | Silêncio de staff não persiste (SV-07) | 🟠 Médio | Superfície **aumentou** com SV-02 |
| 11 | Replay de token dentro do TTL | 🟡 Médio | Mitigado por identidade única |
| 12 | Output device impossível na CEF 108 | 🟡 Baixo | `setSinkId` é Chromium 110 |
| 13 | Animação de fala com nomes não conferidos | 🟡 Baixo | Nasce desligada |

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
| 16 | launcher | ⚠️ PARCIAL — handoff BLOCKED |
| 17 | load test | ⚠️ PARCIAL — 200 simulados, 0 reais |
| 18 | soak test | ✅ VERIFICADO |
| 19 | failure tests | ✅ VERIFICADO |
| 20 | documentação | ✅ VERIFICADO |

**8 verificados · 9 parciais · 3 bloqueados.** Nenhum sistema com três bloqueios
críticos é production-ready.

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
4. **`--control-port`/`--pair` no `voice-helper` (C++).** Fecha o handoff
   automático, remove o último passo manual e permite proibir o
   `VOIP_DEBUG_EXPOSE_TICKET` de vez.
5. **Subir o `deploy/livekit/` de verdade** e validar `UpdateSubscriptions`
   contra ele. Fecha SV-05 e o risco #7 juntos.
6. **Um teste de carga com clientes reais**, começando em 5/10/20 — não em 200.
   `lk load-test` do `livekit-cli` para o lado do SFU, e o
   `npm run loadtest:voice` para o lado do gamemode.
7. **Persistir o silêncio de staff**, se a operação disser que faz falta.
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
npm test                    # 1253/1253
npm run typecheck           # limpo
npm run bench:voice         # sai 0
npm run loadtest:voice      # §2.2, §2.3, §2.4
npm run soak:voice          # §2.3, sai 0
cd ../../apps/launcher && npm test
```
