# Registro: os cinco fluxos e a auditoria

**Data:** 2026-08-15 · **Estado:** implementado, com migration segura e busca em onze eixos.
**Taxonomia e construtor:** [`skymp/gamemode/core/audit-event.js`](../../skymp/gamemode/core/audit-event.js)
**Migration:** [`migration-v17-audit-events.sql`](../../skymp/packages/database/migration-v17-audit-events.sql)
**Busca:** [`apps/web/audit-search.js`](../../apps/web/audit-search.js)

Antecedentes: [pipeline de ações](ADMIN_ACTION_PIPELINE.md) ·
[matriz de autorização](AUTHORIZATION_MATRIX.md) · [estado da plataforma](SKYADMIN_CURRENT_STATE.md)

---

## 1. A tabela atual, medida antes de qualquer escrita

`audit_logs` tem **seis colunas** — `id`, `action`, `actor_account_id`,
`target_account_id`, `details TEXT`, `created_at` — e três índices
(`created_at`, `action+created_at`, `target_account_id+created_at`).

**Treze sítios de escrita** gravam nela, e eles não são a mesma coisa:

| Grava | É, de fato | Volume |
|---|---|---|
| `admin:*` (pipeline) | AUDIT | por ação de staff |
| `staff:*` (handlers do `admin-service`) | AUDIT — e **duplica** o de cima | por ação de staff |
| `governance:*` | AUDIT (autoridade IC) | por ação de guarda |
| `authz:denied` / `authz:granted` | SECURITY | por requisição barrada |
| `identity:staff_reveal` | AUDIT | raro |
| `identity:introduce` / `:alias` | GAMEPLAY | por apresentação |
| `rp_chat:*` | GAMEPLAY | **uma linha por fala** |
| `combat:episode` / `:initiate` | GAMEPLAY | por episódio |
| `death:killer` / `:context` / `:permadeath` | GAMEPLAY | por morte |
| `soul:resolve` | GAMEPLAY | por rolagem |
| `interaction:*` | GAMEPLAY | por uso de menu |

E `details` carrega **três formatos ao mesmo tempo**: texto livre
(`role=admin reason=x`), JSON puro (`combat:*`, `death:*`, `soul:*`,
`rp_chat:*`) e o `chave=valor` do pipeline.

### 1.1 Por que isso é um problema mensurável

`GET /api/audit` fazia `ORDER BY created_at DESC LIMIT 200`. `rp_chat:*` grava
uma linha **por fala de cada jogador**. Com o servidor cheio, as 200 linhas mais
recentes são conversa de taverna, e a última ação de staff sai da tela em
minutos.

A aba "Audit Log" deixa de responder a pergunta para a qual existe — **sem nada
quebrar, sem nenhum erro, sem ninguém perceber**.

Nenhum índice conserta: o filtro que separaria os dois é justamente o que a
tabela não tem. `action LIKE 'staff:%'` não usa `idx_audit_action_created` como
igualdade, e não existe coluna de categoria.

---

## 2. Os cinco fluxos, e onde cada um passa a viver

| Fluxo | Onde vive | No banco? | Por quê |
|---|---|:-:|---|
| **APPLICATION LOG** | `console.*` dos quatro processos | ❌ | Log de aplicação em MySQL é custo de escrita por linha de diagnóstico numa tabela que ninguém consulta com `WHERE`. O que falta ali é nível, correlação e destino — isso é infraestrutura de log, não uma tabela. |
| **AUDIT LOG** | `audit_events` | ✅ | Alteração importante e ação administrativa, com colunas de verdade. |
| **SECURITY EVENT** | `audit_events`, `category='security'` | ✅ | Mesma forma exata — ator, alvo, desfecho, severidade. Tabela separada obrigaria todo caso a fazer `UNION`: "quem tentou e quem conseguiu" é uma pergunta só. |
| **GAMEPLAY EVENT** | `audit_logs` (o fluxo legado) | ✅ | Fica onde está. Mover volume alto exige decidir retenção e particionamento, e isso é uma rodada própria. O que muda hoje é que ele para de afogar a auditoria — porque a auditoria saiu de lá. |
| **METRIC** | memória, `core/voice/voice-metrics.js` | ❌ | Métrica em tabela relacional é a forma mais cara de guardar número que envelhece em minutos. `renderPrometheus()` continua esperando quem o sirva. |

