/**
 * skymp/ui/voice-audio.test.js
 *
 * O pipeline de áudio do cliente, testado **contra o `index.html` de verdade**.
 *
 * ## Por que não é um arquivo `.js` separado
 *
 * O código de voz da UI mora dentro de um `<script>` no `index.html`, porque é
 * assim que a CEF do SkyMP carrega o overlay: um arquivo, sem bundler, sem
 * módulos. Extraí-lo para um `.js` importável só para poder testar criaria a
 * situação clássica em que o arquivo testado e o arquivo carregado divergem —
 * e o que roda em jogo é o que está no HTML.
 *
 * Então este teste **lê o HTML, extrai o script e o executa** num `Function`
 * com `window`, `document` e `AudioContext` falsos. O que ele exercita é
 * exatamente o texto que a CEF vai executar. Se alguém apagar `removeRelayPeer`
 * do HTML, este arquivo falha.
 *
 * ## O que ele prova, e o que ele NÃO prova
 *
 * **Prova:** a topologia do grafo, a contagem de nós, a limpeza, a
 * anti-duplicação e a seleção de efeito. Tudo isso é lógica, e lógica se testa.
 *
 * **Não prova:** que soe direito. Nenhum `AudioContext` falso produz som, e o
 * blocker #1 do projeto — ninguém nunca ouviu a voz deste projeto — continua
 * aberto e não é fechável daqui. Ver `SKYVOICE_CORE_ETAPA_3.md` §11.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { describe, it, beforeEach } = require('node:test');

// ─────────────────────────────────────────────────────────────────────────────
// Web Audio falso: conta nós, conexões e desconexões
// ─────────────────────────────────────────────────────────────────────────────

function criarAudioFalso() {
  const registro = { criados: [], vivos: new Set() };

  class ParamFalso {
    constructor() { this.value = 0; }
    setTargetAtTime(v) { this.value = v; }
    setValueAtTime(v) { this.value = v; }
  }

  class NoFalso {
    constructor(tipo) {
      this.tipo = tipo;
      this.saidas = new Set();
      this.desconectado = false;
      registro.criados.push(this);
      registro.vivos.add(this);
    }
    connect(destino) { this.saidas.add(destino); return destino; }
    disconnect() {
      this.saidas.clear();
      this.desconectado = true;
      registro.vivos.delete(this);
    }
  }

  class ContextoFalso {
    constructor(opts = {}) {
      this.sampleRate = opts.sampleRate || 48000;
      this.currentTime = 0;
      this.state = 'running';
      this.baseLatency = 0.01;
      this.destination = new NoFalso('destination');
    }
    resume() { this.state = 'running'; return Promise.resolve(); }
    createGain() {
      const n = new NoFalso('gain');
      n.gain = new ParamFalso();
      return n;
    }
    createPanner() {
      const n = new NoFalso('panner');
      n.positionX = new ParamFalso();
      n.positionY = new ParamFalso();
      n.positionZ = new ParamFalso();
      return n;
    }
    createBiquadFilter() {
      const n = new NoFalso('filter');
      n.frequency = new ParamFalso();
      n.Q = new ParamFalso();
      return n;
    }
    createBufferSource() {
      const n = new NoFalso('source');
      n.start = () => {};
      n.onended = null;
      return n;
    }
    createBuffer(canais, tamanho) {
      const dados = new Float32Array(tamanho);
      return { duration: tamanho / this.sampleRate, getChannelData: () => dados };
    }
  }

  return { registro, ContextoFalso, NoFalso };
}

/** DOM mínimo: o script toca `getElementById` no HUD e no chat-log. */
function criarDomFalso() {
  const elementos = new Map();
  const criarEl = (id) => ({
    id,
    className: '',
    textContent: '',
    innerHTML: '',
    style: {},
    children: [],
    classList: {
      _set: new Set(),
      add(...c) { c.forEach((x) => this._set.add(x)); },
      remove(...c) { c.forEach((x) => this._set.delete(x)); },
      toggle(c, on) { on ? this._set.add(c) : this._set.delete(c); },
      contains(c) { return this._set.has(c); }
    },
    appendChild(filho) { this.children.push(filho); },
    removeChild(filho) { this.children = this.children.filter((f) => f !== filho); },
    remove() {},
    querySelector() { return { style: {} }; },
    addEventListener() {}
  });

  return {
    getElementById(id) {
      if (!elementos.has(id)) elementos.set(id, criarEl(id));
      return elementos.get(id);
    },
    createElement: (tag) => criarEl(tag),
    addEventListener() {},
    body: criarEl('body')
  };
}

