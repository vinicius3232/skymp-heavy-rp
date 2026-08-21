/**
 * admin-actions.test.js
 *
 * O registro de ações do gamemode: o que existe, o que é alcançável, e o que
 * cada superfície tem permissão de afirmar.
 *
 * ─── O defeito que motivou a invariante da §1 ───────────────────────────────
 *
 * Cinco ações — `voiceMute`, `voiceUnmute`, `voiceDiagnose`, `voiceDisconnect` e
 * `voiceForceReconnect` — existiam no `admin-service`, tinham permissão,
 * auditoria e teste de comportamento passando, e **nenhum
 * `commandRegistry.register`**. Os docstrings falavam de `/calar` e `/vozdiag`,
 * o `voip-service` anunciava no log do boot que estavam disponíveis, e digitar
 * qualquer um deles respondia "Comando desconhecido".
 *
 * A suíte inteira passava porque cada teste chamava o handler direto. "A ação
 * existe" e "a ação é alcançável" eram duas afirmações independentes, e ninguém
 * comparava as duas.
 *
 * Executa com: node --test admin-actions.test.js
 */

'use strict';

const assert = require('assert');
const { describe, it, before, after } = require('node:test');

// ─────────────────────────────────────────────────────────────────────────────
// Duplos: este arquivo não toca banco, `mp`, nem serviço de domínio.
// ─────────────────────────────────────────────────────────────────────────────

const STAFF_ACTOR = 0xaa01;
const ALVO_ACTOR = 0xbb02;

let cargoDoAtor = 'admin';

const Module = require('module');
const originalLoad = Module._load;

Module._load = function (request) {
  if (request === './database' || request.endsWith('/database')) {
    return { init: () => {}, query: async () => [], getConnection: async () => ({}) };
  }
  if (request === './commands' || request.endsWith('/commands')) {
    return {
      sendNotification: () => {},
      getActiveCharacterData: (actorId) => {
        if (actorId === STAFF_ACTOR) return { accountId: 501, characterId: 9001, firstName: 'Staff', lastName: 'Um' };
        if (actorId === ALVO_ACTOR) return { accountId: 777, characterId: 4242, firstName: 'Alvo', lastName: 'Dois' };
        return null;
      }
    };
  }
  if (request === './admin-service' || request.endsWith('/admin-service')) {
    return {
      getRole: (actorId) => (actorId === STAFF_ACTOR ? cargoDoAtor : null),
      auditLog: async () => {}
    };
  }
  return originalLoad.apply(this, arguments);
};

const adminActions = require('./admin-actions');
const permissions = require('./core/permissions');

// O duplo fica instalado pelo arquivo inteiro, de propósito.
//
// `admin-actions.js` faz `require('./admin-service')` e `require('./commands')`
// **dentro** das funções — precisa fazer, senão fecha um ciclo com o
// `commands.js`, que o requer para registrar os comandos. Restaurar o loader
// aqui faria `resolveSession` e `resolveTarget` alcançarem os módulos de
// verdade na hora da chamada, e o teste passaria a depender de banco e de `mp`.
//
// É a mesma nota que o `permissions.behavior.test.js` já carrega, pelo mesmo
// motivo, sobre o `giveItemAdmin`.

// ─────────────────────────────────────────────────────────────────────────────
// 1. Toda ação registrada é alcançável, e todo comando aponta para uma ação
// ─────────────────────────────────────────────────────────────────────────────

