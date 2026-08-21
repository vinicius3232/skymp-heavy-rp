/**
 * VOICE FAILURE nunca é GAME FAILURE.
 *
 * A regra tem uma frase e nove formas de ser violada. Este arquivo é uma por
 * cenário, e todas fazem a mesma pergunta: depois do desastre, **o laço de
 * proximidade ainda roda e o estado ainda é coerente?**
 *
 * ## O que estes testes NÃO provam
 *
 * Nenhum deles envolve um `livekit-server` real, um cliente Skyrim ou uma placa
 * de rede. O SFU aqui é um `fetchImpl` que se comporta mal sob comando. O que
 * está provado é que **o gamemode reage certo** a cada modo de falha — não que
 * o modo de falha aconteça exatamente assim no mundo. A diferença está no
 * relatório final, e é a mesma de sempre neste projeto.
 *
 * ## Por que `unhandledRejection` é o alvo principal
 *
 * O gamemode roda dentro do processo do servidor de jogo. Uma promessa rejeitada
 * sem tratamento ali não é um log feio: é o Node derrubando o processo inteiro,
 * levando junto o mundo, os NPCs e a sessão de todo mundo — por causa de um SFU
 * que não respondeu. É a forma mais provável de a voz derrubar o jogo, e por
 * isso cada cenário instala um detector e falha se ele disparar.
 */

const test = require('node:test');
const assert = require('node:assert');

const { createVoiceCore } = require('./voice-core');
const { createVoiceLiveKitGateway } = require('./livekit-gateway');
const { createVoiceStaffMute } = require('./voice-staff-mute');
const { CONNECTION_STATES } = require('./voice-state');

const quiet = { log() {}, warn() {}, error() {} };

/**
 * O `VoiceSessionService` lê a configuração do LiveKit de `process.env` por
 * chamada, de propósito (ver o cabeçalho dele). Então um teste que queira o
 * caminho LiveKit precisa configurá-lo de verdade — injetar env só no gateway
 * deixaria as sessões em DISABLED e todo `attach` voltaria sem token, o que se
 * pareceria com um bug do teste e não da configuração.
 *
 * `node --test` roda cada arquivo em processo próprio, então isto não escapa
 * daqui.
 */
process.env.LIVEKIT_URL = 'wss://sfu.teste';
process.env.LIVEKIT_API_KEY = 'chave-de-teste';
process.env.LIVEKIT_API_SECRET = 'segredo-de-teste-longo-o-bastante-para-hmac';
process.env.LIVEKIT_ROOM = 'skyvoice-teste';

/**
 * Conecta um ator pelo caminho LiveKit **completo**.
 *
 * `attach` deixa a sessão em CONNECTING; quem a leva a CONNECTED é o
 * `confirmConnected`, que no mundo real vem do cliente avisando que entrou na
 * sala. Pular esse passo deixaria `canSpeak` recusando por "conexão em
 * CONNECTING" — e um teste de falha que nunca chega a conectar não testa falha
 * nenhuma.
 */
function conectar(core, actorId, characterId) {
  const aberto = core.attach(actorId, { characterId });
  assert.ok(aberto.session, `attach de ${actorId} não produziu sessão`);
  core.sessions.confirmConnected(aberto.session.identity);
  return aberto;
}

/**
 * Roda um corpo com um detector de rejeição não tratada instalado.
 *
 * O `setImmediate` duplo no fim existe porque uma rejeição só é classificada
 * como não tratada depois que a microtask queue drena — sem a espera, o detector
 * estaria sempre limpo e o teste seria decorativo.
 */
async function semQuedaDoProcesso(body) {
  const caught = [];
  const onRejection = (err) => caught.push(err);
  process.on('unhandledRejection', onRejection);
  try {
    await body();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  } finally {
    process.off('unhandledRejection', onRejection);
  }
  assert.deepStrictEqual(
    caught.map((e) => (e && e.message) || String(e)), [],
    'rejeição não tratada: isto derrubaria o servidor de jogo'
  );
}

