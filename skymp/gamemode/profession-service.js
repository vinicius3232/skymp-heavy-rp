/**
 * profession-service.js
 *
 * **O Profession Core.** Concessão, revogação, suspensão, rank e XP de
 * profissão de personagem — e nada de gameplay.
 *
 * ─── O que este arquivo explicitamente NÃO faz ──────────────────────────────
 *
 * Nenhuma mineração, corte de árvore, caça, crafting ou contrato mora aqui.
 * `core/profession-registry.js` já documenta a diferença entre uma profissão
 * estar REGISTRADA (existe no catálogo), ESTAR ENABLED (pode ser concedida) e
 * ter GAMEPLAY IMPLEMENTADO (existe automação por trás) — este arquivo lida só
 * com a primeira e a segunda. As treze profissões desta fase não têm a
 * terceira, e nenhuma linha abaixo assume que têm.
 *
 * ─── Onde fica a decisão "pode fazer isso agora?" ───────────────────────────
 *
 * NÃO aqui. Quem decide "este cargo pode conceder profissão?" é
 * `core/permissions.js`, através do pipeline em `admin-actions.js` — este
 * arquivo é o SERVIÇO DE DOMÍNIO que o pipeline chama depois de já ter
 * decidido isso, exatamente como `admin-service.giveItemAdmin` é chamado pela
 * ação `inventory.grant`. Por isso nenhuma função aqui recebe `role` ou
 * `actorId`: elas recebem `characterId`, já resolvido.
 *
 * A única checagem de autorização que VIVE aqui é `moduleRegistry
 * .isEnabled('profession')` — não é uma permissão de cargo, é o interruptor de
 * "este servidor ligou o framework" (§17 do briefing: "nunca habilitar
 * automaticamente em produção"). Ela é verificada nesta camada, e não só no
 * `precondition` do admin-action, porque este módulo pode um dia ganhar um
 * segundo consumidor (ResourceNode) que não passa pelo pipeline — e o
 * interruptor precisa valer para os dois.
 *
 * ─── Resultado tipado, não booleano (mesma convenção de core/economy-service) ─
 *
 * Toda função de escrita devolve `{ok:true, data}` ou `{ok:false, code,
 * message}` para recusa ESPERADA (profissão já ativa, limite atingido, rank
 * fora da faixa). Erro de infraestrutura (banco fora do ar) LANÇA. Os dois
 * nunca se confundem: a diferença é a que já custou caro neste projeto em
 * outro serviço (Achado 7 de `ECONOMY_FRAMEWORK_AUDIT.md`) — timeout de rede
 * virando "profissão negada" seria a mesma classe de bug.
 *
 * ─── Concorrência ────────────────────────────────────────────────────────────
 *
 * `grantProfession` e `reactivateProfession` travam as linhas ATIVAS do
 * personagem (`SELECT ... WHERE character_id = ? AND status = 'active' FOR
 * UPDATE`) antes de contar contra `profession.maxPerCharacter`. Sob
 * REPEATABLE READ (padrão do InnoDB), isso toma next-key lock sobre a faixa do
 * índice `idx_charprof_character` — duas concessões concorrentes para o MESMO
 * personagem serializam, então nenhuma delas dá 4 profissões com o limite em 3.
 * Ver o comentário equivalente em `core/transaction-service.js
 * ._applyGoldDelta`.
 */

'use strict';

const database = require('./database');
const professionRegistry = require('./core/profession-registry');
const moduleRegistry = require('./core/module-registry');
const serverOptions = require('./core/server-options');

// ─────────────────────────────────────────────────────────────────────────────
// Vocabulário
// ─────────────────────────────────────────────────────────────────────────────

const MODULE_ID = 'profession';

/**
 * `active`   — a profissão autoriza gameplay futuro e conta contra o limite.
 * `suspended`— staff tirou temporariamente; NÃO autoriza gameplay, NÃO conta
 *              contra o limite enquanto suspensa, mas o histórico (rank/XP)
 *              fica. Só volta a `active` por `reactivateProfession`.
 * `revoked`  — encerrada. A linha NÃO é apagada (§8 do briefing): rank/XP
 *              ficam como histórico, e `grantProfession` sobre um código
 *              revogado reaproveita a mesma linha em vez de inserir outra.
 */
