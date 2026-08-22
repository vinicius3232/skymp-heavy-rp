/**
 * environment-service.js
 *
 * **Time Sync.** O servidor é a autoridade de `GameTime`/`TimeScale`: avança o
 * relógio do mundo em memória, corrige a deriva dos clientes por heartbeat e
 * persiste o estado para sobreviver a um restart sem o mundo "voltar no
 * tempo". Os 15 pontos completos da §15 da Constituição estão em
 * `docs/technical/ENVIRONMENT_AUDIT.md` — este cabeçalho segue o mesmo padrão
 * narrativo de `profession-service.js`, não um checklist embutido (ver a nota
 * daquele arquivo sobre onde a §15 mora de verdade).
 *
 * ─── O que este arquivo explicitamente NÃO faz ──────────────────────────────
 *
 * Nenhum clima. `ForceWeather` não tem binding confirmado na API do SkyMP
 * (`types/mp.d.ts` não declara `Weather`/`WorldTime`) e `docs/MODDING_GUIDELINES.md`
 * já registra a transição suave como pergunta em aberto, não resposta. O
 * candidato técnico e os riscos ficam em
 * `docs/technical/ENVIRONMENT_WEATHER_SPIKE.md` — sem código, de propósito.
 *
 * ─── Onde fica a autoridade do relógio ──────────────────────────────────────
 *
 * O ESTADO EM MEMÓRIA é a única autoridade enquanto o processo está de pé.
 * `_tick` nunca lê o banco para decidir o próximo valor — só o `initialize()`
 * lê, uma vez, no boot. Isso é o que garante que uma falha de escrita no banco
 * durante a vida do processo NUNCA faz `gameDaysPassed` regredir: a pior
 * consequência de uma persistência falhada é o próximo restart retomar de um
 * ponto um pouco atrasado, nunca o relógio andando pra trás enquanto o mundo
 * está rodando. Ver `_persist` abaixo.
 *
 * ─── §A.6 da Constituição e por que o heartbeat mora aqui dentro ───────────
 *
 * A §A.6 pede que "o tick do mundo" rode fora do processo do SkyMP, porque a
 * simulação da §12 (clima → economia → crime → política, em cascata) é cara
 * e não pode rodar durante uma cena. Este serviço não é essa simulação: é um
 * heartbeat leve (mesmo custo de I/O do `core/connection-monitor.js`, que já
 * roda um `setInterval` de 2s dentro do processo) que só avança um número e
 * corrige o cliente. Se uma fase futura ligar clima→economia de verdade nisto
 * aqui, ESSA cadeia precisa sair para um processo externo — não o relógio.
 *
 * ─── Correção de cliente: bloqueada no binding, não no FormDesc ────────────
 *
 * Versão anterior deste arquivo assumia que `_applyCorrection` funcionaria
 * assim que alguém confirmasse o FormDesc de `GameDaysPassed`/`TimeScale` no
 * CreationKit/xEdit. Isso estava errado: `core/skymp-adapter/papyrus-catalog.js`
 * — a lista extraída do C++ do servidor upstream (`UPSTREAM_COMMIT`) — **não
 * lista `GlobalVariable.SetValue`/`GetValue`**. O SkyMP não implementa essa
 * chamada; o header daquele arquivo é explícito sobre a consequência: chamar
 * uma função fora da lista não lança, o VM loga erro e devolve `null`, e é
 * assim que `death-service.js` derrubou todo mundo uma vez com
 * `Actor.GetActorValue`. Confirmar o FormDesc não resolveria nada — a função
 * nativa não existe neste build, com FormDesc certo ou errado.
 *
 * `_applyCorrection` por isso usa `papyrus.isKnownPapyrusFunction` para
 * recusar a chamada ANTES de tentar (não confia em `callPapyrusFunction`
 * "simplesmente funcionar"), loga uma vez, e não corrige nenhum cliente. O
 * relógio autoritativo em `getWorldTime()` continua correto — só a correção
 * *client-side* está bloqueada. `Utility.GetCurrentGameTime` **está** na
 * lista (leitura, não escrita) — um caminho futuro de correção teria que
 * comparar a leitura do cliente com `getWorldTime()` e agir de outra forma
 * (ex: script Papyrus custom do lado do mod, fora do escopo deste serviço),
 * não escrever direto no global via Papyrus.
 */

'use strict';

const database = require('./database');
const moduleRegistry = require('./core/module-registry');
const papyrus = require('./core/skymp-adapter/papyrus-catalog');

const MODULE_ID = 'environment';

