/**
 * core/server-options.js
 *
 * Carrega, valida e expõe `skymp/config/server-options.<env>.json`.
 *
 * Contexto: esse arquivo era gerado pelo `Initialize-LocalConfig.ps1` e
 * documentado em 112 linhas de schema, mas **nenhum código lia**. Configuração
 * que parece existir e não faz nada é pior que configuração ausente — alguém
 * ajusta `permadeathEnabled`, nada acontece, e conclui que o servidor está
 * bugado.
 *
 * ─── Princípio deste módulo ───────────────────────────────────────────────
 *
 * Só entra aqui opção que **realmente muda comportamento hoje**. Declarar as
 * 24 opções do schema e ligar 4 recriaria exatamente o problema que este
 * arquivo existe pra resolver, só que mais difícil de perceber — porque aí o
 * arquivo *é* lido, e a pessoa tem menos motivo pra desconfiar.
 *
 * Opções não implementadas ficam listadas em `DECLARED_BUT_UNWIRED` e o loader
 * avisa no boot quando encontra uma delas. Ao implementar uma, mova pra
 * `SPEC` e tire da lista.
 *
 * Validação é estrita e falha alto: um valor fora do tipo ou do intervalo
 * aborta o boot em vez de cair num default silencioso. Uma opção de gameplay
 * mal digitada que "quase funciona" é pior do que um servidor que não sobe.
 */

const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// Especificação das opções LIGADAS
// ─────────────────────────────────────────────────────────────────────────────

const num = (min, max) => ({ type: 'number', min, max });
const bool = () => ({ type: 'boolean' });
/**
 * Opção de texto restrita a uma lista fechada.
 *
 * Nasceu com `voice.*.effect`: um efeito de voz é uma escolha de gameplay
 * ("amordaçado soa abafado ou só mais baixo?") e portanto precisa ser
 * configurável, mas um texto livre viraria exatamente o furo que o
 * `voice_mode` do socket já foi — um valor que o resto do sistema não sabe
 * interpretar, virando silêncio sem log. Aqui o valor inválido aborta o boot.
 */
const oneOf = (values) => ({ type: 'enum', values });

/**
 * Cada entrada é `'caminho.da.opcao': { ...regra, default, usedBy }`.
 * `usedBy` não é decorativo: é como alguém descobre onde a opção age sem
 * caçar pelo repositório.
 */
