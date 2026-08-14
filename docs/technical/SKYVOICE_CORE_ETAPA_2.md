# SkyVoice — Etapa 2: o Voice Core

**Data:** 2026-08-14
**Branch:** `research/skymp-upstream-boundary-2026-08-14`
**Escopo:** transformar o spike da Etapa 1 num sistema de voz local, modular e
autoritativo. **Não** é produção, e nada aqui deve ser lido como se fosse.

## Como ler as marcas

Mesma convenção da [auditoria da Etapa 1](SKYVOICE_LIVEKIT_AUDIT.md).

| Marca | Significa |
|---|---|
| **VERIFICADO** | Executado nesta máquina, com número. |
| **INFERIDO** | Deduzido de evidência forte, sem execução. |
| **PLANEJADO** | Decisão tomada, sem código. |
| **NÃO TESTADO** | Não exercitado. |

> **Ninguém ouviu a voz deste projeto ainda.** O blocker #1 da Etapa 1 continua
> aberto e nenhuma linha desta etapa o fecha — ele precisa de duas máquinas com
> Skyrim e de um par de ouvidos. Ver §10.

> **Não existe rádio por voz neste projeto.** Não há frequência, canal, PTT de
> rádio, rádio de facção nem `VoiceRadioService`. A única faixa lógica é
> `voice.local`, e a constante que a nomeia tem um comentário dizendo isto.

---

## 0. O que a verificação prévia encontrou

Antes de tocar em código, as cinco perguntas da tarefa:

| Pergunta | Resposta |
|---|---|
| Commits da etapa anterior | `462963e`, `469ad16`, `6fa3a55` — lidos |
| Relatório técnico | `SKYVOICE_LIVEKIT_AUDIT.md` — lido |
| Testes | `npm test` → **840/840**, batendo com o relatório. **VERIFICADO** |
| **Qual endpoint foi validado?** | **Nenhum dos dois.** Ver abaixo |
| **Dois clientes transmitem áudio?** | **Sim no SFU, não no jogo.** Ver abaixo |

### 0.1 O endpoint validado não é `cef-livekit` nem `voice-helper+livekit`

A pergunta oferecia duas opções e a resposta honesta é **uma terceira**: o spike
da Etapa 1 usou `@livekit/rtc-node` — **dois processos Node** — contra um
`livekit-server` real. Nenhum dos dois endpoints do `voice-endpoint.js` foi
exercitado; os dois continuam `implemented: false` no código.

O que aquilo provou foi o **transporte e o token**, que é real e é o que
permitiu esta etapa existir. O que não provou foi **captura**: nem pela CEF, nem
pelo `voice-helper`.

### 0.2 "Dois clientes transmitindo áudio" depende do que conta como cliente

- **Dois participantes LiveKit trocando áudio pelo SFU:** **VERIFICADO** na
  Etapa 1 — 253 quadros, RMS 0.2121 através do Opus, seletividade em frequência
  de 220×.
- **Dois clientes Skyrim reais:** **NÃO TESTADO.** Continua sendo o blocker #2.

### 0.3 Os blockers críticos da etapa anterior não são resolvíveis por código

| # | Blocker | Estado | Por quê |
|---|---|---|---|
| 1 | Ninguém nunca ouviu a voz | **ABERTO** | Precisa de pessoa e de fones |
| 2 | Nenhum client Skyrim conectou | **ABERTO** | Ambiental — bloqueio da Fase 0 inteira |
| 3 | Nenhum build da SkyrimPlatform | **ABERTO** | Exige fork registrado + build + distribuição |
| 4 | Handoff automático de credencial | **ABERTO** | `VOIP_DEBUG_EXPOSE_TICKET` continua lá |
| 5 | Nada fora de `127.0.0.1` | **ABERTO** | Precisa de duas máquinas em redes distintas |

Os quatro primeiros exigem hardware, um humano ou uma decisão de projeto
(distribuir client próprio). Esta etapa entregou o **checklist de teste humano**
(§11) que destrava #1 e #2, que é o que dá para fazer daqui.

O #4 foi deliberadamente **não** resolvido: o handoff automático de credencial
troca o transporte legado por outro caminho, e mexer nisso no mesmo commit que
refatora a proximidade tornaria impossível separar as duas causas se algo
quebrasse na bancada.

---

## 1. Arquitetura final do Voice Core

