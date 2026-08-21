/**
 * A promessa "não gravamos voz" só vale enquanto alguma coisa a verifica.
 *
 * Este arquivo lê o código de voz de verdade — servidor e cliente — e reprova se
 * aparecer qualquer caminho capaz de gravar, persistir ou registrar o CONTEÚDO
 * de uma conversa. Não é análise estática de verdade e não pretende ser: é uma
 * varredura de padrões, e o que ela garante é que a introdução de um deles seja
 * uma decisão explícita de quem também apaga o teste, e não um efeito colateral
 * de copiar um exemplo da internet.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const VOICE_DIR = __dirname;
const UI_HTML = path.join(__dirname, '..', '..', '..', 'ui', 'index.html');
const VOIP_SERVICE = path.join(__dirname, '..', '..', 'voip-service.js');

/**
 * Tira comentários de linha e de bloco.
 *
 * Os comentários deste projeto **precisam** citar o que é proibido — é onde está
 * registrado por que `use-fake-device-for-media-stream` foi recusado e por que
 * `'radio'` derrubou a voz de alguém em silêncio. Uma varredura que não separe
 * comentário de código transformaria a documentação da decisão na prova de que
 * ela foi violada.
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/<!--[\s\S]*?-->/g, '');
}

function voiceSources() {
  const files = fs.readdirSync(VOICE_DIR)
    .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))
    .map((f) => [path.join('core/voice', f), fs.readFileSync(path.join(VOICE_DIR, f), 'utf8')]);
  files.push(['voip-service.js', fs.readFileSync(VOIP_SERVICE, 'utf8')]);
  files.push(['ui/index.html', fs.readFileSync(UI_HTML, 'utf8')]);
  return files.map(([name, src]) => [name, stripComments(src)]);
}

test('privacidade — nenhum caminho de gravação de mídia existe no código de voz', () => {
  // `MediaRecorder` e `createMediaStreamDestination` são as duas formas de
  // transformar um stream em bytes guardáveis no navegador. `getDisplayMedia`
  // captura tela. Nenhuma tem uso legítimo aqui.
  const forbidden = [
    /\bMediaRecorder\b/,
    /createMediaStreamDestination/,
    /getDisplayMedia/,
    /\bstartRecording\b/i
  ];

  const offenders = [];
  for (const [name, src] of voiceSources()) {
    for (const pattern of forbidden) {
      if (pattern.test(src)) offenders.push(`${name}: ${pattern}`);
    }
  }
  assert.deepStrictEqual(offenders, [], `caminho de gravação encontrado:\n${offenders.join('\n')}`);
});

test('privacidade — nenhum pedido de vídeo, em nenhuma forma', () => {
  const offenders = [];
  for (const [name, src] of voiceSources()) {
    // `video: true` num getUserMedia, ou `camera` numa lista de fontes
    // publicáveis. Os dois são o mesmo erro visto de dois lados.
    if (/video\s*:\s*true/.test(src)) offenders.push(`${name}: video: true`);
    if (/canPublishSources[\s\S]{0,80}camera/.test(src)) offenders.push(`${name}: camera em canPublishSources`);
  }
  assert.deepStrictEqual(offenders, []);
});

test('privacidade — as flags de mídia que os forks usam não aparecem', () => {
  // Registradas em SKYVOICE_LIVEKIT_AUDIT.md §5.5: cada uma abre microfone E
  // câmera para qualquer origem. A auditoria as recusou por escrito; este teste
  // é o que impede alguém de reintroduzi-las copiando o patch de um fork.
  const flags = [
    'auto-accept-camera-and-microphone-capture',
    'use-fake-ui-for-media-stream',
    'use-fake-device-for-media-stream',
    'disable-web-security',
    'enable-media-stream'
  ];
  const offenders = [];
  for (const [name, src] of voiceSources()) {
    for (const flag of flags) {
      if (src.includes(flag)) offenders.push(`${name}: ${flag}`);
    }
  }
  assert.deepStrictEqual(offenders, [], `flag de mídia insegura no código:\n${offenders.join('\n')}`);
});

test('privacidade — o quadro de áudio nunca é escrito em disco', () => {
  // O relay legado passa PCM em base64 por variáveis. O risco é alguém
  // "debugar" gravando o buffer. Procura escrita de arquivo na vizinhança
  // sintática de um nome de variável de áudio.
  const offenders = [];
  for (const [name, src] of voiceSources()) {
    const writes = src.match(/(writeFileSync|createWriteStream|appendFileSync)\s*\([^)]*\)/g) || [];
    for (const w of writes) {
      if (/audio|pcm|frame|voice|opus|sample/i.test(w)) offenders.push(`${name}: ${w}`);
    }
  }
  assert.deepStrictEqual(offenders, [], `escrita de áudio em disco:\n${offenders.join('\n')}`);
});

test('privacidade — o contrato declarado bate com o que o código faz', () => {
  const { PRIVACY } = require('./voice-security');
  assert.strictEqual(PRIVACY.recordsAudio, false);
  assert.strictEqual(PRIVACY.persistsFrames, false);
  assert.strictEqual(PRIVACY.logsAudioContent, false);
  assert.strictEqual(PRIVACY.cameraForbidden, true);
  assert.strictEqual(PRIVACY.pttByDefault, true);
  assert.strictEqual(PRIVACY.showsMicActive, true);
});

test('privacidade — PTT é o padrão do servidor, não uma opção do cliente', () => {
  const policy = fs.readFileSync(path.join(VOICE_DIR, 'voice-policy.js'), 'utf8');
  // `transmitting` nasce false em voice-state e só a policy o liga. Se algum dia
  // o padrão virar "microfone aberto", este teste é o que reclama.
  const state = fs.readFileSync(path.join(VOICE_DIR, 'voice-state.js'), 'utf8');
  assert.ok(/transmitting:\s*false/.test(state), 'o estado inicial precisa ser não-transmitindo');
  assert.ok(/pttDown/.test(policy), 'a concessão de PTT precisa passar pela política');
});

test('privacidade — não existe rádio, em nenhum arquivo de voz', () => {
  // A regra vale para o sistema inteiro, não só para o HUD (que já tinha o seu).
  //
  // `frequency` sozinho NÃO entra na lista, e a razão é concreta: é o nome do
  // `AudioParam` do `BiquadFilterNode`, que o pipeline de efeitos usa para a
  // passa-baixa da mordaça. Proibi-lo reprovaria o áudio espacial legítimo e
  // ensinaria a próxima pessoa a apagar o teste em vez de ler o motivo. O que é
  // rádio é a palavra em português e os nomes de canal/serviço.
  const offenders = [];
  for (const [name, src] of voiceSources()) {
    for (const word of [
      /\bVoiceRadioService\b/,
      /\bradioChannel\b/,
      /\bradioFrequency\b/i,
      /\bfrequência\b/i,
      /\bvoiceChannel\b/
    ]) {
      if (word.test(src)) offenders.push(`${name}: ${word}`);
    }
  }
  assert.deepStrictEqual(offenders, [], `conceito de rádio no código de voz:\n${offenders.join('\n')}`);
});
