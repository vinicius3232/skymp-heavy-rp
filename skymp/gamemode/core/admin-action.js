/**
 * core/admin-action.js
 *
 * **A camada por onde toda ação administrativa passa.**
 *
 * ─── O que este arquivo NÃO é ───────────────────────────────────────────────
 *
 * Não é um monólito administrativo, e a diferença é o ponto inteiro do desenho.
 * Nenhuma regra de domínio mora aqui: este módulo não sabe expulsar ninguém, não
 * sabe mover ouro, não conhece `mp`, não conhece banco e não importa nenhum
 * serviço. Ele recebe descritores de ação — cada um apontando para o serviço de
 * domínio que **já existe e já funciona** — e garante que as mesmas oito etapas
 * aconteçam, na mesma ordem, com o mesmo registro, venha a ação de onde vier.
 *
 * O `admin-service`, o `governance-service` e o `transaction-service` continuam
 * exatamente como estão. O que muda é que deixam de ser chamados direto por
 * quatro superfícies diferentes, cada uma com o próprio jeito de resolver quem
 * está pedindo.
 *
 * ─── O pipeline ─────────────────────────────────────────────────────────────
 *
 *   WEB · DISCORD · COMMAND · API      ← a origem só entrega texto cru
 *              ↓
 *        ADMIN ACTION                  ← o envelope, montado aqui
 *              ↓
 *          SESSION                     ← quem é você? resolvido no servidor
 *              ↓
 *        PERMISSION                    ← core/permissions.js, fonte única
 *              ↓
 *        VALIDATION                    ← motivo e parâmetros, contra o descritor
 *              ↓
 *          TARGET                      ← quem é o alvo? resolvido no servidor
 *              ↓
 *           STATE                      ← a ação faz sentido agora?
 *              ↓
 *      DOMAIN SERVICE                  ← o serviço que já existia, intacto
 *              ↓
 *       TRANSACTION                    ← efeito confirmado antes de registrar
 *              ↓
 *           AUDIT                      ← sempre, inclusive quando falha
 *              ↓
 *          RESULT
 *
 * ─── A regra que dá sentido a tudo: nada de identidade vem de fora ──────────
 *
 * A superfície entrega **apenas**: qual ação, um handle de sessão que ela mesma
 * não escolhe (o `actorId` de quem digitou, o `req` de quem tem cookie), o alvo
 * como texto cru, o motivo e os parâmetros.
 *
 * Ela **nunca** entrega cargo, `accountId`, `characterId` nem estado do alvo.
 * Esses quatro são resolvidos aqui, contra o servidor, em toda invocação —
 * mesmo quando a superfície "já sabe". Um painel que manda `{accountId: 1,
 * role: 'owner'}` está mandando um desejo, não um fato, e a diferença entre as
 * duas coisas é o que separa autorização de decoração.
 *
 * Isso vale inclusive para a superfície mais confiável do projeto: o comando de
 * chat, cujo `actorId` vem do próprio motor. Mesmo ali o `characterId` e o
 * `accountId` são resolvidos, porque o `actorId` é reaproveitado entre sessões
 * pelo SkyMP — foi essa reutilização que já fez um cargo de admin ficar preso a
 * um slot e ser herdado por quem entrasse depois.
 *
 * ─── O que o pipeline acrescenta que não existia ────────────────────────────
 *
 * 1. **Negação com etapa nomeada.** Antes, "não aconteceu" era um `undefined` e
 *    uma notificação. Agora todo caminho que não executa diz em qual etapa
 *    parou e por quê, no `Result` e no `audit_logs`.
 * 2. **Registro em um formato só.** O achado dos "cinco escritores, quatro
 *    formatos" não se resolve reescrevendo os cinco; resolve-se dando ao
 *    próximo — e a quem migrar — um lugar onde o formato é decidido uma vez.
 * 3. **Idempotência por `correlationId`.** Duplo clique no painel, retry do
 *    Discord, comando repetido: a segunda invocação com o mesmo id devolve
 *    `duplicate` em vez de aplicar duas vezes.
 * 4. **Motivo obrigatório onde precisa ser.** Hoje `/permakill` exige motivo e
 *    `/kick` aceita "Sem motivo" — duas regras para a mesma classe de ato,
 *    porque cada handler decidiu sozinho. Agora é uma linha do descritor.
 *
 * ─── Sobre a etapa TRANSACTION, dita sem eufemismo ──────────────────────────
 *
 * **O pipeline não abre transação, e isso é deliberado.** Todo serviço de
 * domínio que move patrimônio já é dono da transação dele através do
 * `core/transaction-service`, que é o único lugar do projeto autorizado a
 * segurar uma conexão. Envolver `setGold` numa transação externa aninharia duas
 * e quebraria a única propriedade que aquele serviço garante.
 *
 * O que esta etapa faz de real: ela é onde o **desfecho** é decidido e onde a
 * idempotência é confirmada. Um `execute` que lança nunca marca o
 * `correlationId` como consumido — então a ação pode ser reenviada com o mesmo
 * id depois que a causa da falha for resolvida, em vez de ficar presa achando
 * que já aconteceu.
 *
 * Quando aparecer uma ação que precise de atomicidade entre dois serviços, o
 * lugar dela é aqui, e o descritor ganha `transactional: true`. Nenhuma ação de
 * hoje precisa, e por isso o parâmetro não existe: construí-lo agora seria uma
 * porta esperando por uma chave que ninguém pediu.
 */

