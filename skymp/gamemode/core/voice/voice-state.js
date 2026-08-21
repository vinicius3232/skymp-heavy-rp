/**
 * core/voice/voice-state.js
 *
 * VoiceStateService — o estado de voz de cada ator, e **quem tem o direito de
 * mudá-lo**.
 *
 * ## A regra que este arquivo existe para tornar impossível de quebrar
 *
 * O cliente nunca determina `actorId`, `characterId`, posição, célula,
 * `voiceMode` nem permissão. Ele **pede**; o servidor decide. Isso é fácil de
 * escrever num comentário e fácil de furar na prática — o furo típico é um
 * `entry.voiceMode = msg.mode` no meio de um `switch` de mensagem, que foi
 * exatamente o que o `voip-service.js` fazia:
 *
 * ```js
 * case 'voice_mode':
 *   voipClients.get(clientActorId).voiceMode = msg.mode || 'normal';
 * ```
 *
 * `msg.mode` é uma string arbitrária vinda do socket. `'radio'`, `'global'`,
 * `'__proto__'` — qualquer uma passava. Não virava alcance infinito por sorte:
 * `VOICE_RANGES[modo]` daria `undefined` e `calcVolume` devolveria `NaN`, que
 * não é `> 0`, então a pessoa simplesmente ficava inaudível. Um cliente
 * conseguia se calar de um jeito que a UI dela não mostrava, e ninguém
 * descobriria por log nenhum.
 *
 * Aqui `setVoiceMode` valida contra `VOICE_RANGES` e **recusa** o que não
 * conhece, devolvendo o motivo. O estado nunca chega a um valor que o resto do
 * sistema não saiba interpretar.
 *
 * ## Por ATOR, nunca por conexão
 *
 * `muted` e `voiceMode` são da pessoa na cena, não do cabo. É a lição mais cara
 * já registrada neste projeto (`VOICE_NATIVE_HELPER.md` §10): com `muted` na
 * conexão, mutar pela UI deixava o helper transmitindo — a pessoa se via mutada
 * e continuava sendo ouvida. Este módulo indexa por `actorId` e não tem sequer
 * um campo de socket, para que o erro não seja representável.
 *
 * ## PTT é estado do servidor, não do microfone
 *
 * `transmitting` só é ligado por `VoicePolicyEngine.pttDown`, que valida antes.
 * Mute local no cliente é conforto; o que decide se a voz sai é este booleano,
 * do lado que já sabe quem você é. Ver `voice-policy.js`.
 */

const { VOICE_RANGES } = require('../proximity-ranges');

/**
 * Modos de voz válidos, **derivados** da tabela de raios.
 *
 * Derivar em vez de escrever uma segunda lista é o ponto: `proximity-ranges.js`
 * é a fonte única de whisper/normal/shout, e uma constante `['whisper',
 * 'normal', 'shout']` aqui seria uma segunda fonte — o mesmo defeito que aquele
 * arquivo nasceu para corrigir, só que na chave em vez de no valor.
 */
const VOICE_MODES = Object.freeze(Object.keys(VOICE_RANGES));

const DEFAULT_VOICE_MODE = 'normal';

/**
 * Estados de conexão de voz de um ator.
 *
 * `DISABLED` não é falha: é o estado de quem não pediu voz (a voz é opt-in por
 * `/voz`) e o de todo mundo quando o transporte está desligado. Distinguir
 * `DISABLED` de `FAILED` é o que permite um servidor sem LiveKit configurado
 * não parecer um servidor com LiveKit quebrado.
 */
const CONNECTION_STATES = Object.freeze({
  DISABLED: 'DISABLED',
  CONNECTING: 'CONNECTING',
  CONNECTED: 'CONNECTED',
  RECONNECTING: 'RECONNECTING',
  FAILED: 'FAILED'
});

/**
 * @typedef {object} VoiceActorState
 * @property {number} actorId
 * @property {number|null} characterId  resolvido pelo servidor, nunca enviado pelo cliente
 * @property {string} voiceMode
 * @property {boolean} muted
 * @property {boolean} transmitting     PTT concedido pelo servidor
 * @property {string} connection        um de CONNECTION_STATES
 * @property {number} updatedAt
 */

/**
 * @param {object} [deps]
 * @param {() => number} [deps.now]
 */
