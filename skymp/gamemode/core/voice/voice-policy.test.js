/**
 * core/voice/voice-policy.test.js
 *
 * Testes do VoicePolicyEngine e do VoiceStateService: os três modos de voz, o
 * PTT, o mute e a regra de célula/worldspace.
 *
 * Duas coisas que estes testes protegem e que não são óbvias:
 *
 * 1. **Nenhum número de alcance é escrito aqui.** Os casos comparam contra
 *    `VOICE_RANGES` importado de `core/proximity-ranges.js`. Um teste com
 *    `assert(volume > 0 em 400 unidades)` passaria a mentir no dia em que
 *    alguém mexesse em `chat.whisperRange` no `server-options` — e o ponto do
 *    arquivo de raios é justamente que mexer lá mude o jogo.
 *
 * 2. **O PTT é testado pelo efeito no servidor**, não pelo retorno da chamada.
 *    O que prova que "mute local não é a segurança" é `canHear` devolver
 *    `ok: false` com o PTT solto, porque é `canHear` que decide se a voz sai.
 *
 * Executa com: node --test core/voice/voice-policy.test.js
 */

const assert = require('assert');
const { describe, it, beforeEach } = require('node:test');

const { VOICE_RANGES } = require('../proximity-ranges');
const {
  createVoiceStateService, VOICE_MODES, DEFAULT_VOICE_MODE, CONNECTION_STATES
} = require('./voice-state');
const { createVoicePolicyEngine, volumeAt, sameSpace } = require('./voice-policy');

const A = 0xff00c001;
const B = 0xff00c002;
const CELL = '162e2:Skyrim.esm';
const OUTRA_CELL = '1a2b3:Skyrim.esm';
const WORLDSPACE = '3c:Skyrim.esm';

/** Ator pronto para falar: personagem carregado, conectado, PTT apertado. */
function pronto(state, policy, actorId, mode = DEFAULT_VOICE_MODE) {
  state.ensure(actorId, { characterId: actorId });
  state.setConnectionState(actorId, CONNECTION_STATES.CONNECTED);
  state.setVoiceMode(actorId, mode);
  policy.pttDown(actorId);
}

function amostra(actorId, pos, space = CELL) {
  return { actorId, space, pos };
}

describe('voice-state — o cliente não escolhe o que o servidor guarda', () => {
  let state;
  beforeEach(() => { state = createVoiceStateService(); });

  it('os modos válidos são derivados de VOICE_RANGES, não escritos à mão', () => {
    assert.deepStrictEqual(VOICE_MODES.slice().sort(), Object.keys(VOICE_RANGES).sort());
    assert.ok(VOICE_MODES.includes('whisper'));
    assert.ok(VOICE_MODES.includes('normal'));
    assert.ok(VOICE_MODES.includes('shout'));
  });

  it('recusa modo desconhecido SEM tocar no estado anterior', () => {
    state.ensure(A);
    state.setVoiceMode(A, 'shout');

    for (const lixo of ['radio', 'global', '__proto__', '', null, 42, {}]) {
      const r = state.setVoiceMode(A, lixo);
      assert.strictEqual(r.ok, false, `${JSON.stringify(lixo)} deveria ser recusado`);
      assert.strictEqual(state.get(A).voiceMode, 'shout', 'o modo anterior tem que sobreviver');
    }
  });

  it('mutar derruba o PTT junto', () => {
    state.ensure(A);
    state.setTransmitting(A, true);
    state.setMuted(A, true);
    assert.strictEqual(state.get(A).transmitting, false);
  });

  it('perder a conexão derruba o PTT — voltar não devolve a transmissão sozinha', () => {
    state.ensure(A);
    state.setConnectionState(A, CONNECTION_STATES.CONNECTED);
    state.setTransmitting(A, true);

    state.setConnectionState(A, CONNECTION_STATES.RECONNECTING);
    assert.strictEqual(state.get(A).transmitting, false);

    state.setConnectionState(A, CONNECTION_STATES.CONNECTED);
    assert.strictEqual(state.get(A).transmitting, false, 'reconectar não pode religar o microfone');
  });

  it('remove é idempotente — logout, disconnect e cleanup podem chegar em qualquer ordem', () => {
    state.ensure(A);
    assert.strictEqual(state.remove(A), true);
    assert.strictEqual(state.remove(A), false);
    assert.strictEqual(state.get(A), null);
  });
});

