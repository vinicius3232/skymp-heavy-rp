# Interaction Framework

**Estado:** implementado, testado (96 testes) e **é o único caminho** — o legado foi removido em 13/08/2026. **Nunca rodou numa sessão real** — mesmo peso que *"ninguém ouviu ainda"* tem na voz nativa e que a projeção não executada tem na etiqueta de identidade.

Arquivos:

| Arquivo | Responsabilidade | Toca `mp`/banco? |
|---|---|---|
| [`core/interaction-registry.js`](../../skymp/gamemode/core/interaction-registry.js) | Catálogo de interações + validação de payload | **Não** — função pura |
| [`core/interaction-targets.js`](../../skymp/gamemode/core/interaction-targets.js) | Traduz o alvo que o cliente diz no alvo que o servidor sabe | Só via `range-utils` |
| [`core/interaction-service.js`](../../skymp/gamemode/core/interaction-service.js) | O pipeline de decisão | Não — tudo por injeção |

---

## 1. O problema

Um servidor de Heavy RP precisa que um jogador aponte para outro e veja *o que faz sentido fazer com aquela pessoa, agora*. Guarda vê "Revistar". Médico vê "Examinar". Quem está do lado de uma barraca vê "Comprar". Ninguém vê o que não pode fazer.

Isso já existia, dentro do `governance-service.js`, e o **fluxo estava certo**. O que estava errado era onde morava: para uma barraca aparecer no menu, a governança precisava importar o módulo de barracas por nome fixo; o vocabulário de ações era uma regex de três namespaces no core; e `requestId` era validado e jogado fora, então duplo clique em "Aplicar multa" cobrava duas vezes.

Diagnóstico completo em [`CORE_FRAMEWORK_AUDIT.md`](../research/CORE_FRAMEWORK_AUDIT.md) §6.

---

## 2. A regra central

> **`canSee` não autoriza nada.**

`canSee` decide o que aparece num menu montado num instante anterior, na máquina de outra pessoa. Entre a montagem e o clique o alvo pode ter andado, saído, sido preso ou vendido a barraca; quem clicou pode ter perdido o cargo.

Por isso `execute` **refaz o pipeline inteiro** — resolve o alvo de novo, checa permissão de novo, mede distância de novo — e roda `canExecute` além de `canSee`.

Nenhuma interação precisa lembrar de revalidar. Quem revalida é o pipeline.

---

## 3. O pipeline

```
Cliente (CEF)
    │  interaction:query  |  interaction:execute
    ▼
core/ui-event-gateway.js        envelope + telemetria, nunca loga payload
    ▼
core/ui-event-router.js         prefixo 'interaction' → e só ele
    ▼
core/interaction-service.js
    │
    ├─ 1. rate limit            política por tipo: query ≠ execute
    ├─ 2. ação conhecida        desconhecida = mesma resposta que indisponível
    ├─ 3. alvo                  targetId do cliente → registro do servidor
    ├─ 4. schema                payload saneado, campo não declarado é descartado
    ├─ 5. permissão             string opaca, resolvida por quem registrou
    ├─ 6. política de ação      core/action-policy.js — estado + zona segura
    ├─ 7. distância             core/range-utils.js
    ├─ 8. canSee                código do módulo
    ├─ 9. canExecute            código do módulo (só no execute)
    ├─ 10. deduplicação         requestId, para ações idempotentes
    ├─ 11. execute              o módulo faz o trabalho
    └─ 12. auditoria            por classe: TRACE não grava
    ▼
core/transaction-service.js     atomicidade e ledger, quando move ouro/item
```

### Por que esta ordem

- **Rate limit antes de tudo** — o objetivo dele é não pagar o resto.
- **Alvo antes de schema** — um pedido sem alvo válido não tem contra o que validar payload.
- **Permissão antes de política** — *"você não é guarda"* é uma resposta melhor que *"você está algemado"* para quem não é guarda.
- **Política e distância antes de `canSee`** — as duas são regras do core, `canSee` é código de módulo: o barato e auditável roda primeiro.
- **Deduplicação depois de toda validação** — um pedido que ia ser recusado não pode consumir o `requestId`, senão o retry legítimo, já corrigido, seria recusado como duplicata.

