const test = require('node:test');
const assert = require('node:assert');

process.env.LIVEKIT_URL = 'wss://diag.teste';
process.env.LIVEKIT_API_KEY = 'chave-diag';
process.env.LIVEKIT_API_SECRET = 'segredo-de-diagnostico-longo-o-bastante';

const { createVoiceCore } = require('./voice-core');
const { createVoiceLiveKitGateway } = require('./livekit-gateway');
const { createVoiceStaffMute } = require('./voice-staff-mute');
const { createVoiceTelemetry } = require('./voice-telemetry');
const { createVoiceDiagnostics } = require('./voice-diagnostics');
const { VOICE_PROTOCOL_VERSION } = require('./voice-telemetry');

const quiet = { log() {}, warn() {}, error() {} };

function montar(atoresIniciais = [[1000, [0, 0, 0], '3c:Skyrim.esm']]) {
  const atores = new Map();
  for (const [id, pos, space] of atoresIniciais) atores.set(id, { pos, space, yaw: 0 });

  const gateway = createVoiceLiveKitGateway({
    fetchImpl: async () => ({ ok: true, status: 200 }),
    mintAdminToken: require('./livekit-token').mintAdminToken,
    logger: quiet
  });
  const staffMute = createVoiceStaffMute();
  const core = createVoiceCore({
    mp: {
      get: (id, f) => {
        const a = atores.get(id);
        return a && f === 'locationalData' ? { pos: a.pos, cellOrWorldDesc: a.space, rot: [0, 0, a.yaw] } : null;
      },
      set() {}
    },
    gateway, staffMute, logger: quiet
  });
  const telemetry = createVoiceTelemetry({ core });
  const diag = createVoiceDiagnostics({ core, telemetry, staffMute });
  return { core, diag, telemetry, staffMute, atores };
}

function conectar(core, actorId, characterId) {
  const aberto = core.attach(actorId, { characterId });
  if (aberto.session) core.sessions.confirmConnected(aberto.session.identity);
  return aberto;
}

// ── Os treze campos ──────────────────────────────────────────────────────────

test('diagnóstico — os treze campos pedidos existem, todos', () => {
  const { core, diag } = montar();
  conectar(core, 1000, 42);

  const d = diag.forActor(1000);
  const pedidos = [
    'voiceConnected', 'voiceBackend', 'participantIdentity', 'characterId',
    'voiceMode', 'currentCell', 'speaking', 'muted', 'staffMuted',
    'connectionQuality', 'reconnectState', 'voiceProtocolVersion'
  ];
  for (const campo of pedidos) {
    assert.ok(campo in d, `falta o campo ${campo}`);
  }
  // O décimo terceiro pedido — "Actor" — é a chave do próprio relatório.
  assert.strictEqual(d.actorId, 1000);
  core.shutdown();
});

test('diagnóstico — o relatório de quem nunca usou /voz é resposta, não erro', () => {
  const { core, diag } = montar();
  const d = diag.forActor(999999);
  assert.strictEqual(d.voiceConnected, false);
  assert.strictEqual(d.reconnectState, 'DISABLED');
  assert.match(d.reason, /não está na cena de voz/);
  assert.strictEqual(d.voiceProtocolVersion, VOICE_PROTOCOL_VERSION);
  core.shutdown();
});

test('diagnóstico — cada campo reflete o estado REAL, não um cache', () => {
  const { core, diag } = montar();
  conectar(core, 1000, 42);

  assert.strictEqual(diag.forActor(1000).voiceConnected, true);
  assert.strictEqual(diag.forActor(1000).voiceMode, 'normal');
  assert.strictEqual(diag.forActor(1000).muted, false);

  core.requestVoiceMode(1000, 'whisper');
  core.requestMute(1000, true);

  assert.strictEqual(diag.forActor(1000).voiceMode, 'whisper');
  assert.strictEqual(diag.forActor(1000).muted, true);
  core.shutdown();
});

test('diagnóstico — a célula vem da MESMA amostra que decide rota', () => {
  const { core, diag } = montar([[1000, [10, 20, 30], '1a26f:Skyrim.esm']]);
  conectar(core, 1000, 42);
  core.recompute('tick');
  assert.strictEqual(diag.forActor(1000).currentCell, '1a26f:Skyrim.esm');
  core.shutdown();
});

test('diagnóstico — `speaking` é o instante, e volta a falso sozinho', () => {
  // Nunca é uma série temporal: um painel que guardasse o histórico de
  // `speaking` seria um registro de conversas por outro nome.
  const { core, diag } = montar();
  conectar(core, 1000, 42);
  core.pttDown(1000);
  core.noteAudioFrame(1000);
  assert.strictEqual(diag.forActor(1000).speaking, true);

  core.pttUp(1000);
  assert.strictEqual(diag.forActor(1000).speaking, false);
  core.shutdown();
});

