/**
 * parked-staff-permissions.test.js
 *
 * Os três comandos de staff que sobraram dos serviços PARKED — `/addrecipe`,
 * `/addingredient` (crafting) e `/settax` (economy-regional) — passavam um
 * **nível numérico** para `hasPermission`, herança de um modelo de permissões
 * que não existe mais. Como `permissions` é um `Set` de strings, `Set.has(20)`
 * é sempre `false`: a checagem nunca explodia e negava tudo em silêncio,
 * inclusive para `owner`. Ver `PARKED_SERVICES_DECISION.md` §7.4.
 *
 * Por que este arquivo existe separado do `permissions.behavior.test.js`:
 * aquele cobre os handlers exportados pelo `admin-service`, e o próprio teste
 * "a matriz cobre todo comando de staff que existe" só enxerga aquele módulo.
 * Estes três handlers moram em outros arquivos, então nasceram fora do alcance
 * da matriz — que é exatamente como o bug do nível numérico sobreviveu a uma
 * suíte inteira.
 *
 * A forma é a mesma, e pelo mesmo motivo: cargo × ação, chamando o handler real
 * e olhando o **efeito colateral**, nunca o retorno. `addIngredient` e
 * `setTaxRate` devolvem `undefined` no sucesso e na negação — um teste de
 * retorno não protegeria nada aqui.
 *
 * Mutações verificadas (aplicadas e executadas, não só previstas):
 *
 *   1. Apagar a checagem de `addRecipe` → `nenhum` e `moderator` passam a criar
 *      receita. **Reprova 2.**
 *   2. O mesmo em `addIngredient`. **Reprova 2.**
 *   3. O mesmo em `setTaxRate`. **Reprova 2.**
 *   4. Voltar `addIngredient` ao nível numérico `20` → `admin` e `owner` param
 *      de conseguir, e a varredura estática acha a linha. **Reprova 3.**
 *   5. Dar `manage_recipes` ao `moderator` em `ROLE_PERMISSIONS` → obriga quem
 *      fez a declarar a mudança na MATRIZ. **Reprova 3.**
 *
 * Executa com: node --test parked-staff-permissions.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { describe, it } = require('node:test');

const STAFF_ACTOR_ID = 0xff00c001;
const STAFF_ACCOUNT_ID = 31;

// ─────────────────────────────────────────────────────────────────────────────
// Estado observável
// ─────────────────────────────────────────────────────────────────────────────

let receitasInseridas = [];
let ingredientesInseridos = [];
let impostosDefinidos = [];
let auditoria = [];
let staffRoleRow = null;

function resetState() {
  receitasInseridas = [];
  ingredientesInseridos = [];
  impostosDefinidos = [];
  auditoria = [];
}

function responder(sql, params = []) {
  if (/SELECT role FROM staff_roles/i.test(sql)) {
    return staffRoleRow ? [staffRoleRow] : [];
  }
  if (/INSERT INTO crafting_recipes/i.test(sql)) {
    receitasInseridas.push({ name: params[0], station: params[1] });
    return { insertId: 900 + receitasInseridas.length };
  }
  if (/INSERT INTO crafting_ingredients/i.test(sql)) {
    ingredientesInseridos.push({ recipeId: params[0], baseId: params[1], count: params[2] });
    return {};
  }
  if (/UPDATE holds SET tax_rate/i.test(sql)) {
    impostosDefinidos.push({ rate: params[0], holdId: params[1] });
    return {};
  }
  if (/INSERT INTO audit_logs/i.test(sql)) {
    auditoria.push({ action: params[0], details: params[3] });
    return {};
  }
  return [];
}

const Module = require('module');
const originalLoad = Module._load;

Module._load = function (request) {
  if (request.endsWith('/database') || request === './database') {
    return {
      init: () => {},
      close: async () => {},
      query: async (sql, params = []) => responder(sql, params),
      getConnection: async () => ({
        query: async (sql, params = []) => [responder(sql, params), []],
        beginTransaction: async () => {},
        commit: async () => {},
        rollback: async () => {},
        release: () => {}
      })
    };
  }
  if (request === './commands' || request.endsWith('/commands')) {
    return {
      sendNotification: () => {},
      broadcastProximityMessage: () => {},
      registerCommand: () => {},
      unregisterCommand: () => {},
      getActiveCharacterData: (actorId) =>
        actorId === STAFF_ACTOR_ID ? { accountId: STAFF_ACCOUNT_ID, characterId: 1, name: 'Staff' } : null
    };
  }
  return originalLoad.apply(this, arguments);
};

// `economy-regional.js` agenda um `setInterval` no corpo do módulo (recarga do
// cache de preços a cada 5 min). Sem interceptar, o timer segura o event loop e
// o `node --test` nunca termina — o mesmo sintoma que o `database.js` sem
// `close()` já produziu no `test:systems`.
const timersDoModulo = [];
const setIntervalOriginal = global.setInterval;
global.setInterval = (...args) => {
  const handle = setIntervalOriginal(...args);
  timersDoModulo.push(handle);
  if (handle && typeof handle.unref === 'function') handle.unref();
  return handle;
};

global.mp = {
  callPapyrusFunction: () => null,
  get: () => null,
  set: () => {},
  getDescFromId: (actorId) => `desc-${actorId}`
};

const admin = require('./admin-service');
const crafting = require('./crafting-service');
const economyRegional = require('./economy-regional');

global.setInterval = setIntervalOriginal;
for (const handle of timersDoModulo) clearInterval(handle);
Module._load = originalLoad;
delete global.mp;

// ─────────────────────────────────────────────────────────────────────────────
// A matriz. Escrita à mão, como a do `permissions.behavior.test.js`.
// ─────────────────────────────────────────────────────────────────────────────

const ACOES = {
  addRecipe: {
    permissao: 'manage_recipes',
    invoca: () => crafting.addRecipe(STAFF_ACTOR_ID, 'forge', 0x1398a, 1, 'Espada de Aco'),
    aconteceu: () => receitasInseridas.length > 0
  },
  addIngredient: {
    permissao: 'manage_recipes',
    invoca: () => crafting.addIngredient(STAFF_ACTOR_ID, 901, 0x5ace, 2),
    aconteceu: () => ingredientesInseridos.length > 0
  },
  setTaxRate: {
    permissao: 'set_gold',
    invoca: () => economyRegional.setTaxRate(STAFF_ACTOR_ID, 'whiterun', 0.15),
    aconteceu: () => impostosDefinidos.length > 0
  }
};

/**
 * `true` = o cargo PODE. `false` = precisa ser negado.
 *
 * Mudou aqui? Você está mudando quem reforma a economia do servidor. Diga o
 * porquê no corpo do commit.
 *
 * Nenhuma das três é de moderador. Receita é casa da moeda (todo jogador usa,
 * quantas vezes quiser) e imposto move ouro de todo mundo — as duas são do
 * mesmo andar de `add_item` e `set_gold`, que o moderador também não tem.
 */