A separação é declarada como **dado** em `STREAMS`, não só como prosa, e há
teste que reprova quem mandar evento para o fluxo errado.

---

## 3. `AuditEvent`

```js
AuditEvent {
  eventId, correlationId, timestamp, sessionId,
  staffAccountId, staffCharacterId,
  targetAccountId, targetCharacterId,
  category, action, severity,
  before, after, reason, metadata,
  source, outcome, permission
}
```

`permission` foi acrescentado à lista pedida: "quem usou `identity.reveal`?" é
uma pergunta de segurança, e dentro de `metadata` ela viraria varredura de
tabela.

### 3.1 O que é coluna e o que é JSON

**A regra: campo que aparece em `WHERE` vira coluna com índice. Campo de forma
variável vira JSON.**

| Coluna | Por quê |
|---|---|
| `staff_account_id`, `staff_character_id`, `target_account_id`, `target_character_id` | a pergunta mais frequente de qualquer investigação |
| `category`, `action`, `severity`, `outcome`, `source`, `permission` | os cinco eixos de classificação |
| `session_id`, `correlation_id` | rastreio entre processos |
| `occurred_at` | toda consulta de auditoria é ordenada no tempo |
| `reason` | `VARCHAR(512)` — texto livre **com teto** |

| JSON | Por quê |
|---|---|
| `before_state`, `after_state` | cada ação guarda coisa diferente; uma coluna por chave seria uma tabela que muda a cada ação nova |
| `metadata` | parâmetros da ação, etapa, rota — variável por origem |

Guardar tudo em JSON teria sido mais rápido de escrever e teria repetido o
defeito de `details`: buscar por staff, período ou severidade viraria varredura
de tabela com extração de JSON por linha.

**`before` e `after` não podem ser os nomes das colunas** — `BEFORE` é palavra
reservada no MySQL (gatilhos). O sufixo `_state` é o preço disso.

### 3.2 Duas decisões de tipo que valem a explicação

- **`DATETIME(3)` e não `TIMESTAMP`.** `TIMESTAMP` é convertido entre fusos na
  leitura e na escrita conforme o `time_zone` da **sessão**. Quatro processos e
  um cliente MySQL com fuso diferente produziriam uma linha do tempo que não
  fecha — que é a única coisa que uma auditoria precisa fazer. Os
  milissegundos existem porque duas ações no mesmo segundo precisam ter ordem
  definida numa arbitragem.
- **Sem `FOREIGN KEY`.** `ON DELETE CASCADE` num registro de auditoria significa
  que apagar uma conta apaga a prova do que ela fez; `SET NULL` apaga contra
  quem. O projeto já decidiu que personagem nunca é apagado
  (`status='retired'`), mas a auditoria não pode depender dessa disciplina para
  sobreviver.

### 3.3 Severidade

Quatro níveis: `info`, `notice`, `warning`, `critical`.

**`critical` é só o irreversível**, e a lista é curta de propósito — se metade
das ações fosse crítica, o filtro por severidade não responderia nada. Há teste
que reprova a lista acima de seis:

`identity.reveal` · `characters.retire` · `players.ban` · `staff.manage`

**O desfecho eleva e nunca rebaixa.** Um `identity.reveal` **negado** é mais
interessante que um executado: alguém tentou desmascarar um jogador sem poder
para isso.

A ordem é por gravidade, não alfabética — `critical` < `warning` como string, e
um `>=` textual devolveria o oposto do pedido.

---

## 4. A migration

**Ela não altera `audit_logs`.** Nenhum `ALTER`, nenhum `DROP`, nenhum `DELETE`,
nenhum `UPDATE` — há quatro asserções de teste sobre o texto do arquivo. Aplicá-la
não pode quebrar nada que lê a tabela antiga, porque ela não toca em nada que
existe.

