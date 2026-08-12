/**
 * core/character-state.js
 *
 * Máquina de estados de personagens.
 *
 * Estados possíveis:
 *   NORMAL      - Sem restrições
 *   BUSY        - Em animação canalizada (minerar, pescar, etc.)
 *   DOWNED      - Abatido, aguardando socorro (persistente no BD)
 *   DEAD        - Morto (transição para DOWNED após estabilização falhar)
 *   RESTRAINED  - Algemado/amarrado (persistente no BD via character_restraints)
 *   IMPRISONED  - Na prisão (persistente no BD via prison_records)
 *   IN_TRADE    - Em negociação com outro jogador
 *   IN_CRAFT    - Em processo de fabricação
 *   IN_DIALOG   - Em diálogo/menu com NPC ou sistema
 *   DISCONNECTED - Sessão encerrada (removido do cache em memória)
 *
 * Estratégia de persistência:
 *   - Estados de SESSÃO (BUSY, IN_TRADE, IN_CRAFT, IN_DIALOG): apenas memória.
 *     Resetam automaticamente na desconexão.
 *   - Estados DURÁVEIS (IMPRISONED, RESTRAINED, DOWNED): carregados do banco no login,
 *     persistidos imediatamente ao setar.
 */

const db = require('../database');

// Estados válidos
const STATES = Object.freeze({
  NORMAL:       'NORMAL',
  BUSY:         'BUSY',
  DOWNED:       'DOWNED',
  DEAD:         'DEAD',
  RESTRAINED:   'RESTRAINED',
  IMPRISONED:   'IMPRISONED',
  IN_TRADE:     'IN_TRADE',
  IN_CRAFT:     'IN_CRAFT',
  IN_DIALOG:    'IN_DIALOG',
  DISCONNECTED: 'DISCONNECTED'
});

/**
 * @typedef {'NORMAL'|'BUSY'|'DOWNED'|'DEAD'|'RESTRAINED'|'IMPRISONED'|'IN_TRADE'|'IN_CRAFT'|'IN_DIALOG'|'DISCONNECTED'} CharacterState
 */

// Estados que sobrevivem a restarts (carregados do BD no login)
/** @type {Set<CharacterState>} */
const DURABLE_STATES = new Set([STATES.IMPRISONED, STATES.RESTRAINED, STATES.DOWNED]);

// Cache em memória: characterId → { state, metadata, setAt }
/** @type {Map<number, {state: CharacterState, metadata: object, setAt: number}>} */
const _stateCache = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// Internal
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Carrega o estado durável de um personagem do banco de dados.
 * Chamado no login (whitelist.js).
 * @param {number} characterId
 * @returns {Promise<{state: CharacterState, metadata: object}>}
 */
async function _loadDurableState(characterId) {
  try {
    // Verifica prisão ativa
    const imprisoned = await db.query(
      `SELECT id, crime_summary, sentence_minutes, time_served_minutes, cell_id
       FROM prison_records
       WHERE character_id = ? AND status = 'active'
       ORDER BY arrested_at DESC LIMIT 1`,
      [characterId]
    );
    if (imprisoned.length > 0) {
      return { state: STATES.IMPRISONED, metadata: imprisoned[0] };
    }

    // Verifica algemas ativas
    const restrained = await db.query(
      `SELECT type, restrained_by_character_id, applied_at
       FROM character_restraints
       WHERE character_id = ?`,
      [characterId]
    );
    if (restrained.length > 0) {
      return { state: STATES.RESTRAINED, metadata: restrained[0] };
    }

    // Estado padrão
    return { state: STATES.NORMAL, metadata: {} };
  } catch (err) {
    console.error(`[character-state] Erro ao carregar estado durável para char ${characterId}:`, err.message);
    return { state: STATES.NORMAL, metadata: {} };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// API Pública
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Inicializa o estado de um personagem ao entrar no servidor.
 * Carrega estados duráveis do banco de dados.
 * @param {number} characterId
 * @returns {Promise<CharacterState>} Estado inicial
 */
async function initialize(characterId) {
  const { state, metadata } = await _loadDurableState(characterId);
  _stateCache.set(characterId, { state, metadata, setAt: Date.now() });
  console.log(`[character-state] char=${characterId} inicializado como ${state}`);
  return state;
}

/**
 * Retorna o estado atual de um personagem.
 * @param {number} characterId
 * @returns {CharacterState} Estado atual ou NORMAL se não encontrado
 */
function get(characterId) {
  const entry = _stateCache.get(characterId);
  return entry ? entry.state : STATES.NORMAL;
}

/**
 * Retorna os metadados do estado atual.
 * @param {number} characterId
 * @returns {object}
 */
function getMetadata(characterId) {
  const entry = _stateCache.get(characterId);
  return entry ? entry.metadata : {};
}

/**
 * Verifica se o personagem está em um estado específico.
 * @param {number} characterId
 * @param {CharacterState|CharacterState[]} states - Estado ou lista de estados
 * @returns {boolean}
 */
function is(characterId, states) {
  const current = get(characterId);
  if (Array.isArray(states)) return states.includes(current);
  return current === states;
}

/**
 * Define o estado de um personagem.
 * Estados duráveis (IMPRISONED, RESTRAINED, DOWNED) são persistidos no BD automaticamente via
 * seus próprios serviços (governance-service, death-service). Este método apenas atualiza o cache.
 *
 * @param {number} characterId
 * @param {CharacterState} newState - Um dos STATES válidos
 * @param {object} [metadata] - Dados adicionais sobre o estado
 */
function set(characterId, newState, metadata = {}) {
  if (!Object.values(STATES).includes(newState)) {
    throw new Error(`[character-state] Estado inválido: ${newState}`);
  }
  const previous = get(characterId);
  _stateCache.set(characterId, { state: newState, metadata, setAt: Date.now() });
  console.log(`[character-state] char=${characterId}: ${previous} → ${newState}`);
}

/**
 * Reseta o estado de um personagem para NORMAL (apenas estados de sessão).
 * Não afeta estados duráveis que devem ser resolvidos pelos seus próprios serviços.
 * @param {number} characterId
 */
function reset(characterId) {
  const current = get(characterId);
  if (!DURABLE_STATES.has(current)) {
    set(characterId, STATES.NORMAL, {});
  } else {
    console.log(`[character-state] char=${characterId} mantém estado durável ${current} no reset`);
  }
}

/**
 * Remove o personagem do cache ao desconectar.
 * Estados duráveis já estão no banco de dados.
 * @param {number} characterId
 */
function cleanup(characterId) {
  _stateCache.delete(characterId);
  console.log(`[character-state] char=${characterId} removido do cache`);
}

module.exports = { STATES, DURABLE_STATES, initialize, get, getMetadata, is, set, reset, cleanup };
