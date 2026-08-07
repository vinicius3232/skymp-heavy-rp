# Sistema de Nametag e Identidade Social

Data: 2026-07-12. **Atualizado em 07/08/2026** — ver "Atualização de 07/08/2026" ao final: a revelação de staff saiu do papel, e a nametag deixou de estar bloqueada por uma pergunta em aberto.

Objetivo: impedir que jogadores descubram o nome IC de outro personagem apenas por proximidade, interface ou chat. O nome exibido deve depender do conhecimento do personagem observador.

## Estado Atual

Implementado em laboratorio:

- Servico server-side: `skymp/gamemode/identity-service.js`.
- Relacao persistente: `character_known_identities`.
- Integracao com chat local: `rp-chat-service.js` resolve nomes por destinatario.
- Comandos:
  - `/apresentar <actorId>`: apresenta o proprio personagem ao alvo.
  - `/apelido <actorId> <nome>`: salva um nome privado para reconhecer alguem.
  - Aliases tecnicos: `/introduce` e `/alias`.

Ainda pendente:

- ~~Nametag visual acima da cabeca.~~ → **POC construída em 07/08/2026, não validada em jogo.** Ver §"A nametag" abaixo.
- UI de lista curta de pessoas proximas.
- **Validacao em jogo com dois clientes** — continua pendente, e continua sendo o que separa este sistema de pronto.
- Integracao completa com disfarces. → Ver §"O disfarce, quando voltar" abaixo: o lugar dele já está decidido.

## Regra de Exibicao

Para cada observador, o servidor resolve o nome do alvo assim:

1. Proprio personagem: nome real.
2. ~~Staff futura: nome real, com permissao auditada.~~ → **Corrigido em 07/08/2026: isto não é um degrau da escada.** Virou `/revelaridentidade`, um caminho à parte. Ver §"A revelação de staff" — o porquê importa mais que a mudança.
3. Identidade conhecida: nome registrado em `character_known_identities`.
4. Desconhecido: `Desconhecido`.

O cliente nao escolhe nem envia o nome exibido.

## Apresentacao

`/apresentar <actorId>` e unilateral.

Exemplo:

- A usa `/apresentar B`.
- B passa a conhecer A pelo nome real de A.
- A nao passa a conhecer B automaticamente.
- Se B quiser revelar o proprio nome, B usa `/apresentar A`.

Motivo: a cena precisa acontecer em RP. O sistema nao deve transformar proximidade em metagaming automatico.

## Apelido

`/apelido <actorId> <nome>` salva conhecimento privado do observador.

Usos esperados:

- `Ferreiro de Whiterun`
- `Guarda ruivo`
- `Homem encapuzado`
- `Mercadora da taverna`

Esse nome aparece apenas para quem definiu o apelido.

## Referencia Keizaal Online

Nao foi encontrada documentacao tecnica publica confirmando a implementacao exata de nametags do Keizaal Online.

Decisao: usar o comportamento como referencia de design relatada/observada, nao como fonte tecnica confirmada.

Fontes publicas usadas como contexto:

- `https://keizaal.com/`
- `https://keizaal.com/play`
- `https://github.com/skyrim-roleplay`
- `https://github.com/skyrim-multiplayer/skymp`

## Requisitos Para Alfa

Estado em 07/08/2026. A coluna que importa é a última: "código pronto" e "alguém viu funcionar" são coisas diferentes neste projeto, e misturá-las é o que o `QA_REPORT_2026-08.md` existe para não deixar acontecer.

| Requisito | Estado | O que falta |
|---|---|---|
| Dois clientes veem nomes diferentes para o mesmo alvo | ⚠️ **Coberto por teste, nunca visto** | Duas pessoas, dois clientes. `identity-service.test.js` e `nametag-service.test.js` provam que o servidor *calcula* nomes diferentes por observador |
| O nome real nao aparece no chat para personagem desconhecido | ⚠️ **Coberto por teste, nunca visto** | Idem. `rp-chat-service` resolve por destinatário e há teste |
| Reconexao preserva conhecidos e apelidos | ⚠️ Implementado (`loadKnownIdentities` no login), não exercitado em sessão | Uma reconexão real |
| Restart do servidor preserva conhecidos e apelidos | ⚠️ Implementado (a tabela é a fonte, o cache é derivado), não exercitado | Um restart real |
| Disfarce sobrescreve nome público sem alterar conhecimento real | ❌ **Fora de escopo, com lugar decidido** | Ver §"O disfarce, quando voltar" |
| Staff tem comando auditado para revelar identidade | ✅ **Resolvido em 07/08/2026** | Nada. `/revelaridentidade`, permissão `reveal_identity`, 10 testes + matriz de cargo, 6 mutações verificadas |
| Nametag visual acima da cabeça | ⚠️ **POC construída, projeção nunca executada** | Ver §"A nametag" — a lista do que não foi provado é específica e curta |