/** Um mundo falso com N atores, para o `sample()` ter o que ler. */
function fakeMp(actors) {
  return {
    get(actorId, field) {
      const a = actors.get(actorId);
      if (!a) return null;
      if (field === 'locationalData') {
        return { pos: a.pos, cellOrWorldDesc: a.space, rot: [0, 0, a.yaw || 0] };
      }
      return null;
    },
    set() {}
  };
}

function makeWorld(n, { space = '1a26f:Skyrim.esm', spread = 300 } = {}) {
  const actors = new Map();
  for (let i = 0; i < n; i++) {
    actors.set(1000 + i, { pos: [i * spread, 0, 0], space, yaw: 0 });
  }
  return actors;
}

/**
 * Um Voice Core com LiveKit configurado e um transporte HTTP sob controle.
 */
function coreComSfu(fetchImpl, over = {}) {
  const env = process.env;
  const gateway = createVoiceLiveKitGateway({
    env: () => env,
    fetchImpl,
    mintAdminToken: require('./livekit-token').mintAdminToken,
    logger: quiet,
    cooldownMs: over.cooldownMs ?? 50,
    timeoutMs: over.timeoutMs ?? 30
  });
  const actors = over.actors || makeWorld(4);
  const core = createVoiceCore({
    mp: fakeMp(actors),
    gateway,
    logger: quiet,
    staffMute: createVoiceStaffMute(),
    ...over.coreOpts
  });
  return { core, gateway, actors, env };
}

// ── 1. LiveKit reinicia ──────────────────────────────────────────────────────

test('falha — LiveKit reinicia: a voz degrada, o laço sobrevive, e ela volta', async () => {
  await semQuedaDoProcesso(async () => {
    let noAr = true;
    const { core, gateway } = coreComSfu(async () => {
      if (!noAr) throw new Error('ECONNREFUSED');
      return { ok: true, status: 200 };
    });

    core.attach(1000, { characterId: 1 });
    core.attach(1001, { characterId: 2 });
    core.recompute('tick');

    // O SFU cai.
    noAr = false;
    for (let i = 0; i < 10; i++) {
      await gateway.removeParticipant(`actor-${i}-aaaa`);
    }
    assert.strictEqual(gateway.describe().state, 'FAILED', 'o circuito precisa abrir');

    // O jogo continua exatamente igual: proximidade calculada, rotas emitidas.
    const antes = core.describe().actors;
    core.recompute('tick');
    assert.strictEqual(core.describe().actors, antes, 'nenhum ator perdido');
    assert.ok(core.peersFor(1000).length >= 0, 'a consulta de rota continua respondendo');

    // O SFU volta. Depois do cooldown, a meia-abertura deixa uma chamada passar.
    noAr = true;
    await new Promise((r) => setTimeout(r, 60));
    const volta = await gateway.removeParticipant('actor-9-bbbb');
    assert.strictEqual(volta.ok, true, 'precisa reconectar sozinho');
    assert.strictEqual(gateway.describe().state, 'CONNECTED');

    core.shutdown();
  });
});

// ── 2. Perda de rede ─────────────────────────────────────────────────────────

test('falha — a rede some no meio de um tick e o tick termina mesmo assim', async () => {
  await semQuedaDoProcesso(async () => {
    const { core } = coreComSfu(async () => { throw new Error('ENETUNREACH'); });

    for (let i = 0; i < 4; i++) core.attach(1000 + i, { characterId: i });

    // Vários ticks com a rede morta. Nenhum pode lançar.
    for (let i = 0; i < 20; i++) {
      assert.doesNotThrow(() => core.recompute('tick'), `tick ${i} lançou`);
    }
    assert.strictEqual(core.describe().actors, 4);
    core.shutdown();
  });
});

// ── 3. Latência alta / timeout ───────────────────────────────────────────────

