/**
 * core/voice/voice-diagnostics.js
 *
 * O que a staff vê e o que a staff pode fazer com a voz de alguém.
 *
 * ## A pergunta que este módulo existe para responder
 *
 * "Por que fulano não está sendo ouvido?" tem doze respostas possíveis, e onze
 * delas são invisíveis do jogo: a sessão pode estar em `CONNECTING`, o
 * personagem pode não ter carregado, o PTT pode estar solto, a pessoa pode estar
 * morta, amordaçada, silenciada pela staff, em outra célula, com o token sem
 * permissão de publicar, com o cliente falando outra versão do protocolo, ou o
 * gateway pode estar com o circuito aberto.
 *
 * Sem um lugar que responda isso, a resposta vem de alguém abrindo o log do
 * servidor com `grep`. Este módulo é esse lugar.
 *
 * ## Por que é LEITURA de estruturas que já existem
 *
 * Nada aqui guarda estado próprio. Cada campo do diagnóstico é lido do módulo
 * que já é dono dele — `voice-state`, `voice-session`, `voice-policy`,
 * `voice-speaking-state`, `livekit-gateway`. Um cache de diagnóstico seria uma
 * segunda opinião sobre o estado da voz, e duas opiniões divergem exatamente no
 * momento em que alguém precisa da verdade.
 *
 * ## Privacidade: o que o diagnóstico NÃO mostra
 *
 * **Nada sobre o conteúdo.** Nenhum campo carrega áudio, nível medido de fala
 * por locutor identificável, transcrição, ou histórico de quem falou com quem.
 * `speaking` é um booleano do instante — "a boca está aberta agora" —, não um
 * registro. Um painel que guardasse a série temporal de `speaking` seria um
 * registro de conversas por outro nome, e este projeto não grava voz.
 *
 * A lista de pares em alcance **não** entra no diagnóstico por padrão pelo mesmo
 * motivo: quem-ouve-quem é derivável da posição, e a posição a staff já vê.
 * Materializá-la numa tela de moderação a transformaria num grafo social
 * consultável.
 */

const { CONNECTION_STATES } = require('./voice-state');
const { VOICE_PROTOCOL_VERSION } = require('./voice-telemetry');

/** As quatro ações administrativas. Nomes estáveis, citáveis no audit log. */
const VOICE_ADMIN_ACTIONS = Object.freeze({
  STAFF_MUTE: 'staff_mute',
  STAFF_UNMUTE: 'staff_unmute',
  DISCONNECT: 'voice_disconnect',
  FORCE_RECONNECT: 'voice_force_reconnect',
  DIAGNOSTICS: 'voice_diagnostics'
});

/**
 * @param {object} deps
 * @param {any} deps.core        VoiceCore
 * @param {any} [deps.telemetry] VoiceTelemetry — para qualidade de conexão
 * @param {any} [deps.staffMute] registro de silêncio; padrão é o compartilhado
 * @param {() => number} [deps.now]
 */
