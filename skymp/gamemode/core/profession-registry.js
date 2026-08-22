/**
 * core/profession-registry.js
 *
 * O catálogo de profissões, e nada além dele.
 *
 * ─── O que este arquivo NÃO é ───────────────────────────────────────────────
 *
 * Não fala com o banco, não conhece `characterId`, não sabe o que é um grant.
 * Isso é `profession-service.js`. Este arquivo responde uma pergunta só: "que
 * profissões existem, e em que estado está cada uma?" — do mesmo jeito que
 * `core/module-registry.js` responde "que módulos existem?" sem saber o que
 * cada módulo faz por dentro.
 *
 * ─── `registered` × `enabled` × `gameplayImplemented` ───────────────────────
 *
 * Três flags porque são três perguntas diferentes, e confundi-las é o que a
 * Fase 0 pediu para evitar (§4 do briefing de profissões):
 *
 *   - `registered`           — a profissão está no catálogo. Sempre `true` para
 *                               quem `get()`/`list()` devolve; a distinção existe
 *                               só para `isRegistered()` sobre um código que
 *                               ninguém registrou.
 *   - `enabled`               — a profissão pode ser concedida HOJE. É o
 *                               interruptor administrativo: uma profissão
 *                               desativada aqui nega `grantProfession` mesmo que
 *                               esteja no catálogo.
 *   - `gameplayImplemented`   — existe sistema automatizado por trás (nó de
 *                               recurso, receita, contrato). **Nenhuma das treze
 *                               profissões desta fase tem isso.** Registrar
 *                               `miner` não significa que existe mineração —
 *                               significa que um staff já pode designar alguém
 *                               como minerador para fins de RP e progressão,
 *                               antes de qualquer ResourceNode existir.
 *
 * `grantProfession` (em `profession-service.js`) checa `enabled`, nunca
 * `gameplayImplemented`. Exigir gameplay implementado para conceder a profissão
 * inverteria a ordem natural do RP: a guilda aceita o aprendiz antes de existir
 * automação nenhuma para o trabalho dele.
 *
 * ─── Por que isto é um registry e não uma constante exportada ───────────────
 *
 * Duas razões, e a primeira é a que importa agora: `_reset()` +
 * `registerBuiltins()` dá aos testes o mesmo isolamento que
 * `core/module-registry.js` já tem. A segunda é o objetivo declarado da §33 do
 * briefing — permitir profissão nova sem tocar o núcleo — que só existe se
 * houver um `register()` para ela entrar, em vez de um array que cada consumidor
 * precisaria re-exportar e concatenar.
 */

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Forma do código
// ─────────────────────────────────────────────────────────────────────────────

/** Minúsculo, com `_` entre palavras — a mesma forma de `module-registry` ids. */
const CODE_SHAPE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

/**
 * Categorias conhecidas. Fechada pelo mesmo motivo que `core/audit-event.js`
 * fecha `CATEGORIES`: categoria livre vira, em seis meses, quatro grafias para a
 * mesma coisa.
 */
const CATEGORIES = Object.freeze({
  gathering: 'Extrai recurso bruto do mundo (minério, madeira, caça, colheita).',
  crafting: 'Transforma recurso bruto em produto (fundição, forja, curtume, cozinha, encantamento).',
  service: 'Presta serviço a outro jogador ou à cidade (tratador de cavalos, taberneiro, mensageiro).',
  institutional: 'Cargo ligado a uma instituição do mundo, não a uma cadeia econômica.'
});

// ─────────────────────────────────────────────────────────────────────────────
// Registro interno
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {object} ProfessionDescriptor
 * @property {string} code
 * @property {string} label
 * @property {string} category
 * @property {string} description
 * @property {boolean} enabled
 * @property {boolean} gameplayImplemented
 */

/** @type {Map<string, Readonly<ProfessionDescriptor>>} */
const _professions = new Map();

/**
 * Registra uma profissão no catálogo.
 *
 * @param {object} descriptor
 * @param {string} descriptor.code                 identificador estável, ex: `'miner'`
 * @param {string} descriptor.label                nome exibido, ex: `'Minerador'`
 * @param {string} descriptor.category             uma chave de `CATEGORIES`
 * @param {string} [descriptor.description]
 * @param {boolean} [descriptor.enabled]            padrão `true`
 * @param {boolean} [descriptor.gameplayImplemented] padrão `false`
 */
