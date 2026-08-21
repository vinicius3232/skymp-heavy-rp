/**
 * voip-service.js
 * VOIP por proximidade: sinalização WebRTC (caminho antigo) + relay de áudio (caminho novo).
 *
 * Arquitetura:
 * - Um WebSocketServer (porta 7778, bind local por padrão) recebe conexoes dos clientes CEF.
 * - Cada cliente se autentica enviando { type: 'auth', actorId, ticket, role }. O ticket é
 *   um token de uso único e curta duração emitido pelo servidor (issueTicket) quando o
 *   jogador roda /voz — sem isso, qualquer processo que conecte no WebSocket local
 *   poderia reivindicar o actorId de outro jogador e sequestrar o slot de voz dele.
 * - O servidor calcula a distancia entre atores a cada 2 segundos.
 * - Com base na distancia, envia { type: 'proximity_update', peers: [...] } ao cliente.
 *
 * Um mesmo jogador tem DUAS conexões, porque falar e ouvir saem por processos
 * diferentes desde que a captura foi pra fora do CEF (ver `role` em §2 abaixo e
 * `docs/technical/VOICE_NATIVE_HELPER.md` §10).
 *
 * Dois caminhos convivem aqui de propósito, e a Fase 2 remove o primeiro:
 *
 * 1. WebRTC P2P (offer/answer/ice). O servidor só repassa sinalização; o áudio vai
 *    direto entre os clientes, e o `index.html` ajusta o GainNode com o
 *    `proximity_update`. É o que roda no client SkyMP oficial — e é o caminho que
 *    *não funciona*, porque a captura (`getUserMedia`) é bloqueada no CEF embutido.
 *
 * 2. Relay pelo servidor (`audio_frame`). Um helper nativo fora do CEF captura o
 *    microfone via WASAPI e manda os frames por este mesmo WebSocket; o servidor
 *    retransmite pra quem está em alcance, com o volume já calculado. O navegador
 *    do jogo só *toca* — tocar nunca foi bloqueado pela CEF, só a captura era.
 *    Ver `docs/technical/VOICE_NATIVE_HELPER.md`.
 *
 * Por que relay e não P2P: reverter a flag do Chromium que libera o microfone é
 * um caminho descartado (`docs/technical/VOICE_CLIENT_PATCH.md`) — a remoção foi
 * deliberada na SkyrimPlatform 2.1, e reabri-la exporia o microfone do jogador a
 * qualquer servidor SkyMP que ele conectasse depois, não só a este. De quebra, o
 * relay resolve NAT/CGNAT: dois jogadores em redes residenciais distintas não
 * fecham conexão direta, mas os dois alcançam o servidor.
 *
 * ─── Refatoração de 14/08/2026: a proximidade saiu daqui ───────────────────
 *
 * Este arquivo era o dono de tudo: sockets, tickets, formato PCM, cálculo de
 * proximidade O(n²), tabela de audiência, `voiceMode` e `muted` por ator. Sete
 * responsabilidades, 755 linhas, e a única forma de mexer numa era abrir o
 * arquivo inteiro.
 *
 * O que **saiu** para `core/voice/` e não volta:
 *
 *   - quem ouve quem, e a que volume  → `voice-route-engine` + `voice-policy`
 *   - a vizinhança                    → `voice-spatial-index` (era o laço O(n²))
 *   - `voiceMode`, `muted`, PTT       → `voice-state` + `voice-policy`
 *   - sessão, identidade, token       → `voice-session`
 *   - o laço e a leitura do mundo     → `voice-core`
 *
 * O que **fica**, porque é o que este arquivo de fato é: o **transporte
 * legado** — o WebSocket, o handshake por ticket, os papéis `listener`/`sender`,
 * o teto de tamanho de quadro, a quota de cadência e o relay de bytes.
 *
 * Nenhuma regra de voz mora mais aqui. `tickProximity` e `calcVolume`
 * continuam exportados porque são a superfície que os testes e o resto do
 * projeto já usam, mas hoje são uma linha cada, delegando ao Voice Core.
 *
 * Nota de 14/08/2026: a CEF do SkyMP é a **108** (Chromium 108.0.5359.125), não
 * a "~70" que este cabeçalho e os docs de voz afirmavam. A 108 tem
 * `CefPermissionHandler`, então existe um caminho de microfone **por origem e
 * só áudio** que não depende de flag global nenhuma. Isso não muda uma linha
 * deste arquivo — a proximidade, o mute por ator e o cálculo de volume valem
 * igual em qualquer transporte —, mas muda qual é o próximo passo.
 * Ver `docs/technical/SKYVOICE_LIVEKIT_AUDIT.md` §5 e `core/voice/`.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
// O gamemode roda em CommonJS dentro do Node embutido pelo SkyMP. A tipagem
// publicada por `ws` e a do Node atual divergem ao inferir destructuring de
// `require`, embora o valor exista em runtime no ws 8.x. Manter a fronteira
// como `any` evita um falso positivo do checkJs sem mudar o contrato real.
/** @type {any} */
const ws = require('ws');
const { WebSocketServer, WebSocket } = ws;
const commands = require('./commands');
const voiceSecurity = require('./core/voice/voice-security');

const VOIP_PORT = Number.parseInt(process.env.VOIP_PORT, 10) || 7778;
const VOIP_BIND_HOST = process.env.VOIP_BIND_HOST || '127.0.0.1';
const VOIP_PUBLIC_HOST = process.env.VOIP_PUBLIC_HOST || '127.0.0.1';

