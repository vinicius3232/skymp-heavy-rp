/**
 * core/interaction-targets.js
 *
 * Traduz o que o cliente **diz** que é o alvo para o que o servidor **sabe**
 * sobre ele.
 *
 * ─── A única regra deste arquivo ────────────────────────────────────────────
 *
 * O cliente sugere; o servidor confirma. Um pedido de interação chega com
 * `{targetType, targetId}` — dois campos que a máquina do jogador escolheu. O
 * resolvedor pega esses dois campos e devolve **o objeto que o servidor já
 * tinha**: o personagem carregado, a barraca do banco, a porta da célula. Se
 * não achar, o pedido morre aqui.
 *
 * O que nunca entra num alvo resolvido: distância, dono, saldo, estado, preço
 * ou permissão vindos do payload. Esses o servidor calcula ou lê do banco —
 * §7 do pedido, e `CONTRIBUTING.md` §3.6 ("evento de cliente é uma dica, não
 * uma prova").
 *
 * ─── Por que só `player` e `object` têm resolvedor ──────────────────────────
 *
 * Porque são os únicos com consumidor. `container`, `door`, `npc`, `property`
 * e `world_point` continuam vocabulário reservado no `interaction-registry`;
 * o dia em que um módulo precisar de um deles, ele chama
 * `registerResolver('container', fn)` no `initialize()` e nada aqui muda.
 *
 * `object` (desde o Minerador MVP, ver `docs/gameplay/MINING.md` §1) é o
 * primeiro alvo que não é um ator: qualquer `MpObjectReference` do mundo,
 * identificada pelo próprio FormId que o cliente reporta ao interagir — nunca
 * um FormDesc digitado à mão. `mp.get(formId, 'locationalData')` é **[DOC]**
 * em `types/mp.d.ts` (a interface `LocationalData` descreve posição "de um
 * objeto", não "de um ator", e a assinatura de `get()` é genérica sobre
 * `FormId`) — mas nunca foi exercitada por este projeto contra uma referência
 * que não fosse ator. Decisão tomada com o usuário: confiar na documentação
 * oficial e implementar, marcando isto como **assumido, não testado em
 * jogo**, até a primeira validação manual em servidor real.
 *
 * Escrever os quatro restantes agora seria escrever funções sem chamador,
 * contra APIs do SkyMP que este projeto nunca exercitou (`mp.get(id,'inventory')`
 * continua marcada **[DOC]** e não testada — ver `ARCHITECTURE.md` §1.4.9). É o
 * mesmo critério registrado no cabeçalho do `module-registry` em 06/08/2026, e
 * a alternativa — resolvedores adivinhados — é pior que ausência, porque
 * parece pronta.
 *
 * Um tipo sem resolvedor falha **fechado e por nome**: "tipo de alvo nao
 * suportado", com log. Nunca `undefined` seguindo pipeline abaixo.
 */

const rangeUtils = require('./range-utils');
const { TARGET_TYPES } = require('./interaction-registry');

/**
 * Aceita `123`, `"123"`, `"0x7b"` e `"7B"`.
 *
 * Os quatro chegam de verdade: o menu de interação formata actorId como
 * `0x...` (`ui/index.html`, `formatActorId`), o chat manda decimal, e o
 * `browserModal` faz ida e volta por JSON. Recusar um dos formatos quebraria um
 * caminho que hoje funciona.
 *
 * @param {unknown} raw
 * @returns {number|null}
 */
