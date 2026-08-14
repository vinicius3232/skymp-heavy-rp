/**
 * core/voice/voice-session.test.js
 *
 * A ponte `actorId ↔ identity`, e os quatro cenários que ela existe para
 * sobreviver: identidade inválida, participante duplicado, reconexão e
 * cleanup.
 *
 * O teste de identidade inválida é o mais importante e o menos óbvio. Não basta
 * recusar `"nao-sou-um-ator"`: qualquer um sabe escrever `actor-42-deadbeef`,
 * que **passa** no formato. O que separa uma identidade válida de uma forjada é
 * ela estar no registro do servidor, e é isso que os casos abaixo exercitam.
 *
 * Executa com: node --test core/voice/voice-session.test.js
 */

const assert = require('assert');
const { describe, it, beforeEach } = require('node:test');

const { createVoiceStateService, CONNECTION_STATES } = require('./voice-state');
const { createVoiceSessionService, resolveLiveKitConfig, DEFAULT_ROOM } = require('./voice-session');
const livekitToken = require('./livekit-token');

const A = 4001;
const B = 4002;

const CONFIGURADO = {
  LIVEKIT_URL: 'ws://127.0.0.1:7880',
  LIVEKIT_API_KEY: 'skyvoice_test',
  LIVEKIT_API_SECRET: 'segredo-de-bancada-nao-vai-para-lugar-nenhum'
};

const silencioso = { log: () => {}, warn: () => {}, error: () => {} };

function montar(env = CONFIGURADO, extra = {}) {
  const state = createVoiceStateService();
  let n = 0;
  const sessions = createVoiceSessionService({
    state,
    env: () => env,
    // Nonce determinístico e HEXADECIMAL. O alfabeto não é escolha estética:
    // `livekit-token.actorIdFromIdentity` só reconhece `[0-9a-f]+`, e uma
    // sessão cuja identidade não volta a ser o actorId é recusada no `open`.
    // Ver o caso "gerador de nonce fora do alfabeto" no fim deste arquivo.
    nonce: () => `a${(++n).toString(16)}`,
    logger: silencioso,
    ...extra
  });
  return { state, sessions };
}

describe('voice-session — configuração', () => {
  it('sem configuração o estado é DISABLED, com o que falta nomeado — não é falha', () => {
    const { state, sessions } = montar({});
    state.ensure(A);
    const r = sessions.open(A, { characterId: 1 });

    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /LIVEKIT_URL/);
    assert.match(r.reason, /LIVEKIT_API_KEY/);
    assert.match(r.reason, /LIVEKIT_API_SECRET/);
    assert.strictEqual(r.session.state, CONNECTION_STATES.DISABLED);
    assert.strictEqual(state.get(A).connection, CONNECTION_STATES.DISABLED);
  });

  it('DISABLED é distinto de FAILED — um é servidor sem voz, o outro é incidente', () => {
    const { sessions } = montar({});
    sessions.open(A);
    assert.notStrictEqual(sessions.get(A).state, CONNECTION_STATES.FAILED);
  });

  it('resolveLiveKitConfig traduz sala e lista o que falta', () => {
    assert.strictEqual(resolveLiveKitConfig(CONFIGURADO).room, DEFAULT_ROOM);
    assert.strictEqual(resolveLiveKitConfig({ ...CONFIGURADO, LIVEKIT_ROOM: 'outra' }).room, 'outra');
    assert.deepStrictEqual(resolveLiveKitConfig({}).missing,
      ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET']);
  });

  it('actorId inválido é recusado antes de qualquer coisa', () => {
    const { sessions } = montar();
    for (const lixo of [undefined, null, NaN, 'A', {}]) {
      const r = sessions.open(/** @type {any} */(lixo));
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.session, null);
    }
  });
});