/**
 * ⚠️ ANDAIME DE TESTE, padrão desligado. Ver `_exposeDebugTicket`.
 *
 * Ligada, faz o /voz gravar o ticket do helper em texto puro (arquivo + log).
 * Não entra em nenhum `.env.example`: quem precisa liga à mão durante o teste
 * manual e desliga depois. A Fase 3 remove a flag inteira.
 *
 * Lida a cada chamada, não uma vez no load: o padrão é desligado, e uma flag que
 * só pode ser ligada reiniciando o servidor é uma flag que alguém vai deixar
 * ligada no `.env` pra não ter que reiniciar de novo. Custa um `process.env` por
 * /voz — que é um comando humano, não um caminho quente.
 */
const VOIP_DEBUG_TICKET_FILE = path.join(__dirname, '.voip-debug-ticket.json');

function _debugExposeTicketEnabled() {
  return process.env.VOIP_DEBUG_EXPOSE_TICKET === 'true';
}

/**
 * Os dois papéis de conexão de um mesmo jogador.
 *
 * `listener` é o `index.html` dentro do CEF: recebe `proximity_update`,
 * `audio_frame` e a sinalização WebRTC, e é ele quem toca som.
 * `sender` é o helper nativo (`voice-helper/`): só empurra `audio_frame` e
 * ignora tudo que chega, porque não tem alto-falante nenhum pra alimentar.
 *
 * `listener` é o padrão de propósito — o `index.html` atual não manda o campo
 * `role`, e um cliente antigo que só escuta é exatamente um listener. Assim a
 * compatibilidade não custa um ramo de código, ela é o caso base.
 */
const VOIP_ROLES = ['listener', 'sender'];
const DEFAULT_VOIP_ROLE = 'listener';

/**
 * Clientes conectados: actorId -> entrada do ator.
 *
 *   { listener: conexão|null, sender: conexão|null }
 *
 * Cada conexão é `{ ws, actorId, role, oversizedFrameLogged }`.
 *
 * Era `Map<actorId, conexão>` — uma conexão por ator — e isso impedia um jogador
 * de falar e ouvir ao mesmo tempo: helper e UI autenticam com o MESMO actorId, e
 * quem chegasse por último derrubava o outro. Enquanto a captura morava no
 * navegador as duas coisas saíam pelo mesmo socket e o índice estava certo; ela
 * saiu (a CEF bloqueia `getUserMedia`), e o índice ficou errado.
 *
 * O que é por CONEXÃO e o que é por ATOR:
 *
 * - Por conexão: o socket e o log de frame grande (é o socket que se comporta mal).
 * - Por ator: `voiceMode`, `muted` e PTT — que desde 14/08/2026 **não moram
 *   mais aqui**. Foram para `core/voice/voice-state.js`, indexados por
 *   `actorId` e sem campo de socket nenhum, para que "mute por conexão" deixe
 *   de ser representável. Este mapa ficou sendo só a lista de sockets abertos.
 *
 * A lição que motivou a separação continua valendo e está registrada lá: mutar
 * pela UI com o estado na conexão deixava o helper transmitindo — a pessoa se
 * via mutada e continuava sendo ouvida.
 *
 * Ver `docs/technical/VOICE_NATIVE_HELPER.md` §10.
 */
const voipClients = new Map();

/**
 * Tickets pendentes emitidos por /voz: `${actorId}:${role}` -> { token, expiresAt }
 *
 * A chave leva o papel porque o ticket é de uso único e `issueTicket` sobrescrevia
 * o pendente do ator: com uma chave só, o `/voz` que serve a UI queima o ticket que
 * o helper usaria, e os dois papéis nunca conseguem estar autenticados juntos.
 * Um ticket por papel é o mínimo pra que a conexão dupla seja alcançável na prática
 * — sem isso a mudança em `voipClients` acima seria correta e inútil.
 */
const _pendingTickets = new Map();
const TICKET_TTL_MS = 30 * 1000;

function _ticketKey(actorId, role) {
  return `${actorId}:${role}`;
}

// O Voice Core. Este arquivo não calcula proximidade, não guarda `voiceMode`
// nem `muted` e não conhece raio nenhum — ele pergunta.
//
// A instância é única e criada no load porque o serviço de voz também é único;
// `startVoipServer` liga o laço e `stopVoipServer` o desliga.
const { createVoiceCore } = require('./core/voice/voice-core');
const { createVoiceTelemetry } = require('./core/voice/voice-telemetry');
const { createVoiceDiagnostics } = require('./core/voice/voice-diagnostics');
const { volumeAt } = require('./core/voice/voice-policy');

const voiceCore = createVoiceCore();

/**
 * Formato do áudio no fio (Fase 1): PCM cru, 16-bit little-endian, mono, 48kHz,
 * quadros de 20ms (960 amostras = 1920 bytes → 2560 chars em base64).
 *
 * O servidor não decodifica nem transcodifica nada — ele é um relay burro que
 * anexa o volume e repassa os bytes. Estas constantes existem só pra derivar o
 * teto de tamanho abaixo e pra que helper, servidor e UI citem a mesma fonte.
 * Ver `docs/technical/VOICE_NATIVE_HELPER.md` §2 pro porquê de PCM antes de Opus.
 */
const AUDIO_SAMPLE_RATE = 48000;
const AUDIO_CHANNELS = 1;
const AUDIO_FRAME_MS = 20;

// PCM a 48 kHz gera 50 frames de 20 ms por segundo. O bucket deixa uma pequena
// folga para jitter do helper, mas impede que um sender autenticado transforme
// o relay em multiplicador de banda mandando centenas de frames por segundo.
const AUDIO_FRAME_RATE_PER_SECOND = 60;
const AUDIO_FRAME_BURST = 12;

/**
 * Teto do payload base64 de um `audio_frame`, em caracteres.
 *
 * Um `audio_frame` é o único ponto onde um cliente autenticado faz o servidor
 * escrever dados controlados por ele nos sockets de *outros* jogadores. Sem
 * teto, um helper com bug (ou um cliente hostil que passou pelo ticket) manda um
 * frame de megabytes e o servidor o multiplica por todo mundo em alcance —
 * amplificação, e a memória que estoura é a do servidor, não a de quem mandou.
 *
 * 8192 dá folga de 3x sobre o quadro nominal de 20ms: quadros de até 60ms passam
 * (o helper pode agrupar sob carga), qualquer coisa acima disso é bug ou abuso.
 */
