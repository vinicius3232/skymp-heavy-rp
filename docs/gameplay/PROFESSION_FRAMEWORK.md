# Profession Framework

**Estado: LAB.** O **Profession Core** está implementado, testado e atrás de
`ENABLE_PROFESSION_SERVICE` (nasce desligado). Nenhuma profissão tem gameplay
por trás — nenhum minério, nenhuma árvore, nenhuma receita. Isto é a
plataforma sobre a qual essas fases futuras vão ser construídas, não a
mineração em si. Ver a auditoria de Fase 0 que precedeu esta implementação
para o inventário completo do que já existia no projeto antes desta rodada.

Arquivos: [`core/profession-registry.js`](../../skymp/gamemode/core/profession-registry.js),
[`profession-service.js`](../../skymp/gamemode/profession-service.js),
as sete ações em [`admin-actions.js`](../../skymp/gamemode/admin-actions.js).

---

## 1. O que existe e o que não existe

| Existe | Não existe (fases futuras) |
|---|---|
| Catálogo de 13 profissões (`core/profession-registry.js`) | Resource Node Framework |
| Concessão / revogação / suspensão / reativação | Mineração, corte de árvore, caça |
| Rank numérico (0..`profession.maxRank`) | Curva de XP → level-up |
| XP acumulado, ajuste administrativo | Ganho de XP por gameplay (coleta, crafting) |
| 7 ações de staff, auditadas, atrás de 5 capabilities | Receita de crafting ligada a profissão/rank |
| `character_professions` (migration v18) | Contrato de profissão (Mensageiro) |
| `/profissoes` (jogador vê a própria ficha) | Qualquer UI CEF |

Se você chegou aqui procurando onde ligar a mineração: não é aqui ainda. É na
próxima fase, sobre o Resource Node Framework, consumindo a API da seção 6.

---

## 2. Arquitetura

```
core/profession-registry.js   catálogo (registered / enabled / gameplayImplemented)
        │
        ▼
profession-service.js         domínio: grant/revoke/suspend/reactivate/rank/xp
        │                     (SÓ isso — nenhuma checagem de cargo mora aqui)
        ▼
admin-actions.js              7 ações registradas no pipeline (core/admin-action.js)
        │                     permissão, sessão, alvo, idempotência, audit
        ▼
character_professions          (migration-v18-professions.sql)
```

Nada aqui é novo em conceito — é reuso do que a auditoria de Fase 0 já mapeou:

- **Permissão** — 5 capabilities novas em `core/permissions.js`
  (`profession.view`, `.assign`, `.revoke`, `.rank`, `.xp`), concedidas a
  `admin`/`owner`, não a `moderator` (mesma classe de decisão que
  `economy.adjust`).
- **Pipeline administrativo** — as 7 ações usam o `core/admin-action.js`
  existente. Nenhum RBAC, nenhuma sessão e nenhum audit novos.
- **Auditoria** — categoria `profession` nova em `core/audit-event.js`
  (o catálogo de categorias é fechado, então isto era obrigatório).
- **Configuração** — `profession.maxPerCharacter` (padrão 3) e
  `profession.maxRank` (padrão 3) em `core/server-options.js`.
- **Ciclo de vida** — módulo `profession` em `core/module-registry.js`,
  fase `lab`, `ENABLE_PROFESSION_SERVICE`.

## 2.1 Uma decisão que se desviou do briefing original, e por quê

O rascunho inicial sugeria uma tabela `professions` (id, code, name, category,
enabled) no banco. Ela **não foi criada**. As treze profissões são fixas em
código e nada nesta fase permite criar profissão nova em runtime — uma tabela
sem escritor além de uma migration de seed seria um espelho do registry, sem
nenhum grau de liberdade a mais. O precedente do próprio projeto para "catálogo
fechado, validado em código, sem tabela própria" já existe:
`crafting_recipes.station_type` é `VARCHAR(64)` com a lista de valores no
comentário, não uma FK. `character_professions.profession_code` segue o mesmo
padrão. Ver o comentário no topo de `migration-v18-professions.sql` para o
raciocínio completo.

---

## 3. `registered` × `enabled` × `gameplayImplemented`

Três perguntas diferentes, deliberadamente não confundidas — a Fase 0 pediu
isso explicitamente:

- **`registered`** — está no catálogo (`core/profession-registry.js`).
- **`enabled`** — pode ser concedida HOJE. `grantProfession` checa isto.
- **`gameplayImplemented`** — existe automação por trás (nó de recurso,
  receita). **Nenhuma das treze tem, hoje.**

