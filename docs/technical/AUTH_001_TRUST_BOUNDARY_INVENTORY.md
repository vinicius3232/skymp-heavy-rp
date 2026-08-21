# AUTH-001 — Inventário de trust boundaries

Data: 2026-08-12. Fonte: código local, não apenas documentação.

## Cadeia real atual

```text
Discord OAuth code
  -> apps/web troca o code no Discord
  -> accountId + discordId
  -> launch_tickets (hash, uso único, 5 min)
  -> apps/game-api consome launch ticket
  -> poll ticket rotativo da fila
  -> game_sessions (hash, reutilizável para reconnect)
  -> launcher grava config.session = ticket:<game-session>
  -> SkyMP com offlineMode=false consulta Master API
  -> Master API retorna user.id = accountId
  -> engine publica profileId = accountId
  -> connection-monitor resolve actorId -> profileId
  -> whitelist resolve account -> approved character
  -> commands cacheia actorId -> accountId/characterId/staff
```

## Identificadores e autoridade

| Dado | Emissor atual | Transporte/persistência | Validador | Consumidor | Autoridade | Risco |
|---|---|---|---|---|---|---|
| Discord OAuth `code` | Discord | launcher -> web HTTPS esperado | Discord token endpoint + redirect allowlist | web | Discord | MEDIUM: interceptação/replay depende de OAuth/PKCE e TLS |
| `discordId` | Discord API | web DB; launcher auth file | web após OAuth | UI/crash metadata | web/Discord | MEDIUM: launcher também possui cópia não autoritativa |
| `accountId` | MariaDB | server-side e Master API response | FK/query server-side | game session/profile | MariaDB | GOOD |
| launch ticket | web CSPRNG | claro só no launcher; hash DB | game-api, TTL + consumed_at | fila | web/game-api | GOOD, se consumo é atômico |
| poll ticket | game-api | memória do main process | game-api, rotacionado | join/status | game-api | MEDIUM: perde estado no restart; nomes ambíguos |
| game session | game-api CSPRNG | claro no launcher/config; hash em MariaDB | Master API, expiry/revoked | SkyMP login/reconnect | web/MariaDB | GOOD/PARTIAL: reutilizável por design, sem bind de personagem/audience explícito |
| `masterKey` | operação | server settings + request path | comparação no web | Master API | operação | HIGH se vazado em logs/URL/proxy |
| `profileId` online | Master API `user.id` | engine runtime | SkyMP quando `offlineMode=false` | connection monitor/whitelist | accountId server-side | GOOD condicionado à config |
| `profileId` client-side | launcher deriva `discordId.slice(-8)` | `skymp5-client-settings.txt` | nenhum no launcher | SkyMP somente offline mode | CLIENT | **CRITICAL se produção usar offlineMode=true** |
| `userId` | SkyMP runtime | memória | engine | connection monitor/kick | engine session slot | EPHEMERAL; reutilizável |
| `actorId` | SkyMP runtime | memória/mp props | engine + monitor | todos os services | engine session actor | EPHEMERAL; limpar no disconnect |
| `characterId` | MariaDB | query por account; cache actor | whitelist | gameplay services | MariaDB | PARTIAL: escolha implícita do approved mais recente |
| staff role | `staff_roles` MariaDB | cache por actorId | admin service | commands/governance | MariaDB | GOOD se cleanup sempre ocorrer |
| VIP | `accounts.vip_level` | DB | services | monetização | MariaDB | não concede staff por design |

## Trust boundaries por componente

### Launcher

Confiável apenas para apresentação e armazenamento temporário. O usuário controla binário, renderer, arquivos e argumentos IPC.

- Pode apresentar OAuth code e tickets, mas não provar identidade sozinho.
- `launch-game` recebe `ticket` pelo IPC; o main process escreve `config.session`.
- Também escreve `gameData.profileId` derivado do Discord: dado não confiável e redundante.
- `discordId`, username e crash metadata enviados pelo launcher não podem autorizar nada.

### Web/Master API

É trust boundary de autenticação junto com MariaDB.

