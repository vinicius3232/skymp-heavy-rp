/**
 * apps/web/admin-actions.js
 *
 * O registro de ações administrativas **do painel**, sobre o mesmo pipeline que
 * o gamemode usa (`skymp/gamemode/core/admin-action.js`).
 *
 * ─── Por que dois registros e um pipeline só ────────────────────────────────
 *
 * O painel e o gamemode são processos diferentes e não compartilham memória: o
 * painel não consegue chamar `admin-service.kickPlayer`, e o gamemode não fala
 * MySQL pelo pool do Express. Um registro único de ações obrigaria um dos dois a
 * conhecer serviços que ele não pode executar — que é o monólito que este
 * desenho recusa.
 *
 * O que é compartilhado é o **mecanismo**: as mesmas oito etapas, na mesma
 * ordem, com o mesmo envelope, o mesmo formato de registro e as mesmas regras
 * sobre o que pode vir de fora. Cada processo declara as ações que ele sabe
 * executar.
 *
 * ─── O que o painel não pode fingir que faz ─────────────────────────────────
 *
 * Nenhuma ação sobre jogador conectado é registrável aqui, e não é por falta de
 * pipeline: **não existe canal do painel para o processo do SkyMP**. Kick,
 * teleporte e silenciamento continuam sendo do gamemode até que essa ponte
 * exista. Declarar `players.kick` aqui com um `execute` que não alcança o jogo
 * seria construir um botão que mente.
 *
 * Por isso este registro tem uma ação só: a revisão de whitelist, que é a única
 * coisa que o painel de fato faz hoje além de ler.
 */

'use strict';

const {
  SOURCES, REASON,
  createAdminActionRegistry,
  createAdminActionPipeline
} = require('../../skymp/gamemode/core/admin-action');
const { createAuditEventStore } = require('../../skymp/gamemode/core/audit-event');

/**
 * @param {object} deps
 * @param {(sql: string, params?: any[]) => Promise<any>} deps.db
 * @param {(accountId: number) => Promise<{role: string|null, accountStatus: string|null, found: boolean}>} deps.resolveStaff
 * @param {(evento: object) => void} deps.notifyModerationLog
 * @param {(discordId: string, status: string) => Promise<void>} deps.syncDiscordRole
 */
