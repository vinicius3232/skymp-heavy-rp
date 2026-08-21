/**
 * mining-service.test.js
 *
 * `mining.mine` roda contra o Interaction Framework de VERDADE
 * (`core/interaction-registry.js`, `core/interaction-targets.js`,
 * `core/interaction-service.js`, sem mock) — só `./profession-service`,
 * `./resource-node-service` e `./core/server-options` são interceptados via
 * `Module._load`, porque mining-service.js usa `require()` direto.
 *
 * Rodar contra o pipeline real, e não contra `handleMine` isolado, é o que
 * prova o que a §"Como a checagem de distância deixou de ser um gap" do
 * cabeçalho de `mining-service.js` afirma: que a distância é medida pelo
 * `core/interaction-service.js` ANTES de `execute` rodar — não uma promessa
 * no comentário.
 *
 * Executa com: node --test mining-service.test.js
 */

const assert = require('node:assert/strict');
const { describe, it, beforeEach, after } = require('node:test');

const interactionRegistry = require('./core/interaction-registry');
const { createTargetResolvers } = require('./core/interaction-targets');
const { createInteractionService } = require('./core/interaction-service');

// ─────────────────────────────────────────────────────────────────────────────
// Estado mutável dos mocks, resetado a cada teste em beforeEach.
// ─────────────────────────────────────────────────────────────────────────────

let nodeAtFormDesc = null; // o que resource-node-service.getNode() devolve
let consumeResult = { ok: true, data: { yield: 2, capacity: 10, maxCapacity: 20 } };
let xpPerGather = 2;
let maxDistance = 200;
let pickaxeCount = 1;

const addXpCalls = [];
const consumeCalls = [];
const getNodeCalls = [];

// Objetos únicos e estáveis: mining-service.js guarda estas referências num
// `require()` de topo de arquivo, então sobrescrever `.consume` num teste
// precisa mutar o MESMO objeto, não um literal novo por chamada de
// Module._load (mesma lição do resource-node-service em resource-node-service.test.js).
const professionServiceMock = {
  addProfessionXp: async (opts) => { addXpCalls.push(opts); return { ok: true }; }
};
const resourceNodeServiceMock = {
  getNode: async (formDesc) => { getNodeCalls.push(formDesc); return nodeAtFormDesc; },
  consume: async (opts) => { consumeCalls.push(opts); return consumeResult; }
};
const serverOptionsMock = {
  get: (key) => {
    if (key === 'mining.xpPerGather') return xpPerGather;
    if (key === 'mining.maxDistance') return maxDistance;
    return undefined;
  }
};

const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === './profession-service' || request.endsWith('/profession-service')) {
    return professionServiceMock;
  }
  if (request === './resource-node-service' || request.endsWith('/resource-node-service')) {
    return resourceNodeServiceMock;
  }
  if (request === './core/server-options' || request.endsWith('/core/server-options')) {
    return serverOptionsMock;
  }
  return originalLoad.apply(this, arguments);
};

const mining = require('./mining-service');

after(() => {
  Module._load = originalLoad;
  delete global.mp;
});

const ATOR = 0x100;
const VEIO_FORMID = 0xabc123;
const VEIO_FORMDESC = 'abc123:Skyrim.esm';

const posState = new Map(); // id (actorId ou formId) -> locationalData
function setPos(id, pos, cell = 'whiterun') {
  posState.set(id, { pos, cellOrWorldDesc: cell });
}

global.mp = {
  get: (id, prop) => (prop === 'locationalData' ? posState.get(id) || null : null),
  getDescFromId: (formId) => (formId === VEIO_FORMID ? VEIO_FORMDESC : `${formId.toString(16)}:Skyrim.esm`),
  callPapyrusFunction: (kind, className, fn) => (className === 'Actor' && fn === 'GetItemCount' ? pickaxeCount : null)
};

const characters = new Map([[ATOR, { characterId: 42, accountId: 1 }]]);
const getCharacter = actorId => characters.get(actorId) || null;

function montarServico() {
  const targets = createTargetResolvers({ getCharacter, logger: { warn() {}, error() {} } });
  return createInteractionService({
    registry: interactionRegistry,
    targets,
    getCharacter,
    notify: () => {},
    sendModal: () => {},
    logger: { log() {}, warn() {}, error() {} }
  });
}