const SPEC = {
  'chat.whisperRange': { ...num(50, 5000), default: 450, usedBy: 'core/proximity-ranges.js (chat e voz)' },
  'chat.localRange': { ...num(50, 10000), default: 1200, usedBy: 'core/proximity-ranges.js (chat e voz)' },
  'chat.shoutRange': { ...num(50, 20000), default: 3500, usedBy: 'core/proximity-ranges.js (chat e voz)' },
  'chat.oocEnabled': { ...bool(), default: true, usedBy: 'rp-chat-service.js (/ooc)' },
  'chat.oocRateLimitSeconds': { ...num(0, 300), default: 5, usedBy: 'rp-chat-service.js (limite de /ooc)' },

  'rp.permadeathEnabled': { ...bool(), default: false, usedBy: 'death-service.js (bleed-out aposenta em vez de respawnar)' },

  'spawn.playerRespawnSeconds': { ...num(0, 3600), default: 5, usedBy: 'death-service.js (RESPAWN_DELAY_MS)' },

  'economy.startingGold': { ...num(0, 1000000), default: 0, usedBy: 'whitelist.js (ouro inicial do personagem)' },

  // ── Voz: como o estado do personagem muda a voz ────────────────────────────
  //
  // Nenhum destes números está escrito na `VoicePolicyEngine`. Ela lê daqui, e
  // os testes derivam daqui — do mesmo jeito que nenhum teste de alcance
  // escreve `450`. O motivo é o mesmo: um servidor que ache que amordaçar
  // deveria calar por completo, ou que abatido deveria continuar falando
  // normal, muda o jogo editando o JSON, e não editando a política.
  //
  // `rangeModifier` multiplica o alcance do modo (whisper/normal/shout);
  // `gainModifier` multiplica o volume final. 1 = sem efeito, 0 = inaudível.
  'voice.downed.canSpeak': { ...bool(), default: true, usedBy: 'core/voice/voice-conditions.js (abatido)' },
  'voice.downed.rangeModifier': { ...num(0, 1), default: 0.35, usedBy: 'core/voice/voice-conditions.js (abatido)' },
  'voice.downed.gainModifier': { ...num(0, 1), default: 0.6, usedBy: 'core/voice/voice-conditions.js (abatido)' },
  'voice.downed.effect': { ...oneOf(['none', 'faint', 'muffled']), default: 'faint', usedBy: 'core/voice/voice-conditions.js (abatido)' },

  'voice.gagged.canSpeak': { ...bool(), default: true, usedBy: 'core/voice/voice-conditions.js (amordaçado)' },
  'voice.gagged.rangeModifier': { ...num(0, 1), default: 0.3, usedBy: 'core/voice/voice-conditions.js (amordaçado)' },
  'voice.gagged.gainModifier': { ...num(0, 1), default: 0.4, usedBy: 'core/voice/voice-conditions.js (amordaçado)' },
  'voice.gagged.effect': { ...oneOf(['none', 'faint', 'muffled']), default: 'muffled', usedBy: 'core/voice/voice-conditions.js (amordaçado)' },

  // Inconsciente e morto não falam — isso não é configurável, é o que as duas
  // palavras significam. O que é configurável é se eles OUVEM: um servidor que
  // queira "você desmaia mas continua escutando a cena" muda aqui.
  'voice.unconscious.canHear': { ...bool(), default: false, usedBy: 'core/voice/voice-conditions.js (inconsciente)' },
  'voice.dead.canHear': { ...bool(), default: false, usedBy: 'core/voice/voice-conditions.js (morto)' },

  // Corte do filtro passa-baixa que o cliente aplica por efeito, em Hz.
  // Viajam uma vez no `auth_ok`, não por quadro. Ver skymp/ui/index.html.
  'voice.effects.muffledLowpassHz': { ...num(120, 20000), default: 700, usedBy: 'skymp/ui/index.html (BiquadFilterNode)' },
  'voice.effects.faintLowpassHz': { ...num(120, 20000), default: 2400, usedBy: 'skymp/ui/index.html (BiquadFilterNode)' },

  // Áudio espacial no cliente. Desligar cai no ganho puro (o comportamento da
  // Etapa 2), que é o que se quer se o PannerNode custar caro na CEF.
  'voice.spatial.enabled': { ...bool(), default: true, usedBy: 'core/voice/voice-core.js e skymp/ui/index.html' }
};

/**
 * Opções que existem no schema/exemplo mas ainda NÃO fazem nada.
 * Manter esta lista honesta é o ponto do módulo inteiro.
 */
const DECLARED_BUT_UNWIRED = [
  'rp.heavyRpEnabled',
  'rp.requireApprovedCharacterForSpawn', // whitelist.js já exige sempre; a opção seria pra afrouxar
  'rp.allowRaceMenuBeforeApproval',
  'rp.defaultStartPointPolicy',
  'chat.logAllChannels',                 // rp-chat-service já loga sempre
  'staff.passwordAdminLoginEnabled',
  'staff.requireRolePermission',         // admin-service já exige sempre
  'staff.requireCommandReason',          // só /permakill exige hoje
  'staff.auditAllCommands',
  'staff.allowDestructiveCommandsInProduction',
  'spawn.vanillaSpawnMode',
  'spawn.npcRespawnSeconds',
  'spawn.disableRespawnActorIds',
  'economy.serverAuthoritativeCurrency', // já é sempre verdade por arquitetura
  'economy.logAllTransactions',          // transaction-service já loga sempre
  'debug.enablePapyrusDebug',
  'debug.enableHotReload',
  'debug.enableDevTools'
];

// ─────────────────────────────────────────────────────────────────────────────

let _options = null;
let _warnings = [];

