/**
 * cell-persistence-service.test.js
 *
 * O que estes testes provam: a allowlist classifica certo, o drop remove do
 * inventário e grava a linha antes de spawnar, a reidratação lê de volta as
 * mesmas coordenadas depois de um "restart" simulado (limpar só o cache em
 * memória — o banco fake, fora do módulo, não é tocado), e que 100 drops numa
 * célula não perdem nem duplicam nenhuma linha.
 *
 * O que eles NÃO provam, e nenhum teste em Node poderia: que `PlaceAtMe`
 * spawna algo visível pra um segundo jogador, e que o polling de célula
 * detecta a troca em tempo hábil contra o servidor real. Ver o cabeçalho de
 * cell-persistence-service.js — a lista do que está e do que não está
 * provado é parte do entregável, não rodapé.
 *
 * Executa com: node --test cell-persistence-service.test.js
 */

const assert = require('assert');
const { describe, it, beforeEach, after } = require('node:test');
const Module = require('module');

// ─────────────────────────────────────────────────────────────────────────────
// Banco fake — vive FORA do módulo, de propósito: "restart simulado" limpa só
// o cache em memória do serviço (_resetInMemoryCaches), nunca isto aqui. Se o
// teste de restart passasse mesmo limpando isto, ele não estaria provando
// nada sobre persistência real.
// ─────────────────────────────────────────────────────────────────────────────
let worldObjects = [];
let nextId = 1;
let clockNow = new Date('2026-08-21T12:00:00Z');

function resetFakeDb() {
  worldObjects = [];
  nextId = 1;
  clockNow = new Date('2026-08-21T12:00:00Z');
}

function isExpired(row) {
  return row.expires_at !== null && new Date(row.expires_at) <= clockNow;
}

