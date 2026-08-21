/**
 * core/audit-event.js
 *
 * **A taxonomia dos registros do servidor, e o construtor do AuditEvent.**
 *
 * ─── Primeiro: o que a tabela atual de fato tem ─────────────────────────────
 *
 * `audit_logs` nasceu com seis colunas — `id`, `action`, `actor_account_id`,
 * `target_account_id`, `details TEXT`, `created_at` — e três índices
 * (`created_at`, `action+created_at`, `target_account_id+created_at`).
 *
 * Treze sítios de escrita gravam nela hoje, e eles **não são a mesma coisa**:
 *
 *   | o que grava                          | o que realmente é          |
 *   |--------------------------------------|----------------------------|
 *   | `admin:*` (pipeline)                 | AUDIT                      |
 *   | `staff:*` (handlers do admin-service)| AUDIT — e duplica o acima  |
 *   | `governance:*`                       | AUDIT (autoridade IC)      |
 *   | `authz:denied` / `authz:granted`     | SECURITY EVENT             |
 *   | `identity:staff_reveal`              | AUDIT                      |
 *   | `identity:introduce` / `:alias`      | GAMEPLAY EVENT             |
 *   | `rp_chat:*`                          | GAMEPLAY EVENT             |
 *   | `combat:episode` / `:initiate`       | GAMEPLAY EVENT             |
 *   | `death:killer` / `:context` / `:permadeath` | GAMEPLAY EVENT      |
 *   | `soul:resolve`                       | GAMEPLAY EVENT             |
 *   | `interaction:*`                      | GAMEPLAY EVENT             |
 *
 * E `details` carrega **três formatos** ao mesmo tempo: texto livre
 * (`role=admin reason=x`), JSON puro (`combat:*`, `death:*`, `soul:*`,
 * `rp_chat:*`) e o `chave=valor` do pipeline.
 *
 * ─── Por que isso é um problema mensurável, e não estético ──────────────────
 *
 * `GET /api/audit` faz `ORDER BY created_at DESC LIMIT 200`. `rp_chat:*` grava
 * **uma linha por fala** de cada jogador. Com o servidor cheio, as 200 linhas
 * mais recentes são conversa de taverna, e a última ação de staff sai da tela
 * em minutos. A aba "Audit Log" do painel deixa de responder a pergunta para a
 * qual ela existe — sem nada quebrar, sem nenhum erro, sem ninguém perceber.
 *
 * Nenhum índice ajuda: o filtro que separaria os dois é justamente o que a
 * tabela não tem. `action LIKE 'staff:%'` não usa `idx_audit_action_created`
 * como igualdade, e não existe coluna de categoria.
 *
 * ─── A separação, e onde cada coisa passa a viver ───────────────────────────
 *
 * Cinco fluxos, e a decisão para cada um:
 *
 * **APPLICATION LOG** — `console.log`/`error` dos quatro processos. **Continua
 * onde está e não vai para o banco.** Log de aplicação em MySQL é um custo de
 * escrita por linha de diagnóstico, numa tabela que ninguém consulta com
 * `WHERE`. O que falta ali é nível, correlação e destino — e isso é
 * infraestrutura de log, não uma tabela.
 *
 * **AUDIT LOG** — alteração importante e ação administrativa. Vai para
 * `audit_events`, com colunas de verdade. É o que este arquivo constrói.
 *
 * **SECURITY EVENT** — decisão de acesso: negação, concessão sensível, cargo
 * desconhecido, conta inativa. Vai para `audit_events` também, com
 * `category='security'`. Não ganha tabela própria porque tem **exatamente a
 * mesma forma** — ator, alvo, desfecho, severidade — e uma tabela separada
 * obrigaria toda investigação a fazer `UNION` entre duas: "quem tentou e quem
 * conseguiu" é uma pergunta só.
 *
 * **GAMEPLAY EVENT** — chat, combate, morte, alma, interação. **Fica em
 * `audit_logs`**, que passa a ser o fluxo de evento de jogo. Não é elegante e é
 * a escolha certa por ora: mover volume alto para uma tabela nova exige decidir
 * retenção e particionamento, e isso é uma rodada própria. O que muda hoje é
 * que ele para de afogar a auditoria, porque a auditoria saiu de lá.
 *
 * **METRIC** — contadores e histogramas. Continua em memória
 * (`core/voice/voice-metrics.js`), com `renderPrometheus()` esperando quem o
 * sirva. Métrica em tabela relacional é a forma mais cara de guardar número que
 * envelhece em minutos.
 *
 * ─── O que NÃO foi feito, e o custo disso ───────────────────────────────────
 *
 * Os handlers do `admin-service` continuam gravando a própria linha `staff:*`
 * em `audit_logs`, **além** do evento que o pipeline grava. Um `/kick` produz
 * duas linhas em tabelas diferentes.
 *
 * Isso é dívida introduzida na rodada do pipeline e está declarada: remover
 * aquelas chamadas exige reescrever a sonda de treze casos do
 * `permissions.behavior.test.js`, que hoje prova "o handler negou" olhando
 * exatamente aquela linha. Trocar a sonda de um teste que funciona, no mesmo
 * commit que muda a tabela, é como se perde os dois. A linha do pipeline é
 * estritamente mais rica, então `audit_events` já é a fonte completa para as
 * ações roteadas; a de `audit_logs` é redundância, não lacuna.
 */

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Os cinco fluxos
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Declarado como dado, e não só como prosa, porque é o que permite testar que
 * ninguém mandou um evento para o fluxo errado.
 */