describe('voice-policy — volume e alcance', () => {
  it('volumeAt cai linearmente e corta exatamente no alcance', () => {
    const r = VOICE_RANGES.normal;
    assert.strictEqual(volumeAt(0, r), 1);
    assert.ok(Math.abs(volumeAt(r / 2, r) - 0.5) < 1e-9);
    assert.strictEqual(volumeAt(r, r), 0, 'no alcance exato já é silêncio');
    assert.strictEqual(volumeAt(r + 1, r), 0);
  });

  it('volumeAt é a MESMA conta do calcVolume legado — caracterização', () => {
    // A conta antiga, copiada do voip-service.js antes da extração.
    const legado = (dist, maxRange) => {
      if (dist >= maxRange) return 0;
      return Math.max(0, Math.min(1, 1 - (dist / maxRange)));
    };
    for (const range of Object.values(VOICE_RANGES)) {
      for (let d = 0; d <= range * 1.2; d += range / 37) {
        assert.strictEqual(volumeAt(d, range), legado(d, range), `divergiu em d=${d}, r=${range}`);
      }
    }
  });

  it('entrada não-numérica vira silêncio, nunca NaN', () => {
    assert.strictEqual(volumeAt(NaN, 1200), 0);
    assert.strictEqual(volumeAt(100, undefined), 0);
    assert.strictEqual(volumeAt(100, 0), 0);
  });

  it('sameSpace: iguais sim, diferentes não, desconhecido não separa', () => {
    assert.strictEqual(sameSpace(CELL, CELL), true);
    assert.strictEqual(sameSpace(CELL, OUTRA_CELL), false);
    assert.strictEqual(sameSpace(CELL, WORLDSPACE), false);
    assert.strictEqual(sameSpace(null, CELL), true, 'falta de informação não é prova de separação');
    assert.strictEqual(sameSpace(CELL, undefined), true);
  });
});

describe('voice-policy — os três modos alcançam o que a tabela diz', () => {
  let state, policy;
  beforeEach(() => {
    state = createVoiceStateService();
    policy = createVoicePolicyEngine({ state });
    pronto(state, policy, A, DEFAULT_VOICE_MODE);
    state.ensure(B, { characterId: B });
    state.setConnectionState(B, CONNECTION_STATES.CONNECTED);
  });

  for (const modo of ['whisper', 'normal', 'shout']) {
    it(`${modo}: ouve dentro do raio, silêncio fora — sem número escrito no teste`, () => {
      const raio = VOICE_RANGES[modo];
      state.setVoiceMode(A, modo);

      const dentro = policy.canHear(amostra(B, [raio * 0.5, 0, 0]), amostra(A, [0, 0, 0]));
      assert.strictEqual(dentro.ok, true, `${modo} deveria alcançar metade do raio`);
      assert.ok(dentro.volume > 0 && dentro.volume <= 1);

      const fora = policy.canHear(amostra(B, [raio + 1, 0, 0]), amostra(A, [0, 0, 0]));
      assert.strictEqual(fora.ok, false);
      assert.strictEqual(fora.volume, 0);
      assert.strictEqual(fora.reason, 'fora de alcance');
    });
  }

  it('o alcance é do LOCUTOR, não do ouvinte — gritar não faz o outro gritar de volta', () => {
    pronto(state, policy, B, 'whisper');
    state.setVoiceMode(A, 'shout');

    const distancia = VOICE_RANGES.whisper + 100; // fora do sussurro, dentro do grito
    const aFalaGritando = policy.canHear(amostra(B, [distancia, 0, 0]), amostra(A, [0, 0, 0]));
    const bFalaSussurrando = policy.canHear(amostra(A, [0, 0, 0]), amostra(B, [distancia, 0, 0]));

    assert.strictEqual(aFalaGritando.ok, true, 'A grita e alcança B');
    assert.strictEqual(bFalaSussurrando.ok, false, 'B sussurra e não alcança A');
  });

  it('a distância continua influenciando o volume dentro do alcance', () => {
    state.setVoiceMode(A, 'normal');
    const r = VOICE_RANGES.normal;
    const perto = policy.canHear(amostra(B, [r * 0.1, 0, 0]), amostra(A, [0, 0, 0]));
    const longe = policy.canHear(amostra(B, [r * 0.9, 0, 0]), amostra(A, [0, 0, 0]));
    assert.ok(perto.volume > longe.volume, 'mais perto tem que ser mais alto');
    assert.ok(longe.volume > 0);
  });

  it('a distância é 3D — altura conta', () => {
    const r = VOICE_RANGES.normal;
    const plano = policy.canHear(amostra(B, [r * 0.9, 0, 0]), amostra(A, [0, 0, 0]));
    const acima = policy.canHear(amostra(B, [r * 0.9, 0, r * 0.9]), amostra(A, [0, 0, 0]));
    assert.ok(plano.ok);
    assert.strictEqual(acima.ok, false, 'a mesma distância horizontal, alto o bastante, sai do alcance');
  });
});

