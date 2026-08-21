# AUTH-002 — Contrato de credenciais opacas v1

Status: **IMPLEMENTADO em 21/08/2026 (AUTH-003).** `apps/web` (emissão de `launch_grant`), `apps/game-api` (`consumeLaunchTicket`, `pollGrants.js`, `makeSessionTicket`) e a rota Master API adotaram `skymp/gamemode/core/opaque-credential.js` como fonte única do formato — rejeição de `kind`/`audience` errado antes do banco em todo ponto de consumo. `queue_grant` saiu de `launch_tickets` (MariaDB) para `apps/game-api/pollGrants.js` (memória, decisão 1 abaixo). Ver a revisão adversarial ao final deste documento para as quatro decisões e como cada uma foi resolvida no código.

## Princípio

Tokens são strings aleatórias opacas. Claims ficam somente no servidor/MariaDB; o cliente não interpreta nem altera identidade. “Opaco” é preferível a JWT neste fluxo porque revogação, uso único e fila já dependem de estado server-side.

## Tipos

| Tipo | Audience | Emissor | Consumidor | TTL recomendado | Reuso |
|---|---|---|---|---:|---|
| `launch_grant.v1` | `game-api:queue` | web após OAuth | game-api | 5 min | uma vez |
| `queue_grant.v1` | `game-api:poll` | game-api | game-api | 2 min deslizante, teto 15 min | rotativo; anterior invalidado |
| `game_session.v1` | `skymp:master-api` | game-api | Master API/SkyMP | 8 h | reconnect permitido |

## Representação externa

```text
hrp_<tipo-curto>_v1_<base64url(32 random bytes)>
```

Prefixos: `lg`, `qg`, `gs`. O prefixo roteia e facilita redaction; não carrega identidade. Entropia mínima: 256 bits de CSPRNG. Comprimento máximo aceito: 128 caracteres. Comparação por hash server-side.

Exemplos não válidos para produção:

```text
hrp_lg_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
hrp_qg_v1_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB
hrp_gs_v1_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC
```

## Registro server-side canônico

```json
{
  "version": 1,
  "kind": "game_session",
  "tokenHash": "sha256-lowercase-hex",
  "accountId": 42,
  "characterId": null,
  "audience": "skymp:master-api",
  "nonce": "server-generated-unique-id",
  "issuedAt": "2026-08-12T02:00:00.000Z",
  "expiresAt": "2026-08-12T10:00:00.000Z",
  "consumedAt": null,
  "revokedAt": null,
  "replacedById": null,
  "keyId": null
}
```

`characterId` é `null` até CHR-002. Depois do bind, deve pertencer a `accountId` e não pode mudar na mesma sessão. `keyId` fica reservado para assinatura de requests inter-service; o token opaco em si não precisa ser assinado.

## Regras de validação

1. Rejeitar antes do DB se tipo, prefixo, versão, charset ou tamanho forem inválidos.
2. Calcular SHA-256 do token completo; nunca logar token ou hash completo.
3. Consultar por `token_hash + kind + audience`.
4. Rejeitar `revoked_at`, expiry e cadeia substituída.
5. `launch_grant` é consumido atomicamente com `UPDATE ... WHERE consumed_at IS NULL AND expires_at > NOW()`; exatamente uma linha deve mudar.
6. `queue_grant` rotaciona em transação: novo registro criado, anterior marcado consumed/replaced.
7. `game_session` pode resolver novamente; incrementar contador e registrar last-resolved sem renovar TTL automaticamente.
8. Resolver identidade exclusivamente do registro: client payload não fornece accountId, Discord ID, characterId, role ou audience.
9. Datas são avaliadas no servidor/DB em UTC. Clock do cliente é irrelevante.
10. Falha de DB é deny-by-default; não cair para profileId local.

## Reconnect e concorrência

- Duas resoluções válidas da mesma game session podem ocorrer durante reconnect; ambas apontam a mesma account/character.
- Connection monitor usa generation/session local para que a resposta antiga não altere o novo actor.
- `resolve_count` é telemetria, não autorização. Alerta de uso simultâneo exige correlação por servidor/conexão antes de revogar.
- Logout/ban revoga todas as game sessions relevantes em transação. Disconnect comum não revoga automaticamente.

