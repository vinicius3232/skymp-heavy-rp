# Fase 0 — Roteiro de teste in-game

**O único bloqueio real do projeto.** 578 testes automatizados passam, e nada nunca rodou numa sessão com jogador. Enquanto este roteiro não for executado, tudo o mais é qualidade sobre código não validado.

> Substitui o `GOVERNANCE_MARKET_STALLS_TEST_PLAN.md` (13/07/2026), que cobria governança e barracas. Desde então entraram `death-service`, `/painel`, VOIP, master API de sessão e a fila — e o gamemode passou de ~15 para **mais de 60 comandos**. Aquele plano descrevia camadas; este descreve **passos, o que observar, e o que significa falhar**.

**Quem precisa:** 2 pessoas (A e B) com Skyrim SE/AE. Uma terceira (C) só na etapa 6.
**Tempo:** ~60 minutos se nada quebrar. Se quebrar, você para e anota — é para isso que serve.

---

## Como usar

Vá em ordem. **Cada etapa depende da anterior ter passado.** Não pule para "o que interessa": se a etapa 2 falha, o resultado da etapa 7 não significa nada.

Cada passo tem:
- **Faça** — a ação exata
- **Espere** — o que tem de acontecer
- **Se falhar** — o que isso significa e onde olhar

Copie o [registro em branco](#registro) para um arquivo novo antes de começar e preencha **enquanto testa**, não depois.

---

## O que nunca rodou com jogador — índice único

Oito sistemas carregam hoje a mesma etiqueta: **confirmado por teste automatizado, nunca confirmado em sessão real.** Eles estavam espalhados por três documentos, e quem preparava uma sessão precisava abrir os três para montar a lista. Esta tabela é a lista.

**Não duplica critério.** Cada linha aponta para o passo detalhado, e é lá que está o que significa passar ou falhar.

| Sistema | O que fazer | O que observar | Passo a passo |
|---|---|---|---|
| **`hit-events`** | A bate em B 5 vezes (2 carregadas), os dois param, esperam 15 s | Uma linha `combat:episode` com `golpes: 5`/`powerAttacks: 2` e **os dois lados resolvidos** — é o teste do `0x14` | [9.1](#91-hit-events--o-snippet-de-cliente-chega-ao-servidor) |
| **`espm`** | `/additem` com `0xf` (válido), `0x14` (Player) e `0x7fffffff` | O válido entra, os dois inválidos são barrados, `character_inventory` fica limpo | [9.2](#92-espm--formid-inválido-é-barrado-antes-de-virar-linha-no-banco) |
| **`safe-zones`** | Copiar o `.example.json`, ligar uma zona, reiniciar | Que a config **carrega** — o bloqueio não é alcançável in-game hoje, e isso é escopo, não falha | [9.3](#93-safe-zones--pré-requisito-primeiro-e-uma-limitação-a-registrar) |
| **`soul-service`** | Entrar com ficha preenchida e `SOUL_SECRET` definido | A frase do primeiro sinal na tela, soma 200/150 no banco, **nenhum número** no `/alma` | [9.4](#94-soul-service--a-alma-existe-mas-ninguém-a-viu-chegar) |
| **Voz — fallback** | `/voz` com `ENABLE_VOIP_SERVICE=true`, sozinho | O chip para em `VOZ INDISPONÍVEL NESTE CLIENT` e **fica nele** | [8.1](#81-o-aviso-de-fallback-aparece-na-tela-1-pessoa-1-client-2-min) |
| **Voz — nativa** | Helper com ticket, A fala e B escuta | Voz **inteligível** (não só "tem sinal"), volume por distância, sem eco | [8.2](#82-voz-de-verdade-com-o-helper-nativo-12-pessoas-20-min) · [`VOICE_NATIVE_HELPER.md`](VOICE_NATIVE_HELPER.md) §11 |
| **Identidade — persistência** | Reconectar e reiniciar o servidor depois de `/apresentar` e `/apelido` | Conhecidos e apelidos **sobrevivem aos dois** | [3.5 e 3.6](#etapa-3--identidade-disfarce-e-persistência-8-min-a-e-b) · [`NAMETAG_IDENTITY_SYSTEM.md`](NAMETAG_IDENTITY_SYSTEM.md) |
| **Nametag + `/revelaridentidade`** | `ENABLE_NAMETAG_SERVICE=true`, A olha B; depois um admin usa `/revelaridentidade` em B | A etiqueta **aparece e acompanha** B ao andar, mostra `Desconhecido` antes de `/apresentar`, e a revelação vira linha em `audit_logs` | [3.7](#etapa-3--identidade-disfarce-e-persistência-8-min-a-e-b) · [`NAMETAG_IDENTITY_SYSTEM.md`](NAMETAG_IDENTITY_SYSTEM.md) |

### Fora desta lista, e por quê

- **Marcas e árvore da Afinidade da Alma** existem e têm teste, mas nenhum caminho de jogo chega até elas — ver a nota ao fim de [9.4](#94-soul-service--a-alma-existe-mas-ninguém-a-viu-chegar).
- **`npc-cleaner`** está inerte por construção (`blockedBaseDescs` vazia = não remove nada, e `skymp/config/npc-policy.json` sequer existe), então não há o que observar. A consequência disso — a fauna vanilla provavelmente já está solta e ativa — é o assunto do [`HOSTILE_MOB_ACTIVATION_DECISION.md`](HOSTILE_MOB_ACTIVATION_DECISION.md), e o censo que ela pede **não é esta Fase 0**: os instrumentos existem desde 08/08 (`/censofauna` e `/sondacadaver`, desligados por padrão) e têm sessão e registro próprios em [`FAUNA_CENSUS_PROTOCOL.md`](FAUNA_CENSUS_PROTOCOL.md). Podem sair na mesma janela; a conclusão é de outra natureza — lá não há "passou" nem "falhou", só o que existe no mundo.

---

## Flags de ambiente — tudo num lugar só

Todas vão no `skymp/gamemode/.env`. A coluna diz **para qual etapa** cada uma existe, porque ligar tudo de uma vez não é o certo — ver as três ressalvas abaixo.

| Flag | Etapas 1–7 | Etapa 8 (voz) | Etapa 9 | Observação |
|---|---|---|---|---|
| `ENABLE_GOVERNANCE_SERVICE` | `true` | — | — | |
| `ENABLE_MARKET_STALLS_SERVICE` | `true` | — | — | 9.2.6 também usa |
| `ENABLE_DEATH_SERVICE` | `true` | — | **`true`** | **Pré-requisito de 9.1**: o `hit-events` sobe dentro do `initDeathService` |
| `ENABLE_PLAYER_PANEL_SERVICE` | `true` | — | — | |
| `ENABLE_VOIP_SERVICE` | **`false`** | `true` | — | Deliberadamente desligado nas 1–7 (ver Etapa 0) |
| `VOIP_DEBUG_EXPOSE_TICKET` | `false` | `true` | — | ⚠️ Credencial em texto puro no disco. Lida a cada `/voz`, então desligar **não** exige reiniciar |
| `VOIP_PUBLIC_HOST` / `VOIP_BIND_HOST` | — | só entre máquinas | — | Padrão `127.0.0.1` só serve na mesma máquina |
| `ENABLE_SOUL_SERVICE` | `false` | — | `true` só em 9.4 | Voltar para `false` ao fim da etapa |
| `SOUL_SECRET` | — | — | **obrigatório em 9.4** | Escolha uma vez; trocar depois quebra quem já foi derivado |
| `ENABLE_NAMETAG_SERVICE` | `true` só em 3.7 | — | — | Desligado por padrão. A projeção mundo→tela **nunca foi executada** — 3.7 é a primeira vez |
| `ENABLE_NPC_CLEANER` | tanto faz | — | — | Inerte com a lista de bloqueio vazia |

### As três ressalvas — verificadas, não presumidas

**1. `ENABLE_SOUL_SERVICE=true` com `SOUL_SECRET` vazio não derruba o servidor — derruba só o módulo, e o resto sobe normalmente.** O `initSoulService` lança, e o `core/module-registry.js` captura, registra `FALHOU ao inicializar` e **continua o boot**. O efeito prático é o pior possível numa sessão de teste: você joga a sessão inteira achando que a alma está ligada. Confira o log de boot por `[module-registry] soul: ATIVO` antes de confiar em qualquer resultado de 9.4.

**2. O passo 9.4.1 exige um boot com o segredo vazio, de propósito.** Ele testa que o modo de falha aponta para o lado seguro. Ou seja: 9.4 não cabe numa sessão "tudo ligado" — precisa de um boot com o segredo ausente e outro com ele presente.

**3. A etapa 9.3 pede três reinícios do servidor** (config válida, categoria inválida, `enabled: false`). Reiniciar interrompe todo mundo que estiver em jogo, então rode 9.3 no fim, ou numa janela separada.

**Não há nenhum par de flags conhecido por conflitar entre si.** O que impede a sessão única são as três ressalvas acima — todas de sequência de boot, nenhuma de incompatibilidade. Uma sessão contínua cobre **1–7, 9.1 e 9.2**; 9.3, 9.4 e 8 querem os próprios boots.

---

## Etapa 0 — Antes de ligar qualquer coisa (10 min, sozinho)

| # | Faça | Espere | Se falhar |
|---|---|---|---|
| 0.1 | `cd skymp/gamemode && npm test` | 444 passando | Não comece. Conserte antes. |
| 0.2 | `npm run test:systems` | 13/13 | Comando, permissão ou flag fora do lugar |
| 0.3 | `npm run check:schema` | `[OK] banco e migrations estao alinhados` | **Aplique as migrations pendentes** (`v2`→`v10`, em ordem; são idempotentes). Banco meio-migrado não quebra o boot — quebra a query que toca a coluna faltante, no meio de uma cena. Foi assim que a v9 nasceu: `characters.gold` estava só no `schema.sql`, então banco antigo migrado em ordem nunca a recebia, e **toda** operação de ouro falharia na etapa 5.6 |
| 0.4 | Confira `apps/game-api/mods.json` | Existe e tem `mods` e `loadOrder` | `/mods.json` responde 503 e **ninguém entra**. Gere com `node scripts/generate-mods-manifest.js` |
| 0.5 | `.\scripts\phase0\Start-AllServices.ps1` | Nenhum aviso vermelho | O script diz o que não vai subir. Ele não mente por otimismo |

**Flags no `.env` do gamemode:**
```
ENABLE_GOVERNANCE_SERVICE=true
ENABLE_MARKET_STALLS_SERVICE=true
ENABLE_DEATH_SERVICE=true
ENABLE_PLAYER_PANEL_SERVICE=true
```
Deixe `ENABLE_VOIP_SERVICE=false` — falar em jogo depende de um componente que ainda não é distribuído (o helper nativo de `VOICE_NATIVE_HELPER.md`; o patch de client de `VOICE_CLIENT_PATCH.md` foi descartado). Ele é a etapa 8, opcional.

> Estas quatro são só o que as etapas 1–7 precisam. A lista completa, com o que cada etapa liga e as três ressalvas de sequência de boot, está em [Flags de ambiente](#flags-de-ambiente--tudo-num-lugar-só).

⚠️ **`offlineMode: false` no `server-settings.json`.** Com `true` o cliente declara a própria identidade e o servidor acredita — a etapa 2 passaria sem provar nada.

---

## Etapa 1 — O jogador A entra (10 min)

Esta é a cadeia inteira: launcher → paridade → fila → sessão → master API → spawn. **É a etapa mais provável de falhar, e a mais importante.**

| # | Faça | Espere | Se falhar |
|---|---|---|---|
| 1.1 | Abrir o launcher, logar com Discord | Perfil aparece | O launcher só captura o `code`; a troca é no painel (`/api/launcher/oauth/exchange`). Veja o log do `apps/web` |
| 1.2 | Verificação de mods | Passa | **Anote o texto exato do erro.** "Plugin extra na load order" é o caso novo — significa que você tem um `.esp` que o servidor não conhece, e ele desloca os FormIDs |
| 1.3 | Entrar na fila | Admitido | Fila exige ticket do painel, não `discordId` |
| 1.4 | Confira `skymp_config.json` | Tem `session` preenchido | Sem isso o servidor não resolve identidade |
| 1.5 | O jogo abre e conecta | A entra no mundo | Porta 7777. Se a UI não aparecer, veja `localhost:9000` |
| 1.6 | No banco: `SELECT * FROM game_sessions ORDER BY id DESC LIMIT 1` | Linha com `resolve_count >= 1` | **Se `resolve_count` for 0, o master API não foi chamado** — o servidor está em `offlineMode` ou o `master` não aponta para o painel |

> **1.6 é o teste mais importante do roteiro.** Ele prova que a identidade veio do servidor e não do cliente. Se falhar, todo o resto roda sobre identidade forjável.

---

## Etapa 2 — O painel do jogador (5 min)

| # | Faça | Espere | Se falhar |
|---|---|---|---|
| 2.1 | `/painel` | HUD abre com 4 abas | Veja o console em `localhost:9000` |
| 2.2 | Ver a aba Status | Vida, magicka, stamina e ouro com valores reais | Valor zerado = o Papyrus não respondeu. **É o teste do formato `self`** (2.13 do QA) |
| 2.3 | Perder vida (queda) e olhar de novo | Vida atualiza em ~2 s | Polling parado |
| 2.4 | Abas Governança, Economia, Social | Abrem sem erro, mesmo vazias | — |

---

## Etapa 3 — Identidade, disfarce e persistência (8 min, A e B)

Os quatro primeiros passos já existiam. Os dois últimos vêm dos **"Requisitos Para Alfa"** do [`NAMETAG_IDENTITY_SYSTEM.md`](NAMETAG_IDENTITY_SYSTEM.md), que os exige desde 12/07/2026 e nunca tinham sido trazidos para cá — o critério é de lá, não foi reescrito.

| # | Faça | Espere | Se falhar |
|---|---|---|---|
| 3.1 | A olha B pela primeira vez | B aparece como **Desconhecido** | **Falha grave.** O sistema de disfarce inteiro depende disso |
| 3.2 | B usa `/apresentar` para A | A passa a ver o nome de B | — |
| 3.3 | A ainda é Desconhecido para B | Sim | Conhecimento **não é recíproco** — é o caso do informante e do espião |
| 3.4 | A dá um apelido em B (`/apelido`) | A vê o apelido, não o nome civil | — |
| 3.5 | **A desconecta e reconecta** | A continua vendo o nome de B (3.2) e o apelido (3.4) | Requisito de alfa *"reconexao deve preservar conhecidos e apelidos"*. Se sumiu, o conhecimento só existia em memória — confira `character_known_identities` no banco |
| 3.6 | **Reinicie o servidor** e A e B voltam | Os dois continuam valendo | Requisito de alfa *"restart do servidor deve preservar conhecidos e apelidos"*. É o teste que separa cache de persistência, e 3.5 pode passar sozinho com o cache quente |

### 3.7 — Nametag e revelação por staff (🔴 nunca executado)

Ligue `ENABLE_NAMETAG_SERVICE=true` e reinicie. **Esta é a primeira vez que a projeção mundo→tela roda** — `worldPointToScreenPoint` nunca foi chamada, então que ela seja alcançável por este caminho é inferência, não observação. Falhar aqui é resultado esperado o bastante para não assustar ninguém.

| # | Faça | Espere | Se falhar |
|---|---|---|---|
| 3.7.1 | A olha B, antes de qualquer `/apresentar` | Etiqueta acima de B dizendo **Desconhecido** | Se aparecer o nome civil, a etiqueta não passa pela escada de identidade — **pare e registre**, é vazamento de identidade |
| 3.7.2 | B anda, corre, sobe uma escada | A etiqueta **acompanha a cabeça** sem tremer nem deslizar | Se ficar presa ou saltar, anote em que movimento: é a convenção de eixos, que nunca foi verificada |
| 3.7.3 | B fica atrás da câmera de A (A gira 180°) | A etiqueta **some**, não aparece espelhada na frente | Ponto atrás da câmera é buraco conhecido — registre o que apareceu |
| 3.7.4 | B se afasta bem, depois volta | Uma etiqueta só, sempre a do mais próximo | — |
| 3.7.5 | Um **admin** usa `/revelaridentidade` em B | Devolve o nome real **de B**, não o de quem digitou | Nome do executor é o bug exato que o `disguise-service` tinha antes de ser apagado |
| 3.7.6 | Um **moderador** tenta o mesmo | **Negado** | `reveal_identity` é `admin`/`owner`. Moderador passando é escalação de privilégio |
| 3.7.7 | `SELECT * FROM audit_logs WHERE action LIKE 'identity:reveal%' ORDER BY id DESC LIMIT 1` | Linha com **quem revelou** e **quem foi revelado** | Revelação sem rastro derruba a justificativa inteira do comando ser explícito |
| 3.7.8 | `SELECT * FROM character_known_identities WHERE ...` (o par staff→B) | **Nenhuma linha nova** | Se gravou, a staff passa a chamar B pelo nome real no chat para sempre — metagaming com aparência legítima |

**Anote o custo.** Se o jogo engasgar com a etiqueta ligada, é o `executeJavaScript` atravessando para a CEF — custo que nunca foi medido, e o motivo de o padrão ser 20 Hz e não por quadro. Desligue a flag ao fim da etapa.

> **Um requisito de alfa daquele documento continua não testável neste build, e não é falha:** *"disfarce ativo deve poder sobrescrever nome publico"* — o `disguise-service` foi apagado em 06/08 ([`PARKED_SERVICES_DECISION.md`](PARKED_SERVICES_DECISION.md) §7.1) e ainda não voltou. Registre como **não aplicável neste build**, não como reprovado.

---

## Etapa 4 — Chat por proximidade (5 min)

| # | Faça | Espere | Se falhar |
|---|---|---|---|
| 4.1 | Colados: `/sussurrar` | B lê | — |
| 4.2 | B se afasta bem e A sussurra | B **não** lê | Raio errado |
| 4.3 | `/gritar` da mesma distância | B lê | — |
| 4.4 | `/me` e `/do` | Aparecem como ação, não fala | — |

---

## Etapa 5 — Morte com consequência (10 min) 🔴

A parte mais nova e menos verificada do gamemode.

| # | Faça | Espere | Se falhar |
|---|---|---|---|
| 5.1 | B mata A (combate ou queda) | A vai para `DOWNED`, **não respawna** | Se respawnar direto, o `death-service` não está ligado ou o hook não disparou |
| 5.2 | `SELECT * FROM audit_logs WHERE action='death:killer' ORDER BY id DESC LIMIT 1` | Linha com o `killerId` de B | **Se estiver vazio, `mp.onDeath` não disparou** — o polling pegou a morte, e o item 1.8 do QA continua bloqueado |
| 5.3 | A tenta andar/atacar/falar | Bloqueado | `action-policy` não aplicou |
| 5.4 | B usa `/socorrer <actorId de A>` perto | A volta a `NORMAL` com vida parcial | — |
| 5.5 | Repita 5.1 e **espere 4 minutos** | A vira `DEAD`, perde ouro, respawna | — |
| 5.6 | Confira `gold_transactions` | Linha da penalidade, saldo nunca negativo | — |
| 5.7 | `action='death:context'` | Lista quem estava por perto | Evidência anti-RDM |
| 5.8 | Repita 5.1 e, com A em `DOWNED` (bleed-out correndo, **sem** `/socorrer`), A desconecta e reconecta | A **continua `DOWNED`** ao voltar — o estado do `death-service` prevalece, sem respawn silencioso do motor | Se A voltar `NORMAL`/respawnado, é `PartOne::SetUserActor` chamando `RespawnWithDelay()` no handshake, por fora do `DeathEvent` — mesma classe de bug que a PR #21 corrigiu no caminho principal, só que na reconexão. **Registrar como achado novo**, não assumir que já está coberto |

**Anote o tempo real entre 5.1 e o `DOWNED` aparecer.** Se passar de 2 s, o hook nativo não está sendo usado.

---

## Etapa 6 — Governança e mercado (10 min, precisa de C)

| # | Faça | Espere | Se falhar |
|---|---|---|---|
| 6.1 | Staff dá cargo de guarda a A e licença a B | — | — |
| 6.2 | A: `/guardduty` | Entra de serviço | — |
| 6.3 | B: `/stallplace` e `/stalladd` | Barraca aparece, item anunciado | — |
| 6.4 | C compra com `/stallbuy` | Ouro sai de C, entra em B, imposto retido | Confira `gold_transactions`: **três linhas, nenhum saldo negativo** |
| 6.5 | C desconecta e reconecta | O item continua no inventário | Persistência quebrada |
| 6.6 | A: `/stallinspect` e `/fine` em B | Multa registrada | — |
| 6.7 | A: `/arrest` em B | B fica preso, sem poder agir | — |
| 6.8 | B reconecta preso | **Continua preso** | Estado durável não sobreviveu ao reconnect |

---

## Etapa 7 — Staff e permissão (5 min)

| # | Faça | Espere | Se falhar |
|---|---|---|---|
| 7.1 | Um moderador tenta `/setgold` | **Negado**, com aviso | Escalação de privilégio |
| 7.2 | Um moderador tenta `/permakill` | **Negado** | Morte permanente nunca é linha de frente |
| 7.3 | Um admin usa `/permakill` com motivo | Personagem vira `retired` | — |
| 7.4 | `SELECT status FROM characters WHERE id=...` | `retired`, **linha existe** | Se sumiu, alguém fez `DELETE` — bug grave |
| 7.5 | Tentar entrar com o personagem aposentado | Bloqueado | — |

---

## Etapa 8 — VOIP (opcional)

A voz nativa é **opcional e Pós-Alfa** por decisão fechada em 07/08/2026 (§13 do `SKYMP_RP_DEVELOPMENT_PLAN.md`). **Falar** em jogo exige o helper nativo de [`VOICE_NATIVE_HELPER.md`](VOICE_NATIVE_HELPER.md), que ainda não é distribuído com o launcher; sem ele o microfone falha e **isso é esperado, não é bug**. O patch de client de `VOICE_CLIENT_PATCH.md` foi descartado e não deve ser aplicado.

### 8.1 O aviso de fallback aparece na tela? (1 pessoa, 1 client, 2 min)

Esta é a única verificação do roteiro que **não precisa de dois jogadores conectados** — pode ser feita por quem abrir o client primeiro, e não deveria esperar o resto da Fase 0. Ela existe porque, sem o patch, a mensagem de erro *é* a experiência de voz de todo mundo na Alfa.

Com `ENABLE_VOIP_SERVICE=true`, entre em jogo e rode `/voz`. O esperado:

- o chip no topo termina em **`VOZ INDISPONÍVEL NESTE CLIENT — use o Discord`** e **fica nele** — se ele virar `VOZ DESCONECTADA`, o `state.voiceFatal` de `skymp/ui/index.html` não está segurando o `onclose` e o jogador está lendo o diagnóstico errado;
- **exceção esperada:** se houver alguém em alcance usando o helper nativo, o chip vira âmbar com **`OUVINDO — SEM MICROFONE`**. Não é regressão: quem não captura ainda ouve, porque o WebSocket deixou de ser fechado na falha de microfone (`VOICE_NATIVE_HELPER.md` §6);
- uma linha aparece no log de chat (canto inferior esquerdo) dizendo que é limitação do client, não do microfone nem do servidor, e apontando `/voz-criar` no Discord;
- nada trava: dá para andar, abrir o `/painel` e continuar jogando com a mensagem na tela.

Anote o que apareceu. **Isto nunca foi visto num CEF real** — `skymp/ui/` não tem suíte de teste, então o comportamento é conhecido por leitura de código apenas.

### 8.2 Voz de verdade, com o helper nativo (1–2 pessoas, ~20 min)

**Este passo não é a Fase 0.** É um teste focado só em voz, e pode rodar com bem
menos gente — até com uma pessoa só, dois processos de helper e dois atores, como
a bancada da Fase 1 já fez. O resto do roteiro não depende dele.

**O binário existe.** `voice-helper.exe` compilou em 07/08/2026 e a captura foi
medida: 50,1 quadros/s, enquadramento exato, zero descartes
(`VOICE_NATIVE_HELPER.md` §8.3 e §8.4). Se você não tiver o binário na sua
máquina, compile seguindo o `voice-helper/README.md`, ou ensaie os passos 3 em
diante com `node voice-helper/tools/frame-probe.js`, que fala exatamente o mesmo
protocolo (inclusive `role: 'sender'`) com um tom de 440Hz no lugar do microfone.

**O que este passo acrescenta ao que já foi medido:** ninguém escutou. Que a
captura entrega sinal em tempo real está provado; que a **voz sai inteligível**
não. É por isso que este passo existe e por que ele precisa de você.

⚠️ **`VOIP_DEBUG_EXPOSE_TICKET` grava um ticket de voz em texto puro no disco.**
Ele vale 30 segundos e autentica como aquele jogador na cena de voz. É andaime de
bancada, com um engenheiro olhando — **não deixe ligado**. O passo 7 existe pra
isso.

**1. Ligue as duas flags** no `.env` do gamemode:

```bash
ENABLE_VOIP_SERVICE=true
```

```bash
VOIP_DEBUG_EXPOSE_TICKET=true
```

A segunda **não está em nenhum `.env.example` de propósito** — ligue à mão.
Ela é lida a cada `/voz`, então não precisa reiniciar o servidor pra desligar.

**2. Se o teste for entre duas máquinas**, ajuste `VOIP_PUBLIC_HOST` para o IP
que a outra máquina alcança (o padrão `127.0.0.1` só serve na mesma máquina), e
`VOIP_BIND_HOST=0.0.0.0` pro servidor aceitar de fora. Numa máquina só, pule.

**3. Jogador A: `/voz` no jogo.** Duas coisas acontecem — a UI conecta sozinha
como `listener` (chip no topo muda), e o ticket de `sender` aparece em dois
lugares: no log do servidor, em `warn`, já montado como linha de comando; e em
`skymp/gamemode/.voip-debug-ticket.json`. Pegue de onde for mais cômodo.

**4. Jogador A: rode o helper** com esse ticket, dentro de 30 segundos:

```bash
voice-helper.exe --actor-id 0xFF000A12 --ticket <do arquivo> --host 127.0.0.1 --port 7778
```

Vencido, é só rodar `/voz` de novo — o ticket novo não derruba a UI, porque são
tickets de papéis diferentes (`VOICE_NATIVE_HELPER.md` §10). O helper deve
imprimir `Autenticado. Capturando`. Se disser `Auth recusada`, quase sempre é
ticket vencido entre um passo e outro.

**5. Jogador B: `/voz`**, e registre qual dos dois casos você testou:

- **só UI** (sem helper): B ouve A, mas não fala. É o caso do client oficial hoje.
- **com helper também**: os dois falam. Precisa de outro `/voz` + outro helper,
  com o `actorId` de B.

**6. O que observar** — e anote o que de fato aconteceu, não o que era pra acontecer:

| Observação | Esperado |
|---|---|
| A fala, B escuta | voz **inteligível**, não só "tem sinal" |
| A se aproxima de B | volume **sobe** conforme a distância cai |
| B se afasta além de ~1200 unidades | áudio **para**; pode demorar até 2s (o tick é de 2s) |
| B volta pro alcance | áudio **volta**, também em até 2s |
| A e B com helper, os dois falando | voz nos **dois sentidos**, ao mesmo tempo |
| A fala e escuta ao mesmo tempo | A **não ouve a própria voz** — se ouvir, é eco e é defeito |
| A fecha o helper (Ctrl+C) | A **para de falar** e **continua ouvindo** B |
| A muta pela UI | B **para de ouvir** A, mesmo com o helper transmitindo |

Sem cancelamento de eco: **use fone**. Em caixa de som a voz do outro volta pro
microfone e reentra na cena — isso é limitação conhecida (`VOICE_NATIVE_HELPER.md`
§9.5), não achado novo.

Se o áudio sair **robótico, cortado ou picotado**, registre o sintoma e em que
condição apareceu — não conclua sozinho se é bloqueador. Há um achado de
re-bufferização já medido (§7) que pode ser a mesma coisa vista de outro ângulo.

**7. Desligue `VOIP_DEBUG_EXPOSE_TICKET`** e apague
`skymp/gamemode/.voip-debug-ticket.json`. O arquivo é ignorado pelo git, então
ninguém vai commitá-lo por acidente — mas ele continua sendo uma credencial em
texto puro no disco de quem testou.

---

## Etapa 9 — Os quatro sistemas que só um jogador conectado prova (10 min, A e B) 🔴

**Nenhum dos quatro jamais rodou com cliente conectado.** O primeiro boot real validou o servidor sozinho; estes dependem de alguém estar em jogo. Os três primeiros vieram do estudo do Red House (`REFERENCE_STUDY_SKYMP_RED_HOUSE.md` §4.1) e são descritos em `ARCHITECTURE.md` 1.4.5–1.4.7; o quarto (`soul-service`) entrou depois e não tem relação com aquele estudo — o título dizia "os três" desde antes de ele existir.

Faça **depois da etapa 5** — o `hit-events` sobe dentro do `initDeathService`, então `ENABLE_DEATH_SERVICE=true` é pré-requisito dos três passos de 9.1.

### 9.1 `hit-events` — o snippet de cliente chega ao servidor?

Esta é a única parte que **não** foi verificada no boot: `mp.makeEventSource` existe e aceita o registro (o log diz `[hit-events] Evento de agressao registrado`), mas o trecho injetado só executa quando alguém conecta.

| # | Faça | Espere | Se falhar |
|---|---|---|---|
| 9.1.1 | Confira o log de boot | `[hit-events] Evento de agressao registrado (evidencia, nao enforcement)` | Se disser `mp.makeEventSource indisponivel`, pare: **nada abaixo pode passar**. O resto de 9.1 não significa nada |
| 9.1.2 | A bate em B **5 vezes**, sendo 2 golpes carregados (power attack). Depois **parem os dois e esperem 15 s** | Nada visível in-game — é evidência, não enforcement. Não deve haver mensagem, dano extra nem bloqueio | Se algo visível acontecer, alguém ligou enforcement. Ver `ARCHITECTURE.md` 1.4.5 |
| 9.1.3 | `SELECT details FROM audit_logs WHERE action='combat:episode' ORDER BY id DESC LIMIT 1` | **Uma linha só**, com `golpes: 5` e `powerAttacks: 2` | Zero linhas = o evento nunca chegou (ver 9.1.6). Cinco linhas = a agregação por episódio quebrou |
| 9.1.4 | No mesmo `details`, olhe `agressorCharacterId` e `alvoCharacterId` | **Os dois preenchidos**, batendo com A e B | ⚠️ **É o teste do `0x14`.** O cliente reporta `0x14` para si mesmo; se o servidor não trocar pelo `pcFormId`, o lado de quem bateu não resolve para personagem nenhum e vem `null`. É o detalhe que o próprio estudo aponta como o mais fácil de errar |
| 9.1.5 | No mesmo `details`, olhe `origem` | `cliente (makeEventSource) — evidencia, nao prova` | A procedência tem que viajar junto com a linha, senão alguém a usa como prova numa arbitragem |
| 9.1.6 | **Se 9.1.3 vier vazio:** A causa dano em si mesmo (queda) e repete | Continua vazio — dano em si mesmo é descartado de propósito | Se aparecer linha aqui e não em 9.1.2, o evento chega mas o par agressor/alvo está errado |

> **A janela é de 10 s de silêncio.** O episódio só vira linha depois que os dois pararem de bater; consultar o banco no meio da briga dá vazio e não é falha.

**Anote quantos segundos passaram entre o último golpe e a linha aparecer.** Muito acima de 10 s significa que a varredura não está rodando.

### 9.2 `espm` — FormID inválido é barrado antes de virar linha no banco?

Precisa de conta **admin+** (permissão `add_item`). O caso `0x14` é o que importa: a API devolve `{}` para ele, e `{}` é *truthy* — uma implementação ingênua deixaria o Player passar como item.

| # | Faça | Espere | Se falhar |
|---|---|---|---|
| 9.2.1 | `/additem <actorId de B> 0xf 1` (`0xf` = Gold001, MISC — o FormID confirmado na sonda) | B recebe. Sem mensagem de item inválido | Se barrar um item **válido**, a lista `TIPOS_DE_INVENTARIO` está errada ou o formato do retorno mudou. **Isto é pior que não validar** |
| 9.2.2 | `/additem <actorId de B> 0x14 1` (Player — existe no jogo, mas é referência, não item) | `[Staff] Item invalido: 0x14 nao existe nos plugins carregados.` | ⚠️ **Se o item "for entregue", a checagem `r && r.record` virou `if (r)`** e `{}` passou como item |
| 9.2.3 | `/additem <actorId de B> 0x7fffffff 1` | Barrado, mesma mensagem com `0x7fffffff` | — |
| 9.2.4 | `SELECT * FROM character_inventory WHERE base_id IN (20, 2147483647)` | **Zero linhas** | O ponto todo do sistema é não gravar o que nunca vira item na tela. Linha aqui = a validação está avisando e gravando assim mesmo |
| 9.2.5 | Repita 9.2.2 e olhe o console do servidor | `[admin] ... tentou dar 0x14: ...` | — |
| 9.2.6 | `/stalladd <stallId> 0x14 1 10 Teste` numa barraca de B | Barrado igual | É o segundo ponto de entrada de `base_id`, e o mais caro: aqui alguém **paga** por uma linha que nunca vira item |

> **Se a mensagem de erro nunca aparecer em nenhum dos três**, verifique se `mp.lookupEspmRecordById` existe nesta build: por desenho, API ausente **deixa passar** (ver `ARCHITECTURE.md` 1.4.6). Silêncio pode ser "aprovou" ou "não sei" — o log de 9.2.5 é o que distingue.

### 9.3 `safe-zones` — pré-requisito primeiro, e uma limitação a registrar

⚠️ **Pré-requisito, não pule:** `skymp/config/safe-zones.json` **não existe** no repositório — só o `.example.json`. Sem ele o módulo responde "não há zona nenhuma" e o teste não prova nada.

1. Copie `skymp/config/safe-zones.example.json` para `skymp/config/safe-zones.json`.
2. Mude `"enabled"` para `true` e deixe **uma** zona: `cellId` = a célula onde A e B estão (o exemplo já traz `0x162e2`, o ponto de spawn atual), `blocks: ["combat"]`, `pos` e `radius` em `null` — célula inteira, que não exige medir nada in-game.
3. **Isto é uma zona de teste, não uma decisão de design.** Zona segura é mecânica de mundo e a Constituição §15 pede as 15 perguntas antes; as quatro que mais mudam o desenho estão no próprio `.example.json`. **Apague o `safe-zones.json` ao terminar a etapa.**

| # | Faça | Espere | Se falhar |
|---|---|---|---|
| 9.3.1 | Reinicie o servidor com o arquivo no lugar | Nenhum erro `[safe-zones]` no boot | `nao e JSON valido` = erro de digitação. `Zona ... nao proibe nada` = `blocks` vazio ou com categoria inexistente |
| 9.3.2 | Ponha uma categoria inválida de propósito (`blocks: ["combate"]`, em português) e reinicie | `[safe-zones] Zona ... lista categoria(s) desconhecida(s): combate` e a zona é ignorada | Silêncio aqui é o pior resultado: seria uma regra que quem escreveu acha que criou e não criou. **Desfaça depois deste passo** |
| 9.3.3 | Volte `"enabled"` para `false` e reinicie | Nenhuma zona ativa, nada muda | — |

**A parte que decide (o bloqueio) não é alcançável in-game hoje — e isso não é bug, é escopo.** A checagem de lugar só roda quando quem chama `actionPolicy.canPerform` informa `context.actorId`, e **nenhum dos quatro chamadores atuais informa** (os quatro estão em `market-stalls-service.js`). Isso é deliberado e tem teste: uma regressão aí ligaria zona segura no servidor inteiro sem ninguém pedir.

Consequência prática para este roteiro: **9.3 testa que a config carrega, não que ela barra.** Verificar `blocksBetween` — a regra dos dois lados, que é o achado que valia a leitura do Red House — exige antes ligar um chamador de verdade, e qual chamador ligar é a decisão de política que continua em aberto. Registre isso no log da Fase 0 como pendência conhecida, não como falha.

### 9.4 `soul-service` — a alma existe, mas ninguém a viu chegar

Mesmo aviso dos três acima: **confirmado por teste automatizado, não confirmado em sessão real.** São 31 testes de serviço mais os 28 do domínio, e nenhum deles prova a única coisa que importa aqui — que a frase chega na tela de quem está jogando.

⚠️ **Pré-requisitos, nenhum deles opcional:**

1. Aplicar a `migration-v10-soul.sql` (banco novo já vem com as tabelas pelo `schema.sql`). Confirme com `npm run check:schema`.
2. Gerar o segredo e pôr no `skymp/gamemode/.env`:
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` → `SOUL_SECRET=<valor>`.
3. `ENABLE_SOUL_SERVICE=true` no mesmo arquivo.
4. **A e B precisam ter ficha preenchida** (`motivations`, `weaknesses`, `social_ties`). Personagem com os três campos vazios continua recebendo alma — mas a de todos eles é a mesma para o mesmo `characterId`, e o teste 9.4.3 não prova nada. Preencha pelo painel antes.

> **Escolha o segredo uma vez.** Trocar depois muda a alma de quem ainda não foi derivado e deixa incoerente quem já foi — a alma é congelada no primeiro spawn, de propósito (`SOUL_AFFINITY.md` §14.1).

| # | Faça | Espere | Se falhar |
|---|---|---|---|
| 9.4.1 | Reinicie o servidor com a flag ligada e `SOUL_SECRET` **vazio** | Boot falha alto com `SOUL_SECRET ausente`, e o módulo não sobe | ⚠️ **Se subir mesmo assim, o modo de falha está apontando pro lado errado.** Alma derivada de segredo vazio é recalculável por qualquer um a partir da ficha, que é pública no painel — e o estrago é permanente |
| 9.4.2 | Preencha o segredo, reinicie, entre com A | Uma notificação com **uma frase** (ex.: *"Você não sonha. Nunca sonhou."*) logo depois do spawn | Nada aparecendo: confira se `revelarPrimeiroSinal` foi chamado (log `[soul] Sinal ... revelado`). Linha no log e nada na tela = o problema é `sendNotification`, não a alma |
| 9.4.3 | `SELECT * FROM character_soul` | Uma linha por personagem que entrou. As quatro afinidades somam **200**, os três traços somam **150** | Soma diferente = o gerador quebrou, e isso é a regra 1 do sistema ("nenhuma alma é estritamente melhor") caindo em silêncio |
| 9.4.4 | Saia e entre de novo com A | **Nenhum segundo sinal.** A frase de 9.4.2 não se repete | Sinal repetindo = o `UNIQUE (character_id, sign_key)` não foi aplicado, ou o `revealSign` está ignorando o que já existe |
| 9.4.5 | `/alma` com A | As mesmas frases que ele já recebeu. **Nenhum número na tela** | ⚠️ Qualquer dígito aqui é vazamento: o jogador nunca pode ver valor, banda ou semente (§II.1) |
| 9.4.6 | Peça a alguém com acesso ao painel web para abrir a aba de auditoria e procurar `soul:resolve` | Linhas com `outcome`, `peso`, `inputs` e `seedRef` — e **nunca** a semente inteira | Semente completa no `details` = ela saiu do servidor. Com ela e este repositório, qualquer pessoa reproduz todas as rolagens futuras daquele personagem |
| 9.4.7 | Anote a alma de A (`SELECT * FROM character_soul WHERE character_id = <A>`), edite a ficha de A pelo painel, reinicie e entre de novo | Os sete valores **não mudaram** | Mudou = a alma está sendo rederivada, e quem jogou meses acordou com outro personagem. As marcas, que são a progressão, ficam órfãs |

**O que 9.4 NÃO testa, e por quê.** Marcas e árvore de transformação existem no serviço e têm teste, mas **nenhum caminho de jogo chega até eles ainda**: `resolveAttempt` e `advancePath` não são chamados por nenhum comando nem por nenhum módulo ativo. Isso é escopo, não pendência — a ordem que o `SOUL_AFFINITY.md` recomenda coloca "os quatro resultados em UMA coisa só, encantamento" como etapa 2, e encantamento depende do `crafting-service`, que continua PARKED.

Consequência prática: **9.4 testa a alma e o sinal, não a consequência.** Registre no log como escopo conhecido. Quem for ligar a etapa 2 precisa antes decidir onde os quatro resultados aparecem, e essa decisão passa pelas 15 perguntas da Constituição §15 como qualquer mecânica nova.

**Ao terminar a etapa**, volte `ENABLE_SOUL_SERVICE=false`. O segredo pode ficar no `.env` — ele não faz nada com o módulo desligado, e trocá-lo depois é pior que mantê-lo.

---

## Registro

Copie para um arquivo novo (`docs/roadmap/FASE_0_LOG_<data>.md`) e preencha durante o teste.

```markdown
# Fase 0 — execução de <data>

Testadores: A=___ B=___ C=___
Build/commit: ___
offlineMode: false ☐    Flags ENABLE_* ligadas: ___

| Etapa | Passou | Observação / erro exato |
|---|---|---|
| 0 Pré-boot        | ☐ |  |
| 1 Entrada         | ☐ |  |
| 1.6 resolve_count | ☐ | valor: ___ |
| 2 Painel          | ☐ |  |
| 3 Identidade      | ☐ |  |
| 3.5 sobrevive à reconexão | ☐ | nome ☐ · apelido ☐ |
| 3.6 sobrevive ao restart  | ☐ | nome ☐ · apelido ☐ |
| 3.7 nametag projeta       | ☐ | Desconhecido ☐ · acompanha ☐ · atrás da câmera ☐ |
| 3.7 revelação por staff   | ☐ | alvo certo ☐ · moderador negado ☐ · audit ☐ |
| 4 Chat            | ☐ |  |
| 5 Morte           | ☐ | tempo até DOWNED: ___ s |
| 5.2 death:killer  | ☐ | killerId: ___ |
| 6 Governança      | ☐ |  |
| 7 Staff           | ☐ |  |
| 9.1 hit-events    | ☐ | golpes/powerAttacks gravados: ___ / ___ · segundos até a linha: ___ |
| 9.1.4 o `0x14`    | ☐ | agressorCharacterId: ___ · alvoCharacterId: ___ |
| 9.2 espm          | ☐ | `0xf` passou ☐ · `0x14` barrado ☐ · `character_inventory` limpo ☐ |
| 9.3 safe-zones    | ☐ | config carregou ☐ · `safe-zones.json` apagado ao fim ☐ |
| 9.4 soul-service  | ☐ | primeiro sinal chegou ☐ · soma 200/150 ☐ · sem numero no `/alma` ☐ · semente fora do audit ☐ |
| 9.4.7 alma congelada | ☐ | valores antes: ___ · depois de editar a ficha: ___ |

## O que quebrou
(erro exato, o que estava fazendo, o que o log disse)

## Decisões desbloqueadas
- [ ] QA 1.8 — tirar o polling do death-service (se 5.2 passou)
- [ ] QA 1.6 — confirmar master API (se 1.6 passou)
- [ ] Remover `/internal/session/resolve` (se 1.6 passou)
- [ ] Liberar Fase 1 da integração com a Chancelaria
- [ ] Liberar a etapa 2 do `soul-service` — os quatro resultados em encantamento (se 9.4 passou). Depende de decidir onde eles aparecem, e de o `crafting-service` sair de PARKED
- [ ] Apagar o `checkDamageSpike` do `death-service` (se 9.1.3 e 9.1.4 passaram — só então o evento de hit substitui a heurística de verdade)
- [ ] Decidir se algum chamador da `action-policy` passa a informar `context.actorId` — sem isso `safe-zones` continua carregado e inerte (ver 9.3)
```

---

## O que este teste decide

Não é cerimônia. Cinco coisas estão **explicitamente esperando** o resultado:

| Se passar | Desbloqueia |
|---|---|
| 5.2 (`death:killer`) | Tirar o polling de 2 s do `death-service` — com 40 jogadores ele come ~600 ms de cada janela |
| 1.6 (`resolve_count`) | Confirmar o master API e apagar o `/internal/session/resolve`, que já é redundante |
| 2.2 (vitais reais) | Confirmar o formato do `self` em Papyrus in-game |
| 9.1.3 + 9.1.4 (`combat:episode` com os dois lados resolvidos) | Apagar o `checkDamageSpike` — a heurística de 25 de vida que não sabe quem bateu só sai quando o evento de hit provar que chega |
| 9.2 (`0x14` barrado) | Confirmar que a validação de item pega erro de digitação sem quebrar `/additem` — os dois modos de falha estão no mesmo teste |
| Tudo | Fase 1 da integração com a Chancelaria Real |
| Tudo | O `soul-service` da Afinidade da Alma |

**Falhar aqui é resultado bom.** O que não pode acontecer é continuar sem saber.
