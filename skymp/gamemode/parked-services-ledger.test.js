/**
 * parked-services-ledger.test.js
 *
 * Os serviços PARKED não rodam — e é exatamente por isso que precisam deste
 * teste. Eles são o código com maior chance de voltar sem revisão: alguém liga
 * uma flag meses depois, e o que estava errado dentro deles vira produção sem
 * passar por ninguém. Foi o cenário que motivou apagar o `economy-service`
 * (seis módulos o importavam) e o que a Fase 3 veio fechar.
 *
 * O que estes testes travam, para os cinco que mexem em patrimônio:
 *
 *   1. **Nenhum caminho de ouro fora do `core/transaction-service`.** Saldo que
 *      muda sem linha em `gold_transactions` é ouro sem rastro — o defeito do
 *      `/setgold` e a razão de o `economy-service` ter sido apagado.
 *   2. **Nenhum caminho de item fora dele tampouco.** É a mesma regra; o
 *      `jobs-service` a violava de forma mais grave que qualquer caso de ouro,
 *      criando recurso que só existia no cliente.
 *   3. **O craft é UMA transação.** Se alguém trocar as primitivas `tx.*` pelas
 *      funções públicas, cada ingrediente vira uma transação independente e uma
 *      falha no meio consome o ingrediente sem entregar o resultado.
 *
 * Verificação por mutação, não por resultado: cada teste abaixo tem uma
 * mutação nomeada que o faz reprovar. Um teste que só confere o retorno de
 * `buyProperty` passaria com o `UPDATE characters SET gold` de volta.
 *
 * Executa com: node --test parked-services-ledger.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { describe, it, beforeEach, after } = require('node:test');

const COMPRADOR_ACTOR = 0xff00e001;
const COMPRADOR_CHAR = 7101;
const VENDEDOR_CHAR = 7102;

// ─────────────────────────────────────────────────────────────────────────────
// Banco de mentira, com o mesmo formato do mock de market-stalls-purchase:
// `db.query` devolve linhas, `conn.query` devolve `[linhas]`.
// ─────────────────────────────────────────────────────────────────────────────

let saldos = {};
let inventario = {};        // `${characterId}:${baseId}` -> count
let containerInventario = {}; // `${containerId}:${baseId}` -> count
let containersExistentes = new Set([1]);
let eventos = [];           // 'begin' | 'commit' | 'rollback'
let ledgerOuro = [];
let ledgerItem = [];
let notificacoes = [];
let itensAplicadosNoCliente = [];
let tabelas = {};           // resultados fixos por consulta de dominio
let erroForcado = null;

function chaveInv(characterId, baseId) {
  return `${characterId}:${baseId}`;
}

/** Roteador de SQL compartilhado entre `db.query` e `conn.query`. */
function responder(sql, params) {
  if (erroForcado && new RegExp(erroForcado.quando, 'i').test(sql)) {
    throw new Error(erroForcado.mensagem);
  }

  // ── Ouro (core/transaction-service) ───────────────────────────────────────
  if (/SELECT gold FROM characters WHERE id = \? FOR UPDATE/i.test(sql)) {
    const id = params[0];
    return saldos[id] === undefined ? [] : [{ gold: saldos[id] }];
  }
  if (/SELECT gold FROM characters/i.test(sql)) {
    return [{ gold: saldos[params[0]] || 0 }];
  }
  if (/UPDATE characters SET gold = gold \+ \?/i.test(sql)) {
    saldos[params[1]] = (saldos[params[1]] || 0) + params[0];
    return [{}];
  }
  if (/INSERT INTO gold_transactions/i.test(sql)) {
    // Posições mudaram na migration v15 (Economy Framework):
    // (transaction_id, character_id, owner_type, owner_ref,
    //  counterparty_type, counterparty_ref, transfer_id, actor_character_id,
    //  delta, reason, module, idempotency_key, status)
    ledgerOuro.push({ characterId: params[1], delta: params[8], reason: params[9], module: params[10] });
    return [{}];
  }

  // ── Inventory Framework (core/inventory.js) ───────────────────────────────
  // O replay de `exchange` é conferido DENTRO da transação, com FOR UPDATE
  // sobre a chave única — auditoria §7. O mock devolve o que já foi gravado.
  if (/SELECT transfer_id FROM inventory_transactions WHERE idempotency_key/i.test(sql)) {
    const achado = ledgerItem.find(l => l.idempotencyKey === params[0]);
    return achado ? [{ transfer_id: achado.transferId }] : [];
  }
  if (/SELECT id FROM containers WHERE id = \?/i.test(sql)) {
    return containersExistentes.has(Number(params[0])) ? [{ id: Number(params[0]) }] : [];
  }
  if (/SELECT count FROM container_inventory/i.test(sql)) {
    const atual = containerInventario[chaveInv(params[0], params[1])];
    return atual === undefined ? [] : [{ count: atual }];
  }
  if (/INSERT INTO container_inventory/i.test(sql)) {
    containerInventario[chaveInv(params[0], params[1])] = params[2];
    return [{}];
  }
  if (/UPDATE container_inventory SET count = count \+ \?/i.test(sql)) {
    containerInventario[chaveInv(params[1], params[2])] += params[0];
    return [{}];
  }
  if (/UPDATE container_inventory SET count = \?/i.test(sql)) {
    containerInventario[chaveInv(params[1], params[2])] = params[0];
    return [{}];
  }
  if (/DELETE FROM container_inventory/i.test(sql)) {
    delete containerInventario[chaveInv(params[0], params[1])];
    return [{}];
  }

  // ── Inventario (core/transaction-service) ─────────────────────────────────
  if (/SELECT count FROM character_inventory/i.test(sql)) {
    const atual = inventario[chaveInv(params[0], params[1])];
    return atual === undefined ? [] : [{ count: atual }];
  }
  if (/INSERT INTO character_inventory/i.test(sql)) {
    inventario[chaveInv(params[0], params[1])] = params[2];
    return [{}];
  }
  if (/UPDATE character_inventory SET count = count \+ \?/i.test(sql)) {
    inventario[chaveInv(params[1], params[2])] += params[0];
    return [{}];
  }
  if (/UPDATE character_inventory SET count = \?/i.test(sql)) {
    inventario[chaveInv(params[1], params[2])] = params[0];
    return [{}];
  }
  if (/DELETE FROM character_inventory/i.test(sql)) {
    delete inventario[chaveInv(params[0], params[1])];
    return [{}];
  }
  if (/INSERT INTO inventory_transactions/i.test(sql)) {
    // Posições mudaram na migration v14: o razão passou a nomear os dois lados
    // do movimento. Ver `core/transaction-service._recordInventoryLedger`.
    // (transaction_id, character_id, owner_type, owner_ref,
    //  counterparty_type, counterparty_ref, transfer_id,
    //  base_id, delta, reason, module, idempotency_key)
    ledgerItem.push({
      characterId: params[1], ownerType: params[2], ownerRef: params[3],
      counterpartyType: params[4], counterpartyRef: params[5], transferId: params[6],
      baseId: params[7], delta: params[8], reason: params[9], module: params[10],
      idempotencyKey: params[11]
    });
    return [{}];
  }

  // ── Dominio de cada servico ───────────────────────────────────────────────
  for (const [padrao, linhas] of Object.entries(tabelas)) {
    if (new RegExp(padrao, 'i').test(sql)) return linhas;
  }

  return [];
}

