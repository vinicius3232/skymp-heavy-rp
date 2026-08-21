/**
 * apps/web/permissions.js
 *
 * O middleware de autorização do painel. **Não é um segundo RBAC** — é um
 * adaptador HTTP em volta de `skymp/gamemode/core/permissions.js`, que é o
 * catálogo único. Este arquivo não decide quem pode o quê; ele traduz a decisão
 * daquele módulo para status HTTP e escreve a negação no `audit_logs`.
 *
 * ─── O que ele substitui ────────────────────────────────────────────────────
 *
 * `requireStaff` resolvia o cargo, guardava em `req.staff.role` e **nenhuma rota
 * jamais o consultava**. Doze rotas de staff, zero verificações de permissão: um
 * `moderator` recém-promovido lia o ranking de ouro, a ficha criminal de todo
 * mundo, o `audit_logs` inteiro e os crash reports com Discord ID de cada
 * jogador — e aprovava whitelist — exatamente como o `owner`.
 * Ver `docs/admin/SKYADMIN_CURRENT_STATE.md` §4.1.
 *
 * `requireStaff` deixou de existir. Não foi mantido como atalho para "qualquer
 * staff" de propósito: um guard que aceita qualquer cargo é indistinguível, na
 * leitura do arquivo de rotas, de um guard que verifica alguma coisa — e foi
 * exatamente essa indistinguibilidade que deixou doze rotas passarem. Há um
 * teste estático que reprova quem o trouxer de volta.
 *
 * ─── Duas coisas que ele confere e o antecessor não conferia ────────────────
 *
 * 1. **A conta da staff continua ativa.** Uma conta com `status='banned'` que
 *    tivesse linha em `staff_roles` continuava entrando no painel: o ban
 *    bloqueava o jogo (`whitelist.js`, `game-api`) e não a web.
 * 2. **O cargo é conhecido.** Cargo fora do catálogo negava tudo em jogo e
 *    liberava tudo aqui. Agora nega dos dois lados, pela mesma tabela.
 *
 * ─── Auditoria ─────────────────────────────────────────────────────────────
 *
 * **Toda negação vira linha**, com o motivo em código estável (`unknown_role`,
 * `reserved_permission`, `not_granted`, …). A pergunta "alguém está sondando
 * permissões que não tem?" era impossível de responder — o `403` não escrevia
 * nada — e é justamente o sinal que se quer ver antes de um incidente.
 *
 * **Concessão** só é auditada onde foi pedido explicitamente na rota
 * (`auditGrant: true`), e não em toda leitura. A regra vem do módulo de voz, que
 * já decidiu que consultar o estado de um jogador é registro: vale para as
 * leituras que carregam dado pessoal ou patrimônio, não para o contador do
 * dashboard. Auditar tudo produziria um log que ninguém lê, que é o mesmo que
 * não auditar.
 *
 * A escrita de auditoria **nunca** derruba a requisição, nos dois sentidos: uma
 * negação com log falho continua sendo negação (o padrão já é negar), e uma
 * concessão com log falho continua passando. O segundo caso é fail-open
 * declarado, e é o mesmo compromisso que `admin-service.auditLog` já faz.
 */

'use strict';

// A mesma travessia que `server.js` já faz desde sempre para ler o `.env` do
// gamemode. Não é uma dependência npm: é um arquivo desta árvore, sem deps
// próprias, e a direção (`apps/` → `skymp/gamemode/`) é a que já está em
// produção. Ver o cabeçalho de core/permissions.js sobre por que ele não mora
// em `skymp/packages/`.
const catalog = require('../../skymp/gamemode/core/permissions');
const { createAuditEventStore } = require('../../skymp/gamemode/core/audit-event');

/**
 * @param {object} deps
 * @param {(sql: string, params?: any[]) => Promise<any[]>} deps.db
 * @param {Pick<Console,'error'|'warn'>} [deps.logger]
 */
