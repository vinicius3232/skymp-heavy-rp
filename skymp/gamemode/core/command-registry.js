/**
 * core/command-registry.js
 *
 * Registro centralizado de comandos de chat.
 * Substitui o switch monolítico em commands.js.
 *
 * Módulos registram seus comandos via:
 *   commandRegistry.register('chopwood', handler, { module: 'woodcutting', phase: 'lab' });
 *
 * O dispatch é feito via:
 *   commandRegistry.dispatch(actorId, '/chopwood', 'args...');
 *
 * Se o módulo que originou o comando não estiver habilitado,
 * o comando não é registrado e não existe para o jogador.
 */

// Mapa de comando → { handler, module, phase, description }
const _commands = new Map();

/**
 * Registra um comando no registry.
 *
 * @param {string|string[]} command - Comando (ex: '/chopwood') ou lista de aliases
 * @param {Function} handler - async function(actorId, args) → void
 * @param {object} [opts]
 * @param {string} [opts.module] - ID do módulo de origem; usa `unknown` quando omitido
 * @param {string} [opts.phase] - Fase do módulo ('core', 'lab', 'parked')
 * @param {string} [opts.description] - Descrição para /help
 * @param {string} [opts.usage] - Exemplo de uso
 */
function register(command, handler, opts = {}) {
  const commands = Array.isArray(command) ? command : [command];
  for (const cmd of commands) {
    const normalized = cmd.toLowerCase().startsWith('/') ? cmd.toLowerCase() : `/${cmd.toLowerCase()}`;
    if (_commands.has(normalized)) {
      console.warn(`[command-registry] Aviso: Comando ${normalized} sobrescrito por módulo '${opts.module || 'unknown'}'`);
    }
    _commands.set(normalized, {
      handler,
      module: opts.module || 'unknown',
      phase: opts.phase || 'core',
      description: opts.description || '',
      usage: opts.usage || normalized
    });
  }
}

/**
 * Remove um comando do registry (usado quando um módulo é desligado).
 * @param {string|string[]} command
 */
function unregister(command) {
  const commands = Array.isArray(command) ? command : [command];
  for (const cmd of commands) {
    const normalized = cmd.toLowerCase().startsWith('/') ? cmd.toLowerCase() : `/${cmd.toLowerCase()}`;
    _commands.delete(normalized);
  }
}

/**
 * Despacha um comando para o handler registrado.
 *
 * @param {number} actorId
 * @param {string} command - Comando com '/' (ex: '/chopwood')
 * @param {string} args - Argumentos como string
 * @returns {boolean} true se o comando foi encontrado e despachado, false se não existe
 */
function dispatch(actorId, command, args) {
  const normalized = command.toLowerCase();
  const entry = _commands.get(normalized);

  if (!entry) {
    return false; // Comando não encontrado
  }

  try {
    const result = entry.handler(actorId, args);
    if (result instanceof Promise) {
      result.catch((err) => {
        console.error(`[command-registry] Erro no handler de ${normalized} (módulo: ${entry.module}):`, err.message);
      });
    }
  } catch (err) {
    console.error(`[command-registry] Erro síncrono no handler de ${normalized} (módulo: ${entry.module}):`, err.message);
  }

  return true;
}

/**
 * Verifica se um comando está registrado.
 * @param {string} command
 * @returns {boolean}
 */
function has(command) {
  const normalized = command.toLowerCase().startsWith('/') ? command.toLowerCase() : `/${command.toLowerCase()}`;
  return _commands.has(normalized);
}

/**
 * Lista todos os comandos registrados.
 * Usado por /help e painel de staff.
 * @returns {Array<{command: string, module: string, phase: string, description: string, usage: string}>}
 */
function list() {
  return Array.from(_commands.entries()).map(([cmd, entry]) => ({
    command: cmd,
    module: entry.module,
    phase: entry.phase,
    description: entry.description,
    usage: entry.usage
  }));
}

module.exports = { register, unregister, dispatch, has, list };