function createWebAdminActions({ db, resolveStaff, notifyModerationLog, syncDiscordRole }) {
  const registry = createAdminActionRegistry();

  // ── SESSION ────────────────────────────────────────────────────────────────

  /**
   * Resolve a sessão a partir do `req`.
   *
   * O `accountId` vem de `req.user`, que o `passport` preencheu a partir do
   * cookie assinado — não do corpo do pedido. O **cargo** é lido do banco
   * agora, em toda ação: um cargo que viesse da sessão seria uma foto do
   * momento do login, e revogar staff passaria a depender de a pessoa
   * deslogar.
   *
   * O status da conta é conferido junto, pela mesma razão que o middleware de
   * permissão o confere: uma conta banida com linha em `staff_roles` não pode
   * agir.
   */
  async function resolveSession(source, req) {
    if (source !== SOURCES.WEB) return null;
    if (!req || !req.isAuthenticated || !req.isAuthenticated()) return null;

    const accountId = req.user && req.user.accountId;
    if (!accountId) return null;

    const staff = await resolveStaff(accountId);
    if (staff.accountStatus !== 'active') return null;

    return {
      // O id da sessão do Express identifica a sessão, não a pessoa — e é o que
      // permite ligar duas ações da mesma janela sem repetir a conta.
      sessionId: req.sessionID || null,
      staffAccountId: accountId,
      // O painel opera fora da ficção: quem revisa whitelist não tem personagem
      // envolvido no ato. `null` é a resposta honesta; inventar um seria pior.
      staffCharacterId: null,
      role: staff.role
    };
  }

  // ── TARGET ─────────────────────────────────────────────────────────────────

  /**
   * Resolve a aplicação de whitelist e a conta dona dela.
   *
   * O `accountId` do alvo e o `discord_id` saem **daqui**, de um `JOIN` a partir
   * do id da aplicação. O pedido entrega só o id da URL; se ele entregasse o
   * `accountId`, uma requisição forjada poderia aprovar a ficha de A e notificar
   * o Discord de B.
   *
   * Devolver `null` para aplicação inexistente também conserta um achado da
   * auditoria: a rota respondia `ok:true` para um id que não existia, gravava
   * auditoria com alvo nulo e notificava o Discord como `aplicação #<id>`.
   */
  async function resolveTarget(kind, ref) {
    if (kind !== 'account') return null;
    const applicationId = Number.parseInt(String(ref), 10);
    if (!Number.isInteger(applicationId) || applicationId <= 0) return null;

    const rows = await db(
      `SELECT wa.id, wa.status, wa.account_id, di.discord_id
         FROM whitelist_applications wa
         LEFT JOIN discord_identities di ON di.account_id = wa.account_id
        WHERE wa.id = ?
        LIMIT 1`,
      [applicationId]
    );
    if (rows.length === 0) return null;

    return {
      id: rows[0].id,
      accountId: rows[0].account_id,
      discordId: rows[0].discord_id || null,
      currentStatus: rows[0].status,
      label: `app#${rows[0].id}`
    };
  }

  // ── AUDIT ──────────────────────────────────────────────────────────────────

  // O mesmo escritor do gamemode, sobre a mesma tabela e o mesmo catálogo. Os
  // dois processos gravam `audit_events` com a mesma forma — que é a condição
  // para uma busca só responder por tudo que a staff fez, venha de onde vier.
  const store = createAuditEventStore({ query: (sql, params) => db(sql, params) });

  async function audit(entrada) {
    await store.record({
      eventId: entrada.actionId,
      correlationId: entrada.correlationId,
      sessionId: entrada.sessionId,
      staffAccountId: entrada.staffAccountId,
      staffCharacterId: entrada.staffCharacterId,
      targetAccountId: entrada.target ? entrada.target.accountId : null,
      // O painel opera sobre conta, não sobre personagem: a revisão de whitelist
      // decide a admissão de uma CONTA. `null` é a resposta honesta.
      targetCharacterId: null,
      action: entrada.action,
      permission: entrada.permission,
      outcome: entrada.outcome,
      source: entrada.source,
      reason: entrada.reason,
      // `before`/`after` de verdade, e este é o único lugar onde eles existem
      // hoje: a revisão de whitelist é a única ação do projeto cujo serviço de
      // domínio conhece o estado anterior — `resolveTarget` o leu para poder
      // recusar aplicação inexistente, então ele está à mão sem custo nenhum.
      before: entrada.target ? { status: entrada.target.currentStatus } : null,
      after: entrada.outcome === 'executed' && entrada.parameters
        ? { status: entrada.parameters.status }
        : null,
      metadata: {
        stage: entrada.stage,
        application: entrada.target ? entrada.target.id : null,
        detail: entrada.detail || null
      }
    });
  }

  // ── A ação ─────────────────────────────────────────────────────────────────

  registry.register({
    id: 'whitelist.review',
    permission: 'whitelist.review',
    description: 'Aprova, rejeita ou reabre uma aplicação de whitelist',
    target: 'account',
    // Rejeitar sem dizer por quê deixa o jogador sem nada para corrigir e a
    // staff seguinte sem nada para consultar. Aprovar não precisa de motivo.
    // A regra fica na precondition porque depende do parâmetro.
    reason: REASON.OPTIONAL,
    parameters: {
      status: { type: 'string', required: true, oneOf: ['approved', 'rejected', 'pending'] },
      extraReviewNotes: { type: 'string', required: false, maxLength: 2000 }
    },

    precondition: ({ parameters, envelope }) => {
      if (parameters.status === 'rejected' && !envelope.reason) {
        return { ok: false, reason: 'rejeitar exige motivo' };
      }
      return { ok: true };
    },

    /**
     * O corpo abaixo é o handler que já existia na rota, movido para cá sem
     * alteração de SQL nem de ordem. As duas coisas que saíram dele:
     *
     * - O `INSERT INTO audit_logs`, porque agora é o pipeline que audita —
     *   com correlationId, permissão e desfecho, que a linha antiga não tinha.
     * - O `if (idRows.length > 0)`, porque o alvo já foi resolvido e uma
     *   aplicação inexistente nunca chega aqui.
     */
    execute: async ({ target, parameters, reason }) => {
      await db(
        'UPDATE whitelist_applications SET status=?, reviewer_notes=?, reviewed_at=NOW() WHERE id=?',
        [parameters.status, reason || null, target.id]
      );

      if (parameters.extraReviewNotes) {
        await db(
          `UPDATE characters c
             INNER JOIN accounts a ON a.id = c.account_id
             INNER JOIN whitelist_applications wa ON wa.account_id = a.id
             SET c.extra_review_notes=?
           WHERE wa.id=? AND c.status='pending'`,
          [parameters.extraReviewNotes, target.id]
        );
      }

      // `c.status='pending'` é obrigatório: sem ele o UPDATE varre TODOS os
      // personagens da conta e reescreve o status de qualquer um — inclusive os
      // aposentados por `/permakill`. Aprovar uma ficha nova ressuscitava o
      // personagem morto permanentemente e apagava a consequência do permakill.
      if (parameters.status === 'approved') {
        await db(
          `UPDATE characters c
             INNER JOIN accounts a ON a.id = c.account_id
             INNER JOIN whitelist_applications wa ON wa.account_id = a.id
             SET c.status='approved'
           WHERE wa.id=? AND c.status='pending'`,
          [target.id]
        );
      }

      if (target.discordId) {
        // O sync ALTERA o estado do usuário no Discord e a falha dele importa —
        // mas não pode desfazer uma decisão já gravada. Ele fica dentro do
        // `execute` e engole o próprio erro, como já fazia.
        await syncDiscordRole(target.discordId, parameters.status);
      }

      // Notificação, não registro: o `audit_logs` do pipeline é o registro.
      // Não é aguardado, pelo mesmo motivo de sempre.
      notifyModerationLog({
        kind: parameters.status === 'approved' ? 'whitelist_approve'
          : parameters.status === 'rejected' ? 'whitelist_reject'
            : 'whitelist_reset',
        target: target.discordId ? `<@${target.discordId}>` : target.label,
        moderator: null,
        reason: reason || null
      });

      return { ok: true };
    },

    auditDetail: (ctx) => `from=${ctx.target.currentStatus}`
  });

  const pipeline = createAdminActionPipeline({ registry, resolveSession, resolveTarget, audit });

  return { registry, pipeline, resolveSession, resolveTarget };
}

/**
 * Traduz o `Result` do pipeline em resposta HTTP.
 *
 * O mapeamento é a razão de os desfechos serem cinco e não um booleano: cada um
 * vira um status diferente, e um cliente consegue distinguir "você não pode" de
 * "esse pedido está errado" de "não deu para fazer agora".
 */
function resultToHttp(res, resultado) {
  switch (resultado.outcome) {
    case 'executed':
      return res.json({ ok: true, actionId: resultado.actionId, correlationId: resultado.correlationId });
    case 'duplicate':
      // 200 e não 409: a intenção do cliente foi satisfeita — a ação aconteceu,
      // só não agora. Um 409 faria um duplo clique parecer erro para quem clicou.
      return res.json({ ok: true, duplicate: true, actionId: resultado.actionId });
    case 'denied':
      return res.status(403).json({ error: 'Acesso staff negado' });
    case 'invalid':
      return res.status(400).json({ error: resultado.detail });
    case 'blocked':
      return res.status(409).json({ error: resultado.detail });
    default:
      return res.status(500).json({ error: 'Erro interno do servidor' });
  }
}

module.exports = { createWebAdminActions, resultToHttp };
