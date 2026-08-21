# RBAC administrativo

**Status:** parcialmente implementado (15/08/2026). O catálogo capability-based, os
cargos, o `requirePermission` do painel e as quatro negações **existem e são testados** —
ver [`AUTHORIZATION_MATRIX.md`](AUTHORIZATION_MATRIX.md) para o que roda. O que este
documento descreve e ainda **não** existe: o mapa cargo→permissão em TABELA (hoje é
`skymp/gamemode/core/permissions.js`), overrides por pessoa, cargo temporário e os seis
cargos (hoje são três).
**Decisão formal:** [ADR 005](../technical/ADR_005_ADMIN_RBAC.md)
**Evidência:** [`ADMIN_PLATFORM_AUDIT.md`](../research/ADMIN_PLATFORM_AUDIT.md) §4.1–§4.6
**Regra que não muda:** `vip_level` é monetização. Nunca foi e nunca será critério de permissão.

---

## 1. As quatro regras

1. **Permissão é a unidade. Cargo é um agrupamento.** Todo código pergunta por
   permissão, nunca por cargo. Não existe `if (role === 'admin')` em lugar nenhum.
2. **O banco é a autoridade.** O mapa cargo→permissão vive em tabela, não em
   constante de arquivo. Mudar quem pode o quê é uma linha auditada, não um deploy.
3. **Negar é o padrão, e negar é barulhento.** Ausência de permissão nega;
   permissão desconhecida nega **e** grita no log; toda negação vira linha de
   auditoria.
4. **Sem herança implícita.** `owner` não "herda" de `admin`. Cada cargo tem seu
   conjunto explícito, ainda que isso duplique linhas. O motivo está na §4.

---

## 2. Catálogo de permissões

Namespace pontuado `dominio.acao[.escopo]`. O domínio é o módulo do painel; a
ação é o verbo; o escopo aparece só quando um verbo tem recortes de risco
diferentes (`logs.view` vs `logs.view.security`).