const MAX_AUDIO_FRAME_B64 = 8192;
// A mensagem de audio cabe com folga e SDP/ICE continuam tendo espaco. Este
// teto e aplicado pelo ws antes de transformar bytes de rede em string/JSON.
const MAX_VOIP_MESSAGE_BYTES = 32 * 1024;

let wss = null;
let _unsubscribeRoutes = null;
let _unsubscribeSpeaking = null;

/**
 * Atores em **microfone aberto** — os que autenticaram sem declarar
 * `ptt: true`, e por isso recebem uma concessão permanente de transmissão.
 *
 * Não é só um registro de aviso: é o estado que diz que a concessão precisa ser
 * **restabelecida**. Mutar limpa `transmitting` de propósito (para que um mute
 * durante a fala não deixe o PTT engatilhado), e num cliente com PTT quem o
 * traz de volta é a tecla. Um cliente legado não tem tecla — sem este conjunto,
 * o primeiro mute o silenciaria para sempre, e desmutar não devolveria a voz.
 *
 * @type {Set<number>}
 */
const _openMicActors = new Set();

/**
 * Devolve a concessão permanente a um ator em microfone aberto.
 * Sem efeito para quem fala o protocolo de PTT — lá quem concede é a tecla.
 * @param {number} actorId
 */
function _restoreOpenMic(actorId) {
  if (!_openMicActors.has(actorId)) return;
  voiceCore.policy.pttDown(actorId);
}

/**
 * Emite um ticket de uso único para um actorId se autenticar num papel.
 * Chamado pelo comando /voz — nunca client-initiated.
 * @param {number} actorId
 * @param {string} [role] 'listener' (padrão) ou 'sender'
 * @returns {string} token
 */
function issueTicket(actorId, role = DEFAULT_VOIP_ROLE) {
  const token = crypto.randomBytes(16).toString('hex');
  _pendingTickets.set(_ticketKey(actorId, role), { token, expiresAt: Date.now() + TICKET_TTL_MS });
  return token;
}

function _consumeTicket(actorId, token, role = DEFAULT_VOIP_ROLE) {
  const key = _ticketKey(actorId, role);
  const pending = _pendingTickets.get(key);
  if (!pending) return false;
  _pendingTickets.delete(key); // uso único, válido ou não
  if (pending.expiresAt < Date.now()) return false;
  if (pending.token !== token) return false;
  return true;
}

/** Entrada do ator, criada sob demanda no primeiro `auth` daquele actorId. */
function _entryFor(actorId) {
  let entry = voipClients.get(actorId);
  if (!entry) {
    entry = { listener: null, sender: null };
    voipClients.set(actorId, entry);
  }
  return entry;
}

/** A conexão `listener` de um ator, se estiver aberta. É quem recebe qualquer coisa. */
function _openListener(actorId) {
  const entry = voipClients.get(actorId);
  const conn = entry && entry.listener;
  return conn && conn.ws.readyState === WebSocket.OPEN ? conn : null;
}

/** True se o ator tem ao menos uma conexão aberta, em qualquer papel. */
function _hasOpenConnection(entry) {
  return VOIP_ROLES.some((role) => entry[role] && entry[role].ws.readyState === WebSocket.OPEN);
}

/** Confirma que a mensagem vem do socket autenticado que ainda ocupa o papel. */
function _isCurrentClientSocket(actorId, role, socket) {
  const entry = voipClients.get(actorId);
  return Boolean(entry && role && entry[role] && entry[role].ws === socket);
}

/**
 * Consome um frame do bucket de uma conexao. Retorna false sem enviar nada
 * quando a cadencia excede o que o formato de audio permite reproduzir.
 */
function _consumeAudioFrameQuota(conn, now = Date.now()) {
  const elapsedMs = Math.max(0, now - conn.audioLastRefillAt);
  const replenished = (elapsedMs * AUDIO_FRAME_RATE_PER_SECOND) / 1000;
  conn.audioTokens = Math.min(AUDIO_FRAME_BURST, conn.audioTokens + replenished);
  conn.audioLastRefillAt = now;

  if (conn.audioTokens < 1) return false;
  conn.audioTokens -= 1;
  return true;
}