```
                    ┌──────────────────────────────────────┐
                    │  SkyMP (mp.get locationalData)       │
                    │  ── a ÚNICA fonte de posição ──      │
                    └──────────────┬───────────────────────┘
                                   │ sample()  ← única fronteira com o mundo
                                   ▼
┌───────────────────────────────────────────────────────────────────────┐
│  VoiceCore  (core/voice/voice-core.js)                                │
│  · lê o mundo    · controla o tempo    · liga os módulos              │
│                                                                       │
│   tick espacial 150 ms ──┐        ┌── markCritical() (imediato)       │
│                          ▼        ▼                                   │
└──────────────────────────┬────────────────────────────────────────────┘
                           │
     ┌─────────────────────┼──────────────────────┬─────────────────────┐
     ▼                     ▼                      ▼                     ▼
┌──────────┐      ┌─────────────────┐   ┌──────────────────┐  ┌──────────────┐
│VoiceState│◄─────│  VoicePolicy    │   │ VoiceSpatialIndex│  │ VoiceMetrics │
│          │      │  canSpeak       │   │ space → buckets  │  │ contadores   │
│voiceMode │      │  canListen      │   │ forEachWithin    │  │ p50/p95/máx  │
│muted     │      │  canHear        │   └────────┬─────────┘  └──────────────┘
│PTT       │      │  audienceProbe  │            │
│connection│      │  pttDown/pttUp  │◄───────────┘
└──────────┘      └────────┬────────┘
                           │              ┌─────────────────────────────┐
                           ▼              │ core/proximity-ranges.js    │
                  ┌─────────────────┐     │ FONTE ÚNICA de whisper/     │
                  │VoiceRouteEngine │◄────│ normal/shout — chat e voz   │
                  │ audiência       │     └─────────────────────────────┘
                  │ rotas + DIFF    │
                  └────────┬────────┘
                           │
          ┌────────────────┴─────────────────┐
          ▼                                  ▼
┌──────────────────┐              ┌─────────────────────┐
│  voip-service    │              │ VoiceLiveKitGateway │
│  (relay legado)  │              │ UpdateSubscriptions │
│  WS + PCM        │              │ circuito + estados  │
└──────────────────┘              └─────────────────────┘
                                            │
                                  ┌─────────▼──────────┐
                                  │  VoiceSession      │
                                  │  identity/token/   │
                                  │  reconnect/cleanup │
                                  └────────────────────┘
```

### 1.1 A divisão de autoridade, sem exceção

O servidor decide **tudo** o que a tarefa listou, e o cliente não tem caminho
para nenhum deles:

| O que | Onde é decidido | Como o cliente participa |
|---|---|---|
| `actorId` | handshake por ticket (`voip-service`) | apresenta um ticket que o servidor emitiu |
| `characterId` | `commands.getActiveCharacterData` | não participa |
| posição | `VoiceCore.sample()` → `mp` | não participa |
| proximidade | `VoiceRouteEngine` | não participa |
| cell / worldspace | `range-utils.getCell(loc)` | não participa |
| `voiceMode` | `VoicePolicy.requestVoiceMode` | **pede**; valor fora de `VOICE_RANGES` é recusado |
| permissões | `VoicePolicy.canSpeak/canListen` | não participa |
| PTT | `VoicePolicy.pttDown` | **pede**; recusado se `canSpeak` disser não |

**O furo que isto fechou** — o `voip-service` fazia:

```js
case 'voice_mode':
  voipClients.get(clientActorId).voiceMode = msg.mode || 'normal';
```

`msg.mode` é string arbitrária do socket. `'radio'` passava, virava
`VOICE_RANGES['radio'] === undefined`, e `calcVolume` devolvia `NaN` — que não é
`> 0`. O cliente conseguia se tornar **inaudível** de um jeito que a UI dele não
mostrava e nenhum log registrava. Hoje `setVoiceMode` recusa e devolve o motivo,
sem tocar no estado anterior. Travado por teste. **VERIFICADO**

---

## 2. Módulos criados

Todos em `skymp/gamemode/core/voice/`. Os nomes seguem os sugeridos na tarefa,
com uma diferença explicada em §3.

| Módulo | Linhas | Responsabilidade |
|---|---|---|
| `voice-metrics.js` | 190 | Contadores e durações (p50/p95/máx) por janela circular |
| `voice-state.js` | 260 | Estado por ATOR: `voiceMode`, `muted`, PTT, conexão, personagem |
| `voice-policy.js` | 400 | `canSpeak` / `canListen` / `canHear` / `audienceProbe` / PTT |
| `voice-spatial-index.js` | 245 | `space → bucket(x,y)`; substitui o laço O(n²) |
| `voice-route-engine.js` | 265 | Audiência, rotas por ouvinte e **diff** de assinaturas |
| `voice-session.js` | 415 | Binding SkyMP↔LiveKit: identidade, token, reconnect, cleanup |
| `livekit-gateway.js` | 350 | `UpdateSubscriptions`/`RemoveParticipant` + circuito |
| `voice-core.js` | 470 | Raiz de composição: lê o mundo, controla o tempo |