const STREAMS = Object.freeze({
  APPLICATION: Object.freeze({
    id: 'application',
    destino: 'stdout do processo',
    exemplo: 'console.error("[voip] socket caiu")',
    noBanco: false
  }),
  AUDIT: Object.freeze({
    id: 'audit',
    destino: 'tabela audit_events',
    exemplo: 'staff expulsou um jogador; whitelist aprovada',
    noBanco: true
  }),
  SECURITY: Object.freeze({
    id: 'security',
    destino: 'tabela audit_events, category=security',
    exemplo: 'permissão negada; cargo desconhecido; conta inativa',
    noBanco: true
  }),
  GAMEPLAY: Object.freeze({
    id: 'gameplay',
    destino: 'tabela audit_logs (o fluxo legado)',
    exemplo: 'fala de RP; episódio de combate; rolagem de alma',
    noBanco: true
  }),
  METRIC: Object.freeze({
    id: 'metric',
    destino: 'memória, via core/voice/voice-metrics.js',
    exemplo: 'quadros de voz por segundo; latência de proximidade',
    noBanco: false
  })
});

// ─────────────────────────────────────────────────────────────────────────────
// Categoria
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A categoria é o **domínio** da ação — o pedaço antes do ponto em
 * `players.kick`. É coluna própria e indexada porque é o filtro mais grosso e
 * mais usado de uma investigação: "o que a staff fez com dinheiro?" não deve
 * exigir `LIKE 'economy.%'`, que não usa índice.
 *
 * Fechada de propósito. Uma categoria livre viraria, em seis meses, quatro
 * grafias para a mesma coisa — que é exatamente o que aconteceu com `details`.
 */
const CATEGORIES = Object.freeze({
  players: 'Ações sobre a presença de um jogador na sessão.',
  characters: 'Ações sobre a ficha de um personagem.',
  inventory: 'Movimentação de item por decisão de staff.',
  economy: 'Movimentação de patrimônio e regras de economia.',
  whitelist: 'Admissão ao servidor.',
  identity: 'Anonimato e revelação.',
  voice: 'Moderação do canal de voz.',
  world: 'Instrumentos de observação e escrita no mundo.',
  staff: 'Concessão e uso de autoridade administrativa.',
  governance: 'Autoridade institucional in-character (guarda, facção, cidade).',
  security: 'Decisões de acesso: negação, concessão sensível, sessão.',
  profession: 'Concessão, revogação e progressão de profissão de personagem.'
});

// ─────────────────────────────────────────────────────────────────────────────
// Severidade
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Quatro níveis. Menos seria não distinguir "aconteceu" de "não se desfaz";
 * mais seria pedir a quem registra uma decisão que ninguém consegue tomar
 * consistentemente.
 */
const SEVERITIES = Object.freeze({
  INFO: 'info',         // aconteceu, reversível, sem consequência de patrimônio
  NOTICE: 'notice',     // mexeu em patrimônio, estado ou admissão
  WARNING: 'warning',   // foi negado, falhou, ou é sinal de sondagem
  CRITICAL: 'critical'  // irreversível, ou concessão de autoridade
});

const SEVERITY_ORDER = Object.freeze(['info', 'notice', 'warning', 'critical']);

