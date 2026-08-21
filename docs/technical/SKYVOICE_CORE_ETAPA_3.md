# SkyVoice — Etapa 3: a voz vira gameplay

**Data:** 2026-08-14
**Branch:** `feat/skyvoice-core-etapa-2`
**Escopo:** transformar o VOIP num sistema de gameplay Heavy RP — regras de
personagem centralizadas, áudio espacial, oclusão e estado de fala. **Não é
produção**, e nada aqui deve ser lido como se fosse.

## Como ler as marcas

Mesma convenção das etapas anteriores.

| Marca | Significa |
|---|---|
| **VERIFICADO** | Executado nesta máquina, com número. |
| **INFERIDO** | Deduzido de evidência forte, sem execução. |
| **PLANEJADO** | Decisão tomada, sem código. |
| **NÃO TESTADO** | Não exercitado. |

> **Ninguém ouviu a voz deste projeto ainda.** O blocker #1 da Etapa 1 continua
> aberto e nenhuma linha desta etapa o fecha. Ver §11 e §12.

> **Não existe rádio por voz neste projeto.** Não há frequência, canal, PTT de
> rádio nem `VoiceRadioService`. A única faixa lógica é `voice.local`, e há um
> teste automatizado que reprova se a palavra aparecer no código do HUD.

---

## 0. O que a verificação prévia encontrou

As cinco perguntas pedidas, antes de tocar em código.

| # | Pergunta | Resposta |
|---|---|---|
| 1 | Commits das etapas anteriores | `5c057ba`, `6fa3a55`, `462963e`, `469ad16` — lidos |
| 2 | Documentação | `SKYVOICE_CORE_ETAPA_2.md`, `SKYVOICE_LIVEKIT_AUDIT.md`, `PAPYRUS_USAGE_POLICY.md` — lidas |
| 3 | Testes | `npm test` → **970/970**, batendo com o documento da Etapa 2. **VERIFICADO** |
| 4 | **LiveKit está funcional?** | **Parcialmente — e a parte que falta é a mesma de antes.** Ver §0.1 |
| 5 | proximity / whisper / normal / shout / PTT / cell isolation | **Verificados por teste; não por ouvido.** Ver §0.2 |

### 0.1 A confirmação do LiveKit voltou parcial, e isto não mudou nesta etapa

O que **está** confirmado, da Etapa 1, contra um `livekit-server` real: token
aceito, token com secret errado recusado (401), áudio publicado por A chegando
em B através do SFU com sinal preservado, PTT e mute duro, reconexão com
identidade preservada.

O que **não** foi possível reconfirmar nesta máquina:

- **não há binário do `livekit-server` no repositório nem na máquina** (`which
  livekit-server` vazio, nenhum arquivo achado);
- **`.env.example` tem `LIVEKIT_URL`, `LIVEKIT_API_KEY` e `LIVEKIT_API_SECRET`
  vazios** — não há credencial para apontar para um servidor remoto.

Rodar o spike exigiria baixar um binário de terceiro e conferir checksum, que é
uma ação de rede e de instalação, e não uma que eu deva tomar sozinho.

**O que continua sem prova é exatamente o item 4 da §10.2 da Etapa 2:** a
serialização do corpo Twirp de `UpdateSubscriptions` contra um servidor real. O
`livekit-gateway` está travado por teste no comportamento de que o gamemode
depende — não chamar à toa, não derrubar o jogo, abrir circuito —, e nada disso
prova o formato do corpo.

**Assunção declarada desta etapa:** o transporte LiveKit continua no estado da
Etapa 1, e o caminho ativo continua sendo `VOICE_BACKEND=legacy` (o relay
WebSocket + `voice-helper`). Tudo o que a Etapa 3 acrescenta é **acima** do
transporte — política, rota, efeito, direção — e funciona igual nos dois.

### 0.2 Os seis comportamentos, e em que sentido eles "funcionam"

| O quê | Estado | Como foi confirmado |
|---|---|---|
| proximity | **VERIFICADO por teste** | `voice-route-engine.test.js` + equivalência com força bruta em 400 atores |
| whisper / normal / shout | **VERIFICADO por teste** | `voice-policy.test.js`, alcances derivados de `VOICE_RANGES` |
| PTT | **VERIFICADO por teste** | concede, recusa, corta, e corta **entre** recomputes |
| cell isolation | **VERIFICADO por teste** | coordenadas idênticas em células distintas → sem rota |
| **qualquer um deles com uma pessoa ouvindo** | **NÃO TESTADO** | Blocker #1 |

A distinção não é formalidade. O que os testes provam é que **o servidor decide
certo**. Nenhum deles prova que sai som.

---

## 1. VoicePolicyEngine

### 1.1 A equação

```
   Locutor  +  Ouvinte  +  Estado do personagem  +  Estado do mundo  =  VoiceRoute
      │           │                 │                      │
   voice-state  voice-state   voice-character-adapter   voice-occlusion
                                     ↓                      ↓
                              voice-conditions      célula / worldspace / portal
```

`resolveRoute(listener, speaker)` é essa equação escrita como função, e devolve
os cinco campos que a etapa pediu:

```js
{
  allowed: false,
  gain: 0,
  rangeModifier: 1,
  gainModifier: 0,
  effect: 'none',
  reason: 'morto — sem voz local',
  distance: Infinity,
  range: 1200,
  conditions: { speaker: ['DEAD'], listener: [] }
}
```

### 1.2 Onde NÃO existe `if (dead)`

Em lugar nenhum de `voice-policy.js`, e esse é o ponto. Morto, inconsciente,
abatido, amordaçado e silenciado pela staff entram por **uma** porta —
`profileOf(actorId)` — e saem como quatro números e um nome de efeito.