function startVoipServer(port = VOIP_PORT, host = VOIP_BIND_HOST) {
  if (wss) return;

  wss = new WebSocketServer({
    port, host, maxPayload: MAX_VOIP_MESSAGE_BYTES,
    // Allowlist de origem, quando configurada. É defesa em profundidade e não
    // substitui o ticket: quem escolhe o header escolhe omiti-lo, e por isso
    // ausência de `Origin` é ACEITA — o `voice-helper.exe` não é um navegador e
    // não manda um. O que isto barra de verdade é o caso do navegador, onde o
    // header é obrigatório e a página não consegue removê-lo.
    verifyClient: (info) => {
      const origin = info.origin || (info.req && info.req.headers && info.req.headers.origin);
      const verdict = voiceSecurity.checkOrigin(origin);
      if (!verdict.allowed) {
        console.warn(`[voip] Handshake recusado — ${verdict.reason}`);
      }
      return verdict.allowed;
    }
  });

  wss.on('listening', () => {
    console.log(`[voip] WebSocket signaling server listening on ws://${host}:${port}`);
  });

  wss.on('connection', (ws) => {
    let clientActorId = null;
    let clientRole = null;

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      switch (msg.type) {
        case 'auth': {
          // Cliente se registra com seu actorId — exige ticket válido emitido por /voz.
          //
          // `role` ausente = 'listener'. O `index.html` não manda o campo e não
          // precisa passar a mandar: quem só escuta É um listener.
          const claimedActorId = parseInt(msg.actorId);
          const claimedRole = msg.role === undefined ? DEFAULT_VOIP_ROLE : msg.role;
          if (!VOIP_ROLES.includes(claimedRole)) {
            console.log(`[voip] Auth rejeitada (role desconhecido: ${msg.role}) para actorId ${msg.actorId}.`);
            // Contado para `voice_auth_failures`. Autenticação falha em quatro
            // lugares diferentes (aqui, identidade desconhecida, identidade que
            // não sobrevive à leitura, emissão de token) e a operação precisa de
            // UM número — ver `voice-telemetry.js`.
            voiceCore.metrics.count('legacy.authRejected');
            ws.send(JSON.stringify({ type: 'auth_failed' }));
            ws.close();
            return;
          }
          if (!Number.isFinite(claimedActorId) || !_consumeTicket(claimedActorId, msg.ticket, claimedRole)) {
            console.log(`[voip] Auth rejeitada (ticket inválido/expirado) para actorId ${msg.actorId} como ${claimedRole}.`);
            // Contado para `voice_auth_failures`. Autenticação falha em quatro
            // lugares diferentes (aqui, identidade desconhecida, identidade que
            // não sobrevive à leitura, emissão de token) e a operação precisa de
            // UM número — ver `voice-telemetry.js`.
            voiceCore.metrics.count('legacy.authRejected');
            ws.send(JSON.stringify({ type: 'auth_failed' }));
            ws.close();
            return;
          }

          clientActorId = claimedActorId;
          clientRole = claimedRole;

          const entry = _entryFor(clientActorId);
          // Reconexão no MESMO papel substitui a anterior; o papel oposto não é
          // tocado. Fechar a antiga aqui dispara o handler de `close` dela, que
          // por isso confere a identidade do socket antes de limpar o slot —
          // sem essa checagem o close atrasado da conexão velha apagaria a nova.
          const previous = entry[clientRole];
          if (previous && previous.ws !== ws) {
            try { previous.ws.close(); } catch { /* já morto */ }
          }
          entry[clientRole] = {
            ws,
            actorId: clientActorId,
            role: clientRole,
            oversizedFrameLogged: false,
            audioRateLimitLogged: false,
            audioTokens: AUDIO_FRAME_BURST,
            audioLastRefillAt: Date.now()
          };

          // O ator entra na cena de voz do Voice Core. `transport: 'legacy'`
          // porque quem transporta aqui é este WebSocket, não o LiveKit — ver
          // `voice-core.attach`.
          // `getActiveCharacterData` devolve `{characterId, firstName, ...}` —
          // não `{id}`. Um `character.id` aqui vira `undefined`, o ator entra
          // sem personagem, `canSpeak` recusa por "personagem não carregado", e
          // o sintoma é voz que simplesmente não sai.
          const character = commands.getActiveCharacterData(clientActorId);
          voiceCore.attach(clientActorId, {
            characterId: character ? character.characterId : null,
            transport: 'legacy'
          });

          // ── Negociação de PTT ──────────────────────────────────────────
          //
          // PTT é o padrão do servidor, e o Voice Core recusa transmitir de
          // quem não apertou. O `voice-helper.exe` que já existe e já capturou
          // áudio real **não fala esse protocolo**: ele autentica e começa a
          // mandar quadros.
          //
          // Exigir PTT dele agora silenciaria o único caminho de captura
          // provado que este projeto tem, para fechar um furo que este caminho
          // sempre teve. Então o handshake NEGOCIA: um cliente que declara
          // `ptt: true` é governado pelo PTT; um que não declara recebe uma
          // concessão permanente e um aviso nomeando o que está aberto.
          //
          // Isto é dívida registrada, não desenho: some quando o helper
          // aprender `ptt_down`/`ptt_up`. O caminho LiveKit não tem esta
          // concessão — lá o PTT vale sem exceção.
          const clientSpeaksPtt = msg.ptt === true;
          if (!clientSpeaksPtt) {
            if (!_openMicActors.has(clientActorId)) {
              _openMicActors.add(clientActorId);
              console.warn(
                `[voip] Actor 0x${clientActorId.toString(16)} autenticou sem declarar 'ptt: true'. ` +
                `Microfone aberto por compatibilidade com o voice-helper legado.`
              );
            }
            _restoreOpenMic(clientActorId);
          }

          console.log(
            `[voip] Actor 0x${clientActorId.toString(16)} connected to VOIP as ${clientRole}` +
            `${clientSpeaksPtt ? ' (PTT)' : ' (microfone aberto — legado)'}.`
          );
          ws.send(JSON.stringify({
            type: 'auth_ok', actorId: clientActorId, role: clientRole, ptt: clientSpeaksPtt,
            // Parâmetros dos efeitos, UMA vez por conexão. Eles vêm do
            // `server-options` e não mudam enquanto o servidor roda; repetir a
            // frequência de corte em cada `proximity_update` seria mandar 50
            // vezes por segundo um número que muda quando alguém edita um JSON.
            effects: voiceCore.effects()
          }));
          break;
        }

        case 'voice_mode': {
          // O cliente PEDE; o servidor decide. Antes esta linha era
          // `entry.voiceMode = msg.mode || 'normal'`, e `msg.mode` é uma string
          // arbitrária vinda do socket — `'radio'` passava, virava alcance
          // `undefined`, e a pessoa ficava inaudível sem que nada avisasse.
          if (clientActorId === null || !_isCurrentClientSocket(clientActorId, clientRole, ws)) break;
          const result = voiceCore.requestVoiceMode(clientActorId, msg.mode);
          if (!result.ok) {
            console.warn(`[voip] Actor 0x${clientActorId.toString(16)}: ${result.reason}`);
          }
          ws.send(JSON.stringify({ type: 'voice_mode', mode: result.mode, ok: result.ok }));
          break;
        }

        case 'ptt_down': {
          // PTT DOWN → o servidor valida `canSpeak` → permite a transmissão.
          // A recusa volta com motivo para que a UI possa dizer "você está
          // mutado" em vez de mostrar um microfone que parece aberto.
          if (clientActorId === null || !_isCurrentClientSocket(clientActorId, clientRole, ws)) break;
          const result = voiceCore.pttDown(clientActorId);
          ws.send(JSON.stringify({ type: 'ptt', transmitting: result.ok, reason: result.reason }));
          break;
        }

        case 'ptt_up': {
          // PTT UP → interrompe. Nunca falha: soltar a tecla é o lado seguro.
          if (clientActorId === null || !_isCurrentClientSocket(clientActorId, clientRole, ws)) break;
          voiceCore.pttUp(clientActorId);
          ws.send(JSON.stringify({ type: 'ptt', transmitting: false }));
          break;
        }

        case 'offer':
        case 'answer':
        case 'ice':
          // Repassa sinalizacao WebRTC para o peer alvo — sempre pro `listener`
          // dele. É o navegador que tem `RTCPeerConnection`; o helper ignoraria.
          if (clientActorId !== null && _isCurrentClientSocket(clientActorId, clientRole, ws) && msg.targetActorId) {
            const target = _openListener(parseInt(msg.targetActorId));
            if (target) {
              target.ws.send(JSON.stringify({
                ...msg,
                fromActorId: clientActorId
              }));
            }
          }
          break;

        case 'audio_frame': {
          // Caminho novo: o helper nativo manda PCM capturado fora do CEF e o
          // servidor retransmite pra quem está em alcance. Só para autenticados
          // — sem isso, uma conexão anônima injetaria áudio na cena de todo
          // mundo, que é o mesmo furo que o ticket fechou no `auth`.
          // Aceito de qualquer papel, não só do `sender`. Os dois sockets
          // provaram a mesma identidade pelo mesmo handshake, então exigir papel
          // aqui não fecharia furo nenhum — só quebraria a sonda em Node e quem
          // ainda autentica sem `role`. O relay usa a identidade autenticada.
          if (clientActorId === null || !_isCurrentClientSocket(clientActorId, clientRole, ws)) break;
          if (typeof msg.data !== 'string') break;
          const entry = voipClients.get(clientActorId);
          const conn = entry && clientRole ? entry[clientRole] : null;
          if (!conn || !_consumeAudioFrameQuota(conn)) {
            if (conn && conn.ws === ws && !conn.audioRateLimitLogged) {
              conn.audioRateLimitLogged = true;
              console.warn(`[voip] Actor 0x${clientActorId.toString(16)} excedeu o limite de audio_frame; descartando.`);
            }
            break;
          }
          if (msg.data.length > MAX_AUDIO_FRAME_B64) {
            // Loga uma vez por conexão: o descarte é barato, o log em 50Hz não.
            if (conn && conn.ws === ws && !conn.oversizedFrameLogged) {
              conn.oversizedFrameLogged = true;
              console.warn(
                `[voip] Actor 0x${clientActorId.toString(16)} mandou audio_frame de ` +
                `${msg.data.length} chars (teto ${MAX_AUDIO_FRAME_B64}); descartando.`
              );
            }
            break;
          }
          relayAudioFrame(clientActorId, msg);
          break;
        }

        case 'mute':
          // Mute é do ator, não da conexão: silencia a pessoa na cena, venha a
          // voz pelo helper ou pelo caminho antigo. Por conexão, mutar pela UI
          // deixaria o helper transmitindo — mutado na tela e audível na cena.
          // O estado mora no `voice-state`, que indexa por ator e não tem onde
          // guardar um socket.
          if (clientActorId !== null && _isCurrentClientSocket(clientActorId, clientRole, ws)) {
            voiceCore.requestMute(clientActorId, msg.muted === true);
            // Desmutar devolve a concessão de microfone aberto ao cliente
            // legado. Ver `_restoreOpenMic`.
            if (msg.muted !== true) _restoreOpenMic(clientActorId);
            console.log(`[voip] Actor 0x${clientActorId.toString(16)} mute=${msg.muted}`);
          }
          break;
      }
    });

    ws.on('close', () => {
      if (clientActorId === null || clientRole === null) return;
      const entry = voipClients.get(clientActorId);
      if (!entry) return;

      // Só limpa o slot se ele ainda for DESTE socket. Uma reconexão no mesmo
      // papel fecha a conexão antiga, e o close dela chega depois de a nova já
      // estar registrada — sem esta checagem, o adeus da velha derrubaria a nova.
      if (entry[clientRole] && entry[clientRole].ws !== ws) return;
      entry[clientRole] = null;

      // `peer_left` só quando sai o `listener`. Sair o `sender` significa que a
      // pessoa fechou o helper: ela para de falar, mas continua na cena de voz e
      // continua ouvindo pela UI. Anunciar saída aí faria os outros derrubarem o
      // caminho de áudio de alguém que ainda está lá, ouvindo.
      if (clientRole === 'listener') {
        broadcast({ type: 'peer_left', actorId: clientActorId }, clientActorId);
      }

      // A entrada só some quando os dois papéis se foram — enquanto sobrar um,
      // o ator segue na cena, com seu `muted`/`voiceMode` preservados no
      // `voice-state`. Quando o último papel cai, ele sai da cena de voz por
      // completo: `detach` limpa estado, rotas, amostra e sessão de uma vez.
      if (!entry.listener && !entry.sender) {
        voipClients.delete(clientActorId);
        _openMicActors.delete(clientActorId);
        voiceCore.detach(clientActorId, 'disconnect');
      }

      console.log(`[voip] Actor 0x${clientActorId.toString(16)} disconnected from VOIP (${clientRole}).`);
    });

    ws.on('error', (err) => {
      console.error('[voip] WebSocket error:', err.message);
    });
  });

  // O laço de proximidade agora é do Voice Core (tick espacial de ~150 ms, com
  // recompute imediato para mudanças críticas). O `setInterval` de 2 s que
  // morava aqui existia porque o cálculo era O(n²); ele não é mais.
  //
  // Entregar o `proximity_update` continua sendo deste arquivo: é ele que tem
  // os sockets. O Voice Core avisa; o transporte entrega.
  _unsubscribeRoutes = voiceCore.onRoutes((routesByListener) => {
    for (const actorId of voipClients.keys()) {
      const listener = _openListener(actorId);
      if (!listener) continue;
      // `peersFor` é a fonte única do formato: ele já compõe volume, efeito,
      // direção e estado de fala. Remontar a lista aqui a partir do mapa cru
      // faria este arquivo ter uma segunda opinião sobre o payload, e ela
      // envelheceria calada — foi assim que `character.id` virou `undefined`.
      listener.ws.send(JSON.stringify({ type: 'proximity_update', peers: voiceCore.peersFor(actorId) }));
    }
  });

  // Estado de fala → quem está em alcance. É o que permite ao cliente animar a
  // boca de outra pessoa e acender o HUD dela sem esperar o próximo
  // `proximity_update` — a transição de fala é o evento mais rápido do sistema,
  // e amarrá-la ao tick de 150 ms produziria bocas atrasadas em relação ao som.
  //
  // Vai só para quem JÁ ouve o locutor: quem não recebe a voz dele não tem o
  // que animar, e mandar assim mesmo seria contar a todo mundo, o tempo todo,
  // quem está falando onde.
  _unsubscribeSpeaking = voiceCore.speaking.onChange((actorId, isSpeaking) => {
    const audience = voiceCore.audienceFor(actorId);
    const raw = JSON.stringify({ type: 'voice_speaking', actorId, speaking: isSpeaking });
    // Ao PARAR, a audiência já pode estar vazia (foi o que causou a parada).
    // Nesse caso o aviso vai para quem estava ouvindo no último recompute, que
    // é a informação mais recente que existe — sem isso, soltar o PTT deixaria
    // a boca aberta em quem acabou de sair de alcance.
    const targets = audience.length > 0 ? audience : voiceCore.lastAudienceFor(actorId);
    for (const listener of targets) {
      const client = _openListener(listener.actorId);
      if (client) client.ws.send(raw);
    }
  });

  voiceCore.start();

  console.log('[voip] VOIP service initialized.');
}

