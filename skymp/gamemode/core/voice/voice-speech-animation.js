/**
 * core/voice/voice-speech-animation.js
 *
 * Primeira animação de fala. **Simples de propósito, e desligada por padrão.**
 *
 * ## O que é, e o que explicitamente não é
 *
 * É um gatilho binário: começou a falar → um evento de animação; parou → outro.
 * **Não é lipsync fonético**, e a instrução da etapa dizia para não tentar
 * ainda. Lipsync exigiria fonemas, e fonema exige abrir o áudio — o servidor
 * não abre, e o cliente que abriria não tem como mexer no esqueleto de outro
 * jogador sem código de client que este projeto não distribui.
 *
 * ## Por que nasce DESLIGADA
 *
 * `Debug.SendAnimationEvent` existe — é uma das oito funções REQUIRED da
 * [política de Papyrus](../../../docs/technical/PAPYRUS_USAGE_POLICY.md) §3, já
 * usada pelo projeto. O que **não** existe é prova de que os nomes de evento
 * abaixo façam alguma coisa: eles não foram conferidos contra o behavior graph
 * do Skyrim, e um evento desconhecido é ignorado em silêncio pelo grafo.
 *
 * Ligar isto por padrão colocaria uma chamada Papyrus por transição de fala em
 * todo servidor, para talvez não produzir movimento nenhum — e o custo de uma
 * chamada Papyrus que de fato executa **nunca foi medido** neste projeto (§7
 * daquela política registra que a única medição existente é de uma função
 * inexistente e é suspeita).
 *
 * Então: `VOICE_SPEECH_ANIMATION=true` liga, os nomes de evento são
 * configuráveis, e o §11 do documento da etapa tem o passo de bancada que
 * transforma "provavelmente" em "vi mexer".
 *
 * ## O que ela garante mesmo desligada
 *
 * O contrato de PARAR. `stop()` é chamado nas cinco situações da etapa (PTT
 * solto, mute, disconnect, falha, incapacidade de falar) porque ele é assinante
 * do `VoiceSpeakingState`, e é *aquele* módulo que tem as cinco garantias. Uma
 * animação que só sabe começar é como um microfone que só sabe abrir.
 */

const { actorRef } = require('../papyrus');

/** Evento enviado ao começar a falar. Não verificado em jogo. */
const DEFAULT_START_EVENT = 'IdleSpeakOpen';
/** Evento enviado ao parar. Não verificado em jogo. */
const DEFAULT_STOP_EVENT = 'IdleSpeakClose';

/**
 * Piso entre dois envios para o MESMO ator.
 *
 * PTT tamborilado (apertar e soltar rápido) produziria um par de chamadas
 * Papyrus por toque. O piso não perde a última transição — ela é reenviada
 * quando a janela passa — e limita o custo por jogador por construção, que é o
 * mesmo princípio do piso de `markCritical`.
 */
const DEFAULT_MIN_INTERVAL_MS = 250;

/**
 * @param {object} [deps]
 * @param {boolean} [deps.enabled] padrão: `VOICE_SPEECH_ANIMATION === 'true'`
 * @param {any} [deps.mp] injetável; senão resolve o global a cada chamada
 * @param {string} [deps.startEvent]
 * @param {string} [deps.stopEvent]
 * @param {number} [deps.minIntervalMs]
 * @param {() => number} [deps.now]
 * @param {(fn: () => void, ms: number) => any} [deps.defer]
 * @param {Pick<Console,'log'|'warn'|'error'>} [deps.logger]
 */
