/**
 * cell-persistence-service.js — "o mundo lembra" (Tarefa 2, promovida de
 * Pós-Alfa em 21/08/2026 — ver HEAVY_RP_GAMEPLAY_SYSTEMS_BACKLOG.md item 6)
 *
 * ─── Escopo, e o que deliberadamente NÃO é ───────────────────────────────────
 *
 * Cobre item DROPADO por jogador: um objeto novo, spawnado em runtime via
 * `ObjectReference.PlaceAtMe` — chamada já aprovada em
 * `PAPYRUS_USAGE_POLICY.md` e já usada por `market-stalls-service.js` para o
 * marcador visual da barraca. Não é capacidade nova da engine.
 *
 * **NÃO** cobre baú/container pré-colocado no mundo (`containers` +
 * `container_inventory`, existe desde migration-v2, consumido por
 * `housing-service.js`) nem corpo (`corpse-probe.js` só observa, não guarda
 * item). As duas já têm modelo próprio; duplicá-las aqui repetiria o defeito
 * que `core/inventory-owner.js` existe para evitar — três formas de "dono de
 * item" que discordam entre si.
 *
 * ─── O que está provado e o que não está ─────────────────────────────────────
 *
 * Provado por teste: classificação da allowlist, cálculo de TTL, idempotência
 * da reidratação (não spawna duas vezes o mesmo objeto ainda ativo), e que o
 * estado sobrevive a um "restart" simulado (limpar cache em memória e reler
 * do banco — a persistência real é a linha em `world_objects`, não o cache).
 *
 * **NÃO provado, mesma lacuna do resto do projeto:** que `PlaceAtMe` de fato
 * spawna um objeto visível para outros jogadores na mesma célula, e que a
 * detecção de troca de célula por polling (`locationalData.cellOrWorldDesc`)
 * responde no tempo certo. Isso só uma sessão com dois clientes decide — Fase
 * 0 §6/§7 seguem pendentes.
 *
 * ─── Por que polling e não um evento `onCellChange` ──────────────────────────
 *
 * `core/module-registry.js` já avaliou (06/08/2026) e decidiu explicitamente
 * NÃO construir despacho genérico de eventos de jogo enquanto só um módulo
 * precisar de cada tipo. Isto aqui é esse segundo consumidor de
 * "célula mudou" que o comentário lá previu como gatilho — mas o padrão que
 * `nametag-service.js` já usa (ler `locationalData` a cada tick, comparar com
 * o valor anterior) resolve sem precisar de um barramento novo. Reabrir a
 * decisão do registry fica para um TERCEIRO consumidor.
 *
 * Desligado por padrão, como todo lab: `ENABLE_CELL_PERSISTENCE_SERVICE=true`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ADENDO (21/08/2026) — fecha o loop: pickup + Interaction Framework
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ─── Resposta à §15 da Constituição ───────────────────────────────────────────
 *
 * Objetivo: dar ao item persistido (§ escopo acima) um fim de vida — hoje ele
 * entra em `world_objects` e nunca sai a não ser por TTL de lixo. Sem pickup,
 * todo item da allowlist (arma/armadura/quest/container_loot, ou qualquer
 * coisa acima do valor mínimo) fica na tabela **para sempre**, mesmo depois de
 * alguém já ter pego fisicamente do chão — exatamente a lacuna que
 * `PERSISTENCE_AUDIT.md` §6 registrou como "a mais séria encontrada".
 *
 * Problema que resolve: crescimento sem limite de `world_objects` (§6 do
 * audit) e a ausência de um caminho jogador→inventário para o que foi
 * dropado.
 *
 * Problemas que cria: um segundo lugar onde "o item existe" pode divergir do
 * banco se o pickup não for atômico — mitigado pelo `UPDATE ... WHERE
 * state='active'` condicional (idêntico em espírito ao consumo de
 * `launch_tickets` em `apps/game-api`), que é também a resposta ao item 4 do
 * pedido (segurança contra duplicação por lag): duas apresentações
 * concorrentes do mesmo `id` disputam a mesma linha, só uma ganha.
 *
 * Exploits: apresentar um `id` de outra célula/já saqueado (recusado pelo
 * `state='active'` condicional); repetir o clique de pickup rápido (recusado
 * pela idempotencyKey do `transactionService.giveItem`, chaveada no `id` da
 * linha — a segunda chamada não duplica o item mesmo que a primeira UPDATE já
 * tenha marcado `looted`, porque o idempotency check do ledger é uma segunda
 * barreira independente); apontar pra um alvo fora de alcance (recusado pelo
 * `assertRange` do pipeline do Interaction Framework, igual a qualquer outra
 * interação registrada).
 *
 * Impacto econômico: nenhum novo — o item já existia no mundo (foi dropado por
 * alguém, ou nasceu ali via drop); pickup só move o mesmo item de volta pro
 * inventário. Sem geração líquida de patrimônio.
 *
 * Impacto político/militar/religioso: nenhum de propósito de sistema.
 *
 * Social/narrativo: fecha o ciclo físico do RP — dropar algo pra outra pessoa
 * pegar (comércio informal, herança de campo de batalha, "deixei isso pra
 * você") deixa de ser gesto cosmético e passa a mover item de verdade.
 *
 * Técnico: usa o Interaction Framework existente
 * (`docs/framework/INTERACTION_FRAMEWORK.md`) pelo canal que ele já previu —
 * `TARGET_TYPES.OBJECT`, reservado desde a origem do framework e sem dono até
 * aqui ("o dia em que um módulo precisar, ele chama `registerResolver`"). O
 * resolvedor do alvo é **síncrono** (contrato do `interaction-targets.js`,
 * `resolve()` chama `resolver(...)` sem `await`), então ele lê de um cache em
 * memória (`_activeObjectsById`) populado por `recordDrop`/`rehydrateCell`, e
 * NÃO consulta o banco — a checagem autoritativa de "o item ainda existe" fica
 * inteiramente no `execute` (`removeObject`, com o UPDATE condicional acima).
 * Isso é literalmente a regra central do framework, "canSee não autoriza
 * nada", aplicada ao pickup: o menu pode oferecer "Pegar" pra um item que já
 * sumiu um instante depois — o `execute` refaz a verificação e recusa limpo.
 *
 * Como balancear: `assertRange` limita a poucos metros (mesmo raio de
 * `say`, reaproveitado de `core/proximity-ranges.js`); `policyAction`
 * (`world_object_pickup`, categoria `gather`) bloqueia em estado
 * algemado/preso/abatido/morto, igual a colher madeira ou minerar.
 *
 * Como integra ao mundo: usa o mesmo pipeline (rate limit → alvo → schema →
 * política → distância → canSee/canExecute → execute → auditoria) que
 * `law.*`/`stall.*` já usam — nenhuma exceção nova no core.
 *
 * ─── Raycast de cliente: o que está provado e o que não está ────────────────
 *
 * `CROSSHAIR_SNIPPET_DO_CLIENTE` roda no processo do Skyrim Platform (não na
 * CEF) e usa `ctx.sp.Game.getCurrentCrosshairRef()` + `.getFormID()` +
 * `ctx.getFormIdInServerFormat(...)`. O último é o mesmo par obrigatório que
 * `core/hit-events.js` já usa e documenta como confirmado necessário — FormID
 * de cliente e de servidor são espaços diferentes.
 *
 * **NÃO provado:** que `Game.getCurrentCrosshairRef()` de fato devolve a
 * referência sob a mira neste build do Skyrim Platform — nunca foi chamado
 * por este projeto (mesma classe de lacuna que `worldPointToScreenPoint` tem
 * em `nametag-service.js` §4). O snippet empurra o resultado pra CEF via
 * `window.handleWorldObjectCrosshair(...)`, no mesmo padrão de
 * `nametag-service.SNIPPET_DO_CLIENTE` → `window.handleNametag`.
 *
 * **Correção de 21/08/2026 (Tarefa 6):** `skymp/ui/index.html` **já** fala
 * `interaction:query`/`interaction:execute` de verdade pra alvo `player` —
 * `INTERACTION_FRAMEWORK.md` §14 estava desatualizado nisso. O que falta não
 * é o protocolo, é o **gatilho**: nada no repositório dispara
 * `mp.events.add('interaction:open', ...)`, o mesmo padrão de listener morto
 * que o próprio `index.html` já documenta ter existido pra `voip:connect`.
 * `window.handleWorldObjectCrosshair` também não é lido ainda — ver o próximo
 * passo concreto em `INTERACTION_FRAMEWORK.md` §14. Por isso `/pegaritem <id>`
 * existe: é o caminho utilizável HOJE, mesmo padrão de `trade-service` ("NÃO
 * tem UI CEF: os comandos de chat são a interface inteira").
 */

