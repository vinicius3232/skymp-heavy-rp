/**
 * core/voice/voice-character-adapter.test.js
 *
 * A tradução do personagem real para a linguagem da voz.
 *
 * O erro que estes testes existem para impedir é o mais natural de todos: ler
 * `RESTRAINED` e concluir "calado". Algema é nas mãos.
 */

const test = require('node:test');
const assert = require('node:assert');

const { createVoiceCharacterAdapter, nullCharacterAdapter } = require('./voice-character-adapter');
const { createVoiceStaffMute } = require('./voice-staff-mute');
const { VOICE_CONDITIONS } = require('./voice-conditions');

const { describe, it, beforeEach } = test;

const CHAR = 4242;

/**
 * Um `character-state` falso com a MESMA superfície do real.
 *
 * Falso e não o real porque `core/character-state.js` puxa `../database`, e um
 * teste de tradução de estado não deve precisar de MySQL. A superfície é
 * copiada campo a campo do módulo real — `STATES`, `get`, `getMetadata` — e é
 * pequena o bastante para que uma divergência apareça no `typecheck`.
 */
function fakeCharacterState() {
  const STATES = {
    NORMAL: 'NORMAL', BUSY: 'BUSY', DOWNED: 'DOWNED', DEAD: 'DEAD',
    RESTRAINED: 'RESTRAINED', IMPRISONED: 'IMPRISONED', IN_TRADE: 'IN_TRADE',
    IN_CRAFT: 'IN_CRAFT', IN_DIALOG: 'IN_DIALOG', DISCONNECTED: 'DISCONNECTED'
  };
  const store = new Map();
  return {
    STATES,
    set(characterId, state, metadata = {}) { store.set(characterId, { state, metadata }); },
    get(characterId) { return (store.get(characterId) || {}).state || STATES.NORMAL; },
    getMetadata(characterId) { return (store.get(characterId) || {}).metadata || {}; }
  };
}

let characterState;
let staffMute;
let adapter;

beforeEach(() => {
  characterState = fakeCharacterState();
  staffMute = createVoiceStaffMute();
  adapter = createVoiceCharacterAdapter({ characterState, staffMute });
});

describe('voice-character-adapter — o que já existia', () => {
  it('personagem sem nada não tem condição nenhuma', () => {
    assert.deepStrictEqual(adapter.conditionsOf(CHAR), []);
  });

  it('DEAD do death-service vira DEAD na voz', () => {
    characterState.set(CHAR, characterState.STATES.DEAD);
    assert.deepStrictEqual(adapter.conditionsOf(CHAR), [VOICE_CONDITIONS.DEAD]);
  });

  it('DOWNED do death-service vira DOWNED na voz', () => {
    characterState.set(CHAR, characterState.STATES.DOWNED, { downedAt: Date.now() });
    assert.deepStrictEqual(adapter.conditionsOf(CHAR), [VOICE_CONDITIONS.DOWNED]);
  });

  it('morto NÃO é abatido também — DEAD substitui DOWNED, não soma', () => {
    characterState.set(CHAR, characterState.STATES.DEAD);
    const c = adapter.conditionsOf(CHAR);
    assert.ok(!c.includes(VOICE_CONDITIONS.DOWNED));
  });

  it('silêncio de staff entra pela própria porta, não pelo character-state', () => {
    staffMute.mute(CHAR, { reason: 'gritando por cima da cena' });
    assert.deepStrictEqual(adapter.conditionsOf(CHAR), [VOICE_CONDITIONS.STAFF_MUTED]);
  });
});

