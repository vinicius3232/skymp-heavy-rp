/**
 * crafting-service.js
 * Sistema de Crafting Modular (Fase Beta).
 *
 * Funciona 100% server-side:
 * - O cliente envia a intenção de craftar (/craft [recipeId]).
 * - O servidor consome os ingredientes e entrega o resultado numa transação só.
 *
 * ⚠️ **O que este cabeçalho afirmava e não era verdade.** Até 13/08/2026 esta
 * lista dizia *"o servidor valida ingredientes, station proximity e perks"*.
 * Ingrediente sim, pelo `FOR UPDATE`. **Proximidade de estação: nunca** — o
 * `craftItem` sequer carregava a estação, então `/craft` funcionava do outro
 * lado do mapa. **Perk: nunca** — `requires_perk` é lido em `listRecipes` e
 * nunca comparado com nada.
 *
 * Hoje o `craftItem` confere que a estação **declarada** é a da receita, que é
 * uma regra de verdade e não é proximidade. Perk e proximidade continuam sem
 * validação, e agora estão escritos como ausentes em vez de anunciados como
 * presentes. Ver `docs/research/INVENTORY_TRADE_CRAFTING_AUDIT.md` §11 e
 * `docs/gameplay/CRAFTING_SYSTEM.md` §5.
 *
 * Registrado em `core/module-registry.js` como módulo `crafting` (fase `lab`,
 * `ENABLE_CRAFTING_SERVICE`, nasce desligado). A migração abaixo era de
 * segurança interna e ficou separada da decisão de reativar de propósito — a
 * mistura das duas é o erro que a Fase 2 do QA_REPORT existe pra não repetir.
 * Ver docs/technical/PARKED_SERVICES_DECISION.md §7.2 para o histórico.
 *
 * ─── Gate de profissão (20/08/2026) ─────────────────────────────────────────
 *
 * `crafting_recipes.required_profession`/`required_rank`
 * (migration-v20-crafting-profession-gate.sql) são checados dentro de
 * `craftItem()`, no mesmo desenho que `resource_nodes.required_profession` já
 * usa contra `profession-service.js`. NULL continua liberado pra qualquer
 * personagem — nenhuma receita hoje tem o campo preenchido, então isto não
 * muda comportamento sozinho; é a staff que passa a poder amarrar uma receita
 * a `blacksmith`, `smelter`, `tanner`, `enchanter` ou `cook` via `/addrecipe`.
 * `requires_perk` continua sem uso — não é este o campo que este gate lê.
 *
 * ─── Por que este arquivo mudou ──────────────────────────────────────────────
 *
 * O `craftItem` anunciava `// 4. Consome ingredientes (transação segura: tudo
 * ou nada)` e não era nenhuma das duas coisas. Era um laço de
 * `inventoryService.removeItem()` independentes seguido de um `giveItem()`, e
 * cada uma dessas funções **abre a própria transação** no transaction-service.
 * Uma receita de três ingredientes eram quatro transações separadas: se a
 * segunda falhasse, a primeira já tinha commitado, o jogador perdia o
 * ingrediente e não recebia nada.
 *
 * É `economy-service.transfer` (`removeGold` seguido de `addGold`, sem
 * transação) com outro substantivo — o mesmo defeito que motivou apagar aquele
 * arquivo, transposto de ouro para item.
 *
 * A Fase 3 (07/08/2026) juntou tudo numa transação pelas primitivas `tx.*`. Em
 * 13/08/2026 o mesmo fluxo passou a ser **uma chamada** de
 * `core/inventory.exchange`, com duas pernas: o consumo (personagem →
 * `system:consume`) e a entrega (`system:craft` → personagem). O ganho sobre a
 * versão anterior não é atomicidade — aquela já estava certa — e sim que o
 * outro lado de cada movimento passa a ter nome no razão, e que a chave de
 * idempotência deixou de ser inútil (ver o passo 4 do `craftItem`).
 */

const db = require('./database');
const commands = require('./commands');
const inventory = require('./core/inventory');
const professionService = require('./profession-service');
const serverOptions = require('./core/server-options');
const MODULE = 'crafting';

// Tipos de estação e seus formDescs (objetos de referência do Skyrim)
// Esses IDs são verificados por proximidade (futuro: mp.get distance)
const STATION_TYPES = ['forge', 'cooking_pot', 'tanning_rack', 'alchemy_lab', 'enchanting_table'];

/**
 * Lista as receitas disponíveis para um tipo de estação.
 */
