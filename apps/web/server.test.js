/**
 * Smoke tests do painel web.
 *
 * O `apps/web` era o único serviço com regra de negócio real — autorização de
 * staff, aprovação de whitelist, troca de OAuth — e nenhum teste. Estes testes
 * cobrem os caminhos onde um erro é silencioso e caro: um endpoint de staff que
 * esquece o guard, ou um UPDATE que reescreve linha demais.
 *
 * O MySQL é substituído por um duplo em memória antes do `require` do servidor,
 * então nada aqui toca banco nem rede.
 */

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('path');

// ── Duplo de MySQL ───────────────────────────────────────────────────────────
// Guarda toda query executada, pra que os testes possam afirmar sobre o SQL em
// si (é o SQL que continha o bug do personagem aposentado, não o handler).
const queryLog = [];
let queryHandler = () => [];

const fakePool = {
  execute: async (sql, params = []) => {
    queryLog.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    const result = await queryHandler(sql, params);
    if (Array.isArray(result)) return [result, []];
    return [result, []];
  }
};

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'mysql2/promise') {
    return { createPool: () => fakePool };
  }
  return realLoad.apply(this, arguments);
};

process.env.INTERNAL_API_SECRET = 'test-internal-secret';
process.env.MASTER_KEY = 'chave-do-servidor-de-teste';
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DISCORD_CLIENT_ID = 'test-client-id';
process.env.DISCORD_CLIENT_SECRET = 'test-client-secret';

const { app, validateApplication, issueLaunchTicket } = require(path.join(__dirname, 'server.js'));
const credential = require(path.join(__dirname, '..', '..', 'skymp', 'gamemode', 'core', 'opaque-credential'));

Module._load = realLoad;

// ── Servidor efêmero ─────────────────────────────────────────────────────────
let server;
let baseUrl;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  queryLog.length = 0;
  queryHandler = () => [];
});

