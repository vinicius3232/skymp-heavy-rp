/**
 * apps/bot-discord/staffAuthorization.js
 *
 * O bot pergunta ao painel se alguém é staff. **Não decide sozinho.**
 *
 * ─── O que isto substitui ───────────────────────────────────────────────────
 *
 * `voiceChannels.isStaffMember` aceitava quem tivesse o cargo `STAFF_ROLE_ID`
 * **do Discord** ou a permissão `Administrator` da guild. Era uma quarta fonte
 * de autoridade — depois de `staff_roles` no gamemode, `staff_roles` no painel e
 * a governança IC — e a única que ficava fora do banco: promover alguém no
 * Discord dava poder que o servidor de jogo não reconhecia, e revogar no banco
 * não tirava nada aqui.
 *
 * O efeito prático era pequeno (criar canal de voz temporário), e o precedente
 * não era: era a porta pela qual "cargo do Discord vira poder" entraria de novo
 * na próxima funcionalidade. O projeto já tinha decidido o contrário — o bot
 * **recebe** ordem do painel e nunca manda.
 *
 * ─── Por que perguntar em vez de dar banco ao bot ───────────────────────────
 *
 * O bot não tem acesso ao MySQL hoje, e isso é uma qualidade: ele é o processo
 * mais exposto (fala com uma API de terceiro, roda com um token que circula) e o
 * único que não pode ler nem escrever nada do servidor. Dar-lhe um pool para
 * resolver um cargo trocaria uma inconsistência de autoridade por uma superfície
 * de banco a mais.
 *
 * O painel já autentica Discord, já lê `staff_roles` e já expõe endpoints
 * internos. Ele responde.
 *
 * ─── Fail-closed, e por quê aqui e não no `moderationLog` ───────────────────
 *
 * `moderationLog.notify` manda-e-esquece: se o Discord estiver fora, a ação de
 * moderação já aconteceu e o canal é só notificação. Aqui é o oposto — a
 * resposta é a **condição** para a ação acontecer. Painel fora do ar, timeout,
 * resposta malformada: tudo nega. Um bot que libera quando não consegue
 * perguntar é um bot que libera todo mundo no minuto em que o painel cai.
 */

'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

/** Curto: é um clique num slash command, alguém está esperando. */
const TIMEOUT_MS = 3000;

/**
 * @param {object} deps
 * @param {string} deps.panelUrl        base do painel, ex. `http://127.0.0.1:3001`
 * @param {string} deps.internalSecret
 * @param {Pick<Console,'warn'|'error'>} [deps.logger]
 */
function createStaffAuthorization({ panelUrl, internalSecret, logger = console }) {
  /**
   * @param {string} discordId
   * @param {string} permission  capability do catálogo, ex. `voice.mute`
   * @returns {Promise<{allowed: boolean, role: string|null, reason: string}>}
   */
  function authorize(discordId, permission) {
    return new Promise((resolve) => {
      const negar = (reason) => resolve({ allowed: false, role: null, reason });

      if (!panelUrl || !internalSecret) {
        // Uma vez por chamada e não por boot, ao contrário do `moderationLog`:
        // ali a ausência de configuração é uma escolha de operação válida
        // (servidor que não quer o canal), aqui ela quebra um comando que a
        // staff está tentando usar agora.
        logger.error('[staff-authz] PANEL_INTERNAL_URL ou INTERNAL_API_SECRET ausente: negando por padrão.');
        return negar('not_configured');
      }

      let alvo;
      try {
        alvo = new URL('/internal/authorize', panelUrl);
      } catch (err) {
        logger.error(`[staff-authz] PANEL_INTERNAL_URL invalida ('${panelUrl}'):`, err.message);
        return negar('bad_panel_url');
      }

      const corpo = Buffer.from(JSON.stringify({ discordId, permission }), 'utf8');
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
            'X-Internal-Secret': internalSecret
          }
        },
        (res) => {
          let bruto = '';
          res.setEncoding('utf8');
          res.on('data', (pedaco) => { bruto += pedaco; });
          res.on('end', () => {
            if (res.statusCode !== 200) {
              logger.warn(`[staff-authz] Painel respondeu HTTP ${res.statusCode} para '${permission}'.`);
              return negar(`panel_http_${res.statusCode}`);
            }
            try {
              const corpoResposta = JSON.parse(bruto);
              // `allowed !== true` e não `!allowed`: um painel que responda
              // `{"allowed":"yes"}` por um bug de serialização não pode virar
              // autorização por coerção de tipo.
              if (corpoResposta.allowed !== true) {
                return negar(String(corpoResposta.reason || 'denied'));
              }
              resolve({ allowed: true, role: corpoResposta.role || null, reason: 'granted' });
            } catch (err) {
              logger.error('[staff-authz] Resposta do painel nao e JSON valido:', err.message);
              negar('bad_panel_response');
            }
          });
        }
      );

      req.on('timeout', () => req.destroy(new Error(`sem resposta em ${TIMEOUT_MS}ms`)));
      req.on('error', (err) => {
        logger.error(`[staff-authz] Falha ao consultar o painel sobre '${permission}':`, err.message);
        negar('panel_unreachable');
      });

      req.end(corpo);
    });
  }

  return { authorize };
}

/** Frase para o usuário do Discord. Nunca vaza detalhe de infraestrutura. */
function explainDenial(reason) {
  switch (reason) {
    case 'not_granted':
      return 'Seu cargo de staff não inclui esta ação.';
    case 'no_role':
    case 'account_not_found':
      return 'Você não é staff neste servidor.';
    case 'unknown_role':
      return 'Seu cargo de staff não é reconhecido. Fale com um administrador.';
    case 'account_banned':
    case 'account_suspended':
      return 'Sua conta não está ativa.';
    default:
      // Timeout, painel fora, config faltando: a pessoa não precisa saber qual,
      // e precisa saber que não é culpa dela.
      return 'Não foi possível verificar sua permissão agora. Tente de novo em instantes.';
  }
}

module.exports = { createStaffAuthorization, explainDenial };