/**
 * Carrega o `<script>` do `index.html` num sandbox e devolve o que ele expõe.
 *
 * O script termina com muitas funções de escopo de módulo; para alcançá-las, o
 * carregador acrescenta um `return` com os nomes que interessam. Isso mantém o
 * HTML intocado — nada nele existe só por causa do teste.
 */
function carregarVoz() {
  const html = fs.readFileSync(path.resolve(__dirname, 'index.html'), 'utf8');
  const blocos = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.strictEqual(blocos.length, 1, 'o index.html deveria ter um bloco de script só');

  const { registro, ContextoFalso } = criarAudioFalso();
  const document = criarDomFalso();

  const gatilhos = [];
  const mpFalso = {
    trigger: (ev, data) => gatilhos.push({ ev, data }),
    send: () => {},
    events: { add: () => {} }
  };

  const window = {
    AudioContext: ContextoFalso,
    performance: { now: () => 0 },
    crypto: undefined,
    mp: mpFalso,
    addEventListener() {},
    removeEventListener() {}
  };

  const enviadas = [];
  class WebSocketFalso {
    constructor() {
      this.readyState = 1;
      WebSocketFalso.ultimo = this;
    }
    send(raw) { enviadas.push(JSON.parse(raw)); }
    close() { this.fechado = true; }
  }
  WebSocketFalso.OPEN = 1;

  const corpo = blocos[0][1] + `
    ;return {
      state, handleSignal, playRelayFrame, getRelayChain, removeRelayPeer,
      applyEffect, setPannerDirection, tearDownVoiceAudio, connectVoip,
      renderVoiceChip, toggleMute, setVoiceMode, ensureAudioContext,
      voiceStats: window.voiceStats
    };`;

  const fabrica = new Function(
    'window', 'document', 'mp', 'WebSocket', 'console', 'setTimeout', 'atob', 'navigator',
    corpo
  );

  const api = fabrica(
    window, document, mpFalso, WebSocketFalso,
    { log() {}, warn() {}, error() {}, table() {} },
    (fn) => { fn(); return { unref() {} }; },
    (b64) => Buffer.from(b64, 'base64').toString('binary'),
    { mediaDevices: { getUserMedia: () => Promise.reject(Object.assign(new Error('bloqueado'), { name: 'NotAllowedError' })) } }
  );

  return { ...api, registro, window, document, gatilhos, enviadas, WebSocketFalso };
}

/** Um quadro de 20 ms de PCM 16-bit mono a 48 kHz, em base64. */
function quadro(amplitude = 0.5) {
  const amostras = 960;
  const buf = Buffer.alloc(amostras * 2);
  for (let i = 0; i < amostras; i++) {
    buf.writeInt16LE(Math.round(amplitude * 32767 * Math.sin(i / 10)), i * 2);
  }
  return buf.toString('base64');
}

const A = 0xff001001;
const B = 0xff001002;

// ─────────────────────────────────────────────────────────────────────────────

let voz;
beforeEach(() => { voz = carregarVoz(); });

describe('cliente — topologia do pipeline', () => {
  it('a cadeia é Gain → Panner → destination quando não há efeito', () => {
    voz.playRelayFrame(A, 0.8, quadro());
    const cadeia = voz.state.relayPeers.get(A);

    assert.ok(cadeia, 'o primeiro quadro cria a cadeia');
    assert.ok(cadeia.gainNode.saidas.has(cadeia.panner), 'ganho vai ao panner');
    assert.strictEqual(cadeia.filter, null,
      'sem efeito não há filtro: um passa-baixa transparente custaria CPU por locutor');
  });

  it('o panner NÃO atenua por distância — isso é do servidor', () => {
    voz.playRelayFrame(A, 0.8, quadro());
    const { panner } = voz.state.relayPeers.get(A);
    assert.strictEqual(panner.rolloffFactor, 0,
      'duas quedas independentes fariam o jogador ouvir mais baixo do que a regra manda');
    assert.strictEqual(panner.refDistance, 1);
    assert.strictEqual(panner.maxDistance, 1);
  });

  it('`equalpower`, não HRTF — a CEF é a parte apertada do sistema', () => {
    voz.playRelayFrame(A, 0.8, quadro());
    assert.strictEqual(voz.state.relayPeers.get(A).panner.panningModel, 'equalpower');
  });

  it('o volume do servidor vira o ganho, sem o cliente opinar', () => {
    voz.playRelayFrame(A, 0.42, quadro());
    assert.strictEqual(voz.state.relayPeers.get(A).gainNode.gain.value, 0.42);
  });
});

