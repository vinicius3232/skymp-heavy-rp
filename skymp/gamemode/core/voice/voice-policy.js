/**
 * core/voice/voice-policy.js
 *
 * VoicePolicyEngine — as perguntas de permissão da voz, num lugar só.
 *
 * ## As três perguntas
 *
 *   - `canSpeak(actorId)`      — esta pessoa pode transmitir agora?
 *   - `canHear(a, b, ctx)`     — este ouvinte recebe este locutor, e a que volume?
 *   - `pttDown/pttUp`          — o gesto do jogador vira (ou não) transmissão.
 *
 * Tudo o mais no Voice Core consulta estas três. O motivo de estarem juntas é
 * que elas compartilham o estado que decide (`VoiceStateService`) e a tabela que
 * mede (`core/proximity-ranges.js`), e separá-las daria a cada chamador a
 * chance de responder por conta própria — que é como um servidor autoritativo
 * vira um servidor que concorda com o cliente na maioria das vezes.
 *
 * ## PTT é a segurança, mute local é conforto
 *
 * O fluxo é o pedido, não a ordem:
 *
 * ```
 * PTT DOWN (cliente)  →  canSpeak()  →  transmitting = true   → rota permite publicar
 * PTT UP   (cliente)  →               transmitting = false    → rota corta
 * ```
 *
 * O `false` do meio é o que importa: enquanto `transmitting` for `false`, o
 * `VoiceRouteEngine` não coloca aquele locutor na audiência de ninguém, e o
 * relay não repassa quadro nenhum dele. Um cliente modificado que ignore o
 * PTT e publique assim mesmo continua sem audiência — não porque a UI dele se
 * comporte, mas porque o lado que decide quem ouve quem é este.
 *
 * É a diferença entre "o microfone do jogador está mudo" (decisão do cliente,
 * verificável por ninguém) e "o servidor não entrega a voz dele a ninguém"
 * (decisão do servidor, verificável por teste). Só a segunda é regra de jogo.
 *
 * ## Onde os raios moram
 *
 * Em `core/proximity-ranges.js`, e só lá. Este arquivo **lê** `VOICE_RANGES` e
 * não define número nenhum de alcance. Foi o que fez o sussurro escrito e o
 * sussurro falado voltarem a alcançar as mesmas pessoas, e uma tabela local
 * aqui — ainda que idêntica hoje — reabriria a divergência no dia em que
 * alguém ajustasse `server-options`.
 */

const { VOICE_RANGES } = require('../proximity-ranges');
const { CONNECTION_STATES, VOICE_MODES, DEFAULT_VOICE_MODE } = require('./voice-state');
const { nullMetrics } = require('./voice-metrics');

/**
 * Volume a partir da distância e do alcance. Queda linear, corte em `maxRange`.
 *
 * Esta é a **mesma conta** que o `voip-service.calcVolume` fazia, movida sem
 * uma vírgula de mudança de comportamento: um teste de caracterização trava os
 * dois contra os mesmos pares de entrada.
 *
 * Nota de leitura: o comentário original prometia "mínimo de 0.05 para quem
 * está muito perto" e o código nunca fez isso — `1 - d/r` tende a 1 quando a
 * distância tende a zero, e o `Math.max(0, ...)` só protege o outro extremo. A
 * promessa não foi implementada agora: implementá-la mudaria o áudio de todo
 * mundo, e mudar comportamento enquanto se move código é como uma regressão
 * fica indistinguível de uma refatoração. O comentário é que estava errado.
 *
 * @param {number} distance
 * @param {number} maxRange
 * @returns {number} 0..1
 */
function volumeAt(distance, maxRange) {
  if (!Number.isFinite(distance) || !Number.isFinite(maxRange) || maxRange <= 0) return 0;
  if (distance >= maxRange) return 0;
  return Math.max(0, Math.min(1, 1 - (distance / maxRange)));
}