function createAuthorization({ db, logger = console }) {
  if (typeof db !== 'function') throw new Error('[authz] db inválido');

  /**
   * Resolve cargo e elegibilidade numa consulta só.
   *
   * `LEFT JOIN` e não `INNER`: precisamos distinguir "conta não existe" de
   * "conta existe e não é staff" de "conta é staff e está banida". As três
   * negam, e as três significam coisas diferentes no log.
   *
   * @param {number} accountId
   * @returns {Promise<{role: string|null, accountStatus: string|null, found: boolean}>}
   */
  async function resolveStaff(accountId) {
    const rows = await db(
      `SELECT a.status AS account_status, sr.role AS role
         FROM accounts a
         LEFT JOIN staff_roles sr ON sr.account_id = a.id
        WHERE a.id = ?
        LIMIT 1`,
      [accountId]
    );
    if (rows.length === 0) return { role: null, accountStatus: null, found: false };
    return { role: rows[0].role || null, accountStatus: rows[0].account_status || null, found: true };
  }

  /**
   * Grava uma decisão de autorização — o fluxo **SECURITY EVENT**.
   *
   * Vai para `audit_events` com `category='security'`, e não para uma tabela
   * separada. Os dois têm exatamente a mesma forma — ator, alvo, desfecho,
   * severidade — e separá-los obrigaria toda investigação a fazer `UNION` entre
   * duas tabelas: "quem tentou e quem conseguiu" é uma pergunta só.
   *
   * A severidade sai do catálogo: `denied` eleva para `warning`, que é o que
   * torna "alguém está sondando permissões que não tem" uma consulta de um
   * filtro em vez de uma leitura de texto livre.
   */
  const store = createAuditEventStore({ query: (sql, params) => db(sql, params) }, logger);

  async function recordDecision(kind, { accountId, permission, reason, method, route, role }) {
    // Falha de escrita é engolida pelo próprio store, que grita e devolve
    // `{ok:false}`. Uma negação sem log continua sendo negação; uma concessão
    // sem log continua passando. Ver o cabeçalho.
    await store.record({
      staffAccountId: accountId || null,
      category: 'security',
      action: `security.${kind}`,
      // `granted`/`denied` do middleware são desfechos, não ações — o
      // vocabulário é o mesmo do pipeline, e é o que faz `?outcome=denied`
      // responder pelas duas superfícies de uma vez.
      outcome: kind === 'denied' ? 'denied' : 'executed',
      source: 'web',
      permission,
      reason: reason || null,
      metadata: { route: `${method} ${route}`, role: role || null }
    });
  }

  /**
   * O middleware.
   *
   * @param {string} permission  capability do catálogo, ex. `audit.view`
   * @param {{auditGrant?: boolean}} [options]
   */
  function requirePermission(permission, options = {}) {
    // Validação no **carregamento do módulo de rotas**, não no primeiro
    // request. Uma rota registrada com `requirePermission('audit.viwe')`
    // negaria para todo mundo, para sempre, e o sintoma seria "o painel parou
    // de funcionar para o owner" — descoberto por alguém tentando trabalhar.
    // Aqui o servidor não sobe.
    if (!catalog.isWellFormed(permission) || !catalog.CAPABILITIES[permission]) {
      throw new Error(
        `[authz] rota registrada com a permissão '${permission}', que não existe no catálogo. ` +
        `Ativas: ${catalog.activePermissions().join(', ')}. Ver skymp/gamemode/core/permissions.js.`
      );
    }
    if (catalog.CAPABILITIES[permission].status === 'reserved') {
      throw new Error(
        `[authz] rota registrada com a permissão RESERVADA '${permission}'. ` +
        `Reservada significa que o poder ainda não existe — ela nega para todo cargo, inclusive owner. ` +
        `Promova-a a 'active' no catálogo e conceda-a a um cargo antes de usá-la numa rota.`
      );
    }

    return async function authorize(req, res, next) {
      const route = req.baseUrl ? `${req.baseUrl}${req.path}` : req.path;
      const method = req.method;

      if (!req.isAuthenticated || !req.isAuthenticated()) {
        // 401 e não 403: não é "você não pode", é "não sei quem você é". A
        // distinção já existia e o `apps/web/server.test.js` depende dela.
        return res.status(401).json({ error: 'Nao autenticado' });
      }

      const accountId = req.user && req.user.accountId;

      let staff;
      try {
        staff = await resolveStaff(accountId);
      } catch (err) {
        logger.error('[authz] Falha ao resolver cargo de staff:', err.message);
        return res.status(500).json({ error: 'Erro interno do servidor' });
      }

      // Conta inativa nega antes de qualquer permissão. Uma conta banida com
      // cargo de staff entrava aqui normalmente até esta linha existir.
      if (staff.accountStatus !== 'active') {
        await recordDecision('denied', {
          accountId, permission, role: staff.role, method, route,
          reason: staff.found ? `account_${staff.accountStatus}` : 'account_not_found'
        });
        return res.status(403).json({ error: 'Acesso staff negado' });
      }

      const decision = catalog.decide(staff.role, permission);
      req.staff = { role: staff.role, capabilities: catalog.capabilitiesForRole(staff.role) };

      if (!decision.allowed) {
        await recordDecision('denied', {
          accountId, permission, role: staff.role, method, route, reason: decision.reason
        });
        // Cargo desconhecido no banco é incidente de operação, não uso normal:
        // alguém inseriu uma linha em `staff_roles` com um valor que nenhum dos
        // dois lados reconhece. Vale gritar.
        if (decision.reason === catalog.DENIAL.UNKNOWN_ROLE) {
          logger.error(`[authz] ${catalog.explain(decision)} (conta ${accountId}).`);
        }
        return res.status(403).json({ error: 'Acesso staff negado' });
      }

      if (options.auditGrant) {
        await recordDecision('granted', {
          accountId, permission, role: staff.role, method, route, reason: null
        });
      }

      return next();
    };
  }

  return { requirePermission, resolveStaff, recordDecision };
}

module.exports = { createAuthorization, catalog };
