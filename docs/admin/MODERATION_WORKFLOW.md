# Fluxo de moderação

**Status:** desenho aceito, implementação não iniciada
**Permissões:** [`RBAC.md`](RBAC.md) · **Plataforma:** [`ADMIN_PLATFORM.md`](ADMIN_PLATFORM.md)
**Rubrica de whitelist (canônica):** [`../staff/WHITELIST_RUBRIC.md`](../staff/WHITELIST_RUBRIC.md)

---

## 1. O princípio

Moderação em Heavy RP não é uma sequência de punições soltas. É um **histórico
por pessoa** que precisa responder, meses depois e para alguém que não estava
lá: *o que aconteceu, quem decidiu, com base em quê, e o que foi feito.*

Hoje o servidor responde a primeira e a terceira metade dessa pergunta. Um
`/kick` grava `audit_events` — com o motivo em coluna própria e obrigatório
desde 15/08/2026 — e manda uma linha para o Discord. Não existe nada que ligue o
kick de hoje ao warn da semana passada e ao ban de amanhã: `correlationId`
liga invocações da mesma decisão, não decisões diferentes sobre a mesma pessoa.
O histórico por jogador continua sendo consulta (`?accountId=`), não entidade.

O **caso** é a coisa que liga.

---

## 2. O caso

Um caso é a unidade de moderação. Ações vivem dentro dele.

```
Caso #142
  target      Ralof Battleborn (conta 87)
  type        metagaming
  status      resolved
  opened_by   moderator Sigrid          2026-08-10 21:14
  reason      "usou informação de Discord em cena"
  ├─ evidência  captura, link de log de chat
  ├─ ação       warn      (moderator Sigrid)   2026-08-10
  ├─ ação       kick      (moderator Sigrid)   2026-08-10
  └─ ação       tempban   (admin Bjorn, 72 h)  2026-08-11
```

| Campo | Regra |
|---|---|
| `id` | sequencial, é o número que a staff cita |
| `target_account_id` | a **conta**, não o personagem — pessoa que age é conta |
| `target_character_id` | opcional; preenchido quando o caso é sobre um personagem |
| `type` | vocabulário fechado (ver §2.1) |
| `status` | `open` · `under_review` · `resolved` · `appealed` · `overturned` |
| `reason` | obrigatório na abertura |
| `evidence` | anexos e links; opcional, mas exigido para `status='resolved'` em caso 🔴 |
| `opened_by_account_id` | quem abriu |
| `created_at` / `resolved_at` | |

**Ações** (`moderation_actions`) referenciam o caso e carregam o que a ação tem
de próprio: tipo, executor, motivo, duração, resultado, `correlationId` e o
`event_id` da linha de `audit_events` correspondente.

### 2.1 Tipos de caso

`metagaming` · `powergaming` · `rdm` (morte sem RP) · `ooc_conduct` (conduta fora
de personagem) · `exploit` · `cheating` · `harassment` · `whitelist_fraud` ·
`other`.

Vocabulário fechado, e não texto livre, porque a pergunta operacional que
justifica o campo é *"quantos casos de exploit este mês?"*. Texto livre não
responde. `other` existe e exige explicação no `reason` — e um `other` que vira
recorrente é o sinal de que falta um tipo.

### 2.2 Uma ação pode existir sem caso?

**Sim, e é o caminho normal.** Exigir abertura de caso para um kick de "volte
depois de ler as regras" transformaria moderação leve em burocracia, e a resposta
previsível seria a staff parar de registrar.

A regra é por severidade:

| Ação | Caso obrigatório? |
|---|---|
| `warn`, `kick`, `mute` | não — mas a ação é sempre registrada e **anexável** a um caso depois |
| `tempban`, `ban`, `permakill`, congelamento de conta | **sim** |

Uma ação solta pode ser puxada para dentro de um caso mais tarde, que é como o
histórico se forma na prática: três kicks soltos viram um caso quando alguém nota
o padrão.

---

## 3. Ações e o que cada uma exige

| Ação | Motivo | Prazo | Caso | Efeito | Existe? |
|---|---|---|---|---|---|
| `note` | — | — | não | anotação interna no perfil | ❌ |
| `warn` | ✅ | — | não | registro + aviso ao jogador | ❌ |
| `kick` | ✅ | — | não | encerra a sessão atual | jogo ✅ / painel ❌ |
| `mute` | ✅ | ✅ | não | silencia chat e voz | ❌ (não existe em jogo) |
| `tempban` | ✅ | ✅ | ✅ | bloqueia login até expirar | ❌ |
| `ban` | ✅ | — | ✅ | bloqueia login sem prazo | ❌ |
| `unban` | ✅ | — | ✅ | reativa a conta | ❌ |
| `permakill` | ✅ | — | ✅ | `characters.status='retired'` | jogo ✅ / painel ❌ |
| `account_freeze` | ✅ | — | ✅ | bloqueia movimentação de patrimônio | ❌ |