async function listRecipes(actorId, stationType) {
  if (!STATION_TYPES.includes(stationType)) {
    if (typeof mp !== 'undefined') mp.callPapyrusFunction('global', 'Debug', 'notification', null, ['Tipo de estação inválido.']);
    return [];
  }

  const recipes = await db.query(
    'SELECT id, name, result_base_id, result_count, requires_perk FROM crafting_recipes WHERE station_type = ?',
    [stationType]
  );

  if (recipes.length === 0) {
    if (typeof mp !== 'undefined') mp.callPapyrusFunction('global', 'Debug', 'notification', null, [`Nenhuma receita disponível em ${stationType}.`]);
    return [];
  }

  const summary = recipes.map(r => `[${r.id}] ${r.name}`).join(' | ');
  if (typeof mp !== 'undefined') mp.callPapyrusFunction('global', 'Debug', 'notification', null, [summary]);
  return recipes;
}

/**
 * Executa um craft. /craft [recipeId] [estacao].
 *
 * @param {number} actorId
 * @param {number} characterId
 * @param {number|string} recipeId
 * @param {object} [opts]
 * @param {string} [opts.stationType] estação em que o jogador diz estar
 * @param {string} [opts.requestId]   chave de idempotência vinda de quem pediu
 */
async function craftItem(actorId, characterId, recipeId, opts = {}) {
  // 1. Carrega a receita
  const recipeRows = await db.query('SELECT * FROM crafting_recipes WHERE id = ?', [recipeId]);
  if (recipeRows.length === 0) {
    if (typeof mp !== 'undefined') mp.callPapyrusFunction('global', 'Debug', 'notification', null, ['Receita não encontrada.']);
    return false;
  }
  const recipe = recipeRows[0];

  // 2. A estacao declarada precisa ser a da receita.
  //
  // Isto NAO e proximidade: o servidor nao sabe onde estao as forjas do mundo,
  // e nenhuma tabela guarda isso. O que esta checagem impede e forjar uma
  // espada no caldeirao de cozinha — e ela existe agora porque o cabecalho
  // deste arquivo afirmava, desde julho, que o servidor validava "station
  // proximity", e nada no `craftItem` chegava perto de fazer isso
  // (auditoria §11). Proximidade real depende do resolvedor de alvo `object`,
  // que o Interaction Framework ainda nao tem — ver
  // docs/gameplay/CRAFTING_SYSTEM.md §5.
  if (opts.stationType && opts.stationType !== recipe.station_type) {
    if (typeof mp !== 'undefined') {
      mp.callPapyrusFunction('global', 'Debug', 'notification', null, [
        `Esta receita e feita em: ${recipe.station_type}.`
      ]);
    }
    return false;
  }

  // 2.5. Gate de profissão/rank — checado de verdade, ao contrário de
  // `requires_perk` (ver o cabeçalho deste arquivo). NULL = receita livre.
  if (recipe.required_profession) {
    const tem = await professionService.hasProfession(characterId, recipe.required_profession);
    if (!tem) {
      if (typeof mp !== 'undefined') {
        mp.callPapyrusFunction('global', 'Debug', 'notification', null, [
          `Você precisa ser ${recipe.required_profession} para fazer isso.`
        ]);
      }
      return false;
    }
    if (recipe.required_rank !== null && recipe.required_rank !== undefined) {
      const estado = await professionService.getProfessionState(characterId, recipe.required_profession);
      if (!estado || estado.rank < recipe.required_rank) {
        if (typeof mp !== 'undefined') {
          mp.callPapyrusFunction('global', 'Debug', 'notification', null, [
            `Seu rank de ${recipe.required_profession} ainda não é suficiente para esta receita.`
          ]);
        }
        return false;
      }
    }
  }

  // 3. Carrega os ingredientes
  const ingredients = await db.query('SELECT base_id, count FROM crafting_ingredients WHERE recipe_id = ?', [recipeId]);
  if (ingredients.length === 0) {
    // Receita sem ingrediente cadastrado criaria item do nada. `addRecipe` e
    // `addIngredient` sao dois comandos separados, entao a janela entre os dois
    // existe de verdade — e um craft nela seria duplicacao de item pela staff.
    if (typeof mp !== 'undefined') mp.callPapyrusFunction('global', 'Debug', 'notification', null, ['Receita incompleta: nenhum ingrediente cadastrado.']);
    return false;
  }

  // 4. A chave de idempotencia.
  //
  // Ela continha `Date.now()`, e por isso nunca deduplicou nada: dois `/craft`
  // seguidos produziam duas chaves diferentes, o `UNIQUE` nao era violado e o
  // craft acontecia duas vezes — enquanto o comentario ali afirmava o
  // contrario (auditoria §5). Uma chave de idempotencia vem de QUEM PEDE, ou
  // de um estado estavel. Nunca do relogio de quem executa.
  const requestId = opts.requestId || inventory.newRequestId(`craft.${characterId}.${recipeId}`);

  // 5. Consome ingredientes e entrega o resultado — UMA transacao, duas pernas.
  //
  // A checagem de estoque nao precisa de passo proprio: o `applyStackDelta` le
  // com `FOR UPDATE` e lanca se faltar, o que e estritamente melhor que o
  // `hasItem` que existia antes. Aquele lia fora da transacao, entao entre a
  // checagem e o consumo o item podia ter saido por outro caminho (venda em
  // barraca, /removeitem da staff) e o craft consumia o que nao existia mais.
  //
  // As duas pernas nomeiam a contraparte `system`: o ingrediente vai para o
  // nada e o resultado vem do nada. E o que faz a soma dos deltas do razao
  // fechar em zero por `transfer_id`, e o que torna respondivel a pergunta
  // "de onde saiu este item?" que a auditoria §2 nao conseguia responder.
  const resultado = await inventory.exchange({
    legs: [
      {
        from: inventory.character(characterId, actorId),
        to: inventory.system(inventory.SYSTEM_SOURCES.CONSUME),
        items: ingredients.map(ing => ({ baseId: ing.base_id, quantity: ing.count }))
      },
      {
        from: inventory.system(inventory.SYSTEM_SOURCES.CRAFT),
        to: inventory.character(characterId, actorId),
        items: [{ baseId: recipe.result_base_id, quantity: recipe.result_count }]
      }
    ],
    reason: 'craft',
    module: MODULE,
    requestId
  });

  if (!resultado.ok) {
    console.error(`[crafting] Craft falhou (char=${characterId} recipe=${recipeId}): ${resultado.code} ${resultado.reason}`);
    if (typeof mp !== 'undefined') {
      mp.callPapyrusFunction('global', 'Debug', 'notification', null, [`Craft cancelado: ${resultado.reason}`]);
    }
    return false;
  }

  if (resultado.duplicate) {
    // Reenvio do mesmo pedido. Nao craftou de novo, e dizer "voce criou" seria
    // mentir sobre um item que o jogador ja tem.
    if (typeof mp !== 'undefined') {
      mp.callPapyrusFunction('global', 'Debug', 'notification', null, ['Este craft ja havia sido concluido.']);
    }
    return true;
  }

  if (typeof mp !== 'undefined') {
    mp.callPapyrusFunction('global', 'Debug', 'notification', null, [
      `✓ Você criou: ${recipe.name} (x${recipe.result_count}).`
    ]);
  }

  // XP só quando a receita tem profissão dona — craft livre não progride
  // profissão nenhuma, pelo mesmo motivo que `mining-service` só concede XP
  // de `miner`.
  if (recipe.required_profession) {
    const xpPorCraft = serverOptions.get('crafting.xpPerCraft');
    if (xpPorCraft > 0) {
      await professionService.addProfessionXp({
        characterId,
        professionCode: recipe.required_profession,
        amount: xpPorCraft,
        context: 'craft'
      });
    }
  }

  commands.broadcastProximityMessage(actorId, `* Trabalha com habilidade na estação.`, 500);
  console.log(`[crafting] Char ${characterId} crafted recipe ${recipeId}: ${recipe.name}`);
  return true;
}