/**
 * Recalcula quem ouve quem. **Uma linha, e é essa a notícia.**
 *
 * Era um laço aninhado sobre todos os atores — 9.900 pares com 100 jogadores,
 * 39.800 com 200 — rodando a cada 2 s justamente porque ninguém queria pagar
 * aquilo com mais frequência. Hoje quem calcula é o `VoiceRouteEngine` sobre o
 * `VoiceSpatialIndex`, o tick é de 150 ms, e o número está medido em
 * `scripts/bench-voice-proximity.js` em vez de afirmado aqui.
 *
 * Continua exportado com este nome porque é a superfície que os testes e o
 * resto do projeto já chamam para forçar um tick determinístico.
 */
function tickProximity() {
  voiceCore.recompute('tick');
}

/**
 * Volume por distância. Reexportado de `core/voice/voice-policy.js`, que é
 * quem tem a conta agora — e a tem em UM lugar, compartilhada com o motor de
 * rotas. Manter o nome evita quebrar quem já importava daqui.
 */
const calcVolume = volumeAt;

/**
 * Retransmite um `audio_frame` para quem está em alcance do locutor, anexando o
 * volume que aquele ouvinte específico deve aplicar.
 *
 * O servidor não olha dentro de `data` — não decodifica, não mistura, não
 * transcodifica. Mixagem no servidor economizaria banda de descida, mas exigiria
 * decodificar e somar N fluxos por ouvinte a cada 20ms; para uma prova de
 * conceito isso é trocar um problema provado por um não provado. Ver
 * `docs/technical/VOICE_NATIVE_HELPER.md` §5.
 *
 * @param {number} fromActorId locutor já autenticado
 * @param {object} msg mensagem recebida (usa-se apenas `seq` e `data`)
 * @returns {number} quantos ouvintes receberam — usado por teste e log
 */
