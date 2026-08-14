/**
 * core/voice/voice-conditions.test.js
 *
 * A tabela de condições e a composição delas.
 *
 * O que estes testes protegem não é aritmética — é a decisão de **compor** em
 * vez de escolher a condição mais grave. Um abatido amordaçado precisa soar
 * diferente de um abatido, e a forma de garantir isso é aqui, não na política.
 *
 * **Nenhum número de modificador é escrito à mão neste arquivo.** Todos vêm de
 * `conditionProfiles()`, que os lê do `server-options`. Um teste com
 * `assert(gain === 0.4)` passaria a mentir no dia em que alguém ajustasse
 * `voice.gagged.gainModifier` — e o ponto daquela opção é justamente que mexer
 * nela mude o jogo.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  VOICE_CONDITIONS, VOICE_EFFECTS, EFFECT_STRENGTH,
  conditionProfiles, composeProfile, neutralProfile, effectSettings
} = require('./voice-conditions');

const { describe, it } = test;

describe('voice-conditions — a tabela', () => {
  it('todo perfil declara os seis campos, sem buraco', () => {
    const table = conditionProfiles();
    for (const nome of Object.values(VOICE_CONDITIONS)) {
      const p = table[nome];
      assert.ok(p, `condição sem perfil: ${nome}`);
      assert.strictEqual(typeof p.canSpeak, 'boolean', nome);
      assert.strictEqual(typeof p.canHear, 'boolean', nome);
      assert.ok(Number.isFinite(p.rangeModifier), nome);
      assert.ok(Number.isFinite(p.gainModifier), nome);
      assert.ok(Object.values(VOICE_EFFECTS).includes(p.effect), `${nome}: efeito ${p.effect}`);
    }
  });

  it('MORTO não fala — e isso não é configurável', () => {
    assert.strictEqual(conditionProfiles()[VOICE_CONDITIONS.DEAD].canSpeak, false);
  });

  it('INCONSCIENTE não fala — e isso também não é configurável', () => {
    assert.strictEqual(conditionProfiles()[VOICE_CONDITIONS.UNCONSCIOUS].canSpeak, false);
  });

  it('SILENCIADO PELA STAFF não fala, mas CONTINUA OUVINDO', () => {
    const p = conditionProfiles()[VOICE_CONDITIONS.STAFF_MUTED];
    assert.strictEqual(p.canSpeak, false);
    assert.strictEqual(p.canHear, true,
      'senão a punição vira desconexão disfarçada');
  });

  /**
   * O caso que a instrução destacou: mordaça é EFEITO, não mute.
   *
   * Uma implementação que calasse o amordaçado passaria em qualquer teste de
   * "amordaçado não é ouvido de longe" e estaria errada — quem amordaça quer
   * ouvir o outro tentando falar.
   */
  it('AMORDAÇADO fala, mais baixo, mais perto, e ABAFADO', () => {
    const p = conditionProfiles()[VOICE_CONDITIONS.GAGGED];
    assert.strictEqual(p.canSpeak, true, 'mordaça abafa, não cala');
    assert.ok(p.gainModifier > 0, 'ganho zero seria mute com outro nome');
    assert.ok(p.gainModifier < 1, 'e precisa ser mais baixo que o normal');
    assert.ok(p.rangeModifier < 1, 'e alcançar menos');
    assert.strictEqual(p.effect, VOICE_EFFECTS.MUFFLED);
  });

  it('ABATIDO é configurável de ponta a ponta', () => {
    const p = conditionProfiles()[VOICE_CONDITIONS.DOWNED];
    assert.ok(p.rangeModifier <= 1);
    assert.ok(p.gainModifier <= 1);
    assert.ok(Object.values(VOICE_EFFECTS).includes(p.effect));
  });
});

