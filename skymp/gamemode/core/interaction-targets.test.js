/**
 * core/interaction-targets.test.js
 *
 * Cobertura direta dos resolvedores — `player` já era exercitado só através
 * de `interaction-service.test.js`; este arquivo nasce com o resolvedor
 * `object` (Minerador MVP, ver `docs/gameplay/MINING.md` §1) e aproveita para
 * fechar `player` também.
 *
 * Executa com: node --test core/interaction-targets.test.js
 */

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { createTargetResolvers } = require('./interaction-targets');
const { TARGET_TYPES } = require('./interaction-registry');

const ATOR = 0x100;
const ALVO = 0x200;

function montar(overrides = {}) {
  const registrados = new Map([[ALVO, { characterId: 2, accountId: 22 }]]);
  const getCharacter = overrides.getCharacter || (actorId => registrados.get(actorId) || null);
  return createTargetResolvers({ getCharacter, logger: { warn() {}, error() {} } });
}

describe('interaction-targets — object', () => {
  it('resolve um FormId numérico, hex com 0x e hex sem 0x, todos pro mesmo alvo', () => {
    const targets = montar();
    for (const raw of [ALVO, '0x200', '200', '0X200']) {
      const r = targets.resolve(TARGET_TYPES.OBJECT, raw, ATOR);
      assert.equal(r.ok, true, `recusou ${JSON.stringify(raw)}`);
      assert.equal(r.target.formId, ALVO);
      assert.equal(r.target.type, TARGET_TYPES.OBJECT);
      assert.equal(r.target.id, `object:${ALVO}`);
    }
  });

  it('recusa FormId ausente, malformado ou zero/negativo', () => {
    const targets = montar();
    for (const raw of [undefined, null, 'abacaxi', '0xZZ', -1, 0]) {
      const r = targets.resolve(TARGET_TYPES.OBJECT, raw, ATOR);
      assert.equal(r.ok, false, `aceitou ${JSON.stringify(raw)}`);
    }
  });

  it('não exige personagem carregado — objeto não é ator', () => {
    const targets = montar({ getCharacter: () => null });
    const r = targets.resolve(TARGET_TYPES.OBJECT, ALVO, ATOR);
    assert.equal(r.ok, true);
  });

  it('assertRange delega em rangeUtils.assertRange, genérico sobre o segundo id', () => {
    const targets = montar();
    const r = targets.resolve(TARGET_TYPES.OBJECT, ALVO, ATOR);
    // Sem `mp`, rangeUtils.assertRange deixa passar e marca unverified — é o
    // que prova que a delegação chegou à implementação real, não a um stub.
    const veredito = r.target.assertRange(ATOR, 200);
    assert.equal(veredito.ok, true);
    assert.equal(veredito.unverified, true);
  });
});

describe('interaction-targets — player (regressão)', () => {
  it('continua recusando alvo de si mesmo e alvo sem personagem', () => {
    const targets = montar();
    assert.equal(targets.resolve(TARGET_TYPES.PLAYER, ATOR, ATOR).ok, false);
    assert.equal(targets.resolve(TARGET_TYPES.PLAYER, 0x999, ATOR).ok, false);
  });

  it('resolve o personagem carregado do alvo', () => {
    const targets = montar();
    const r = targets.resolve(TARGET_TYPES.PLAYER, ALVO, ATOR);
    assert.equal(r.ok, true);
    assert.equal(r.target.characterId, 2);
  });
});

describe('interaction-targets — tipo sem resolvedor', () => {
  it('falha fechado e por nome para container/door/npc/property/world_point', () => {
    const targets = montar();
    for (const tipo of [TARGET_TYPES.CONTAINER, TARGET_TYPES.DOOR, TARGET_TYPES.NPC, TARGET_TYPES.PROPERTY, TARGET_TYPES.WORLD_POINT]) {
      const r = targets.resolve(tipo, ALVO, ATOR);
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'Tipo de alvo nao suportado.');
    }
  });
});
