# Runbook de operação

Como subir, conferir e diagnosticar o servidor. Escrito para quem opera, não para quem desenvolve — assume que o código está certo e pergunta se o **ambiente** está.

> **Estado:** o servidor nunca rodou uma sessão real com jogadores. Este runbook cobre o que é verificável hoje e marca explicitamente o que só será exercitado quando alguém entrar. Ver [QA_REPORT_2026-08.md](QA_REPORT_2026-08.md).

---

## 1. Antes de subir

```powershell
.\scripts\phase0\Start-AllServices.ps1
```

O script confere, **antes** de despachar qualquer processo:

| Verificação | O que significa falhar |
|---|---|
| Arquivo de entrada existe | Caminho errado ou repositório incompleto |
| `.env` presente onde é exigido | O serviço morreria no `require('dotenv')` numa janela separada, e a orquestração reportaria sucesso |
| `node_modules` presente | Idem — foi assim que o painel web ficou fora do ar sem ninguém notar |
| `apps/game-api/mods.json` existe | `/mods.json` responde 503 e **nenhum jogador passa da verificação de paridade** |
| Banco alinhado com as migrations | Ver §2 — a falha mais cara de diagnosticar do projeto |

Se ele reclamar, resolva o que ele apontou. Ele não mente por otimismo: prefere avisar que um serviço não vai subir a dizer "concluída" com um processo morto.

---

## 2. Banco desalinhado — o problema silencioso

```bash
cd skymp/gamemode
npm run check:schema
```

As migrations `v2`–`v9` são aplicadas **à mão**, em ordem. Nada garantia que foram todas aplicadas até este check existir.

**Por que isso é pior do que parece:** um banco meio-migrado não quebra o boot. O servidor sobe, o login passa, e só a query que toca a coluna faltante falha — às vezes semanas depois, numa cena, com ouro no meio. O sintoma clássico: alguém aplicou até a `v6`, o `game-api` tenta gravar em `game_sessions` (v8), e a admissão na fila falha com erro de SQL cru — que o jogador vê como "servidor offline".

O que o comando reporta:

| Saída | Causa | O que fazer |
|---|---|---|
| `[FALTA] tabela ...` | Migration não aplicada | Aplique as pendentes, em ordem |
| `[FALTA] coluna ...` | Migration aplicada pela metade | Idem — são idempotentes (`IF NOT EXISTS`), rodar de novo é seguro |
| `[FALTA] indice ...` | Provavelmente a `v7` | Nada quebra sem ela; fica lento sob carga, que é quando ninguém está olhando o schema |
| `[AVISO] tabela extra` | Alguém criou tabela à mão | Não bloqueia. Investigue: é assim que um schema se separa em dois sem ninguém perceber |

Sem banco à mão, `npm run check:schema:list` imprime só o que as migrations declaram — é o que o CI roda.

---

## 3. Quem pode o quê

```bash
cd skymp/gamemode
npm test           # inclui permissions.behavior.test.js
```

A autoridade de staff vem **exclusivamente** da tabela `staff_roles`. O campo `vip_level` em `accounts` é só monetização e **nunca** deve ser usado como critério administrativo.

O mapa cargo→permissão vive em **[`skymp/gamemode/core/permissions.js`](../../skymp/gamemode/core/permissions.js)** — um lugar só, consultado pelo gamemode, pelo painel web e (via `POST /internal/authorize`) pelo bot do Discord. O inventário completo de rota × capability × cargo mínimo está em [`AUTHORIZATION_MATRIX.md`](../admin/AUTHORIZATION_MATRIX.md).

Duas coisas que mudam a operação do dia a dia:

- **Cargo fora do catálogo nega tudo, dos dois lados, e grita no log.** Inserir `role='support'` em `staff_roles` não cria um cargo — cria uma conta que não consegue fazer nada, em jogo nem no painel. Os cargos são `moderator`, `admin` e `owner`.
- **Conta não-`active` não entra no painel**, mesmo tendo linha em `staff_roles`.

A matriz vigente está em [`permissions.behavior.test.js`](../../skymp/gamemode/permissions.behavior.test.js) e em [`core/permissions.test.js`](../../skymp/gamemode/core/permissions.test.js) — o teste é o registro. Resumo dos comandos:

| Ação | Permission | moderator | admin | owner |
|---|---|---|---|---|
| `/tp` | `players.teleport` | ✅ | ✅ | ✅ |
| `/anim` | `players.animate` | ✅ | ✅ | ✅ |
| `/kick` | `players.kick` | ✅ | ✅ | ✅ |
| `/calar`, `/vozdiag`, … | `voice.mute` | ✅ | ✅ | ✅ |
| `/additem` | `inventory.grant` | ❌ | ✅ | ✅ |
| `/setgold` | `economy.adjust` | ❌ | ✅ | ✅ |
| `/permakill` | `characters.retire` | ❌ | ✅ | ✅ |
| `/revelaridentidade` | `identity.reveal` | ❌ | ✅ | ✅ |
| `/censofauna`, `/sondacadaver` | `world.probe` | ❌ | ✅ | ✅ |

**Todo comando de staff atravessa o pipeline comum** ([`core/admin-action.js`](../../skymp/gamemode/core/admin-action.js), documentado em [`ADMIN_ACTION_PIPELINE.md`](../admin/ADMIN_ACTION_PIPELINE.md)): sessão, permissão, validação, alvo, estado, serviço de domínio, desfecho, auditoria. Três consequências operacionais:

