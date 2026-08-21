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

A matriz vigente está em [`permissions.behavior.test.js`](../../skymp/gamemode/permissions.behavior.test.js) — o teste é o registro. Resumo:

| Ação | moderator | admin | owner |
|---|---|---|---|
| `/anim`, `/tp` | ✅ | ✅ | ✅ |
| `/kick` | ✅ | ✅ | ✅ |
| `/additem` | ❌ | ✅ | ✅ |
| `/setgold` | ❌ | ✅ | ✅ |
| `/permakill` | ❌ | ✅ | ✅ |

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

### 6.1 `MASTER_KEY` viaja na URL — AUTH-04a

O contrato do Master API não é nosso: `GET /api/servers/:masterKey/sessions/:session` é o formato que o binário do SkyMP chama nativamente (`skymp5-server/ts/systems/login.ts`, a partir da string `master` em `server-settings.json`). Não dá pra tirar a `masterKey` da URL sem modificar o SkyMP compilado, o que a política do projeto proíbe.

**Auditado em `apps/web/server.js`: não há vazamento na aplicação.** Não existe `morgan` nem qualquer middleware de log de acesso — o serviço nunca escreve a URL completa em log próprio. A comparação usa `safeEquals` (tempo constante) e a resposta é 404 uniforme tanto pra `masterKey` errada quanto pra sessão desconhecida, então nem timing nem status code confirmam a chave certa pra quem está adivinhando.

**O risco real está fora deste repositório: no proxy reverso.** Nginx, ALB, Cloudflare e qualquer log de acesso HTTP padrão registram a URL completa por padrão, `masterKey` incluída.

Antes de colocar `apps/web` atrás de um proxy reverso em produção:

1. **Redija o path nos logs de acesso.** Nginx: substitua `$request_uri` por uma versão mascarada no `log_format`, ou use `map` pra apagar o segmento `/api/servers/<masterKey>/`. Confirme que provedores de CDN/WAF (Cloudflare, etc.) também mascaram — muitos guardam o path completo em log de borda por padrão, fora do seu controle direto.
2. **Rotação da `MASTER_KEY` é a mitigação de fundo**, porque o vazamento em log de infraestrutura nunca é 100% descartável. Procedimento:
   - gere um valor novo com `openssl rand -hex 32` (ou equivalente);
   - atualize `MASTER_KEY` no `.env` de `apps/web` e o `masterKey` correspondente em `skymp/config/server-settings.<env>.json` — **os dois precisam mudar juntos**, e nessa ordem: primeiro o painel, depois o servidor de jogo, porque um servidor com a chave antiga simplesmente recebe 404 até ser reiniciado com a nova;
   - reinicie `apps/web` antes do servidor de jogo, nunca depois — a janela entre os dois é curta (o pool de conexões do servidor de jogo já teria a chave antiga em memória até o próximo restart dele) e não afeta jogadores conectados, só a próxima resolução de sessão;
   - não há downtime de jogadores já conectados: a `masterKey` só é usada na resolução da `game_session` (login/reconnect), não durante a sessão de jogo em si.
3. **Rotação de rotina, não só em resposta a incidente.** Sem cadência definida ainda — decisão de operação pendente; o mínimo é rotacionar toda vez que alguém que teve acesso ao `.env` de produção deixar de precisar dele.

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