/**
 * A severidade **base** de cada ação, antes do desfecho.
 *
 * `critical` é reservado para o que não se desfaz — e a lista é curta de
 * propósito. Se metade das ações fosse crítica, o filtro por severidade não
 * responderia nada.
 *
 * - `identity.reveal` — a única ação de staff que não se desfaz nem por outro
 *   comando nem pelo tempo. Uma identidade revelada passa a morar na cabeça de
 *   quem leu.
 * - `characters.retire` — morte permanente. É soft-delete, mas o personagem
 *   nunca mais entra.
 * - `players.ban` e `staff.manage` — tirar alguém do servidor e conceder
 *   autoridade são as duas decisões que mudam quem pode o quê daqui pra frente.
 */
const BASE_SEVERITY = Object.freeze({
  'identity.reveal': SEVERITIES.CRITICAL,
  'characters.retire': SEVERITIES.CRITICAL,
  'players.ban': SEVERITIES.CRITICAL,
  'staff.manage': SEVERITIES.CRITICAL,

  'economy.adjust': SEVERITIES.NOTICE,
  'economy.recipes': SEVERITIES.NOTICE,
  'inventory.grant': SEVERITIES.NOTICE,
  'inventory.remove': SEVERITIES.NOTICE,
  'whitelist.review': SEVERITIES.NOTICE,
  'players.kick': SEVERITIES.NOTICE,
  'world.probe': SEVERITIES.NOTICE,
  'voice.mute': SEVERITIES.NOTICE,

  // Profissão: todas reversíveis (revogar não é permakill), então `notice` —
  // mexem em estado de personagem sem serem irreversíveis.
  'profession.assign': SEVERITIES.NOTICE,
  'profession.revoke': SEVERITIES.NOTICE,
  'profession.suspend': SEVERITIES.NOTICE,
  'profession.reactivate': SEVERITIES.NOTICE,
  'profession.rank': SEVERITIES.NOTICE,
  'profession.xp': SEVERITIES.NOTICE
});

/** Desfechos possíveis. Espelham os do pipeline — é o mesmo vocabulário. */
const OUTCOMES = Object.freeze(['executed', 'denied', 'invalid', 'blocked', 'failed', 'duplicate']);

/**
 * A severidade final: a base da ação, elevada pelo desfecho.
 *
 * Um `identity.reveal` **negado** não é menos interessante que um executado —
 * é mais: alguém tentou desmascarar um jogador sem poder para isso. Por isso a
 * regra eleva e nunca rebaixa.
 *
 * @param {string} action
 * @param {string} outcome
 */
function resolveSeverity(action, outcome) {
  const base = BASE_SEVERITY[action] || SEVERITIES.INFO;
  const doDesfecho = (outcome === 'denied' || outcome === 'failed')
    ? SEVERITIES.WARNING
    : SEVERITIES.INFO;

  return SEVERITY_ORDER[Math.max(SEVERITY_ORDER.indexOf(base), SEVERITY_ORDER.indexOf(doDesfecho))];
}

// ─────────────────────────────────────────────────────────────────────────────
// Classificação do que já existe
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A que fluxo pertence um nome de ação do formato ANTIGO.
 *
 * Usada pelo backfill da `migration-v17` e pelos testes que provam que a
 * migração não classificou conversa de taverna como auditoria. Ela é a versão
 * executável da tabela no cabeçalho deste arquivo.
 *
 * @param {string} action
 * @returns {{stream: string, category: string|null, action: string}}
 */
function classifyLegacyAction(action) {
  const nome = String(action || '');

  // O formato novo já é `admin:dominio.acao`.
  if (nome.startsWith('admin:')) {
    const capability = nome.slice('admin:'.length);
    return { stream: STREAMS.AUDIT.id, category: capability.split('.')[0] || null, action: capability };
  }
  if (nome.startsWith('authz:')) {
    return { stream: STREAMS.SECURITY.id, category: 'security', action: nome.replace(':', '.') };
  }

  // Ações de staff do vocabulário antigo.
  if (nome.startsWith('staff:')) {
    const verbo = nome.slice('staff:'.length);
    return { stream: STREAMS.AUDIT.id, category: LEGACY_STAFF_CATEGORY[verbo] || 'staff', action: `legacy.${verbo}` };
  }
  if (nome.startsWith('whitelist:')) {
    return { stream: STREAMS.AUDIT.id, category: 'whitelist', action: 'whitelist.review' };
  }
  if (nome.startsWith('governance:')) {
    return { stream: STREAMS.AUDIT.id, category: 'governance', action: nome.replace(':', '.') };
  }
  if (nome === 'identity:staff_reveal') {
    return { stream: STREAMS.AUDIT.id, category: 'identity', action: 'identity.reveal' };
  }

  // Tudo o mais é evento de jogo e permanece em `audit_logs`. A lista é
  // explícita, e não um `else`, para que um nome novo caia no `unknown` abaixo
  // em vez de ser classificado por acidente.
  if (/^(rp_chat|combat|death|soul|interaction|identity|economy|market_stalls):/.test(nome)) {
    return { stream: STREAMS.GAMEPLAY.id, category: null, action: nome };
  }

  return { stream: 'unknown', category: null, action: nome };
}