'use strict';

const permissions = require('./permissions');

// ─────────────────────────────────────────────────────────────────────────────
// Vocabulário
// ─────────────────────────────────────────────────────────────────────────────

/**
 * De onde a ação chegou.
 *
 * Não é decorativo: ele entra no `audit_logs` e é a diferença entre "a staff
 * expulsou alguém de dentro do jogo" e "alguém expulsou pelo painel de fora".
 * Numa arbitragem contestada isso importa tanto quanto quem e quando.
 */
const SOURCES = Object.freeze({
  WEB: 'web',
  DISCORD: 'discord',
  COMMAND: 'command',
  API: 'api'
});

/** As etapas, na ordem. Um desfecho que não é `executed` sempre nomeia uma. */
const STAGES = Object.freeze({
  SESSION: 'session',
  PERMISSION: 'permission',
  VALIDATION: 'validation',
  TARGET: 'target',
  STATE: 'state',
  EXECUTE: 'execute',
  TRANSACTION: 'transaction',
  AUDIT: 'audit'
});

/**
 * Desfechos. Cinco, e a distinção entre eles é operacional:
 *
 * - `denied`    — a pessoa não podia. É o material de `security.review`.
 * - `invalid`   — o pedido estava malformado. É erro de quem chamou.
 * - `blocked`   — o pedido estava certo e o mundo disse não (alvo ausente,
 *                 estado incompatível). Não é culpa de ninguém.
 * - `failed`    — o serviço de domínio quebrou. É incidente.
 * - `duplicate` — já aconteceu com este `correlationId`.
 *
 * Colapsá-los num `false` foi o que fez `hasPermission` e `removeGold`
 * devolverem a mesma coisa para "não pode" e "o banco caiu" — e, no caso da
 * multa da guarda, um timeout de rede virar mandado de prisão contra quem tinha
 * o dinheiro.
 */
const OUTCOMES = Object.freeze({
  EXECUTED: 'executed',
  DENIED: 'denied',
  INVALID: 'invalid',
  BLOCKED: 'blocked',
  FAILED: 'failed',
  DUPLICATE: 'duplicate'
});

/** Como o motivo é tratado por ação. */
const REASON = Object.freeze({
  REQUIRED: 'required',
  OPTIONAL: 'optional',
  NONE: 'none'
});

const ACTION_ID_SHAPE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)+$/;

const MAX_REASON_LENGTH = 512;

// ─────────────────────────────────────────────────────────────────────────────
// Descritores
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tipos de parâmetro aceitos. Pequeno de propósito: um validador genérico
 * completo é uma dependência, e o que passa por aqui são argumentos de comando
 * de staff — inteiros, FormIDs e texto curto.
 *
 * @type {Record<string, (raw: unknown, rule: any) => {ok: true, value: any}|{ok: false, reason: string}>}
 */
