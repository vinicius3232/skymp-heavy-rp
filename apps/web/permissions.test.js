/**
 * apps/web/permissions.test.js
 *
 * **A matriz rota × cargo do painel.** É o teste que não existia.
 *
 * `server.test.js` cobre "as doze rotas respondem 401 sem sessão" — e nada mais.
 * Nunca se verificou que um `moderator` NÃO pode alguma coisa, pela razão
 * simples de que não havia nada que ele não pudesse: `requireStaff` aceitava
 * qualquer cargo, e a granularidade morava do outro lado do muro, no gamemode.
 * Ver `docs/admin/SKYADMIN_CURRENT_STATE.md` §5.
 *
 * A forma é a de `permissions.behavior.test.js`, que é o irmão deste arquivo do
 * lado do jogo: **matriz escrita à mão, uma linha por rota, cargo × efeito
 * real** — aqui o efeito é o status HTTP e a linha de auditoria, lá é o ledger
 * escrito e o status mudado. Derivar a matriz do catálogo faria o teste
 * concordar consigo mesmo, que é o formato mais caro de teste inútil.
 *
 * ─── O que cada caso pega ───────────────────────────────────────────────────
 *
 *   - `200` onde deveria ser `403`: escalação de privilégio.
 *   - `403` onde deveria ser `200`: alguém apertou o cargo sem perceber, e a
 *     staff descobre isso tentando trabalhar.
 *   - `403` sem linha em `audit_logs`: negação invisível. A pergunta "alguém
 *     está sondando permissões que não tem?" volta a ser impossível de
 *     responder, que é o sinal que se quer ver ANTES de um incidente.
 *
 * Executa com: node --test permissions.test.js
 */

'use strict';

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('path');

const catalog = require('../../skymp/gamemode/core/permissions');
const { COLUMNS: colunas } = require('../../skymp/gamemode/core/audit-event');

// ─────────────────────────────────────────────────────────────────────────────
// Duplo de MySQL + sessão
// ─────────────────────────────────────────────────────────────────────────────

const ACCOUNT_ID = 77;

/** O cargo do "usuário logado". `null` = tem conta e não é staff. */
let cargoAtual = null;
/** `active` | `banned` | `suspended` — o status da conta da staff. */
let statusConta = 'active';
/** Toda linha gravada em `audit_logs` durante o caso. */
let auditoria = [];

const fakePool = {
  execute: async (sql, params = []) => {
    const limpo = sql.replace(/\s+/g, ' ').trim();

    // A consulta do middleware: cargo + status numa tacada só.
    if (/FROM accounts a LEFT JOIN staff_roles/i.test(limpo)) {
      if (params[0] !== ACCOUNT_ID) return [[], []];
      return [[{ account_status: statusConta, role: cargoAtual }], []];
    }
    // A decisão de autorização passou a ser um SECURITY EVENT em
    // `audit_events`, com colunas de verdade — antes era texto livre dentro de
    // `details` em `audit_logs`. A sonda acompanha a mudança de destino, e a
    // asserção fica MAIS forte: ela deixa de procurar substring numa string e
    // passa a olhar coluna.
    //
    // As posições vêm de `COLUMNS` do catálogo, e não de números escritos à
    // mão: uma coluna inserida no meio deslocaria tudo, e a sonda passaria a
    // ler `severity` onde espera `action` sem erro nenhum.
    if (/INSERT INTO audit_events/i.test(limpo)) {
      const col = (nome) => params[colunas.indexOf(nome)];
      auditoria.push({
        action: col('action'),
        category: col('category'),
        severity: col('severity'),
        outcome: col('outcome'),
        permission: col('permission'),
        reason: col('reason'),
        actor: col('staff_account_id')
      });
      return [{ affectedRows: 1 }, []];
    }
    // Queries de contagem do dashboard. Precisam de forma válida: sem isto o
    // handler explode com 500, e um teste que só exige "não é 403" aceitaria
    // essa explosão como sucesso — medindo o portão contra uma rota quebrada.
    if (/SELECT COUNT\(\*\) as c/i.test(limpo)) return [[{ c: 0 }], []];

    // Qualquer outra query é do handler da rota. Devolver vazio basta: o que
    // este arquivo mede é o portão, não o conteúdo.
    return [[], []];
  }
};

