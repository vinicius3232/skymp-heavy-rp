/**
 * identity-staff-reveal.test.js
 *
 * `/revelaridentidade` — a peça que o `NAMETAG_IDENTITY_SYSTEM.md` exigia desde
 * 12/07/2026 ("Staff deve ter comando auditado para revelar identidade") e que
 * nunca existiu numa forma correta.
 *
 * Este arquivo é separado de `permissions.behavior.test.js` porque as duas
 * perguntas são diferentes. Lá a pergunta é *"quem pode?"*, e a matriz de cargo
 * × ação já cobre `revealIdentity`. Aqui a pergunta é *"quando pode, revela a
 * coisa certa?"* — e a resposta histórica foi **não**.
 *
 * O `disguise-service.staffReveal` (apagado em 06/08/2026, ver
 * `PARKED_SERVICES_DECISION.md` §7.1, achado 5) montava a mensagem com
 * `commands.getActiveCharacterData(actorId)` — a própria staff — e usava o
 * `targetActorId` só para localizar o disfarce. `/revealid` respondia
 * *"X é na verdade \<nome de quem digitou o comando\>"*. Passar num teste de
 * permissão não teria pego isso: o comando era autorizado corretamente e
 * respondia corretamente errado.
 *
 * Como todo handler de staff deste projeto, `revealIdentity` devolve
 * `undefined` no sucesso e na negação. Nada aqui olha retorno — só efeito.
 *
 * Executa com: node --test identity-staff-reveal.test.js
 */

const assert = require('assert');
const { describe, it, beforeEach } = require('node:test');

// ─────────────────────────────────────────────────────────────────────────────
// Estado observável
// ─────────────────────────────────────────────────────────────────────────────

const auditEntries = [];   // { action, actorAccountId, targetAccountId, details }
const notifications = [];  // { actorId, message }

let staffRoleRow = null;

const STAFF_ACTOR_ID = 0xff00c001;
const STAFF_ACCOUNT_ID = 71;
const STAFF_CHARACTER_ID = 700;

const ALVO_ACTOR_ID = 0xff00c002;
const ALVO_ACCOUNT_ID = 72;
const ALVO_CHARACTER_ID = 800;

// Os dois nomes são deliberadamente distintos e reconhecíveis à vista: o bug
// histórico era devolver um no lugar do outro, e uma asserção só passaria a
// falhar de forma legível se os nomes não se parecerem em nada.
const STAFF_NOME = 'Sereth Vantir';
const ALVO_NOME = 'Brenna Coldhearth';

const PERSONAGENS = {
  [STAFF_ACTOR_ID]: {
    accountId: STAFF_ACCOUNT_ID,
    characterId: STAFF_CHARACTER_ID,
    firstName: 'Sereth',
    lastName: 'Vantir'
  },
  [ALVO_ACTOR_ID]: {
    accountId: ALVO_ACCOUNT_ID,
    characterId: ALVO_CHARACTER_ID,
    firstName: 'Brenna',
    lastName: 'Coldhearth'
  }
};

