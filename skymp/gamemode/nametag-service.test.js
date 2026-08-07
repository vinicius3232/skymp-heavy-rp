/**
 * nametag-service.test.js
 *
 * O que estes testes provam: que o servidor escolhe o alvo certo e resolve o
 * nome certo POR OBSERVADOR.
 *
 * O que eles **não** provam, e nenhum teste em Node poderia: que a etiqueta
 * aparece na tela, no lugar certo, para a pessoa certa. Isso depende de
 * `worldPointToScreenPoint` responder o que a documentação do SkyMP diz que ela
 * responde, e ninguém deste projeto chamou essa função ainda. Ver
 * `nametag-service.js` §4 — a lista do que está e do que não está provado é
 * parte do entregável, não rodapé.
 *
 * A última suíte é diferente das outras: ela lê o snippet de cliente como TEXTO
 * e reprova padrões proibidos. É a única forma de proteger uma decisão sobre
 * código que roda numa máquina que este processo nunca vê.
 *
 * Executa com: node --test nametag-service.test.js
 */

const assert = require('assert');
const { describe, it, beforeEach, after } = require('node:test');

// ─────────────────────────────────────────────────────────────────────────────
// Mocks
// ─────────────────────────────────────────────────────────────────────────────

const OBSERVADOR = 0xff00d001;
const PERTO = 0xff00d002;
const LONGE = 0xff00d003;
const OUTRA_CELULA = 0xff00d004;

const CHAR = {
  [OBSERVADOR]:    { characterId: 901, firstName: 'Alvara', lastName: 'Dawnmere', accountId: 91 },
  [PERTO]:         { characterId: 902, firstName: 'Brenna', lastName: 'Coldhearth', accountId: 92 },
  [LONGE]:         { characterId: 903, firstName: 'Corvo',  lastName: 'Mendax', accountId: 93 },
  [OUTRA_CELULA]:  { characterId: 904, firstName: 'Dagna',  lastName: 'Stonehand', accountId: 94 }
};

let atoresAtivos = [];
let posicoes = {};

const Module = require('module');
const originalLoad = Module._load;

Module._load = function (request, parent, isMain) {
  if (request === './database' || request.endsWith('/database')) {
    return { init: () => {}, query: async () => [] };
  }
  if (request === './commands' || request.endsWith('/commands')) {
    return {
      listActiveActorIds: () => [...atoresAtivos],
      getActiveCharacterData: (actorId) => CHAR[actorId] || null,
      sendNotification: () => {}
    };
  }
  return originalLoad.apply(this, arguments);
};

const nametag = require('./nametag-service');
const identity = require('./identity-service');

// A property escrita por `tick()`. Chave: actorId do observador.
const propertyEscrita = new Map();

global.mp = {
  get: (actorId, prop) => (prop === 'locationalData' ? posicoes[actorId] : undefined),
  set: (actorId, prop, valor) => {
    if (prop === nametag.PROPERTY) propertyEscrita.set(actorId, valor);
  }
};

after(() => {
  Module._load = originalLoad;
  delete global.mp;
});

const CELULA_A = '3c:Skyrim.esm';
const CELULA_B = '1a2b:Skyrim.esm';

function cenarioPadrao() {
  atoresAtivos = [OBSERVADOR, PERTO, LONGE, OUTRA_CELULA];
  posicoes = {
    [OBSERVADOR]:   { pos: [0, 0, 0], cellOrWorldDesc: CELULA_A },
    // 300 unidades: dentro do alcance da fala.
    [PERTO]:        { pos: [300, 0, 0], cellOrWorldDesc: CELULA_A },
    // Bem além de `ALCANCE`, que vem do raio de fala normal.
    [LONGE]:        { pos: [nametag.ALCANCE + 500, 0, 0], cellOrWorldDesc: CELULA_A },
    // Colado no observador, mas em outra célula: interior vizinho.
    [OUTRA_CELULA]: { pos: [10, 0, 0], cellOrWorldDesc: CELULA_B }
  };
}

function candidatosDoCenario() {
  return atoresAtivos.map(actorId => ({
    actorId,
    pos: posicoes[actorId].pos,
    celula: posicoes[actorId].cellOrWorldDesc
  }));
}

function limparConhecimento() {
  for (const c of Object.values(CHAR)) identity.forgetKnownIdentities(c.characterId);
}

function resetar() {
  cenarioPadrao();
  propertyEscrita.clear();
  nametag._ultimoEnvio.clear();
  limparConhecimento();
}

// ─────────────────────────────────────────────────────────────────────────────