```
                    ┌──────────────────────────────┐
                    │ core/character-state.js      │  ← já existia
                    │ DOWNED · DEAD · RESTRAINED   │     (death-service,
                    │ IMPRISONED · …               │      governance-service)
                    └──────────────┬───────────────┘
                                   │
                    ┌──────────────▼───────────────┐
                    │ voice-staff-mute.js          │  ← novo, e é de VOZ,
                    │ silêncio aplicado pela staff │     não de personagem
                    └──────────────┬───────────────┘
                                   │
                    ┌──────────────▼───────────────┐
                    │ voice-character-adapter.js   │  ← TRADUTOR
                    │ conditionsOf(characterId)    │     (nenhum estado próprio)
                    └──────────────┬───────────────┘
                                   │  ['DOWNED', 'GAGGED']
                    ┌──────────────▼───────────────┐
                    │ voice-conditions.js          │  ← A TABELA
                    │ composeProfile()             │     (server-options)
                    └──────────────┬───────────────┘
                                   │  {canSpeak, canHear, rangeModifier,
                                   │   gainModifier, effect, reason}
                    ┌──────────────▼───────────────┐
                    │ voice-policy.js              │
                    │ profileOf() ← porta única    │
                    └──────────────────────────────┘
```

Acrescentar uma condição nova (cego? bêbado? enfeitiçado?) é **uma linha na
tabela e uma no adapter**. Não toca a política, o motor de rotas, o relay nem o
cliente.

### 1.3 Cinco superfícies, uma regra

`canSpeak`, `canListen`, `canHear`, `audienceProbe` e `resolveRoute` são a mesma
regra vista de cinco ângulos. Há um teste de varredura que exige que as cinco
concordem em **toda** combinação de condição do locutor × condição do ouvinte —
64 pares, veredito e ganho idênticos. É o que faz "não espalhe as regras"
continuar valendo depois que outra pessoa mexer no arquivo. **VERIFICADO**

### 1.4 Composição, não precedência

Uma pessoa pode estar abatida **e** amordaçada. Escolher "a condição mais grave"
perderia a mordaça, e a voz do abatido amordaçado sairia igual à de um abatido
qualquer — uma regra de jogo desaparecendo por causa de outra.

| Campo | Como compõe |
|---|---|
| `canSpeak` / `canHear` | **E lógico** — uma proibição basta |
| `rangeModifier` / `gainModifier` | **produto** — dois efeitos se somam |
| `effect` | o **mais forte** (`none < faint < muffled`) |
| `reason` | o primeiro motivo **bloqueante**, na ordem de leitura |

A ordem de leitura existe só para o motivo, e começa por `STAFF_MUTED`: quando a
staff silenciou alguém, é isso que a pessoa e o log precisam ler — não "você
está morto", que é verdade e é irrelevante para quem vai apelar da punição.

Uma condição que só **atenua** (mordaça, abatido que fala) nunca vira motivo de
recusa. Dizer "amordaçado" como motivo para quem está falando seria mentira.

### 1.5 Cache de ciclo

`conditionsOf` consulta dois `Map` e compõe um objeto. Sem cache isso
aconteceria **uma vez por par** — na topologia densa, 39.800 vezes por tick para
200 respostas distintas.

O cache vive **dentro** de um ciclo de recompute (`beginCycle`/`endCycle`, com
`finally`) e não sobrevive a ele. Um perfil de 150 ms atrás faria um cadáver
terminar a frase no ciclo seguinte. Fora de ciclo — que é o regime do relay, a
50 Hz — toda leitura vai à fonte. **VERIFICADO** por dois testes.

---

## 2. Estados integrados

### 2.1 O que foi reusado, e o que é novo

| Condição de voz | De onde vem | Quem escreve lá | Novo? |
|---|---|---|---|
| `DEAD` | `character-state.STATES.DEAD` | `death-service.bleedOut` | **não** |
| `DOWNED` | `character-state.STATES.DOWNED` | `death-service.handlePlayerDowned` | **não** |
| `GAGGED` | metadado do `RESTRAINED` | `governance-service` (algemar) | **não** |
| `STAFF_MUTED` | `voice-staff-mute` | `admin-service.voiceMute` | **sim** |
| `UNCONSCIOUS` | **ninguém ainda** | — | encaixe |

**Nenhum sistema de personagem foi duplicado.** O adapter *lê*
`core/character-state.js` — o mesmo que `core/action-policy.js` lê para decidir
se alguém pode minerar. Um personagem abatido tem **um** estado, e dois sistemas
o consultam.

### 2.2 A mordaça não é uma algema nova

`character_restraints.type` já é `VARCHAR(32)` com `'handcuffs, rope'` no
comentário — uma coluna de **tipo**, não um booleano de algema. Amordaçar é um
`type` a mais nela: sem tabela nova, sem estado novo, sem migration.

O adapter reconhece dois caminhos, e o segundo existe porque `type` cabe um
valor só:

- `metadata.type === 'gag'` — a algema **é** uma mordaça;
- `metadata.gagged === true` — algemado **e** amordaçado, ou amordaçado dentro
  da cela (onde o estado é `IMPRISONED`, não `RESTRAINED`).

**Algema comum não cala**, e isso está travado por três testes. É o erro natural
de quem lê "RESTRAINED" e conclui "restrito, então calado" — e se ele existisse,
algemar um suspeito o impediria de responder ao guarda, que é o oposto do que
uma cena de prisão em Heavy RP precisa.

### 2.3 `UNCONSCIOUS`: o buraco, nomeado

**Não existe produtor de inconsciência neste projeto.** `character-state` tem
`DOWNED` (sangrando, consciente, pedindo socorro) e `DEAD`, e nenhum dos dois é
desmaio.

A instrução pedia **suportar a arquitetura**, não inventar o sistema. Então: a
condição existe, a regra existe, o teste existe, e a porta de entrada é
`unconsciousProbe` — um gancho injetável cujo padrão lê `metadata.unconscious`,
que **ninguém escreve hoje**.

Inventar `STATES.UNCONSCIOUS` agora seria pior: um estado na máquina central sem
transição que o produza, que `action-policy` teria que passar a considerar, e que
apareceria no painel do jogador como um estado alcançável.

### 2.4 Silêncio de staff não é estado de personagem

`character-state` descreve o que aconteceu com o **corpo**. Silêncio de staff é
uma decisão administrativa sobre um **canal**. Empurrá-lo para lá faria um
jogador silenciado deixar de poder minerar, porque `action-policy` bloqueia por
estado e o estado seria um só.