- **`/kick`, `/setgold` e `/revelaridentidade` passaram a exigir motivo.** Antes o `/kick` caía para `'Sem motivo'` e os outros dois não pediam nada. A mensagem de uso diz o que falta.
- **Os cinco comandos de voz passaram a existir.** `/calar`, `/descalar`, `/vozdiag`, `/vozdesconectar` e `/vozreconectar` estavam implementados, com permissão e auditoria, e sem registro nenhum — digitá-los respondia "Comando desconhecido".
- **Toda negação e toda falha viram linha em `audit_logs`**, com a etapa em que pararam. Para ver o que foi barrado:

```sql
SELECT * FROM audit_events WHERE outcome = 'denied' ORDER BY id DESC;
```

**A auditoria mudou de tabela.** `audit_logs` recebia treze escritores que não gravavam a mesma coisa — inclusive `rp_chat:*`, uma linha por FALA de cada jogador —, e a aba Audit Log do painel afogava em conversa de taverna com o servidor cheio. A ação administrativa passou a viver em **`audit_events`**, com colunas indexadas e busca em onze eixos; `audit_logs` continua existindo, intacta, como o fluxo de evento de jogo. Ver [`AUDIT_LOG.md`](../admin/AUDIT_LOG.md).

A migration é a **v17** e é segura: não altera, não apaga e não move nada — ela COPIA para a tabela nova o que é auditoria, e é reexecutável. Depois de aplicar, confira:

```sql
SELECT
  (SELECT COUNT(*) FROM audit_logs
    WHERE action LIKE 'admin:%' OR action LIKE 'authz:%' OR action LIKE 'staff:%'
       OR action LIKE 'whitelist:%' OR action LIKE 'governance:%'
       OR action = 'identity:staff_reveal')  AS origem,
  (SELECT COUNT(*) FROM audit_events
    WHERE legacy_audit_log_id IS NOT NULL)   AS copiadas;
```

Os nomes antigos (`kick`, `set_gold`, …) continuam funcionando: são traduzidos por `LEGACY_ALIASES`. A exceção é `ban`, que era concedida a `admin`/`owner` e nunca foi verificada em lugar nenhum — ela virou uma capability **reservada** e agora nega explicitamente, com motivo no log, em vez de descrever um poder inexistente.

`/permakill` nunca chega ao moderador de propósito: morte permanente é revisão de staff sênior, não decisão de linha de frente.

**`/setgold` deixa rastro na economia, não só no `audit_logs`.** Ele passa pelo `core/transaction-service`, então toda alteração vira linha em `gold_transactions` com `reason='staff_setgold'`. Para auditar o que a staff moveu:

```sql
SELECT * FROM gold_transactions WHERE reason = 'staff_setgold' ORDER BY id DESC;
```

Até 06/08/2026 o comando fazia `UPDATE characters SET gold = ?` direto: o `audit_logs` registrava a intenção, mas o saldo deixava de fechar com a soma do ledger e não havia como distinguir ouro concedido pela staff de ouro duplicado por bug.

**Se um comando novo entrar sem cobertura na matriz, o teste falha.** É deliberado — comando de staff sem ninguém verificando quem pode usar nasce como porta aberta.

---

## 4. Depuração

| Ferramenta | Como |
|---|---|
| **DevTools da UI in-game** | Abra `localhost:9000` no Chrome normal. Console, inspetor e breakpoints da interface CEF. Sem isso a UI é depurada às cegas. |
| **Live reload da UI** | Suba um dev server na porta 1234; o SkyMP faz proxy das requisições de UI para ele. Itera CSS/JS sem reiniciar nada. |
| **Snapshot antes de teste destrutivo** | `databaseDriver: "zip"` guarda o mundo num arquivo só. |

---

## 5. Portas

| Porta | Serviço | Exposta? |
|---|---|---|
| 7777/UDP | Servidor SkyMP | Sim |
| 7758 | `apps/game-api` | Sim |
| 3001 | `apps/web` (painel) | Sim |
| 3000/HTTPS | UI do navegador embutido — **não configurável** | Não |
| 3002 | `apps/bot-discord` | **Não** — firewall |
| 7778 | VOIP | Sim, se o VOIP estiver ligado |
| 9000 | DevTools do Chromium | **Não** — só local |
| 1234 | Dev server da UI | **Não** — só local |

⚠️ **A porta da UI é `porta principal + 1` quando a principal é não-padrão.** Padronizar o servidor em 7757 jogaria a UI para 7758 e colidiria com o `game-api`. Por isso o padrão é 7777.

---

## 6. Segredos

Gere **aleatórios e distintos por ambiente**: `SESSION_SECRET`, `INTERNAL_API_SECRET`, `MASTER_KEY`.

Nunca commite `.env` — o `.gitignore` cobre e o CI verifica. Nunca coloque segredo em variável `VITE_*`: elas são **embutidas no instalador** distribuído aos jogadores.

Em produção, `offlineMode: false`. Sempre. Com `offlineMode: true` o cliente declara a própria identidade e o servidor acredita — não há autenticação nenhuma.

---

## 7. Quando algo dá errado em jogo

1. **`audit_logs`** é a primeira parada. Toda ação de staff, toda transação e o contexto de morte passam por lá.
2. **`gold_transactions`** tem o ledger com motivo e módulo de origem de cada movimento. Ouro que "sumiu" está aqui, ou não passou pelo `transaction-service` — que é o bug de verdade.
3. **Nunca `DELETE` em personagem.** `status='retired'` é o caminho; o histórico precisa sobreviver.

---

## 8. O que este runbook ainda não cobre

Honestidade sobre o limite, no mesmo espírito do relatório de QA:

- **Restauração de backup.** Não há procedimento de backup verificado. Antes de qualquer restauração oficial, teste em ambiente separado.
- **Carga.** Nenhuma medição com múltiplos jogadores. O polling de 2s do `death-service`/`player-panel`/`voip` é onde o problema tende a aparecer primeiro.
- **Incidente com jogadores online.** Não há procedimento porque nunca houve jogadores online.