/**
 * Duas posições estão no mesmo espaço audível?
 *
 * A regra tem três casos e o terceiro é o que se erra:
 *
 *   - ambos conhecidos e iguais    → mesmo lugar
 *   - ambos conhecidos e diferentes→ lugares diferentes, **por mais perto que
 *     os números fiquem**. Cada interior do Skyrim tem origem de coordenada
 *     própria: duas tavernas distintas têm coordenadas na mesma vizinhança
 *     numérica, e sem esta linha a voz atravessa a parede entre elas.
 *   - um dos dois desconhecido     → **não separa**. Falta de informação não é
 *     prova de estarem em lugares diferentes, e tratá-la como prova calaria
 *     alguém por causa de uma leitura que falhou.
 *
 * Mesma regra de `core/range-utils.distanceBetween` (`ca && cb && ca !== cb →
 * Infinity`) e do `nametag-service`. Ela não é reimplementada aqui por
 * conveniência: `range-utils` decide a partir de dois `actorId` lendo o `mp`, e
 * o Voice Core precisa decidir a partir de duas amostras que ele já leu — ler
 * de novo por par seria O(n²) de ida ao `mp`, que é justamente o custo que esta
 * etapa existe para remover. O que se compartilha é `getCell`, que é onde mora
 * o conhecimento sobre *quais campos* nomeiam uma célula.
 *
 * @param {string|null|undefined} a
 * @param {string|null|undefined} b
 */
function sameSpace(a, b) {
  if (!a || !b) return true;
  return a === b;
}

/**
 * @param {object} deps
 * @param {ReturnType<typeof import('./voice-state').createVoiceStateService>} deps.state
 * @param {Record<string, number>} [deps.ranges]  padrão: VOICE_RANGES
 * @param {ReturnType<typeof import('./voice-metrics').createVoiceMetrics>} [deps.metrics]
 * @param {boolean} [deps.pttRequired] padrão: true — PTT é o padrão do servidor
 */