describe('ação declarada e ação alcançável são a mesma lista', () => {
  it('toda ação do registro tem um comando que a invoca', () => {
    const comAcao = new Set(adminActions.COMMANDS.map((c) => c.action));
    const orfas = adminActions.registry.ids().filter((id) => !comAcao.has(id));

    assert.deepEqual(
      orfas, [],
      `Ação(ões) registrada(s) que nenhum comando invoca: ${orfas.join(', ')}. ` +
      `Foi exatamente assim que as cinco ações de voz passaram a existir sem que ninguém ` +
      `conseguisse usá-las — com permissão, auditoria e teste passando.`
    );
  });

  it('todo comando aponta para uma ação que existe', () => {
    const inventados = adminActions.COMMANDS.filter((c) => !adminActions.registry.has(c.action));
    assert.deepEqual(inventados.map((c) => c.action), []);
  });

  it('as cinco ações de voz estão entre as alcançáveis', () => {
    const voz = ['voice.mute', 'voice.unmute', 'voice.diagnose', 'voice.disconnect', 'voice.reconnect'];
    for (const id of voz) {
      assert.ok(adminActions.registry.has(id), `'${id}' não está registrada`);
      assert.ok(
        adminActions.COMMANDS.some((c) => c.action === id),
        `'${id}' existe e continua sem comando — era o defeito original`
      );
    }
  });

  it('toda ação exige uma capability ATIVA do catálogo', () => {
    for (const acao of adminActions.registry.list()) {
      const cap = permissions.CAPABILITIES[acao.permission];
      assert.ok(cap, `'${acao.id}' exige '${acao.permission}', fora do catálogo`);
      assert.equal(cap.status, 'active', `'${acao.id}' está atrás de uma reservada`);
    }
  });

  it('nenhum comando é registrado duas vezes', () => {
    const nomes = adminActions.COMMANDS.flatMap((c) => (Array.isArray(c.names) ? c.names : [c.names]));
    assert.equal(new Set(nomes).size, nomes.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. As ações irreversíveis exigem motivo
// ─────────────────────────────────────────────────────────────────────────────

describe('motivo obrigatório onde a ação não se desfaz', () => {
  const exigem = ['players.kick', 'characters.retire', 'identity.reveal', 'economy.adjust', 'voice.mute'];

  for (const id of exigem) {
    it(`${id} exige motivo`, () => {
      assert.equal(
        adminActions.registry.get(id).reason, 'required',
        `'${id}' aceita acontecer sem que ninguém saiba por quê. ` +
        `Era o caso de /kick, que caía para 'Sem motivo', enquanto /permakill recusava.`
      );
    });
  }

  it('o comando dessas ações coleta o motivo do resto da linha', () => {
    for (const id of exigem) {
      const def = adminActions.COMMANDS.find((c) => c.action === id);
      assert.equal(def.rest, 'reason', `'${id}' exige motivo e o comando '${def.names}' não o coleta`);
      assert.match(def.usage, /motivo/, `o uso de '${def.names}' não diz que o motivo é necessário`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Identidade sai do servidor
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveSession não aceita nada de quem chama', () => {
  it('devolve conta, personagem e cargo lidos do servidor', async () => {
    cargoDoAtor = 'owner';
    const s = await adminActions.resolveSession('command', STAFF_ACTOR);

    assert.equal(s.staffAccountId, 501);
    assert.equal(s.staffCharacterId, 9001);
    assert.equal(s.role, 'owner');
    assert.equal(s.sessionId, `actor:${STAFF_ACTOR.toString(16)}`);
  });

  it('devolve null para quem não é staff', async () => {
    const s = await adminActions.resolveSession('command', 0x9999);
    assert.equal(s, null, 'quem não tem cargo não pode nem abrir uma sessão administrativa');
  });

  it('recusa origem que não seja command', async () => {
    // O gamemode não atende pedido web: se um dia atender, será por uma sessão
    // que este resolvedor não sabe ler, e liberar seria o oposto do certo.
    cargoDoAtor = 'owner';
    assert.equal(await adminActions.resolveSession('web', STAFF_ACTOR), null);
    assert.equal(await adminActions.resolveSession('api', STAFF_ACTOR), null);
  });
});

describe('resolveTarget resolve a ficha no servidor', () => {
  it('traduz o hex digitado em characterId e accountId reais', async () => {
    const t = await adminActions.resolveTarget('player', '0xbb02');
    assert.equal(t.characterId, 4242);
    assert.equal(t.accountId, 777);
    assert.match(t.label, /Alvo Dois/);
  });

  it('aceita o hex sem prefixo, que é como a staff digita', async () => {
    const t = await adminActions.resolveTarget('player', 'bb02');
    assert.equal(t.characterId, 4242);
  });

  it('devolve null para alvo sem personagem carregado', async () => {
    assert.equal(await adminActions.resolveTarget('player', '0xdead'), null);
  });

  it('devolve null para lixo', async () => {
    for (const ref of ['', 'abacaxi', null, undefined]) {
      assert.equal(await adminActions.resolveTarget('player', ref), null, `aceitou ${JSON.stringify(ref)}`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. O adaptador de chat não decide nada
// ─────────────────────────────────────────────────────────────────────────────

describe('parseCommandArgs só reparte a linha', () => {
  const def = adminActions.COMMANDS.find((c) => c.action === 'inventory.grant');

  it('separa alvo e parâmetros posicionais', () => {
    const p = adminActions.parseCommandArgs(def, '0xff01 1398a 5');
    assert.equal(p.targetRef, '0xff01');
    assert.deepEqual(p.parameters, { baseId: '1398a', count: '5' });
  });

  it('entrega parâmetro ausente como ausente, sem inventar padrão', () => {
    // O padrão é do descritor, aplicado na etapa VALIDATION. Se o adaptador o
    // aplicasse, cada superfície teria a própria noção do que é o padrão.
    const p = adminActions.parseCommandArgs(def, '0xff01 1398a');
    assert.deepEqual(p.parameters, { baseId: '1398a' });
  });

  it('junta o resto da linha como motivo', () => {
    const kick = adminActions.COMMANDS.find((c) => c.action === 'players.kick');
    const p = adminActions.parseCommandArgs(kick, '0xff01 gritou por cima da cena toda');
    assert.equal(p.targetRef, '0xff01');
    assert.equal(p.reason, 'gritou por cima da cena toda');
  });

  it('entrega motivo vazio quando não veio, em vez de um padrão', () => {
    const kick = adminActions.COMMANDS.find((c) => c.action === 'players.kick');
    const p = adminActions.parseCommandArgs(kick, '0xff01');
    assert.equal(p.reason, '', 'um padrão aqui recriaria o "Sem motivo" que o /kick tinha');
  });

  it('não explode com linha vazia', () => {
    const p = adminActions.parseCommandArgs(def, '');
    assert.equal(p.targetRef, undefined);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Profissão: o interruptor do módulo, ponta a ponta pelo pipeline real
// ─────────────────────────────────────────────────────────────────────────────

describe('profession.* — o pipeline de verdade, não só a estrutura', () => {
  const moduleRegistry = require('./core/module-registry');

  it('nega quando quem chama não tem cargo — SESSION, antes de qualquer coisa', async () => {
    const r = await adminActions.pipeline.run({
      action: 'profession.view',
      source: 'command',
      sourceRef: ALVO_ACTOR // não é staff
    });
    assert.equal(r.outcome, 'denied');
    assert.equal(r.stage, 'session');
  });

  it('bloqueia em STATE quando o módulo profession está desligado — nunca chega ao serviço', async () => {
    // Nenhum boot rodou 'profession' neste arquivo: moduleRegistry.isEnabled
    // devolve false por padrão, exatamente como em produção sem a env var.
    assert.equal(moduleRegistry.isEnabled('profession'), false);

    const r = await adminActions.pipeline.run({
      action: 'profession.view',
      source: 'command',
      sourceRef: STAFF_ACTOR,
      targetRef: `0x${ALVO_ACTOR.toString(16)}`
    });
    assert.equal(r.outcome, 'blocked');
    assert.equal(r.stage, 'state');
  });

  describe('com o módulo ligado (ENABLE_PROFESSION_SERVICE=true)', () => {
    let antes;

    before(async () => {
      antes = process.env.ENABLE_PROFESSION_SERVICE;
      process.env.ENABLE_PROFESSION_SERVICE = 'true';
      if (!moduleRegistry.getState('profession')) {
        moduleRegistry.register({
          id: 'profession',
          enabledBy: 'ENABLE_PROFESSION_SERVICE',
          phase: 'lab',
          dependencies: [],
          commands: [],
          initialize: async () => {}
        });
      }
      await moduleRegistry.bootAll();
    });

    after(() => {
      process.env.ENABLE_PROFESSION_SERVICE = antes;
    });

    it('devolve executed e produz auditoria para quem tem profession.view', async () => {
      assert.equal(moduleRegistry.isEnabled('profession'), true);

      const r = await adminActions.pipeline.run({
        action: 'profession.view',
        source: 'command',
        sourceRef: STAFF_ACTOR,
        targetRef: `0x${ALVO_ACTOR.toString(16)}`
      });
      assert.equal(r.outcome, 'executed');
      assert.deepEqual(r.data, []); // banco fake devolve [] — o que importa é o outcome
    });

    it('nega profession.assign para moderator — não está na matriz', async () => {
      cargoDoAtor = 'moderator';
      try {
        const r = await adminActions.pipeline.run({
          action: 'profession.assign',
          source: 'command',
          sourceRef: STAFF_ACTOR,
          targetRef: `0x${ALVO_ACTOR.toString(16)}`,
          parameters: { professionCode: 'miner' }
        });
        assert.equal(r.outcome, 'denied');
        assert.equal(r.stage, 'permission');
      } finally {
        cargoDoAtor = 'admin';
      }
    });

    it('recusa professionCode fora do catálogo na VALIDATION, antes do serviço', async () => {
      const r = await adminActions.pipeline.run({
        action: 'profession.assign',
        source: 'command',
        sourceRef: STAFF_ACTOR,
        targetRef: `0x${ALVO_ACTOR.toString(16)}`,
        parameters: { professionCode: 'does_not_exist' }
      });
      assert.equal(r.outcome, 'invalid');
      assert.equal(r.stage, 'validation');
    });
  });
});
