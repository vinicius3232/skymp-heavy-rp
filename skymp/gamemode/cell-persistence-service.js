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
 */

const db = require('./database');
const commands = require('./commands');
const transactionService = require('./core/transaction-service');
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

/** actorId → cellId onde ele estava no último tick, para detectar troca sem evento. */
const _lastCellByActor = new Map();

/** cellId → true, para não reidratar a mesma célula duas vezes enquanto ela já está ativa. */
const _rehydratedCells = new Set();

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

    _spawnObject(actorId, { id: result.insertId, base_id: baseId, pos_x: posX, pos_y: posY, pos_z: posZ, angle_z: angleZ });
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
function _spawnObject(spawnerActorId, row) {
  if (typeof mp === 'undefined' || typeof mp.callPapyrusFunction !== 'function') return null;
  if (typeof mp.getDescFromId !== 'function') {
    console.warn('[cell-persistence] Spawn indisponível: mp.getDescFromId ausente, sem self válido pro Papyrus.');
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
      return null;
    }

    mp.set(refId, 'pos', [row.pos_x, row.pos_y, row.pos_z]);
    mp.set(refId, 'angle', [0, 0, row.angle_z || 0]);

    const refDesc = typeof mp.getDescFromId === 'function' ? mp.getDescFromId(refId) : null;
    if (refDesc) {
      db.query('UPDATE world_objects SET ref_desc = ? WHERE id = ?', [refDesc, row.id]).catch((err) => {
        console.error(`[cell-persistence] Falha ao gravar ref_desc de world_objects.id=${row.id}:`, err.message);
      });
    }
    return refId;
  } catch (err) {
    console.error(`[cell-persistence] Falha ao spawnar world_objects.id=${row.id}:`, err.message);
    return null;
  }
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
    _spawnObject(spawnerActorId, row);
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
}

function initCellPersistenceService() {
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
  _lastCellByActor.clear();
  _rehydratedCells.clear();
}

/** Só para teste: simula um restart do processo sem perder o que está no banco. */
function _resetInMemoryCaches() {
  _lastCellByActor.clear();
  _rehydratedCells.clear();
}

module.exports = {
  MODULE,
  ALWAYS_PERSIST_CATEGORIES,
  MIN_VALUE_THRESHOLD,
  JUNK_TTL_MS,
  TICK_INTERVAL_MS,
  classifyPersistence,
  recordDrop,
  rehydrateCell,
  sweepExpired,
  tick,
  initCellPersistenceService,
  shutdownCellPersistenceService,
  _resetInMemoryCaches,
  _lastCellByActor,
  _rehydratedCells
};