**Risco** governa a UI ([§22 do briefing](ADMIN_PLATFORM.md#7-risco-e-ui)):
🟢 leitura · 🟡 muta estado recuperável · 🔴 irreversível ou de alto impacto.

### 2.1 Jogadores e sessões

| Permissão | Risco | O que autoriza | Existe hoje? |
|---|---|---|---|
| `players.view` | 🟢 | listar contas, ver perfil, histórico de sessões | painel: sem gate |
| `players.session.view` | 🟢 | ver quem está conectado agora | **bloqueada** — §4.8 da auditoria |
| `players.kick` | 🟡 | expulsar da sessão atual | jogo: `kick` ✅ · painel: ❌ |
| `players.warn` | 🟡 | registrar advertência formal | ❌ não existe |
| `players.mute` | 🟡 | silenciar chat/voz | ❌ não existe em jogo |
| `players.ban` | 🔴 | banir conta (temp ou permanente) | permissão declarada, **nada implementa** |
| `players.unban` | 🔴 | revogar ban | ❌ |
| `players.teleport` | 🟡 | teleportar até um jogador | jogo: `teleport` ✅ |

### 2.2 Personagens

| Permissão | Risco | O que autoriza | Existe hoje? |
|---|---|---|---|
| `characters.view` | 🟢 | ficha, biografia, histórico | painel: sem gate |
| `characters.edit` | 🟡 | corrigir campos de ficha | ❌ |
| `characters.rename` | 🟡 | renomear (com registro do nome anterior) | ❌ |
| `characters.notes` | 🟡 | anotações de staff no personagem | ❌ |
| `characters.retire` | 🔴 | aposentar (`status='retired'`) | jogo: `retire_character` ✅ |
| `characters.permakill` | 🔴 | morte permanente | mesmo comando acima |
| `characters.restore` | 🔴 | reverter aposentadoria | ❌ — ver §5 do MODERATION_WORKFLOW |
| `identity.reveal` | 🔴 | revelar nome real por trás do anonimato | jogo: `reveal_identity` ✅ |

`characters.retire` e `characters.permakill` são a mesma operação hoje
(`/permakill` grava `status='retired'`). Ficam separadas no catálogo porque o
`MODERATION_WORKFLOW` §5 distingue aposentadoria administrativa de CK narrativo,
e a distinção precisa de nome antes de precisar de código.

### 2.3 Economia e inventário

| Permissão | Risco | O que autoriza | Existe hoje? |
|---|---|---|---|
| `economy.view` | 🟢 | saldos, tesouros, ranking | painel: sem gate |
| `economy.ledger.search` | 🟢 | buscar em `gold_transactions` | ❌ |
| `economy.adjust` | 🔴 | mover ouro de um personagem | jogo: `set_gold` ✅ |
| `economy.freeze` | 🔴 | congelar conta suspeita | ❌ |
| `inventory.view` | 🟢 | ver inventário e `inventory_transactions` | ❌ |
| `inventory.trace` | 🟢 | rastrear um item pelo ledger | ❌ |
| `inventory.grant` | 🔴 | entregar item | jogo: `add_item` ✅ |
| `inventory.remove` | 🔴 | remover item | ❌ |

**Invariante herdada, não negociável:** ajuste de ouro passa por
`core/transaction-service`; entrega e remoção de item passam por
`transaction-service.giveItem`/`removeItem`. Nenhuma rota do painel escreve em
`characters.gold` ou `character_inventory` direto. É a regra que apagou o
`economy-service.js` antigo (`CONTRIBUTING.md` §3.1) e ela vale igual quando o
chamador é a UI.

### 2.4 Whitelist, staff e mundo

| Permissão | Risco | O que autoriza | Existe hoje? |
|---|---|---|---|
| `whitelist.view` | 🟢 | ler a fila de aplicações | painel: sem gate |
| `whitelist.review` | 🟡 | mover entre estados, escrever parecer | painel: **sem gate** |
| `whitelist.approve` | 🟡 | aprovar (libera entrada no servidor) | painel: **sem gate** |
| `staff.view` | 🟢 | ver equipe e cargos | ❌ |
| `staff.manage` | 🔴 | conceder/revogar cargo e permissão | jogo: `manage_staff` ✅ |
| `factions.view` / `factions.manage` | 🟢 / 🟡 | facções | view sem gate · manage ❌ |
| `world.probe` | 🟡 | censo de fauna e sonda de cadáver | jogo: `run_world_probe` ✅ |
| `crafting.recipes.manage` | 🔴 | criar/editar receita (regra permanente) | jogo: `manage_recipes` ✅ |

### 2.5 Servidor, módulos e logs

| Permissão | Risco | O que autoriza | Existe hoje? |
|---|---|---|---|
| `server.view` | 🟢 | health, fila, versão, manifesto | `/health` é público hoje |
| `server.announce` | 🟡 | anúncio global | ❌ |
| `server.maintenance` | 🔴 | modo manutenção / fechar entrada | ❌ |
| `server.restart` | 🔴 | reiniciar processo | **não deve existir até a §14 do ADMIN_PLATFORM** |
| `modules.view` | 🟢 | estado dos módulos do registry | ❌ |
| `modules.toggle` | 🔴 | ligar/desligar módulo | ❌ — hoje é `ENABLE_*` no `.env` + restart |
| `logs.view` | 🟢 | auditoria administrativa | jogo: `view_audit` (declarada, **nada verifica**) |
| `logs.view.security` | 🔴 | eventos sensíveis: revelação de identidade, mudança de cargo, negações | ❌ |

`logs.view.security` é escopo separado por um motivo concreto: até 15/08/2026 o
`audit_logs` misturava `identity:staff_reveal` com `staff:teleport` na mesma
pilha, sem nada que os separasse numa consulta. Hoje `audit_events` tem
`severity` — e revelação de identidade é `critical` enquanto teleporte é `info`
—, então o escopo deixou de depender de uma coluna que não existia; o argumento
abaixo, porém, continua de pé. Quem pode ver movimentação
rotineira não deveria ver, de graça, a lista de quem foi desmascarado — o
`admin-service.js` gastou trinta linhas argumentando que revelar identidade é a
única ação de staff sem volta, e deixar o **rastro** dela aberto a todo cargo
esvaziaria metade daquele cuidado.

### 2.6 Mapa de renome (as 12 permissões que já existem)

O gamemode usa nomes planos. A migração é mecânica e **falha fechada**:
`hasPermission` já recusa nome desconhecido com `console.error`, então uma
chamada esquecida nega a ação e aparece no log — o comportamento mais seguro
possível para um renome.

| Nome atual | Nome novo | Chamadores a atualizar |
|---|---|---|
| `kick` | `players.kick` | `admin-service.js` |
| `teleport` | `players.teleport` | `admin-service.js` (×2) |
| `ban` | `players.ban` | nenhum — **órfã** |
| `add_item` | `inventory.grant` | `admin-service.js` |
| `set_gold` | `economy.adjust` | `admin-service.js`, `economy-regional.js` |
| `retire_character` | `characters.permakill` | `admin-service.js` |
| `reveal_identity` | `identity.reveal` | `admin-service.js` |
| `run_world_probe` | `world.probe` | `fauna-census.js` (×2), `corpse-probe.js` |
| `manage_recipes` | `crafting.recipes.manage` | `crafting-service.js` (×2) |
| `manage_staff` | `staff.manage` | `governance-service.js`, `market-stalls-service.js` (×2) |
| `view_audit` | `logs.view` | nenhum — **órfã** |
| `manage_whitelist` | `whitelist.review` | nenhum — **órfã** |

As três órfãs não são renomeadas: são **decididas**. `players.ban` e
`whitelist.review` ganham implementação (painel); `logs.view` idem. Nenhuma
permissão pode existir no catálogo sem pelo menos um verificador — e isso vira
teste (`ADMIN_SECURITY_MATRIX` §3.1).

---

## 3. Cargos

Cargo é rótulo operacional e agrupamento de permissões. **Nada no código lê o
nome do cargo para decidir.**

| Cargo | Para quem | Domínios que alcança |
|---|---|---|
| `SUPERADMIN` | dono do servidor | tudo, incluindo `staff.manage` e `server.*` |
| `ADMIN` | administração | tudo exceto `staff.manage`, `server.restart`, `modules.toggle` |
| `MODERATOR` | linha de frente | `players.*` até `kick`/`warn`/`mute`, `whitelist.*`, `logs.view`, leituras |
| `SUPPORT` | atendimento | leituras + `characters.notes` + `whitelist.review`. **Nenhuma ação em jogo** |
| `GAMEMASTER` | eventos e RP | `players.teleport`, `inventory.grant`, `world.probe`, leituras |
| `DEVELOPER` | quem constrói | `modules.view`, `logs.view`, `server.view`, leituras. **Nada de jogador** |

Duas escolhas que valem o argumento:

**`GAMEMASTER` recebe `inventory.grant` e não recebe `economy.adjust`.** Entregar
uma espada para um evento é reversível e visível; mover ouro mexe no razão que a
economia inteira usa para fechar. São riscos diferentes e o cargo que roda evento
precisa do primeiro, não do segundo.

**`DEVELOPER` não toca em jogador.** É o cargo mais fácil de conceder e o que mais
gente vai ter. Dar-lhe `players.kick` porque "é útil para testar" transformaria a
permissão mais concedida na mais poderosa — que é exatamente o argumento que o
`admin-service.js` usou para manter `reveal_identity` fora do moderador.

A matriz completa cargo × permissão vive na migration de seed e é reproduzida em
[`ADMIN_SECURITY_MATRIX.md`](../testing/ADMIN_SECURITY_MATRIX.md) §2, que é onde
ela é **testada**. Duplicá-la aqui criaria uma segunda resposta para a mesma
pergunta.

---

## 4. Por que não há herança

O desenho óbvio seria `SUPERADMIN > ADMIN > MODERATOR > SUPPORT` com herança.
Foi recusado:

1. **A pergunta que importa é "quem pode `economy.adjust`?"** Com conjuntos
   explícitos é um `SELECT`. Com herança é uma travessia de árvore que precisa
   estar certa em todo lugar que a faz — painel, gamemode, teste e a cabeça de
   quem audita.
2. **Os cargos deste projeto não formam uma linha.** `GAMEMASTER` pode
   `inventory.grant`, que `MODERATOR` não pode; `MODERATOR` pode `players.kick`,
   que `GAMEMASTER` não precisa. Já são um reticulado, não uma escada — forçar
   escada obrigaria a inventar exceções, e exceção em herança é o defeito clássico.
3. **O custo é duplicação de linha em uma tabela de seed.** Barato, visível, e
   um `CHECK` de integridade cobre o resto.

O briefing §21 pede teste de "role inheritance". O teste correspondente aqui é o
**oposto**: verificar que nenhum cargo ganha permissão que não está escrita para
ele, mesmo que outro cargo "acima" a tenha. Está em `ADMIN_SECURITY_MATRIX` §2.2.

---

## 5. Modelo de dados

### 5.1 O que muda

```sql
-- CATÁLOGO — a lista fechada de permissões que existem.
CREATE TABLE staff_permission_catalog (
  permission   VARCHAR(64) PRIMARY KEY,
  risk         ENUM('read','mutate','destructive') NOT NULL,
  description  VARCHAR(256) NOT NULL
);

-- CARGOS — a lista fechada de cargos.
CREATE TABLE staff_role_definitions (
  role         VARCHAR(32) PRIMARY KEY,
  label        VARCHAR(64) NOT NULL,
  is_system    TINYINT(1) NOT NULL DEFAULT 1   -- cargo de sistema não é editável pela UI
);

-- MAPA cargo → permissão. É a fonte de verdade que hoje é ROLE_PERMISSIONS.
CREATE TABLE staff_role_permissions (
  role        VARCHAR(32) NOT NULL,
  permission  VARCHAR(64) NOT NULL,
  PRIMARY KEY (role, permission),
  CONSTRAINT fk_srp_role FOREIGN KEY (role) REFERENCES staff_role_definitions (role) ON DELETE CASCADE,
  CONSTRAINT fk_srp_perm FOREIGN KEY (permission) REFERENCES staff_permission_catalog (permission)
);

-- OVERRIDE por pessoa. Existe para o caso raro, e é sempre temporário por padrão.
CREATE TABLE staff_permission_overrides (
  id                    INT AUTO_INCREMENT PRIMARY KEY,
  account_id            INT NOT NULL,
  permission            VARCHAR(64) NOT NULL,
  mode                  ENUM('grant','deny') NOT NULL,
  reason                VARCHAR(256) NOT NULL,           -- obrigatório
  granted_by_account_id INT NOT NULL,
  granted_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at            TIMESTAMP NULL DEFAULT NULL,
  revoked_at            TIMESTAMP NULL DEFAULT NULL,
  UNIQUE KEY uq_override (account_id, permission, revoked_at),
  CONSTRAINT fk_spo_account FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE,
  CONSTRAINT fk_spo_perm    FOREIGN KEY (permission) REFERENCES staff_permission_catalog (permission)
);
```

`staff_roles` é alterada, não substituída — é a tabela que os dois leitores já
consultam:

```sql
ALTER TABLE staff_roles
  ADD COLUMN expires_at            TIMESTAMP NULL DEFAULT NULL,
  ADD COLUMN revoked_at            TIMESTAMP NULL DEFAULT NULL,
  ADD COLUMN revoked_by_account_id INT NULL DEFAULT NULL,
  ADD COLUMN revoke_reason         VARCHAR(256) NULL DEFAULT NULL,
  ADD CONSTRAINT fk_staff_role_def FOREIGN KEY (role) REFERENCES staff_role_definitions (role);
-- e, SOMENTE depois que os dois leitores agregarem múltiplas linhas:
--   DROP INDEX account_id;   -- o UNIQUE que impede cargo temporário simultâneo
--   ADD KEY idx_staff_account_active (account_id, revoked_at, expires_at);
```

Revogar cargo passa a ser `revoked_at = NOW()` com motivo, **nunca `DELETE`** —
mesma regra que `CONTRIBUTING.md` §3.7 já impõe a personagem, pelo mesmo motivo:
o histórico de quem teve qual poder e quando precisa sobreviver à revogação.

`staff_permissions` (a tabela vazia de hoje, cuja FK aponta para a *linha* de uma
pessoa e não para o cargo) é **descontinuada** pela migration. Ver
[ADR 005](../technical/ADR_005_ADMIN_RBAC.md) §3.

### 5.2 Resolução efetiva

```
permissões(conta) =
      ∪ { staff_role_permissions[r] : r ∈ cargos ativos da conta }
    ∪   { p : override(conta, p, 'grant') ativo }
    ∖   { p : override(conta, p, 'deny')  ativo }
```

Cargo ativo = `revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())`.
**`deny` sempre vence.** Um override de negação é a forma de suspender alguém de
uma capacidade sem tirar o cargo inteiro — e ele não pode ser contornado somando
outro cargo.

### 5.3 Ordem de migração, porque a ordem importa

`SELECT role FROM staff_roles WHERE account_id = ? LIMIT 1` existe hoje em dois
lugares. Soltar o `UNIQUE` antes de trocar essas duas leituras faria a segunda
linha de cargo ser silenciosamente ignorada — a pessoa recebe metade do poder que
foi concedido e ninguém vê erro.

1. Criar as tabelas novas e semear cargo→permissão a partir do `ROLE_PERMISSIONS` atual.
2. Trocar os dois leitores para agregar **todas** as linhas ativas.
3. Só então soltar o `UNIQUE(account_id)`.

---

## 6. Contrato do middleware (painel)

```js
// apps/web — substitui requireStaff em TODAS as rotas de staff
requirePermission('whitelist.approve')
```

Obrigações, todas verificáveis por teste:

1. Sessão ausente → `401`. Sem permissão → `403`. **Nunca `404`** para esconder
   existência de rota: staff é população conhecida e 404 confunde diagnóstico.
2. A resposta de negação não diz qual permissão faltou nem quais a conta tem.
   O motivo detalhado vai para a auditoria, não para o corpo HTTP.
3. Verifica também `accounts.status = 'active'` da própria staff (fecha §4.10 da
   auditoria): conta banida perde o painel junto com o jogo.
4. Permissão fora do catálogo → `500` **no boot da rota**, não em runtime. Uma
   rota registrada com permissão inexistente é bug de programação e deve impedir
   o servidor de subir, não negar silenciosamente em produção.
5. ~~Toda negação grava `audit_logs`~~ ✅ **feito em 15/08/2026, em `audit_events`:**
   toda negação grava com `outcome='denied'`, `severity` elevada, a permissão
   pedida e o `correlationId`. O sinal de sondagem passou a existir e é uma
   consulta de um filtro (`?outcome=denied`), não uma leitura de texto livre.
6. Cache de permissões por sessão com TTL curto (≤ 60 s) **e** invalidação
   imediata em qualquer escrita de `staff_roles`/overrides. Revogação que demora
   um TTL para valer é aceitável para concessão; para revogação, não.

No gamemode, `admin-service.hasPermission(actorId, permission)` mantém a
assinatura — muda só a origem do `Set`: passa a vir do banco no login, com a
mesma resolução da §5.2. O `staffCache` continua sendo por `actorId` e continua
sendo limpo na desconexão (`admin-service.test.js` já cobre isso).

**Se o banco estiver indisponível no login, o resultado é conjunto vazio.** Staff
sem poder é um problema pequeno; staff com poder herdado de um cache que ninguém
consegue invalidar é um incidente.

---

## 7. Discord

O Discord **sugere**; o banco **decide**. Concretamente:

| Direção | Permitido? |
|---|---|
| Painel aprova whitelist → bot adiciona cargo no Discord | ✅ existe hoje (`/api/sync-role`) |
| Cargo do Discord → cargo de staff no banco | ⚠️ só como **proposta**, nunca aplicação automática |
| Cargo do Discord → permissão em jogo | ❌ **nunca** |

O caminho de sugestão, se for construído, produz uma linha em uma fila de
revisão que um `SUPERADMIN` confirma com motivo. Nada em `staff_roles` nasce de
um webhook.

Três razões: quem administra o servidor do Discord não é necessariamente quem
administra o jogo; cargo do Discord é editável por qualquer um com
`MANAGE_ROLES` lá, uma superfície que este projeto não controla; e um outage do
Discord não pode alterar quem pode banir no jogo.

**Pendência real, registrada:** `apps/bot-discord/voiceChannels.js` usa
`STAFF_ROLE_ID` do Discord para autorizar `/voz-criar` e `/voz-fechar`. É o único
lugar onde o Discord é autoridade sobre uma ação. O impacto é baixo (canal de voz
temporário, nenhum efeito em jogo ou em dado persistente) e a alternativa —
consultar `staff_roles` a cada slash command — acopla o bot ao banco, que hoje ele
não toca. Fica **aceito e documentado**, não corrigido, com um gatilho para
reabrir: se um slash command passar a ter efeito em jogo ou em dado persistente,
ele migra para `requirePermission` via painel antes de existir.