describe('voice-session — identidade é derivada, nunca aceita', () => {
  let ctx;
  beforeEach(() => { ctx = montar(); });

  it('a identidade sai do actorId do servidor, com nonce próprio', () => {
    ctx.state.ensure(A);
    const r = ctx.sessions.open(A, { characterId: 7 });

    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.session.identity, `actor-${A}-a1`);
    assert.strictEqual(livekitToken.actorIdFromIdentity(r.session.identity), A);
    assert.strictEqual(r.session.state, CONNECTION_STATES.CONNECTING);
  });

  it('o token é aceitável e NÃO carrega o API secret', () => {
    ctx.sessions.open(A);
    const { token } = ctx.sessions.open(B);
    assert.ok(!token.includes(CONFIGURADO.LIVEKIT_API_SECRET));

    const payload = livekitToken.decodePayloadUnsafe(token);
    assert.strictEqual(payload.sub, `actor-${B}-a2`);
    assert.strictEqual(payload.video.room, DEFAULT_ROOM);
    assert.deepStrictEqual(payload.video.canPublishSources, ['microphone']);
    assert.strictEqual(payload.video.roomAdmin, false);
    assert.strictEqual(payload.video.canPublishData, false);
  });

  it('IDENTIDADE INVÁLIDA: formato correto mas não emitida por nós é recusada', () => {
    ctx.sessions.open(A);

    // Todas passam no formato `actor-<n>-<hex>`; nenhuma está no registro.
    for (const forjada of [`actor-${B}-a1`, 'actor-999-abcdef', `actor-${A}-outronce`]) {
      assert.strictEqual(ctx.sessions.resolveActor(forjada), null, `${forjada} deveria ser recusada`);
      const r = ctx.sessions.confirmConnected(forjada);
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.actorId, null);
    }
  });

  it('IDENTIDADE INVÁLIDA: lixo que nem parece identidade', () => {
    ctx.sessions.open(A);
    for (const lixo of ['', 'admin', 'actor--', null, undefined, 42, {}]) {
      assert.strictEqual(ctx.sessions.resolveActor(/** @type {any} */(lixo)), null);
    }
  });

  it('a identidade emitida resolve, e confirmar leva a CONNECTED', () => {
    ctx.state.ensure(A);
    const { session } = ctx.sessions.open(A);

    assert.strictEqual(ctx.sessions.resolveActor(session.identity), A);
    const r = ctx.sessions.confirmConnected(session.identity);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.actorId, A);
    assert.strictEqual(ctx.sessions.get(A).state, CONNECTION_STATES.CONNECTED);
    assert.strictEqual(ctx.state.get(A).connection, CONNECTION_STATES.CONNECTED);
    assert.strictEqual(ctx.sessions.isConnected(A), true);
  });
});

describe('voice-session — participante duplicado', () => {
  let ctx;
  beforeEach(() => { ctx = montar(); });

  it('abrir duas vezes gera identidade NOVA e despeja a anterior explicitamente', () => {
    const primeira = ctx.sessions.open(A);
    const segunda = ctx.sessions.open(A);

    assert.notStrictEqual(primeira.session.identity, segunda.session.identity);
    assert.strictEqual(segunda.evicted, primeira.session.identity,
      'a antiga tem que sair por decisão do servidor, não por colisão de chave');
    assert.strictEqual(segunda.session.generation, 2);
  });

  it('a identidade superada para de resolver na mesma hora', () => {
    const primeira = ctx.sessions.open(A);
    ctx.sessions.open(A);

    assert.strictEqual(ctx.sessions.resolveActor(primeira.session.identity), null);
    assert.strictEqual(ctx.sessions.confirmConnected(primeira.session.identity).ok, false);
  });

  it('há uma sessão por ator, nunca duas', () => {
    ctx.sessions.open(A);
    ctx.sessions.open(A);
    ctx.sessions.open(A);
    assert.strictEqual(ctx.sessions.size(), 1);
    assert.strictEqual(ctx.sessions.all().length, 1);
  });

  it('atores diferentes nunca colidem de identidade', () => {
    const a = ctx.sessions.open(A);
    const b = ctx.sessions.open(B);
    assert.notStrictEqual(a.session.identity, b.session.identity);
    assert.strictEqual(ctx.sessions.resolveActor(a.session.identity), A);
    assert.strictEqual(ctx.sessions.resolveActor(b.session.identity), B);
  });
});

