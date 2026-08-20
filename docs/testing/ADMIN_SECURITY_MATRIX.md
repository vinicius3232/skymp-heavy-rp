# Matriz de segurança da plataforma administrativa

**O que está travado por teste, o que está travado só por convenção, e o que não
está travado.** As três colunas existem porque misturá-las é como um projeto acha
que está seguro.

Referências: [auditoria](../research/ADMIN_PLATFORM_AUDIT.md) ·
[ADR 005](../technical/ADR_005_ADMIN_RBAC.md) · [RBAC](../admin/RBAC.md) ·
[moderação](../admin/MODERATION_WORKFLOW.md)

---

## 0. Estado em 2026-08-13, dito sem eufemismo

> **Nenhum teste desta matriz existe.** Este documento é o portão, não o
> relatório. Ele descreve o que precisa passar **antes** de qualquer pessoa da
> staff receber acesso ao painel — e nada disso passa hoje.

O que existe hoje, para não confundir os dois:

| Suíte | Estado | O que cobre de administrativo |
|---|---|---|
| `apps/web/server.test.js` | passa | 12 rotas respondem **401 sem sessão**; validação de ficha; ticket guarda hash; contrato do master API |
| `skymp/gamemode/permissions.behavior.test.js` | passa | matriz cargo × comando **do gamemode**, por comportamento real |
| `skymp/gamemode/parked-staff-permissions.test.js` | passa | comandos PARKED; nenhum nível numérico sobrou |
| `skymp/gamemode/admin-service.test.js` | passa | `hasPermission` recusa argumento inválido; cargo não sobrevive à desconexão |

E o buraco exato: **nenhum teste do painel exercita uma sessão autenticada.**
Todos param no 401. O caminho "staff logada, sem a permissão certa" — que é o
único caminho que o RBAC precisa provar — nunca foi executado.

---

## 1. As afirmações que a matriz precisa sustentar

Cada uma vira teste. Nenhuma vale como intenção.

1. Toda rota administrativa exige **uma permissão nomeada**, não a existência de
   um cargo.
2. Cargo sem a permissão **nunca** consegue o efeito, e a negação vira linha de
   auditoria.
3. Repetir a mesma requisição não duplica efeito.
4. Ação 🔴 sem motivo é recusada **no servidor**, não só na UI.
5. Ouro e item movidos pelo painel passam pelo `transaction-service` e deixam
   linha no razão.
6. Ban impede login; revogação de sessão impede reconexão; nenhum dos dois
   depende da UI ter feito a coisa certa.
7. Conta de staff banida ou com cargo expirado perde o acesso na requisição
   seguinte.

---

## 2. Matriz de autorização

### 2.1 Por rota

Cada rota administrativa recebe **três** testes, não um. O terceiro é o que
costuma faltar.

| # | Teste | Esperado |
|---|---|---|
| A | sem sessão | `401`, nenhuma query de domínio executada |
| B | sessão de staff **com** a permissão | `2xx` e efeito observável |
| C | sessão de staff **sem** a permissão | `403`, **efeito ausente**, linha de auditoria `outcome='denied'` |

O teste C verifica **ausência de efeito**, nunca só o código de status. Uma rota
que responde `403` depois de escrever no banco passa num teste de status e é
exatamente o bug que o teste existe para pegar.

O teste B verifica **efeito**, nunca só `ok:true`. O `PATCH /api/whitelist/:id`
de hoje responde `ok:true` para aplicação inexistente ([auditoria §4.12](../research/ADMIN_PLATFORM_AUDIT.md)) — a prova de que status não é evidência.

### 2.2 Por cargo × permissão

Réplica do que `permissions.behavior.test.js` já faz no gamemode, aplicada ao
painel: uma tabela `MATRIZ` no arquivo de teste, um caso gerado por célula, e uma
mensagem de falha que diz *"isso é escalação de privilégio"*.

Casos obrigatórios além da matriz:

