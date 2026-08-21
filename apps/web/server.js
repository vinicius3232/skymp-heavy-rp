const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '.env') });
require('dotenv').config({ path: path.resolve(__dirname, '../../skymp/gamemode/.env') });
const express = require('express');
const session = require('express-session');
const mysql   = require('mysql2/promise');
const cors    = require('cors');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;

const app  = express();
const PORT = process.env.PANEL_PORT || 3001;
const INTERNAL_API_SECRET = requireEnv('INTERNAL_API_SECRET');
// O bot escuta em 127.0.0.1 (ver apps/bot-discord/index.js). Configurável porque
// nem sempre painel e bot rodam no mesmo host.
const BOT_INTERNAL_URL = process.env.BOT_INTERNAL_URL || 'http://127.0.0.1:3002';
// Allowlist dos redirect_uri aceitos em /api/launcher/oauth/exchange. O launcher
// sobe um servidor de callback local em 127.0.0.1:19847 (ver electron/main.ts).
const LAUNCHER_REDIRECT_URIS = (process.env.LAUNCHER_REDIRECT_URIS || 'http://localhost:19847/callback,http://127.0.0.1:19847/callback')
  .split(',')
  .map((uri) => uri.trim())
  .filter(Boolean);
const CRASH_REPORT_DIR = path.join(__dirname, 'crash-reports');
// Identifica o servidor de jogo no contrato de master API do SkyMP. Precisa
// bater com `masterKey` do skymp/config/server-settings.*.json.
const MASTER_KEY = process.env.MASTER_KEY || null;

/** Comparação em tempo constante, tolerante a tamanhos diferentes. */
function safeEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be set`);
  }
  return value;
}

// ── DB Pool ────────────────────────────────────────────────────────────────
const pool = mysql.createPool({
  host:     process.env.DB_HOST     || '127.0.0.1',
  port:     process.env.DB_PORT     || 3306,
  user:     process.env.DB_USER     || 'root',
  password: process.env.DB_PASS     || '',
  database: process.env.DB_NAME     || 'skymp_rp',
  waitForConnections: true,
  connectionLimit: 5
});

const db = async (sql, params = []) => {
  const [rows] = await pool.execute(sql, params);
  return rows;
};

const fsp = fs.promises;

async function ensureCrashReportDir() {
  await fsp.mkdir(CRASH_REPORT_DIR, { recursive: true });
}

// ── Rate limiting simples (janela deslizante em memória) ────────────────────
const rateLimitBuckets = new Map();
function isRateLimited(key, maxRequests, windowMs) {
  const now = Date.now();
  const timestamps = (rateLimitBuckets.get(key) || []).filter((t) => now - t < windowMs);
  timestamps.push(now);
  rateLimitBuckets.set(key, timestamps);
  return timestamps.length > maxRequests;
}

function sanitizeCrashText(value, maxLength) {
  return String(value || '').replace(/\0/g, '').slice(0, maxLength);
}

function normalizeCrashReport(body) {
  const crashes = Array.isArray(body.crashes) ? body.crashes.slice(0, 3) : [];
  return {
    id: `${Date.now()}-${crypto.randomUUID()}`,
    receivedAt: new Date().toISOString(),
    discordId: sanitizeCrashText(body.discordId, 64) || null,
    username: sanitizeCrashText(body.username, 120) || null,
    clientVersion: sanitizeCrashText(body.clientVersion, 80) || null,
    launcherVersion: sanitizeCrashText(body.launcherVersion, 80) || null,
    crashes: crashes.map((crash) => ({
      filename: sanitizeCrashText(crash.filename || crash.name, 160).replace(/[\\/:*?"<>|]/g, '_') || 'crash.log',
      mtime: Number(crash.mtime) || null,
      content: sanitizeCrashText(crash.content, 65000)
    })).filter((crash) => crash.content.length > 0)
  };
}

// ── Middleware ─────────────────────────────────────────────────────────────
if (process.env.TRUST_PROXY === 'true' || process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}
// A origem era `http://localhost:${PORT}` fixo, o que quebra assim que o painel
// sai da máquina de desenvolvimento. Em produção informe o domínio real em
// PANEL_PUBLIC_URL (aceita lista separada por vírgula pra apex + www).
const CORS_ORIGINS = (process.env.PANEL_PUBLIC_URL || `http://localhost:${PORT}`)
  .split(',')
  .map((origin) => origin.trim().replace(/\/+$/, ''))
  .filter(Boolean);

app.use(cors({ origin: CORS_ORIGINS, credentials: true }));
app.use(express.json({ limit: '512kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: requireEnv('SESSION_SECRET'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 8 * 60 * 60 * 1000 // 8h
  }
}));

