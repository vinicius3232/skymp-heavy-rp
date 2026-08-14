/**
 * core/voice/voice-speaking-state.js
 *
 * `VoiceSpeakingState` — quem está falando **agora**, e quão alto.
 *
 * ## Por que não basta olhar o PTT
 *
 * `state.transmitting` diz que a pessoa tem **permissão** para falar. Não diz
 * que ela está falando: segurar a tecla e ficar calado é o caso comum de quem
 * está prestes a dizer algo. Uma animação de boca ligada no PTT abriria a boca
 * do personagem por meio segundo antes de sair som, todas as vezes.
 *
 * Então "falando" é a conjunção de duas coisas:
 *
 *   1. o servidor **permite** (`canSpeak`) — e isso é autoritativo;
 *   2. quadros de áudio **chegaram** há pouco (`noteFrame`) — e isso é
 *      observação, não confiança: o quadro já foi contado, medido e limitado
 *      por taxa antes de chegar aqui.
 *
 * O servidor não decodifica o quadro (`voip-service` §relayAudioFrame é
 * explícito sobre isso), então **`audioLevel` do lado do servidor é `null`** e
 * está declarado como tal. Quem consegue medi-lo é o cliente, que já tem a
 * amostra tocando num `AnalyserNode`. Prometer um número aqui exigiria abrir o
 * PCM a 50 Hz por locutor para produzir um valor que o cliente já tem de graça.
 *
 * ## A garantia que este módulo existe para dar
 *
 * A etapa pediu que a animação PARE em cinco situações. Todas terminam na mesma
 * função — `clear(actorId)` — e nenhuma depende de o cliente avisar:
 *
 * | Situação | Quem chama |
 * |---|---|
 * | soltar o PTT | `voice-core.pttUp` |
 * | mute | `voice-core.requestMute` |
 * | disconnect / logout | `voice-core.detach` |
 * | falha de voz (conexão cai) | `voice-core.detach` / `shutdown` |
 * | incapacidade de falar (morte, mordaça, staff) | `sweep()`, que reconsulta a política |
 *
 * A quinta é a que não podia ser um evento: ninguém emite "você morreu, pare de
 * falar" para o sistema de voz. `sweep()` roda a cada tick e é o que garante
 * que a boca fecha quando a pessoa morre no meio de uma frase.
 */

/** Sem quadro há mais que isto, a pessoa parou de falar. */
const DEFAULT_SILENCE_MS = 220;

/**
 * @param {object} deps
 * @param {{canSpeak: (actorId: number) => {ok: boolean, reason?: string}}} deps.policy
 * @param {() => number} [deps.now]
 * @param {number} [deps.silenceMs]
 */