const realLoad = Module._load;
Module._load = function (request) {
  if (request === 'mysql2/promise') return { createPool: () => fakePool };

  // Sessão falsa: injeta `req.user` e `req.isAuthenticated` sem precisar de um
  // fluxo de OAuth. O `passport` REAL continua sendo carregado — só os dois
  // middlewares dele são trocados.
  //
  // Sobrescrever no objeto em vez de devolver uma cópia com spread: `passport`
  // exporta uma INSTÂNCIA de classe, e `{...instancia}` copia só as
  // propriedades próprias — os métodos vivem no protótipo e somem. O sintoma é
  // `passport.serializeUser is not a function` no carregamento do servidor.
  if (request === 'passport') {
    const real = realLoad.apply(this, arguments);
    real.initialize = () => (req, res, next) => next();
    real.session = () => (req, res, next) => {
      req.isAuthenticated = () => autenticado;
      req.user = autenticado ? { accountId: ACCOUNT_ID, username: 'staff-de-teste' } : undefined;
      next();
    };
    return real;
  }
  return realLoad.apply(this, arguments);
};

/** Se o request tem sessão. Testes de 401 desligam. */
let autenticado = true;

process.env.INTERNAL_API_SECRET = 'test-internal-secret';
process.env.MASTER_KEY = 'chave-do-servidor-de-teste';
process.env.SESSION_SECRET = 'test-session-secret';
process.env.DISCORD_CLIENT_ID = 'test-client-id';
process.env.DISCORD_CLIENT_SECRET = 'test-client-secret';

const { app } = require(path.join(__dirname, 'server.js'));
Module._load = realLoad;

let server;
let baseUrl;

before(async () => {
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise((resolve) => server.close(resolve)); });

beforeEach(() => {
  auditoria = [];
  autenticado = true;
  statusConta = 'active';
});