function register(descriptor) {
  const erro = (msg) => { throw new Error(`[profession-registry] ${msg}`); };

  if (!descriptor || typeof descriptor !== 'object') erro('descritor ausente');
  const {
    code, label, category,
    description = '',
    enabled = true,
    gameplayImplemented = false
  } = descriptor;

  if (!CODE_SHAPE.test(String(code))) {
    erro(`code inválido '${code}': esperado minúsculo, '_' entre palavras (ex: 'stablehand')`);
  }
  if (!label || typeof label !== 'string') erro(`profissão '${code}' sem label`);
  if (!CATEGORIES[category]) {
    erro(`profissão '${code}' com categoria '${category}' fora do catálogo. Conhecidas: ${Object.keys(CATEGORIES).join(', ')}.`);
  }
  if (_professions.has(code)) erro(`profissão '${code}' registrada duas vezes`);

  _professions.set(code, Object.freeze({
    code, label, category, description,
    enabled: !!enabled,
    gameplayImplemented: !!gameplayImplemented
  }));
}

/** @param {string} code @returns {Readonly<ProfessionDescriptor>|null} */
function get(code) {
  return _professions.get(code) || null;
}

/** Todas as profissões registradas, em ordem estável (a de registro). */
function list() {
  return [..._professions.values()];
}

/** @param {string} code */
function isRegistered(code) {
  return _professions.has(code);
}

/** @param {string} code */
function isEnabled(code) {
  const p = get(code);
  return !!p && p.enabled;
}

/** @param {string} code */
function isGameplayImplemented(code) {
  const p = get(code);
  return !!p && p.gameplayImplemented;
}

/**
 * A checagem que `grantProfession` faz antes de qualquer coisa. Devolve motivo
 * nomeado — nunca um booleano só — pelo mesmo argumento de `core/permissions.js
 * .decide`: um `false` mudo obriga quem chama a adivinhar a causa.
 *
 * @param {unknown} code
 * @returns {{ok:true, profession: object}|{ok:false, reason:'unknown_profession'|'profession_disabled'}}
 */
function validate(code) {
  const p = typeof code === 'string' ? get(code) : null;
  if (!p) return { ok: false, reason: 'unknown_profession' };
  if (!p.enabled) return { ok: false, reason: 'profession_disabled' };
  return { ok: true, profession: p };
}

/** Só para teste: devolve o registry ao estado vazio. */
function _reset() {
  _professions.clear();
}

// ─────────────────────────────────────────────────────────────────────────────
// Catálogo inicial (§4 do briefing de profissões)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * As treze profissões planejadas. Nenhuma tem `gameplayImplemented: true` — essa
 * é a Fase 6 em diante, uma de cada vez, sobre o Resource Node Framework que
 * ainda não existe.
 *
 * `guard` merece a nota que a §11 do briefing pediu: isto é uma ETIQUETA de
 * ocupação/RP, não a autoridade da guarda. Quem decide o que um guarda IC pode
 * fazer — revistar, prender, multar — continua sendo `governance-service.js`
 * (facções e cargos), e este catálogo não concede nenhum desses poderes. Um
 * personagem pode ter `profession = 'guard'` sem cargo nenhum em `governance`, e
 * vice-versa; as duas coisas não se falam nesta fase, de propósito. Ver
 * `docs/gameplay/PROFESSION_FRAMEWORK.md` §"Guard × governance".
 *
 * @type {ReadonlyArray<{code:string,label:string,category:string,description?:string}>}
 */
const BUILTIN_PROFESSIONS = Object.freeze([
  { code: 'miner', label: 'Minerador', category: 'gathering' },
  { code: 'lumberjack', label: 'Lenhador', category: 'gathering' },
  { code: 'hunter', label: 'Caçador', category: 'gathering' },
  { code: 'farmer', label: 'Fazendeiro', category: 'gathering' },
  { code: 'smelter', label: 'Fundidor', category: 'crafting' },
  { code: 'blacksmith', label: 'Ferreiro', category: 'crafting' },
  { code: 'tanner', label: 'Curtidor', category: 'crafting' },
  { code: 'enchanter', label: 'Encantador', category: 'crafting' },
  { code: 'cook', label: 'Cozinheiro', category: 'crafting' },
  { code: 'stablehand', label: 'Tratador de Cavalos', category: 'service' },
  { code: 'innkeeper', label: 'Taberneiro', category: 'service' },
  { code: 'courier', label: 'Mensageiro', category: 'service' },
  {
    code: 'guard',
    label: 'Guarda',
    category: 'institutional',
    description: 'Ocupação/RP. NÃO é a autoridade da guarda — essa é governance-service.js.'
  }
]);

/** Registra as treze, pulando quem já estiver lá (idempotente, para reload/teste). */
function registerBuiltins() {
  for (const p of BUILTIN_PROFESSIONS) {
    if (!_professions.has(p.code)) {
      register({ ...p, enabled: true, gameplayImplemented: false });
    }
  }
}

registerBuiltins();

module.exports = {
  CATEGORIES,
  CODE_SHAPE,
  BUILTIN_PROFESSIONS,
  register,
  registerBuiltins,
  get,
  list,
  isRegistered,
  isEnabled,
  isGameplayImplemented,
  validate,
  _reset
};
