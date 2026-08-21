/**
 * core/voice/voice-occlusion.js
 *
 * O que fica **entre** o locutor e o ouvinte.
 *
 * A instrução pedia três níveis e pedia que fossem progressivos. Eles são, e o
 * que este arquivo entrega hoje é o nível 1 inteiro, o nível 2 como encaixe
 * vazio, e o nível 3 recusado com motivo.
 *
 * ## Nível 1 — célula e worldspace. **ATIVO.**
 *
 * Dois espaços diferentes não se ouvem. Já era assim desde `112d51b` ("a voz
 * para de atravessar a parede entre duas células") e continua sendo a regra
 * mais forte do sistema — ela vem ANTES da distância, porque duas tavernas
 * distintas têm coordenadas na mesma vizinhança numérica e a distância entre
 * elas mede zero.
 *
 * No SkyMP célula e worldspace são o MESMO campo (`cellOrWorldDesc`), então o
 * nível 1 é uma comparação de string. Ver `SKYVOICE_CORE_ETAPA_2.md` §3.1.
 *
 * ## Nível 2 — portas e portais. **ENCAIXE, SEM IMPLEMENTAÇÃO.**
 *
 * A pergunta da tarefa era se dá para saber **com segurança** se uma porta está
 * aberta, fechada, e o que ela liga. O que o estudo achou:
 *
 * | Pergunta | Existe API? | Serve? |
 * |---|---|---|
 * | Porta aberta/fechada | **Sim** — `ObjectReference.GetOpenState` | Só com a referência da porta em mãos |
 * | O que a porta liga | **Sim** — `ObjectReference.GetLinkedRef` + `GetParentCell` | idem |
 * | **Quais portas existem numa célula** | **NÃO** | É aqui que trava |
 *
 * As duas primeiras estão em `PAPYRUS_USAGE_POLICY.md` §3 como SAFE. A terceira
 * não tem resposta: o servidor não enumera o conteúdo de uma célula.
 * `mp.lookupEspmRecordById` devolve `{}` para **referências** — está medido em
 * `core/espm.js`, contra servidor real, com `0x14` (o Player) como exemplo —
 * então o `XTEL` de uma porta de carregamento não é legível pelo caminho ESPM.
 * Sobra `Game.FindClosestReferenceOfTypeFromRef`, que é uma chamada Papyrus
 * **por jogador por tick**, e o custo de uma chamada Papyrus que de fato existe
 * **nunca foi medido** — a única medição do projeto (13–35 ms) é de uma função
 * inexistente e está marcada como suspeita na §7 daquela política.
 *
 * Conclusão: **os primitivos existem, a enumeração não, e o orçamento é
 * desconhecido.** Implementar assim mesmo seria escolher o resultado antes de
 * medir, que é exatamente o que o bench da Etapa 2 existe para não repetir.
 *
 * O que fica é o encaixe: `setPortalProvider()`. Quem um dia tiver uma tabela
 * curada de portas (ou um `.psc` nosso publicando `OnOpen`/`OnClose` via
 * `mp.registerPapyrusFunction`) liga aqui, e a voz passa a atravessar a porta
 * abafada em vez de parar na parede — **sem tocar na política**.
 *
 * ## Nível 3 — raycast. **RECUSADO NESTA ETAPA.**
 *
 * A instrução foi específica: *"NÃO fazer raycast por jogador contra todos os
 * outros sem estudo"*. O estudo é curto e negativo:
 *
 *   1. Não há API de raycast no servidor. As 128 funções do VM não incluem
 *      nenhuma, e o `mp` não expõe geometria de colisão.
 *   2. O que existiria seria no CLIENTE (`SkyrimPlatform`), e mover a decisão
 *      para lá entrega ao cliente quem ouve quem — a fronteira que esta
 *      arquitetura inteira existe para não cruzar.
 *   3. Sem (1) não há benchmark possível, e a instrução condicionava o nível 3
 *      a haver benchmark.
 *
 * Não está "adiado por falta de tempo". Está recusado por não haver caminho.
 */

const { VOICE_EFFECTS } = require('./voice-conditions');

