import test from 'node:test';
import assert from 'node:assert';

import {
  parseVoiceManifest, compareVersions, decideVoiceAction, verifyHash,
  helperArgs, voiceConfigForClient, shutdownOrder, sanitizeVoicePreferences
} from './voice-dist.mjs';

const HASH = 'a'.repeat(64);

function manifesto(over = {}) {
  return {
    voiceVersion: '1.2.0',
    downloadUrl: 'https://github.com/exemplo/dist/releases/download/voice/voice-helper.zip',
    sha256: HASH,
    sizeBytes: 4_000_000,
    mandatory: false,
    ...over
  };
}

// ── Manifesto ────────────────────────────────────────────────────────────────

test('manifesto — o caminho feliz passa', () => {
  const r = parseVoiceManifest(manifesto());
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.manifest.voiceVersion, '1.2.0');
  assert.strictEqual(r.manifest.sha256, HASH);
});

test('manifesto — hash ausente ABORTA', () => {
  // A regra decisiva: um manifesto sem sha256 é indistinguível de um
  // comprometido, e instalar sem verificar seria confiar numa release do GitHub
  // para executar código na máquina do jogador.
  const semHash = manifesto();
  delete semHash.sha256;
  const r = parseVoiceManifest(semHash);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /sha256/);
});

test('manifesto — hash malformado aborta igual', () => {
  for (const ruim of ['', 'abc', HASH.slice(0, 63), HASH + 'a', 'z'.repeat(64), null, 123]) {
    const r = parseVoiceManifest(manifesto({ sha256: ruim }));
    assert.strictEqual(r.ok, false, `${JSON.stringify(ruim)} deveria ser recusado`);
  }
});

test('manifesto — hash em maiúsculas é aceito e normalizado', () => {
  const r = parseVoiceManifest(manifesto({ sha256: 'A'.repeat(64) }));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.manifest.sha256, HASH, 'normalizado para minúsculas');
});

test('manifesto — download por HTTP é recusado', () => {
  // O hash não protege um download por HTTP: quem troca o binário no caminho
  // troca o manifesto junto.
  const r = parseVoiceManifest(manifesto({ downloadUrl: 'http://exemplo.tld/voice.zip' }));
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /https/);
});

test('manifesto — `mandatory` só é verdadeiro quando dito', () => {
  // Um manifesto malformado não deve conseguir bloquear a entrada de ninguém:
  // voz é opcional, e "falha de voz nunca é falha de jogo" começa aqui.
  for (const v of [undefined, null, 'true', 1, 'sim']) {
    assert.strictEqual(parseVoiceManifest(manifesto({ mandatory: v })).manifest.mandatory, false);
  }
  assert.strictEqual(parseVoiceManifest(manifesto({ mandatory: true })).manifest.mandatory, true);
});

test('manifesto — lixo não derruba, devolve motivo', () => {
  for (const lixo of [null, undefined, 'texto', 42, []]) {
    const r = parseVoiceManifest(lixo);
    assert.strictEqual(r.ok, false);
    assert.ok(r.reason);
  }
});

// ── Versões ──────────────────────────────────────────────────────────────────

test('versão — comparação é numérica, não alfabética', () => {
  // Com string, "2.10.0" < "2.9.0" e o jogador ficaria preso numa versão antiga.
  assert.strictEqual(compareVersions('2.10.0', '2.9.0'), 1);
  assert.strictEqual(compareVersions('1.0.0', '1.0.1'), -1);
  assert.strictEqual(compareVersions('1.2.3', '1.2.3'), 0);
  assert.strictEqual(compareVersions('1.2', '1.2.0'), 0);
  assert.strictEqual(compareVersions('10.0.0', '9.99.99'), 1);
});

// ── Decisão ──────────────────────────────────────────────────────────────────

const parsed = parseVoiceManifest(manifesto());

test('decisão — nada instalado → install', () => {
  const d = decideVoiceAction({ parsed, installedVersion: null, exePresent: false });
  assert.strictEqual(d.action, 'install');
});

