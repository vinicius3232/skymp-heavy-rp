/**
 * voice-dist.mjs — ciclo de vida da voz no launcher, sem I/O
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * O problema que este módulo existe para apagar
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Até aqui, ligar a voz exigia do jogador quatro passos manuais, e cada um deles
 * é um jogador perdido:
 *
 *   1. ligar `VOIP_DEBUG_EXPOSE_TICKET` no **servidor** (um andaime de bancada);
 *   2. abrir o arquivo `.voip-debug-ticket.json` e **copiar** um ticket de 30 s;
 *   3. rodar `voice-helper.exe --actor-id … --ticket …` **na mão**, antes de o
 *      ticket expirar;
 *   4. manter tudo isso coerente entre versões de cliente e de servidor.
 *
 * Nenhum desses passos é ação de jogador. Este módulo é a lógica que os
 * substitui: **o launcher instala, verifica, versiona, inicia, entrega a
 * credencial e desliga.**
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Como a credencial chega ao helper sem passar por um humano
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * O ticket é emitido pelo **servidor**, dentro do jogo, quando o jogador digita
 * `/voz`. O launcher não pode conhecê-lo: ele já fechou a janela quando isso
 * acontece, e adivinhar seria pior.
 *
 * Quem recebe o ticket é a **CEF** (pela property `voipTicket` do SkyMP). Então
 * o caminho é: CEF → helper, direto, sem disco e sem humano.
 *
 * ```
 *   launcher                     jogo                          helper
 *      │                          │                              │
 *      │ 1. gera pairingToken     │                              │
 *      │    (aleatório, por       │                              │
 *      │     execução)            │                              │
 *      │──── grava no config ────►│                              │
 *      │──── inicia o helper com --control-port e --pair ────────►│
 *      │                          │                              │
 *      │                     2. /voz                             │
 *      │                          │◄── voipTicket (do servidor)  │
 *      │                     3. CEF POST 127.0.0.1:<port>        │
 *      │                          │──── {pair, actorId, ticket} ►│
 *      │                          │                        4. autentica no VOIP
 * ```
 *
 * O `pairingToken` é o que impede **qualquer** processo local de mandar um
 * ticket ao helper. Ele é novo a cada execução do launcher, vive só em memória e
 * no config local, e não vale em outra máquina nem em outra sessão.
 *
 * Isso apaga a necessidade do `VOIP_DEBUG_EXPOSE_TICKET` — que é o blocker #4
 * registrado em `SKYVOICE_LIVEKIT_AUDIT.md` §12.
 *
 * ⚠️ **O lado do helper é C++ e NÃO está implementado.** Este módulo é a metade
 * do launcher: ele gera o token, monta os argumentos e sabe decidir versão,
 * integridade e rollback. O `--control-port`/`--pair` precisa existir no
 * `voice-helper/src/main.cpp` para o caminho fechar. Ver
 * `docs/technical/SKYVOICE_DEPLOYMENT.md`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Por que `.mjs` puro e sem I/O
 * ─────────────────────────────────────────────────────────────────────────────
 * Mesma escolha do `parity.mjs`: dentro dos handlers `ipcMain.handle` isto seria
 * impossível de testar sem um Electron, um servidor e um jogo. Aqui `fs`, `http`
 * e `child_process` entram como argumento.
 */

/**
 * Nome do carimbo local que diz qual versão de voz está instalada.
 *
 * Separado do carimbo do cliente (`skymp_client_version.txt`) de propósito: voz
 * e cliente têm cadências diferentes, e um carimbo só obrigaria a rebaixar o
 * cliente inteiro para voltar uma versão de helper.
 */
export const VOICE_STAMP_FILENAME = 'skymp_voice_version.txt';

/** Onde o helper é instalado, relativo à pasta do jogo. */
export const VOICE_INSTALL_DIR = 'Data/Platform/Voice';

/** Nome do executável do helper. */
export const VOICE_HELPER_EXE = 'voice-helper.exe';

