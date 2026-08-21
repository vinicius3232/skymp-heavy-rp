/**
 * core/voice/voice-security.js
 *
 * As regras de segurança da voz que só um ambiente pode violar — e que por isso
 * nenhum teste unitário de módulo pegaria.
 *
 * ## Por que isto é código e não uma seção de documento
 *
 * As decisões de segurança do SkyVoice já estavam certas nos módulos: o secret
 * não sai do processo (`livekit-token`), a identidade é derivada no servidor
 * (`voice-session`), o token nega `roomAdmin` e vídeo. Nada disso protege contra
 * a classe de erro que de fato acontece em produção, que é **a configuração**:
 *
 * - subir com `VOIP_DEBUG_EXPOSE_TICKET=true` esquecido de uma bancada;
 * - apontar `LIVEKIT_URL` para `ws://` em vez de `wss://`, e mandar o access
 *   token em texto puro pela internet;
 * - trocar `VOIP_BIND_HOST` para `0.0.0.0` e expor um WebSocket sem TLS;
 * - copiar o `.env` do servidor para dentro do que o launcher distribui.
 *
 * Um documento dizendo "não faça isso" já existe e não impede nenhuma delas. Um
 * `audit()` chamado no boot, que **recusa subir** quando o ambiente é
 * indefensável, impede todas.
 *
 * ## A escala, e por que ela tem três níveis e não dois
 *
 * | Nível | O que significa | O que o boot faz |
 * |---|---|---|
 * | `fatal` | O ambiente entrega credencial ou voz a quem não deveria | **aborta** |
 * | `warn` | Perigoso, mas pode ser deliberado numa bancada | segue, com aviso nomeado |
 * | `note` | Informação que a operação precisa ler uma vez | segue |
 *
 * Dois níveis não bastam porque `NODE_ENV` decide o significado da mesma
 * configuração: `ws://127.0.0.1` numa bancada é o certo, e em produção é o
 * access token de todo jogador viajando legível. A mesma linha precisa ser
 * `note` num ambiente e `fatal` no outro, e é `productionLike` que separa.
 *
 * ## O que este módulo NÃO faz
 *
 * Não abre porta, não escreve em disco, não chama rede. É uma função pura sobre
 * `env` — o que a torna testável sem ambiente, que é a única forma de um guarda
 * de ambiente ser confiável.
 *
 * Também **não** grava áudio, não persiste quadro e não registra conteúdo de
 * conversa: ver `PRIVACY` no fim do arquivo, que é uma asserção executável de
 * que nenhum caminho de voz escreve mídia em lugar nenhum.
 */

/** Ambientes tratados como produção para efeito de segurança. */
const PRODUCTION_LIKE = Object.freeze(['production', 'staging']);

/** Severidades, da mais grave para a mais leve. */
const SEVERITY = Object.freeze({ FATAL: 'fatal', WARN: 'warn', NOTE: 'note' });

/**
 * Hosts que significam "escuta em todas as interfaces".
 *
 * `::` e `0.0.0.0` são os óbvios; a string vazia é o caso que passa
 * despercebido, porque `VOIP_BIND_HOST=` num `.env` parece "não configurado" e o
 * `ws` a trata como todas as interfaces.
 */
const WILDCARD_HOSTS = Object.freeze(['0.0.0.0', '::', '*', '']);

/**
 * Nomes de variável cujo valor **nunca** pode sair deste processo.
 *
 * Usada por `assertNoSecretsIn()` para varrer qualquer coisa que vá para o
 * cliente. A lista é de nomes, mas a varredura é por **valor**: procurar a
 * string `LIVEKIT_API_SECRET` num payload não acharia nada — o que vaza é o
 * conteúdo dela.
 */
const SECRET_ENV_NAMES = Object.freeze([
  'LIVEKIT_API_SECRET',
  'SOUL_SECRET',
  'INTERNAL_API_SECRET',
  'DISCORD_CLIENT_SECRET',
  'DB_PASSWORD',
  'SESSION_SECRET'
]);

/**
 * Comprimento mínimo para um valor de segredo ser procurado num payload.
 *
 * Sem piso, um segredo mal configurado como `"1"` faria toda mensagem que
 * contenha o dígito 1 ser acusada de vazamento — e o alarme falso constante é
 * como um detector de vazamento acaba desligado. Segredo curto demais é um
 * problema à parte, e é apontado como achado próprio.
 */
const MIN_SECRET_LENGTH = 8;

/**
 * @typedef {object} SecurityFinding
 * @property {string} id        identificador estável, citável em documento
 * @property {string} severity  um de SEVERITY
 * @property {string} title
 * @property {string} detail    o que está errado, com o valor observado
 * @property {string} fix       o que fazer
 */

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {boolean}
 */