describe('voice-policy — célula e worldspace', () => {
  let state, policy;
  beforeEach(() => {
    state = createVoiceStateService();
    policy = createVoicePolicyEngine({ state });
    pronto(state, policy, A);
    state.ensure(B, { characterId: B });
    state.setConnectionState(B, CONNECTION_STATES.CONNECTED);
  });

  it('mesma célula, coordenadas próximas: ouve', () => {
    const r = policy.canHear(amostra(B, [10, 0, 0], CELL), amostra(A, [0, 0, 0], CELL));
    assert.strictEqual(r.ok, true);
  });

  it('células diferentes com coordenadas IDÊNTICAS: nunca ouve', () => {
    const r = policy.canHear(amostra(B, [0, 0, 0], OUTRA_CELL), amostra(A, [0, 0, 0], CELL));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.volume, 0);
    assert.strictEqual(r.reason, 'célula/worldspace incompatível');
  });

  it('worldspaces diferentes com coordenadas idênticas: nunca ouve', () => {
    const r = policy.canHear(amostra(B, [0, 0, 0], WORLDSPACE), amostra(A, [0, 0, 0], CELL));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'célula/worldspace incompatível');
  });

  it('espaço desconhecido de um lado não silencia ninguém', () => {
    const r = policy.canHear(amostra(B, [10, 0, 0], null), amostra(A, [0, 0, 0], CELL));
    assert.strictEqual(r.ok, true, 'não saber onde alguém está não é prova de que ele está longe');
  });
});

describe('voice-policy — PTT é a segurança, não o mute local', () => {
  let state, policy;
  beforeEach(() => {
    state = createVoiceStateService();
    policy = createVoicePolicyEngine({ state });
    state.ensure(A, { characterId: A });
    state.setConnectionState(A, CONNECTION_STATES.CONNECTED);
    state.ensure(B, { characterId: B });
    state.setConnectionState(B, CONNECTION_STATES.CONNECTED);
  });

  it('PTT é o padrão: sem apertar, não fala', () => {
    assert.strictEqual(policy.pttRequired, true);
    const r = policy.canSpeak(A);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'PTT solto');
  });

  it('PTT DOWN → o servidor valida e permite; PTT UP → corta', () => {
    const down = policy.pttDown(A);
    assert.strictEqual(down.ok, true);
    assert.strictEqual(down.changed, true);
    assert.strictEqual(policy.canSpeak(A).ok, true);

    const ouveComPtt = policy.canHear(amostra(B, [10, 0, 0]), amostra(A, [0, 0, 0]));
    assert.strictEqual(ouveComPtt.ok, true);

    const up = policy.pttUp(A);
    assert.strictEqual(up.changed, true);

    const ouveSemPtt = policy.canHear(amostra(B, [10, 0, 0]), amostra(A, [0, 0, 0]));
    assert.strictEqual(ouveSemPtt.ok, false, 'sem PTT o SERVIDOR não entrega — não depende do cliente');
    assert.strictEqual(ouveSemPtt.reason, 'PTT solto');
  });

  it('PTT DOWN é RECUSADO quando o servidor diz que não pode falar', () => {
    policy.requestMute(A, true);
    const r = policy.pttDown(A);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'mutado');
    assert.strictEqual(state.get(A).transmitting, false, 'a recusa não pode deixar resíduo ligado');
  });

  it('PTT DOWN é recusado sem personagem carregado', () => {
    state.ensure(0xff00c009);
    state.setConnectionState(0xff00c009, CONNECTION_STATES.CONNECTED);
    const r = policy.pttDown(0xff00c009);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'personagem não carregado');
  });

  it('PTT DOWN é recusado com a conexão fora de CONNECTED', () => {
    for (const estado of ['CONNECTING', 'RECONNECTING', 'FAILED', 'DISABLED']) {
      state.setConnectionState(A, estado);
      const r = policy.pttDown(A);
      assert.strictEqual(r.ok, false, `${estado} não pode falar`);
      assert.ok(r.reason.includes(estado));
    }
  });

  it('PTT UP nunca falha — soltar a tecla é o lado seguro', () => {
    assert.strictEqual(policy.pttUp(A).ok, true);
    assert.strictEqual(policy.pttUp(A).ok, true);
    assert.strictEqual(policy.pttUp(0xdeadbeef).ok, true, 'nem para um ator que não existe');
  });

  it('mutar durante a fala corta na hora', () => {
    policy.pttDown(A);
    assert.strictEqual(policy.canHear(amostra(B, [10, 0, 0]), amostra(A, [0, 0, 0])).ok, true);
    policy.requestMute(A, true);
    const r = policy.canHear(amostra(B, [10, 0, 0]), amostra(A, [0, 0, 0]));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'mutado');
  });

  it('mute silencia a própria voz, não a dos outros', () => {
    policy.pttDown(A);
    policy.requestMute(B, true);
    const bOuveA = policy.canHear(amostra(B, [10, 0, 0]), amostra(A, [0, 0, 0]));
    assert.strictEqual(bOuveA.ok, true, 'B mutado continua OUVINDO');
    assert.strictEqual(policy.canListen(B).ok, true);
  });

  it('ouvinte desconectado não recebe rota', () => {
    policy.pttDown(A);
    state.setConnectionState(B, CONNECTION_STATES.FAILED);
    const r = policy.canHear(amostra(B, [10, 0, 0]), amostra(A, [0, 0, 0]));
    assert.strictEqual(r.ok, false);
    assert.ok(r.reason.includes('FAILED'));
  });

  it('ninguém ouve a própria voz de volta', () => {
    policy.pttDown(A);
    const r = policy.canHear(amostra(A, [0, 0, 0]), amostra(A, [0, 0, 0]));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'mesmo ator');
  });
});