## Rotação e autenticação inter-service

Os tokens opacos não dependem de signing key. A ligação web <-> game-api e SkyMP <-> Master API ainda precisa autenticação de serviço:

- curto prazo: preservar compatibilidade `masterKey`, redigir URL e limitar rede;
- alvo: header autenticado ou mTLS quando o cliente SkyMP permitir;
- requests próprios web/game-api: HMAC/Ed25519 com `keyId`, timestamp, nonce, method, path e body canônico;
- janela de replay de request: no máximo 60 s, nonce único persistido/cacheado no consumidor.

## Redaction

Qualquer chave com `ticket`, `token`, `session`, `authorization`, `masterKey`, `secret` ou `credential` deve virar `[REDACTED]`. Em diagnóstico, permitir apenas prefixo de tipo e um correlation ID separado; nunca últimos caracteres do token.

## Vetores de teste

| Vetor | Resultado esperado |
|---|---|
| prefixo desconhecido | reject antes do DB |
| token curto/Unicode/base64 inválido | reject antes do DB |
| hash desconhecido | 404/unauthorized uniforme |
| audience trocada | reject |
| expirado/revogado | reject |
| dois consumidores do mesmo launch grant | exatamente um sucesso |
| retry do queue grant antigo após rotação | reject; novo continua válido |
| duas resoluções de game session | ambas mesma account/character; contador +2 |
| client envia accountId/characterId diferente | campos ignorados/rejeitados; registro vence |
| DB indisponível | deny; nunca fallback offline |
| token aparece em exceção/log | teste falha |
| character bind para personagem de outra conta | rollback/reject |

## Decisões pendentes para Claude

1. Queue grant precisa persistência MariaDB ou um store efêmero compartilhado é suficiente para a topologia inicial?
2. Game session de 8 h deve ter limite absoluto menor/maior e política explícita de renovação?
3. É viável remover `masterKey` da URL sem alterar upstream, ou devemos apenas isolar/redigir?
4. O bind de character deve acontecer antes da fila ou após admissão?

## Critério de aprovação

AUTH-003 só começa após resposta às quatro decisões, revisão do threat model e aceitação dos vetores de concorrência/replay.

## Revisão adversarial do Claude — 2026-08-21

Baseada no código atual, não só no design: `apps/game-api/queue.js`, `skymp/gamemode/core/opaque-credential.js`, `migration-v8-game-sessions.sql`, e `apps/web/server.js:678`.

### 1. `queue_grant`: MariaDB ou store efêmero?

**Store efêmero (em memória) basta — e já é o que existe.** `queue.js` já implementa a fila inteira como `Map` em processo único, sem qualquer dependência de rede ou banco, por design explícito ("pura manipulação de estado em memória, pra que dê pra testar a política de admissão sem subir nada"). `queue_grant` só precisa sobreviver a um polling de segundos dentro do mesmo processo que o emitiu — nunca cruza serviço. Persistir em MariaDB adicionaria uma escrita por poll (alta frequência, TTL de 2 min) sem ganhar nada: um restart do `game-api` já reresolve fila e admissão do zero, e isso é aceitável porque, pela cadeia do AUTH-001, restart muda *disponibilidade*, não *identidade* — quem está na fila reconecta e reentra.

**Condição que invalida esta resposta:** isso pressupõe `game-api` rodando como instância única (sem load balancer/réplicas). Se houver plano de escalar `game-api` horizontalmente, um `queue_grant` emitido pela réplica A e consultado na réplica B falha silenciosamente — aí sim precisa de store compartilhado (Redis, não MariaDB; é dado de TTL curto, não auditoria). **Isto é decisão de topologia de deploy, não posso assumir sozinho — perguntar ao dono do produto antes de escalar `game-api` para >1 instância.**

**Gate proposto:** comentário/README em `apps/game-api` deixando explícito "single-instance assumption" e um teste que documente essa premissa, para que escalar horizontalmente sem revisar isto quebre de forma visível, não silenciosa.