---

## 4. Registrar uma interação

Do `initialize()` do seu módulo:

```js
const interactionRegistry = require('./core/interaction-registry');

interactionRegistry.register({
  id: 'medical.help',                 // <modulo>.<acao>, minúsculas
  module: 'medical',                  // dono — usado na limpeza automática
  target: interactionRegistry.TARGET_TYPES.PLAYER,
  label: 'Prestar socorro',
  section: 'medicina',                // agrupamento no menu (padrão: o módulo)
  order: 10,                          // menor primeiro

  distance: 200,                      // unidades do Skyrim; medido pelo servidor
  policyAction: 'medical_help',       // id da core/action-policy.js
  audit: interactionRegistry.AUDIT_LEVELS.GAMEPLAY,
  idempotent: false,                  // true exige requestId e deduplica

  schema: {
    reason: { type: 'string', label: 'Motivo', max: 160 }
  },

  canSee: async ctx => estaFerido(ctx.target.characterId),
  canExecute: async ctx => ({ allowed: temBandagem(ctx.characterId), reason: 'Sem bandagem.' }),
  execute: async ctx => {
    await curar(ctx.target.characterId);
    return { message: 'Você estabilizou o ferido.' };
  }
});
```

E no descritor do módulo, em `phase0-basic.js`:

```js
dependencies: ['interaction'],
```

A ordenação topológica do `module-registry` garante que o framework esteja pronto antes do seu `initialize()`, independentemente da ordem dos blocos no arquivo.

**Nada mais precisa ser editado.** Nem o core, nem a governança, nem o roteador de eventos. É o §23 do pedido.

### O ciclo de vida é automático

`shutdownAll()` chama `interactionRegistry.unregisterModule(id)` para todo módulo, pelo mesmo motivo que remove os comandos: uma ação que sobrevive ao desligamento aparece no menu e executa contra um serviço que não está mais lá. Um módulo que falha **no meio** do `initialize()` também tem suas interações removidas.

---

## 5. O contexto entregue ao módulo

```js
{
  actorId,       // ator SkyMP de quem agiu
  actor,         // o registro de personagem que o servidor já tinha
  characterId,
  accountId,

  target: {      // resolvido pelo servidor, nunca copiado do payload
    type,        // 'player'
    id,          // 'player:512' — estável, para log e dedupe
    label,
    actorId, characterId, accountId, character,
    assertRange(fromActorId, maxRange)
  },

  interactionId,
  module,
  data,          // payload JÁ SANEADO: só os campos do schema, já convertidos
  requestId,     // null quando a ação não é idempotente
  permission,    // veredicto do checkPermission, quando houve
  distanceVerified,
  distanceUnverified
}
```

`data` é um objeto **novo**. Um campo não declarado no schema não chega ao `execute` — é a diferença entre validar e sanear.

`distanceUnverified` é `true` quando `mp` não existe e não houve como medir. O pipeline deixa passar (é o que torna tudo isto testável fora do jogo) mas a auditoria registra `distancia=NAO_VERIFICADA` em vez de mentir que mediu.

---

## 6. Tipos de alvo

O vocabulário tem sete: `PLAYER`, `NPC`, `OBJECT`, `CONTAINER`, `DOOR`, `PROPERTY`, `WORLD_POINT`.

**Só `PLAYER` tem resolvedor implementado.** Os outros seis são vocabulário reservado, e um pedido contra eles falha com *"Tipo de alvo nao suportado"* — fechado, nomeado, visível.

Escrever os seis agora seria escrever seis funções sem chamador, contra APIs do SkyMP que este projeto nunca exercitou (`mp.get(id,'inventory')` segue marcada `[DOC]` em `types/mp.d.ts`). É o mesmo critério que o `module-registry` usou em 06/08/2026 para **não** construir distribuição de eventos de jogo, e a alternativa — seis resolvedores adivinhados — é pior que a ausência, porque parece pronta.

Quando um tipo ganhar dono:

