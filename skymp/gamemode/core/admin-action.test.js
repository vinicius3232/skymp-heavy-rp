/**
 * core/admin-action.test.js
 *
 * O pipeline é a camada por onde toda ação administrativa passa. Um defeito
 * aqui não fica contido numa ação — ele vale para todas, nas quatro origens.
 *
 * ─── O que este arquivo mede, e o que ele recusa medir ──────────────────────
 *
 * Ele mede o **mecanismo**: a ordem das etapas, o que cada uma recusa, o que
 * chega ao serviço de domínio e o que vai para o registro. Ele **não** mede
 * regra de domínio — `admin-service.test.js` e `permissions.behavior.test.js`
 * fazem isso, contra os serviços reais, e continuam sendo o portão daquilo.
 *
 * A divisão importa: um teste de pipeline que chamasse `kickPlayer` de verdade
 * estaria medindo duas coisas e falharia por qualquer das duas.
 *
 * ─── As quatro classes de defeito que ele existe para pegar ─────────────────
 *
 *   1. **Identidade vinda de fora.** O pedido manda `role: 'owner'`,
 *      `staffAccountId`, `characterId` do alvo — e nada disso pode chegar a
 *      lugar nenhum. É a garantia central do desenho, e a única forma de
 *      prová-la é tentar burlar.
 *   2. **Etapa pulada.** Uma ação que execute sem passar por permissão, ou que
 *      resolva alvo antes de negar, ou que audite antes do efeito.
 *   3. **Desfecho colapsado.** "Não pode", "pedido errado", "o mundo disse não"
 *      e "quebrou" precisam continuar distinguíveis. Colapsá-los num booleano
 *      foi o que fez um timeout de rede virar mandado de prisão na multa da
 *      guarda.
 *   4. **Registro incompleto.** Uma negação sem linha, ou uma linha sem a etapa
 *      em que parou.
 *
 * Executa com: node --test core/admin-action.test.js
 */

'use strict';

const assert = require('assert');
const { describe, it, beforeEach } = require('node:test');

const {
  SOURCES, OUTCOMES, STAGES, REASON,
  createAdminActionRegistry,
  createAdminActionPipeline,
  defineAdminAction,
  formatAuditDetail
} = require('./admin-action');

// ─────────────────────────────────────────────────────────────────────────────
// Cenário
// ─────────────────────────────────────────────────────────────────────────────

let auditadas = [];
let executadas = [];
let cargoNoServidor = 'admin';
let alvoExiste = true;

/**
 * A sessão que o SERVIDOR resolve. Repare no que ela contém e no que o pedido
 * dos testes tenta injetar: os dois nunca coincidem, de propósito.
 */
async function resolveSession(source, sourceRef) {
  if (source !== SOURCES.COMMAND && source !== SOURCES.WEB) return null;
  if (sourceRef === 'anonimo') return null;
  return {
    sessionId: 'sessao-do-servidor',
    staffAccountId: 501,
    staffCharacterId: 9001,
    role: cargoNoServidor
  };
}

async function resolveTarget(kind, ref) {
  if (!alvoExiste) return null;
  if (kind !== 'player') return null;
  if (!ref) return null;
  return { actorId: 0xff01, characterId: 4242, accountId: 777, label: `alvo(${ref})` };
}

async function audit(entrada) {
  auditadas.push(entrada);
}

function novoRegistro() {
  const registry = createAdminActionRegistry();

  registry.register({
    id: 'players.kick',
    permission: 'players.kick',
    description: 'expulsa',
    target: 'player',
    reason: REASON.REQUIRED,
    execute: async (ctx) => {
      executadas.push(ctx);
      return { ok: true };
    }
  });

  registry.register({
    id: 'economy.adjust',
    permission: 'economy.adjust',
    description: 'ajusta ouro',
    target: 'player',
    reason: REASON.REQUIRED,
    parameters: { amount: { type: 'integer', required: true, min: 0, max: 1000 } },
    execute: async (ctx) => { executadas.push(ctx); return { ok: true }; }
  });

  registry.register({
    id: 'identity.reveal',
    permission: 'identity.reveal',
    description: 'revela',
    target: 'player',
    reason: REASON.REQUIRED,
    precondition: ({ target }) => target.characterId === 4242
      ? { ok: true }
      : { ok: false, reason: 'personagem incompatível' },
    execute: async (ctx) => { executadas.push(ctx); return { ok: true }; }
  });

  registry.register({
    id: 'server.view',
    permission: 'server.view',
    description: 'sem alvo, sem motivo',
    execute: async (ctx) => { executadas.push(ctx); return { ok: true, data: { visto: true } }; }
  });

  registry.register({
    id: 'voice.mute',
    permission: 'voice.mute',
    description: 'quebra de propósito',
    target: 'player',
    reason: REASON.NONE,
    execute: async () => { throw new Error('o serviço de domínio caiu'); }
  });

  return registry;
}