const DAY_MS = 86400000;
const DEFAULT_HEARTBEAT_MS = 2000;
const DEFAULT_PERSIST_EVERY_N_TICKS = 15; // ~30s com heartbeat de 2s
const DEFAULT_TIMESCALE = 20; // padrão vanilla do Skyrim

/**
 * A chamada Papyrus que corrigiria o relógio do cliente, se o SkyMP a
 * implementasse. Mantida nomeada (em vez de inline em `_applyCorrection`)
 * para que `isKnownPapyrusFunction` e um eventual upstream futuro tenham um
 * único lugar para checar — ver a nota do cabeçalho sobre por que isto está
 * bloqueado hoje.
 */
const CORRECTION_CALL = Object.freeze({ callType: 'method', className: 'GlobalVariable', functionName: 'SetValue' });

/** @param {object} dependencies */
function _deps(dependencies = {}) {
  return {
    db: dependencies.db || database,
    moduleRegistry: dependencies.moduleRegistry || moduleRegistry,
    mp: dependencies.mp !== undefined ? dependencies.mp : (typeof mp !== 'undefined' ? mp : undefined),
    now: dependencies.now || (() => Date.now()),
    logger: dependencies.logger || console
  };
}

function _isModuleEnabled(deps) {
  return deps.moduleRegistry.isEnabled(MODULE_ID);
}

// ─────────────────────────────────────────────────────────────────────────────
// Estado em memória — autoridade única durante a vida do processo
// ─────────────────────────────────────────────────────────────────────────────

/** @type {{gameDaysPassed:number, timeScale:number, lastTickAt:number|null}|null} */
let _state = null;
let _timer = null;
let _ticksSinceLastPersist = 0;

function _resetForTest() {
  _state = null;
  _timer = null;
  _ticksSinceLastPersist = 0;
  _warnedUnsupported = false;
}

function _rowToState(row) {
  return {
    gameDaysPassed: Number(row.game_days_passed),
    timeScale: Number(row.timescale),
    lastTickAt: null
  };
}

/**
 * Lê a linha única do banco. Cria com o default (ou `INITIAL_TIMESCALE`) se
 * ainda não existir — só acontece no PRIMEIRO boot do servidor.
 * @param {object} deps
 * @param {number} initialTimeScale
 */
async function _loadState(deps, initialTimeScale) {
  const rows = await deps.db.query('SELECT * FROM world_time_state WHERE id = 1', []);
  if (rows.length > 0) return _rowToState(rows[0]);

  await deps.db.query(
    'INSERT INTO world_time_state (id, game_days_passed, timescale) VALUES (1, 0, ?)',
    [initialTimeScale]
  );
  return { gameDaysPassed: 0, timeScale: initialTimeScale, lastTickAt: null };
}

/**
 * Persiste o estado atual. Falha aqui NUNCA altera `_state` — a próxima
 * tentativa é o próximo tick que bater o intervalo de persistência. É o que
 * torna "o tempo não anda para trás em falha de banco" verdade: a falha só
 * atrasa o que o PRÓXIMO restart vai ler, nunca o que está rodando agora.
 * @param {object} deps
 */
async function _persist(deps) {
  try {
    await deps.db.query(
      'UPDATE world_time_state SET game_days_passed = ?, timescale = ? WHERE id = 1',
      [_state.gameDaysPassed, _state.timeScale]
    );
  } catch (err) {
    deps.logger.error(`[environment] Falha ao persistir world_time_state (retenta no próximo ciclo): ${err.message}`);
  }
}

let _warnedUnsupported = false;

/**
 * Aplica a correção de deriva nos clientes. Recusa ANTES de chamar
 * `mp.callPapyrusFunction` se a função não estiver em `papyrus-catalog.js` —
 * `GlobalVariable.SetValue` não está: este build do SkyMP não a implementa, e
 * chamar mesmo assim não lançaria, só devolveria `null` em silêncio (ver o
 * cabeçalho do arquivo). O relógio autoritativo (`getWorldTime()`) continua
 * correto de qualquer forma — só a correção client-side fica indisponível.
 * @param {object} deps
 */
