# Revisão: os sistemas que dependem de realidade compartilhada

Data: **09/08/2026**. Base: [`SKYMP_UPSTREAM_REFERENCE.md`](SKYMP_UPSTREAM_REFERENCE.md)
**§8 e §9**, levantadas nesta mesma rodada.

> **Segunda passagem.** A primeira versão deste documento (commit `7ef31fb`,
> 00:37) cruzou os sistemas contra a **§8** da referência. Às 04:34 a **§9**
> entrou — a varredura sistemática do DeepWiki, com um achado `[DOC]` verificado
> linha a linha. Ela **muda três vereditos** desta revisão, e o principal é
> justamente o sistema que a primeira passagem tinha liberado como 🟡. Reler a
> §1 e a §8 abaixo é o ponto desta atualização; o resto está mantido.

Este projeto tem oito sistemas cuja suposição central é *"todo jogador vê ou sabe
a mesma coisa, resolvida de um lugar só"*. Todos foram construídos com uma
hipótese sobre como o SkyMP resolve estado compartilhado por baixo, e nenhuma
dessas hipóteses tinha sido conferida contra a arquitetura real — só contra o
comportamento observado em teste automatizado, que roda com `mp` **mockado**. Um
mock aceita qualquer payload; o addon nativo não.

Esta revisão cruza cada suposição com a arquitetura. **Nenhuma linha de código
mudou** — a rodada foi de leitura, de propósito: achar e registrar sem consertar
no calor da descoberta.