Quem silencia continua **ouvindo** — senão a punição vira desconexão disfarçada.

`/calar` e `/descalar` estão em `admin-service`, com permissão `voice_mute`
(moderador+, ao lado de `kick`), audit log e notificação ao bot do Discord.
Cobertos pela matriz de permissão por cargo, que reprova comando de staff sem
cobertura.

**⚠️ O silêncio NÃO persiste.** Vive na memória do processo e some no restart.
Persistir exigiria tabela, migration e uma decisão sobre expiração que ninguém
tomou. Está em §11 como item aberto, não como detalhe.

---

## 3. Áudio espacial

### 3.1 O pipeline

```
  audio_frame (PCM)
        │
   BufferSource ──► GainNode ──► [BiquadFilter] ──► PannerNode ──► destination
                        │              │                │
                     volume         efeito           direção
                   (servidor)    (mordaça/fraco)   (unitário, no
                                  só quando há      referencial do
                                     efeito)           ouvinte)
```

### 3.2 Duas decisões que o desenho conceitual não fixava

**O filtro vem ANTES do panner.** A instrução desenhava `Panner → Environment
Filter → Destination`. Depois do panner o sinal é estéreo, e o biquad filtraria
dois canais em vez de um — o dobro do custo, no ponto mais apertado do sistema.
Com `equalpower` o panner é um par de ganhos constantes, então filtrar antes ou
depois dá o **mesmo resultado audível**. Trocou-se ordem por metade da conta,
sem trocar o som.

**O panner NÃO atenua por distância.** `rolloffFactor = 0`, `refDistance =
maxDistance = 1`, fonte sempre a raio 1. A queda por distância é do servidor e já
está no `volume`. Se o panner aplicasse a dele, o volume passaria por **duas
quedas independentes**, uma autoritativa e uma não, e o desvio cresceria com a
distância — o disfarce perfeito para uma regra de jogo quebrada. **VERIFICADO**
por teste no cliente.

### 3.3 O servidor manda direção, não posição

`voice-spatial.directionFor` devolve um **vetor unitário no referencial do
ouvinte**:

```
  Skyrim:      +X leste, +Y norte, +Z cima; rot[2] = yaw em GRAUS, 0 = norte, horário
  frente  = ( sin(yaw),  cos(yaw))
  direita = ( cos(yaw), -sin(yaw))

  Web Audio:   ouvinte olha para -Z, +Y cima, +X direita
  x = componente à direita
  y = componente para cima
  z = -componente à frente        ← o sinal que se erra uma vez
```

Efeito colateral bem-vindo: **nenhuma coordenada absoluta viaja no
`proximity_update`.** Trocar por `pos: [x,y,z]` teria sido a forma mais fácil de
piorar isso sem perceber.

**O erro que os testes existem para pegar é o sinal de `z`.** Com `equalpower` a
panorâmica acontece quase toda em esquerda/direita, e quem está na frente soa
praticamente igual a quem está atrás — uma implementação com `z` invertido passa
em **todo** teste de L/R. Por isso há caso de frente e de trás separados, com a
asserção no eixo `z`. **VERIFICADO**

Há também o teste que prova que a **orientação** é usada e não só a posição:
mesmo locutor, ouvinte gira 90°, e quem estava à direita passa para a frente. Sem
`rot`, o áudio ficaria preso à rosa dos ventos em vez de à cabeça do jogador.

`rot` entra na amostra do MESMO `locationalData` que já era lido: uma ida ao
`mp`, dois campos. Ausência é tolerada — sem orientação, trata-se como olhando
para o norte. Uma leitura sem orientação vale mais que uma pessoa sem rota.

### 3.4 Compatibilidade com a CEF 108 — **VERIFICADO por teste**

A CEF do SkyMP é a **108** (`cef_binary_108.4.13+…+chromium-108.0.5359.125`,
`overlay_ports/cef-prebuilt/portfile.cmake`; ver `6fa3a55`).

| API usada | Desde | Situação |
|---|---|---|
| `createPanner`, `createBiquadFilter`, `createGain` | Chromium 14 | ✅ |
| `PannerNode.positionX/Y/Z` como `AudioParam` | Chromium 52 | ✅ com detecção em runtime |
| `panningModel = 'equalpower'` | Chromium 14 | ✅ |
| `AudioParam.setTargetAtTime` | Chromium 14 | ✅ |
| `AudioContext.baseLatency` | Chromium 58 | ✅ (métrica) |
| `performance.memory` | não-padrão, Chromium | ✅ com guarda |

Deliberadamente **fora**, com teste automatizado que reprova se aparecerem:

| API | Por quê |
|---|---|
| `AudioContext.setSinkId` | **Chromium 110.** Não existe na 108 |
| `AudioWorklet` | Existe na 108, mas exige carregar módulo por URL, o que a origem do overlay complica |
| `MediaStreamTrackProcessor` | Desnecessária, e estreita a compatibilidade |
| `HRTF` | Custo por fonte muito maior que `equalpower`, sem ganho audível em fone dentro de um jogo |

`positionX` é detectado em runtime com queda para o `setPosition()` obsoleto: o
pin da CEF pode mudar, e um `undefined.setTargetAtTime` aqui calaria todo mundo
com um TypeError por quadro. **VERIFICADO** por teste.

---

## 4. Atenuação

### 4.1 Onde ela mora, e por que só num lugar

| Camada | Aplica atenuação? |
|---|---|
| `VoicePolicyEngine` (servidor) | **sim** — `(1 - d/r) × gainModifier × oclusão` |
| `PannerNode` (cliente) | **não** — `rolloffFactor = 0` |
| `GainNode` (cliente) | aplica o número que o servidor mandou |

A curva não mudou desde a Etapa 2 — queda linear com corte em `maxRange`, a mesma
conta que o `voip-service.calcVolume` fazia. O que a Etapa 3 acrescentou foram os
dois multiplicadores.

### 4.2 O alcance efetivo

```
  alcance efetivo = VOICE_RANGES[modo] × rangeModifier(condições) × rangeModifier(oclusão)
  ganho           = (1 − d / alcance)  × gainModifier(condições)  × gainModifier(oclusão)
```