// ── Auth via Discord OAuth ───────────────────────────────────────────────────
app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(new DiscordStrategy({
    clientID: requireEnv('DISCORD_CLIENT_ID'),
    clientSecret: requireEnv('DISCORD_CLIENT_SECRET'),
    // Precisa bater EXATAMENTE com a Redirect URI cadastrada no portal do
    // Discord, senão a autenticação falha com `invalid_request`.
    callbackURL: process.env.DISCORD_CALLBACK_URL || `${CORS_ORIGINS[0]}/api/auth/discord/callback`,
    scope: ['identify']
}, async (accessToken, refreshToken, profile, done) => {
    try {
        const rows = await db('SELECT account_id FROM discord_identities WHERE discord_id = ?', [profile.id]);
        let accountId;
        if (rows.length === 0) {
            const [accRes] = await pool.execute('INSERT INTO accounts (status) VALUES (?)', ['active']);
            accountId = accRes.insertId;
            await pool.execute('INSERT INTO discord_identities (discord_id, account_id, username, avatar) VALUES (?, ?, ?, ?)', [profile.id, accountId, profile.username, profile.avatar || '']);
        } else {
            accountId = rows[0].account_id;
            await pool.execute('UPDATE discord_identities SET username = ?, avatar = ? WHERE discord_id = ?', [profile.username, profile.avatar || '', profile.id]);
        }
        
        return done(null, { id: profile.id, username: profile.username, avatar: profile.avatar, accountId });
    } catch(err) {
        return done(err, null);
    }
}));

function requireAuth(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) return next();
  res.status(401).json({ error: 'Não autenticado' });
}

// ── Autorização ──────────────────────────────────────────────────────────────
//
// A autoridade de staff é derivada EXCLUSIVAMENTE da tabela `staff_roles`, e o
// mapa cargo→permissão vem de `skymp/gamemode/core/permissions.js` — o mesmo
// catálogo que o gamemode consulta. Não há uma segunda tabela aqui.
//
// O campo `vip_level` em `accounts` é SOMENTE para monetização (VIP/Apoiador) e
// NUNCA é critério de permissão administrativa. A regra não mudou; o que mudou é
// que agora existe um lugar só onde ela pode ser quebrada.
//
// `requireStaff` foi REMOVIDO. Ele aceitava qualquer cargo e protegia doze
// rotas, incluindo a única mutável. Ver `apps/web/permissions.js`.
const { createAuthorization, catalog: authorizationCatalog } = require('./permissions');
const {
  requirePermission,
  recordDecision: recordAuthzDecision,
  // O mesmo resolvedor que o middleware usa, reaproveitado pelo pipeline de
  // ações. Duas leituras diferentes de `staff_roles` no mesmo processo seriam a
  // divergência que este trabalho existe para remover.
  resolveStaff
} = createAuthorization({ db });

app.get('/api/auth/discord', passport.authenticate('discord'));
app.get('/api/auth/discord/callback', passport.authenticate('discord', {
    failureRedirect: '/?error=auth_failed'
}), (req, res) => {
    res.redirect('/');
});

app.post('/api/auth/logout', (req, res) => {
  req.logout((err) => {
    if(err) { console.error('[logout]', err); return res.status(500).json({ error: 'Erro interno do servidor' }); }
    req.session.destroy(() => res.json({ ok: true }));
  });
});

// Rotas do Jogador Público
app.get('/api/me', requireAuth, async (req, res) => {
    try {
        const appRows = await db('SELECT * FROM whitelist_applications WHERE account_id = ? ORDER BY id DESC LIMIT 1', [req.user.accountId]);
        const application = appRows.length > 0 ? appRows[0] : null;
        res.json({
            user: req.user,
            application
        });
    } catch (err) { console.error('[/api/me]', err); res.status(500).json({ error: 'Erro interno do servidor' }); }
});

// Heurística best-effort: sinaliza conceitos fortes pra staff olhar com mais
// atenção antes de aprovar (rubrica de whitelist Heavy RP). Não é um gate
// automático — só marca needs_extra_review pra staff decidir na revisão.
const STRONG_CONCEPT_PATTERN = new RegExp(
  [
    'nobre', 'noble', 'jarl', 'th[aã]ne',
    'vampir', 'vampire',
    'lobisomem', 'werewolf',
    'daedra', 'daedric',
    'mago poderoso', 'archmage', 'arquimago',
    'assassino', 'assassin',
    'l[ií]der de fac[cç][aã]o', 'faction leader'
  ].join('|'),
  'i'
);

function detectsStrongConcept(...texts) {
  const combined = texts.filter(Boolean).join(' ');
  return STRONG_CONCEPT_PATTERN.test(combined);
}

// Limites alinhados com o schema (VARCHAR/TEXT) e com a rubrica de whitelist:
// um campo vazio ou de 1 caractere não é uma ficha, e um campo maior que o
// tipo da coluna estoura no INSERT e vira 500 sem explicação pro jogador.
const APPLY_FIELDS = {
  first_name:  { required: true,  min: 2, max: 60,   label: 'Nome' },
  last_name:   { required: true,  min: 2, max: 60,   label: 'Sobrenome' },
  biography:   { required: true,  min: 80, max: 5000, label: 'Biografia' },
  // Obrigatórios também no servidor, não só no `required` do apply.html — o
  // formulário é só a UI, e a rubrica de whitelist trata ficha sem motivação,
  // fraqueza ou laço social como reprovada de saída.
  motivations: { required: true,  min: 30, max: 2000, label: 'Motivações' },
  weaknesses:  { required: true,  min: 30, max: 2000, label: 'Fraquezas' },
  social_ties: { required: true,  min: 30, max: 2000, label: 'Laços sociais' }
};