const STATUS = Object.freeze({
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  REVOKED: 'revoked'
});

/**
 * Teto de XP em INT UNSIGNED da coluna, mesma lógica de `MAX_GOLD` em
 * `core/transaction-service.js`: um incremento que estourasse a coluna
 * satura em silêncio no modo não-estrito do MySQL em vez de falhar.
 */
const MAX_XP = 2147483647;

// ─────────────────────────────────────────────────────────────────────────────
// Auxiliares
// ─────────────────────────────────────────────────────────────────────────────

/** @param {object} dependencies */
function _deps(dependencies = {}) {
  return {
    db: dependencies.db || database,
    registry: dependencies.registry || professionRegistry,
    moduleRegistry: dependencies.moduleRegistry || moduleRegistry,
    serverOptions: dependencies.serverOptions || serverOptions
  };
}

function _isModuleEnabled(deps) {
  return deps.moduleRegistry.isEnabled(MODULE_ID);
}

function _rowToState(row) {
  if (!row) return null;
  return {
    characterId: row.character_id,
    professionCode: row.profession_code,
    status: row.status,
    rank: row.rank,
    xp: row.xp,
    grantedByCharacterId: row.granted_by_character_id,
    joinedAt: row.joined_at,
    updatedAt: row.updated_at
  };
}

