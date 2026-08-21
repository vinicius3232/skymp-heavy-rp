/**
 * apps/web/audit-search.js
 *
 * A busca em `audit_events`. Monta SQL parametrizado a partir de filtros
 * nomeados, e recusa qualquer filtro que não esteja na lista.
 *
 * ─── Por que um construtor e não uma query por rota ─────────────────────────
 *
 * Onze eixos de busca combináveis dariam, escritos à mão, uma query por
 * combinação útil — e a tentação seguinte seria concatenar pedaços de string
 * vindos da query string. O `apps/web` inteiro não tem uma única concatenação
 * de SQL hoje, e essa é uma propriedade que se perde uma vez só.
 *
 * Aqui **nada** vem do cliente para dentro do SQL: o nome do filtro é a chave
 * de um mapa fechado, o operador é fixo por filtro, e o valor sempre vira `?`.
 * Um filtro desconhecido é erro, não é ignorado — ignorar faria
 * `?staff_account_id=5` (nome errado) devolver a tabela inteira parecendo um
 * resultado filtrado, que é a forma mais fácil de vazar registro por engano.
 *
 * ─── Sobre os índices, dito com precisão ────────────────────────────────────
 *
 * Todo filtro abaixo tem índice, e todos terminam em `occurred_at` porque toda
 * consulta de auditoria é ordenada no tempo. A exceção que vale nomear:
 * `accountId` e `characterId` procuram nos **dois lados** (quem agiu e quem
 * sofreu), e viram `a = ? OR b = ?`. Isso depende do `index_merge` do
 * MySQL/MariaDB para usar os dois índices; quando o plano não colabora, o
 * caminho rápido é o filtro específico (`staffAccountId` ou `targetAccountId`),
 * que é uma igualdade sobre um índice só.
 */

'use strict';

const catalog = require('../../skymp/gamemode/core/audit-event');

/** Teto duro. Uma busca sem limite numa tabela de auditoria é um `SELECT *`. */
const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;

/**
 * Os filtros aceitos. `sql` recebe o placeholder; `params` transforma o valor
 * cru no que vai para o driver.
 *
 * A validação de forma acontece aqui e não na rota: uma severidade inventada
 * (`?severity=urgente`) devolveria zero linhas em silêncio, e quem consultasse
 * concluiria que nada aconteceu — que é a resposta errada mais cara que uma
 * busca de auditoria pode dar.
 */
