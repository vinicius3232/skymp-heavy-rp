/**
 * core/voice/voice-conditions.js
 *
 * O vocabulário de estado da voz, e a **única** tabela que diz o que cada
 * estado faz com ela.
 *
 * ## O que este arquivo existe para impedir
 *
 * A instrução da etapa foi explícita: não espalhar `if dead`, `if gagged`,
 * `if unconscious` por vários arquivos. O jeito de garantir isso não é
 * disciplina — é não ter onde escrever o segundo `if`. Aqui há uma tabela de
 * perfis; o resto do sistema pergunta e recebe números.
 *
 * Se um dia alguém quiser "cego não ouve sussurro", a mudança é uma linha na
 * tabela. Se a regra estivesse em `canSpeak`, na `audienceProbe`, no relay e no
 * HUD, seriam quatro — e o quarto ficaria para trás, que é como um jogador
 * descobre uma regra pela metade.
 *
 * ## Composição, não precedência
 *
 * Uma pessoa pode estar abatida **e** amordaçada. Escolher "a condição mais
 * grave" perderia a mordaça, e a voz de um abatido amordaçado sairia igual à de
 * um abatido qualquer — uma regra de jogo desaparecendo por causa de outra.
 *
 * Então as condições **compõem**:
 *
 *   - `canSpeak` / `canHear` → **E lógico**. Uma proibição basta.
 *   - `rangeModifier` / `gainModifier` → **produto**. Dois efeitos se somam.
 *   - `effect` → o **mais forte** presente (`none < faint < muffled`).
 *   - `reason` → o primeiro motivo de recusa, na ordem de `CONDITION_ORDER`.
 *
 * A ordem existe só para o motivo: quem lê um log quer "silenciado pela staff",
 * não "amordaçado", quando as duas coisas valem.
 *
 * ## Nada aqui inventa estado de personagem
 *
 * Este arquivo não sabe o que é `character-state.js`, nem lê banco, nem tem
 * cache de jogador. Quem traduz o mundo real nesta linguagem é
 * `voice-character-adapter.js`. A separação é o que permite testar a regra sem
 * subir banco, e trocar a fonte do estado sem tocar na regra.
 */

const serverOptions = require('../server-options');

/**
 * As condições de voz. **Não são estados de personagem** — são as perguntas que
 * a voz faz sobre o personagem, e há duas (`GAGGED`, `STAFF_MUTED`) que não
 * correspondem a nenhum `character-state.STATES`.
 */
const VOICE_CONDITIONS = Object.freeze({
  NORMAL: 'NORMAL',
  DOWNED: 'DOWNED',
  UNCONSCIOUS: 'UNCONSCIOUS',
  DEAD: 'DEAD',
  GAGGED: 'GAGGED',
  STAFF_MUTED: 'STAFF_MUTED'
});

/**
 * Efeitos de voz que o cliente sabe aplicar.
 *
 * São **nomes**, não parâmetros: o corte do passa-baixa mora no
 * `server-options` e viaja uma vez no `auth_ok`. Mandar a frequência por rota
 * seria repetir 50 vezes por segundo um número que muda quando alguém edita um
 * JSON e reinicia o servidor.
 */
const VOICE_EFFECTS = Object.freeze({
  NONE: 'none',
  /** Mais baixo e sem brilho — quem está caindo, não quem está abafado. */
  FAINT: 'faint',
  /** Passa-baixa agressivo: a voz atravessa um pano. É a mordaça. */
  MUFFLED: 'muffled'
});

/** Força relativa dos efeitos, para a composição escolher o mais forte. */
const EFFECT_STRENGTH = Object.freeze({
  [VOICE_EFFECTS.NONE]: 0,
  [VOICE_EFFECTS.FAINT]: 1,
  [VOICE_EFFECTS.MUFFLED]: 2
});

/**
 * Ordem de leitura do MOTIVO quando mais de uma condição recusa.
 *
 * Staff primeiro de propósito: quando a staff silenciou alguém, é isso que a
 * pessoa e o log precisam ler — não "você está morto", que é verdade e é
 * irrelevante para quem vai apelar da punição.
 */
const CONDITION_ORDER = Object.freeze([
  VOICE_CONDITIONS.STAFF_MUTED,
  VOICE_CONDITIONS.DEAD,
  VOICE_CONDITIONS.UNCONSCIOUS,
  VOICE_CONDITIONS.DOWNED,
  VOICE_CONDITIONS.GAGGED,
  VOICE_CONDITIONS.NORMAL
]);

/**
 * @typedef {object} VoiceConditionProfile
 * @property {boolean} canSpeak
 * @property {boolean} canHear
 * @property {number} rangeModifier  multiplica o alcance do modo de voz
 * @property {number} gainModifier   multiplica o volume final
 * @property {string} effect         um de VOICE_EFFECTS
 * @property {string|null} reason    por que não fala/ouve, quando é o caso
 */

/**
 * Perfil de cada condição, montado a partir do `server-options`.
 *
 * É uma **função**, não uma constante de módulo, porque `server-options` é
 * recarregável (`_reset()` nos testes) e porque congelar a tabela na primeira
 * importação faria a configuração depender da ordem de carga dos módulos — o
 * mesmo defeito que o `mp` congelado no construtor produziu na Etapa 2.
 *
 * @returns {Record<string, VoiceConditionProfile>}
 */