function parseActorId(raw) {
  if (typeof raw === 'number') {
    return Number.isSafeInteger(raw) && raw > 0 ? raw : null;
  }
  if (typeof raw !== 'string') return null;
  const clean = raw.trim().replace(/^0x/i, '');
  if (!/^[0-9a-f]{1,8}$/i.test(clean)) return null;
  const parsed = Number.parseInt(clean, 16);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Mesma forma de `parseActorId` — aceita `123`, `"123"`, `"0x7b"`, `"7B"` —
 * com nome próprio porque aqui o número não é um ator, é o FormId de uma
 * `MpObjectReference` qualquer que o cliente reportou ao interagir.
 *
 * @param {unknown} raw
 * @returns {number|null}
 */
function parseFormId(raw) {
  return parseActorId(raw);
}

/**
 * @typedef {object} AlvoResolvido
 * @property {string} type           o tipo declarado (já validado)
 * @property {string} id             identificador estável, para log e dedupe
 * @property {string} label          nome curto para a UI e para a auditoria
 * @property {number} [actorId]      quando o alvo é um ator no mundo
 * @property {number} [formId]       quando o alvo é uma MpObjectReference qualquer
 * @property {number} [characterId]  quando o alvo é um personagem persistido
 * @property {number|null} [accountId]
 * @property {object} [character]    o registro que o servidor já tinha em mãos
 * @property {(actorId: number, maxRange: number) => {ok: boolean, reason?: string, unverified?: boolean}} [assertRange]
 */

/**
 * Cria o conjunto de resolvedores.
 *
 * Recebe `getCharacter` por injeção em vez de importar `commands.js`: quem sabe
 * quem está logado é o `commands.js`, que importa meio gamemode. Uma
 * dependência dessas aqui tornaria este arquivo — que precisa ser testável sem
 * servidor — impossível de carregar num teste.
 *
 * @param {{getCharacter: (actorId: number) => object|null|undefined, logger?: Pick<Console,'warn'|'error'>}} deps
 */
function createTargetResolvers({ getCharacter, logger = console }) {
  if (typeof getCharacter !== 'function') {
    throw new Error('[interaction-targets] getCharacter invalido');
  }

  /** @type {Map<string, (rawTargetId: unknown, actorId: number) => AlvoResolvido|null>} */
  const resolvers = new Map();

  /**
   * O alvo é outra pessoa no mundo.
   *
   * Duas recusas, e as duas importam:
   *
   *   1. **Sem personagem carregado, não há alvo.** Um actorId cru pode ser um
   *      NPC vanilla, um ator de outro jogador ainda escolhendo personagem, ou
   *      um número inventado. `getCharacter` só responde para quem passou pela
   *      whitelist e escolheu personagem.
   *   2. **Ninguém é alvo de si mesmo por este caminho.** Interação consigo é
   *      painel (`/painel`), não menu contextual. A governança já fazia essa
   *      recusa (`actorId === targetActorId`) — e ela é a razão de o ramo
   *      `isSelf` do `market-stalls` nunca ter sido alcançável
   *      (`CORE_FRAMEWORK_AUDIT.md` §6.7a). Manter a regra aqui, num lugar só,
   *      é o que permite consertar aquilo sem duplicar a decisão.
   */
  resolvers.set(TARGET_TYPES.PLAYER, (rawTargetId, actorId) => {
    const targetActorId = parseActorId(rawTargetId);
    if (targetActorId === null) return null;
    if (targetActorId === actorId) return null;

    const character = getCharacter(targetActorId);
    if (!character) return null;

    return {
      type: TARGET_TYPES.PLAYER,
      id: `player:${targetActorId}`,
      label: `0x${targetActorId.toString(16)}`,
      actorId: targetActorId,
      characterId: character.characterId,
      accountId: character.accountId || null,
      character,
      assertRange: (fromActorId, maxRange) => rangeUtils.assertRange(fromActorId, targetActorId, maxRange)
    };
  });

  /**
   * O alvo é uma `MpObjectReference` qualquer do mundo — um veio de mineração
   * hoje, potencialmente qualquer objeto interativo amanhã.
   *
   * Diferente de `player`, o cliente aqui reporta o **FormId** de quem ele
   * está mirando, não um FormDesc digitado. É o mesmo padrão de confiança que
   * `player` já usa (o cliente indica o alvo, o servidor mede distância e
   * decide o resto) — a diferença é só o tipo de objeto do outro lado.
   *
   * `assertRange` reaproveita `rangeUtils.assertRange` sem modificação: a
   * implementação já era genérica sobre `mp.get(id, 'locationalData')`, nunca
   * exigiu que o segundo id fosse um ator. Ver o aviso de procedência no
   * cabeçalho deste arquivo — `locationalData` contra um objeto comum é
   * **assumido a partir da doc oficial, não validado em jogo**.
   */
  resolvers.set(TARGET_TYPES.OBJECT, (rawTargetId) => {
    const formId = parseFormId(rawTargetId);
    if (formId === null) return null;

    return {
      type: TARGET_TYPES.OBJECT,
      id: `object:${formId}`,
      label: `0x${formId.toString(16)}`,
      formId,
      assertRange: (fromActorId, maxRange) => rangeUtils.assertRange(fromActorId, formId, maxRange)
    };
  });

  /**
   * Registra um resolvedor para um tipo de alvo que ainda não tem.
   *
   * Chamado no `initialize()` de quem for o dono daquele tipo — `properties`
   * para `property`, `crafting` para `object`, e assim por diante. O core não
   * precisa saber que eles existem.
   *
   * @param {string} targetType
   * @param {(rawTargetId: unknown, actorId: number) => AlvoResolvido|null} resolver
   */
  function registerResolver(targetType, resolver) {
    if (typeof resolver !== 'function') {
      throw new Error(`[interaction-targets] resolvedor de '${targetType}' invalido`);
    }
    if (resolvers.has(targetType)) {
      throw new Error(`[interaction-targets] '${targetType}' ja tem resolvedor`);
    }
    resolvers.set(targetType, resolver);
  }

  /**
   * @param {string} targetType
   * @param {unknown} rawTargetId
   * @param {number} actorId  quem está interagindo
   * @returns {{ok: true, target: AlvoResolvido}|{ok: false, reason: string}}
   */
  function resolve(targetType, rawTargetId, actorId) {
    const resolver = resolvers.get(targetType);
    if (!resolver) {
      // Não é erro de jogador: ou o tipo é válido e ainda não tem dono, ou o
      // cliente mandou um tipo que não existe. A mensagem é a mesma para os
      // dois — descrever a diferença ensinaria a sondar o servidor.
      logger.warn(`[interaction-targets] sem resolvedor para tipo '${targetType}'`);
      return { ok: false, reason: 'Tipo de alvo nao suportado.' };
    }

    let target;
    try {
      target = resolver(rawTargetId, actorId);
    } catch (err) {
      logger.error(`[interaction-targets] resolvedor de '${targetType}' falhou:`, err.message);
      return { ok: false, reason: 'Alvo invalido.' };
    }

    if (!target) return { ok: false, reason: 'Alvo invalido.' };
    return { ok: true, target };
  }

  function supportedTypes() {
    return Array.from(resolvers.keys());
  }

  return { resolve, registerResolver, supportedTypes };
}

module.exports = { createTargetResolvers, parseActorId, parseFormId };