const db = require('./database');
const commands = require('./commands');
const transactionService = require('./core/transaction-service');
const interactionRegistry = require('./core/interaction-registry');
const actionPolicy = require('./core/action-policy');
const { RANGES } = require('./core/proximity-ranges');
const { actorRef } = require('./core/papyrus');

const MODULE = 'cell_persistence';

/**
 * Categorias que persistem indefinidamente independente de valor — o "ou
 * categoria específica" do filtro de importância. Fora daqui, só o valor
 * decide (ver `classifyPersistence`).
 */
const ALWAYS_PERSIST_CATEGORIES = Object.freeze(new Set(['weapon', 'armor', 'quest', 'container_loot']));

/** Abaixo disto (em ouro), e fora das categorias acima, é "lixo": persiste, mas com TTL curto. */
const MIN_VALUE_THRESHOLD = 100;

/** TTL do lixo. Curto o bastante para não acumular sujeira, longo o bastante pra quem estava por perto ainda ver. */
const JUNK_TTL_MS = 10 * 60 * 1000;

/** Tick de varredura de célula (troca de célula + limpeza de expirados). Mesmo espírito do nametag: 2s, não por quadro. */
const TICK_INTERVAL_MS = 2000;

let _timer = null;

/**
 * Guarda contra ticks sobrepostos — achado da revisão de prontidão pra Fase 0
 * (Tarefa 6, 21/08/2026): `setInterval` dispara a cada `TICK_INTERVAL_MS`
 * **sem esperar o tick anterior terminar**. Com poucos jogadores um tick
 * conclui bem antes dos 2s; sob carga (10 jogadores, cada um podendo disparar
 * um `SELECT` de reidratação) um tick pode passar de 2s, e o próximo dispara
 * em cima dele.
 *
 * O cenário real que isso evita: dois jogadores A e B entram na MESMA célula
 * nova dentro da janela de um tick lento. `tick()` processa A primeiro e
 * marca `_lastCellByActor` antes de aguardar `rehydrateCell` (protege A contra
 * ser reprocessado), mas B só é alcançado depois que a `await` de A resolver
 * — DENTRO do mesmo tick. Se um SEGUNDO tick começa nesse meio-tempo e
 * também alcança B (que o primeiro tick ainda não processou), os dois ticks
 * podem chamar `rehydrateCell` pra célula ainda não marcada em
 * `_rehydratedCells` simultaneamente: dois `SELECT`, duas rodadas de
 * `PlaceAtMe` pros mesmos objetos — referências duplicadas no mundo, uma das
 * quais fica órfã (o `UPDATE ref_desc` da segunda sobrescreve o rastro da
 * primeira).
 */