/**
 * Staff: Adiciona uma nova receita ao banco.
 * /addrecipe [station] [resultBaseId] [resultCount] [name]
 *
 * `requiredProfession`/`requiredRank` são opcionais — receita sem eles fica
 * livre para qualquer personagem, o mesmo default de `resource_nodes`.
 */
async function addRecipe(actorId, stationType, resultBaseId, resultCount, name, requiredProfession = null, requiredRank = null) {
  const adminService = require('./admin-service');
  if (!adminService.hasPermission(actorId, 'manage_recipes')) return null;

  const res = await db.query(
    `INSERT INTO crafting_recipes
      (name, station_type, result_base_id, result_count, required_profession, required_rank)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [name, stationType, resultBaseId, resultCount, requiredProfession, requiredRank]
  );
  const recipeId = res.insertId;

  if (typeof mp !== 'undefined') {
    mp.callPapyrusFunction('global', 'Debug', 'notification', null, [`Receita criada com ID ${recipeId}: ${name}`]);
  }
  console.log(`[crafting] Recipe ${recipeId} added by actor ${actorId.toString(16)}: ${name}`);
  return recipeId;
}

/**
 * Staff: Adiciona um ingrediente a uma receita.
 * /addingredient [recipeId] [baseId] [count]
 */
async function addIngredient(actorId, recipeId, baseId, count) {
  const adminService = require('./admin-service');
  if (!adminService.hasPermission(actorId, 'manage_recipes')) return;

  await db.query(
    'INSERT INTO crafting_ingredients (recipe_id, base_id, count) VALUES (?, ?, ?)',
    [recipeId, baseId, count]
  );
  if (typeof mp !== 'undefined') {
    mp.callPapyrusFunction('global', 'Debug', 'notification', null, [`Ingrediente 0x${baseId.toString(16)} x${count} adicionado à receita ${recipeId}.`]);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Comandos de chat — sem UI CEF, mesmo padrão de `jobs-service.commandDefs()`.
// `/craft` e `/receitas` resolvem `characterId` aqui porque `craftItem` e
// `listRecipes` recebem `characterId` já resolvido (craftItem precisa dele
// para o gate de profissão e para `inventory.exchange`); os comandos de staff
// só repassam `actorId`, que é quem `addRecipe`/`addIngredient` já esperam.
// ─────────────────────────────────────────────────────────────────────────────

function _characterIdFor(actorId) {
  const character = commands.getActiveCharacterData(actorId);
  return character ? character.characterId : null;
}

function commandDefs() {
  return [
    {
      name: '/receitas',
      description: '[Crafting] Lista as receitas de uma estação',
      usage: `/receitas <${STATION_TYPES.join('|')}>`,
      handler: async (actorId, args) => {
        const stationType = String(args || '').trim();
        await listRecipes(actorId, stationType);
      }
    },
    {
      name: '/craft',
      description: '[Crafting] Fabrica um item numa estação',
      usage: '/craft <recipeId> [estacao]',
      handler: async (actorId, args) => {
        const characterId = _characterIdFor(actorId);
        if (!characterId) {
          if (typeof mp !== 'undefined') mp.callPapyrusFunction('global', 'Debug', 'notification', null, ['Personagem não carregado.']);
          return;
        }
        const [bruto, stationType] = String(args || '').trim().split(/\s+/);
        const recipeId = Number.parseInt(bruto, 10);
        if (!Number.isSafeInteger(recipeId)) {
          if (typeof mp !== 'undefined') mp.callPapyrusFunction('global', 'Debug', 'notification', null, ['Uso: /craft <recipeId> [estacao]']);
          return;
        }
        await craftItem(actorId, characterId, recipeId, { stationType });
      }
    },
    {
      name: '/addrecipe',
      description: '[Staff] Cria uma receita (opcionalmente presa a uma profissão/rank)',
      usage: '/addrecipe <estacao> <resultBaseId> <resultCount> <nome> [profissao] [rank]',
      handler: async (actorId, args) => {
        const partes = String(args || '').trim().split(/\s+/);
        const [stationType, resultBaseIdRaw, resultCountRaw, ...resto] = partes;
        const resultBaseId = Number.parseInt(resultBaseIdRaw, 16);
        const resultCount = Number.parseInt(resultCountRaw, 10);
        if (!STATION_TYPES.includes(stationType) || !Number.isSafeInteger(resultBaseId) || !Number.isSafeInteger(resultCount) || resto.length === 0) {
          if (typeof mp !== 'undefined') {
            mp.callPapyrusFunction('global', 'Debug', 'notification', null, [
              'Uso: /addrecipe <estacao> <resultBaseId hex> <resultCount> <nome> [profissao] [rank]'
            ]);
          }
          return;
        }
        // O nome pode ter espaço; profissão/rank, se vierem, são as duas
        // últimas palavras — heurística aceitável porque nome de receita não
        // termina com um rank numérico isolado.
        let name = resto.join(' ');
        let requiredProfession = null;
        let requiredRank = null;
        const possivelRank = Number.parseInt(resto[resto.length - 1], 10);
        if (resto.length >= 2 && Number.isSafeInteger(possivelRank)) {
          requiredRank = possivelRank;
          requiredProfession = resto[resto.length - 2];
          name = resto.slice(0, -2).join(' ');
        }
        if (!name) name = resto.join(' ');

        await addRecipe(actorId, stationType, resultBaseId, resultCount, name, requiredProfession, requiredRank);
      }
    },
    {
      name: '/addingredient',
      description: '[Staff] Adiciona um ingrediente a uma receita',
      usage: '/addingredient <recipeId> <baseId hex> <count>',
      handler: async (actorId, args) => {
        const [recipeIdRaw, baseIdRaw, countRaw] = String(args || '').trim().split(/\s+/);
        const recipeId = Number.parseInt(recipeIdRaw, 10);
        const baseId = Number.parseInt(baseIdRaw, 16);
        const count = Number.parseInt(countRaw, 10);
        if (!Number.isSafeInteger(recipeId) || !Number.isSafeInteger(baseId) || !Number.isSafeInteger(count)) {
          if (typeof mp !== 'undefined') mp.callPapyrusFunction('global', 'Debug', 'notification', null, ['Uso: /addingredient <recipeId> <baseId hex> <count>']);
          return;
        }
        await addIngredient(actorId, recipeId, baseId, count);
      }
    }
  ];
}

module.exports = {
  listRecipes,
  craftItem,
  addRecipe,
  addIngredient,
  commandDefs,
  STATION_TYPES
};