const FILTERS = Object.freeze({
  // ── Período ────────────────────────────────────────────────────────────────
  from: {
    sql: 'ae.occurred_at >= ?',
    parse: (v) => {
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) throw new Error("'from' não é uma data válida (use ISO 8601)");
      return [d];
    }
  },
  to: {
    sql: 'ae.occurred_at <= ?',
    parse: (v) => {
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) throw new Error("'to' não é uma data válida (use ISO 8601)");
      return [d];
    }
  },

  // ── Staff ──────────────────────────────────────────────────────────────────
  staffAccountId: { sql: 'ae.staff_account_id = ?', parse: (v) => [inteiro(v, 'staffAccountId')] },
  staffCharacterId: { sql: 'ae.staff_character_id = ?', parse: (v) => [inteiro(v, 'staffCharacterId')] },

  // ── Alvo ───────────────────────────────────────────────────────────────────
  targetAccountId: { sql: 'ae.target_account_id = ?', parse: (v) => [inteiro(v, 'targetAccountId')] },
  targetCharacterId: { sql: 'ae.target_character_id = ?', parse: (v) => [inteiro(v, 'targetCharacterId')] },

  // ── Pessoa, nos dois lados ─────────────────────────────────────────────────
  //
  // "Mostre tudo que envolve esta conta" é a pergunta que uma investigação faz
  // primeiro, e ela não sabe de antemão se a pessoa agiu ou sofreu.
  accountId: {
    sql: '(ae.staff_account_id = ? OR ae.target_account_id = ?)',
    parse: (v) => { const n = inteiro(v, 'accountId'); return [n, n]; }
  },
  characterId: {
    sql: '(ae.staff_character_id = ? OR ae.target_character_id = ?)',
    parse: (v) => { const n = inteiro(v, 'characterId'); return [n, n]; }
  },

  // ── Classificação ──────────────────────────────────────────────────────────
  action: { sql: 'ae.action = ?', parse: (v) => [texto(v, 'action', 96)] },
  category: {
    sql: 'ae.category = ?',
    parse: (v) => {
      const c = texto(v, 'category', 32);
      if (!catalog.CATEGORIES[c]) {
        throw new Error(`categoria '${c}' não existe. Conhecidas: ${Object.keys(catalog.CATEGORIES).join(', ')}`);
      }
      return [c];
    }
  },
  severity: {
    sql: 'ae.severity = ?',
    parse: (v) => {
      const s = texto(v, 'severity', 16);
      if (!catalog.SEVERITY_ORDER.includes(s)) {
        throw new Error(`severidade '${s}' não existe. Conhecidas: ${catalog.SEVERITY_ORDER.join(', ')}`);
      }
      return [s];
    }
  },
  /**
   * `severity >= x`. A ordem é a do catálogo, não alfabética — `critical` vem
   * depois de `warning` por gravidade, e ANTES dele em ordem de string, o que
   * faria um `>=` textual devolver o oposto do pedido.
   *
   * Vira `IN (...)` e não `FIELD(severity, …) >= ?` de propósito: **qualquer
   * função sobre a coluna impede o MySQL de usar `idx_audit_ev_severity`**, e a
   * consulta que a migration otimizou viraria varredura de tabela. É o mesmo
   * defeito que o `DATE(created_at) = CURDATE()` do dashboard já teve, e que já
   * foi corrigido uma vez neste projeto pela mesma razão.
   *
   * A lista é fechada e curta — quatro níveis —, então o `IN` é literalmente a
   * enumeração do que se quer.
   */
  minSeverity: {
    sql: null, // montado por `dynamic`: o número de placeholders varia
    dynamic: (v) => {
      const s = texto(v, 'minSeverity', 16);
      const i = catalog.SEVERITY_ORDER.indexOf(s);
      if (i < 0) {
        throw new Error(`severidade '${s}' não existe. Conhecidas: ${catalog.SEVERITY_ORDER.join(', ')}`);
      }
      const aceitas = catalog.SEVERITY_ORDER.slice(i);
      return { sql: `ae.severity IN (${aceitas.map(() => '?').join(', ')})`, params: aceitas };
    }
  },
  outcome: {
    sql: 'ae.outcome = ?',
    parse: (v) => {
      const o = texto(v, 'outcome', 16);
      if (!catalog.OUTCOMES.includes(o)) {
        throw new Error(`desfecho '${o}' não existe. Conhecidos: ${catalog.OUTCOMES.join(', ')}`);
      }
      return [o];
    }
  },
  source: { sql: 'ae.source = ?', parse: (v) => [texto(v, 'source', 16)] },
  permission: { sql: 'ae.permission = ?', parse: (v) => [texto(v, 'permission', 64)] },

  // ── Rastreio ───────────────────────────────────────────────────────────────
  sessionId: { sql: 'ae.session_id = ?', parse: (v) => [texto(v, 'sessionId', 128)] },
  correlationId: { sql: 'ae.correlation_id = ?', parse: (v) => [texto(v, 'correlationId', 128)] },
  eventId: { sql: 'ae.event_id = ?', parse: (v) => [texto(v, 'eventId', 64)] }
});

function inteiro(v, nome) {
  const n = Number.parseInt(String(v), 10);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`'${nome}' precisa ser um inteiro positivo`);
  return n;
}

function texto(v, nome, max) {
  const s = String(v).trim();
  if (!s) throw new Error(`'${nome}' está vazio`);
  if (s.length > max) throw new Error(`'${nome}' passa de ${max} caracteres`);
  return s;
}

/**
 * As colunas devolvidas. Lista explícita, e não `SELECT *`:
 *
 * `before_state`, `after_state` e `metadata` podem carregar até 16 KB cada, e
 * uma listagem de 500 linhas com os três seria 24 MB no navegador de quem só
 * queria ver o que aconteceu ontem. Eles saem só no detalhe de um evento.
 *
 * A lição vem do `soul-service`, que documenta ter deixado a semente fora do
 * `details` **por segurança**, porque `GET /api/audit` devolvia o campo inteiro
 * para qualquer staff no navegador.
 */
const LIST_COLUMNS = `
  ae.id, ae.event_id, ae.correlation_id, ae.occurred_at, ae.session_id,
  ae.staff_account_id, ae.staff_character_id,
  ae.target_account_id, ae.target_character_id,
  ae.category, ae.action, ae.severity, ae.outcome, ae.source,
  ae.permission, ae.reason,
  ds.username AS staff_name, dt.username AS target_name`;

const DETAIL_COLUMNS = `${LIST_COLUMNS}, ae.before_state, ae.after_state, ae.metadata`;

