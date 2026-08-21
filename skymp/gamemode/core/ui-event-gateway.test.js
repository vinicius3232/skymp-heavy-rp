const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { createUiEventGateway, installUiEventGateway, NOME_DO_EVENTO, SNIPPET_DO_CLIENTE } = require('./ui-event-gateway');

function setup({ valid = true, dispatch } = {}) {
  const calls = [];
  const logs = [];
  const router = {
    isValidEventEnvelope: () => valid,
    dispatch: dispatch || (async () => { calls.push('dispatch'); })
  };
  const gateway = createUiEventGateway({
    uiEventRouter: router,
    handleChatInput: (actorId, text) => calls.push(['chat', actorId, text]),
    logger: {
      log: (...args) => logs.push(['log', ...args]),
      warn: (...args) => logs.push(['warn', ...args]),
      error: (...args) => logs.push(['error', ...args])
    }
  });
  return { gateway, calls, logs };
}

describe('ui-event-gateway', () => {
  it('recusa envelope invalido antes de rotear ou chamar chat', () => {
    const { gateway, calls, logs } = setup({ valid: false });
    assert.equal(gateway(0xff000001, null), false);
    assert.deepEqual(calls, []);
    assert.equal(logs[0][0], 'warn');
  });

  it('roteia um evento valido, preserva chat e redige seu payload nos logs', async () => {
    const { gateway, calls, logs } = setup();
    assert.equal(gateway(0xff000001, { type: 'cef::chat:send', data: 'segredo-do-jogador' }), true);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, ['dispatch', ['chat', 0xff000001, 'segredo-do-jogador']]);
    assert.ok(logs[0].join(' ').includes('type=cef::chat:send data=string'));
    assert.ok(!logs[0].join(' ').includes('segredo-do-jogador'));
  });

  it('erro assincrono do roteador e registrado sem lancar no callback SkyMP', async () => {
    const { gateway, logs } = setup({ dispatch: async () => { throw new Error('router boom'); } });
    assert.equal(gateway(0xff000001, { type: 'panel:open' }), true);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(logs.some(entry => entry[0] === 'error' && entry.join(' ').includes('router boom')));
  });

  it('falha sincrona de chat nao escapa do callback SkyMP', () => {
    const router = { isValidEventEnvelope: () => true, dispatch: async () => {} };
    const errors = [];
    const gateway = createUiEventGateway({
      uiEventRouter: router,
      handleChatInput: () => { throw new Error('chat boom'); },
      logger: { log: () => {}, warn: () => {}, error: (...args) => errors.push(args) }
    });
    assert.equal(gateway(1, { type: 'cef::chat:send', data: 'ola' }), false);
    assert.ok(errors[0].join(' ').includes('chat boom'));
  });

  // ─────────────────────────────────────────────────────────────────────────
  // installUiEventGateway — BOUND-004: mp.onUiEvent nunca foi chamado pelo
  // SkyMP (docs/research/SKYMP_INTEGRATION_AUDIT.md §5). A correção troca
  // isso por mp.makeEventSource('_onUiEvent', ...) + mp._onUiEvent.
  // ─────────────────────────────────────────────────────────────────────────

  it('registra o event source com o nome certo (precisa comecar com _) e o snippet certo', () => {
    const mp = { makeEventSource: (nome, snippet) => { mp._registeredAs = { nome, snippet }; } };
    installUiEventGateway(mp, {
      uiEventRouter: { isValidEventEnvelope: () => true, dispatch: async () => {} },
      handleChatInput: () => {},
      logger: { log: () => {}, warn: () => {}, error: () => {} }
    });
    assert.equal(mp._registeredAs.nome, NOME_DO_EVENTO);
    assert.ok(NOME_DO_EVENTO.startsWith('_'), 'ActionListener::OnCustomEvent exige nome comecando com _');
    assert.equal(mp._registeredAs.snippet, SNIPPET_DO_CLIENTE);
    assert.ok(SNIPPET_DO_CLIENTE.includes("ctx.sp.on('browserMessage'"), 'snippet precisa escutar browserMessage, nao onUiEvent');
  });

  it('NAO atribui mais mp.onUiEvent — é exatamente o que o BOUND-004 provou morto', () => {
    const mp = { makeEventSource: () => {} };
    installUiEventGateway(mp, {
      uiEventRouter: { isValidEventEnvelope: () => true, dispatch: async () => {} },
      handleChatInput: () => {},
      logger: { log: () => {}, warn: () => {}, error: () => {} }
    });
    assert.equal(mp.onUiEvent, undefined);
  });

  it('mp._onUiEvent(pcFormId, uiEvent) despacha para o gateway com args[0] como o envelope', () => {
    const mp = { makeEventSource: () => {} };
    const calls = [];
    const gateway = installUiEventGateway(mp, {
      uiEventRouter: { isValidEventEnvelope: () => true, dispatch: async () => { calls.push('dispatch'); } },
      handleChatInput: () => {},
      logger: { log: () => {}, warn: () => {}, error: () => {} }
    });
    assert.equal(typeof mp._onUiEvent, 'function');
    const resultado = mp._onUiEvent(0xff000001, { type: 'panel:open' });
    assert.equal(resultado, true);
    assert.equal(resultado, gateway(0xff000001, { type: 'panel:open' }));
  });

  it('sem mp.makeEventSource (versão de SkyMP sem introspeção _sp3/event source): avisa e não lança, gateway continua utilizável diretamente', () => {
    const mp = {};
    const logs = [];
    const gateway = installUiEventGateway(mp, {
      uiEventRouter: { isValidEventEnvelope: () => true, dispatch: async () => {} },
      handleChatInput: () => {},
      logger: { log: () => {}, warn: (...a) => logs.push(a), error: () => {} }
    });
    assert.equal(mp._onUiEvent, undefined);
    assert.ok(logs.some((l) => l.join(' ').includes('makeEventSource indisponivel')));
    assert.equal(typeof gateway, 'function');
  });

  it('rejeita mp inválido', () => {
    assert.throws(() => installUiEventGateway(null, {}));
  });

  it('interrompe o despacho quando o limitador configurado recusa o evento', () => {
    const { calls, logs } = setup();
    const limitedGateway = createUiEventGateway({
      uiEventRouter: { isValidEventEnvelope: () => true, dispatch: async () => calls.push('dispatch') },
      handleChatInput: () => calls.push('chat'),
      rateLimiter: { observe: () => ({ allowed: false }) },
      logger: { log: (...args) => logs.push(args), warn: (...args) => logs.push(args), error: () => {} }
    });
    assert.equal(limitedGateway(1, { type: 'panel:open' }), false);
    assert.deepEqual(calls, []);
    assert.ok(logs[0].join(' ').includes('rate limited'));
  });
});