describe('nametag — escolha do alvo', () => {
  beforeEach(resetar);

  it('escolhe o mais proximo dentro do alcance', () => {
    const alvo = nametag.escolherAlvo(OBSERVADOR, candidatosDoCenario());
    assert.equal(alvo.actorId, PERTO);
  });

  it('ignora quem esta fora do alcance da fala', () => {
    atoresAtivos = [OBSERVADOR, LONGE];
    assert.equal(
      nametag.escolherAlvo(OBSERVADOR, candidatosDoCenario()), null,
      'alguem a mais de ALCANCE nao deveria receber etiqueta'
    );
  });

  it('ignora quem esta em outra celula, mesmo colado', () => {
    // `OUTRA_CELULA` está a 10 unidades — mais perto que `PERTO`, que está a 300.
    // Se a célula fosse ignorada, ele venceria. Etiqueta atravessando parede de
    // interior é pior que etiqueta ausente.
    atoresAtivos = [OBSERVADOR, PERTO, OUTRA_CELULA];
    assert.equal(nametag.escolherAlvo(OBSERVADOR, candidatosDoCenario()).actorId, PERTO);
  });

  it('nao escolhe o proprio observador', () => {
    atoresAtivos = [OBSERVADOR];
    assert.equal(nametag.escolherAlvo(OBSERVADOR, candidatosDoCenario()), null);
  });

  it('sem celula conhecida nao arrisca', () => {
    atoresAtivos = [OBSERVADOR, PERTO];
    posicoes[PERTO] = { pos: [300, 0, 0] };   // sem cellOrWorldDesc
    assert.equal(
      nametag.escolherAlvo(OBSERVADOR, candidatosDoCenario()), null,
      'sem saber a celula dos dois nao da pra afirmar que estao no mesmo lugar'
    );
  });

  it('desempata pela distancia, nao pela ordem da lista', () => {
    atoresAtivos = [OBSERVADOR, LONGE, PERTO];
    posicoes[LONGE] = { pos: [800, 0, 0], cellOrWorldDesc: CELULA_A };
    assert.equal(nametag.escolherAlvo(OBSERVADOR, candidatosDoCenario()).actorId, PERTO);
  });
});

describe('nametag — o texto sai do identity-service, por observador', () => {
  beforeEach(resetar);

  it('desconhecido aparece como Desconhecido', () => {
    const payload = nametag.montarPayload(OBSERVADOR, PERTO);
    assert.equal(payload.actorId, PERTO);
    assert.equal(payload.nome, identity.UNKNOWN_NAME);
  });

  it('conhecido aparece com o nome registrado', () => {
    identity.cacheKnownIdentity(CHAR[OBSERVADOR].characterId, CHAR[PERTO].characterId, 'Brenna Coldhearth', 'introduced');
    assert.equal(nametag.montarPayload(OBSERVADOR, PERTO).nome, 'Brenna Coldhearth');
  });

  it('apelido privado vale so para quem o deu', () => {
    // O requisito central do NAMETAG_IDENTITY_SYSTEM.md: dois observadores, o
    // mesmo alvo, nomes diferentes. Se a nametag resolvesse nome por conta
    // propria (a forma do disguise-service apagado — chave só no alvo), isto
    // devolveria a mesma coisa para os dois.
    identity.cacheKnownIdentity(CHAR[OBSERVADOR].characterId, CHAR[PERTO].characterId, 'A encapuzada', 'alias');

    assert.equal(nametag.montarPayload(OBSERVADOR, PERTO).nome, 'A encapuzada');
    assert.equal(nametag.montarPayload(LONGE, PERTO).nome, identity.UNKNOWN_NAME);
  });

  it('sem alvo o payload zera o actorId', () => {
    assert.deepEqual(nametag.montarPayload(OBSERVADOR, null), { actorId: null });
  });

  it('alvo que saiu no meio do tick nao vira etiqueta fantasma', () => {
    assert.deepEqual(nametag.montarPayload(OBSERVADOR, 0xff00dfff), { actorId: null });
  });
});