**O backfill copia**, não move: as linhas cujo `action` é auditoria entram em
`audit_events` com `legacy_audit_log_id` apontando para a origem, e o `details`
original vai inteiro para `metadata.legacy_details`. Ele é texto livre em três
formatos e não dá para reparti-lo em colunas com confiança; o que dá para fazer
com honestidade é preservá-lo verbatim e dizer de onde veio.

**É reexecutável.** `INSERT IGNORE` mais `UNIQUE KEY uk_audit_legacy` no id de
origem. Isso importa porque as migrations deste projeto são aplicadas **à mão**,
e um banco meio-migrado é a falha mais cara que ele tem.

**Evento de jogo não é copiado.** Há teste que reprova se `rp_chat`, `combat`,
`death`, `soul` ou `interaction` aparecerem no `WHERE` do backfill — copiá-los
faria a tabela nova nascer com o problema da antiga.

A classificação do SQL espelha `classifyLegacyAction()` no JS, e **há teste que
compara os dois**: se divergirem, o backfill classifica uma coisa e o código
classifica outra sobre a mesma linha.

### 4.1 Conferência depois de aplicar

```sql
SELECT
  (SELECT COUNT(*) FROM audit_logs
    WHERE action LIKE 'admin:%' OR action LIKE 'authz:%' OR action LIKE 'staff:%'
       OR action LIKE 'whitelist:%' OR action LIKE 'governance:%'
       OR action = 'identity:staff_reveal')  AS origem,
  (SELECT COUNT(*) FROM audit_events
    WHERE legacy_audit_log_id IS NOT NULL)   AS copiadas;
```

---

## 5. Busca

`GET /api/audit` (exige `audit.view`, moderador+). Onze eixos, todos indexados,
todos parametrizados, combináveis.

| Eixo | Filtro |
|---|---|
| período | `from`, `to` (ISO 8601) |
| staff | `staffAccountId`, `staffCharacterId` |
| player / account | `accountId` (**os dois lados**), `targetAccountId` |
| character | `characterId` (os dois lados), `targetCharacterId` |
| action | `action` |
| category | `category` |
| severity | `severity`, `minSeverity` |
| session | `sessionId` |
| correlation ID | `correlationId` |
| target | `targetAccountId`, `targetCharacterId` |
| — | `outcome`, `source`, `permission`, `eventId`, `limit`, `before` |

```
GET /api/audit?category=security&minSeverity=warning&from=2026-08-01
GET /api/audit?accountId=42&limit=50
GET /api/audit?correlationId=c-8f2a
GET /api/audit/summary?from=2026-08-01
GET /api/audit/event/:eventId
```

**Filtro desconhecido é `400`, nunca ignorado.** Ignorar faria
`?staff_account_id=5` (nome errado) devolver a tabela inteira parecendo um
resultado filtrado — a forma mais fácil de vazar registro por engano. O mesmo
vale para valor inválido: `?severity=urgente` é erro, e não zero linhas em
silêncio, porque quem consultasse concluiria que nada aconteceu.

### 5.1 Três decisões de desempenho

- **`minSeverity` vira `IN (...)`, não `FIELD(severity, …) >= ?`.** Qualquer
  função sobre a coluna impede o uso de `idx_audit_ev_severity`. É o mesmo
  defeito que o `DATE(created_at) = CURDATE()` do dashboard já teve, e que já
  foi corrigido uma vez neste projeto pela mesma razão. Há teste que varre o
  `WHERE` gerado procurando `DATE(`, `FIELD(`, `LOWER(`, `CAST(`.
- **Paginação por cursor (`before=<id>`), nunca `OFFSET`.** `OFFSET 10000` faz o
  MySQL ler e descartar dez mil linhas; numa tabela que só cresce, a última
  página é a mais cara.
- **A listagem não devolve `before`/`after`/`metadata`.** Até 16 KB cada; 500
  linhas com os três seriam 24 MB no navegador de quem só queria ver o que
  aconteceu ontem. Eles saem só em `/api/audit/event/:eventId`. A lição vem do
  `soul-service`, que documenta ter deixado a semente do gerador fora do
  `details` **por segurança**, porque o painel devolvia o campo inteiro para
  qualquer staff.

### 5.2 O custo dos índices, dito

