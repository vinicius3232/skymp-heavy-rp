/**
 * core/voice/voice-spatial.test.js
 *
 * Áudio direcional.
 *
 * ## O erro que estes testes existem para pegar
 *
 * O sinal de `z`. Com `equalpower` — o modelo que a CEF vai rodar — a
 * panorâmica acontece quase toda no eixo esquerda/direita, e quem está na
 * frente soa praticamente igual a quem está atrás. Uma implementação com o
 * sinal de `z` trocado passa em **todo** teste de esquerda/direita e entrega
 * frente e trás invertidos.
 *
 * Por isso há caso de frente e caso de trás, separados, com a asserção no eixo
 * `z` e não no `x`.
 */

const test = require('node:test');
const assert = require('node:assert');

const { directionFor, quantizeDirection } = require('./voice-spatial');

const { describe, it } = test;

/** Olhando para o norte (+Y). É o `rot[2] = 0` do Skyrim. */
const NORTE = [0, 0, 0];
/** Olhando para o leste (+X). `rot[2]` cresce no sentido horário. */
const LESTE = [0, 0, 90];

const ORIGEM = [0, 0, 0];

/** Aproximadamente igual, com folga de arredondamento. */
function perto(atual, esperado, msg) {
  assert.ok(Math.abs(atual - esperado) < 0.02, `${msg}: ${atual} ≠ ${esperado}`);
}

describe('voice-spatial — o eixo que se erra', () => {
  it('quem está À FRENTE soa em -Z', () => {
    const dir = directionFor(ORIGEM, NORTE, [0, 100, 0]);
    perto(dir[2], -1, 'frente é -Z no Web Audio');
    perto(dir[0], 0, 'e não deve vazar para os lados');
  });

  it('quem está ATRÁS soa em +Z', () => {
    const dir = directionFor(ORIGEM, NORTE, [0, -100, 0]);
    perto(dir[2], 1, 'atrás é +Z');
    perto(dir[0], 0, 'idem');
  });

  it('frente e trás são OPOSTOS, não iguais', () => {
    const frente = directionFor(ORIGEM, NORTE, [0, 100, 0]);
    const tras = directionFor(ORIGEM, NORTE, [0, -100, 0]);
    assert.notStrictEqual(Math.sign(frente[2]), Math.sign(tras[2]),
      'o sinal trocado de z passa em todo teste de L/R e inverte frente e trás');
  });
});

describe('voice-spatial — esquerda e direita', () => {
  it('quem está a LESTE de quem olha para o norte soa à DIREITA (+X)', () => {
    const dir = directionFor(ORIGEM, NORTE, [100, 0, 0]);
    perto(dir[0], 1, 'leste é a direita de quem olha para o norte');
    perto(dir[2], 0, 'e não à frente');
  });

  it('quem está a OESTE soa à ESQUERDA (-X)', () => {
    const dir = directionFor(ORIGEM, NORTE, [-100, 0, 0]);
    perto(dir[0], -1);
  });

  /**
   * O teste que prova que a ORIENTAÇÃO do ouvinte é usada, e não só a posição.
   *
   * Mesmo locutor, mesmo lugar. O ouvinte gira 90°. Se a implementação
   * ignorasse `rot`, os dois resultados seriam idênticos — e o áudio ficaria
   * preso à rosa dos ventos em vez de à cabeça do jogador.
   */
  it('GIRAR o ouvinte move a fonte: quem estava à direita passa para a frente', () => {
    const olhandoNorte = directionFor(ORIGEM, NORTE, [100, 0, 0]);
    const olhandoLeste = directionFor(ORIGEM, LESTE, [100, 0, 0]);

    perto(olhandoNorte[0], 1, 'à direita antes de girar');
    perto(olhandoLeste[2], -1, 'à frente depois de girar');
    assert.notDeepStrictEqual(olhandoNorte, olhandoLeste,
      'ignorar rot prenderia o áudio à rosa dos ventos');
  });

  it('olhando para o leste, quem está ao norte soa à ESQUERDA', () => {
    const dir = directionFor(ORIGEM, LESTE, [0, 100, 0]);
    perto(dir[0], -1);
  });
});

describe('voice-spatial — altura e normalização', () => {
  it('quem está ACIMA soa em +Y', () => {
    const dir = directionFor(ORIGEM, NORTE, [0, 0, 100]);
    perto(dir[1], 1);
  });

  it('o vetor é sempre UNITÁRIO — a distância não viaja nele', () => {
    for (const alvo of [[10, 0, 0], [10000, 0, 0], [3, 4, 12], [-7, 2, -9]]) {
      const d = directionFor(ORIGEM, NORTE, alvo);
      const norma = Math.hypot(d[0], d[1], d[2]);
      perto(norma, 1, `norma de ${JSON.stringify(alvo)}`);
    }
  });

  it('perto e longe na MESMA direção dão o mesmo vetor', () => {
    const perto1 = directionFor(ORIGEM, NORTE, [100, 0, 0]);
    const longe = directionFor(ORIGEM, NORTE, [5000, 0, 0]);
    assert.deepStrictEqual(quantizeDirection(perto1), quantizeDirection(longe),
      'a atenuação por distância é do servidor e mora no volume, não aqui');
  });
});

describe('voice-spatial — bordas', () => {
  it('mesmo ponto devolve "à frente" em vez de um vetor nulo', () => {
    assert.deepStrictEqual(directionFor(ORIGEM, NORTE, [0, 0, 0]), [0, 0, -1],
      '[0,0,0] num PannerNode é o ouvinte dentro da fonte: panorâmica indefinida');
  });

  it('sem orientação, trata como olhando para o norte em vez de falhar', () => {
    const semRot = directionFor(ORIGEM, undefined, [100, 0, 0]);
    assert.deepStrictEqual(semRot, directionFor(ORIGEM, NORTE, [100, 0, 0]),
      'uma leitura sem orientação vale mais que uma pessoa sem rota');
  });

  it('posição malformada não lança', () => {
    assert.deepStrictEqual(directionFor(null, NORTE, [1, 2, 3]), [0, 0, -1]);
    assert.deepStrictEqual(directionFor(ORIGEM, NORTE, [1, 2]), [0, 0, -1]);
  });

  it('quantizar mantém o vetor praticamente unitário', () => {
    const d = quantizeDirection(directionFor(ORIGEM, NORTE, [1, 1, 1]));
    perto(Math.hypot(d[0], d[1], d[2]), 1, 'duas casas dão ~0.6° de resolução');
  });
});