O modificador se aplica **sobre o modo**, não sobre um alcance fixo: um sussurro
amordaçado alcança uma fração do **sussurro**, não do grito. A mordaça abafa o
que a pessoa escolheu dizer; ela não redefine o que a pessoa é. **VERIFICADO**

Há teste exigindo que o volume caia **monotonicamente** até o corte, com e sem
mordaça — 20 pontos por curva.

### 4.3 Nenhum número está no código

Todos os modificadores vêm de `server-options`:

| Opção | Padrão |
|---|---|
| `voice.downed.canSpeak` | `true` |
| `voice.downed.rangeModifier` | `0.35` |
| `voice.downed.gainModifier` | `0.6` |
| `voice.downed.effect` | `faint` |
| `voice.gagged.canSpeak` | `true` |
| `voice.gagged.rangeModifier` | `0.3` |
| `voice.gagged.gainModifier` | `0.4` |
| `voice.gagged.effect` | `muffled` |
| `voice.unconscious.canHear` | `false` |
| `voice.dead.canHear` | `false` |
| `voice.effects.muffledLowpassHz` | `700` |
| `voice.effects.faintLowpassHz` | `2400` |
| `voice.spatial.enabled` | `true` |

`server-options` ganhou um tipo de regra `enum` para os dois `effect`. Texto
livre reabriria o furo do `voice_mode` da Etapa 1 — um valor que o resto do
sistema não sabe interpretar, virando silêncio sem log. Aqui valor inválido
**aborta o boot**.

**Nenhum teste desta etapa escreve um modificador à mão.** Todos derivam de
`conditionProfiles()`. Um `assert(gain === 0.4)` passaria a mentir no dia em que
alguém ajustasse o JSON — e o ponto daquela opção é que mexer nela mude o jogo.

---

## 5. Oclusão

### 5.1 Nível 1 — célula e worldspace. **ATIVO**

Dois espaços diferentes não se ouvem. É a regra mais forte do sistema e vem
**antes** da distância: cada interior do Skyrim tem origem de coordenada própria,
e a distância numérica entre duas tavernas distintas pode medir zero.

Espaço desconhecido de um dos lados **não separa**. Falta de informação não é
prova de estarem em lugares diferentes, e tratá-la como prova calaria alguém por
causa de uma leitura de `locationalData` que falhou.

A regra saiu de dentro da política e virou `voice-occlusion.between()`, com o
mesmo veredito consultado pelo caminho quente e pelo frio — antes, `canHear`
usava `sameSpace` e o probe fazia a comparação em linha, o que teria produzido
dois motivos diferentes para o mesmo par no dia em que o nível 2 existisse.

### 5.2 Nível 2 — portas e portais. **ESTUDADO. ENCAIXE PRONTO, SEM IMPLEMENTAÇÃO**

A pergunta era se dá para saber **com segurança** se uma porta está aberta,
fechada, e o que ela liga. O estudo, contra
[`PAPYRUS_USAGE_POLICY.md`](PAPYRUS_USAGE_POLICY.md) §3 e `core/espm.js`:

| Pergunta | Existe API? | Serve? |
|---|---|---|
| Porta aberta ou fechada | **Sim** — `ObjectReference.GetOpenState` (SAFE) | Só com a referência da porta em mãos |
| O que a porta liga | **Sim** — `GetLinkedRef` + `GetParentCell` (SAFE) | idem |
| **Quais portas existem numa célula** | **NÃO** | É aqui que trava |

Três achados, na ordem em que fecham o caminho:

1. **O servidor não enumera o conteúdo de uma célula.** Não há API para isso.
2. **O caminho ESPM está fechado.** `mp.lookupEspmRecordById` devolve `{}` para
   **referências** — medido contra servidor real, com `0x14` (o Player) como
   exemplo, e registrado em `core/espm.js`. O `XTEL` de uma porta de
   carregamento não é legível por ali.
3. **Sobra `Game.FindClosestReferenceOfTypeFromRef`**, que seria uma chamada
   Papyrus **por jogador por tick** — e o custo de uma chamada Papyrus que de
   fato executa **nunca foi medido** neste projeto. A única medição existente
   (13–35 ms) é de uma função **inexistente** e está marcada como suspeita na §7
   daquela política.

**Conclusão: os primitivos existem, a enumeração não, e o orçamento é
desconhecido.** Implementar assim mesmo seria escolher o resultado antes de
medir — exatamente o que o bench da Etapa 2 existe para não repetir.

O que ficou pronto é o **encaixe**: `occlusion.setPortalProvider(fn)`. Quem um
dia tiver uma tabela curada de portas — ou um `.psc` nosso publicando
`OnOpen`/`OnClose` via `mp.registerPapyrusFunction` — liga ali, e a voz passa a
atravessar a porta **abafada e mais fraca** em vez de parar na parede, **sem
tocar na política**. Um provedor que não conhece o par devolve `null` e o nível 1
responde; um que lança não cala a cena. **VERIFICADO** por sete testes,
incluindo um que atravessa a política ponta a ponta com um provedor ligado.

### 5.3 Nível 3 — raycast. **RECUSADO, com motivo**

A instrução condicionava o nível 3 a haver API confiável **e** benchmark. O
estudo é curto e negativo:

1. **Não há API de raycast no servidor.** As 128 funções do VM não incluem
   nenhuma, e o `mp` não expõe geometria de colisão.
2. O que existiria seria no **cliente** (SkyrimPlatform), e mover a decisão para
   lá entregaria ao cliente quem ouve quem — a fronteira que esta arquitetura
   inteira existe para não cruzar.
3. Sem (1), não há benchmark possível. A condição da instrução não é atendível.

Não está adiado por falta de tempo. Está recusado por não haver caminho.

---

## 6. Efeitos

| Efeito | Quando | O que o cliente faz |
|---|---|---|
| `none` | padrão | **nenhum nó de filtro existe** |
| `faint` | abatido (configurável) | passa-baixa em `voice.effects.faintLowpassHz` |
| `muffled` | amordaçado, e o padrão de um portal | passa-baixa em `voice.effects.muffledLowpassHz` |

### 6.1 Mordaça é efeito, não mute