const CODE_TO_MESSAGE = {
  depleted: 'Este veio está esgotado. Volte mais tarde.',
  node_disabled: 'Este veio não está disponível.',
  not_found: 'Não há nada para minerar aqui.',
  rank_too_low: 'Seu rank de Minerador ainda não é suficiente para este veio.',
  invalid_character: 'Personagem inválido.',
  invalid_form_desc: 'Alvo inválido.'
};

describe('mining-service — mining.mine no Interaction Framework', () => {
  beforeEach(() => {
    interactionRegistry._reset();
    mining.registerMiningInteractions();

    nodeAtFormDesc = { formDesc: VEIO_FORMDESC, enabled: true };
    consumeResult = { ok: true, data: { yield: 2, capacity: 10, maxCapacity: 20 } };
    xpPerGather = 2;
    maxDistance = 200;
    pickaxeCount = 1;
    addXpCalls.length = 0;
    consumeCalls.length = 0;
    getNodeCalls.length = 0;
    mining.activeGatherers.clear();

    posState.clear();
    setPos(ATOR, [0, 0, 0]);
    setPos(VEIO_FORMID, [10, 0, 0]); // perto: dentro de qualquer maxDistance razoável
  });

  it('registra com target object e a distância vem de mining.maxDistance', () => {
    const entry = interactionRegistry.get('mining.mine');
    assert.equal(entry.target, interactionRegistry.TARGET_TYPES.OBJECT);
    assert.equal(entry.distance, 200);
  });

  it('sem nó naquele FormId, a ação não aparece no menu (canSee)', async () => {
    nodeAtFormDesc = null;
    const service = montarServico();
    const result = await service.query(ATOR, { targetType: 'object', targetId: VEIO_FORMID });
    const acoes = result.sections.flatMap(s => s.actions.map(a => a.action));
    assert.ok(!acoes.includes('mining.mine'));
  });

  it('com nó cadastrado, a ação aparece no menu', async () => {
    const service = montarServico();
    const result = await service.query(ATOR, { targetType: 'object', targetId: VEIO_FORMID });
    const acoes = result.sections.flatMap(s => s.actions.map(a => a.action));
    assert.ok(acoes.includes('mining.mine'));
  });

  it('longe do veio, execute recusa no estágio de distância e não consome', async () => {
    setPos(VEIO_FORMID, [100000, 0, 0]);
    const service = montarServico();
    const r = await service.execute(ATOR, { action: 'mining.mine', targetId: VEIO_FORMID });
    assert.equal(r.ok, false);
    assert.equal(r.stage, service.STAGES.DISTANCE);
    assert.equal(consumeCalls.length, 0);
  });

  it('minera com sucesso: consome o nó, credita xp e libera o characterId', async () => {
    const service = montarServico();
    const r = await service.execute(ATOR, { action: 'mining.mine', targetId: VEIO_FORMID });

    assert.equal(r.ok, true);
    assert.equal(consumeCalls.length, 1);
    assert.deepEqual(consumeCalls[0], { characterId: 42, actorId: ATOR, formDesc: VEIO_FORMDESC });
    assert.equal(addXpCalls.length, 1);
    assert.equal(addXpCalls[0].amount, 2);
    assert.equal(addXpCalls[0].professionCode, 'miner');
    assert.equal(addXpCalls[0].characterId, 42);
    assert.match(r.message, /Você minerou 2x \(restam 10\/20 no veio\)\./);
    assert.ok(!mining.activeGatherers.has(42), 'finally deve liberar o characterId mesmo no sucesso');
  });

  it('nega sem picareta e não consome (checagem client-trusted, só decide se começa)', async () => {
    pickaxeCount = 0;
    const service = montarServico();
    const r = await service.execute(ATOR, { action: 'mining.mine', targetId: VEIO_FORMID });
    assert.equal(r.ok, true);
    assert.equal(r.message, 'Você precisa de uma picareta.');
    assert.equal(consumeCalls.length, 0);
  });

  it('bloqueia coleta concorrente pelo characterId', async () => {
    mining.activeGatherers.add(42);
    const service = montarServico();
    const r = await service.execute(ATOR, { action: 'mining.mine', targetId: VEIO_FORMID });
    assert.equal(r.message, 'Você já está ocupado fazendo algo.');
    assert.equal(consumeCalls.length, 0);
  });

  it('não credita xp quando mining.xpPerGather é 0', async () => {
    xpPerGather = 0;
    const service = montarServico();
    await service.execute(ATOR, { action: 'mining.mine', targetId: VEIO_FORMID });
    assert.equal(addXpCalls.length, 0);
  });

  for (const [code, esperado] of Object.entries(CODE_TO_MESSAGE)) {
    it(`mapeia consume() code='${code}' para a mensagem certa e não credita xp`, async () => {
      consumeResult = { ok: false, code };
      const service = montarServico();
      const r = await service.execute(ATOR, { action: 'mining.mine', targetId: VEIO_FORMID });
      assert.equal(r.message, esperado);
      assert.equal(addXpCalls.length, 0);
      assert.ok(!mining.activeGatherers.has(42));
    });
  }

  it('libera o characterId mesmo se consume() lançar', async () => {
    const original = resourceNodeServiceMock.consume;
    resourceNodeServiceMock.consume = async () => { throw new Error('conexao caiu'); };
    try {
      const service = montarServico();
      const r = await service.execute(ATOR, { action: 'mining.mine', targetId: VEIO_FORMID });
      assert.equal(r.ok, false);
      assert.equal(r.stage, service.STAGES.EXECUTE);
    } finally {
      resourceNodeServiceMock.consume = original;
    }
    assert.ok(!mining.activeGatherers.has(42), 'finally deve liberar o characterId mesmo quando consume() lanca');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ENABLE_MINING_RUNTIME_DIAGNOSTICS — instrumentação da homologação
// (docs/research/MINING_RUNTIME_VALIDATION_REPORT.md). Não muda resultado
// nenhum de canSee/execute, só loga. Cobertura: desligado por padrão (nada é
// impresso), ligado imprime as linhas esperadas com correlationId estável por
// chamada de execute().
// ─────────────────────────────────────────────────────────────────────────────

describe('mining-service — ENABLE_MINING_RUNTIME_DIAGNOSTICS [instrumentação, sem efeito em gameplay]', () => {
  beforeEach(() => {
    interactionRegistry._reset();
    mining.registerMiningInteractions();
    nodeAtFormDesc = { formDesc: VEIO_FORMDESC, enabled: true };
    consumeResult = { ok: true, data: { yield: 2, capacity: 10, maxCapacity: 20 } };
    xpPerGather = 2;
    pickaxeCount = 1;
    mining.activeGatherers.clear();
    posState.clear();
    setPos(ATOR, [0, 0, 0]);
    setPos(VEIO_FORMID, [10, 0, 0]);
    delete process.env.ENABLE_MINING_RUNTIME_DIAGNOSTICS;
  });

  it('desligado por padrão: nenhuma linha [mining:diag] é impressa', async (t) => {
    const logs = [];
    t.mock.method(console, 'log', (...args) => { logs.push(args.join(' ')); });
    const service = montarServico();
    await service.execute(ATOR, { action: 'mining.mine', targetId: VEIO_FORMID });
    assert.ok(!logs.some((l) => l.includes('[mining:diag]')), 'sem a flag, nenhuma linha de diagnostico deveria sair');
  });

  it('ligado: imprime target_received/target_resolved na consulta (canSee) e o ciclo completo no execute, com o MESMO correlationId dentro de um execute', async (t) => {
    process.env.ENABLE_MINING_RUNTIME_DIAGNOSTICS = 'true';
    const logs = [];
    t.mock.method(console, 'log', (...args) => { logs.push(args.join(' ')); });

    const service = montarServico();
    await service.query(ATOR, { targetType: 'object', targetId: VEIO_FORMID });
    assert.ok(logs.some((l) => l.includes('target_received')));
    assert.ok(logs.some((l) => l.includes('target_resolved') && l.includes('"nodeFound":true')));

    logs.length = 0;
    await service.execute(ATOR, { action: 'mining.mine', targetId: VEIO_FORMID });

    // `execute()` revalida via `canSee` antes de rodar `execute` de verdade (o
    // pipeline documentado é "...distância→canSee→canExecute→dedup→execute..."),
    // então `target_received`/`target_resolved` (correlationId 'n/a', de
    // propósito — canSee não pertence a uma tentativa específica) também
    // aparecem aqui. Só as linhas do PRÓPRIO execute() carregam o
    // correlationId gerado por `_newCorrelationId`.
    const linhasExecute = logs.filter((l) => l.includes('[mining:diag]') && !l.includes(' n/a '));
    assert.ok(linhasExecute.length >= 5, 'espera pelo menos execute_start/tool_check/form_desc_resolved/resource_node_consume/profession_xp_granted/execute_end');

    const ids = new Set(linhasExecute.map((l) => l.split(' ')[1]));
    assert.equal(ids.size, 1, 'todas as linhas de UM execute() devem carregar o MESMO correlationId');

    assert.ok(linhasExecute.some((l) => l.includes('execute_start')));
    assert.ok(linhasExecute.some((l) => l.includes('tool_check') && l.includes('"hasPickaxe":true')));
    assert.ok(linhasExecute.some((l) => l.includes('resource_node_consume') && l.includes('"ok":true')));
    assert.ok(linhasExecute.some((l) => l.includes('profession_xp_granted')));
    assert.ok(linhasExecute.some((l) => l.includes('execute_end')));
  });

  it('ligado, mas sem picareta: loga tool_check com hasPickaxe:false e para — não chega a resource_node_consume', async (t) => {
    process.env.ENABLE_MINING_RUNTIME_DIAGNOSTICS = 'true';
    pickaxeCount = 0;
    const logs = [];
    t.mock.method(console, 'log', (...args) => { logs.push(args.join(' ')); });

    const service = montarServico();
    await service.execute(ATOR, { action: 'mining.mine', targetId: VEIO_FORMID });

    assert.ok(logs.some((l) => l.includes('tool_check') && l.includes('"hasPickaxe":false')));
    assert.ok(!logs.some((l) => l.includes('resource_node_consume')));
  });

  it('duas execuções sequenciais geram correlationIds DIFERENTES entre si', async (t) => {
    process.env.ENABLE_MINING_RUNTIME_DIAGNOSTICS = 'true';
    const logs = [];
    t.mock.method(console, 'log', (...args) => { logs.push(args.join(' ')); });

    const service = montarServico();
    await service.execute(ATOR, { action: 'mining.mine', targetId: VEIO_FORMID });
    const idsExec1 = new Set(logs.filter((l) => l.includes('[mining:diag]') && !l.includes(' n/a ')).map((l) => l.split(' ')[1]));
    logs.length = 0;

    await service.execute(ATOR, { action: 'mining.mine', targetId: VEIO_FORMID });
    const idsExec2 = new Set(logs.filter((l) => l.includes('[mining:diag]') && !l.includes(' n/a ')).map((l) => l.split(' ')[1]));

    assert.equal(idsExec1.size, 1);
    assert.equal(idsExec2.size, 1);
    assert.notEqual([...idsExec1][0], [...idsExec2][0], 'cada execute() deveria correlacionar suas proprias linhas, nunca misturar com outra tentativa');
  });

  it('_diagnoseItemCountAvailability: sem mp._sp3ListMethods, loga skip e não lança', () => {
    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => { logs.push(args.join(' ')); };
    try {
      process.env.ENABLE_MINING_RUNTIME_DIAGNOSTICS = 'true';
      assert.doesNotThrow(() => mining._diagnoseItemCountAvailability());
      assert.ok(logs.some((l) => l.includes('itemcount_availability_check_skipped')));
    } finally {
      console.log = originalLog;
    }
  });

  it('_diagnoseItemCountAvailability: com mp._sp3ListMethods, reporta registrado:true/false por classe via _sp3ListMethods real (reflexão, não suposição)', () => {
    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => { logs.push(args.join(' ')); };
    global.mp._sp3ListMethods = (className) => {
      if (className === 'Actor') return ['IsWeaponDrawn', 'DrawWeapon'];       // sem GetItemCount
      if (className === 'ObjectReference') return ['GetItemCount', 'AddItem']; // com GetItemCount
      return [];
    };
    try {
      process.env.ENABLE_MINING_RUNTIME_DIAGNOSTICS = 'true';
      mining._diagnoseItemCountAvailability();
      assert.ok(logs.some((l) => l.includes('"className":"Actor"') && l.includes('"registrado":false')));
      assert.ok(logs.some((l) => l.includes('"className":"ObjectReference"') && l.includes('"registrado":true')));
    } finally {
      console.log = originalLog;
      delete global.mp._sp3ListMethods;
    }
  });

  it('_diagnoseItemCountAvailability: desligado por padrão, não chama _sp3ListMethods nem loga nada', () => {
    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => { logs.push(args.join(' ')); };
    let chamado = false;
    global.mp._sp3ListMethods = () => { chamado = true; return []; };
    try {
      mining._diagnoseItemCountAvailability();
      assert.equal(chamado, false);
      assert.equal(logs.length, 0);
    } finally {
      console.log = originalLog;
      delete global.mp._sp3ListMethods;
    }
  });
});