function createVoicePolicyEngine(deps) {
  const {
    state,
    ranges = VOICE_RANGES,
    metrics = nullMetrics(),
    pttRequired = true
  } = deps || {};

  if (!state || typeof state.get !== 'function') {
    throw new Error('[voice-policy] VoiceStateService ausente');
  }

  /**
   * Alcance de um modo. Modo desconhecido cai em `normal` — nunca em
   * `undefined`, que viraria `NaN` no volume e silêncio inexplicável.
   * @param {string} mode
   */
  function rangeFor(mode) {
    const range = ranges[mode];
    return Number.isFinite(range) ? range : ranges[DEFAULT_VOICE_MODE];
  }

  /** Maior alcance possível — o raio de busca no índice espacial. */
  function maxRange() {
    return Math.max(...VOICE_MODES.map((m) => rangeFor(m)));
  }

  /**
   * Esta pessoa pode transmitir voz agora?
   *
   * Ordem das recusas escolhida para o diagnóstico: da mais estrutural
   * (não existe sessão) para a mais volátil (não apertou a tecla). Quem lê um
   * log de recusa quer saber a causa raiz, e a primeira recusa é a que aparece.
   *
   * @param {number} actorId
   * @returns {{ok: boolean, reason?: string}}
   */
  function canSpeak(actorId) {
    const s = state.get(actorId);
    if (!s) return { ok: false, reason: 'sem sessão de voz' };
    if (s.characterId === null) return { ok: false, reason: 'personagem não carregado' };
    if (s.connection !== CONNECTION_STATES.CONNECTED) {
      return { ok: false, reason: `conexão em ${s.connection}` };
    }
    if (s.muted) return { ok: false, reason: 'mutado' };
    if (pttRequired && !s.transmitting) return { ok: false, reason: 'PTT solto' };
    return { ok: true };
  }

  /**
   * Esta pessoa está em condição de receber voz?
   *
   * Separado de `canSpeak` porque as condições são diferentes: quem ouve não
   * precisa de PTT nem deixa de ouvir por estar mutado — mute silencia a
   * própria voz na cena, não os outros. O que se exige do ouvinte é apenas que
   * ele tenha uma sessão viva para onde mandar áudio.
   *
   * @param {number} actorId
   * @returns {{ok: boolean, reason?: string}}
   */
  function canListen(actorId) {
    const s = state.get(actorId);
    if (!s) return { ok: false, reason: 'sem sessão de voz' };
    if (s.connection !== CONNECTION_STATES.CONNECTED) {
      return { ok: false, reason: `conexão em ${s.connection}` };
    }
    return { ok: true };
  }

  /**
   * Este ouvinte recebe este locutor, e a que volume?
   *
   * Recebe as amostras já lidas pelo servidor (`{space, pos}`), nunca `actorId`
   * cru: quem lê posição é o `VoiceCore`, uma vez por ator por tick. Aceitar
   * `actorId` aqui convidaria cada chamador a ler de novo.
   *
   * @param {{actorId: number, space: string|null, pos: number[]}} listener
   * @param {{actorId: number, space: string|null, pos: number[]}} speaker
   * @returns {{ok: boolean, volume: number, distance: number, reason?: string}}
   */
  function canHear(listener, speaker) {
    if (!listener || !speaker) return { ok: false, volume: 0, distance: Infinity, reason: 'amostra ausente' };
    if (listener.actorId === speaker.actorId) {
      // Ouvir a própria voz de volta é eco, não voz.
      return { ok: false, volume: 0, distance: 0, reason: 'mesmo ator' };
    }

    // O veredito sai do MESMO código que o recompute usa. O que segue depois
    // dele só reconstrói o motivo, e só quando a resposta é não.
    const probe = audienceProbe(speaker);
    if (probe) {
      const volume = probe(listener);
      if (volume > 0) return { ok: true, volume, distance: probe.distance };
    }

    // Caminho frio: descobrir por quê. A ordem vai da recusa mais estrutural
    // para a mais volátil, porque quem lê um log quer a causa raiz.
    const listening = canListen(listener.actorId);
    if (!listening.ok) return { ok: false, volume: 0, distance: Infinity, reason: listening.reason };

    const speaking = canSpeak(speaker.actorId);
    if (!speaking.ok) return { ok: false, volume: 0, distance: Infinity, reason: speaking.reason };

    if (!sameSpace(listener.space, speaker.space)) {
      return { ok: false, volume: 0, distance: Infinity, reason: 'célula/worldspace incompatível' };
    }

    const distance = distance3D(listener.pos, speaker.pos);
    if (!Number.isFinite(distance)) {
      return { ok: false, volume: 0, distance: Infinity, reason: 'posição inválida' };
    }

    return { ok: false, volume: 0, distance, reason: 'fora de alcance' };
  }

  /**
   * A mesma regra de `canHear`, preparada para um locutor e sem alocar.
   *
   * ## Por que existe uma segunda porta para a mesma regra
   *
   * `canHear` responde por par e devolve motivo — é a forma legível, e é a que
   * os testes usam. No recompute ela é chamada uma vez por par candidato, e
   * numa taverna cheia isso é dezenas de milhares de vezes a cada 150 ms. Nessa
   * escala o que ela faz **além** da regra passa a dominar: três `Map.get` por
   * par (locutor, ouvinte, locutor de novo para o modo), um objeto de resultado
   * alocado por par, e uma raiz quadrada mesmo quando a resposta é "longe
   * demais".
   *
   * O bench mediu o efeito: com `canHear` no laço, o índice espacial ficava
   * **mais lento que o laço O(n²)** que ele substitui na topologia densa. O
   * trabalho útil era idêntico; a diferença era tudo isto.
   *
   * Esta função tira do laço o que não muda dentro dele — estado do locutor,
   * alcance, posição, espaço — e devolve um teste que faz um `Map.get` por par,
   * não aloca, e compara **distância ao quadrado** contra **alcance ao
   * quadrado**, pulando a raiz para quem está fora.
   *
   * ## E a duplicação da regra?
   *
   * Não há: `canHear` é implementada **sobre** esta função. Ela chama o probe
   * para decidir e só reconstrói o motivo no caminho de recusa, que é frio. Uma
   * regra, duas superfícies.
   *
   * @param {{actorId: number, space: string|null, pos: number[]}} speaker
   * @returns {((listener: {actorId: number, space: string|null, pos: number[]}) => number) & {distance: number, range: number} | null}
   *   `null` se o locutor não pode falar; senão, uma função que devolve o
   *   volume (0 = não ouve) e publica a distância medida em `.distance`.
   */
  function audienceProbe(speaker) {
    if (!speaker || !Array.isArray(speaker.pos)) return null;
    if (!canSpeak(speaker.actorId).ok) return null;

    const speakerState = state.get(speaker.actorId);
    const range = rangeFor(speakerState ? speakerState.voiceMode : DEFAULT_VOICE_MODE);
    const rangeSquared = range * range;
    const space = speaker.space;
    const [sx, sy, sz] = speaker.pos;
    const speakerId = speaker.actorId;

    /**
     * A distância do último par avaliado.
     *
     * Campo mutável num closure, e não um segundo valor de retorno, porque um
     * `{volume, distance}` por par é exatamente a alocação que esta função
     * existe para não fazer. É seguro pelo mesmo motivo que o resto do gamemode
     * é: Node é uma thread só, e quem lê `.distance` lê imediatamente depois da
     * chamada, dentro do mesmo laço síncrono.
     */
    const probe = /** @type {any} */ ((listener) => {
      if (listener.actorId === speakerId) return 0;

      const ls = state.get(listener.actorId);
      if (!ls || ls.connection !== CONNECTION_STATES.CONNECTED) return 0;

      // `sameSpace` em linha: chamada de função por par, nesta escala, aparece
      // no perfil. A regra é a mesma — desconhecido de um lado não separa.
      if (space && listener.space && space !== listener.space) {
        metrics.count('policy.rejected.space');
        return 0;
      }

      const lp = listener.pos;
      const dx = sx - lp[0];
      const dy = sy - lp[1];
      const dz = sz - lp[2];
      const d2 = dx * dx + dy * dy + dz * dz;
      // Comparar quadrados evita a raiz para todo mundo que está fora — que,
      // fora da taverna, é quase todo mundo.
      if (!(d2 < rangeSquared)) return 0;

      const distance = Math.sqrt(d2);
      probe.distance = distance;
      return 1 - (distance / range);
    });
    probe.distance = 0;
    probe.range = range;
    return probe;
  }

  /**
   * PTT DOWN — o cliente pediu para falar.
   *
   * O pedido é validado ANTES de virar transmissão, e a recusa é devolvida com
   * motivo para que o cliente possa mostrar "você está mutado" em vez de um
   * microfone que parece aberto e não sai som.
   *
   * @param {number} actorId
   * @returns {{ok: boolean, changed: boolean, reason?: string}}
   */
  function pttDown(actorId) {
    const s = state.get(actorId);
    if (!s) {
      metrics.count('ptt.rejected');
      return { ok: false, changed: false, reason: 'sem sessão de voz' };
    }
    // `canSpeak` com PTT já solto recusaria por "PTT solto" — que é exatamente
    // o que se está tentando mudar. Avalia-se o resto das condições fingindo
    // que a tecla já está apertada, e só então concede.
    const previous = s.transmitting;
    s.transmitting = true;
    const verdict = canSpeak(actorId);
    if (!verdict.ok) {
      s.transmitting = previous;
      metrics.count('ptt.rejected');
      return { ok: false, changed: false, reason: verdict.reason };
    }
    metrics.count('ptt.granted');
    return { ok: true, changed: previous !== true };
  }

  /**
   * PTT UP — interrompe a transmissão.
   *
   * Nunca falha. Soltar a tecla é o lado seguro de um controle de microfone, e
   * um caminho que pudesse recusar deixaria alguém transmitindo por causa de um
   * estado inesperado.
   *
   * @param {number} actorId
   */
  function pttUp(actorId) {
    const result = state.setTransmitting(actorId, false);
    if (result.changed) metrics.count('ptt.released');
    return { ok: true, changed: result.changed };
  }

  /**
   * Troca de modo pedida pelo cliente. Valida e devolve o motivo da recusa.
   * @param {number} actorId
   * @param {unknown} mode
   */
  function requestVoiceMode(actorId, mode) {
    const result = state.setVoiceMode(actorId, mode);
    if (!result.ok) metrics.count('voiceMode.rejected');
    else if (result.changed) metrics.count('voiceMode.changed');
    return result;
  }

  /**
   * Mute pedido pelo cliente. Sempre aceito: silenciar-se é direito de quem
   * fala, e não há estado do servidor que justifique recusar.
   * @param {number} actorId
   * @param {boolean} muted
   */
  function requestMute(actorId, muted) {
    const result = state.setMuted(actorId, muted);
    if (result.changed) metrics.count(muted ? 'mute.on' : 'mute.off');
    return result;
  }

  return {
    canSpeak, canListen, canHear, audienceProbe, pttDown, pttUp,
    requestVoiceMode, requestMute,
    rangeFor, maxRange, volumeAt, sameSpace,
    pttRequired
  };
}

/** Distância euclidiana 3D entre duas posições `[x, y, z]`. */
function distance3D(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length < 3 || b.length < 3) return Infinity;
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

module.exports = {
  createVoicePolicyEngine,
  volumeAt,
  sameSpace,
  distance3D
};