function isProductionLike(env) {
  return PRODUCTION_LIKE.includes(String(env.NODE_ENV || '').toLowerCase());
}

/**
 * Audita o ambiente de voz.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ok: boolean, fatal: SecurityFinding[], findings: SecurityFinding[], production: boolean}}
 */
function audit(env = process.env) {
  /** @type {SecurityFinding[]} */
  const findings = [];
  const production = isProductionLike(env);
  const voiceEnabled = env.ENABLE_VOIP_SERVICE === 'true';
  const backend = (env.VOICE_BACKEND || 'legacy').toLowerCase();

  const add = (severity, id, title, detail, fix) =>
    findings.push({ id, severity, title, detail, fix });

  // ── 1. O andaime de debug ──────────────────────────────────────────────────
  //
  // `VOIP_DEBUG_EXPOSE_TICKET` grava em disco, em texto puro, uma credencial que
  // autentica como aquele jogador. Numa bancada é a única forma prática de
  // alimentar o `voice-helper.exe`; em produção é um arquivo no servidor que
  // permite falar como qualquer um que rodou `/voz` nos últimos 30 s.
  if (env.VOIP_DEBUG_EXPOSE_TICKET === 'true') {
    add(
      production ? SEVERITY.FATAL : SEVERITY.WARN,
      'VOICE-SEC-001',
      'Ticket de voz exposto em texto puro',
      'VOIP_DEBUG_EXPOSE_TICKET=true grava .voip-debug-ticket.json e loga a credencial. ' +
        'Quem lê o arquivo autentica no VOIP como aquele ator.',
      'Desligue a variável. Em produção o handoff é do launcher (LAUNCHER_DISTRIBUTION.md).'
    );
  }

  // ── 2. Transporte do access token ──────────────────────────────────────────
  //
  // O access token do LiveKit é um portador: quem o tem é quem ele diz que é,
  // até expirar. Mandá-lo por `ws://` o entrega a qualquer intermediário do
  // caminho — e o caminho, em produção, é a internet.
  if (backend === 'livekit') {
    const url = String(env.LIVEKIT_URL || '');
    if (url === '') {
      add(
        SEVERITY.FATAL, 'VOICE-SEC-002',
        'VOICE_BACKEND=livekit sem LIVEKIT_URL',
        'O backend escolhido é o LiveKit e não há URL de servidor.',
        'Defina LIVEKIT_URL (wss://...) ou volte VOICE_BACKEND para legacy.'
      );
    } else if (/^ws:/i.test(url)) {
      const loopback = /^ws:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(url);
      add(
        production ? SEVERITY.FATAL : (loopback ? SEVERITY.NOTE : SEVERITY.WARN),
        'VOICE-SEC-003',
        'LiveKit sem TLS',
        `LIVEKIT_URL=${url} usa ws:// — o access token viaja legível, e com ele ` +
          'qualquer pessoa entra na sala como aquele jogador.',
        'Use wss://. Ver docs/technical/SKYVOICE_DEPLOYMENT.md §TLS.'
      );
    }

    if (!env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) {
      add(
        SEVERITY.FATAL, 'VOICE-SEC-004',
        'Credencial do LiveKit incompleta',
        'LIVEKIT_API_KEY ou LIVEKIT_API_SECRET vazio. Um token assinado com secret ' +
          'vazio é aceito por createHmac e recusado pelo servidor lá na frente — o ' +
          'sintoma vira "a voz não conecta", longe da causa.',
        'Preencha as duas, ou volte VOICE_BACKEND para legacy.'
      );
    }
  }

  // ── 3. Força do secret ─────────────────────────────────────────────────────
  const secret = String(env.LIVEKIT_API_SECRET || '');
  if (secret !== '' && secret.length < 32) {
    add(
      production ? SEVERITY.FATAL : SEVERITY.WARN,
      'VOICE-SEC-005',
      'LIVEKIT_API_SECRET curto',
      `${secret.length} caracteres. O secret é a chave HMAC que assina toda ` +
        'identidade da sala; curto o bastante e ele é adivinhável offline a partir ' +
        'de um único token capturado.',
      'Gere 32+ bytes: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }

  // ── 4. Exposição do WebSocket legado ───────────────────────────────────────
  //
  // O `voip-service` é `ws://` puro, sem TLS e sem verificação de Origin. Ligado
  // a 127.0.0.1 isso é inalcançável de fora e está certo. Ligado a `0.0.0.0` é
  // um socket de voz aberto na internet — e o ticket que o protege tem 30 s,
  // mas o áudio que trafega depois não tem nada.
  const bindHost = env.VOIP_BIND_HOST === undefined ? '127.0.0.1' : String(env.VOIP_BIND_HOST);
  if (voiceEnabled && backend === 'legacy' && WILDCARD_HOSTS.includes(bindHost)) {
    add(
      production ? SEVERITY.FATAL : SEVERITY.WARN,
      'VOICE-SEC-006',
      'WebSocket de voz sem TLS exposto em todas as interfaces',
      `VOIP_BIND_HOST=${JSON.stringify(bindHost)} e o relay legado não fala TLS. ` +
        'O áudio e o ticket trafegam em texto puro para qualquer alcance de rede.',
      'Mantenha 127.0.0.1 e ponha um proxy TLS na frente (wss), ou use VOICE_BACKEND=livekit.'
    );
  }

  // ── 5. Origin da CEF ───────────────────────────────────────────────────────
  //
  // Quem pode abrir o WebSocket de voz hoje é qualquer coisa que tenha um
  // ticket. O ticket é forte; a falta de allowlist de origem significa que uma
  // página qualquer carregada na CEF, ou um processo local, pode tentar. É
  // defesa em profundidade, e por isso não é fatal.
  if (voiceEnabled && backend === 'legacy' && !env.VOICE_ALLOWED_ORIGINS) {
    add(
      SEVERITY.NOTE, 'VOICE-SEC-007',
      'Sem allowlist de origem no WebSocket de voz',
      'VOICE_ALLOWED_ORIGINS vazio: o handshake aceita qualquer Origin (inclusive ausente, ' +
        'que é o caso do voice-helper nativo — ele não é um navegador).',
      'Defina VOICE_ALLOWED_ORIGINS para restringir as origens de navegador aceitas.'
    );
  }

  // ── 6. Autowhitelist local ─────────────────────────────────────────────────
  if (production && env.ALLOW_LOCAL_AUTOWHITELIST === 'true') {
    add(
      SEVERITY.FATAL, 'VOICE-SEC-008',
      'Autowhitelist local ligada em produção',
      'ALLOW_LOCAL_AUTOWHITELIST=true admite qualquer conexão sem passar pela whitelist, ' +
        'e com ela vem o acesso à cena de voz.',
      'Desligue.'
    );
  }

  // ── 7. Câmera ──────────────────────────────────────────────────────────────
  //
  // Não há variável que ligue câmera neste projeto, e é isso que o achado
  // registra: se alguém um dia introduzir uma, este guarda a encontra no boot em
  // vez de num incidente.
  for (const name of Object.keys(env)) {
    if (/VIDEO|CAMERA|WEBCAM/i.test(name) && /VOICE|VOIP|LIVEKIT/i.test(name)) {
      add(
        SEVERITY.FATAL, 'VOICE-SEC-009',
        'Variável de vídeo no sistema de voz',
        `${name} existe no ambiente. Este projeto não publica vídeo em hipótese nenhuma: ` +
          'o token concede canPublishSources: ["microphone"] e nada mais.',
        'Remova a variável. Se a intenção era vídeo, ela não tem lugar aqui.'
      );
    }
  }

  const fatal = findings.filter((f) => f.severity === SEVERITY.FATAL);
  return { ok: fatal.length === 0, fatal, findings, production };
}

/**
 * Roda a auditoria no boot e derruba o processo quando o ambiente é indefensável.
 *
 * Derrubar é a decisão certa aqui, e é o oposto da regra "voz falhando não
 * derruba o jogo" — que vale para **runtime**. As duas convivem porque tratam de
 * momentos diferentes: em runtime, um SFU fora do ar não pode tirar o servidor
 * do ar; no boot, um ambiente que vaza credencial não deve chegar a ter runtime.
 * Subir com o aviso no log seria subir: ninguém lê o log de boot de um servidor
 * que subiu.
 *
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {Pick<Console,'log'|'warn'|'error'>} [opts.logger]
 * @param {(code: number) => void} [opts.exit] injetável por teste
 * @returns {ReturnType<typeof audit>}
 */
function enforceAtBoot(opts = {}) {
  const {
    env = process.env,
    logger = console,
    exit = (code) => process.exit(code)
  } = opts;

  const result = audit(env);

  for (const f of result.findings) {
    const line = `[voice-security] ${f.severity.toUpperCase()} ${f.id} — ${f.title}: ${f.detail} → ${f.fix}`;
    if (f.severity === SEVERITY.FATAL) logger.error(line);
    else if (f.severity === SEVERITY.WARN) logger.warn(line);
    else logger.log(line);
  }

  if (!result.ok) {
    logger.error(
      `[voice-security] ${result.fatal.length} achado(s) FATAL. O servidor não sobe com ` +
        'o ambiente de voz neste estado.'
    );
    exit(1);
  }

  return result;
}

/**
 * Varre um payload destinado ao cliente atrás do VALOR de qualquer segredo.
 *
 * Procura por valor e não por nome porque é o valor que vaza. Um `JSON.stringify`
 * de um objeto que por descuido carregue `apiSecret` produz a string do segredo,
 * não a palavra "LIVEKIT_API_SECRET".
 *
 * Usado no caminho que empurra credencial ao cliente (`voip-service.issueTicket`
 * e o handshake de voz) — o ponto onde um erro de refatoração transformaria
 * "manda o token" em "manda a configuração inteira".
 *
 * @param {unknown} payload  o que vai para o cliente
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{clean: boolean, leaked: string[]}}
 */
function assertNoSecretsIn(payload, env = process.env) {
  let serialized;
  try {
    serialized = typeof payload === 'string' ? payload : JSON.stringify(payload);
  } catch {
    // Um payload que não serializa não é um payload que vai para o cliente.
    // Tratar como limpo aqui seria mentir; tratar como vazamento seria alarme
    // falso. Devolver o motivo é o único honesto.
    return { clean: false, leaked: ['<payload não serializável>'] };
  }
  if (typeof serialized !== 'string' || serialized === '') return { clean: true, leaked: [] };

  const leaked = [];
  for (const name of SECRET_ENV_NAMES) {
    const value = env[name];
    if (typeof value !== 'string' || value.length < MIN_SECRET_LENGTH) continue;
    if (serialized.includes(value)) leaked.push(name);
  }
  return { clean: leaked.length === 0, leaked };
}

/**
 * `verifyClient` do WebSocket de voz: allowlist de origem.
 *
 * ## Por que Origin ausente é ACEITA
 *
 * O `voice-helper.exe` não é um navegador e não manda `Origin`. Recusar
 * requisição sem `Origin` fecharia o único caminho de captura que este projeto
 * tem provado. E não haveria ganho: um atacante que escolhe o header escolheria
 * omiti-lo.
 *
 * O que a allowlist protege de verdade é o caso do navegador: uma página
 * carregada na CEF (ou num navegador do jogador) que tente abrir o socket de voz
 * **carrega `Origin` obrigatoriamente**, porque o navegador o põe e a página não
 * consegue removê-lo. Então a allowlist é eficaz exatamente contra quem ela
 * consegue identificar, e não finge proteger contra o resto.
 *
 * A defesa real contra cliente arbitrário continua sendo o ticket de uso único
 * e curta duração. Isto é a camada de cima.
 *
 * @param {string|undefined} origin
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{allowed: boolean, reason: string}}
 */
function checkOrigin(origin, env = process.env) {
  const raw = String(env.VOICE_ALLOWED_ORIGINS || '').trim();
  if (raw === '') return { allowed: true, reason: 'sem allowlist configurada' };

  if (origin === undefined || origin === null || origin === '') {
    return { allowed: true, reason: 'sem Origin — cliente nativo, não navegador' };
  }

  const allowed = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (allowed.includes('*')) return { allowed: true, reason: 'allowlist curinga' };
  if (allowed.includes(origin)) return { allowed: true, reason: 'origem na allowlist' };
  return { allowed: false, reason: `origem não autorizada: ${origin}` };
}

/**
 * O contrato de privacidade, como dado legível — e como asserção.
 *
 * Está aqui, e não só num documento, porque um documento não falha. Quem varre o
 * código atrás de gravação de mídia, pedido de vídeo e flags inseguras de CEF é
 * o `voice-privacy.test.js`, e a lista de padrões proibidos mora **lá**, não
 * aqui: escrevê-la neste arquivo faria a varredura encontrar a própria lista e
 * acusar o guarda de ser o infrator.
 *
 * A promessa "não gravamos voz" só vale enquanto alguma coisa a verifica.
 */
const PRIVACY = Object.freeze({
  recordsAudio: false,
  persistsFrames: false,
  logsAudioContent: false,
  showsMicActive: true,
  pttByDefault: true,
  cameraForbidden: true
});

module.exports = {
  audit,
  enforceAtBoot,
  assertNoSecretsIn,
  checkOrigin,
  isProductionLike,
  SEVERITY,
  PRODUCTION_LIKE,
  SECRET_ENV_NAMES,
  WILDCARD_HOSTS,
  PRIVACY
};
