# Contratos

**Um jogador publica trabalho, outro aceita, o servidor move os septims e mantém
o registro.** Sem NPC, sem fila de staff, sem arbitragem automática.

- Código: [`contracts-service.js`](../../skymp/gamemode/contracts-service.js)
- Economia: [`ECONOMY_FRAMEWORK.md`](../framework/ECONOMY_FRAMEWORK.md)
- Schema: [migration v15](../../skymp/packages/database/migration-v15-economy-framework.sql)
- Origem do conceito: Mereth Roleplay — **sem licença e sem código público**.
  Reimplementação a partir da ideia publicada, não port
  ([pesquisa](../research/SKYMP_ECOSYSTEM_DEEP_DIVE.md) §4).

> ✅ **ATIVO (lab), reativado em 20/08/2026.** Registrado em
> `core/module-registry.js` como módulo `contracts`
> (`ENABLE_CONTRACTS_SERVICE`, nasce desligado como todo `lab`). Ganhou os
> oito comandos de chat que faltavam (`/contratocriar`, `/contratoaceitar`,
> `/contratoentregar`, `/contratocontestar`, `/contratoacertar`,
> `/contratocancelar`, `/contratolistar`, `/contratoinfo`) e a varredura
> periódica de 5 min que chama `sweepExpired`/`sweepReviewed` — antes dessa
> data existiam funções puras sem nenhuma camada de `actorId`→`characterId` e
> sem nada chamando a varredura. Subiu no boot local sem erro; **ainda nunca
> foi visto num servidor com gente dentro.**

---

## 1. Para o jogador

Você quer alguém para escoltar uma caravana até Riften. Publica o contrato com a
recompensa. **O ouro sai do seu bolso na hora.**

Alguém aceita. Faz o trabalho. Declara entrega. Você confirma, e o ouro vai para
ele. Se você sumir, o contrato se acerta sozinho depois de dois dias.

Se você achar que o trabalho não foi feito, você **contesta** — e aí ninguém
recebe até um humano resolver. O servidor não decide quem tem razão.

Se ninguém aceitar até o prazo, seu ouro volta.

---

## 2. Os sete estados

```
              ┌──────────► cancelled   criador desiste enquanto aberto
              │                        escrow devolvido
  open ───────┼──────────► expired     prazo venceu
    │         │                        escrow devolvido
    ▼         │
  accepted ───┘──────────► expired     prazo venceu
    │                                  escrow devolvido
    ▼
  delivered ────────────► settled      escrow → trabalhador
    │
    └──────────────────► disputed      escrow FICA travado
```

| Estado | Quem chega nele | O que acontece com o ouro |
|---|---|---|
| `open` | criador publica | travado no escrow |
| `accepted` | trabalhador aceita | continua travado |
| `delivered` | trabalhador declara entrega | continua travado; abre janela de 48h |
| `settled` | criador confirma, ou a varredura depois de 48h | vai para o trabalhador |
| `cancelled` | criador desiste **enquanto `open`** | volta para o criador |
| `expired` | varredura, com prazo vencido em `open` ou `accepted` | volta para o criador |
| `disputed` | criador contesta a entrega | **fica travado** |

Toda transição vira uma linha em `contract_events`, com quem agiu e quando. A
tabela é append-only: um contrato não tem "estado corrigido", tem histórico.

---

## 3. As três regras que não se negociam

### 3.1 Escrow trava no post, não na entrega

`open` só existe com o ouro já fora do bolso do criador. O financiamento e a
criação acontecem na **mesma transação**, e o escrow vem primeiro.

Se o criador não tem o valor, o resultado é **nenhum contrato** — nunca um
contrato publicado que ninguém pode pagar. É a mesma filosofia fail-closed do
`server-options`: quando algo quebra, você fica sem a coisa, não com uma versão
quebrada dela.

> A justificativa do Mereth, que é boa o bastante para citar: o servidor pega o
> dinheiro *antes* da promessa.

### 3.2 Expiração nunca toca trabalho entregue

`delivered` e `disputed` estão fora da varredura. Sem isso, o exploit é óbvio:
receba o trabalho, deixe o relógio correr, recupere o ouro.

A defesa é uma **lista de estados** (`EXPIRABLE`), não um comentário, e há um
teste cujo nome é a regra. Acrescentar `delivered` àquela lista reprova o teste.

### 3.3 `disputed` não decide nada

Contestar **não** devolve o ouro ao criador e **não** paga o trabalhador. O
escrow fica travado, e resolver é papel de gente.

Isso é deliberado e vem da [Constituição](../CONSTITUICAO.md) e do briefing §11:
consequência irreversível não se automatiza. Um servidor que decide sozinho
"quem tem razão" numa disputa de trabalho está errando de um dos dois lados em
metade dos casos, em silêncio.

---

## 4. Quem pode o quê

| Ação | Quem | De onde | Para onde |
|---|---|---|---|
| criar | qualquer um com o ouro | — | `open` |
| aceitar | **qualquer um menos o criador** | `open` | `accepted` |
| entregar | só quem aceitou | `accepted` | `delivered` |
| acertar | criador, ou varredura após 48h | `delivered` | `settled` |
| contestar | só o criador | `delivered` | `disputed` |
| cancelar | só o criador | `open` | `cancelled` |
| expirar | só a varredura | `open` ou `accepted` | `expired` |

Duas ausências que são decisões:

**O criador não pode aceitar o próprio contrato.** Sem essa regra, contrato vira
uma forma de mover ouro para si mesmo com carimbo de legitimidade — que é
exatamente o que uma lavagem procura.