let _tickInFlight = false;

/** actorId → cellId onde ele estava no último tick, para detectar troca sem evento. */
const _lastCellByActor = new Map();

/** cellId → true, para não reidratar a mesma célula duas vezes enquanto ela já está ativa. */
const _rehydratedCells = new Set();

/**
 * id (world_objects.id) → { id, base_id, pos_x, pos_y, pos_z, angle_z, ref_desc }
 * para todo objeto que este processo já sabe estar ativo — populado por
 * `recordDrop`/`rehydrateCell` via `_spawnObject`, removido por `removeObject`
 * e `sweepExpired`.
 *
 * Existe porque `interactionTargets.resolve()` chama o resolvedor de alvo de
 * forma SÍNCRONA (sem `await` — ver `core/interaction-targets.js`), então o
 * resolvedor de `TARGET_TYPES.OBJECT` não pode ir ao banco. Este cache é a
 * fonte rápida para "isto parece existir"; `removeObject` é quem confere a
 * verdade contra o banco antes de qualquer efeito.
 */
const _activeObjectsById = new Map();

/** Alcance de pickup: o mesmo raio de fala normal — quem consegue conversar alcança o chão ao lado. */
const PICKUP_RANGE = RANGES.say;

/** Id de ação da `core/action-policy.js` — bloqueia pickup em estado algemado/preso/abatido/morto. */
const PICKUP_POLICY_ACTION = 'world_object_pickup';

/**
 * Decide se um drop persiste "para sempre" (allowlist) ou como lixo com TTL.
 *
 * Server-authoritative por construção: quem chama isto informa `category` e
 * `value` explicitamente — o mesmo padrão de `transaction-service.giveItem`,
 * que também não adivinha preço sozinho. Este projeto não tem um catálogo de
 * itens derivado do ESM (nenhum arquivo aqui faz parsing de plugin); category/
 * value são responsabilidade de quem chama `recordDrop`, hoje o comando
 * `/dropitem` com argumentos explícitos. Quando um catálogo real existir, o
 * único ponto de ajuste é ali — esta função não muda.
 *
 * @param {{category: string, value: number}} item
 * @returns {{ttlMs: number|null}} null = persiste indefinidamente
 */
function classifyPersistence({ category, value }) {
  if (ALWAYS_PERSIST_CATEGORIES.has(category)) return { ttlMs: null };
  if (Number(value) >= MIN_VALUE_THRESHOLD) return { ttlMs: null };
  return { ttlMs: JUNK_TTL_MS };
}

function _cellDesc(loc) {
  return loc.cellOrWorldDesc || loc.cellOrWorldSpaceId || loc.cellId || loc.worldOrCell || null;
}

/**
 * Registra um item dropado no mundo: remove do inventário persistente do
 * personagem (transaction-service, atômico e auditável) e grava a linha em
 * `world_objects`. Se a gravação em `world_objects` falhar depois da remoção
 * ter funcionado, devolve o item — item sumir do inventário sem virar objeto
 * no mundo é duplicação/perda de patrimônio, a mesma classe de bug que
 * `game-api/persistAdmission` já trata assim para a fila.
 *
 * O spawn visual (`PlaceAtMe`) é best-effort e não bloqueia o registro: se
 * falhar (ou `mp` não existir, como em teste), a linha em `world_objects`
 * ainda é a fonte da verdade — o objeto aparece na próxima reidratação da
 * célula.
 *
 * @param {object} opts
 * @param {number} opts.actorId
 * @param {number} opts.characterId
 * @param {number} opts.baseId
 * @param {number} opts.count
 * @param {string} opts.category
 * @param {number} opts.value
 * @returns {Promise<{ok: true, id: number} | {ok: false, reason: string}>}
 */