describe('voice-session — reconexão', () => {
  let ctx;
  beforeEach(() => { ctx = montar(); });

  it('renew MANTÉM a identidade — a volta não pode parecer uma chegada', () => {
    const aberta = ctx.sessions.open(A);
    ctx.sessions.confirmConnected(aberta.session.identity);

    const renovada = ctx.sessions.renew(A);
    assert.strictEqual(renovada.ok, true);
    assert.strictEqual(renovada.session.identity, aberta.session.identity);
    assert.strictEqual(renovada.session.state, CONNECTION_STATES.RECONNECTING);
    assert.ok(renovada.token);
    assert.notStrictEqual(renovada.token, aberta.token, 'o token é novo mesmo com a identidade igual');
  });

  it('a identidade renovada continua resolvendo, e reconfirmar volta a CONNECTED', () => {
    const aberta = ctx.sessions.open(A);
    ctx.sessions.confirmConnected(aberta.session.identity);
    ctx.sessions.markReconnecting(A);
    ctx.sessions.renew(A);

    assert.strictEqual(ctx.sessions.resolveActor(aberta.session.identity), A);
    assert.strictEqual(ctx.sessions.confirmConnected(aberta.session.identity).ok, true);
    assert.strictEqual(ctx.sessions.isConnected(A), true);
  });

  it('renew sem sessão aberta não cria uma do nada', () => {
    const r = ctx.sessions.renew(A);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'sem sessão aberta');
    assert.strictEqual(ctx.sessions.size(), 0);
  });

  it('renew sem configuração falha sem derrubar a sessão que existe', () => {
    let env = { ...CONFIGURADO };
    const state = createVoiceStateService();
    const sessions = createVoiceSessionService({ state, env: () => env, logger: silencioso });
    sessions.open(A);

    env = {};
    const r = sessions.renew(A);
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /não configurado/);
    assert.ok(sessions.get(A), 'a sessão continua registrada');
  });

  it('markReconnecting e markFailed espelham no VoiceStateService', () => {
    ctx.state.ensure(A);
    const aberta = ctx.sessions.open(A);
    ctx.sessions.confirmConnected(aberta.session.identity);

    ctx.sessions.markReconnecting(A);
    assert.strictEqual(ctx.state.get(A).connection, CONNECTION_STATES.RECONNECTING);

    ctx.sessions.markFailed(A, 'SFU fora do ar');
    assert.strictEqual(ctx.state.get(A).connection, CONNECTION_STATES.FAILED);
    assert.strictEqual(ctx.sessions.get(A).lastError, 'SFU fora do ar');
  });

  it('a queda derruba o PTT — voltar não devolve o microfone aberto', () => {
    ctx.state.ensure(A, { characterId: 1 });
    const aberta = ctx.sessions.open(A);
    ctx.sessions.confirmConnected(aberta.session.identity);
    ctx.state.setTransmitting(A, true);

    ctx.sessions.markReconnecting(A);
    assert.strictEqual(ctx.state.get(A).transmitting, false);

    ctx.sessions.confirmConnected(aberta.session.identity);
    assert.strictEqual(ctx.state.get(A).transmitting, false);
  });
});