const get = (p, opts) => fetch(`${baseUrl}${p}`, { redirect: 'manual', ...opts });
const post = (p, body) => fetch(`${baseUrl}${p}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
  redirect: 'manual'
});

// ─────────────────────────────────────────────────────────────────────────────

describe('autenticação obrigatória', () => {
  // Sem sessão, nenhuma rota de dado pode responder 200. O risco real aqui é
  // alguém adicionar um endpoint novo e esquecer o guard.
  const protectedRoutes = [
    '/api/me',
    '/api/dashboard',
    '/api/whitelist',
    '/api/characters',
    '/api/audit',
    '/api/economy/holds',
    '/api/economy/top-gold',
    '/api/criminal',
    '/api/factions',
    '/api/prison',
    '/api/crashes'
  ];

  for (const route of protectedRoutes) {
    test(`GET ${route} exige autenticação`, async () => {
      const res = await get(route);
      assert.equal(res.status, 401, `${route} respondeu ${res.status} sem sessão`);
    });
  }

  test('POST /api/apply exige autenticação', async () => {
    const res = await post('/api/apply', { first_name: 'A' });
    assert.equal(res.status, 401);
  });
});

describe('validação da aplicação de personagem', () => {
  const valid = {
    first_name: 'Ralof',
    last_name: 'de Riverwood',
    biography: 'x'.repeat(120),
    motivations: 'y'.repeat(40),
    weaknesses: 'z'.repeat(40),
    social_ties: 'w'.repeat(40)
  };

  test('aceita ficha completa', () => {
    const { error, clean } = validateApplication(valid);
    assert.equal(error, undefined);
    assert.equal(clean.first_name, 'Ralof');
  });

  test('rejeita nome ausente', () => {
    assert.match(validateApplication({ ...valid, first_name: '' }).error, /Nome/);
  });

  test('rejeita nome só com espaços', () => {
    assert.match(validateApplication({ ...valid, first_name: '   ' }).error, /Nome/);
  });

  test('rejeita biografia curta demais', () => {
    assert.match(validateApplication({ ...valid, biography: 'curta' }).error, /Biografia/);
  });

  test('rejeita campo acima do limite da coluna', () => {
    assert.match(validateApplication({ ...valid, biography: 'x'.repeat(6000) }).error, /Biografia/);
  });

  // A rubrica de whitelist trata ficha sem estes campos como reprovada. Eles
  // eram `required` só no HTML, o que é trivial de contornar.
  for (const field of ['motivations', 'weaknesses', 'social_ties']) {
    test(`rejeita ${field} ausente (rubrica Heavy RP)`, () => {
      const { error } = validateApplication({ ...valid, [field]: '' });
      assert.ok(error, `${field} vazio deveria ser rejeitado no servidor`);
    });
  }

  test('faz trim antes de gravar', () => {
    const { clean } = validateApplication({ ...valid, first_name: '  Ralof  ' });
    assert.equal(clean.first_name, 'Ralof');
  });

  test('rejeita tipo não-string sem quebrar', () => {
    assert.ok(validateApplication({ ...valid, first_name: { toString: () => 'x' } }).error);
    assert.ok(validateApplication({}).error);
  });
});

describe('troca de OAuth do launcher', () => {
  test('rejeita redirect_uri fora da allowlist', async () => {
    const res = await post('/api/launcher/oauth/exchange', {
      code: 'abc',
      redirect_uri: 'http://servidor-do-atacante.example/callback'
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /redirect_uri/);
  });

  test('rejeita code ausente', async () => {
    const res = await post('/api/launcher/oauth/exchange', {
      redirect_uri: 'http://localhost:19847/callback'
    });
    assert.equal(res.status, 400);
  });

  test('aceita o redirect_uri do launcher (chega a falar com o Discord)', async () => {
    const res = await post('/api/launcher/oauth/exchange', {
      code: 'codigo-invalido',
      redirect_uri: 'http://localhost:19847/callback'
    });
    // Passa da validação de forma; o Discord real recusa o code falso.
    assert.notEqual(res.status, 400, 'o redirect_uri da allowlist não deveria ser barrado');
  });
});

describe('ticket de lançamento', () => {
  test('issueLaunchTicket grava hash, nunca o token em claro', async () => {
    queryLog.length = 0;
    queryHandler = () => [];
    const token = await issueLaunchTicket(42, '123456789', '127.0.0.1');

    assert.equal(credential.parse(token)?.kind, 'launch_grant', 'o token emitido precisa ser um launch_grant opaco válido');

    const insert = queryLog.find((q) => /INSERT INTO launch_tickets/i.test(q.sql));
    assert.ok(insert, 'deveria ter gravado o ticket');
    assert.equal(insert.params[0], credential.hash(token), 'o banco guarda o hash, não o token');
    assert.notEqual(insert.params[0], token, 'o token em claro não pode ir pro banco');
  });
});

describe('endpoint de crash reports', () => {
  test('rejeita corpo sem crash válido', async () => {
    const res = await post('/api/crashes/client', { crashes: [] });
    assert.equal(res.status, 400);
  });

  test('rejeita crash sem conteúdo', async () => {
    const res = await post('/api/crashes/client', { crashes: [{ filename: 'a.log', content: '' }] });
    assert.equal(res.status, 400);
  });
});

describe('endpoints removidos continuam removidos', () => {
  // Servia um manifesto com hash falso e ninguém o consumia. Se voltar, volta
  // a ser um alvo pra alguém apontar o launcher.
  test('GET /api/launcher/manifest não devolve JSON de manifesto', async () => {
    const res = await get('/api/launcher/manifest');
    const body = await res.text();
    assert.ok(!body.includes('dummy_hash_for_testing'), 'o stub de manifesto voltou');
  });
});

describe('rotação de crash reports', () => {
  // O diretório crescia sem limite: até 64 KB de log por crash, e um cliente
  // instável reporta em série.
  const { pruneCrashReports, CRASH_REPORT_DIR } = require('./server.js');
  const fs = require('fs');
  const path = require('path');

  function makeReport(name, ageDays) {
    const p = path.join(CRASH_REPORT_DIR, name);
    fs.writeFileSync(p, JSON.stringify({ id: name, crashes: [] }));
    if (ageDays) {
      const t = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
      fs.utimesSync(p, t, t);
    }
    return p;
  }

  function clearDir() {
    if (!fs.existsSync(CRASH_REPORT_DIR)) return;
    for (const f of fs.readdirSync(CRASH_REPORT_DIR)) {
      if (f.endsWith('.json')) fs.unlinkSync(path.join(CRASH_REPORT_DIR, f));
    }
  }

  beforeEach(() => {
    fs.mkdirSync(CRASH_REPORT_DIR, { recursive: true });
    clearDir();
  });

  after(clearDir);

  test('remove relatórios mais velhos que o limite de idade', async () => {
    makeReport('velho.json', 60);
    makeReport('recente.json', 1);

    await pruneCrashReports();

    assert.equal(fs.existsSync(path.join(CRASH_REPORT_DIR, 'velho.json')), false);
    assert.equal(fs.existsSync(path.join(CRASH_REPORT_DIR, 'recente.json')), true);
  });

  test('mantém os recentes quando nada passou da idade', async () => {
    for (let i = 0; i < 5; i++) makeReport(`r${i}.json`, 1);
    const removed = await pruneCrashReports();
    assert.equal(removed, 0);
    assert.equal(fs.readdirSync(CRASH_REPORT_DIR).filter(f => f.endsWith('.json')).length, 5);
  });

  test('não quebra com diretório vazio', async () => {
    assert.equal(await pruneCrashReports(), 0);
  });

  test('sobrevive a arquivo que some no meio da poda', async () => {
    // Concorrência real: dois relatórios chegando ao mesmo tempo disparam duas
    // podas. A segunda encontra arquivos que a primeira já apagou.
    makeReport('some.json', 60);
    const [a, b] = await Promise.all([pruneCrashReports(), pruneCrashReports()]);
    assert.equal(typeof a, 'number');
    assert.equal(typeof b, 'number');
  });
});

describe('master API de sessão (contrato do SkyMP)', () => {
  // Este endpoint é o que tira a identidade das mãos do cliente: com
  // `offlineMode: false`, o servidor SkyMP não lê o `profileId` do
  // skymp_config.json — ele pergunta aqui quem é o dono da sessão, e o `id`
  // que respondermos vira o profileId do gamemode.
  const MASTER_KEY = 'chave-do-servidor-de-teste';
  const SESSION = credential.generate('game_session');

  test('masterKey errada responde 404, não 403', async () => {
    // 404 e não 403 de propósito: não confirmamos a existência da chave certa
    // pra quem está adivinhando.
    const res = await get(`/api/servers/chave-errada/sessions/${SESSION}`);
    assert.equal(res.status, 404);
  });

  test('sessão desconhecida responde 404', async () => {
    // 404 é o que o SkyMP espera: ele manda `loginFailedSessionNotFound`
    // pro cliente, que é a mensagem correta pro jogador.
    queryHandler = () => [];
    const res = await get(`/api/servers/${MASTER_KEY}/sessions/${SESSION}`);
    assert.equal(res.status, 404);
  });

  test('sessão curta demais é rejeitada sem ir ao banco', async () => {
    queryLog.length = 0;
    const res = await get(`/api/servers/${MASTER_KEY}/sessions/curta`);
    assert.equal(res.status, 404);
    assert.equal(queryLog.filter(q => /game_sessions/i.test(q.sql)).length, 0);
  });

  test('token de outro kind (launch_grant) é rejeitado sem ir ao banco', async () => {
    queryLog.length = 0;
    const launchGrant = credential.generate('launch_grant');
    const res = await get(`/api/servers/${MASTER_KEY}/sessions/${launchGrant}`);
    assert.equal(res.status, 404);
    assert.equal(queryLog.filter(q => /game_sessions/i.test(q.sql)).length, 0, 'kind errado nunca deveria consultar o banco');
  });

  test('sessão válida responde no formato que o SkyMP espera, com characterId aditivo', async () => {
    queryHandler = (sql) => {
      if (/SELECT id, account_id, character_id, discord_id FROM game_sessions/i.test(sql)) {
        return [{ id: 7, account_id: 42, character_id: 501, discord_id: '123456789' }];
      }
      return [];
    };

    const res = await get(`/api/servers/${MASTER_KEY}/sessions/${SESSION}`);
    assert.equal(res.status, 200);

    const body = await res.json();
    // A forma de `user` é ditada pelo SkyMP (systems/login.ts lê `data.user.id`),
    // não por nós — se isto mudar, o login inteiro para. `characterId` é campo
    // aditivo (AUTH-003/CHR-001): o SkyMP nativo ignora o que não conhece.
    assert.equal(body.user.id, 42, 'user.id vira o profileId do gamemode');
    assert.equal(body.user.discordId, '123456789');
    assert.equal(body.characterId, 501);
  });

  test('sessão sem bind (emitida antes da migration v19) responde characterId nulo, não erro', async () => {
    queryHandler = (sql) => /SELECT id, account_id, character_id, discord_id FROM game_sessions/i.test(sql)
      ? [{ id: 7, account_id: 42, character_id: null, discord_id: '123456789' }]
      : [];

    const res = await get(`/api/servers/${MASTER_KEY}/sessions/${SESSION}`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).characterId, null);
  });

  test('a consulta exige sessão não revogada e não expirada', async () => {
    queryHandler = () => [{ id: 1, account_id: 1, character_id: null, discord_id: 'x' }];
    await get(`/api/servers/${MASTER_KEY}/sessions/${SESSION}`);

    const q = queryLog.find(q => /FROM game_sessions/i.test(q.sql));
    assert.ok(q, 'deveria ter consultado game_sessions');
    assert.match(q.sql, /revoked_at IS NULL/, 'sessão revogada precisa deixar de valer na hora');
    assert.match(q.sql, /expires_at > NOW\(\)/, 'sessão expirada não pode autenticar');
  });

  test('guarda hash, nunca o token em claro', async () => {
    queryHandler = () => [{ id: 1, account_id: 1, character_id: null, discord_id: 'x' }];
    await get(`/api/servers/${MASTER_KEY}/sessions/${SESSION}`);

    const q = queryLog.find(q => /FROM game_sessions/i.test(q.sql));
    assert.notEqual(q.params[0], SESSION, 'o token em claro não pode ir pro banco');
    assert.equal(q.params[0], credential.hash(SESSION));
  });

  test('contabiliza a resolução', async () => {
    queryHandler = (sql) => /SELECT id, account_id/i.test(sql)
      ? [{ id: 7, account_id: 42, character_id: null, discord_id: 'x' }] : [];
    await get(`/api/servers/${MASTER_KEY}/sessions/${SESSION}`);

    // resolve_count alto é sinal de sessão compartilhada entre máquinas.
    const upd = queryLog.find(q => /UPDATE game_sessions/i.test(q.sql));
    assert.ok(upd, 'deveria registrar o uso');
    assert.match(upd.sql, /resolve_count = resolve_count \+ 1/);
  });
});
