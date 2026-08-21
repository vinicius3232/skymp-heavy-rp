/**
 * Testes em nível HTTP do `game-api`.
 *
 * Existem porque `queue.test.js` testa o módulo de fila, não as rotas — então
 * o transporte da credencial (query string versus corpo, GET versus POST) não
 * tinha nenhuma rede de proteção. Foi assim que `SEC-QS-01` passou despercebido.
 *
 * ## Por que isto roda sem MariaDB
 *
 * `consumeLaunchTicket`/`pollGrants.consume` recusam ticket ausente,
 * não-string, malformado ou de `kind` errado **antes** de tocar o banco
 * (regra 1 de AUTH_002_OPAQUE_TICKET_V1.md). Todos os casos aqui caem nessa
 * recusa antecipada, então a suíte não precisa de banco e não fica instável
 * na CI.
 *
 * O preço é o limite declarado abaixo: não dá pra testar o caminho feliz sem
 * um banco. Caminho feliz continua sendo trabalho da sessão de teste real.
 */

process.env.INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || 'test-secret-not-used-here';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { app } = require('./server');

let server;
let baseUrl;

before(async () => {
  await new Promise((resolve) => {
    // Porta 0 = o SO escolhe uma livre. Fixar porta faria a suíte brigar com
    // um game-api rodando na máquina do dev.
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

function request(method, path, { body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      `${baseUrl}${path}`,
      {
        method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {}
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(data); } catch { /* corpo não-JSON é resultado válido de teste */ }
          resolve({ status: res.statusCode, body: parsed, raw: data });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Ticket com formato plausível: 64 hex, o mesmo tamanho que `makeSessionTicket`
// produz. Se alguma rota voltar a ler da query string, este valor passa do
// filtro de tamanho e o comportamento muda de forma observável.
const PLAUSIBLE_TICKET = 'a'.repeat(64);

describe('SEC-QS-01 — o ticket não viaja em query string', () => {
  test('GET /api/queue/status não existe mais', async () => {
    const res = await request('GET', `/api/queue/status?ticket=${PLAUSIBLE_TICKET}`);

    // 404 é a resposta do Express pra método sem rota registrada. Se isto voltar
    // a ser 200/401/500, o GET foi reintroduzido e o ticket voltou pra URL.
    assert.equal(res.status, 404, 'GET foi reintroduzido — o ticket voltou pra query string');
  });

  test('POST /api/queue/status ignora ticket vindo da query string', async () => {
    const res = await request('POST', `/api/queue/status?ticket=${PLAUSIBLE_TICKET}`, { body: {} });

    assert.equal(res.status, 401);
    assert.equal(res.body.message, 'invalid_ticket');
  });

  test('query string não muda a resposta em relação a não mandar ticket nenhum', async () => {
    const semTicket = await request('POST', '/api/queue/status', { body: {} });
    const comQuery = await request('POST', `/api/queue/status?ticket=${PLAUSIBLE_TICKET}`, { body: {} });

    assert.deepEqual(comQuery.body, semTicket.body);
    assert.equal(comQuery.status, semTicket.status);
  });

  test('POST /api/queue/join também ignora a query string', async () => {
    const res = await request('POST', `/api/queue/join?ticket=${PLAUSIBLE_TICKET}`, { body: {} });

    assert.equal(res.status, 401);
    assert.equal(res.body.message, 'invalid_ticket');
  });
});

describe('fila — recusa antes de tocar o banco', () => {
  for (const [nome, body] of [
    ['corpo vazio', {}],
    ['ticket nulo', { ticket: null }],
    ['ticket numérico', { ticket: 12345678901234567890123456789012 }],
    ['ticket curto demais', { ticket: 'abc' }],
    ['ticket com 31 caracteres', { ticket: 'a'.repeat(31) }]
  ]) {
    test(`status recusa ${nome} com 401`, async () => {
      const res = await request('POST', '/api/queue/status', { body });
      assert.equal(res.status, 401);
      assert.equal(res.body.message, 'invalid_ticket');
    });

    test(`join recusa ${nome} com 401`, async () => {
      const res = await request('POST', '/api/queue/join', { body });
      assert.equal(res.status, 401);
      assert.equal(res.body.message, 'invalid_ticket');
    });
  }

  test('requisição sem corpo nenhum não derruba a rota', async () => {
    // `express.json()` deixa `req.body` indefinido quando não há corpo. A rota
    // faz `(req.body || {}).ticket` justamente por isso; se alguém tirar esse
    // guarda, isto vira 500.
    const res = await request('POST', '/api/queue/status');
    assert.equal(res.status, 401);
  });
});

describe('fila — kind errado nunca cruza rota (AUTH-002 regra 1)', () => {
  const credential = require('../../skymp/gamemode/core/opaque-credential');

  test('/api/queue/join recusa um queue_grant bem-formado, sem tocar o banco', async () => {
    const queueGrant = credential.generate('queue_grant');
    const res = await request('POST', '/api/queue/join', { body: { ticket: queueGrant } });
    assert.equal(res.status, 401);
    assert.equal(res.body.message, 'invalid_ticket');
  });

  test('/api/queue/status recusa um launch_grant bem-formado, sem tocar o banco', async () => {
    const launchGrant = credential.generate('launch_grant');
    const res = await request('POST', '/api/queue/status', { body: { ticket: launchGrant } });
    assert.equal(res.status, 401);
    assert.equal(res.body.message, 'invalid_ticket');
  });

  test('/api/queue/status recusa um game_session apresentado como queue_grant', async () => {
    const gameSession = credential.generate('game_session');
    const res = await request('POST', '/api/queue/status', { body: { ticket: gameSession } });
    assert.equal(res.status, 401);
    assert.equal(res.body.message, 'invalid_ticket');
  });
});

describe('endpoints internos exigem segredo', () => {
  test('session/resolve sem X-Internal-Secret responde 401', async () => {
    const res = await request('POST', '/internal/session/resolve', { body: { session: 'x' } });
    assert.equal(res.status, 401);
  });

  test('session/release sem X-Internal-Secret responde 401', async () => {
    const res = await request('POST', '/internal/session/release', { body: { session: 'x' } });
    assert.equal(res.status, 401);
  });
});

describe('/health responde sem banco', () => {
  test('devolve o estado do manifesto e da fila', async () => {
    const res = await request('GET', '/health');

    assert.equal(res.status, 200);
    assert.ok(Object.prototype.hasOwnProperty.call(res.body, 'ok'));
    assert.ok(res.body.queue, 'health precisa expor o estado da fila');
  });
});

/**
 * ## O que esta suíte NÃO prova
 *
 * - **Nada do caminho feliz.** Todo caso aqui termina em recusa antecipada.
 *   Ticket válido, admissão, emissão de `pollTicket` e persistência de sessão
 *   exigem MariaDB e continuam sem cobertura automatizada.
 * - **Não prova ausência de leitura da query string quando há banco.** Com um
 *   banco disponível, uma regressão que lesse `req.query.ticket` também
 *   devolveria 401 (o ticket não existiria na tabela). O que trava a regressão
 *   de verdade é o teste do GET 404: reverter o transporte sem reverter o
 *   método é improvável, e o método é observável sem banco.
 */