function _isPositiveInt(v) {
  return Number.isSafeInteger(v) && v > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Consultas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Todas as linhas do personagem, qualquer status. Quem quer só as ativas
 * filtra o resultado — a API não esconde histórico de quem pediu tudo.
 * @param {number} characterId
 * @param {object} [dependencies]
 */
async function getCharacterProfessions(characterId, dependencies = {}) {
  const deps = _deps(dependencies);
  if (!_isPositiveInt(characterId)) throw new Error('[profession-service] characterId inválido');
  const rows = await deps.db.query(
    'SELECT * FROM character_professions WHERE character_id = ? ORDER BY profession_code',
    [characterId]
  );
  return rows.map(_rowToState);
}

/** @param {number} characterId @param {string} professionCode @param {object} [dependencies] */
async function getProfessionState(characterId, professionCode, dependencies = {}) {
  const deps = _deps(dependencies);
  if (!_isPositiveInt(characterId)) throw new Error('[profession-service] characterId inválido');
  const rows = await deps.db.query(
    'SELECT * FROM character_professions WHERE character_id = ? AND profession_code = ?',
    [characterId, professionCode]
  );
  return rows.length > 0 ? _rowToState(rows[0]) : null;
}

/**
 * `true` apenas quando a profissão está ATIVA — suspensa não autoriza
 * gameplay (§8 do briefing), então não conta como "tem a profissão" para
 * quem for consultar isto antes de liberar uma ação futura.
 * @param {number} characterId @param {string} professionCode @param {object} [dependencies]
 */
async function hasProfession(characterId, professionCode, dependencies = {}) {
  const state = await getProfessionState(characterId, professionCode, dependencies);
  return !!state && state.status === STATUS.ACTIVE;
}

// ─────────────────────────────────────────────────────────────────────────────
// Concessão
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Conta quantas profissões ATIVAS o personagem tem, travando as linhas
 * envolvidas — deve ser chamada dentro da transação do chamador.
 * @param {object} conn
 * @param {number} characterId
 */
async function _lockActiveCount(conn, characterId) {
  const [rows] = await conn.query(
    "SELECT id FROM character_professions WHERE character_id = ? AND status = 'active' FOR UPDATE",
    [characterId]
  );
  return rows.length;
}

/**
 * Concede uma profissão. Se já existir uma linha REVOGADA para o mesmo par
 * (character, profissão), reaproveita a linha — rank e XP antigos voltam a
 * valer. Isto é uma decisão explícita, não a única leitura possível do §8 do
 * briefing: a alternativa (zerar rank/XP num "recomeço") é razoável também.
 * Documentado em docs/gameplay/PROFESSION_FRAMEWORK.md §"Reconceder após
 * revogar" para quem quiser trocar o comportamento.
 *
 * @param {object} opts
 * @param {number} opts.characterId
 * @param {string} opts.professionCode
 * @param {number|null} [opts.grantedByCharacterId]
 * @param {object} [dependencies]
 * @returns {Promise<{ok:true,data:object}|{ok:false,code:string,data?:object}>}
 */
async function grantProfession(opts, dependencies = {}) {
  const deps = _deps(dependencies);
  const { characterId, professionCode, grantedByCharacterId = null } = opts || {};

  if (!_isModuleEnabled(deps)) return { ok: false, code: 'module_disabled' };
  if (!_isPositiveInt(characterId)) return { ok: false, code: 'invalid_character' };

  const validacao = deps.registry.validate(professionCode);
  if (!validacao.ok) return { ok: false, code: validacao.reason };

  const maxPerCharacter = deps.serverOptions.get('profession.maxPerCharacter');

  const conn = await deps.db.getConnection();
  try {
    await conn.beginTransaction();

    const [existentes] = await conn.query(
      'SELECT id, status, rank, xp FROM character_professions WHERE character_id = ? AND profession_code = ? FOR UPDATE',
      [characterId, professionCode]
    );
    const existente = existentes[0] || null;

    if (existente && existente.status === STATUS.ACTIVE) {
      await conn.rollback();
      return { ok: false, code: 'already_active' };
    }
    if (existente && existente.status === STATUS.SUSPENDED) {
      await conn.rollback();
      return { ok: false, code: 'suspended_use_reactivate' };
    }

    const ativos = await _lockActiveCount(conn, characterId);
    if (ativos >= maxPerCharacter) {
      await conn.rollback();
      return { ok: false, code: 'max_professions_reached', data: { max: maxPerCharacter, active: ativos } };
    }

    if (existente) {
      // Reaproveita a linha revogada.
      await conn.query(
        "UPDATE character_professions SET status = 'active', granted_by_character_id = ?, joined_at = CURRENT_TIMESTAMP WHERE id = ?",
        [grantedByCharacterId, existente.id]
      );
    } else {
      await conn.query(
        `INSERT INTO character_professions
          (character_id, profession_code, status, rank, xp, granted_by_character_id)
         VALUES (?, ?, 'active', 0, 0, ?)`,
        [characterId, professionCode, grantedByCharacterId]
      );
    }

    await conn.commit();
    const estado = await getProfessionState(characterId, professionCode, dependencies);
    return { ok: true, data: estado };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Revogação / suspensão / reativação
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Transição de status genérica: trava a linha, confere o status de origem
 * exigido e escreve o novo. As quatro operações de ciclo de vida
 * (revoke/suspend/reactivate) são a mesma forma com origem/destino
 * diferentes — uma função só evita quatro cópias do mesmo `FOR UPDATE`.
 *
 * @param {object} opts
 * @param {number} opts.characterId
 * @param {string} opts.professionCode
 * @param {string[]} opts.fromStatuses status de origem aceitos
 * @param {string} opts.toStatus
 * @param {string} opts.wrongStatusCode código de recusa se o status atual não bate
 * @param {boolean} [opts.recheckCapacity] confere o limite antes de escrever (reativação)
 * @param {object} deps
 */
async function _transition(opts, deps) {
  const { characterId, professionCode, fromStatuses, toStatus, wrongStatusCode, recheckCapacity } = opts;

  if (!_isModuleEnabled(deps)) return { ok: false, code: 'module_disabled' };
  if (!_isPositiveInt(characterId)) return { ok: false, code: 'invalid_character' };

  const conn = await deps.db.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      'SELECT id, status FROM character_professions WHERE character_id = ? AND profession_code = ? FOR UPDATE',
      [characterId, professionCode]
    );
    const linha = rows[0] || null;

    if (!linha) {
      await conn.rollback();
      return { ok: false, code: 'not_found' };
    }
    if (!fromStatuses.includes(linha.status)) {
      await conn.rollback();
      return { ok: false, code: wrongStatusCode, data: { currentStatus: linha.status } };
    }

    if (recheckCapacity) {
      const maxPerCharacter = deps.serverOptions.get('profession.maxPerCharacter');
      const ativos = await _lockActiveCount(conn, characterId);
      if (ativos >= maxPerCharacter) {
        await conn.rollback();
        return { ok: false, code: 'max_professions_reached', data: { max: maxPerCharacter, active: ativos } };
      }
    }

    await conn.query('UPDATE character_professions SET status = ? WHERE id = ?', [toStatus, linha.id]);
    await conn.commit();

    return { ok: true, data: await getProfessionState(characterId, professionCode, { db: deps.db }) };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/** @param {{characterId:number, professionCode:string}} opts @param {object} [dependencies] */
async function revokeProfession(opts, dependencies = {}) {
  const deps = _deps(dependencies);
  return _transition({
    ...opts,
    fromStatuses: [STATUS.ACTIVE, STATUS.SUSPENDED],
    toStatus: STATUS.REVOKED,
    wrongStatusCode: 'already_revoked'
  }, deps);
}

/** @param {{characterId:number, professionCode:string}} opts @param {object} [dependencies] */
async function suspendProfession(opts, dependencies = {}) {
  const deps = _deps(dependencies);
  return _transition({
    ...opts,
    fromStatuses: [STATUS.ACTIVE],
    toStatus: STATUS.SUSPENDED,
    wrongStatusCode: 'not_active'
  }, deps);
}

/**
 * Volta uma profissão SUSPENSA para ativa. Reconta contra
 * `profession.maxPerCharacter` — suspender uma e conceder outra até o limite,
 * depois reativar a primeira, não pode furar o teto por trás.
 * @param {{characterId:number, professionCode:string}} opts @param {object} [dependencies]
 */
async function reactivateProfession(opts, dependencies = {}) {
  const deps = _deps(dependencies);
  return _transition({
    ...opts,
    fromStatuses: [STATUS.SUSPENDED],
    toStatus: STATUS.ACTIVE,
    wrongStatusCode: 'not_suspended',
    recheckCapacity: true
  }, deps);
}

// ─────────────────────────────────────────────────────────────────────────────
// Rank
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {number} opts.characterId
 * @param {string} opts.professionCode
 * @param {number} opts.rank inteiro, 0..profession.maxRank
 * @param {object} [dependencies]
 */
async function setProfessionRank(opts, dependencies = {}) {
  const deps = _deps(dependencies);
  const { characterId, professionCode, rank } = opts || {};

  if (!_isModuleEnabled(deps)) return { ok: false, code: 'module_disabled' };
  if (!_isPositiveInt(characterId)) return { ok: false, code: 'invalid_character' };

  const maxRank = deps.serverOptions.get('profession.maxRank');
  if (!Number.isInteger(rank) || rank < 0 || rank > maxRank) {
    return { ok: false, code: 'invalid_rank', data: { min: 0, max: maxRank } };
  }

  const conn = await deps.db.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      'SELECT id, status, rank FROM character_professions WHERE character_id = ? AND profession_code = ? FOR UPDATE',
      [characterId, professionCode]
    );
    const linha = rows[0] || null;

    if (!linha) {
      await conn.rollback();
      return { ok: false, code: 'not_found' };
    }
    if (linha.status !== STATUS.ACTIVE) {
      await conn.rollback();
      return { ok: false, code: 'not_active', data: { currentStatus: linha.status } };
    }

    const rankAnterior = linha.rank;
    await conn.query('UPDATE character_professions SET rank = ? WHERE id = ?', [rank, linha.id]);
    await conn.commit();

    return { ok: true, data: { previousRank: rankAnterior, rank } };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// XP
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ajusta o XP de profissão. `amount` negativo só é aceito quando
 * `staffCharacterId` está presente — é o que a §10 do briefing pede
 * ("rejeitar negativo se operação não for administrativa explícita"), e é
 * verificado AQUI, não só na camada de admin action, porque esta função é a
 * API pública que um consumidor futuro (ResourceNode, crafting) vai chamar
 * direto, sem passar pelo pipeline — e o convite para dar XP negativo sem
 * motivo administrativo não pode depender de quem está chamando lembrar de
 * checar isso de novo.
 *
 * XP nunca fica negativo: um decremento maior que o saldo zera em vez de
 * lançar, porque "staff tirou XP demais por engano" é uma correção normal, não
 * um erro de programação.
 *
 * @param {object} opts
 * @param {number} opts.characterId
 * @param {string} opts.professionCode
 * @param {number} opts.amount inteiro, != 0
 * @param {string} [opts.context] de onde veio o ganho (ex: 'admin_adjust'; 'gather' em fases futuras)
 * @param {number|null} [opts.staffCharacterId] presença = ajuste administrativo, autoriza amount negativo
 * @param {object} [dependencies]
 */
async function addProfessionXp(opts, dependencies = {}) {
  const deps = _deps(dependencies);
  const { characterId, professionCode, amount, staffCharacterId = null } = opts || {};

  if (!_isModuleEnabled(deps)) return { ok: false, code: 'module_disabled' };
  if (!_isPositiveInt(characterId)) return { ok: false, code: 'invalid_character' };
  if (!Number.isSafeInteger(amount) || amount === 0) return { ok: false, code: 'invalid_amount' };
  if (amount < 0 && !_isPositiveInt(staffCharacterId)) {
    return { ok: false, code: 'negative_requires_admin' };
  }

  const conn = await deps.db.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      'SELECT id, status, xp FROM character_professions WHERE character_id = ? AND profession_code = ? FOR UPDATE',
      [characterId, professionCode]
    );
    const linha = rows[0] || null;

    if (!linha) {
      await conn.rollback();
      return { ok: false, code: 'not_found' };
    }
    if (linha.status !== STATUS.ACTIVE) {
      await conn.rollback();
      return { ok: false, code: 'not_active', data: { currentStatus: linha.status } };
    }

    const xpAnterior = Number(linha.xp);
    const xpNovo = Math.max(0, Math.min(MAX_XP, xpAnterior + amount));

    await conn.query('UPDATE character_professions SET xp = ? WHERE id = ?', [xpNovo, linha.id]);
    await conn.commit();

    return { ok: true, data: { previousXp: xpAnterior, xp: xpNovo, delta: xpNovo - xpAnterior } };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Comando de jogador — só leitura, só a própria ficha
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `/profissoes` — o jogador vê as próprias profissões. Sem capability: não é
 * ação de staff, é leitura da própria ficha, do mesmo jeito que `/status` (em
 * `commands.js`) não pede permissão para o jogador ver o próprio personagem.
 */
function commandDefs() {
  return [
    {
      name: '/profissoes',
      description: 'Mostra suas profissões',
      usage: '/profissoes',
      handler: async (actorId) => {
        // `sendNotification` (não `mp.sendChatMessage`, que não existe nesta
        // API) é o único caminho de notificação individual do gamemode — ver
        // commands.js. `require` preguiçoso pelo mesmo motivo do resto do
        // arquivo: commands.js registra este comando, então importá-lo no
        // topo fecharia o ciclo.
        const commands = require('./commands');
        const personagem = commands.getActiveCharacterData(actorId);
        if (!personagem) return;

        const estados = await getCharacterProfessions(personagem.characterId);
        if (estados.length === 0) {
          commands.sendNotification(actorId, '[Profissões] Você não tem nenhuma profissão.');
          return;
        }
        const linhas = estados.map((estado) => {
          const prof = professionRegistry.get(estado.professionCode);
          const nome = prof ? prof.label : estado.professionCode;
          return `${nome} — status=${estado.status} rank=${estado.rank} xp=${estado.xp}`;
        });
        commands.sendNotification(actorId, `[Profissões]\n${linhas.join('\n')}`);
      }
    }
  ];
}

module.exports = {
  MODULE_ID,
  STATUS,
  MAX_XP,
  getCharacterProfessions,
  getProfessionState,
  hasProfession,
  grantProfession,
  revokeProfession,
  suspendProfession,
  reactivateProfession,
  setProfessionRank,
  addProfessionXp,
  commandDefs,
  // Exposto só para teste.
  _rowToState
};
