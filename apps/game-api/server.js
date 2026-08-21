/**
 * apps/game-api — API do servidor de jogo (porta 7758)
 *
 * O launcher já chamava estes endpoints desde sempre; o serviço é que não
 * existia. Enquanto isso, `verify-mods` sempre falhava com "servidor offline" e
 * a fila nunca respondia — ou seja, a verificação de paridade de modpack, que é
 * a base da regra de Autoridade do Servidor, nunca chegou a rodar.
 *
 * Endpoints públicos (chamados pelo launcher do jogador):
 *   GET  /mods.json             → manifesto de paridade { mods, loadOrder }
 *   POST /api/queue/join        → { ticket } → entra na fila
 *   POST /api/queue/status      → { ticket } → posição ou ticket de sessão
 *   GET  /health                → diagnóstico
 *
 * Endpoints internos (X-Internal-Secret, chamados pelo gamemode):
 *   POST /internal/session/resolve   → valida ticket de sessão e marca conectado
 *   POST /internal/session/release   → libera o slot na desconexão
 *
 * Por que a fila não aceita `discordId` direto: `discordId` é público. O
 * launcher apresenta um ticket emitido pelo painel (que é quem tem o client
 * secret do Discord e portanto é o único capaz de provar que aquele Discord
 * autenticou de fato). Ver migration-v6-launch-tickets.sql.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const crypto = require('crypto');
const express = require('express');
const mysql = require('mysql2/promise');

const { createQueue } = require('./queue');
const { createManifestLoader } = require('./modsManifest');
const pollGrants = require('./pollGrants');

// Fonte única do formato de credencial opaca (AUTH-002/AUTH-003) — mesmo
// arquivo que `skymp/gamemode` e `apps/web` usam. Sem dependências externas
// (só `node:crypto`), então requerer por caminho relativo através da fronteira
// de app é seguro: a alternativa seria triplicar `generate`/`parse`/`hash` e
// arriscar as três copiarem-se e divergirem, a mesma classe de bug que já
// aconteceu aqui com CEF/proximity-ranges/papyrus self.
const credential = require(path.join(__dirname, '..', '..', 'skymp', 'gamemode', 'core', 'opaque-credential'));

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

const PORT = parseInt(process.env.GAME_API_PORT || '7758', 10);
const HOST = process.env.GAME_API_BIND_HOST || '0.0.0.0';
const MANIFEST_PATH = process.env.MODS_MANIFEST_PATH || path.join(__dirname, 'mods.json');

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

const INTERNAL_API_SECRET = requireEnv('INTERNAL_API_SECRET');

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'skymp_rp',
  waitForConnections: true,
  connectionLimit: 5
});

const db = async (sql, params = []) => {
  const [rows] = await pool.execute(sql, params);
  return rows;
};

const manifestLoader = createManifestLoader(MANIFEST_PATH);
const queue = createQueue({ capacity: parseInt(process.env.QUEUE_CAPACITY || '40', 10) });

const makeSessionTicket = () => credential.generate('game_session');

// Quanto tempo a sessão de jogo vale. Precisa cobrir uma sessão inteira, com
// folga pra reconectar depois de um crash — o servidor de jogo consulta o
// master a cada conexão.
//
// Absoluto, sem renovação automática por design (AUTH-002 decisão 2,
// docs/technical/AUTH_002_OPAQUE_TICKET_V1.md): `last_resolved_at`/
// `resolve_count` são só telemetria. Renovar em silêncio a cada reconexão
// transformaria um token de N horas em token de vida indefinida enquanto o
// jogador ficar online, sem ganho de UX real — quando expira, o launcher
// reautentica via OAuth automaticamente.
//
// Teto de 24h: nenhum valor de operação acima disso é aceito. É a defesa
// contra configurar `GAME_SESSION_TTL_SECONDS` errado por engano (ex.: um
// zero a mais) e nunca perceber, porque o sintoma — sessão vivendo dias — só
// aparece muito depois de configurado.
const GAME_SESSION_TTL_SECONDS_MAX = 24 * 60 * 60;
const GAME_SESSION_TTL_SECONDS = (() => {
  const configured = parseInt(process.env.GAME_SESSION_TTL_SECONDS || String(12 * 60 * 60), 10);
  if (!Number.isInteger(configured) || configured <= 0 || configured > GAME_SESSION_TTL_SECONDS_MAX) {
    throw new Error(
      `GAME_SESSION_TTL_SECONDS inválido (${process.env.GAME_SESSION_TTL_SECONDS}) — ` +
      `precisa ser um inteiro positivo até ${GAME_SESSION_TTL_SECONDS_MAX} (24h).`
    );
  }
  return configured;
})();

/**
 * Grava a sessão que o servidor de jogo vai resolver contra o master API
 * (`apps/web`, `GET /api/servers/:masterKey/sessions/:session`).
 *
 * É este registro que faz o `profileId` deixar de ser uma declaração do
 * cliente: o SkyMP com `offlineMode: false` não lê o `profileId` do
 * `skymp_config.json`, ele pergunta ao master quem é o dono da sessão.
 *
 * Guardamos só o hash — se o banco vazar, as sessões em voo não viram
 * credencial. Mesmo critério de `launch_tickets`.
 *
 * `characterId` e `bound_at` fecham o SECURITY-BLOCKER AUTH-03: a sessão
 * passa a fixar QUAL personagem, não só qual conta. O bind acontece aqui,
 * no mesmo instante em que a admissão é persistida — nunca depois, na
 * conexão — porque `characterId` já foi resolvido antes da entrada na fila
 * (ver `resolveApprovedCharacter` e a resposta à §15/AUTH-002 em
 * docs/technical/AUTH_002_OPAQUE_TICKET_V1.md).
 */