describe('voice-policy — as duas superfícies da mesma regra concordam', () => {
  /**
   * `canHear` é a forma legível; `audienceProbe` é a forma que o recompute usa
   * dezenas de milhares de vezes por tick. `canHear` é implementada sobre o
   * probe, então elas não PODEM divergir no "sim" — mas o caminho de recusa
   * reconstrói o motivo por conta própria, e é lá que uma divergência caberia.
   *
   * Este caso varre a matriz inteira de estados e distâncias e exige que as
   * duas respondam a mesma coisa. Sem ele, uma otimização futura no probe
   * poderia calar alguém que `canHear` diz que ouve, e o único sintoma seria
   * um teste passando enquanto o jogo erra.
   */
  it('canHear e audienceProbe dão o mesmo veredito em toda a matriz', () => {
    const state = createVoiceStateService();
    const policy = createVoicePolicyEngine({ state });

    const estados = ['CONNECTED', 'CONNECTING', 'RECONNECTING', 'FAILED', 'DISABLED'];
    const espacos = [CELL, OUTRA_CELL, null];
    let comparacoes = 0;

    for (const modo of VOICE_MODES) {
      for (const estadoFala of estados) {
        for (const estadoOuve of estados) {
          for (const mutado of [false, true]) {
            for (const ptt of [false, true]) {
              for (const espacoOuve of espacos) {
                state.clear();
                state.ensure(A, { characterId: A });
                state.ensure(B, { characterId: B });
                state.setVoiceMode(A, modo);
                state.setConnectionState(A, estadoFala);
                state.setConnectionState(B, estadoOuve);
                state.setMuted(A, mutado);
                if (ptt) state.setTransmitting(A, true);

                const raio = VOICE_RANGES[modo];
                for (const d of [0, raio * 0.5, raio - 1, raio, raio * 2]) {
                  const falante = amostra(A, [0, 0, 0], CELL);
                  const ouvinteAmostra = amostra(B, [d, 0, 0], espacoOuve);

                  const porCanHear = policy.canHear(ouvinteAmostra, falante);
                  const probe = policy.audienceProbe(falante);
                  const volumeProbe = probe ? probe(ouvinteAmostra) : 0;

                  assert.strictEqual(
                    porCanHear.ok, volumeProbe > 0,
                    `divergência: modo=${modo} fala=${estadoFala} ouve=${estadoOuve} ` +
                    `mudo=${mutado} ptt=${ptt} espaço=${espacoOuve} d=${d}`
                  );
                  if (porCanHear.ok) {
                    assert.ok(Math.abs(porCanHear.volume - volumeProbe) < 1e-12,
                      `volumes divergiram: ${porCanHear.volume} vs ${volumeProbe}`);
                  }
                  comparacoes++;
                }
              }
            }
          }
        }
      }
    }
    assert.ok(comparacoes > 1000, `esperava uma matriz grande; foram ${comparacoes} comparações`);
  });
});

describe('voice-policy — modo desconhecido nunca vira alcance indefinido', () => {
  it('rangeFor de modo inválido cai em normal, não em undefined', () => {
    const state = createVoiceStateService();
    const policy = createVoicePolicyEngine({ state });
    assert.strictEqual(policy.rangeFor('radio'), VOICE_RANGES.normal);
    assert.strictEqual(policy.rangeFor(undefined), VOICE_RANGES.normal);
    assert.ok(Number.isFinite(policy.rangeFor('qualquer coisa')));
  });

  it('maxRange é o maior raio da tabela — o raio de busca do índice', () => {
    const state = createVoiceStateService();
    const policy = createVoicePolicyEngine({ state });
    assert.strictEqual(policy.maxRange(), Math.max(...Object.values(VOICE_RANGES)));
  });
});