---

# Atualização de 07/08/2026

## A revelação de staff

**Resolvido: comando explícito e auditado, permissão própria, `admin` e `owner`.**

`/revelaridentidade <actorId>` (alias técnico `/revealidentity`, mesmo padrão de `/apresentar` → `/introduce`). Implementado em `skymp/gamemode/admin-service.js`.

### Por que comando, e não "staff sempre vê o nome real"

A regra 2 acima dizia *"Staff futura: nome real, com permissao auditada"*, e a leitura literal disso — um terceiro ramo dentro de `getDisplayName()` — foi avaliada e recusada. Quatro motivos, em ordem de peso:

1. **Estado não se audita; só o uso dele.** A própria regra pede auditoria. Um ramo passivo não tem evento: ninguém consegue responder *quem* furou o anonimato de *quem* e *quando*, que é exatamente a pergunta de uma arbitragem contestada. Um comando tem ator, alvo e carimbo de tempo.
2. **Acoplaria a autoridade sobre o nome ao cache de staff.** `getDisplayName(observador, alvo)` trabalha com **personagens**; o cargo de staff vive em `staffCache`, chaveado por **actorId**. Um ramo lá dentro obrigaria o `identity-service` a importar o `admin-service`, e o efeito apareceria de uma vez em todos os chamadores — chat local, aba Social do painel, nametag. É a forma de defeito que a [`PARKED_SERVICES_DECISION.md`](PARKED_SERVICES_DECISION.md) §7.1 usou para apagar o `disguise-service`, aplicada por dentro em vez de por fora.
3. **A staff também joga.** Nome real passivo estraga permanentemente as cenas do personagem de quem é staff. Custo contínuo, pago por todo mundo o tempo todo, para atender um caso raro.
4. **Revelar é raro por desenho.** Se virar rotina, o problema é outro.

**O preço da escolha, dito por inteiro:** investigar custa um comando por pessoa, e a staff precisa do `actorId` em mãos. É atrito real, e foi aceito — desmascarar deve doer um pouco.

### Por que uma permissão nova, e por que `admin`+

Mesmo formato de raciocínio da §7.4 do `PARKED_SERVICES_DECISION.md`.

**Por que `reveal_identity` nova e não `view_audit`.** `view_audit` era o candidato óbvio e é o errado, pelo mesmo motivo que `add_item` era errado para receita: significa **ler o que a staff fez**, não **furar o anonimato de um jogador**. Quem auditasse *"quem pode `view_audit`?"* receberia a resposta errada sobre quem pode desmascarar. E `view_audit` é permissão de moderador — reaproveitá-la alargaria o poder para a linha de frente inteira sem que ninguém tivesse decidido isso.

**Por que fora do moderador.** O argumento aqui **não** é o de patrimônio da §7.4 — revelar não move nada. É que **nenhuma outra ação de staff é irreversível do jeito que esta é**: um kick acaba quando a pessoa reconecta, ouro dado volta por outro `/setgold`, e até o `/permakill` é soft-delete. Uma identidade revelada não desrevela — ela passa a morar na cabeça de quem leu, e o `audit_logs` registra que aconteceu sem poder desfazer. O valor do sistema de anonimato é inversamente proporcional a quantas pessoas conseguem contorná-lo, e moderador é o cargo mais numeroso e menos filtrado.

**O que continua em aberto.** Se a operação real mostrar que denúncia de metagaming chega mais rápido do que admin responde, a resposta **não** é dar `reveal_identity` ao moderador — é desenhar uma variante com escopo (revelar apenas quem é parte de uma denúncia aberta). Alargar o cargo resolveria a fila criando o problema que a permissão existe para evitar.

### O que o comando deliberadamente não faz

**Não escreve em `character_known_identities`.** Aquela tabela é conhecimento **IC** — o que o personagem sabe. A revelação é **OOC**. Gravá-la ali faria o personagem da staff chamar o alvo pelo nome real no chat local para sempre, sem que ninguém tivesse apresentado nada a ninguém: a ferramenta de investigação viraria máquina de metagaming com rastro de aparência legítima. Há teste de mutação para isso.

**Não toca `getDisplayName()`.** A escada continua com os degraus que tinha — e precisa chegar limpa nas mãos de quem construir o disfarce.

### O bug que o `/revealid` antigo tinha