```js
interactionTargets.registerResolver('container', (rawTargetId, actorId) => {
  const bau = baus.get(String(rawTargetId));
  if (!bau) return null;                       // null = alvo inválido
  return {
    type: 'container',
    id: `container:${bau.id}`,
    label: bau.nome,
    assertRange: (from, max) => rangeUtils.assertRange(from, bau.actorId, max)
  };
});
```

O core não precisa saber que ele existe.

### Ninguém é alvo de si mesmo

Interação consigo é o painel (`/painel`), não o menu contextual. A regra vive num lugar só, no resolvedor de `player` — a versão anterior a tinha na governança, e era a razão de o ramo `isSelf` do `market-stalls` (`stall.manage`) nunca ter sido alcançável.

### Números são decimais, strings são hexadecimais

`512` é 512. `"512"` é `0x512`. `"0x200"` e `"200"` são o mesmo ator.

Não é arbitrário: é o que o `parseActorId` da governança sempre fez e o que o menu manda (`formatActorId` emite `0x…`). Mudar quebraria a UI atual.

---

## 7. `requestId` e duplo clique

Uma interação com `idempotent: true` **exige** `requestId` (8 a 48 caracteres) e o pipeline deduplica por `(actorId, requestId)`:

| Situação | Resposta |
|---|---|
| Primeira chamada | Executa |
| Segunda, com a primeira ainda rodando | Recusa: *"já está sendo processada"* |
| Segunda, depois da primeira terminar | Devolve **o mesmo resultado**, sem executar (`duplicate: true`) |
| Recusa antes do `execute` | `requestId` **não é consumido** — o retry corrigido funciona |
| `execute` lançou | `requestId` liberado — o retry é o comportamento certo do cliente |

Fica em memória (TTL de 120 s), de propósito. Uma tabela daria idempotência entre reinícios do servidor, ao custo de um `INSERT` no caminho quente de toda interação, para proteger de um caso que não acontece. **A idempotência que precisa sobreviver a restart já existe uma camada abaixo**, por `idempotency_key` no `transaction-service` — e é ela que protege ouro e item. Esta protege contra duplo clique.

Hoje usam: `law.fine`, `law.arrest`, `law.confiscate`, `stall.buy`.

---

## 8. Auditoria

| Classe | Grava? | Para quê |
|---|---|---|
| `TRACE` | **Não** | Consulta e leitura — abrir vitrine, ver menu |
| `GAMEPLAY` | Sim | Muda o mundo de forma reversível (padrão) |
| `SECURITY` | Sim | Um jogador sobre outro, sem consentimento |
| `ADMIN` | Sim | Poder de staff |
| `ECONOMY` | Sim | Move ouro ou item |

O padrão é `GAMEPLAY`: quem não escolheu, grava. Silêncio é opt-in.

**Recusa não gera linha.** Um jogador clicando num botão que não pode usar não pode encher a tabela que a staff usa para arbitrar. Falha do `execute` gera, com o motivo.

Auditoria que falha **não desfaz** o que já aconteceu: grita no log e segue.

---

## 9. Rate limit

`core/ui-event-rate-limiter.js` ganhou política por tipo. O teto global continua desligado por padrão — a disciplina de medir antes de limitar não mudou.

| Variável de ambiente | Efeito |
|---|---|
| `UI_EVENT_RATE_LIMIT_MAX_EVENTS` | Teto global por `(ator, tipo)`. `0`/ausente = só mede |
| `UI_EVENT_RATE_LIMIT_WINDOW_MS` | Janela global (padrão 60 s) |
| `INTERACTION_EXECUTE_RATE_LIMIT` | Teto só de `interaction:execute` |

`query` e `execute` têm perfis opostos: a consulta acontece a cada mira (dezenas por minuto, barata, sem efeito colateral), a execução move ouro (unidades por minuto, cara, irreversível). Um teto único ou estrangula a primeira ou libera a segunda.

O limitador é **um só**, compartilhado entre o gateway e o framework: dois dariam dois orçamentos ao mesmo jogador, e a soma não apareceria em métrica nenhuma.

---

## 10. Segredos que o pipeline não conta

Coisas que parecem detalhe e não são:

