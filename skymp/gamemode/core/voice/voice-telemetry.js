/**
 * core/voice/voice-telemetry.js
 *
 * As métricas operacionais do SkyVoice, com os nomes que a operação pediu.
 *
 * ## Por que isto é uma TRADUÇÃO e não uma coleta nova
 *
 * O sistema já mede. `voice-metrics.js` conta cinquenta e poucas séries com
 * nomes internos (`session.connected`, `route.subscribe`, `gateway.failure`) e
 * guarda janela de duração com p50/p95. Nada disso precisava ser reescrito.
 *
 * O que faltava era o **vocabulário de fora**. Quem opera o servidor não
 * pergunta "quantos `session.reconnecting` aconteceram" — pergunta "quantas
 * reconexões de voz". As duas perguntas têm a mesma resposta e nomes diferentes,
 * e este arquivo é o dicionário entre elas.
 *
 * A alternativa seria renomear os contadores internos para os nomes de fora.
 * Seria pior: os nomes internos descrevem **onde** a coisa aconteceu
 * (`session.`, `route.`, `gateway.`), que é o que serve para depurar, e os de
 * fora descrevem **o que** aconteceu, que é o que serve para operar. Colapsar os
 * dois faria perder um dos usos.
 *
 * ## Por que uma métrica é soma de várias
 *
 * `voice_auth_failures` não tem contador correspondente porque autenticação
 * falha em quatro lugares diferentes: ticket inválido no relay legado,
 * identidade desconhecida, identidade que não sobrevive à leitura de volta, e
 * emissão de token falhando. São quatro defeitos distintos para quem depura e
 * **um** número para quem opera — "a voz está recusando gente".
 *
 * Somar aqui, e não na origem, é o que permite o alerta ser um só e a
 * investigação continuar tendo quatro respostas. `explain()` devolve a
 * decomposição para quando o alerta disparar.
 *
 * ## O que este módulo NÃO faz
 *
 * **Não abre porta e não exporta sozinho.** É a mesma disciplina do
 * `voice-metrics.js`, e pelo mesmo motivo: um módulo de métrica que abre socket
 * decide política de operação por conta própria. Ele renderiza (`snapshot`,
 * `renderPrometheus`) e quem serve é quem já tem servidor — hoje o
 * `apps/game-api`, que já expõe `/health` e já tem autenticação interna.
 *
 * **Não registra conteúdo.** Nenhuma métrica daqui carrega texto de conversa,
 * amostra de áudio ou nível medido por locutor identificável. Contagem e estado,
 * nada mais. Ver `voice-security.PRIVACY`.
 */

/**
 * Versão do protocolo de voz.
 *
 * Existe porque o diagnóstico da staff precisa responder "este cliente fala a
 * mesma língua que o servidor?" — e porque um cliente antigo, no dia em que o
 * formato do `proximity_update` mudar, produz o sintoma mais caro possível:
 * conecta, autentica, e simplesmente não ouve ninguém.
 *
 * Sobe quando o formato do fio muda de forma incompatível, não a cada mudança.
 *
 * - **1** — `proximity_update` com `{actorId, volume}`; `audio_frame` base64.
 * - **2** — acrescenta `effect` e `dir` (vetor unitário) por par, e `speaking`.
 *   Etapa 3. Cliente v1 ignora os campos novos e continua funcionando **sem**
 *   espacialização e sem efeitos — degradação, não quebra.
 */
const VOICE_PROTOCOL_VERSION = 2;

/**
 * O dicionário. Cada métrica de fora aponta para os contadores internos que a
 * compõem.
 *
 * `gauge` é lido do estado no instante da fotografia; `counter` é soma
 * monotônica de séries do `voice-metrics`.
 *
 * @type {Record<string, {type: 'counter'|'gauge', help: string, from?: string[], gauge?: string}>}
 */