async function persistGameSession(token, accountId, characterId, discordId) {
  await db(
    `INSERT INTO game_sessions (token_hash, account_id, character_id, discord_id, expires_at, bound_at)
     VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND), NOW())`,
    [credential.hash(token), accountId, characterId, discordId, GAME_SESSION_TTL_SECONDS]
  );
}

/**
 * Persiste a sessão de quem acabou de ser admitido.
 *
 * A fila é síncrona e em memória (pra ser testável sem banco), então a
 * gravação acontece aqui, depois. Se falhar, a admissão é desfeita: entrar na
 * fila e receber um ticket que o servidor de jogo vai recusar seria pior que
 * um erro honesto — o jogador ficaria olhando o Skyrim não conectar sem
 * entender por quê.
 *
 * `identity.characterId` cobre o caso de `/api/queue/join` (resolvido ali,
 * antes de chamar `queue.join`); `result.characterId` cobre `/api/queue/status`
 * promovendo alguém que já estava esperando — o bind foi feito no join
 * original, `queue.js` só o carrega adiante. Os dois nunca deveriam divergir
 * pra a mesma conta; se algum dia divergirem é bug de outro lugar, não motivo
 * pra escolher um em silêncio.
 */
async function persistAdmission(result, identity) {
  if (result.status !== 'success' || !result.ticket) return result;

  const characterId = result.characterId ?? identity.characterId ?? null;
  if (!characterId) {
    // Não deveria acontecer: `queue.join` sempre recebe characterId antes de
    // admitir. Se chegou aqui sem um, o bind quebrou antes desta função —
    // recusar é mais seguro que criar uma game_session órfã de personagem.
    console.error(`[game-api] Admissão da conta ${identity.accountId} sem characterId — bind ausente.`);
    queue.release(identity.accountId, makeSessionTicket);
    return { status: 'error', message: 'character_bind_missing' };
  }

  try {
    await persistGameSession(result.ticket, identity.accountId, characterId, identity.discordId);
    return result;
  } catch (err) {
    console.error('[game-api] Falha ao gravar game_session:', err.message);
    queue.release(identity.accountId, makeSessionTicket);
    return { status: 'error', message: 'session_persist_failed' };
  }
}

// ── Rate limiting (janela deslizante em memória) ────────────────────────────
const rateLimitBuckets = new Map();
function isRateLimited(key, maxRequests, windowMs) {
  const now = Date.now();
  const timestamps = (rateLimitBuckets.get(key) || []).filter((t) => now - t < windowMs);
  timestamps.push(now);
  rateLimitBuckets.set(key, timestamps);
  return timestamps.length > maxRequests;
}