test('falha — SFU lento não pendura o laço de proximidade', async () => {
  await semQuedaDoProcesso(async () => {
    // Uma chamada que nunca responde. Sem `AbortSignal.timeout` no gateway isto
    // seria uma promessa pendurada por tick, dentro do processo que também
    // precisa mover NPCs.
    const { core, gateway } = coreComSfu(
      (url, init) => new Promise((_resolve, reject) => {
        if (init && init.signal) {
          init.signal.addEventListener('abort', () => reject(new Error('AbortError')));
        }
      }),
      { timeoutMs: 20 }
    );

    core.attach(1000, { characterId: 1 });

    const t0 = Date.now();
    const r = await gateway.removeParticipant('actor-1-aaaa');
    const elapsed = Date.now() - t0;

    assert.strictEqual(r.ok, false);
    assert.ok(elapsed < 2000, `a chamada demorou ${elapsed} ms — o timeout não agiu`);
    // E o tick seguinte continua barato.
    assert.doesNotThrow(() => core.recompute('tick'));
    core.shutdown();
  });
});

// ── 4. Expiração de token ────────────────────────────────────────────────────

test('falha — token expirado é renovado sem virar um participante novo', async () => {
  await semQuedaDoProcesso(async () => {
    const { core } = coreComSfu(async () => ({ ok: true, status: 200 }));

    const aberto = conectar(core, 1000, 1);
    const identidadeOriginal = aberto.session.identity;
    assert.ok(aberto.token, 'a sessão precisa nascer com token');

    // O relógio passa do `exp`. A renovação é o caminho de reconexão.
    const renovado = core.sessions.renew(1000);
    assert.strictEqual(renovado.ok, true);
    assert.notStrictEqual(renovado.token, aberto.token, 'token novo');
    assert.strictEqual(
      renovado.session.identity, identidadeOriginal,
      'a identidade PRECISA sobreviver: trocá-la faria a volta parecer uma chegada, ' +
      'e derrubaria as assinaturas que os outros já têm'
    );
    core.shutdown();
  });
});

test('falha — emissão de token falhando vira FAILED, não exceção', async () => {
  await semQuedaDoProcesso(async () => {
    const env = { LIVEKIT_URL: 'wss://x', LIVEKIT_API_KEY: 'k', LIVEKIT_API_SECRET: 's' };
    const { createVoiceSessionService } = require('./voice-session');
    const sessions = createVoiceSessionService({
      env: () => env,
      logger: quiet,
      tokenIssuer: {
        ...require('./livekit-token'),
        mintAccessToken: () => { throw new Error('HSM fora do ar'); }
      }
    });

    let resultado;
    assert.doesNotThrow(() => { resultado = sessions.open(1000); });
    assert.strictEqual(resultado.ok, false);
    assert.strictEqual(resultado.session.state, CONNECTION_STATES.FAILED);
    assert.match(resultado.reason, /HSM fora do ar/);
  });
});

// ── 5. Cliente cai ───────────────────────────────────────────────────────────

test('falha — cliente some sem avisar: o sweep fecha a boca sozinho', async () => {
  await semQuedaDoProcesso(async () => {
    const { core } = coreComSfu(async () => ({ ok: true, status: 200 }));
    conectar(core, 1000, 1);
    core.pttDown(1000);
    core.noteAudioFrame(1000);
    assert.strictEqual(core.speaking.describe().speaking, 1, 'estava falando');

    // O cliente morre. Ninguém emite "parei de falar" — é o caso que não pode
    // depender de evento.
    core.detach(1000, 'clientCrash');

    assert.strictEqual(core.speaking.describe().speaking, 0, 'a boca precisa fechar');
    assert.strictEqual(core.state.get(1000), null, 'o estado sai junto');
    assert.strictEqual(core.sessions.get(1000), null, 'a sessão também');
    core.shutdown();
  });
});

test('falha — desconexão do SkyMP durante a fala não deixa rota órfã', async () => {
  await semQuedaDoProcesso(async () => {
    const actors = makeWorld(3, { spread: 100 });   // todos em alcance
    const { core } = coreComSfu(async () => ({ ok: true, status: 200 }), { actors });

    for (let i = 0; i < 3; i++) conectar(core, 1000 + i, i + 1);
    core.pttDown(1000);
    core.recompute('tick');
    assert.ok(core.routes.subscriptionCount() > 0, 'precisa haver assinatura para o teste valer');

    core.detach(1000, 'disconnect');
    core.recompute('tick');

    // Nenhuma assinatura pode citar quem saiu.
    for (const outro of [1001, 1002]) {
      const pares = core.peersFor(outro).map((p) => p.actorId);
      assert.ok(!pares.includes(1000), `1000 ainda aparece na rota de ${outro}`);
    }
    core.shutdown();
  });
});

