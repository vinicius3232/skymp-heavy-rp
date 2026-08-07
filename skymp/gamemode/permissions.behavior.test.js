/**
 * permissions.behavior.test.js
 *
 * Teste de comportamento de permissão por cargo — o equivalente aos testes
 * pgTAP de RLS por cargo que servidores institucionais usam.
 *
 * A diferença para `admin-service.test.js` importa e é o motivo deste arquivo
 * existir separado: aquele testa `hasPermission` e um comando. Este pergunta,
 * para **cada cargo** e **cada comando de staff**, se a ação de fato acontece
 * ou de fato é negada — chamando o handler real e olhando o efeito colateral,
 * não o retorno.
 *
 * Por que isso pega o que o teste unitário não pega:
 *
 *   1. `hasPermission` pode estar perfeito e o handler não chamá-lo. Um teste
 *      de `hasPermission` passa; a porta fica aberta. Aqui o handler é chamado
 *      de verdade, então esquecer a checagem quebra o teste.
 *   2. O bug `Set.has(20)` (doze chamadas passando nível numérico contra um Set
 *      de strings, negando tudo em silêncio) atravessou toda a suíte unitária.
 *      Uma matriz explícita de cargo × ação é exatamente o que o teria pego.
 *   3. Alargar um cargo em `ROLE_PERMISSIONS` deixa de ser uma linha discreta:
 *      dar `set_gold` ao moderador quebra este arquivo e obriga quem fez a
 *      declarar a mudança na matriz abaixo.
 *
 * A matriz é escrita à mão de propósito. Derivá-la de `ROLE_PERMISSIONS` faria
 * o teste concordar consigo mesmo — que é o formato mais caro de teste inútil.
 *
 * Executa com: node --test permissions.behavior.test.js
 */

const assert = require('assert');
const { describe, it, beforeEach } = require('node:test');

// ─────────────────────────────────────────────────────────────────────────────
// Estado observável dos mocks
// ─────────────────────────────────────────────────────────────────────────────

const auditEntries = [];      // { action, ... } gravados em audit_logs
const goldUpdates = [];       // UPDATE characters SET gold (dentro da transacao)
const goldLedger = [];        // INSERT INTO gold_transactions — o rastro da economia
const statusUpdates = [];     // UPDATE characters SET status
const notifications = [];     // { actorId, message }
const itemsGiven = [];        // transaction-service.giveItem

let staffRoleRow = null;      // { role: 'moderator' } | null
let saldoAtual = 0;           // SELECT gold FROM characters

