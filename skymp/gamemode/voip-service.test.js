/**
 * voip-service.test.js
 *
 * Testes do handshake por ticket do voip-service — a correção do bug de
 * spoofing de actorId (antes, {type:'auth', actorId} era aceito sem nenhuma
 * verificação). Usa um servidor real em porta efêmera (port:0) via o próprio
 * pacote `ws`, já dependência do projeto — não mocka a rede, exercita o
 * handshake de verdade.
 *
 * Executa com: node --test voip-service.test.js
 */

const assert = require('assert');
const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const WebSocket = require('ws');

const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request.endsWith('/database') || request === './database') {
    return { query: async () => [], init: () => {} };
  }
  return originalLoad.apply(this, arguments);
};

const commands = require('./commands');
const voip = require('./voip-service');
const { VOICE_RANGES } = require('./core/proximity-ranges');

Module._load = originalLoad;

  /**
   * Registra um personagem ativo para o ator, se ainda não houver.
   *
   * Não é decoração de teste: desde a refatoração de 14/08/2026 o servidor só
   * deixa falar quem tem personagem carregado (`voice-policy.canSpeak`), e em
   * produção isso já era verdade por outro caminho — `issueTicket` só é
   * alcançável pelo `/voz`, que devolve cedo sem personagem ativo. Estes testes
   * chamam `issueTicket` direto e pulavam essa etapa; registrar aqui aproxima o
   * teste do que o servidor realmente vê.
   */
  function comPersonagem(actorId) {
    if (!commands.getActiveCharacterData(actorId)) {
      commands.registerActiveCharacter(actorId, { id: actorId, first_name: 'Teste', last_name: 'Voz' }, 1, 1);
    }
    return actorId;
  }


const ACTOR_ID = 0xff00b001;
let port;

function connect() {
  return new WebSocket(`ws://127.0.0.1:${port}`);
}

function waitForMessage(ws) {
  return new Promise((resolve, reject) => {
    ws.once('message', (raw) => resolve(JSON.parse(raw.toString())));
    ws.once('error', reject);
  });
}

function waitForClose(ws) {
  return new Promise((resolve) => ws.once('close', resolve));
}

