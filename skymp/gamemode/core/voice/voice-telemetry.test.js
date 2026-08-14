const test = require('node:test');
const assert = require('node:assert');

const { createVoiceCore } = require('./voice-core');
const { createVoiceTelemetry, METRIC_MAP, VOICE_PROTOCOL_VERSION } = require('./voice-telemetry');
const { createVoiceStaffMute } = require('./voice-staff-mute');

const quiet = { log() {}, warn() {}, error() {} };

function makeCore(over = {}) {
  return createVoiceCore({
    logger: quiet,
    // Registro próprio: dois testes dividindo punição seria um contando com o
    // silêncio aplicado pelo outro.
    staffMute: createVoiceStaffMute(),
    ...over
  });
}

test('telemetria — as dez métricas pedidas existem, todas', () => {
  const pedidas = [
    'voice_connected_players', 'voice_active_speakers', 'voice_reconnects',
    'voice_auth_failures', 'voice_subscription_count', 'voice_subscription_changes',
    'voice_policy_denies', 'voice_connection_quality', 'voice_client_errors',
    'voice_server_errors'
  ];
  for (const nome of pedidas) {
    assert.ok(METRIC_MAP[nome], `falta ${nome}`);
    assert.ok(METRIC_MAP[nome].help, `${nome} sem help`);
  }
  assert.strictEqual(Object.keys(METRIC_MAP).length, pedidas.length, 'nem a mais, nem a menos');
});

test('telemetria — snapshot de um servidor vazio é zero, não indefinido', () => {
  const t = createVoiceTelemetry({ core: makeCore() });
  const snap = t.snapshot();
  for (const [nome, def] of Object.entries(METRIC_MAP)) {
    if (nome === 'voice_connection_quality') continue;
    assert.strictEqual(typeof snap.metrics[nome], 'number', `${nome} (${def.type}) não é número`);
  }
  assert.strictEqual(snap.metrics.voice_connected_players, 0);
  assert.strictEqual(snap.protocolVersion, VOICE_PROTOCOL_VERSION);
});

test('telemetria — jogadores conectados contam do ESTADO, não de um contador', () => {
  // Um contador de "conectou" menos um de "desconectou" divergiria do estado
  // real no primeiro caminho de saída que esquecesse de decrementar. O gauge lê
  // a verdade no instante da fotografia.
  const core = makeCore();
  const t = createVoiceTelemetry({ core });

  core.attach(1, { transport: 'legacy', characterId: 10 });
  core.attach(2, { transport: 'legacy', characterId: 20 });
  assert.strictEqual(t.snapshot().metrics.voice_connected_players, 2);

  core.detach(1, 'logout');
  assert.strictEqual(t.snapshot().metrics.voice_connected_players, 1);

  core.shutdown();
  assert.strictEqual(t.snapshot().metrics.voice_connected_players, 0);
});

test('telemetria — voice_auth_failures soma as quatro origens', () => {
  const core = makeCore();
  const t = createVoiceTelemetry({ core });

  core.metrics.count('session.invalidIdentity');
  core.metrics.count('session.tokenFailed', 2);
  core.metrics.count('legacy.authRejected', 3);
  core.metrics.count('session.identityRoundTripFailed');

  assert.strictEqual(t.snapshot().metrics.voice_auth_failures, 7);

  // E a decomposição continua disponível para quem for investigar o alerta.
  const parts = t.explain('voice_auth_failures');
  assert.strictEqual(parts.total, 7);
  assert.strictEqual(parts.parts['legacy.authRejected'], 3);
  assert.strictEqual(parts.parts['session.invalidIdentity'], 1);
});

test('telemetria — voice_policy_denies soma condição, célula, PTT e modo', () => {
  const core = makeCore();
  const t = createVoiceTelemetry({ core });
  for (const k of ['policy.rejected.condition', 'policy.rejected.space', 'ptt.rejected', 'voiceMode.rejected']) {
    core.metrics.count(k);
  }
  assert.strictEqual(t.snapshot().metrics.voice_policy_denies, 4);
});

test('telemetria — recusa de política REAL aparece na métrica', () => {
  // Não basta somar contadores fabricados: o caminho de código precisa emitir.
  const core = makeCore();
  const t = createVoiceTelemetry({ core });
  core.attach(5, { transport: 'legacy', characterId: 50 });

  const antes = t.snapshot().metrics.voice_policy_denies;
  core.requestVoiceMode(5, 'radio');       // modo que não existe
  const depois = t.snapshot().metrics.voice_policy_denies;

  assert.ok(depois > antes, `esperava aumento, ${antes} → ${depois}`);
});

test('telemetria — churn de assinatura conta subscribe e unsubscribe juntos', () => {
  const core = makeCore();
  const t = createVoiceTelemetry({ core });
  core.metrics.count('route.subscribe', 5);
  core.metrics.count('route.unsubscribe', 3);
  assert.strictEqual(t.snapshot().metrics.voice_subscription_changes, 8);
});

test('telemetria — qualidade de conexão é agrupada em faixas', () => {
  const core = makeCore();
  const t = createVoiceTelemetry({ core });

  t.recordConnectionQuality(1, 'excellent');
  t.recordConnectionQuality(2, 'poor');
  t.recordConnectionQuality(3, 'poor');

  const q = t.snapshot().metrics.voice_connection_quality;
  assert.strictEqual(q.excellent, 1);
  assert.strictEqual(q.poor, 2);
  assert.strictEqual(q.lost, 0);
});