function relayAudioFrame(fromActorId, msg) {
  // `audienceFor` consulta a política antes de devolver a tabela: entre um
  // recompute e este quadro o PTT pode ter sido solto ou o mute ligado, e a
  // audiência tem até um tick de idade. É aqui que "não usar só mute local
  // como segurança" deixa de ser uma frase e vira um `return 0`.
  const audience = voiceCore.audienceFor(fromActorId);
  if (!audience || audience.length === 0) return 0;

  // O quadro chegou e a política deixou passar: este ator ESTÁ falando. É o
  // único sinal honesto disso que o servidor tem — o PTT diz que ele pode, não
  // que ele está. `noteAudioFrame` reconsulta `canSpeak` e devolve `false` se
  // a resposta mudou desde o recompute, e nesse caso o quadro não é
  // retransmitido: mesma pergunta, mesma resposta, um lugar só.
  if (!voiceCore.noteAudioFrame(fromActorId)) return 0;

  let delivered = 0;
  for (const listener of audience) {
    // Sempre a conexão `listener` do ouvinte, nunca um `sender` dele: o helper
    // do outro não toca nada, e mandar áudio pra lá seria gastar banda pra que
    // um processo o descarte. A audiência já exclui o próprio locutor (o tick
    // pula `peer.actorId === client.actorId`), então o `listener` de quem fala
    // não recebe a própria voz de volta — isso seria eco, não voz.
    const client = _openListener(listener.actorId);
    if (!client) continue;

    // Serializado por ouvinte porque o `volume` muda por ouvinte. Custa uma
    // cópia do payload por destinatário; com PCM cru isso é ~2,5KB cada. Está
    // registrado como item da Fase 2 (com Opus o payload cai ~30x, e aí o
    // desperdício deixa de importar).
    client.ws.send(JSON.stringify({
      type: 'audio_frame',
      fromActorId,
      volume: listener.volume,
      // O efeito viaja com o quadro, e não só no `proximity_update`, porque
      // uma mordaça aplicada entre dois ticks precisa valer no quadro
      // seguinte — não no próximo tick. É um campo curto; o payload é PCM
      // ou Opus, dependendo de `codec`.
      effect: listener.effect,
      seq: msg.seq,
      // Repassado sem olhar dentro: o servidor não decodifica (§ acima), só
      // encaminha o que o locutor declarou. Ausente = PCM cru, o formato de
      // quem ainda não fala Opus (`voice-helper` antigo já em campo, ou a
      // sonda de teste) — `decodeRelayFrame` do lado do ouvinte decide por
      // isso, não pela versão de ninguém.
      codec: msg.codec,
      data: msg.data
    }));
    delivered++;
  }
  return delivered;
}