function createVoiceStateService(deps = {}) {
  const { now = () => Date.now() } = deps;

  /** @type {Map<number, VoiceActorState>} */
  const actors = new Map();

  /**
   * Cria (ou devolve) o estado de um ator.
   *
   * `characterId` é parâmetro de servidor: quem chama é o serviço de voz depois
   * de resolver o personagem ativo em `commands.getActiveCharacterData`. Não há
   * caminho por onde um cliente informe o seu.
   *
   * @param {number} actorId
   * @param {{characterId?: number|null}} [opts]
   * @returns {VoiceActorState}
   */
  function ensure(actorId, opts = {}) {
    let state = actors.get(actorId);
    if (!state) {
      state = {
        actorId,
        characterId: opts.characterId ?? null,
        voiceMode: DEFAULT_VOICE_MODE,
        muted: false,
        transmitting: false,
        connection: CONNECTION_STATES.DISABLED,
        updatedAt: now()
      };
      actors.set(actorId, state);
    } else if (opts.characterId !== undefined && opts.characterId !== null) {
      state.characterId = opts.characterId;
    }
    return state;
  }

  /** @param {number} actorId @returns {VoiceActorState|null} */
  function get(actorId) {
    return actors.get(actorId) || null;
  }

  function has(actorId) {
    return actors.has(actorId);
  }

  /** @returns {number[]} */
  function actorIds() {
    return [...actors.keys()];
  }

  /** @returns {VoiceActorState[]} */
  function all() {
    return [...actors.values()];
  }

  function size() {
    return actors.size;
  }

  /**
   * Troca o modo de voz.
   *
   * Recusa qualquer coisa fora de `VOICE_MODES` **sem tocar no estado**. O
   * estado anterior sobreviver a um pedido inválido importa: se um cliente
   * mandar lixo, a pessoa continua sendo ouvida como estava, em vez de cair
   * num modo neutro que ela não escolheu.
   *
   * @param {number} actorId
   * @param {unknown} mode
   * @returns {{ok: boolean, changed: boolean, mode: string, reason?: string}}
   */
  function setVoiceMode(actorId, mode) {
    const state = actors.get(actorId);
    if (!state) return { ok: false, changed: false, mode: DEFAULT_VOICE_MODE, reason: 'ator sem estado de voz' };
    if (typeof mode !== 'string' || !VOICE_MODES.includes(mode)) {
      return { ok: false, changed: false, mode: state.voiceMode, reason: `modo de voz desconhecido: ${JSON.stringify(mode)}` };
    }
    const changed = state.voiceMode !== mode;
    state.voiceMode = mode;
    if (changed) state.updatedAt = now();
    return { ok: true, changed, mode };
  }

  /**
   * Muta/desmuta o ator.
   *
   * Mutar **derruba o PTT junto**. Sem isso, alguém que apertou a tecla e mutou
   * em seguida ficaria com `transmitting: true` guardado, e o próximo
   * desmute devolveria a transmissão sem a pessoa ter apertado nada — voz na
   * cena sem gesto de quem fala é o pior defeito possível num microfone.
   *
   * @param {number} actorId
   * @param {boolean} muted
   * @returns {{ok: boolean, changed: boolean, muted: boolean}}
   */
  function setMuted(actorId, muted) {
    const state = actors.get(actorId);
    if (!state) return { ok: false, changed: false, muted: false };
    const value = muted === true;
    const changed = state.muted !== value;
    state.muted = value;
    if (value) state.transmitting = false;
    if (changed) state.updatedAt = now();
    return { ok: true, changed, muted: value };
  }

  /**
   * Liga/desliga a transmissão (PTT). **Uso interno do VoicePolicyEngine.**
   *
   * Está exposto porque o estado mora aqui, não porque qualquer um deva chamar:
   * quem valida se a pessoa *pode* transmitir é a policy, e chamar isto direto
   * pula a validação. O serviço de voz fala com a policy.
   *
   * @param {number} actorId
   * @param {boolean} transmitting
   * @returns {{ok: boolean, changed: boolean, transmitting: boolean}}
   */
  function setTransmitting(actorId, transmitting) {
    const state = actors.get(actorId);
    if (!state) return { ok: false, changed: false, transmitting: false };
    const value = transmitting === true;
    const changed = state.transmitting !== value;
    state.transmitting = value;
    if (changed) state.updatedAt = now();
    return { ok: true, changed, transmitting: value };
  }

  /**
   * @param {number} actorId
   * @param {string} connection um de CONNECTION_STATES
   * @returns {{ok: boolean, changed: boolean, connection: string}}
   */
  function setConnectionState(actorId, connection) {
    const state = actors.get(actorId);
    if (!state) return { ok: false, changed: false, connection: CONNECTION_STATES.DISABLED };
    if (!Object.prototype.hasOwnProperty.call(CONNECTION_STATES, connection)) {
      return { ok: false, changed: false, connection: state.connection };
    }
    const changed = state.connection !== connection;
    state.connection = connection;
    // Perder a conexão derruba a transmissão. Um `transmitting` que sobrevive
    // à queda volta ligado na reconexão, e a pessoa passa a falar sem ter
    // apertado nada depois de voltar.
    if (connection !== CONNECTION_STATES.CONNECTED) state.transmitting = false;
    if (changed) state.updatedAt = now();
    return { ok: true, changed, connection };
  }

  /**
   * Vincula o personagem ativo ao ator. Sempre server-side.
   * @param {number} actorId
   * @param {number|null} characterId
   */
  function bindCharacter(actorId, characterId) {
    const state = actors.get(actorId);
    if (!state) return { ok: false };
    state.characterId = Number.isFinite(characterId) ? characterId : null;
    state.updatedAt = now();
    return { ok: true, characterId: state.characterId };
  }

  /**
   * Remove o ator do estado de voz. Idempotente de propósito: logout,
   * desconexão do socket e cleanup podem chegar em qualquer ordem, e cada um
   * chamando isto é mais barato do que cada um checando antes.
   * @param {number} actorId
   * @returns {boolean} havia estado a remover
   */
  function remove(actorId) {
    return actors.delete(actorId);
  }

  function clear() {
    actors.clear();
  }

  return {
    ensure, get, has, actorIds, all, size,
    setVoiceMode, setMuted, setTransmitting, setConnectionState,
    bindCharacter, remove, clear
  };
}

module.exports = {
  createVoiceStateService,
  VOICE_MODES,
  DEFAULT_VOICE_MODE,
  CONNECTION_STATES
};