function conditionProfiles() {
  const free = {
    canSpeak: true, canHear: true, rangeModifier: 1, gainModifier: 1,
    effect: VOICE_EFFECTS.NONE, reason: null
  };

  return {
    [VOICE_CONDITIONS.NORMAL]: { ...free },

    // Abatido: configurável de ponta a ponta porque a instrução dizia
    // "comportamento configurável" e porque servidores discordam disto. O
    // padrão — fala, baixo e curto — é o que casa com o `death-service`, onde
    // DOWNED é alguém sangrando e esperando socorro, não um cadáver.
    [VOICE_CONDITIONS.DOWNED]: {
      ...free,
      canSpeak: serverOptions.get('voice.downed.canSpeak'),
      rangeModifier: serverOptions.get('voice.downed.rangeModifier'),
      gainModifier: serverOptions.get('voice.downed.gainModifier'),
      effect: serverOptions.get('voice.downed.effect'),
      reason: 'abatido'
    },

    // Inconsciente NÃO fala, e isso não é opção: é o significado da palavra.
    [VOICE_CONDITIONS.UNCONSCIOUS]: {
      ...free,
      canSpeak: false,
      canHear: serverOptions.get('voice.unconscious.canHear'),
      gainModifier: 0,
      reason: 'inconsciente'
    },

    // Morto: sem voz local. Continuar audível seria o defeito de RP mais
    // barato de cometer e o mais caro de perceber — a cena inteira ouve um
    // cadáver falar e ninguém sabe se é bug ou permissão.
    [VOICE_CONDITIONS.DEAD]: {
      ...free,
      canSpeak: false,
      canHear: serverOptions.get('voice.dead.canHear'),
      gainModifier: 0,
      reason: 'morto — sem voz local'
    },

    // Amordaçado é o caso que a instrução destacou: **efeito, não mute**.
    // Calar por completo é mais fácil de implementar e pior de jogar — quem
    // amordaça quer ouvir o outro tentando falar, e quem está amordaçado
    // quer poder chamar atenção de quem está encostado.
    [VOICE_CONDITIONS.GAGGED]: {
      ...free,
      canSpeak: serverOptions.get('voice.gagged.canSpeak'),
      rangeModifier: serverOptions.get('voice.gagged.rangeModifier'),
      gainModifier: serverOptions.get('voice.gagged.gainModifier'),
      effect: serverOptions.get('voice.gagged.effect'),
      reason: 'amordaçado'
    },

    // Silêncio de staff é punição, não estado do corpo: cala a voz e não toca
    // na audição. Quem foi silenciado continua ouvindo a cena — e precisa
    // continuar, senão a punição vira desconexão disfarçada.
    [VOICE_CONDITIONS.STAFF_MUTED]: {
      ...free,
      canSpeak: false,
      gainModifier: 0,
      reason: 'silenciado pela staff'
    }
  };
}

/**
 * Perfil livre — o que vale para quem não tem condição nenhuma.
 * @returns {VoiceConditionProfile & {conditions: string[]}}
 */
function neutralProfile() {
  return {
    canSpeak: true, canHear: true, rangeModifier: 1, gainModifier: 1,
    effect: VOICE_EFFECTS.NONE, reason: null, conditions: []
  };
}

/**
 * Compõe as condições ativas num perfil só.
 *
 * @param {string[]} conditions nomes de `VOICE_CONDITIONS`
 * @param {Record<string, VoiceConditionProfile>} [profiles] injetável para teste
 * @returns {VoiceConditionProfile & {conditions: string[]}}
 */
function composeProfile(conditions, profiles) {
  const table = profiles || conditionProfiles();
  const active = [];
  for (const name of conditions || []) {
    if (name && name !== VOICE_CONDITIONS.NORMAL && table[name]) active.push(name);
  }
  if (active.length === 0) return neutralProfile();

  const composed = neutralProfile();
  composed.conditions = active;

  for (const name of active) {
    const profile = table[name];
    composed.canSpeak = composed.canSpeak && profile.canSpeak;
    composed.canHear = composed.canHear && profile.canHear;
    composed.rangeModifier *= profile.rangeModifier;
    composed.gainModifier *= profile.gainModifier;
    if (EFFECT_STRENGTH[profile.effect] > EFFECT_STRENGTH[composed.effect]) {
      composed.effect = profile.effect;
    }
  }

  // O motivo é o da primeira condição BLOQUEANTE na ordem de leitura. Uma
  // condição que só atenua (mordaça, abatido que fala) não é motivo de recusa,
  // e reportá-la como se fosse faria o log dizer "amordaçado" para alguém que
  // está falando normalmente através da mordaça.
  for (const name of CONDITION_ORDER) {
    if (!active.includes(name)) continue;
    const profile = table[name];
    if (!profile.canSpeak || !profile.canHear) {
      composed.reason = profile.reason;
      break;
    }
  }

  return composed;
}

/** Parâmetros dos efeitos, para viajar uma vez no handshake. */
function effectSettings() {
  return {
    [VOICE_EFFECTS.MUFFLED]: { lowpassHz: serverOptions.get('voice.effects.muffledLowpassHz') },
    [VOICE_EFFECTS.FAINT]: { lowpassHz: serverOptions.get('voice.effects.faintLowpassHz') }
  };
}

module.exports = {
  VOICE_CONDITIONS,
  VOICE_EFFECTS,
  EFFECT_STRENGTH,
  CONDITION_ORDER,
  conditionProfiles,
  composeProfile,
  neutralProfile,
  effectSettings
};