Foi o item que a instrução destacou, e a diferença é de jogo: calar por completo
é mais fácil de implementar e pior de jogar. Quem amordaça quer ouvir o outro
tentando falar; quem está amordaçado quer poder chamar a atenção de quem está
encostado. O padrão entrega **os três** vetores que a instrução listou — redução
de alcance (×0.3), redução de ganho (×0.4) e passa-baixa (700 Hz).

Há teste exigindo `gainModifier > 0`: ganho zero seria mute com outro nome.

### 6.2 O filtro não existe quando não é preciso

`BiquadFilterNode` é criado **só** quando um efeito o exige, e **descartado**
quando o efeito volta a `none`. Um passa-baixa em 20 kHz seria transparente ao
ouvido e não seria transparente à CPU. Numa cena de oito pessoas com uma
amordaçada, isso é **um** biquad, não oito. A religação acontece só quando o
efeito muda — amordaçar, desmaiar, cair —, e o caso comum não paga nada.

O teste que mais importa aqui é o de **voltar para `none`**: um filtro pendurado
deixaria a pessoa abafada para sempre depois de ser socorrida, e o sintoma seria
"a voz dele nunca mais voltou ao normal", sem erro em lugar nenhum.

### 6.3 O corte vem do servidor, uma vez

Os parâmetros viajam no `auth_ok`, não por rota. Repetir a frequência de corte em
cada `proximity_update` seria mandar 50 vezes por segundo um número que muda
quando alguém edita um JSON e reinicia o servidor.

O `effect` em si viaja **nos dois** caminhos — no `proximity_update` e no
`audio_frame` — porque uma mordaça colocada entre dois ticks precisa valer no
quadro seguinte, não daqui a 150 ms. É um campo curto; o payload é PCM.

---

## 7. VoiceSpeakingState

### 7.1 Por que PTT não basta

`state.transmitting` diz que a pessoa tem **permissão** para falar. Não diz que
ela está falando: segurar a tecla e ficar calado é o caso comum de quem está
prestes a dizer algo. Uma boca ligada no PTT abriria meio segundo antes do som,
todas as vezes.

"Falando" é a conjunção de duas coisas: o servidor **permite** (`canSpeak`,
autoritativo) e quadros **chegaram** há pouco (observação, já contada, medida e
limitada por taxa antes de chegar aqui).

### 7.2 `audioLevel`

| Onde | Valor | Por quê |
|---|---|---|
| **Servidor** | **`null`, sempre** | Ele não abre o PCM. É desenho, não TODO |
| **Cliente** | RMS do quadro decodificado | Ele já tem as amostras em cache |

Prometer um número no servidor exigiria decodificar 50 quadros por segundo por
locutor para produzir algo que o cliente tem de graça. O campo aceita um nível
caso o `voice-helper` um dia mande RMS no cabeçalho — a assinatura já o suporta.

No cliente é uma passada por 960 amostras, sem `AnalyserNode`: um analisador
daria o mesmo número e custaria um nó e uma FFT por locutor.

### 7.3 As cinco garantias de parada

Todas terminam na mesma função, e nenhuma depende de o cliente avisar:

| Situação | Quem chama | Teste |
|---|---|---|
| soltar o PTT | `voice-core.pttUp` → `speaking.clear` | ✅ |
| mute | `voice-core.requestMute` → `speaking.clear` | ✅ |
| disconnect / logout | `voice-core.detach` → `speaking.forget` | ✅ |
| falha de voz | `voice-core.shutdown` → `speaking.clearAll` | ✅ |
| **incapacidade de falar** | `speaking.sweep()`, a cada tick | ✅ |

A quinta é a que não podia ser um evento: **ninguém emite "você morreu, pare de
falar"** para o sistema de voz. Sem o `sweep`, a boca de quem morre no meio da
frase fica aberta. E `noteFrame` reconsulta `canSpeak` por quadro, porque entre
um tick e o outro cabem sete quadros — esperar o sweep seria tarde.

### 7.4 Animação de fala — implementada e **DESLIGADA POR PADRÃO**

`Debug.SendAnimationEvent` existe: é uma das oito funções REQUIRED da política de
Papyrus, já usada pelo projeto. O que **não** existe é prova de que os nomes de
evento (`IdleSpeakOpen` / `IdleSpeakClose`) façam alguma coisa — eles não foram
conferidos contra o behavior graph do Skyrim, e um evento desconhecido é ignorado
em silêncio pelo grafo.

Ligar isto por padrão colocaria uma chamada Papyrus por transição de fala em todo
servidor, para talvez não produzir movimento nenhum. Então:
`VOICE_SPEECH_ANIMATION=true` liga, `VOICE_SPEECH_ANIM_START`/`_STOP` trocam os
nomes, e o §11 tem o passo de bancada que transforma "provavelmente" em "vi
mexer".

O que ela garante mesmo desligada: o contrato de **parar**. Ela é *assinante* do
`VoiceSpeakingState`, e é aquele módulo que tem as cinco garantias — nenhuma foi
reimplementada aqui. Piso de 250 ms entre envios por ator (PTT tamborilado vira
uma chamada, não vinte), mas `stop` **não** espera o piso: boca aberta é pior que
uma chamada a mais.

**Não é lipsync fonético, e a instrução pedia que não fosse ainda.**

---

## 8. HUD

### 8.1 O que saiu

Até a Etapa 2 havia uma lista no canto inferior esquerdo com um cartão e uma
barra de volume **por pessoa em alcance**. Numa taverna com oito pessoas, oito
cartões animados por cima do jogo, contando ao jogador o ganho aplicado à voz de
cada vizinho — uma coisa com a qual ele não decide nada.

### 8.2 O que ficou

Um chip, e ele é sobre a **sua** voz. Precedência, de cima para baixo:

```
   VOZ COM ERRO  >  MUDO  >  MIC · <modo>  >  SUSSURRO / NORMAL / GRITO
```

A ordem importa: quem está mutado **e** em modo sussurro precisa ler MUDO, porque
é o mudo que explica por que ninguém responde. Um chip mostrando SUSSURRO ali
estaria dizendo a verdade e escondendo o problema.

