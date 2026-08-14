/**
 * core/voice/voice-speaking-state.test.js
 *
 * `isSpeaking`, `audioLevel`, e — o que de fato importa — as **cinco garantias
 * de parada** que a etapa exigiu.
 *
 * Uma animação de fala que só sabe começar é como um microfone que só sabe
 * abrir. Cada uma das cinco tem um caso aqui.
 */

const assert = require('assert');
const { describe, it, beforeEach } = require('node:test');

const { createVoiceSpeakingState } = require('./voice-speaking-state');
const { createVoiceSpeechAnimation } = require('./voice-speech-animation');

const A = 0xff00e001;
const B = 0xff00e002;

/** Política falsa: um conjunto de quem pode falar, controlado pelo teste. */
function politicaFalsa(podem = [A, B]) {
  const conjunto = new Set(podem);
  return {
    conjunto,
    canSpeak: (actorId) => (conjunto.has(actorId)
      ? { ok: true }
      : { ok: false, reason: 'proibido pelo teste' })
  };
}

let agora;
let policy;
let speaking;

beforeEach(() => {
  agora = 1000;
  policy = politicaFalsa();
  speaking = createVoiceSpeakingState({ policy, now: () => agora, silenceMs: 200 });
});

describe('voice-speaking-state — o básico', () => {
  it('ninguém está falando antes do primeiro quadro', () => {
    assert.strictEqual(speaking.isSpeaking(A), false);
    assert.deepStrictEqual(speaking.speakers(), []);
  });

  /**
   * A distinção que este módulo existe para fazer: PTT é PERMISSÃO, quadro é
   * OBSERVAÇÃO. Segurar a tecla e ficar calado é o caso comum de quem está
   * prestes a dizer algo, e uma boca ligada no PTT abriria meio segundo antes
   * do som, todas as vezes.
   */
  it('poder falar NÃO é estar falando — só o quadro liga', () => {
    assert.strictEqual(policy.canSpeak(A).ok, true);
    assert.strictEqual(speaking.isSpeaking(A), false);

    speaking.noteFrame(A);
    assert.strictEqual(speaking.isSpeaking(A), true);
  });

  it('o evento sai UMA vez por transição, não por quadro', () => {
    const eventos = [];
    speaking.onChange((actorId, isSpeaking) => eventos.push([actorId, isSpeaking]));

    for (let i = 0; i < 10; i++) speaking.noteFrame(A);
    assert.deepStrictEqual(eventos, [[A, true]], '10 quadros, 1 evento');
  });

  it('`audioLevel` do servidor é null — ele não abre o PCM', () => {
    speaking.noteFrame(A);
    assert.strictEqual(speaking.audioLevel(A), null,
      'prometer um número aqui exigiria decodificar 50 quadros por segundo por locutor');
  });

  it('mas aceita um nível se algum dia o cliente medir e mandar', () => {
    speaking.noteFrame(A, 0.42);
    assert.strictEqual(speaking.audioLevel(A), 0.42);
  });

  it('nível fora de [0,1] é grampeado em vez de propagado', () => {
    speaking.noteFrame(A, 5);
    assert.strictEqual(speaking.audioLevel(A), 1);
  });
});