// ── 6. Recarga da CEF ────────────────────────────────────────────────────────

test('falha — CEF recarrega: reconectar não cria uma segunda presença', async () => {
  await semQuedaDoProcesso(async () => {
    const removidos = [];
    const { core } = coreComSfu(async (url) => {
      if (url.includes('RemoveParticipant')) removidos.push(url);
      return { ok: true, status: 200 };
    });

    const primeira = core.attach(1000, { characterId: 1 });
    const segunda = core.attach(1000, { characterId: 1 });   // a CEF recarregou

    assert.notStrictEqual(segunda.session.identity, primeira.session.identity);
    assert.strictEqual(segunda.evicted, primeira.session.identity, 'a anterior é despejada por decisão explícita');
    assert.strictEqual(core.sessions.size(), 1, 'uma pessoa, uma sessão');

    await new Promise((r) => setImmediate(r));
    assert.ok(removidos.length >= 1, 'o despejo precisa chegar ao SFU');
    core.shutdown();
  });
});

// ── 7. Perda de pacote ───────────────────────────────────────────────────────

test('falha — quadros faltando param a fala em vez de congelar a boca aberta', async () => {
  await semQuedaDoProcesso(async () => {
    let agora = 1_000_000;
    const { core } = coreComSfu(async () => ({ ok: true, status: 200 }), {
      coreOpts: { now: () => agora }
    });

    conectar(core, 1000, 1);
    core.pttDown(1000);
    core.noteAudioFrame(1000);
    assert.strictEqual(core.speaking.describe().speaking, 1);

    // A rede engasga: os quadros param de chegar, mas o PTT continua apertado.
    // Sem o sweep, `speaking` ficaria verdadeiro para sempre e a boca do
    // personagem ficaria aberta.
    agora += 5000;
    core.speaking.sweep();
    assert.strictEqual(core.speaking.describe().speaking, 0, 'silêncio prolongado precisa parar a fala');
    core.shutdown();
  });
});

// ── 8. Reconexão ─────────────────────────────────────────────────────────────

test('falha — ciclo de queda e volta cem vezes não vaza estado', async () => {
  await semQuedaDoProcesso(async () => {
    const { core } = coreComSfu(async () => ({ ok: true, status: 200 }));

    for (let i = 0; i < 100; i++) {
      core.attach(1000, { characterId: 1 });
      core.pttDown(1000);
      core.noteAudioFrame(1000);
      core.recompute('tick');
      core.detach(1000, 'reconnect');
    }

    const d = core.describe();
    assert.strictEqual(d.actors, 0, 'nenhum estado de ator sobrou');
    assert.strictEqual(d.sessions, 0, 'nenhuma sessão sobrou');
    assert.strictEqual(d.subscriptions, 0, 'nenhuma assinatura sobrou');
    assert.strictEqual(d.speaking.tracked, 0, 'ninguém ficou marcado como falante');
    core.shutdown();
  });
});

test('falha — laço de reconexão não abre o circuito por engano', async () => {
  await semQuedaDoProcesso(async () => {
    // Uma sessão que reabre muitas vezes não é falha de rede. Se ela contasse
    // como falha, um jogador com internet instável abriria o circuito para
    // TODO MUNDO no servidor.
    const { core, gateway } = coreComSfu(async () => ({ ok: true, status: 200 }));
    for (let i = 0; i < 30; i++) {
      core.attach(1000, { characterId: 1 });
      core.detach(1000, 'flap');
    }
    await new Promise((r) => setImmediate(r));
    assert.notStrictEqual(gateway.describe().state, 'FAILED');
    assert.strictEqual(gateway.describe().consecutiveFailures, 0);
    core.shutdown();
  });
});