`MIC` não é um sétimo estado: aparece **junto** do modo, porque saber que o
microfone está aberto sem saber o alcance é meia informação.

O modo desenhado é o que o **servidor** confirmou, nunca o que o cliente pediu —
foi assim que `'radio'` conseguiu, na Etapa 1, deixar alguém inaudível com a UI
dizendo que estava tudo bem.

O que se perdeu junto: saber quem está falando pela barrinha. Isso passou a ser
dito onde já se olha — o personagem, pela animação de fala. Um indicador de fala
pertence à cena, não a uma lista no canto.

### 8.3 Não existe rádio

Nenhuma frequência, canal ou sistema de rádio aparece no HUD ou no código. Há
**teste automatizado** que lê o `index.html`, tira os comentários e reprova se
`radio`, `rádio`, `frequência` ou `voiceChannel` aparecerem no código. Os
comentários podem citar `'radio'` — eles precisam registrar que aquela string já
derrubou a voz de alguém em silêncio.

### 8.4 Megafone

**Não implementado, e não deveria ser inventado agora.** A instrução o permitia
*só* com integração a item/equipamento existente ou sem criar sistema artificial.
Não há item de megafone no projeto, e a integração com equipamento exigiria
`Actor.IsEquipped` por locutor por tick — a mesma classe de custo Papyrus não
medido que fechou o nível 2 da oclusão.

Quando existir, ele é **uma condição de voz a mais** com `rangeModifier > 1`, na
tabela de `voice-conditions`, e continua sendo `voice.local`. A arquitetura já o
suporta; falta o item e falta a medição. Registrado em §11.

---

## 9. Testes

**1135 testes, 1135 passam, 0 falham.** `npm run typecheck` limpo.
`npm run bench:voice` sai 0. **VERIFICADO** (970 antes desta etapa, **165
acrescentados**).

### 9.1 A lista obrigatória da instrução

| # | Exigido | Onde | Resultado |
|---|---|---|---|
| 1 | dead cannot speak | `voice-policy-conditions.test.js` | ✅ e não gera audiência, não só permissão negada |
| 2 | unconscious cannot speak | idem | ✅ |
| 3 | gagged modifiers | idem | ✅ alcance, ganho e efeito, derivados da config |
| 4 | staff mute | `voice-staff-mute.test.js`, `permissions.behavior.test.js` | ✅ inclusive expiração e matriz de cargo |
| 5 | state transition | `voice-policy-conditions.test.js` | ✅ morrer corta, ser socorrido devolve, e o cache não sobrevive ao ciclo |
| 6 | directional audio | `voice-spatial.test.js`, `voice-audio.test.js` | ✅ frente/trás separados de L/R |
| 7 | distance attenuation | `voice-policy-conditions.test.js` | ✅ monotônica, com e sem mordaça |
| 8 | cell isolation | idem | ✅ coordenadas idênticas, e a vedação vence a mordaça |
| 9 | effect selection | `voice-audio.test.js` | ✅ inclusive o descarte do filtro ao voltar a `none` |
| 10 | duplicated audio prevention | idem | ✅ `/voz` duas vezes não deixa duas cadeias |
| 11 | disconnect cleanup | idem + `voice-core.test.js` | ✅ |
| 12 | AudioNode cleanup | `voice-audio.test.js` | ✅ **todos** os nós, não só o ganho |

### 9.2 Os testes do cliente rodam contra o `index.html` de verdade

O código de voz da UI mora num `<script>` dentro do `index.html`, porque é assim
que a CEF carrega o overlay. Extraí-lo para um `.js` importável só para poder
testar criaria a situação clássica em que o arquivo testado e o arquivo carregado
divergem.

Então `skymp/ui/voice-audio.test.js` **lê o HTML, extrai o script e o executa**
num sandbox com `AudioContext`, `document` e `WebSocket` falsos que contam nós,
conexões e desconexões. Se alguém apagar `removeRelayPeer` do HTML, o teste
falha. **36 casos.**

Ele **não** prova que soe direito: nenhum `AudioContext` falso produz som.

### 9.3 Testes que valem mais que a linha na tabela

**A varredura das cinco superfícies.** 64 combinações de condição do locutor ×
condição do ouvinte, exigindo veredito e ganho **idênticos** em `canHear`,
`audienceProbe` e `resolveRoute`. Um `if` acrescentado a uma delas quebra este
caso — é o que faz "não espalhe as regras" continuar valendo depois que outra
pessoa mexer no arquivo.

**Frente e trás, separados de esquerda e direita.** Com `equalpower`, o sinal de
`z` invertido passa em todo teste de L/R e entrega frente e trás trocados.

**Algema comum não cala.** Três casos, porque é o erro que um leitor apressado de
`RESTRAINED` cometeria.

**O filtro descartado ao voltar para `none`.** Um filtro pendurado deixaria quem
foi socorrido abafado para sempre, sem erro em lugar nenhum.

**O cache de perfil não sobrevive ao ciclo.** Senão um cadáver termina a frase.

**Nenhum modificador escrito à mão.** Todos derivam do `server-options`, pela
mesma razão que nenhum teste de alcance escreve `450`.

---

## 10. Performance

### 10.1 Servidor — **VERIFICADO**, `npm run bench:voice`, Node v25.5.0

Recompute p95, n=200, por topologia:

| Topologia | Etapa 2 | Etapa 3 | Delta |
|---|---|---|---|
| espalhada | 0.467 ms | **0.404 ms** | −13% |
| mista | 1.258 ms | **0.828 ms** | −34% |
| **densa** | **15.688 ms** | **16.214 ms** | **+3,4%** |

```
  Pior recompute p95:                     16.214 ms  (n=200, densa)
  Orçamento (25% do tick de 150 ms):      37.500 ms  → CABE
  Idade máxima de rota, movimento normal: 166.214 ms
  Faixa pedida: 100–250 ms                           → DENTRO
  Bench sai com código 0.
```