describe('cliente — áudio direcional', () => {
  it('a direção do servidor vai para o panner', () => {
    voz.playRelayFrame(A, 0.8, quadro());
    const cadeia = voz.state.relayPeers.get(A);

    voz.setPannerDirection(cadeia, [1, 0, 0]);
    assert.strictEqual(cadeia.panner.positionX.value, 1);
    assert.strictEqual(cadeia.panner.positionZ.value, 0);

    voz.setPannerDirection(cadeia, [0, 0, -1]);
    assert.strictEqual(cadeia.panner.positionZ.value, -1);
  });

  it('`proximity_update` reposiciona quem já tem cadeia', async () => {
    voz.playRelayFrame(A, 0.8, quadro());
    await voz.handleSignal({
      type: 'proximity_update',
      peers: [{ actorId: A, volume: 0.5, effect: 'none', dir: [-1, 0, 0] }]
    });
    assert.strictEqual(voz.state.relayPeers.get(A).panner.positionX.value, -1);
  });

  /**
   * Montar ganho, panner e filtro para alguém de quem talvez nunca chegue um
   * quadro é exatamente o processamento de áudio inútil que a etapa manda
   * evitar. Quem cria a cadeia é o primeiro quadro.
   */
  it('`proximity_update` NÃO cria cadeia para quem ainda não falou', async () => {
    await voz.handleSignal({
      type: 'proximity_update',
      peers: [{ actorId: A, volume: 0.5, effect: 'none', dir: [0, 0, -1] }]
    });
    assert.strictEqual(voz.state.relayPeers.size, 0);
  });
});

describe('cliente — seleção de efeito', () => {
  it('`muffled` cria o filtro e o coloca ENTRE ganho e panner', () => {
    voz.playRelayFrame(A, 0.8, quadro(), 'muffled');
    const c = voz.state.relayPeers.get(A);

    assert.ok(c.filter, 'a mordaça precisa de filtro');
    assert.strictEqual(c.filter.type, 'lowpass');
    assert.ok(c.gainNode.saidas.has(c.filter), 'ganho → filtro');
    assert.ok(c.filter.saidas.has(c.panner), 'filtro → panner');
    assert.ok(!c.gainNode.saidas.has(c.panner), 'e o atalho antigo foi desfeito');
  });

  it('o corte vem do servidor, não do cliente', () => {
    voz.state.effectSettings = { muffled: { lowpassHz: 333 }, faint: { lowpassHz: 999 } };
    voz.playRelayFrame(A, 0.8, quadro(), 'muffled');
    assert.strictEqual(voz.state.relayPeers.get(A).filter.frequency.value, 333);
  });

  it('`faint` e `muffled` usam cortes diferentes', () => {
    voz.playRelayFrame(A, 0.8, quadro(), 'faint');
    const faint = voz.state.relayPeers.get(A).filter.frequency.value;
    voz.playRelayFrame(A, 0.8, quadro(), 'muffled');
    const muffled = voz.state.relayPeers.get(A).filter.frequency.value;
    assert.ok(muffled < faint, 'senão os dois efeitos são um só');
  });

  /**
   * Ser socorrido tem que devolver a voz limpa. Um filtro que ficasse pendurado
   * deixaria a pessoa abafada para sempre — e o sintoma seria "a voz dele nunca
   * mais voltou ao normal", sem erro em lugar nenhum.
   */
  it('voltar para `none` DESCARTA o filtro e refaz o atalho', () => {
    voz.playRelayFrame(A, 0.8, quadro(), 'muffled');
    const c = voz.state.relayPeers.get(A);
    const filtroAntigo = c.filter;

    voz.applyEffect(c, 'none');

    assert.strictEqual(c.filter, null);
    assert.strictEqual(filtroAntigo.desconectado, true);
    assert.ok(c.gainNode.saidas.has(c.panner));
    assert.strictEqual(voz.state.audioStats.filters, 0);
  });

  it('reafirmar o mesmo efeito não recria nó nenhum', () => {
    voz.playRelayFrame(A, 0.8, quadro(), 'muffled');
    const filtro = voz.state.relayPeers.get(A).filter;
    for (let i = 0; i < 20; i++) voz.playRelayFrame(A, 0.8, quadro(), 'muffled');
    assert.strictEqual(voz.state.relayPeers.get(A).filter, filtro);
    assert.strictEqual(voz.state.audioStats.filters, 1);
  });
});