/**
 * Envia para o `listener` de todo mundo, menos o excluído.
 *
 * Só listeners: o que passa por aqui hoje é `peer_left`, que existe pra UI
 * desmontar o áudio de quem saiu. O helper não tem o que desmontar.
 */
function broadcast(msg, excludeActorId) {
  const raw = JSON.stringify(msg);
  for (const actorId of voipClients.keys()) {
    if (actorId === excludeActorId) continue;
    const listener = _openListener(actorId);
    if (listener) listener.ws.send(raw);
  }
}

/**
 * Retorna todos os atores conectados ao VOIP (para debug).
 */
function getConnectedVoipActors() {
  return [...voipClients.keys()];
}

/**
 * Porta em que o servidor está realmente escutando — útil em testes que
 * sobem o servidor em port:0 (porta efêmera escolhida pelo SO).
 * @returns {number|null}
 */
function getListeningPort() {
  if (!wss) return null;
  const addr = wss.address(); // null até o bind assíncrono terminar (evento 'listening')
  return addr ? addr.port : null;
}

/**
 * Encerra o servidor de sinalização (usado por testes; não há caminho de
 * shutdown em produção hoje, o módulo não declara shutdown no module-registry).
 */
function stopVoipServer() {
  if (_unsubscribeRoutes) _unsubscribeRoutes();
  _unsubscribeRoutes = null;
  if (_unsubscribeSpeaking) _unsubscribeSpeaking();
  _unsubscribeSpeaking = null;
  voiceCore.shutdown('stopVoipServer');
  _openMicActors.clear();
  if (!wss) return;
  wss.close();
  wss = null;
}

/**
 * Comando /voz: opt-in explícito — voz por proximidade não é forçada em todo
 * mundo (ver SKYMP_RP_DEVELOPMENT_PLAN.md, "Se voice chat é obrigatório" segue
 * uma decisão em aberto). Emite um ticket e empurra pro cliente via a property
 * SkyMP voipTicket (mesmo padrão comprovado de browserModal/panelData).
 */
function requestVoiceConnection(actorId) {
  const character = commands.getActiveCharacterData(actorId);
  if (!character) {
    commands.sendNotification(actorId, 'Seu personagem ainda nao esta carregado.');
    return;
  }

  // Dois tickets, um por papel. O da UI vai pela property, como sempre; o do
  // helper é emitido sempre, esteja ou não exposto — emitir é barato (expira em
  // 30s sem uso) e assim a EXPOSIÇÃO, que é a parte arriscada, fica sendo a
  // única coisa atrás da flag. Um ticket só não serviria: é de uso único, e
  // quem chegasse primeiro queimaria o do outro.
  const ticket = issueTicket(actorId, 'listener');
  const senderTicket = issueTicket(actorId, 'sender');

  _exposeDebugTicket(actorId, senderTicket);

  if (typeof mp === 'undefined') return;
  try {
    const payload = {
      actorId,
      ticket,
      host: VOIP_PUBLIC_HOST,
      port: VOIP_PORT,
      sentAt: Date.now()
    };

    // Última conferência antes de o objeto sair do processo. Não protege contra
    // este payload — ele é conhecido, curto e obviamente limpo. Protege contra a
    // versão dele daqui a seis meses, quando alguém precisar mandar "a
    // configuração do LiveKit" ao cliente e espalhar um objeto de config aqui
    // dentro. É o ponto exato onde um `...config` transforma "manda o token" em
    // "manda o secret", e o custo de conferir é uma varredura de string por
    // `/voz`, que é um comando humano.
    const leak = voiceSecurity.assertNoSecretsIn(payload);
    if (!leak.clean) {
      console.error(
        `[voip] BLOQUEADO: o payload de voz carregava ${leak.leaked.join(', ')}. ` +
        'Nada foi enviado ao cliente.'
      );
      return;
    }

    mp.set(actorId, 'voipTicket', payload);
  } catch (err) {
    console.error('[voip] Falha ao enviar ticket de voz:', err.message);
  }
}

