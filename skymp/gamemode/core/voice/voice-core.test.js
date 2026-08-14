/**
 * core/voice/voice-core.test.js
 *
 * Integração: os módulos ligados, com um `mp` falso que responde
 * `locationalData` no mesmo formato do SkyMP (`{pos, cellOrWorldDesc}`).
 *
 * O que este arquivo protege e nenhum dos outros protege:
 *
 *   - **teleporte e troca de célula são DETECTADOS**, comparando amostras. O
 *     SkyMP não emite evento para nenhum dos dois, e um requisito que depende
 *     de um evento inexistente é um requisito que nunca é cumprido;
 *   - **o imediato é imediato e o coalescimento coalesce**. As duas coisas se
 *     contradizem se implementadas com desatenção, e é fácil escrever um teste
 *     que passa nas duas por acidente;
 *   - **o gamemode sobrevive ao SFU morto**, que é a promessa da etapa.
 *
 * Executa com: node --test core/voice/voice-core.test.js
 */

const assert = require('assert');
const { describe, it, beforeEach } = require('node:test');

const { VOICE_RANGES } = require('../proximity-ranges');
const { createVoiceCore, DEFAULT_TICK_MS } = require('./voice-core');
const { CONNECTION_STATES, createVoiceStateService } = require('./voice-state');
const { createVoiceSessionService } = require('./voice-session');

const A = 5001;
const B = 5002;
const C = 5003;
const CELL = '162e2:Skyrim.esm';
const OUTRA_CELL = '1a2b3:Skyrim.esm';
const WORLDSPACE = '3c:Skyrim.esm';

const silencioso = { log: () => {}, warn: () => {}, error: () => {} };
const CONFIGURADO = {
  LIVEKIT_URL: 'ws://127.0.0.1:7880',
  LIVEKIT_API_KEY: 'k',
  LIVEKIT_API_SECRET: 's'
};

/** `mp` falso, no formato exato do SkyMP. */
function fakeMp() {
  const locais = new Map();
  return {
    locais,
    get(actorId, prop) {
      if (prop !== 'locationalData') return undefined;
      return locais.get(actorId) || null;
    },
    por(actorId, pos, cell = CELL) {
      locais.set(actorId, { pos, cellOrWorldDesc: cell, rot: [0, 0, 0] });
    }
  };
}

/**
 * Núcleo de teste. `schedule` é síncrono para que o recompute crítico aconteça
 * dentro do próprio caso, sem `await` de temporizador — o que se quer observar é
 * a coalescência, não o event loop.
 *
 * A configuração do LiveKit é **injetada**, nunca lida do ambiente. O serviço de
 * sessão padrão lê `process.env`, e um teste que dependesse disso passaria na
 * máquina de quem exportou as variáveis e falharia no `npm test` de todo mundo
 * — que é exatamente o tipo de teste que acaba desligado.
 */
function montar({ gateway, env = CONFIGURADO, schedule = (fn) => fn(), ...extra } = {}) {
  const mp = fakeMp();
  const state = extra.state || createVoiceStateService();
  const core = createVoiceCore({
    mp,
    logger: silencioso,
    schedule,
    minCriticalIntervalMs: 0,
    gateway: gateway || gatewayFalso().gateway,
    state,
    sessions: createVoiceSessionService({ state, env: () => env, logger: silencioso }),
    ...extra
  });
  return { mp, core };
}

/** Gateway falso que registra o que recebeu, sem rede. */
function gatewayFalso() {
  const chamadas = { subscribe: [], unsubscribe: [], removed: [] };
  const gateway = {
    async applySubscriptionDiff(diff) {
      if (!diff) return { ok: true, calls: 0, skipped: true };
      chamadas.subscribe.push(...diff.subscribe);
      chamadas.unsubscribe.push(...diff.unsubscribe);
      return { ok: true, calls: diff.subscribe.length + diff.unsubscribe.length, skipped: false };
    },
    async removeParticipant(identity) { chamadas.removed.push(identity); return { ok: true }; },
    async mutePublishedTrack() { return { ok: true }; },
    describe: () => ({ state: 'CONNECTED', configured: true, missing: [] }),
    reset: () => {}
  };
  return { gateway, chamadas };
}