test('decisão — versão antiga → update', () => {
  const d = decideVoiceAction({ parsed, installedVersion: '1.1.0', exePresent: true });
  assert.strictEqual(d.action, 'update');
  assert.strictEqual(d.targetVersion, '1.2.0');
});

test('decisão — em dia → ok, sem baixar nada', () => {
  const d = decideVoiceAction({ parsed, installedVersion: '1.2.0', exePresent: true });
  assert.strictEqual(d.action, 'ok');
});

test('decisão — ROLLBACK: local à frente do publicado desce', () => {
  // O servidor voltou uma versão porque a nova quebrou. Chamar isto de "já está
  // atualizado" deixaria a versão quebrada rodando exatamente nas máquinas que a
  // pegaram primeiro — as de quem joga mais.
  const d = decideVoiceAction({ parsed, installedVersion: '1.3.0', exePresent: true });
  assert.strictEqual(d.action, 'update');
  assert.match(d.reason, /rollback/i);
  assert.strictEqual(d.targetVersion, '1.2.0');
});

test('decisão — carimbo sem executável → reinstall', () => {
  // Antivírus, limpeza de disco, desinstalação parcial. O carimbo diz o que FOI
  // instalado, não o que existe.
  const d = decideVoiceAction({ parsed, installedVersion: '1.2.0', exePresent: false });
  assert.strictEqual(d.action, 'reinstall');
  assert.match(d.reason, /não está no disco/);
});

test('decisão — jogador desligou a voz → skip', () => {
  const d = decideVoiceAction({ parsed, installedVersion: null, exePresent: false, voiceEnabled: false });
  assert.strictEqual(d.action, 'skip');
});

test('decisão — manifesto quebrado NÃO impede de jogar', () => {
  // A aplicação de "falha de voz nunca é falha de jogo" ao caminho de
  // distribuição. Um manifesto ruim entra sem voz; ele não segura ninguém na
  // tela do launcher.
  const ruim = parseVoiceManifest({ voiceVersion: '9.9.9' });   // sem downloadUrl
  const d = decideVoiceAction({ parsed: ruim, installedVersion: null, exePresent: false });
  assert.strictEqual(d.action, 'skip');
  assert.match(d.reason, /sem voz/);
});

test('decisão — manifesto quebrado com helper já instalado mantém o que existe', () => {
  const d = decideVoiceAction({ parsed: { ok: false, reason: 'rede fora' }, installedVersion: '1.2.0', exePresent: true });
  assert.strictEqual(d.action, 'skip');
});

test('decisão — cliente velho demais bloqueia a voz, com motivo', () => {
  // Um helper que fala um protocolo que o cliente não entende produz o sintoma
  // mais caro: conecta, autentica, e ninguém ouve ninguém.
  const comMin = parseVoiceManifest(manifesto({ minClientVersion: '2.0.0' }));
  const d = decideVoiceAction({ parsed: comMin, installedVersion: null, exePresent: false, clientVersion: '1.9.0' });
  assert.strictEqual(d.action, 'blocked');
  assert.match(d.reason, /exige cliente/);
});

test('decisão — cliente novo o bastante passa', () => {
  const comMin = parseVoiceManifest(manifesto({ minClientVersion: '2.0.0' }));
  const d = decideVoiceAction({ parsed: comMin, installedVersion: null, exePresent: false, clientVersion: '2.0.0' });
  assert.strictEqual(d.action, 'install');
});

// ── Integridade ──────────────────────────────────────────────────────────────

test('hash — igual passa, diferente reprova', () => {
  assert.strictEqual(verifyHash(HASH, HASH).ok, true);
  assert.strictEqual(verifyHash(HASH, 'b'.repeat(64)).ok, false);
});

test('hash — maiúsculas de um lado não reprovam', () => {
  assert.strictEqual(verifyHash('A'.repeat(64), 'a'.repeat(64)).ok, true);
});