São nove índices secundários mais duas chaves únicas, e cada `INSERT` atualiza
todos. Aceito porque esta tabela é escrita uma vez por **ação administrativa** —
dezenas por dia, não milhares por minuto como `rp_chat` — e porque uma auditoria
que não se consulta em tempo útil não serve para arbitrar nada.

A exceção que vale nomear: `accountId` e `characterId` procuram nos dois lados e
viram `a = ? OR b = ?`, o que depende do `index_merge` do MySQL/MariaDB. Quando
o plano não colabora, o caminho rápido é o filtro específico.

---

## 6. O que ficou fora, e o custo

### 6.1 A duplicação que a rodada do pipeline introduziu

Os handlers do `admin-service` continuam gravando a própria linha `staff:*` em
`audit_logs`, **além** do evento que o pipeline grava em `audit_events`. Um
`/kick` produz duas linhas, em tabelas diferentes.

Isso é dívida declarada. Remover aquelas chamadas exige reescrever a sonda de
treze casos do `permissions.behavior.test.js`, que hoje prova "o handler negou"
olhando exatamente aquela linha — e trocar a sonda de um teste que funciona, no
mesmo commit que muda a tabela, é como se perde os dois.

**A linha do pipeline é estritamente mais rica**, então `audit_events` já é a
fonte completa para as ações roteadas; a de `audit_logs` é redundância, não
lacuna.

### 6.2 O que ainda escreve só em `audit_logs`

`governance:*` (prisão, multa, confisco), `world.probe` (censo e sonda),
`death:*`, `combat:*`, `soul:*`, `rp_chat:*`, `identity:introduce`. Os quatro
últimos são evento de jogo e é onde devem ficar. Os dois primeiros são auditoria
e migram na próxima rodada — o backfill já os classifica corretamente, então o
histórico deles já está em `audit_events`; o que falta é a escrita nova.

### 6.3 `before` / `after`

Preenchidos hoje **só** pela revisão de whitelist, que é a única ação cujo
serviço de domínio conhece o estado anterior — `resolveTarget` o leu para poder
recusar aplicação inexistente, então ele está à mão sem custo nenhum.

Para as outras, ficam `null`. Inventá-los a partir do que o comando pediu seria
gravar a intenção como se fosse o fato — e num registro de auditoria isso é pior
que a ausência.

O caso que mais os pede é `economy.adjust`: o `setGold` já calcula `anterior` e
`delta` e os escreve como texto dentro de `details`. Movê-los para `before`/`after`
é mexer num serviço de domínio que funciona, e entra pela porta dele.

---

## 7. Cobertura

| Suíte | Testes | O que trava |
|---|---|---|
| [`core/audit-event.test.js`](../../skymp/gamemode/core/audit-event.test.js) | 55 | os cinco fluxos distintos; classificação das 25 ações antigas (auditoria × segurança × jogo); `critical` só para o irreversível e a lista curta; desfecho eleva e nunca rebaixa; **`COLUMNS` e `toRow` concordam por valor-sentinela**; **toda coluna do `INSERT` existe na migration**; fail-open para banco fora e **lança** para evento malformado; a migration não altera nem apaga nada; o backfill é reexecutável e não copia evento de jogo |
| [`apps/web/audit-search.test.js`](../../apps/web/audit-search.test.js) | 34 | os onze eixos existem; valor do cliente sempre vira placeholder; filtro desconhecido é erro; valor inválido é erro e não zero linhas; **nenhuma função sobre coluna indexada**; cursor em vez de `OFFSET`; listagem sem os campos JSON |
| [`apps/web/permissions.test.js`](../../apps/web/permissions.test.js) | 93 | a matriz rota × cargo, agora com as três rotas novas; a sonda de auditoria lê **coluna** em vez de procurar substring |

A asserção de valor-sentinela da primeira linha existe porque uma divergência
entre `COLUMNS` e `toRow` grava `reason` na coluna de `source` **sem erro
nenhum** — é a classe de bug que a `migration-v15` já produziu no ledger de
ouro, quando as posições do `INSERT` mudaram.

Suítes completas: gamemode **1477/1477**, painel **127/127**, game-api 48/48,
bot 42/42, `test:systems` 13/13, typecheck limpo, `check:schema:list` 65 tabelas.
