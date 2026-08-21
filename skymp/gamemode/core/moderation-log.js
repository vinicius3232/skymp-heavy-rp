/**
 * core/moderation-log.js
 *
 * Avisa o bot do Discord quando uma ação de moderação acontece em jogo.
 *
 * O registro de verdade continua sendo `audit_logs`, escrito pelo
 * `admin-service` no mesmo fluxo da ação. Isto aqui é **notificação** — serve
 * pra staff ver acontecendo sem abrir o painel. Ver `apps/bot-discord/moderationLog.js`
 * e `docs/ARCHITECTURE.md` 1.3.
 *
 * ─── Três decisões, e por quê ────────────────────────────────────────────────
 *
 * **1. `http.request` do core, não `fetch`.** O gamemode roda dentro do Node que
 * o SkyMP embute, e não controlamos a versão dele — `fetch` global só existe a
 * partir do Node 18. Uma dependência nova também estava fora: o `package.json`
 * do gamemode tem três, e cada uma precisa resolver a partir de
 * `skymp/gamemode/node_modules` porque o entry file roda do `%TEMP%`.
 *
 * **2. Manda e esquece.** Nenhuma função daqui é `await`ada por quem modera.
 * Um `/permakill` não pode ficar lento nem falhar porque o Discord está fora, e
 * a consequência da ação já está no banco antes desta chamada sair.
 *
 * **3. Desligado por padrão.** Sem `BOT_INTERNAL_URL` e `INTERNAL_API_SECRET` no
 * `.env` do gamemode, `notify()` volta na primeira linha. Servidor que não quer
 * o canal não paga nada, e não vê erro nenhum.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

/** Curto de propósito: é notificação, e ninguém está esperando por ela. */
const TIMEOUT_MS = 3000;

let _avisouQueEstaDesligado = false;

/**
 * @param {object} evento
 * @param {'ban'|'kick'|'voice_mute'|'permakill'|'whitelist_approve'|'whitelist_reject'|'whitelist_reset'} evento.kind
 * @param {string}  evento.target     quem sofreu a ação (nome do personagem, id)
 * @param {string} [evento.moderator] quem aplicou
 * @param {string} [evento.reason]
 */
function notify(evento) {
  const base = process.env.BOT_INTERNAL_URL;
  const secret = process.env.INTERNAL_API_SECRET;

  if (!base || !secret) {
    // Uma vez por boot, não por evento: a ausência é uma escolha de operação
    // válida, e gritar a cada kick transformaria isso em ruído que a staff
    // aprende a ignorar — que é como um aviso de verdade passa despercebido.
    if (!_avisouQueEstaDesligado) {
      console.log('[moderation-log] Desligado (BOT_INTERNAL_URL ou INTERNAL_API_SECRET ausente no .env).');
      _avisouQueEstaDesligado = true;
    }
    return;
  }

  let alvo;
  try {
    alvo = new URL('/api/moderation-log', base);
  } catch (err) {
    console.error(`[moderation-log] BOT_INTERNAL_URL invalida ('${base}'):`, err.message);
    return;
  }

  const corpo = Buffer.from(JSON.stringify({ ...evento, source: 'gamemode', at: new Date().toISOString() }), 'utf8');
  const transporte = alvo.protocol === 'https:' ? https : http;

  const req = transporte.request(
    {
      hostname: alvo.hostname,
      port: alvo.port || (alvo.protocol === 'https:' ? 443 : 80),
      path: alvo.pathname,
      method: 'POST',
      timeout: TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': corpo.length,
        'X-Internal-Secret': secret
      }
    },
    (res) => {
      // O corpo é drenado e descartado: sem isto o socket fica preso até o
      // timeout, e num servidor com moderação ativa isso vaza conexão.
      res.resume();
      if (res.statusCode >= 400) {
        console.error(`[moderation-log] Bot recusou o evento '${evento.kind}': HTTP ${res.statusCode}`);
      }
    }
  );

  req.on('timeout', () => req.destroy(new Error(`sem resposta em ${TIMEOUT_MS}ms`)));
  req.on('error', (err) => {
    // Nunca propaga. A ação de moderação já aconteceu e está em `audit_logs`;
    // o Discord estar fora não pode desfazer nada nem aparecer pro jogador.
    console.error(`[moderation-log] Falha ao avisar o bot sobre '${evento.kind}':`, err.message);
  });

  req.end(corpo);
}

module.exports = { notify };