/** Coloca o ator na cena, conectado, com PTT apertado e posição definida. */
function entrar(core, mp, actorId, pos, cell = CELL, { falando = true, mode = 'normal' } = {}) {
  mp.por(actorId, pos, cell);
  core.attach(actorId, { characterId: actorId });
  const session = core.sessions.get(actorId);
  core.sessions.confirmConnected(session.identity);
  core.requestVoiceMode(actorId, mode);
  if (falando) core.pttDown(actorId);
}

describe('voice-core — amostragem é a fronteira de autoridade', () => {
  it('posição e célula vêm do mp, uma leitura por ator', () => {
    const { mp, core } = montar();
    entrar(core, mp, A, [10, 20, 30]);

    const { samples } = core.sample();
    assert.strictEqual(samples.length, 1);
    // `rot` entra na amostra na Etapa 3 e vem do MESMO `locationalData` — uma
    // ida ao `mp`, dois campos. O fake não declara `rot`, e o núcleo cai em
    // `[0, 0, 0]`: falta de orientação não pode custar a rota de ninguém.
    assert.deepStrictEqual(samples[0], { actorId: A, space: CELL, pos: [10, 20, 30], rot: [0, 0, 0] });
  });

  it('leitura que falha REMOVE o ator da amostra em vez de reaproveitar a anterior', () => {
    const { mp, core } = montar();
    entrar(core, mp, A, [0, 0, 0]);
    core.sample();

    mp.locais.delete(A);
    const { samples } = core.sample();
    assert.strictEqual(samples.length, 0, 'rota sobre posição velha não é regra defensável');
  });

  it('mp que lança não derruba a amostragem dos outros', () => {
    const mp = fakeMp();
    const original = mp.get.bind(mp);
    const core = createVoiceCore({
      mp: { get: (id, p) => { if (id === A) throw new Error('boom'); return original(id, p); } },
      logger: silencioso, schedule: (fn) => fn(), gateway: gatewayFalso().gateway
    });
    mp.por(A, [0, 0, 0]);
    mp.por(B, [0, 0, 0]);
    core.attach(A, { characterId: A });
    core.attach(B, { characterId: B });

    const { samples } = core.sample();
    assert.deepStrictEqual(samples.map((s) => s.actorId), [B]);
  });

  /**
   * Duas regressões reais moram neste caso, e as duas tinham o mesmo sintoma:
   * o servidor sobe, o laço roda, ninguém ouve ninguém, e não há erro em lugar
   * nenhum para investigar.
   *
   *   1. O `mp` era capturado no construtor. O `voip-service` instancia o Voice
   *      Core ao ser carregado — antes de o host publicar o global —, e o
   *      núcleo congelava `null` para sempre.
   *   2. Ao corrigir (1), o parâmetro destruturado chamava-se `mp` e
   *      **sombreava o global** dentro da função que ia lê-lo.
   */
  it('sem mp injetado, o núcleo lê o global do host — resolvido a cada leitura', () => {
    const core = createVoiceCore({ logger: silencioso, schedule: (fn) => fn(), gateway: gatewayFalso().gateway });
    const anterior = globalThis.mp;
    try {
      // Ator anexado ANTES de existir mundo: é a ordem real de boot.
      core.attach(A, { characterId: A, transport: 'legacy' });
      assert.deepStrictEqual(core.sample().samples, [], 'sem mundo, nenhuma amostra');

      globalThis.mp = {
        get: (id, prop) => (prop === 'locationalData' && id === A
          ? { pos: [1, 2, 3], rot: [0, 0, 90], cellOrWorldDesc: CELL }
          : null)
      };

      const { samples } = core.sample();
      assert.deepStrictEqual(samples, [{ actorId: A, space: CELL, pos: [1, 2, 3], rot: [0, 0, 90] }],
        'o global publicado depois tem que ser enxergado');
    } finally {
      if (anterior === undefined) delete globalThis.mp;
      else globalThis.mp = anterior;
    }
  });

  it('sem mp o núcleo funciona sem mundo, sem lançar', () => {
    const core = createVoiceCore({ mp: null, logger: silencioso, gateway: gatewayFalso().gateway });
    core.attach(A, { characterId: A });
    const r = core.recompute('tick');
    assert.strictEqual(r.routeCount, 0);
  });
});