function novaConexao() {
  return {
    beginTransaction: async () => { eventos.push('begin'); },
    commit: async () => { eventos.push('commit'); },
    rollback: async () => { eventos.push('rollback'); },
    release: () => {},
    query: async (sql, params = []) => [responder(sql, params)]
  };
}

// Instância única do mock de `commands`. Precisa ser a mesma que os serviços
// capturam no `require` do topo deles: um objeto novo por chamada do
// `Module._load` seria impossível de manipular depois, e o teste de troca de
// slot depende justamente de trocar `getActiveCharacterData` no meio.
const commandsMock = {
  sendNotification: (actorId, message) => notificacoes.push({ actorId, message }),
  getActiveCharacterData: (actorId) =>
    actorId === COMPRADOR_ACTOR ? { characterId: COMPRADOR_CHAR, accountId: 1, firstName: 'Comprador', lastName: 'Um' } : null,
  getActiveActorByCharacterId: () => null,
  broadcastProximityMessage: () => {},
  registerCommand: () => {}
};

const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request) {
  if (request.endsWith('/database') || request === './database' || request === '../database') {
    return {
      init: () => {},
      close: async () => {},
      query: async (sql, params = []) => responder(sql, params),
      getConnection: async () => novaConexao()
    };
  }
  if (request === './commands' || request.endsWith('/commands')) return commandsMock;
  return originalLoad.apply(this, arguments);
};