- **Ação inexistente e ação indisponível dão a mesma resposta.** Distinguir transformaria o menu num oráculo de enumeração do servidor.
- **A lista devolvida ao cliente não carrega permissão, alcance nem classe de auditoria.** A resposta é a lista de ações; o raciocínio é do servidor.
- **`targetType` do pedido é ignorado no `execute`** — vem do descritor. Aceitá-lo permitiria chamar uma ação de `player` declarando o alvo como `container` e cair num resolvedor que não faz as recusas daquela ação.
- **Um `canSee` que lança vira NEGA**, não vira passa. Módulo com bug não abre o menu de ninguém.
- **Um `canSee` que devolve `undefined` vira NEGA.** Quem não decidiu não autorizou.
- **Interação com `permission` declarada e sem verificador injetado NEGA**, e grita no log.

---

## 11. Eventos

**UI → servidor**

```js
{ type: 'interaction:query',   data: { targetType: 'player', targetId: '0x200' } }
{ type: 'interaction:execute', data: { action: 'law.fine', targetId: '0x200',
                                       requestId: 'req-...', data: { amount: 150, reason: '...' } } }
```

`data` também é aceito no nível de cima (`{action, targetId, amount, reason}`), que é o formato que a CEF usa hoje.

**Servidor → UI**

```js
mp.set(actorId, 'browserModal', {
  type: 'interaction:actions',
  data: {
    target: { type: 'player', id: 'player:512', label: '0x200' },
    targetType: 'player',
    sections: [{
      id: 'guarda', label: 'guarda',
      actions: [{
        action: 'law.fine', label: 'Aplicar multa',
        requiresRequestId: true,
        fields: [{ name: 'amount', type: 'int', label: 'Valor', required: true, min: 1, max: 100000 }]
      }]
    }]
  }
});
```

Os campos do formulário **vêm do servidor**. Enquanto os dois lados declaram os mesmos campos, o dia em que o servidor apertar um limite a UI continua oferecendo o antigo, e o jogador descobre digitando.

O resultado do `execute` vai por notificação, não por modal: o resultado de uma ação é uma frase, não uma tela.

---

## 12. O que já está registrado

| Interação | Módulo | Alcance | Auditoria | Idempotente |
|---|---|---|---|---|
| `law.stop` — Abordar | governance | 450 | SECURITY | não |
| `law.search` — Revistar | governance | 350 | SECURITY | não |
| `law.records` — Ver ficha | governance | 450 | SECURITY | não |
| `law.fine` — Aplicar multa | governance | 450 | ECONOMY | **sim** |
| `law.detain` — Deter | governance | 450 | SECURITY | não |
| `law.arrest` — Prender | governance | **650** | SECURITY | **sim** |
| `law.confiscate` — Confiscar | governance | 450 | ECONOMY | **sim** |
| `law.release` — Liberar | governance | 450 | SECURITY | não |
| `stall.view` — Ver vitrine | market-stalls | `chat.localRange` | **TRACE** | não |
| `stall.buy` — Comprar item | market-stalls | `chat.localRange` | ECONOMY | **sim** |
| `identity.introduce` — Apresentar-se | identity | 450 | **TRACE** | não |

Cada `execute` chama a mesma função de domínio de sempre (`stopTarget`, `fineTarget`, `buyItem`, …), **e cada uma revalida permissão e alcance por conta própria**. A redundância é deliberada: se alguém chamar `fineTarget` por outro caminho, a checagem continua lá.

Três coisas mudaram para essas ações:

1. **Distância no `canSee`.** O menu antigo listava por permissão e nada mais, então um guarda via "Prender" no menu de alguém do outro lado do mapa. `law.arrest` usa 650 (escolta), que é o alcance que `arrestTarget` sempre exigiu internamente e que o menu antigo não refletia.
2. **Idempotência real** em multa, prisão, confisco e compra.
3. **Barraca com alcance.** A vitrine aparecia para quem estivesse na mesma célula, a qualquer distância.

---

## 13. O caminho antigo foi removido

Em 13/08/2026, na mesma frente: o legado saiu inteiro, e este é o único caminho.