/**
 * @typedef {object} OcclusionVerdict
 * @property {boolean} blocked        corta a rota por completo
 * @property {number} rangeModifier   multiplica o alcance
 * @property {number} gainModifier    multiplica o volume
 * @property {string} effect          um de VOICE_EFFECTS
 * @property {string|null} reason
 */

/** Passagem livre — mesmo espaço, nada no caminho. */
const CLEAR = Object.freeze({
  blocked: false, rangeModifier: 1, gainModifier: 1, effect: VOICE_EFFECTS.NONE, reason: null
});

/** Espaços diferentes e nenhum portal conhecido entre eles. */
const SEALED = Object.freeze({
  blocked: true, rangeModifier: 0, gainModifier: 0, effect: VOICE_EFFECTS.NONE,
  reason: 'célula/worldspace incompatível'
});

/**
 * @param {object} [deps]
 * @param {ReturnType<typeof import('./voice-metrics').createVoiceMetrics>} [deps.metrics]
 */
function createVoiceOcclusion(deps = {}) {
  const metrics = deps.metrics || require('./voice-metrics').nullMetrics();

  /**
   * Nível 2, quando alguém o ligar.
   *
   * Contrato: recebe os dois espaços e devolve `null` (não sei / não há
   * caminho) ou um `OcclusionVerdict`. Devolver `null` é o padrão e cai no
   * nível 1 — um provedor que não conhece um par de células **não** deve
   * inventar passagem.
   *
   * @type {((listenerSpace: string|null, speakerSpace: string|null) => OcclusionVerdict|null)|null}
   */
  let portalProvider = null;

  /** @param {typeof portalProvider} provider */
  function setPortalProvider(provider) {
    portalProvider = typeof provider === 'function' ? provider : null;
    return portalProvider !== null;
  }

  /**
   * O que o ambiente faz com esta voz.
   *
   * ## A regra do desconhecido, que não mudou
   *
   * Espaço desconhecido de um dos lados **não separa**. Falta de informação não
   * é prova de estarem em lugares diferentes, e tratá-la como prova calaria
   * alguém por causa de uma leitura de `locationalData` que falhou. É a mesma
   * decisão de `voice-policy.sameSpace`, e as duas apontam para este
   * comentário de propósito.
   *
   * @param {string|null|undefined} listenerSpace
   * @param {string|null|undefined} speakerSpace
   * @returns {OcclusionVerdict}
   */
  function between(listenerSpace, speakerSpace) {
    if (!listenerSpace || !speakerSpace) return CLEAR;
    if (listenerSpace === speakerSpace) return CLEAR;

    if (portalProvider) {
      let verdict = null;
      try {
        verdict = portalProvider(listenerSpace, speakerSpace);
      } catch (err) {
        // Um provedor que lança não pode calar a cena inteira. Ele perde a
        // pergunta e o nível 1 responde — que é a resposta conservadora.
        metrics.count('occlusion.providerError');
        verdict = null;
      }
      if (verdict && typeof verdict === 'object') {
        metrics.count('occlusion.portal');
        return normalize(verdict);
      }
    }

    metrics.count('occlusion.sealed');
    return SEALED;
  }

  /** Um provedor externo não decide o formato do veredito. */
  function normalize(verdict) {
    const range = Number.isFinite(verdict.rangeModifier) ? clamp01(verdict.rangeModifier) : 1;
    const gain = Number.isFinite(verdict.gainModifier) ? clamp01(verdict.gainModifier) : 1;
    const effect = Object.values(VOICE_EFFECTS).includes(verdict.effect)
      ? verdict.effect
      : VOICE_EFFECTS.MUFFLED;
    return {
      blocked: verdict.blocked === true,
      rangeModifier: range,
      gainModifier: gain,
      effect,
      reason: typeof verdict.reason === 'string' ? verdict.reason : 'portal'
    };
  }

  function describe() {
    return { level: portalProvider ? 2 : 1, portalProvider: portalProvider !== null };
  }

  return { between, setPortalProvider, describe, CLEAR, SEALED };
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

module.exports = { createVoiceOcclusion, CLEAR, SEALED };