const MATRIZ = {
  //               sem cargo       moderator       admin        owner
  addRecipe:     { nenhum: false, moderator: false, admin: true, owner: true },
  addIngredient: { nenhum: false, moderator: false, admin: true, owner: true },
  setTaxRate:    { nenhum: false, moderator: false, admin: true, owner: true }
};

const CARGOS = ['nenhum', 'moderator', 'admin', 'owner'];

async function comCargo(cargo) {
  resetState();
  admin.removeStaffRole(STAFF_ACTOR_ID);
  staffRoleRow = cargo === 'nenhum' ? null : { role: cargo };
  await admin.registerStaffRole(STAFF_ACTOR_ID, STAFF_ACCOUNT_ID);
}

// ─────────────────────────────────────────────────────────────────────────────
// Testes
// ─────────────────────────────────────────────────────────────────────────────

describe('comandos de staff dos servicos PARKED — matriz de permissao', () => {
  for (const [nomeAcao, acao] of Object.entries(ACOES)) {
    for (const cargo of CARGOS) {
      const permitido = MATRIZ[nomeAcao][cargo];

      it(`${cargo} ${permitido ? 'PODE' : 'NAO PODE'} ${nomeAcao}`, async () => {
        await comCargo(cargo);
        await acao.invoca();

        if (permitido) {
          assert.equal(
            acao.aconteceu(), true,
            `${cargo} deveria conseguir ${nomeAcao} (permissao '${acao.permissao}'), e a acao nao teve efeito. ` +
            `Se voltou a passar nivel numerico, hasPermission nega em silencio — foi o bug original.`
          );
        } else {
          assert.equal(
            acao.aconteceu(), false,
            `${cargo} NAO deveria conseguir ${nomeAcao}, mas a acao aconteceu. ` +
            `Escalacao de privilegio: o handler provavelmente nao chama hasPermission('${acao.permissao}').`
          );
        }
      });
    }
  }
});