describe('voice-session — desconexão, logout e cleanup', () => {
  let ctx;
  beforeEach(() => { ctx = montar(); });

  it('close devolve a identidade que precisa sair da sala', () => {
    const aberta = ctx.sessions.open(A);
    const r = ctx.sessions.close(A, 'logout');

    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.identity, aberta.session.identity);
    assert.strictEqual(r.reason, 'logout');
  });

  it('depois do close nada resolve mais — nem a identidade, nem a sessão', () => {
    const aberta = ctx.sessions.open(A);
    ctx.sessions.close(A);

    assert.strictEqual(ctx.sessions.get(A), null);
    assert.strictEqual(ctx.sessions.resolveActor(aberta.session.identity), null);
    assert.strictEqual(ctx.sessions.isConnected(A), false);
    assert.strictEqual(ctx.sessions.size(), 0);
  });

  it('close é idempotente — logout e disconnect podem chegar em qualquer ordem', () => {
    ctx.sessions.open(A);
    assert.strictEqual(ctx.sessions.close(A, 'disconnect').ok, true);
    assert.strictEqual(ctx.sessions.close(A, 'logout').ok, false);
    assert.strictEqual(ctx.sessions.close(A, 'cleanup').ok, false);
  });

  it('closeAll devolve todas as identidades e esvazia o registro', () => {
    const a = ctx.sessions.open(A);
    const b = ctx.sessions.open(B);

    const identidades = ctx.sessions.closeAll('shutdown');
    assert.deepStrictEqual(identidades.sort(), [a.session.identity, b.session.identity].sort());
    assert.strictEqual(ctx.sessions.size(), 0);
  });

  it('reabrir depois do close é uma sessão nova, com identidade nova', () => {
    const primeira = ctx.sessions.open(A);
    ctx.sessions.close(A);
    const segunda = ctx.sessions.open(A);

    assert.notStrictEqual(segunda.session.identity, primeira.session.identity);
    assert.strictEqual(segunda.evicted, null, 'não há o que despejar: a anterior já saiu');
  });
});

describe('voice-session — a identidade tem que sobreviver à leitura de volta', () => {
  /**
   * Este caso existe por causa de um defeito real encontrado ao escrever os
   * testes acima: quem MONTA a identidade é o `voice-session`, quem a LÊ é o
   * `livekit-token`, e o leitor exige um alfabeto (`[0-9a-f]+` no nonce) que o
   * gerador não declarava em lugar nenhum.
   *
   * Com um nonce fora do alfabeto, `open` respondia `ok: true`, o token era
   * emitido e aceito, e só `resolveActor` devolvia `null` — depois, longe
   * daqui, com o sintoma "ninguém ouve ninguém" e nenhum erro no caminho.
   */
  it('gerador de nonce fora do alfabeto é recusado no open, com o motivo nomeado', () => {
    const state = createVoiceStateService();
    const sessions = createVoiceSessionService({
      state,
      env: () => CONFIGURADO,
      nonce: () => 'NONCE-EM-MAIÚSCULA',
      logger: silencioso
    });
    state.ensure(A);

    const r = sessions.open(A);
    assert.strictEqual(r.ok, false, 'não pode responder ok para uma identidade que não resolve');
    assert.match(r.reason, /hexadecimal minúsculo/);
    assert.strictEqual(r.session.state, CONNECTION_STATES.FAILED);
    assert.strictEqual(sessions.resolveActor(r.session.identity), null);
  });

  it('o nonce de produção está dentro do alfabeto — sem gerador injetado', () => {
    const state = createVoiceStateService();
    const sessions = createVoiceSessionService({ state, env: () => CONFIGURADO, logger: silencioso });
    for (let i = 0; i < 50; i++) {
      const r = sessions.open(A + i);
      assert.strictEqual(r.ok, true, `o nonce padrão falhou na tentativa ${i}: ${r.reason}`);
      assert.strictEqual(sessions.resolveActor(r.session.identity), A + i);
    }
  });
});

describe('voice-session — falha de emissão não derruba nada', () => {
  it('token que lança vira FAILED com o motivo, sem exceção subindo', () => {
    const state = createVoiceStateService();
    const sessions = createVoiceSessionService({
      state,
      env: () => CONFIGURADO,
      logger: silencioso,
      tokenIssuer: {
        ...livekitToken,
        mintAccessToken: () => { throw new Error('secret corrompido'); }
      }
    });
    state.ensure(A);

    const r = sessions.open(A);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'secret corrompido');
    assert.strictEqual(r.session.state, CONNECTION_STATES.FAILED);
    assert.strictEqual(state.get(A).connection, CONNECTION_STATES.FAILED);
  });
});