Registrado aqui porque ele explica por que a cobertura é do jeito que é. O `disguise-service.staffReveal` (apagado em 06/08/2026, §7.1 achado 5) montava a mensagem com os dados de **quem digitou o comando**, usando o `targetActorId` só para localizar o disfarce: `/revealid` respondia *"X é na verdade \<nome de quem digitou\>"*. Um teste de permissão não teria pego isso — o comando era autorizado corretamente e respondia corretamente errado. Por isso `identity-staff-reveal.test.js` existe separado da matriz de cargos: lá a pergunta é *"quem pode?"*, aqui é *"quando pode, revela a coisa certa?"*.

## A nametag

**Estado: parcialmente provado.** Há caminho técnico, há POC, e **a projeção nunca foi executada**.

### O que a investigação achou

A pergunta que travava a nametag desde a origem era *"o servidor consegue saber onde um ator aparece na tela do observador?"*. A resposta é **sim, mas não o servidor** — e essa distinção é a peça inteira.

| Achado | Procedência |
|---|---|
| `worldPointToScreenPoint(...pontos: number[][]): number[][]` — *"convert an array of points in the game world to an array of points on the user's screen. The dot on the screen is indicated by 3 numbers from -1 to 1."* | **[DOC]** `skyrim-multiplayer/skymp`, `docs/skyrim_platform/new_methods.md`. Assinatura das tipagens oficiais (`skyrim-platform/skyrim-platform`, `index.d.ts`) |
| Evento `update` — *"Called once for every frame in the game (60 times per second at 60 FPS) after you've loaded a save or started a new game."* | **[DOC]** mesmo repositório, `docs/skyrim_platform/new_events.md` |
| Alcançável como `ctx.sp.worldPointToScreenPoint` dentro de um snippet de `makeProperty` | **INFERÊNCIA.** `ctx.sp` é o namespace do Skyrim Platform e este projeto já usa `ctx.sp.on` e `ctx.sp.browser.*` com sucesso — mas ninguém viu esta função responder |
| O Red House **não** fez nametag | Confirmado lendo o estudo: o front deles é `client/{animList, chat}`, `systems/{interactionMenu, trade}`, `crafts`. O "player ID" do HUD deles é elemento de canto fixo. Ver [`REFERENCE_STUDY_SKYMP_RED_HOUSE.md`](REFERENCE_STUDY_SKYMP_RED_HOUSE.md) §4.1 |
| Nenhum HUD deste projeto jamais foi ancorado no mundo | Confirmado lendo `skymp/ui/index.html`: `#voip-hud` e `#voip-status` são `position: fixed` com canto fixo |

Ambas as assinaturas foram registradas em `skymp/gamemode/types/mp.d.ts`, com a marcação de procedência que aquele arquivo exige.

### O achado que derruba o bloqueio de custo

O medo registrado era que uma nametag em tempo real por polling Papyrus inviabilizaria o servidor. O número que sustentava isso vem das medições que o Red House deixou anotadas — 13 ms num `getEquipment`, 35 ms num `av.set` (`REFERENCE_STUDY_SKYMP_RED_HOUSE.md` §4.1) —, e é o mesmo custo que fez o `player-panel-service` parar de ler vitais de quem não está com a aba Status aberta.

**Aquelas medições são de chamadas do *servidor* para o Papyrus do cliente: ida e volta pela rede.** `worldPointToScreenPoint` não é isso. Ela é função nativa do próprio processo do jogo, chamada por JS que já está dentro dele. **Zero chamadas Papyrus por quadro, por pessoa.** O argumento que bloqueava não se aplica a este caminho.

### As duas frequências, e por quê

| O quê | Onde | Frequência | Por quê |
|---|---|---|---|
| Quem é o alvo, e o nome dele | Servidor | **2 s** | Mesmo tick da voz. Nome só muda quando alguém se apresenta ou recebe apelido — evento humano, digitado. Quem é o mais próximo muda em velocidade de caminhada. É a mesma defasagem que o `proximity_update` do VOIP já carrega, aceita lá pelo mesmo motivo: a conta é O(n²) de distância 3D e pagá-la mais vezes por segundo não compra nada perceptível |
| A posição na tela | Cliente | **até 20 Hz** | Aqui a defasagem é percebida: uma etiqueta que se atualiza a cada 2 s não parece atrasada, parece quebrada — fica parada no ar enquanto a pessoa anda. O laço roda no `update` (60 fps) e só trabalha a cada 50 ms; o CSS interpola o intervalo |

**Por que não por quadro, se a projeção é barata.** Não é a projeção que custa: é o `browser.executeJavaScript`, que serializa uma string e a atravessa para o processo da CEF. A 60 fps seriam 60 travessias por segundo por etiqueta. **Esse custo não foi medido** — e é por não ter sido que o padrão é conservador. O `index.html` já tinha tomado a mesma decisão pelo mesmo motivo no HUD de voz.