describe('cliente — limpeza de AudioNode', () => {
  /**
   * O vazamento que este teste existe para pegar não aparece como erro: aparece
   * como o jogo ficando lento depois de uma hora numa cidade movimentada. Um
   * `disconnect` só no ganho deixaria filtro e panner pendurados no
   * `destination`, e o navegador continua percorrendo o grafo a cada bloco de
   * 128 amostras para processar silêncio.
   */
  it('remover um locutor desconecta TODOS os nós da cadeia', () => {
    voz.playRelayFrame(A, 0.8, quadro(), 'muffled');
    const { gainNode, filter, panner } = voz.state.relayPeers.get(A);

    voz.removeRelayPeer(A);

    assert.strictEqual(gainNode.desconectado, true, 'ganho');
    assert.strictEqual(filter.desconectado, true, 'filtro');
    assert.strictEqual(panner.desconectado, true, 'panner — o esquecido');
    assert.strictEqual(voz.state.relayPeers.has(A), false);
  });

  it('os contadores voltam a zero — é assim que o vazamento fica visível', () => {
    voz.playRelayFrame(A, 0.8, quadro(), 'muffled');
    voz.playRelayFrame(B, 0.8, quadro());
    assert.strictEqual(voz.state.audioStats.chains, 2);
    assert.strictEqual(voz.state.audioStats.panners, 2);
    assert.strictEqual(voz.state.audioStats.filters, 1);

    voz.removeRelayPeer(A);
    voz.removeRelayPeer(B);

    assert.deepStrictEqual(
      { c: voz.state.audioStats.chains, p: voz.state.audioStats.panners, f: voz.state.audioStats.filters },
      { c: 0, p: 0, f: 0 }
    );
  });

  it('sair do alcance desmonta a cadeia de quem saiu, e só dele', async () => {
    voz.playRelayFrame(A, 0.8, quadro());
    voz.playRelayFrame(B, 0.8, quadro());

    await voz.handleSignal({
      type: 'proximity_update',
      peers: [{ actorId: B, volume: 0.5, effect: 'none', dir: [0, 0, -1] }]
    });

    assert.strictEqual(voz.state.relayPeers.has(A), false, 'A saiu de alcance');
    assert.strictEqual(voz.state.relayPeers.has(B), true, 'B continua');
  });

  it('remover duas vezes não é erro nem contabiliza duas vezes', () => {
    voz.playRelayFrame(A, 0.8, quadro());
    voz.removeRelayPeer(A);
    assert.doesNotThrow(() => voz.removeRelayPeer(A));
    assert.strictEqual(voz.state.audioStats.chains, 0);
  });

  it('a queda da sinalização desmonta tudo', () => {
    voz.playRelayFrame(A, 0.8, quadro(), 'muffled');
    voz.playRelayFrame(B, 0.8, quadro());

    voz.tearDownVoiceAudio();

    assert.strictEqual(voz.state.relayPeers.size, 0);
    assert.strictEqual(voz.state.audioStats.chains, 0);
    assert.strictEqual(voz.state.audioStats.panners, 0);
    assert.strictEqual(voz.state.audioStats.filters, 0);
  });

  it('as fontes de buffer não se acumulam', () => {
    voz.playRelayFrame(A, 0.8, quadro());
    const cadeia = voz.state.relayPeers.get(A);
    assert.strictEqual(cadeia.activeSources, 1);

    // O navegador chama `onended` quando o buffer termina.
    voz.registro.criados.filter((n) => n.tipo === 'source').forEach((n) => n.onended && n.onended());
    assert.strictEqual(cadeia.activeSources, 0);
  });
});