test('hash — prefixo que casa NÃO passa', () => {
  // `startsWith` é o modo clássico de uma verificação parecer existir e não
  // existir.
  const quase = HASH.slice(0, 60) + 'bbbb';
  assert.strictEqual(verifyHash(HASH, quase).ok, false);
});

test('hash — vazio ou truncado reprova em vez de passar', () => {
  for (const ruim of ['', null, undefined, HASH.slice(0, 32)]) {
    assert.strictEqual(verifyHash(HASH, ruim).ok, false);
    assert.strictEqual(verifyHash(ruim, HASH).ok, false);
  }
});

// ── Início do helper ─────────────────────────────────────────────────────────

test('helper — os argumentos NÃO carregam ticket', () => {
  // O ticket é emitido pelo servidor quando o jogador digita /voz, e o launcher
  // já fechou a janela. Um ticket na linha de comando seria um ticket visível no
  // gerenciador de tarefas.
  const args = helperArgs({ controlPort: 45123, pairingToken: 'x'.repeat(32) });
  const texto = args.join(' ');
  assert.ok(!/--ticket/.test(texto), 'nenhum ticket na linha de comando');
  assert.ok(!/--actor-id/.test(texto), 'nem o ator: o helper descobre pelo canal de controle');
});

test('helper — o canal de controle é loopback e não é configurável', () => {
  const args = helperArgs({ controlPort: 45123, pairingToken: 'x'.repeat(32) });
  const i = args.indexOf('--control-host');
  assert.strictEqual(args[i + 1], '127.0.0.1');
});

test('helper — PTT é declarado, sempre', () => {
  // Um helper que não declara `ptt: true` recebe concessão de microfone aberto
  // no servidor (dívida da Etapa 3). Declarar aqui fecha a concessão para todo
  // mundo que vem pelo launcher.
  assert.ok(helperArgs({ controlPort: 1, pairingToken: 'y'.repeat(20) }).includes('--ptt'));
});

test('helper — segredo curto é recusado antes de virar argumento', () => {
  assert.throws(() => helperArgs({ controlPort: 45123, pairingToken: 'curto' }), /pairingToken/);
});

test('helper — porta inválida é recusada', () => {
  for (const porta of [0, -1, 70000, 1.5, null, 'abc']) {
    assert.throws(() => helperArgs({ controlPort: porta, pairingToken: 'z'.repeat(32) }), /controlPort/);
  }
});

test('helper — o pid do launcher vai junto, para a guarda de órfão', () => {
  // `detached: false` não mata o helper quando o launcher morre no Windows. Se
  // o pid não for passado, um launcher derrubado à força deixa para trás um
  // processo sem janela que abriu o microfone — e nenhum caminho de saída do
  // `main.ts` roda para limpá-lo.
  const args = helperArgs({ controlPort: 45123, pairingToken: 'x'.repeat(32), parentPid: 4242 });
  const i = args.indexOf('--parent-pid');
  assert.ok(i >= 0, 'o argumento precisa existir');
  assert.strictEqual(args[i + 1], '4242');
});

test('helper — sem pid válido, a guarda simplesmente não é pedida', () => {
  // Passar `--parent-pid 0` seria pior que omitir: o helper trataria "não existe
  // processo 0" como "o launcher morreu" e sairia antes de qualquer pareamento.
  for (const pid of [undefined, 0, -1, 1.5, null, 'abc']) {
    const args = helperArgs({ controlPort: 45123, pairingToken: 'x'.repeat(32), parentPid: pid });
    assert.ok(!args.includes('--parent-pid'), `pid ${String(pid)} não deveria virar argumento`);
  }
});