E `skymp/gamemode/scripts/bench-voice-proximity.js` (280) — a medição de §5.

### 2.1 Estados de conexão

Os cinco pedidos, em `voice-state.CONNECTION_STATES`, espelhados em
`livekit-gateway.GATEWAY_STATES` de propósito (mesmo vocabulário nos dois
níveis):

```
DISABLED ──open()──► CONNECTING ──confirmConnected()──► CONNECTED
   ▲                     │                                  │
   │                     └──markFailed()──► FAILED          │
   │                                          │             │
   └──────── close() ───────────┬─────────────┴── markReconnecting()
                                │                           │
                                └──────  RECONNECTING  ──────┘
```

`DISABLED` **não é falha**: é o estado de um servidor que não configurou
LiveKit — a maioria hoje — e mantê-lo distinto de `FAILED` é o que impede "voz
não configurada" de aparecer no log como incidente.

---

## 3. Onde o desenho divergiu da sugestão, e por quê

### 3.1 `worldspace → cell` é UM nível no SkyMP, não dois

A prioridade pedida era **worldspace → cell/instância → buckets espaciais**. No
SkyMP os dois primeiros são **o mesmo campo**: `locationalData` expõe um único
`cellOrWorldDesc`, um FormDesc `"162e2:Skyrim.esm"`, que é o *worldspace* num
exterior e a *célula* num interior. **VERIFICADO** em `types/mp.d.ts` e em
`core/range-utils.getCell`, que já é a lista completa dos nomes que essa
informação pode ter.

Então a hierarquia real é `space → bucket(x, y)`. Inventar um terceiro nível a
partir de um campo inexistente daria uma árvore mais simétrica e uma chave
sempre igual à do nível de baixo. O `space` já entrega a propriedade que
importa: **dois espaços diferentes nunca são comparados**, e a separação entre
dois interiores e a separação entre dois worldspaces saem da mesma linha.

O seletor de espaço é injetável (`spaceOf`) para o dia em que o upstream expuser
os dois separadamente.

### 3.2 Grade uniforme, não quadtree

Buckets de tamanho fixo em `Map`: O(1) para inserir, O(k) para consultar. Uma
quadtree daria o mesmo assintótico com rebalanceamento, alocação por nó e um
caso ruim de gente empilhada no mesmo ponto — que é exatamente a taverna cheia.
A instrução pedia evitar estrutura desnecessariamente complexa.

### 3.3 Uma sala LiveKit, não uma por célula

Uma sala por célula tornaria o isolamento **estrutural** em vez de calculado — o
que soa melhor — e custaria uma reconexão WebRTC completa a cada porta
atravessada, com renegociação ICE e um buraco de áudio de segundos numa ação que
no jogo leva um quadro. O isolamento é feito pelas **assinaturas**, que mudam
sem derrubar transporte.

---

## 4. Sistema legado restante

**Nada foi removido.** O que mudou é que o legado deixou de ser o dono das
regras.

