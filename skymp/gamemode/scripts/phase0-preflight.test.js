const assert = require('assert');
const { describe, it } = require('node:test');

const preflight = require('./phase0-preflight');

describe('phase0-preflight — argumentos e segredos', () => {
  it('usa main/local como padrão', () => {
    assert.deepEqual(preflight.parseArgs([]), { profile: 'main', topology: 'local' });
  });

  it('recusa perfil desconhecido', () => {
    assert.throws(() => preflight.parseArgs(['--profile', 'tudo-ligado']), /Perfil inválido/);
  });

  it('lê dotenv sem exigir aspas e sem alterar o valor', () => {
    const env = preflight.parseDotEnv('A=true\nB="segredo com espaço"\n# C=ignorado');
    assert.deepEqual(env, { A: 'true', B: 'segredo com espaço' });
  });
});

describe('phase0-preflight — perfil principal', () => {
  it('aprova as flags exatas do roteiro', () => {
    const env = { NODE_ENV: 'local', ...preflight.MAIN_FLAGS };
    const errors = preflight.validateProfile(env, 'main', 'local').filter(item => item.level === 'ERROR');
    assert.equal(errors.length, 0);
  });

  it('reprova serviço obrigatório desligado e feature isolada ligada', () => {
    const env = {
      NODE_ENV: 'local',
      ...preflight.MAIN_FLAGS,
      ENABLE_DEATH_SERVICE: 'false',
      ENABLE_SOUL_SERVICE: 'true'
    };
    const codes = preflight.validateProfile(env, 'main', 'local')
      .filter(item => item.level === 'ERROR')
      .map(item => item.code);
    assert.ok(codes.includes('flag:ENABLE_DEATH_SERVICE'));
    assert.ok(codes.includes('flag:ENABLE_SOUL_SERVICE'));
  });
});

describe('phase0-preflight — perfis isolados', () => {
  it('voz nativa fora de local recusa hosts de loopback', () => {
    const env = {
      NODE_ENV: 'local',
      ENABLE_VOIP_SERVICE: 'true',
      ENABLE_SOUL_SERVICE: 'false',
      VOIP_DEBUG_EXPOSE_TICKET: 'true',
      VOIP_PUBLIC_HOST: '127.0.0.1',
      VOIP_BIND_HOST: 'localhost'
    };
    const codes = preflight.validateProfile(env, 'voice-native', 'lan')
      .filter(item => item.level === 'ERROR')
      .map(item => item.code);
    assert.ok(codes.includes('voip:public-host'));
    assert.ok(codes.includes('voip:bind-host'));
  });

  it('boot positivo da alma exige segredo sem imprimi-lo', () => {
    const env = { NODE_ENV: 'local', ENABLE_SOUL_SERVICE: 'true', ENABLE_VOIP_SERVICE: 'false' };
    const errors = preflight.validateProfile(env, 'soul', 'local').filter(item => item.level === 'ERROR');
    assert.ok(errors.some(item => item.code === 'soul:secret'));
  });
});

describe('phase0-preflight — server settings', () => {
  it('offlineMode true e loopback em LAN reprovam', () => {
    const results = preflight.validateSettings({
      offlineMode: true,
      gamemodePath: 'gamemode/phase0-basic.js',
      listenHost: '127.0.0.1',
      loadOrder: ['Skyrim.esm']
    }, 'lan');
    const codes = results.filter(item => item.level === 'ERROR').map(item => item.code);
    assert.ok(codes.includes('settings:offline-mode'));
    assert.ok(codes.includes('settings:listen-host'));
  });
});
