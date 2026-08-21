const { test, describe, beforeEach, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const serverOptions = require('./server-options');

// O loader resolve o caminho a partir de __dirname, então os testes escrevem
// num ambiente próprio dentro de skymp/config/ e limpam depois. Usar um nome
// improvável evita colidir com config real de alguém.
const CONFIG_DIR = path.resolve(__dirname, '..', '..', 'config');
const TEST_ENV = '__test_env__';
const TEST_FILE = path.join(CONFIG_DIR, `server-options.${TEST_ENV}.json`);

function writeConfig(obj) {
  fs.writeFileSync(TEST_FILE, JSON.stringify(obj, null, 2));
}

function removeConfig() {
  if (fs.existsSync(TEST_FILE)) fs.unlinkSync(TEST_FILE);
}

before(removeConfig);
after(removeConfig);
beforeEach(() => {
  serverOptions._reset();
  removeConfig();
});

describe('defaults', () => {
  test('arquivo ausente não é erro — usa defaults', () => {
    const result = serverOptions.load(TEST_ENV);
    assert.equal(result.ok, true);
    assert.equal(result.usedFile, false);
    assert.equal(result.options['chat.localRange'], 1200);
    assert.equal(result.options['rp.permadeathEnabled'], false);
  });

  test('defaults preservam os valores que estavam hardcoded antes', () => {
    // Este teste existe pra que ligar o loader não mude comportamento por
    // acidente. Se alguém alterar um default, quebra aqui e precisa justificar.
    const { options } = serverOptions.load(TEST_ENV);
    assert.equal(options['chat.whisperRange'], 450);
    assert.equal(options['chat.localRange'], 1200);
    assert.equal(options['chat.shoutRange'], 3500);
    assert.equal(options['chat.oocRateLimitSeconds'], 5);
    assert.equal(options['spawn.playerRespawnSeconds'], 5);
    assert.equal(options['economy.startingGold'], 0);
  });
});

describe('leitura de valores válidos', () => {
  test('sobrescreve o default', () => {
    writeConfig({ chat: { localRange: 800 } });
    const { options } = serverOptions.load(TEST_ENV);
    assert.equal(options['chat.localRange'], 800);
  });

  test('chave ausente no arquivo mantém o default', () => {
    writeConfig({ chat: { localRange: 800 } });
    const { options } = serverOptions.load(TEST_ENV);
    assert.equal(options['chat.shoutRange'], 3500, 'o que não foi informado deveria ficar no default');
  });

  test('aceita booleano false (e não confunde com ausente)', () => {
    writeConfig({ chat: { oocEnabled: false } });
    assert.equal(serverOptions.load(TEST_ENV).options['chat.oocEnabled'], false);
  });

  test('aceita zero como valor legítimo', () => {
    writeConfig({ spawn: { playerRespawnSeconds: 0 } });
    assert.equal(serverOptions.load(TEST_ENV).options['spawn.playerRespawnSeconds'], 0);
  });
});

describe('validação falha alto', () => {
  // O ponto: uma opção de gameplay mal digitada que "quase funciona" é pior
  // que um servidor que não sobe.

  test('tipo errado aborta', () => {
    writeConfig({ chat: { localRange: 'muito' } });
    assert.throws(() => serverOptions.load(TEST_ENV), /localRange.*esperado n[uú]mero/i);
  });

  test('booleano recebendo string aborta', () => {
    writeConfig({ rp: { permadeathEnabled: 'true' } });
    assert.throws(() => serverOptions.load(TEST_ENV), /permadeathEnabled.*booleano/i);
  });

  test('valor fora do intervalo aborta', () => {
    writeConfig({ chat: { localRange: 999999 } });
    assert.throws(() => serverOptions.load(TEST_ENV), /localRange.*fora do intervalo/i);
  });

  test('número negativo onde não faz sentido aborta', () => {
    writeConfig({ economy: { startingGold: -50 } });
    assert.throws(() => serverOptions.load(TEST_ENV), /startingGold.*fora do intervalo/i);
  });

  test('JSON corrompido aborta com o caminho no erro', () => {
    fs.writeFileSync(TEST_FILE, '{ isso nao e json');
    assert.throws(() => serverOptions.load(TEST_ENV), /nao e JSON valido/i);
  });

  test('relata TODOS os erros de uma vez, não só o primeiro', () => {
    writeConfig({ chat: { localRange: 'x', shoutRange: 'y' } });
    try {
      serverOptions.load(TEST_ENV);
      assert.fail('deveria ter lançado');
    } catch (err) {
      assert.match(err.message, /localRange/);
      assert.match(err.message, /shoutRange/, 'quem está corrigindo config quer ver tudo de uma vez');
    }
  });
});

describe('honestidade sobre o que não está implementado', () => {
  test('avisa quando o arquivo traz opção que ainda não faz nada', () => {
    writeConfig({ debug: { enableHotReload: true } });
    const { warnings } = serverOptions.load(TEST_ENV);
    assert.ok(
      warnings.some((w) => w.includes('debug.enableHotReload')),
      'configurar algo inerte precisa gerar aviso — é o problema que este módulo existe pra resolver'
    );
  });

  test('não avisa sobre opções que estão ligadas', () => {
    writeConfig({ chat: { localRange: 900 } });
    const { warnings } = serverOptions.load(TEST_ENV);
    assert.equal(warnings.length, 0);
  });

  test('SPEC e DECLARED_BUT_UNWIRED não se sobrepõem', () => {
    // Uma opção nos dois lugares significaria que a documentação mente numa
    // das duas direções.
    for (const dottedPath of serverOptions.DECLARED_BUT_UNWIRED) {
      assert.ok(!(dottedPath in serverOptions.SPEC), `${dottedPath} está em SPEC e em DECLARED_BUT_UNWIRED`);
    }
  });

  test('toda opção do exemplo está em SPEC ou declarada como não-implementada', () => {
    // Impede que o exemplo ganhe uma chave nova sem ninguém decidir se ela
    // funciona — que foi exatamente como as 24 opções originais viraram letra
    // morta.
    const example = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'server-options.local.example.json'), 'utf8'));
    const known = new Set([...Object.keys(serverOptions.SPEC), ...serverOptions.DECLARED_BUT_UNWIRED]);

    const missing = [];

    /**
     * Desce em QUALQUER profundidade.
     *
     * Até 14/08/2026 esta varredura descia exatamente dois níveis, porque todas
     * as opções tinham exatamente dois. Quando `voice.downed.rangeModifier`
     * nasceu, ela passou a acusar `voice.downed` — um objeto — como opção não
     * classificada, e o `getAtPath` do módulo já lia caminho de qualquer
     * tamanho. Era o teste que estava estreito, não a configuração que estava
     * torta.
     *
     * A parada é na FOLHA: um nó que ainda é objeto não é uma opção, é uma
     * seção. Chave começando com `_` é comentário do JSON e não entra.
     */
    const varrer = (valor, prefixo) => {
      for (const [chave, filho] of Object.entries(valor)) {
        if (chave.startsWith('_')) continue;
        const dottedPath = prefixo ? `${prefixo}.${chave}` : chave;
        if (filho !== null && typeof filho === 'object' && !Array.isArray(filho)) {
          varrer(filho, dottedPath);
        } else if (prefixo && !known.has(dottedPath)) {
          missing.push(dottedPath);
        }
      }
    };
    varrer(example, '');

    assert.deepEqual(missing, [], 'opções no exemplo que não foram classificadas em core/server-options.js');
  });
});

describe('get()', () => {
  test('carrega sozinho se ninguém chamou load()', () => {
    serverOptions._reset();
    assert.equal(typeof serverOptions.get('chat.localRange'), 'number');
  });

  test('opção fora da SPEC lança com dica de como resolver', () => {
    assert.throws(() => serverOptions.get('debug.enableHotReload'), /DECLARED_BUT_UNWIRED/);
  });
});
