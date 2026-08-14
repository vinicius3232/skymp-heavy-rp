/**
 * core/voice/voice-occlusion.test.js
 *
 * Nível 1 (célula/worldspace) e o encaixe do nível 2 (portais).
 */

const test = require('node:test');
const assert = require('node:assert');

const { createVoiceOcclusion } = require('./voice-occlusion');
const { VOICE_EFFECTS } = require('./voice-conditions');

const { describe, it } = test;

const TAVERNA = '162e2:Skyrim.esm';
const OUTRA_TAVERNA = '1a26f:Skyrim.esm';

describe('voice-occlusion — nível 1', () => {
  it('mesmo espaço passa limpo', () => {
    const o = createVoiceOcclusion();
    const v = o.between(TAVERNA, TAVERNA);
    assert.strictEqual(v.blocked, false);
    assert.strictEqual(v.gainModifier, 1);
    assert.strictEqual(v.effect, VOICE_EFFECTS.NONE);
  });

  /**
   * A regra mais forte do sistema, e ela vem ANTES da distância: dois interiores
   * do Skyrim têm origem de coordenada própria, e a distância numérica entre
   * duas tavernas distintas pode ser zero.
   */
  it('espaços diferentes são vedados, por mais perto que os números fiquem', () => {
    const o = createVoiceOcclusion();
    assert.strictEqual(o.between(TAVERNA, OUTRA_TAVERNA).blocked, true);
  });

  /**
   * Falta de informação não é prova de estarem em lugares diferentes. Tratá-la
   * como prova calaria alguém por causa de uma leitura de `locationalData` que
   * falhou.
   */
  it('espaço desconhecido de um lado NÃO separa', () => {
    const o = createVoiceOcclusion();
    assert.strictEqual(o.between(null, TAVERNA).blocked, false);
    assert.strictEqual(o.between(TAVERNA, undefined).blocked, false);
    assert.strictEqual(o.between(null, null).blocked, false);
  });

  it('sem provedor, o sistema se declara nível 1', () => {
    assert.deepStrictEqual(createVoiceOcclusion().describe(), { level: 1, portalProvider: false });
  });
});

describe('voice-occlusion — nível 2, o encaixe', () => {
  it('um provedor de portal transforma parede em porta fechada', () => {
    const o = createVoiceOcclusion();
    o.setPortalProvider((a, b) => (
      (a === TAVERNA && b === OUTRA_TAVERNA)
        ? { blocked: false, rangeModifier: 0.4, gainModifier: 0.25, effect: VOICE_EFFECTS.MUFFLED, reason: 'porta fechada' }
        : null
    ));

    const v = o.between(TAVERNA, OUTRA_TAVERNA);
    assert.strictEqual(v.blocked, false);
    assert.strictEqual(v.gainModifier, 0.25);
    assert.strictEqual(v.effect, VOICE_EFFECTS.MUFFLED);
    assert.deepStrictEqual(o.describe(), { level: 2, portalProvider: true });
  });

  /**
   * Um provedor que não conhece um par de células devolve `null` e o nível 1
   * responde. Inventar passagem no desconhecido faria a voz atravessar
   * qualquer parede que ninguém tivesse mapeado — o oposto do conservador.
   */
  it('provedor que não conhece o par cai no nível 1, que veda', () => {
    const o = createVoiceOcclusion();
    o.setPortalProvider(() => null);
    assert.strictEqual(o.between(TAVERNA, OUTRA_TAVERNA).blocked, true);
  });

  it('um provedor que LANÇA não cala a cena — o nível 1 responde', () => {
    const o = createVoiceOcclusion();
    o.setPortalProvider(() => { throw new Error('tabela de portas corrompida'); });
    assert.strictEqual(o.between(TAVERNA, OUTRA_TAVERNA).blocked, true,
      'a resposta conservadora é a parede, não o silêncio do sistema inteiro');
  });

  it('o provedor não decide o formato: veredito malformado é normalizado', () => {
    const o = createVoiceOcclusion();
    o.setPortalProvider(() => ({ blocked: false, gainModifier: 7, effect: 'plasma' }));
    const v = o.between(TAVERNA, OUTRA_TAVERNA);
    assert.strictEqual(v.gainModifier, 1, 'ganho fora de [0,1] é grampeado');
    assert.strictEqual(v.effect, VOICE_EFFECTS.MUFFLED, 'efeito desconhecido cai no abafado');
  });

  it('desligar o provedor volta ao nível 1', () => {
    const o = createVoiceOcclusion();
    o.setPortalProvider(() => ({ blocked: false, gainModifier: 0.5 }));
    o.setPortalProvider(null);
    assert.strictEqual(o.between(TAVERNA, OUTRA_TAVERNA).blocked, true);
    assert.strictEqual(o.describe().level, 1);
  });

  it('o provedor só é consultado quando os espaços DIFEREM', () => {
    let chamadas = 0;
    const o = createVoiceOcclusion();
    o.setPortalProvider(() => { chamadas++; return null; });
    o.between(TAVERNA, TAVERNA);
    assert.strictEqual(chamadas, 0, 'o caso comum não pode pagar uma chamada');
  });
});