function getAtPath(obj, dottedPath) {
  return dottedPath.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

/**
 * Valida um valor contra a regra. Devolve mensagem de erro ou `null`.
 */
function validateValue(dottedPath, value, rule) {
  if (rule.type === 'boolean') {
    if (typeof value !== 'boolean') return `${dottedPath}: esperado booleano, veio ${typeof value} (${JSON.stringify(value)})`;
    return null;
  }
  if (rule.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return `${dottedPath}: esperado número, veio ${typeof value} (${JSON.stringify(value)})`;
    }
    if (value < rule.min || value > rule.max) {
      return `${dottedPath}: ${value} fora do intervalo permitido [${rule.min}, ${rule.max}]`;
    }
    return null;
  }
  if (rule.type === 'enum') {
    if (typeof value !== 'string' || !rule.values.includes(value)) {
      return `${dottedPath}: esperado um de [${rule.values.join(', ')}], veio ${JSON.stringify(value)}`;
    }
    return null;
  }
  return `${dottedPath}: regra de tipo desconhecida '${rule.type}'`;
}

/**
 * Carrega o arquivo do ambiente atual.
 *
 * Ausência de arquivo NÃO é erro: o servidor roda com os defaults, que são os
 * mesmos valores que estavam hardcoded antes deste módulo existir. O que é
 * erro é um arquivo presente com conteúdo inválido — aí alguém tentou
 * configurar alguma coisa e merece saber que não funcionou.
 *
 * @param {string} [environment] 'local' | 'staging' | 'production'.
 *   Padrão: NODE_ENV, ou 'local'.
 */
function load(environment) {
  const env = environment || process.env.NODE_ENV || 'local';
  const configPath = path.resolve(__dirname, '..', '..', 'config', `server-options.${env}.json`);

  _warnings = [];
  const resolved = {};
  for (const [dottedPath, rule] of Object.entries(SPEC)) {
    resolved[dottedPath] = rule.default;
  }

  if (!fs.existsSync(configPath)) {
    _options = resolved;
    _warnings.push(`server-options.${env}.json nao encontrado — usando defaults.`);
    return { ok: true, options: resolved, warnings: _warnings, path: configPath, usedFile: false };
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    // Falha alto: o arquivo existe, então alguém quis configurar algo.
    throw new Error(`[server-options] ${configPath} nao e JSON valido: ${err.message}`);
  }

  const errors = [];
  for (const [dottedPath, rule] of Object.entries(SPEC)) {
    const value = getAtPath(raw, dottedPath);
    if (value === undefined) continue; // não informado: fica no default
    const error = validateValue(dottedPath, value, rule);
    if (error) { errors.push(error); continue; }
    resolved[dottedPath] = value;
  }

  if (errors.length > 0) {
    throw new Error(
      `[server-options] ${configPath} tem valores invalidos:\n  - ${errors.join('\n  - ')}\n` +
      `Corrija o arquivo ou remova as chaves pra usar os defaults.`
    );
  }

  // Avisa sobre o que a pessoa configurou achando que faria efeito.
  for (const dottedPath of DECLARED_BUT_UNWIRED) {
    if (getAtPath(raw, dottedPath) !== undefined) {
      _warnings.push(`${dottedPath} esta no arquivo mas AINDA NAO faz nada (ver core/server-options.js).`);
    }
  }

  _options = resolved;
  return { ok: true, options: resolved, warnings: _warnings, path: configPath, usedFile: true };
}

/**
 * Lê uma opção já carregada. Chama `load()` sozinho se ninguém chamou antes,
 * pra que um módulo não dependa da ordem de boot.
 */
function get(dottedPath) {
  if (!_options) load();
  if (!(dottedPath in SPEC)) {
    throw new Error(`[server-options] '${dottedPath}' nao esta em SPEC. Se acabou de implementar, mova de DECLARED_BUT_UNWIRED pra SPEC.`);
  }
  return _options[dottedPath];
}

/** Estado atual, pra diagnóstico no boot. */
function describe() {
  if (!_options) load();
  return {
    wired: Object.keys(SPEC).length,
    unwired: DECLARED_BUT_UNWIRED.length,
    values: { ..._options },
    warnings: [..._warnings]
  };
}

/** Só pra testes: descarta o estado carregado. */
function _reset() {
  _options = null;
  _warnings = [];
}

module.exports = { load, get, describe, SPEC, DECLARED_BUT_UNWIRED, _reset };