| O quê | Estado | Sai quando |
|---|---|---|
| Relay WS + PCM cru + base64 | **ativo, é o caminho padrão** | LiveKit assumir o transporte |
| WebRTC P2P no `index.html` (`offer`/`answer`/`ice`) | **ativo, nunca produziu áudio** | Houver caminho de captura distribuído |
| `VOIP_DEBUG_EXPOSE_TICKET` + `_exposeDebugTicket` | **ativo, desligado por padrão** | Handoff automático de credencial (blocker #4) |
| `voice-helper/` (WASAPI) | **ativo, é a única captura provada** | Nunca — é a base do Plano B |
| `voice-endpoint.js` (a costura) | **ativo** | Nunca — é o que permite decidir A vs B depois |

### 4.1 A dívida que esta etapa criou, nomeada

**Microfone aberto por compatibilidade.** PTT é o padrão do servidor, e o Voice
Core recusa transmitir de quem não apertou. O `voice-helper.exe` que já existe e
já capturou áudio real **não fala esse protocolo** — ele autentica e começa a
mandar quadros.

Exigir PTT dele agora silenciaria o único caminho de captura provado do projeto,
para fechar um furo que esse caminho sempre teve. Então o handshake **negocia**:

```js
{ type: 'auth', actorId, ticket, ptt: true }   // → governado pelo PTT
{ type: 'auth', actorId, ticket }              // → concessão permanente + aviso
```

O servidor loga, uma vez por ator:

```
[voip] Actor 0x… autenticou sem declarar 'ptt: true'.
       Microfone aberto por compatibilidade com o voice-helper legado.
```

**Isto é dívida registrada, não desenho.** Some quando o helper aprender
`ptt_down`/`ptt_up`. O caminho LiveKit **não tem** esta concessão. **VERIFICADO**
por teste.

---

## 5. Latência de proximidade medida

`npm run bench:voice` — **VERIFICADO**, Node v25.5.0, 200 iterações por caso.

### 5.1 Recompute, p95, por topologia e população

| n | espalhada | densa | mista | legado O(n²) espalhada |
|---|---|---|---|---|
| 10 | 0.021 ms | 0.045 ms | 0.021 ms | 0.023 ms |
| 50 | 0.068 ms | 1.042 ms | 0.165 ms | 0.071 ms |
| 100 | 0.255 ms | 3.747 ms | 0.320 ms | 0.436 ms |
| **200** | **0.467 ms** | **15.688 ms** | **1.258 ms** | **1.179 ms** |

Pares avaliados por tick, n=200:

| topologia | Voice Core | legado |
|---|---|---|
| espalhada | **149** | 39.800 (**267× menos**) |
| mista | **2.505** | 39.800 (**16× menos**) |
| densa | 39.800 | 39.800 (**igual — e é correto**) |

### 5.2 Mudança crítica (troca de célula → rota atualizada), n=200

| topologia | p50 | p95 | máx |
|---|---|---|---|
| espalhada | 0.264 ms | 0.686 ms | 1.785 ms |
| mista | 0.535 ms | 1.467 ms | 4.822 ms |
| densa | 7.733 ms | 11.906 ms | 16.892 ms |

### 5.3 Veredito

```
Pior recompute p95:                     15.688 ms  (n=200, densa)
Orçamento (25% do tick de 150 ms):      37.500 ms  → CABE
Idade máxima de rota, movimento normal: 165.688 ms
Faixa pedida: 100–250 ms                           → DENTRO
Antes desta etapa: tick de 2000 ms, idade de rota ~2 s.
```

O bench **sai com código 1** se a meta não for atingida, para poder virar portão
de CI em vez de um número que alguém lê e esquece.

### 5.4 O resultado desconfortável, registrado

**Na topologia densa o índice espacial é mais LENTO que o laço O(n²) que ele
substitui** — 15.7 ms contra 4.7 ms a n=200. Não é defeito de implementação: com
200 pessoas todas dentro do alcance umas das outras, a resposta **é** quadrática,
os 39.800 pares são todos necessários, e o índice só acrescenta o custo de
percorrer buckets.

Está registrado em vez de escondido porque:

1. o bench mede as três topologias de propósito — medir só a favorável seria
   escolher o resultado antes de medir;
2. o caso realista de um servidor de RP é a **mista** (aglomerados numa cidade,
   resto espalhado), onde o Voice Core avalia **16× menos pares**;
3. 15.7 ms cabe com folga no orçamento de 37.5 ms, então o pior caso não ameaça
   a meta.

Duas otimizações saíram justamente desta medição, e as duas foram medidas:

| Mudança | Densa p95 antes → depois |
|---|---|
| `forEachWithin` (visita sem alocar) em vez de `queryWithin` | 18.9 → 19.1 ms (**neutro**) |
| `audienceProbe` (1 `Map.get`/par, sem objeto, sem `sqrt` no descarte) | 19.1 → **11.6 ms** |

A primeira **não** ajudou — a alocação não era o gargalo, e ficou por ser
correta de qualquer forma (o `push(...bucket)` tinha teto de pilha). A segunda
resolveu: o custo estava em `canHear` fazer 3 `Map.get`, alocar um objeto de
resultado e tirar raiz quadrada mesmo para quem estava longe demais.

---

## 6. Comportamento das subscriptions

### 6.1 A separação que torna "sem chamada redundante" verdadeiro

Um recompute produz duas coisas para dois consumidores:

- **`routesByListener`** — mapa completo de volume. Vira `proximity_update`.
  **Muda a cada passo que alguém dá.**
- **`diff`** — só entradas e saídas de alcance. Vira `subscribe`/`unsubscribe`.
  **Quase nunca muda.**

Se as duas viajassem pelo mesmo caminho, cada passo viraria uma chamada ao SFU.

### 6.2 O ciclo, medido

```
A entra no alcance de B  → diff.subscribe   = [{listener: B, speaker: A, track: 'voice.local'}]
A continua no alcance    → diff             = {subscribe: [], unsubscribe: []}   ← 20 ticks seguidos
A sai do alcance         → diff.unsubscribe = [{listener: B, speaker: A, ...}]
A sai da SALA (logout)   → routes.forget(A) → NENHUM comando
```

**VERIFICADO** por teste, incluindo os 20 ticks seguidos sem emissão.

Ticks sem nenhuma mudança de assinatura, medidos no bench: **75%** na topologia
espalhada com n=200.

### 6.3 As três economias

1. **Cache do estado atual** (`_subscriptions: Map<listener, Set<speaker>>`) — o
   diff só nasce da diferença.
2. **Agrupamento por ouvinte** no gateway — `UpdateSubscriptions` é por
   participante; dez faixas para a mesma pessoa é **uma** ida à rede, não dez.
   **VERIFICADO** por teste.
3. **Diff vazio não vira chamada** — `applySubscriptionDiff` retorna antes de
   tocar em `fetch`. **VERIFICADO** por teste.

### 6.4 `forget` vs `unsubscribe`

Sair de alcance e sair da sala são coisas diferentes. Quem saiu da sala teve as
assinaturas mortas junto; mandar `unsubscribe` para ele seria a chamada
redundante mais cara possível — citando uma identidade que não existe mais. Por
isso `detach()` chama `routes.forget()` **antes** de `sessions.close()`.
**VERIFICADO** por teste.

---

## 7. Testes

**970 testes, 970 passam, 0 falham.** `npm run typecheck` limpo. **VERIFICADO**
(execução nesta sessão; 840 antes, **130 acrescentados**).

### 7.1 A lista obrigatória da tarefa

| # | Exigido | Onde | Resultado |
|---|---|---|---|
| 1 | whisper | `voice-policy.test.js` | ✅ alcance lido de `VOICE_RANGES`, sem número no teste |
| 2 | normal | idem | ✅ |
| 3 | shout | idem | ✅ |
| 4 | PTT | `voice-policy.test.js`, `voice-core.test.js` | ✅ concede, recusa, corta, e corta **entre** recomputes |
| 5 | mute | idem | ✅ mute cala a própria voz, não a dos outros; derruba PTT |
| 6 | entrar no alcance | `voice-route-engine.test.js` | ✅ exatamente 1 `subscribe` |
| 7 | sair do alcance | idem | ✅ exatamente 1 `unsubscribe` |
| 8 | same cell | `voice-policy.test.js` | ✅ |
| 9 | different cell | idem | ✅ coordenadas **idênticas**, sem rota |
| 10 | different worldspace | idem | ✅ mesmo caminho (§3.1) |
| 11 | teleport | `voice-core.test.js` | ✅ detectado por salto; corta no mesmo ciclo |
| 12 | reconnect | `voice-session.test.js` | ✅ `renew` mantém a identidade |
| 13 | disconnect | idem + `voice-core.test.js` | ✅ |
| 14 | logout | `voice-core.test.js` | ✅ `detach` limpa 4 estruturas e despeja |
| 15 | invalid identity | `voice-session.test.js` | ✅ inclusive formato válido não emitido |
| 16 | duplicate participant | idem | ✅ nova identidade + despejo explícito |
| 17 | rapid voiceMode switching | `voice-core.test.js` | ✅ 100 trocas → 1 ciclo, nos dois regimes do piso |
| 18 | cleanup | `voice-core.test.js` | ✅ `shutdown` não deixa timer nem estado |

### 7.2 Testes que valem mais que a linha na tabela

**Equivalência do índice com a força bruta.** 400 atores, 4 tipos de espaço
(incluindo desconhecido), 3 raios, semente fixa: o índice tem que devolver o
**conjunto idêntico** ao do laço O(n²). Um índice mais rápido e ligeiramente
errado seria pior que o laço lento — o erro apareceria como alguém que não é
ouvido de vez em quando, perto da borda de um bucket, e ninguém ligaria isso à
estrutura de dados.

**Equivalência das duas superfícies da política.** `canHear` (legível) e
`audienceProbe` (rápida) varridas contra a matriz inteira de estados × modos ×
distâncias × espaços — >1000 comparações — exigindo veredito e volume idênticos.

**Caracterização do volume.** `volumeAt` comparada com a conta antiga do
`voip-service.calcVolume` em 37 pontos por raio. Mover código sem mudar
comportamento é o único jeito de uma regressão não se disfarçar de refatoração.

**Nenhum número de alcance escrito nos testes.** Todos derivam de `VOICE_RANGES`.
Um teste com `assert(volume > 0 em 400 unidades)` passaria a mentir no dia em que
alguém ajustasse `chat.whisperRange` no `server-options` — e o ponto daquele
arquivo é justamente que mexer nele mude o jogo.

---

## 8. Resultados: quatro defeitos reais encontrados pelos testes

Nenhum destes foi procurado. Todos apareceram porque o teste existia.

### 8.1 🔴 A identidade não sobrevivia à leitura de volta

`voice-session` **monta** a identidade; `livekit-token.actorIdFromIdentity` a
**lê**, e exige `[0-9a-f]+` no nonce — um alfabeto que o gerador não declarava em
lugar nenhum. Um nonce fora dele fazia `open()` responder `ok: true`, o token ser
emitido e aceito, e só `resolveActor` devolver `null` — depois, longe dali, com o
sintoma "ninguém ouve ninguém" e nenhum erro no caminho.

**Corrigido:** `open()` confere o round-trip e recusa com o motivo nomeado.
Travado por dois testes, um deles exercitando o gerador de produção 50 vezes.

### 8.2 🔴 O `mp` congelado em `null`

O Voice Core capturava `globalThis.mp` **no construtor**. O `voip-service` o
instancia ao ser carregado — antes de o host publicar o global. O núcleo
congelava `null` para sempre: servidor sobe, laço roda, ninguém ouve ninguém,
sem erro em lugar nenhum.

**Corrigido:** `world()` resolve a cada leitura.

### 8.3 🔴 …e a correção introduziu um sombreamento

Ao corrigir 8.2, o parâmetro destruturado chamava-se `mp` e **sombreava o
global** dentro da própria função que ia lê-lo — `typeof mp` passou a perguntar
sobre o parâmetro, que é `null`. Mesmo sintoma, causa nova.

**Corrigido:** o parâmetro chama-se `injectedMp`, com comentário explicando por
que o nome é feio. Travado por um teste que anexa um ator **antes** de existir
mundo e publica o global depois — a ordem real de boot.

### 8.4 🟠 `getActiveCharacterData` devolve `{characterId}`, não `{id}`

Ler `character.id` no handshake dava `undefined`, o ator entrava sem personagem,
`canSpeak` recusava por "personagem não carregado", e a voz simplesmente não
saía. Encontrado pela suíte legada de 41 testes ao rodar contra a refatoração.

### 8.5 🟠 Mutar silenciava o cliente legado para sempre

`setMuted(true)` limpa `transmitting` de propósito — para que um mute durante a
fala não deixe o PTT engatilhado. Num cliente com PTT quem o traz de volta é a
tecla; um cliente legado não tem tecla. O primeiro mute o calava permanentemente.

**Corrigido:** `_openMicActors` deixou de ser um registro de aviso e virou o
estado que diz que a concessão precisa ser **restabelecida** no desmute.

---

## 9. Performance e resiliência

### 9.1 O que o PTT faz com o custo do tick

Contra-intuitivo e medido: **PTT barateia o tick.** `audienceProbe` devolve
`null` para quem não pode falar — mutado, PTT solto, desconectado — e essas
pessoas saem do custo **antes** de consultar o índice. Num servidor com PTT, a
qualquer instante a maioria não está falando.

### 9.2 Se o LiveKit cair, o jogo não cai

| Camada | Garantia | Prova |
|---|---|---|
| `livekit-gateway` | Nenhuma função pública rejeita | 5 testes, sem `assert.rejects` — se rejeitar, o caso quebra |
| Circuito | Abre após 3 falhas; 10 ticks → 0 tentativas | **VERIFICADO** |
| Meia-abertura | 1 sondagem após cooldown; fecha de novo se falhar | **VERIFICADO** |
| `voice-core` | `catch` no tick e por assinante de rota | **VERIFICADO** |
| Regra de jogo | Proximidade continua sendo calculada com o SFU morto | **VERIFICADO** |

Com o circuito aberto, o que para é a **economia de banda**, não a regra: o
`proximity_update` continua saindo e o ganho continua correto.

### 9.3 O cliente não escolhe a carga do servidor

`markCritical` é alcançável por mensagem (`voice_mode`, `mute`, PTT). O piso de
intervalo (20 ms) coalesce: **100 trocas de modo → 1 recompute**, e a última
troca não é perdida — só agrupada. **VERIFICADO** nos dois regimes (dentro e
fora da janela do piso).

---

## 10. Falhas e o que ainda não foi validado

### 10.1 Falhas conhecidas

| # | Falha | Gravidade |
|---|---|---|
| 1 | **Microfone aberto** para clientes que não declaram `ptt: true` (§4.1) | 🟠 dívida nomeada, com log |
| 2 | Índice **mais lento que o laço antigo** na topologia densa (§5.4) | 🟡 dentro do orçamento |
| 3 | Corpo Twirp do `UpdateSubscriptions` **não verificado contra servidor real** | 🟠 ver 10.2 |
| 4 | `VOIP_DEBUG_EXPOSE_TICKET` continua existindo | 🟡 blocker #4 herdado |
| 5 | Espaço desconhecido faz varredura linear | 🟢 contado por métrica; não deve ocorrer |

### 10.2 NÃO TESTADO, sem exceção

1. **Voz inteligível a um ouvido humano** — em qualquer transporte. Blocker #1.
2. **Dois clientes Skyrim reais** falando e ouvindo. Blocker #2.
3. O Voice Core **dentro do processo do SkyMP** com jogadores reais. Tudo aqui
   rodou em Node com `mp` falso ou ausente.
4. **`UpdateSubscriptions` contra um `livekit-server` real.** O gateway está
   travado no comportamento de que o gamemode depende (não chamar à toa, não
   derrubar o jogo, abrir circuito); a **serialização do corpo** não foi
   confirmada. É o item mais provável de precisar de ajuste.
5. `getUserMedia` dentro da CEF do SkyMP, com ou sem `CefPermissionHandler`.
6. O `livekit-client` (JS) rodando dentro da CEF 108.
7. O `client-sdk-cpp` compilado no `voice-helper`.
8. Qualquer coisa fora de `127.0.0.1`: latência, perda, jitter, TURN, CGNAT.
9. Carga real: 5/10/20 ouvintes numa cena, com áudio de verdade. O bench mede
   **decisão de rota**, não transporte de áudio.
10. AEC / supressão de ruído.
11. O tick de 150 ms **competindo com o resto do gamemode** num servidor real. O
    orçamento de 25% é uma escolha, não uma medição em produção.
12. Reconexão real do LiveKit (o `renew` foi exercitado; um cabo caindo não).

> **A latência medida em §5 é do servidor decidindo quem ouve quem.** Ela não
> diz nada sobre a latência que uma pessoa ouve, que depende de captura, codec,
> SFU e rede — nenhuma delas medida aqui. O próprio bench imprime isso.

---

## 11. Checklist de teste humano — dois clientes Skyrim reais

Isto destrava os blockers #1 e #2. Precisa de **duas máquinas** (ou uma máquina e
uma VM com GPU), duas cópias de Skyrim, dois fones e **duas pessoas** — a última
parte não é opcional: inteligibilidade é julgamento, não medição.