describe('a permissao nomeada existe de verdade', () => {
  it('manage_recipes e conhecida — nao e uma porta que nunca abre', async () => {
    await comCargo('admin');
    assert.equal(
      admin.hasPermission(STAFF_ACTOR_ID, 'manage_recipes'), true,
      'admin deveria ter manage_recipes; permissao desconhecida nega sempre e o log grita'
    );
  });

  it('moderador nao herda manage_recipes', async () => {
    await comCargo('moderator');
    assert.equal(admin.hasPermission(STAFF_ACTOR_ID, 'manage_recipes'), false);
  });

  it('setTaxRate ainda grava audit_logs quando permitido', async () => {
    await comCargo('owner');
    await economyRegional.setTaxRate(STAFF_ACTOR_ID, 'whiterun', 0.2);
    assert.ok(
      auditoria.some(e => e.action === 'economy:setTax'),
      'mexer no imposto sem rastro em audit_logs seria pior que negar'
    );
  });
});

/**
 * Guarda estática. A matriz acima prova o comportamento dos três handlers que
 * conhecemos; esta varredura pega o **quarto** — alguém que copie o padrão
 * antigo para um arquivo novo, ou que reverta um destes num merge.
 *
 * O `hasPermission` já grita no log quando recebe número, mas log só ajuda quem
 * está lendo o log na hora, e estes serviços estão PARKED justamente porque
 * ninguém os está olhando.
 */
describe('nenhum nivel numerico sobrou no gamemode', () => {
  it('nenhum arquivo passa numero para hasPermission', () => {
    const raiz = __dirname;
    const numerico = /hasPermission\s*\(\s*[^,)]+,\s*\d+\s*\)/;
    const encontrados = [];

    const varrer = (dir) => {
      for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entrada.name === 'node_modules') continue;
        const alvo = path.join(dir, entrada.name);
        if (entrada.isDirectory()) {
          varrer(alvo);
          continue;
        }
        if (!entrada.name.endsWith('.js')) continue;
        // Só código de produção. A classe de bug é sítio de chamada real; os
        // testes que existem sobre ela (`admin-service.test.js`,
        // `permissions.behavior.test.js`) passam `20` de propósito, para provar
        // que a chamada errada nega e grita. Varrê-los reprovaria o guard
        // justamente por causa dos testes que guardam a mesma coisa.
        if (entrada.name.endsWith('.test.js')) continue;

        const conteudo = fs.readFileSync(alvo, 'utf8');
        for (const [i, linha] of conteudo.split('\n').entries()) {
          const inicio = linha.trimStart();
          if (inicio.startsWith('*')) continue;  // continuação de comentário de bloco
          // ...e comentário de linha, pelo mesmo motivo. O que este guard caça é
          // SÍTIO DE CHAMADA, e prosa não executa: `core/permissions.js` explica
          // a classe de bug citando `hasPermission(actorId, 20)` textualmente, e
          // ser reprovado por documentar o defeito que se está consertando é o
          // tipo de falso positivo que faz alguém afrouxar o guard inteiro.
          // Comentário no FIM de uma linha de código continua sendo varrido.
          if (inicio.startsWith('//')) continue;
          if (numerico.test(linha)) {
            encontrados.push(`${path.relative(raiz, alvo)}:${i + 1}`);
          }
        }
      }
    };

    varrer(raiz);

    assert.deepEqual(
      encontrados, [],
      `Nivel numerico de permissao encontrado em: ${encontrados.join(', ')}. ` +
      `hasPermission compara contra um Set de strings — numero nega sempre, para todo mundo, ` +
      `inclusive owner. Use um nome de ROLE_PERMISSIONS.`
    );
  });
});