describe('voice-speaking-state — as cinco garantias de parada', () => {
  it('1. soltar o PTT: `clear` para na hora', () => {
    speaking.noteFrame(A);
    assert.strictEqual(speaking.clear(A), true);
    assert.strictEqual(speaking.isSpeaking(A), false);
  });

  it('2. mute: mesma porta, e o evento de parada sai', () => {
    const eventos = [];
    speaking.onChange((actorId, isSpeaking) => eventos.push(isSpeaking));
    speaking.noteFrame(A);
    speaking.clear(A);
    assert.deepStrictEqual(eventos, [true, false]);
  });

  it('3. disconnect: `forget` para e esquece', () => {
    speaking.noteFrame(A);
    speaking.forget(A);
    assert.strictEqual(speaking.isSpeaking(A), false);
    assert.strictEqual(speaking.describe().tracked, 0, 'nem resíduo no mapa');
  });

  it('4. falha de voz: `clearAll` limpa a cena inteira', () => {
    speaking.noteFrame(A);
    speaking.noteFrame(B);
    speaking.clearAll();
    assert.deepStrictEqual(speaking.speakers(), []);
  });

  /**
   * A quinta é a que não podia ser um evento: **ninguém emite "você morreu,
   * pare de falar"** para o sistema de voz. Sem o `sweep`, a boca de quem morre
   * no meio da frase fica aberta.
   */
  it('5. perder o direito de falar: o sweep fecha a boca de quem morreu falando', () => {
    speaking.noteFrame(A);
    assert.strictEqual(speaking.isSpeaking(A), true);

    policy.conjunto.delete(A); // morreu / foi amordaçado / foi silenciado
    assert.strictEqual(speaking.sweep(), 1);
    assert.strictEqual(speaking.isSpeaking(A), false);
  });

  it('e o quadro seguinte à morte também não reabre a boca', () => {
    speaking.noteFrame(A);
    policy.conjunto.delete(A);
    assert.strictEqual(speaking.noteFrame(A), false,
      'entre um tick e outro cabem sete quadros; esperar o sweep seria tarde');
    assert.strictEqual(speaking.isSpeaking(A), false);
  });
});