### Preparação

- [ ] `skymp/gamemode/.env`: `ENABLE_VOIP_SERVICE=true`, `VOICE_BACKEND=legacy`
- [ ] `VOIP_BIND_HOST=0.0.0.0` e `VOIP_PUBLIC_HOST=<IP da máquina do servidor>`
- [ ] Firewall liberando **7778/TCP**
- [ ] `npm test` → 970/970 antes de subir
- [ ] `npm run bench:voice` → sai 0
- [ ] Confirmar no boot: `[voip] Voice Core: tick 150 ms, bucket 2048 u, gateway DISABLED`
- [ ] `voice-helper.exe` compilado nas duas máquinas
- [ ] `VOIP_DEBUG_EXPOSE_TICKET=true` **só durante a bancada** — e desligar depois

### A. Conexão

- [ ] A e B conectam e criam personagem
- [ ] Os dois rodam `/voz`
- [ ] Log mostra `connected to VOIP as listener` para os dois
- [ ] Log mostra o aviso de **microfone aberto** (esperado com o helper atual)
- [ ] `voice-helper.exe --actor-id … --ticket … --host … --port 7778` nos dois
- [ ] Log mostra `connected to VOIP as sender` para os dois

### B. O blocker #1 — alguém ouve

- [ ] **A fala. B ouve som?** ☐ sim ☐ não
- [ ] **B entende as palavras?** ☐ sim ☐ não ☐ parcialmente
- [ ] **B fala. A ouve?** ☐ sim ☐ não
- [ ] Latência percebida: ☐ imperceptível ☐ perceptível ☐ atrapalha
- [ ] Qualidade: ☐ limpa ☐ metálica ☐ picotada ☐ com eco
- [ ] Anotar o que quer que aconteça, mesmo (principalmente) se for feio