describe('voice-core — mudanças críticas são imediatas', () => {
  it('TROCA DE CÉLULA é detectada e corta a rota', () => {
    const { mp, core } = montar();
    entrar(core, mp, A, [0, 0, 0]);
    entrar(core, mp, B, [100, 0, 0], CELL, { falando: false });

    core.recompute('tick');
    assert.strictEqual(core.audienceFor(A).length, 1, 'na mesma célula, B ouve A');

    mp.por(B, [100, 0, 0], OUTRA_CELL);
    const { critical } = core.sample();
    assert.deepStrictEqual(critical, [{ actorId: B, reason: 'spaceChange' }]);

    core.recompute('tick');
    assert.strictEqual(core.audienceFor(A).length, 0, 'noutra célula, não ouve mais');
  });

  it('TROCA DE WORLDSPACE é o mesmo caminho — no SkyMP é o mesmo campo', () => {
    const { mp, core } = montar();
    entrar(core, mp, A, [0, 0, 0], WORLDSPACE);
    entrar(core, mp, B, [50, 0, 0], WORLDSPACE, { falando: false });
    core.recompute('tick');
    assert.strictEqual(core.audienceFor(A).length, 1);

    mp.por(B, [50, 0, 0], CELL);
    const { critical } = core.sample();
    assert.deepStrictEqual(critical, [{ actorId: B, reason: 'spaceChange' }]);
    core.recompute('tick');
    assert.strictEqual(core.audienceFor(A).length, 0);
  });

  it('TELEPORTE dentro da mesma célula é detectado por salto de posição', () => {
    const { mp, core } = montar();
    entrar(core, mp, A, [0, 0, 0]);
    entrar(core, mp, B, [100, 0, 0], CELL, { falando: false });
    core.sample();

    // Passo normal: não é teleporte.
    mp.por(B, [160, 0, 0]);
    assert.deepStrictEqual(core.sample().critical, []);

    // Salto de 20.000 unidades: é.
    mp.por(B, [20000, 0, 0]);
    assert.deepStrictEqual(core.sample().critical, [{ actorId: B, reason: 'teleport' }]);
  });

  it('teleporte corta a rota no MESMO ciclo, sem esperar o tick', () => {
    const { mp, core } = montar();
    entrar(core, mp, A, [0, 0, 0]);
    entrar(core, mp, B, [100, 0, 0], CELL, { falando: false });
    core.recompute('tick');
    assert.strictEqual(core.audienceFor(A).length, 1);

    mp.por(B, [999999, 0, 0]);
    core.recompute('critical');
    assert.strictEqual(core.audienceFor(A).length, 0);
  });

  it('voiceMode, mute, PTT e detach agendam recompute imediato', () => {
    const ciclos = [];
    const { mp, core } = montar({ schedule: (fn) => { ciclos.push('agendado'); fn(); } });
    entrar(core, mp, A, [0, 0, 0]);

    const antes = ciclos.length;
    core.requestVoiceMode(A, 'shout');
    core.requestMute(A, true);
    core.requestMute(A, false);
    core.pttDown(A);
    core.pttUp(A);
    assert.ok(ciclos.length > antes, 'cada mudança relevante tem que forçar um ciclo');
  });

  it('reafirmar o mesmo modo NÃO força recompute — é o mesmo princípio do diff', () => {
    const ciclos = [];
    const { mp, core } = montar({ schedule: (fn) => { ciclos.push(1); fn(); } });
    entrar(core, mp, A, [0, 0, 0]);
    core.requestVoiceMode(A, 'shout');

    const antes = ciclos.length;
    for (let i = 0; i < 10; i++) core.requestVoiceMode(A, 'shout');
    assert.strictEqual(ciclos.length, antes, 'dez vezes o mesmo modo é zero recompute');
  });
});