describe('voice-speaking-state — silêncio natural', () => {
  it('parar de mandar quadro para a fala depois do tempo de silêncio', () => {
    speaking.noteFrame(A);
    agora += 150;
    speaking.sweep();
    assert.strictEqual(speaking.isSpeaking(A), true, 'ainda dentro da janela');

    agora += 100;
    speaking.sweep();
    assert.strictEqual(speaking.isSpeaking(A), false);
  });

  it('quem continua mandando quadro não é derrubado pelo sweep', () => {
    for (let i = 0; i < 5; i++) {
      speaking.noteFrame(A);
      agora += 100;
      speaking.sweep();
      assert.strictEqual(speaking.isSpeaking(A), true, `iteração ${i}`);
    }
  });

  it('parar um NÃO para o outro', () => {
    speaking.noteFrame(A);
    speaking.noteFrame(B);
    speaking.clear(A);
    assert.strictEqual(speaking.isSpeaking(B), true);
  });

  it('`clear` é idempotente — as cinco portas podem chegar em qualquer ordem', () => {
    speaking.noteFrame(A);
    assert.strictEqual(speaking.clear(A), true);
    assert.strictEqual(speaking.clear(A), false);
    assert.strictEqual(speaking.clear(A), false);
  });

  it('um assinante que lança não trava a boca dos outros', () => {
    speaking.onChange(() => { throw new Error('assinante ruim'); });
    const bons = [];
    speaking.onChange((actorId) => bons.push(actorId));

    assert.doesNotThrow(() => speaking.noteFrame(A));
    assert.deepStrictEqual(bons, [A]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('voice-speech-animation — o gatilho', () => {
  function montar(opts = {}) {
    const chamadas = [];
    const mp = {
      getDescFromId: (id) => `${id.toString(16)}:Skyrim.esm`,
      callPapyrusFunction: (tipo, classe, fn, self, args) => chamadas.push({ tipo, classe, fn, args })
    };
    const anim = createVoiceSpeechAnimation({
      enabled: true, mp, now: () => agora, defer: (fn) => fn(),
      logger: { log() {}, warn() {}, error() {} },
      ...opts
    });
    return { anim, chamadas, mp };
  }

  it('DESLIGADA por padrão — os nomes de evento não foram vistos em jogo', () => {
    const anim = createVoiceSpeechAnimation({ enabled: undefined, mp: {} });
    assert.strictEqual(typeof anim.enabled, 'boolean');
    assert.strictEqual(anim.describe().enabled, process.env.VOICE_SPEECH_ANIMATION === 'true');
  });

  it('ligada, começar a falar manda um Debug.SendAnimationEvent', () => {
    const { anim, chamadas } = montar();
    anim.set(A, true);

    assert.strictEqual(chamadas.length, 1);
    assert.strictEqual(chamadas[0].tipo, 'global');
    assert.strictEqual(chamadas[0].classe, 'Debug');
    assert.strictEqual(chamadas[0].fn, 'SendAnimationEvent');
    // A referência é `{type:'form', desc}` e não o FormID cru. Passar o número
    // já custou 22 chamadas erradas a este projeto. Ver core/papyrus.js.
    assert.deepStrictEqual(chamadas[0].args[0], { type: 'form', desc: `${A.toString(16)}:Skyrim.esm` });
  });

  it('reafirmar o mesmo estado NÃO manda de novo', () => {
    const { anim, chamadas } = montar();
    anim.set(A, true);
    agora += 1000;
    anim.set(A, true);
    assert.strictEqual(chamadas.length, 1);
  });

  it('PTT tamborilado é coalescido pelo piso de intervalo', () => {
    const adiado = [];
    const { anim, chamadas } = montar({ defer: (fn) => adiado.push(fn), minIntervalMs: 250 });

    anim.set(A, true);          // imediato
    assert.strictEqual(chamadas.length, 1);

    for (let i = 0; i < 20; i++) anim.set(A, i % 2 === 0);
    assert.strictEqual(chamadas.length, 1, 'nada mais saiu durante a janela');
    assert.strictEqual(adiado.length, 1, 'e só UM adiamento foi agendado');

    agora += 300;
    adiado[0]();
    assert.ok(chamadas.length <= 2, 'vinte trocas viram no máximo uma chamada a mais');
  });

  it('`stop` NÃO espera o piso — boca aberta é pior que uma chamada a mais', () => {
    const { anim, chamadas } = montar({ defer: () => {} , minIntervalMs: 10_000 });
    anim.set(A, true);
    anim.stop(A);
    assert.strictEqual(chamadas.length, 2);
    assert.strictEqual(chamadas[1].args[1], anim.describe().stopEvent);
  });

  it('parar quem já estava parado não manda nada', () => {
    const { anim, chamadas } = montar();
    anim.stop(A);
    assert.strictEqual(chamadas.length, 0);
  });

  it('`bind` faz as cinco garantias do estado de fala valerem para a animação', () => {
    const { anim, chamadas } = montar();
    anim.bind(speaking);

    speaking.noteFrame(A);
    assert.strictEqual(chamadas.length, 1, 'começou');

    policy.conjunto.delete(A);
    speaking.sweep();
    assert.strictEqual(chamadas.length, 2, 'morreu falando e a boca fechou');
    assert.strictEqual(chamadas[1].args[1], anim.describe().stopEvent);
  });

  it('sem mundo (`mp` ausente) não lança — a voz é o produto, a animação é o enfeite', () => {
    const anim = createVoiceSpeechAnimation({
      enabled: true, mp: null, now: () => agora, defer: (fn) => fn()
    });
    const anterior = globalThis.mp;
    try {
      // @ts-ignore — apagar o global é justamente o cenário
      delete globalThis.mp;
      assert.doesNotThrow(() => anim.set(A, true));
    } finally {
      if (anterior !== undefined) globalThis.mp = anterior;
    }
  });

  it('um `mp` que lança não derruba o laço de voz', () => {
    const { anim } = montar({ mp: { callPapyrusFunction: () => { throw new Error('VM fora'); }, getDescFromId: () => 'x' } });
    assert.doesNotThrow(() => anim.set(A, true));
    assert.strictEqual(anim.describe().failed, 1, 'a falha é contada, não engolida');
  });
});