// `mp` mínimo. `AddItem`/`RemoveItem` são registrados para que o teste consiga
// afirmar que NENHUM item chegou no cliente sem antes virar linha no ledger —
// que é literalmente o defeito que o jobs-service tinha.
global.mp = {
  callPapyrusFunction: (tipo, classe, funcao, self, args = []) => {
    if (funcao === 'AddItem') itensAplicadosNoCliente.push({ baseId: args[0], count: args[1] });
    if (funcao === 'RemoveItem') itensAplicadosNoCliente.push({ baseId: args[0], count: -args[1] });
    if (funcao === 'GetItemCount') return 1; // sempre tem a ferramenta
    return null;
  },
  get: () => null,
  set: () => {},
  // `core/papyrus.actorRef` monta o `self` como `{type, desc}` e precisa disto.
  getDescFromId: (actorId) => `desc-${actorId}`
};

const housing = require('./housing-service');
const horse = require('./horse-service');
const crafting = require('./crafting-service');
const jobs = require('./jobs-service');

Module._load = originalLoad;

after(() => {
  delete global.mp;
});

beforeEach(() => {
  saldos = { [COMPRADOR_CHAR]: 1000, [VENDEDOR_CHAR]: 0 };
  inventario = {};
  containerInventario = {};
  containersExistentes = new Set([1]);
  eventos = [];
  ledgerOuro = [];
  ledgerItem = [];
  notificacoes = [];
  itensAplicadosNoCliente = [];
  tabelas = {};
  erroForcado = null;
  jobs._activeGatherers.clear();
});

/**
 * A afirmação central da Fase 3, em uma função.
 *
 * Soma o que o ledger diz que aconteceu e compara com o que o saldo fez de
 * fato. Se algum caminho mover ouro sem gravar a linha, a soma não fecha —
 * independentemente de qual caminho seja, o que é a razão de ser desta forma e
 * não de uma checagem de `ledgerOuro.length`.
 */