- Troca OAuth code mantendo client secret no servidor.
- Emite launch ticket CSPRNG e guarda apenas SHA-256.
- Resolve game session ativa e retorna `accountId` como `user.id`.
- `masterKey` no path é segredo operacional; deve ser redigido e futuramente substituído/complementado por autenticação que não apareça em URL.

### Game API/fila

Transforma launch ticket em admissão e game session. É autoridade temporária de capacidade, não de personagem ou staff.

- Launch ticket precisa ser consumido numa operação atômica no MariaDB.
- Estado de fila/admission atualmente reside em memória; restart muda a disponibilidade, mas não deve mudar identidade.
- Game session deve ser emitida somente após consumo válido e nunca aceitar accountId do cliente.

### SkyMP/gamemode

- Em online mode, profileId vem da resposta do Master API e representa accountId.
- `connection-monitor` procura actor por profileId via polling e evita que uma promise antiga aprove/rejeite uma reconexão nova.
- `whitelist.checkWhitelist` normaliza o `profileId` online para `accountId` e consulta `accounts.id`. `discord_id` continua sendo somente a identidade externa de login.
- Depois da resolução, gameplay deve usar `commands.getActiveCharacterData(actorId)`, nunca characterId/profileId enviado em UI packet.

## Security blockers

### SECURITY-BLOCKER AUTH-01 — profileId redundante controlado pelo cliente. RESOLVIDO em 21/08/2026 (junto de AUTH-003)

`apps/launcher/electron/main.ts` gravava `gameData.profileId` derivado dos últimos oito dígitos do Discord. Passou a fazer `delete clientSettings.gameData.profileId` — o fluxo online nunca precisou desse valor (a engine resolve contra a Master API), e ele só existia como risco residual caso `offlineMode` regredisse para `true` em produção.

**Evidência:** `skymp/gamemode/core/auth-boundary.test.js` — teste invertido de "documenta o profileId legado" para "AUTH-01 fechado: launcher não escreve mais profileId legado", com `assert.doesNotMatch`.

CI/config doctor continuar reprovando `offlineMode=true` fora de ambiente local segue valendo como defesa em profundidade — este fechamento remove a superfície, não substitui aquele gate.

### SECURITY-BLOCKER AUTH-02 — semântica divergente de profileId (**RESOLVIDO em 2026-08-12**)

O Master API retorna `accountId` e a whitelist agora consulta `accounts.id`. Account ID e Discord ID permanecem namespaces separados.

**Evidência:** online `profileId === accountId`; `whitelist.test.js` cobre a consulta por `accounts.id`. Discord ID é atributo, não chave de gameplay.

### SECURITY-BLOCKER AUTH-03 — personagem não vinculado à sessão. RESOLVIDO em 21/08/2026 (AUTH-003)

`apps/game-api` resolve e grava `character_id` em `game_sessions` no momento do `/api/queue/join` — junto com o consumo do `launch_grant`, não depois da promoção da fila (`resolveApprovedCharacter`, `migration-v19-game-session-character-bind.sql`). `whitelist.js` passou a ler o personagem vinculado via `game_sessions JOIN characters`, não mais `ORDER BY id DESC LIMIT 1`.

Até CHR-002 existir, cardinalidade de um `approved` por conta continua sendo o que torna o bind automático seguro: `resolveApprovedCharacter` recusa (não adivinha) se encontrar mais de um. Sessões emitidas antes desta migration ficam sem bind e caem num fallback que reproduz o comportamento antigo, com aviso em log — rede de segurança de migração, não uma segunda forma permanente de escolher personagem; expira sozinha pelo TTL da sessão.

**Evidência:** `apps/game-api/queue.test.js` (bind sobrevive à espera e à promoção), `skymp/gamemode/whitelist.test.js` (bind vence o fallback), `apps/web/server.test.js` (`characterId` na resposta do Master API).

### SECURITY-BLOCKER AUTH-04 — segredo em URL

URLs aparecem com facilidade em access logs, traces e proxies. Duas ocorrências desta classe foram identificadas.