### O que a POC é, e o que não é

`skymp/gamemode/nametag-service.js`, atrás de `ENABLE_NAMETAG_SERVICE`, desligado por padrão.

**Uma etiqueta: a do personagem mais próximo.** Não todos os vizinhos. O que precisa ser provado primeiro é que a projeção funciona e que o texto certo chega, e isso uma etiqueta prova igual a dez — dez multiplicariam por dez um custo de CEF que ninguém mediu.

**Não toca `getDisplayName()`.** A nametag chama e não sabe resolver nome nenhum. Isso é requisito, não conveniência: quando o disfarce virar degrau daquela função, a etiqueta passa a mostrar o nome disfarçado sem uma linha de mudança.

**O cliente nunca escolhe o texto.** Ele recebe o nome pronto e só o posiciona. Se pudesse escolher, o anonimato não existiria — bastaria editar o JS do cliente. Há teste estático sobre o snippet que reprova se alguém o fizer tentar descobrir nome sozinho.

### O que NÃO está provado

Isto tem o mesmo peso que *"ninguém ouviu ainda"* tem nos documentos da voz nativa. Não é rodapé.

- **`ctx.sp.worldPointToScreenPoint` nunca foi chamada.** Que ela seja alcançável por esse caminho é **inferência**, não observação — a mesma classe de suposição que já custou caro duas vezes neste projeto (o `self` do Papyrus, o require nu de `dotenv`).
- **A convenção dos eixos não foi verificada.** O código assume `x = -1 esquerda / +1 direita` e `y = -1 embaixo / +1 em cima`, que é o padrão de espaço normalizado, mas a documentação não diz. Se a etiqueta aparecer espelhada na vertical, o conserto é trocar o sinal do `y`: uma linha.
- **Ponto atrás da câmera é um buraco conhecido.** A documentação diz "3 números de -1 a 1" e não diz o que acontece com quem está atrás. O código esconde a etiqueta fora da faixa, o que resolve o caso comum e **não** resolve um ponto atrás que projete dentro dela — a etiqueta apareceria com a pessoa às costas. Não se fecha isso lendo documentação.
- **O custo do `executeJavaScript` a 20 Hz não foi medido.**
- **A altura da cabeça (145 unidades) é estimativa de mesa.** O número certo sai da primeira sessão, não do código.
- **Ninguém validou com dois clientes.** É o requisito de alfa que este próprio documento carrega desde a origem, e o que separa *"A vê `Desconhecido` e B vê `Brenna`"* de *"o código calcula que A deveria ver `Desconhecido`"*.

### A cobertura, e o que ela protege

24 testes em `nametag-service.test.js`. Os seis últimos são de tipo diferente: leem o snippet de cliente **como texto** e reprovam padrão proibido. É a única forma de proteger uma decisão sobre código que roda numa máquina que o processo de teste nunca vê — em particular, um `callPapyrusFunction` dentro do laço de tela reprova, com a mensagem apontando para cá.

## O disfarce, quando voltar

**Não está no escopo desta rodada, e o lugar dele já está decidido — não redescubra isso do zero.**

A [`PARKED_SERVICES_DECISION.md`](PARKED_SERVICES_DECISION.md) §7.1 apagou o `disguise-service.js` em 06/08/2026 e registrou onde o requisito passa a morar: **um degrau dentro de `getDisplayName()`, não um serviço paralelo.** O encaixe já está pronto de três lados:

- `character_known_identities.source` aceita o valor `'disguise'` desde o `schema.sql`;
- `skymp/ui/player-panel.js` já rotula esse valor como "disfarce" na aba Social;
- este documento já registrava o requisito na forma certa — *"disfarce ativo deve poder sobrescrever nome publico sem alterar conhecimento real"* —, isto é, como regra **dentro** da escada de exibição.

O que a §7.1 explica e não se deve reaprender pelo caminho caro: a chave é `(observador, alvo)`, nunca só `alvo`. Sob o `identity-service`, quem não te conheceu já te vê como `Desconhecido` — **anonimato é o padrão**. O que o disfarce precisa resolver é o caso oposto: parecer *outra pessoa específica* para quem **já te conhece**. Isso é necessariamente por observador, e é por isso que a estrutura do serviço antigo (um nome falso global) não podia expressar o requisito.

**As duas peças desta rodada foram desenhadas sabendo que esse terceiro degrau chega depois.** A revelação de staff ficou **fora** de `getDisplayName()` justamente para que a função chegue limpa; a nametag **não sabe** resolver nome, então herda o degrau novo de graça.