`grantProfession` nunca checa `gameplayImplemented`. Um staff já pode designar
um jogador como Minerador por RP, antes de qualquer picareta funcionar de
verdade — é assim que uma guilda aceita um aprendiz antes de existir trabalho
pronto pra ele.

---

## 4. Ciclo de vida de uma profissão

```
                    grantProfession
                          │
                          ▼
   (não existe) ──────► ACTIVE ◄──── reactivateProfession ────┐
                          │  │                                 │
              revokeProfession  suspendProfession               │
                          │        │                            │
                          ▼        ▼                            │
                      REVOKED   SUSPENDED ───────────────────────┘
                          │
                 grantProfession
              (reaproveita a linha,
               rank/xp preservados)
```

- **`active`** — autoriza gameplay futuro, conta contra
  `profession.maxPerCharacter`.
- **`suspended`** — histórico preservado (rank/xp), NÃO autoriza gameplay, NÃO
  conta contra o limite. Só volta por `reactivateProfession`.
- **`revoked`** — encerrada, linha **não é apagada**. `grantProfession` sobre
  um código revogado reaproveita a mesma linha — rank e XP antigos voltam a
  valer. **Esta é uma decisão explícita, não a única leitura possível**: zerar
  rank/XP num "recomeço do zero" também seria razoável. Se um dia isso importar
  para o RP do servidor, é uma mudança pequena em
  `profession-service.grantProfession`.

Reativar **reconta** contra o limite: suspender uma profissão, conceder outra
até o teto e depois reativar a primeira não pode furar o limite por trás.

---

## 5. Segurança

- Cliente nunca atribui a própria profissão — as 6 operações de escrita só
  existem atrás do pipeline de staff (`/setprofissao`, `/removeprofissao`,
  etc.); o único comando de jogador (`/profissoes`) é leitura da própria
  ficha, sem nenhuma escrita.
- Concorrência: `grantProfession`/`reactivateProfession` travam
  (`SELECT ... FOR UPDATE`) as linhas ativas do personagem antes de contar
  contra o limite. Sob REPEATABLE READ (padrão InnoDB), isso toma next-key
  lock sobre a faixa do índice `idx_charprof_character` — duas concessões
  concorrentes para o MESMO personagem serializam.
- XP negativo só é aceito com `staffCharacterId` presente — verificado dentro
  de `profession-service.js`, não só na camada administrativa, porque a
  função é a API pública que um consumidor futuro (ResourceNode) vai chamar
  direto.
- Fail closed: `moduleRegistry.isEnabled('profession')` é checado tanto no
  `precondition` do pipeline (a ação nem chega ao serviço) quanto dentro do
  próprio `profession-service.js` (protege quem chamar o serviço sem passar
  pelo pipeline).
- Resultado tipado: `{ok:true, data}` ou `{ok:false, code}` para recusa
  esperada; erro de infraestrutura **lança**. A mesma convenção de
  `core/economy-service.js`, pela mesma razão (Achado 7 do audit de economia:
  timeout de banco não pode virar "profissão negada").

---

## 6. API interna (para consumidores futuros)

```js
const professionService = require('./profession-service');

await professionService.hasProfession(characterId, 'miner');
// → boolean, true só quando status === 'active'

await professionService.getProfessionState(characterId, 'miner');
// → {characterId, professionCode, status, rank, xp, grantedByCharacterId, joinedAt, updatedAt} | null

await professionService.addProfessionXp({
  characterId, professionCode: 'miner', amount: 10, context: 'gather'
});
// → {ok:true, data:{previousXp, xp, delta}} | {ok:false, code}
```

Isto é o que o Resource Node Framework, o crafting reativado e um futuro
Contract Framework vão chamar. Nenhum deles existe ainda.

---

## 7. Guard × governance — não confundir as duas autoridades

`guard` está no catálogo de profissões como **etiqueta de ocupação/RP**. Ela
**não concede nenhum poder de guarda**. Quem decide o que um guarda IC pode
fazer — revistar, prender, multar, confiscar — continua sendo
`governance-service.js` (facções e cargos IC), que a auditoria de Fase 0 já
identificou como o sistema existente e correto para isso.