/** O domínio de cada verbo antigo do `admin-service`. */
const LEGACY_STAFF_CATEGORY = Object.freeze({
  kick: 'players',
  teleport: 'players',
  playAnimation: 'players',
  addItem: 'inventory',
  setGold: 'economy',
  retireCharacter: 'characters',
  voice_mute: 'voice',
  voice_unmute: 'voice',
  voice_diagnostics: 'voice',
  voice_disconnect: 'voice',
  voice_force_reconnect: 'voice'
});

// ─────────────────────────────────────────────────────────────────────────────
// O evento
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {object} AuditEvent
 * @property {string} eventId
 * @property {string|null} correlationId
 * @property {Date} timestamp
 * @property {string|null} sessionId
 * @property {number|null} staffAccountId
 * @property {number|null} staffCharacterId
 * @property {number|null} targetAccountId
 * @property {number|null} targetCharacterId
 * @property {string} category
 * @property {string} action
 * @property {string} severity
 * @property {string|null} permission
 * @property {object|null} before
 * @property {object|null} after
 * @property {string|null} reason
 * @property {object|null} metadata
 * @property {string} source
 * @property {string} outcome
 */

const MAX_REASON = 512;
const MAX_JSON_BYTES = 16 * 1024;

/**
 * Recorta um objeto que vai para coluna JSON.
 *
 * Não é economia de espaço: `details` já provou que um campo sem limite vira o
 * lugar onde alguém despeja um payload inteiro do cliente, e o `soul-service`
 * documenta ter deixado a semente de fora **por segurança**, porque
 * `GET /api/audit` devolvia `details` inteiro para qualquer staff no navegador.
 * Um teto explícito é o que impede o próximo autor de descobrir isso por
 * acidente.
 */
function clampJson(valor) {
  if (valor === null || valor === undefined) return null;
  let texto;
  try {
    texto = JSON.stringify(valor);
  } catch {
    return JSON.stringify({ _erro: 'payload não serializável' });
  }
  if (texto === undefined) return null;
  if (Buffer.byteLength(texto, 'utf8') <= MAX_JSON_BYTES) return texto;
  return JSON.stringify({ _truncado: true, _bytes: Buffer.byteLength(texto, 'utf8') });
}

let _contador = 0;

/**
 * Constrói um `AuditEvent` validado.
 *
 * Lança em erro de programação — categoria fora do catálogo, desfecho
 * desconhecido, ação sem nome. Um evento malformado é pior que um evento
 * ausente: ele entra no registro e mente sobre o que aconteceu.
 *
 * @param {object} entrada
 * @param {() => number} [agora]
 */
