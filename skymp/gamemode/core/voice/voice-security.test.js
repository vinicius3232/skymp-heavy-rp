const test = require('node:test');
const assert = require('node:assert');

const {
  audit, enforceAtBoot, assertNoSecretsIn, checkOrigin, isProductionLike, SEVERITY
} = require('./voice-security');

/** Ambiente mínimo de bancada: voz ligada, backend legado, tudo local. */
function benchEnv(over = {}) {
  return {
    NODE_ENV: 'local',
    ENABLE_VOIP_SERVICE: 'true',
    VOICE_BACKEND: 'legacy',
    VOIP_BIND_HOST: '127.0.0.1',
    ...over
  };
}

/** Ambiente de produção com LiveKit corretamente configurado. */
function prodEnv(over = {}) {
  return {
    NODE_ENV: 'production',
    ENABLE_VOIP_SERVICE: 'true',
    VOICE_BACKEND: 'livekit',
    LIVEKIT_URL: 'wss://voz.exemplo.tld',
    LIVEKIT_API_KEY: 'APIchave',
    LIVEKIT_API_SECRET: 'a'.repeat(64),
    VOIP_BIND_HOST: '127.0.0.1',
    ...over
  };
}

const idsOf = (r) => r.findings.map((f) => f.id);

test('voice-security — o ambiente correto de produção passa limpo', () => {
  const result = audit(prodEnv());
  assert.strictEqual(result.ok, true, `achados: ${JSON.stringify(result.findings, null, 2)}`);
  assert.strictEqual(result.fatal.length, 0);
  assert.strictEqual(result.production, true);
});

test('voice-security — a bancada padrão passa limpo', () => {
  const result = audit(benchEnv());
  assert.strictEqual(result.ok, true, `achados: ${JSON.stringify(result.findings, null, 2)}`);
});

test('voice-security — NODE_ENV decide a severidade da MESMA configuração', () => {
  // Este é o caso que justifica três níveis em vez de dois. `ws://127.0.0.1`
  // é o certo numa bancada e é o access token de todo jogador em texto puro
  // na internet em produção.
  const bench = audit(benchEnv({ VOICE_BACKEND: 'livekit', LIVEKIT_URL: 'ws://127.0.0.1:7880', LIVEKIT_API_KEY: 'k', LIVEKIT_API_SECRET: 'b'.repeat(64) }));
  const prod = audit(prodEnv({ LIVEKIT_URL: 'ws://127.0.0.1:7880' }));

  const benchTls = bench.findings.find((f) => f.id === 'VOICE-SEC-003');
  const prodTls = prod.findings.find((f) => f.id === 'VOICE-SEC-003');

  assert.strictEqual(benchTls.severity, SEVERITY.NOTE, 'loopback em bancada é nota');
  assert.strictEqual(prodTls.severity, SEVERITY.FATAL, 'ws:// em produção é fatal');
  assert.strictEqual(bench.ok, true);
  assert.strictEqual(prod.ok, false);
});

test('voice-security — ws:// remoto fora de produção é WARN, não nota', () => {
  const r = audit(benchEnv({
    VOICE_BACKEND: 'livekit', LIVEKIT_URL: 'ws://voz.exemplo.tld',
    LIVEKIT_API_KEY: 'k', LIVEKIT_API_SECRET: 'c'.repeat(64)
  }));
  const tls = r.findings.find((f) => f.id === 'VOICE-SEC-003');
  assert.strictEqual(tls.severity, SEVERITY.WARN);
});

test('voice-security — ticket de debug é fatal em produção e aviso na bancada', () => {
  const prod = audit(prodEnv({ VOIP_DEBUG_EXPOSE_TICKET: 'true' }));
  const bench = audit(benchEnv({ VOIP_DEBUG_EXPOSE_TICKET: 'true' }));

  assert.strictEqual(prod.ok, false);
  assert.ok(prod.fatal.some((f) => f.id === 'VOICE-SEC-001'));
  assert.strictEqual(bench.ok, true);
  assert.strictEqual(bench.findings.find((f) => f.id === 'VOICE-SEC-001').severity, SEVERITY.WARN);
});

