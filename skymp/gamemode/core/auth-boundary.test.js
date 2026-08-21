const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..', '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

// `skymp/server/` inteiro é ignorado pelo `.gitignore` (linha 29), então o
// `server-settings.json` de runtime não existe em clone limpo. O teste antigo
// juntava as duas verificações numa só e lia esse arquivo, o que fazia a suíte
// passar na máquina de quem já rodou o servidor e falhar na CI desde 12/08 —
// quatro execuções seguidas vermelhas na `main`.
//
// O nome dele dizia "runtime versionado", e o arquivo que ele lia não é
// versionado. São duas perguntas diferentes e viraram dois testes: uma sobre o
// que o repositório promete, que sempre roda; outra sobre o que esta máquina
// vai subir, que só existe onde há o que conferir.

test('auth boundary — nenhuma configuração versionada usa offlineMode', () => {
  for (const arquivo of [
    'skymp/config/server-settings.local.example.json',
    'skymp/config/server-settings.staging.example.json'
  ]) {
    const cfg = JSON.parse(read(arquivo));
    assert.equal(cfg.offlineMode, false, `${arquivo} usa offlineMode`);
    assert.equal(typeof cfg.master, 'string', `${arquivo} não declara master`);
    assert.ok(cfg.master.length > 0, `${arquivo} tem master vazio`);
  }
});

test('auth boundary — o server-settings desta máquina não usa offlineMode', (t) => {
  const runtime = path.join(repoRoot, 'skymp/server/server-settings.json');

  // Pular é honesto aqui, e aparece na saída: em clone limpo não há
  // configuração de runtime, então não há nada a afirmar sobre ela.
  if (!fs.existsSync(runtime)) {
    t.skip('skymp/server/server-settings.json não existe (é ignorado pelo git)');
    return;
  }

  assert.equal(JSON.parse(fs.readFileSync(runtime, 'utf8')).offlineMode, false);
});

test('auth boundary — Master API resolve a sessão para accountId', () => {
  const web = read('apps/web/server.js');

  assert.match(web, /SELECT id, account_id, character_id, discord_id FROM game_sessions/);
  assert.match(web, /user:\s*\{\s*id:\s*rows\[0\]\.account_id/);
  assert.doesNotMatch(web, /user:\s*\{\s*id:\s*rows\[0\]\.discord_id/);
});

test('auth boundary — sessão inválida não possui fallback para identidade do cliente', () => {
  const web = read('apps/web/server.js');
  const sessionRouteStart = web.indexOf("app.get('/api/servers/:masterKey/sessions/:session'");
  const launcherSection = web.indexOf('// ── API: Launcher', sessionRouteStart);

  assert.ok(sessionRouteStart >= 0, 'rota Master API não encontrada');
  assert.ok(launcherSection > sessionRouteStart, 'fim da rota Master API não encontrado');
  const route = web.slice(sessionRouteStart, launcherSection);

  assert.match(route, /rows\.length === 0\) return res\.status\(404\)/);
  assert.doesNotMatch(route, /req\.(body|query).*profileId/);
});

test('auth boundary — launcher online injeta sessão opaca e remove profileId da config principal', () => {
  const launcher = read('apps/launcher/electron/main.ts');

  assert.match(launcher, /config\.session\s*=\s*`ticket:\$\{ticket \|\| ''\}`/);
  assert.match(launcher, /delete config\.profileId/);
});

test('auth boundary — AUTH-01 fechado: launcher não escreve mais profileId legado', () => {
  // Invertido conforme o próprio plano do teste anterior: o fluxo online agora
  // remove `gameData.profileId` em vez de gravá-lo. Ver o comentário AUTH-01/
  // AUTH-003 em apps/launcher/electron/main.ts, junto de `delete`.
  const launcher = read('apps/launcher/electron/main.ts');

  assert.match(launcher, /delete clientSettings\.gameData\.profileId/);
  assert.doesNotMatch(launcher, /clientSettings\.gameData\.profileId\s*=/);
  assert.match(launcher, /clientSettings\.gameData\.launcherTicket\s*=/);
});

test('auth boundary — consumo do launch ticket é um UPDATE condicional atômico', () => {
  const gameApi = read('apps/game-api/server.js');
  const start = gameApi.indexOf('async function consumeLaunchTicket');
  const end = gameApi.indexOf('async function isEligible', start);
  assert.ok(start >= 0 && end > start, 'consumeLaunchTicket não encontrado');
  const implementation = gameApi.slice(start, end);

  assert.match(implementation, /UPDATE launch_tickets SET consumed_at = NOW\(\)/);
  assert.match(implementation, /consumed_at IS NULL AND expires_at > NOW\(\)/);
  assert.match(implementation, /result\.affectedRows !== 1/);
  assert.doesNotMatch(implementation, /SELECT[\s\S]+consumed_at[\s\S]+UPDATE launch_tickets/);
});
