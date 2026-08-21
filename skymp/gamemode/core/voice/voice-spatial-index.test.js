/**
 * core/voice/voice-spatial-index.test.js
 *
 * O teste que importa aqui é o de **equivalência**: o índice espacial só vale
 * se der exatamente a mesma resposta que a varredura O(n²) que ele substitui.
 * Um índice mais rápido e ligeiramente errado seria pior que o laço lento — o
 * erro apareceria como alguém que não é ouvido de vez em quando, perto da
 * borda de um bucket, e ninguém ligaria isso à estrutura de dados.
 *
 * Por isso o caso central sorteia posições com semente fixa, roda os dois
 * caminhos e exige conjuntos idênticos. Semente fixa porque um teste que falha
 * uma vez a cada cem execuções é um teste que alguém vai marcar como instável e
 * desligar.
 *
 * Executa com: node --test core/voice/voice-spatial-index.test.js
 */

const assert = require('assert');
const { describe, it } = require('node:test');

const { createVoiceSpatialIndex, DEFAULT_BUCKET_SIZE } = require('./voice-spatial-index');
const { VOICE_RANGES } = require('../proximity-ranges');

const CELL = '162e2:Skyrim.esm';
const OUTRA = '1a2b3:Skyrim.esm';

/** Gerador determinístico — mulberry32. Semente fixa: o teste não pode piscar. */
function rng(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dist3(a, b) {
  const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** A varredura que o índice substitui, escrita à mão para servir de referência. */
function forcaBruta(samples, origin, radius) {
  return samples
    .filter((s) => s.actorId !== origin.actorId)
    .filter((s) => !origin.space || !s.space || s.space === origin.space)
    .filter((s) => dist3(s.pos, origin.pos) <= radius)
    .map((s) => s.actorId)
    .sort((a, b) => a - b);
}

function pelaConsulta(index, samples, origin, radius) {
  return index.queryWithin(origin, radius)
    .filter((s) => s.actorId !== origin.actorId)
    .filter((s) => dist3(s.pos, origin.pos) <= radius)
    .map((s) => s.actorId)
    .sort((a, b) => a - b);
}

describe('voice-spatial-index — equivalência com a varredura O(n²)', () => {
  it('dá exatamente o mesmo conjunto que a força bruta, nos três raios', () => {
    const random = rng(20260814);
    const espacos = [CELL, OUTRA, '4b1c:Skyrim.esm', null];
    /** @type {any[]} */
    const samples = [];
    for (let i = 0; i < 400; i++) {
      samples.push({
        actorId: 0x1000 + i,
        // O `null` entra de propósito: o caminho de espaço desconhecido é o
        // único de custo linear que sobrou, e ele precisa dar a mesma resposta.
        space: espacos[Math.floor(random() * espacos.length)],
        pos: [
          (random() - 0.5) * 40000,
          (random() - 0.5) * 40000,
          (random() - 0.5) * 2000
        ]
      });
    }

    const index = createVoiceSpatialIndex();
    index.rebuild(samples);

    for (const raio of Object.values(VOICE_RANGES)) {
      for (const origin of samples) {
        assert.deepStrictEqual(
          pelaConsulta(index, samples, origin, raio),
          forcaBruta(samples, origin, raio),
          `divergiu para ator 0x${origin.actorId.toString(16)} (space=${origin.space}) no raio ${raio}`
        );
      }
    }
  });

  it('a equivalência vale para qualquer tamanho de bucket', () => {
    const random = rng(7);
    const samples = [];
    for (let i = 0; i < 120; i++) {
      samples.push({
        actorId: i,
        space: CELL,
        pos: [(random() - 0.5) * 12000, (random() - 0.5) * 12000, 0]
      });
    }
    // Buckets menores que o raio, do tamanho do raio e maiores que ele: os três
    // regimes de `span` na consulta.
    for (const bucketSize of [128, 1200, DEFAULT_BUCKET_SIZE, 20000]) {
      const index = createVoiceSpatialIndex({ bucketSize });
      index.rebuild(samples);
      for (const origin of samples.slice(0, 30)) {
        assert.deepStrictEqual(
          pelaConsulta(index, samples, origin, VOICE_RANGES.normal),
          forcaBruta(samples, origin, VOICE_RANGES.normal),
          `bucketSize ${bucketSize} divergiu`
        );
      }
    }
  });
});

describe('voice-spatial-index — separação por espaço', () => {
  it('nunca devolve candidato de outro espaço', () => {
    const index = createVoiceSpatialIndex();
    index.rebuild([
      { actorId: 1, space: CELL, pos: [0, 0, 0] },
      { actorId: 2, space: OUTRA, pos: [0, 0, 0] },
      { actorId: 3, space: CELL, pos: [100, 0, 0] }
    ]);
    const encontrados = index.queryWithin({ actorId: 1, space: CELL, pos: [0, 0, 0] }, 5000)
      .map((s) => s.actorId).sort();
    assert.deepStrictEqual(encontrados, [1, 3], 'o ator 2 está na mesma coordenada, em outra célula');
  });

  it('quem não tem espaço conhecido entra em toda consulta', () => {
    const index = createVoiceSpatialIndex();
    index.rebuild([
      { actorId: 1, space: CELL, pos: [0, 0, 0] },
      { actorId: 2, space: null, pos: [50, 0, 0] }
    ]);
    const encontrados = index.queryWithin({ actorId: 1, space: CELL, pos: [0, 0, 0] }, 1000)
      .map((s) => s.actorId).sort();
    assert.deepStrictEqual(encontrados, [1, 2]);
  });

  it('origem sem espaço conhecido varre tudo — e o contador registra', () => {
    const chamadas = [];
    const metrics = {
      count: (n) => chamadas.push(n), observe: () => {}, timer: () => () => 0,
      stats: () => null, snapshot: () => ({}), reset: () => {}
    };
    const index = createVoiceSpatialIndex({ metrics });
    index.rebuild([
      { actorId: 1, space: null, pos: [0, 0, 0] },
      { actorId: 2, space: CELL, pos: [10, 0, 0] },
      { actorId: 3, space: OUTRA, pos: [10, 0, 0] }
    ]);
    const encontrados = index.queryWithin({ actorId: 1, space: null, pos: [0, 0, 0] }, 1000)
      .map((s) => s.actorId).sort();
    assert.deepStrictEqual(encontrados, [1, 2, 3]);
    assert.ok(chamadas.includes('spatial.query.fullScan'), 'a varredura completa tem que ser contada');
  });
});

describe('voice-spatial-index — reconstrução e higiene', () => {
  it('rebuild descarta o conteúdo anterior por completo', () => {
    const index = createVoiceSpatialIndex();
    index.rebuild([{ actorId: 1, space: CELL, pos: [0, 0, 0] }]);
    index.rebuild([{ actorId: 2, space: CELL, pos: [0, 0, 0] }]);
    const ids = index.queryWithin({ actorId: 9, space: CELL, pos: [0, 0, 0] }, 100).map((s) => s.actorId);
    assert.deepStrictEqual(ids, [2], 'o ator 1 não pode sobreviver ao rebuild');
  });

  it('amostra sem posição válida é descartada em vez de derrubar o rebuild', () => {
    const index = createVoiceSpatialIndex();
    const r = index.rebuild([
      { actorId: 1, space: CELL, pos: [0, 0, 0] },
      { actorId: 2, space: CELL, pos: null },
      { actorId: 3, space: CELL, pos: [1, 2] },
      null
    ]);
    assert.strictEqual(r.total, 1);
  });

  it('raio inválido devolve lista vazia em vez de varrer o servidor', () => {
    const index = createVoiceSpatialIndex();
    index.rebuild([{ actorId: 1, space: CELL, pos: [0, 0, 0] }]);
    assert.deepStrictEqual(index.queryWithin({ actorId: 2, space: CELL, pos: [0, 0, 0] }, 0), []);
    assert.deepStrictEqual(index.queryWithin({ actorId: 2, space: CELL, pos: [0, 0, 0] }, -1), []);
    assert.deepStrictEqual(index.queryWithin({ actorId: 2, space: CELL, pos: [0, 0, 0] }, NaN), []);
  });

  it('bucketSize inválido falha alto, no construtor', () => {
    assert.throws(() => createVoiceSpatialIndex({ bucketSize: 0 }), /bucketSize inválido/);
    assert.throws(() => createVoiceSpatialIndex({ bucketSize: -5 }), /bucketSize inválido/);
  });

  it('describe conta espaços, buckets e o maior bucket', () => {
    const index = createVoiceSpatialIndex({ bucketSize: 1000 });
    index.rebuild([
      { actorId: 1, space: CELL, pos: [0, 0, 0] },
      { actorId: 2, space: CELL, pos: [10, 10, 0] },
      { actorId: 3, space: CELL, pos: [5000, 0, 0] },
      { actorId: 4, space: OUTRA, pos: [0, 0, 0] },
      { actorId: 5, space: null, pos: [0, 0, 0] }
    ]);
    const d = index.describe();
    assert.strictEqual(d.total, 5);
    assert.strictEqual(d.spaces, 2);
    assert.strictEqual(d.buckets, 3, 'dois buckets em CELL, um em OUTRA');
    assert.strictEqual(d.largestBucket, 2);
    assert.strictEqual(d.unknownSpace, 1);
  });
});

describe('voice-spatial-index — o custo cai de verdade', () => {
  it('numa cena espalhada, os candidatos são uma fração do servidor', () => {
    const random = rng(99);
    const samples = [];
    // 300 pessoas espalhadas por ~100.000 unidades: a escala de um worldspace.
    for (let i = 0; i < 300; i++) {
      samples.push({
        actorId: i,
        space: CELL,
        pos: [(random() - 0.5) * 100000, (random() - 0.5) * 100000, 0]
      });
    }
    const index = createVoiceSpatialIndex();
    index.rebuild(samples);

    let candidatos = 0;
    for (const origin of samples) {
      candidatos += index.queryWithin(origin, VOICE_RANGES.whisper).length;
    }
    const media = candidatos / samples.length;

    // Sem índice, cada consulta olharia 300. A afirmação é conservadora de
    // propósito: o ponto é que o custo deixou de ser proporcional ao servidor,
    // não bater um número exato que dependeria da semente.
    assert.ok(
      media < samples.length / 5,
      `esperava candidatos bem abaixo de ${samples.length}; veio ${media.toFixed(1)}`
    );
  });
});