> **Atualização de 09/08/2026 — dois dos quatro 🔴 foram consertados.** O
> `death-service` (§6, os dois achados) e o `safe-zones` (§2) saíram em
> [`09fbb12`](https://github.com/vinicius3232/skymp-heavy-rp/commit/09fbb12), numa rodada separada que fez **só** os dois
> consertos. Os vereditos abaixo foram atualizados no lugar, com a marca ✅
> **corrigido** e o que mudou.
>
> **Atualização de 14/08/2026 — o terceiro saiu.** O `voip-service` (§5) foi
> corrigido em [`112d51b`](https://github.com/vinicius3232/skymp-heavy-rp/commit/112d51b), também numa rodada de um
> conserto só. **Resta `hit-events` (§1) em 🔴**, sem conserto e de propósito — a
> priorização no fim explica por que ele não deve entrar antes da sessão.
>
> O texto do achado foi **mantido no passado**, não apagado: o que ele descreve
> aconteceu, e um documento de auditoria que reescreve o diagnóstico depois do
> conserto perde a única coisa que o torna útil na próxima vez.

## Como ler os vereditos

| | Significado |
|---|---|
| ✅ **Confirmado** | A suposição bate com o que se sabe da arquitetura real. |
| 🟡 **Provável, pendente de Fase 0** | A arquitetura sustenta a suposição; só jogador real fecha. É o resultado esperado da maioria. |
| 🔴 **Desalinhado** | A suposição não bate com o que a arquitetura faz. |
| ✅ **Corrigido** | Era 🔴; o código mudou. Traz o commit e o que o conserto **não** alcança. |
| ⚪ **Não verificável** | Nem a referência upstream nem o código local respondem. |

Procedência, como no resto do projeto: **`[DOC]`** é código-fonte primário lido;
**`[DEEPWIKI]`** é a wiki gerada, não conferida contra o código — evidência, não
veredito fechado. Nesta rodada a distinção pagou duas vezes: a wiki **omite**
`locationalData` da lista de PropertyBindings, o que teria condenado três
serviços por engano (o código primário desmentiu, §8.2); e a wiki **afirma** que
só `connect`/`disconnect`/`packet` chegam ao JS, o que a §9.1 desmente com a
cadeia inteira lida no código.

---

## Tabela-resumo

| Sistema | Veredito | Em uma frase |
|---|---|---|
| `core/hit-events.js` | 🔴 | Existe um caminho nativo (`mp["onPapyrusEvent:OnHit"]`) com o agressor **já resolvido e validado pelo servidor**, e não o usamos — coletamos em paralelo a ele. |
| `core/safe-zones.js` | ✅ **corrigido** | Era 🔴: o `cellId` do exemplo (`"0x162e2"`) não era `FormDesc`, a zona nunca casaria e falharia **aberta**. Exemplo corrigido e o loader agora **recusa e grita**. `09fbb12` |
| `identity-service` | ✅ | Resolução de nome por observador é 100% nossa, em banco; não há suposição sobre o SkyMP para conferir. |
| `nametag-service` | 🟡 | A projeção mundo→tela não é contrariada por nada; a wiki aponta um caminho mais barato (`SetTextRefr()`) que ninguém verificou. |
| `voip-service` | ✅ **corrigido** | Era 🔴: calculava distância entre atores **sem comparar célula** — único dos três sistemas de proximidade que não fazia isso. O `tickProximity` agora guarda a célula junto com a posição e descarta o par quando divergem. [`112d51b`](https://github.com/vinicius3232/skymp-heavy-rp/commit/112d51b) |
| `death-service` | ✅ **corrigido** | Eram dois: o servidor respawnava sozinho em 25 s e o payload do respawn lançava. O handler passa a **bloquear o respawn nativo do que é dele**, e o payload está na forma que o addon aceita. `09fbb12` |
| `market-stalls-service` / governança | 🟡 | Lê `cellOrWorldDesc` corretamente e compara célula com célula; duas properties de barraca ficam ⚪. |
| `npc-cleaner.js` | ✅ | `baseDesc` no formato `"1a6a0:Skyrim.esm"` é **exatamente** o que `BaseDescBinding` devolve. |
| Escala de mob | ⚪ | Metade `[DOC]` e fechada (lista nivelada é do servidor); a outra metade — se **estatística** escala por cliente — segue em aberto e é medição da Fase 0. |

**Um achado é sistêmico e explica dois dos 🔴:** o projeto trata identidade de
célula como *hexadecimal com prefixo `0x`*, e o SkyMP a trata como **`FormDesc`
em string** (`"162e2:Skyrim.esm"`). Ver §10 — **os dois pontos foram corrigidos
em `09fbb12`**, e a §10 registra o que sobrou como regra para as próximas
features.

**O que mudou da primeira passagem para esta:**

| Sistema | Antes (§8) | Agora (§8 + §9) | Por quê |
|---|---|---|---|
| `core/hit-events.js` | 🟡 | **🔴** | §9.1 `[DOC]`: o `OnHit` nativo chega ao gamemode e já resolve o `0x14` |
| `voip-service` | 🟡 | **🔴** (✅ corrigido depois, `112d51b`) | Leitura de código nesta passagem: `tickProximity` ignora a célula |
| Escala de mob | ✅ | **⚪** | §9.8 registra explicitamente que a wiki **não** responde a parte que importa |

---

## 1. `core/hit-events.js` — evidência de combate por proximidade

> **Este é o achado que a §9 trouxe, e ele inverte o veredito da primeira
> passagem.** Nada aqui diz que o sistema atual está quebrado. Diz que existe um
> caminho mais forte, disponível hoje, que não estamos usando.

**Suposição do código.** O cabeçalho de
[hit-events.js:15-21](../../skymp/gamemode/core/hit-events.js) e a
`ARCHITECTURE.md` §1.4.5 registram a premissa em texto: *"o SkyMP **recusou**
expor o pacote de hit ao gamemode (issue #1338) — o evento é reconstruído do lado
do cliente"*. Disso decorre tudo o mais: que `makeEventSource` é o único caminho
barato; que o snippet precisa capturar `ctx.sp.on('hit')` por conta própria; que
`0x14` é problema nosso para traduzir
([hit-events.js:138](../../skymp/gamemode/core/hit-events.js)); e que o
resultado é *"evidência, não enforcement"* porque vem cru do cliente.

**O que a arquitetura diz.**

- **`[DOC]`** (§9.1, cadeia lida arquivo por arquivo no upstream `main`) — não
  existe `mp.onHit`, **mas o evento chega assim mesmo**, por outro nome:

  ```js
  mp["onPapyrusEvent:OnHit"] = (
    targetFormId, akAggressor, akSource, akProjectile,
    abPowerAttack, abSneakAttack, abBashAttack, abHitBlocked
  ) => { /* ... */ };
  ```

  O caminho é `ActionListener::OnHit` → `SendPapyrusOnHitEvent` →
  `MpForm::SendPapyrusEvent` → `PapyrusEventEvent` (que prefixa
  `"onPapyrusEvent:"`) → `ScampServerListener::OnMpApiEvent`.
- **`[DOC]`** (§9.1, item 2 da cadeia) — **o servidor traduz o `0x14` sozinho**:
  `if (hitData.aggressor == 0x14) { aggressor = myActor; ... }`, e o mesmo para
  `target`. A tradução que fazemos à mão já vem feita.
- **`[DOC]`** (§9.1, itens 3 e 4) — antes de despachar, o servidor **já validou**:
  agressor pertence ao usuário (ou é o *hoster* registrado), mesma
  célula/worldspace, distância ≤ 4096 unidades, agressor não está morto, alcance
  de arma e cadência (`CanHit`).
- **`[DOC]`** (§9.1, item 11 / `PapyrusUtils.h:14-49`) — o agressor chega como
  `{ type: 'form', desc: '<FormDesc>' }`, que é **exatamente** o formato que
  `core/papyrus.js` (`actorRef`/`baseRef`) já usa.
- **`[DEEPWIKI]`** (§9.4, `hitService.ts:15-69`) — o cliente nativo manda `OnHit`
  como **RELIABLE** (ao contrário de movimento e vitais, que são UNRELIABLE), e
  **já filtra**: descarta golpe em objeto estático e só aceita atacante que seja
  o jogador local ou um NPC hospedado por ele.
- **`[DOC]`** — um `grep` por `onPapyrusEvent` no gamemode inteiro não devolve
  nada. Nem o `types/mp.d.ts` declara. Nunca usamos.

**Veredito: 🔴 Desalinhado.**

A premissa escrita no cabeçalho do arquivo — *"o dado não chega ao gamemode"* —
**é falsa**. "Não existe `mp.onHit`" é verdade e continua sendo; a conclusão
tirada dali não. A referência já registra a correção na própria §4, com o aviso
de que aquela seção estava parcialmente errada desde que foi escrita.

**Impacto prático.** Não é que o combate esteja quebrado hoje: o
`makeEventSource` continua sendo um caminho válido, e o sistema de episódios em
volta dele é nosso e não muda. O custo é outro, e tem três partes:

1. **Estamos coletando em paralelo a um canal que já existe.** O cliente nativo
   já captura, filtra e envia o golpe como RELIABLE. Nosso snippet injeta um
   segundo `ctx.sp.on('hit')` no mesmo loop de jogo para capturar o mesmo evento
   — trabalho duplicado na máquina do jogador, que é justamente onde o cabeçalho
   do arquivo diz querer ser econômico.
2. **A qualidade da evidência é menor do que precisaria ser.** Hoje aceitamos o
   que o snippet disser. Pelo caminho nativo, o servidor já teria descartado
   golpe de ator morto, de célula diferente, fora de alcance e fora de cadência
   **antes** de nos contar. Para arbitragem de RDM — que é o propósito declarado
   do módulo — isso é um degrau de confiabilidade a mais, de graça.
3. **O `0x14` deixa de ser risco.** Ele é hoje o único ponto do módulo cuja
   fonte é o Red House de 2021 e não documentação nossa, e a primeira passagem
   desta revisão o marcou como "só a Fase 0 fecha". Pelo caminho nativo a questão
   não existe.

**Os limites, para que a proposta não seja lida como maior do que é.**
**`[DOC]`** (§9.1): devolver `false` neste evento **não impede o dano** — só
impede o despacho para a VM Papyrus; `SendPapyrusOnHitEvent` descarta o retorno
de `Fire()` e o cálculo de dano roda em seguida. **Continua sendo observação, não
enforcement** — a decisão central do módulo (`ARCHITECTURE.md` §1.4.5) permanece
correta e não deve mudar. O evento também dispara **no alvo**, não no agressor. E
nada disto rodou neste servidor: é `[DOC]` de upstream, não observação nossa.

**Proposta (não implementada).**

1. Registrar `mp["onPapyrusEvent:OnHit"]` e alimentar o **mesmo** `registrarGolpe`
   que já existe, convertendo `akAggressor.desc` → FormID com
   **`mp.getIdFromDesc`** **`[DOC]`** (§8.3). A agregação em episódio, o descarte
   de dano em si mesmo e o teto por episódio não mudam uma linha — são a parte
   deste projeto e continuam valendo.
2. Manter os **dois caminhos ligados durante a Fase 0**, com origem marcada na
   linha de `audit_logs` (o campo `origem` já existe exatamente para isso). É a
   única forma barata de descobrir se os dois veem o mesmo golpe.
3. Só então decidir se o `makeEventSource` sai. Ele tem um dado que o caminho
   nativo pode não ter no mesmo formato (`isSneakAttack` etc. chegam como args
   Papyrus posicionais) — conferir antes de remover, não junto.

Isto **não** é para a rodada de código pré-Fase 0: ver a priorização em
"O que isto muda para a Fase 0".

---

## 2. `core/safe-zones.js` — bloqueio por célula/posição

**Suposição do código.** Que `mp.get(actorId, 'locationalData')` devolve célula e
posição; que `loc.pos` é um array de 3 números; e que a célula do ator pode ser
comparada por **igualdade de string** com o `cellId` escrito na config
([safe-zones.js:177-189](../../skymp/gamemode/core/safe-zones.js)).

**O que a arquitetura diz.** **`[DOC]`** `LocationalDataBinding.cpp` (referência
§8.4) devolve exatamente:

```js
{ cellOrWorldDesc: "1a26f:Skyrim.esm", pos: [x,y,z], rot: [x,y,z] }
```

- A **leitura está certa**: `loc.cellOrWorldDesc` é o primeiro item da nossa
  cadeia defensiva, é string, e `loc.pos` é array de 3 — o `_distancia3D` e o
  raio funcionam. Os outros três nomes da cadeia (`cellOrWorldSpaceId`,
  `cellId`, `worldOrCell`) não existem: são código morto, mas inofensivo.
- **O formato do valor está errado.** **`[DOC]`** `FormDesc.cpp` (§8.5): a string
  canônica é hex **sem prefixo `0x`**, `:`, nome do arquivo. O exemplo em
  `skymp/config/safe-zones.example.json` traz `"cellId": "0x162e2"`.

`"0x162e2" !== "162e2:Skyrim.esm"` — a comparação de string nunca casa.

**Veredito: 🔴 Desalinhado — ✅ corrigido em [`09fbb12`](https://github.com/vinicius3232/skymp-heavy-rp/commit/09fbb12).**

**Impacto prático.** Hoje é **latente**, e por dois motivos independentes:
`zones` nasce vazia com `enabled` em `false`, e — confirmado por leitura nesta
passagem — **nenhum dos quatro chamadores de `actionPolicy.canPerform` informa
`context.actorId`**, então a dimensão de lugar nem é consultada. É por isso que
nenhum teste pegou, e a `ARCHITECTURE.md` §1.4.7 já registrava esse segundo fato.

O problema é o dia em que alguém preencher a config copiando o exemplo: a zona é
aceita pelo loader (o `cellId` é uma string não-vazia, que é tudo que ele valida),
aparece nos logs como carregada, e **nunca dispara**. Uma zona segura que falha
assim falha **aberta** — a proteção simplesmente não existe, sem erro em lugar
nenhum. É o modo de falha que o próprio cabeçalho do arquivo diz querer evitar:
*"config ausente não pode virar comportamento surpresa"*.

### ✅ Corrigido em [`09fbb12`](https://github.com/vinicius3232/skymp-heavy-rp/commit/09fbb12)

Os itens 1 e 2 da proposta saíram; o 3 não, e o motivo está registrado abaixo.

1. **`safe-zones.example.json` agora traz `"162e2:Skyrim.esm"`**, com um bloco
   `_sobre_cellid` explicando o formato e por que errar nele não dá erro. Era o
   caminho pelo qual o defeito entraria — quem copia o exemplo faz o esperado.
2. **`loadZones` recusa `cellId` fora do formato e grita.** Quatro casos
   cobertos: prefixo `0x`, ausência de `:`, hex inválido antes do `:` e arquivo
   vazio depois. O log diz a forma certa, não só que está errada. **A zona sai
   da lista** em vez de entrar inerte — as duas protegem igual (nada), mas só uma
   aparece; é a mesma disciplina da categoria desconhecida logo ao lado.
3. **A conversão a partir de FormID numérico (`mp.getDescFromId`) não entrou
   aqui.** Ela resolveria o formato sem depender de o humano acertar, mas trocaria
   uma config declarativa em disco — legível, versionada, conferível sem servidor
   — por uma que só se resolve com o `mp` vivo. Para uma lista que ainda nasce
   vazia e cuja primeira zona nem foi decidida, validar é mais barato que
   converter. O `death-service` **usa** a derivação (§6.3), porque lá a constante
   é do código e não da config.

`parseZones` foi separado da leitura de disco para que o teste exercitasse config
malformada sem escrever em `skymp/config/safe-zones.json` — um teste que falhasse
no meio deixaria para trás uma config de zona segura ativa, que é exatamente a
surpresa que este módulo existe para não causar. Mesmo padrão do
`sweepOnce(policy = loadPolicy())` do `npc-cleaner`.

**O que o conserto não muda:** as zonas continuam nascendo vazias e desligadas, e
**nenhum chamador de `canPerform` informa `context.actorId`** — então a dimensão
de lugar segue não sendo consultada. Isto era latente antes e continua latente; o
que mudou é que agora falha **alto** em vez de aberto. A `ARCHITECTURE.md` §1.4.7
continua sendo o registro correto disso.

---

## 3. `identity-service` — quem sabe o nome de quem

**Suposição do código.** Que o servidor decide, **por observador**, qual nome cada
pessoa vê (`identity.getDisplayName(observador, alvo)`), e que isso é estado do
nosso banco (`character_known_identities`), não do SkyMP.

**O que a arquitetura diz.** Nada — e isso é o resultado, não uma lacuna. Uma
leitura do arquivo inteiro confirma que **`identity-service.js` não toca `mp` em
lugar nenhum**: é `database.js`, um cache em `Map` por observador, e funções
puras de sanitização. Não há suposição sobre a arquitetura do SkyMP para
conferir, porque não há dependência dela.

**Veredito: ✅ Confirmado.**

O sistema é realidade compartilhada no sentido mais forte que este projeto tem:
resolvido num lugar só, do lado do servidor, a partir de estado persistido que o
cliente não pode tocar. É o único dos oito que não depende do SkyMP para ser
verdade — e por isso o único que a Fase 0 não precisa validar quanto ao
mecanismo, só quanto à experiência.

A `ARCHITECTURE.md` §1.4.8 registra corretamente que a parte **não** provada é a
exibição, não a resolução. Ela é o sistema seguinte.

---

## 4. `nametag-service` — a projeção mundo→tela

**Suposição do código.** Que `ctx.sp.worldPointToScreenPoint` é alcançável do
snippet injetado via `makeProperty`/`updateOwner`; que
`ctx.getFormIdInClientFormat` traduz o FormID de servidor; que os eixos vão de
−1 a +1 com `y` positivo para cima; e que **alguém precisa projetar mundo→tela a
cada quadro** para a etiqueta acompanhar o ator
([nametag-service.js:209-229](../../skymp/gamemode/nametag-service.js)).

**O que a arquitetura diz.**

- **`[DOC]`** `mp.makeProperty` está registrado em `ScampServer.cpp` (§8.3) — o
  canal existe, e já é o mesmo comprovado de `browserModal`/`panelData`.
- **`[DOC]`** A escolha do alvo compara `_celula(loc)` **dos dois atores**, ambos
  vindos de `locationalData`. Como é célula contra célula (e não célula contra
  config), o formato `FormDesc` não atrapalha: strings iguais comparam iguais.
  **Este sistema não é atingido pelo achado da §10.**
- **`[DEEPWIKI]`** (§9.6, `TextApi.cpp:8-181`) — a `TextApi` do SkyrimPlatform
  expõe **`SetTextRefr()`**, que *"prende o texto a uma referência do jogo, por
  FormId"*, com o desenho feito por overlay DirectX. Se isso funcionar como a
  wiki descreve, **a projeção manual é desnecessária**: o texto acompanharia o
  ator sozinho, sem `worldPointToScreenPoint`, sem laço a 20 Hz e sem travessia
  de CEF por atualização.
- ⚠️ **`[DEEPWIKI]`, e a wiki se contradiz aqui.** A página `3.1.2` afirma que as
  coordenadas de texto são **só de tela** e que world-space "não é especificado";
  a `3.1.1` documenta `SetTextRefr()`. A segunda é mais específica e
  provavelmente a certa, **mas nenhuma foi conferida no código**.
- **`[DEEPWIKI]`** (§9.6, `view/worldView.ts:71-85`) — **todos os `FormView` são
  destruídos quando o jogador troca de worldspace/célula.** Qualquer coisa presa a
  uma entidade renderizada morre na troca de célula e precisa ser recriada.

**Veredito: 🟡 Provável, pendente de Fase 0.**

A suposição central — *"o cliente consegue saber onde um ator aparece na tela"* —
não é contrariada por nada. `worldPointToScreenPoint` é `[DOC]` da documentação
oficial do SkyrimPlatform, citada no próprio cabeçalho do arquivo. O que
permanece **⚪ dentro deste veredito** é o que a `ARCHITECTURE.md` §1.4.8 e o §4
do cabeçalho já registram com o peso certo: a função nunca foi chamada, a
convenção dos eixos não foi verificada, ponto atrás da câmera é buraco conhecido
e o custo do `executeJavaScript` a 20 Hz não foi medido. Esta revisão **não muda**
aquele registro; confirma que ele é honesto.

**Duas notas, não achados:**

1. **`SetTextRefr()` é a primeira coisa a abrir quando a nametag voltar à mesa** —
   `TextApi.cpp:8-181`. É `[DEEPWIKI]`, então não derruba nem confirma o desenho
   atual; mas se a wiki estiver certa, o caminho que a POC escolheu é o mais caro
   dos dois, e o custo de descobrir isso agora é uma leitura de arquivo.
2. **A destruição de `FormView` na troca de célula já está coberta por acidente
   feliz.** O snippet resolve o form a cada tick com `getFormEx` e chama
   `esconder()` quando não acha ([nametag-service.js:205-207](../../skymp/gamemode/nametag-service.js)),
   então a etiqueta some sozinha em vez de ficar presa a uma referência morta.
   Vale saber que o comportamento é ciclo de vida da plataforma, não bug — para
   ninguém "consertar" isso depurando *"a etiqueta sumiu quando entrei na
   taverna"*.

**Nota herdada da primeira passagem, ainda válida.** O `tick()` varre
`listActiveActorIds()` e faz O(n²) de distância 3D a cada 2 s, enquanto o servidor
**já mantém** vizinhança por grid e a expõe (`mp.getNeighborsByPosition`,
properties `neighbors`/`actorNeighbors`) — **`[DOC]`** §8.2 e §8.3. Não está
errado, está caro à toa. Vale considerar quando a POC virar feature: hoje o
gargalo desconhecido é a CEF, não a distância.

---

## 5. `voip-service` — volume por distância e retransmissão por proximidade

> **Veredito revisto nesta passagem.** A primeira leitura confirmou que a
> **leitura** de `locationalData` está correta e parou aí. Uma leitura do
> `tickProximity` inteiro mostra o que falta depois dela.

**Suposição do código.** Que `mp.get(actorId, 'locationalData')` dá posição
confiável a cada 2 s para calcular volume por distância; e — implicitamente —
que **a distância euclidiana entre dois `pos` é uma medida de "estão perto um do
outro no mesmo lugar"**
([voip-service.js:404-421](../../skymp/gamemode/voip-service.js)).

**O que a arquitetura diz.** **`[DOC]`** (§8.4) `locationalData` devolve `pos`
**e** `cellOrWorldDesc`. Os dois campos vêm juntos, na mesma leitura, porque a
posição sozinha não identifica um lugar: cada célula de interior tem origem de
coordenadas própria, e worldspaces distintos são espaços distintos.

O `tickProximity` lê o objeto e guarda **só o `pos`**:

```js
const loc = mp.get(actorId, 'locationalData');
if (!loc) continue;
actors.push({ actorId, entry, pos: loc.pos });   // cellOrWorldDesc descartado
```

Depois compara `distance3D(client.pos, peer.pos)` contra `VOICE_RANGES` sem
nenhuma checagem de célula.

**Este é o único dos três sistemas de proximidade do projeto que faz isso**, e é
o que torna o achado sólido em vez de especulativo:

| Onde | Compara célula? |
|---|---|
| `core/range-utils.js:32` | Sim — `if (ca && cb && ca !== cb) return Infinity;` |
| `nametag-service.js:271` | Sim — pula candidato de célula diferente, com comentário explicando por quê |
| `voip-service.js:417` | **Não** |

**Veredito: 🔴 Desalinhado — ✅ corrigido em [`112d51b`](https://github.com/vinicius3232/skymp-heavy-rp/commit/112d51b).**

**Impacto prático.** Dois jogadores em células diferentes com coordenadas
numericamente próximas ouvem um ao outro. O caso não é exótico: interiores do
Skyrim são construídos em torno da origem, então duas tavernas distintas — ou uma
taverna e uma masmorra — têm coordenadas na mesma vizinhança numérica. O efeito é
voz atravessando de um interior para outro, ou de um interior para o exterior,
sem que exista caminho entre eles.

E o efeito não para na voz: o mesmo `_audienceByActor` montado neste laço é o que
o helper nativo usa para **retransmitir `audio_frame`** por proximidade
(`ARCHITECTURE.md` §1.4.4). Um erro de audiência aqui é entrega de áudio a quem
não deveria receber, não só um ganho errado num slider.

Para um servidor de Heavy RP isso é exatamente a classe de falha que esta revisão
existe para achar: quebra a premissa de que *"o que eu ouço corresponde a onde eu
estou"*, que é realidade compartilhada no sentido mais literal.

Vale dizer o que **não** está errado: o resto do caminho de áudio — WebSocket na
7778, ticket de uso único, helper nativo capturando fora do CEF, retransmissão com
volume anexado — **não passa pelo SkyMP**, e a arquitetura do upstream nem
sustenta nem contraria. Aquilo continua 🟡 pelo motivo de sempre: **ninguém ouviu
áudio ainda**.

### ✅ Corrigido em [`112d51b`](https://github.com/vinicius3232/skymp-heavy-rp/commit/112d51b)

A proposta era guardar a célula junto com a posição e descartar o par quando
divergissem. Saiu inteira, e contida no `tickProximity` como previsto — duas
linhas de comportamento, nenhuma mudança de formato.

1. **O laço que monta `actors` passa a guardar a célula**, via
   `rangeUtils.getCell(loc)`. Não é economia de digitação: a quarta cadeia
   defensiva de nomes de campo seria o quarto lugar do repositório com opinião
   própria sobre o que conta como célula, e o dia em que uma delas divergisse a
   voz e a nametag discordariam sobre onde a mesma pessoa está. A regra continua
   num lugar só — `core/range-utils.js` não foi tocado, só lido.
2. **O laço interno descarta o par quando as duas células existem e divergem**,
   antes de calcular distância. É literalmente a regra do
   `range-utils.distanceBetween` (`if (ca && cb && ca !== cb) return Infinity`) e
   a mesma que o `nametag-service` aplica — o `voip-service` deixa de ser o
   terceiro voto discordante da tabela acima.

**Célula desconhecida não descarta ninguém**, e isso é decisão, não descuido:
`ca && cb` é a mesma guarda do `range-utils`. Falta de informação não é prova de
que duas pessoas estão separadas, e derrubar o par por ausência de campo faria a
voz sumir sozinha em qualquer cenário onde o `locationalData` viesse magro — uma
falha silenciosa trocada por outra. É também o que os mocks dos outros blocos
deste arquivo de teste devolvem (`{ pos }` sem célula), então o comportamento
anterior deles continua exercitado exatamente como era.

**Dois testes novos**, em bloco próprio com `mp` mockado devolvendo os dois
campos: mesma célula dentro do alcance continua se ouvindo (o caso feliz não
regride), e células diferentes com coordenadas na mesma vizinhança numérica não
aparecem no `proximity_update` uma da outra, não entram no `_audienceByActor` e
não recebem `audio_frame`. Os dois foram conferidos contra o mutante: removida a
checagem, o segundo reprova; invertida, os dois reprovam. Suíte do gamemode:
**498 → 500, zero falhas**.

**O que o conserto não alcança.** O sistema de voz continua 🟡 pelo motivo maior
e inalterado: **ninguém ouviu áudio ainda**. Este conserto tira do caminho um
defeito que a Fase 0 poderia não revelar; não substitui a sessão que vai revelar
o resto. E o custo O(n²) do tick a cada 2 s segue igual — a checagem de célula é
uma comparação de string a mais por par, e a nota herdada da §4 sobre
`mp.getNeighborsByPosition` continua valendo como otimização de quando a POC
virar feature.

---

## 6. `death-service` — autoria de morte e resgate por proximidade

Este é o sistema onde a rodada se pagou. **Dois desalinhamentos independentes.**

### 6.1 O que está confirmado

**`[DOC]`** `gamemode_events/DeathEvent.cpp` (§8.6) confirma, exatamente como
`ARCHITECTURE.md` §1.4.3 descreve:

- O hook chama-se literalmente `"onDeath"`.
- Os argumentos são `[actorId, killerId]`, com **`killerId = 0`** quando não há
  autor — o nosso tratamento de "0 = sem autor" está certo.
- **`[DOC]`** `ScampServerListener.cpp:41-56` busca `mp.onDeath` como **property
  do objeto `mp`**. Ou seja: `mp.onDeath = handler` é a convenção correta, e a
  decisão do `core/death-events.js` de ser dono único do slot está bem fundada —
  o slot é mesmo exclusivo, e um segundo `mp.onDeath = ...` apagaria o primeiro
  em silêncio, exatamente como o cabeçalho daquele arquivo argumenta.

A §9 acrescenta um reforço ao desenho, e vale registrar porque é raro: **`[DEEPWIKI]`**
(§9.4, `sendInputsService.ts:137-196`) mostra que `ChangeValues` — o pacote que
carrega HP — é enviado **só quando muda**, com piso de 2000 ms, e atrasa 500 ms
durante conjuração **exceto quando `health = 0`**. O upstream tratou morte como o
caso que não pode atrasar. Nossa arquitetura foi para o mesmo lado por conta
própria ao adotar `mp.onDeath` como gatilho primário.

O mesmo dado condena o caminho antigo com um número que ninguém tinha: **o
polling de 2 s lia um valor que também se atualiza a cada ~2 s**, então o atraso
real era o dobro do que supúnhamos. A rede de segurança é mais frouxa do que o
comentário em [death-service.js:159](../../skymp/gamemode/death-service.js)
dá a entender — o que importa para o Achado A abaixo.

Isso tudo é ✅ dentro do sistema.

### 6.2 🔴 Achado A — o servidor respawna sozinho em 25 s · ✅ corrigido

**Suposição do código.** Que, depois de `onDeath`, o personagem fica onde caiu e
sob nosso controle pelos 4 minutos de `BLEED_OUT_MS`, até alguém usar `/socorrer`
ou o bleed-out fechar.

**O que a arquitetura faz.** **`[DOC]`** `DeathEvent::OnFireSuccess` chama
**`actor->RespawnWithDelay()`**. **`[DOC]`** `GameModeEvent::Fire` só chama
`OnFireSuccess` se **nenhum** listener devolveu `false`. **`[DOC]`**
`ScampServerListener.cpp:105-111` fixa o contrato:

| `mp.onDeath` devolve | Efeito |
|---|---|
| `undefined` | não bloqueia → **respawn automático acontece** |
| `false` | bloqueia → sem respawn |
| lança | erro logado, **não bloqueia** |

Nosso handler é
`mp.onDeath = (actorId, killerId) => _dispatch(actorId, killerId)`
([death-events.js:112](../../skymp/gamemode/core/death-events.js)), e
`_dispatch` é um laço `for` sem `return`
([death-events.js:78-89](../../skymp/gamemode/core/death-events.js)) —
**devolve `undefined`**. Os handlers dos assinantes também têm o retorno
descartado: `handler(actorId, killerId)` é chamado como statement.

**`[DOC]`** `MpChangeForms.h:109`: `float spawnDelay = 25.0f`. E um `grep` por
`spawnDelay` no gamemode inteiro não devolve nada — nunca ajustamos.

**A §9 acrescenta um segundo caminho para o mesmo efeito**, que a primeira
passagem não tinha: **`[DEEPWIKI]`** (§9.2, `PartOne.cpp:175-221`)
`PartOne::SetUserActor` **chama `RespawnWithDelay()` se o ator estiver morto**.
Ou seja, mesmo que o `DeathEvent` fosse bloqueado, um jogador que caísse e
reconectasse seria respawnado pelo próprio handshake. Bloquear o evento resolve o
caminho principal, não todos.

**Impacto prático.** O jogador morre. Nosso estado vira `DOWNED` e abre a janela
de socorro de 4 minutos. **Aos 25 segundos o servidor ressuscita e teleporta o
personagem para o `spawnPoint`**, por conta própria, sem passar por
`executeRespawn`, sem penalidade de ouro, sem `characterState`, sem
`panelRefreshBus`. A pessoa levanta no meio do mundo enquanto a nossa máquina de
estado ainda a considera caída e aguardando resgate pelos 3,5 minutos restantes —
e `/socorrer` continua "funcionando" sobre alguém que já está de pé em outro
lugar.

Isto **derruba o desenho inteiro de morte com consequência**, que é o ponto
central de Heavy RP do `SKYMP_RP_DEVELOPMENT_PLAN.md` §8.1. E é invisível em
teste: o `mp` mockado não tem `DeathEvent`, não tem `spawnDelay` e nunca
respawna ninguém.

### ✅ Corrigido em [`09fbb12`](https://github.com/vinicius3232/skymp-heavy-rp/commit/09fbb12) — decisão: bloquear (opção 1)

A decisão estava registrada aqui como aberta, entre **bloquear sempre** e
**bloquear e reprogramar `spawnDelay`**. Fechou na primeira, e **não por
preferência de estilo: a segunda não funciona.**

**Por que reprogramar o `spawnDelay` não resolve.** O respawn deste projeto não é
um teleporte. `executeRespawn` faz `Resurrect` → `locationalData` →
`_wasDead=false` → `characterState.set(NORMAL)` → notificação →
`panelRefreshBus`; e o `bleedOut` antes dele cobra a penalidade pelo
`transaction-service` e grava o contexto anti-RDM. **`RespawnWithDelay()` não faz
nada disso.** Alinhar o relógio nativo só faria o respawn empobrecido acontecer na
hora certa — sem penalidade, sem transição de estado, sem painel. O relógio nunca
foi o problema; o problema é *quem* respawna.

**O que a opção 1 perde, conferido antes de escolher.** **`[DOC]`**
`DeathEvent` não sobrescreve `OnFireBlocked`, então bloquear não deixa nada
pendente no motor: perde-se o respawn, que é exatamente o que substituímos. Não
havia razão técnica escondida para a opção 2.

**O bloqueio é escopado, e é por causa do efeito de segunda ordem que esta seção
já tinha registrado.** `RespawnWithDelay` é como o servidor devolve **qualquer**
ator morto ao mundo, e o `hunting-service` vai assinar o mesmo hook — um
`return false` global mataria o respawn dos mobs junto. Então:

- **O barramento agrega retorno.** `_dispatch` devolve `false` se **algum**
  assinante pediu, `undefined` caso contrário. Não sai do laço cedo (bloquear é
  decisão do fim, não atalho que cala quem vem depois), só o booleano `false`
  exato conta (um `0` ou `null` por descuido não desliga o respawn do servidor), e
  **assinante que lança não bloqueia** — mesma regra do upstream, pela mesma
  razão: falha de um consumidor não pode virar decisão de mundo.
- **O `death-service` só reivindica ator com personagem ativo.** A checagem é
  `getActiveCharacterData`, síncrona e O(1), porque o motor lê o retorno no mesmo
  frame e não dá para esperar o `handlePlayerDowned`, que é async. Um lobo morto
  não tem `characterData`, o retorno fica `undefined`, e a fauna respawna normal —
  que é o requisito da §7.2 do `HOSTILE_MOB_ACTIVATION_DECISION.md`.

**O que o conserto NÃO alcança, e continua valendo.** **`[DEEPWIKI]`** (§9.2 da
referência, `PartOne.cpp:175-221`) `PartOne::SetUserActor` chama
`RespawnWithDelay()` se o ator estiver morto no handshake. **Um jogador que caia e
reconecte é respawnado por aquele caminho**, que não passa pelo `DeathEvent` e
portanto não passa por este bloqueio. Bloquear o evento resolve o caminho
principal, não todos — e isso é observação da Fase 0, não conserto desta rodada.
Vale incluir "cair e reconectar" nos passos da etapa de morte do
`FASE_0_ROTEIRO.md`.

### 6.3 🔴 Achado B — o payload do nosso respawn lança · ✅ corrigido

**Suposição do código.** Que `mp.set(actorId, 'locationalData', {...})` aceita
`{ pos, worldOrCell, angleZ }`
([death-service.js:369-373](../../skymp/gamemode/death-service.js)).

**O que a arquitetura exige.** **`[DOC]`** `LocationalDataBinding::Set` (§8.4) lê
exatamente `cellOrWorldDesc` (string), `pos` (array) e `rot` (array), via
`NapiHelper::ExtractString` / `ExtractNiPoint3`, que **lançam** quando o valor
não é do tipo esperado (`NapiHelper.h:96,218`).

Nosso objeto não tem `cellOrWorldDesc` (tem `worldOrCell`) e não tem `rot` (tem
`angleZ`). `Get("cellOrWorldDesc")` devolve `undefined`, que não é string →
**`std::runtime_error`**.

Dois agravantes que reforçam o veredito:

- **O projeto já sabe a forma certa em dois lugares.** `types/mp.d.ts:38-42`
  declara `LocationalData` como `{ pos, rot, cellOrWorldDesc }` — exatamente o
  que a §8.4 confirma —, e
  [governance-service.js:711-715](../../skymp/gamemode/governance-service.js)
  escreve o payload **correto** ao prender alguém. É o mesmo `mp.set` com a mesma
  property, com formas diferentes, no mesmo repositório. O `npm run typecheck` é
  informativo (`ARCHITECTURE.md` §1.4), então nunca reclamou.
- **`RESPAWN_CELL = '0x162e2'`**
  ([death-service.js:36](../../skymp/gamemode/death-service.js)) não é
  `FormDesc`. Mesmo com a chave certa, **`[DOC]`** `FormDesc::FromString("0x162e2")`
  não encontra `:`, cai no ramo sem arquivo, e `ToFormId` resolve para
  `0xff000000 + 0x162e2` — a faixa de forms **gerados pelo servidor**, não o
  Templo de Kynareth. Dois defeitos empilhados, e o segundo só apareceria depois
  de consertar o primeiro.

**Impacto prático.** Em `executeRespawn`, a ordem é: `Resurrect` via Papyrus
(linha 367) → `mp.set` (linha 369, **lança**) → e as linhas 374 a 382 **nunca
rodam**. Resultado: o personagem é ressuscitado **onde caiu**, `_wasDead`
continua `true`, `characterState` nunca volta para `NORMAL`, o jogador não recebe
notificação e o painel não atualiza. O `catch` da linha 383 loga
`Failed to respawn actor` e o servidor segue.

Combinado com o Achado A, o comportamento real na Fase 0 seria: morrer → levantar
sozinho aos 25 s em outro lugar → e, se alguém chegasse a acionar o bleed-out,
uma segunda ressurreição no lugar errado com o estado travado.

### ✅ Corrigido em [`09fbb12`](https://github.com/vinicius3232/skymp-heavy-rp/commit/09fbb12)

O payload virou `{ cellOrWorldDesc, pos, rot }`, e a célula é **derivada** com
**`mp.getDescFromId`** **`[DOC]`** — a forma preferível que a proposta apontava —
com `'162e2:Skyrim.esm'` só como rede para o caso de o método não existir (o
`market-stalls-service` já trata `getDescFromId` como possivelmente ausente).
Derivar sobrevive a mudança de load order; o literal escrito à mão, não.

**A varredura foi feita, e não assumiu que era só ali.** As quatro escritas de
`locationalData` do repositório foram conferidas: `admin-service` repassa o objeto
lido de `mp.get` (correto por construção), `governance-service` e `whitelist` já
usavam a forma certa. **Só o `death-service` estava errado** — o que reforça o
diagnóstico desta seção, e não o enfraquece: a forma certa já existia em dois
lugares do mesmo repositório.

**O que continua sem verificação, e agora está dito no código.** O `162e2` **não
foi conferido contra o ESM**. Ele veio herdado, e ninguém abriu o arquivo. O que
esta rodada consertou é o **formato**, que era defeito certo; o **valor** segue
sendo observação da Fase 0, registrado como tal tanto no `death-service.js` quanto
no `safe-zones.example.json`.

**O mock do teste passou a ser rigoroso, e isso é parte do conserto.** Enquanto o
`mp.set` do `death-service.test.js` guardava qualquer payload, o defeito ficava
verde — que é o parágrafo de abertura desta revisão: *um mock aceita qualquer
payload; o addon nativo não*. Ele agora emula `LocationalDataBinding::Set`, e
reverter o payload reprova dois testes — sendo o mais eloquente **"volta o
personagem pra NORMAL"**, que não é sobre posição nenhuma. Reprova porque o
`mp.set` lança antes e derruba as linhas seguintes junto, que é exatamente o
efeito real em produção.

### Veredito do sistema: 🔴 Desalinhado (dois achados) — ✅ **os dois corrigidos**

`mp.onDeath` e `killerId` já estavam ✅. O ciclo de vida em volta deles passou a
estar: uma autoridade só sobre o respawn, e um payload que o addon aceita. **O que
não mudou é o que sempre valeu — nada disto rodou com jogador conectado**, e é a
etapa de morte da Fase 0 que fecha.

---

## 7. `market-stalls-service` / governança — ações condicionadas a proximidade

**Suposição do código.** Que dá para condicionar ação à célula e à distância
lendo `locationalData`, priorizando mesma célula e depois menor distância
euclidiana ([market-stalls-service.js:154-158](../../skymp/gamemode/market-stalls-service.js)).

**O que a arquitetura diz.** **`[DOC]`** A leitura está correta: a cadeia começa em
`loc.cellOrWorldDesc`, que é o campo real (§8.4). O `'unknown'` no fim da cadeia
é um fallback que nunca será alcançado, o que é o comportamento desejado. A
governança valida alcance por `core/range-utils.js`, que **compara célula** — o
caminho certo, e o mesmo que o `voip-service` passou a reaproveitar quando o
achado da §5 foi corrigido.

**`[DEEPWIKI]`** (§8.7 / 2.4.2) reforça de fora: o servidor já valida posse de
ator em `SendToNeighbours` antes de aceitar mudança de estado, e
`MovementValidation::Validate` recusa teleporte impossível. Uma ação de mercado
condicionada a proximidade não está apoiada em posição que o cliente possa
inventar livremente.

**Veredito: 🟡 Provável, pendente de Fase 0.**

Nada na arquitetura contraria. O que falta é o de sempre: ninguém executou uma
compra com duas pessoas conectadas. O [`GOVERNANCE_MARKET_STALLS_TEST_PLAN.md`](../historico/GOVERNANCE_MARKET_STALLS_TEST_PLAN.md) já
existe para isso.

**Duas observações menores, nenhuma muda o veredito:**

1. **⚪ Duas properties da barraca não estão na lista de bindings padrão.**
   `spawnStallVisual` faz `mp.set(refId, 'scale', ...)` e
   `mp.set(refId, 'displayName', ...)`
   ([market-stalls-service.js:227-232](../../skymp/gamemode/market-stalls-service.js)).
   A lista real de `CreateStandardPropertyBindings()` — **`[DOC]`** §8.2 — traz
   `pos`, `angle` e `worldOrCellDesc` (as outras três usadas ali), mas **não**
   `scale` nem `displayName`. Não dá para concluir daí que falham: podem cair no
   caminho de property customizada (`DynamicFields`, §9.5) e simplesmente não
   produzir efeito visual, ou podem lançar. **Nem a referência nem o código local
   respondem** — fica ⚪, dentro de um sistema 🟡, e o barato é olhar no primeiro
   spawn de barraca da Fase 0 em vez de investigar agora.
2. **`getNearestCityId` compara coordenadas entre células**, com penalidade fixa
   de 50000 em vez de descarte
   ([market-stalls-service.js:296-301](../../skymp/gamemode/market-stalls-service.js)).
   É a mesma suposição que tornou o `voip-service` 🔴 (§5, já corrigido), mas
   aqui o efeito é limitado: a pergunta é "qual cidade cobra imposto", a
   penalidade já empurra a mesma célula para a frente, e o pior caso é atribuição
   de jurisdição errada, não voz atravessando parede. Registrado como design a
   revisar, não como desalinhamento.

---

## 8. `npc-cleaner.js` — curadoria por `baseDesc`

**Suposição do código.** Que `mp.get(npcActorId, 'baseDesc')` devolve uma
**string** no formato `"1a6a0:Skyrim.esm"`, comparável diretamente com a lista de
bloqueio da config; e que `mp.getActorsByProfileId(0)` enumera NPCs
([npc-cleaner.js:162-170](../../skymp/gamemode/npc-cleaner.js)).

**O que a arquitetura diz.**

- **`[DOC]`** `BaseDescBinding.cpp` devolve
  `FormDesc::FromFormId(refr.GetBaseId(), espmFiles).ToString()` — string, no
  formato `shortFormId` hex sem `0x` + `:` + arquivo. **`[DOC]`** `FormDesc.cpp`
  confirma o formato. `"1a6a0:Skyrim.esm"` é exatamente isso.
- **`[DOC]`** `getActorsByProfileId` está registrado em `ScampServer.cpp` (§8.3).
- **`[DOC]`** `baseDesc` está na lista de bindings padrão (§8.2), então a leitura
  é servida do estado do servidor.

**Veredito: ✅ Confirmado.**

Vale registrar por que este acertou: o comentário em
[npc-cleaner.js:40](../../skymp/gamemode/npc-cleaner.js) mostra que a versão
anterior comparava `baseDesc` (string) com FormID numérico e que isso foi
corrigido deliberadamente. O `npc-policy.example.json` já traz o formato certo.
Foi o único sistema que enfrentou a questão do formato de `FormDesc` de frente —
e é justamente o que a §10 mostra que faltou nos outros dois.

O `safeRadius` se apoia em `rangeUtils.distanceBetween`, que compara célula e
devolve `Infinity` quando divergem — correto pela §8.4, e a mesma disciplina que
faltava no `voip-service` até a §5 ser corrigida.

---

## 9. Escala de mob — meia resposta, e a metade que falta é medição

> **Veredito revisto nesta passagem.** A primeira versão marcou ✅ citando o
> fechamento da lista nivelada. A §9.8 da referência mostra que isso responde
> menos da pergunta do que parecia.

**A investigação não foi reaberta**, como o plano manda. O que mudou é a leitura
do que ela fechou.

**O que está fechado, `[DOC]`.** `HOSTILE_MOB_ACTIVATION_DECISION.md` §7.4(b)
registra, com arquivos e funções, que a **resolução de lista nivelada é do
servidor**, com nível constante e resultado guardado por ator. A §9.8 da
referência é explícita em pedir que ninguém refaça essa verificação.

**O que continua aberto.** A §9.8 da referência lista, entre as *"perguntas deste
projeto que a wiki inteira não respondeu"*:

> **Se estatística de NPC escala por nível do jogador no cliente.** O
> `HOSTILE_MOB_ACTIVATION_DECISION.md` §7.4(c)(2) já registrava esse limite; a
> wiki não o toca. Segue em aberto.

São duas perguntas, e só a primeira foi fechada. *Qual* criatura a lista nivelada
produz é decisão do servidor; *quão forte* aquela criatura é na tela de cada
jogador não está respondido por nada que tenhamos lido.

E é a segunda que importa para realidade compartilhada. O
`FAUNA_CENSUS_PROTOCOL.md` (Passo 2) diz isso com todas as letras:

> Se o SkyMP herdar isso **por cliente**, dois jogadores lado a lado veem o mesmo
> lobo com forças diferentes — e "socorri você contra o urso" deixa de ser uma
> frase com sentido único. Isso não é balanceamento; é **realidade
> compartilhada**, que é pré-requisito de Heavy RP.

**Veredito: ⚪ Não verificável com o que temos.**

Não é um retrocesso: a pergunta já tem instrumento e protocolo (`/censofauna` +
`/censofauna alvo <actorId>`, com dois jogadores de níveis diferentes comparando
as duas telas). O que esta revisão corrige é o registro — marcar ✅ aqui daria a
impressão de que a arquitetura já garantiu o que ela não garante, e essa é
exatamente a classe de otimismo que o prompt desta rodada pede para evitar.

O comando sozinho não responde. **A comparação que decide é entre as duas telas**,
e ela é da Fase 0.

---

## 10. O achado sistêmico: identidade de célula não é hexadecimal

Dois dos 🔴 têm a mesma raiz, e vale nomeá-la separada dos sistemas:

**O projeto trata identidade de célula como número hex com prefixo `0x`. O SkyMP
a trata como `FormDesc` serializado em string.**

| Onde | Escrito | Deveria ser | Estado |
|---|---|---|---|
| `death-service.js:36` | `RESPAWN_CELL = '0x162e2'` | `'162e2:Skyrim.esm'` | ✅ derivado por `mp.getDescFromId` em `09fbb12` |
| `safe-zones.example.json` | `"cellId": "0x162e2"` | `"162e2:Skyrim.esm"` | ✅ corrigido e **validado no loader** em `09fbb12` |

Os dois vieram do mesmo valor herdado. E os dois falham **em silêncio**, que é o
que os torna caros: **`[DOC]`** `FormDesc::FromString` não valida — sem `:` ela
apenas resolve para outra faixa de FormID (§8.5). Não há exceção, não há log.

**Os dois foram consertados por caminhos diferentes, de propósito.** No
`death-service` a célula é constante **do código**, então foi derivada de
`mp.getDescFromId` — o servidor sabe de qual arquivo aquele FormID veio, e a
derivação sobrevive a mudança de load order. No `safe-zones` a célula é dado **de
config**, escrito por humano, e ali derivar trocaria uma config declarativa em
disco por uma que só se resolve com o `mp` vivo; o caminho foi **validar e
recusar alto**. A regra geral que sobra é a mesma para os dois:

Onde a comparação é **ator contra ator** (nametag, market-stalls, voz,
npc-cleaner) o formato não importa, porque os dois lados vêm da mesma fonte. O
erro só aparece quando uma **string escrita por humano** entra na conta. Isso é
uma regra útil para as próximas features: *toda constante de célula ou de base
escrita à mão é suspeita até ser derivada de `mp.getDescFromId` ou conferida
contra `FormDesc`.*

Nota de rodapé com a mesma forma, para quem for mexer em property privada:
**`[DEEPWIKI]`** (§9.5) diz que os prefixos de privacidade são `__p_` / `__pi_`;
a §2.6 da referência registra `private.`. **Os dois não podem estar certos e
nenhum foi lido no código.** Errar ali vaza para o cliente em silêncio — mesma
classe de falha, mesmo conselho: confira antes de confiar.

---

## O que isto muda para a Fase 0

**Quatro dos oito sistemas saíram sem achado.** `identity-service` e
`npc-cleaner` estão ✅ confirmados contra o código primário do upstream;
`nametag-service` e `market-stalls`/governança estão 🟡, que é o resultado
esperado e saudável — a arquitetura sustenta a suposição, e o que falta é a
validação ao vivo que a Fase 0 já existe para fazer. Para esses quatro, **nada
nesta revisão sugere que a sessão vá encontrar surpresa de arquitetura**, e o
roteiro segue como planejado.

**Um sistema bloqueava parte da sessão: o `death-service`. Não bloqueia mais.**
Dos que não bloqueavam, `safe-zones` e `voip-service` também saíram consertados;
**resta um 🔴 aberto, o `hit-events`, e ele deve continuar aberto até depois da
sessão** — o motivo está no item 5.

Prioridade entre os 🔴:

1. **`death-service` Achado A (respawn automático em 25 s) — bloqueava.
   ✅ Corrigido em [`09fbb12`](https://github.com/vinicius3232/skymp-heavy-rp/commit/09fbb12).** Não adiantava testar
   morte, socorro e bleed-out com o servidor ressuscitando o jogador aos 25
   segundos por baixo: a etapa de morte do `FASE_0_ROTEIRO.md` mediria um
   comportamento que não é o desenhado, e o mais provável é que a sessão gastasse
   tempo de duas pessoas depurando "o socorro não funciona" quando o problema
   seria outro. A decisão de desenho que faltava foi tomada (bloquear, §6.2) e o
   handler passou a reivindicar o que é dele.

   **Um passo novo para o roteiro, que este conserto não cobre:** o bloqueio vale
   para o `DeathEvent`, não para o handshake. **Cair e reconectar** ainda leva o
   jogador a ser respawnado por `PartOne::SetUserActor`. Vale exercitar isso
   explicitamente na sessão em vez de descobrir por acidente.
2. **`death-service` Achado B (payload do respawn lança) — bloqueava junto.
   ✅ Corrigido no mesmo commit.** Era o mesmo teste, e consertar A sem B só
   trocaria o sintoma: o jogador ficaria caído até o bleed-out e então falharia o
   respawn. Saíram juntos, como previsto.
3. **`voip-service` (distância sem célula) — não bloqueava.
   ✅ Corrigido em [`112d51b`](https://github.com/vinicius3232/skymp-heavy-rp/commit/112d51b).** A decisão que esta seção
   deixou em aberto — consertar antes ou levar o defeito para a sessão e medir em
   volta dele — foi tomada na primeira: o conserto era pequeno, contido no
   `tickProximity`, e reaproveitava regra que já existia. Não sobra pendência de
   desenho aqui.

   **O que muda para a sessão:** o passo de **duas pessoas em interiores
   diferentes** deixa de ser obrigatório para não medir errado, mas continua
   valendo como verificação barata — é o único jeito de confirmar ao vivo o que os
   testes afirmam com `mp` mockado. E o alerta que motivava a escolha some: um
   teste de voz feito inteiramente dentro de uma célula agora mede o que promete.

   **O que não muda:** a voz segue 🟡 pelo motivo de sempre — ninguém ouviu áudio
   ainda —, e isso é a Fase 0 que responde, não este commit.
4. **`safe-zones` (formato do `cellId`) — não bloqueava.
   ✅ Corrigido em [`09fbb12`](https://github.com/vinicius3232/skymp-heavy-rp/commit/09fbb12).** As zonas nascem vazias e
   desligadas, e nenhum chamador de `canPerform` informa `context.actorId`; nada
   na Fase 0 dependia delas. O conserto era barato e a janela para fazê-lo era
   **antes de alguém preencher a config** — que é quando o defeito passaria a
   valer —, então saiu junto em vez de esperar. O que muda para a sessão: nada. O
   que muda para depois dela: quem preencher a config agora recebe erro em vez de
   uma zona que parece ativa.
5. **`hit-events` (o `OnHit` nativo não usado) — não bloqueia, e não deve entrar
   antes da sessão.** É o achado mais interessante desta rodada e o que mais muda
   o desenho a médio prazo, mas o sistema atual **funciona como está** e a Fase 0
   precisa exercitar o que existe, não o que vai existir. Trocar o caminho de
   coleta agora substituiria um mecanismo não validado por outro mecanismo não
   validado, às vésperas da sessão que existe para validar. **A sessão deve rodar
   com o `makeEventSource` atual**; o caminho nativo entra depois, com os dois
   ligados em paralelo para comparação (§1). O que muda para a Fase 0 é só a
   expectativa: se o snippet não reportar nada, já sabemos qual é a segunda
   tentativa, e ela não custa mais uma rodada de pesquisa.

**Uma correção de registro, sem custo de sessão.** A escala de mob passou de ✅
para ⚪ (§9). Isso não acrescenta trabalho à Fase 0 — o Passo 2 do
`FAUNA_CENSUS_PROTOCOL.md` já estava no roteiro. Muda só a leitura de quem chegar
depois: aquele passo é **a pergunta**, não a confirmação de uma resposta que já
teríamos.

**O resto da Fase 0 não muda.** Os pontos que já pediam observação cuidadosa (o
snippet de hit nunca ter rodado, a projeção da nametag nunca ter sido chamada,
ninguém ter ouvido áudio) continuam exatamente com o peso que `ARCHITECTURE.md`
§1.4.4, §1.4.5 e §1.4.8 já lhes davam. Esta revisão não os agrava nem os alivia —
confirma que aqueles registros são honestos.

**Dois ganhos colaterais, para depois da Fase 0:**

- O servidor já mantém vizinhança por grid e a expõe
  (`mp.getNeighborsByPosition`, properties `neighbors` / `actorNeighbors` /
  `onlinePlayers`). Voz e nametag reimplementam isso em O(n²) a cada 2 s. Não é
  defeito e não é urgente — é a peça óbvia a considerar quando qualquer um dos
  dois sair de POC.
- **`[DEEPWIKI]`** (§9.5) — `consoleCommandsAllowed` é permissão **nativa, por
  ator, do lado do servidor**, e o `admin-service` não a usa. Vale conferir se ela
  está ligada por engano **antes do primeiro teste com gente de fora**. Não é
  achado desta revisão (não é realidade compartilhada), mas é barato e cai na
  mesma janela.
