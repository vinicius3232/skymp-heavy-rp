/**
 * core/voice/voice-policy.js
 *
 * VoicePolicyEngine — as perguntas de permissão da voz, num lugar só.
 *
 * ## A equação que este módulo resolve
 *
 * ```
 *   Locutor + Ouvinte + Estado do personagem + Estado do mundo  =  VoiceRoute
 * ```
 *
 * `resolveRoute(listener, speaker)` é essa equação escrita como função, e a
 * `VoiceRoute` que ela devolve tem exatamente os cinco campos que a etapa
 * pediu: `allowed`, `gain`, `rangeModifier`, `effect`, `reason`.
 *
 *   - **Locutor / Ouvinte** → `VoiceStateService` (modo, mute, PTT, conexão)
 *   - **Estado do personagem** → `voice-character-adapter` → `voice-conditions`
 *   - **Estado do mundo** → `voice-occlusion` (célula, worldspace, portais)
 *
 * ## As perguntas
 *
 *   - `canSpeak(actorId)`      — esta pessoa pode transmitir agora?
 *   - `canListen(actorId)`     — esta pessoa está em condição de receber?
 *   - `canHear(a, b)`          — este ouvinte recebe este locutor, e a que volume?
 *   - `resolveRoute(a, b)`     — a mesma resposta, com os cinco campos
 *   - `pttDown/pttUp`          — o gesto do jogador vira (ou não) transmissão.
 *
 * Tudo o mais no Voice Core consulta estas. O motivo de estarem juntas é
 * que elas compartilham o estado que decide (`VoiceStateService`) e a tabela que
 * mede (`core/proximity-ranges.js`), e separá-las daria a cada chamador a
 * chance de responder por conta própria — que é como um servidor autoritativo
 * vira um servidor que concorda com o cliente na maioria das vezes.
 *
 * ## Onde NÃO existe `if (dead)`
 *
 * Em lugar nenhum deste arquivo, e é o ponto. Morto, inconsciente, abatido,
 * amordaçado e silenciado pela staff entram por **uma** porta —
 * `profileOf(actorId)` — e saem como quatro números e um nome de efeito. A
 * tabela que os produz é `voice-conditions.js`; a tradução do personagem real é
 * `voice-character-adapter.js`. Acrescentar uma condição nova não toca aqui.
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
const { composeProfile, neutralProfile, conditionProfiles, VOICE_EFFECTS, EFFECT_STRENGTH } = require('./voice-conditions');
const { nullCharacterAdapter } = require('./voice-character-adapter');
const { createVoiceOcclusion } = require('./voice-occlusion');

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
 * @param {ReturnType<typeof import('./voice-character-adapter').createVoiceCharacterAdapter>} [deps.conditions]
 * @param {ReturnType<typeof import('./voice-occlusion').createVoiceOcclusion>} [deps.occlusion]
 * @param {Record<string, any>} [deps.conditionProfiles]
 */