### C. Distância e modos

- [ ] Encostados: volume alto
- [ ] Afastando devagar: **o volume cai de forma contínua**, não em degraus
- [ ] Além de ~1200 unidades: silêncio total
- [ ] A em `whisper`: B só ouve muito perto (~450)
- [ ] A em `shout`: B ouve de longe (~3500)
- [ ] **Voz e chat concordam:** se B lê o `/sussurrar` de A, B ouve o sussurro de A
- [ ] Volume muda **em menos de meio segundo** ao andar (era ~2 s antes)

### D. Célula e worldspace

- [ ] A entra numa taverna, B fica fora, **encostados na porta**: não se ouvem
- [ ] A e B na mesma taverna: se ouvem
- [ ] A em Riverwood, B em Whiterun, **mesmas coordenadas locais**: não se ouvem
- [ ] Atravessar a porta corta/restaura a voz **imediatamente**, sem esperar tick

### E. Teleporte

- [ ] `mp.moveTo` (ou porta) leva A para longe: B para de ouvir **na hora**
- [ ] A volta: B volta a ouvir

### F. Mute e PTT

- [ ] A muta pela UI: B para de ouvir **mesmo com o helper rodando**
- [ ] A desmuta: B volta a ouvir
- [ ] Se o helper já falar PTT: soltar a tecla corta; segurar restaura
- [ ] Recusa de PTT com mute ligado aparece na UI com motivo

