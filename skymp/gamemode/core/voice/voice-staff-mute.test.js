/**
 * core/voice/voice-staff-mute.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { createVoiceStaffMute } = require('./voice-staff-mute');

const { describe, it } = test;

const A = 1;
const B = 2;

describe('voice-staff-mute', () => {
  it('silencia e devolve a voz', () => {
    const m = createVoiceStaffMute();
    assert.strictEqual(m.isMuted(A), false);

    m.mute(A, { reason: 'gritando por cima da cena', byCharacterId: B });
    assert.strictEqual(m.isMuted(A), true);
    assert.strictEqual(m.get(A).byCharacterId, B);

    m.unmute(A);
    assert.strictEqual(m.isMuted(A), false);
  });

  it('silenciar um NÃO silencia o outro', () => {
    const m = createVoiceStaffMute();
    m.mute(A, {});
    assert.strictEqual(m.isMuted(B), false);
  });

  it('sem motivo, registra que não houve motivo em vez de deixar vazio', () => {
    const m = createVoiceStaffMute();
    m.mute(A, {});
    assert.ok(m.get(A).reason.length > 0);
  });

  it('characterId inválido é recusado antes de virar entrada', () => {
    const m = createVoiceStaffMute();
    assert.strictEqual(m.mute(undefined, {}).ok, false);
    assert.strictEqual(m.size(), 0);
  });

  /**
   * A expiração é conferida na LEITURA, não por timer.
   *
   * Um `setTimeout` por punição sobreviveria a logout e a `unmute`, e um deles
   * disparando depois de a pessoa ter sido silenciada de novo desfaria a
   * segunda punição por causa da primeira.
   */
  it('silêncio temporário expira sozinho, sem timer', () => {
    let agora = 1000;
    const m = createVoiceStaffMute({ now: () => agora });

    m.mute(A, { durationMs: 60_000 });
    assert.strictEqual(m.isMuted(A), true);

    agora += 59_000;
    assert.strictEqual(m.isMuted(A), true);

    agora += 2_000;
    assert.strictEqual(m.isMuted(A), false);
    assert.strictEqual(m.size(), 0, 'expirado sai do mapa em vez de acumular');
  });

  it('sem duração, o silêncio dura até alguém desfazer', () => {
    let agora = 0;
    const m = createVoiceStaffMute({ now: () => agora });
    m.mute(A, {});
    agora += 10 * 365 * 24 * 3600 * 1000;
    assert.strictEqual(m.isMuted(A), true);
  });

  it('resilenciar substitui a punição anterior, com o motivo novo', () => {
    const m = createVoiceStaffMute();
    m.mute(A, { reason: 'primeiro' });
    m.mute(A, { reason: 'segundo' });
    assert.strictEqual(m.get(A).reason, 'segundo');
    assert.strictEqual(m.size(), 1);
  });

  it('describe lista quem está silenciado agora, sem os expirados', () => {
    let agora = 0;
    const m = createVoiceStaffMute({ now: () => agora });
    m.mute(A, { durationMs: 100 });
    m.mute(B, {});

    agora = 200;
    const lista = m.describe();
    assert.deepStrictEqual(lista.map((e) => e.characterId), [B]);
  });

  it('desfazer quem não estava silenciado não é erro', () => {
    const m = createVoiceStaffMute();
    assert.deepStrictEqual(m.unmute(A), { ok: true, changed: false });
  });

  it('duas instâncias não compartilham registro — testes não vazam entre si', () => {
    const m1 = createVoiceStaffMute();
    const m2 = createVoiceStaffMute();
    m1.mute(A, {});
    assert.strictEqual(m2.isMuted(A), false);
  });
});