/**
 * Interpreta e VALIDA um manifesto de voz.
 *
 * A regra decisiva é a mesma do manifesto de cliente: **hash ausente aborta**.
 * Um manifesto sem `sha256` é indistinguível de um comprometido, e instalar sem
 * verificar seria confiar numa release do GitHub para executar código na máquina
 * do jogador.
 *
 * @param {unknown} raw
 * @returns {{ok: true, manifest: {voiceVersion: string, downloadUrl: string, sha256: string, sizeBytes: number|null, minClientVersion: string|null, protocolVersion: number|null, mandatory: boolean, notes: string}} | {ok: false, reason: string}}
 */
export function parseVoiceManifest(raw) {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, reason: 'manifesto de voz vazio ou ilegível' };
  }
  const m = /** @type {Record<string, unknown>} */ (raw);

  const voiceVersion = typeof m.voiceVersion === 'string' ? m.voiceVersion.trim() : '';
  if (!voiceVersion) return { ok: false, reason: 'manifesto de voz sem voiceVersion' };

  const downloadUrl = typeof m.downloadUrl === 'string' ? m.downloadUrl.trim() : '';
  if (!downloadUrl) return { ok: false, reason: 'manifesto de voz sem downloadUrl' };

  // HTTPS obrigatório. Um download de executável por HTTP é um executável que
  // qualquer intermediário do caminho pode trocar — e o hash não protege, porque
  // quem troca o binário troca o manifesto junto.
  if (!/^https:\/\//i.test(downloadUrl)) {
    return { ok: false, reason: `downloadUrl precisa ser https:// (veio ${downloadUrl.slice(0, 24)}…)` };
  }

  const sha256 = typeof m.sha256 === 'string' ? m.sha256.trim().toLowerCase() : '';
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    return { ok: false, reason: 'manifesto de voz sem sha256 válido — instalar sem verificar não é opção' };
  }

  return {
    ok: true,
    manifest: {
      voiceVersion,
      downloadUrl,
      sha256,
      sizeBytes: Number.isFinite(m.sizeBytes) ? Number(m.sizeBytes) : null,
      minClientVersion: typeof m.minClientVersion === 'string' ? m.minClientVersion : null,
      protocolVersion: Number.isFinite(m.protocolVersion) ? Number(m.protocolVersion) : null,
      // `mandatory` só é verdadeiro quando dito explicitamente. Um manifesto
      // malformado não deve conseguir bloquear a entrada de ninguém no jogo —
      // voz é opcional, e a regra "falha de voz nunca é falha de jogo" começa
      // aqui.
      mandatory: m.mandatory === true,
      notes: typeof m.notes === 'string' ? m.notes : ''
    }
  };
}

/**
 * Compara versões `a.b.c`. Devolve -1, 0 ou 1.
 *
 * Comparação numérica por componente, e não `localeCompare`: com string,
 * `"2.10.0" < "2.9.0"`, e o jogador ficaria preso numa versão antiga porque `1`
 * vem antes de `9` no alfabeto.
 *
 * @param {string} a @param {string} b
 */