Um personagem pode ter `profession = 'guard'` sem nenhum cargo em
`governance`, e vice-versa. As duas coisas **não se falam nesta fase**, de
propósito — evitar que o Profession Core vire uma segunda fonte de verdade
para `GUARD_SEARCH`/`GUARD_ARREST`/etc. era uma condição explícita desta
rodada. Um adapter que ligue as duas (ex.: `profession=guard` como
pré-requisito para ingressar na guarda IC) é uma decisão de produto para uma
fase futura, não implícita nesta.

---

## 8. Adapter futuro: Skyrim Faction API

A auditoria de Fase 0 confirmou que `AddToFaction`/`RemoveFromFaction`/
`IsInFaction`/`GetFactions` funcionam no SkyMP atual (teste oficial
`misc/tests/test_factions.js`). **Não são usadas nesta fase.** O banco
(`character_professions`) é a única fonte de verdade. Se uma fase futura
quiser sincronizar profissão com uma facção visual/mecânica do Skyrim (ex.:
hostilidade vanilla), o ponto de entrada é uma função nova que lê o estado já
persistido e chama a API Papyrus — nunca o contrário.

---

## 9. Como adicionar uma profissão nova

Sem tocar no núcleo (§33 do briefing original):

```js
const professionRegistry = require('./core/profession-registry');

professionRegistry.register({
  code: 'fisher',
  label: 'Pescador',
  category: 'gathering', // gathering | crafting | service | institutional
  enabled: true
  // gameplayImplemented fica false até existir automação de verdade
});
```

Isso a torna concedível via `/setprofissao` imediatamente (o `oneOf` de
`professionCode` nas ações administrativas é computado a partir do catálogo no
boot do processo — uma profissão registrada depois do boot exige reiniciar
para aparecer nos comandos, mas já responde a `hasProfession`/
`getProfessionState` sem reiniciar nada).

---

## 10. Testes

`node --test core/profession-registry.test.js profession-service.test.js
admin-actions.test.js` — cobre registry, ciclo de vida completo, concorrência
(ordem de lock), rank/XP válido e inválido, fail-closed de XP negativo, e o
pipeline administrativo ponta a ponta (sessão, permissão, VALIDATION,
precondition do módulo, execução, dados). `profession-service.test.js` também
lê `migration-v18-professions.sql` e falha se alguma coluna que o serviço usa
sumir de lá — o mesmo padrão que `core/audit-event.test.js` já usa contra
`migration-v17`.

Concorrência real (duas transações MySQL disputando a mesma linha) não é
provável com um mock síncrono — os testes de concorrência aqui provam que a
**ordem** das queries está certa (trava antes de contar, conta antes de
decidir), não que o MySQL de verdade se comporta assim. Só um teste de
integração contra um banco real prova isso.

---

## 11. NOT IMPLEMENTED YET

- Resource Node Framework: **motor implementado**, sem consumidor — ver
  [RESOURCE_NODE_FRAMEWORK.md](RESOURCE_NODE_FRAMEWORK.md). Nenhum nó está
  ligado a um objeto real do mundo ainda.
- Minerador — **tem gameplay** desde antes desta rodada, via `mining-service.js`
  (interação `mining.mine` sobre o Resource Node Framework). Lenhador, Caçador,
  Fazendeiro continuam sem coleta própria — só `jobs-service.js` (trabalho
  livre, sem profissão) cobre lenha/minério/peixe hoje.
- Fundidor, Curtidor — **têm gameplay** desde 20/08/2026: `crafting-service.js`
  foi reativado (ver [CRAFTING_SYSTEM.md](CRAFTING_SYSTEM.md)) com gate de
  profissão/rank real (`required_profession`/`required_rank`,
  migration-v20-crafting-profession-gate.sql) e receita cadastrada em
  `seed-forging.sql`. **Ferreiro, Encantador, Cozinheiro têm o gate pronto e
  zero receita** — o mecanismo existe, falta conteúdo (um `result_base_id` de
  arma/armadura/item confirmado, não inventado).
- Tratador de Cavalos, Taberneiro — qualquer integração com `horse-service.js`
  ou economia de taverna
- Mensageiro — Contract Framework: `contracts-service.js` foi reativado em
  20/08/2026 (ver [CONTRACTS.md](CONTRACTS.md)), mas continua jogador↔jogador,
  sem NPC
- Guarda — qualquer poder administrativo/IC (permanece 100% em
  `governance-service.js`)
- Qualquer UI CEF para profissão
- Curva de XP → level-up
- Fadiga/stamina ligada a atividade de profissão (o projeto não tem sistema de
  fadiga hoje — ver §16 do briefing original)
