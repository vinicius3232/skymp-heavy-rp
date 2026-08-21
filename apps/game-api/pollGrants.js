/**
 * pollGrants.js — `queue_grant` efêmero, em memória (AUTH-002/AUTH-003)
 *
 * Antes desta mudança, o ticket de polling da fila (re-emitido a cada
 * `/api/queue/join`/`/api/queue/status` enquanto o jogador espera) vivia na
 * mesma tabela `launch_tickets` que o `launch_grant` do OAuth — mesmo formato,
 * sem `kind`/`audience`, o problema que
 * `docs/technical/AUTH_001_TRUST_BOUNDARY_INVENTORY.md` registrou. Uma escrita
 * em MariaDB por poll também não comprava nada: `queue.js` já é estado em
 * memória do mesmo processo, pelo mesmo motivo (testável sem banco), e
 * `queue_grant` nunca precisa sobreviver a mais que isso — só ao intervalo
 * entre dois polls do MESMO processo que o emitiu.
 *
 * ⚠️ PREMISSA DE TOPOLOGIA: isto assume `apps/game-api` como instância única.
 * Um `queue_grant` emitido pela réplica A não resolve numa réplica B atrás de
 * um load balancer — quebra silenciosamente, sem erro claro. Se
 * `apps/game-api` escalar horizontalmente, isto precisa virar um store
 * compartilhado (Redis, não MariaDB — é TTL curto, não auditoria), não uma
 * migration. Ver a revisão adversarial em
 * `docs/technical/AUTH_002_OPAQUE_TICKET_V1.md` §1.
 */

const credential = require(require('path').join(
  __dirname, '..', '..', 'skymp', 'gamemode', 'core', 'opaque-credential'
));

/** 2 min, o TTL deslizante que o contrato v1 define para `queue_grant`. */
const TTL_MS = 2 * 60 * 1000;

/** tokenHash → { accountId, discordId, expiresAt } */
const _grants = new Map();

/**
 * Emite um novo `queue_grant` para a conta. Não invalida grants anteriores da
 * mesma conta por si só — quem chama isto já consumiu (e portanto já apagou)
 * o grant anterior antes de pedir um novo, no mesmo request.
 */
function issue(accountId, discordId, now = Date.now()) {
  const token = credential.generate('queue_grant');
  _grants.set(credential.hash(token), { accountId, discordId, expiresAt: now + TTL_MS });
  return token;
}

/**
 * Consome e ROTACIONA: o registro morre daqui, mesmo se o token estiver
 * expirado ou for desconhecido. Reapresentar o mesmo `queue_grant` nunca
 * funciona duas vezes — é a propriedade de uso único que o contrato exige.
 *
 * @returns {{accountId:number, discordId:string}|null}
 */
function consume(token, now = Date.now()) {
  const parsed = credential.parse(token);
  if (!parsed || parsed.kind !== 'queue_grant') return null;

  const tokenHash = credential.hash(token);
  const entry = _grants.get(tokenHash);
  _grants.delete(tokenHash);
  if (!entry) return null;
  if (now > entry.expiresAt) return null;

  return { accountId: entry.accountId, discordId: entry.discordId };
}

/** Só para teste: devolve ao estado vazio entre casos. */
function _reset() {
  _grants.clear();
}

/** Só para diagnóstico/teste: quantos grants estão vivos agora. */
function _size() {
  return _grants.size;
}

module.exports = { issue, consume, TTL_MS, _reset, _size };