export function compareVersions(a, b) {
  const pa = String(a || '0').split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map((n) => Number.parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

/**
 * Decide o que fazer com a voz nesta execução.
 *
 * Devolve uma AÇÃO, não um efeito. Quem executa é o `main.ts`, que tem disco e
 * rede; separar as duas coisas é o que torna esta decisão testável — e ela é a
 * decisão que pode impedir alguém de jogar.
 *
 * @param {object} args
 * @param {ReturnType<typeof parseVoiceManifest>} args.parsed  manifesto já validado
 * @param {string|null} args.installedVersion  carimbo local, `null` se nada instalado
 * @param {boolean} args.exePresent            o executável existe no disco?
 * @param {string|null} [args.clientVersion]   versão do cliente instalada
 * @param {boolean} [args.voiceEnabled]        o jogador quer voz? (preferência local)
 * @returns {{action: 'skip'|'install'|'update'|'reinstall'|'ok'|'blocked', reason: string, targetVersion?: string, mandatory?: boolean}}
 */
export function decideVoiceAction(args) {
  const {
    parsed, installedVersion, exePresent,
    clientVersion = null, voiceEnabled = true
  } = args;

  if (!voiceEnabled) {
    return { action: 'skip', reason: 'o jogador desligou a voz nas preferências' };
  }

  if (!parsed || parsed.ok !== true) {
    // Manifesto ruim NÃO bloqueia o jogo. Se já houver helper instalado, ele
    // continua valendo; se não houver, entra-se sem voz. É a aplicação direta de
    // "falha de voz nunca é falha de jogo" ao caminho de distribuição.
    const reason = parsed && 'reason' in parsed ? parsed.reason : 'manifesto de voz indisponível';
    return {
      action: 'skip',
      reason: `${reason} — entrando sem voz (o jogo não depende dela)`
    };
  }

  const m = parsed.manifest;

  // Paridade com o cliente. Um helper que fala um protocolo que o cliente
  // instalado não entende produz o sintoma mais caro: conecta, autentica, e
  // ninguém ouve ninguém.
  if (m.minClientVersion && clientVersion && compareVersions(clientVersion, m.minClientVersion) < 0) {
    return {
      action: 'blocked',
      reason: `a voz ${m.voiceVersion} exige cliente ≥ ${m.minClientVersion}; o instalado é ${clientVersion}`,
      targetVersion: m.voiceVersion,
      mandatory: m.mandatory
    };
  }

  // Binário sumiu (antivírus, limpeza de disco, desinstalação parcial). O
  // carimbo sozinho mentiria: ele diz o que FOI instalado, não o que existe.
  if (!exePresent) {
    return {
      action: installedVersion ? 'reinstall' : 'install',
      reason: installedVersion
        ? `carimbo diz ${installedVersion} mas o executável não está no disco`
        : 'voz ainda não instalada',
      targetVersion: m.voiceVersion,
      mandatory: m.mandatory
    };
  }

  if (!installedVersion) {
    return { action: 'install', reason: 'sem carimbo de versão de voz', targetVersion: m.voiceVersion, mandatory: m.mandatory };
  }

  const cmp = compareVersions(installedVersion, m.voiceVersion);
  if (cmp < 0) {
    return { action: 'update', reason: `${installedVersion} → ${m.voiceVersion}`, targetVersion: m.voiceVersion, mandatory: m.mandatory };
  }
  if (cmp > 0) {
    // O local está À FRENTE do manifesto. É rollback publicado pela operação —
    // o servidor voltou uma versão porque a nova quebrou alguma coisa. Descer é
    // o comportamento certo, e chamá-lo de "já está atualizado" deixaria a
    // versão quebrada rodando exatamente nas máquinas que a pegaram primeiro.
    return {
      action: 'update',
      reason: `rollback: instalado ${installedVersion} está à frente do publicado ${m.voiceVersion}`,
      targetVersion: m.voiceVersion,
      mandatory: m.mandatory
    };
  }

  return { action: 'ok', reason: `voz ${installedVersion} em dia`, targetVersion: m.voiceVersion, mandatory: m.mandatory };
}

/**
 * Confere o hash baixado contra o manifesto.
 *
 * Comparação **case-insensitive** e por igualdade exata do hex inteiro. Sem
 * `startsWith`, sem prefixo: um hash truncado que casa nos primeiros caracteres é
 * o modo clássico de uma verificação parecer existir e não existir.
 *
 * @param {string} expected
 * @param {string} actual
 * @returns {{ok: boolean, reason?: string}}
 */
export function verifyHash(expected, actual) {
  const e = String(expected || '').trim().toLowerCase();
  const a = String(actual || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(e)) return { ok: false, reason: 'hash esperado inválido' };
  if (!/^[0-9a-f]{64}$/.test(a)) return { ok: false, reason: 'hash calculado inválido' };
  if (e !== a) return { ok: false, reason: `hash não confere (esperado ${e.slice(0, 12)}…, veio ${a.slice(0, 12)}…)` };
  return { ok: true };
}

/**
 * Argumentos com que o helper é iniciado.
 *
 * **Nenhum ticket aqui.** O ticket é emitido pelo servidor quando o jogador
 * digita `/voz`, e o launcher já fechou a janela quando isso acontece. O que vai
 * na linha de comando é o canal por onde o ticket VAI chegar, e o segredo que
 * autoriza quem pode usá-lo.
 *
 * @param {object} args
 * @param {number} args.controlPort   porta de loopback do canal de controle
 * @param {string} args.pairingToken  segredo desta execução
 * @param {string} [args.logLevel]
 * @returns {string[]}
 */
export function helperArgs(args) {
  const { controlPort, pairingToken, logLevel = 'info' } = args;
  if (!Number.isInteger(controlPort) || controlPort <= 0 || controlPort > 65535) {
    throw new Error('[voice-dist] controlPort inválido');
  }
  if (typeof pairingToken !== 'string' || pairingToken.length < 16) {
    throw new Error('[voice-dist] pairingToken curto demais para ser segredo');
  }
  return [
    // Loopback explícito, e não configurável. Um canal de controle que aceita a
    // rede é um canal por onde alguém de fora manda o helper falar.
    '--control-host', '127.0.0.1',
    '--control-port', String(controlPort),
    '--pair', pairingToken,
    '--log-level', logLevel,
    // PTT é o padrão, e o helper precisa DECLARAR que o fala. Um helper que não
    // declara recebe concessão de microfone aberto no servidor (dívida
    // registrada em SKYVOICE_CORE_ETAPA_3.md §11.2). Declarar aqui é o que
    // fecha essa concessão para todo mundo que vem pelo launcher.
    '--ptt'
  ];
}

/**
 * O que o launcher escreve no config do jogo para a CEF encontrar o helper.
 *
 * **Nunca inclui credencial de servidor.** Só o endereço local e o segredo de
 * pareamento desta execução — que não vale em outra máquina nem em outra sessão.
 *
 * @param {object} args
 * @param {number} args.controlPort
 * @param {string} args.pairingToken
 * @param {string|null} args.voiceVersion
 * @param {boolean} args.helperRunning
 */
export function voiceConfigForClient(args) {
  const { controlPort, pairingToken, voiceVersion, helperRunning } = args;
  return {
    voice: {
      helperControlUrl: `http://127.0.0.1:${controlPort}/ticket`,
      pairingToken,
      voiceVersion: voiceVersion || null,
      helperRunning: helperRunning === true,
      // O cliente precisa saber que PTT é o regime, para desenhar o HUD certo
      // antes mesmo de o servidor confirmar.
      pushToTalk: true
    }
  };
}

/**
 * Ordem de desligamento.
 *
 * O helper morre ANTES do jogo, e a ordem importa: ele segura o microfone pelo
 * WASAPI. Deixá-lo vivo depois de o jogo fechar é um processo invisível com o
 * microfone aberto — exatamente o que a política de privacidade proíbe, e o tipo
 * de coisa que um jogador descobre pelo LED da webcam do vizinho.
 *
 * Idempotente: `stop` num helper que já morreu é sucesso, não erro. Fechar o
 * jogo de três formas diferentes é normal, e cada uma chamando isto é mais
 * barato do que cada uma conferindo antes.
 *
 * @returns {string[]} a ordem, para quem for executar
 */
export function shutdownOrder() {
  return ['voice-helper', 'game'];
}

/**
 * Preferências de voz que o launcher guarda LOCALMENTE.
 *
 * Só o que é preferência de máquina: dispositivo, volume, se a voz está ligada.
 * **Nada de credencial, nada de estado de jogo, nada de histórico.** Um launcher
 * que guardasse "com quem você falou" seria um registro de conversas por outro
 * nome.
 *
 * @param {unknown} raw
 */
export function sanitizeVoicePreferences(raw) {
  const p = (raw && typeof raw === 'object') ? /** @type {Record<string, unknown>} */ (raw) : {};
  const clamp01 = (v, fallback) => (Number.isFinite(v) ? Math.max(0, Math.min(1, Number(v))) : fallback);
  return {
    enabled: p.enabled !== false,
    // `inputDeviceId` é uma string opaca do WASAPI. Guardada como está, truncada
    // — um id de dispositivo não passa de algumas centenas de caracteres, e um
    // campo sem teto num arquivo local é o lugar onde alguém guarda outra coisa.
    inputDeviceId: typeof p.inputDeviceId === 'string' ? p.inputDeviceId.slice(0, 256) : null,
    outputVolume: clamp01(p.outputVolume, 1),
    inputGain: clamp01(p.inputGain, 1),
    pushToTalk: true   // não é preferência: é política. Ver PRIVACY.
  };
}