// ── 9. O laço em si ──────────────────────────────────────────────────────────

test('falha — um assinante de rotas que lança não mata o tick', async () => {
  await semQuedaDoProcesso(async () => {
    const { core } = coreComSfu(async () => ({ ok: true, status: 200 }));
    core.onRoutes(() => { throw new Error('painel quebrado'); });
    core.attach(1000, { characterId: 1 });

    for (let i = 0; i < 5; i++) {
      assert.doesNotThrow(() => core.recompute('tick'));
    }
    assert.ok(core.metrics.snapshot().counters['core.subscriberError'] > 0, 'o erro precisa ser contado');
    core.shutdown();
  });
});

test('falha — `mp` sumindo no meio do jogo não derruba o laço', async () => {
  await semQuedaDoProcesso(async () => {
    let mundo = fakeMp(makeWorld(3));
    const gateway = createVoiceLiveKitGateway({
      env: () => ({}), logger: quiet
    });
    const core = createVoiceCore({
      // O `mp` é resolvido a cada leitura de propósito; aqui ele começa a
      // lançar, que é o que um host em teardown faz.
      mp: { get: (...a) => mundo.get(...a), set: () => {} },
      gateway, logger: quiet, staffMute: createVoiceStaffMute()
    });

    for (let i = 0; i < 3; i++) core.attach(1000 + i, { transport: 'legacy', characterId: i });
    core.recompute('tick');

    mundo = { get() { throw new Error('mp em teardown'); }, set() {} };
    for (let i = 0; i < 5; i++) {
      assert.doesNotThrow(() => core.recompute('tick'), 'o laço não pode morrer com o mundo indo embora');
    }
    core.shutdown();
  });
});

test('falha — o timer do tick continua agendado depois de um tick que lança', async () => {
  await semQuedaDoProcesso(async () => {
    let chamadas = 0;
    const gateway = createVoiceLiveKitGateway({ env: () => ({}), logger: quiet });
    const core = createVoiceCore({
      mp: {
        get() { chamadas++; throw new Error('leitura falhou'); },
        set() {}
      },
      gateway, logger: quiet, tickMs: 5, staffMute: createVoiceStaffMute()
    });
    core.attach(1000, { transport: 'legacy', characterId: 1 });
    core.start();

    await new Promise((r) => setTimeout(r, 60));
    core.stop();

    // Um `setInterval` cujo callback lança perde o tick e continua agendado —
    // mas só se o callback tratar. Se ele não tratar, a rejeição sobe.
    assert.ok(chamadas > 2, `o laço parou depois de ${chamadas} tentativas`);
    core.shutdown();
  });
});

// ── 10. Degradação, não desligamento ─────────────────────────────────────────

test('falha — com o SFU inteiro fora, a REGRA de quem ouve quem continua certa', async () => {
  await semQuedaDoProcesso(async () => {
    // É o ponto da arquitetura: o LiveKit é transporte. Com ele fora, o gamemode
    // ainda sabe quem ouviria quem — o que para é a otimização de banda, não a
    // regra de mundo.
    const actors = new Map([
      [1000, { pos: [0, 0, 0], space: 'A', yaw: 0 }],
      [1001, { pos: [200, 0, 0], space: 'A', yaw: 0 }],     // perto, mesma célula
      [1002, { pos: [200, 0, 0], space: 'B', yaw: 0 }]      // mesmas coordenadas, OUTRA célula
    ]);
    const { core } = coreComSfu(async () => { throw new Error('SFU morto'); }, { actors });

    for (const id of [1000, 1001, 1002]) conectar(core, id, id - 999);
    core.pttDown(1001);
    core.recompute('tick');

    const ouvidos = core.peersFor(1000).map((p) => p.actorId);
    assert.ok(ouvidos.includes(1001), 'quem está perto na mesma célula continua sendo ouvido');
    assert.ok(!ouvidos.includes(1002), 'a vedação entre células vale mesmo com o SFU fora');
    core.shutdown();
  });
});