async function recordDrop({ actorId, characterId, baseId, count, category, value }) {
  if (!Number.isInteger(baseId) || baseId <= 0) return { ok: false, reason: 'invalid_base_id' };
  if (!Number.isInteger(count) || count <= 0) return { ok: false, reason: 'invalid_count' };

  const loc = typeof mp !== 'undefined' ? mp.get(actorId, 'locationalData') : null;
  if (!loc || !loc.pos) return { ok: false, reason: 'no_location' };
  const cellId = _cellDesc(loc);
  if (!cellId) return { ok: false, reason: 'no_cell' };

  const removed = await transactionService.removeItem({
    actorId, characterId, baseId, count,
    reason: 'world_drop', module: MODULE,
    idempotencyKey: `${MODULE}_drop_${characterId}_${baseId}_${Date.now()}`
  });
  if (!removed) return { ok: false, reason: 'inventory_removal_failed' };

  const { ttlMs } = classifyPersistence({ category, value });
  const [posX, posY, posZ] = loc.pos;
  const angleZ = loc.rot?.[2] || loc.angleZ || 0;

  try {
    const result = await db.query(
      `INSERT INTO world_objects
         (cell_id, base_id, pos_x, pos_y, pos_z, angle_z, category, state, dropped_by_character_id, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ${ttlMs === null ? 'NULL' : 'DATE_ADD(NOW(), INTERVAL ? SECOND)'})`,
      ttlMs === null
        ? [cellId, baseId, posX, posY, posZ, angleZ, category, characterId]
        : [cellId, baseId, posX, posY, posZ, angleZ, category, characterId, Math.floor(ttlMs / 1000)]
    );

    _spawnObject(actorId, { id: result.insertId, base_id: baseId, pos_x: posX, pos_y: posY, pos_z: posZ, angle_z: angleZ, cell_id: cellId }, 'drop');
    return { ok: true, id: result.insertId };
  } catch (err) {
    console.error('[cell-persistence] Falha ao gravar world_objects, devolvendo item:', err.message);
    // Reverte a remoção — sem isso o item desaparece do inventário e nunca
    // vira objeto no mundo. idempotencyKey própria: é uma transação distinta.
    await transactionService.giveItem({
      actorId, characterId, baseId, count,
      reason: 'world_drop_rollback', module: MODULE,
      idempotencyKey: `${MODULE}_rollback_${characterId}_${baseId}_${Date.now()}`
    });
    return { ok: false, reason: 'persist_failed' };
  }
}

/**
 * Spawna a referência visual de uma linha de `world_objects`, via o mesmo
 * padrão que `market-stalls-service.spawnStallVisual` já usa. `spawnerActorId`
 * é só a âncora do `self` da chamada Papyrus — a posição final vem de
 * `mp.set`, não de proximidade a quem spawnou.
 *
 * Retorna o `refId` (número de servidor) ou `null` se não deu pra spawnar —
 * nunca lança: falha de spawn não pode derrubar `recordDrop`/`rehydrateCell`.
 */
/**
 * Log de correlação para o protocolo de teste de dois clientes (Tarefa 6,
 * item 2). O servidor não tem como saber quando o Jogador B efetivamente VIU
 * o objeto aparecer — isso só o replicação nativa do SkyMP faz, e não expõe
 * confirmação nenhuma pro gamemode. O que dá pra medir daqui é só o instante
 * em que o SERVIDOR emitiu o `PlaceAtMe`; o protocolo de teste
 * (`FASE_0_TWO_CLIENT_TEST_PROTOCOL.md`) usa esse timestamp como o "T=0" que
 * a pessoa testando compara contra o relógio de parede de quando o objeto
 * apareceu na tela do Jogador B.
 *
 * `[SPAWN-SYNC]` é o marcador — `grep SPAWN-SYNC` no log do servidor durante
 * o teste isola só essas linhas.
 */
function _logSpawnSync(row, reason, refId) {
  console.log(
    `[cell-persistence] [SPAWN-SYNC] motivo=${reason} world_objects.id=${row.id} ` +
    `baseId=0x${row.base_id.toString(16)} cell=${row.cell_id || 'desconhecida'} ` +
    `refId=${refId ? '0x' + refId.toString(16) : 'FALHOU'} t=${new Date().toISOString()}`
  );
}

