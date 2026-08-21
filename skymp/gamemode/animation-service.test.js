/**
 * animation-service.test.js
 *
 * O que estes testes provam: que o servidor nunca chama Papyrus com um nome de
 * idle vindo direto do cliente, que a allowlist é fechada, que o cooldown
 * bloqueia spam, e que a mensagem de proximidade sai no formato esperado.
 *
 * O que eles NÃO provam, e nenhum teste em Node poderia: que `Actor.PlayIdle`
 * de fato reproduz a animação na tela de alguém. Ver o cabeçalho de
 * `animation-service.js` — a lista do que está e do que não está provado é
 * parte do entregável, não rodapé.
 *
 * Executa com: node --test animation-service.test.js
 */

const assert = require('assert');
const { describe, it, beforeEach, after } = require('node:test');

const ATOR = 0xff00e001;
const OUTRO = 0xff00e002;

const CHAR = {
  [ATOR]: { characterId: 701, firstName: 'Brenna', lastName: 'Coldhearth', accountId: 71 },
  [OUTRO]: { characterId: 702, firstName: 'Corvo', lastName: 'Mendax', accountId: 72 }
};

const Module = require('module');
const originalLoad = Module._load;

let mensagensBroadcast = [];
let chamadasPapyrus = [];

Module._load = function (request, parent, isMain) {
  if (request === './database' || request.endsWith('/database')) {
    return { init: () => {}, query: async () => [] };
  }
  if (request === './commands' || request.endsWith('/commands')) {
    return {
      getActiveCharacterData: (actorId) => CHAR[actorId] || null,
      broadcastProximityMessage: (sourceActorId, message, radius) => {
        mensagensBroadcast.push({ sourceActorId, message: typeof message === 'function' ? message(sourceActorId) : message, radius });
      },
      sendNotification: () => {}
    };
  }
  return originalLoad.apply(this, arguments);
};

const animation = require('./animation-service');

after(() => {
  Module._load = originalLoad;
  delete global.mp;
});

function resetar() {
  mensagensBroadcast = [];
  chamadasPapyrus = [];
  animation._ultimoGesto.clear();
  global.mp = {
    callPapyrusFunction: (...args) => { chamadasPapyrus.push(args); },
    getDescFromId: (formId) => `${formId.toString(16)}:Skyrim.esm`
  };
}

describe('animation-service — allowlist', () => {
  beforeEach(resetar);

  it('toca um gesto valido', () => {
    const resultado = animation.playEmote(ATOR, 'acenar');
    assert.equal(resultado.ok, true);
    assert.equal(chamadasPapyrus.length, 1);
  });

  it('rejeita gesto desconhecido sem tocar Papyrus', () => {
    const resultado = animation.playEmote(ATOR, 'moonwalk');
    assert.deepEqual(resultado, { ok: false, motivo: 'desconhecido' });
    assert.equal(chamadasPapyrus.length, 0, 'nome desconhecido nunca deve chegar ao Papyrus');
  });

  it('nunca passa a chave do cliente crua para o Papyrus — so o idle mapeado', () => {
    animation.playEmote(ATOR, 'acenar');
    const [, classe, funcao, , args] = chamadasPapyrus[0];
    assert.equal(classe, 'Actor');
    assert.equal(funcao, 'PlayIdle');
    assert.equal(args[0], animation.EMOTES.acenar.idle);
    assert.notEqual(args[0], 'acenar', 'o argumento deve ser o nome do idle, nao a chave que o jogador digitou');
  });

  it('e case-insensitive e tolera espaco', () => {
    const resultado = animation.playEmote(ATOR, '  ACENAR  ');
    assert.equal(resultado.ok, true);
  });

  it('rejeita string vazia ou undefined', () => {
    assert.equal(animation.playEmote(ATOR, '').ok, false);
    assert.equal(animation.playEmote(ATOR, undefined).ok, false);
  });
});

describe('animation-service — cooldown', () => {
  beforeEach(resetar);

  it('bloqueia um segundo gesto imediato do mesmo ator', () => {
    assert.equal(animation.playEmote(ATOR, 'acenar').ok, true);
    const segundo = animation.playEmote(ATOR, 'rir');
    assert.deepEqual(segundo, { ok: false, motivo: 'cooldown' });
    assert.equal(chamadasPapyrus.length, 1, 'o segundo gesto nao deveria ter chegado ao Papyrus');
  });

  it('cooldown e por ator, nao global', () => {
    assert.equal(animation.playEmote(ATOR, 'acenar').ok, true);
    assert.equal(animation.playEmote(OUTRO, 'acenar').ok, true, 'outro ator nao deveria herdar o cooldown do primeiro');
  });

  it('limparAtor reabre o cooldown', () => {
    animation.playEmote(ATOR, 'acenar');
    animation.limparAtor(ATOR);
    assert.equal(animation.playEmote(ATOR, 'rir').ok, true);
  });
});

describe('animation-service — mensagem de proximidade', () => {
  beforeEach(resetar);

  it('usa o nome do personagem ativo, nao o actorId', () => {
    animation.playEmote(ATOR, 'reverenciar');
    assert.equal(mensagensBroadcast.length, 1);
    assert.match(mensagensBroadcast[0].message, /Brenna Coldhearth/);
  });

  it('cai em "Alguem" se o ator nao tiver personagem ativo', () => {
    const SEM_CHAR = 0xff00e099;
    animation.playEmote(SEM_CHAR, 'acenar');
    assert.match(mensagensBroadcast[0].message, /Alguém/);
  });

  it('usa o raio de emote, o mesmo de /me e /do', () => {
    const { RANGES } = require('./core/proximity-ranges');
    animation.playEmote(ATOR, 'acenar');
    assert.equal(mensagensBroadcast[0].radius, RANGES.emote);
  });

  it('gesto rejeitado nao gera broadcast', () => {
    animation.playEmote(ATOR, 'inexistente');
    assert.equal(mensagensBroadcast.length, 0);
  });
});

describe('animation-service — listaDeGestos', () => {
  it('reflete exatamente as chaves de EMOTES', () => {
    assert.deepEqual(animation.listaDeGestos().sort(), Object.keys(animation.EMOTES).sort());
  });

  it('nenhum gesto da allowlist tem nome de idle de combate/morte obvio', () => {
    const proibidos = /attack|death|dead|bleedout|kill/i;
    for (const [chave, gesto] of Object.entries(animation.EMOTES)) {
      assert.ok(!proibidos.test(gesto.idle), `'${chave}' -> '${gesto.idle}' parece um idle de combate/morte, fora do escopo cosmetico`);
    }
  });
});