function resetState() {
  auditEntries.length = 0;
  goldUpdates.length = 0;
  goldLedger.length = 0;
  statusUpdates.length = 0;
  notifications.length = 0;
  itemsGiven.length = 0;
  saldoAtual = 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mocks
// ─────────────────────────────────────────────────────────────────────────────

const STAFF_ACTOR_ID = 0xff00b001;
const STAFF_ACCOUNT_ID = 1;
const TARGET_ACTOR_ID = 0xff00b002;
const TARGET_ACCOUNT_ID = 2;
const TARGET_CHARACTER_ID = 42;

const Module = require('module');
const originalLoad = Module._load;

// Uma unica implementacao de query serve o `db.query` (fora de transacao) e o
// `conn.query` (dentro dela). A diferenca esta so no formato do retorno: o
// database.js devolve `rows` e o mysql2 cru devolve `[rows, fields]`, que e o
// que o transaction-service desestrutura.
function responderQuery(sql, params = []) {
  if (/SELECT role FROM staff_roles/i.test(sql)) {
    return staffRoleRow ? [staffRoleRow] : [];
  }
  if (/SELECT gold FROM characters/i.test(sql)) {
    return [{ gold: saldoAtual }];
  }
  if (/UPDATE characters SET gold/i.test(sql)) {
    // `gold = gold + ?` — o transaction-service so move por delta.
    goldUpdates.push({ delta: params[0], characterId: params[1] });
    saldoAtual += Number(params[0]) || 0;
    return {};
  }
  if (/INSERT INTO gold_transactions/i.test(sql)) {
    // (transaction_id, character_id, delta, reason, module, idempotency_key, status)
    goldLedger.push({ characterId: params[1], delta: params[2], reason: params[3], module: params[4] });
    return {};
  }
  if (/UPDATE characters SET status/i.test(sql)) {
    statusUpdates.push({ status: params[0], characterId: params[1] });
    return {};
  }
  if (/INSERT INTO audit_logs/i.test(sql)) {
    // Ordem real do admin-service: (action, actor_account_id, target_account_id, details)
    auditEntries.push({ action: params[0], details: params[3] });
    return {};
  }
  return [];
}

Module._load = function (request, parent, isMain) {
  if (request.endsWith('/database') || request === './database') {
    return {
      init: () => {},
      query: async (sql, params = []) => responderQuery(sql, params),
      // O `/setgold` passou a mover ouro pelo core/transaction-service, que
      // abre transacao — sem isto o mock nao alcanca mais o caminho do dinheiro.
      getConnection: async () => ({
        query: async (sql, params = []) => {
          const resultado = responderQuery(sql, params);
          return [resultado, []]; // mysql2 cru devolve [rows, fields]
        },
        beginTransaction: async () => {},
        commit: async () => {},
        rollback: async () => {},
        release: () => {}
      })
    };
  }

  if (request === './commands' || request.endsWith('/commands')) {
    return {
      sendNotification: (actorId, message) => notifications.push({ actorId, message }),
      getActiveCharacterData: (actorId) => {
        if (actorId === STAFF_ACTOR_ID) {
          return { accountId: STAFF_ACCOUNT_ID, characterId: 1, name: 'Staff' };
        }
        if (actorId === TARGET_ACTOR_ID) {
          return { accountId: TARGET_ACCOUNT_ID, characterId: TARGET_CHARACTER_ID, name: 'Alvo' };
        }
        return null;
      },
      registerCommand: () => {},
      unregisterCommand: () => {}
    };
  }

  if (request === './core/transaction-service' || request.endsWith('/core/transaction-service')) {
    // O módulo REAL, com só o `giveItem` substituído.
    //
    // Substituir o serviço inteiro por um stub tornaria o teste de `/setgold`
    // circular: ele passaria a verificar que o mock escreve no ledger, não que
    // o comando usa o caminho que escreve. Como `database` também está mockado
    // aqui (e ganhou `getConnection`), o serviço real roda de ponta a ponta
    // contra o banco falso — BEGIN, SELECT ... FOR UPDATE, ledger e COMMIT
    // incluídos.
    //
    // `giveItem` continua stub porque `itemsGiven` é a sonda de `giveItemAdmin`,
    // que é outro comando desta matriz e não tem nada a ver com ouro.
    const real = originalLoad.apply(this, arguments);
    return {
      ...real,
      giveItem: async (payload) => {
        itemsGiven.push(payload);
        return true;
      }
    };
  }

  return originalLoad.apply(this, arguments);
};

const admin = require('./admin-service');

// O mock fica instalado pelo arquivo inteiro, de propósito: `giveItemAdmin`
// faz `require('./core/transaction-service')` **dentro** da função, então
// restaurar o loader aqui deixaria o handler alcançar o banco de verdade.

// ─────────────────────────────────────────────────────────────────────────────
// A matriz. Escrita à mão, deliberadamente.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cada ação declara como invocá-la e como saber que ela **aconteceu de verdade**.
 * `aconteceu` nunca olha o valor de retorno — os handlers de staff retornam
 * `undefined` tanto no sucesso quanto na negação, que é justamente por que um
 * teste de retorno não protegeria nada aqui.
 */
const ACOES = {
  playAnimation: {
    permissao: 'teleport',
    invoca: () => admin.playAnimation(STAFF_ACTOR_ID, TARGET_ACTOR_ID, 'IdleApplaud'),
    aconteceu: () => auditEntries.some(e => e.action === 'staff:playAnimation')
  },
  teleportTo: {
    permissao: 'teleport',
    invoca: () => admin.teleportTo(STAFF_ACTOR_ID, TARGET_ACTOR_ID),
    aconteceu: () => auditEntries.some(e => e.action === 'staff:teleport')
  },
  kickPlayer: {
    permissao: 'kick',
    invoca: () => admin.kickPlayer(STAFF_ACTOR_ID, TARGET_ACTOR_ID, 'motivo de teste'),
    aconteceu: () => auditEntries.some(e => e.action === 'staff:kick')
  },
  giveItemAdmin: {
    permissao: 'add_item',
    invoca: () => admin.giveItemAdmin(STAFF_ACTOR_ID, TARGET_ACTOR_ID, 0x0000000f, 10),
    aconteceu: () => itemsGiven.length > 0
  },
  setGold: {
    permissao: 'set_gold',
    invoca: () => admin.setGold(STAFF_ACTOR_ID, TARGET_ACTOR_ID, 500),
    // Antes esta sonda era `goldUpdates.length > 0` — ela observava o
    // `UPDATE characters SET gold` solto que o comando fazia. Isso amarrava o
    // teste justamente ao padrao que o CONTRIBUTING §3.1 proibe, e por isso ele
    // quebrou quando o comando passou pelo core/transaction-service.
    //
    // A sonda nova e mais forte: exige que o ouro tenha se movido **e** que a
    // movimentacao tenha virado linha no ledger. Ouro que muda sem rastro em
    // `gold_transactions` agora reprova aqui, que e exatamente o defeito que o
    // comando tinha.
    aconteceu: () => goldUpdates.length > 0 && goldLedger.length > 0
  },
  retireCharacter: {
    permissao: 'retire_character',
    invoca: () => admin.retireCharacter(STAFF_ACTOR_ID, TARGET_ACTOR_ID, 'motivo de teste'),
    aconteceu: () => statusUpdates.some(u => u.status === 'retired')
  },
  revealIdentity: {
    permissao: 'reveal_identity',
    invoca: () => admin.revealIdentity(STAFF_ACTOR_ID, TARGET_ACTOR_ID),
    // A sonda é a linha de auditoria, não a notificação. Revelar sem rastro é
    // pior do que não revelar: a única coisa que torna o poder aceitável é
    // alguém conseguir provar depois que ele foi usado, contra quem e por quem.
    aconteceu: () => auditEntries.some(e => e.action === 'identity:staff_reveal')
  }
};

/**
 * `true` = o cargo PODE. `false` = precisa ser negado.
 *
 * Mudou aqui? Você está mudando a autoridade da staff no servidor. Diga o
 * porquê no corpo do commit — este arquivo é o registro de quem pode o quê.
 */
const MATRIZ = {
  //                 sem cargo  moderator  admin  owner
  playAnimation:   { nenhum: false, moderator: true,  admin: true,  owner: true },
  teleportTo:      { nenhum: false, moderator: true,  admin: true,  owner: true },
  kickPlayer:      { nenhum: false, moderator: true,  admin: true,  owner: true },
  giveItemAdmin:   { nenhum: false, moderator: false, admin: true,  owner: true },
  setGold:         { nenhum: false, moderator: false, admin: true,  owner: true },
  // Morte permanente nunca é decisão de linha de frente.
  retireCharacter: { nenhum: false, moderator: false, admin: true,  owner: true },
  // Nem furar o anonimato de um jogador: é a única ação de staff que não tem
  // como ser desfeita — nem por outro comando, nem pelo tempo. Ver o bloco de
  // ROLE_PERMISSIONS em admin-service.js.
  revealIdentity:  { nenhum: false, moderator: false, admin: true,  owner: true }
};

const CARGOS = ['nenhum', 'moderator', 'admin', 'owner'];

async function comCargo(cargo) {
  resetState();
  admin.removeStaffRole(STAFF_ACTOR_ID);
  staffRoleRow = cargo === 'nenhum' ? null : { role: cargo };
  await admin.registerStaffRole(STAFF_ACTOR_ID, STAFF_ACCOUNT_ID);
}

function negacaoFoiEnviada() {
  return notifications.some(
    n => n.actorId === STAFF_ACTOR_ID && /permiss/i.test(n.message) && /negad/i.test(n.message)
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Testes
// ─────────────────────────────────────────────────────────────────────────────

describe('matriz de permissão por cargo — comportamento real dos comandos', () => {
  for (const [nomeAcao, acao] of Object.entries(ACOES)) {
    for (const cargo of CARGOS) {
      const permitido = MATRIZ[nomeAcao][cargo];
      const rotulo = `${cargo} ${permitido ? 'PODE' : 'NAO PODE'} ${nomeAcao}`;

      it(rotulo, async () => {
        await comCargo(cargo);
        await acao.invoca();

        if (permitido) {
          assert.equal(
            acao.aconteceu(), true,
            `${cargo} deveria conseguir ${nomeAcao} (permissao '${acao.permissao}'), mas a acao nao teve efeito. ` +
            `Se a intencao era tirar essa permissao do cargo, atualize a MATRIZ neste arquivo.`
          );
        } else {
          assert.equal(
            acao.aconteceu(), false,
            `${cargo} NAO deveria conseguir ${nomeAcao}, mas a acao aconteceu. ` +
            `Isso e uma escalacao de privilegio: o handler provavelmente nao chama hasPermission('${acao.permissao}').`
          );
          assert.equal(
            negacaoFoiEnviada(), true,
            `${cargo} foi barrado em ${nomeAcao}, mas nao recebeu aviso de permissao negada. ` +
            `Negar em silencio faz o jogador achar que o comando esta quebrado.`
          );
        }
      });
    }
  }
});

describe('a matriz cobre todo comando de staff que existe', () => {
  it('nenhum handler exportado ficou de fora da matriz', () => {
    // Handlers que não são comandos de staff sujeitos a permissão.
    const naoSaoComandos = new Set([
      'registerStaffRole', 'removeStaffRole', 'hasPermission', 'getRole', 'auditLog'
    ]);

    const exportados = Object.keys(admin).filter(
      key => typeof admin[key] === 'function' && !naoSaoComandos.has(key)
    );

    const ausentes = exportados.filter(nome => !(nome in ACOES));
    assert.deepEqual(
      ausentes, [],
      `Comando(s) de staff sem cobertura de permissao: ${ausentes.join(', ')}. ` +
      `Todo comando novo entra na MATRIZ — senao ele nasce sem ninguem verificando quem pode usar.`
    );
  });
});

describe('hasPermission recusa argumento invalido', () => {
  beforeEach(async () => {
    await comCargo('owner');
  });

  it('nivel numerico legado nega, mesmo para owner', () => {
    // O bug historico: 12 chamadas passavam 10/20 contra um Set de strings.
    assert.equal(admin.hasPermission(STAFF_ACTOR_ID, 20), false);
    assert.equal(admin.hasPermission(STAFF_ACTOR_ID, 10), false);
  });

  it('permissao inexistente nega, mesmo para owner', () => {
    // O caso oposto: quem escreve isso acha que criou uma regra e criou uma
    // porta que nunca abre.
    assert.equal(admin.hasPermission(STAFF_ACTOR_ID, 'manage_factions'), false);
  });

  it('owner tem de fato as permissoes que declara', () => {
    for (const permissao of ['kick', 'teleport', 'add_item', 'set_gold', 'retire_character', 'manage_staff', 'reveal_identity']) {
      assert.equal(
        admin.hasPermission(STAFF_ACTOR_ID, permissao), true,
        `owner deveria ter '${permissao}'`
      );
    }
  });
});

/**
 * `/setgold` era o unico caminho de dinheiro do gamemode que escapava do
 * ledger: fazia `UPDATE characters SET gold = ?` direto, sem transacao e sem
 * linha em `gold_transactions`. E o comando que mais precisa de rastro — ouro
 * que aparece sem origem registrada e indistinguivel de duplicacao por bug, e
 * quem pode fazer isso e exatamente a staff.
 *
 * Estes testes olham o efeito no ledger, nao o retorno (que e `undefined` no
 * sucesso e na negacao, como todo handler de staff deste arquivo).
 */
describe('setGold move ouro pelo ledger, nunca por UPDATE solto', () => {
  beforeEach(async () => {
    await comCargo('owner');
  });

  it('grava a movimentacao em gold_transactions', async () => {
    saldoAtual = 200;
    await admin.setGold(STAFF_ACTOR_ID, TARGET_ACTOR_ID, 500);

    assert.equal(goldLedger.length, 1, 'toda mudanca de ouro precisa de uma linha no ledger');
    assert.equal(goldLedger[0].characterId, TARGET_CHARACTER_ID);
    assert.equal(goldLedger[0].reason, 'staff_setgold', 'o motivo e o que torna o rastro auditavel');
    assert.equal(goldLedger[0].module, 'admin');
  });

  it('converte o valor absoluto em delta a partir do saldo real', async () => {
    // A staff pede "500". O saldo e 200. O que vai pro banco e +300 — o
    // transaction-service so move por delta, que e o que permite `gold = gold + ?`
    // sob lock sem sobrescrever escrita concorrente.
    saldoAtual = 200;
    await admin.setGold(STAFF_ACTOR_ID, TARGET_ACTOR_ID, 500);

    assert.equal(goldUpdates.length, 1);
    assert.equal(goldUpdates[0].delta, 300, 'deveria somar a diferenca, nao gravar o valor absoluto');
  });

  it('abaixar o ouro tambem passa pelo ledger', async () => {
    saldoAtual = 1000;
    await admin.setGold(STAFF_ACTOR_ID, TARGET_ACTOR_ID, 250);

    assert.equal(goldUpdates[0].delta, -750);
    assert.equal(goldLedger.length, 1);
    assert.equal(goldLedger[0].delta, -750, 'o ledger precisa registrar a retirada, nao so a entrada');
  });

  it('pedir o saldo que ja existe nao gera movimentacao nem ruido no ledger', async () => {
    saldoAtual = 400;
    await admin.setGold(STAFF_ACTOR_ID, TARGET_ACTOR_ID, 400);

    assert.equal(goldUpdates.length, 0);
    assert.equal(goldLedger.length, 0, 'delta zero nao e transacao — poluiria a auditoria');
    assert.ok(
      auditEntries.some(e => e.action === 'staff:setGold'),
      'ainda assim o comando aconteceu e precisa constar no audit_logs'
    );
  });

  it('valor invalido nao zera o patrimonio do jogador', async () => {
    saldoAtual = 5000;
    // `/setgold <id>` sem valor faz o handler passar `parseInt(undefined)` = NaN.
    // Antes isso virava `SET gold = NaN`, que o MySQL grava como 0: um erro de
    // digitacao apagava a fortuna do jogador em silencio.
    await admin.setGold(STAFF_ACTOR_ID, TARGET_ACTOR_ID, Number.NaN);

    assert.equal(goldUpdates.length, 0, 'NaN nao pode chegar no banco');
    assert.equal(goldLedger.length, 0);
    assert.ok(
      notifications.some(n => /invalid/i.test(n.message)),
      'a staff precisa saber que o comando foi recusado'
    );
  });

  it('valor negativo e recusado', async () => {
    saldoAtual = 100;
    await admin.setGold(STAFF_ACTOR_ID, TARGET_ACTOR_ID, -50);

    assert.equal(goldUpdates.length, 0);
    assert.equal(goldLedger.length, 0);
  });
});