| Caso | Esperado |
|---|---|
| Cargo **sem herança**: `MODERATOR` não recebe permissão só porque `ADMIN` a tem | negado |
| Cargo desconhecido em `staff_roles` (ex.: `'suporte'` digitado à mão) | **`403`, não acesso total** — hoje é acesso total ([auditoria §4.3](../research/ADMIN_PLATFORM_AUDIT.md)) |
| Cargo com `expires_at` no passado | negado |
| Cargo com `revoked_at` preenchido | negado |
| Duas linhas de cargo ativas na mesma conta | união das permissões, ambas contadas |
| Override `deny` sobre permissão que o cargo concede | **negado** — `deny` vence |
| Override `grant` expirado | negado |
| Conta de staff com `accounts.status='banned'` | negado em toda rota |

### 2.3 Sincronia entre os dois lados

O defeito estrutural que a auditoria encontrou é painel e gamemode lerem a mesma
tabela com regras diferentes. O teste que impede a reincidência:

| Teste | Esperado |
|---|---|
| Toda permissão de `staff_permission_catalog` tem ao menos um verificador no código | falha nomeando as órfãs |
| Toda string passada a `requirePermission()` e a `hasPermission()` existe no catálogo | falha nomeando as inventadas |
| A resolução de permissões do painel e a do gamemode, para a mesma conta, produzem o **mesmo conjunto** | falha na divergência |

O primeiro teste reprova hoje: `ban`, `view_audit` e `manage_whitelist` estão
declaradas e nenhuma linha de código as verifica.

---

## 3. Matriz de ameaças — §20 do briefing

| Ameaça | Estado hoje | O que trava depois |
|---|---|---|
| **RBAC bypass** | 🔴 não há o que burlar: o gate é binário | teste C de toda rota + §2.2 |
| **Escalação por cargo desconhecido** | 🔴 acesso total | `FK` para `staff_role_definitions` + teste |
| **SQL injection** | 🟢 tudo parametrizado (`pool.execute`) em web, game-api e bot | teste que falha se aparecer concatenação em SQL |
| **Mass assignment** | 🟡 rotas atuais desestruturam campos explicitamente | validação com rejeição de campo desconhecido |
| **IDOR** | 🟡 alvo vem do path, mas ninguém confere se o recurso existe | teste: id inexistente → `404`, nunca `ok:true` |
| **CSRF** | 🟡 `sameSite:'lax'` já bloqueia `PATCH` cross-site; sem token, sem defesa em profundidade | token + teste de rota mutável sem token → `403` |
| **XSS** | 🟡 UI monta HTML por template string; sem CSP | CSP e teste de escape em campo de ficha (biografia é texto do jogador) |
| **Session fixation** | 🔴 sessão não é regenerada no login | `req.session.regenerate()` no callback + teste de troca de id |
| **Sessão em memória** | 🔴 `MemoryStore`; toda sessão morre no deploy | store MariaDB + teste de sobrevivência a restart |
| **OAuth** | 🟢 `redirect_uri` em allowlist; secret só no servidor; ticket com hash | manter os testes existentes; avaliar PKCE (pendência do skyadmin) |
| **API interna exposta** | 🟢 `X-Internal-Secret` em tempo constante; bot escuta em `127.0.0.1` | teste existente cobre 401 sem segredo |
| **WebSocket auth** | 🟡 só o de voz existe; painel não usa WS | se a ponte usar WS: autenticar no handshake, testar rejeição |
| **Adulteração de auditoria** | 🔴 usuário SQL único com DML completa | §5 |
| **Admin API exposta** | 🟡 `GET /health` do `game-api` é público (só agregados, sem identidade) | manter agregado; teste que falha se identidade vazar |
| **Enumeração por resposta** | 🟡 `403` não diz qual permissão faltou (correto); mas `ok:true` genérico atrapalha | padronizar corpo de erro + teste |

---

## 4. Testes de comportamento — §21 do briefing