function _spawnObject(spawnerActorId, row, reason = 'desconhecido') {
  // Entra no cache ANTES do spawn visual: é o que faz o objeto virar um alvo
  // resolvível (§ADENDO) mesmo se o PlaceAtMe falhar — a linha do banco já é
  // a fonte da verdade, e recusar o pickup só porque o marcador visual não
  // apareceu seria pior do que deixar pegar um item invisível.
  _activeObjectsById.set(row.id, {
    id: row.id, base_id: row.base_id,
    pos_x: row.pos_x, pos_y: row.pos_y, pos_z: row.pos_z, angle_z: row.angle_z,
    ref_desc: null
  });

  if (typeof mp === 'undefined' || typeof mp.callPapyrusFunction !== 'function') {
    _logSpawnSync(row, reason, null);
    return null;
  }
  if (typeof mp.getDescFromId !== 'function') {
    console.warn('[cell-persistence] Spawn indisponível: mp.getDescFromId ausente, sem self válido pro Papyrus.');
    _logSpawnSync(row, reason, null);
    return null;
  }

  try {
    const formToPlace = mp.callPapyrusFunction('global', 'Game', 'getFormEx', null, [row.base_id]);
    const placed = mp.callPapyrusFunction(
      'method', 'ObjectReference', 'PlaceAtMe',
      actorRef(spawnerActorId),
      [formToPlace, 1, true, false]
    );
    const refId = placed?.desc && typeof mp.getIdFromDesc === 'function' ? mp.getIdFromDesc(placed.desc) : placed;
    if (!refId) {
      console.warn(`[cell-persistence] PlaceAtMe não devolveu referência para world_objects.id=${row.id}.`);
      _logSpawnSync(row, reason, null);
      return null;
    }

    mp.set(refId, 'pos', [row.pos_x, row.pos_y, row.pos_z]);
    mp.set(refId, 'angle', [0, 0, row.angle_z || 0]);

    const refDesc = typeof mp.getDescFromId === 'function' ? mp.getDescFromId(refId) : null;
    if (refDesc) {
      const cached = _activeObjectsById.get(row.id);
      if (cached) cached.ref_desc = refDesc;
      db.query('UPDATE world_objects SET ref_desc = ? WHERE id = ?', [refDesc, row.id]).catch((err) => {
        console.error(`[cell-persistence] Falha ao gravar ref_desc de world_objects.id=${row.id}:`, err.message);
      });
    }
    _logSpawnSync(row, reason, refId);
    return refId;
  } catch (err) {
    console.error(`[cell-persistence] Falha ao spawnar world_objects.id=${row.id}:`, err.message);
    _logSpawnSync(row, reason, null);
    return null;
  }
}

/**
 * Apaga a referência viva de um objeto pego/expirado, se ela existir.
 * `Disable` + `Delete` — as duas já aprovadas em `PAPYRUS_USAGE_POLICY.md`.
 * Best-effort e silencioso: se não houver `ref_desc` (objeto nunca chegou a
 * spawnar visualmente, ou o processo reiniciou desde então), não há nada pra
 * apagar, e isso não é erro.
 */
function _despawnObject(id) {
  const cached = _activeObjectsById.get(id);
  const refDesc = cached?.ref_desc;
  _activeObjectsById.delete(id);
  if (!refDesc) return;
  if (typeof mp === 'undefined' || typeof mp.callPapyrusFunction !== 'function' || typeof mp.getIdFromDesc !== 'function') return;

  try {
    const refId = mp.getIdFromDesc(refDesc);
    if (!refId) return;
    const self = { type: 'form', desc: refDesc };
    mp.callPapyrusFunction('method', 'ObjectReference', 'Disable', self, []);
    mp.callPapyrusFunction('method', 'ObjectReference', 'Delete', self, []);
  } catch (err) {
    console.error(`[cell-persistence] Falha ao remover a referência viva de world_objects.id=${id}:`, err.message);
  }
}

/**
 * Pega um item do mundo: autoridade final do servidor sobre se ele ainda
 * existe (item 4 do pedido). O UPDATE condicional é o que decide sob
 * concorrência — dois jogadores clicando quase juntos, ou lag reapresentando
 * o mesmo clique, disputam a MESMA linha; só um vê `affectedRows === 1`. É o
 * mesmo padrão que `apps/game-api.consumeLaunchTicket` usa para uso único.
 *
 * A `idempotencyKey` do `giveItem` é uma SEGUNDA barreira, independente do
 * UPDATE: mesmo que alguém conseguisse chamar isto duas vezes para o mesmo
 * `id` (não deveria, dado o UPDATE), o ledger recusaria a segunda concessão.
 *
 * @param {number} id - world_objects.id
 * @param {number} actorId
 * @param {number} characterId
 * @returns {Promise<{ok: true} | {ok: false, reason: string}>}
 */