function isValidInternalSecret(provided) {
  if (typeof provided !== 'string' || !provided) return false;
  const expected = Buffer.from(INTERNAL_API_SECRET);
  const actual = Buffer.from(provided);
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

function requireInternal(req, res, next) {
  if (!isValidInternalSecret(req.get('X-Internal-Secret'))) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
}

/**
 * Valida e consome um ticket de lançamento emitido pelo painel.
 *
 * Rejeita antes de tocar o banco se o formato ou o `kind` estiverem errados
 * (regra 1 do contrato — AUTH_002_OPAQUE_TICKET_V1.md): um `queue_grant` ou
 * `game_session` apresentado aqui por engano nunca deveria gerar sequer uma
 * consulta a `launch_tickets`.
 *
 * O UPDATE condicional é o que garante uso único sob concorrência: dois
 * pedidos simultâneos com o mesmo ticket disputam a mesma linha e só um deles
 * vê `affectedRows === 1`. Checar-e-depois-marcar em dois passos deixaria uma
 * janela pra ambos passarem.
 */
async function consumeLaunchTicket(token) {
  const parsed = credential.parse(token);
  if (!parsed || parsed.kind !== 'launch_grant') return null;

  const tokenHash = credential.hash(token);
  const [result] = await pool.execute(
    `UPDATE launch_tickets SET consumed_at = NOW()
     WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > NOW()`,
    [tokenHash]
  );
  if (result.affectedRows !== 1) return null;

  const rows = await db('SELECT account_id, discord_id FROM launch_tickets WHERE token_hash = ?', [tokenHash]);
  if (rows.length === 0) return null;
  return { accountId: rows[0].account_id, discordId: rows[0].discord_id };
}

/**
 * Confere que a conta continua elegível a entrar. O ticket prova *quem* é a
 * pessoa; isto prova que ela ainda *pode* jogar — uma conta pode ter sido
 * banida entre o login no launcher e a entrada na fila.
 */
async function isEligible(accountId) {
  const rows = await db(
    `SELECT a.status,
            (SELECT COUNT(*) FROM whitelist_applications w
              WHERE w.account_id = a.id AND w.status = 'approved') AS approved_apps,
            (SELECT COUNT(*) FROM characters c
              WHERE c.account_id = a.id AND c.status = 'approved') AS approved_chars
     FROM accounts a WHERE a.id = ?`,
    [accountId]
  );
  if (rows.length === 0) return { ok: false, reason: 'account_not_found' };
  if (rows[0].status !== 'active') return { ok: false, reason: 'account_not_active' };
  if (Number(rows[0].approved_apps) === 0) return { ok: false, reason: 'not_whitelisted' };
  if (Number(rows[0].approved_chars) === 0) return { ok: false, reason: 'no_approved_character' };
  return { ok: true };
}

/**
 * Resolve o personagem a vincular à game session (AUTH-003 / CHR-001).
 *
 * Até CHR-002 existir, uma conta só pode ter UM personagem `approved` — a
 * aplicação de personagem já impõe isso (ver whitelist.js). Essa cardinalidade
 * é o que torna o bind automático seguro: não há escolha nenhuma a fazer,
 * então não há decisão de UI faltando. `> 1` não é o caminho "escolher o mais
 * recente" — é uma violação de invariante que ainda não deveria ser possível,
 * e por isso recusa em vez de adivinhar.
 *
 * Quando CHR-002 chegar, a escolha vira input explícito do jogador NESTE MESMO
 * ponto (join da fila) — a função muda de "resolver sozinho" para "validar a
 * escolha", mas o momento do bind não muda.
 */
async function resolveApprovedCharacter(accountId) {
  const rows = await db(`SELECT id FROM characters WHERE account_id = ? AND status = 'approved'`, [accountId]);
  if (rows.length === 0) return null;
  if (rows.length > 1) {
    console.error(
      `[game-api] Conta ${accountId} tem ${rows.length} personagens approved — ` +
      'seleção explícita (CHR-002) ainda não existe, bind automático recusado.'
    );
    return null;
  }
  return rows[0].id;
}

// ── Paridade de modpack ─────────────────────────────────────────────────────

app.get('/mods.json', (req, res) => {
  const result = manifestLoader.load();
  if (!result.ok) {
    // 503 e não 200-com-lista-vazia: uma lista vazia passaria na verificação do
    // launcher e deixaria qualquer modpack entrar.
    console.error(`[game-api] Manifesto indisponivel: ${result.reason} (${MANIFEST_PATH})`);
    return res.status(503).json({ error: 'Manifesto de mods indisponivel no servidor.' });
  }
  res.json(result.manifest);
});

// ── Fila ────────────────────────────────────────────────────────────────────

app.post('/api/queue/join', async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (isRateLimited(`queue-join:${ip}`, 20, 60 * 1000)) {
    return res.status(429).json({ status: 'error', message: 'rate_limited' });
  }

  try {
    const identity = await consumeLaunchTicket((req.body || {}).ticket);
    if (!identity) return res.status(401).json({ status: 'error', message: 'invalid_ticket' });

    const eligible = await isEligible(identity.accountId);
    if (!eligible.ok) return res.status(403).json({ status: 'error', message: eligible.reason });

    // O bind acontece AQUI, junto com o consumo do launch_grant — não depois
    // da promoção da fila. Ver resolveApprovedCharacter e a resposta à
    // pergunta 4 do AUTH-002 em docs/technical/AUTH_002_OPAQUE_TICKET_V1.md.
    const characterId = await resolveApprovedCharacter(identity.accountId);
    if (!characterId) return res.status(403).json({ status: 'error', message: 'no_approved_character' });

    const result = await persistAdmission(
      queue.join(identity.accountId, identity.discordId, characterId, makeSessionTicket),
      { ...identity, characterId }
    );

    // O launcher precisa reconsultar a fila, e o launch_grant acabou de ser
    // consumido — devolvemos um queue_grant novo (efêmero, em memória) pro
    // polling seguinte.
    if (result.status === 'queued') {
      result.pollTicket = pollGrants.issue(identity.accountId, identity.discordId);
    }

    res.json(result);
  } catch (err) {
    console.error('[game-api] /api/queue/join', err);
    res.status(500).json({ status: 'error', message: 'internal_error' });
  }
});

