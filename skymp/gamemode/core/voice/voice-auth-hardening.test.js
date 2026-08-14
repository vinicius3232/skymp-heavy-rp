/**
 * As duas camadas de autorização do transporte, e os defeitos que elas fecham.
 *
 * 1. **Token de operador.** Ele não existia. O `livekit-gateway` recusa toda
 *    chamada sem um emissor, devolvendo `{ok:false, skipped:true}` — sem erro,
 *    sem falha de circuito, sem métrica de falha. Nenhum caminho de produção
 *    passava um, então `UpdateSubscriptions` nunca saiu do processo.
 *
 * 2. **`canPublish` no token do jogador.** Saía sempre `true`. O silêncio
 *    dependia inteiramente da camada de assinatura — que é justamente a que o
 *    circuito aberto desliga para não derrubar o jogo.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  mintAccessToken, mintAdminToken, decodePayloadUnsafe,
  participantIdentity, actorIdFromIdentity,
  DEFAULT_TTL_SECONDS, ADMIN_TTL_SECONDS
} = require('./livekit-token');
const { createVoiceSessionService } = require('./voice-session');
const { createVoiceLiveKitGateway } = require('./livekit-gateway');

const API_KEY = 'APIchavedeteste';
const API_SECRET = 'segredo-de-teste-longo-o-suficiente-para-hmac';

// ── Token de operador ────────────────────────────────────────────────────────

test('token de operador — não entra na sala', () => {
  // `roomJoin: false` é o que impede este token de virar uma presença na cena de
  // voz caso vaze. Ele autoriza ADMINISTRAR a sala pela API, não estar dentro.
  const payload = decodePayloadUnsafe(mintAdminToken({ apiKey: API_KEY, apiSecret: API_SECRET, room: 'skyvoice' }));
  assert.strictEqual(payload.video.roomJoin, false);
  assert.strictEqual(payload.video.roomAdmin, true);
});

test('token de operador — não publica nem assina mídia', () => {
  const payload = decodePayloadUnsafe(mintAdminToken({ apiKey: API_KEY, apiSecret: API_SECRET, room: 'skyvoice' }));
  assert.strictEqual(payload.video.canPublish, false);
  assert.strictEqual(payload.video.canSubscribe, false);
  assert.strictEqual(payload.video.canPublishData, false);
});

test('token de operador — preso a UMA sala, e sala é obrigatória', () => {
  // Um `roomAdmin` sem sala administra TODAS as salas do servidor. Hoje há uma
  // só, o que faria a diferença passar despercebida — e é por isso que é travada
  // agora, enquanto o erro é barato.
  assert.throws(
    () => mintAdminToken({ apiKey: API_KEY, apiSecret: API_SECRET }),
    /room ausente/
  );
  const payload = decodePayloadUnsafe(mintAdminToken({ apiKey: API_KEY, apiSecret: API_SECRET, room: 'sala-x' }));
  assert.strictEqual(payload.video.room, 'sala-x');
});

test('token de operador — vive muito menos que o do jogador', () => {
  const now = 1_700_000_000_000;
  const admin = decodePayloadUnsafe(mintAdminToken({ apiKey: API_KEY, apiSecret: API_SECRET, room: 'r', now }));
  const player = decodePayloadUnsafe(mintAccessToken({
    apiKey: API_KEY, apiSecret: API_SECRET, room: 'r', identity: 'actor-1-aa', now
  }));

  assert.strictEqual(admin.exp - Math.floor(now / 1000), ADMIN_TTL_SECONDS);
  assert.strictEqual(player.exp - Math.floor(now / 1000), DEFAULT_TTL_SECONDS);
  assert.ok(ADMIN_TTL_SECONDS < DEFAULT_TTL_SECONDS);
});

test('token de operador — o secret não aparece no token', () => {
  const token = mintAdminToken({ apiKey: API_KEY, apiSecret: API_SECRET, room: 'skyvoice' });
  assert.ok(!token.includes(API_SECRET));
  assert.ok(!JSON.stringify(decodePayloadUnsafe(token)).includes(API_SECRET));
});

test('token de operador — o `sub` não é confundível com o de um jogador', () => {
  // Um `sub` que casasse com `actor-<id>-<nonce>` faria um token de operador
  // parecer o de um jogador na leitura de um log — e vice-versa.
  const payload = decodePayloadUnsafe(mintAdminToken({ apiKey: API_KEY, apiSecret: API_SECRET, room: 'r' }));
  assert.strictEqual(actorIdFromIdentity(payload.sub), null);
});

test('token de operador — secret errado produz assinatura diferente', () => {
  const a = mintAdminToken({ apiKey: API_KEY, apiSecret: API_SECRET, room: 'r', now: 1000 });
  const b = mintAdminToken({ apiKey: API_KEY, apiSecret: 'outro-segredo-completamente', room: 'r', now: 1000 });
  assert.notStrictEqual(a.split('.')[2], b.split('.')[2]);
});

// ── O gateway deixa de ser inerte ────────────────────────────────────────────

test('gateway — sem emissor de token, toda chamada é pulada em silêncio', () => {
  // Reproduz o defeito original: é assim que o gateway se comportava em
  // produção, e nada no describe() denunciava.
  const gateway = createVoiceLiveKitGateway({
    env: () => ({ LIVEKIT_URL: 'wss://x', LIVEKIT_API_KEY: 'k', LIVEKIT_API_SECRET: 's' }),
    fetchImpl: async () => { throw new Error('não deveria chegar à rede'); },
    mintAdminToken: null,
    logger: { log() {}, warn() {}, error() {} }
  });

  return gateway.removeParticipant('actor-1-aa').then((r) => {
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.skipped, true);
    assert.match(r.reason, /token de operador/);
    assert.strictEqual(gateway.describe().consecutiveFailures, 0, 'nem contava como falha');
  });
});

test('gateway — o voice-core real passa um emissor, e a chamada sai', async () => {
  // A prova de que a fiação foi corrigida: monta o Voice Core como produção o
  // monta (sem injetar gateway) e confere que a chamada chega ao transporte.
  const { createVoiceCore } = require('./voice-core');
  const calls = [];

  const env = {
    LIVEKIT_URL: 'wss://sfu.exemplo.tld',
    LIVEKIT_API_KEY: API_KEY,
    LIVEKIT_API_SECRET: API_SECRET,
    LIVEKIT_ROOM: 'skyvoice'
  };
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }

  try {
    const core = createVoiceCore({ logger: { log() {}, warn() {}, error() {} } });
    // Substitui só o transporte HTTP, mantendo o resto da fiação real.
    const gateway = createVoiceLiveKitGateway({
      metrics: core.metrics,
      logger: { log() {}, warn() {}, error() {} },
      mintAdminToken: require('./livekit-token').mintAdminToken,
      fetchImpl: async (url, init) => {
        calls.push({ url, auth: init.headers.Authorization });
        return { ok: true, status: 200 };
      }
    });

    const result = await gateway.removeParticipant('actor-7-abcd');
    assert.strictEqual(result.ok, true, `esperava sucesso, veio ${JSON.stringify(result)}`);
    assert.strictEqual(calls.length, 1);
    assert.match(calls[0].url, /twirp\/livekit\.RoomService\/RemoveParticipant$/);
    assert.match(calls[0].auth, /^Bearer eyJ/, 'precisa ir um JWT no header');

    // E o JWT precisa ser o de operador, não o de um jogador.
    const jwt = calls[0].auth.replace('Bearer ', '');
    assert.strictEqual(decodePayloadUnsafe(jwt).video.roomAdmin, true);
    assert.ok(!calls[0].auth.includes(API_SECRET), 'o secret nunca vai no header');
  } finally {
    for (const k of Object.keys(env)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
});

// ── canPublish no token do jogador ───────────────────────────────────────────

function sessionEnv(over = {}) {
  return {
    LIVEKIT_URL: 'wss://sfu.exemplo.tld',
    LIVEKIT_API_KEY: API_KEY,
    LIVEKIT_API_SECRET: API_SECRET,
    LIVEKIT_ROOM: 'skyvoice',
    ...over
  };
}

function makeSessions(over) {
  return createVoiceSessionService({
    env: () => sessionEnv(over),
    logger: { log() {}, warn() {}, error() {} }
  });
}

test('sessão — por padrão o jogador publica e assina', () => {
  const sessions = makeSessions();
  const opened = sessions.open(101);
  assert.strictEqual(opened.ok, true);
  const payload = decodePayloadUnsafe(opened.token);
  assert.strictEqual(payload.video.canPublish, true);
  assert.strictEqual(payload.video.canSubscribe, true);
});

test('sessão — canPublish:false vira negação NO TOKEN, não só na rota', () => {
  // É a camada que sobrevive ao circuito aberto do gateway. Sem ela, um
  // jogador silenciado pela staff voltaria a ser ouvido assim que o SFU
  // ficasse inalcançável pelo gamemode.
  const sessions = makeSessions();
  const opened = sessions.open(102, { canPublish: false });
  const payload = decodePayloadUnsafe(opened.token);
  assert.strictEqual(payload.video.canPublish, false);
  assert.strictEqual(payload.video.canSubscribe, true, 'quem é calado continua ouvindo');
});

test('sessão — quem é calado continua assinando: punição não é desconexão', () => {
  const sessions = makeSessions();
  const opened = sessions.open(103, { canPublish: false });
  assert.strictEqual(opened.session.canSubscribe, true);
  assert.strictEqual(opened.session.canPublish, false);
});

test('sessão — a renovação NÃO devolve a voz de quem foi calado', () => {
  // A reconexão seria a forma trivial de desfazer a punição: bastaria cair e
  // voltar. `renew` preserva a permissão durável quando ninguém a muda.
  const sessions = makeSessions();
  sessions.open(104, { canPublish: false });
  const renewed = sessions.renew(104);
  assert.strictEqual(renewed.ok, true);
  assert.strictEqual(decodePayloadUnsafe(renewed.token).video.canPublish, false);
});

test('sessão — a renovação pode APERTAR a permissão de quem já está conectado', () => {
  const sessions = makeSessions();
  sessions.open(105);
  assert.strictEqual(decodePayloadUnsafe(sessions.open(105).token).video.canPublish, true);

  const tightened = sessions.renew(105, { canPublish: false });
  assert.strictEqual(decodePayloadUnsafe(tightened.token).video.canPublish, false);
  assert.strictEqual(sessions.get(105).canPublish, false);
});

test('sessão — a renovação pode SOLTAR de novo (descalar)', () => {
  const sessions = makeSessions();
  sessions.open(106, { canPublish: false });
  const released = sessions.renew(106, { canPublish: true });
  assert.strictEqual(decodePayloadUnsafe(released.token).video.canPublish, true);
});

test('sessão — nem publicando nem calado o token ganha direitos de operador', () => {
  const sessions = makeSessions();
  for (const canPublish of [true, false]) {
    const payload = decodePayloadUnsafe(sessions.open(200 + Number(canPublish), { canPublish }).token);
    assert.strictEqual(payload.video.roomAdmin, false);
    assert.strictEqual(payload.video.roomCreate, false);
    assert.strictEqual(payload.video.canPublishData, false);
    assert.deepStrictEqual(payload.video.canPublishSources, ['microphone']);
  }
});

// ── Spoofing e replay ────────────────────────────────────────────────────────

test('identidade — o cliente não escolhe a sua: `open` ignora identity no opts', () => {
  const sessions = makeSessions();
  // Passa uma identidade alheia junto do pedido, como um cliente hostil faria.
  const opened = sessions.open(300, { identity: 'actor-999-cafe', characterId: 5 });
  assert.notStrictEqual(opened.session.identity, 'actor-999-cafe');
  assert.strictEqual(actorIdFromIdentity(opened.session.identity), 300);
});

test('identidade — resolveActor recusa identidade bem formada que não emitimos', () => {
  const sessions = makeSessions();
  sessions.open(301);
  // O formato bate. Qualquer um sabe escrever isto.
  assert.strictEqual(actorIdFromIdentity('actor-301-deadbeef'), 301);
  // E ainda assim não resolve, porque não está no registro do servidor.
  assert.strictEqual(sessions.resolveActor('actor-301-deadbeef'), null);
});

test('identidade — a sessão superada para de resolver imediatamente', () => {
  // É a defesa contra replay de uma identidade antiga: reabrir gera nonce novo,
  // e a anterior deixa de ser reconhecida no mesmo instante.
  const sessions = makeSessions();
  const first = sessions.open(302).session.identity;
  const second = sessions.open(302).session.identity;

  assert.notStrictEqual(first, second);
  assert.strictEqual(sessions.resolveActor(first), null, 'a superada não resolve mais');
  assert.strictEqual(sessions.resolveActor(second), 302);
});

test('identidade — confirmConnected recusa identidade desconhecida', () => {
  const sessions = makeSessions();
  const r = sessions.confirmConnected('actor-1-naoexiste');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.actorId, null);
});

test('token — cada emissão tem jti próprio', () => {
  // Não impede replay sozinho (o LiveKit não guarda jti), mas é o que torna
  // dois tokens distinguíveis num log de auditoria.
  const a = decodePayloadUnsafe(mintAccessToken({ apiKey: API_KEY, apiSecret: API_SECRET, room: 'r', identity: 'actor-1-aa', now: 1000 }));
  const b = decodePayloadUnsafe(mintAccessToken({ apiKey: API_KEY, apiSecret: API_SECRET, room: 'r', identity: 'actor-1-aa', now: 1000 }));
  assert.notStrictEqual(a.jti, b.jti);
});

test('token — a janela de replay é o TTL, e ela é curta e declarada', () => {
  const now = 1_700_000_000_000;
  const p = decodePayloadUnsafe(mintAccessToken({
    apiKey: API_KEY, apiSecret: API_SECRET, room: 'r', identity: 'actor-1-aa', now
  }));
  assert.strictEqual(p.exp - p.nbf, DEFAULT_TTL_SECONDS + 10, 'TTL + folga de relógio');
  assert.ok(DEFAULT_TTL_SECONDS <= 600, 'um crachá de entrada não deve valer mais que 10 min');
});

test('identidade — participantIdentity produz hexadecimal que sobrevive à leitura', () => {
  for (let i = 0; i < 50; i++) {
    const identity = participantIdentity(i * 7 + 1);
    assert.strictEqual(actorIdFromIdentity(identity), i * 7 + 1);
  }
});
