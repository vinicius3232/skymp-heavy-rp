# Pipeline de ações administrativas

**Data:** 2026-08-15 · **Estado:** implementado, aplicado a 13 ações, coberto por teste.
**Mecanismo:** [`skymp/gamemode/core/admin-action.js`](../../skymp/gamemode/core/admin-action.js)
**Registros:** [gamemode](../../skymp/gamemode/admin-actions.js) · [painel](../../apps/web/admin-actions.js)

Antecedentes: [matriz de autorização](AUTHORIZATION_MATRIX.md) ·
[estado da plataforma](SKYADMIN_CURRENT_STATE.md)

---

## 1. O que foi consolidado, e o que deliberadamente não foi

Antes, uma ação administrativa era o que cada superfície decidia que ela era.
`commands.js` tinha doze registros de comando, cada um com o próprio
`parseInt(parts[0], 16)`, o próprio tratamento de argumento faltando e a própria
resposta para "e se o alvo não existir?". O painel tinha um handler de rota que
fazia tudo inline. O bot decidia sozinho quem era staff.

O que passou a ser comum são as **oito etapas** e o **envelope**. O que
**não** foi movido é a regra de domínio: `admin-service`, `governance-service` e
`transaction-service` continuam exatamente como estavam, com as mesmas
assinaturas. Um monólito administrativo teria sido a resposta errada à mesma
pergunta — e é a que a `PARKED_SERVICES_DECISION.md` já rejeitou três vezes por
outros motivos.

```
   WEB          DISCORD        COMMAND          API
    │              │              │              │
    └──────────────┴──────┬───────┴──────────────┘
                          │   a superfície entrega texto cru
                          ▼   e um handle de sessão que ela não escolhe
                   ┌─────────────┐
                   │ ADMIN ACTION│  o envelope
                   └──────┬──────┘
                          ▼
                     SESSION        quem é você?      ← resolvido no servidor
                          ▼
                    PERMISSION      pode?             ← core/permissions.js
                          ▼
                    VALIDATION      o pedido faz sentido?
                          ▼
                       TARGET       contra quem?      ← resolvido no servidor
                          ▼
                        STATE       faz sentido agora?
                          ▼
                 DOMAIN SERVICE     o serviço que já existia, intacto
                          ▼
                   TRANSACTION      efeito confirmado; idempotência
                          ▼
                        AUDIT       sempre, inclusive quando falha
                          ▼
                       RESULT
```

---

## 2. O envelope

```js
AdminAction {
  actionId,          // identifica ESTA invocação
  correlationId,     // liga invocações relacionadas
  sessionId,
  staffAccountId,
  staffCharacterId,
  permission,
  action,            // o NOME da ação: 'players.kick'
  target,
  reason,
  parameters,
  source,
  requestedAt
}
```

**`actionId` × `action` × `correlationId`** — os três nomes convidam à confusão,
então a escolha está declarada:

- **`action`** é o nome, estável e repetido: por ele se pergunta "quantos kicks
  houve?".
- **`actionId`** é único por invocação: por ele se acha uma linha específica.
- **`correlationId`** liga invocações — o retry de um clique, ou a mesma decisão
  atravessando painel e jogo. É o **único** campo que a superfície pode
  fornecer, e serve exclusivamente para rastreio e deduplicação. **Nunca entra
  em nenhuma decisão de autorização**, e é escopado por conta dentro do
  pipeline: sem isso, escolher o id de outra pessoa seria uma forma de suprimir
  a ação dela.

---

## 3. Nada de identidade vem de fora

A superfície entrega **apenas**: qual ação, um handle de sessão que ela mesma
não escolhe, o alvo como texto cru, o motivo e os parâmetros.

| A superfície manda | O servidor resolve |
|---|---|
| `sourceRef` — o `actorId` do motor, ou o `req` com cookie assinado | `sessionId`, `staffAccountId`, `staffCharacterId`, **cargo** |
| `targetRef` — o hex que a staff digitou, ou o id da URL | `characterId`, `accountId`, `label`, estado atual do alvo |
| `parameters`, `reason` | validados contra o descritor; chave não declarada é **recusa**, não silêncio |

Quatro coisas são explicitamente ignoradas quando aparecem no pedido: **cargo,
`accountId`, `characterId` e estado do alvo**. Há um teste por item, e cada um
tenta injetar o campo e verifica que ele não chegou a lugar nenhum.

Isso vale inclusive para a superfície mais confiável do projeto — o comando de
chat, cujo `actorId` vem do próprio motor. Mesmo ali `characterId` e
`accountId` são relidos, porque **o SkyMP reaproveita `actorId` entre sessões**:
foi essa reutilização que já fez um cargo de admin ficar preso a um slot e ser
herdado por quem entrasse depois. Um `characterId` "que a superfície já sabia"
seria do jogador anterior.