async function removeObject(id, actorId, characterId) {
  if (!Number.isInteger(id) || id <= 0) return { ok: false, reason: 'invalid_id' };

  const result = await db.query(
    `UPDATE world_objects SET state = 'looted' WHERE id = ? AND state = 'active'`,
    [id]
  );
  if (!result.affectedRows) return { ok: false, reason: 'already_gone' };

  const cached = _activeObjectsById.get(id);
  let baseId = cached?.base_id;
  if (!baseId) {
    const rows = await db.query('SELECT base_id FROM world_objects WHERE id = ?', [id]);
    baseId = rows[0]?.base_id;
  }

  _despawnObject(id);

  if (!baseId) {
    console.error(`[cell-persistence] world_objects.id=${id} marcado looted sem base_id resolvivel.`);
    return { ok: false, reason: 'missing_base_id' };
  }

  const given = await transactionService.giveItem({
    actorId, characterId, baseId, count: 1,
    reason: 'world_pickup', module: MODULE,
    idempotencyKey: `${MODULE}_pickup_${id}`
  });

  return given ? { ok: true } : { ok: false, reason: 'inventory_failed' };
}

/**
 * Reidrata uma célula: lê os objetos ativos e não-expirados de `world_objects`
 * e spawna cada um. Idempotente por processo — chamar duas vezes para a mesma
 * célula, enquanto ela seguir "já reidratada", não spawna em dobro. O cache
 * de idempotência é só em memória de propósito: um restart do processo é
 * exatamente o caso que deve reidratar de novo, porque toda referência viva
 * anterior morreu junto com o processo.
 *
 * @param {string} cellId
 * @param {number} spawnerActorId - ator cuja chegada disparou a reidratação
 * @returns {Promise<{spawned: number, skipped: 'already_hydrated'|null}>}
 */
async function rehydrateCell(cellId, spawnerActorId) {
  if (!cellId) return { spawned: 0, skipped: null };
  if (_rehydratedCells.has(cellId)) return { spawned: 0, skipped: 'already_hydrated' };

  const rows = await db.query(
    `SELECT id, base_id, pos_x, pos_y, pos_z, angle_z FROM world_objects
     WHERE cell_id = ? AND state = 'active' AND (expires_at IS NULL OR expires_at > NOW())`,
    [cellId]
  );

  for (const row of rows) {
    _spawnObject(spawnerActorId, { ...row, cell_id: cellId }, 'rehydrate');
  }

  _rehydratedCells.add(cellId);
  return { spawned: rows.length, skipped: null };
}

/**
 * Remove do banco todo objeto de lixo cujo TTL já passou. Objeto sem `state`
 * ativo (já saqueado/despawnado) fica de fora — não é este sweep que decide
 * isso. DELETE físico, não soft-delete: é lixo descartável por design, ao
 * contrário de personagem (CONTRIBUTING.md — nunca DELETE em personagem).
 *
 * @returns {Promise<number>} quantas linhas foram removidas
 */
async function sweepExpired() {
  // Precisa saber QUAIS ids somem, não só quantos, pra tirá-los de
  // `_activeObjectsById` — senão o resolvedor de alvo (síncrono, não consulta
  // o banco) continuaria oferecendo "Pegar" pra um item que o DELETE abaixo já
  // apagou, e o pickup falharia com `already_gone` em vez de simplesmente não
  // aparecer no menu.
  const expirados = await db.query(
    `SELECT id FROM world_objects WHERE state = 'active' AND expires_at IS NOT NULL AND expires_at <= NOW()`
  );
  for (const { id } of expirados) _despawnObject(id);

  const result = await db.query(
    `DELETE FROM world_objects WHERE state = 'active' AND expires_at IS NOT NULL AND expires_at <= NOW()`
  );
  return result.affectedRows || 0;
}

/**
 * Um tick: detecta troca de célula por polling (mesmo padrão de
 * `nametag-service.tick`) e varre expirados. Exportado para o teste rodar um
 * tick determinístico em vez de esperar o timer.
 */
async function tick() {
  if (typeof mp === 'undefined') return;

  // Ver o comentário de `_tickInFlight`: sem isto, um tick lento (muitos
  // jogadores) e o próximo `setInterval` disparando em cima dele podem
  // reidratar a mesma célula duas vezes. Pular o tick atrasado é seguro — o
  // próximo tick (2s depois) processa os mesmos atores do mesmo jeito, então
  // isto só atrasa a detecção de troca de célula, nunca perde uma.
  if (_tickInFlight) {
    console.warn('[cell-persistence] Tick anterior ainda em andamento — pulando este ciclo pra evitar reidratação em dobro.');
    return;
  }
  _tickInFlight = true;

  try {
    const presentes = new Set();
    for (const actorId of commands.listActiveActorIds()) {
      presentes.add(actorId);
      let loc;
      try {
        loc = mp.get(actorId, 'locationalData');
      } catch {
        continue;
      }
      if (!loc || !loc.pos) continue;

      const cellId = _cellDesc(loc);
      if (!cellId) continue;

      const anterior = _lastCellByActor.get(actorId);
      if (anterior === cellId) continue;

      _lastCellByActor.set(actorId, cellId);
      try {
        await rehydrateCell(cellId, actorId);
      } catch (err) {
        console.error(`[cell-persistence] Falha ao reidratar célula ${cellId}:`, err.message);
      }
    }

    for (const actorId of _lastCellByActor.keys()) {
      if (!presentes.has(actorId)) _lastCellByActor.delete(actorId);
    }

    try {
      await sweepExpired();
    } catch (err) {
      console.error('[cell-persistence] Falha na varredura de expirados:', err.message);
    }
  } finally {
    _tickInFlight = false;
  }
}