function createVoicePolicyEngine(deps) {
  const {
    state,
    ranges = VOICE_RANGES,
    metrics = nullMetrics(),
    pttRequired = true,
    // O adapter NULO é o padrão de propósito. O real puxa
    // `core/character-state`, que puxa `../database`; um teste de alcance de
    // sussurro não deve precisar de MySQL para rodar. Quem quer as condições
    // reais é o `voice-core`, e ele as injeta.
    conditions = nullCharacterAdapter(),
    occlusion = createVoiceOcclusion({ metrics })
  } = deps || {};

  if (!state || typeof state.get !== 'function') {
    throw new Error('[voice-policy] VoiceStateService ausente');
  }

  /**
   * Tabela de perfis por condição, resolvida uma vez por engine.
   *
   * Lida na construção e não por chamada porque ela vem do `server-options`,
   * que é imutável enquanto o servidor roda. Ler por par seria um
   * `serverOptions.get` por par por tick, para devolver o mesmo número.
   */
  const profileTable = deps.conditionProfiles || conditionProfiles();

  /**
   * Cache de perfil composto, válido só DENTRO de um ciclo de recompute.
   *
   * `null` significa "sem ciclo aberto": toda leitura vai à fonte. É o modo em
   * que o relay opera, e é o certo lá — entre um recompute e o quadro seguinte
   * a pessoa pode ter morrido, e servir um perfil de 150 ms atrás faria um
   * cadáver terminar a frase.
   *
   * Dentro de um ciclo o cache existe porque `conditionsOf` consulta dois
   * `Map` e compõe um objeto, e sem ele isso aconteceria uma vez por PAR — na
   * topologia densa, 39.800 vezes por tick para 200 respostas distintas.
   *
   * @type {Map<number, import('./voice-conditions').VoiceConditionProfile & {conditions: string[]}>|null}
   */
  let _profileCache = null;

  /** Abre um ciclo de recompute: perfis passam a ser cacheados. */
  function beginCycle() {
    _profileCache = new Map();
  }

  /** Fecha o ciclo. Depois disto toda leitura volta a ir à fonte. */
  function endCycle() {
    _profileCache = null;
  }

  /**
   * O perfil de voz de um ator: o que as condições do personagem dele fazem
   * com a voz. **A única porta por onde morte, desmaio, mordaça e silêncio de
   * staff entram nesta política.**
   *
   * @param {number} actorId
   * @returns {import('./voice-conditions').VoiceConditionProfile & {conditions: string[]}}
   */
  function profileOf(actorId) {
    if (_profileCache) {
      const cached = _profileCache.get(actorId);
      if (cached) return cached;
    }
    const s = state.get(actorId);
    const active = s ? conditions.conditionsOf(s.characterId) : [];
    const profile = active.length === 0
      ? neutralProfile()
      : composeProfile(active, profileTable);
    if (_profileCache) _profileCache.set(actorId, profile);
    return profile;
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
   * @returns {{ok: boolean, reason?: string, conditions?: string[]}}
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
    // A condição do PERSONAGEM vem por último entre as recusas porque é a mais
    // externa ao transporte: "você está morto" só é a explicação útil depois de
    // haver sessão, personagem e conexão. Antes disso o motivo verdadeiro é
    // outro, e mostrar a morte esconderia um problema de conexão.
    const profile = profileOf(actorId);
    if (!profile.canSpeak) {
      metrics.count('policy.rejected.condition');
      return { ok: false, reason: profile.reason || 'condição do personagem', conditions: profile.conditions };
    }
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
   * @returns {{ok: boolean, reason?: string, conditions?: string[]}}
   */
  function canListen(actorId) {
    const s = state.get(actorId);
    if (!s) return { ok: false, reason: 'sem sessão de voz' };
    if (s.connection !== CONNECTION_STATES.CONNECTED) {
      return { ok: false, reason: `conexão em ${s.connection}` };
    }
    // Ouvir tem condição própria e ela é MAIS FROUXA que a de falar: silenciado
    // pela staff continua ouvindo (senão a punição vira desconexão disfarçada),
    // e amordaçado ouve normalmente (a mordaça está na boca). Quem não ouve é
    // quem está inconsciente ou morto — e mesmo isso é configurável.
    const profile = profileOf(actorId);
    if (!profile.canHear) {
      return { ok: false, reason: profile.reason || 'condição do personagem', conditions: profile.conditions };
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
   * @returns {{ok: boolean, volume: number, distance: number, effect: string, reason?: string}}
   */
  function canHear(listener, speaker) {
    if (!listener || !speaker) {
      return { ok: false, volume: 0, distance: Infinity, effect: VOICE_EFFECTS.NONE, reason: 'amostra ausente' };
    }
    if (listener.actorId === speaker.actorId) {
      // Ouvir a própria voz de volta é eco, não voz.
      return { ok: false, volume: 0, distance: 0, effect: VOICE_EFFECTS.NONE, reason: 'mesmo ator' };
    }

    // O veredito sai do MESMO código que o recompute usa. O que segue depois
    // dele só reconstrói o motivo, e só quando a resposta é não.
    const probe = audienceProbe(speaker);
    if (probe) {
      const volume = probe(listener);
      if (volume > 0) {
        return { ok: true, volume, distance: probe.distance, effect: probe.effect };
      }
    }

    // Caminho frio: descobrir por quê. A ordem vai da recusa mais estrutural
    // para a mais volátil, porque quem lê um log quer a causa raiz.
    const listening = canListen(listener.actorId);
    if (!listening.ok) {
      return { ok: false, volume: 0, distance: Infinity, effect: VOICE_EFFECTS.NONE, reason: listening.reason };
    }

    const speaking = canSpeak(speaker.actorId);
    if (!speaking.ok) {
      return { ok: false, volume: 0, distance: Infinity, effect: VOICE_EFFECTS.NONE, reason: speaking.reason };
    }

    // O mesmo veredito de ambiente que o caminho quente usa. Chamar
    // `sameSpace` aqui teria a resposta certa hoje e mentiria no dia em que um
    // provedor de portal existisse: o par estaria audível pelo caminho quente
    // e "incompatível" pelo frio — dois motivos para o mesmo par.
    const environment = occlusion.between(listener.space, speaker.space);
    if (environment.blocked) {
      return { ok: false, volume: 0, distance: Infinity, effect: VOICE_EFFECTS.NONE, reason: environment.reason };
    }

    const distance = distance3D(listener.pos, speaker.pos);
    if (!Number.isFinite(distance)) {
      return { ok: false, volume: 0, distance: Infinity, effect: VOICE_EFFECTS.NONE, reason: 'posição inválida' };
    }

    return { ok: false, volume: 0, distance, effect: VOICE_EFFECTS.NONE, reason: 'fora de alcance' };
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
   * @returns {((listener: {actorId: number, space: string|null, pos: number[]}) => number) & {distance: number, range: number, baseRange: number, rangeModifier: number, gainModifier: number, effect: string} | null}
   *   `null` se o locutor não pode falar; senão, uma função que devolve o
   *   volume (0 = não ouve) e publica a distância medida em `.distance` e o
   *   efeito do par em `.effect`.
   */
  function audienceProbe(speaker) {
    if (!speaker || !Array.isArray(speaker.pos)) return null;
    if (!canSpeak(speaker.actorId).ok) return null;

    const speakerState = state.get(speaker.actorId);
    const profile = profileOf(speaker.actorId);
    const baseRange = rangeFor(speakerState ? speakerState.voiceMode : DEFAULT_VOICE_MODE);

    // O alcance efetivo é o do modo VEZES o modificador da condição. Um
    // sussurro amordaçado alcança 30% de um sussurro, não 30% de um grito — a
    // mordaça abafa o que a pessoa escolheu dizer, não redefine o que ela é.
    const range = baseRange * profile.rangeModifier;
    if (!(range > 0)) return null;

    const gainModifier = profile.gainModifier;
    if (!(gainModifier > 0)) return null;

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

      // Condição do OUVINTE. Um `Map.get` cacheado por ciclo — sem isto, um
      // inconsciente continuaria recebendo rota e o cliente dele tocaria a
      // cena inteira enquanto a UI diz que ele está apagado.
      const listenerProfile = profileOf(listener.actorId);
      if (!listenerProfile.canHear) return 0;

      // Ambiente. No nível 1 isto é a mesma comparação de string que estava
      // aqui em linha antes — a diferença é que agora um provedor de portal
      // pode transformar "parede" em "porta fechada", sem tocar nesta função.
      // `space === listener.space` é conferido antes para que o caso comum
      // (mesma célula) não pague sequer uma chamada.
      let occlusionGain = 1;
      let occlusionRangeSquared = rangeSquared;
      let pairEffect = profile.effect;

      if (space !== listener.space) {
        const verdict = occlusion.between(listener.space, space);
        if (verdict.blocked) {
          metrics.count('policy.rejected.space');
          return 0;
        }
        occlusionGain = verdict.gainModifier;
        const occludedRange = range * verdict.rangeModifier;
        occlusionRangeSquared = occludedRange * occludedRange;
        if (EFFECT_STRENGTH[verdict.effect] > EFFECT_STRENGTH[pairEffect]) {
          pairEffect = verdict.effect;
        }
      }

      const lp = listener.pos;
      const dx = sx - lp[0];
      const dy = sy - lp[1];
      const dz = sz - lp[2];
      const d2 = dx * dx + dy * dy + dz * dz;
      // Comparar quadrados evita a raiz para todo mundo que está fora — que,
      // fora da taverna, é quase todo mundo.
      if (!(d2 < occlusionRangeSquared)) return 0;

      const distance = Math.sqrt(d2);
      probe.distance = distance;
      probe.effect = pairEffect;
      return (1 - (distance / range)) * gainModifier * occlusionGain;
    });
    probe.distance = 0;
    probe.range = range;
    probe.baseRange = baseRange;
    probe.rangeModifier = profile.rangeModifier;
    probe.gainModifier = gainModifier;
    /** Efeito do último par avaliado. Mesma justificativa de `.distance`. */
    probe.effect = profile.effect;
    return probe;
  }

  /**
   * A equação da etapa, escrita como função:
   *
   * ```
   *   Locutor + Ouvinte + Estado do personagem + Estado do mundo = VoiceRoute
   * ```
   *
   * É a superfície **legível** — a que os testes e o diagnóstico usam. O
   * recompute continua usando `audienceProbe`, e as duas não podem divergir
   * porque esta é implementada sobre aquela: o veredito e o ganho saem do
   * mesmo código, e o que muda é só quanto contexto se devolve junto.
   *
   * @param {{actorId: number, space: string|null, pos: number[]}} listener
   * @param {{actorId: number, space: string|null, pos: number[]}} speaker
   * @returns {{allowed: boolean, gain: number, rangeModifier: number, gainModifier: number,
   *           effect: string, reason: string|null, distance: number, range: number,
   *           conditions: {speaker: string[], listener: string[]}}}
   */
  function resolveRoute(listener, speaker) {
    const speakerProfile = speaker ? profileOf(speaker.actorId) : neutralProfile();
    const listenerProfile = listener ? profileOf(listener.actorId) : neutralProfile();
    const conditionsOut = {
      speaker: speakerProfile.conditions,
      listener: listenerProfile.conditions
    };

    const verdict = canHear(listener, speaker);
    const range = rangeFor(
      state.get(speaker && speaker.actorId) ? state.get(speaker.actorId).voiceMode : DEFAULT_VOICE_MODE
    ) * speakerProfile.rangeModifier;

    return {
      allowed: verdict.ok,
      gain: verdict.volume,
      rangeModifier: speakerProfile.rangeModifier,
      gainModifier: speakerProfile.gainModifier,
      effect: verdict.ok ? verdict.effect : VOICE_EFFECTS.NONE,
      reason: verdict.ok ? null : (verdict.reason ?? null),
      distance: verdict.distance,
      range,
      conditions: conditionsOut
    };
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
    canSpeak, canListen, canHear, audienceProbe, resolveRoute, pttDown, pttUp,
    requestVoiceMode, requestMute,
    profileOf, beginCycle, endCycle,
    rangeFor, maxRange, volumeAt, sameSpace,
    occlusion, conditions,
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