describe('voice-conditions — composição', () => {
  it('sem condição nenhuma, nada muda', () => {
    const p = composeProfile([]);
    assert.deepStrictEqual(
      { canSpeak: p.canSpeak, canHear: p.canHear, range: p.rangeModifier, gain: p.gainModifier, effect: p.effect },
      { canSpeak: true, canHear: true, range: 1, gain: 1, effect: VOICE_EFFECTS.NONE }
    );
  });

  it('NORMAL na lista é o mesmo que lista vazia', () => {
    assert.deepStrictEqual(composeProfile([VOICE_CONDITIONS.NORMAL]), neutralProfile());
  });

  /**
   * O teste que justifica a decisão de compor.
   *
   * Se a implementação escolhesse "a condição mais grave", o resultado seria o
   * perfil de ABATIDO puro — e a mordaça teria sumido sem que nada avisasse.
   */
  it('ABATIDO + AMORDAÇADO compõem: os dois modificadores se MULTIPLICAM', () => {
    const table = conditionProfiles();
    const abatido = table[VOICE_CONDITIONS.DOWNED];
    const amordacado = table[VOICE_CONDITIONS.GAGGED];

    const composto = composeProfile([VOICE_CONDITIONS.DOWNED, VOICE_CONDITIONS.GAGGED], table);

    assert.strictEqual(composto.gainModifier, abatido.gainModifier * amordacado.gainModifier);
    assert.strictEqual(composto.rangeModifier, abatido.rangeModifier * amordacado.rangeModifier);
    assert.ok(composto.gainModifier < abatido.gainModifier,
      'o abatido amordaçado tem que soar mais baixo que o abatido');
  });

  it('o efeito composto é o MAIS FORTE presente, não o último', () => {
    const composto = composeProfile([VOICE_CONDITIONS.DOWNED, VOICE_CONDITIONS.GAGGED]);
    const table = conditionProfiles();
    const esperado = EFFECT_STRENGTH[table[VOICE_CONDITIONS.GAGGED].effect]
      >= EFFECT_STRENGTH[table[VOICE_CONDITIONS.DOWNED].effect]
      ? table[VOICE_CONDITIONS.GAGGED].effect
      : table[VOICE_CONDITIONS.DOWNED].effect;
    assert.strictEqual(composto.effect, esperado);
  });

  it('uma proibição basta: MORTO + AMORDAÇADO não fala', () => {
    const composto = composeProfile([VOICE_CONDITIONS.DEAD, VOICE_CONDITIONS.GAGGED]);
    assert.strictEqual(composto.canSpeak, false);
  });

  /**
   * O motivo é o da primeira condição BLOQUEANTE, e a staff vem primeiro: quem
   * foi silenciado precisa ler a punição, não um estado do corpo que também é
   * verdade e não ajuda em nada a apelar dela.
   */
  it('o motivo é o da staff quando ela e a morte valem juntas', () => {
    const composto = composeProfile([VOICE_CONDITIONS.DEAD, VOICE_CONDITIONS.STAFF_MUTED]);
    assert.strictEqual(composto.reason, conditionProfiles()[VOICE_CONDITIONS.STAFF_MUTED].reason);
  });

  it('condição que só ATENUA não vira motivo de recusa', () => {
    const composto = composeProfile([VOICE_CONDITIONS.GAGGED]);
    assert.strictEqual(composto.canSpeak, true);
    assert.strictEqual(composto.reason, null,
      'dizer "amordaçado" como motivo de recusa para quem está falando seria mentira');
  });

  it('condição desconhecida é ignorada em vez de derrubar a composição', () => {
    const composto = composeProfile(['ENFEITIÇADO', VOICE_CONDITIONS.GAGGED]);
    assert.deepStrictEqual(composto.conditions, [VOICE_CONDITIONS.GAGGED]);
  });
});

describe('voice-conditions — parâmetros dos efeitos', () => {
  it('cada efeito com filtro declara um corte finito e positivo', () => {
    const settings = effectSettings();
    for (const nome of [VOICE_EFFECTS.MUFFLED, VOICE_EFFECTS.FAINT]) {
      assert.ok(Number.isFinite(settings[nome].lowpassHz), nome);
      assert.ok(settings[nome].lowpassHz > 0, nome);
    }
  });

  it('o abafado corta MAIS GRAVE que o fraco — senão os dois efeitos são um só', () => {
    const settings = effectSettings();
    assert.ok(settings[VOICE_EFFECTS.MUFFLED].lowpassHz < settings[VOICE_EFFECTS.FAINT].lowpassHz);
  });

  it('`none` não tem parâmetro — é a ausência de filtro, não um filtro neutro', () => {
    assert.strictEqual(effectSettings()[VOICE_EFFECTS.NONE], undefined,
      'um passa-baixa "transparente" custaria CPU por locutor para não fazer nada');
  });
});