/**
 * Distância entre o ator e uma posição fixa do mundo (não outro ator).
 * `core/range-utils.js` só compara dois atores — um `world_objects` não tem
 * `locationalData` próprio a consultar por FormID quando não está spawnado
 * (célula não reidratada ainda), então a comparação é sempre contra a posição
 * GRAVADA no banco, nunca contra a referência viva.
 *
 * Mesma honestidade de `range-utils.assertRange`: sem `mp`, devolve
 * `unverified` em vez de fingir que mediu — é o que mantém isto testável sem
 * servidor.
 */
function _assertRangeToObject(actorId, targetPos, maxRange) {
  if (typeof mp === 'undefined') return { ok: true, unverified: true };
  let loc;
  try {
    loc = mp.get(actorId, 'locationalData');
  } catch {
    loc = null;
  }
  if (!loc || !loc.pos) return { ok: false, reason: 'Nao foi possivel validar proximidade.' };

  const [ax, ay, az] = loc.pos;
  const [ox, oy, oz] = targetPos;
  const distancia = Math.sqrt((ax - ox) ** 2 + (ay - oy) ** 2 + (az - oz) ** 2);
  if (distancia > maxRange) return { ok: false, reason: 'Alvo fora de alcance.' };
  return { ok: true };
}

/**
 * Registra o resolvedor de `TARGET_TYPES.OBJECT` no Interaction Framework —
 * ver o ADENDO no cabeçalho. `registerTargetResolver` é injetado (não
 * `require('./core/interaction-targets')` direto): a instância viva é criada
 * uma vez em `phase0-basic.js` e precisa ser A MESMA que `interaction-service`
 * consulta, não uma nova.
 */
function registerInteractionTarget(registerTargetResolver) {
  if (typeof registerTargetResolver !== 'function') return;

  registerTargetResolver(interactionRegistry.TARGET_TYPES.OBJECT, (rawTargetId, _actorId) => {
    const id = Number(rawTargetId);
    if (!Number.isSafeInteger(id) || id <= 0) return null;

    const cached = _activeObjectsById.get(id);
    if (!cached) return null; // sem dono aqui: ou nunca existiu, ou já foi pego/expirou

    return {
      type: interactionRegistry.TARGET_TYPES.OBJECT,
      id: `object:${cached.id}`,
      label: `Item (0x${cached.base_id.toString(16)})`,
      assertRange: (fromActorId, maxRange) =>
        _assertRangeToObject(fromActorId, [cached.pos_x, cached.pos_y, cached.pos_z], maxRange)
    };
  });
}

/**
 * Registra a interação `world_object.pickup` — "Pegar" no menu contextual
 * quando o alvo é um item dropado. `execute` é onde a autoridade final mora
 * (item 4 do pedido): `removeObject` refaz a checagem contra o banco, porque
 * `canSee`/o resolvedor rodaram sobre o cache, que pode estar desatualizado.
 *
 * O motivo específico da falha (`already_gone`, `inventory_failed`, ...) vai
 * pro `Error` lançado, que `core/interaction-service.js` grava em
 * `record(entry, ctx, 'error', err.message)` (auditoria/log do servidor) —
 * **não** é isso que o jogador vê. O pipeline converte qualquer `execute` que
 * lança na mesma notificação genérica ("Nao foi possivel concluir a acao."),
 * de propósito (`INTERACTION_FRAMEWORK.md` §10: "ação inexistente e ação
 * indisponível dão a mesma resposta... não transformar o menu num oráculo").
 * `/pegaritem`, o caminho por comando de chat, mostra o motivo específico,
 * porque ali quem está "sondando" já é o próprio dono da conta.
 */
function registerPickupInteraction() {
  actionPolicy.registerAction(PICKUP_POLICY_ACTION, ['gameplay', 'gather'], 'Pegar item do chão');

  interactionRegistry.register({
    id: 'world_object.pickup',
    module: MODULE,
    target: interactionRegistry.TARGET_TYPES.OBJECT,
    label: 'Pegar',
    section: 'mundo',
    order: 10,
    distance: PICKUP_RANGE,
    policyAction: PICKUP_POLICY_ACTION,
    audit: interactionRegistry.AUDIT_LEVELS.GAMEPLAY,
    idempotent: false,
    canSee: async (ctx) => _activeObjectsById.has(Number(ctx.target.id.split(':')[1])),
    execute: async (ctx) => {
      const objectId = Number(ctx.target.id.split(':')[1]);
      const resultado = await removeObject(objectId, ctx.actorId, ctx.characterId);
      if (!resultado.ok) throw new Error(`world_object.pickup falhou: ${'reason' in resultado ? resultado.reason : 'desconhecido'}`);
      return { message: 'Você pegou o item.' };
    }
  });
}

