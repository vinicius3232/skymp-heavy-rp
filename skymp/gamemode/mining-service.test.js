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
