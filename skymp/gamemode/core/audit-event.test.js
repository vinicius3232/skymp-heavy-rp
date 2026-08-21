/**
 * core/audit-event.test.js
 *
 * A taxonomia e o construtor. O que estes testes protegem é a propriedade que
 * torna a tabela nova útil: **uma linha de auditoria não pode mentir sobre o
 * que aconteceu**.
 *
 * Três classes de defeito, todas com precedente nesta árvore:
 *
 *   1. **Classificação errada.** Uma fala de RP entrando como auditoria devolve
 *      a tabela ao problema que a motivou — `rp_chat:*` grava uma linha por
 *      fala, e o `LIMIT 200` do painel some com a última ação de staff em
 *      minutos.
 *   2. **Ordem de coluna divergente.** `COLUMNS` e `toRow` precisam concordar.
 *      Uma divergência grava `reason` na coluna de `source` sem erro nenhum —
 *      é a classe de bug que a `migration-v15` já produziu no ledger de ouro,
 *      quando as posições do `INSERT` mudaram.
 *   3. **Severidade que não distingue nada.** Se `critical` fosse liberal, o
 *      filtro por severidade não responderia à única pergunta para a qual ele
 *      existe.
 *
 * Executa com: node --test core/audit-event.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { describe, it } = require('node:test');

const ae = require('./audit-event');

// ─────────────────────────────────────────────────────────────────────────────
// 1. Os cinco fluxos
// ─────────────────────────────────────────────────────────────────────────────

describe('os cinco fluxos estão declarados e são distintos', () => {
  it('os cinco existem, com destino declarado', () => {
    const ids = Object.values(ae.STREAMS).map((s) => s.id).sort();
    assert.deepEqual(ids, ['application', 'audit', 'gameplay', 'metric', 'security']);
    for (const s of Object.values(ae.STREAMS)) {
      assert.ok(s.destino && s.destino.length > 5, `fluxo '${s.id}' sem destino declarado`);
      assert.equal(typeof s.noBanco, 'boolean');
    }
  });

  it('application e metric NÃO vão para o banco', () => {
    // Log de aplicação em MySQL é custo de escrita por linha de diagnóstico
    // numa tabela que ninguém consulta com WHERE; métrica em tabela relacional
    // é a forma mais cara de guardar número que envelhece em minutos.
    assert.equal(ae.STREAMS.APPLICATION.noBanco, false);
    assert.equal(ae.STREAMS.METRIC.noBanco, false);
  });

  it('audit e security vão para a MESMA tabela', () => {
    // Separá-los obrigaria toda investigação a fazer UNION: "quem tentou e quem
    // conseguiu" é uma pergunta só.
    assert.match(ae.STREAMS.AUDIT.destino, /audit_events/);
    assert.match(ae.STREAMS.SECURITY.destino, /audit_events/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Classificação do que já existe
// ─────────────────────────────────────────────────────────────────────────────

describe('classificação das ações antigas', () => {
  const AUDITORIA = [
    'admin:players.kick', 'admin:economy.adjust',
    'staff:kick', 'staff:setGold', 'staff:retireCharacter', 'staff:voice_mute',
    'whitelist:approve', 'whitelist:reject', 'whitelist:reset',
    'governance:guard:arrest', 'identity:staff_reveal'
  ];
  const SEGURANCA = ['authz:denied', 'authz:granted'];
  const JOGO = [
    'rp_chat:me', 'rp_chat:do', 'rp_chat:falar',
    'combat:episode', 'combat:initiate',
    'death:killer', 'death:context', 'death:permadeath',
    'soul:resolve', 'interaction:identity.introduce',
    'identity:introduce', 'identity:alias'
  ];

  for (const nome of AUDITORIA) {
    it(`'${nome}' é AUDITORIA`, () => {
      const c = ae.classifyLegacyAction(nome);
      assert.equal(c.stream, 'audit', `'${nome}' classificado como '${c.stream}'`);
      assert.ok(ae.CATEGORIES[c.category], `categoria '${c.category}' fora do catálogo`);
    });
  }

  for (const nome of SEGURANCA) {
    it(`'${nome}' é SEGURANÇA`, () => {
      const c = ae.classifyLegacyAction(nome);
      assert.equal(c.stream, 'security');
      assert.equal(c.category, 'security');
    });
  }

  for (const nome of JOGO) {
    it(`'${nome}' é EVENTO DE JOGO e NÃO vira auditoria`, () => {
      const c = ae.classifyLegacyAction(nome);
      assert.equal(
        c.stream, 'gameplay',
        `'${nome}' foi classificado como '${c.stream}'. Conversa de taverna entrando na auditoria ` +
        `devolve a tabela ao problema que motivou separá-la.`
      );
    });
  }

  it('nome que ninguém previu cai em `unknown`, não em auditoria', () => {
    // Um `else` que classificasse o desconhecido como auditoria faria o backfill
    // copiar o que ele não entende. `unknown` é o que faz o teste da migration
    // abaixo reprovar em vez de gravar errado.
    assert.equal(ae.classifyLegacyAction('sistema:coisa_nova').stream, 'unknown');
    assert.equal(ae.classifyLegacyAction('').stream, 'unknown');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Severidade
// ─────────────────────────────────────────────────────────────────────────────

describe('severidade', () => {
  it('só o irreversível é critical', () => {
    for (const acao of ['identity.reveal', 'characters.retire', 'players.ban', 'staff.manage']) {
      assert.equal(ae.resolveSeverity(acao, 'executed'), 'critical', `'${acao}' deveria ser critical`);
    }
  });

  it('a lista de critical é curta — senão o filtro não responde nada', () => {
    const criticas = Object.entries(ae.BASE_SEVERITY).filter(([, s]) => s === 'critical');
    assert.ok(
      criticas.length <= 6,
      `${criticas.length} ações críticas. Se metade for crítica, filtrar por severidade não separa nada.`
    );
  });

  it('patrimônio e admissão são notice', () => {
    for (const acao of ['economy.adjust', 'inventory.grant', 'whitelist.review', 'players.kick']) {
      assert.equal(ae.resolveSeverity(acao, 'executed'), 'notice');
    }
  });

  it('o desfecho ELEVA e nunca rebaixa', () => {
    // Um `identity.reveal` negado é MAIS interessante que um executado: alguém
    // tentou desmascarar um jogador sem poder para isso.
    assert.equal(ae.resolveSeverity('identity.reveal', 'denied'), 'critical');
    assert.equal(ae.resolveSeverity('players.teleport', 'denied'), 'warning');
    assert.equal(ae.resolveSeverity('players.teleport', 'failed'), 'warning');
    assert.equal(ae.resolveSeverity('players.teleport', 'executed'), 'info');
  });

  it('a ordem é por gravidade, não alfabética', () => {
    // `critical` < `warning` em ordem de string. Um `>=` textual devolveria o
    // oposto do pedido, e é por isso que a busca usa `IN (...)`.
    assert.deepEqual(ae.SEVERITY_ORDER, ['info', 'notice', 'warning', 'critical']);
    assert.ok('critical' < 'warning', 'a premissa do comentário acima mudou');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. O construtor
// ─────────────────────────────────────────────────────────────────────────────

describe('buildAuditEvent', () => {
  const base = { action: 'players.kick', outcome: 'executed', source: 'command' };

  it('deriva categoria e severidade da ação', () => {
    const e = ae.buildAuditEvent(base);
    assert.equal(e.category, 'players');
    assert.equal(e.severity, 'notice');
  });

  it('recusa categoria fora do catálogo', () => {
    assert.throws(() => ae.buildAuditEvent({ ...base, action: 'magia.lancar' }), /fora do catálogo/);
  });

  it('recusa desfecho desconhecido', () => {
    assert.throws(() => ae.buildAuditEvent({ ...base, outcome: 'talvez' }), /desconhecido/);
  });

  it('recusa evento sem ação', () => {
    assert.throws(() => ae.buildAuditEvent({ outcome: 'executed' }), /sem ação/);
  });

  it('descarta id não positivo em vez de gravar zero', () => {
    const e = ae.buildAuditEvent({ ...base, staffAccountId: 0, targetAccountId: -1, targetCharacterId: 'x' });
    assert.equal(e.staffAccountId, null);
    assert.equal(e.targetAccountId, null);
    assert.equal(e.targetCharacterId, null);
  });

  it('corta motivo longo em vez de estourar a coluna', () => {
    const e = ae.buildAuditEvent({ ...base, reason: 'x'.repeat(2000) });
    assert.equal(e.reason.length, ae.MAX_REASON);
  });

  it('trunca JSON grande demais, e diz que truncou', () => {
    // `details TEXT` sem limite foi onde três formatos passaram a conviver, e o
    // `soul-service` documenta ter deixado a semente de fora POR SEGURANÇA
    // porque o painel devolvia o campo inteiro no navegador.
    const e = ae.buildAuditEvent({ ...base, metadata: { lixo: 'y'.repeat(ae.MAX_JSON_BYTES + 100) } });
    const m = JSON.parse(e.metadata);
    assert.equal(m._truncado, true);
    assert.ok(m._bytes > ae.MAX_JSON_BYTES);
  });

  it('não explode com payload circular', () => {
    const circular = { nome: 'x' };
    circular.eu = circular;
    const e = ae.buildAuditEvent({ ...base, metadata: circular });
    assert.match(e.metadata, /não serializável/);
  });

  it('cada evento tem id próprio', () => {
    const a = ae.buildAuditEvent(base);
    const b = ae.buildAuditEvent(base);
    assert.notEqual(a.eventId, b.eventId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. A ordem das colunas
// ─────────────────────────────────────────────────────────────────────────────

describe('COLUMNS e toRow concordam', () => {
  it('mesma quantidade', () => {
    const e = ae.buildAuditEvent({ action: 'players.kick', outcome: 'executed', source: 'command' });
    assert.equal(
      ae.toRow(e).length, ae.COLUMNS.length,
      'a linha tem tamanho diferente da lista de colunas — o INSERT grava valor na coluna errada'
    );
  });

  it('o INSERT tem um placeholder por coluna', () => {
    assert.equal((ae.INSERT_SQL.match(/\?/g) || []).length, ae.COLUMNS.length);
  });

  it('cada valor cai na coluna com o significado certo', () => {
    // A prova é por valor-sentinela: cada campo recebe algo reconhecível, e o
    // teste confere a POSIÇÃO. Sem isto, trocar `reason` com `source` passa.
    const e = ae.buildAuditEvent({
      action: 'economy.adjust', outcome: 'blocked', source: 'web',
      permission: 'economy.adjust', reason: 'motivo-sentinela',
      staffAccountId: 11, staffCharacterId: 22, targetAccountId: 33, targetCharacterId: 44,
      sessionId: 'sessao-sentinela', correlationId: 'corr-sentinela'
    });
    const linha = ae.toRow(e);
    const em = (nome) => linha[ae.COLUMNS.indexOf(nome)];

    assert.equal(em('correlation_id'), 'corr-sentinela');
    assert.equal(em('session_id'), 'sessao-sentinela');
    assert.equal(em('staff_account_id'), 11);
    assert.equal(em('staff_character_id'), 22);
    assert.equal(em('target_account_id'), 33);
    assert.equal(em('target_character_id'), 44);
    assert.equal(em('category'), 'economy');
    assert.equal(em('action'), 'economy.adjust');
    assert.equal(em('outcome'), 'blocked');
    assert.equal(em('source'), 'web');
    assert.equal(em('permission'), 'economy.adjust');
    assert.equal(em('reason'), 'motivo-sentinela');
  });

  it('toda coluna do INSERT existe na migration', () => {
    // O SQL e o JS são escritos em arquivos diferentes por pessoas diferentes em
    // momentos diferentes. Uma coluna que só existe de um lado é um `INSERT`
    // que falha em produção e passa em todo teste sem banco.
    const sql = fs.readFileSync(
      path.resolve(__dirname, '..', '..', 'packages', 'database', 'migration-v17-audit-events.sql'),
      'utf8'
    );
    const criacao = sql.slice(sql.indexOf('CREATE TABLE IF NOT EXISTS `audit_events`'), sql.indexOf('ALTER TABLE'));
    for (const coluna of ae.COLUMNS) {
      assert.ok(
        criacao.includes(`\`${coluna}\``),
        `a coluna '${coluna}' está no INSERT e não na migration-v17`
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. O escritor
// ─────────────────────────────────────────────────────────────────────────────

describe('createAuditEventStore', () => {
  it('grava e devolve o id', async () => {
    const gravadas = [];
    const store = ae.createAuditEventStore({ query: async (sql, p) => gravadas.push({ sql, p }) });
    const r = await store.record({ action: 'players.kick', outcome: 'executed', source: 'command' });

    assert.equal(r.ok, true);
    assert.equal(gravadas.length, 1);
    assert.match(gravadas[0].sql, /INSERT INTO audit_events/);
  });

  it('banco fora NÃO propaga — fail-open declarado', async () => {
    // Uma auditoria que falha não pode desfazer um efeito que já aconteceu nem
    // transformar negação em permissão. A diferença para antes é que agora há
    // UM lugar onde essa escolha vive.
    const store = ae.createAuditEventStore(
      { query: async () => { throw new Error('banco fora'); } },
      { error: () => {} }
    );
    const r = await store.record({ action: 'players.kick', outcome: 'executed', source: 'command' });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'banco fora');
  });

  it('evento malformado LANÇA, e não vira linha errada', async () => {
    // Aqui é o oposto do caso acima, e a assimetria é a decisão: falha de
    // INFRAESTRUTURA é fail-open; erro de PROGRAMAÇÃO não pode entrar no
    // registro, porque um evento malformado mente sobre o que aconteceu.
    const store = ae.createAuditEventStore({ query: async () => {} });
    await assert.rejects(() => store.record({ action: 'magia.lancar', outcome: 'executed' }), /fora do catálogo/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. O backfill da migration concorda com o classificador
// ─────────────────────────────────────────────────────────────────────────────

describe('a migration e o código classificam a mesma coisa do mesmo jeito', () => {
  const sql = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'packages', 'database', 'migration-v17-audit-events.sql'),
    'utf8'
  );

  it('o WHERE do backfill copia exatamente os prefixos de auditoria', () => {
    const where = sql.slice(sql.lastIndexOf('FROM `audit_logs` al'));
    for (const prefixo of ['admin:', 'authz:', 'staff:', 'whitelist:', 'governance:']) {
      assert.ok(where.includes(`'${prefixo}%'`), `o backfill não copia '${prefixo}'`);
    }
    assert.ok(where.includes("'identity:staff_reveal'"));
  });

  it('o backfill NÃO copia evento de jogo', () => {
    const where = sql.slice(sql.lastIndexOf('FROM `audit_logs` al'));
    for (const prefixo of ['rp_chat', 'combat', 'death', 'soul', 'interaction']) {
      assert.ok(
        !where.includes(prefixo),
        `o backfill copia '${prefixo}', que é evento de jogo — a tabela nova nasceria com o problema da antiga`
      );
    }
  });

  it('a migration não altera nem apaga nada da tabela antiga', () => {
    // A garantia central: aplicar esta migration não pode quebrar o que lê
    // `audit_logs` hoje, porque ela não toca em nada que existe.
    assert.ok(!/ALTER TABLE\s+`?audit_logs`?/i.test(sql), 'a migration altera audit_logs');
    assert.ok(!/DROP\s+TABLE/i.test(sql), 'a migration tem DROP TABLE');
    assert.ok(!/DELETE\s+FROM/i.test(sql), 'a migration apaga linhas');
    assert.ok(!/UPDATE\s+`?audit_logs`?/i.test(sql), 'a migration escreve em audit_logs');
  });

  it('o backfill é reexecutável', () => {
    // As migrations deste projeto são aplicadas À MÃO, e um banco meio-migrado
    // é a falha mais cara que ele tem. Rodar duas vezes não pode duplicar.
    assert.ok(/INSERT IGNORE INTO `audit_events`/i.test(sql), 'o backfill não é INSERT IGNORE');
    assert.ok(/UNIQUE KEY `uk_audit_legacy`/i.test(sql), 'falta a chave única no id de origem');
  });

  it('toda categoria que o backfill produz existe no catálogo', () => {
    const bloco = sql.slice(sql.indexOf('END                                                         AS category'));
    const anterior = sql.slice(0, sql.indexOf('AS category'));
    const citadas = [...anterior.matchAll(/THEN '([a-z_]+)'/g)].map((m) => m[1]);
    for (const c of citadas) {
      if (c === 'legacy') continue; // é valor de `source`, não de categoria
      assert.ok(
        ae.CATEGORIES[c] || ['executed', 'denied'].includes(c),
        `o backfill grava a categoria '${c}', que não está no catálogo`
      );
    }
    assert.ok(bloco.length > 0);
  });
});