function createVoiceSpeechAnimation(deps = {}) {
  const {
    enabled = process.env.VOICE_SPEECH_ANIMATION === 'true',
    mp: injectedMp = null,
    startEvent = process.env.VOICE_SPEECH_ANIM_START || DEFAULT_START_EVENT,
    stopEvent = process.env.VOICE_SPEECH_ANIM_STOP || DEFAULT_STOP_EVENT,
    minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
    now = () => Date.now(),
    defer = (fn, ms) => {
      const timer = setTimeout(fn, ms);
      if (typeof timer.unref === 'function') timer.unref();
      return timer;
    },
    logger = console
  } = deps;

  /** @type {Map<number, {sentAt: number, sentState: boolean|null, pending: boolean|null, scheduled: boolean}>} */
  const actors = new Map();
  let sent = 0;
  let coalesced = 0;
  let failed = 0;

  /** Mesma razão de `voice-core.world()`: o global chega depois da carga. */
  function world() {
    if (injectedMp) return injectedMp;
    return typeof mp !== 'undefined' && mp ? mp : null;
  }

  function entryFor(actorId) {
    let entry = actors.get(actorId);
    if (!entry) {
      // `-Infinity` e não `0`: o piso de intervalo existe para limitar TROCAS,
      // e a primeira fala de alguém não é uma troca. Com `0`, `now() - sentAt`
      // dependeria da época do relógio — num relógio de teste que começa em
      // 1000 ms, a primeira animação de todo mundo sairia adiada.
      entry = { sentAt: -Infinity, sentState: null, pending: null, scheduled: false };
      actors.set(actorId, entry);
    }
    return entry;
  }

  function dispatch(actorId, speaking) {
    const skymp = world();
    if (!skymp) return false;
    try {
      // `actorRef` recebe o `mp` que este módulo resolveu, e não lê o global:
      // aqui o `mp` pode ser o injetado (teste, boot cedo), e um `actorRef` que
      // fosse ao global levantaria `getDescFromId of undefined` exatamente onde
      // o resto do módulo já sabe com quem falar.
      skymp.callPapyrusFunction('global', 'Debug', 'SendAnimationEvent', null, [
        actorRef(actorId, skymp),
        speaking ? startEvent : stopEvent
      ]);
      sent++;
      return true;
    } catch (err) {
      // Uma animação que falha não pode derrubar o laço de voz. Ela é o
      // enfeite; a voz é o produto.
      failed++;
      logger.error(`[voice-anim] Falha ao enviar animação de fala: ${err.message}`);
      return false;
    }
  }

  function flush(actorId) {
    const entry = actors.get(actorId);
    if (!entry) return;
    entry.scheduled = false;
    if (entry.pending === null) return;
    const desired = entry.pending;
    entry.pending = null;
    if (entry.sentState === desired) return;
    entry.sentState = desired;
    entry.sentAt = now();
    dispatch(actorId, desired);
  }

  /**
   * O ator começou ou parou de falar.
   *
   * @param {number} actorId
   * @param {boolean} speaking
   */
  function set(actorId, speaking) {
    if (!enabled) return { ok: false, reason: 'desligado' };

    const entry = entryFor(actorId);
    if (entry.sentState === speaking && entry.pending === null) {
      return { ok: true, changed: false };
    }

    entry.pending = speaking;
    const since = now() - entry.sentAt;
    if (since >= minIntervalMs) {
      flush(actorId);
      return { ok: true, changed: true, deferred: false };
    }

    if (!entry.scheduled) {
      entry.scheduled = true;
      defer(() => flush(actorId), minIntervalMs - since);
    } else {
      coalesced++;
    }
    return { ok: true, changed: true, deferred: true };
  }

  /**
   * Para a animação AGORA, sem piso de intervalo.
   *
   * O piso protege o servidor de uma sequência de trocas; um `stop` atrasado
   * protegeria o servidor à custa de deixar a boca aberta de alguém que
   * desconectou. Entre os dois, parar ganha sempre — o custo de uma chamada a
   * mais é menor que o de um personagem falando sozinho no meio da taverna.
   *
   * @param {number} actorId
   */
  function stop(actorId) {
    const entry = actors.get(actorId);
    if (!enabled) {
      if (entry) actors.delete(actorId);
      return { ok: false, reason: 'desligado' };
    }
    const wasSpeaking = entry ? entry.sentState === true : false;
    if (entry) {
      entry.pending = null;
      entry.sentState = false;
      entry.sentAt = now();
    }
    if (wasSpeaking) dispatch(actorId, false);
    return { ok: true, changed: wasSpeaking };
  }

  /** Desconexão: para e esquece. */
  function forget(actorId) {
    const result = stop(actorId);
    actors.delete(actorId);
    return result;
  }

  function clearAll() {
    for (const actorId of [...actors.keys()]) forget(actorId);
  }

  /**
   * Liga no `VoiceSpeakingState`. É por aqui que as cinco garantias de parada
   * chegam — nenhuma delas é implementada aqui de novo.
   * @param {{onChange: Function}} speakingState
   */
  function bind(speakingState) {
    return speakingState.onChange((actorId, speaking) => {
      if (speaking) set(actorId, true);
      else stop(actorId);
    });
  }

  function describe() {
    return { enabled, startEvent, stopEvent, minIntervalMs, tracked: actors.size, sent, coalesced, failed };
  }

  return { set, stop, forget, clearAll, bind, describe, enabled };
}

module.exports = {
  createVoiceSpeechAnimation,
  DEFAULT_START_EVENT,
  DEFAULT_STOP_EVENT,
  DEFAULT_MIN_INTERVAL_MS
};
