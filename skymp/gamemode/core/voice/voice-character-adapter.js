/**
 * core/voice/voice-character-adapter.js
 *
 * A costura entre o personagem que o projeto já tem e a linguagem que a voz
 * fala. **É um tradutor, não uma segunda máquina de estados.**
 *
 * ## O que já existia, e foi reusado inteiro
 *
 * | Condição de voz | De onde vem, hoje | Quem escreve lá |
 * |---|---|---|
 * | `DEAD` | `character-state.STATES.DEAD` | `death-service.bleedOut` |
 * | `DOWNED` | `character-state.STATES.DOWNED` | `death-service.handlePlayerDowned` |
 * | `GAGGED` | metadados do `RESTRAINED` | `governance-service` (algemar) |
 * | `STAFF_MUTED` | `voice-staff-mute` | `admin-service` |
 * | `UNCONSCIOUS` | **ninguém ainda** — ver §"o buraco honesto" |
 *
 * Nada disto foi duplicado. Este arquivo **lê** `core/character-state.js`, que
 * é o mesmo que `core/action-policy.js` lê para decidir se alguém pode minerar.
 * Um personagem abatido tem UM estado, e dois sistemas o consultam.
 *
 * ## A mordaça não é uma algema nova
 *
 * `character_restraints.type` já é `VARCHAR(32)` com `'handcuffs, rope'` no
 * comentário — uma coluna de tipo, não um booleano de algema. Amordaçar é um
 * `type` a mais nela, e não uma tabela, nem um estado, nem uma flag em
 * `characters`. O adapter reconhece:
 *
 *   - `metadata.type === 'gag'` (ou `'gagged'`) — a algema é uma mordaça;
 *   - `metadata.gagged === true` — algemado **e** amordaçado ao mesmo tempo.
 *
 * O segundo caso é o que impede a regra de ser exclusiva: alguém pode estar de
 * mãos atadas e com um pano na boca, e o primeiro campo só cabe um valor.
 *
 * **Algema comum não cala.** Está travado por teste, porque é o erro natural
 * de quem lê "RESTRAINED" e conclui "restrito, então calado".
 *
 * ## O buraco honesto: `UNCONSCIOUS`
 *
 * Não existe produtor de inconsciência neste projeto. `character-state` tem
 * `DOWNED` (sangrando, consciente, pedindo socorro) e `DEAD`, e nenhum dos dois
 * é desmaio.
 *
 * A instrução pedia **suportar a arquitetura**, não inventar o sistema. Então:
 * a condição existe, a regra existe, o teste existe, e a porta de entrada é um
 * campo de metadado (`unconscious: true`) que **ninguém escreve hoje**. No dia
 * em que um sistema de nocaute nascer, ele seta o metadado e a voz obedece sem
 * uma linha nova aqui.
 *
 * Inventar `STATES.UNCONSCIOUS` agora seria pior: um estado na máquina central
 * sem transição que o produza, que `action-policy` teria que passar a
 * considerar, e que apareceria em painel de jogador como um estado alcançável.
 */

const { VOICE_CONDITIONS } = require('./voice-conditions');

/** Valores de `character_restraints.type` que significam uma mordaça. */
const GAG_RESTRAINT_TYPES = Object.freeze(['gag', 'gagged', 'mordaca', 'mordaça']);

/**
 * @param {object} [deps]
 * @param {any} [deps.characterState] padrão: `core/character-state`
 * @param {{isMuted: (characterId: number) => boolean}} [deps.staffMute]
 * @param {(characterId: number, metadata: object) => boolean} [deps.unconsciousProbe]
 *   Gancho para o dia em que existir nocaute. Recebe o metadado do estado atual.
 */
function createVoiceCharacterAdapter(deps = {}) {
  const characterState = deps.characterState || require('../character-state');
  const staffMute = deps.staffMute || require('./voice-staff-mute').sharedVoiceStaffMute;
  const unconsciousProbe = deps.unconsciousProbe || defaultUnconsciousProbe;

  const STATES = characterState.STATES;

  /**
   * As condições de voz ativas de um personagem.
   *
   * `characterId` nulo devolve lista vazia — e isso é deliberado. Um ator sem
   * personagem carregado já é recusado por `canSpeak` com "personagem não
   * carregado"; inventar aqui uma condição para ele produziria dois motivos
   * diferentes para a mesma causa, e o log mostraria o menos útil.
   *
   * @param {number|null|undefined} characterId
   * @returns {string[]}
   */
  function conditionsOf(characterId) {
    if (!Number.isFinite(characterId)) return [];

    const conditions = [];
    const id = /** @type {number} */ (characterId);

    if (staffMute && staffMute.isMuted(id)) conditions.push(VOICE_CONDITIONS.STAFF_MUTED);

    const state = characterState.get(id);
    const metadata = characterState.getMetadata(id) || {};

    if (state === STATES.DEAD) conditions.push(VOICE_CONDITIONS.DEAD);
    else if (state === STATES.DOWNED) conditions.push(VOICE_CONDITIONS.DOWNED);

    // Inconsciência é conferida FORA do `else`: um sistema de nocaute futuro
    // pode marcar alguém como inconsciente sem que o estado central mude, e
    // exigir que ele mexa em `character-state` seria empurrar para ele a
    // decisão de qual estado sobrescrever.
    if (unconsciousProbe(id, metadata)) conditions.push(VOICE_CONDITIONS.UNCONSCIOUS);

    if (isGagged(state, metadata)) conditions.push(VOICE_CONDITIONS.GAGGED);

    return conditions;
  }

  /**
   * Amordaçado?
   *
   * A checagem de `RESTRAINED` está separada do `type` de propósito: `gagged`
   * pode viajar como metadado de qualquer estado (alguém amordaçado dentro da
   * cela é `IMPRISONED`, não `RESTRAINED`), enquanto `type: 'gag'` só faz
   * sentido quando o estado é a algema.
   */
  function isGagged(state, metadata) {
    if (metadata && metadata.gagged === true) return true;
    if (state !== STATES.RESTRAINED) return false;
    const type = metadata && typeof metadata.type === 'string' ? metadata.type.toLowerCase() : '';
    return GAG_RESTRAINT_TYPES.includes(type);
  }

  return { conditionsOf, isGagged, GAG_RESTRAINT_TYPES };
}

/** @param {number} _characterId @param {object} metadata */
function defaultUnconsciousProbe(_characterId, metadata) {
  return !!(metadata && metadata.unconscious === true);
}

/**
 * Adapter que nunca acha condição nenhuma.
 *
 * É o padrão de quem constrói o Voice Core sem passar `conditions` — testes
 * antigos, benches, e o próprio `voice-policy` quando instanciado sozinho.
 * Sem ele, `require('../character-state')` puxaria `../database` para dentro de
 * qualquer teste de política, e um teste de alcance de sussurro passaria a
 * depender de MySQL.
 */
function nullCharacterAdapter() {
  return {
    conditionsOf: () => [],
    isGagged: () => false,
    GAG_RESTRAINT_TYPES
  };
}

module.exports = {
  createVoiceCharacterAdapter,
  nullCharacterAdapter,
  defaultUnconsciousProbe,
  GAG_RESTRAINT_TYPES
};