describe('nametag — o tick', () => {
  beforeEach(resetar);

  it('empurra a property com o alvo e o nome resolvido', () => {
    atoresAtivos = [OBSERVADOR, PERTO];
    nametag.tick();

    const enviado = propertyEscrita.get(OBSERVADOR);
    assert.ok(enviado, 'o observador deveria ter recebido a property');
    assert.equal(enviado.actorId, PERTO);
    assert.equal(enviado.nome, identity.UNKNOWN_NAME);
  });

  it('cada observador recebe o SEU nome para o mesmo alvo', () => {
    atoresAtivos = [OBSERVADOR, PERTO];
    identity.cacheKnownIdentity(CHAR[OBSERVADOR].characterId, CHAR[PERTO].characterId, 'Brenna', 'introduced');
    nametag.tick();

    assert.equal(propertyEscrita.get(OBSERVADOR).nome, 'Brenna');
    assert.equal(
      propertyEscrita.get(PERTO).nome, identity.UNKNOWN_NAME,
      'a apresentacao e unilateral — quem foi apresentado nao passa a conhecer de volta'
    );
  });

  it('nao reenvia payload identico no tick seguinte', () => {
    atoresAtivos = [OBSERVADOR, PERTO];
    nametag.tick();
    propertyEscrita.clear();
    nametag.tick();

    assert.equal(
      propertyEscrita.size, 0,
      'mp.set propaga pro cliente; reenviar o mesmo alvo com o mesmo nome a cada 2s e trafego que nao muda um pixel'
    );
  });

  it('reenvia quando o nome muda, mesmo com o alvo igual', () => {
    atoresAtivos = [OBSERVADOR, PERTO];
    nametag.tick();
    propertyEscrita.clear();

    identity.cacheKnownIdentity(CHAR[OBSERVADOR].characterId, CHAR[PERTO].characterId, 'Brenna', 'introduced');
    nametag.tick();

    assert.equal(propertyEscrita.get(OBSERVADOR).nome, 'Brenna');
  });

  it('quando o alvo se afasta, o cliente recebe actorId nulo', () => {
    atoresAtivos = [OBSERVADOR, PERTO];
    nametag.tick();
    propertyEscrita.clear();

    posicoes[PERTO] = { pos: [nametag.ALCANCE + 100, 0, 0], cellOrWorldDesc: CELULA_A };
    nametag.tick();

    assert.equal(
      propertyEscrita.get(OBSERVADOR).actorId, null,
      'sem isso a etiqueta ficaria pendurada no ultimo alvo conhecido'
    );
  });

  it('quem desconecta some do cache de diffing', () => {
    atoresAtivos = [OBSERVADOR, PERTO];
    nametag.tick();
    assert.ok(nametag._ultimoEnvio.has(PERTO));

    atoresAtivos = [OBSERVADOR];
    nametag.tick();
    assert.ok(
      !nametag._ultimoEnvio.has(PERTO),
      'cache chaveado por actorId que so cresce e vazamento — e o SkyMP reaproveita actorId entre sessoes'
    );
  });

  it('sozinho no mundo nao gera etiqueta', () => {
    atoresAtivos = [OBSERVADOR];
    nametag.tick();
    assert.equal(propertyEscrita.get(OBSERVADOR).actorId, null);
  });
});

/**
 * O snippet roda na máquina do jogador, dentro do loop do jogo. Nenhum teste
 * consegue executá-lo aqui — então o que dá para proteger é a forma dele.
 *
 * Estas asserções existem porque as decisões que elas guardam são as que se
 * perdem primeiro quando alguém "só ajusta rapidinho" o laço de tela.
 */
describe('nametag — o snippet de cliente respeita as decisoes que o cabecalho registra', () => {
  const snippet = nametag.SNIPPET_DO_CLIENTE;

  it('nao chama Papyrus, em nenhuma forma', () => {
    // A decisão inteira desta feature. Uma nametag que segue a cabeça em tempo
    // real com ida e volta ao Papyrus por pessoa por quadro inviabilizaria o
    // servidor — as medições do Red House dão 13–35 ms POR CHAMADA
    // (REFERENCE_STUDY_SKYMP_RED_HOUSE.md §4.1). `worldPointToScreenPoint` é
    // nativa do processo do jogo e por isso este caminho existe.
    for (const proibido of ['callPapyrusFunction', 'callNative', 'callGlobalFunction']) {
      assert.ok(
        !snippet.includes(proibido),
        `o laco de tela usa '${proibido}'. Se isso foi deliberado, a decisao mudou e o cabecalho ` +
        `de nametag-service.js precisa mudar junto — nao e um ajuste local.`
      );
    }
  });

  it('projeta pela API documentada', () => {
    assert.ok(snippet.includes('worldPointToScreenPoint'));
  });

  it('traduz o FormID de servidor para o do cliente', () => {
    // Sem isto o número cru aponta para outro objeto no espaço de forms do
    // cliente — mesmo detalhe que o hit-events já pagou para aprender.
    assert.ok(
      snippet.includes('getFormIdInClientFormat'),
      'FormID de servidor e de cliente sao espacos diferentes'
    );
  });

  it('estrangula a escrita na CEF', () => {
    assert.ok(
      snippet.includes(`< ${nametag.INTERVALO_DE_TELA_MS}`),
      'sem a guarda de intervalo o executeJavaScript roda a 60 Hz — custo nao medido, ver §2'
    );
  });

  it('registra o laco uma unica vez', () => {
    // `updateOwner` roda a cada mudança da property. Sem a guarda, cada tick que
    // muda o alvo penduraria mais um handler no `update` do jogo — o vazamento
    // cresceria pelo tempo de sessão e só apareceria como queda de FPS.
    assert.ok(snippet.includes('if (!nt.ligado)') && snippet.includes('nt.ligado = true'));
    assert.equal(
      (snippet.match(/ctx\.sp\.on\(/g) || []).length, 1,
      'mais de um registro de evento no snippet — confira a guarda'
    );
  });

  it('o cliente nunca escolhe o nome, so o repassa', () => {
    // Se o snippet montasse texto, o anonimato deixaria de existir: bastaria
    // editar o JS do cliente para ver o nome real de todo mundo.
    assert.ok(
      snippet.includes('nt.alvo.nome'),
      'o nome exibido tem que ser o que veio do servidor, sem transformacao'
    );
    assert.ok(
      !/getName|getBaseObject|getDisplayName/.test(snippet),
      'o snippet esta tentando descobrir o nome sozinho — o cliente nao pode ser autoridade sobre isso'
    );
  });
});
