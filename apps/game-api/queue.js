/**
 * queue.js
 *
 * Fila de entrada do servidor, sem dependência de rede nem de banco — tudo
 * aqui é pura manipulação de estado em memória, pra que dê pra testar a
 * política de admissão sem subir nada.
 *
 * Modelo: capacidade fixa de slots. Quem chega e encontra slot livre entra
 * direto; quem não encontra fica numa fila FIFO e é promovido quando um slot
 * vaga. Um slot vaga quando o jogador desconecta (o gamemode avisa) ou quando
 * a reserva expira sem ele ter aparecido no jogo.
 *
 * A expiração de reserva é o que impede a fila de travar: sem ela, um jogador
 * que fecha o launcher depois de ser admitido seguraria o slot pra sempre e a
 * fila inteira ficaria parada atrás dele.
 */

// Quanto tempo um jogador admitido tem pra efetivamente entrar no jogo antes
// de o slot voltar pra fila. Precisa cobrir o boot do Skyrim + SKSE, que não é
// rápido — daí o valor generoso.
const DEFAULT_RESERVATION_TTL_MS = 3 * 60 * 1000;

function createQueue(options = {}) {
  const capacity = Number.isInteger(options.capacity) && options.capacity > 0 ? options.capacity : 40;
  const reservationTtlMs = options.reservationTtlMs || DEFAULT_RESERVATION_TTL_MS;
  const now = options.now || (() => Date.now());

  // accountId -> { accountId, discordId, characterId, sessionTicket, reservedAt, connected }
  const _admitted = new Map();
  // Lista ordenada de { accountId, discordId, characterId, joinedAt }
  let _waiting = [];

  /**
   * Devolve slots cujas reservas expiraram sem o jogador ter conectado.
   * Chamado no início de toda operação — é mais simples e mais confiável que
   * manter um timer por reserva.
   */
  function _reapExpired() {
    const t = now();
    for (const [accountId, entry] of _admitted) {
      if (entry.connected) continue;
      if (t - entry.reservedAt > reservationTtlMs) {
        _admitted.delete(accountId);
      }
    }
  }

  function _promoteFromWaiting(makeTicket) {
    while (_admitted.size < capacity && _waiting.length > 0) {
      const next = _waiting.shift();
      _admitted.set(next.accountId, {
        accountId: next.accountId,
        discordId: next.discordId,
        characterId: next.characterId,
        sessionTicket: makeTicket(next.accountId),
        reservedAt: now(),
        connected: false
      });
    }
  }

  /**
   * Pede entrada. Idempotente por conta: chamar duas vezes não cria duas
   * posições nem dois slots — o launcher faz polling, então repetição é o caso
   * normal, não a exceção.
   *
   * `characterId` é resolvido por quem chama (AUTH-003: bind acontece no
   * consumo do launch_grant, não depois da promoção) e viaja com a entrada até
   * a admissão — `status()` nunca precisa dele de novo, porque já está aqui.
   *
   * @returns {{status:'success', ticket:string, characterId:number} | {status:'queued', position:number}}
   */
  function join(accountId, discordId, characterId, makeTicket) {
    _reapExpired();

    const existing = _admitted.get(accountId);
    if (existing) return { status: 'success', ticket: existing.sessionTicket, characterId: existing.characterId };

    const waitingIndex = _waiting.findIndex((e) => e.accountId === accountId);
    if (waitingIndex !== -1) {
      _promoteFromWaiting(makeTicket);
      const promoted = _admitted.get(accountId);
      if (promoted) return { status: 'success', ticket: promoted.sessionTicket, characterId: promoted.characterId };
      return { status: 'queued', position: _waiting.findIndex((e) => e.accountId === accountId) + 1 };
    }

    if (_admitted.size < capacity) {
      const ticket = makeTicket(accountId);
      _admitted.set(accountId, { accountId, discordId, characterId, sessionTicket: ticket, reservedAt: now(), connected: false });
      return { status: 'success', ticket, characterId };
    }

    _waiting.push({ accountId, discordId, characterId, joinedAt: now() });
    return { status: 'queued', position: _waiting.length };
  }

  /**
   * Consulta sem efeito colateral de entrada — mas ainda promove quem estiver
   * esperando, porque o polling é o único momento em que descobrimos que uma
   * reserva expirou.
   */
  function status(accountId, makeTicket) {
    _reapExpired();
    _promoteFromWaiting(makeTicket);

    const admitted = _admitted.get(accountId);
    if (admitted) return { status: 'success', ticket: admitted.sessionTicket, characterId: admitted.characterId };

    const index = _waiting.findIndex((e) => e.accountId === accountId);
    if (index !== -1) return { status: 'queued', position: index + 1 };

    return { status: 'not_queued' };
  }

  /** O gamemode confirma que o jogador entrou: a reserva vira ocupação real. */
  function markConnected(accountId) {
    const entry = _admitted.get(accountId);
    if (!entry) return false;
    entry.connected = true;
    return true;
  }

  /** O gamemode avisa que o jogador saiu: o slot volta pra fila. */
  function release(accountId, makeTicket) {
    const removed = _admitted.delete(accountId);
    _waiting = _waiting.filter((e) => e.accountId !== accountId);
    if (removed && makeTicket) _promoteFromWaiting(makeTicket);
    return removed;
  }

  /** Valida um ticket de sessão. Usado pelo gamemode ao aceitar a conexão. */
  function resolveSessionTicket(ticket) {
    if (!ticket) return null;
    for (const entry of _admitted.values()) {
      if (entry.sessionTicket === ticket) return entry;
    }
    return null;
  }

  function snapshot() {
    _reapExpired();
    return {
      capacity,
      occupied: _admitted.size,
      connected: Array.from(_admitted.values()).filter((e) => e.connected).length,
      waiting: _waiting.length
    };
  }

  return { join, status, markConnected, release, resolveSessionTicket, snapshot };
}

module.exports = { createQueue, DEFAULT_RESERVATION_TTL_MS };