/**
 * O trecho que roda NO CLIENTE, dentro do Skyrim Platform (não na CEF).
 *
 * Mesma forma de `nametag-service.SNIPPET_DO_CLIENTE`: registrado via
 * `mp.makeProperty(..., {updateOwner: ...})`, instala o loop uma vez
 * (`ct.state.worldObjectCrosshair.ligado`) e empurra pra CEF via
 * `executeJavaScript`, throttlado — não every quadro.
 *
 * `ctx.getFormIdInServerFormat` é obrigatório (mesmo par que
 * `core/hit-events.js` já usa e documenta): o FormID que
 * `getCurrentCrosshairRef().getFormID()` devolve é do espaço do CLIENTE.
 *
 * NUNCA visto rodando — ver o ADENDO no cabeçalho deste arquivo.
 */
const CROSSHAIR_INTERVALO_MS = 150;

const CROSSHAIR_SNIPPET_DO_CLIENTE = `
  ctx.state.worldObjectCrosshair = ctx.state.worldObjectCrosshair || { ligado: false, ultimoEnvio: 0, ultimoFormId: null };
  var wc = ctx.state.worldObjectCrosshair;

  if (!wc.ligado) {
    wc.ligado = true;

    ctx.sp.on('update', function () {
      try {
        var agora = Date.now();
        if (agora - wc.ultimoEnvio < ${CROSSHAIR_INTERVALO_MS}) return;
        wc.ultimoEnvio = agora;

        var ref = ctx.sp.Game.getCurrentCrosshairRef ? ctx.sp.Game.getCurrentCrosshairRef() : null;
        var formIdServidor = null;
        if (ref) {
          var formIdCliente = ref.getFormID();
          formIdServidor = ctx.getFormIdInServerFormat(formIdCliente);
        }

        if (formIdServidor === wc.ultimoFormId) return;
        wc.ultimoFormId = formIdServidor;

        if (!ctx.sp.browser || !ctx.sp.browser.executeJavaScript) return;
        ctx.sp.browser.executeJavaScript(
          'window.handleWorldObjectCrosshair && window.handleWorldObjectCrosshair(' + JSON.stringify({ formId: formIdServidor }) + ')'
        );
      } catch (e) {
        // Erro aqui roda no cliente e nao tem pra onde ir. Engolir e o certo:
        // derrubar o handler mataria a deteccao de mira pelo resto da sessao.
      }
    });
  }
`;

function initCellPersistenceService(deps = {}) {
  registerInteractionTarget(deps.registerTargetResolver);
  registerPickupInteraction();

  if (_timer) return;
  _timer = setInterval(() => {
    tick().catch((err) => console.error('[cell-persistence] Falha no tick:', err.message));
  }, TICK_INTERVAL_MS);
  if (typeof _timer.unref === 'function') _timer.unref();
  console.log('[cell-persistence] Serviço ativo. NÃO validado em jogo — ver o cabeçalho do arquivo.');
}

function shutdownCellPersistenceService() {
  if (_timer) clearInterval(_timer);
  _timer = null;
  _tickInFlight = false;
  _lastCellByActor.clear();
  _rehydratedCells.clear();
  _activeObjectsById.clear();
  // A interação é removida automaticamente pelo module-registry
  // (`shutdownAll()` chama `interactionRegistry.unregisterModule(MODULE)`
  // para todo módulo) — não duplicar essa limpeza aqui.
}

/**
 * Só para teste: simula um restart do processo sem perder o que está no
 * banco. Limpa TODO cache em memória, `_activeObjectsById` incluso — um
 * restart real perde tudo que não é linha de banco. `rehydrateCell` repovoa
 * `_activeObjectsById` a partir do banco (via `_spawnObject`) assim que a
 * célula for reidratada de novo; até lá, o resolvedor de alvo corretamente
 * não vê o objeto — é o mesmo "nunca reidratado" de antes do primeiro drop.
 */
function _resetInMemoryCaches() {
  _lastCellByActor.clear();
  _rehydratedCells.clear();
  _activeObjectsById.clear();
  _tickInFlight = false;
}

module.exports = {
  MODULE,
  ALWAYS_PERSIST_CATEGORIES,
  MIN_VALUE_THRESHOLD,
  JUNK_TTL_MS,
  TICK_INTERVAL_MS,
  PICKUP_RANGE,
  PICKUP_POLICY_ACTION,
  CROSSHAIR_INTERVALO_MS,
  CROSSHAIR_SNIPPET_DO_CLIENTE,
  classifyPersistence,
  recordDrop,
  rehydrateCell,
  sweepExpired,
  removeObject,
  tick,
  registerInteractionTarget,
  registerPickupInteraction,
  initCellPersistenceService,
  shutdownCellPersistenceService,
  _resetInMemoryCaches,
  _lastCellByActor,
  _rehydratedCells,
  _activeObjectsById
};