O `MODERATION_WORKFLOW` não inventa capacidade: as ausências acima são as mesmas
que a [auditoria §4.8](../research/ADMIN_PLATFORM_AUDIT.md) mediu. `mute` e
`freeze` não existem no jogo e **não entram no painel antes de existirem lá**.

---

## 4. Ban — o desenho, porque a metade que falta é pequena

Os dois pontos de aplicação já existem e funcionam:

```
whitelist.js:124      accounts.status !== 'active'  → kick
game-api isEligible   accounts.status !== 'active'  → 403 na fila
master API            game_sessions.revoked_at IS NULL exigido
```

O que falta é o **escritor**. Um ban é uma transação única:

```sql
BEGIN;
  INSERT INTO bans (account_id, case_id, type, reason,
                    issued_by_account_id, expires_at);      -- NULL = permanente
  UPDATE accounts SET status = 'banned' WHERE id = ?;
  UPDATE game_sessions SET revoked_at = NOW()
    WHERE account_id = ? AND revoked_at IS NULL;            -- corta a reconexão
  INSERT INTO audit_events (...);                           -- mesma transação
COMMIT;
```

Depois do commit, e fora dele: notificação ao Discord (manda-e-esquece, como o
`moderation-log` já faz) e — quando a ponte existir — o kick do jogador online.

**Três coisas que este desenho assume e que precisam ser ditas:**

1. **Revogar sessão não expulsa quem já está dentro.** O SkyMP consulta o master
   API na conexão. Até a ponte existir, ban de jogador online só vale no próximo
   login, e o painel deve dizer isso na confirmação em vez de fingir imediatismo.
2. **`tempban` precisa de alguém que expire.** `expires_at` no passado não
   reativa a conta sozinho. A expiração é uma varredura periódica que devolve
   `accounts.status='active'` — e ela mesma grava auditoria, porque uma conta que
   volta a poder entrar é uma mudança de estado como qualquer outra.
3. **`unban` é `INSERT`, nunca `DELETE`.** O ban revogado continua na tabela com
   `revoked_at`, `revoked_by` e motivo. Histórico de punição que desaparece ao ser
   revertido não é histórico — é a mesma regra do `CONTRIBUTING.md` §3.7.

---

## 5. Personagem: aposentar, matar e a pergunta do restore

Hoje `/permakill` grava `status='retired'` e o jogador precisa de nova aplicação
de whitelist. Nunca há `DELETE`. Isso está certo e não muda.

O que precisa de nome — e o catálogo do RBAC já separou — são **dois atos
diferentes que hoje usam o mesmo comando**:

| Ato | O que é | Reversível? |
|---|---|---|
| `characters.retire` | administrativo: ficha aprovada por engano, personagem duplicado, pedido do jogador | sim, por decisão |
| `characters.permakill` | narrativo: consequência de RP, morte definitiva na história | **não** |

Confundir os dois é caro nas duas direções: reverter um CK narrativo destrói a
consequência que o servidor inteiro existe para produzir; **não** reverter um
erro administrativo pune o jogador por um erro da staff.

### 5.1 `characters.restore` existe, e é a permissão mais restrita do catálogo

Ela existe porque erro administrativo acontece — o próprio repositório registra
um caso em que aprovar uma ficha nova ressuscitava um personagem que tinha levado
`/permakill`, corrigido com um `WHERE c.status='pending'`.

Regras:

1. só `SUPERADMIN`;
2. exige caso aberto e motivo;
3. **nunca** restaura personagem cujo registro diz `permakill` — restaura
   `retire`. Reverter CK narrativo não é uma operação do sistema; se um dia for
   necessário, é decisão explícita fora do painel, com o registro dizendo isso.

### 5.2 O aviso que a Constituição exige e o código ainda não dá

O Anexo A.3 da `CONSTITUICAO.md` registra em aberto: a §5 proíbe escolha
irreversível **sem aviso**, e não existe mecanismo que avise o jogador de que
está entrando em território irreversível.

Este documento não resolve isso — é gameplay, não moderação. Mas fixa a metade
que é de moderação: **a staff é avisada.** Todo diálogo de `permakill`, ban
permanente e revelação de identidade nomeia o alvo e declara, em uma frase, que
não há desfazer.

---

## 6. Whitelist

Estados, substituindo os três de hoje (`pending`, `approved`, `rejected`):

```
                 ┌──────────────────┐
   aplicação ──► │     PENDING      │
                 └────────┬─────────┘
                          │ revisor assume
                 ┌────────▼─────────┐
            ┌────┤  UNDER_REVIEW    ├────┐
            │    └────────┬─────────┘    │
            │             │              │
   ┌────────▼───┐  ┌──────▼──────┐  ┌────▼─────────┐
   │  APPROVED  │  │  REJECTED   │  │NEEDS_CHANGES │
   └────────────┘  └─────────────┘  └──────┬───────┘
                                           │ jogador reenvia
                                           └──► PENDING
```

| Estado | Significa | Quem move |
|---|---|---|
| `PENDING` | na fila, sem revisor | — |
| `UNDER_REVIEW` | alguém assumiu | `whitelist.review` |
| `NEEDS_CHANGES` | falta algo específico; parecer obrigatório | `whitelist.review` |
| `APPROVED` | libera entrada no servidor | `whitelist.approve` |
| `REJECTED` | recusada; parecer obrigatório | `whitelist.review` |