**O criador não pode cancelar depois de alguém aceitar.** O trabalhador já se
comprometeu; cancelar unilateralmente o deixaria com trabalho feito e sem
recurso. Um contrato aceito que dá errado sai por `expired` (o prazo) ou por
acordo entre os dois, fora do sistema.

---

## 5. Categorias

`mercenary` · `caravan` · `delivery` · `bodyguard` · `crafting` · `mining` ·
`harvest` · `hunt` · `arcane` · `investigation` · `generic`

Uma categoria fora da lista é recusada — ela vira filtro de listagem e rótulo de
RP, e valor livre transforma a listagem em lixo.

### O framework não verifica o trabalho, e isso é honesto

Entrega de **item** é contável pelo servidor (é o que o
[inventory framework](../framework/INVENTORY_FRAMEWORK.md) faz). "Matou o
bandido", "escoltou a caravana até Riften" e "descobriu quem roubou o cofre" não
são. Para essas, quem confirma é o criador, e a janela de revisão de 48h existe
justamente porque a confirmação é humana e humanos somem.

Fingir o contrário — inventar uma verificação automática de escolta — seria
prometer uma onisciência que o servidor não tem, e o resultado seria pior que a
confirmação manual: um trabalho legítimo recusado por um detector que errou.

Acrescentar uma categoria é **só editar a lista**. Se algum dia uma categoria
ganhar verificação automática, ela entra como uma checagem opcional antes da
transição `accepted → delivered`, não como um estado novo.

---

## 6. A janela de revisão

`delivered` grava `review_until = agora + 48h`.

- O criador pode acertar a qualquer momento, sem esperar.
- Passadas as 48h sem disputa, `sweepReviewed()` acerta sozinho.
- Contestar antes disso trava tudo em `disputed`.

Sem o acerto automático, um criador que abandona o servidor deixa o trabalhador
com o ouro travado para sempre. Com ele, quem some perde o direito de contestar
— o que é a escolha certa, porque o ouro já não era dele desde a publicação.

---

## 7. As varreduras

Duas, e cada uma processa **uma transação por contrato**:

| Varredura | O que faz | Chave de idempotência |
|---|---|---|
| `sweepExpired()` | `open`/`accepted` com prazo vencido → `expired` | `sweep-expire-${id}` |
| `sweepReviewed()` | `delivered` com janela vencida → `settled` | `sweep-settle-${id}` |

Uma transação por contrato, e não uma para todos, porque uma linha problemática
não pode transformar a varredura inteira em nenhuma expiração processada.

A chave deriva do contrato, então rodar a varredura duas vezes no mesmo minuto
não expira duas vezes nem devolve o escrow duas vezes.

**Desde 20/08/2026, `contracts-service.initContractsService()` agenda as
duas** (`setInterval` de 5 min, chamado pelo `initialize` do módulo
`contracts` em `phase0-basic.js`) — mesmo padrão de
`market-stalls-service._expirationTimer`.

---

## 8. O que aconteceu com `defaulted`

O Mereth tem um estado `defaulted` para "o criador não consegue pagar". **Com
escrow no post, esse estado não pode existir**: o ouro já saiu do bolso do
criador antes de o contrato aparecer para qualquer um.

Isso é uma consequência real da escolha da [ADR 004](../technical/ADR_004_ECONOMY_ACCOUNTS_AND_LEDGER.md#27-escrow-é-uma-conta-não-um-campo-no-contrato),
e vale registrar: escolher escrow em vez de dívida **elimina uma classe inteira
de estado** em troca de exigir o ouro adiantado.

Dívida continua existindo no servidor — só não nasce de contrato. Ela nasce de
multa e das outras origens do [sistema de dívida](DEBT_SYSTEM.md).

---

## 9. O que não existe ainda

1. **Interface.** Não há comando de chat nem painel. O serviço tem API; a UI é
   trabalho separado, e depende do
   [interaction framework](../framework/INTERACTION_FRAMEWORK.md).
2. **Resolução de disputa.** `disputed` é terminal para o automático. Não há
   ferramenta de staff para liberar o escrow de uma disputa — hoje seria
   `economy.closeEscrow` chamado à mão.
3. **Contrato com item como recompensa.** Só septim. Escrow de item exigiria a
   mesma estrutura no lado do inventário.
4. **Reputação.** Ninguém acumula histórico de "entregou 12, calotou 2". Os
   dados existem em `contract_events`; nada os lê.
5. **Contrato de facção.** `creator_character_id` é sempre um personagem. Uma
   guilda publicando com ouro do tesouro é possível na economia (`faction` é
   titular válido) e não está no serviço.
6. **Marcos parciais.** Um escrow, uma liberação. Pagar 30% agora e 70% na
   entrega exigiria `economy_escrow.balance` movimentado por partes — está
   registrado como sinal de revisão na ADR 004 §6.

---

## 10. Segurança

Cobertos por teste (ver [matriz](../testing/ECONOMY_SECURITY_MATRIX.md)):
criação sem saldo, aceite do próprio contrato, roubo de contrato já aceito,
entrega por quem não aceitou, auto-pagamento do trabalhador, acerto duplo,
replay de acerto, cancelamento após aceite, expiração de trabalho entregue,
expiração antes da hora, disputa por quem não é o criador, e falha de
infraestrutura no meio da criação.

Não coberto, e honesto sobre isso: **concorrência real**. Os testes rodam contra
um MySQL simulado, sequencialmente. Os `SELECT ... FOR UPDATE` estão lá e a
lógica os assume, mas duas pessoas aceitando o mesmo contrato no mesmo
milissegundo nunca foi observado — só raciocinado.