function novoPipeline(extra = {}) {
  return createAdminActionPipeline({
    registry: novoRegistro(),
    resolveSession,
    resolveTarget,
    audit,
    logger: { warn: () => {}, error: () => {} },
    ...extra
  });
}

beforeEach(() => {
  auditadas = [];
  executadas = [];
  cargoNoServidor = 'admin';
  alvoExiste = true;
});

const pedidoValido = {
  action: 'players.kick',
  source: SOURCES.COMMAND,
  sourceRef: 0xaa01,
  targetRef: '0xff01',
  reason: 'quebrou a regra 4'
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. Nada de identidade vem de fora
// ─────────────────────────────────────────────────────────────────────────────

describe('identidade é resolvida pelo servidor, nunca aceita do pedido', () => {
  it('ignora o cargo enviado no pedido', async () => {
    cargoNoServidor = 'moderator';
    const p = novoPipeline();

    const r = await p.run({
      ...pedidoValido,
      action: 'identity.reveal',
      // O moderador NÃO tem identity.reveal. O pedido mente sobre isso.
      role: 'owner',
      staff: { role: 'owner' },
      session: { role: 'owner' }
    });

    assert.equal(r.outcome, OUTCOMES.DENIED);
    assert.equal(r.stage, STAGES.PERMISSION);
    assert.equal(executadas.length, 0, 'a ação foi executada com um cargo que o pedido inventou');
  });

  it('ignora o staffAccountId enviado no pedido', async () => {
    const p = novoPipeline();
    const r = await p.run({ ...pedidoValido, staffAccountId: 1, accountId: 1 });

    assert.equal(r.outcome, OUTCOMES.EXECUTED);
    assert.equal(
      auditadas[0].staffAccountId, 501,
      'o registro guardou a conta que o PEDIDO mandou, não a que o servidor resolveu'
    );
  });

  it('ignora o staffCharacterId enviado no pedido', async () => {
    const p = novoPipeline();
    await p.run({ ...pedidoValido, staffCharacterId: 1, characterId: 1 });
    assert.equal(auditadas[0].staffCharacterId, 9001);
  });

  it('ignora o estado do alvo enviado no pedido', async () => {
    const p = novoPipeline();
    await p.run({
      ...pedidoValido,
      target: { characterId: 1, accountId: 1, label: 'alvo forjado' },
      targetCharacterId: 1
    });

    assert.equal(executadas[0].target.characterId, 4242, 'o alvo veio do pedido, não do servidor');
    assert.equal(executadas[0].target.accountId, 777);
    assert.equal(auditadas[0].target.accountId, 777);
  });

  it('o serviço de domínio nunca recebe o pedido cru', async () => {
    const p = novoPipeline();
    await p.run({ ...pedidoValido, role: 'owner', extra: 'nada disso pode chegar' });

    const ctx = executadas[0];
    assert.deepEqual(
      Object.keys(ctx).sort(), ['envelope', 'parameters', 'reason', 'session', 'target'],
      'o execute recebeu chaves além das cinco resolvidas pelo pipeline'
    );
    assert.equal(ctx.session.role, 'admin');
  });

  it('sem sessão de staff, nega na primeira etapa', async () => {
    const p = novoPipeline();
    const r = await p.run({ ...pedidoValido, sourceRef: 'anonimo' });

    assert.equal(r.outcome, OUTCOMES.DENIED);
    assert.equal(r.stage, STAGES.SESSION);
    assert.equal(executadas.length, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. A ordem das etapas
// ─────────────────────────────────────────────────────────────────────────────

describe('as etapas acontecem na ordem, e uma negação impede as seguintes', () => {
  it('permissão é checada ANTES de resolver o alvo', async () => {
    // Se o alvo fosse resolvido primeiro, quem não pode agir conseguiria
    // descobrir se um jogador está online mandando pedidos e lendo o motivo da
    // recusa — "alvo não encontrado" contra "permissão negada".
    cargoNoServidor = 'moderator';
    alvoExiste = false;
    const p = novoPipeline();

    const r = await p.run({ ...pedidoValido, action: 'identity.reveal' });
    assert.equal(r.stage, STAGES.PERMISSION, 'vazou a existência do alvo para quem não pode agir');
  });

  it('validação é checada antes de resolver o alvo', async () => {
    alvoExiste = false;
    const p = novoPipeline();
    const r = await p.run({ ...pedidoValido, reason: '' });
    assert.equal(r.stage, STAGES.VALIDATION);
  });

  it('estado é checado depois do alvo e antes do domínio', async () => {
    const p = createAdminActionPipeline({
      registry: novoRegistro(),
      resolveSession,
      resolveTarget: async () => ({ actorId: 1, characterId: 999, accountId: 2, label: 'outro' }),
      audit,
      logger: { warn: () => {}, error: () => {} }
    });

    const r = await p.run({ ...pedidoValido, action: 'identity.reveal' });
    assert.equal(r.outcome, OUTCOMES.BLOCKED);
    assert.equal(r.stage, STAGES.STATE);
    assert.equal(executadas.length, 0);
  });

  it('alvo ausente bloqueia, e não é confundido com negação', async () => {
    alvoExiste = false;
    const p = novoPipeline();
    const r = await p.run(pedidoValido);

    assert.equal(r.outcome, OUTCOMES.BLOCKED);
    assert.equal(r.stage, STAGES.TARGET);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Validação
// ─────────────────────────────────────────────────────────────────────────────

describe('validação de motivo e parâmetros', () => {
  it('motivo obrigatório ausente é INVALID, não DENIED', async () => {
    const p = novoPipeline();
    const r = await p.run({ ...pedidoValido, reason: '   ' });

    assert.equal(r.outcome, OUTCOMES.INVALID);
    assert.match(r.detail, /motivo/i);
  });

  it('parâmetro obrigatório ausente é recusado', async () => {
    const p = novoPipeline();
    const r = await p.run({ ...pedidoValido, action: 'economy.adjust', parameters: {} });

    assert.equal(r.outcome, OUTCOMES.INVALID);
    assert.match(r.detail, /amount/);
  });

  it('parâmetro fora do intervalo é recusado', async () => {
    const p = novoPipeline();
    const r = await p.run({ ...pedidoValido, action: 'economy.adjust', parameters: { amount: 5000 } });
    assert.equal(r.outcome, OUTCOMES.INVALID);
  });

  it('parâmetro NÃO declarado é recusado, não ignorado', async () => {
    // Ignorar é o comportamento perigoso: um parâmetro que o descritor não
    // declara é ou erro de quem chamou, ou tentativa de alcançar um caminho que
    // a ação não expõe.
    const p = novoPipeline();
    const r = await p.run({
      ...pedidoValido, action: 'economy.adjust',
      parameters: { amount: 10, characterId: 1 }
    });

    assert.equal(r.outcome, OUTCOMES.INVALID);
    assert.match(r.detail, /desconhecido/);
  });

  it('texto numérico é convertido, e lixo é recusado', async () => {
    const p = novoPipeline();

    const ok = await p.run({ ...pedidoValido, action: 'economy.adjust', parameters: { amount: '250' } });
    assert.equal(ok.outcome, OUTCOMES.EXECUTED);
    assert.strictEqual(executadas[0].parameters.amount, 250, 'deveria chegar como número');

    const ruim = await p.run({ ...pedidoValido, action: 'economy.adjust', parameters: { amount: 'muito' } });
    assert.equal(ruim.outcome, OUTCOMES.INVALID);
  });

  it('ação não registrada é recusada', async () => {
    const p = novoPipeline();
    const r = await p.run({ ...pedidoValido, action: 'players.explode' });
    assert.equal(r.outcome, OUTCOMES.INVALID);
  });

  it('origem desconhecida é recusada', async () => {
    const p = novoPipeline();
    const r = await p.run({ ...pedidoValido, source: 'curl' });
    assert.equal(r.outcome, OUTCOMES.INVALID);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Desfechos distintos
// ─────────────────────────────────────────────────────────────────────────────

describe('os desfechos não colapsam', () => {
  it('domínio que lança vira FAILED, não DENIED nem BLOCKED', async () => {
    const p = novoPipeline();
    const r = await p.run({ ...pedidoValido, action: 'voice.mute', reason: undefined });

    assert.equal(r.outcome, OUTCOMES.FAILED);
    assert.equal(r.stage, STAGES.EXECUTE);
    assert.match(r.detail, /caiu/);
  });

  it('domínio que recusa vira BLOCKED', async () => {
    const registry = novoRegistro();
    registry.register({
      id: 'players.teleport',
      permission: 'players.teleport',
      target: 'player',
      execute: async () => ({ ok: false, reason: 'jogador em zona segura' })
    });
    const p = createAdminActionPipeline({
      registry, resolveSession, resolveTarget, audit, logger: { warn: () => {}, error: () => {} }
    });

    const r = await p.run({ ...pedidoValido, action: 'players.teleport', reason: undefined });
    assert.equal(r.outcome, OUTCOMES.BLOCKED);
    assert.equal(r.detail, 'jogador em zona segura');
  });

  it('ação sem alvo e sem motivo executa e devolve dados', async () => {
    const p = novoPipeline();
    const r = await p.run({ action: 'server.view', source: SOURCES.WEB, sourceRef: {} });

    assert.equal(r.outcome, OUTCOMES.EXECUTED);
    assert.deepEqual(r.data, { visto: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Idempotência
// ─────────────────────────────────────────────────────────────────────────────

describe('idempotência por correlationId', () => {
  it('a segunda invocação com o mesmo id não executa de novo', async () => {
    const p = novoPipeline();
    const pedido = { ...pedidoValido, correlationId: 'clique-unico' };

    const primeira = await p.run(pedido);
    const segunda = await p.run(pedido);

    assert.equal(primeira.outcome, OUTCOMES.EXECUTED);
    assert.equal(segunda.outcome, OUTCOMES.DUPLICATE);
    assert.equal(executadas.length, 1, 'a ação aconteceu duas vezes');
  });

  it('uma ação que FALHOU pode ser reenviada com o mesmo id', async () => {
    // O `correlationId` não pode ser consumido por uma tentativa que não teve
    // efeito: senão a ação fica presa achando que já aconteceu, e a staff
    // precisa inventar um id novo para tentar de novo.
    const p = novoPipeline();
    const pedido = { ...pedidoValido, action: 'voice.mute', reason: undefined, correlationId: 'tentativa' };

    const falha = await p.run(pedido);
    assert.equal(falha.outcome, OUTCOMES.FAILED);

    const denovo = await p.run(pedido);
    assert.notEqual(denovo.outcome, OUTCOMES.DUPLICATE);
  });

  it('uma NEGAÇÃO não consome o id de quem pode', async () => {
    // Sem isto, quem não pode agir teria como bloquear a ação de quem pode:
    // bastaria enviar antes, com o id que a outra pessoa usaria.
    cargoNoServidor = 'moderator';
    const p = novoPipeline();
    const pedido = { ...pedidoValido, action: 'identity.reveal', correlationId: 'disputado' };

    const negada = await p.run(pedido);
    assert.equal(negada.outcome, OUTCOMES.DENIED);

    cargoNoServidor = 'owner';
    const permitida = await p.run(pedido);
    assert.equal(permitida.outcome, OUTCOMES.EXECUTED, 'a negação anterior travou o id');
  });

  it('ações diferentes com o mesmo id não se atrapalham', async () => {
    const p = novoPipeline();
    const a = await p.run({ ...pedidoValido, correlationId: 'x' });
    const b = await p.run({ ...pedidoValido, action: 'economy.adjust', parameters: { amount: 1 }, correlationId: 'x' });

    assert.equal(a.outcome, OUTCOMES.EXECUTED);
    assert.equal(b.outcome, OUTCOMES.EXECUTED);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Registro
// ─────────────────────────────────────────────────────────────────────────────

describe('auditoria', () => {
  it('TODO desfecho vira linha, inclusive negação e falha', async () => {
    const p = novoPipeline();
    cargoNoServidor = 'moderator';
    await p.run({ ...pedidoValido, action: 'identity.reveal' });          // denied
    await p.run({ ...pedidoValido, reason: '' });                          // invalid
    alvoExiste = false;
    await p.run(pedidoValido);                                             // blocked
    alvoExiste = true;
    cargoNoServidor = 'owner';
    await p.run({ ...pedidoValido, action: 'voice.mute', reason: undefined }); // failed
    await p.run(pedidoValido);                                             // executed

    const desfechos = auditadas.map((e) => e.outcome);
    assert.deepEqual(desfechos, ['denied', 'invalid', 'blocked', 'failed', 'executed']);
    for (const e of auditadas) {
      assert.ok(e.stage, 'toda linha precisa dizer em que etapa parou');
      assert.ok(e.correlationId, 'toda linha precisa do correlationId');
      assert.ok(e.actionId, 'toda linha precisa identificar a invocação');
    }
  });

  it('o envelope carrega os treze campos', async () => {
    const p = novoPipeline();
    await p.run(pedidoValido);
    const e = auditadas[0];

    for (const campo of [
      'actionId', 'correlationId', 'sessionId', 'staffAccountId', 'staffCharacterId',
      'permission', 'action', 'target', 'reason', 'parameters', 'source', 'requestedAt'
    ]) {
      assert.ok(campo in e, `o envelope não carrega '${campo}'`);
    }
    assert.equal(e.action, 'players.kick');
    assert.equal(e.permission, 'players.kick');
    assert.notEqual(e.actionId, e.correlationId, 'actionId identifica a invocação; correlationId liga invocações');
  });

  it('uma auditoria que falha não transforma negação em permissão', async () => {
    const p = createAdminActionPipeline({
      registry: novoRegistro(),
      resolveSession, resolveTarget,
      audit: async () => { throw new Error('banco fora'); },
      logger: { warn: () => {}, error: () => {} }
    });

    cargoNoServidor = 'moderator';
    const r = await p.run({ ...pedidoValido, action: 'identity.reveal' });
    assert.equal(r.outcome, OUTCOMES.DENIED, 'o banco caiu e a negação virou outra coisa');
  });

  it('o formato do detalhe é um só, e legível', async () => {
    const p = novoPipeline();
    await p.run({ ...pedidoValido, action: 'economy.adjust', parameters: { amount: 300 }, correlationId: 'c-1' });

    const linha = formatAuditDetail(auditadas[0]);
    assert.match(linha, /correlation=c-1/);
    assert.match(linha, /permission=economy\.adjust/);
    assert.match(linha, /outcome=executed/);
    assert.match(linha, /source=command/);
    assert.match(linha, /p\.amount=300/);
    assert.match(linha, /reason="quebrou a regra 4"/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. O descritor recusa erro de programação no carregamento
// ─────────────────────────────────────────────────────────────────────────────

describe('defineAdminAction falha cedo', () => {
  const base = { id: 'players.kick', permission: 'players.kick', execute: async () => ({ ok: true }) };

  it('recusa permissão fora do catálogo', () => {
    assert.throws(() => defineAdminAction({ ...base, permission: 'players.explode' }), /não existe no catálogo/);
  });

  it('recusa permissão RESERVADA', () => {
    // Uma ação atrás de uma reservada é uma ação que ninguém pode executar —
    // nem `owner`. Melhor o processo não subir do que a staff descobrir isso
    // tentando trabalhar.
    assert.throws(() => defineAdminAction({ ...base, permission: 'players.ban' }), /RESERVADA/);
  });

  it('recusa id malformado', () => {
    assert.throws(() => defineAdminAction({ ...base, id: 'Kick' }), /id inválido/);
  });

  it('recusa tipo de parâmetro desconhecido', () => {
    assert.throws(
      () => defineAdminAction({ ...base, parameters: { x: { type: 'json' } } }),
      /tipo 'json' desconhecido/
    );
  });

  it('recusa ação registrada duas vezes', () => {
    const r = createAdminActionRegistry();
    r.register(base);
    assert.throws(() => r.register(base), /duas vezes/);
  });
});