const PARAM_TYPES = {
  integer(raw, rule) {
    const n = typeof raw === 'string' ? Number.parseInt(raw, 10) : raw;
    if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isInteger(n)) {
      return { ok: false, reason: 'esperado um número inteiro' };
    }
    if (rule.min !== undefined && n < rule.min) return { ok: false, reason: `mínimo ${rule.min}` };
    if (rule.max !== undefined && n > rule.max) return { ok: false, reason: `máximo ${rule.max}` };
    return { ok: true, value: n };
  },

  /**
   * FormID do Skyrim, aceito em hexadecimal com ou sem `0x`.
   *
   * Separado de `integer` porque a base é 16 e porque o erro que ele previne é
   * específico: `/additem <id> 15 1` com o `15` lido como decimal entrega um
   * item diferente do que a staff quis, e o servidor grava sem reclamar. A
   * validação de que o FormID existe de verdade continua sendo do
   * `core/espm.js`, no serviço de domínio — aqui só a forma.
   */
  formId(raw) {
    if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) return { ok: true, value: raw };
    if (typeof raw !== 'string') return { ok: false, reason: 'esperado um FormID' };
    const limpo = raw.toLowerCase().startsWith('0x') ? raw.slice(2) : raw;
    if (!/^[0-9a-f]{1,8}$/i.test(limpo)) return { ok: false, reason: 'FormID deve ser hexadecimal' };
    return { ok: true, value: Number.parseInt(limpo, 16) };
  },

  string(raw, rule) {
    if (typeof raw !== 'string') return { ok: false, reason: 'esperado texto' };
    const limpo = raw.trim();
    // `oneOf` antes do tamanho: quando o campo é um conjunto fechado, dizer
    // "máximo 255 caracteres" sobre `aproved` esconde que o problema é o
    // conjunto, não o tamanho.
    if (rule.oneOf && !rule.oneOf.includes(limpo)) {
      return { ok: false, reason: `esperado um de: ${rule.oneOf.join(', ')}` };
    }
    if (rule.minLength !== undefined && limpo.length < rule.minLength) {
      return { ok: false, reason: `mínimo ${rule.minLength} caracteres` };
    }
    if (limpo.length > (rule.maxLength || 255)) {
      return { ok: false, reason: `máximo ${rule.maxLength || 255} caracteres` };
    }
    return { ok: true, value: limpo };
  },

  boolean(raw) {
    if (typeof raw === 'boolean') return { ok: true, value: raw };
    if (raw === 'true') return { ok: true, value: true };
    if (raw === 'false') return { ok: true, value: false };
    return { ok: false, reason: 'esperado true ou false' };
  }
};

/**
 * Declara uma ação administrativa.
 *
 * A validação é feita **aqui**, na definição, e não na primeira invocação. Um
 * descritor com a permissão errada produziria uma ação que nega para sempre, e
 * o sintoma seria "o comando parou de funcionar para o owner" — descoberto por
 * alguém tentando trabalhar. Assim o processo não sobe.
 *
 * @param {object} d
 * @param {string} d.id            `players.kick` — identifica a AÇÃO, não a invocação
 * @param {string} d.permission    capability do catálogo
 * @param {string} [d.description]
 * @param {'player'|'account'|'none'} [d.target]
 * @param {'required'|'optional'|'none'} [d.reason]
 * @param {Record<string, any>} [d.parameters]
 * @param {Function} [d.precondition]  ({session, target, parameters}) => {ok, reason?}
 * @param {Function} d.execute         (ctx) => {ok, data?, message?} | throws
 * @param {Function} [d.auditDetail]   (ctx, result) => string
 */
function defineAdminAction(d) {
  const erro = (msg) => { throw new Error(`[admin-action] ${msg}`); };

  if (!d || typeof d !== 'object') erro('descritor ausente');
  if (!ACTION_ID_SHAPE.test(String(d.id))) {
    erro(`id inválido '${d.id}': esperado 'dominio.acao' minúsculo`);
  }
  if (!permissions.CAPABILITIES[d.permission]) {
    erro(
      `ação '${d.id}' exige a permissão '${d.permission}', que não existe no catálogo. ` +
      `Ativas: ${permissions.activePermissions().join(', ')}.`
    );
  }
  if (permissions.CAPABILITIES[d.permission].status === 'reserved') {
    erro(
      `ação '${d.id}' exige '${d.permission}', que está RESERVADA — ela nega para todo cargo, ` +
      `inclusive owner. Uma ação atrás de uma reservada é uma ação que ninguém pode executar.`
    );
  }
  if (typeof d.execute !== 'function') erro(`ação '${d.id}' sem execute`);

  const target = d.target || 'none';
  if (!['player', 'account', 'none'].includes(target)) erro(`ação '${d.id}' com target inválido '${target}'`);

  const reason = d.reason || REASON.NONE;
  if (!Object.values(REASON).includes(reason)) erro(`ação '${d.id}' com reason inválido '${reason}'`);

  const parameters = d.parameters || {};
  for (const [nome, regra] of Object.entries(parameters)) {
    if (!PARAM_TYPES[regra.type]) {
      erro(`ação '${d.id}', parâmetro '${nome}': tipo '${regra.type}' desconhecido. ` +
           `Conhecidos: ${Object.keys(PARAM_TYPES).join(', ')}.`);
    }
  }

  return Object.freeze({
    id: d.id,
    permission: d.permission,
    description: d.description || '',
    target,
    reason,
    parameters: Object.freeze(parameters),
    precondition: d.precondition || null,
    execute: d.execute,
    auditDetail: d.auditDetail || null
  });
}