test('helper — os argumentos são exatamente os que o main.cpp aceita', () => {
  // Este teste existe por um defeito real: até 2026-08-14 o `helperArgs`
  // montava `--control-host/--control-port/--pair/--log-level/--ptt` e o
  // `voice-helper/src/main.cpp` não conhecia NENHUM deles. O helper saía com
  // código 2 em toda execução vinda do launcher, e o launcher reportava
  // sucesso.
  //
  // A lista abaixo é a do `ParseArgs` do main.cpp. Quando um lado mudar sem o
  // outro, é aqui que se descobre — e não numa sessão de teste com jogadores.
  const aceitos = new Set([
    '--control-host', '--control-port', '--pair', '--pair-ttl', '--parent-pid',
    '--ptt', '--log-level', '--actor-id', '--ticket', '--host', '--port'
  ]);
  const args = helperArgs({ controlPort: 45123, pairingToken: 'x'.repeat(32), parentPid: 99 });
  for (const a of args) {
    if (a.startsWith('--')) {
      assert.ok(aceitos.has(a), `${a} não existe no ParseArgs do voice-helper/src/main.cpp`);
    }
  }
});

// ── Config para a CEF ────────────────────────────────────────────────────────

test('config do cliente — carrega o canal e o segredo, e nada de servidor', () => {
  const c = voiceConfigForClient({
    controlPort: 45123, pairingToken: 'k'.repeat(32),
    voiceVersion: '1.2.0', helperRunning: true
  });
  assert.strictEqual(c.voice.helperControlUrl, 'http://127.0.0.1:45123/ticket');
  assert.strictEqual(c.voice.pairingToken, 'k'.repeat(32));
  assert.strictEqual(c.voice.pushToTalk, true);

  const texto = JSON.stringify(c);
  assert.ok(!/LIVEKIT/i.test(texto), 'nada de LiveKit no config do cliente');
  assert.ok(!/secret/i.test(texto), 'nenhuma credencial de servidor');
});

// ── Desligamento ─────────────────────────────────────────────────────────────

test('desligamento — o helper morre ANTES do jogo', () => {
  // Ele segura o microfone pelo WASAPI. Deixá-lo vivo depois de o jogo fechar é
  // um processo invisível com o microfone aberto.
  assert.deepStrictEqual(shutdownOrder(), ['voice-helper', 'game']);
});

// ── Preferências locais ──────────────────────────────────────────────────────

test('preferências — só o que é preferência de máquina sobrevive', () => {
  const p = sanitizeVoicePreferences({
    enabled: true, inputDeviceId: 'wasapi://mic-1', outputVolume: 0.8, inputGain: 1.2,
    // Coisas que um launcher não guarda.
    ticket: 'abc', lastSpokeWith: [1, 2, 3], transcript: 'oi'
  });
  assert.deepStrictEqual(Object.keys(p).sort(), ['enabled', 'inputDeviceId', 'inputGain', 'outputVolume', 'pushToTalk']);
  assert.ok(!('ticket' in p));
  assert.ok(!('lastSpokeWith' in p), 'histórico de com quem falou seria registro de conversa');
});

test('preferências — volume e ganho são limitados a 0..1', () => {
  const p = sanitizeVoicePreferences({ outputVolume: 99, inputGain: -5 });
  assert.strictEqual(p.outputVolume, 1);
  assert.strictEqual(p.inputGain, 0);
});

test('preferências — PTT não é preferência, é política', () => {
  const p = sanitizeVoicePreferences({ pushToTalk: false });
  assert.strictEqual(p.pushToTalk, true, 'o jogador não pode desligar o PTT pelo arquivo de preferências');
});

test('preferências — id de dispositivo tem teto', () => {
  const p = sanitizeVoicePreferences({ inputDeviceId: 'x'.repeat(5000) });
  assert.strictEqual(p.inputDeviceId.length, 256);
});

test('preferências — entrada vazia produz padrões seguros', () => {
  const p = sanitizeVoicePreferences(null);
  assert.strictEqual(p.enabled, true);
  assert.strictEqual(p.outputVolume, 1);
  assert.strictEqual(p.pushToTalk, true);
  assert.strictEqual(p.inputDeviceId, null);
});