function createVoiceSpeakingState(deps) {
  const { policy, now = () => Date.now(), silenceMs = DEFAULT_SILENCE_MS } = deps || {};
  if (!policy || typeof policy.canSpeak !== 'function') {
    throw new Error('[voice-speaking-state] VoicePolicyEngine ausente');
  }

  /** @type {Map<number, {speaking: boolean, lastFrameAt: number, audioLevel: number|null}>} */
  const actors = new Map();

  /** @type {((actorId: number, speaking: boolean, audioLevel: number|null) => void)[]} */
  const subscribers = [];

  function entryFor(actorId) {
    let entry = actors.get(actorId);
    if (!entry) {
      entry = { speaking: false, lastFrameAt: 0, audioLevel: null };
      actors.set(actorId, entry);
    }
    return entry;
  }

  function emit(actorId, speaking, audioLevel) {
    for (const cb of subscribers) {
      try {
        cb(actorId, speaking, audioLevel);
      } catch {
        // Um assinante que lança não pode travar a boca de todo mundo. O
        // consumidor real disto é uma animação; perder um evento dela é menos
        // grave do que o laço de voz morrer por causa dela.
      }
    }
  }

  /**
   * Um quadro de áudio deste ator chegou.
   *
   * `level` é opcional e hoje **ninguém o envia**: nem o `voice-helper`, nem a
   * UI. O parâmetro existe para que o dia em que o helper aprender a mandar RMS
   * no cabeçalho não exija mudar assinatura em três arquivos.
   *
   * @param {number} actorId
   * @param {number} [level] 0..1
   */
  function noteFrame(actorId, level) {
    // A permissão é reconsultada AQUI, e não só no sweep. Entre um tick e o
    // outro cabem sete quadros; sem esta linha, quem foi silenciado pela staff
    // continuaria com a boca se mexendo por até um tick depois de calado.
    if (!policy.canSpeak(actorId).ok) {
      clear(actorId);
      return false;
    }

    const entry = entryFor(actorId);
    entry.lastFrameAt = now();
    if (Number.isFinite(level)) entry.audioLevel = Math.max(0, Math.min(1, /** @type {number} */(level)));

    if (!entry.speaking) {
      entry.speaking = true;
      emit(actorId, true, entry.audioLevel);
    }
    return true;
  }

  /**
   * Para de considerar este ator falando. Idempotente de propósito: PTT up,
   * mute e disconnect podem chegar em qualquer ordem, e cada um chamando isto é
   * mais barato do que cada um checando antes.
   *
   * @param {number} actorId
   */
  function clear(actorId) {
    const entry = actors.get(actorId);
    if (!entry) return false;
    const wasSpeaking = entry.speaking;
    entry.speaking = false;
    entry.lastFrameAt = 0;
    entry.audioLevel = null;
    if (wasSpeaking) emit(actorId, false, null);
    return wasSpeaking;
  }

  /** Tira o ator do mapa por completo. Usado no detach. */
  function forget(actorId) {
    const stopped = clear(actorId);
    actors.delete(actorId);
    return stopped;
  }

  /**
   * Passa por todo mundo e derruba quem parou de falar ou perdeu o direito.
   *
   * Chamado por tick. É o que fecha a boca de quem morreu no meio da frase —
   * a única das cinco garantias que não tem um evento para pendurar.
   *
   * @returns {number} quantos pararam neste sweep
   */
  function sweep() {
    const t = now();
    let stopped = 0;
    for (const [actorId, entry] of actors) {
      if (!entry.speaking) continue;
      if (t - entry.lastFrameAt > silenceMs || !policy.canSpeak(actorId).ok) {
        if (clear(actorId)) stopped++;
      }
    }
    return stopped;
  }

  /** @param {number} actorId */
  function isSpeaking(actorId) {
    const entry = actors.get(actorId);
    return !!(entry && entry.speaking);
  }

  /**
   * Nível de áudio conhecido pelo servidor. **`null` hoje, sempre**, e isso é
   * um fato do desenho, não um TODO: o servidor não abre o PCM.
   * @param {number} actorId
   */
  function audioLevel(actorId) {
    const entry = actors.get(actorId);
    return entry ? entry.audioLevel : null;
  }

  /** @param {(actorId: number, speaking: boolean, audioLevel: number|null) => void} cb */
  function onChange(cb) {
    subscribers.push(cb);
    return () => {
      const i = subscribers.indexOf(cb);
      if (i >= 0) subscribers.splice(i, 1);
    };
  }

  /** Quem está falando agora. Para HUD, diagnóstico e teste. */
  function speakers() {
    const list = [];
    for (const [actorId, entry] of actors) {
      if (entry.speaking) list.push({ actorId, audioLevel: entry.audioLevel });
    }
    return list;
  }

  function clearAll() {
    for (const actorId of [...actors.keys()]) clear(actorId);
    actors.clear();
  }

  function describe() {
    return { tracked: actors.size, speaking: speakers().length, silenceMs };
  }

  return {
    noteFrame, clear, forget, sweep, isSpeaking, audioLevel,
    onChange, speakers, clearAll, describe
  };
}

module.exports = { createVoiceSpeakingState, DEFAULT_SILENCE_MS };