const JOINS = `
  FROM audit_events ae
  LEFT JOIN discord_identities ds ON ds.account_id = ae.staff_account_id
  LEFT JOIN discord_identities dt ON dt.account_id = ae.target_account_id`;

/**
 * Monta a consulta.
 *
 * @param {object} filtros  vindos da query string, ainda crus
 * @param {{detail?: boolean}} [opts]
 * @returns {{sql: string, params: any[], limit: number, applied: string[]}}
 */
function buildWhere(filtros = {}) {
  const where = [];
  const params = [];
  const applied = [];

  for (const [nome, valor] of Object.entries(filtros)) {
    if (valor === undefined || valor === null || valor === '') continue;
    if (nome === 'limit' || nome === 'before') continue;

    const filtro = FILTERS[nome];
    if (!filtro) {
      // Recusa, não ignora. Ver o cabeçalho.
      throw new Error(
        `filtro desconhecido '${nome}'. Aceitos: ${Object.keys(FILTERS).join(', ')}, limit, before.`
      );
    }

    if (filtro.dynamic) {
      const montado = filtro.dynamic(valor);
      where.push(montado.sql);
      params.push(...montado.params);
    } else {
      where.push(filtro.sql);
      params.push(...filtro.parse(valor));
    }
    applied.push(nome);
  }

  // Paginação por cursor e não por OFFSET: `OFFSET 10000` faz o MySQL ler e
  // descartar dez mil linhas, e numa tabela que só cresce a última página é a
  // mais cara. `id` é monotônico e já é a chave primária.
  if (filtros.before !== undefined && filtros.before !== '') {
    where.push('ae.id < ?');
    params.push(inteiro(filtros.before, 'before'));
  }

  return { where, params, applied };
}

/**
 * Monta a consulta de listagem.
 *
 * @param {object} filtros  vindos da query string, ainda crus
 * @param {{detail?: boolean}} [opts]
 * @returns {{sql: string, params: any[], limit: number, applied: string[]}}
 */
function buildSearch(filtros = {}, opts = {}) {
  const { where, params, applied } = buildWhere(filtros);

  // Qualquer entrada que não seja um inteiro positivo cai no padrão — `0`,
  // `-5`, `'muitos'` e ausente respondem a mesma coisa.
  //
  // A versão anterior tratava `0` como ausente (caía em 100) e `-5` como
  // pequeno (virava 1): duas respostas diferentes para a mesma classe de
  // entrada inválida, e a diferença aparecia num teto de 100 linhas para quem
  // pediu zero. Previsível vale mais que engenhoso aqui.
  const pedido = Number.parseInt(String(filtros.limit), 10);
  const limit = Number.isInteger(pedido) && pedido > 0
    ? Math.min(pedido, MAX_LIMIT)
    : DEFAULT_LIMIT;

  const sql =
    `SELECT ${opts.detail ? DETAIL_COLUMNS : LIST_COLUMNS}` +
    JOINS +
    (where.length ? `\n  WHERE ${where.join('\n    AND ')}` : '') +
    // `id DESC` e não `occurred_at DESC`: dois eventos no mesmo milissegundo
    // teriam ordem indefinida, e o cursor da página seguinte pularia ou
    // repetiria linha. `id` desempata e é a chave primária.
    `\n  ORDER BY ae.occurred_at DESC, ae.id DESC` +
    `\n  LIMIT ${limit}`;

  return { sql, params, limit, applied };
}

/**
 * Contagem por categoria e severidade num período — o resumo que uma tela de
 * `security.review` abre antes de qualquer filtro.
 */
function buildSummary(filtros = {}) {
  // Compartilha `buildWhere` com a busca em vez de recortar o SQL que ela
  // gerou. Fatiar string gerada funcionava hoje e quebraria em silêncio no dia
  // em que a cláusula mudasse de posição — devolvendo uma contagem SEM filtro
  // que parece uma contagem filtrada, que é a resposta errada mais cara que uma
  // tela de auditoria pode dar.
  const { where, params } = buildWhere(filtros);

  return {
    sql:
      `SELECT ae.category, ae.severity, ae.outcome, COUNT(*) AS total` +
      `\n  FROM audit_events ae` +
      (where.length ? `\n  WHERE ${where.join('\n    AND ')}` : '') +
      `\n  GROUP BY ae.category, ae.severity, ae.outcome` +
      `\n  ORDER BY total DESC`,
    params
  };
}

module.exports = {
  FILTERS,
  buildWhere,
  MAX_LIMIT,
  DEFAULT_LIMIT,
  buildSearch,
  buildSummary
};