test('voice-security — só a string "true" liga o andaime', () => {
  for (const value of ['1', 'yes', 'TRUE', 'sim', '']) {
    const r = audit(prodEnv({ VOIP_DEBUG_EXPOSE_TICKET: value }));
    assert.ok(!idsOf(r).includes('VOICE-SEC-001'), `${JSON.stringify(value)} não deveria ligar`);
  }
});

test('voice-security — bind em curinga sem TLS é fatal em produção', () => {
  for (const host of ['0.0.0.0', '::', '']) {
    const r = audit(prodEnv({ VOICE_BACKEND: 'legacy', VOIP_BIND_HOST: host }));
    assert.ok(
      r.fatal.some((f) => f.id === 'VOICE-SEC-006'),
      `VOIP_BIND_HOST=${JSON.stringify(host)} deveria ser fatal`
    );
  }
});

test('voice-security — VOIP_BIND_HOST ausente é 127.0.0.1, não curinga', () => {
  // O `ws` trata string vazia como todas as interfaces, mas ausência é o padrão
  // do voip-service, que é loopback. Confundir os dois transformaria um
  // servidor correto num achado fatal.
  const env = prodEnv({ VOICE_BACKEND: 'legacy' });
  delete env.VOIP_BIND_HOST;
  const r = audit(env);
  assert.ok(!idsOf(r).includes('VOICE-SEC-006'));
});

test('voice-security — o achado de exposição só vale para o backend legado', () => {
  // Com LiveKit o relay WebSocket não transporta áudio; apontar o bind dele
  // como exposição de voz seria um achado que não descreve nada.
  const r = audit(prodEnv({ VOICE_BACKEND: 'livekit', VOIP_BIND_HOST: '0.0.0.0' }));
  assert.ok(!idsOf(r).includes('VOICE-SEC-006'));
});

test('voice-security — secret curto é fatal em produção', () => {
  const r = audit(prodEnv({ LIVEKIT_API_SECRET: 'curtinho' }));
  assert.ok(r.fatal.some((f) => f.id === 'VOICE-SEC-005'));
});

test('voice-security — livekit sem credencial não sobe', () => {
  const r = audit(prodEnv({ LIVEKIT_API_SECRET: '' }));
  assert.ok(r.fatal.some((f) => f.id === 'VOICE-SEC-004'));
});

test('voice-security — qualquer variável de vídeo no sistema de voz é fatal', () => {
  const r = audit(prodEnv({ LIVEKIT_ENABLE_VIDEO: 'true' }));
  assert.ok(r.fatal.some((f) => f.id === 'VOICE-SEC-009'));
});

test('voice-security — enforceAtBoot derruba o processo com achado fatal', () => {
  const codes = [];
  const lines = [];
  const logger = { log: (l) => lines.push(l), warn: (l) => lines.push(l), error: (l) => lines.push(l) };

  enforceAtBoot({ env: prodEnv({ VOIP_DEBUG_EXPOSE_TICKET: 'true' }), logger, exit: (c) => codes.push(c) });

  assert.deepStrictEqual(codes, [1], 'deveria sair com 1');
  assert.ok(lines.some((l) => l.includes('VOICE-SEC-001')), 'o motivo precisa aparecer no log');
});

test('voice-security — enforceAtBoot não derruba um ambiente correto', () => {
  const codes = [];
  const logger = { log: () => {}, warn: () => {}, error: () => {} };
  const r = enforceAtBoot({ env: prodEnv(), logger, exit: (c) => codes.push(c) });
  assert.deepStrictEqual(codes, []);
  assert.strictEqual(r.ok, true);
});

// ── Vazamento de segredo ─────────────────────────────────────────────────────