/**
 * POST e não GET, e o ticket vem no corpo e não na query string.
 *
 * O ticket é credencial: quem o tem entra na fila como aquela conta. Query
 * string entra em log de acesso de servidor e de proxy; corpo de POST não.
 * O `join` ao lado sempre leu do corpo — isto aqui lia da query, e eram dois
 * tratamentos diferentes pro mesmo segredo a catorze linhas de distância.
 *
 * O impacto era menor do que parece (o transporte já é HTTP puro, e os tickets
 * rotacionam e são de uso único), mas a inconsistência convidava a erro: o
 * próximo endpoint copiaria um dos dois, e metade das chances era a errada.
 *
 * `req.query` é deliberadamente ignorado. O teste de regressão em
 * `server.http.test.js` manda um ticket pela query e exige 401 — se alguém
 * reintroduzir a leitura por lá, aquele teste quebra.
 *
 * Diferente de `/api/queue/join`, este endpoint consome um `queue_grant`
 * (`pollGrants`, efêmero em memória), nunca um `launch_grant` — os dois
 * viviam na mesma tabela `launch_tickets` sem distinção de `kind`, o problema
 * que AUTH_001_TRUST_BOUNDARY_INVENTORY.md registrou. `characterId` não
 * precisa ser resolvido de novo aqui: já foi fixado no `join` original e
 * `queue.status` o devolve de dentro da entrada existente.
 */
app.post('/api/queue/status', async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (isRateLimited(`queue-status:${ip}`, 120, 60 * 1000)) {
    return res.status(429).json({ status: 'error', message: 'rate_limited' });
  }

  try {
    const identity = pollGrants.consume((req.body || {}).ticket);
    if (!identity) return res.status(401).json({ status: 'error', message: 'invalid_ticket' });

    const result = await persistAdmission(
      queue.status(identity.accountId, makeSessionTicket),
      identity
    );
    if (result.status === 'queued') {
      result.pollTicket = pollGrants.issue(identity.accountId, identity.discordId);
    }
    res.json(result);
  } catch (err) {
    console.error('[game-api] /api/queue/status', err);
    res.status(500).json({ status: 'error', message: 'internal_error' });
  }
});

// ── Endpoints internos (gamemode) ───────────────────────────────────────────

app.post('/internal/session/resolve', requireInternal, (req, res) => {
  const entry = queue.resolveSessionTicket((req.body || {}).ticket);
  if (!entry) return res.status(404).json({ ok: false, error: 'unknown_session' });
  queue.markConnected(entry.accountId);
  res.json({ ok: true, accountId: entry.accountId, discordId: entry.discordId });
});

app.post('/internal/session/release', requireInternal, (req, res) => {
  const accountId = Number((req.body || {}).accountId);
  if (!Number.isInteger(accountId)) return res.status(400).json({ ok: false, error: 'invalid_account_id' });
  const released = queue.release(accountId, makeSessionTicket);
  res.json({ ok: true, released });
});

// ── Diagnóstico ─────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  const manifest = manifestLoader.load();
  res.json({
    ok: manifest.ok,
    manifest: manifest.ok
      ? { mods: manifest.manifest.mods.length, plugins: manifest.manifest.loadOrder.length }
      : { error: manifest.reason },
    queue: queue.snapshot()
  });
});

if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`[game-api] Rodando em http://${HOST}:${PORT}`);
    const manifest = manifestLoader.load();
    if (!manifest.ok) {
      console.warn(`[game-api] ATENCAO: manifesto de mods indisponivel (${manifest.reason}).`);
      console.warn('[game-api] Gere com: node scripts/generate-mods-manifest.js <caminho-do-Data>');
      console.warn('[game-api] Ate la, /mods.json responde 503 e nenhum jogador consegue entrar.');
    } else {
      console.log(`[game-api] Manifesto: ${manifest.manifest.mods.length} arquivos, ${manifest.manifest.loadOrder.length} plugins.`);
    }
  });
}

module.exports = { app, queue, pollGrants, consumeLaunchTicket, isEligible, resolveApprovedCharacter };