describe('voice-character-adapter — a mordaça', () => {
  /**
   * O erro natural, travado.
   *
   * `RESTRAINED` é o estado de quem está algemado. Se ele calasse, algemar um
   * suspeito o impediria de responder ao guarda — que é o oposto do que uma
   * cena de prisão em Heavy RP precisa.
   */
  it('ALGEMA COMUM NÃO CALA — nem abafa', () => {
    characterState.set(CHAR, characterState.STATES.RESTRAINED, { type: 'handcuffs' });
    assert.deepStrictEqual(adapter.conditionsOf(CHAR), []);
  });

  it('corda também não cala', () => {
    characterState.set(CHAR, characterState.STATES.RESTRAINED, { type: 'rope' });
    assert.deepStrictEqual(adapter.conditionsOf(CHAR), []);
  });

  it('`type: gag` na algema é uma mordaça', () => {
    characterState.set(CHAR, characterState.STATES.RESTRAINED, { type: 'gag' });
    assert.deepStrictEqual(adapter.conditionsOf(CHAR), [VOICE_CONDITIONS.GAGGED]);
  });

  it('o `type` é lido sem depender de caixa', () => {
    characterState.set(CHAR, characterState.STATES.RESTRAINED, { type: 'GAG' });
    assert.deepStrictEqual(adapter.conditionsOf(CHAR), [VOICE_CONDITIONS.GAGGED]);
  });

  /**
   * `type` cabe um valor só. Alguém de mãos atadas E com um pano na boca
   * precisa dos dois, e é para isso que a flag existe.
   */
  it('`gagged: true` amordaça em cima de qualquer estado, inclusive na cela', () => {
    characterState.set(CHAR, characterState.STATES.IMPRISONED, { gagged: true });
    assert.deepStrictEqual(adapter.conditionsOf(CHAR), [VOICE_CONDITIONS.GAGGED]);
  });

  it('algemado e amordaçado ao mesmo tempo é UMA condição de voz: a mordaça', () => {
    characterState.set(CHAR, characterState.STATES.RESTRAINED, { type: 'handcuffs', gagged: true });
    assert.deepStrictEqual(adapter.conditionsOf(CHAR), [VOICE_CONDITIONS.GAGGED]);
  });
});

describe('voice-character-adapter — inconsciência', () => {
  /**
   * Não existe produtor de inconsciência neste projeto. O que existe é o
   * ENCAIXE, e é ele que está testado: no dia em que um sistema de nocaute
   * nascer, ele grava o metadado e a voz obedece sem uma linha nova no adapter.
   */
  it('o gancho padrão lê `unconscious: true` no metadado do estado', () => {
    characterState.set(CHAR, characterState.STATES.NORMAL, { unconscious: true });
    assert.deepStrictEqual(adapter.conditionsOf(CHAR), [VOICE_CONDITIONS.UNCONSCIOUS]);
  });

  it('um sistema de nocaute futuro pode trocar o gancho sem mexer aqui', () => {
    const nocauteados = new Set([CHAR]);
    const outro = createVoiceCharacterAdapter({
      characterState, staffMute,
      unconsciousProbe: (id) => nocauteados.has(id)
    });
    assert.deepStrictEqual(outro.conditionsOf(CHAR), [VOICE_CONDITIONS.UNCONSCIOUS]);
    assert.deepStrictEqual(outro.conditionsOf(99), []);
  });

  it('inconsciência SOMA com o estado do corpo em vez de substituí-lo', () => {
    characterState.set(CHAR, characterState.STATES.DOWNED, { unconscious: true });
    const c = adapter.conditionsOf(CHAR);
    assert.ok(c.includes(VOICE_CONDITIONS.DOWNED));
    assert.ok(c.includes(VOICE_CONDITIONS.UNCONSCIOUS));
  });
});

describe('voice-character-adapter — bordas', () => {
  it('ator sem personagem carregado não inventa condição', () => {
    assert.deepStrictEqual(adapter.conditionsOf(null), []);
    assert.deepStrictEqual(adapter.conditionsOf(undefined), []);
    assert.deepStrictEqual(adapter.conditionsOf(NaN), [],
      '`canSpeak` já recusa por "personagem não carregado"; dois motivos para a mesma causa mostram o menos útil');
  });

  it('o adapter nulo nunca acha nada — é o padrão de quem testa sem mundo', () => {
    const nulo = nullCharacterAdapter();
    assert.deepStrictEqual(nulo.conditionsOf(CHAR), []);
  });

  it('staff + estado do corpo aparecem os dois, e a staff vem primeiro', () => {
    characterState.set(CHAR, characterState.STATES.DOWNED);
    staffMute.mute(CHAR, { reason: 'metagaming' });
    assert.deepStrictEqual(adapter.conditionsOf(CHAR), [
      VOICE_CONDITIONS.STAFF_MUTED,
      VOICE_CONDITIONS.DOWNED
    ]);
  });
});