test('voice-security — o VALOR do segredo é detectado, não o nome', () => {
  const env = { LIVEKIT_API_SECRET: 'S3cr3t0-muito-longo-e-improvavel-000' };

  // O nome sozinho não é vazamento: um payload pode citar a variável.
  assert.strictEqual(
    assertNoSecretsIn({ hint: 'defina LIVEKIT_API_SECRET' }, env).clean, true
  );

  // O valor é.
  const leak = assertNoSecretsIn({ config: { apiSecret: env.LIVEKIT_API_SECRET } }, env);
  assert.strictEqual(leak.clean, false);
  assert.deepStrictEqual(leak.leaked, ['LIVEKIT_API_SECRET']);
});

test('voice-security — o segredo escondido no fundo de um objeto é achado', () => {
  const env = { SOUL_SECRET: 'alma-secreta-longa-o-suficiente' };
  const payload = { a: { b: [{ c: { d: env.SOUL_SECRET } }] } };
  assert.strictEqual(assertNoSecretsIn(payload, env).clean, false);
});

test('voice-security — segredo curto demais não gera alarme falso', () => {
  // Com um segredo `"1"`, toda mensagem contendo o dígito 1 seria acusada.
  const env = { LIVEKIT_API_SECRET: '1' };
  assert.strictEqual(assertNoSecretsIn({ port: 7778 }, env).clean, true);
});

test('voice-security — o ticket de voz real não carrega segredo nenhum', () => {
  // O payload exato que `voip-service` empurra ao cliente.
  const env = { LIVEKIT_API_SECRET: 'x'.repeat(48), SOUL_SECRET: 'y'.repeat(48) };
  const payload = { port: 7778, ticket: 'abc123', host: '127.0.0.1', role: 'listener' };
  assert.strictEqual(assertNoSecretsIn(payload, env).clean, true);
});

test('voice-security — payload não serializável não é declarado limpo', () => {
  const circular = {};
  circular.self = circular;
  assert.strictEqual(assertNoSecretsIn(circular, {}).clean, false);
});

// ── Origem ───────────────────────────────────────────────────────────────────

test('voice-security — sem allowlist tudo passa', () => {
  assert.strictEqual(checkOrigin('https://qualquer.tld', {}).allowed, true);
});

test('voice-security — origem fora da allowlist é recusada', () => {
  const env = { VOICE_ALLOWED_ORIGINS: 'http://localhost:3001,skyrim://overlay' };
  assert.strictEqual(checkOrigin('https://evil.tld', env).allowed, false);
  assert.strictEqual(checkOrigin('skyrim://overlay', env).allowed, true);
  assert.strictEqual(checkOrigin('http://localhost:3001', env).allowed, true);
});

test('voice-security — Origin ausente passa: o helper nativo não é navegador', () => {
  // Recusar aqui fecharia o único caminho de captura provado do projeto, e não
  // protegeria de nada: quem escolhe o header escolhe omiti-lo.
  const env = { VOICE_ALLOWED_ORIGINS: 'skyrim://overlay' };
  assert.strictEqual(checkOrigin(undefined, env).allowed, true);
  assert.strictEqual(checkOrigin('', env).allowed, true);
});

test('voice-security — allowlist com espaços em volta funciona', () => {
  const env = { VOICE_ALLOWED_ORIGINS: ' skyrim://overlay , http://a.tld ' };
  assert.strictEqual(checkOrigin('skyrim://overlay', env).allowed, true);
  assert.strictEqual(checkOrigin('http://a.tld', env).allowed, true);
});

test('voice-security — isProductionLike cobre staging', () => {
  assert.strictEqual(isProductionLike({ NODE_ENV: 'production' }), true);
  assert.strictEqual(isProductionLike({ NODE_ENV: 'staging' }), true);
  assert.strictEqual(isProductionLike({ NODE_ENV: 'local' }), false);
  assert.strictEqual(isProductionLike({}), false);
});