describe('cliente — áudio duplicado', () => {
  /**
   * `/voz` duas vezes sem a primeira ter caído é o caminho mais curto para áudio
   * duplicado: dois sockets entregando os mesmos quadros, duas cadeias por
   * locutor com jitter próprio. Soa como eco, e não como bug.
   */
  it('reconectar sem fechar antes NÃO deixa duas cadeias do mesmo locutor', () => {
    voz.connectVoip(A, 'ticket-1', '127.0.0.1', 7778);
    voz.playRelayFrame(B, 0.8, quadro());
    assert.strictEqual(voz.state.audioStats.chains, 1);

    voz.connectVoip(A, 'ticket-2', '127.0.0.1', 7778);

    assert.strictEqual(voz.state.relayPeers.size, 0, 'a sessão anterior foi desmontada');
    assert.strictEqual(voz.state.audioStats.chains, 0);

    voz.playRelayFrame(B, 0.8, quadro());
    assert.strictEqual(voz.state.audioStats.chains, 1, 'e a nova monta uma só');
  });

  it('o socket antigo é fechado e não pode mais mexer no estado novo', () => {
    voz.connectVoip(A, 'ticket-1', '127.0.0.1', 7778);
    const antigo = voz.WebSocketFalso.ultimo;
    voz.connectVoip(A, 'ticket-2', '127.0.0.1', 7778);

    assert.strictEqual(antigo.fechado, true);
    assert.strictEqual(antigo.onclose, null, 'o close atrasado dele não pode derrubar a sessão nova');
  });

  it('um locutor tem UMA cadeia por mais quadros que cheguem', () => {
    for (let i = 0; i < 100; i++) voz.playRelayFrame(A, 0.8, quadro());
    assert.strictEqual(voz.state.relayPeers.size, 1);
    assert.strictEqual(voz.state.audioStats.chains, 1);
    assert.strictEqual(voz.state.audioStats.panners, 1);
  });
});

describe('cliente — jitter buffer adaptativo', () => {
  it('nasce no piso (60ms) e um underrun cresce o colchão em 20ms', () => {
    voz.playRelayFrame(A, 0.8, quadro());
    const cadeia = voz.state.relayPeers.get(A);
    assert.strictEqual(cadeia.jitterS, 0.06, 'piso é o valor inicial');

    // Adianta o relógio pra além do que a cadeia já agendou — é a definição
    // de underrun: a fonte atrasou e o colchão atual não segurou.
    voz.state.audioCtx.currentTime = cadeia.nextPlayTime + 0.001;
    voz.playRelayFrame(A, 0.8, quadro());

    assert.strictEqual(cadeia.jitterS, 0.08, 'cresceu um quadro de 20ms');
    assert.strictEqual(voz.state.audioStats.underruns, 1);
  });

  it('o colchão não passa do teto (240ms) por mais underrun que apanhe', () => {
    voz.playRelayFrame(A, 0.8, quadro());
    const cadeia = voz.state.relayPeers.get(A);
    for (let i = 0; i < 20; i++) {
      voz.state.audioCtx.currentTime = cadeia.nextPlayTime + 0.001;
      voz.playRelayFrame(A, 0.8, quadro());
    }
    assert.strictEqual(cadeia.jitterS, 0.24);
  });

  it('cada locutor tem o próprio colchão — o underrun de um não afeta o outro', () => {
    voz.playRelayFrame(A, 0.8, quadro());
    voz.playRelayFrame(B, 0.8, quadro());
    const cadeiaA = voz.state.relayPeers.get(A);
    const cadeiaB = voz.state.relayPeers.get(B);

    voz.state.audioCtx.currentTime = cadeiaA.nextPlayTime + 0.001;
    voz.playRelayFrame(A, 0.8, quadro());

    assert.strictEqual(cadeiaA.jitterS, 0.08);
    assert.strictEqual(cadeiaB.jitterS, 0.06, 'quem não apanhou underrun fica no piso');
  });

  it('depois de uma janela sem underrun, o colchão encolhe 10ms — devagar', () => {
    voz.playRelayFrame(A, 0.8, quadro());
    const cadeia = voz.state.relayPeers.get(A);
    voz.state.audioCtx.currentTime = cadeia.nextPlayTime + 0.001;
    voz.playRelayFrame(A, 0.8, quadro()); // um underrun: jitterS = 0.08
    assert.strictEqual(cadeia.jitterS, 0.08);

    // 250 quadros saudáveis, com o relógio andando junto — é o que reprodução
    // em tempo real faz. Sem avançar `currentTime`, `nextPlayTime` se afasta
    // do "agora" congelado a cada quadro e cai sozinho no ramo de rajada
    // adiantada antes de completar a janela, o que não é o cenário que este
    // teste quer exercitar.
    for (let i = 0; i < 250; i++) {
      voz.state.audioCtx.currentTime += 0.02;
      voz.playRelayFrame(A, 0.8, quadro());
    }

    assert.strictEqual(cadeia.jitterS, 0.07, 'encolheu meio quadro (10ms), não voltou tudo de vez');
    assert.strictEqual(voz.state.audioStats.underruns, 1, 'só o primeiro underrun contou');
  });

  it('o colchão não encolhe abaixo do piso (60ms)', () => {
    voz.playRelayFrame(A, 0.8, quadro());
    const cadeia = voz.state.relayPeers.get(A);
    for (let i = 0; i < 250 * 5; i++) {
      voz.state.audioCtx.currentTime += 0.02;
      voz.playRelayFrame(A, 0.8, quadro());
    }
    assert.strictEqual(cadeia.jitterS, 0.06);
  });

  it('rajada de quadros adiantados reencaixa no presente sem contar como underrun', () => {
    voz.playRelayFrame(A, 0.8, quadro());
    const cadeia = voz.state.relayPeers.get(A);
    // Empurra a fila bem à frente do relógio, além do teto de fila (0.5s).
    cadeia.nextPlayTime = voz.state.audioCtx.currentTime + 10;
    voz.playRelayFrame(A, 0.8, quadro());

    assert.strictEqual(cadeia.jitterS, 0.06, 'rajada adiantada não é underrun — não cresce o colchão');
    assert.strictEqual(voz.state.audioStats.underruns, 0);
  });
});