O cargo também é relido a cada ação, e não guardado na sessão: um cargo lido no
login seria uma foto, e revogar staff passaria a depender de a pessoa deslogar.

---

## 4. Os cinco desfechos

Colapsá-los num booleano foi o que fez `hasPermission` e `removeGold`
devolverem a mesma coisa para "não pode" e "o banco caiu" — e, na multa da
guarda, um timeout de rede virar mandado de prisão contra quem tinha o dinheiro.

| Desfecho | Significa | HTTP | Etapa típica |
|---|---|---|---|
| `executed` | aconteceu | 200 | — |
| `denied` | a pessoa não podia | 403 | `session`, `permission` |
| `invalid` | o pedido estava errado | 400 | `validation` |
| `blocked` | o pedido estava certo e o mundo disse não | 409 | `target`, `state` |
| `failed` | o serviço de domínio quebrou | 500 | `execute` |
| `duplicate` | já aconteceu com este `correlationId` | 200 | `transaction` |

`duplicate` responde **200 e não 409** de propósito: a intenção do cliente foi
satisfeita — a ação aconteceu, só não agora. Um 409 faria um duplo clique
parecer erro para quem clicou.

Todo desfecho que não é `executed` nomeia a **etapa** em que parou. Antes, "não
aconteceu" era um `undefined` e uma notificação.

---

## 5. A etapa TRANSACTION, dita sem eufemismo

**O pipeline não abre transação.** Todo serviço de domínio que move patrimônio
já é dono da transação dele através do `core/transaction-service`, que é o único
lugar do projeto autorizado a segurar uma conexão. Envolver `setGold` numa
transação externa aninharia duas e quebraria a única propriedade que aquele
serviço garante.

O que a etapa faz de real:

1. **Decide o desfecho** — `ok: false` do domínio vira `blocked`, exceção vira
   `failed`.
2. **Confirma a idempotência só no sucesso.** Um `execute` que lança **não**
   consome o `correlationId`, então a ação pode ser reenviada com o mesmo id
   depois que a causa da falha for resolvida, em vez de ficar presa achando que
   já aconteceu.

Quando aparecer uma ação que precise de atomicidade entre dois serviços, o lugar
dela é aqui, e o descritor ganha `transactional: true`. **Nenhuma ação de hoje
precisa, e por isso o parâmetro não existe** — construí-lo agora seria uma porta
esperando por uma chave que ninguém pediu.

---

## 6. Auditoria em um formato só

O achado dos "cinco escritores, quatro formatos" não se resolve reescrevendo os
cinco. Resolve-se dando ao próximo — e a quem migrar — um lugar onde o formato é
decidido uma vez:

```
admin:players.kick
correlation=c-1 permission=players.kick source=command outcome=executed
stage=audit session=actor:aa01 staffChar=9001 target=Alvo_Dois(0xbb02)
targetChar=4242 reason="gritou por cima da cena toda"
```

`chave=valor` e não JSON porque `details` é `TEXT` e já carrega quatro formatos
escritos por cinco módulos; mudar para JSON exigiria migrar os antigos ou
conviver com dois. Este formato é legível por olho, por `grep` e por um parser de
dez linhas — que é o que a superfície de `security.review` vai precisar.

**Toda etapa que interrompe também vira linha**, com `outcome` e `stage`. A
auditoria continua fail-open — uma escrita que falha grita e o desfecho segue —
e isso é declarado: a diferença é que agora está **num lugar só**. O dia em que
o projeto quiser fail-closed para as ações irreversíveis, é uma função que muda,
não cinco.

---

## 7. O que foi aplicado

### 7.1 Gamemode — 12 ações (fonte `command`)

| Comando | Ação | Motivo |
|---|---|---|
| `/kick` | `players.kick` | **obrigatório** |
| `/tp` | `players.teleport` | — |
| `/anim` | `players.animate` | — |
| `/additem` | `inventory.grant` | opcional |
| `/setgold` | `economy.adjust` | **obrigatório** |
| `/permakill` | `characters.retire` | **obrigatório** |
| `/revelaridentidade` | `identity.reveal` | **obrigatório** |
| `/calar` | `voice.mute` | **obrigatório** |
| `/descalar` | `voice.unmute` | opcional |
| `/vozdiag` | `voice.diagnose` | — |
| `/vozdesconectar` | `voice.disconnect` | **obrigatório** |
| `/vozreconectar` | `voice.reconnect` | — |

**Cinco desses comandos não existiam.** `voiceMute`, `voiceUnmute`,
`voiceDiagnose`, `voiceDisconnect` e `voiceForceReconnect` estavam no
`admin-service` com permissão, auditoria e teste de comportamento passando — e
**nenhum `commandRegistry.register`**. Os docstrings falavam de `/calar` e
`/vozdiag`, o `voip-service` anunciava no log do boot que estavam disponíveis, e
digitar qualquer um deles respondia *"Comando desconhecido"*.