async function fakeQuery(sql, params = []) {
  const normalized = sql.replace(/\s+/g, ' ').trim();

  if (/^INSERT INTO world_objects/i.test(normalized)) {
    const hasTtl = params.length === 9;
    const [cellId, baseId, posX, posY, posZ, angleZ, category, characterId, ttlSeconds] = params;
    const row = {
      id: nextId++,
      cell_id: cellId, base_id: baseId,
      pos_x: posX, pos_y: posY, pos_z: posZ, angle_z: angleZ,
      category, state: 'active',
      dropped_by_character_id: characterId,
      ref_desc: null,
      expires_at: hasTtl ? new Date(clockNow.getTime() + ttlSeconds * 1000) : null
    };
    worldObjects.push(row);
    return { insertId: row.id, affectedRows: 1 };
  }

  if (/^SELECT id, base_id, pos_x, pos_y, pos_z, angle_z FROM world_objects/i.test(normalized)) {
    const [cellId] = params;
    return worldObjects
      .filter((r) => r.cell_id === cellId && r.state === 'active' && !isExpired(r))
      .map(({ id, base_id, pos_x, pos_y, pos_z, angle_z }) => ({ id, base_id, pos_x, pos_y, pos_z, angle_z }));
  }

  if (/^UPDATE world_objects SET state = 'looted' WHERE id = \? AND state = 'active'/i.test(normalized)) {
    const [id] = params;
    const row = worldObjects.find((r) => r.id === id && r.state === 'active');
    if (row) row.state = 'looted';
    return { affectedRows: row ? 1 : 0 };
  }

  if (/^SELECT base_id FROM world_objects WHERE id = \?/i.test(normalized)) {
    const [id] = params;
    const row = worldObjects.find((r) => r.id === id);
    return row ? [{ base_id: row.base_id }] : [];
  }

  if (/^UPDATE world_objects SET ref_desc/i.test(normalized)) {
    const [refDesc, id] = params;
    const row = worldObjects.find((r) => r.id === id);
    if (row) row.ref_desc = refDesc;
    return { affectedRows: row ? 1 : 0 };
  }

  if (/^SELECT id FROM world_objects WHERE state = 'active' AND expires_at/i.test(normalized)) {
    return worldObjects.filter((r) => r.state === 'active' && r.expires_at !== null && isExpired(r)).map((r) => ({ id: r.id }));
  }

  if (/^DELETE FROM world_objects WHERE state = 'active' AND expires_at/i.test(normalized)) {
    const before = worldObjects.length;
    worldObjects = worldObjects.filter((r) => !(r.state === 'active' && r.expires_at !== null && isExpired(r)));
    return { affectedRows: before - worldObjects.length };
  }

  throw new Error(`fakeQuery: SQL não reconhecido: ${normalized}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Mocks de módulo
// ─────────────────────────────────────────────────────────────────────────────
const originalLoad = Module._load;

let atoresAtivos = [];
let posicoes = {}; // actorId -> { pos, cellOrWorldDesc }
let removeItemImpl = async () => true;
let giveItemCalls = [];

// Referência ESTÁVEL: `Module._load` roda de novo a cada `require('./database')`,
// inclusive dentro do próprio teste. Se cada chamada devolvesse um objeto
// literal novo, mutar `.query` num teste não afetaria o objeto que
// `cell-persistence-service.js` já guardou na sua própria referência —
// exatamente o bug que fazia o teste de rollback falhar silenciosamente.
const fakeDbModule = { query: fakeQuery };

Module._load = function (request, parent, isMain) {
  if (request === './database' || request.endsWith('/database')) {
    return fakeDbModule;
  }
  if (request === './commands' || request.endsWith('/commands')) {
    return {
      listActiveActorIds: () => [...atoresAtivos],
      getActiveCharacterData: (actorId) => (posicoes[actorId] ? { characterId: actorId + 900 } : null),
      sendNotification: () => {}
    };
  }
  if (request === './core/transaction-service' || request.endsWith('/core/transaction-service')) {
    return {
      removeItem: (...args) => removeItemImpl(...args),
      giveItem: async (opts) => { giveItemCalls.push(opts); return true; }
    };
  }
  return originalLoad.apply(this, arguments);
};

const cellPersistence = require('./cell-persistence-service');
const interactionRegistry = require('./core/interaction-registry');

after(() => {
  Module._load = originalLoad;
  delete global.mp;
});

const CELULA_A = '162e2:Skyrim.esm';
const CELULA_B = '1a2b:Skyrim.esm';
const ATOR = 0xff00c001;

let placeAtMeCalls = [];
let despawnCalls = [];

function resetar() {
  resetFakeDb();
  atoresAtivos = [];
  posicoes = {};
  removeItemImpl = async () => true;
  giveItemCalls = [];
  placeAtMeCalls = [];
  despawnCalls = [];
  cellPersistence._resetInMemoryCaches();
  try { interactionRegistry._reset(); } catch { /* alguns testes reidratam o registry sozinhos */ }

  let nextRefId = 0x100;
  global.mp = {
    get: (actorId, prop) => (prop === 'locationalData' ? posicoes[actorId] : undefined),
    set: () => {},
    getDescFromId: (formId) => `${formId.toString(16)}:Skyrim.esm`,
    getIdFromDesc: (desc) => parseInt(desc, 16) || null,
    callPapyrusFunction: (type, cls, fn, self, args) => {
      if (cls === 'Game' && fn === 'getFormEx') return { type: 'espm', desc: `${args[0].toString(16)}:Skyrim.esm` };
      if (cls === 'ObjectReference' && fn === 'PlaceAtMe') {
        placeAtMeCalls.push({ self, args });
        const refId = nextRefId++;
        return { type: 'form', desc: `${refId.toString(16)}:Skyrim.esm` };
      }
      if (cls === 'ObjectReference' && (fn === 'Disable' || fn === 'Delete')) {
        despawnCalls.push({ fn, self });
        return null;
      }
      return null;
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describe('cell-persistence — classifyPersistence (filtro de importancia)', () => {
  it('categoria da allowlist persiste indefinidamente, mesmo com valor 0', () => {
    for (const category of cellPersistence.ALWAYS_PERSIST_CATEGORIES) {
      assert.deepEqual(cellPersistence.classifyPersistence({ category, value: 0 }), { ttlMs: null });
    }
  });

  it('valor acima do limiar persiste indefinidamente mesmo fora da allowlist', () => {
    const resultado = cellPersistence.classifyPersistence({ category: 'misc', value: cellPersistence.MIN_VALUE_THRESHOLD });
    assert.deepEqual(resultado, { ttlMs: null });
  });

  it('lixo (fora da allowlist, abaixo do valor) ganha TTL curto, nao e descartado', () => {
    const resultado = cellPersistence.classifyPersistence({ category: 'misc', value: 1 });
    assert.deepEqual(resultado, { ttlMs: cellPersistence.JUNK_TTL_MS });
  });
});

describe('cell-persistence — recordDrop', () => {
  beforeEach(resetar);

  it('remove do inventario e grava a linha antes de spawnar', async () => {
    atoresAtivos = [ATOR];
    posicoes[ATOR] = { pos: [10, 20, 30], cellOrWorldDesc: CELULA_A, rot: [0, 0, 90] };

    const resultado = await cellPersistence.recordDrop({
      actorId: ATOR, characterId: 901, baseId: 0xf, count: 1, category: 'weapon', value: 0
    });

    assert.equal(resultado.ok, true);
    assert.equal(worldObjects.length, 1);
    const linha = worldObjects[0];
    assert.equal(linha.cell_id, CELULA_A);
    assert.equal(linha.pos_x, 10);
    assert.equal(linha.angle_z, 90);
    assert.equal(linha.expires_at, null, 'weapon esta na allowlist, nao deveria expirar');
    assert.equal(placeAtMeCalls.length, 1, 'deveria ter tentado o spawn visual');
  });

  it('lixo grava com expires_at preenchido', async () => {
    atoresAtivos = [ATOR];
    posicoes[ATOR] = { pos: [0, 0, 0], cellOrWorldDesc: CELULA_A };

    await cellPersistence.recordDrop({ actorId: ATOR, characterId: 901, baseId: 0xf, count: 1, category: 'misc', value: 0 });

    assert.notEqual(worldObjects[0].expires_at, null);
  });

  it('rejeita baseId invalido sem tocar inventario', async () => {
    atoresAtivos = [ATOR];
    posicoes[ATOR] = { pos: [0, 0, 0], cellOrWorldDesc: CELULA_A };
    let chamouRemove = false;
    removeItemImpl = async () => { chamouRemove = true; return true; };

    const resultado = await cellPersistence.recordDrop({ actorId: ATOR, characterId: 901, baseId: 0, count: 1, category: 'misc', value: 0 });
    assert.equal(resultado.ok, false);
    assert.equal(chamouRemove, false);
  });

  it('sem locationalData, recusa sem remover item', async () => {
    let chamouRemove = false;
    removeItemImpl = async () => { chamouRemove = true; return true; };

    const resultado = await cellPersistence.recordDrop({ actorId: ATOR, characterId: 901, baseId: 0xf, count: 1, category: 'misc', value: 0 });
    assert.equal(resultado.ok, false);
    assert.equal(resultado.reason, 'no_location');
    assert.equal(chamouRemove, false);
  });

  it('falha na remocao do inventario aborta sem gravar linha', async () => {
    atoresAtivos = [ATOR];
    posicoes[ATOR] = { pos: [0, 0, 0], cellOrWorldDesc: CELULA_A };
    removeItemImpl = async () => false;

    const resultado = await cellPersistence.recordDrop({ actorId: ATOR, characterId: 901, baseId: 0xf, count: 1, category: 'misc', value: 0 });
    assert.equal(resultado.ok, false);
    assert.equal(worldObjects.length, 0);
  });

  it('falha ao gravar world_objects devolve o item (rollback)', async () => {
    atoresAtivos = [ATOR];
    posicoes[ATOR] = { pos: [0, 0, 0], cellOrWorldDesc: CELULA_A };

    const originalQuery = fakeDbModule.query;
    fakeDbModule.query = async (sql, params) => {
      if (/^INSERT INTO world_objects/i.test(sql)) throw new Error('conexão perdida');
      return originalQuery(sql, params);
    };

    const resultado = await cellPersistence.recordDrop({ actorId: ATOR, characterId: 901, baseId: 0xf, count: 1, category: 'misc', value: 0 });

    fakeDbModule.query = originalQuery;
    assert.equal(resultado.ok, false);
    assert.equal(resultado.reason, 'persist_failed');
    assert.equal(giveItemCalls.length, 1, 'deveria ter devolvido o item');
    assert.equal(giveItemCalls[0].baseId, 0xf);
  });
});

describe('cell-persistence — rehydrateCell', () => {
  beforeEach(resetar);

  async function semear(cellId, quantidade) {
    atoresAtivos = [ATOR];
    posicoes[ATOR] = { pos: [0, 0, 0], cellOrWorldDesc: cellId };
    for (let i = 0; i < quantidade; i++) {
      await cellPersistence.recordDrop({ actorId: ATOR, characterId: 901, baseId: 0xf + i, count: 1, category: 'weapon', value: 0 });
    }
    placeAtMeCalls = []; // os drops já spawnaram; a reidratação conta à parte
    cellPersistence._resetInMemoryCaches(); // drop já marcou a célula como "hidratada"; zera pra reidratar de propósito
  }

  it('spawna todos os objetos ativos da celula', async () => {
    await semear(CELULA_A, 5);
    const resultado = await cellPersistence.rehydrateCell(CELULA_A, ATOR);
    assert.equal(resultado.spawned, 5);
    assert.equal(placeAtMeCalls.length, 5);
  });

  it('e idempotente: segunda chamada pra mesma celula nao spawna de novo', async () => {
    await semear(CELULA_A, 3);
    await cellPersistence.rehydrateCell(CELULA_A, ATOR);
    placeAtMeCalls = [];

    const segunda = await cellPersistence.rehydrateCell(CELULA_A, ATOR);
    assert.equal(segunda.skipped, 'already_hydrated');
    assert.equal(placeAtMeCalls.length, 0);
  });

  it('celula sem objetos nao spawna nada e nao lanca', async () => {
    const resultado = await cellPersistence.rehydrateCell(CELULA_B, ATOR);
    assert.equal(resultado.spawned, 0);
  });

  it('objeto expirado nao e reidratado', async () => {
    atoresAtivos = [ATOR];
    posicoes[ATOR] = { pos: [0, 0, 0], cellOrWorldDesc: CELULA_A };
    await cellPersistence.recordDrop({ actorId: ATOR, characterId: 901, baseId: 0xf, count: 1, category: 'misc', value: 0 }); // TTL curto
    clockNow = new Date(clockNow.getTime() + cellPersistence.JUNK_TTL_MS + 1000);
    cellPersistence._resetInMemoryCaches();
    placeAtMeCalls = [];

    const resultado = await cellPersistence.rehydrateCell(CELULA_A, ATOR);
    assert.equal(resultado.spawned, 0);
  });

  it('"restart" simulado: o cache em memoria zera, mas o banco fake mantem as coordenadas', async () => {
    await semear(CELULA_A, 4);
    await cellPersistence.rehydrateCell(CELULA_A, ATOR);
    const coordenadasAntes = worldObjects.map((r) => [r.pos_x, r.pos_y, r.pos_z]);

    // "Restart": zera só o cache do serviço. O array `worldObjects` (o banco
    // fake) não é tocado — é exatamente o que representa sobreviver ao
    // processo reiniciar.
    cellPersistence.shutdownCellPersistenceService();
    cellPersistence._resetInMemoryCaches();
    placeAtMeCalls = [];

    const resultado = await cellPersistence.rehydrateCell(CELULA_A, ATOR);
    assert.equal(resultado.spawned, 4, 'os 4 objetos deveriam reidratar depois do restart');
    const coordenadasDepois = worldObjects.map((r) => [r.pos_x, r.pos_y, r.pos_z]);
    assert.deepEqual(coordenadasDepois, coordenadasAntes, 'coordenadas nao podem mudar so por reidratar de novo');
  });
});

describe('cell-persistence — sweepExpired', () => {
  beforeEach(resetar);

  it('remove so o expirado, preserva o resto', async () => {
    atoresAtivos = [ATOR];
    posicoes[ATOR] = { pos: [0, 0, 0], cellOrWorldDesc: CELULA_A };

    await cellPersistence.recordDrop({ actorId: ATOR, characterId: 901, baseId: 1, count: 1, category: 'weapon', value: 0 }); // permanente
    await cellPersistence.recordDrop({ actorId: ATOR, characterId: 901, baseId: 2, count: 1, category: 'misc', value: 0 }); // lixo, TTL curto

    assert.equal(worldObjects.length, 2);
    clockNow = new Date(clockNow.getTime() + cellPersistence.JUNK_TTL_MS + 1000);

    const removidos = await cellPersistence.sweepExpired();
    assert.equal(removidos, 1);
    assert.equal(worldObjects.length, 1);
    assert.equal(worldObjects[0].category, 'weapon');
  });

  it('sem nada expirado, nao remove nada', async () => {
    atoresAtivos = [ATOR];
    posicoes[ATOR] = { pos: [0, 0, 0], cellOrWorldDesc: CELULA_A };
    await cellPersistence.recordDrop({ actorId: ATOR, characterId: 901, baseId: 1, count: 1, category: 'weapon', value: 0 });

    assert.equal(await cellPersistence.sweepExpired(), 0);
  });
});

describe('cell-persistence — tick (deteccao de troca de celula por polling)', () => {
  beforeEach(resetar);

  it('reidrata quando um ator entra numa celula nova', async () => {
    atoresAtivos = [ATOR];
    posicoes[ATOR] = { pos: [0, 0, 0], cellOrWorldDesc: CELULA_A };
    await cellPersistence.recordDrop({ actorId: ATOR, characterId: 901, baseId: 1, count: 1, category: 'weapon', value: 0 });
    cellPersistence._resetInMemoryCaches();
    placeAtMeCalls = [];

    await cellPersistence.tick();
    assert.equal(placeAtMeCalls.length, 1, 'primeiro tick deveria reidratar a celula onde o ator ja esta');
  });

  it('nao reidrata de novo se a celula nao mudou entre ticks', async () => {
    atoresAtivos = [ATOR];
    posicoes[ATOR] = { pos: [0, 0, 0], cellOrWorldDesc: CELULA_A };
    await cellPersistence.tick();
    await cellPersistence.tick();

    assert.equal(cellPersistence._lastCellByActor.get(ATOR), CELULA_A);
  });

  it('detecta troca de celula e reidrata a nova', async () => {
    atoresAtivos = [ATOR];
    posicoes[ATOR] = { pos: [0, 0, 0], cellOrWorldDesc: CELULA_A };
    await cellPersistence.recordDrop({ actorId: ATOR, characterId: 901, baseId: 1, count: 1, category: 'weapon', value: 0 });
    cellPersistence._resetInMemoryCaches();
    await cellPersistence.tick(); // hidrata A

    posicoes[ATOR] = { pos: [500, 500, 0], cellOrWorldDesc: CELULA_B };
    placeAtMeCalls = [];
    await cellPersistence.tick();

    assert.equal(cellPersistence._lastCellByActor.get(ATOR), CELULA_B);
  });

  it('ator que desconecta some do cache de ultima celula', async () => {
    atoresAtivos = [ATOR];
    posicoes[ATOR] = { pos: [0, 0, 0], cellOrWorldDesc: CELULA_A };
    await cellPersistence.tick();
    assert.ok(cellPersistence._lastCellByActor.has(ATOR));

    atoresAtivos = [];
    await cellPersistence.tick();
    assert.ok(!cellPersistence._lastCellByActor.has(ATOR), 'cache chaveado por actorId nao pode vazar entre sessoes');
  });

  it('tick tambem varre expirados', async () => {
    atoresAtivos = [ATOR];
    posicoes[ATOR] = { pos: [0, 0, 0], cellOrWorldDesc: CELULA_A };
    await cellPersistence.recordDrop({ actorId: ATOR, characterId: 901, baseId: 1, count: 1, category: 'misc', value: 0 });
    clockNow = new Date(clockNow.getTime() + cellPersistence.JUNK_TTL_MS + 1000);

    await cellPersistence.tick();
    assert.equal(worldObjects.length, 0);
  });
});

describe('cell-persistence — estresse: 100 itens numa celula', () => {
  beforeEach(resetar);

  it('100 drops sequenciais: nenhuma linha perdida, nenhum id duplicado', async () => {
    atoresAtivos = [ATOR];
    posicoes[ATOR] = { pos: [0, 0, 0], cellOrWorldDesc: CELULA_A };

    const resultados = [];
    for (let i = 0; i < 100; i++) {
      posicoes[ATOR].pos = [i, i * 2, 0];
      resultados.push(
        await cellPersistence.recordDrop({
          actorId: ATOR, characterId: 901, baseId: 0x100 + i, count: 1,
          category: i % 2 === 0 ? 'weapon' : 'misc', value: 0
        })
      );
    }

    assert.ok(resultados.every((r) => r.ok), 'todos os 100 drops deveriam ter sido aceitos');
    assert.equal(worldObjects.length, 100, 'nenhuma linha perdida');
    const idsUnicos = new Set(worldObjects.map((r) => r.id));
    assert.equal(idsUnicos.size, 100, 'nenhum id duplicado');

    const permanentes = worldObjects.filter((r) => r.expires_at === null).length;
    const lixo = worldObjects.filter((r) => r.expires_at !== null).length;
    assert.equal(permanentes, 50, 'metade era weapon (allowlist)');
    assert.equal(lixo, 50, 'metade era misc (TTL curto)');
  });

  it('100 itens sobrevivem ao restart simulado com as coordenadas corretas', async () => {
    atoresAtivos = [ATOR];
    posicoes[ATOR] = { pos: [0, 0, 0], cellOrWorldDesc: CELULA_A };

    for (let i = 0; i < 100; i++) {
      posicoes[ATOR].pos = [i, i * 2, i * 3];
      await cellPersistence.recordDrop({
        actorId: ATOR, characterId: 901, baseId: 0x200 + i, count: 1, category: 'weapon', value: 0
      });
    }

    const antes = new Map(worldObjects.map((r) => [r.base_id, [r.pos_x, r.pos_y, r.pos_z]]));

    // "Restart": zera cache em memória, banco fake intacto.
    cellPersistence.shutdownCellPersistenceService();
    cellPersistence._resetInMemoryCaches();
    placeAtMeCalls = [];

    const resultado = await cellPersistence.rehydrateCell(CELULA_A, ATOR);
    assert.equal(resultado.spawned, 100, 'os 100 objetos deveriam reidratar');
    assert.equal(placeAtMeCalls.length, 100, 'cada objeto deveria gerar exatamente uma chamada PlaceAtMe');

    for (const row of worldObjects) {
      assert.deepEqual([row.pos_x, row.pos_y, row.pos_z], antes.get(row.base_id), `coordenadas de base_id=${row.base_id} mudaram depois do restart`);
    }
  });

  it('a carga do "banco" nao cresce por reidratacao repetida da mesma celula', async () => {
    atoresAtivos = [ATOR];
    posicoes[ATOR] = { pos: [0, 0, 0], cellOrWorldDesc: CELULA_A };
    for (let i = 0; i < 100; i++) {
      await cellPersistence.recordDrop({ actorId: ATOR, characterId: 901, baseId: 0x300 + i, count: 1, category: 'weapon', value: 0 });
    }

    const linhasAntes = worldObjects.length;
    // Reidratar a mesma célula várias vezes (ex.: vários jogadores entrando)
    // não deveria inserir linha nenhuma — reidratação é leitura, não escrita.
    await cellPersistence.rehydrateCell(CELULA_A, ATOR);
    cellPersistence._resetInMemoryCaches();
    await cellPersistence.rehydrateCell(CELULA_A, ATOR);
    cellPersistence._resetInMemoryCaches();
    await cellPersistence.rehydrateCell(CELULA_A, ATOR);

    assert.equal(worldObjects.length, linhasAntes, 'reidratar nao deveria criar linha nenhuma em world_objects');
  });
});

describe('cell-persistence — removeObject (pickup, Tarefa 5)', () => {
  beforeEach(resetar);

  async function dropar() {
    atoresAtivos = [ATOR];
    posicoes[ATOR] = { pos: [10, 20, 30], cellOrWorldDesc: CELULA_A };
    const resultado = await cellPersistence.recordDrop({
      actorId: ATOR, characterId: 901, baseId: 0xf, count: 1, category: 'weapon', value: 0
    });
    giveItemCalls = []; // limpa o giveItem que o proprio recordDrop nao chama (ele so remove) — deixa limpo pro pickup
    return resultado.id;
  }

  it('pega um item ativo: marca looted, da o item, despawna a referencia', async () => {
    const id = await dropar();
    assert.ok(cellPersistence._activeObjectsById.has(id));

    const resultado = await cellPersistence.removeObject(id, ATOR, 901);
    assert.deepEqual(resultado, { ok: true });

    assert.equal(worldObjects.find((r) => r.id === id).state, 'looted');
    assert.equal(giveItemCalls.length, 1);
    assert.equal(giveItemCalls[0].baseId, 0xf);
    assert.equal(giveItemCalls[0].idempotencyKey, `cell_persistence_pickup_${id}`);
    assert.ok(!cellPersistence._activeObjectsById.has(id), 'sai do cache depois de pego');
    assert.ok(despawnCalls.some((c) => c.fn === 'Disable'));
    assert.ok(despawnCalls.some((c) => c.fn === 'Delete'));
  });

  it('segunda tentativa no mesmo id falha com already_gone — autoridade final do servidor', async () => {
    const id = await dropar();
    const primeira = await cellPersistence.removeObject(id, ATOR, 901);
    assert.equal(primeira.ok, true);

    giveItemCalls = [];
    const segunda = await cellPersistence.removeObject(id, ATOR, 901);
    assert.deepEqual(segunda, { ok: false, reason: 'already_gone' });
    assert.equal(giveItemCalls.length, 0, 'a segunda tentativa nao pode conceder o item de novo');
  });

  it('id inexistente falha sem tocar giveItem', async () => {
    const resultado = await cellPersistence.removeObject(999999, ATOR, 901);
    assert.deepEqual(resultado, { ok: false, reason: 'already_gone' });
    assert.equal(giveItemCalls.length, 0);
  });

  it('id invalido e recusado antes de qualquer query', async () => {
    assert.deepEqual(await cellPersistence.removeObject(0, ATOR, 901), { ok: false, reason: 'invalid_id' });
    assert.deepEqual(await cellPersistence.removeObject(-1, ATOR, 901), { ok: false, reason: 'invalid_id' });
    assert.deepEqual(await cellPersistence.removeObject(NaN, ATOR, 901), { ok: false, reason: 'invalid_id' });
  });

  it('duas apresentacoes concorrentes do mesmo id: so uma ganha (item 4 do pedido)', async () => {
    const id = await dropar();
    giveItemCalls = [];

    const [a, b] = await Promise.all([
      cellPersistence.removeObject(id, ATOR, 901),
      cellPersistence.removeObject(id, ATOR, 901)
    ]);

    const vencedores = [a, b].filter((r) => r.ok);
    assert.equal(vencedores.length, 1, 'exatamente uma das duas chamadas concorrentes deveria ganhar');
    assert.equal(giveItemCalls.length, 1, 'o item so pode ser concedido uma vez');
  });
});

describe('cell-persistence — resolvedor de alvo TARGET_TYPES.OBJECT (Tarefa 5)', () => {
  beforeEach(resetar);

  function fakeRegisterResolver() {
    let resolver = null;
    const register = (type, fn) => { resolver = fn; };
    register.get = () => resolver;
    return register;
  }

  it('resolve um objeto que esta no cache', async () => {
    atoresAtivos = [ATOR];
    posicoes[ATOR] = { pos: [0, 0, 0], cellOrWorldDesc: CELULA_A };
    const drop = await cellPersistence.recordDrop({ actorId: ATOR, characterId: 901, baseId: 0x10, count: 1, category: 'weapon', value: 0 });

    const registrador = fakeRegisterResolver();
    cellPersistence.registerInteractionTarget(registrador);

    const alvo = registrador.get()(String(drop.id), ATOR);
    assert.ok(alvo);
    assert.equal(alvo.type, interactionRegistry.TARGET_TYPES.OBJECT);
    assert.equal(alvo.id, `object:${drop.id}`);
    assert.equal(typeof alvo.assertRange, 'function');
  });

  it('devolve null para id fora do cache (nunca existiu, ja foi pego, ou expirou)', () => {
    const registrador = fakeRegisterResolver();
    cellPersistence.registerInteractionTarget(registrador);
    assert.equal(registrador.get()('999999', ATOR), null);
  });

  it('devolve null para entrada nao numerica', () => {
    const registrador = fakeRegisterResolver();
    cellPersistence.registerInteractionTarget(registrador);
    assert.equal(registrador.get()('nao-e-um-id', ATOR), null);
    assert.equal(registrador.get()(undefined, ATOR), null);
  });

  it('assertRange aprova dentro do alcance e recusa fora', async () => {
    atoresAtivos = [ATOR];
    posicoes[ATOR] = { pos: [0, 0, 0], cellOrWorldDesc: CELULA_A };
    const drop = await cellPersistence.recordDrop({ actorId: ATOR, characterId: 901, baseId: 0x10, count: 1, category: 'weapon', value: 0 });

    const registrador = fakeRegisterResolver();
    cellPersistence.registerInteractionTarget(registrador);
    const alvo = registrador.get()(String(drop.id), ATOR);

    posicoes[ATOR] = { pos: [1, 0, 0], cellOrWorldDesc: CELULA_A }; // pertinho do objeto (dropado em [0,0,0])
    assert.equal(alvo.assertRange(ATOR, cellPersistence.PICKUP_RANGE).ok, true);

    posicoes[ATOR] = { pos: [cellPersistence.PICKUP_RANGE + 500, 0, 0], cellOrWorldDesc: CELULA_A };
    const longe = alvo.assertRange(ATOR, cellPersistence.PICKUP_RANGE);
    assert.equal(longe.ok, false);
  });
});

describe('cell-persistence — interacao world_object.pickup (Tarefa 5)', () => {
  beforeEach(resetar);

  it('registra a interacao com o alcance e a categoria de policy corretos', () => {
    cellPersistence.registerPickupInteraction();
    const entry = interactionRegistry.get('world_object.pickup');
    assert.ok(entry);
    assert.equal(entry.target, interactionRegistry.TARGET_TYPES.OBJECT);
    assert.equal(entry.distance, cellPersistence.PICKUP_RANGE);
    assert.equal(entry.policyAction, cellPersistence.PICKUP_POLICY_ACTION);
    assert.equal(entry.audit, interactionRegistry.AUDIT_LEVELS.GAMEPLAY);
  });

  it('canSee e verdadeiro so enquanto o objeto estiver no cache', async () => {
    cellPersistence.registerPickupInteraction();
    const entry = interactionRegistry.get('world_object.pickup');

    atoresAtivos = [ATOR];
    posicoes[ATOR] = { pos: [0, 0, 0], cellOrWorldDesc: CELULA_A };
    const drop = await cellPersistence.recordDrop({ actorId: ATOR, characterId: 901, baseId: 0x10, count: 1, category: 'weapon', value: 0 });

    const ctxVisivel = { target: { id: `object:${drop.id}` } };
    assert.equal(await entry.canSee(ctxVisivel), true);

    await cellPersistence.removeObject(drop.id, ATOR, 901);
    assert.equal(await entry.canSee(ctxVisivel), false, 'depois de pego, nao deveria mais aparecer no menu de outra pessoa');
  });

  it('execute pega o item e devolve mensagem de sucesso', async () => {
    cellPersistence.registerPickupInteraction();
    const entry = interactionRegistry.get('world_object.pickup');

    atoresAtivos = [ATOR];
    posicoes[ATOR] = { pos: [0, 0, 0], cellOrWorldDesc: CELULA_A };
    const drop = await cellPersistence.recordDrop({ actorId: ATOR, characterId: 901, baseId: 0x10, count: 1, category: 'weapon', value: 0 });
    giveItemCalls = [];

    const resultado = await entry.execute({ actorId: ATOR, characterId: 901, target: { id: `object:${drop.id}` } });
    assert.equal(resultado.message, 'Você pegou o item.');
    assert.equal(giveItemCalls.length, 1);
  });

  it('execute lanca quando o item ja foi pego — o pipeline decide a mensagem generica pro jogador', async () => {
    cellPersistence.registerPickupInteraction();
    const entry = interactionRegistry.get('world_object.pickup');

    atoresAtivos = [ATOR];
    posicoes[ATOR] = { pos: [0, 0, 0], cellOrWorldDesc: CELULA_A };
    const drop = await cellPersistence.recordDrop({ actorId: ATOR, characterId: 901, baseId: 0x10, count: 1, category: 'weapon', value: 0 });
    await cellPersistence.removeObject(drop.id, ATOR, 901);
    giveItemCalls = [];

    await assert.rejects(
      entry.execute({ actorId: ATOR, characterId: 901, target: { id: `object:${drop.id}` } }),
      /already_gone/
    );
    assert.equal(giveItemCalls.length, 0);
  });
});