**AUTH-04a — `masterKey` no path do Master API. RESOLVIDO em 21/08/2026 — via runbook, não via mudança de contrato.**

Não dá pra tirar a `masterKey` da URL: `GET /api/servers/:masterKey/sessions/:session` é o formato que o binário do SkyMP chama nativamente, não escolha nossa — mudar exigiria modificar o SkyMP compilado, proibido pela política do projeto. Auditoria confirmou que `apps/web/server.js` não tem middleware de log de acesso (`morgan` ou equivalente) e nunca escreve a URL completa em log próprio — o vazamento possível é inteiramente de infraestrutura (proxy reverso/CDN), fora deste repositório.

**Evidência:** nenhuma ocorrência de log de request/URL completa em `apps/web/server.js`; comparação por `safeEquals` (tempo constante); 404 uniforme para `masterKey` errada e sessão desconhecida (não diferencia os dois casos pra quem está adivinhando).

**Fechamento:** runbook de redação de log de proxy + rotação de `MASTER_KEY` em [`OPERATIONS.md` §6.1](OPERATIONS.md#61-master_key-viaja-na-url--auth-04a). Rotação de rotina (cadência) segue como decisão de operação pendente, não bloqueia o fechamento do blocker de código.

**AUTH-04b — ticket de fila na query string. RESOLVIDO em 2026-08-13.**

`GET /api/queue/status?ticket=…` lia a credencial de `req.query.ticket`, enquanto `POST /api/queue/join`, catorze linhas acima, sempre leu do corpo. Dois tratamentos do mesmo segredo no mesmo arquivo.

Encontrado ao verificar se estávamos expostos ao problema que o `SensitiveArgumentMasker` do Crows RP revela — **não estávamos** por aquele caminho (o launcher não passa credencial por argumento de linha de comando; o ticket vai para `clientSettings.gameData.launcherTicket`, em arquivo), mas a verificação achou esta outra porta. Ver [`ECOSYSTEM_DEEP_DIVE`](../research/SKYMP_ECOSYSTEM_DEEP_DIVE.md) §10.

Impacto real era menor que o da AUTH-04a: o transporte já é HTTP puro, e o `queue_grant` rotaciona e é de uso único — um ticket que aparecesse num log provavelmente já estaria consumido. O que justificou corrigir foi o custo (não há launcher em produção, porque a Fase 0 nunca rodou) e a inconsistência, que convidava o próximo endpoint a copiar o lado errado.

Correção: a rota virou `POST /api/queue/status` lendo `(req.body || {}).ticket`; `req.query` é ignorado. `poll-queue` no launcher passou a usar `postJsonToUrl`, igual ao `join-queue`.

**Regressão travada por teste.** `apps/game-api/server.http.test.js` — primeiro teste em nível HTTP deste serviço, criado junto. Exige 404 no `GET /api/queue/status` e 401 quando o ticket vem só pela query. Verificado por mutação: revertendo `app.post` para `app.get`, nove testes falham.

## Caracterizações que viram testes/gates

1. Master API retorna `accountId` e nunca aceita ID do cliente.
2. Sessão revogada/expirada/desconhecida retorna 404.
3. Banco guarda somente hashes de launch/game tickets.
4. Resposta obsoleta de whitelist não toca uma reconexão.
5. Configuração staging/production deve ter `offlineMode=false`.
6. Launcher online deve remover profileId legado antes da Fase AUTH-003. **Feito em 21/08/2026.**
7. Staff role é resolvido por accountId server-side e removido no disconnect.
8. Nenhuma credencial viaja em query string ou path — coberto para a fila por `server.http.test.js` (AUTH-04b); o `masterKey` (AUTH-04a) segue descoberto.

## Decisão para AUTH-002

Não criar um único token para todas as funções. Manter três capabilities:

- `launch_grant`: uso único, OAuth -> fila;
- `queue_grant`: rotativo, somente polling/admissão;
- `game_session`: reconnect permitido, somente Master API/SkyMP.

O contrato v1 formaliza nomes, audience e lifecycle. Character bind será opcional no schema v1 e obrigatório quando CHR-002 for ativado.
