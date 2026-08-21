# CHR-001 — Modelo Account, Session, Character e Identity

Status: bind Session↔Character **IMPLEMENTADO em 21/08/2026** (`migration-v19-game-session-character-bind.sql`, AUTH-003). Data original do design: 2026-08-12.

O bind automático descrito abaixo (§"Desenho de persistência futuro") foi simplificado: em vez de `audience`/`kind`/`nonce` na tabela, o `kind` já vive no prefixo da credencial opaca (AUTH-002) e a cardinalidade "um approved por conta" tornou a seleção explícita desnecessária por enquanto — `apps/game-api` resolve o personagem sozinho no join da fila. Isto NÃO é CHR-002: continua sem seleção de personagem pelo jogador, sem suporte a múltiplos approved, e sem retirada/troca de personagem em sessão ativa. Ver `resolveApprovedCharacter` em `apps/game-api/server.js` para onde a seleção explícita entra quando CHR-002 chegar — o ponto do bind (join da fila) não muda, só a origem do `characterId`.

## Responsabilidades

| Agregado | Significado | Pode mudar durante conexão? | Fonte |
|---|---|---:|---|
| Account | pessoa/conta autenticada e sanções globais | não | MariaDB/web |
| Session | capability temporária que prova a conta e audience | não; pode ser revogada | MariaDB/Master API |
| Character | persona persistente, inventário, posição, estado e lifecycle | não após bind | MariaDB |
| Identity | nome público/real, alias, disfarce e conhecimento entre personagens | projeções podem mudar | MariaDB/domain service |
| Actor | representação efêmera SkyMP do character conectado | sim no reconnect | engine |

## Invariantes

1. Session pertence a exatamente uma Account.
2. Character pertence a exatamente uma Account.
3. Uma Session liga no máximo um Character por vez; após o bind, não troca.
4. Character deve estar `approved` e não `retired` no instante do bind.
5. Actor associa-se a uma Session/Character somente após autenticação server-side.
6. Disconnect remove Actor/cache, não apaga Session ou Character.
7. Staff pertence a Account e é projetado para Actor; VIP nunca concede staff.
8. Alias/disfarce afeta apresentação, não ownership, audit ou autorização.
9. `character_known_identities` é relação observer -> target, não propriedade global do target.
10. CK/permakill muda Character para `retired`; nenhuma nova sessão pode vinculá-lo.

## Lifecycle

```text
OAuth -> Account authenticated -> game Session issued
  -> list approved Characters
  -> server receives character selection intent
  -> verifies ownership/status and atomically binds Session
  -> SkyMP resolves Session -> Account + bound Character
  -> Actor created -> caches initialized
  -> disconnect -> Actor caches cleaned
  -> reconnect with same Session -> same Character
  -> logout/ban/CK -> revoke/unbind according to policy
```

## Cardinalidade durante transição

Até CHR-002, manter uma única ficha `approved` ativa por conta como regra de aplicação. Quando seleção for implementada, permitir múltiplos approved, mas uma única sessão ativa por character e bind explícito antes do jogo.

## Desenho de persistência futuro

Opção preferida: adicionar `character_id`, `audience`, `kind`, `nonce` e `bound_at` a `game_sessions`, com FK e constraint validada no serviço. MariaDB não oferece partial unique index portátil para “uma sessão ativa”; concorrência deve usar `SELECT ... FOR UPDATE` na conta/personagem e transação.

Nenhuma migration é criada nesta fase. O schema final depende da revisão do Claude e de decidir se a seleção acontece antes ou depois da fila.

## Testes obrigatórios para CHR-002

- Account A não seleciona Character de B.
- Character pending/rejected/retired não pode ser vinculado.
- Dois selects concorrentes na mesma Session resultam em um bind imutável.
- Reconnect retorna o mesmo Character.
- Trocar o payload depois do bind não troca Character.
- CK revoga sessões ligadas e impede reconnect.
- ActorId reutilizado não herda character/staff/state anterior.
- Falha após bind e antes do spawn é recuperável sem bind divergente.