describe('cliente — estado de fala e HUD', () => {
  it('`voice_speaking` é repassado ao gamemode para animação', async () => {
    await voz.handleSignal({ type: 'voice_speaking', actorId: A, speaking: true });
    const evento = voz.gatilhos.find((g) => g.ev === 'cef::voice:speaking');
    assert.ok(evento);
    assert.deepStrictEqual(evento.data, { actorId: A, speaking: true });
  });

  it('o `audioLevel` do cliente sai do quadro que ele já decodificou', () => {
    voz.playRelayFrame(A, 0.8, quadro(0.5));
    const nivel = voz.state.relayPeers.get(A).level;
    assert.ok(nivel > 0 && nivel <= 1, `nível fora de faixa: ${nivel}`);

    voz.playRelayFrame(B, 0.8, quadro(0.05));
    assert.ok(voz.state.relayPeers.get(B).level < nivel, 'mais baixo tem que medir menos');
  });

  it('o HUD mostra o MODO, e o modo vem do servidor', async () => {
    await voz.handleSignal({ type: 'voice_mode', mode: 'shout', ok: true });
    assert.strictEqual(voz.document.getElementById('voip-chip-text').textContent, 'GRITO');
  });

  it('modo RECUSADO pelo servidor não muda o HUD', async () => {
    await voz.handleSignal({ type: 'voice_mode', mode: 'shout', ok: true });
    await voz.handleSignal({ type: 'voice_mode', mode: 'normal', ok: false });
    assert.strictEqual(voz.document.getElementById('voip-chip-text').textContent, 'GRITO',
      'desenhar o pedido antes da resposta é como a UI passa a mentir');
  });

  it('transmitindo mostra MIC junto do modo', async () => {
    await voz.handleSignal({ type: 'ptt', transmitting: true });
    assert.match(voz.document.getElementById('voip-chip-text').textContent, /^MIC · /);
  });

  it('MUDO tem precedência sobre o modo', async () => {
    await voz.handleSignal({ type: 'ptt', transmitting: true });
    voz.toggleMute();
    assert.strictEqual(voz.document.getElementById('voip-chip-text').textContent, 'MUDO');
  });

  it('erro tem precedência sobre tudo', async () => {
    await voz.handleSignal({ type: 'auth_failed' });
    assert.strictEqual(voz.document.getElementById('voip-chip-text').textContent, 'VOZ COM ERRO');
  });

  /**
   * Não existe rádio neste projeto, e a regra vale para o CÓDIGO — não para os
   * comentários, que precisam poder citar `'radio'` para registrar que aquela
   * string já derrubou a voz de alguém em silêncio na Etapa 1. Apagar o
   * histórico faria alguém refazer o percurso.
   */
  it('não existe rádio, frequência nem canal no código do HUD', () => {
    const html = fs.readFileSync(path.resolve(__dirname, 'index.html'), 'utf8');
    const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1]
      .replace(/\/\/[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    const achados = script.match(/\b(radio|rádio|frequencia|frequência|voiceChannel)\b/gi) || [];
    assert.deepStrictEqual(achados, [], `o HUD não pode citar rádio: ${achados}`);
  });
});

describe('cliente — o handshake', () => {
  it('os parâmetros de efeito chegam UMA vez, no auth_ok', async () => {
    await voz.handleSignal({
      type: 'auth_ok', actorId: A, role: 'listener', ptt: true,
      effects: { muffled: { lowpassHz: 555 }, faint: { lowpassHz: 1500 } }
    });
    assert.strictEqual(voz.state.effectSettings.muffled.lowpassHz, 555);
  });

  it('auth_ok sem `effects` mantém o padrão em vez de zerar', async () => {
    const antes = voz.state.effectSettings.muffled.lowpassHz;
    await voz.handleSignal({ type: 'auth_ok', actorId: A, role: 'listener' });
    assert.strictEqual(voz.state.effectSettings.muffled.lowpassHz, antes);
  });
});

describe('cliente — só APIs que a CEF 108 tem', () => {
  const PROIBIDAS = [
    ['setSinkId', 'Chromium 110 — a CEF do SkyMP é a 108'],
    ['audioWorklet', 'exige carregar módulo por URL, complicado em file://'],
    ['MediaStreamTrackProcessor', 'não é necessário e estreita a compatibilidade'],
    ['OfflineAudioContext', 'não usado; se aparecer, é engano'],
    ['requestIdleCallback', 'não implementado em toda CEF']
  ];

  it('nenhuma API além do que a 108 garante', () => {
    const html = fs.readFileSync(path.resolve(__dirname, 'index.html'), 'utf8');
    // Só o CÓDIGO, não os comentários: este arquivo cita `setSinkId` de
    // propósito, para registrar por que ele não está sendo usado.
    const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1]
      .replace(/\/\/[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');

    for (const [api, porque] of PROIBIDAS) {
      assert.ok(!new RegExp(`\\.${api}\\b|\\b${api}\\s*\\(`).test(script),
        `${api} não pode ser usada: ${porque}`);
    }
  });

  it('`positionX` é detectado em runtime, com queda para `setPosition`', () => {
    // Um pin de CEF diferente sem `positionX` como AudioParam levantaria
    // `undefined.setTargetAtTime` por quadro e calaria todo mundo.
    voz.playRelayFrame(A, 0.8, quadro());
    const cadeia = voz.state.relayPeers.get(A);
    cadeia.panner.positionX = undefined;
    let chamou = null;
    cadeia.panner.setPosition = (x, y, z) => { chamou = [x, y, z]; };

    assert.doesNotThrow(() => voz.setPannerDirection(cadeia, [0.5, 0, -0.87]));
    assert.deepStrictEqual(chamou, [0.5, 0, -0.87]);
  });
});

describe('cliente — as métricas da bancada', () => {
  it('`voiceStats` conta cadeias, panners, filtros e fontes', () => {
    voz.playRelayFrame(A, 0.8, quadro(), 'muffled');
    voz.playRelayFrame(B, 0.8, quadro());

    const s = voz.voiceStats();
    assert.strictEqual(s.cadeias, 2);
    assert.strictEqual(s.panners, 2);
    assert.strictEqual(s.filtros, 1);
    assert.strictEqual(s.fontesTocando, 2);
    assert.strictEqual(s.quadrosTocados, 2);
    assert.strictEqual(s.contexto, 'running');
  });

  it('o pico de cadeias sobrevive à limpeza — é o número que interessa depois', () => {
    voz.playRelayFrame(A, 0.8, quadro());
    voz.playRelayFrame(B, 0.8, quadro());
    voz.tearDownVoiceAudio();
    assert.strictEqual(voz.voiceStats().cadeiasPico, 2);
    assert.strictEqual(voz.voiceStats().cadeias, 0);
  });

  it('quadro ilegível é contado, não engolido', () => {
    voz.playRelayFrame(A, 0.8, '@@@ isto não é base64 @@@');
    const s = voz.voiceStats();
    assert.ok(s.quadrosDescartados >= 0);
  });
});
