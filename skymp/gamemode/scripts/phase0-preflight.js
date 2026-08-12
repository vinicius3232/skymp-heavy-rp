#!/usr/bin/env node
/**
 * Preflight somente-leitura da sessão in-game da Fase 0.
 *
 * Não inicia processos, não altera .env e nunca imprime valores de segredo.
 * O objetivo é falhar antes de chamar testadores, com uma lista completa do
 * que falta para o perfil de boot escolhido.
 */

const fs = require('fs');
const path = require('path');

const PROFILES = new Set(['main', 'nametag', 'voice-fallback', 'voice-native', 'soul', 'safe-zones']);
const TOPOLOGIES = new Set(['local', 'lan', 'internet']);

const MAIN_FLAGS = Object.freeze({
  ENABLE_GOVERNANCE_SERVICE: 'true',
  ENABLE_MARKET_STALLS_SERVICE: 'true',
  ENABLE_DEATH_SERVICE: 'true',
  ENABLE_PLAYER_PANEL_SERVICE: 'true',
  ENABLE_VOIP_SERVICE: 'false',
  ENABLE_SOUL_SERVICE: 'false',
  ENABLE_NAMETAG_SERVICE: 'false'
});

function parseArgs(argv) {
  const options = { profile: 'main', topology: 'local' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--profile') options.profile = argv[++index];
    else if (arg === '--topology') options.topology = argv[++index];
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Argumento desconhecido: ${arg}`);
  }
  if (!PROFILES.has(options.profile)) throw new Error(`Perfil inválido: ${options.profile}`);
  if (!TOPOLOGIES.has(options.topology)) throw new Error(`Topologia inválida: ${options.topology}`);
  return options;
}

function parseDotEnv(content) {
  const values = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

function isLoopback(host) {
  const normalized = String(host || '').trim().toLowerCase();
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1';
}

function result(level, code, message) {
  return { level, code, message };
}

function validateExpectedFlags(env, expected) {
  const results = [];
  for (const [key, expectedValue] of Object.entries(expected)) {
    const actual = String(env[key] || '').toLowerCase();
    if (actual !== expectedValue) {
      results.push(result('ERROR', `flag:${key}`, `${key} deve ser ${expectedValue} neste perfil.`));
    } else {
      results.push(result('OK', `flag:${key}`, `${key}=${expectedValue}`));
    }
  }
  return results;
}

function validateProfile(env, profile, topology) {
  const results = [];
  if ((env.NODE_ENV || '') !== 'local') {
    results.push(result('ERROR', 'env:NODE_ENV', 'NODE_ENV deve ser local para usar server-options.local.json.'));
  } else {
    results.push(result('OK', 'env:NODE_ENV', 'NODE_ENV=local'));
  }

  if (profile === 'main') results.push(...validateExpectedFlags(env, MAIN_FLAGS));

  if (profile === 'nametag') {
    results.push(...validateExpectedFlags(env, { ...MAIN_FLAGS, ENABLE_NAMETAG_SERVICE: 'true' }));
  }

  if (profile === 'voice-fallback' || profile === 'voice-native') {
    results.push(...validateExpectedFlags(env, { ENABLE_VOIP_SERVICE: 'true', ENABLE_SOUL_SERVICE: 'false' }));
    const exposeExpected = profile === 'voice-native' ? 'true' : 'false';
    results.push(...validateExpectedFlags(env, { VOIP_DEBUG_EXPOSE_TICKET: exposeExpected }));
    if (topology !== 'local' && isLoopback(env.VOIP_PUBLIC_HOST)) {
      results.push(result('ERROR', 'voip:public-host', 'VOIP_PUBLIC_HOST não pode ser loopback fora da topologia local.'));
    }
    if (topology !== 'local' && isLoopback(env.VOIP_BIND_HOST)) {
      results.push(result('ERROR', 'voip:bind-host', 'VOIP_BIND_HOST não pode escutar apenas em loopback fora da topologia local.'));
    }
  }

  if (profile === 'soul') {
    results.push(...validateExpectedFlags(env, { ENABLE_SOUL_SERVICE: 'true', ENABLE_VOIP_SERVICE: 'false' }));
    if (!env.SOUL_SECRET) results.push(result('ERROR', 'soul:secret', 'SOUL_SECRET precisa estar definido para o boot positivo de 9.4.'));
    else results.push(result('OK', 'soul:secret', 'SOUL_SECRET está definido (valor não exibido).'));
  }

  return results;
}

function validateSettings(settings, topology) {
  const results = [];
  if (settings.offlineMode !== false) {
    results.push(result('ERROR', 'settings:offline-mode', 'offlineMode precisa ser false para provar identidade/master API.'));
  } else {
    results.push(result('OK', 'settings:offline-mode', 'offlineMode=false'));
  }
  if (settings.gamemodePath !== 'gamemode/phase0-basic.js') {
    results.push(result('ERROR', 'settings:gamemode', 'gamemodePath precisa apontar para gamemode/phase0-basic.js.'));
  } else {
    results.push(result('OK', 'settings:gamemode', 'gamemodePath correto.'));
  }
  if (topology !== 'local' && isLoopback(settings.listenHost)) {
    results.push(result('ERROR', 'settings:listen-host', 'listenHost não pode ser loopback para testadores LAN/internet.'));
  }
  if (!Array.isArray(settings.loadOrder) || settings.loadOrder.length === 0) {
    results.push(result('ERROR', 'settings:load-order', 'loadOrder está ausente ou vazia.'));
  } else {
    results.push(result('OK', 'settings:load-order', `loadOrder contém ${settings.loadOrder.length} plugins.`));
  }
  return results;
}

function inspectReadiness({ rootDir, profile, topology }) {
  const results = [];
  const checkFile = (relativePath, code, missingMessage) => {
    const absolute = path.join(rootDir, relativePath);
    if (!fs.existsSync(absolute)) {
      results.push(result('ERROR', code, missingMessage));
      return null;
    }
    results.push(result('OK', code, `${relativePath} encontrado.`));
    return absolute;
  };

  const services = [
    ['apps/web', 'server.js'],
    ['apps/bot-discord', 'index.js'],
    ['apps/game-api', 'server.js'],
    ['apps/launcher', 'package.json']
  ];
  for (const [directory, entry] of services) {
    checkFile(`${directory}/${entry}`, `entry:${directory}`, `${directory}/${entry} não encontrado.`);
    checkFile(`${directory}/.env`, `env:${directory}`, `${directory}/.env ausente; copie o exemplo e preencha sem commitar.`);
    checkFile(`${directory}/node_modules`, `deps:${directory}`, `${directory}/node_modules ausente; rode npm ci nessa pasta.`);
  }

  checkFile('skymp/server/dist_back/skymp5-server.js', 'server:artifact', 'Artifact do servidor ausente; execute Install-SkyMPServerArtifact.ps1.');
  checkFile('skymp/gamemode/node_modules', 'deps:gamemode', 'Dependências do gamemode ausentes; rode npm ci.');

  const envPath = checkFile('skymp/gamemode/.env', 'env:gamemode', 'skymp/gamemode/.env ausente; copie .env.example e configure o perfil de boot.');
  if (envPath) {
    const env = parseDotEnv(fs.readFileSync(envPath, 'utf8'));
    results.push(...validateProfile(env, profile, topology));
  }

  const settingsPath = checkFile(
    'skymp/config/server-settings.local.json',
    'config:server-settings',
    'server-settings.local.json ausente; execute Initialize-LocalConfig.ps1 e revise os placeholders.'
  );
  if (settingsPath) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      results.push(...validateSettings(settings, topology));
    } catch (error) {
      results.push(result('ERROR', 'config:server-settings-json', `server-settings.local.json inválido: ${error.message}`));
    }
  }

  const optionsPath = checkFile(
    'skymp/config/server-options.local.json',
    'config:server-options',
    'server-options.local.json ausente; execute Initialize-LocalConfig.ps1 e revise as opções.'
  );
  if (optionsPath) {
    try {
      JSON.parse(fs.readFileSync(optionsPath, 'utf8'));
      results.push(result('OK', 'config:server-options-json', 'server-options.local.json é JSON válido.'));
    } catch (error) {
      results.push(result('ERROR', 'config:server-options-json', `server-options.local.json inválido: ${error.message}`));
    }
  }

  const manifestPath = checkFile(
    'apps/game-api/mods.json',
    'mods:manifest',
    'apps/game-api/mods.json ausente; /mods.json responderá 503.'
  );
  if (manifestPath) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const valid = Array.isArray(manifest.mods) && Array.isArray(manifest.loadOrder) && manifest.loadOrder.length > 0;
      results.push(result(valid ? 'OK' : 'ERROR', 'mods:shape', valid
        ? `Manifesto contém ${manifest.mods.length} arquivos e ${manifest.loadOrder.length} plugins.`
        : 'mods.json precisa conter arrays mods e loadOrder não vazio.'));
    } catch (error) {
      results.push(result('ERROR', 'mods:json', `mods.json inválido: ${error.message}`));
    }
  }

  if (profile === 'safe-zones') {
    const safeZonesPath = checkFile(
      'skymp/config/safe-zones.json',
      'config:safe-zones',
      'safe-zones.json ausente; copie o exemplo apenas para a etapa 9.3.'
    );
    if (safeZonesPath) {
      try {
        JSON.parse(fs.readFileSync(safeZonesPath, 'utf8'));
        results.push(result('OK', 'config:safe-zones-json', 'safe-zones.json é JSON válido.'));
      } catch (error) {
        results.push(result('ERROR', 'config:safe-zones-json', `safe-zones.json inválido: ${error.message}`));
      }
    }
  }

  return results;
}

function printHelp() {
  console.log('Uso: npm run preflight:phase0 -- --profile <perfil> --topology <topologia>');
  console.log(`Perfis: ${[...PROFILES].join(', ')}`);
  console.log(`Topologias: ${[...TOPOLOGIES].join(', ')}`);
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[preflight] ${error.message}`);
    printHelp();
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    printHelp();
    return;
  }

  const rootDir = path.resolve(__dirname, '..', '..', '..');
  const results = inspectReadiness({ rootDir, profile: options.profile, topology: options.topology });
  console.log(`[preflight] perfil=${options.profile} topologia=${options.topology}`);
  for (const item of results) console.log(`[${item.level}] ${item.message}`);

  const errors = results.filter(item => item.level === 'ERROR');
  const warnings = results.filter(item => item.level === 'WARN');
  console.log(`\n[preflight] ${errors.length} erro(s), ${warnings.length} aviso(s), ${results.length - errors.length - warnings.length} item(ns) aprovado(s).`);
  if (errors.length > 0) {
    console.error('[preflight] NÃO CHAME TESTADORES ainda. Resolva os erros acima e repita o mesmo perfil.');
    process.exitCode = 1;
  } else {
    console.log('[preflight] Perfil pronto para o boot. O teste in-game ainda é obrigatório.');
  }
}

if (require.main === module) main();

module.exports = {
  PROFILES,
  TOPOLOGIES,
  MAIN_FLAGS,
  parseArgs,
  parseDotEnv,
  isLoopback,
  validateExpectedFlags,
  validateProfile,
  validateSettings,
  inspectReadiness
};