### G. Queda e limpeza

- [ ] Fechar o helper de A: A para de falar, **continua ouvindo**
- [ ] Fechar o jogo de A: log mostra `disconnected`, B não vê resíduo
- [ ] Matar o servidor com os dois conectados: **o jogo não trava** nos clientes
- [ ] Reconectar A: funciona sem reiniciar o servidor
- [ ] Reconectar A **sem fechar antes**: uma sessão só, sem voz duplicada

### H. Rede real (blocker #5)

- [ ] Repetir A–G com as duas máquinas em **redes diferentes**
- [ ] Anotar se pica, atrasa ou corta — e quando

### Registro obrigatório

- [ ] Data, máquinas, versão do servidor, commit
- [ ] `describe()` do Voice Core ao fim da sessão (métricas)
- [ ] **O que não funcionou.** Uma sessão que só registra o que deu certo não
      destrava blocker nenhum.

---

## 12. Recomendação para a próxima etapa

**Não avançar para produção.** Na ordem:

1. **Rodar o checklist §11.** Destrava os blockers #1 e #2, que são os únicos que
   importam. Todo o resto é preparação para eles.
2. **Ensinar PTT ao `voice-helper`** (`ptt_down`/`ptt_up` no WebSocket). Fecha a
   dívida do §4.1 e é uma mudança pequena no `main.cpp`.