function validateApplication(body) {
  const clean = {};
  for (const [field, rule] of Object.entries(APPLY_FIELDS)) {
    const value = typeof body[field] === 'string' ? body[field].trim() : '';
    if (!value) {
      if (rule.required) return { error: `${rule.label} é obrigatório.` };
      clean[field] = null;
      continue;
    }
    if (value.length < rule.min) return { error: `${rule.label} precisa de pelo menos ${rule.min} caracteres.` };
    if (value.length > rule.max) return { error: `${rule.label} passa do limite de ${rule.max} caracteres.` };
    clean[field] = value;
  }
  return { clean };
}

app.post('/api/apply', requireAuth, async (req, res) => {
    const { error: validationError, clean } = validateApplication(req.body || {});
    if (validationError) return res.status(400).json({ error: validationError });
    const { first_name, last_name, biography, motivations, weaknesses, social_ties } = clean;
    try {
        const existing = await db('SELECT status FROM whitelist_applications WHERE account_id = ? ORDER BY id DESC LIMIT 1', [req.user.accountId]);
        if (existing.length > 0 && (existing[0].status === 'pending' || existing[0].status === 'approved')) {
            return res.status(400).json({ error: 'Você já possui uma aplicação pendente ou aprovada.' });
        }

        const needsExtraReview = detectsStrongConcept(biography, motivations, weaknesses, social_ties) ? 1 : 0;

        await pool.execute(
            `INSERT INTO characters
               (account_id, first_name, last_name, biography, motivations, weaknesses, social_ties, needs_extra_review, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [req.user.accountId, first_name, last_name, biography, motivations, weaknesses, social_ties, needsExtraReview, 'pending']
        );

        await pool.execute(
            'INSERT INTO whitelist_applications (account_id, status) VALUES (?, ?)',
            [req.user.accountId, 'pending']
        );

        res.json({ ok: true });
    } catch (err) { console.error('[/api/apply]', err); res.status(500).json({ error: 'Erro interno do servidor' }); }
});

// ── API: Dashboard ─────────────────────────────────────────────────────────
app.get('/api/dashboard', requirePermission('server.view'), async (req, res) => {
  try {
    const [accounts]    = await pool.execute('SELECT COUNT(*) as c FROM accounts');
    const [chars]       = await pool.execute('SELECT COUNT(*) as c FROM characters');
    const [pending]     = await pool.execute("SELECT COUNT(*) as c FROM whitelist_applications WHERE status='pending'");
    // `DATE(created_at)=CURDATE()` envolve a coluna numa função, o que impede o
    // MySQL de usar índice — vira varredura da tabela inteira, justamente a que
    // mais cresce no projeto. A comparação por intervalo faz o mesmo recorte e
    // consegue usar `idx_audit_created` (migration v7).
    const [auditToday]  = await pool.execute(
      "SELECT COUNT(*) as c FROM audit_logs WHERE created_at >= CURDATE() AND created_at < CURDATE() + INTERVAL 1 DAY"
    );
    const [prisoners]   = await pool.execute("SELECT COUNT(*) as c FROM prison_records WHERE status='active'");
    const [factions]    = await pool.execute('SELECT COUNT(*) as c FROM factions');
    res.json({
      accounts:    accounts[0].c,
      characters:  chars[0].c,
      pending:     pending[0].c,
      auditToday:  auditToday[0].c,
      prisoners:   prisoners[0].c,
      factions:    factions[0].c
    });
  } catch (err) { console.error('[/api/dashboard]', err); res.status(500).json({ error: 'Erro interno do servidor' }); }
});

// ── API: Whitelist ─────────────────────────────────────────────────────────
app.get('/api/whitelist', requirePermission('whitelist.view'), async (req, res) => {
  try {
    const rows = await db(
      `SELECT wa.id, wa.status, wa.created_at, wa.reviewer_notes,
              d.username as discord_name, d.discord_id,
              c.first_name, c.last_name, c.biography, c.motivations, c.weaknesses,
              c.social_ties, c.needs_extra_review, c.extra_review_notes
       FROM whitelist_applications wa
       LEFT JOIN accounts a ON a.id = wa.account_id
       LEFT JOIN discord_identities d ON d.account_id = a.id
       LEFT JOIN characters c ON c.account_id = a.id
       ORDER BY wa.status='pending' DESC, wa.created_at DESC
       LIMIT 100`
    );
    res.json(rows);
  } catch (err) { console.error('[/api/whitelist GET]', err); res.status(500).json({ error: 'Erro interno do servidor' }); }
});

/**
 * Manda um evento pro canal de log de moderacao do Discord (via bot).
 *
 * Manda e esquece: nao retorna promessa pra quem chama e engole todo erro. O
 * registro de verdade e `audit_logs`; o canal e notificacao. Ver
 * `apps/bot-discord/moderationLog.js` e ARCHITECTURE.md 1.3.
 */
function notifyModerationLog(evento) {
    fetch(`${BOT_INTERNAL_URL}/api/moderation-log`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Internal-Secret': INTERNAL_API_SECRET
        },
        body: JSON.stringify({ ...evento, source: 'painel', at: new Date().toISOString() })
    }).catch(e => console.error('[web] Falha ao enviar log de moderacao:', e.message));
}

/**
 * Sincroniza o cargo de whitelist no Discord.
 *
 * Extraido para ca porque a acao passou a viver em `admin-actions.js` e ele nao
 * conhece — nem deve conhecer — a URL do bot nem o segredo interno. Engole o
 * proprio erro, como sempre engoliu: a decisao de whitelist ja esta gravada, e
 * o Discord fora do ar nao pode desfaze-la.
 */
async function syncDiscordRole(discordId, status) {
  try {
    await fetch(`${BOT_INTERNAL_URL}/api/sync-role`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': INTERNAL_API_SECRET },
      body: JSON.stringify({ discord_id: discordId, status })
    });
  } catch (e) {
    console.error('[web] Falha ao notificar o Bot do Discord:', e.message);
  }
}

// ── Acoes administrativas do painel ──────────────────────────────────────────
//
// A revisao de whitelist e a UNICA rota mutavel de staff do painel, e passou a
// atravessar o pipeline comum (`skymp/gamemode/core/admin-action.js`): sessao,
// permissao, validacao, alvo, estado, servico de dominio, desfecho, auditoria.
//
// O handler nao sumiu nem foi reescrito — ele foi movido para o `execute` da
// acao, com o mesmo SQL e a mesma ordem. O que ele perdeu foi o proprio
// `INSERT INTO audit_logs` (agora e o pipeline que audita, com correlationId,
// permissao e desfecho) e o `if (idRows.length > 0)`, porque uma aplicacao
// inexistente nao chega mais ao dominio: ela para na etapa TARGET.
const { createWebAdminActions, resultToHttp } = require('./admin-actions');
const webAdminActions = createWebAdminActions({
  db, resolveStaff, notifyModerationLog, syncDiscordRole
});

app.patch('/api/whitelist/:id', requirePermission('whitelist.review'), async (req, res) => {
  // O corpo entrega intencao, nunca identidade. `status` e as notas sao
  // parametros; quem esta pedindo e contra quem sao resolvidos no servidor.
  const resultado = await webAdminActions.pipeline.run({
    action: 'whitelist.review',
    source: 'web',
    sourceRef: req,
    targetRef: req.params.id,
    reason: (req.body || {}).reviewer_notes,
    parameters: {
      status: (req.body || {}).status,
      extraReviewNotes: (req.body || {}).extra_review_notes
    },
    // Aceito do cliente e usado SO para deduplicar e rastrear. Nunca entra em
    // nenhuma decisao de autorizacao, e e escopado por conta dentro do pipeline.
    correlationId: (req.body || {}).correlationId
  });

  return resultToHttp(res, resultado);
});

// ── API: Personagens ───────────────────────────────────────────────────────
app.get('/api/characters', requirePermission('characters.view'), async (req, res) => {
  try {
    const search = req.query.q ? `%${req.query.q}%` : '%';
    const rows = await db(
      `SELECT c.id, c.first_name, c.last_name, c.status, c.gold, c.created_at,
              d.username as discord_name
       FROM characters c
       LEFT JOIN accounts a ON a.id = c.account_id
       LEFT JOIN discord_identities d ON d.account_id = a.id
       WHERE c.first_name LIKE ? OR c.last_name LIKE ? OR d.username LIKE ?
       ORDER BY c.created_at DESC LIMIT 50`,
      [search, search, search]
    );
    res.json(rows);
  } catch (err) { console.error('[/api/characters]', err); res.status(500).json({ error: 'Erro interno do servidor' }); }
});

// ── API: Auditoria ──────────────────────────────────────────────────────────
//
// Lê `audit_events`, não `audit_logs`. A diferença não é de tabela, é de
// pergunta respondida: `audit_logs` recebe treze escritores que não gravam a
// mesma coisa, e `rp_chat:*` grava uma linha por FALA de cada jogador — o
// `LIMIT 200` desta rota devolvia conversa de taverna com o servidor cheio, e a
// última ação de staff saía da tela em minutos. Ver `core/audit-event.js`.
//
// Onze eixos de filtro, todos indexados, todos parametrizados, e filtro
// desconhecido é `400` em vez de ser ignorado — ignorar faria um nome errado
// (`?staff_account_id=5`) devolver a tabela inteira parecendo resultado
// filtrado.
const auditSearch = require('./audit-search');

app.get('/api/audit', requirePermission('audit.view', { auditGrant: true }), async (req, res) => {
  try {
    const { sql, params, limit, applied } = auditSearch.buildSearch(req.query);
    const rows = await db(sql, params);
    res.json({
      events: rows,
      // O cursor da próxima página. `null` quando acabou — o cliente não
      // precisa adivinhar comparando o tamanho com o limite.
      nextBefore: rows.length === limit ? rows[rows.length - 1].id : null,
      applied
    });
  } catch (err) {
    // Erro de filtro é do cliente e precisa dizer o quê; erro de banco é nosso
    // e não deve vazar SQL. O construtor lança `Error` simples para o primeiro.
    if (err instanceof Error && !/^ER_|ECONN/.test(err.code || '')) {
      return res.status(400).json({ error: err.message });
    }
    console.error('[/api/audit]', err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

/**
 * O detalhe de um evento — o único lugar que devolve `before`, `after` e
 * `metadata`.
 *
 * Eles ficam fora da listagem porque carregam até 16 KB cada, e 500 linhas com
 * os três seriam 24 MB no navegador de quem só queria ver o que aconteceu
 * ontem. O `soul-service` já documenta a mesma lição pelo lado da segurança:
 * ele deixou a semente fora do `details` porque esta rota devolvia o campo
 * inteiro para qualquer staff.
 */
app.get('/api/audit/event/:eventId', requirePermission('audit.view', { auditGrant: true }), async (req, res) => {
  try {
    const { sql, params } = auditSearch.buildSearch({ eventId: req.params.eventId, limit: 1 }, { detail: true });
    const rows = await db(sql, params);
    if (rows.length === 0) return res.status(404).json({ error: 'Evento não encontrado' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[/api/audit/event]', err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

/**
 * Contagem por categoria, severidade e desfecho — o resumo que uma tela de
 * revisão de segurança abre antes de filtrar qualquer coisa.
 */
app.get('/api/audit/summary', requirePermission('audit.view'), async (req, res) => {
  try {
    const { sql, params } = auditSearch.buildSummary(req.query);
    res.json(await db(sql, params));
  } catch (err) {
    if (err instanceof Error && !/^ER_|ECONN/.test(err.code || '')) {
      return res.status(400).json({ error: err.message });
    }
    console.error('[/api/audit/summary]', err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

/**
 * O fluxo de EVENTO DE JOGO, que continua em `audit_logs`.
 *
 * Rota separada e nome honesto: `audit_logs` deixou de ser a auditoria e passou
 * a ser o registro de chat, combate, morte, alma e interação. Ela existe para
 * que a evidência de RDM que o `death-service` produz continue alcançável — e
 * para que ninguém precise ler duas tabelas achando que lê uma.
 *
 * `governance.view` e não `audit.view`: são registros do mundo, não da staff.
 */
app.get('/api/events/gameplay', requirePermission('governance.view'), async (req, res) => {
  try {
    const rows = await db(
      `SELECT al.id, al.action, al.details, al.created_at,
              da.username as actor_name, dt.username as target_name
       FROM audit_logs al
       LEFT JOIN discord_identities da ON da.account_id = al.actor_account_id
       LEFT JOIN discord_identities dt ON dt.account_id = al.target_account_id
       ORDER BY al.created_at DESC LIMIT 200`
    );
    res.json(rows);
  } catch (err) { console.error('[/api/events/gameplay]', err); res.status(500).json({ error: 'Erro interno do servidor' }); }
});

// ── API: Economia / Holds ──────────────────────────────────────────────────
app.get('/api/economy/holds', requirePermission('economy.view'), async (req, res) => {
  try {
    const rows = await db(
      `SELECT h.id, h.name, h.tax_rate, h.treasury,
              f.tag as faction_tag, f.name as faction_name
       FROM holds h
       LEFT JOIN factions f ON f.id = h.ruling_faction_id
       ORDER BY h.name`
    );
    res.json(rows);
  } catch (err) { console.error('[/api/economy/holds]', err); res.status(500).json({ error: 'Erro interno do servidor' }); }
});

app.get('/api/economy/top-gold', requirePermission('economy.view', { auditGrant: true }), async (req, res) => {
  try {
    const rows = await db(
      `SELECT c.first_name, c.last_name, c.gold, d.username
       FROM characters c
       LEFT JOIN accounts a ON a.id = c.account_id
       LEFT JOIN discord_identities d ON d.account_id = a.id
       ORDER BY c.gold DESC LIMIT 10`
    );
    res.json(rows);
  } catch (err) { console.error('[/api/economy/top-gold]', err); res.status(500).json({ error: 'Erro interno do servidor' }); }
});

// ── API: Fichas Criminais ──────────────────────────────────────────────────
app.get('/api/criminal', requirePermission('governance.view'), async (req, res) => {
  try {
    const rows = await db(
      `SELECT cr.id, cr.crime, cr.bounty, cr.hold, cr.resolved, cr.created_at,
              c.first_name, c.last_name
       FROM criminal_records cr
       INNER JOIN characters c ON c.id = cr.character_id
       ORDER BY cr.resolved ASC, cr.created_at DESC LIMIT 100`
    );
    res.json(rows);
  } catch (err) { console.error('[/api/criminal]', err); res.status(500).json({ error: 'Erro interno do servidor' }); }
});

// ── API: Facções ───────────────────────────────────────────────────────────
app.get('/api/factions', requirePermission('governance.view'), async (req, res) => {
  try {
    const rows = await db(
      `SELECT f.id, f.tag, f.name, f.treasury, f.color_hex, f.created_at,
              COUNT(fm.id) as member_count
       FROM factions f
       LEFT JOIN faction_members fm ON fm.faction_id = f.id
       GROUP BY f.id ORDER BY member_count DESC`
    );
    res.json(rows);
  } catch (err) { console.error('[/api/factions]', err); res.status(500).json({ error: 'Erro interno do servidor' }); }
});

// ── API: Presos Ativos ─────────────────────────────────────────────────────
app.get('/api/prison', requirePermission('governance.view'), async (req, res) => {
  try {
    const rows = await db(
      `SELECT pr.id, pr.sentence_minutes, pr.time_served_minutes, pr.crime_summary,
              pr.status, pr.arrested_at,
              c.first_name, c.last_name
       FROM prison_records pr
       INNER JOIN characters c ON c.id = pr.character_id
       WHERE pr.status='active'
       ORDER BY pr.arrested_at DESC`
    );
    res.json(rows);
  } catch (err) { console.error('[/api/prison]', err); res.status(500).json({ error: 'Erro interno do servidor' }); }
});

// API: Crash reports do launcher
const CRASH_REPORT_MAX_BYTES = 256 * 1024;
const CRASH_REPORT_MAX_FILES = parseInt(process.env.CRASH_REPORT_MAX_FILES || '500', 10);
const CRASH_REPORT_MAX_AGE_DAYS = parseInt(process.env.CRASH_REPORT_MAX_AGE_DAYS || '30', 10);

/**
 * Remove relatórios antigos demais ou excedentes.
 *
 * Dois limites em vez de um: a idade evita guardar log de uma versão do cliente
 * que nem existe mais, e a contagem protege contra uma enxurrada num intervalo
 * curto — um bug de crash em loop pode gerar centenas de relatórios no mesmo
 * dia, e só o limite de idade não seguraria isso.
 *
 * Falha aqui nunca deve derrubar o recebimento: perder a poda é irrelevante
 * perto de perder o relatório.
 */
async function pruneCrashReports() {
  const names = (await fsp.readdir(CRASH_REPORT_DIR)).filter((name) => name.endsWith('.json'));

  const entries = [];
  for (const name of names) {
    const fullPath = path.join(CRASH_REPORT_DIR, name);
    try {
      const stat = await fsp.stat(fullPath);
      entries.push({ fullPath, mtimeMs: stat.mtimeMs });
    } catch { /* sumiu no meio do caminho: nada a podar */ }
  }

  const cutoff = Date.now() - CRASH_REPORT_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const doomed = new Set(entries.filter((e) => e.mtimeMs < cutoff).map((e) => e.fullPath));

  // Do mais novo pro mais velho; o que passar do teto entra na lista.
  const survivors = entries
    .filter((e) => !doomed.has(e.fullPath))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const extra of survivors.slice(CRASH_REPORT_MAX_FILES)) {
    doomed.add(extra.fullPath);
  }

  for (const fullPath of doomed) {
    try { await fsp.unlink(fullPath); } catch { /* concorrência: já foi */ }
  }

  if (doomed.size > 0) {
    console.log(`[crash-reports] ${doomed.size} relatorio(s) antigo(s) removido(s).`);
  }
  return doomed.size;
}
app.post('/api/crashes/client', async (req, res) => {
  try {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    if (isRateLimited(`crashes:${ip}`, 10, 60 * 1000)) {
      return res.status(429).json({ ok: false, error: 'Muitas requisições, tente novamente mais tarde.' });
    }

    const contentLength = Number(req.get('content-length') || 0);
    if (contentLength > CRASH_REPORT_MAX_BYTES) {
      return res.status(413).json({ ok: false, error: 'Payload muito grande' });
    }

    const report = normalizeCrashReport(req.body || {});
    if (report.crashes.length === 0) return res.status(400).json({ ok: false, error: 'Nenhum crash valido recebido' });

    await ensureCrashReportDir();
    const filePath = path.join(CRASH_REPORT_DIR, `${report.id}.json`);
    await fsp.writeFile(filePath, JSON.stringify(report, null, 2));

    // Sem isto o diretório cresce pra sempre: cada relatório carrega até 64 KB
    // de log por crash, e um cliente instável reporta em série. Rodar depois da
    // escrita (e não em cron) mantém a limpeza acoplada ao que a causa.
    pruneCrashReports().catch((err) => console.error('[crash-reports] Falha ao podar:', err.message));

    res.json({ ok: true, id: report.id, received: report.crashes.length });
  } catch (err) {
    console.error('[/api/crashes/client]', err);
    res.status(500).json({ ok: false, error: 'Erro interno do servidor' });
  }
});

app.get('/api/crashes', requirePermission('security.view', { auditGrant: true }), async (req, res) => {
  try {
    await ensureCrashReportDir();
    const names = (await fsp.readdir(CRASH_REPORT_DIR)).filter((name) => name.endsWith('.json'));

    const reports = [];
    for (const name of names) {
      const fullPath = path.join(CRASH_REPORT_DIR, name);
      try {
        const raw = JSON.parse(await fsp.readFile(fullPath, 'utf8'));
        reports.push({
          id: raw.id,
          receivedAt: raw.receivedAt,
          discordId: raw.discordId,
          username: raw.username,
          clientVersion: raw.clientVersion,
          launcherVersion: raw.launcherVersion,
          files: Array.isArray(raw.crashes) ? raw.crashes.map((crash) => ({
            filename: crash.filename,
            mtime: crash.mtime,
            bytes: String(crash.content || '').length
          })) : []
        });
      } catch (fileErr) {
        console.error(`[/api/crashes] Arquivo corrompido ignorado: ${name}`, fileErr.message);
      }
    }

    reports.sort((a, b) => String(b.receivedAt).localeCompare(String(a.receivedAt)));
    res.json(reports.slice(0, 100));
  } catch (err) {
    console.error('[/api/crashes]', err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// ── API: Master (contrato do SkyMP) ──────────────────────────────────────────
//
// Este endpoint não foi inventado por nós: é o contrato que o servidor SkyMP
// chama quando `offlineMode: false` (ver skymp5-server/ts/systems/login.ts
// upstream). O servidor pega o `gameData.session` que o cliente mandou e
// pergunta ao master quem é aquela pessoa. O `user.id` que respondermos vira o
// `profileId` do gamemode.
//
// É isso que tira a identidade das mãos do cliente. Sem este endpoint, o
// caminho é `offlineMode: true`, onde o cliente simplesmente declara o próprio
// `profileId` no `skymp_config.json` e o servidor acredita.
//
// O `master` padrão do SkyMP é `https://gateway.skymp.net`. Apontar para o
// nosso painel é só trocar a string em `server-settings.json` — e faz sentido,
// porque o painel já é quem autentica o Discord e aprova a whitelist.
app.get('/api/servers/:masterKey/sessions/:session', async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';

  // Comparação em tempo constante: a masterKey identifica o servidor de jogo
  // e não deve vazar por diferença de tempo de resposta.
  if (!MASTER_KEY || !safeEquals(req.params.masterKey, MASTER_KEY)) {
    console.warn(`[master-api] masterKey invalida vinda de ${ip}`);
    return res.status(404).json({ error: 'Unknown server' });
  }

  if (isRateLimited(`master-session:${ip}`, 120, 60 * 1000)) {
    return res.status(429).json({ error: 'Too many requests' });
  }

  try {
    const session = req.params.session;
    if (typeof session !== 'string' || session.length < 32) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const rows = await db(
      `SELECT id, account_id, discord_id FROM game_sessions
       WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > NOW()`,
      [hashTicket(session)]
    );

    // 404 é o que o SkyMP espera pra sessão inválida: ele manda
    // `loginFailedSessionNotFound` pro cliente, que é a mensagem correta.
    if (rows.length === 0) return res.status(404).json({ error: 'Session not found' });

    // Contabiliza o uso. `resolve_count` alto é sinal de sessão compartilhada
    // entre máquinas — vale olhar quando aparecer.
    await db(
      'UPDATE game_sessions SET last_resolved_at = NOW(), resolve_count = resolve_count + 1 WHERE id = ?',
      [rows[0].id]
    );

    // A forma da resposta é ditada pelo SkyMP, não por nós: `data.user.id`.
    res.json({ user: { id: rows[0].account_id, discordId: rows[0].discord_id } });
  } catch (err) {
    console.error('[master-api] /sessions', err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// ── API interna: autorização para os outros processos ────────────────────────
//
// O bot do Discord precisava saber se alguém é staff e não tem — nem deve ter —
// acesso ao banco. Antes disso ele respondia sozinho: `voiceChannels.js` aceitava
// quem tivesse o cargo `STAFF_ROLE_ID` **do Discord** ou a permissão
// `Administrator` da guild. Era uma quarta fonte de autoridade, fora do
// `staff_roles`, e a auditoria a marcou como precedente a não repetir
// (`docs/admin/SKYADMIN_CURRENT_STATE.md`, seção do bot).
//
// A correção não é dar banco ao bot: é o painel — que já é quem autentica o
// Discord e já lê `staff_roles` — responder a pergunta. O bot passa a perguntar,
// e a resposta vem do mesmo catálogo que decide tudo o mais.
//
// Ele NÃO recebe sessão nem cookie: a fronteira aqui é o `X-Internal-Secret`,
// como em todos os outros endpoints entre processos deste projeto. O Discord ID
// vem do corpo porque é o bot quem sabe quem clicou no comando.
app.post('/internal/authorize', async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';

  if (isRateLimited(`authorize:${ip}`, 120, 60 * 1000)) {
    return res.status(429).json({ error: 'Too many requests' });
  }
  if (!safeEquals(req.get('X-Internal-Secret') || '', INTERNAL_API_SECRET)) {
    console.warn(`[authz] Tentativa nao autorizada em /internal/authorize de ${ip}`);
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { discordId, permission } = req.body || {};
  if (typeof discordId !== 'string' || !discordId) return res.status(400).json({ error: 'discordId ausente' });
  if (typeof permission !== 'string' || !permission) return res.status(400).json({ error: 'permission ausente' });

  try {
    const rows = await db(
      `SELECT a.id AS account_id, a.status AS account_status, sr.role AS role
         FROM discord_identities di
         INNER JOIN accounts a ON a.id = di.account_id
         LEFT JOIN staff_roles sr ON sr.account_id = a.id
        WHERE di.discord_id = ?
        LIMIT 1`,
      [discordId]
    );

    // Conta desconhecida e conta inativa negam do mesmo jeito para quem
    // pergunta, e diferente no registro. O bot não precisa da distinção; quem
    // for auditar depois, sim.
    const conta = rows[0] || null;
    const elegivel = conta && conta.account_status === 'active';
    const decision = elegivel
      ? authorizationCatalog.decide(conta.role, permission)
      : { allowed: false, reason: conta ? `account_${conta.account_status}` : 'account_not_found', role: null };

    if (!decision.allowed) {
      await recordAuthzDecision('denied', {
        accountId: conta ? conta.account_id : null,
        permission, role: conta ? conta.role : null,
        method: 'POST', route: '/internal/authorize', reason: decision.reason
      });
    }

    // O cargo volta junto para o bot poder dizer "você é moderador e isso é de
    // admin" em vez de um "não pode" sem explicação. Nunca voltam as
    // capabilities de outra pessoa nem o account_id.
    res.json({ allowed: decision.allowed, role: decision.allowed ? conta.role : null, reason: decision.reason || null });
  } catch (err) {
    console.error('[authz] /internal/authorize', err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// ── API: Launcher ────────────────────────────────────────────────────────────

// Tempo de vida do ticket de lançamento: ele só precisa sobreviver do clique em
// "Jogar" até a entrada na fila. Curto porque nada nele exige durar mais.
const LAUNCH_TICKET_TTL_MS = 5 * 60 * 1000;

function hashTicket(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Emite um ticket de uso único ligado a uma conta. Guarda só o hash — se o
 * banco vazar, os tickets em voo não viram credencial utilizável.
 */
async function issueLaunchTicket(accountId, discordId, issuedIp) {
  const token = crypto.randomBytes(32).toString('hex');
  await db(
    `INSERT INTO launch_tickets (token_hash, account_id, discord_id, expires_at, issued_ip)
     VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND), ?)`,
    [hashTicket(token), accountId, discordId, Math.floor(LAUNCH_TICKET_TTL_MS / 1000), issuedIp || null]
  );
  return token;
}


// Troca do `code` do OAuth do Discord por um perfil, feita pelo painel.
//
// O launcher é um app de desktop distribuído aos jogadores: qualquer segredo
// embutido nele (era `VITE_DISCORD_CLIENT_SECRET`) pode ser extraído do
// instalador por qualquer pessoa que baixe o jogo, e com o secret em mãos dá pra
// se passar pela aplicação no Discord. O secret fica só aqui, no servidor.
//
// O launcher manda `{ code, redirect_uri }` e recebe de volta apenas os dados
// públicos do usuário — nunca o access_token do Discord, que não tem uso do lado
// dele e só aumentaria a superfície de vazamento.
app.post('/api/launcher/oauth/exchange', async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (isRateLimited(`oauth-exchange:${ip}`, 10, 60 * 1000)) {
    return res.status(429).json({ error: 'Muitas tentativas, aguarde um minuto.' });
  }

  const { code, redirect_uri } = req.body || {};
  if (typeof code !== 'string' || !code) return res.status(400).json({ error: 'code ausente' });
  if (typeof redirect_uri !== 'string' || !redirect_uri) return res.status(400).json({ error: 'redirect_uri ausente' });

  // Só aceitamos os redirect_uri que nós mesmos registramos. Sem isso, um code
  // roubado poderia ser trocado apontando pra um endereço controlado por terceiro.
  if (!LAUNCHER_REDIRECT_URIS.includes(redirect_uri)) {
    return res.status(400).json({ error: 'redirect_uri não permitido' });
  }

  try {
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri
      })
    });

    if (!tokenRes.ok) return res.status(401).json({ error: 'Falha ao autenticar no Discord.' });
    const token = await tokenRes.json();
    if (!token.access_token) return res.status(401).json({ error: 'Falha ao autenticar no Discord.' });

    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${token.access_token}` }
    });
    if (!userRes.ok) return res.status(401).json({ error: 'Falha ao ler o perfil do Discord.' });
    const user = await userRes.json();
    if (!user.id) return res.status(401).json({ error: 'Falha ao ler o perfil do Discord.' });

    // A conta precisa existir antes de emitir ticket — quem nunca passou pelo
    // painel não tem whitelist, então não tem o que fazer na fila.
    const accountRows = await db('SELECT account_id FROM discord_identities WHERE discord_id = ?', [user.id]);
    const accountId = accountRows.length > 0 ? accountRows[0].account_id : null;

    const profile = {
      discordId: user.id,
      username: user.username,
      globalName: user.global_name || user.username,
      avatar: user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png` : null
    };

    // Só o painel tem o client secret, logo só ele consegue provar que aquele
    // Discord de fato autenticou. O ticket carrega essa prova até a fila
    // (apps/game-api), que não teria como verificar nada sozinha.
    if (accountId) {
      profile.launchTicket = await issueLaunchTicket(accountId, user.id, ip);
    }

    res.json(profile);
  } catch (err) {
    console.error('[/api/launcher/oauth/exchange]', err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Aqui existia um `GET /api/launcher/manifest` que devolvia um manifesto fixo
// com `hash: "dummy_hash_for_testing"`. Nada o consumia: o launcher real
// (apps/launcher/electron/main.ts) busca o manifesto de cliente e de mods em
// GitHub Releases (VITE_GITHUB_DIST_REPO) e a paridade de modpack em
// `http://<SERVER_IP>:<VITE_API_PORT>/mods.json`. Manter um stub com hash falso
// num painel que também serve autenticação era só um convite a alguém apontar o
// launcher pra ele. Ver docs/technical/LAUNCHER_DISTRIBUTION.md.

// ── Catch-all: SPA ─────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Só escuta quando executado direto. Sob `require` (testes), exporta o app pra
// ser montado num servidor efêmero — sem isso, importar este arquivo num teste
// abriria a porta 3001 de verdade.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[staff-panel] Painel rodando em http://localhost:${PORT}`);
  });
}

module.exports = { app, validateApplication, issueLaunchTicket, hashTicket, pruneCrashReports, CRASH_REPORT_DIR };