describe('voip-service — handshake por ticket', () => {
  before(async () => {
    commands.registerActiveCharacter(ACTOR_ID, { id: 501, first_name: 'Jorah', last_name: 'Ferreiro' }, 1, 1);
    voip.startVoipServer(0, '127.0.0.1');
    // O bind é assíncrono (evento 'listening') — getListeningPort() só resolve depois disso.
    for (let i = 0; i < 50 && !voip.getListeningPort(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    port = voip.getListeningPort();
    assert.ok(port > 0, 'servidor deveria estar escutando numa porta efêmera');
  });

  after(() => {
    voip.stopVoipServer();
    commands.removeActiveCharacter(ACTOR_ID);
  });

  beforeEach(() => {
    voip._pendingTickets.clear();
  });

  it('recusa auth sem ticket e fecha a conexão', async () => {
    const ws = connect();
    await new Promise((resolve) => ws.once('open', resolve));
    ws.send(JSON.stringify({ type: 'auth', actorId: ACTOR_ID }));

    const reply = await waitForMessage(ws);
    assert.strictEqual(reply.type, 'auth_failed');
    await waitForClose(ws);
  });

  it('recusa auth com ticket errado', async () => {
    voip.issueTicket(ACTOR_ID);
    const ws = connect();
    await new Promise((resolve) => ws.once('open', resolve));
    ws.send(JSON.stringify({ type: 'auth', actorId: ACTOR_ID, ticket: 'ticket-forjado' }));

    const reply = await waitForMessage(ws);
    assert.strictEqual(reply.type, 'auth_failed');
    ws.close();
  });

  it('recusa auth reivindicando o actorId de outra pessoa (o bug original)', async () => {
    const ticketDoOutro = voip.issueTicket(0xff00b002); // ticket emitido pra OUTRO actorId
    const ws = connect();
    await new Promise((resolve) => ws.once('open', resolve));
    // Ataque: tenta se autenticar como ACTOR_ID usando o ticket de outra pessoa.
    ws.send(JSON.stringify({ type: 'auth', actorId: ACTOR_ID, ticket: ticketDoOutro }));

    const reply = await waitForMessage(ws);
    assert.strictEqual(reply.type, 'auth_failed');
    ws.close();
  });

  it('aceita auth com ticket válido emitido pra aquele actorId', async () => {
    const ticket = voip.issueTicket(ACTOR_ID);
    const ws = connect();
    await new Promise((resolve) => ws.once('open', resolve));
    ws.send(JSON.stringify({ type: 'auth', actorId: ACTOR_ID, ticket }));

    const reply = await waitForMessage(ws);
    assert.strictEqual(reply.type, 'auth_ok');
    assert.strictEqual(reply.actorId, ACTOR_ID);
    assert.ok(voip.getConnectedVoipActors().includes(ACTOR_ID));
    ws.close();
  });

  it('ticket é de uso único — replay do mesmo ticket falha', async () => {
    const ticket = voip.issueTicket(ACTOR_ID);

    const ws1 = connect();
    await new Promise((resolve) => ws1.once('open', resolve));
    ws1.send(JSON.stringify({ type: 'auth', actorId: ACTOR_ID, ticket }));
    const reply1 = await waitForMessage(ws1);
    assert.strictEqual(reply1.type, 'auth_ok');
    ws1.close();

    const ws2 = connect();
    await new Promise((resolve) => ws2.once('open', resolve));
    ws2.send(JSON.stringify({ type: 'auth', actorId: ACTOR_ID, ticket }));
    const reply2 = await waitForMessage(ws2);
    assert.strictEqual(reply2.type, 'auth_failed', 'reusar o mesmo ticket deveria falhar');
    ws2.close();
  });

  // Os dois casos abaixo montam o ticket na mão, então precisam da mesma chave
  // que o serviço usa — hoje `${actorId}:${role}`, porque um ticket por ator não
  // dava conta dos dois papéis (ver VOICE_NATIVE_HELPER.md §10). Usar a chave
  // errada aqui faria o caso de expirado passar por ausência de ticket em vez de
  // por expiração: a resposta certa pelo motivo errado.
  it('_consumeTicket rejeita ticket expirado', () => {
    voip._pendingTickets.set(voip._ticketKey(ACTOR_ID, 'listener'), { token: 'abc', expiresAt: Date.now() - 1000 });
    assert.strictEqual(voip._consumeTicket(ACTOR_ID, 'abc'), false);
  });

  it('_consumeTicket aceita ticket válido dentro do TTL', () => {
    voip._pendingTickets.set(voip._ticketKey(ACTOR_ID, 'listener'), { token: 'abc', expiresAt: Date.now() + 10000 });
    assert.strictEqual(voip._consumeTicket(ACTOR_ID, 'abc'), true);
  });

  it('ticket de um papel não vale no outro', () => {
    // Os dois papéis autenticam no mesmo endpoint com o mesmo formato. Se o
    // ticket fosse intercambiável, o /voz de um jogador daria ao helper dele um
    // token que também abre o slot de listener — e o handshake pararia de
    // distinguir os dois lados que a §10 acabou de separar.
    const listenerTicket = voip.issueTicket(ACTOR_ID, 'listener');
    assert.strictEqual(voip._consumeTicket(ACTOR_ID, listenerTicket, 'sender'), false);

    const senderTicket = voip.issueTicket(ACTOR_ID, 'sender');
    assert.strictEqual(voip._consumeTicket(ACTOR_ID, senderTicket, 'listener'), false);
    // E o do sender continua válido no papel dele — o teste acima não o queimou.
    assert.strictEqual(voip._consumeTicket(ACTOR_ID, senderTicket, 'sender'), true);
  });

  it('issueTicket sem papel emite pro listener — é o padrão de compatibilidade', () => {
    const ticket = voip.issueTicket(ACTOR_ID);
    assert.ok(voip._pendingTickets.has(voip._ticketKey(ACTOR_ID, 'listener')));
    assert.strictEqual(voip._consumeTicket(ACTOR_ID, ticket, 'listener'), true);
  });

  it('recusa auth com role desconhecido mesmo havendo ticket para aquela chave', async () => {
    // O ticket é emitido PARA o papel inventado, então a chave existe e o
    // handshake passaria por ela. Sem emitir, a recusa viria da falta de ticket
    // e o teste não diria nada sobre a validação de papel — passaria igual com a
    // validação removida. O papel precisa ser barrado por ser desconhecido.
    //
    // O que isso protege: `entry[role] = conexão` grava a propriedade que vier.
    // Um papel arbitrário cria um slot que nenhum tick lê, nenhum relay entrega
    // e nenhum `close` limpa — uma conexão viva e invisível pro serviço.
    const ticket = voip.issueTicket(ACTOR_ID, 'admin');
    const ws = connect();
    await new Promise((resolve) => ws.once('open', resolve));
    ws.send(JSON.stringify({ type: 'auth', actorId: ACTOR_ID, ticket, role: 'admin' }));

    // O `finally` não é zelo: se a asserção falhar antes do close, o socket fica
    // aberto e o processo do `node --test` não encerra — o arquivo inteiro trava
    // em vez de reprovar, e um teste que trava não diz qual defeito ele pegou.
    try {
      const reply = await waitForMessage(ws);
      assert.strictEqual(reply.type, 'auth_failed');
      await waitForClose(ws);
      assert.strictEqual(voip._voipClients.has(ACTOR_ID), false, 'nada deveria ter sido registrado');
    } finally {
      ws.close();
    }
  });
});

describe('voip-service — quota de audio_frame', () => {
  it('aceita o burst inicial e descarta o frame seguinte ate haver reposicao', () => {
    const conn = { audioTokens: voip.AUDIO_FRAME_BURST, audioLastRefillAt: 0 };

    for (let i = 0; i < voip.AUDIO_FRAME_BURST; i++) {
      assert.strictEqual(voip._consumeAudioFrameQuota(conn, 0), true);
    }
    assert.strictEqual(voip._consumeAudioFrameQuota(conn, 0), false);
  });

  it('repoe frames pela cadencia configurada, sem ultrapassar o burst', () => {
    const conn = { audioTokens: 0, audioLastRefillAt: 0 };
    assert.strictEqual(voip._consumeAudioFrameQuota(conn, 1000), true);
    assert.ok(conn.audioTokens <= voip.AUDIO_FRAME_BURST - 1);
  });
});

/**
 * Relay de `audio_frame` — o caminho novo, que substitui o WebRTC P2P (bloqueado
 * pela CEF do lado da captura). Aqui `mp` precisa ser mockado: a proximidade lê
 * `mp.get(actorId, 'locationalData')`, e sem posição não há audiência nenhuma.
 *
 * O tick é chamado à mão em vez de esperar o timer de 2s — um teste que dorme
 * dois segundos por caso não é um teste, é um castigo.
 */
describe('voip-service — relay de audio_frame por proximidade', () => {
  const SPEAKER = 0xff00c001;
  const NEAR = 0xff00c002;
  const FAR = 0xff00c003;

  const RANGE = VOICE_RANGES.normal;
  const positions = new Map();

  // 2560 chars = exatamente um quadro de 20ms (1920 bytes) em base64.
  const FRAME = 'A'.repeat(2560);

  let relayPort;

  before(async () => {
    global.mp = {
      get: (actorId, prop) => {
        if (prop !== 'locationalData') return null;
        const pos = positions.get(actorId);
        return pos ? { pos } : null;
      }
    };

    voip.startVoipServer(0, '127.0.0.1');
    for (let i = 0; i < 50 && !voip.getListeningPort(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    relayPort = voip.getListeningPort();
    assert.ok(relayPort > 0);
  });

  after(() => {
    voip.stopVoipServer();
    delete global.mp;
  });

  // Todo socket aberto por um teste é fechado ao fim dele.
  //
  // Não é higiene opcional. Um socket vazado mantém o processo do `node --test`
  // vivo depois do último caso (todos passam e o arquivo reprova por timeout),
  // e pior: `voipClients` é indexado por actorId, então um socket órfão do teste
  // anterior que fecha durante o próximo apaga a entrada do socket *novo* com o
  // mesmo actorId — o teste seguinte falha por um motivo que não é o dele.
  const openSockets = [];

  beforeEach(() => {
    positions.clear();
    voip._pendingTickets.clear();
    voip.voiceCore.routes.reset();
  });

  afterEach(async () => {
    await Promise.all(openSockets.splice(0).map((ws) => new Promise((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) return resolve();
      ws.once('close', resolve);
      ws.close();
    })));
  });

  function track(ws) {
    openSockets.push(ws);
    return ws;
  }

  /**
   * Conecta, autentica com ticket válido e devolve um socket que acumula mensagens.
   *
   * `role` undefined não manda o campo — é de propósito, e é o que o
   * `index.html` faz hoje. Assim a maioria dos casos deste arquivo continua
   * exercitando o caminho de compatibilidade sem pedir nada a ele.
   */
  async function connectAuthed(actorId, role) {
    comPersonagem(actorId);
    const ticket = voip.issueTicket(actorId, role || 'listener');
    const ws = track(new WebSocket(`ws://127.0.0.1:${relayPort}`));
    ws.received = [];
    ws.on('message', (raw) => ws.received.push(JSON.parse(raw.toString())));
    await new Promise((resolve) => ws.once('open', resolve));
    const auth = { type: 'auth', actorId, ticket };
    if (role !== undefined) auth.role = role;
    ws.send(JSON.stringify(auth));
    await waitFor(ws, 'auth_ok');
    return ws;
  }

  /**
   * Espera uma mensagem de um tipo específico. Filtrar por tipo não é preciosismo:
   * o ticker de 2s pode injetar um `proximity_update` no meio, e um `once('message')`
   * cru pegaria essa mensagem e o teste falharia por motivo errado.
   */
  function waitFor(ws, type, timeoutMs = 1000) {
    const already = ws.received.find((m) => m.type === type);
    if (already) return Promise.resolve(already);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout esperando '${type}'`)), timeoutMs);
      const onMessage = (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type !== type) return;
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(msg);
      };
      ws.on('message', onMessage);
    });
  }

  /** Dá tempo do servidor processar e (não) entregar antes de afirmar ausência. */
  function settle() {
    return new Promise((resolve) => setTimeout(resolve, 120));
  }

  it('retransmite o frame para quem está em alcance', async () => {
    positions.set(SPEAKER, [0, 0, 0]);
    positions.set(NEAR, [RANGE * 0.5, 0, 0]);

    const speaker = await connectAuthed(SPEAKER);
    const near = await connectAuthed(NEAR);
    voip.tickProximity();

    speaker.send(JSON.stringify({ type: 'audio_frame', seq: 7, data: FRAME }));
    const got = await waitFor(near, 'audio_frame');

    assert.strictEqual(got.fromActorId, SPEAKER);
    assert.strictEqual(got.seq, 7);
    assert.strictEqual(got.data, FRAME, 'o servidor não deve tocar nos bytes de áudio');

  });

  it('repassa `codec` sem olhar dentro — Opus vai, PCM sem o campo tambem vai', async () => {
    positions.set(SPEAKER, [0, 0, 0]);
    positions.set(NEAR, [RANGE * 0.5, 0, 0]);

    const speaker = await connectAuthed(SPEAKER);
    const near = await connectAuthed(NEAR);
    voip.tickProximity();

    // `waitFor` cacheia o primeiro `audio_frame` recebido e devolveria ele de
    // novo numa segunda chamada — por isso os dois quadros saem antes de olhar
    // o que chegou, e a leitura é direto em `near.received` (mesmo padrão de
    // `countFrames`/`far.received.filter` usado no resto deste arquivo).
    speaker.send(JSON.stringify({ type: 'audio_frame', seq: 1, codec: 'opus', data: FRAME }));
    speaker.send(JSON.stringify({ type: 'audio_frame', seq: 2, data: FRAME }));
    await settle();

    const frames = near.received.filter((m) => m.type === 'audio_frame');
    assert.strictEqual(frames.length, 2);
    assert.strictEqual(frames[0].codec, 'opus', 'o servidor nao decide o codec, so repassa o que o locutor declarou');
    assert.strictEqual(frames[1].codec, undefined,
      'ausencia de codec e o PCM cru legado — nao vira "null" nem um default inventado pelo servidor');
  });

  it('o volume retransmitido é o mesmo que calcVolume daria para aquele par', async () => {
    const dist = RANGE * 0.25;
    positions.set(SPEAKER, [0, 0, 0]);
    positions.set(NEAR, [dist, 0, 0]);

    const speaker = await connectAuthed(SPEAKER);
    const near = await connectAuthed(NEAR);
    voip.tickProximity();

    speaker.send(JSON.stringify({ type: 'audio_frame', data: FRAME }));
    const got = await waitFor(near, 'audio_frame');

    assert.strictEqual(got.volume, voip.calcVolume(dist, RANGE));
    assert.ok(Math.abs(got.volume - 0.75) < 1e-9, `volume esperado ~0.75, veio ${got.volume}`);

    // E precisa bater com o que o proximity_update manda pro ganho do WebRTC —
    // se os dois caminhos discordassem, a mesma pessoa soaria em dois volumes
    // diferentes dependendo de qual transporte a entregou.
    const prox = await waitFor(near, 'proximity_update', 2500);
    const peer = prox.peers.find((p) => p.actorId === SPEAKER);
    assert.ok(peer, 'o locutor deveria aparecer no proximity_update do ouvinte');
    assert.strictEqual(peer.volume, got.volume);

  });

  it('NÃO retransmite para quem está fora do alcance', async () => {
    positions.set(SPEAKER, [0, 0, 0]);
    positions.set(FAR, [RANGE * 1.5, 0, 0]);

    const speaker = await connectAuthed(SPEAKER);
    const far = await connectAuthed(FAR);
    voip.tickProximity();

    speaker.send(JSON.stringify({ type: 'audio_frame', data: FRAME }));
    await settle();

    assert.strictEqual(
      far.received.filter((m) => m.type === 'audio_frame').length, 0,
      'quem está fora do alcance não deveria receber nada'
    );

  });

  it('entrega ao que está perto e não ao que está longe, no mesmo frame', async () => {
    positions.set(SPEAKER, [0, 0, 0]);
    positions.set(NEAR, [RANGE * 0.5, 0, 0]);
    positions.set(FAR, [RANGE * 2, 0, 0]);

    const speaker = await connectAuthed(SPEAKER);
    const near = await connectAuthed(NEAR);
    const far = await connectAuthed(FAR);
    voip.tickProximity();

    speaker.send(JSON.stringify({ type: 'audio_frame', data: FRAME }));
    await waitFor(near, 'audio_frame');
    await settle();

    assert.strictEqual(far.received.filter((m) => m.type === 'audio_frame').length, 0);

  });

  it('o locutor não recebe o próprio frame de volta', async () => {
    positions.set(SPEAKER, [0, 0, 0]);
    positions.set(NEAR, [RANGE * 0.5, 0, 0]);

    const speaker = await connectAuthed(SPEAKER);
    const near = await connectAuthed(NEAR);
    voip.tickProximity();

    speaker.send(JSON.stringify({ type: 'audio_frame', data: FRAME }));
    await waitFor(near, 'audio_frame');
    await settle();

    assert.strictEqual(
      speaker.received.filter((m) => m.type === 'audio_frame').length, 0,
      'ouvir a si mesmo com atraso de rede é eco, não voz'
    );

  });

  it('relaya sob a identidade autenticada, não sob o fromActorId que veio no frame', async () => {
    // O ataque: FAR está longe do NEAR e não deveria ser ouvido por ele, mas
    // manda um frame carimbado como se fosse do SPEAKER, que está pertinho.
    // Se o servidor lesse `fromActorId` da mensagem em vez de usar a identidade
    // que ele mesmo autenticou, a voz de qualquer um sairia da boca de outro —
    // é o mesmo furo do spoofing de actorId no `auth`, uma camada acima.
    positions.set(SPEAKER, [0, 0, 0]);
    positions.set(NEAR, [RANGE * 0.5, 0, 0]);
    positions.set(FAR, [RANGE * 5, 0, 0]);

    const near = await connectAuthed(NEAR);
    const far = await connectAuthed(FAR);
    await connectAuthed(SPEAKER);
    voip.tickProximity();

    far.send(JSON.stringify({ type: 'audio_frame', fromActorId: SPEAKER, data: FRAME }));
    await settle();

    assert.strictEqual(
      near.received.filter((m) => m.type === 'audio_frame').length, 0,
      'o frame do FAR não deveria chegar no NEAR carimbado como SPEAKER'
    );
  });

  it('descarta frame de conexão não autenticada', async () => {
    positions.set(SPEAKER, [0, 0, 0]);
    positions.set(NEAR, [RANGE * 0.5, 0, 0]);

    const speaker = await connectAuthed(SPEAKER);
    const near = await connectAuthed(NEAR);
    voip.tickProximity();

    // Terceira conexão, sem auth: manda frame se passando pelo locutor.
    const anon = track(new WebSocket(`ws://127.0.0.1:${relayPort}`));
    await new Promise((resolve) => anon.once('open', resolve));
    anon.send(JSON.stringify({ type: 'audio_frame', fromActorId: SPEAKER, data: FRAME }));
    await settle();

    assert.strictEqual(
      near.received.filter((m) => m.type === 'audio_frame').length, 0,
      'sem ticket não se injeta áudio na cena de ninguém'
    );

  });

  it('descarta frame acima do teto de tamanho', async () => {
    positions.set(SPEAKER, [0, 0, 0]);
    positions.set(NEAR, [RANGE * 0.5, 0, 0]);

    const speaker = await connectAuthed(SPEAKER);
    const near = await connectAuthed(NEAR);
    voip.tickProximity();

    speaker.send(JSON.stringify({
      type: 'audio_frame',
      data: 'A'.repeat(voip.MAX_AUDIO_FRAME_B64 + 1)
    }));
    await settle();

    assert.strictEqual(
      near.received.filter((m) => m.type === 'audio_frame').length, 0,
      'frame acima do teto seria amplificado pelo relay para todos em alcance'
    );

    // E o socket continua vivo: descartar o frame não é motivo pra derrubar a voz.
    speaker.send(JSON.stringify({ type: 'audio_frame', data: FRAME }));
    await waitFor(near, 'audio_frame');

  });

  it('locutor mutado não é retransmitido', async () => {
    positions.set(SPEAKER, [0, 0, 0]);
    positions.set(NEAR, [RANGE * 0.5, 0, 0]);

    const speaker = await connectAuthed(SPEAKER);
    const near = await connectAuthed(NEAR);
    speaker.send(JSON.stringify({ type: 'mute', muted: true }));
    await settle();
    voip.tickProximity();

    speaker.send(JSON.stringify({ type: 'audio_frame', data: FRAME }));
    await settle();

    assert.strictEqual(near.received.filter((m) => m.type === 'audio_frame').length, 0);

  });

  it('sem tick não há audiência — frame que chega antes do primeiro tick não vaza', async () => {
    positions.set(SPEAKER, [0, 0, 0]);
    positions.set(NEAR, [RANGE * 0.5, 0, 0]);

    const speaker = await connectAuthed(SPEAKER);
    const near = await connectAuthed(NEAR);
    // De propósito: nenhum tickProximity() aqui.

    speaker.send(JSON.stringify({ type: 'audio_frame', data: FRAME }));
    await settle();

    assert.strictEqual(near.received.filter((m) => m.type === 'audio_frame').length, 0);

  });

  it('tick que não consegue ler posição zera a audiência em vez de manter a velha', async () => {
    positions.set(SPEAKER, [0, 0, 0]);
    positions.set(NEAR, [RANGE * 0.5, 0, 0]);

    const speaker = await connectAuthed(SPEAKER);
    const near = await connectAuthed(NEAR);
    voip.tickProximity();

    // Confere que a audiência existe antes de tirar o chão dela.
    speaker.send(JSON.stringify({ type: 'audio_frame', data: FRAME }));
    await waitFor(near, 'audio_frame');
    near.received.length = 0;

    // Agora o tick roda sem `mp` — nenhuma posição é legível.
    const savedMp = global.mp;
    delete global.mp;
    try {
      voip.tickProximity();
      speaker.send(JSON.stringify({ type: 'audio_frame', data: FRAME }));
      await settle();
    } finally {
      global.mp = savedMp;
    }

    assert.strictEqual(
      near.received.filter((m) => m.type === 'audio_frame').length, 0,
      'sem posição não há proximidade; entregar pela audiência velha seria ' +
      'retransmitir com base em onde as pessoas estavam, não onde estão'
    );
  });

  it('sinalização WebRTC continua sendo repassada — a Fase 1 adiciona, não substitui', async () => {
    positions.set(SPEAKER, [0, 0, 0]);
    positions.set(NEAR, [RANGE * 0.5, 0, 0]);

    const speaker = await connectAuthed(SPEAKER);
    const near = await connectAuthed(NEAR);

    speaker.send(JSON.stringify({ type: 'offer', targetActorId: NEAR, sdp: 'v=0 fake' }));
    const offer = await waitFor(near, 'offer');

    assert.strictEqual(offer.fromActorId, SPEAKER);
    assert.strictEqual(offer.sdp, 'v=0 fake');

  });
});

/**
 * Conexão dupla: o helper (`sender`) e a UI (`listener`) do MESMO jogador.
 *
 * Este bloco existe porque, até esta rodada, um jogador não conseguia falar e
 * ouvir ao mesmo tempo: `voipClients` era `Map<actorId, conexão>` e quem
 * autenticasse por último derrubava o outro. O teste de bancada da Fase 1
 * contornou usando dois atores distintos, o que é exatamente o cenário que NÃO
 * é o de um jogador real. Ver VOICE_NATIVE_HELPER.md §10.
 */
describe('voip-service — helper e UI do mesmo ator convivendo', () => {
  const ALICE = 0xff00d001;
  const BOB = 0xff00d002;

  const RANGE = VOICE_RANGES.normal;
  const positions = new Map();
  const FRAME = 'A'.repeat(2560);

  let dualPort;
  const openSockets = [];

  before(async () => {
    global.mp = {
      get: (actorId, prop) => {
        if (prop !== 'locationalData') return null;
        const pos = positions.get(actorId);
        return pos ? { pos } : null;
      }
    };
    voip.startVoipServer(0, '127.0.0.1');
    for (let i = 0; i < 50 && !voip.getListeningPort(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    dualPort = voip.getListeningPort();
    assert.ok(dualPort > 0);
  });

  after(() => {
    voip.stopVoipServer();
    delete global.mp;
  });

  beforeEach(() => {
    positions.clear();
    voip._pendingTickets.clear();
    voip.voiceCore.routes.reset();
    voip._voipClients.clear();
  });

  afterEach(async () => {
    await Promise.all(openSockets.splice(0).map((ws) => new Promise((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) return resolve();
      ws.once('close', resolve);
      ws.close();
    })));
  });

  async function connectAs(actorId, role) {
    comPersonagem(actorId);
    const ticket = voip.issueTicket(actorId, role);
    const ws = new WebSocket(`ws://127.0.0.1:${dualPort}`);
    openSockets.push(ws);
    ws.received = [];
    ws.on('message', (raw) => ws.received.push(JSON.parse(raw.toString())));
    await new Promise((resolve) => ws.once('open', resolve));
    ws.send(JSON.stringify({ type: 'auth', actorId, ticket, role }));
    await waitForType(ws, 'auth_ok');
    return ws;
  }

  function waitForType(ws, type, timeoutMs = 1000) {
    const already = ws.received.find((m) => m.type === type);
    if (already) return Promise.resolve(already);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout esperando '${type}'`)), timeoutMs);
      const onMessage = (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type !== type) return;
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(msg);
      };
      ws.on('message', onMessage);
    });
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 120));
  const countFrames = (ws) => ws.received.filter((m) => m.type === 'audio_frame').length;

  it('os dois papéis do mesmo ator ficam conectados ao mesmo tempo', async () => {
    const listener = await connectAs(ALICE, 'listener');
    const sender = await connectAs(ALICE, 'sender');

    // O antigo `voipClients.set(actorId, ...)` fazia o segundo auth sobrescrever
    // o primeiro; nenhum dos dois sockets fechava, mas um virava órfão — vivo e
    // invisível pro servidor.
    assert.strictEqual(listener.readyState, WebSocket.OPEN);
    assert.strictEqual(sender.readyState, WebSocket.OPEN);

    const entry = voip._voipClients.get(ALICE);
    assert.ok(entry, 'o ator deveria ter entrada');
    assert.ok(entry.listener, 'slot de listener ocupado');
    assert.ok(entry.sender, 'slot de sender ocupado');
    assert.notStrictEqual(entry.listener.ws, entry.sender.ws, 'são dois sockets distintos');

    assert.deepStrictEqual(voip.getConnectedVoipActors(), [ALICE], 'uma pessoa, um ator');
  });

  it('o áudio do sender de Alice chega no listener de Bob, e não no de Alice', async () => {
    positions.set(ALICE, [0, 0, 0]);
    positions.set(BOB, [RANGE * 0.5, 0, 0]);

    const aliceListener = await connectAs(ALICE, 'listener');
    const aliceSender = await connectAs(ALICE, 'sender');
    const bobListener = await connectAs(BOB, 'listener');
    voip.tickProximity();

    aliceSender.send(JSON.stringify({ type: 'audio_frame', seq: 3, data: FRAME }));
    const got = await waitForType(bobListener, 'audio_frame');

    assert.strictEqual(got.fromActorId, ALICE);
    assert.strictEqual(got.data, FRAME);
    await settle();

    // O ponto todo da separação de papéis: a voz sai por um socket de Alice e
    // não pode voltar pelo outro. Ouvir a própria voz com atraso de rede é eco.
    assert.strictEqual(countFrames(aliceListener), 0, 'Alice não ouve a própria voz');
    assert.strictEqual(countFrames(aliceSender), 0, 'o helper não recebe áudio nenhum');
  });

  it('o sender não recebe proximity_update; o listener recebe', async () => {
    positions.set(ALICE, [0, 0, 0]);
    positions.set(BOB, [RANGE * 0.5, 0, 0]);

    const aliceListener = await connectAs(ALICE, 'listener');
    const aliceSender = await connectAs(ALICE, 'sender');
    await connectAs(BOB, 'listener');
    voip.tickProximity();
    await settle();

    const prox = aliceListener.received.filter((m) => m.type === 'proximity_update');
    assert.ok(prox.length > 0, 'a UI precisa do mapa de volume pra ajustar o ganho');
    assert.strictEqual(
      aliceSender.received.filter((m) => m.type === 'proximity_update').length, 0,
      'o helper não tem ganho pra ajustar — mandar isso pra ele é banda jogada fora'
    );

    // E Bob aparece uma vez só, não duas — a posição é lida por ator, não por
    // conexão. Duplicado aqui viraria cada quadro entregue em dobro.
    assert.strictEqual(prox[prox.length - 1].peers.filter((p) => p.actorId === BOB).length, 1);
  });

  it('fechar o sender não derruba o listener nem anuncia peer_left', async () => {
    positions.set(ALICE, [0, 0, 0]);
    positions.set(BOB, [RANGE * 0.5, 0, 0]);

    const aliceListener = await connectAs(ALICE, 'listener');
    const aliceSender = await connectAs(ALICE, 'sender');
    const bobListener = await connectAs(BOB, 'listener');
    voip.tickProximity();

    await new Promise((resolve) => { aliceSender.once('close', resolve); aliceSender.close(); });
    await settle();

    assert.strictEqual(aliceListener.readyState, WebSocket.OPEN, 'a UI de Alice segue viva');
    assert.ok(voip._voipClients.has(ALICE), 'Alice continua na cena de voz');
    assert.strictEqual(voip._voipClients.get(ALICE).sender, null);

    // Alice fechou o helper: ela parou de falar, mas continua ouvindo. Anunciar
    // saída faria a UI de Bob desmontar o áudio de alguém que ainda está lá.
    assert.strictEqual(
      bobListener.received.filter((m) => m.type === 'peer_left').length, 0,
      'sair o sender não é sair da cena'
    );

    // E Bob ainda alcança Alice: ela segue recebendo.
    const bobSender = await connectAs(BOB, 'sender');
    voip.tickProximity();
    bobSender.send(JSON.stringify({ type: 'audio_frame', data: FRAME }));
    await waitForType(aliceListener, 'audio_frame');
  });

  it('fechar o listener anuncia peer_left e não derruba o sender', async () => {
    positions.set(ALICE, [0, 0, 0]);
    positions.set(BOB, [RANGE * 0.5, 0, 0]);

    const aliceListener = await connectAs(ALICE, 'listener');
    const aliceSender = await connectAs(ALICE, 'sender');
    const bobListener = await connectAs(BOB, 'listener');
    voip.tickProximity();

    await new Promise((resolve) => { aliceListener.once('close', resolve); aliceListener.close(); });
    await settle();

    assert.strictEqual(aliceSender.readyState, WebSocket.OPEN, 'o helper de Alice segue vivo');
    const left = bobListener.received.filter((m) => m.type === 'peer_left');
    assert.strictEqual(left.length, 1, 'sair o listener é sair da cena de voz');
    assert.strictEqual(left[0].actorId, ALICE);

    // Alice ficou só com o helper: ela não ouve mais nada, mas continua audível.
    voip.tickProximity();
    aliceSender.send(JSON.stringify({ type: 'audio_frame', data: FRAME }));
    const got = await waitForType(bobListener, 'audio_frame');
    assert.strictEqual(got.fromActorId, ALICE);
  });

  it('mute pela UI cala o helper — o estado é do ator, não da conexão', async () => {
    positions.set(ALICE, [0, 0, 0]);
    positions.set(BOB, [RANGE * 0.5, 0, 0]);

    const aliceListener = await connectAs(ALICE, 'listener');
    const aliceSender = await connectAs(ALICE, 'sender');
    const bobListener = await connectAs(BOB, 'listener');

    // O mute chega pelo socket da UI; quem transmite é o outro socket. Se o
    // estado morasse na conexão, Alice se veria mutada e seguiria sendo ouvida.
    aliceListener.send(JSON.stringify({ type: 'mute', muted: true }));
    await settle();
    voip.tickProximity();

    aliceSender.send(JSON.stringify({ type: 'audio_frame', data: FRAME }));
    await settle();
    assert.strictEqual(countFrames(bobListener), 0, 'mutado na UI é mutado na cena');

    // E desmutar pela UI devolve a voz do helper.
    aliceListener.send(JSON.stringify({ type: 'mute', muted: false }));
    await settle();
    voip.tickProximity();
    aliceSender.send(JSON.stringify({ type: 'audio_frame', data: FRAME }));
    await waitForType(bobListener, 'audio_frame');
  });

  it('um ator só com sender não recebe nada — nem áudio, nem proximity_update', async () => {
    // Alice fecha a UI e deixa só o helper (ou nunca abriu a UI). Ela continua
    // audível, mas não há pra onde entregar. A tentação de "manda pro socket que
    // estiver aberto" é o bug: o helper descartaria tudo, e o servidor pagaria
    // banda de descida por quadro por ouvinte pra que ninguém ouvisse nada.
    positions.set(ALICE, [0, 0, 0]);
    positions.set(BOB, [RANGE * 0.5, 0, 0]);

    const aliceSender = await connectAs(ALICE, 'sender');
    const bobSender = await connectAs(BOB, 'sender');
    const bobListener = await connectAs(BOB, 'listener');
    voip.tickProximity();

    bobSender.send(JSON.stringify({ type: 'audio_frame', data: FRAME }));
    await settle();

    assert.strictEqual(countFrames(aliceSender), 0, 'o helper não toca áudio — não deve receber');
    assert.strictEqual(
      aliceSender.received.filter((m) => m.type === 'proximity_update').length, 0,
      'o helper não tem ganho pra ajustar'
    );

    // E Alice segue sendo ouvida por Bob: sem listener ela é muda pra si, não pros outros.
    aliceSender.send(JSON.stringify({ type: 'audio_frame', data: FRAME }));
    const got = await waitForType(bobListener, 'audio_frame');
    assert.strictEqual(got.fromActorId, ALICE);
  });

  it('ator com dois papéis conta uma vez só na audiência e no proximity_update', async () => {
    // A posição é lida por ator. Se o tick iterasse conexões, Alice (dois papéis)
    // entraria duas vezes na lista: apareceria duplicada no proximity_update de
    // Bob e, pior, cada quadro de Bob seria entregue DUAS vezes no listener dela
    // — voz dobrada sobre si mesma, que soa como flanger, não como defeito de rede.
    positions.set(ALICE, [0, 0, 0]);
    positions.set(BOB, [RANGE * 0.5, 0, 0]);

    const aliceListener = await connectAs(ALICE, 'listener');
    await connectAs(ALICE, 'sender');
    const bobListener = await connectAs(BOB, 'listener');
    const bobSender = await connectAs(BOB, 'sender');
    voip.tickProximity();
    await settle();

    const prox = bobListener.received.filter((m) => m.type === 'proximity_update');
    assert.ok(prox.length > 0);
    assert.strictEqual(
      prox[prox.length - 1].peers.filter((p) => p.actorId === ALICE).length, 1,
      'Alice é uma pessoa num lugar só, mesmo com dois sockets'
    );

    bobSender.send(JSON.stringify({ type: 'audio_frame', seq: 9, data: FRAME }));
    await waitForType(aliceListener, 'audio_frame');
    await settle();
    assert.strictEqual(countFrames(aliceListener), 1, 'um quadro enviado, um quadro entregue');
  });

  it('reconectar um papel substitui só aquele papel', async () => {
    const aliceListener = await connectAs(ALICE, 'listener');
    const firstSender = await connectAs(ALICE, 'sender');

    // O helper caiu e voltou. O close atrasado do socket velho chega DEPOIS de o
    // novo já estar registrado — se o handler não conferisse a identidade do
    // socket, esse adeus limparia o slot do novo.
    const secondSender = await connectAs(ALICE, 'sender');
    await settle();

    assert.strictEqual(firstSender.readyState, WebSocket.CLOSED, 'o helper antigo é fechado');
    assert.strictEqual(secondSender.readyState, WebSocket.OPEN);
    assert.strictEqual(aliceListener.readyState, WebSocket.OPEN, 'a UI não foi tocada');

    const entry = voip._voipClients.get(ALICE);
    assert.ok(entry.sender, 'o slot de sender não pode ficar vazio depois da troca');
    assert.strictEqual(entry.sender.ws.readyState, WebSocket.OPEN);
    assert.ok(entry.listener, 'e o listener continua lá');
  });
});

/**
 * Proximidade por CÉLULA, não só por coordenada.
 *
 * `locationalData` devolve `cellOrWorldDesc` junto com `pos` porque posição
 * sozinha não identifica lugar: cada interior do Skyrim é construído em torno da
 * própria origem, então duas tavernas distintas — ou uma taverna e uma masmorra —
 * têm coordenadas na mesma vizinhança numérica. Comparar só `pos` faz a voz
 * atravessar de um interior pra outro sem existir caminho entre eles.
 *
 * O mock daqui devolve os dois campos (os outros blocos deste arquivo devolvem
 * só `pos`, de propósito: célula desconhecida não deve descartar ninguém).
 *
 * Se a checagem de célula sumir do `tickProximity`, o segundo caso reprova; se
 * for invertida, o primeiro reprova junto.
 */
describe('voip-service — proximidade respeita a célula', () => {
  const IN_TAVERN = 0xff00f001;
  const IN_TAVERN_2 = 0xff00f002;
  const IN_DUNGEON = 0xff00f003;

  const TAVERN = '162e2:Skyrim.esm';
  const DUNGEON = '1a26f:Skyrim.esm';

  const RANGE = VOICE_RANGES.normal;
  const FRAME = 'A'.repeat(2560);
  const locs = new Map();

  let cellPort;
  const openSockets = [];

  before(async () => {
    global.mp = {
      get: (actorId, prop) => {
        if (prop !== 'locationalData') return null;
        return locs.get(actorId) || null;
      }
    };
    voip.startVoipServer(0, '127.0.0.1');
    for (let i = 0; i < 50 && !voip.getListeningPort(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    cellPort = voip.getListeningPort();
    assert.ok(cellPort > 0);
  });

  after(() => {
    voip.stopVoipServer();
    delete global.mp;
  });

  beforeEach(() => {
    locs.clear();
    voip._pendingTickets.clear();
    voip.voiceCore.routes.reset();
    voip._voipClients.clear();
  });

  afterEach(async () => {
    await Promise.all(openSockets.splice(0).map((ws) => new Promise((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) return resolve();
      ws.once('close', resolve);
      ws.close();
    })));
  });

  async function connectAs(actorId, role) {
    comPersonagem(actorId);
    const ticket = voip.issueTicket(actorId, role || 'listener');
    const ws = new WebSocket(`ws://127.0.0.1:${cellPort}`);
    openSockets.push(ws);
    ws.received = [];
    ws.on('message', (raw) => ws.received.push(JSON.parse(raw.toString())));
    await new Promise((resolve) => ws.once('open', resolve));
    const auth = { type: 'auth', actorId, ticket };
    if (role !== undefined) auth.role = role;
    ws.send(JSON.stringify(auth));
    await waitForType(ws, 'auth_ok');
    return ws;
  }

  function waitForType(ws, type, timeoutMs = 1000) {
    const already = ws.received.find((m) => m.type === type);
    if (already) return Promise.resolve(already);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout esperando '${type}'`)), timeoutMs);
      const onMessage = (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type !== type) return;
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(msg);
      };
      ws.on('message', onMessage);
    });
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 120));
  const countFrames = (ws) => ws.received.filter((m) => m.type === 'audio_frame').length;
  const lastProx = (ws) => {
    const all = ws.received.filter((m) => m.type === 'proximity_update');
    return all.length ? all[all.length - 1] : null;
  };

  it('mesma célula e dentro do alcance: continuam se ouvindo', async () => {
    locs.set(IN_TAVERN, { cellOrWorldDesc: TAVERN, pos: [0, 0, 0] });
    locs.set(IN_TAVERN_2, { cellOrWorldDesc: TAVERN, pos: [RANGE * 0.5, 0, 0] });

    const speaker = await connectAs(IN_TAVERN, 'sender');
    const listener = await connectAs(IN_TAVERN_2, 'listener');
    voip.tickProximity();
    await settle();

    const prox = lastProx(listener);
    assert.ok(prox, 'o ouvinte precisa receber o mapa de volume');
    assert.ok(
      prox.peers.some((p) => p.actorId === IN_TAVERN),
      'quem está na mesma célula e no alcance tem que aparecer no proximity_update'
    );

    speaker.send(JSON.stringify({ type: 'audio_frame', seq: 1, data: FRAME }));
    const got = await waitForType(listener, 'audio_frame');
    assert.strictEqual(got.fromActorId, IN_TAVERN);
  });

  it('células diferentes com coordenadas próximas: não se ouvem', async () => {
    // A mesma distância do caso anterior — a única coisa que muda é a célula.
    // Sem a checagem, este par passaria pelo filtro de alcance exatamente igual.
    locs.set(IN_TAVERN, { cellOrWorldDesc: TAVERN, pos: [0, 0, 0] });
    locs.set(IN_DUNGEON, { cellOrWorldDesc: DUNGEON, pos: [RANGE * 0.5, 0, 0] });

    const speaker = await connectAs(IN_TAVERN, 'sender');
    const listener = await connectAs(IN_DUNGEON, 'listener');
    voip.tickProximity();
    await settle();

    const prox = lastProx(listener);
    assert.ok(prox, 'o ouvinte recebe o mapa mesmo vazio — o silêncio é a resposta');
    assert.strictEqual(
      prox.peers.filter((p) => p.actorId === IN_TAVERN).length, 0,
      'quem está em outra célula não pode entrar no proximity_update'
    );

    // E o mesmo mapa é o que o relay consulta: audiência errada aqui é áudio
    // entregue a quem não deveria receber, não só um ganho errado no slider.
    const audience = voip.voiceCore.audienceFor(IN_TAVERN);
    assert.strictEqual(
      audience.filter((a) => a.actorId === IN_DUNGEON).length, 0,
      'a audiência do locutor não pode conter alguém de outra célula'
    );

    speaker.send(JSON.stringify({ type: 'audio_frame', seq: 2, data: FRAME }));
    await settle();
    assert.strictEqual(countFrames(listener), 0, 'nenhum quadro atravessa a parede da célula');
  });
});

describe('voip-service — comando /voz', () => {
  it('requestVoiceConnection não lança sem personagem ativo', () => {
    assert.doesNotThrow(() => voip.requestVoiceConnection(0xdeadbeef));
  });

  it('commandDefs registra /voz e /voice', () => {
    const defs = voip.commandDefs();
    const def = defs.find(d => Array.isArray(d.name) && d.name.includes('/voz'));
    assert.ok(def, '/voz deveria estar registrado');
    assert.ok(def.name.includes('/voice'));
    assert.strictEqual(typeof def.handler, 'function');
  });
});

/**
 * Exposição do ticket pra teste manual — ANDAIME TEMPORÁRIO (VOICE_NATIVE_HELPER.md §11).
 *
 * O que precisa estar travado aqui é o PADRÃO: desligado. Um andaime que expõe
 * credencial em texto puro e vem ligado de fábrica é pior do que não ter andaime.
 */
describe('voip-service — exposição do ticket de debug', () => {
  const DEBUG_ACTOR = 0xff00e001;
  const fs = require('fs');
  let savedFlag;

  before(() => {
    savedFlag = process.env.VOIP_DEBUG_EXPOSE_TICKET;
    commands.registerActiveCharacter(DEBUG_ACTOR, { id: 777, first_name: 'Testa', last_name: 'Dora' }, 1, 1);
    global.mp = { set: () => {}, get: () => null };
  });

  after(() => {
    if (savedFlag === undefined) delete process.env.VOIP_DEBUG_EXPOSE_TICKET;
    else process.env.VOIP_DEBUG_EXPOSE_TICKET = savedFlag;
    commands.removeActiveCharacter(DEBUG_ACTOR);
    delete global.mp;
    try { fs.unlinkSync(voip.VOIP_DEBUG_TICKET_FILE); } catch { /* pode não existir */ }
  });

  beforeEach(() => {
    voip._pendingTickets.clear();
    try { fs.unlinkSync(voip.VOIP_DEBUG_TICKET_FILE); } catch { /* pode não existir */ }
  });

  it('desligada por padrão — a ausência da env não expõe nada', () => {
    delete process.env.VOIP_DEBUG_EXPOSE_TICKET;
    assert.strictEqual(voip._debugExposeTicketEnabled(), false);

    voip.requestVoiceConnection(DEBUG_ACTOR);
    assert.strictEqual(
      fs.existsSync(voip.VOIP_DEBUG_TICKET_FILE), false,
      'sem a flag, /voz não pode deixar credencial em disco'
    );
  });

  it("só 'true' liga — qualquer outro valor continua desligado", () => {
    for (const valor of ['false', '1', 'yes', 'TRUE', '']) {
      process.env.VOIP_DEBUG_EXPOSE_TICKET = valor;
      assert.strictEqual(
        voip._debugExposeTicketEnabled(), false,
        `'${valor}' não deveria ligar a exposição`
      );
    }
  });

  it('ligada, grava o ticket de sender com o que o helper precisa', () => {
    process.env.VOIP_DEBUG_EXPOSE_TICKET = 'true';
    voip.requestVoiceConnection(DEBUG_ACTOR);

    assert.ok(fs.existsSync(voip.VOIP_DEBUG_TICKET_FILE), 'o arquivo deveria existir');
    const dump = JSON.parse(fs.readFileSync(voip.VOIP_DEBUG_TICKET_FILE, 'utf8'));

    assert.strictEqual(dump.actorId, DEBUG_ACTOR);
    assert.strictEqual(dump.role, 'sender');
    assert.ok(dump.ticket && dump.ticket.length > 0);
    assert.ok(dump.host, 'sem host o testador não sabe onde conectar');
    assert.ok(dump.port > 0);
    assert.ok(dump.expiresAt, 'sem prazo o testador não sabe se já venceu');

    // O ticket gravado tem que ser o do SENDER: é o que vai pro --ticket do
    // helper. Gravar o do listener daria um token que o helper não consegue usar
    // e que, pior, queimaria o da UI.
    assert.strictEqual(
      voip._pendingTickets.get(voip._ticketKey(DEBUG_ACTOR, 'sender')).token, dump.ticket
    );
    assert.notStrictEqual(
      voip._pendingTickets.get(voip._ticketKey(DEBUG_ACTOR, 'listener')).token, dump.ticket
    );
  });

  it('/voz emite os dois tickets — um por papel, sem um queimar o outro', () => {
    delete process.env.VOIP_DEBUG_EXPOSE_TICKET;
    voip.requestVoiceConnection(DEBUG_ACTOR);

    // Antes desta rodada `issueTicket` sobrescrevia o pendente do ator: o
    // segundo /voz apagava o primeiro e os dois papéis nunca coexistiam.
    assert.ok(voip._pendingTickets.has(voip._ticketKey(DEBUG_ACTOR, 'listener')));
    assert.ok(voip._pendingTickets.has(voip._ticketKey(DEBUG_ACTOR, 'sender')));
  });
});