const METRIC_MAP = Object.freeze({
  voice_connected_players: {
    type: 'gauge',
    gauge: 'connectedPlayers',
    help: 'Atores com estado de voz CONNECTED neste instante.'
  },
  voice_active_speakers: {
    type: 'gauge',
    gauge: 'activeSpeakers',
    help: 'Atores considerados falando agora (permissão do servidor + quadros recentes).'
  },
  voice_reconnects: {
    type: 'counter',
    // `session.renew` entra porque uma renovação de token É uma reconexão do
    // ponto de vista de quem opera: é a mesma pessoa voltando. Contá-la à parte
    // faria o número de reconexões parecer menor do que a operação observa.
    from: ['session.reconnecting', 'session.renew'],
    help: 'Reconexões de sessão de voz.'
  },
  voice_auth_failures: {
    type: 'counter',
    from: [
      'session.invalidIdentity',
      'session.identityRoundTripFailed',
      'session.tokenFailed',
      'legacy.authRejected'
    ],
    help: 'Tentativas de entrar na voz recusadas por autenticação.'
  },
  voice_subscription_count: {
    type: 'gauge',
    gauge: 'subscriptions',
    help: 'Arestas ouvinte→locutor ativas neste instante.'
  },
  voice_subscription_changes: {
    type: 'counter',
    from: ['route.subscribe', 'route.unsubscribe'],
    help: 'Assinaturas criadas ou removidas (churn).'
  },
  voice_policy_denies: {
    type: 'counter',
    from: [
      'policy.rejected.condition',
      'policy.rejected.space',
      'ptt.rejected',
      'voiceMode.rejected'
    ],
    help: 'Pedidos recusados pela política de voz (condição, célula, PTT, modo).'
  },
  voice_connection_quality: {
    type: 'gauge',
    gauge: 'connectionQuality',
    help: 'Qualidade de conexão reportada, por faixa (excellent/good/poor/lost/unknown).'
  },
  voice_client_errors: {
    type: 'counter',
    from: ['client.error'],
    help: 'Erros reportados pelo cliente de voz.'
  },
  voice_server_errors: {
    type: 'counter',
    from: [
      'core.tickError',
      'core.criticalError',
      'core.gatewayError',
      'core.subscriberError',
      'core.sample.error',
      'gateway.failure',
      'occlusion.providerError'
    ],
    help: 'Erros do lado do servidor no caminho de voz.'
  }
});

/** Faixas aceitas de qualidade de conexão. São as do LiveKit, mais `unknown`. */
const QUALITY_BUCKETS = Object.freeze(['excellent', 'good', 'poor', 'lost', 'unknown']);

/**
 * @param {object} deps
 * @param {any} deps.core   um VoiceCore
 * @param {() => number} [deps.now]
 */