### 2. TTL de 8h do `game_session`: limite absoluto e renovação?

**Absoluto, sem renovação automática.** `resolve_count`/`last_resolved_at` (migration v8) já existem só como telemetria, não para estender TTL — o próprio AUTH-002 diz isso na linha 63 ("incrementar contador e registrar last-resolved sem renovar TTL automaticamente"). Manter assim: renovação silenciosa a cada reconnect transformaria um token de 8h num token de vida indefinida enquanto o jogador ficar online, o que expande a janela de exposição em caso de vazamento sem nenhum ganho de UX real (uma sessão de RP pesado de 8h contínuas já é generosa). Quando expirar, o launcher reautentica via OAuth automaticamente — o custo de não renovar é baixo porque o fluxo já é automatizado, não manual.

**Ajuste sobre o valor:** 8h não deveria ficar hardcoded — deveria ser configurável via `.env` do jeito que outros parâmetros de auth já são (ver `AUTH_MASTER_KEY` em `check-server-config.js`), com um teto documentado (ex.: nunca aceitar >24h) para que operação não configure algo perigoso por engano.

### 3. Dá pra tirar `masterKey` da URL sem quebrar upstream?

**Não.** `GET /api/servers/:masterKey/sessions/:session` (`apps/web/server.js:678`) não é uma escolha nossa — é o formato exato que o binário do SkyMP (`skymp5-server/ts/systems/login.ts`, citado no comentário da migration v8) chama nativamente a partir da string `master` em `server-settings.json`. Mudar a forma da URL exigiria modificar o cliente Master API dentro do SkyMP compilado, o que contraria a própria restrição do projeto de não tocar binários do SkyMP.

**O que dá pra fazer, e resolve o risco real:** a masterKey em si já é comparada em tempo constante (`safeEquals`) e nunca retorna sinal diferenciado (404 uniforme pra masterKey errada e sessão não encontrada). O que falta é garantir que ela nunca *persista* em log — access log do reverse proxy, middleware de log do Express, APM. **Gate concreto para fechar AUTH-04a:** auditar todo pipeline de log entre o proxy e `apps/web` (nginx/ALB access log format, qualquer `morgan`/logger custom) para confirmar que o path completo não é logado, e documentar rotação do `masterKey` como runbook operacional (é a mitigação padrão para um segredo que não pode sair da URL). Isso é auditoria + runbook, não mudança de contrato.

### 4. Bind de character: antes ou depois da admissão na fila?

**Antes — no consumo do `launch_grant`, junto com o join na fila, não depois da promoção.** A fila (`queue.js`) resolve só capacidade; misturar bind de character com promoção de fila criaria uma corrida onde o tempo de espera (arbitrário, pode ser minutos) fica entre "personagem escolhido" e "personagem confirmado", violando o invariante do CHR-001 de que o bind é imediato e imutável assim que ocorre. A escolha de personagem já acontece no launcher antes do jogador entrar na fila — faz sentido que a requisição de join na fila já carregue a seleção, e o bind vire atômico com o consumo do `launch_grant` (mesma transação que já existe para consumo uso-único). O `game_session` emitido ao sair da fila nasce **já vinculado** a um `character_id`, then CHR-002 não precisa inventar um segundo momento de bind.

### Vetores de concorrência/replay do AUTH-002

Aceitos como escritos — a tabela de vetores (linhas 88-103) já cobre os casos que a implementação atual de `launch_tickets`/`game_sessions` precisa continuar respeitando (consumo atômico, 404 uniforme, sem fallback offline). Nenhum vetor adicional identificado além do que já está listado.

### Decisão de status

Três das quatro perguntas têm resposta fechada por evidência de código (1, 2, 4) ou por restrição de upstream (3). A única pendência real é de topologia de deploy (single-instance `game-api`), que não é uma decisão técnica que eu deva tomar sozinho. **Recomendação: aprovar AUTH-003 condicionado a essa confirmação de topologia**, não travar o trabalho todo por ela.