describe('voice-core — rapid voiceMode switching não vira carga escolhida pelo cliente', () => {
  /**
   * `markCritical` tem dois caminhos e os dois precisam ser observados:
   * fora da janela do piso ele roda no `schedule` (imediato), dentro dela ele
   * roda no `defer` (adiado). Contar só um dos dois deixaria o outro livre
   * para regredir — e é o adiado que protege o servidor da rajada.
   */
  function nucleoComRelogio(minCriticalIntervalMs = 50) {
    const estado = { relogio: 1000, imediatos: [], adiados: [] };
    const mp = fakeMp();
    const state = createVoiceStateService();
    const core = createVoiceCore({
      mp, logger: silencioso,
      now: () => estado.relogio,
      minCriticalIntervalMs,
      schedule: (fn) => estado.imediatos.push(fn),
      defer: (fn, ms) => estado.adiados.push({ fn, ms }),
      state,
      sessions: createVoiceSessionService({ state, env: () => CONFIGURADO, logger: silencioso }),
      gateway: gatewayFalso().gateway
    });
    estado.pendentes = () => estado.imediatos.length + estado.adiados.length;
    estado.drenar = () => {
      const todos = [...estado.imediatos, ...estado.adiados.map((d) => d.fn)];
      estado.imediatos.length = 0;
      estado.adiados.length = 0;
      for (const fn of todos) fn();
    };
    return { mp, core, ...estado, get relogioRef() { return estado; } };
  }

  it('cem trocas DENTRO da janela do piso viram UM ciclo adiado', () => {
    const t = nucleoComRelogio(50);
    t.mp.por(A, [0, 0, 0]);
    t.core.attach(A, { characterId: A });
    t.drenar(); // consome o ciclo do attach; a partir daqui só as trocas contam

    const modos = ['whisper', 'normal', 'shout'];
    for (let i = 0; i < 100; i++) t.core.requestVoiceMode(A, modos[i % 3]);

    // O relógio não andou: as cem trocas caem todas dentro do piso.
    assert.strictEqual(t.imediatos.length, 0, 'dentro do piso nada roda imediatamente');
    assert.strictEqual(t.adiados.length, 1,
      `cem trocas produziram ${t.adiados.length} ciclos adiados; o cliente não escolhe a carga do servidor`);
    assert.ok(t.adiados[0].ms > 0 && t.adiados[0].ms <= 50);
  });

  it('cem trocas FORA da janela viram UM ciclo imediato, não cem', () => {
    const t = nucleoComRelogio(50);
    t.mp.por(A, [0, 0, 0]);
    t.core.attach(A, { characterId: A });
    t.drenar();

    t.relogioRef.relogio += 500; // o piso já passou

    const modos = ['whisper', 'normal', 'shout'];
    for (let i = 0; i < 100; i++) t.core.requestVoiceMode(A, modos[i % 3]);

    assert.strictEqual(t.imediatos.length, 1, 'a primeira roda já; as outras 99 coalescem nela');
    assert.strictEqual(t.adiados.length, 0);
  });

  it('a última troca não é perdida — coalescer não é descartar', () => {
    const t = nucleoComRelogio(50);
    const longe = VOICE_RANGES.whisper + 100; // fora do sussurro, dentro do grito

    entrar(t.core, t.mp, A, [0, 0, 0]);
    entrar(t.core, t.mp, B, [longe, 0, 0], CELL, { falando: false });
    t.drenar();
    t.core.recompute('tick');

    t.core.requestVoiceMode(A, 'whisper');
    t.core.requestVoiceMode(A, 'shout');
    t.core.requestVoiceMode(A, 'whisper');
    t.core.requestVoiceMode(A, 'shout');

    assert.strictEqual(t.pendentes(), 1, 'quatro trocas, um ciclo pendente');
    t.drenar();

    assert.strictEqual(t.core.state.get(A).voiceMode, 'shout');
    assert.strictEqual(t.core.audienceFor(A).length, 1,
      'o estado final é o que vale, e o ciclo coalescido o aplicou');
  });
});

describe('voice-core — PTT ponta a ponta', () => {
  it('a audiência some no instante em que o PTT sobe, sem esperar recompute', () => {
    const { mp, core } = montar();
    entrar(core, mp, A, [0, 0, 0]);
    entrar(core, mp, B, [100, 0, 0], CELL, { falando: false });
    core.recompute('tick');
    assert.strictEqual(core.audienceFor(A).length, 1);

    core.policy.pttUp(A); // direto na policy: sem recompute no caminho
    assert.strictEqual(core.audienceFor(A).length, 0,
      'entre um recompute e o quadro seguinte, o PTT solto tem que cortar');
  });

  it('PTT negado para quem está mutado, e a audiência continua vazia', () => {
    const { mp, core } = montar();
    entrar(core, mp, A, [0, 0, 0], CELL, { falando: false });
    entrar(core, mp, B, [100, 0, 0], CELL, { falando: false });
    core.requestMute(A, true);

    const r = core.pttDown(A);
    assert.strictEqual(r.ok, false);
    core.recompute('tick');
    assert.strictEqual(core.audienceFor(A).length, 0);
  });
});