function createVoiceTelemetry(deps = /** @type {{core: any, now?: () => number}} */ ({})) {
  const { core, now = () => Date.now() } = deps;
  if (!core) throw new Error('[voice-telemetry] core é obrigatório');

  /**
   * Qualidade de conexão por ator, reportada pelo CLIENTE.
   *
   * Vive aqui e não no `voice-state` porque não é regra de jogo: nada no mundo
   * muda porque a conexão de alguém piorou. É informação de operação, e
   * misturá-la ao estado autoritativo daria a ela um peso que ela não tem.
   *
   * **Reportada pelo cliente** significa que um cliente hostil pode mentir. É
   * aceitável e está declarado: mentir aqui polui um painel e não muda quem
   * ouve quem. Nenhuma decisão do servidor lê este mapa.
   *
   * @type {Map<number, {quality: string, at: number}>}
   */
  const quality = new Map();

  /**
   * Registra qualidade de conexão reportada.
   * @param {number} actorId
   * @param {string} value
   */
  function recordConnectionQuality(actorId, value) {
    if (!Number.isFinite(actorId)) return { ok: false };
    const bucket = QUALITY_BUCKETS.includes(value) ? value : 'unknown';
    quality.set(actorId, { quality: bucket, at: now() });
    return { ok: true, quality: bucket };
  }

  /**
   * Um erro reportado pelo cliente.
   *
   * O `code` é contado; a mensagem **não é guardada**. Mensagem de erro de
   * cliente é texto arbitrário vindo de fora, e um painel que a exibe é um
   * painel com injeção de conteúdo — além de ser o lugar mais provável de um dia
   * aparecer conteúdo de conversa num log, que é exatamente o que a política de
   * privacidade proíbe.
   *
   * @param {number} actorId
   * @param {string} code
   */
  function noteClientError(actorId, code) {
    const safe = typeof code === 'string' ? code.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 48) : 'unknown';
    core.metrics.count('client.error');
    core.metrics.count(`client.error.${safe || 'unknown'}`);
    return { ok: true, code: safe };
  }

  /** Esquece um ator: logout, desconexão. */
  function forget(actorId) {
    quality.delete(actorId);
  }

  /** Os valores que só o estado sabe — lidos no instante da fotografia. */
  function gauges() {
    const { CONNECTION_STATES } = require('./voice-state');
    let connected = 0;
    for (const s of core.state.all()) {
      if (s.connection === CONNECTION_STATES.CONNECTED) connected++;
    }

    /** @type {Record<string, number>} */
    const byQuality = {};
    for (const b of QUALITY_BUCKETS) byQuality[b] = 0;
    for (const entry of quality.values()) byQuality[entry.quality]++;

    return {
      connectedPlayers: connected,
      activeSpeakers: core.speaking.describe().speaking,
      subscriptions: core.routes.subscriptionCount(),
      connectionQuality: byQuality
    };
  }

  /**
   * Fotografia com os nomes de fora.
   *
   * @returns {{at: number, protocolVersion: number, metrics: Record<string, number|Record<string,number>>, latency: object}}
   */
  function snapshot() {
    const counters = core.metrics.snapshot().counters;
    const g = gauges();

    /** @type {Record<string, any>} */
    const metrics = {};
    for (const [name, def] of Object.entries(METRIC_MAP)) {
      if (def.type === 'gauge') {
        metrics[name] = g[def.gauge];
      } else {
        let total = 0;
        for (const key of def.from) total += counters[key] || 0;
        metrics[name] = total;
      }
    }

    return {
      at: now(),
      protocolVersion: VOICE_PROTOCOL_VERSION,
      metrics,
      // A latência do SERVIDOR decidindo quem ouve quem. Não é a latência que
      // uma pessoa ouve — essa depende de captura, codec, SFU e rede, e nenhuma
      // delas passa por aqui. O nome carrega a distinção de propósito.
      latency: {
        recomputeMs: core.metrics.stats('core.cycle'),
        gatewayCallMs: core.metrics.stats('gateway.call')
      }
    };
  }

  /**
   * A decomposição de uma métrica composta, para quando o alerta disparar.
   *
   * @param {string} name
   */
  function explain(name) {
    const def = METRIC_MAP[name];
    if (!def) return null;
    if (def.type === 'gauge') return { type: 'gauge', value: gauges()[def.gauge] };
    const counters = core.metrics.snapshot().counters;
    /** @type {Record<string, number>} */
    const parts = {};
    for (const key of def.from) parts[key] = counters[key] || 0;
    return { type: 'counter', parts, total: Object.values(parts).reduce((a, b) => a + b, 0) };
  }

  /**
   * Formato de texto do Prometheus.
   *
   * Existe porque é o formato que praticamente todo coletor lê, e escrevê-lo é
   * concatenação de string — não vale arrastar uma dependência para isso, pela
   * mesma razão que o JWT é assinado com `node:crypto` em vez do SDK.
   *
   * Quem SERVE isto é outro processo. Este módulo devolve texto.
   */
  function renderPrometheus(prefix = '') {
    const snap = snapshot();
    const lines = [];

    for (const [name, def] of Object.entries(METRIC_MAP)) {
      const full = `${prefix}${name}`;
      const value = snap.metrics[name];
      lines.push(`# HELP ${full} ${def.help}`);
      lines.push(`# TYPE ${full} ${def.type}`);
      if (value !== null && typeof value === 'object') {
        for (const [label, v] of Object.entries(value)) {
          lines.push(`${full}{quality="${label}"} ${v}`);
        }
      } else {
        lines.push(`${full} ${value}`);
      }
    }

    // A latência sai como métricas próprias, com o sufixo que diz a unidade.
    for (const [key, stats] of Object.entries(snap.latency)) {
      if (!stats) continue;
      const full = `${prefix}voice_${key.replace(/Ms$/, '')}_milliseconds`;
      lines.push(`# HELP ${full} Latência do servidor (não é a latência ouvida por uma pessoa).`);
      lines.push(`# TYPE ${full} summary`);
      lines.push(`${full}{quantile="0.5"} ${stats.p50}`);
      lines.push(`${full}{quantile="0.95"} ${stats.p95}`);
      lines.push(`${full}_count ${stats.count}`);
    }

    lines.push(`# HELP ${prefix}voice_protocol_version Versão do protocolo de voz do servidor.`);
    lines.push(`# TYPE ${prefix}voice_protocol_version gauge`);
    lines.push(`${prefix}voice_protocol_version ${VOICE_PROTOCOL_VERSION}`);

    return lines.join('\n') + '\n';
  }

  /**
   * Linha única para o log periódico.
   *
   * Serve o servidor que não tem coletor nenhum — que é o caso de hoje. Um
   * número que só existe atrás de um Prometheus que ninguém instalou é um número
   * que não existe.
   */
  function logLine() {
    const m = snapshot().metrics;
    return (
      `[voice-telemetry] conectados=${m.voice_connected_players} ` +
      `falando=${m.voice_active_speakers} ` +
      `assinaturas=${m.voice_subscription_count} ` +
      `churn=${m.voice_subscription_changes} ` +
      `reconexões=${m.voice_reconnects} ` +
      `authFalhas=${m.voice_auth_failures} ` +
      `recusasPolítica=${m.voice_policy_denies} ` +
      `errosServidor=${m.voice_server_errors} ` +
      `errosCliente=${m.voice_client_errors}`
    );
  }

  return {
    snapshot, explain, renderPrometheus, logLine,
    recordConnectionQuality, noteClientError, forget,
    qualityOf: (actorId) => quality.get(actorId) || null,
    METRIC_MAP, VOICE_PROTOCOL_VERSION
  };
}

module.exports = {
  createVoiceTelemetry,
  METRIC_MAP,
  QUALITY_BUCKETS,
  VOICE_PROTOCOL_VERSION
};