| Cenário pedido | Teste | O que verifica de verdade |
|---|---|---|
| permission denied | §2.1-C em toda rota | `403` **e** ausência de efeito **e** auditoria de negação |
| role inheritance | §2.2 | que **não** há herança: cargo só tem o que está escrito |
| expired session | sessão além do `maxAge` | `401`; e sessão persistida sobrevive a restart |
| kick unauthorized | cargo sem `players.kick` | nenhuma chamada a `mp.kick`; auditoria de negação |
| economy adjustment | ajuste pelo painel | saldo muda **e** `gold_transactions` recebe linha; sem permissão, nenhum dos dois |
| inventory grant | concessão pelo painel | `inventory_transactions` recebe linha; motivo obrigatório; `baseId` validado contra os plugins (`core/espm`) |
| audit creation | toda ação 🟡/🔴 | linha com `permission`, `reason`, `request_id`, `outcome`, e `before`/`after` quando aplicável |
| ban | ban de conta | `accounts.status='banned'` **e** `game_sessions.revoked_at` preenchido **na mesma transação**; login seguinte recusado |
| whitelist review | transição de estado | `reviewed_by` gravado; transição inválida recusada; `NEEDS_CHANGES` permite reenvio |
| concurrent staff actions | dois `PATCH` simultâneos na mesma ficha | um vence, o outro recebe conflito — **nunca dois `ok:true`** |

### 4.1 Idempotência

| Teste | Esperado |
|---|---|
| Mesmo `Idempotency-Key`, duas requisições | um efeito, duas respostas idênticas |
| Chave repetida com corpo diferente | recusa; chave não é apelido para "faça de novo" |
| Duplo clique em ban | um ban, uma linha de auditoria |

O padrão já existe no projeto: `gold_transactions.idempotency_key` com `UNIQUE`,
usada pelo ouro inicial de whitelist. O painel reutiliza a ideia, não inventa outra.

---

## 5. O que só o banco pode travar

Estes não são testáveis por unidade e por isso costumam ficar de fora — o que os
torna a parte mais frágil.

| Controle | Estado | Por que importa |
|---|---|---|
| Usuário SQL do painel sem `DELETE`/`UPDATE` em **`audit_events`** (e em `audit_logs`) | ❌ um usuário para tudo | é a diferença entre "não há rota" e "não é possível". **A tabela que importa é `audit_events`** — desde 15/08/2026 é lá que vivem a auditoria administrativa e as decisões de acesso. Trancar só `audit_logs` protege o chat e deixa a auditoria aberta |
| Usuário SQL do `game-api` restrito às tabelas que usa | ❌ | menor privilégio |
| `FK` de `staff_roles.role` para o catálogo de cargos | ❌ | fecha o cargo-fantasma da §2.2 |
| `FK` de permissão para o catálogo | ❌ | impede permissão inventada em produção |
| Backup e restauração ensaiados | ❌ | **`audit_events`** é o registro de última instância (era `audit_logs` até 15/08/2026) |

---

## 6. Mutação — a regra da casa

Quando os testes existirem, cada afirmação da §1 recebe uma mutação aplicada ao
código real e revertida depois. Um teste que passa com o bug de volta não testa
nada — e neste projeto isso já custou caro: 22 chamadas Papyrus com argumento
errado passaram meses com a suíte verde (`CONTRIBUTING.md` §6).

Mutações mínimas, uma por afirmação:

| Mutação a aplicar | Deve reprovar |
|---|---|
| `requirePermission` devolve `next()` sempre | todo teste C |
| Trocar a resolução de permissão por "tem linha em `staff_roles`" | §2.2 inteira |
| Ignorar `expires_at`/`revoked_at` na resolução | testes de cargo temporário |
| Fazer `deny` perder para `grant` | teste de override |
| Tirar a auditoria de dentro da transação do ban | teste de ban |
| Tirar `UPDATE game_sessions ... revoked_at` do ban | teste de reconexão após ban |
| Ignorar `Idempotency-Key` | §4.1 |
| Aceitar `reason` vazio no servidor | testes de ação 🔴 |

---

## 7. Portão

Nenhuma pessoa da staff além do dono recebe acesso ao painel antes de:

1. §2.1 completo — três testes por rota administrativa, sem exceção;
2. §2.2 completo, incluindo cargo desconhecido, expirado e revogado;
3. §2.3 — nenhuma permissão órfã, nenhuma permissão inventada;
4. sessão em MariaDB com regeneração no login;
5. auditoria de negação funcionando;
6. §5 linhas 1 e 3 (privilégio do usuário SQL sobre `audit_events` — a tabela
   que guarda a auditoria desde 15/08/2026 —, FK de cargo).

Os itens 1–5 são código e teste. O item 6 é operação, e é o único que não se
verifica rodando `npm test` — motivo pelo qual está escrito aqui e não só na
cabeça de quem provisiona o banco.