**No servidor**, `governance-service.js` perdeu `getInteractionActions`,
`handleInteractionAction`, `validateUiInteractionPayload`, `isValidUiAction`,
`handleUiEvent` e `sendBrowserModal`; `market-stalls-service.js` perdeu
`getInteractionSections` e `handleInteractionAction`. `phase0-basic.js` não
registra mais o prefixo `governance` no roteador de eventos — a governança
deixou de ter UI própria. As funções de domínio (`stopTarget`, `fineTarget`,
`arrestTarget`, `buyItem`, …) ficaram **intactas**.

**Na CEF**, `skymp/ui/index.html` fala `interaction:query` / `interaction:execute`
e perdeu `ACTION_CONFIG`, `DEFAULT_INTERACTION_SECTIONS`,
`mergeInteractionSections` e `sendChatCommand`. Os campos de cada formulário
vêm do `schema` do servidor; o cliente só desenha.

Duas mudanças de comportamento vieram junto:

- **`stall.manage` saiu do menu.** Dependia de alvo `self`, que o framework não
  permite — e já era inalcançável antes, por uma recusa da governança
  (`CORE_FRAMEWORK_AUDIT.md` §6.7a). O comando de chat continua. Volta ao menu
  quando `object`/`container` ganhar resolvedor e a barraca virar alvo de verdade.
- **"Apresentar-se" virou `identity.introduce`**, uma interação de verdade,
  registrada por `commands.js`. Some do menu quando o alvo já conhece o
  personagem: apresentar-se duas vezes não é erro, mas é um botão que não faz
  nada, e um menu de RP que oferece gestos vazios ensina o jogador a ignorá-lo.

## 14. O que NÃO está feito

**Correção de 21/08/2026 (Tarefa 6): os dois itens abaixo estavam desatualizados neste documento e foram corrigidos por evidência de código, não por suposição.**

- ~~A CEF ainda não usa `interaction:*`~~ **— falso desde algum momento entre 13/08 e 21/08.** `skymp/ui/index.html` já fala `interaction:query`/`interaction:execute` de verdade para alvo `player` (`openInteractionMenu`, `sendUiEvent('interaction:query', ...)`, linha ~1055). O que **continua** faltando: o gatilho que abre o menu. `mp.events.add('interaction:open', ...)` está registrado na CEF, mas **nada no repositório rastreado chama o lado nativo que dispararia esse evento** — o mesmo padrão de listener morto que o próprio código já documenta ter existido para `voip:connect` ("um listener que nunca funcionou de verdade — nada no servidor jamais dava `mp.trigger` nele", `index.html` linha ~1278). Sem esse gatilho, o menu de interação nunca abre por ação do jogador, para NENHUM tipo de alvo — não é um problema específico de objeto/pickup, é anterior e maior.
- **Cinco dos sete tipos de alvo não têm resolvedor** (era "seis" — `object` ganhou o dele na Tarefa 5, `world_object.pickup` em `cell-persistence-service.js`). Por escolha (§6) pros outros cinco.
- **`stall.manage` não tem lugar no menu** — depende de alvo `self`, que o framework não permite. O comando de chat continua sendo o caminho. `object` já tem resolvedor (linha acima), mas é dono de `cell-persistence-service`, não de `market-stalls-service` — a barraca ainda precisaria do próprio resolvedor ou de um tipo dedicado pra virar alvo de verdade.
- **Nada disto rodou numa sessão real.** 96+ testes verdes e zero jogadores — nem mesmo o caminho `player` que já fala o protocolo certo.

**Próximo passo concreto para fechar o gatilho** (não feito nesta revisão — risco real de regressão num fluxo que hoje funciona, sem cliente pra testar contra): estender o snippet de crosshair (`CROSSHAIR_SNIPPET_DO_CLIENTE`, `cell-persistence-service.js`) com detecção de tecla (`ctx.sp.on('keyDown', ...)` — mesma classe de API documentada-mas-nunca-exercitada que `getCurrentCrosshairRef`) que chama `ctx.sp.browser.executeJavaScript` direto pra uma nova função `window.openInteractionMenuFromCrosshair(payload)` na CEF — **não** via `mp.events.add('interaction:open', ...)`, que está comprovadamente morto. Exige também tornar `INTERACTION_TARGET_TYPE` (hoje constante fixa `'player'` em `index.html`) dinâmico por chamada.