describe('voice-core — assinaturas seletivas ponta a ponta', () => {
  it('A entra no alcance de B → subscribe; sai → unsubscribe; fica → nada', () => {
    const { gateway, chamadas } = gatewayFalso();
    const { mp, core } = montar({ gateway });
    entrar(core, mp, A, [0, 0, 0]);
    entrar(core, mp, B, [VOICE_RANGES.normal + 500, 0, 0], CELL, { falando: false });
    core.recompute('tick');
    chamadas.subscribe.length = 0;
    chamadas.unsubscribe.length = 0;

    mp.por(B, [100, 0, 0]);
    core.recompute('tick');
    assert.deepStrictEqual(chamadas.subscribe.map((e) => [e.listener, e.speaker]), [[B, A]]);

    for (let i = 0; i < 10; i++) {
      mp.por(B, [100 + i, 0, 0]);
      core.recompute('tick');
    }
    assert.strictEqual(chamadas.subscribe.length, 1, 'ficar perto não gera chamada nova');
    assert.strictEqual(chamadas.unsubscribe.length, 0);

    mp.por(B, [VOICE_RANGES.normal + 500, 0, 0]);
    core.recompute('tick');
    assert.deepStrictEqual(chamadas.unsubscribe.map((e) => [e.listener, e.speaker]), [[B, A]]);
  });
});

describe('voice-core — desconexão, logout e cleanup', () => {
  it('detach limpa estado, sessão, amostra e rotas, e despeja o participante', () => {
    const { gateway, chamadas } = gatewayFalso();
    const { mp, core } = montar({ gateway });
    entrar(core, mp, A, [0, 0, 0]);
    entrar(core, mp, B, [100, 0, 0], CELL, { falando: false });
    core.recompute('tick');
    const identidade = core.identityOf(A);

    core.detach(A, 'logout');

    assert.strictEqual(core.state.get(A), null);
    assert.strictEqual(core.sessions.get(A), null);
    assert.strictEqual(core.identityOf(A), null);
    assert.strictEqual(core.routes.subscriptionCount(), 0);
    assert.ok(chamadas.removed.includes(identidade), 'o participante tem que sair da sala');
  });

  it('detach NÃO deixa unsubscribe pendente para quem já saiu', () => {
    const { gateway, chamadas } = gatewayFalso();
    const { mp, core } = montar({ gateway });
    entrar(core, mp, A, [0, 0, 0]);
    entrar(core, mp, B, [100, 0, 0], CELL, { falando: false });
    core.recompute('tick');
    chamadas.unsubscribe.length = 0;

    core.detach(B, 'disconnect');
    mp.locais.delete(B);
    core.recompute('tick');

    assert.strictEqual(chamadas.unsubscribe.length, 0,
      'desassinar um participante que não está na sala é a chamada redundante mais cara');
  });

  it('detach é seguro em qualquer ordem e repetido', () => {
    const { mp, core } = montar();
    entrar(core, mp, A, [0, 0, 0]);
    core.detach(A, 'disconnect');
    core.detach(A, 'logout');
    core.detach(A, 'cleanup');
    assert.strictEqual(core.state.get(A), null);
  });

  it('shutdown fecha tudo e não deixa temporizador nem estado para trás', () => {
    const { gateway, chamadas } = gatewayFalso();
    const { mp, core } = montar({ gateway });
    entrar(core, mp, A, [0, 0, 0]);
    entrar(core, mp, B, [100, 0, 0]);
    entrar(core, mp, C, [200, 0, 0]);
    core.start();
    core.recompute('tick');

    const fechadas = core.shutdown('shutdown');

    assert.strictEqual(fechadas, 3);
    assert.strictEqual(chamadas.removed.length, 3);
    assert.strictEqual(core.describe().running, false);
    assert.strictEqual(core.describe().actors, 0);
    assert.strictEqual(core.describe().sessions, 0);
    assert.strictEqual(core.describe().subscriptions, 0);
  });
});

describe('voice-core — participante duplicado no fluxo real', () => {
  it('reconectar sem fechar antes despeja a sessão anterior e limpa as rotas dela', () => {
    const { gateway, chamadas } = gatewayFalso();
    const { mp, core } = montar({ gateway });
    entrar(core, mp, A, [0, 0, 0]);
    entrar(core, mp, B, [100, 0, 0], CELL, { falando: false });
    core.recompute('tick');
    const primeira = core.identityOf(A);

    // Mesma pessoa, nova conexão, sem que a antiga tenha fechado.
    core.attach(A, { characterId: A });
    const segunda = core.identityOf(A);

    assert.notStrictEqual(segunda, primeira);
    assert.ok(chamadas.removed.includes(primeira), 'a anterior sai por decisão explícita');
    // Duas sessões no total (A e B), e exatamente UMA para A — que é a
    // propriedade em teste. `size()` conta o servidor inteiro.
    assert.strictEqual(core.sessions.size(), 2);
    assert.strictEqual(core.sessions.all().filter((s) => s.actorId === A).length, 1);
    assert.strictEqual(core.sessions.resolveActor(primeira), null, 'a identidade antiga morre na hora');
  });
});