A suíte inteira passava porque cada teste chamava o handler direto: "a ação
existe" e "a ação é alcançável" eram duas afirmações independentes. O registro
as uniu, e há um teste que reprova a próxima ação que nascer inalcançável.

### 7.2 Painel — 1 ação (fonte `web`)

`whitelist.review` é a única rota mutável de staff que existe. O handler não foi
reescrito: foi movido para o `execute`, com o mesmo SQL e a mesma ordem. Ele
perdeu duas coisas:

- o próprio `INSERT INTO audit_logs` — agora o pipeline audita, com
  `correlationId`, permissão e desfecho, que a linha antiga não tinha;
- o `if (idRows.length > 0)` — uma aplicação inexistente para na etapa `target`.
  Isso conserta de passagem um achado da auditoria: a rota respondia `ok:true`
  para um id que não existia, gravava auditoria com alvo nulo e notificava o
  Discord como `aplicação #<id>`.

E ganhou uma regra: **rejeitar exige motivo**. Rejeitar sem dizer por quê deixa
o jogador sem nada para corrigir e a staff seguinte sem nada para consultar.

---

## 8. As três mudanças de comportamento

Todas deliberadas, todas correções de inconsistência que a auditoria registrou.

1. **`/kick` passou a exigir motivo.** O `commands.js` caía para `'Sem motivo'`,
   enquanto `/permakill` recusava a ação sem motivo. Duas regras para a mesma
   classe de ato, porque cada handler decidiu sozinho.
2. **`/setgold` passou a exigir motivo.** É o comando que mais precisa de
   rastro: ouro que aparece sem origem registrada é indistinguível de duplicação
   por bug, e quem pode fazer isso é exatamente a staff.
3. **`/revelaridentidade` passou a exigir motivo.** É a única ação de staff que
   não se desfaz nem por outro comando nem pelo tempo. O que torna esse poder
   aceitável é alguém conseguir mostrar depois **por que** ele foi usado, e não
   só que foi.

O custo está dito: os três comandos passam a recusar sem a última parte, e a
mensagem de uso diz o que falta. É atrito, e é aceito.

---

## 9. O que NÃO foi aplicado, e por quê

| Superfície | Estado | Por quê |
|---|---|---|
| **Bot do Discord** (`discord`) | não aplicado | O bot já perdeu a autoridade própria e pergunta ao painel (`POST /internal/authorize`). Rotear `/voz-criar` pelo pipeline exigiria que a **auditoria** também atravessasse o painel, porque o bot não tem banco — é um endpoint novo, não uma fiação. Fica como o próximo passo natural, e o custo de não ter feito está dito: criar canal de voz continua sem linha em `audit_logs`. |
| **Game API** (`api`) | não aplicado | Não tem nenhuma ação administrativa. `api` existe no vocabulário do envelope porque é a origem que a ponte painel→jogo vai usar quando existir. |
| **Ações de governança IC** | não aplicado | Prisão, multa, confisco e mandado são ações de **personagem**, não de staff. Elas têm o próprio eixo de permissão, com escopo e plantão. Empurrá-las para cá misturaria os dois eixos, que é exatamente o que `manage_staff` já faz de errado. |
| **`death-service`, `identity-service`, `market-stalls`** | não aplicado | Escrevem `audit_logs` direto, em formatos próprios. Migrar é ganho de uniformidade sem mudança de comportamento — o tipo de coisa que se faz devagar, uma por vez. |

---

## 10. Cobertura

| Suíte | Testes | O que trava |
|---|---|---|
| [`core/admin-action.test.js`](../../skymp/gamemode/core/admin-action.test.js) | 33 | identidade injetada no pedido não chega a lugar nenhum (5 casos); ordem das etapas; permissão antes do alvo (não vazar existência de jogador); validação de motivo e parâmetros; parâmetro não declarado é recusa; os cinco desfechos distintos; idempotência (incluindo "falha não consome o id" e "negação não trava o id de quem pode"); toda etapa vira linha; auditoria que falha não vira permissão; descritor com permissão reservada não sobe |
| [`admin-actions.test.js`](../../skymp/gamemode/admin-actions.test.js) | 23 | **toda ação registrada tem comando que a invoca**; todo comando aponta para ação existente; as cinco de voz alcançáveis; motivo obrigatório nas irreversíveis; resolvedores leem do servidor e recusam lixo; o adaptador de chat não inventa padrão |
| [`apps/web/permissions.test.js`](../../apps/web/permissions.test.js) | 44 | a matriz rota × cargo, agora incluindo o `PATCH` que atravessa o pipeline |

Suítes completas: gamemode **1422/1422**, painel **84/84**, game-api **48/48**,
bot **42/42**, `test:systems` 13/13, typecheck limpo.