test('diagnóstico — staffMuted lê o registro de punição, e canPublish acompanha', () => {
  const { core, diag, staffMute } = montar();
  conectar(core, 1000, 42);
  assert.strictEqual(diag.forActor(1000).staffMuted, false);
  assert.strictEqual(diag.forActor(1000).canPublish, true);

  staffMute.mute(42, { reason: 'gritando por cima da cena' });

  const d = diag.forActor(1000);
  assert.strictEqual(d.staffMuted, true);
  // O observador do Voice Core reemitiu o token: a punição vale AGORA, não só
  // na próxima conexão.
  assert.strictEqual(d.canPublish, false, 'a punição precisa chegar ao token da sessão viva');
  assert.strictEqual(d.canSpeakNow, false);
  core.shutdown();
});

test('diagnóstico — descalar devolve canPublish sem reconectar', () => {
  const { core, diag, staffMute } = montar();
  conectar(core, 1000, 42);
  staffMute.mute(42, { reason: 'x' });
  assert.strictEqual(diag.forActor(1000).canPublish, false);

  staffMute.unmute(42);
  assert.strictEqual(diag.forActor(1000).canPublish, true);
  assert.strictEqual(diag.forActor(1000).staffMuted, false);
  core.shutdown();
});

test('diagnóstico — o motivo responde "por que fulano não é ouvido"', () => {
  const { core, diag } = montar();
  conectar(core, 1000, 42);

  // PTT solto é o motivo mais comum, e o mais confundido com bug.
  const d = diag.forActor(1000);
  assert.strictEqual(d.canSpeakNow, false);
  assert.match(d.reason, /PTT/);

  core.pttDown(1000);
  assert.strictEqual(diag.forActor(1000).canSpeakNow, true);
  assert.strictEqual(diag.forActor(1000).reason, null);
  core.shutdown();
});

test('diagnóstico — o circuito aberto do gateway aparece, e não vira "bug de proximidade"', async () => {
  const gateway = createVoiceLiveKitGateway({
    fetchImpl: async () => { throw new Error('SFU morto'); },
    mintAdminToken: require('./livekit-token').mintAdminToken,
    logger: quiet, failureThreshold: 2
  });
  const core = createVoiceCore({ mp: { get: () => null, set() {} }, gateway, staffMute: createVoiceStaffMute(), logger: quiet });
  const diag = createVoiceDiagnostics({ core, staffMute: createVoiceStaffMute() });

  conectar(core, 1000, 42);
  for (let i = 0; i < 5; i++) await gateway.removeParticipant('actor-1-aaaa');

  const d = diag.forActor(1000);
  assert.strictEqual(d.gatewayState, 'FAILED');
  assert.match(d.gatewayLastError, /SFU morto|RemoveParticipant/);
  core.shutdown();
});

test('diagnóstico — a qualidade de conexão reportada aparece', () => {
  const { core, diag, telemetry } = montar();
  conectar(core, 1000, 42);
  assert.strictEqual(diag.forActor(1000).connectionQuality, null);
  telemetry.recordConnectionQuality(1000, 'poor');
  assert.strictEqual(diag.forActor(1000).connectionQuality, 'poor');
  core.shutdown();
});

// ── Privacidade ──────────────────────────────────────────────────────────────

test('diagnóstico — NÃO expõe o grafo de quem ouve quem', () => {
  // Materializar a lista de pares numa tela de moderação a transformaria num
  // grafo social consultável. A posição a staff já vê; derivar é outra coisa.
  const { core, diag } = montar([
    [1000, [0, 0, 0], '3c:Skyrim.esm'],
    [1001, [100, 0, 0], '3c:Skyrim.esm']
  ]);
  conectar(core, 1000, 42);
  conectar(core, 1001, 43);
  core.pttDown(1001);
  core.recompute('tick');

  const d = diag.forActor(1000);
  const texto = JSON.stringify(d);
  assert.ok(!('peers' in d), 'sem lista de pares');
  assert.ok(!('audience' in d), 'sem audiência');
  assert.ok(!texto.includes('1001'), 'o diagnóstico de um não deve citar o outro');
  core.shutdown();
});

test('diagnóstico — NÃO expõe token, nem no forceReconnect', () => {
  const { core, diag } = montar();
  const aberto = conectar(core, 1000, 42);
  assert.ok(aberto.token, 'a sessão tem token');

  const d = diag.forActor(1000);
  assert.ok(!JSON.stringify(d).includes(aberto.token), 'o relatório não pode carregar o token');

  const r = diag.forceReconnect(1000);
  assert.ok(!('token' in r), 'a resposta da ação não pode carregar o token');
  core.shutdown();
});

