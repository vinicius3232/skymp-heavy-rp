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

/**
 * SV-07 — a punição sobrevive ao restart.
 *
 * O que estava errado não era só "a punição some". Desde que ela passou a mexer
 * no token do LiveKit (SV-02), um restart devolvia a voz **e** reemitia token
 * com `canPublish: true` — ou seja, a forma mais barata de escapar de uma
 * punição era esperar o próximo restart do servidor.
 */
describe('voice-staff-mute — persistência (SV-07)', () => {
  /** Store de mentira que registra o que foi pedido, e pode quebrar sob comando. */
  function fakeStore(inicial = []) {
    const linhas = new Map(inicial.map((e) => [e.characterId, e]));
    const chamadas = [];
    let quebrado = null;
    return {
      chamadas,
      linhas,
      quebrar(err) { quebrado = err; },
      store: {
        async save(entry) {
          chamadas.push(['save', entry.characterId]);
          if (quebrado) throw quebrado;
          linhas.set(entry.characterId, entry);
        },
        async remove(characterId) {
          chamadas.push(['remove', characterId]);
          if (quebrado) throw quebrado;
          linhas.delete(characterId);
        },
        async loadActive(nowMs) {
          chamadas.push(['loadActive', nowMs]);
          if (quebrado) throw quebrado;
          return [...linhas.values()].filter((e) => e.until === null || e.until > nowMs);
        }
      }
    };
  }

  const entrada = (characterId, until = null) => ({
    characterId, byCharacterId: 9, reason: 'teste', at: 1000, until
  });

  it('o silêncio atravessa o restart', async () => {
    const disco = fakeStore();

    const antesDoRestart = createVoiceStaffMute({ store: disco.store });
    antesDoRestart.mute(A, { reason: 'gritando por cima da cena', byCharacterId: B });
    // A escrita é deliberadamente sem `await` dentro do módulo; o teste espera o
    // event loop drenar, que é o que um servidor real faz entre ticks.
    await new Promise((r) => setImmediate(r));

    const depoisDoRestart = createVoiceStaffMute({ store: disco.store });
    assert.strictEqual(depoisDoRestart.isMuted(A), false, 'antes do hydrate, ninguém está calado');

    const carga = await depoisDoRestart.hydrate();
    assert.strictEqual(carga.ok, true);
    assert.strictEqual(carga.loaded, 1);
    assert.strictEqual(depoisDoRestart.isMuted(A), true);
    assert.strictEqual(depoisDoRestart.get(A).reason, 'gritando por cima da cena');
  });

  it('a punição vale ANTES de o banco responder — o registro não espera I/O', () => {
    const disco = fakeStore();
    const m = createVoiceStaffMute({ store: disco.store });

    m.mute(A, {});
    // Nenhum `await` aqui de propósito: se o módulo esperasse a escrita, um
    // MySQL lento viraria uma janela em que a staff manda calar e nada acontece.
    assert.strictEqual(m.isMuted(A), true);
  });

  it('banco fora do ar NÃO impede a punição, e não lança', async () => {
    const disco = fakeStore();
    disco.quebrar(new Error('MySQL fora'));
    const avisos = [];
    const m = createVoiceStaffMute({
      store: disco.store,
      logger: { warn: (msg) => avisos.push(msg) }
    });

    // Sem try/catch: se lançar, o caso quebra — que é o ponto.
    m.mute(A, {});
    await new Promise((r) => setImmediate(r));

    assert.strictEqual(m.isMuted(A), true, 'a punição vale nesta execução mesmo sem banco');
    assert.strictEqual(avisos.length, 1);
    assert.match(avisos[0], /não persistiu/);
  });

  it('hydrate que falha não derruba o boot', async () => {
    const disco = fakeStore();
    disco.quebrar(new Error('MySQL fora'));
    const m = createVoiceStaffMute({ store: disco.store, logger: { warn: () => {} } });

    const carga = await m.hydrate();
    assert.strictEqual(carga.ok, false);
    assert.strictEqual(m.size(), 0, 'começa vazio em vez de não começar');
  });

  it('punição vencida no banco não volta no hydrate', async () => {
    let agora = 5000;
    const disco = fakeStore([entrada(A, 1000), entrada(B, null)]);
    const m = createVoiceStaffMute({ store: disco.store, now: () => agora });

    const carga = await m.hydrate();
    assert.strictEqual(carga.loaded, 1);
    assert.strictEqual(m.isMuted(A), false, 'expirou enquanto o servidor estava desligado');
    assert.strictEqual(m.isMuted(B), true);
  });

  it('expirar na leitura também apaga a linha — senão o banco só cresce', async () => {
    let agora = 1000;
    const disco = fakeStore();
    const m = createVoiceStaffMute({ store: disco.store, now: () => agora });

    m.mute(A, { durationMs: 100 });
    await new Promise((r) => setImmediate(r));

    agora = 2000;
    assert.strictEqual(m.isMuted(A), false);
    await new Promise((r) => setImmediate(r));
    assert.ok(disco.chamadas.some(([op, id]) => op === 'remove' && id === A));
  });

  it('unmute alcança o banco mesmo com a memória já limpa', async () => {
    // Cenário real: o hydrate falhou, então a memória está vazia, mas a linha
    // continua no banco. Um `unmute` que só olhasse a memória não faria nada, e
    // a punição ressuscitaria no próximo restart.
    const disco = fakeStore([entrada(A)]);
    const m = createVoiceStaffMute({ store: disco.store });

    const r = m.unmute(A);
    await new Promise((res) => setImmediate(res));

    assert.strictEqual(r.changed, false, 'a memória não tinha nada');
    assert.strictEqual(disco.linhas.has(A), false, 'o banco tinha, e agora não tem');
  });

  it('sem store, o módulo se comporta exatamente como antes', async () => {
    const m = createVoiceStaffMute();
    m.mute(A, {});
    assert.strictEqual(m.isMuted(A), true);

    const carga = await m.hydrate();
    assert.strictEqual(carga.ok, false);
    assert.match(carga.reason, /sem persistência/);
  });

  it('setStore liga a persistência depois da construção — é assim que o boot faz', async () => {
    const disco = fakeStore();
    const m = createVoiceStaffMute();

    m.mute(A, {});
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(disco.chamadas.length, 0, 'sem store, nada foi escrito');

    m.setStore(disco.store);
    m.mute(B, {});
    await new Promise((r) => setImmediate(r));
    assert.ok(disco.chamadas.some(([op, id]) => op === 'save' && id === B));
  });
});