async function chamar(method, rota) {
  return fetch(`${baseUrl}${rota}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify({ status: 'approved' }),
    redirect: 'manual'
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// A matriz. Escrita à mão.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Uma linha por rota de staff do painel. `permissao` é o que a rota exige;
 * `moderator`/`admin`/`owner` é se aquele cargo passa.
 *
 * Mudou aqui? Você está mudando quem enxerga o quê no painel. Diga o porquê no
 * corpo do commit.
 */
const ROTAS = [
  // rota                        método   permissão            mod    admin  owner
  ['/api/dashboard',             'GET',   'server.view',       true,  true,  true],
  ['/api/whitelist',             'GET',   'whitelist.view',    true,  true,  true],
  ['/api/whitelist/1',           'PATCH', 'whitelist.review',  true,  true,  true],
  ['/api/characters',            'GET',   'characters.view',   true,  true,  true],
  ['/api/audit',                 'GET',   'audit.view',        true,  true,  true],
  ['/api/criminal',              'GET',   'governance.view',   true,  true,  true],
  ['/api/factions',              'GET',   'governance.view',   true,  true,  true],
  ['/api/prison',                'GET',   'governance.view',   true,  true,  true],

  // As duas que o moderador PERDEU ao fechar a porta. Até aqui o painel não
  // perguntava nada, então "moderador" significava, na web, o mesmo que "owner".
  ['/api/economy/holds',         'GET',   'economy.view',      false, true,  true],
  ['/api/economy/top-gold',      'GET',   'economy.view',      false, true,  true],
  // Crash reports carregam Discord ID e username de cada jogador que crashou —
  // era a rota com o pior par risco/permissão do painel inteiro.
  ['/api/crashes',               'GET',   'security.view',     false, true,  true],

  // A auditoria ganhou detalhe e resumo, e o fluxo de evento de jogo ganhou
  // rota própria — `audit_logs` deixou de ser a auditoria e passou a ser o
  // registro de chat, combate e morte.
  ['/api/audit/event/abc',       'GET',   'audit.view',        true,  true,  true],
  ['/api/audit/summary',         'GET',   'audit.view',        true,  true,  true],
  ['/api/events/gameplay',       'GET',   'governance.view',   true,  true,  true]
];

const CARGOS = ['moderator', 'admin', 'owner'];

describe('matriz rota × cargo', () => {
  for (const [rota, metodo, permissao, ...esperado] of ROTAS) {
    CARGOS.forEach((cargo, i) => {
      const podeAcessar = esperado[i];

      test(`${cargo} ${podeAcessar ? 'ACESSA' : 'NAO ACESSA'} ${metodo} ${rota}`, async () => {
        cargoAtual = cargo;
        const res = await chamar(metodo, rota);

        if (podeAcessar) {
          // 200 e não "qualquer coisa menos 403": um handler que explode com
          // 500 passaria na versão frouxa, e o teste estaria medindo o portão
          // contra uma rota quebrada.
          //
          // 409 e 404 entram na lista porque são o portão tendo deixado passar
          // e o ALVO não existindo no duplo: o `PATCH` não acha a aplicação de
          // whitelist, e o detalhe de auditoria não acha o evento. Os dois são
          // resposta correta de uma rota funcionando — o que estes casos medem
          // é só que ninguém foi barrado por permissão.
          assert.ok(
            [200, 404, 409].includes(res.status),
            `${cargo} deveria passar em ${metodo} ${rota} (exige '${permissao}') e recebeu ${res.status}. ` +
            `Se a intenção era tirar essa permissão do cargo, atualize a MATRIZ e o catálogo.`
          );
        } else {
          assert.equal(
            res.status, 403,
            `${cargo} NAO deveria passar em ${metodo} ${rota} (exige '${permissao}'). ` +
            `Isso é escalação de privilégio: a rota provavelmente não chama requirePermission.`
          );
          assert.ok(
            auditoria.some((l) => l.outcome === 'denied' && l.permission === permissao),
            `${cargo} foi barrado em ${metodo} ${rota} e a negação NAO virou linha de auditoria. ` +
            `Negação invisível é o sinal que se quer ver antes de um incidente, não depois.`
          );
        }
      });
    });
  }

  test('a matriz cobre toda rota de staff que existe no servidor', () => {
    // A varredura é do arquivo de rotas, não da matriz: ela pega a rota NOVA
    // que alguém adicionar sem passar por aqui — que é exatamente como as doze
    // rotas originais nasceram sem verificação nenhuma.
    const fonte = require('fs').readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    const declaradas = [...fonte.matchAll(/app\.(get|post|patch|put|delete)\(\s*'([^']+)'\s*,\s*requirePermission/g)]
      .map((m) => `${m[1].toUpperCase()} ${m[2]}`);

    const naMatriz = new Set(ROTAS.map(([rota, metodo]) => {
      const normalizada = rota.replace(/\/1$/, '/:id').replace(/\/abc$/, '/:eventId');
      return `${metodo} ${normalizada}`;
    }));
    const ausentes = declaradas.filter((d) => !naMatriz.has(d));

    assert.deepEqual(
      ausentes, [],
      `Rota(s) protegida(s) por requirePermission e fora da matriz: ${ausentes.join(', ')}. ` +
      `Toda rota de staff entra aqui — senão ela nasce sem ninguém verificando quem pode chamá-la.`
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// As negações que não dependem de cargo
// ─────────────────────────────────────────────────────────────────────────────

describe('negações estruturais', () => {
  test('sem sessão continua sendo 401, não 403', async () => {
    // A distinção importa e o `server.test.js` depende dela: 401 é "não sei
    // quem você é", 403 é "sei e você não pode".
    autenticado = false;
    cargoAtual = 'owner';
    const res = await chamar('GET', '/api/audit');
    assert.equal(res.status, 401);
    autenticado = true;
  });

  test('conta sem cargo nenhum é negada e auditada', async () => {
    cargoAtual = null;
    const res = await chamar('GET', '/api/dashboard');
    assert.equal(res.status, 403);
    assert.ok(auditoria.some((l) => l.outcome === 'denied' && l.reason === 'no_role'));
  });

  test('cargo desconhecido no banco nega TUDO, e não libera tudo', async () => {
    // O defeito exato do sistema anterior: `role='support'` dava acesso total
    // ao painel (`rows.length !== 0`) e zero em jogo (`Set` vazio), em silêncio.
    cargoAtual = 'support';
    for (const [rota, metodo] of ROTAS) {
      auditoria = [];
      const res = await chamar(metodo, rota);
      assert.equal(res.status, 403, `cargo 'support' passou em ${metodo} ${rota}`);
      assert.ok(
        auditoria.some((l) => l.reason === 'unknown_role'),
        `${metodo} ${rota} negou o cargo desconhecido sem dizer que era isso`
      );
    }
  });

  test('conta banida com cargo de staff não entra no painel', async () => {
    // O ban bloqueava o JOGO (whitelist.js, game-api) e não a WEB: uma conta
    // `status='banned'` com linha em `staff_roles` continuava entrando.
    cargoAtual = 'owner';
    statusConta = 'banned';
    const res = await chamar('GET', '/api/audit');
    assert.equal(res.status, 403);
    assert.ok(auditoria.some((l) => l.reason === 'account_banned'));
  });

  test('a concessão sensível também vira registro', async () => {
    // Três rotas pedem `auditGrant`: quem leu o audit log, o ranking de
    // patrimônio e os crash reports. A regra vem do módulo de voz, que já
    // decidiu que consultar o estado de um jogador é registro.
    cargoAtual = 'owner';
    await chamar('GET', '/api/audit');
    assert.ok(
      auditoria.some((l) => l.outcome === 'executed' && l.permission === 'audit.view'),
      'ler o registro de auditoria inteiro precisa deixar rastro de quem leu'
    );
  });

  test('a leitura comum NAO vira registro', async () => {
    // Auditar toda leitura produziria um log que ninguém lê, que é o mesmo que
    // não auditar.
    cargoAtual = 'owner';
    await chamar('GET', '/api/dashboard');
    assert.equal(
      auditoria.filter((l) => l.outcome === 'executed').length, 0,
      'o contador do dashboard não é material de auditoria'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Guardas estáticas
// ─────────────────────────────────────────────────────────────────────────────

describe('o painel não pode voltar a decidir sozinho', () => {
  const fonte = require('fs').readFileSync(path.join(__dirname, 'server.js'), 'utf8');

  test('`requireStaff` não existe mais', () => {
    const chamadas = fonte.split('\n').filter(
      (linha) => /requireStaff/.test(linha) && !linha.trimStart().startsWith('//') && !linha.trimStart().startsWith('*')
    );
    assert.deepEqual(
      chamadas, [],
      `\`requireStaff\` voltou: ${chamadas.join(' | ')}. Ele aceitava qualquer cargo e protegia doze rotas, ` +
      `incluindo a única mutável. Um guard que aceita todo mundo é indistinguível, na leitura do arquivo, ` +
      `de um que verifica alguma coisa — e foi essa indistinguibilidade que deixou as doze passarem.`
    );
  });

  test('nenhuma rota de dados fica sem guard', () => {
    // O `\s*` fica DENTRO do lookahead de propósito. Fora dele, ele casa zero
    // caracteres e a negativa passa a ser avaliada no espaço que antecede o
    // nome do guard — `', requireAuth'` "não começa com requireAuth" porque
    // começa com espaço, e toda rota guardada era reportada como sem guard.
    const semGuard = [...fonte.matchAll(/app\.(get|post|patch|put|delete)\(\s*'(\/api\/[^']+)'\s*,(?!\s*(?:requirePermission|requireAuth))/g)]
      .map((m) => `${m[1].toUpperCase()} ${m[2]}`)
      // Rotas públicas por contrato, cada uma com a própria fronteira:
      // OAuth do Discord, logout, o master API do SkyMP (masterKey + rate
      // limit), a troca de OAuth do launcher e o recebimento de crash.
      .filter((r) => !/\/api\/auth\/|\/api\/servers\/|\/api\/launcher\/|\/api\/crashes\/client/.test(r));

    assert.deepEqual(
      semGuard, [],
      `Rota(s) de API sem guard nenhum: ${semGuard.join(', ')}.`
    );
  });

  test('o painel não tem uma segunda tabela cargo→permissão', () => {
    // A duplicação é o defeito que este trabalho existe para remover. Se alguém
    // reintroduzir um mapa aqui, os dois lados voltam a divergir em silêncio.
    assert.ok(
      !/ROLE_PERMISSIONS|ROLE_CAPABILITIES\s*=/.test(fonte),
      'apps/web/server.js declarou o próprio mapa de cargos. A fonte única é skymp/gamemode/core/permissions.js.'
    );
  });

  test('toda permissão usada nas rotas existe e está ativa no catálogo', () => {
    for (const m of fonte.matchAll(/requirePermission\(\s*'([^']+)'/g)) {
      const nome = m[1];
      assert.ok(catalog.CAPABILITIES[nome], `rota exige '${nome}', que não está no catálogo`);
      assert.equal(
        catalog.CAPABILITIES[nome].status, 'active',
        `rota exige '${nome}', que está RESERVADA — ela nega para todo cargo, inclusive owner`
      );
    }
  });
});