test('diagnóstico — o resumo de log não carrega conteúdo de conversa', () => {
  const { core, diag } = montar();
  conectar(core, 1000, 42);
  const linha = diag.summaryLine(1000);
  assert.match(linha, /connected=/);
  assert.match(linha, /proto=\d/);
  assert.ok(linha.length < 300, 'o resumo vai para a tabela de auditoria; precisa ser curto');
  core.shutdown();
});

// ── Ações ────────────────────────────────────────────────────────────────────

test('ação — disconnect tira a voz e NÃO tira do jogo', () => {
  const { core, diag } = montar();
  conectar(core, 1000, 42);
  assert.strictEqual(diag.forActor(1000).voiceConnected, true);

  const r = diag.disconnect(1000, 'cliente travado');
  assert.strictEqual(r.ok, true);
  assert.ok(r.identity, 'precisa devolver a identidade que saiu da sala');

  // A pessoa saiu da VOZ.
  assert.strictEqual(core.state.get(1000), null);
  assert.strictEqual(core.sessions.get(1000), null);
  // E o relatório volta a ser o de quem não está na voz — não o de quem foi
  // expulso do servidor, que este módulo nem sabe fazer.
  assert.strictEqual(diag.forActor(1000).voiceConnected, false);
  core.shutdown();
});

test('ação — disconnect em quem não está na voz recusa sem lançar', () => {
  const { core, diag } = montar();
  const r = diag.disconnect(999999);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /não está na cena de voz/);
  core.shutdown();
});

test('ação — forceReconnect PRESERVA a identidade', () => {
  // Trocar a identidade faria a volta parecer uma chegada e derrubaria as
  // assinaturas que os outros participantes já têm.
  const { core, diag } = montar();
  const aberto = conectar(core, 1000, 42);
  const identidade = aberto.session.identity;

  const r = diag.forceReconnect(1000);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.identity, identidade);
  assert.strictEqual(core.sessions.get(1000).identity, identidade);
  core.shutdown();
});

test('ação — forceReconnect recalcula a permissão durável', () => {
  // É o caso que justifica a ação existir: um /calar aplicado enquanto o
  // gateway estava fora precisa valer no token depois.
  const { core, diag, staffMute } = montar();
  conectar(core, 1000, 42);
  staffMute.mute(42, { reason: 'x' });

  const r = diag.forceReconnect(1000);
  assert.strictEqual(r.canPublish, false);
  core.shutdown();
});

test('ação — forceReconnect no backend legado diz a verdade em vez de fingir', () => {
  const { core, diag } = montar();
  core.attach(1000, { transport: 'legacy', characterId: 42 });

  const r = diag.forceReconnect(1000);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.transport, 'legacy');
  assert.match(r.note, /não tem token/);
  core.shutdown();
});

// ── Visão geral ──────────────────────────────────────────────────────────────

test('overview — conta o sistema sem citar ninguém', () => {
  const { core, diag } = montar([
    [1000, [0, 0, 0], '3c:Skyrim.esm'],
    [1001, [100, 0, 0], '3c:Skyrim.esm']
  ]);
  conectar(core, 1000, 42);
  conectar(core, 1001, 43);
  core.recompute('tick');

  const o = diag.overview();
  assert.strictEqual(o.actors, 2);
  assert.strictEqual(o.sessions, 2);
  assert.strictEqual(o.protocolVersion, VOICE_PROTOCOL_VERSION);
  assert.ok(o.metrics, 'a visão geral carrega as métricas voice_*');

  const texto = JSON.stringify(o);
  assert.ok(!texto.includes('1000') || !texto.includes('actorId'), 'a visão geral é agregada');
  core.shutdown();
});

test('roster — lista quem está na voz com o motivo de cada um', () => {
  const { core, diag, staffMute } = montar([
    [1000, [0, 0, 0], '3c:Skyrim.esm'],
    [1001, [100, 0, 0], '3c:Skyrim.esm']
  ]);
  conectar(core, 1000, 42);
  conectar(core, 1001, 43);
  staffMute.mute(43, { reason: 'gritaria' });

  const lista = diag.roster();
  assert.strictEqual(lista.length, 2);

  const calado = lista.find((r) => r.characterId === 43);
  assert.strictEqual(calado.staffMuted, true);
  assert.strictEqual(calado.canSpeakNow, false);
  assert.ok(calado.reason, 'a lista precisa dizer POR QUE, senão a staff clica em cada um');
  core.shutdown();
});
