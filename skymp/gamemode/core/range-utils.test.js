/**
 * core/range-utils.test.js
 *
 * `range-utils.js` nunca teve teste dedicado até esta rodada
 * (docs/research/MINING_RUNTIME_VALIDATION_REPORT.md). Este arquivo cobre só
 * o que a investigação de runtime do Minerador exigiu: o que acontece quando
 * `mp.get(formId, 'locationalData')` lança para um FormId que não existe em
 * `WorldState` — confirmado como comportamento real do SkyMP lendo
 * `ScampServer::Get`/`WorldState::GetFormAt` no upstream (`main`), não
 * presumido. Não é suíte completa de `range-utils.js`.
 *
 * Executa com: node --test core/range-utils.test.js
 */

'use strict';

const assert = require('node:assert/strict');
const { describe, it, after } = require('node:test');

const rangeUtils = require('./range-utils');

after(() => {
  delete global.mp;
});

const ATOR = 0x100;
const FORM_ID_INEXISTENTE = 0x99999999;

describe('range-utils — getLoc/assertRange contra mp.get() que lança [regressão]', () => {
  it('mp.get() lançando (FormId inexistente em WorldState, comportamento real do SkyMP) não propaga — getLoc devolve null', () => {
    global.mp = {
      get: (id) => {
        if (id === FORM_ID_INEXISTENTE) {
          // Mesma forma que Napi::Error chega ao JS: um throw síncrono.
          throw new Error(`Form with id 0x${id.toString(16)} doesn't exist`);
        }
        return null;
      }
    };
    assert.doesNotThrow(() => rangeUtils.getLoc(FORM_ID_INEXISTENTE));
    assert.equal(rangeUtils.getLoc(FORM_ID_INEXISTENTE), null);
  });

  it('assertRange contra alvo cujo FormId não existe: falha limpa no estágio de distância, não lança', () => {
    global.mp = {
      get: (id) => {
        if (id === ATOR) return { pos: [0, 0, 0], rot: [0, 0, 0], cellOrWorldDesc: 'x:Skyrim.esm' };
        throw new Error(`Form with id 0x${id.toString(16)} doesn't exist`);
      }
    };
    let resultado;
    assert.doesNotThrow(() => { resultado = rangeUtils.assertRange(ATOR, FORM_ID_INEXISTENTE, 200); });
    assert.deepEqual(resultado, { ok: false, reason: 'Nao foi possivel validar proximidade.' });
  });

  it('distanceBetween com um dos dois FormIds lançando: devolve null (não Infinity, não exceção)', () => {
    global.mp = {
      get: (id) => {
        if (id === ATOR) return { pos: [0, 0, 0], rot: [0, 0, 0], cellOrWorldDesc: 'x:Skyrim.esm' };
        throw new Error('inexistente');
      }
    };
    assert.equal(rangeUtils.distanceBetween(ATOR, FORM_ID_INEXISTENTE), null);
  });

  it('caminho feliz continua igual: dois FormIds válidos, mesma célula, calcula distância normalmente', () => {
    global.mp = {
      get: (id) => {
        if (id === ATOR) return { pos: [0, 0, 0], rot: [0, 0, 0], cellOrWorldDesc: 'x:Skyrim.esm' };
        if (id === 0x200) return { pos: [3, 4, 0], rot: [0, 0, 0], cellOrWorldDesc: 'x:Skyrim.esm' };
        return null;
      }
    };
    assert.equal(rangeUtils.distanceBetween(ATOR, 0x200), 5);
    assert.deepEqual(rangeUtils.assertRange(ATOR, 0x200, 10), { ok: true });
  });

  it('sem mp definido: comportamento inalterado — unverified, nunca lança', () => {
    delete global.mp;
    assert.doesNotThrow(() => rangeUtils.assertRange(ATOR, FORM_ID_INEXISTENTE, 200));
    assert.deepEqual(rangeUtils.assertRange(ATOR, FORM_ID_INEXISTENTE, 200), { ok: true, unverified: true });
  });
});
