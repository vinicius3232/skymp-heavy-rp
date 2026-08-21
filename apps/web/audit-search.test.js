/**
 * apps/web/audit-search.test.js
 *
 * O construtor de busca. Ele monta SQL a partir de dados que vêm da query
 * string, então o que estes testes protegem é, em ordem de gravidade:
 *
 *   1. **Nada do cliente entra no SQL.** O `apps/web` inteiro não tem uma única
 *      concatenação de SQL, e essa é uma propriedade que se perde uma vez só.
 *   2. **Filtro desconhecido é erro, não é ignorado.** Ignorar faria
 *      `?staff_account_id=5` (nome errado) devolver a tabela inteira parecendo
 *      um resultado filtrado — a forma mais fácil de vazar registro por engano.
 *   3. **O índice continua sendo usado.** A `migration-v17` criou nove índices
 *      justamente para estas consultas; uma função sobre a coluna anula todos.
 *
 * Executa com: node --test audit-search.test.js
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const busca = require('./audit-search');
const catalogo = require('../../skymp/gamemode/core/audit-event');

// ─────────────────────────────────────────────────────────────────────────────
// 1. Os onze eixos pedidos
// ─────────────────────────────────────────────────────────────────────────────

describe('todo eixo de busca pedido existe', () => {
  const EIXOS = {
    'período': ['from', 'to'],
    'staff': ['staffAccountId', 'staffCharacterId'],
    'player / account': ['accountId', 'targetAccountId'],
    'character': ['characterId', 'targetCharacterId'],
    'action': ['action'],
    'category': ['category'],
    'severity': ['severity', 'minSeverity'],
    'session': ['sessionId'],
    'correlation ID': ['correlationId'],
    'target': ['targetAccountId', 'targetCharacterId']
  };

  for (const [eixo, filtros] of Object.entries(EIXOS)) {
    test(`busca por ${eixo}`, () => {
      for (const f of filtros) {
        assert.ok(busca.FILTERS[f], `o filtro '${f}' não existe`);
      }
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Nada do cliente entra no SQL
// ─────────────────────────────────────────────────────────────────────────────

describe('injeção', () => {
  test('o valor sempre vira placeholder', () => {
    const q = busca.buildSearch({ action: "x'; DROP TABLE audit_events; --" });
    assert.ok(!q.sql.includes('DROP'), 'o valor entrou no SQL');
    assert.equal(q.params[0], "x'; DROP TABLE audit_events; --");
    assert.equal((q.sql.match(/\?/g) || []).length, q.params.length);
  });

  test('filtro desconhecido é recusado, nunca ignorado', () => {
    // Ignorar devolveria a tabela inteira parecendo filtrada.
    assert.throws(() => busca.buildSearch({ staff_account_id: 5 }), /filtro desconhecido/);
    assert.throws(() => busca.buildSearch({ 'ae.id) OR 1=1 --': 1 }), /filtro desconhecido/);
  });

  test('o número de placeholders bate com o de parâmetros em toda combinação', () => {
    const q = busca.buildSearch({
      from: '2026-08-01', to: '2026-08-15',
      accountId: 7, characterId: 9,
      action: 'players.kick', category: 'players',
      minSeverity: 'notice', outcome: 'denied',
      sessionId: 's1', correlationId: 'c1', before: 500, limit: 50
    });
    assert.equal((q.sql.match(/\?/g) || []).length, q.params.length);
  });

  test('`limit` nunca vem do cliente como texto no SQL', () => {
    // `LIMIT` é interpolado (o driver não aceita placeholder ali em toda
    // versão), então ele PRECISA ser um inteiro validado antes.
    const q = busca.buildSearch({ limit: '10; DROP TABLE audit_events' });
    assert.match(q.sql, /LIMIT \d+$/m);
    assert.ok(!q.sql.includes('DROP'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Validação de valor
// ─────────────────────────────────────────────────────────────────────────────

describe('valor inválido é erro, não zero resultados', () => {
  test('categoria inventada é recusada', () => {
    // Devolver zero linhas em silêncio faria quem consulta concluir que nada
    // aconteceu — a resposta errada mais cara que uma busca de auditoria dá.
    assert.throws(() => busca.buildSearch({ category: 'magia' }), /não existe/);
  });

  test('severidade inventada é recusada', () => {
    assert.throws(() => busca.buildSearch({ severity: 'urgente' }), /não existe/);
    assert.throws(() => busca.buildSearch({ minSeverity: 'urgente' }), /não existe/);
  });

  test('desfecho inventado é recusado', () => {
    assert.throws(() => busca.buildSearch({ outcome: 'talvez' }), /não existe/);
  });

  test('data inválida é recusada', () => {
    assert.throws(() => busca.buildSearch({ from: 'ontem' }), /data válida/);
  });

  test('id não numérico é recusado', () => {
    assert.throws(() => busca.buildSearch({ staffAccountId: 'abc' }), /inteiro positivo/);
    assert.throws(() => busca.buildSearch({ accountId: '-3' }), /inteiro positivo/);
  });

  test('toda categoria do catálogo é aceita', () => {
    for (const c of Object.keys(catalogo.CATEGORIES)) {
      assert.doesNotThrow(() => busca.buildSearch({ category: c }), `categoria '${c}' recusada`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. O índice continua utilizável
// ─────────────────────────────────────────────────────────────────────────────

describe('as consultas usam os índices que a migration criou', () => {
  test('nenhum filtro põe função sobre a coluna', () => {
    // `DATE(created_at) = CURDATE()` já custou uma varredura de tabela inteira
    // neste projeto, no dashboard, e foi corrigido pela mesma razão. Qualquer
    // função sobre a coluna indexada anula o índice.
    const q = busca.buildSearch({
      from: '2026-08-01', minSeverity: 'warning', category: 'security',
      accountId: 5, action: 'players.kick', sessionId: 's', correlationId: 'c'
    });
    const where = q.sql.slice(q.sql.indexOf('WHERE'), q.sql.indexOf('ORDER BY'));

    for (const fn of ['DATE(', 'FIELD(', 'LOWER(', 'UPPER(', 'CAST(', 'CONVERT(', 'SUBSTRING(']) {
      assert.ok(!where.includes(fn), `o WHERE usa ${fn}) sobre uma coluna indexada`);
    }
  });

  test('minSeverity vira IN, com só as severidades pedidas', () => {
    const q = busca.buildSearch({ minSeverity: 'warning' });
    assert.match(q.sql, /ae\.severity IN \(\?, \?\)/);
    assert.deepEqual(q.params, ['warning', 'critical']);

    const tudo = busca.buildSearch({ minSeverity: 'info' });
    assert.deepEqual(tudo.params, ['info', 'notice', 'warning', 'critical']);
  });

  test('a ordenação desempata por id', () => {
    // Dois eventos no mesmo milissegundo teriam ordem indefinida, e o cursor da
    // página seguinte pularia ou repetiria linha.
    assert.match(busca.buildSearch({}).sql, /ORDER BY ae\.occurred_at DESC, ae\.id DESC/);
  });

  test('a paginação é por cursor, nunca por OFFSET', () => {
    // `OFFSET 10000` faz o MySQL ler e descartar dez mil linhas; numa tabela que
    // só cresce, a última página é a mais cara.
    const q = busca.buildSearch({ before: 900 });
    assert.match(q.sql, /ae\.id < \?/);
    assert.ok(!q.sql.includes('OFFSET'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Limites e forma da resposta
// ─────────────────────────────────────────────────────────────────────────────

describe('limites', () => {
  test('o limite tem teto duro', () => {
    assert.equal(busca.buildSearch({ limit: 99999 }).limit, busca.MAX_LIMIT);
  });

  test('limite ausente ou lixo cai no padrão', () => {
    assert.equal(busca.buildSearch({}).limit, busca.DEFAULT_LIMIT);
    assert.equal(busca.buildSearch({ limit: 'muitos' }).limit, busca.DEFAULT_LIMIT);
  });

  test('zero, negativo e lixo caem TODOS no mesmo lugar', () => {
    // Previsibilidade: uma única resposta para toda entrada inválida. Antes
    // `0` caía em 100 (tratado como ausente) e `-5` virava 1 — duas respostas
    // para a mesma classe de erro, e a diferença aparecia como um teto de cem
    // linhas para quem pediu zero.
    for (const ruim of [0, -5, 'muitos', null, {}]) {
      assert.equal(
        busca.buildSearch({ limit: ruim }).limit, busca.DEFAULT_LIMIT,
        `limit=${JSON.stringify(ruim)} devolveu algo diferente do padrão`
      );
    }
  });

  test('a listagem NÃO devolve before/after/metadata', () => {
    // Até 16 KB cada; 500 linhas com os três seriam 24 MB no navegador de quem
    // só queria ver o que aconteceu ontem. O `soul-service` documenta a mesma
    // lição pelo lado da segurança.
    const lista = busca.buildSearch({});
    assert.ok(!lista.sql.includes('before_state'));
    assert.ok(!lista.sql.includes('metadata'));
  });

  test('o detalhe devolve os três', () => {
    const detalhe = busca.buildSearch({ eventId: 'x' }, { detail: true });
    for (const c of ['before_state', 'after_state', 'metadata']) {
      assert.ok(detalhe.sql.includes(c), `o detalhe não devolve '${c}'`);
    }
  });

  test('`applied` diz quais filtros valeram', () => {
    // Sem isso, o cliente não tem como saber se o filtro que ele mandou foi
    // considerado — e é assim que alguém confia num resultado mais estreito do
    // que pediu.
    const q = busca.buildSearch({ category: 'security', limit: 10 });
    assert.deepEqual(q.applied, ['category']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Resumo
// ─────────────────────────────────────────────────────────────────────────────

describe('buildSummary', () => {
  test('agrupa por categoria, severidade e desfecho', () => {
    const r = busca.buildSummary({});
    assert.match(r.sql, /GROUP BY ae\.category, ae\.severity, ae\.outcome/);
  });

  test('aplica o MESMO filtro da busca', () => {
    // Ele compartilha `buildWhere` em vez de recortar o SQL da busca. Fatiar
    // string gerada funcionava e quebraria em silêncio no dia em que a cláusula
    // mudasse de posição — devolvendo contagem SEM filtro que parece filtrada.
    const r = busca.buildSummary({ category: 'security', from: '2026-08-01' });
    assert.match(r.sql, /WHERE ae\.category = \?/);
    assert.match(r.sql, /ae\.occurred_at >= \?/);
    assert.equal(r.params.length, 2);
  });

  test('sem filtro, não gera WHERE vazio', () => {
    assert.ok(!busca.buildSummary({}).sql.includes('WHERE'));
  });

  test('recusa o mesmo filtro desconhecido que a busca recusa', () => {
    assert.throws(() => busca.buildSummary({ inventado: 1 }), /filtro desconhecido/);
  });
});