3. **Validar `UpdateSubscriptions` contra um `livekit-server` real** — estender o
   spike da Etapa 1, que já sobe um. É o item 4 do §10.2 e o mais provável de
   precisar de ajuste.
4. **Medir o Voice Core dentro do processo do SkyMP**, com o jogo rodando. O
   orçamento de 25% do tick é uma escolha até alguém medir a competição real.
5. **Só então** considerar `VOICE_BACKEND=livekit` em ambiente fechado, com os
   dois caminhos ainda presentes.

Reforçando o escopo: **não existe rádio por voz neste projeto**, e nada aqui deve
ser lido como preparação para um.

---

## Fontes

**Internas:** [`SKYVOICE_LIVEKIT_AUDIT.md`](SKYVOICE_LIVEKIT_AUDIT.md) ·
[`VOICE_NATIVE_HELPER.md`](VOICE_NATIVE_HELPER.md) ·
[`VOICE_CLIENT_PATCH.md`](VOICE_CLIENT_PATCH.md) ·
[`FASE_0_ROTEIRO.md`](FASE_0_ROTEIRO.md) ·
[`TASK_005_VOIP_CAPACITY_AND_SECURITY.md`](../roadmap/TASK_005_VOIP_CAPACITY_AND_SECURITY.md)

**Código:** `skymp/gamemode/core/voice/` · `skymp/gamemode/core/proximity-ranges.js`
· `skymp/gamemode/core/range-utils.js` · `skymp/gamemode/voip-service.js` ·
`skymp/gamemode/scripts/bench-voice-proximity.js`

**LiveKit:** [Selective subscription](https://docs.livekit.io/home/client/tracks/subscribe/)
· [Gerenciar participantes](https://docs.livekit.io/home/server/managing-participants/)