function buildAuditEvent(entrada, agora = () => Date.now()) {
  const erro = (msg) => { throw new Error(`[audit-event] ${msg}`); };

  const action = String(entrada.action || '');
  if (!action) erro('evento sem ação');

  const category = entrada.category || action.split('.')[0];
  if (!CATEGORIES[category]) {
    erro(`categoria '${category}' fora do catálogo (ação '${action}'). Conhecidas: ${Object.keys(CATEGORIES).join(', ')}.`);
  }

  const outcome = String(entrada.outcome || 'executed');
  if (!OUTCOMES.includes(outcome)) {
    erro(`desfecho '${outcome}' desconhecido. Conhecidos: ${OUTCOMES.join(', ')}.`);
  }

  const severity = entrada.severity || resolveSeverity(action, outcome);
  if (!SEVERITY_ORDER.includes(severity)) erro(`severidade '${severity}' desconhecida`);

  const ms = agora();
  const eventId = entrada.eventId || `${ms.toString(36)}${(++_contador).toString(36).padStart(4, '0')}`;

  return Object.freeze({
    eventId: String(eventId).slice(0, 64),
    correlationId: entrada.correlationId ? String(entrada.correlationId).slice(0, 128) : null,
    timestamp: entrada.timestamp instanceof Date ? entrada.timestamp : new Date(ms),
    sessionId: entrada.sessionId ? String(entrada.sessionId).slice(0, 128) : null,
    staffAccountId: intOuNulo(entrada.staffAccountId),
    staffCharacterId: intOuNulo(entrada.staffCharacterId),
    targetAccountId: intOuNulo(entrada.targetAccountId),
    targetCharacterId: intOuNulo(entrada.targetCharacterId),
    category,
    action: action.slice(0, 96),
    severity,
    // Coluna e não metadata: "quem usou `identity.reveal`?" é pergunta de
    // segurança, e dentro de JSON ela viraria varredura de tabela.
    permission: entrada.permission ? String(entrada.permission).slice(0, 64) : null,
    before: clampJson(entrada.before),
    after: clampJson(entrada.after),
    reason: entrada.reason ? String(entrada.reason).slice(0, MAX_REASON) : null,
    metadata: clampJson(entrada.metadata),
    source: String(entrada.source || 'unknown').slice(0, 16),
    outcome
  });
}

function intOuNulo(valor) {
  const n = Number(valor);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * A ordem das colunas do `INSERT`. Exportada porque o escritor e o teste
 * precisam concordar sobre ela, e uma divergência aqui grava `reason` na coluna
 * de `source` sem erro nenhum — foi a classe de bug que a `migration-v15` já
 * produziu no ledger de ouro.
 */
const COLUMNS = Object.freeze([
  'event_id', 'correlation_id', 'occurred_at', 'session_id',
  'staff_account_id', 'staff_character_id', 'target_account_id', 'target_character_id',
  'category', 'action', 'severity', 'outcome', 'source', 'permission',
  'reason', 'before_state', 'after_state', 'metadata'
]);

/** @param {ReturnType<buildAuditEvent>} evento */
function toRow(evento) {
  return [
    evento.eventId, evento.correlationId, evento.timestamp, evento.sessionId,
    evento.staffAccountId, evento.staffCharacterId, evento.targetAccountId, evento.targetCharacterId,
    evento.category, evento.action, evento.severity, evento.outcome, evento.source, evento.permission,
    evento.reason, evento.before, evento.after, evento.metadata
  ];
}

const INSERT_SQL =
  `INSERT INTO audit_events (${COLUMNS.map((c) => `\`${c}\``).join(', ')}) ` +
  `VALUES (${COLUMNS.map(() => '?').join(', ')})`;

/**
 * O escritor. Recebe `db` injetado — o gamemode passa o `database.js` dele, o
 * painel passa o helper do pool do Express.
 *
 * @param {{query: (sql: string, params: any[]) => Promise<any>}} db
 * @param {Pick<Console,'error'>} [logger]
 */
function createAuditEventStore(db, logger = console) {
  /** @param {object} entrada */
  async function record(entrada) {
    const evento = buildAuditEvent(entrada);
    try {
      await db.query(INSERT_SQL, toRow(evento));
      return { ok: true, eventId: evento.eventId };
    } catch (err) {
      // Fail-open, e continua declarado: uma auditoria que falha não pode
      // desfazer um efeito que já aconteceu nem transformar negação em
      // permissão. A diferença para antes é que agora há UM lugar onde essa
      // escolha vive — o dia em que as ações `critical` precisarem de
      // fail-closed, é esta função que muda.
      logger.error(`[audit-event] falha ao gravar '${evento.action}' (${evento.eventId}):`, err.message);
      return { ok: false, eventId: evento.eventId, error: err.message };
    }
  }

  return { record, INSERT_SQL, COLUMNS };
}

module.exports = {
  STREAMS,
  CATEGORIES,
  SEVERITIES,
  SEVERITY_ORDER,
  OUTCOMES,
  BASE_SEVERITY,
  LEGACY_STAFF_CATEGORY,
  MAX_JSON_BYTES,
  MAX_REASON,
  resolveSeverity,
  classifyLegacyAction,
  buildAuditEvent,
  createAuditEventStore,
  toRow,
  COLUMNS,
  INSERT_SQL
};