/** Um registro de ações. Cada processo tem o seu — o painel não conhece as do jogo. */
function createAdminActionRegistry() {
  const _acoes = new Map();

  function register(descriptor) {
    const acao = defineAdminAction(descriptor);
    if (_acoes.has(acao.id)) throw new Error(`[admin-action] ação '${acao.id}' registrada duas vezes`);
    _acoes.set(acao.id, acao);
    return acao;
  }

  return {
    register,
    get: (id) => _acoes.get(id) || null,
    has: (id) => _acoes.has(id),
    list: () => [..._acoes.values()],
    ids: () => [..._acoes.keys()],
    size: () => _acoes.size
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// O envelope
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `AdminAction` — o que atravessa o pipeline.
 *
 * Sobre `actionId` × `action`, porque os dois nomes convidam à confusão:
 *
 *   - **`action`** é o NOME da ação: `players.kick`. Estável, repetido em toda
 *     invocação, é por ele que se pergunta "quantos kicks houve?".
 *   - **`actionId`** identifica ESTA invocação. Único, gerado aqui, é por ele
 *     que se acha uma linha específica no registro.
 *   - **`correlationId`** liga invocações relacionadas — a mesma decisão de
 *     staff atravessando painel e jogo, ou o retry de um clique. É o único
 *     campo que a superfície pode fornecer, e é **exclusivamente** para
 *     rastreio e deduplicação: nunca entra em nenhuma decisão de autorização.
 *
 * @typedef {object} AdminAction
 * @property {string} actionId
 * @property {string} correlationId
 * @property {string|null} sessionId
 * @property {number|null} staffAccountId
 * @property {number|null} staffCharacterId
 * @property {string} permission
 * @property {string} action
 * @property {object|null} target
 * @property {string|null} reason
 * @property {object} parameters
 * @property {string} source
 * @property {string} requestedAt
 */

// ─────────────────────────────────────────────────────────────────────────────
// O pipeline
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} deps
 * @param {ReturnType<createAdminActionRegistry>} deps.registry
 * @param {(source: string, sourceRef: any) => Promise<object|null>} deps.resolveSession
 *   Recebe o handle cru da superfície e devolve
 *   `{sessionId, staffAccountId, staffCharacterId, role}` — ou `null`.
 *   **Toda** identidade sai daqui; nada dela pode vir do pedido.
 * @param {(kind: string, ref: unknown, ctx: object) => Promise<object|null>} [deps.resolveTarget]
 * @param {(entry: object) => Promise<void>} deps.audit
 * @param {() => number} [deps.now]
 * @param {() => string} [deps.newId]
 * @param {number} [deps.idempotencyTtlMs]
 * @param {Pick<Console,'warn'|'error'>} [deps.logger]
 */
function createAdminActionPipeline(deps) {
  const {
    registry,
    resolveSession,
    resolveTarget = async () => null,
    audit,
    now = () => Date.now(),
    idempotencyTtlMs = 5 * 60 * 1000,
    logger = console
  } = deps;

  if (!registry) throw new Error('[admin-action] pipeline sem registry');
  if (typeof resolveSession !== 'function') throw new Error('[admin-action] pipeline sem resolveSession');
  if (typeof audit !== 'function') throw new Error('[admin-action] pipeline sem audit');

  let _contador = 0;
  const newId = deps.newId || (() => `${now().toString(36)}-${(++_contador).toString(36)}`);

  /**
   * `correlationId` já consumido → `expiraEm`.
   *
   * A chave inclui o `staffAccountId`. Sem isso, um `correlationId` escolhido
   * por quem chama viraria uma forma de suprimir a ação de OUTRA pessoa: bastava
   * enviar antes, com o id que ela usaria. Escopado por conta, o pior caso é
   * alguém deduplicar as próprias ações, que é o comportamento pedido.
   *
   * @type {Map<string, number>}
   */
  const _consumidos = new Map();

  function _podarIdempotencia(agora) {
    for (const [chave, expiraEm] of _consumidos) {
      if (expiraEm <= agora) _consumidos.delete(chave);
    }
  }

  /** Monta o desfecho e registra. Todo caminho de saída passa por aqui. */
  async function _finalizar(envelope, outcome, stage, detail, data) {
    const entrada = {
      action: envelope.action,
      actionId: envelope.actionId,
      correlationId: envelope.correlationId,
      sessionId: envelope.sessionId,
      staffAccountId: envelope.staffAccountId,
      staffCharacterId: envelope.staffCharacterId,
      permission: envelope.permission,
      target: envelope.target,
      reason: envelope.reason,
      parameters: envelope.parameters,
      source: envelope.source,
      requestedAt: envelope.requestedAt,
      outcome,
      stage,
      detail: detail || null
    };

    try {
      await audit(entrada);
    } catch (err) {
      // A auditoria não pode desfazer um efeito que já aconteceu, e não pode
      // transformar uma negação em permissão. Ela grita e o desfecho segue.
      //
      // Isto é fail-open declarado, e é a mesma escolha que `admin-service
      // .auditLog` já fazia. A diferença é que aqui ela está num lugar só: o dia
      // em que o projeto quiser fail-closed para as ações irreversíveis, é esta
      // função que muda, não cinco.
      logger.error(`[admin-action] falha ao auditar '${envelope.action}' (${envelope.actionId}):`, err.message);
    }

    return Object.freeze({
      ok: outcome === OUTCOMES.EXECUTED,
      outcome,
      stage,
      action: envelope.action,
      actionId: envelope.actionId,
      correlationId: envelope.correlationId,
      detail: detail || null,
      data: data === undefined ? null : data
    });
  }

  /**
   * Executa uma ação administrativa.
   *
   * @param {object} pedido
   * @param {string} pedido.action     nome da ação registrada
   * @param {string} pedido.source     um de SOURCES
   * @param {any} pedido.sourceRef     handle de sessão da superfície (actorId, req, …)
   * @param {unknown} [pedido.targetRef] o alvo como a superfície o recebeu, cru
   * @param {string} [pedido.reason]
   * @param {object} [pedido.parameters]
   * @param {string} [pedido.correlationId]
   */
  async function run(pedido) {
    const agora = now();
    const requestedAt = new Date(agora).toISOString();

    // O envelope nasce com o que ainda não foi resolvido em `null`. Ele é
    // preenchido etapa por etapa, e é ele — nunca o `pedido` — que chega ao
    // serviço de domínio.
    /** @type {any} */
    const envelope = {
      actionId: newId(),
      correlationId: typeof pedido.correlationId === 'string' && pedido.correlationId
        ? pedido.correlationId.slice(0, 128)
        : newId(),
      sessionId: null,
      staffAccountId: null,
      staffCharacterId: null,
      permission: null,
      action: String(pedido.action || ''),
      target: null,
      reason: null,
      parameters: {},
      source: String(pedido.source || ''),
      requestedAt
    };

    // ── Ação e origem ────────────────────────────────────────────────────────
    if (!Object.values(SOURCES).includes(envelope.source)) {
      return _finalizar(envelope, OUTCOMES.INVALID, STAGES.VALIDATION,
        `origem desconhecida '${envelope.source}'`);
    }
    const acao = registry.get(envelope.action);
    if (!acao) {
      return _finalizar(envelope, OUTCOMES.INVALID, STAGES.VALIDATION,
        `ação não registrada '${envelope.action}'`);
    }
    envelope.permission = acao.permission;

    // ── SESSION ──────────────────────────────────────────────────────────────
    // Nada de identidade vem do pedido. Nem aqui, nem depois.
    let sessao;
    try {
      sessao = await resolveSession(envelope.source, pedido.sourceRef);
    } catch (err) {
      logger.error(`[admin-action] resolveSession falhou para '${envelope.action}':`, err.message);
      return _finalizar(envelope, OUTCOMES.FAILED, STAGES.SESSION, 'falha ao resolver a sessão');
    }
    if (!sessao) {
      return _finalizar(envelope, OUTCOMES.DENIED, STAGES.SESSION, 'sem sessão de staff');
    }
    envelope.sessionId = sessao.sessionId ?? null;
    envelope.staffAccountId = sessao.staffAccountId ?? null;
    envelope.staffCharacterId = sessao.staffCharacterId ?? null;

    // ── PERMISSION ───────────────────────────────────────────────────────────
    // Contra o cargo que a SESSÃO trouxe, nunca contra um cargo do pedido.
    const decisao = permissions.decide(sessao.role, acao.permission);
    if (!decisao.allowed) {
      return _finalizar(envelope, OUTCOMES.DENIED, STAGES.PERMISSION, decisao.reason);
    }

    // ── Idempotência ─────────────────────────────────────────────────────────
    // Depois da permissão: quem não pode executar também não pode consumir um
    // `correlationId` e bloquear a próxima tentativa de quem pode.
    _podarIdempotencia(agora);
    const chaveIdem = `${envelope.staffAccountId}:${envelope.action}:${envelope.correlationId}`;
    if (_consumidos.has(chaveIdem)) {
      return _finalizar(envelope, OUTCOMES.DUPLICATE, STAGES.TRANSACTION,
        'correlationId já consumido');
    }

    // ── VALIDATION ───────────────────────────────────────────────────────────
    const motivoCru = typeof pedido.reason === 'string' ? pedido.reason.trim() : '';
    if (acao.reason === REASON.REQUIRED && !motivoCru) {
      return _finalizar(envelope, OUTCOMES.INVALID, STAGES.VALIDATION, 'motivo é obrigatório');
    }
    if (acao.reason === REASON.NONE && motivoCru) {
      // Não é rejeição por rigor: um motivo guardado numa ação que não o exibe
      // vira texto que ninguém lê e que ninguém sabe que existe.
      logger.warn(`[admin-action] '${acao.id}' recebeu motivo e não usa motivo; ignorado.`);
    }
    envelope.reason = acao.reason === REASON.NONE ? null : (motivoCru.slice(0, MAX_REASON_LENGTH) || null);

    const brutos = pedido.parameters && typeof pedido.parameters === 'object' ? pedido.parameters : {};

    // Chave desconhecida é recusa, não silêncio. Um parâmetro que o descritor
    // não declara é ou erro de quem chamou, ou tentativa de alcançar um caminho
    // que a ação não expõe — e as duas merecem parar aqui.
    for (const nome of Object.keys(brutos)) {
      if (!acao.parameters[nome]) {
        return _finalizar(envelope, OUTCOMES.INVALID, STAGES.VALIDATION,
          `parâmetro desconhecido '${nome}'`);
      }
    }

    for (const [nome, regra] of Object.entries(acao.parameters)) {
      const cru = brutos[nome];
      if (cru === undefined || cru === null || cru === '') {
        if (regra.required) {
          return _finalizar(envelope, OUTCOMES.INVALID, STAGES.VALIDATION,
            `parâmetro '${nome}' é obrigatório`);
        }
        if (regra.default !== undefined) envelope.parameters[nome] = regra.default;
        continue;
      }
      const veredito = PARAM_TYPES[regra.type](cru, regra);
      if (veredito.ok === false) {
        return _finalizar(envelope, OUTCOMES.INVALID, STAGES.VALIDATION,
          `parâmetro '${nome}': ${veredito.reason}`);
      }
      envelope.parameters[nome] = veredito.value;
    }

    // ── TARGET ───────────────────────────────────────────────────────────────
    // O alvo chega como texto e sai como fato resolvido no servidor. O
    // `characterId` e o `accountId` do alvo NUNCA vêm do pedido — é o que
    // impede uma superfície de pedir uma ação contra a ficha de outra pessoa.
    if (acao.target !== 'none') {
      let alvo;
      try {
        alvo = await resolveTarget(acao.target, pedido.targetRef, { action: acao, session: sessao });
      } catch (err) {
        logger.error(`[admin-action] resolveTarget falhou para '${acao.id}':`, err.message);
        return _finalizar(envelope, OUTCOMES.FAILED, STAGES.TARGET, 'falha ao resolver o alvo');
      }
      if (!alvo) {
        return _finalizar(envelope, OUTCOMES.BLOCKED, STAGES.TARGET, 'alvo não encontrado');
      }
      envelope.target = alvo;
    }

    // ── STATE ────────────────────────────────────────────────────────────────
    if (acao.precondition) {
      let veredito;
      try {
        veredito = await acao.precondition({
          session: sessao, target: envelope.target, parameters: envelope.parameters, envelope
        });
      } catch (err) {
        logger.error(`[admin-action] precondition de '${acao.id}' lançou:`, err.message);
        return _finalizar(envelope, OUTCOMES.FAILED, STAGES.STATE, 'falha ao checar o estado');
      }
      if (veredito && veredito.ok === false) {
        return _finalizar(envelope, OUTCOMES.BLOCKED, STAGES.STATE, veredito.reason || 'estado incompatível');
      }
    }

    // ── DOMAIN SERVICE ───────────────────────────────────────────────────────
    // O serviço que já existia, chamado com dados que o servidor resolveu.
    let resultado;
    try {
      resultado = await acao.execute({
        session: sessao,
        target: envelope.target,
        parameters: envelope.parameters,
        reason: envelope.reason,
        envelope
      });
    } catch (err) {
      logger.error(`[admin-action] '${acao.id}' lançou:`, err.message);
      // O `correlationId` NÃO é consumido: a ação pode ser reenviada com o
      // mesmo id depois que a causa da falha for resolvida.
      return _finalizar(envelope, OUTCOMES.FAILED, STAGES.EXECUTE, err.message);
    }

    // ── TRANSACTION ──────────────────────────────────────────────────────────
    // O desfecho é decidido aqui, e a idempotência é confirmada só no sucesso.
    if (resultado && resultado.ok === false) {
      return _finalizar(envelope, OUTCOMES.BLOCKED, STAGES.EXECUTE,
        resultado.reason || 'o serviço de domínio recusou');
    }
    _consumidos.set(chaveIdem, agora + idempotencyTtlMs);

    // ── AUDIT + RESULT ───────────────────────────────────────────────────────
    const detalhe = acao.auditDetail
      ? acao.auditDetail({ session: sessao, target: envelope.target, parameters: envelope.parameters }, resultado)
      : null;

    return _finalizar(envelope, OUTCOMES.EXECUTED, STAGES.AUDIT, detalhe,
      resultado && resultado.data !== undefined ? resultado.data : null);
  }

  return { run, registry, _consumidos };
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatação do registro
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A linha de `audit_logs.details`, em um formato só.
 *
 * `chave=valor` separado por espaço, com o motivo entre aspas por ser o único
 * campo de texto livre. Não é JSON porque `details` é `TEXT` e já carrega quatro
 * formatos diferentes escritos por cinco módulos — mudar para JSON exigiria
 * migrar os antigos ou conviver com dois. Este formato é legível por olho, por
 * `grep` e por um parser de dez linhas, que é o que o painel vai precisar.
 *
 * @param {object} entrada
 */
function formatAuditDetail(entrada) {
  const campos = [
    ['correlation', entrada.correlationId],
    ['permission', entrada.permission],
    ['source', entrada.source],
    ['outcome', entrada.outcome],
    ['stage', entrada.stage],
    ['session', entrada.sessionId],
    ['staffChar', entrada.staffCharacterId],
    ['target', entrada.target ? (entrada.target.label ?? entrada.target.id ?? null) : null],
    ['targetChar', entrada.target ? (entrada.target.characterId ?? null) : null]
  ];

  const params = Object.entries(entrada.parameters || {});
  for (const [nome, valor] of params) campos.push([`p.${nome}`, valor]);

  if (entrada.detail) campos.push(['detail', entrada.detail]);

  const partes = campos
    .filter(([, valor]) => valor !== null && valor !== undefined && valor !== '')
    .map(([chave, valor]) => `${chave}=${String(valor).replace(/\s+/g, '_')}`);

  // O motivo vai por último e entre aspas: é o único campo com espaço legítimo.
  if (entrada.reason) partes.push(`reason="${String(entrada.reason).replace(/"/g, "'")}"`);

  return partes.join(' ');
}

module.exports = {
  SOURCES,
  STAGES,
  OUTCOMES,
  REASON,
  PARAM_TYPES,
  defineAdminAction,
  createAdminActionRegistry,
  createAdminActionPipeline,
  formatAuditDetail,
  MAX_REASON_LENGTH
};