Mudanças que os estados novos obrigam:

1. **`reviewed_by` passa a ser `account_id`.** Hoje a coluna é
   `VARCHAR(128)` e **nunca é preenchida** — o `PATCH` grava `reviewer_notes` e
   `reviewed_at`, e o revisor só aparece indiretamente em `audit_logs`. Uma FK
   para `accounts` responde "quem aprovou?" com um `JOIN`, não com uma busca em
   texto.
2. **`UNDER_REVIEW` é o que impede duas pessoas revisarem a mesma ficha.** É o
   caso de concorrência real do painel: transição só vale se o estado anterior for
   o esperado, e quem perder a corrida recebe "outro revisor assumiu", não um
   `ok:true` mentiroso.
3. **`NEEDS_CHANGES` precisa de reenvio.** A regra atual bloqueia nova aplicação
   com `pending` ou `approved` ativa; `NEEDS_CHANGES` tem de deixar reenviar,
   mantendo a aplicação original ligada à nova para o histórico.
4. **`needs_extra_review` continua sendo dica, não porta.** A heurística de
   conceito forte marca a ficha para atenção — nunca reprova sozinha. Está certo
   e não muda.

---

## 7. Apelação

Uma apelação é uma **transição de caso**, não uma entidade nova:
`resolved → appealed → (overturned | resolved)`.

| Regra | Motivo |
|---|---|
| Quem executou a ação não julga a própria apelação | o conflito é óbvio e o sistema deve impedi-lo, não confiar na disciplina |
| `overturned` exige motivo e não apaga nada | a ação original continua no histórico com o desfecho registrado ao lado |
| `overturned` de ban dispara `unban`; de `retire`, permite `restore`; de `permakill`, **não dispara nada automático** | §5.1 |

Canal de entrada (Discord, formulário, ticket) fica em aberto — ver
[`ADMIN_PLATFORM.md`](ADMIN_PLATFORM.md#8-fila-de-reports--preparação-não-construção).

---

## 8. Auditoria: o que toda ação grava

Contra a lista pedida. A coluna "Depois" foi **entregue em 15/08/2026** por
`audit_events` — ver [`AUDIT_LOG.md`](AUDIT_LOG.md); a coluna "Hoje" descreve o
`audit_logs`, que continua sendo o fluxo de evento de jogo
([auditoria §4.7](../research/ADMIN_PLATFORM_AUDIT.md)):

| Campo | Hoje | Depois |
|---|---|---|
| `actor_account_id` | ✅ | ✅ |
| `action` | ✅ | ✅ |
| `target_account_id` | ✅ | ✅ + `target_character_id` |
| `permission` | ❌ | ✅ — a permissão que autorizou |
| `reason` | dentro de `details` | ✅ coluna própria |
| `before` / `after` | só `setGold`, em texto | ✅ JSON, nos campos que mudaram |
| `request_id` | ❌ | ✅ |
| `outcome` | ❌ | ✅ `allowed` · `denied` · `failed` |
| `created_at` | ✅ | ✅ |
| `case_id` | ❌ | ✅ quando houver |

**Negação é auditada.** Hoje não é: `sendDenied()` avisa o jogador e não escreve
nada; o `403` do painel não escreve nada. Sem isso, "alguém está testando
permissões que não tem" é invisível — e esse é o sinal que se quer ver antes do
incidente.

**Ninguém apaga o registro pelo painel.** Não existe rota de escrita destrutiva
sobre as tabelas de registro e não vai existir. A proteção real, porém, é de
banco: hoje um único usuário SQL serve painel, `game-api` e gamemode, com DML
completa. Fechar isso — usuário com `INSERT`/`SELECT` e sem `DELETE`/`UPDATE` —
é item do [`ADMIN_SECURITY_MATRIX`](../testing/ADMIN_SECURITY_MATRIX.md) §5, e é
a diferença entre "não há caminho" e "não é possível".

> ⚠️ **A tabela a proteger é `audit_events`, não `audit_logs`.** Desde 15/08/2026
> a auditoria administrativa e as decisões de acesso vivem em `audit_events`;
> `audit_logs` continua existindo e passou a ser o fluxo de evento de jogo (chat,
> combate, morte). Um controle que tranque só a segunda deixa a auditoria com DML
> completa — e dá a sensação de proteção sobre a tabela errada, que é pior do que
> não ter controle nenhum. Ver [`AUDIT_LOG.md`](AUDIT_LOG.md).

---

## 9. Discord

O Discord continua sendo **notificação**, nunca registro. `moderation-log` não é
aguardado, engole erro e não pode atrasar nem desfazer uma decisão já gravada.
Vale igual para caso, ban, apelação e whitelist.

O que muda: o evento passa a citar o número do caso, para que a linha no canal
seja acionável — que é a mesma razão pela qual `nomeParaLog` já inclui o
`actorId` em hexadecimal ao lado do nome.