/**
 * ⚠️ ANDAIME DE TESTE — TEMPORÁRIO. Remover junto com a Fase 3.
 *
 * Escreve o ticket do `sender` num arquivo local e loga em `warn`, pra que uma
 * pessoa testando consiga copiá-lo pro `--ticket` do `voice-helper.exe`. Hoje o
 * ticket só existe dentro da property `voipTicket`, que é lida pelo navegador do
 * jogo — não há como um humano vê-lo.
 *
 * Por que atrás de flag, desligada por padrão: isto grava em disco, em texto
 * puro, uma credencial que autentica como aquele jogador na cena de voz. Vale 30
 * segundos, o que limita o estrago, e ainda assim quem ler o arquivo dentro da
 * janela fala pela boca da pessoa. É aceitável numa bancada com um engenheiro
 * olhando, e em nenhum outro lugar.
 *
 * A Fase 3 (handoff automático, jogo → helper, sem intervenção manual) substitui
 * isto por completo, e esta função e a flag devem sumir junto.
 * Ver `docs/technical/VOICE_NATIVE_HELPER.md` §11.
 */
function _exposeDebugTicket(actorId, senderTicket) {
  if (!_debugExposeTicketEnabled()) return;

  const payload = {
    actorId,
    actorIdHex: `0x${actorId.toString(16).toUpperCase()}`,
    ticket: senderTicket,
    role: 'sender',
    host: VOIP_PUBLIC_HOST,
    port: VOIP_PORT,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + TICKET_TTL_MS).toISOString(),
    ttlSeconds: TICKET_TTL_MS / 1000,
    aviso: 'ANDAIME DE TESTE. Desligue VOIP_DEBUG_EXPOSE_TICKET depois do teste.'
  };

  console.warn(
    `[voip] ⚠️  VOIP_DEBUG_EXPOSE_TICKET ligado — ticket de 'sender' exposto em texto puro.\n` +
    `[voip]     voice-helper.exe --actor-id ${payload.actorIdHex} --ticket ${senderTicket} ` +
    `--host ${VOIP_PUBLIC_HOST} --port ${VOIP_PORT}\n` +
    `[voip]     Vale ${payload.ttlSeconds}s. Desligue a flag depois do teste.`
  );

  // O arquivo é conveniência; falhar em escrevê-lo não pode derrubar o /voz —
  // o log acima já entregou o ticket.
  try {
    fs.writeFileSync(VOIP_DEBUG_TICKET_FILE, JSON.stringify(payload, null, 2));
  } catch (err) {
    console.warn(`[voip] Não consegui escrever ${VOIP_DEBUG_TICKET_FILE}: ${err.message}`);
  }
}

/**
 * Telemetria e diagnóstico deste Voice Core.
 *
 * Ficam aqui porque este arquivo é o dono da instância do Voice Core. Criá-los
 * em outro lugar exigiria exportar o core, e um core exportado é um core que
 * alguém instancia duas vezes — dois laços de proximidade decidindo rotas para
 * as mesmas pessoas.
 */
const voiceTelemetry = createVoiceTelemetry({ core: voiceCore });
const voiceDiagnostics = createVoiceDiagnostics({ core: voiceCore, telemetry: voiceTelemetry });

/**
 * Liga o diagnóstico ao `admin-service`.
 *
 * A direção da injeção é o ponto: o `admin-service` NÃO importa o Voice Core.
 * Ele recebe uma interface de leitura e três ações, e continua sem saber que o
 * sistema de voz existe. É a mesma disciplina que `voice-staff-mute` mantém com
 * a instância compartilhada — staff não depende de voz.
 *
 * Chamado no `initialize` do módulo de voz. Num servidor com
 * `ENABLE_VOIP_SERVICE=false` isto nunca roda, e os comandos de voz da staff
 * respondem "o sistema de voz nao esta ativo" — que é a verdade.
 */
function bindAdminDiagnostics() {
  try {
    require('./admin-service').bindVoiceDiagnostics(voiceDiagnostics);
    console.log('[voip] Diagnóstico de voz disponível para a staff (/vozdiag, /vozdesconectar, /vozreconectar).');
  } catch (err) {
    // Um admin-service ausente não pode impedir a voz de subir.
    console.warn(`[voip] Não consegui ligar o diagnóstico ao admin-service: ${err.message}`);
  }
}

function commandDefs() {
  return [
    {
      name: ['/voz', '/voice'],
      description: 'Conecta ao chat de voz por proximidade (opt-in)',
      usage: '/voz',
      handler: (actorId) => requestVoiceConnection(actorId)
    }
  ];
}

module.exports = {
  commandDefs,
  bindAdminDiagnostics,
  voiceTelemetry,
  voiceDiagnostics,
  startVoipServer,
  stopVoipServer,
  getConnectedVoipActors,
  getListeningPort,
  issueTicket,
  requestVoiceConnection,
  // Formato do áudio no fio — o helper nativo e a UI precisam concordar com isto.
  AUDIO_SAMPLE_RATE,
  AUDIO_CHANNELS,
  AUDIO_FRAME_MS,
  MAX_AUDIO_FRAME_B64,
  AUDIO_FRAME_RATE_PER_SECOND,
  AUDIO_FRAME_BURST,
  MAX_VOIP_MESSAGE_BYTES,
  // `tickProximity` é chamado pelo laço do Voice Core em produção; exposto
  // porque o teste do relay precisa de um tick determinístico em vez de
  // esperar o timer.
  tickProximity,
  calcVolume,
  // O Voice Core, para quem precisa da camada de baixo (diagnóstico, teste, e
  // o dia em que o backend LiveKit assumir o transporte).
  voiceCore,
  // Papéis de conexão — o helper manda 'sender', a UI não manda nada e vira
  // 'listener'. Ver `voipClients` e VOICE_NATIVE_HELPER.md §10.
  VOIP_ROLES,
  DEFAULT_VOIP_ROLE,
  // Exposto só pra testes
  _consumeTicket,
  _pendingTickets,
  _ticketKey,
  _consumeAudioFrameQuota,
  _isCurrentClientSocket,
  _voipClients: voipClients,
  _openMicActors,
  _debugExposeTicketEnabled,
  VOIP_DEBUG_TICKET_FILE
};