**Os +3,4% na topologia densa são o preço desta etapa, e estão registrados
porque medir só a topologia favorável seria escolher o resultado antes de
medir.** O que foi acrescentado ao caminho quente foi um `profileOf` cacheado por
ouvinte e a checagem de oclusão quando os espaços diferem. A direção **não** está
nesse número por par: ela é calculada por **rota**, não por par candidato — numa
cena espalhada, 149 contas em vez de 39.800.

O resultado desconfortável da Etapa 2 continua valendo: na topologia densa o
índice espacial é mais lento que o laço O(n²) que ele substitui, porque com 200
pessoas todas em alcance a resposta **é** quadrática. Cabe no orçamento, e o caso
realista de um servidor de RP é a **mista**.

### 10.2 Cliente — **NÃO MEDIDO. Instrumentado.**

A instrução pediu medição de CPU da CEF, CPU do AudioContext, tracks, panners,
filtros, memória e impacto em FPS. **Nada disso foi medido, e não dá para
medir daqui:** exige o jogo rodando, o que é o blocker #2.

O que foi feito é o que dá para fazer daqui — **instrumentar**. `window.voiceStats()`,
chamável do console da CEF (`localhost:9000`):

```js
{
  contexto: 'running', sampleRate: 48000,
  baseLatency: 0.01, outputLatency: 0.02,   // o pedaço da latência que não é rede
  cadeias: 3, cadeiasPico: 8,               // ← "tracks"
  panners: 3, filtros: 1,                   // ← os nós que a instrução pediu
  fontesTocando: 3,                         // ← detecta acúmulo de BufferSource
  quadrosTocados: 15420, quadrosDescartados: 2,
  peersWebRTC: 0,
  memoriaMB: 84                             // performance.memory, com guarda
}
```

| Métrica pedida | Como obter | Estado |
|---|---|---|
| Quantidade de tracks | `voiceStats().cadeias` / `.cadeiasPico` | instrumentado |
| Quantidade de PannerNodes | `voiceStats().panners` | instrumentado |
| Filtros | `voiceStats().filtros` | instrumentado |
| Memória | `voiceStats().memoriaMB` | instrumentado |
| **CPU da CEF** | DevTools → Performance, `localhost:9000` | **manual, §11** |
| **CPU do AudioContext** | idem, faixa "Audio" | **manual, §11** |
| **Impacto em FPS** | contador do jogo, com e sem voz | **manual, §11** |

### 10.3 O que foi feito para não processar áudio de quem não é ouvido

| Decisão | Efeito |
|---|---|
| Cadeia criada pelo **primeiro quadro**, não pelo `proximity_update` | quem está em alcance e nunca fala não custa nó nenhum |
| Filtro criado **só** quando há efeito, e descartado ao sair | 1 biquad numa cena de 8, não 8 |
| Sair de alcance desmonta a cadeia inteira | sem grafo processando silêncio |
| Queda da sinalização desmonta tudo | e impede o segundo conjunto na reconexão |
| `rolloffFactor = 0` em vez de curva de distância | o panner não calcula atenuação |
| `equalpower` em vez de `HRTF` | um par de ganhos em vez de convolução por fonte |
| Direção por **rota**, não por par | 149 contas em vez de 39.800 (espalhada, n=200) |
| Perfil de condição cacheado por ciclo | 200 leituras em vez de 39.800 (densa) |
| PTT continua **barateando** o tick | quem não fala sai do custo antes do índice |

---

## 11. Problemas restantes

### 11.1 Nesta etapa

| # | Problema | Gravidade |
|---|---|---|
| 1 | **Silêncio de staff não persiste** — restart devolve a voz de todo mundo | 🟠 nomeado, com `describe()` para listar antes de reiniciar |
| 2 | **`UNCONSCIOUS` não tem produtor** — a condição existe e ninguém a liga | 🟡 encaixe deliberado, §2.3 |
| 3 | **Nomes de evento de animação não conferidos** — por isso ela nasce desligada | 🟠 §7.4 |
| 4 | **Oclusão nível 2 sem provedor** — a arquitetura está pronta, a tabela de portas não existe | 🟡 §5.2 |
| 5 | **Megafone não existe** — falta o item e falta medir o custo de `IsEquipped` | 🟢 §8.4 |
| 6 | **Índice mais lento que o laço antigo na topologia densa**, +3,4% nesta etapa | 🟡 dentro do orçamento |

### 11.2 Herdados e ainda abertos

| # | Problema | Estado |
|---|---|---|
| 1 | **Microfone aberto** para clientes que não declaram `ptt: true` | 🟠 dívida da Etapa 2, com log |
| 2 | Corpo Twirp do `UpdateSubscriptions` não verificado contra servidor real | 🟠 §0.1 |
| 3 | `VOIP_DEBUG_EXPOSE_TICKET` continua existindo | 🟡 blocker #4 |
| 4 | Nada fora de `127.0.0.1` | 🟠 blocker #5 |

### 11.3 Checklist de bancada — o que esta etapa acrescenta ao §11 da Etapa 2

O checklist da Etapa 2 continua valendo inteiro. Estes são os itens novos.

**Áudio espacial**

- [ ] A fala; B gira em volta de A: **o som acompanha a cabeça de B**, não a bússola
- [ ] A à esquerda de B soa à esquerda; à direita, à direita
- [ ] A à frente e A atrás soam **diferentes** (com `equalpower`, sutil — anotar se não der)
- [ ] Andar em volta não produz **clique** ao cruzar os eixos

**Condições de personagem**

- [ ] A cai (DOWNED): a voz fica **mais baixa e mais curta**, e ainda sai
- [ ] A sangra até morrer (DEAD): a voz **para**, e a boca fecha
- [ ] A é socorrido: a voz volta **limpa**, sem filtro pendurado
- [ ] Staff dá `/calar` em A: A **para de falar e continua ouvindo**
- [ ] `/descalar`: a voz volta
- [ ] A algemado com `handcuffs`: **fala normalmente**
- [ ] A amordaçado: a voz sai **abafada**, não some

**Estado de fala e animação**

- [ ] Com `VOICE_SPEECH_ANIMATION=true`: **a boca do personagem se mexe?** ☐ sim ☐ não
- [ ] Se não: trocar `VOICE_SPEECH_ANIM_START`/`_STOP` e anotar o que se tentou
- [ ] Soltar o PTT **para** a animação
- [ ] Mutar **para** a animação
- [ ] Fechar o helper **para** a animação
- [ ] Morrer falando **para** a animação