function conferirOuroFecha(saldosIniciais) {
  const porPersonagem = {};
  for (const linha of ledgerOuro) {
    porPersonagem[linha.characterId] = (porPersonagem[linha.characterId] || 0) + linha.delta;
  }
  for (const id of new Set([...Object.keys(saldos), ...Object.keys(saldosIniciais)])) {
    const movimentoReal = (saldos[id] || 0) - (saldosIniciais[id] || 0);
    const movimentoNoLedger = porPersonagem[id] || 0;
    assert.strictEqual(
      movimentoReal, movimentoNoLedger,
      `char ${id}: saldo moveu ${movimentoReal} mas o ledger registra ${movimentoNoLedger} — ouro sem rastro`
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────

describe('housing-service — compra de propriedade', () => {
  const PRECO = 400;

  beforeEach(() => {
    tabelas['FROM properties WHERE id = \\? AND is_for_sale'] = [
      { id: 5, name: 'Casa em Whiterun', price_gold: PRECO, owner_character_id: null }
    ];
  });

  it('todo o ouro gasto vira linha em gold_transactions', async () => {
    const iniciais = { ...saldos };
    const ok = await housing.buyProperty(COMPRADOR_ACTOR, COMPRADOR_CHAR, 5);

    assert.strictEqual(ok, true);
    assert.strictEqual(saldos[COMPRADOR_CHAR], 1000 - PRECO);
    conferirOuroFecha(iniciais);

    // Mutação que reprova aqui: trocar `transactionService.removeGold` por um
    // `UPDATE characters SET gold` direto — que é o que o arquivo fazia antes
    // de o economy-service ser apagado. O saldo continuaria certo e o ledger
    // ficaria vazio.
    const linha = ledgerOuro.find(l => l.reason === 'property_purchase');
    assert.ok(linha, 'a compra precisa de linha própria no ledger');
    assert.strictEqual(linha.delta, -PRECO);
    assert.strictEqual(linha.module, 'housing');
  });

  it('saldo insuficiente não move ouro nem grava ledger', async () => {
    saldos[COMPRADOR_CHAR] = PRECO - 1;
    const iniciais = { ...saldos };

    const ok = await housing.buyProperty(COMPRADOR_ACTOR, COMPRADOR_CHAR, 5);

    assert.strictEqual(ok, false);
    assert.strictEqual(saldos[COMPRADOR_CHAR], PRECO - 1, 'o saldo não podia ter mudado');
    conferirOuroFecha(iniciais);
    assert.strictEqual(ledgerOuro.length, 0);
  });
});

describe('horse-service — compra de cavalo', () => {
  const PRECO = 250;

  beforeEach(() => {
    tabelas['SELECT id FROM horses WHERE owner_character_id'] = [];
    tabelas['FROM horses WHERE id = \\? AND for_sale'] = [
      { id: 3, name: 'Sombra', sale_price: PRECO, owner_character_id: VENDEDOR_CHAR }
    ];
  });

  it('as duas pernas (comprador e vendedor) viram linha no ledger', async () => {
    const iniciais = { ...saldos };
    await horse.buyHorse(COMPRADOR_ACTOR, COMPRADOR_CHAR, 3);

    assert.strictEqual(saldos[COMPRADOR_CHAR], 1000 - PRECO);
    assert.strictEqual(saldos[VENDEDOR_CHAR], PRECO);
    conferirOuroFecha(iniciais);

    // A mutação que este teste existe pra pegar é a mais fácil de cometer:
    // creditar o vendedor com um UPDATE direto "porque é só um credito".
    // `conferirOuroFecha` reprova, e a asserção abaixo diz qual perna sumiu.
    assert.ok(ledgerOuro.find(l => l.characterId === COMPRADOR_CHAR && l.delta === -PRECO), 'falta a perna do comprador');
    assert.ok(ledgerOuro.find(l => l.characterId === VENDEDOR_CHAR && l.delta === PRECO), 'falta a perna do vendedor');
  });
});

describe('trade-service — não tem caminho de ouro', () => {
  it('o arquivo não chama nenhuma função de ouro', () => {
    // O import de `economy-service` que ele tinha era morto e saiu junto com o
    // arquivo importado. Esta é uma asserção estrutural de propósito: o
    // trade-service não tem função de compra pra exercitar, e o que precisa
    // ficar travado é que ele continue sem caminho de dinheiro até alguém
    // desenhar o commit duplo que o backlog pede.
    const fonte = require('fs').readFileSync(require('path').join(__dirname, 'trade-service.js'), 'utf8');
    assert.strictEqual(/addGold|removeGold|SET gold/i.test(fonte), false,
      'trade-service ganhou caminho de ouro — ele precisa passar pelo transaction-service e ter teste próprio');
  });
});

describe('crafting-service — consumo e entrega numa transação só', () => {
  const INGREDIENTE_A = 0x1001;
  const INGREDIENTE_B = 0x1002;
  const RESULTADO = 0x2001;

  beforeEach(() => {
    tabelas['FROM crafting_recipes WHERE id'] = [
      { id: 9, name: 'Poção de Cura', result_base_id: RESULTADO, result_count: 2 }
    ];
    tabelas['FROM crafting_ingredients WHERE recipe_id'] = [
      { base_id: INGREDIENTE_A, count: 2 },
      { base_id: INGREDIENTE_B, count: 1 }
    ];
    inventario[chaveInv(COMPRADOR_CHAR, INGREDIENTE_A)] = 5;
    inventario[chaveInv(COMPRADOR_CHAR, INGREDIENTE_B)] = 1;
  });

  it('consome os dois ingredientes e entrega o resultado', async () => {
    const ok = await crafting.craftItem(COMPRADOR_ACTOR, COMPRADOR_CHAR, 9);

    assert.strictEqual(ok, true);
    assert.strictEqual(inventario[chaveInv(COMPRADOR_CHAR, INGREDIENTE_A)], 3);
    assert.strictEqual(inventario[chaveInv(COMPRADOR_CHAR, INGREDIENTE_B)], undefined, 'zerou, então a linha sai');
    assert.strictEqual(inventario[chaveInv(COMPRADOR_CHAR, RESULTADO)], 2);
  });

  it('é UMA transação — não uma por ingrediente', async () => {
    await crafting.craftItem(COMPRADOR_ACTOR, COMPRADOR_CHAR, 9);

    // Esta é a asserção que pega a regressão para o código anterior: ele
    // chamava `removeItem()` por ingrediente e `giveItem()` no fim, e cada uma
    // dessas funções abre a própria transação. Seriam três `begin`.
    assert.deepStrictEqual(
      eventos, ['begin', 'commit'],
      'consumo e entrega precisam commitar juntos — trocar as primitivas tx.* pelas funções públicas quebra isto'
    );
  });

  it('toda movimentação de item vira linha em inventory_transactions', async () => {
    await crafting.craftItem(COMPRADOR_ACTOR, COMPRADOR_CHAR, 9);

    // Seis, e não três: desde a migration v14 o razão grava **as duas pontas**
    // de cada movimento. O craft tem três movimentos (dois consumos e uma
    // entrega) e seis pontas, porque a contraparte de cada um é o dono
    // `system` — `consume` no que some, `craft` no que nasce.
    //
    // A linha do lado do nada é o que torna a conservação verificável: sem
    // ela, "item criado" e "erro de contabilidade" ficam indistinguíveis. Ver
    // INVENTORY_TRADE_CRAFTING_AUDIT.md §2.
    assert.strictEqual(ledgerItem.length, 6, 'três movimentos, duas pontas cada');

    const doPersonagem = ledgerItem.filter(l => l.ownerType === 'character');
    assert.strictEqual(doPersonagem.length, 3);
    assert.ok(doPersonagem.find(l => l.baseId === INGREDIENTE_A && l.delta === -2));
    assert.ok(doPersonagem.find(l => l.baseId === INGREDIENTE_B && l.delta === -1));
    assert.ok(doPersonagem.find(l => l.baseId === RESULTADO && l.delta === 2));

    // A soma por transferência fecha em zero — o invariante que o razão não
    // tinha como sustentar antes de nomear o outro lado.
    const porTransferencia = {};
    for (const l of ledgerItem) porTransferencia[l.transferId] = (porTransferencia[l.transferId] || 0) + l.delta;
    for (const [id, soma] of Object.entries(porTransferencia)) {
      assert.strictEqual(soma, 0, `transfer ${id} não fecha`);
    }

    for (const linha of ledgerItem) {
      assert.strictEqual(linha.module, 'crafting');
      assert.strictEqual(linha.reason, 'craft');
    }
  });

  it('falta de ingrediente reverte tudo — não consome o que já tinha passado', async () => {
    inventario[chaveInv(COMPRADOR_CHAR, INGREDIENTE_B)] = 0;

    const ok = await crafting.craftItem(COMPRADOR_ACTOR, COMPRADOR_CHAR, 9);

    assert.strictEqual(ok, false);
    assert.deepStrictEqual(eventos, ['begin', 'rollback']);
    // O primeiro ingrediente foi consumido *dentro* da transação abortada. Com
    // o código antigo — uma transação por ingrediente — o `removeItem` do
    // primeiro já teria commitado, e o jogador perderia 2x INGREDIENTE_A sem
    // receber nada. É o `economy-service.transfer` transposto pra item.
    assert.strictEqual(itensAplicadosNoCliente.length, 0, 'nada pode chegar no cliente depois de um rollback');
    assert.strictEqual(inventario[chaveInv(COMPRADOR_CHAR, RESULTADO)], undefined);
  });

  it('receita sem ingrediente cadastrado não cria item do nada', async () => {
    tabelas['FROM crafting_ingredients WHERE recipe_id'] = [];

    const ok = await crafting.craftItem(COMPRADOR_ACTOR, COMPRADOR_CHAR, 9);

    assert.strictEqual(ok, false);
    assert.strictEqual(eventos.length, 0, 'nem chega a abrir transação');
    assert.strictEqual(ledgerItem.length, 0);
  });

  it('erro de SQL não vai pra tela do jogador', async () => {
    erroForcado = { quando: 'INSERT INTO inventory_transactions', mensagem: "Unknown column 'foo' in 'field list'" };

    await crafting.craftItem(COMPRADOR_ACTOR, COMPRADOR_CHAR, 9);

    const paraOJogador = notificacoes.map(n => n.message).join(' ');
    assert.strictEqual(/Unknown column/.test(paraOJogador), false, 'nome de coluna não pode vazar pro jogador');
  });

  describe('gate de profissão (migration-v20)', () => {
    beforeEach(() => {
      // Sobrescreve a receita do beforeEach externo com uma presa a profissão —
      // o mesmo recipeId (9), só que agora exigindo `blacksmith`.
      tabelas['FROM crafting_recipes WHERE id'] = [
        { id: 9, name: 'Poção de Cura', result_base_id: RESULTADO, result_count: 2, required_profession: 'blacksmith', required_rank: null }
      ];
    });

    it('recusa quem não tem a profissão exigida — e não consome nada', async () => {
      tabelas['FROM character_professions WHERE character_id'] = []; // sem linha = sem profissão

      const ok = await crafting.craftItem(COMPRADOR_ACTOR, COMPRADOR_CHAR, 9);

      assert.strictEqual(ok, false);
      assert.strictEqual(ledgerItem.length, 0, 'a checagem de profissão precisa vir ANTES de consumir ingrediente');
      assert.strictEqual(inventario[chaveInv(COMPRADOR_CHAR, INGREDIENTE_A)], 5, 'ingrediente intacto');
    });

    it('libera quem tem a profissão ativa', async () => {
      tabelas['FROM character_professions WHERE character_id'] = [
        { character_id: COMPRADOR_CHAR, profession_code: 'blacksmith', status: 'active', rank: 1, xp: 0 }
      ];

      const ok = await crafting.craftItem(COMPRADOR_ACTOR, COMPRADOR_CHAR, 9);

      assert.strictEqual(ok, true);
      assert.strictEqual(inventario[chaveInv(COMPRADOR_CHAR, RESULTADO)], 2, 'craft completou e entregou o resultado');
    });

    it('receita sem required_profession continua livre (regressão)', async () => {
      tabelas['FROM crafting_recipes WHERE id'] = [
        { id: 9, name: 'Poção de Cura', result_base_id: RESULTADO, result_count: 2 } // sem o campo, como antes desta migration
      ];

      const ok = await crafting.craftItem(COMPRADOR_ACTOR, COMPRADOR_CHAR, 9);

      assert.strictEqual(ok, true, 'NULL/ausente continua sem gate nenhum');
    });
  });
});

describe('jobs-service — coleta com rastro no banco', () => {
  const ITEM_FIREWOOD = 0x00033760;

  /**
   * O `setTimeout` de 10 s é do serviço, não da regra. O teste exercita o
   * fecho da coleta pelo caminho real (`_finishGather` via o timer) usando os
   * timers falsos do node:test — simular a entrega chamando o
   * transaction-service à mão testaria o mock, não o serviço.
   */
  it('a coleta credita pelo transaction-service, com linha no ledger', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });

    jobs.chopWood(COMPRADOR_ACTOR);
    assert.strictEqual(jobs._activeGatherers.has(COMPRADOR_CHAR), true, 'marcou ocupado');

    t.mock.timers.tick(10_001);
    await new Promise(resolve => setImmediate(resolve));

    // A mutação que este teste pega é o código anterior inteiro: ele chamava
    // `AddItem` do Papyrus direto, então o item aparecia no cliente e o banco
    // nunca ficava sabendo. Ledger vazio com item entregue = recurso que não
    // existe pro servidor.
    assert.strictEqual(ledgerItem.length, 1, 'a lenha precisa virar linha em inventory_transactions');
    assert.strictEqual(ledgerItem[0].baseId, ITEM_FIREWOOD);
    assert.strictEqual(ledgerItem[0].reason, 'woodcutting');
    assert.strictEqual(ledgerItem[0].module, 'jobs');
    assert.ok(ledgerItem[0].delta >= 1 && ledgerItem[0].delta <= 3);

    // E o banco precisa concordar com o que foi pro cliente.
    const noBanco = inventario[chaveInv(COMPRADOR_CHAR, ITEM_FIREWOOD)];
    const noCliente = itensAplicadosNoCliente.find(i => i.baseId === ITEM_FIREWOOD);
    assert.strictEqual(noBanco, ledgerItem[0].delta);
    assert.ok(noCliente, 'o cliente também recebe — depois do commit');
    assert.strictEqual(noCliente.count, noBanco);

    assert.strictEqual(jobs._activeGatherers.has(COMPRADOR_CHAR), false, 'liberou ao terminar');
  });

  it('sem personagem carregado não coleta — não há onde creditar', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });

    jobs.chopWood(0xdeadbeef); // actorId sem personagem no mock de commands

    t.mock.timers.tick(10_001);
    await new Promise(resolve => setImmediate(resolve));

    assert.strictEqual(ledgerItem.length, 0);
    assert.strictEqual(itensAplicadosNoCliente.length, 0, 'nada pode chegar no cliente');
  });

  it('coleta concorrente do mesmo personagem é recusada', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });

    jobs.chopWood(COMPRADOR_ACTOR);
    jobs.chopWood(COMPRADOR_ACTOR); // segunda tentativa, ainda ocupado

    t.mock.timers.tick(10_001);
    await new Promise(resolve => setImmediate(resolve));

    assert.strictEqual(ledgerItem.length, 1, 'duas coletas simultâneas dariam duas linhas');
  });

  it('se o slot trocar de dono no meio, o recurso não é entregue', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });

    jobs.chopWood(COMPRADOR_ACTOR);

    // O jogador cai e outro entra no mesmo actorId. É a classe de bug que a
    // auditoria da Fase 1 pegou no `_lastHealth` do death-service: aqui ela
    // entregaria a lenha ao personagem errado — e o ledger registraria a
    // entrega corretamente, no dono errado, que é pior que não entregar.
    const original = commandsMock.getActiveCharacterData;
    commandsMock.getActiveCharacterData = () => ({ characterId: 7199, accountId: 2 });

    try {
      t.mock.timers.tick(10_001);
      await new Promise(resolve => setImmediate(resolve));
    } finally {
      commandsMock.getActiveCharacterData = original;
    }

    assert.strictEqual(ledgerItem.length, 0, 'não pode creditar ninguém');
    assert.strictEqual(itensAplicadosNoCliente.length, 0);
    assert.strictEqual(jobs._activeGatherers.has(COMPRADOR_CHAR), false, 'o ocupado sai mesmo assim');
  });
});

describe('a migration-v20 declara toda coluna que o gate de profissão do crafting usa', () => {
  const sql = fs.readFileSync(
    path.resolve(__dirname, '..', 'packages', 'database', 'migration-v20-crafting-profession-gate.sql'),
    'utf8'
  );
  const alteracao = sql.slice(sql.indexOf('ALTER TABLE'));

  for (const coluna of ['required_profession', 'required_rank']) {
    it(`declara a coluna '${coluna}'`, () => {
      assert.ok(alteracao.includes(`\`${coluna}\``), `coluna '${coluna}' usada em crafting-service.js mas ausente da migration-v20`);
    });
  }
});