function resetState() {
  auditEntries.length = 0;
  notifications.length = 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mocks
// ─────────────────────────────────────────────────────────────────────────────

const Module = require('module');
const originalLoad = Module._load;

Module._load = function (request, parent, isMain) {
  if (request === './database' || request.endsWith('/database')) {
    return {
      init: () => {},
      query: async (sql, params = []) => {
        if (/SELECT role FROM staff_roles/i.test(sql)) {
          return staffRoleRow ? [staffRoleRow] : [];
        }
        if (/INSERT INTO audit_logs/i.test(sql)) {
          // (action, actor_account_id, target_account_id, details)
          auditEntries.push({
            action: params[0],
            actorAccountId: params[1],
            targetAccountId: params[2],
            details: params[3]
          });
          return {};
        }
        return [];
      }
    };
  }

  if (request === './commands' || request.endsWith('/commands')) {
    return {
      sendNotification: (actorId, message) => notifications.push({ actorId, message }),
      getActiveCharacterData: (actorId) => PERSONAGENS[actorId] || null,
      registerCommand: () => {},
      unregisterCommand: () => {}
    };
  }

  return originalLoad.apply(this, arguments);
};

// `identity-service` entra REAL de propósito. Substituí-lo por um stub tornaria
// o teste circular: ele passaria a verificar que o mock devolve um nome, não que
// o comando pede o nome a quem é dono do assunto. O único `require` dele que
// alcança o mundo é `./database`, que está mockado acima.
const admin = require('./admin-service');
const identity = require('./identity-service');

async function comCargo(cargo) {
  resetState();
  admin.removeStaffRole(STAFF_ACTOR_ID);
  staffRoleRow = cargo === null ? null : { role: cargo };
  await admin.registerStaffRole(STAFF_ACTOR_ID, STAFF_ACCOUNT_ID);
}

function notificacoesDaStaff() {
  return notifications.filter(n => n.actorId === STAFF_ACTOR_ID).map(n => n.message);
}

function linhaDeRevelacao() {
  return auditEntries.find(e => e.action === 'identity:staff_reveal') || null;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('/revelaridentidade — revela o ALVO, nunca quem executou', () => {
  beforeEach(async () => {
    await comCargo('admin');
  });

  it('devolve o nome real do alvo', async () => {
    await admin.revealIdentity(STAFF_ACTOR_ID, ALVO_ACTOR_ID);

    const mensagens = notificacoesDaStaff();
    assert.ok(
      mensagens.some(m => m.includes(ALVO_NOME)),
      `a staff deveria ter recebido "${ALVO_NOME}"; recebeu: ${JSON.stringify(mensagens)}`
    );
  });

  it('NAO devolve o nome de quem digitou o comando', async () => {
    // Este é o defeito do `staffReveal` antigo, literalmente:
    // `/revealid` respondia "X é na verdade <nome da própria staff>".
    // Trocar `targetChar` por `staffChar` no handler reprova aqui.
    await admin.revealIdentity(STAFF_ACTOR_ID, ALVO_ACTOR_ID);

    const mensagens = notificacoesDaStaff();
    assert.ok(
      !mensagens.some(m => m.includes(STAFF_NOME)),
      `a resposta trouxe o nome de quem executou (${STAFF_NOME}) — e o bug do /revealid antigo. ` +
      `Mensagens: ${JSON.stringify(mensagens)}`
    );
  });

  it('a auditoria aponta staff como ator e alvo como alvo, nao o contrario', async () => {
    await admin.revealIdentity(STAFF_ACTOR_ID, ALVO_ACTOR_ID);

    const linha = linhaDeRevelacao();
    assert.ok(linha, 'nenhuma linha identity:staff_reveal foi gravada');
    assert.equal(
      linha.actorAccountId, STAFF_ACCOUNT_ID,
      'actor_account_id precisa ser a conta de quem revelou'
    );
    assert.equal(
      linha.targetAccountId, ALVO_ACCOUNT_ID,
      'target_account_id precisa ser a conta de quem foi revelado — invertido, a auditoria acusa a vitima'
    );
    assert.ok(
      linha.details.includes(`targetCharacterId=${ALVO_CHARACTER_ID}`),
      `os detalhes precisam identificar o personagem revelado; vieram: ${linha.details}`
    );
    assert.ok(
      !linha.details.includes(`targetCharacterId=${STAFF_CHARACTER_ID}`),
      'os detalhes trouxeram o characterId de quem executou no lugar do alvo'
    );
  });

  it('o cargo vai na linha de auditoria', async () => {
    // Sem isso, uma revisão de "quem tinha esse poder em julho" precisa
    // reconstruir o histórico de staff_roles a partir de outro lugar.
    await admin.revealIdentity(STAFF_ACTOR_ID, ALVO_ACTOR_ID);
    assert.ok(linhaDeRevelacao().details.includes('role=admin'));
  });
});

describe('/revelaridentidade — revelar sem auditar e proibido', () => {
  it('toda revelacao bem-sucedida grava identity:staff_reveal', async () => {
    // Remover a chamada a `identity.auditIdentityEvent` do handler reprova aqui.
    await comCargo('owner');
    await admin.revealIdentity(STAFF_ACTOR_ID, ALVO_ACTOR_ID);

    assert.equal(
      auditEntries.filter(e => e.action === 'identity:staff_reveal').length, 1,
      'uma revelacao, uma linha — nem zero (sem rastro) nem duas (rastro duplicado)'
    );
  });

  it('negada por falta de permissao nao gera linha de auditoria nem vaza nome', async () => {
    await comCargo('moderator');
    await admin.revealIdentity(STAFF_ACTOR_ID, ALVO_ACTOR_ID);

    assert.equal(linhaDeRevelacao(), null, 'negacao nao e revelacao — nao deve poluir o audit_logs');
    const mensagens = notificacoesDaStaff();
    assert.ok(
      !mensagens.some(m => m.includes(ALVO_NOME)),
      'o nome real vazou mesmo com a permissao negada'
    );
    assert.ok(
      mensagens.some(m => /permiss/i.test(m) && /negad/i.test(m)),
      'negar em silencio faz a staff achar que o comando esta quebrado'
    );
  });

  it('sem cargo nenhum tambem nao vaza nem audita', async () => {
    await comCargo(null);
    await admin.revealIdentity(STAFF_ACTOR_ID, ALVO_ACTOR_ID);

    assert.equal(linhaDeRevelacao(), null);
    assert.ok(!notificacoesDaStaff().some(m => m.includes(ALVO_NOME)));
  });
});

describe('/revelaridentidade — nao contamina o conhecimento IC', () => {
  beforeEach(async () => {
    await comCargo('owner');
    identity.forgetKnownIdentities(STAFF_CHARACTER_ID);
  });

  it('a staff continua vendo Desconhecido no chat depois de revelar', async () => {
    // A revelação é OOC. Se ela escrevesse em `character_known_identities`, o
    // PERSONAGEM da staff passaria a chamar o alvo pelo nome real no chat local
    // para sempre — uma ferramenta de investigação virando máquina de
    // metagaming com rastro de aparência legítima.
    const staffChar = { characterId: STAFF_CHARACTER_ID, ...PERSONAGENS[STAFF_ACTOR_ID] };
    const alvoChar = { characterId: ALVO_CHARACTER_ID, ...PERSONAGENS[ALVO_ACTOR_ID] };

    assert.equal(identity.getDisplayName(staffChar, alvoChar), identity.UNKNOWN_NAME);

    await admin.revealIdentity(STAFF_ACTOR_ID, ALVO_ACTOR_ID);

    assert.equal(
      identity.getDisplayName(staffChar, alvoChar), identity.UNKNOWN_NAME,
      'revelar para a staff nao pode ensinar o personagem dela a reconhecer o alvo'
    );
  });

  it('a escada de exibicao normal continua com os degraus que tinha', async () => {
    // Guarda contra a alternativa recusada: um ramo de staff dentro de
    // `getDisplayName()`. Se alguém enfiar um lá, o alvo passa a aparecer com o
    // nome real para o observador que é staff, e isto reprova.
    //
    // Importa além desta rodada: a `PARKED_SERVICES_DECISION.md` §7.1 já decidiu
    // que o disfarce, quando voltar, entra como degrau nesta função. Ela precisa
    // continuar chegando limpa nas mãos de quem construir aquilo.
    const staffChar = { characterId: STAFF_CHARACTER_ID, ...PERSONAGENS[STAFF_ACTOR_ID] };
    const alvoChar = { characterId: ALVO_CHARACTER_ID, ...PERSONAGENS[ALVO_ACTOR_ID] };

    // 1. você mesmo → nome real
    assert.equal(identity.getDisplayName(staffChar, staffChar), STAFF_NOME);
    // 2. desconhecido → Desconhecido, mesmo sendo owner
    assert.equal(identity.getDisplayName(staffChar, alvoChar), identity.UNKNOWN_NAME);
    // 3. conhecido → o nome registrado
    identity.cacheKnownIdentity(STAFF_CHARACTER_ID, ALVO_CHARACTER_ID, 'A encapuzada', 'alias');
    assert.equal(identity.getDisplayName(staffChar, alvoChar), 'A encapuzada');
  });
});

describe('/revelaridentidade — alvo ausente', () => {
  beforeEach(async () => {
    await comCargo('owner');
  });

  it('alvo nao carregado avisa e nao audita', async () => {
    await admin.revealIdentity(STAFF_ACTOR_ID, 0xff00cfff);

    assert.equal(linhaDeRevelacao(), null, 'nao houve revelacao — nada a registrar');
    assert.ok(
      notificacoesDaStaff().some(m => /nao encontrado/i.test(m)),
      'a staff precisa saber que o actorId nao corresponde a ninguem carregado'
    );
  });
});