**HUD**

- [ ] O chip mostra o modo e muda ao trocar
- [ ] Mutado mostra `MUDO`, mesmo em sussurro
- [ ] Transmitindo mostra `MIC · <modo>` e pulsa
- [ ] **Não aparece nada sobre rádio, frequência ou canal**

**Performance no cliente — os números que faltam**

- [ ] `window.voiceStats()` no console da CEF (`localhost:9000`), com 1, 5 e 10 locutores
- [ ] Anotar `cadeias`, `panners`, `filtros`, `fontesTocando`, `memoriaMB`
- [ ] **CPU da CEF:** DevTools → Performance, 30 s de gravação, com e sem voz
- [ ] **CPU do AudioContext:** na mesma gravação, faixa de áudio
- [ ] **FPS:** contador do jogo, com e sem voz, na mesma cena
- [ ] Sair de alcance de todo mundo: `cadeias` volta a **0**
- [ ] Ficar uma hora numa cidade movimentada: `memoriaMB` **estabiliza?**
- [ ] `/voz` duas vezes seguidas: **não** há eco nem voz dobrada

---

## 12. Itens não testados

Sem exceção, e a lista é o documento.

1. **Voz inteligível a um ouvido humano.** Blocker #1. Nada nesta etapa o toca.
2. **Dois clientes Skyrim reais.** Blocker #2.
3. **Qualquer coisa desta etapa dentro do processo do SkyMP.** Tudo rodou em Node
   com `mp` falso ou ausente.
4. **O pipeline de áudio dentro da CEF 108 de verdade.** Os 36 testes do cliente
   rodam contra um `AudioContext` **falso**. Eles provam topologia, contagem e
   limpeza; não provam que o `PannerNode` da 108 se comporta como o de um
   Chromium moderno, nem que `equalpower` é audível em fone dentro do jogo.
5. **Áudio direcional ouvido por uma pessoa.** A matemática está testada; a
   percepção, não.
6. **A animação de fala.** Os nomes de evento não foram vistos mexer nada. Ela
   nasce desligada por causa disso.
7. **O custo de uma chamada Papyrus que de fato executa.** Continua sem medição, e
   é o que fecha o nível 2 da oclusão e o megafone.
8. **CPU da CEF, CPU do AudioContext e impacto em FPS.** Instrumentados,
   não medidos.
9. **Memória do cliente ao longo do tempo.** O teste prova que os contadores
   voltam a zero; ele não prova que o navegador libera a memória.
10. **`UpdateSubscriptions` contra um `livekit-server` real.** Item herdado, e o
    mais provável de precisar de ajuste.
11. **`getUserMedia` na CEF do SkyMP**, com ou sem `CefPermissionHandler`.
12. **`livekit-client` (JS) rodando dentro da CEF 108.**
13. **Qualquer coisa fora de `127.0.0.1`:** latência, perda, jitter, TURN, CGNAT.
14. **Carga real:** 5/10/20 locutores numa cena, com áudio de verdade.
15. **AEC / supressão de ruído.**
16. **O tick de 150 ms competindo com o resto do gamemode** num servidor real.
17. **A composição de condições em jogo.** Um abatido amordaçado tem teste; nunca
    existiu em cena.

> **A latência e o custo medidos em §10.1 são do servidor decidindo quem ouve
> quem.** Eles não dizem nada sobre a latência que uma pessoa ouve, que depende
> de captura, codec, SFU e rede — nenhuma delas medida aqui.

---

## 13. Recomendação para a próxima etapa

**Não avançar para produção.** Na ordem:

1. **Rodar o §11 da Etapa 2 e o §11.3 daqui.** Destrava os blockers #1 e #2, que
   são os únicos que importam. Todo o resto é preparação para eles.
2. **Medir o cliente** — CPU, FPS, memória. É a única parte da instrução desta
   etapa que ficou por fazer, e ela precisa do jogo aberto.
3. **Conferir os nomes de evento da animação** e ligá-la, ou trocá-los.
4. **Ensinar PTT ao `voice-helper`.** Fecha a dívida do microfone aberto.
5. **Medir o custo de uma chamada Papyrus que existe.** Ele destrava, de uma vez,
   o nível 2 da oclusão e o megafone.
6. **Validar `UpdateSubscriptions` contra um `livekit-server` real.**
7. **Persistir o silêncio de staff**, se a operação disser que faz falta.
8. **Só então** considerar `VOICE_BACKEND=livekit` em ambiente fechado.

Reforçando o escopo: **não existe rádio por voz neste projeto**, e nada aqui deve
ser lido como preparação para um.

---

## Fontes

**Internas:** [`SKYVOICE_CORE_ETAPA_2.md`](SKYVOICE_CORE_ETAPA_2.md) ·
[`SKYVOICE_LIVEKIT_AUDIT.md`](SKYVOICE_LIVEKIT_AUDIT.md) ·
[`PAPYRUS_USAGE_POLICY.md`](PAPYRUS_USAGE_POLICY.md) ·
[`VOICE_NATIVE_HELPER.md`](VOICE_NATIVE_HELPER.md) ·
[`ADR_005_ADMIN_RBAC.md`](ADR_005_ADMIN_RBAC.md) ·
[`FASE_0_ROTEIRO.md`](FASE_0_ROTEIRO.md)

**Código:** `skymp/gamemode/core/voice/` · `skymp/gamemode/core/character-state.js`
· `skymp/gamemode/core/action-policy.js` · `skymp/gamemode/core/server-options.js`
· `skymp/gamemode/admin-service.js` · `skymp/ui/index.html` ·
`skymp/ui/voice-audio.test.js`

**Web Audio:** [PannerNode](https://developer.mozilla.org/docs/Web/API/PannerNode)
· [BiquadFilterNode](https://developer.mozilla.org/docs/Web/API/BiquadFilterNode)
· [Web Audio spatialization](https://developer.mozilla.org/docs/Web/API/Web_Audio_API/Web_audio_spatialization_basics)