describe('voice-core — o SFU morre e o jogo continua', () => {
  it('gateway que REJEITA não derruba o ciclo nem o estado do jogo', () => {
    const explosivo = {
      applySubscriptionDiff: async () => { throw new Error('SFU morreu'); },
      removeParticipant: async () => { throw new Error('SFU morreu'); },
      mutePublishedTrack: async () => { throw new Error('SFU morreu'); },
      describe: () => ({ state: 'FAILED', configured: true, missing: [] }),
      reset: () => {}
    };
    const { mp, core } = montar({ gateway: explosivo });
    entrar(core, mp, A, [0, 0, 0]);
    entrar(core, mp, B, [100, 0, 0], CELL, { falando: false });

    const r = core.recompute('tick');

    assert.strictEqual(r.routeCount, 1, 'a proximidade continua sendo calculada');
    assert.strictEqual(core.audienceFor(A).length, 1, 'a regra de jogo não depende do SFU');
    core.detach(A, 'logout');
    assert.strictEqual(core.state.get(A), null);
  });

  it('assinante de rotas que lança não derruba o ciclo nem os outros assinantes', () => {
    const { mp, core } = montar();
    entrar(core, mp, A, [0, 0, 0]);
    entrar(core, mp, B, [100, 0, 0], CELL, { falando: false });

    // Assinantes registrados DEPOIS do setup: `attach` já dispara ciclos, e
    // contá-los aqui misturaria a montagem da cena com o que se quer observar.
    const recebidos = [];
    core.onRoutes(() => { throw new Error('assinante ruim'); });
    core.onRoutes((routes) => recebidos.push(routes.size));

    core.recompute('tick');

    assert.deepStrictEqual(recebidos, [1], 'o segundo assinante recebe mesmo com o primeiro quebrado');
  });

  it('sem configuração de LiveKit a sessão fica DISABLED e o jogo segue', () => {
    const mp = fakeMp();
    const state = createVoiceStateService();
    const core = createVoiceCore({
      mp, logger: silencioso, schedule: (fn) => fn(),
      state,
      sessions: createVoiceSessionService({ state, env: () => ({}), logger: silencioso }),
      gateway: gatewayFalso().gateway
    });

    mp.por(A, [0, 0, 0]);
    const r = core.attach(A, { characterId: A });

    assert.strictEqual(r.ok, false);
    assert.strictEqual(core.state.get(A).connection, CONNECTION_STATES.DISABLED);
    assert.doesNotThrow(() => core.recompute('tick'));
    assert.strictEqual(core.audienceFor(A).length, 0, 'DISABLED não fala');
  });
});

describe('voice-core — o laço', () => {
  it('o intervalo padrão está dentro da faixa pedida de 100–250 ms', () => {
    assert.ok(DEFAULT_TICK_MS >= 100 && DEFAULT_TICK_MS <= 250, `DEFAULT_TICK_MS=${DEFAULT_TICK_MS}`);
  });

  it('start é idempotente e stop desarma', () => {
    const { core } = montar();
    const primeiro = core.start();
    assert.strictEqual(core.start(), primeiro);
    assert.strictEqual(core.describe().running, true);
    core.stop();
    assert.strictEqual(core.describe().running, false);
  });

  it('describe entrega o retrato completo, com métrica', () => {
    const { mp, core } = montar();
    entrar(core, mp, A, [0, 0, 0]);
    entrar(core, mp, B, [100, 0, 0], CELL, { falando: false });
    core.recompute('tick');

    const d = core.describe();
    assert.strictEqual(d.actors, 2);
    assert.strictEqual(d.sessions, 2);
    assert.strictEqual(d.subscriptions, 1);
    assert.ok(d.spatial.total >= 2);
    assert.ok(d.metrics.durations['route.recompute'], 'o recompute tem que estar medido');
  });
});