function createVoiceDiagnostics(deps = /** @type {{core: any, telemetry?: any, staffMute?: any, now?: () => number}} */ ({})) {
  const {
    core,
    telemetry = null,
    staffMute = require('./voice-staff-mute').sharedVoiceStaffMute,
    now = () => Date.now()
  } = deps;
  if (!core) throw new Error('[voice-diagnostics] core é obrigatório');

  /**
   * O diagnóstico de um ator. Os treze campos pedidos, e nada além.
   *
   * Devolve um objeto mesmo para quem não tem voz nenhuma — com
   * `voiceConnected: false` e o motivo. Devolver `null` obrigaria toda tela a
   * tratar o caso, e o caso mais comum de uma consulta de staff é justamente
   * "esta pessoa não está na voz", que é uma resposta e não um erro.
   *
   * @param {number} actorId
   */
  function forActor(actorId) {
    const state = core.state.get(actorId);
    const session = core.sessions.get(actorId);
    const gateway = core.gateway.describe();

    if (!state) {
      return {
        actorId,
        voiceConnected: false,
        voiceBackend: (process.env.VOICE_BACKEND || 'legacy').toLowerCase(),
        participantIdentity: null,
        characterId: null,
        voiceMode: null,
        currentCell: null,
        speaking: false,
        muted: false,
        staffMuted: false,
        connectionQuality: null,
        reconnectState: CONNECTION_STATES.DISABLED,
        voiceProtocolVersion: VOICE_PROTOCOL_VERSION,
        canPublish: null,
        reason: 'ator não está na cena de voz (nunca usou /voz, ou já saiu)',
        at: now()
      };
    }

    // A célula vem da amostra do Voice Core, que é a MESMA leitura que decide
    // rota. Ler `mp` de novo aqui daria um segundo valor, e a staff estaria
    // diagnosticando um mundo levemente diferente do que a voz usa.
    const sample = core.sample ? safeSample(actorId) : null;

    // `canSpeak` é o veredito completo da política — o mesmo que decide se sai
    // voz. É o campo que responde a pergunta de verdade.
    const speakVerdict = core.policy.canSpeak(actorId);

    return {
      actorId,
      voiceConnected: state.connection === CONNECTION_STATES.CONNECTED,
      voiceBackend: (process.env.VOICE_BACKEND || 'legacy').toLowerCase(),
      participantIdentity: session ? session.identity : null,
      characterId: state.characterId,
      voiceMode: state.voiceMode,
      currentCell: sample ? sample.space : null,
      speaking: core.speaking.isSpeaking(actorId),
      muted: state.muted,
      staffMuted: Number.isFinite(state.characterId) ? staffMute.isMuted(state.characterId) : false,
      connectionQuality: telemetry ? (telemetry.qualityOf(actorId)?.quality ?? null) : null,
      reconnectState: state.connection,
      voiceProtocolVersion: VOICE_PROTOCOL_VERSION,

      // Campos que não estavam na lista pedida e que são a diferença entre um
      // painel bonito e um painel que resolve o chamado.
      canPublish: session ? session.canPublish : null,
      transmitting: state.transmitting,
      canSpeakNow: speakVerdict.ok,
      reason: speakVerdict.ok ? null : speakVerdict.reason,
      conditions: speakVerdict.conditions || [],
      // O circuito aberto do gateway explica "por que a assinatura não mudou",
      // que de outro jeito parece bug de proximidade.
      gatewayState: gateway.state,
      gatewayLastError: gateway.lastError,
      at: now()
    };
  }

  /**
   * Uma amostra que nunca lança: diagnóstico não pode quebrar por leitura de
   * mundo. `sample()` devolve `{samples, critical}` — a amostra está no primeiro.
   */
  function safeSample(actorId) {
    try {
      const { samples } = core.sample();
      return samples.find((s) => s.actorId === actorId) || null;
    } catch {
      return null;
    }
  }

  /**
   * Visão geral do sistema, para a tela de staff.
   *
   * Sem lista de pares e sem grafo de quem ouve quem — ver a nota de privacidade
   * no cabeçalho.
   */
  function overview() {
    const d = core.describe();
    return {
      backend: (process.env.VOICE_BACKEND || 'legacy').toLowerCase(),
      protocolVersion: VOICE_PROTOCOL_VERSION,
      tickMs: d.tickMs,
      running: d.running,
      actors: d.actors,
      sessions: d.sessions,
      subscriptions: d.subscriptions,
      speaking: d.speaking.speaking,
      spatialAudio: d.spatialAudio,
      gateway: d.gateway,
      staffMuted: staffMute.describe().length,
      metrics: telemetry ? telemetry.snapshot().metrics : null,
      at: now()
    };
  }

  /** Todo mundo que está na voz agora, resumido. Para a lista da tela. */
  function roster() {
    return core.state.actorIds().map((actorId) => {
      const d = forActor(actorId);
      return {
        actorId: d.actorId,
        characterId: d.characterId,
        voiceConnected: d.voiceConnected,
        voiceMode: d.voiceMode,
        speaking: d.speaking,
        muted: d.muted,
        staffMuted: d.staffMuted,
        connectionQuality: d.connectionQuality,
        reconnectState: d.reconnectState,
        canSpeakNow: d.canSpeakNow,
        reason: d.reason
      };
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Ações
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Desconecta a voz de alguém, **sem tirar a pessoa do jogo**.
   *
   * A distinção é a razão de esta ação existir separada de `/kick`: um cliente
   * de voz travado — cadeia de áudio duplicada, sessão zumbi, helper que parou de
   * responder — se resolve derrubando a voz, e derrubar o jogador junto é uma
   * punição que ele não recebeu.
   *
   * @param {number} actorId
   * @param {string} [reason]
   */
  function disconnect(actorId, reason = 'staff') {
    const before = forActor(actorId);
    if (!core.state.get(actorId)) {
      return { ok: false, reason: 'ator não está na cena de voz', action: VOICE_ADMIN_ACTIONS.DISCONNECT };
    }
    const closed = core.detach(actorId, 'staffDisconnect');
    return {
      ok: true,
      action: VOICE_ADMIN_ACTIONS.DISCONNECT,
      identity: closed.identity,
      before: { voiceConnected: before.voiceConnected, reconnectState: before.reconnectState },
      reason
    };
  }

  /**
   * Força a reemissão de token, mantendo a identidade.
   *
   * Não é o mesmo que desconectar e reconectar: manter a identidade preserva as
   * assinaturas que os outros participantes já têm, e faz a volta não parecer uma
   * chegada. É a ação certa para "o áudio dele parou mas ele ainda está lá".
   *
   * Também **recalcula a permissão durável** — então um `/calar` aplicado
   * enquanto o gateway estava fora passa a valer no token agora.
   *
   * @param {number} actorId
   */
  function forceReconnect(actorId) {
    const session = core.sessions.get(actorId);
    if (!session) {
      // No caminho legado não há sessão LiveKit. Forçar recompute é o
      // equivalente honesto, e dizer isso é melhor que fingir que reconectou.
      if (core.state.get(actorId)) {
        core.markCritical(actorId, 'staffForceReconnect');
        return {
          ok: true,
          action: VOICE_ADMIN_ACTIONS.FORCE_RECONNECT,
          transport: 'legacy',
          note: 'backend legado não tem token; rotas recalculadas'
        };
      }
      return { ok: false, reason: 'sem sessão de voz', action: VOICE_ADMIN_ACTIONS.FORCE_RECONNECT };
    }

    const refreshed = core.refreshGrants(actorId);
    return {
      ok: refreshed.ok,
      action: VOICE_ADMIN_ACTIONS.FORCE_RECONNECT,
      transport: 'livekit',
      identity: session.identity,
      canPublish: refreshed.canPublish,
      // O token NÃO vai no retorno. Quem o entrega ao cliente é o caminho de
      // voz, pela property do SkyMP; devolvê-lo aqui o colocaria numa resposta
      // de painel de staff, que é um lugar por onde uma credencial de jogador
      // não tem por que passar.
      reason: refreshed.reason
    };
  }

  /**
   * O relatório de diagnóstico, formatado para uma linha de log/auditoria.
   *
   * Existe porque a ação `Diagnostics` também precisa gerar audit log, e o que
   * se registra é **que alguém consultou**, com o resumo do que viu — não o
   * objeto inteiro, que encheria a tabela.
   *
   * @param {number} actorId
   */
  function summaryLine(actorId) {
    const d = forActor(actorId);
    return (
      `connected=${d.voiceConnected} backend=${d.voiceBackend} ` +
      `state=${d.reconnectState} mode=${d.voiceMode ?? '-'} ` +
      `speaking=${d.speaking} muted=${d.muted} staffMuted=${d.staffMuted} ` +
      `canPublish=${d.canPublish ?? '-'} quality=${d.connectionQuality ?? '-'} ` +
      `proto=${d.voiceProtocolVersion} reason=${d.reason ?? 'ok'}`
    );
  }

  return { forActor, overview, roster, disconnect, forceReconnect, summaryLine };
}

module.exports = { createVoiceDiagnostics, VOICE_ADMIN_ACTIONS };