test('telemetria — qualidade desconhecida cai em `unknown`, não explode', () => {
  // O valor vem do cliente. Um cliente hostil manda qualquer string, e um Map
  // com chave arbitrária vinda de fora é crescimento de memória controlado por
  // quem não deveria controlá-lo.
  const core = makeCore();
  const t = createVoiceTelemetry({ core });
  t.recordConnectionQuality(1, 'ótima demais');
  t.recordConnectionQuality(2, '__proto__');
  const q = t.snapshot().metrics.voice_connection_quality;
  assert.strictEqual(q.unknown, 2);
  assert.strictEqual(Object.keys(q).length, 5, 'só as cinco faixas conhecidas');
});

test('telemetria — erro de cliente conta o código e NÃO guarda a mensagem', () => {
  const core = makeCore();
  const t = createVoiceTelemetry({ core });

  const r = t.noteClientError(1, 'audio-context-suspended');
  assert.strictEqual(r.code, 'audio-context-suspended');
  assert.strictEqual(t.snapshot().metrics.voice_client_errors, 1);

  // Um "código" que na verdade é texto livre é higienizado e truncado: é o
  // ponto mais provável de conteúdo de conversa vazar para um log.
  const sujo = t.noteClientError(2, 'erro: <script>alert(1)</script> o jogador disse algo');
  assert.ok(!sujo.code.includes('<'), 'sem marcação');
  assert.ok(sujo.code.length <= 48, 'truncado');
});

test('telemetria — voice_server_errors cobre os caminhos que não podem derrubar o jogo', () => {
  const core = makeCore();
  const t = createVoiceTelemetry({ core });
  for (const k of ['core.tickError', 'core.criticalError', 'gateway.failure', 'occlusion.providerError']) {
    core.metrics.count(k);
  }
  assert.strictEqual(t.snapshot().metrics.voice_server_errors, 4);
});

test('telemetria — o formato Prometheus sai válido e com HELP/TYPE', () => {
  const core = makeCore();
  const t = createVoiceTelemetry({ core });
  core.attach(1, { transport: 'legacy', characterId: 10 });
  t.recordConnectionQuality(1, 'good');

  const text = t.renderPrometheus();

  for (const nome of Object.keys(METRIC_MAP)) {
    assert.ok(text.includes(`# HELP ${nome} `), `falta HELP de ${nome}`);
    assert.ok(text.includes(`# TYPE ${nome} `), `falta TYPE de ${nome}`);
  }
  assert.ok(text.includes('voice_connection_quality{quality="good"} 1'));
  assert.ok(text.includes(`voice_protocol_version ${VOICE_PROTOCOL_VERSION}`));
  assert.ok(text.endsWith('\n'), 'exposição do Prometheus termina em nova linha');

  core.shutdown();
});

test('telemetria — o prefixo é aplicado a tudo', () => {
  const t = createVoiceTelemetry({ core: makeCore() });
  const text = t.renderPrometheus('skymp_');
  assert.ok(text.includes('skymp_voice_connected_players'));
  assert.ok(!/\n# HELP voice_/.test(text), 'nada deveria escapar do prefixo');
});

test('telemetria — a latência é nomeada como latência do SERVIDOR', () => {
  // O nome carrega a distinção de propósito: não é a latência que uma pessoa
  // ouve, e um painel rotulado "voice latency" seria lido como se fosse.
  const core = makeCore();
  const t = createVoiceTelemetry({ core });
  core.attach(1, { transport: 'legacy', characterId: 10 });
  core.recompute('tick');

  const text = t.renderPrometheus();
  assert.ok(text.includes('voice_recompute_milliseconds'));
  assert.ok(/não é a latência ouvida por uma pessoa/.test(text));

  const snap = t.snapshot();
  assert.ok(snap.latency.recomputeMs, 'o recompute precisa ter amostra depois de um tick');
  core.shutdown();
});

test('telemetria — logLine serve o servidor que não tem coletor nenhum', () => {
  const core = makeCore();
  const t = createVoiceTelemetry({ core });
  core.attach(1, { transport: 'legacy', characterId: 10 });

  const line = t.logLine();
  assert.match(line, /conectados=1/);
  assert.match(line, /assinaturas=\d+/);
  assert.match(line, /errosServidor=\d+/);
  core.shutdown();
});

test('telemetria — esquecer um ator tira a qualidade dele da conta', () => {
  const core = makeCore();
  const t = createVoiceTelemetry({ core });
  t.recordConnectionQuality(1, 'poor');
  assert.strictEqual(t.snapshot().metrics.voice_connection_quality.poor, 1);
  t.forget(1);
  assert.strictEqual(t.snapshot().metrics.voice_connection_quality.poor, 0);
});

test('telemetria — nenhuma métrica carrega identificador de pessoa', () => {
  // Privacidade: contagem e estado, nada mais. Um rótulo com actorId ou nome de
  // personagem transformaria a exposição de métrica num registro de quem falou
  // com quem — que é exatamente o que este projeto promete não fazer.
  const core = makeCore();
  const t = createVoiceTelemetry({ core });
  core.attach(0xff000042, { transport: 'legacy', characterId: 777 });
  t.recordConnectionQuality(0xff000042, 'good');
  t.noteClientError(0xff000042, 'ctx-suspended');

  const text = t.renderPrometheus();
  assert.ok(!text.includes('ff000042'), 'actorId não pode aparecer');
  assert.ok(!text.includes('4278190146'), 'nem em decimal');
  assert.ok(!text.includes('777'), 'characterId não pode aparecer');
  core.shutdown();
});
