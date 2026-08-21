/**
 * jobs-service.test.js — CHARACTERIZATION TESTS
 *
 * Congela o comportamento REAL de jobs-service.js hoje, antes da primeira
 * migração arquitetural deste domínio (ver docs/research/
 * WORK_ECOSYSTEM_DECISION_SUMMARY.md, "Next Implementation Task").
 *
 * Isto NÃO afirma que o comportamento é desejável. Vários testes aqui estão
 * marcados `LEGACY CHARACTERIZATION` — provam o que o código faz hoje, não o
 * que ele deveria fazer quando `jobs-service` for sucedido por Public Work
 * (docs/technical/ADR_011_PUBLIC_WORK.md). Nenhum bug conhecido foi corrigido
 * nesta rodada: `Math.random()` como origem da recompensa, ausência de
 * cooldown, ausência de Interaction Framework, ausência de Profession/
 * Resource Node em `mineOre` — tudo isso é caracterizado, não resolvido.
 *
 * `jobs-service.js` usa `require()` direto (sem injeção de dependência), então
 * `./commands` e `./core/transaction-service` são interceptados via
 * `Module._load`, no mesmo padrão de mining-service.test.js. `./core/papyrus`
 * NÃO é mockado — `actorRef()` real roda contra o `global.mp` mockado abaixo,
 * porque é só uma leitura de `mp.getDescFromId`.
 *
 * setTimeout real (10s/15s/20s) é substituído por `t.mock.timers` do
 * `node:test` — cada teste habilita/avança/restaura os timers no próprio
 * escopo do `t`, sem estado global entre testes.
 *
 * Executa com: node --test jobs-service.test.js
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it, after } = require('node:test');

// ─────────────────────────────────────────────────────────────────────────────
// Mocks — objetos únicos e estáveis (jobs-service.js guarda a referência do
// `require()` de topo de arquivo; sobrescrever uma função precisa mutar o
// MESMO objeto, não substituir por um literal novo).
// ─────────────────────────────────────────────────────────────────────────────

const notifications = []; // [{actorId, text}]
const broadcasts = [];    // [{actorId, message, radius}]
const giveItemCalls = [];

let characters = new Map(); // actorId -> {characterId} | undefined
let giveItemImpl = async (opts) => { giveItemCalls.push(opts); return true; };
let toolCounts = new Map(); // toolBaseId -> count (default 1 se não listado)

const commandsMock = {
  getActiveCharacterData: (actorId) => characters.get(actorId) || null,
  broadcastProximityMessage: (actorId, message, radius) => { broadcasts.push({ actorId, message, radius }); }
};

const transactionServiceMock = {
  giveItem: async (opts) => giveItemImpl(opts)
};

const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === './commands' || request.endsWith('/commands')) return commandsMock;
  if (request === './core/transaction-service' || request.endsWith('/core/transaction-service')) return transactionServiceMock;
  return originalLoad.apply(this, arguments);
};

const jobs = require('./jobs-service');

after(() => {
  Module._load = originalLoad;
  delete global.mp;
});

global.mp = {
  getDescFromId: (formId) => `${formId.toString(16)}:Skyrim.esm`,
  callPapyrusFunction: (kind, className, fn, self, args) => {
    if (className === 'Debug' && fn === 'notification') {
      notifications.push({ text: args[0] });
      return null;
    }
    if (className === 'Actor' && fn === 'GetItemCount') {
      const toolBaseId = args[0];
      return toolCounts.has(toolBaseId) ? toolCounts.get(toolBaseId) : 1;
    }
    return null;
  }
};

// FormIDs lidos direto do código-fonte de jobs-service.js — são o contrato
// que estes testes protegem, não valores inventados pelo teste.
const ITEM_FIREWOOD = 0x00033760;
const ITEM_WOODCUTTER_AXE = 0x0002F2F4;
const ITEM_PICKAXE = 0x000E3C16;
const ITEM_IRON_ORE = 0x00071CF3;
const ITEM_CORUNDUM_ORE = 0x0005ACDB;
const ITEM_EBONY_ORE = 0x0005ACDC;
const FISH_SALMON = 0x00065C34;
const FISH_RIVER_BETTY = 0x00106E1A;
const FISH_SPADETAIL = 0x00106E19;

const ATOR = 0x100;
const CHAR_A = 42;

function resetState() {
  notifications.length = 0;
  broadcasts.length = 0;
  giveItemCalls.length = 0;
  characters = new Map([[ATOR, { characterId: CHAR_A }]]);
  giveItemImpl = async (opts) => { giveItemCalls.push(opts); return true; };
  toolCounts = new Map();
  jobs._activeGatherers.clear();
}

/** Avança o fake timer e libera a fila de microtasks para o `.then()`/`.catch()` do setTimeout terminar. */
async function tickAndFlush(t, ms) {
  t.mock.timers.tick(ms);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

// Fila de valores devolvidos por Math.random() em sequência, um por chamada.
function mockRandomSequence(t, values) {
  let i = 0;
  t.mock.method(Math, 'random', () => (i < values.length ? values[i++] : values[values.length - 1]));
}

// ─────────────────────────────────────────────────────────────────────────────
// commandDefs — CURRENT CONTRACT: só estes 3 comandos, lidos de commandDefs(),
// não da documentação (docs/gameplay não é fonte de verdade para isto).
// ─────────────────────────────────────────────────────────────────────────────

describe('jobs-service — commandDefs [CURRENT CONTRACT]', () => {
  it('registra exatamente /cortarlenha, /garimpar, /pescar — sem duplicata, sem comando a mais', () => {
    const defs = jobs.commandDefs();
    const nomes = defs.map((d) => d.name);
    assert.deepEqual(nomes.sort(), ['/cortarlenha', '/garimpar', '/pescar']);
    assert.equal(new Set(nomes).size, nomes.length, 'nenhum comando duplicado');
  });

  it('cada comando tem handler, usage e description', () => {
    for (const def of jobs.commandDefs()) {
      assert.equal(typeof def.handler, 'function');
      assert.equal(typeof def.usage, 'string');
      assert.equal(typeof def.description, 'string');
    }
  });

  it('/cortarlenha aciona chopWood — handler entrega ITEM_FIREWOOD ao terminar', async (t) => {
    resetState();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    mockRandomSequence(t, [0]); // woodAmount = floor(0*3)+1 = 1
    const handler = jobs.commandDefs().find((d) => d.name === '/cortarlenha').handler;
    handler(ATOR);
    await tickAndFlush(t, 10000);
    assert.equal(giveItemCalls.length, 1);
    assert.equal(giveItemCalls[0].baseId, ITEM_FIREWOOD);
  });

  it('/garimpar aciona mineOre — handler entrega minério ao terminar', async (t) => {
    resetState();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    mockRandomSequence(t, [0, 0]); // chance=0 (ferro), amount=floor(0*2)+1=1
    const handler = jobs.commandDefs().find((d) => d.name === '/garimpar').handler;
    handler(ATOR);
    await tickAndFlush(t, 15000);
    assert.equal(giveItemCalls.length, 1);
    assert.equal(giveItemCalls[0].baseId, ITEM_IRON_ORE);
  });

  it('/pescar aciona catchFish — handler entrega peixe ao terminar', async (t) => {
    resetState();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    mockRandomSequence(t, [0.9]); // > 0.8 => River Betty
    const handler = jobs.commandDefs().find((d) => d.name === '/pescar').handler;
    handler(ATOR);
    await tickAndFlush(t, 20000);
    assert.equal(giveItemCalls.length, 1);
    assert.equal(giveItemCalls[0].baseId, FISH_RIVER_BETTY);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Personagem inválido / sem ferramenta — CURRENT CONTRACT
// ─────────────────────────────────────────────────────────────────────────────

describe('jobs-service — personagem e ferramenta [CURRENT CONTRACT]', () => {
  it('actorId sem personagem carregado: notifica e não entrega nada, nenhum timer agendado', async (t) => {
    resetState();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    characters = new Map(); // ninguém carregado
    jobs.chopWood(ATOR);
    await tickAndFlush(t, 10000);
    assert.equal(giveItemCalls.length, 0);
    assert.ok(notifications.some((n) => n.text === 'Personagem nao carregado.'));
  });

  it('sem a ferramenta exigida (machado), chopWood recusa e não agenda entrega', async (t) => {
    resetState();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    toolCounts.set(ITEM_WOODCUTTER_AXE, 0);
    jobs.chopWood(ATOR);
    await tickAndFlush(t, 10000);
    assert.equal(giveItemCalls.length, 0);
    assert.ok(notifications.some((n) => n.text === 'Você precisa de um Machado de Lenhador.'));
  });

  it('sem a ferramenta exigida (picareta), mineOre recusa e não agenda entrega', async (t) => {
    resetState();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    toolCounts.set(ITEM_PICKAXE, 0);
    jobs.mineOre(ATOR);
    await tickAndFlush(t, 15000);
    assert.equal(giveItemCalls.length, 0);
    assert.ok(notifications.some((n) => n.text === 'Você precisa de uma Picareta.'));
  });

  it('catchFish NÃO exige ferramenta hoje (toolBaseId=null no código) [LEGACY CHARACTERIZATION — TODO no próprio arquivo]', async (t) => {
    resetState();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    mockRandomSequence(t, [0.9]);
    jobs.catchFish(ATOR);
    await tickAndFlush(t, 20000);
    assert.equal(giveItemCalls.length, 1, 'entregou sem checar ferramenta nenhuma');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// chopWood — CURRENT CONTRACT (mecanismo de entrega) + comportamento de RNG
// ─────────────────────────────────────────────────────────────────────────────

describe('jobs-service — chopWood', () => {
  it('[CURRENT CONTRACT] entrega via transactionService.giveItem com module=jobs, reason=woodcutting', async (t) => {
    resetState();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    mockRandomSequence(t, [0.999]);
    jobs.chopWood(ATOR);
    await tickAndFlush(t, 10000);

    assert.equal(giveItemCalls.length, 1);
    const call = giveItemCalls[0];
    assert.equal(call.actorId, ATOR);
    assert.equal(call.characterId, CHAR_A);
    assert.equal(call.baseId, ITEM_FIREWOOD);
    assert.equal(call.reason, 'woodcutting');
    assert.equal(call.module, 'jobs');
    assert.equal(typeof call.idempotencyKey, 'string');
    assert.ok(call.idempotencyKey.startsWith('jobs_woodcutting_42_'));
  });

  it('[LEGACY CHARACTERIZATION] quantidade vem de Math.random(): floor(rand*3)+1, faixa 1..3', async (t) => {
    resetState();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    mockRandomSequence(t, [0]); // floor(0*3)+1 = 1
    jobs.chopWood(ATOR);
    await tickAndFlush(t, 10000);
    assert.equal(giveItemCalls[0].count, 1);
  });

  it('[LEGACY CHARACTERIZATION] Math.random() próximo de 1 produz o teto da faixa (3)', async (t) => {
    resetState();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    mockRandomSequence(t, [0.999]); // floor(0.999*3)+1 = 3
    jobs.chopWood(ATOR);
    await tickAndFlush(t, 10000);
    assert.equal(giveItemCalls[0].count, 3);
  });

  it('avisa e notifica o jogador ao terminar', async (t) => {
    resetState();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    mockRandomSequence(t, [0]);
    jobs.chopWood(ATOR);
    await tickAndFlush(t, 10000);
    assert.ok(notifications.some((n) => n.text === 'Você coletou 1x Lenha.'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// mineOre — CURRENT CONTRACT (entrega) + LEGACY CHARACTERIZATION (ausência de
// Profession/Resource Node/distância — a duplicação com mining-service que a
// auditoria encontrou)
// ─────────────────────────────────────────────────────────────────────────────

describe('jobs-service — mineOre', () => {
  it('[CURRENT CONTRACT] entrega via transactionService.giveItem com module=jobs, reason=mining', async (t) => {
    resetState();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    mockRandomSequence(t, [0, 0]);
    jobs.mineOre(ATOR);
    await tickAndFlush(t, 15000);

    const call = giveItemCalls[0];
    assert.equal(call.actorId, ATOR);
    assert.equal(call.characterId, CHAR_A);
    assert.equal(call.reason, 'mining');
    assert.equal(call.module, 'jobs');
    assert.ok(call.idempotencyKey.startsWith('jobs_mining_42_'));
  });

  it('[LEGACY CHARACTERIZATION] Math.random() <= 0.6 entrega Minério de Ferro', async (t) => {
    resetState();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    mockRandomSequence(t, [0.5, 0]);
    jobs.mineOre(ATOR);
    await tickAndFlush(t, 15000);
    assert.equal(giveItemCalls[0].baseId, ITEM_IRON_ORE);
  });

  it('[LEGACY CHARACTERIZATION] 0.6 < Math.random() <= 0.9 entrega Minério de Corundum', async (t) => {
    resetState();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    mockRandomSequence(t, [0.7, 0]);
    jobs.mineOre(ATOR);
    await tickAndFlush(t, 15000);
    assert.equal(giveItemCalls[0].baseId, ITEM_CORUNDUM_ORE);
  });

  it('[LEGACY CHARACTERIZATION] Math.random() > 0.9 entrega Minério de Ébano', async (t) => {
    resetState();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    mockRandomSequence(t, [0.95, 0]);
    jobs.mineOre(ATOR);
    await tickAndFlush(t, 15000);
    assert.equal(giveItemCalls[0].baseId, ITEM_EBONY_ORE);
  });

  it('[LEGACY CHARACTERIZATION] quantidade: floor(rand*2)+1, faixa 1..2', async (t) => {
    resetState();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    mockRandomSequence(t, [0, 0.999]);
    jobs.mineOre(ATOR);
    await tickAndFlush(t, 15000);
    assert.equal(giveItemCalls[0].count, 2);
  });

  it('[LEGACY CHARACTERIZATION] não consulta profession-service nem resource-node-service — a duplicação com mining-service que a auditoria encontrou (WORK_PROFESSION_ECOSYSTEM_CURRENT_STATE.md §15)', () => {
    const source = fs.readFileSync(path.resolve(__dirname, 'jobs-service.js'), 'utf8');
    assert.ok(!/require\(['"]\.\/profession-service['"]\)/.test(source), 'jobs-service.js não deveria (e hoje não) requerer profession-service');
    assert.ok(!/require\(['"]\.\/resource-node-service['"]\)/.test(source), 'jobs-service.js não deveria (e hoje não) requerer resource-node-service');
    assert.ok(!/require\(['"]\.\/core\/interaction-registry['"]\)/.test(source), 'jobs-service.js não deveria (e hoje não) requerer o Interaction Framework');
  });

  it('[LEGACY CHARACTERIZATION] mineOre entrega minério mesmo sem nenhuma profissão concedida ao personagem — mockRandomSequence prova que nada além de RNG decide o resultado', async (t) => {
    resetState();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    // Nenhum mock de profession-service existe neste arquivo — se mineOre
    // consultasse profession-service, esta chamada quebraria por módulo
    // ausente/real sendo carregado. Ela não quebra: é a prova por ausência.
    mockRandomSequence(t, [0, 0]);
    jobs.mineOre(ATOR);
    await tickAndFlush(t, 15000);
    assert.equal(giveItemCalls.length, 1, 'entregou sem checar profissão nenhuma');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// catchFish — CURRENT CONTRACT + o caso "peixe escapou" (sem entrega)
// ─────────────────────────────────────────────────────────────────────────────

describe('jobs-service — catchFish', () => {
  for (const [desc, rand, esperado] of [
    ['> 0.8 entrega River Betty', 0.9, FISH_RIVER_BETTY],
    ['0.5..0.8 entrega Spadetail', 0.6, FISH_SPADETAIL],
    ['0.2..0.5 entrega Salmão', 0.3, FISH_SALMON]
  ]) {
    it(`[LEGACY CHARACTERIZATION] Math.random() ${desc}`, async (t) => {
      resetState();
      t.mock.timers.enable({ apis: ['setTimeout'] });
      mockRandomSequence(t, [rand]);
      jobs.catchFish(ATOR);
      await tickAndFlush(t, 20000);
      assert.equal(giveItemCalls[0].baseId, esperado);
      assert.equal(giveItemCalls[0].count, 1);
      assert.equal(giveItemCalls[0].reason, 'fishing');
    });
  }

  it('[CURRENT CONTRACT] Math.random() <= 0.2: peixe escapa — nenhuma entrega, characterId liberado imediatamente', async (t) => {
    resetState();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    mockRandomSequence(t, [0.1]);
    jobs.catchFish(ATOR);
    await tickAndFlush(t, 20000);
    assert.equal(giveItemCalls.length, 0, 'não chama transactionService.giveItem quando não há peixe');
    assert.ok(!jobs._activeGatherers.has(CHAR_A), 'libera o slot mesmo sem entrega, senão o jogador travaria');
    assert.ok(notifications.some((n) => n.text === 'O peixe escapou!'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Repetição — CURRENT CONTRACT: sem cooldown próprio, caracterizado como
// LEGACY porque Public Work (ADR 011) exige cooldown obrigatório.
// ─────────────────────────────────────────────────────────────────────────────

describe('jobs-service — repetição [LEGACY CHARACTERIZATION]', () => {
  it('allows_repeated_work_calls_without_service_cooldown_current_behavior', async (t) => {
    resetState();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    mockRandomSequence(t, [0, 0, 0]);

    jobs.chopWood(ATOR);
    await tickAndFlush(t, 10000);
    assert.equal(giveItemCalls.length, 1, 'primeira coleta entregue');

    // Nada no serviço registra "quando foi a última vez que este personagem
    // trabalhou" — o único freio é `activeGatherers`, que já foi liberado no
    // `finally` implícito de `_finishGather`. Uma segunda chamada imediata é
    // aceita sem nenhuma espera.
    jobs.chopWood(ATOR);
    await tickAndFlush(t, 10000);
    assert.equal(giveItemCalls.length, 2, 'segunda coleta, imediatamente em seguida, também é aceita — sem cooldown');
  });

  it('bloqueia SOMENTE coleta concorrente (mesmo characterId, ainda em andamento) — não é cooldown, é lock de sessão', async (t) => {
    resetState();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    mockRandomSequence(t, [0]);

    jobs.chopWood(ATOR); // inicia, ainda não terminou (timer de 10s não avançou)
    jobs.chopWood(ATOR); // segunda chamada enquanto a primeira está "em andamento"

    await tickAndFlush(t, 10000);
    assert.equal(giveItemCalls.length, 1, 'só a primeira gerou entrega — a segunda foi recusada por concorrência, não por cooldown');
    assert.ok(notifications.some((n) => n.text === 'Você já está ocupado fazendo algo.'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Falha de transactionService.giveItem — CURRENT CONTRACT
// ─────────────────────────────────────────────────────────────────────────────

describe('jobs-service — falha de transactionService.giveItem [CURRENT CONTRACT]', () => {
  it('giveItem devolve false: notifica falha, não reporta sucesso, uma única tentativa', async (t) => {
    resetState();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    mockRandomSequence(t, [0]);
    giveItemImpl = async (opts) => { giveItemCalls.push(opts); return false; };

    jobs.chopWood(ATOR);
    await tickAndFlush(t, 10000);

    assert.equal(giveItemCalls.length, 1, 'não existe segunda tentativa/retry automático');
    assert.ok(notifications.some((n) => n.text === 'A coleta se perdeu antes de chegar na sua mochila.'));
    assert.ok(!notifications.some((n) => n.text.includes('Você coletou')), 'não anuncia sucesso quando a entrega falhou');
    assert.ok(!jobs._activeGatherers.has(CHAR_A), 'libera o slot mesmo em falha, senão o jogador travaria para sempre');
  });

  it('giveItem lança: erro é capturado pelo .catch() do próprio jobs-service, não propaga para o chamador', async (t) => {
    resetState();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    mockRandomSequence(t, [0]);
    giveItemImpl = async () => { throw new Error('conexao com o banco caiu'); };

    // chopWood() não é async e não devolve promise: se o erro escapasse do
    // setTimeout ele viraria unhandledRejection, não uma exceção síncrona
    // aqui. O teste prova que a chamada em si não lança.
    assert.doesNotThrow(() => jobs.chopWood(ATOR));
    await tickAndFlush(t, 10000);

    assert.ok(!notifications.some((n) => n.text.includes('Você coletou')), 'não anuncia sucesso quando giveItem lançou');
  });

  it('sessão hijack: personagem no slot muda entre início e fim — não entrega, char original permanece liberado', async (t) => {
    resetState();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    mockRandomSequence(t, [0]);

    jobs.chopWood(ATOR); // inicia como CHAR_A
    characters.set(ATOR, { characterId: 999 }); // outro personagem assume o mesmo actorId/slot
    await tickAndFlush(t, 10000);

    assert.equal(giveItemCalls.length, 0, 'não entrega para ninguém quando o slot trocou de dono no meio da coleta');
    assert.ok(!jobs._activeGatherers.has(CHAR_A), 'characterId original é liberado no finally implícito, mesmo descartando a coleta');
  });
});