function _applyCorrection(deps) {
  if (typeof deps.mp === 'undefined' || !deps.mp) return;

  const { callType, className, functionName } = CORRECTION_CALL;
  if (!papyrus.isKnownPapyrusFunction(callType, className, functionName)) {
    if (!_warnedUnsupported) {
      _warnedUnsupported = true;
      deps.logger.warn(
        `[environment] ${className}.${functionName} não está em papyrus-catalog.js (build ${papyrus.UPSTREAM_COMMIT}) — ` +
        'este SkyMP não implementa a chamada. O relógio do servidor continua correto; ' +
        'nenhum cliente recebe correção de deriva até um caminho alternativo existir.'
      );
    }
    return;
  }

  // Inalcançável enquanto papyrus-catalog.js não listar a função — mantido
  // para quando (se) um upstream futuro passar a implementá-la.
  try {
    deps.mp.callPapyrusFunction(callType, className, functionName, /* GameDaysPassed */ null, [_state.gameDaysPassed]);
    deps.mp.callPapyrusFunction(callType, className, functionName, /* TimeScale */ null, [_state.timeScale]);
  } catch (err) {
    deps.logger.error(`[environment] Falha ao aplicar correção de deriva: ${err.message}`);
  }
}

/**
 * Um heartbeat: avança `gameDaysPassed` proporcionalmente ao tempo real
 * decorrido e a `timeScale`, corrige os clientes, e persiste a cada N ticks.
 * Exposto separado de `start()`/`stop()` para o teste chamar direto, sem
 * depender de timer real — mesmo padrão de `core/connection-monitor.js`.
 * @param {object} [dependencies]
 */
async function _tick(dependencies = {}) {
  const deps = _deps(dependencies);
  if (!_state) return;

  const nowMs = deps.now();
  const elapsedMs = _state.lastTickAt === null ? 0 : Math.max(0, nowMs - _state.lastTickAt);
  _state.gameDaysPassed += (elapsedMs / DAY_MS) * _state.timeScale;
  _state.lastTickAt = nowMs;

  _applyCorrection(deps);

  _ticksSinceLastPersist += 1;
  if (_ticksSinceLastPersist >= DEFAULT_PERSIST_EVERY_N_TICKS) {
    _ticksSinceLastPersist = 0;
    await _persist(deps);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// API Pública
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Leitura pura do estado em memória. `null` antes do `initialize()`.
 * @param {object} [dependencies]
 */
function getWorldTime(dependencies = {}) {
  const deps = _deps(dependencies);
  if (!_isModuleEnabled(deps)) return null;
  if (!_state) return null;
  return { gameDaysPassed: _state.gameDaysPassed, timeScale: _state.timeScale };
}

/**
 * @param {object} [dependencies]
 * @param {number} [heartbeatMs]
 */
async function initialize(dependencies = {}, heartbeatMs = DEFAULT_HEARTBEAT_MS) {
  const deps = _deps(dependencies);

  const envTimeScale = Number(process.env.INITIAL_TIMESCALE);
  const initialTimeScale = Number.isFinite(envTimeScale) && envTimeScale > 0 ? envTimeScale : DEFAULT_TIMESCALE;

  _state = await _loadState(deps, initialTimeScale);
  _state.lastTickAt = deps.now();
  _ticksSinceLastPersist = 0;

  if (_timer) return;
  _timer = setInterval(() => {
    _tick(dependencies).catch((err) => deps.logger.error(`[environment] Erro no heartbeat: ${err.message}`));
  }, heartbeatMs);
  if (typeof _timer.unref === 'function') _timer.unref();
}

/**
 * @param {object} [dependencies]
 */
async function shutdown(dependencies = {}) {
  const deps = _deps(dependencies);
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
  if (_state) await _persist(deps);
}

function healthCheck() {
  return _state !== null && _timer !== null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Comando de jogador — só leitura
// ─────────────────────────────────────────────────────────────────────────────

function commandDefs() {
  return [
    {
      name: '/tempo',
      description: 'Mostra o dia e horário atuais do mundo',
      usage: '/tempo',
      handler: async (actorId) => {
        const commands = require('./commands');
        const estado = getWorldTime();
        if (!estado) {
          commands.sendNotification(actorId, '[Tempo] Serviço de ambiente desativado.');
          return;
        }
        const dia = Math.floor(estado.gameDaysPassed);
        const horaFracionaria = (estado.gameDaysPassed - dia) * 24;
        const hora = Math.floor(horaFracionaria);
        const minuto = Math.floor((horaFracionaria - hora) * 60);
        commands.sendNotification(
          actorId,
          `[Tempo] Dia ${dia}, ${String(hora).padStart(2, '0')}:${String(minuto).padStart(2, '0')} ` +
          `(TimeScale ${estado.timeScale})`
        );
      }
    }
  ];
}

module.exports = {
  MODULE_ID,
  DAY_MS,
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_PERSIST_EVERY_N_TICKS,
  DEFAULT_TIMESCALE,
  CORRECTION_CALL,
  getWorldTime,
  initialize,
  shutdown,
  healthCheck,
  commandDefs,
  // Expostos só para teste.
  _tick,
  _resetForTest
};
