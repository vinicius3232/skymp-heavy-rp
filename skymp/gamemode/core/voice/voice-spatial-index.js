/**
 * core/voice/voice-spatial-index.js
 *
 * VoiceSpatialIndex — de "compare todo mundo com todo mundo" para "olhe só a
 * vizinhança".
 *
 * ## O custo que isto remove
 *
 * O `tickProximity` antigo era dois laços aninhados sobre a lista de atores:
 * cada par comparado, distância 3D calculada, célula conferida. Com 100
 * jogadores conectados são 9.900 comparações por tick — e o tick só existia a
 * cada 2 s justamente porque ninguém queria pagar aquilo com frequência.
 * A conta piora com o quadrado: 200 jogadores são 39.800.
 *
 * O detalhe que torna o O(n²) desnecessário é que a resposta é quase sempre
 * "não". Numa cidade cheia, o sussurro de alguém alcança 450 unidades; o resto
 * do servidor está a quilômetros. Comparar com o resto é gastar 99% do tick
 * para confirmar o óbvio.
 *
 * ## A hierarquia, e por que ela tem dois níveis e não três
 *
 * A prioridade pedida era **worldspace → cell/instância → buckets espaciais**.
 * No SkyMP os dois primeiros são **o mesmo campo**: `locationalData` expõe um
 * único `cellOrWorldDesc`, um FormDesc no formato `"162e2:Skyrim.esm"`, que é o
 * *worldspace* quando a pessoa está num exterior e a *célula* quando está num
 * interior. Não há um segundo campo a consultar — `core/range-utils.getCell` já
 * é a lista completa dos nomes que essa informação pode ter.
 *
 * Então a hierarquia real é:
 *
 * ```
 * space (cellOrWorldDesc)   ← worldspace OU célula; o motor não distingue
 *   └── bucket (x, y)       ← grade uniforme de `bucketSize` unidades
 * ```
 *
 * Inventar um terceiro nível a partir de um campo que não existe daria uma
 * árvore mais bonita e uma chave sempre igual à do nível de baixo. O que se
 * ganharia em simetria se perderia em verdade, e o `space` já entrega a
 * propriedade que interessa: **duas pessoas em espaços diferentes nunca são
 * comparadas**, por mais próximos que os números fiquem. A separação entre dois
 * interiores e a separação entre dois worldspaces saem da mesma linha.
 *
 * O seletor de espaço é injetável (`spaceOf`) exatamente para o dia em que o
 * upstream expuser worldspace e célula separadamente: aí o nível novo entra
 * aqui, e nada mais no Voice Core precisa saber.
 *
 * ## Grade uniforme, e não quadtree
 *
 * Buckets de tamanho fixo indexados por `Map` são O(1) para inserir e O(k) para
 * consultar, onde `k` é quanta gente está perto de verdade. Uma quadtree daria
 * o mesmo comportamento assintótico com rebalanceamento, alocação por nó e um
 * caso ruim de gente empilhada no mesmo ponto — que é exatamente o caso de uma
 * taverna cheia. Grade uniforme é a estrutura simples que serve; o índice é
 * reconstruído do zero a cada tick, e reconstruir uma grade é um laço.
 *
 * ## Espaço desconhecido
 *
 * Se `getCell` não achar campo nenhum, o espaço é `null` — e a regra do projeto
 * é que **falta de informação não separa ninguém** (ver `voice-policy.sameSpace`).
 * Esses atores ficam fora dos buckets, numa lista à parte que entra em toda
 * consulta. É o único caminho de custo linear que sobrou, e há um contador
 * (`spatial.unknownSpace`) para que ele apareça se algum dia deixar de ser raro
 * — em vez de virar uma lentidão sem explicação.
 */

const { nullMetrics } = require('./voice-metrics');
const rangeUtils = require('../range-utils');

/**
 * Lado do bucket, em unidades do Skyrim.
 *
 * 2048 sai da relação com os raios de `proximity-ranges.js`: o sussurro (450)
 * cabe numa vizinhança 3×3 e o grito (3500) numa 5×5. Buckets maiores
 * devolveriam candidatos demais para o sussurro; menores fariam o grito varrer
 * uma grade grande de buckets vazios. Ajustável por `VOICE_BUCKET_SIZE` porque
 * o número certo depende de como o servidor distribui as pessoas, e isso é
 * medível (`scripts/bench-voice-proximity.js`) em vez de opinável.
 */
const DEFAULT_BUCKET_SIZE = 2048;

/**
 * Amostra de posição de um ator, **produzida pelo servidor**.
 * @typedef {object} VoiceSample
 * @property {number} actorId
 * @property {string|null} space
 * @property {number[]} pos
 */

/**
 * @param {object} [deps]
 * @param {number} [deps.bucketSize]
 * @param {(loc: any) => string|null} [deps.spaceOf] como extrair o espaço de um `locationalData`
 * @param {ReturnType<typeof import('./voice-metrics').createVoiceMetrics>} [deps.metrics]
 */
function createVoiceSpatialIndex(deps = {}) {
  const {
    bucketSize = DEFAULT_BUCKET_SIZE,
    spaceOf = rangeUtils.getCell,
    metrics = nullMetrics()
  } = deps;

  if (!Number.isFinite(bucketSize) || bucketSize <= 0) {
    throw new Error(`[voice-spatial-index] bucketSize inválido: ${bucketSize}`);
  }

  /** @type {Map<string, {members: VoiceSample[], buckets: Map<string, VoiceSample[]>}>} */
  let spaces = new Map();
  /** @type {VoiceSample[]} */
  let unknownSpace = [];
  let total = 0;

  const bucketOf = (v) => Math.floor(v / bucketSize);
  const bucketKey = (bx, by) => `${bx}|${by}`;

  /**
   * Reconstrói o índice a partir das amostras do tick.
   *
   * Reconstrução total, e não atualização incremental: mover uma pessoa entre
   * buckets exigiria saber onde ela estava, o que é um segundo índice
   * (`actorId → bucket`) que pode divergir do primeiro. Com N na casa das
   * centenas, `rebuild` é um laço de N com uma divisão e um `Map.get` por
   * amostra — mais barato que manter dois índices coerentes.
   *
   * @param {VoiceSample[]} samples
   */
  function rebuild(samples) {
    const done = metrics.timer('spatial.rebuild');
    spaces = new Map();
    unknownSpace = [];
    total = 0;

    for (const sample of samples) {
      if (!sample || !Array.isArray(sample.pos) || sample.pos.length < 3) continue;
      total++;

      if (!sample.space) {
        unknownSpace.push(sample);
        metrics.count('spatial.unknownSpace');
        continue;
      }

      let space = spaces.get(sample.space);
      if (!space) {
        space = { members: [], buckets: new Map() };
        spaces.set(sample.space, space);
      }
      space.members.push(sample);

      const key = bucketKey(bucketOf(sample.pos[0]), bucketOf(sample.pos[1]));
      let bucket = space.buckets.get(key);
      if (!bucket) {
        bucket = [];
        space.buckets.set(key, bucket);
      }
      bucket.push(sample);
    }

    done();
    metrics.observe('spatial.size', total);
    return { total, spaces: spaces.size, unknown: unknownSpace.length };
  }

  /**
   * Visita cada candidato dentro de `radius` de `origin`, **sem alocar**.
   *
   * Esta é a forma usada no caminho quente, e a razão é medida. A versão que
   * devolvia array (`queryWithin`, logo abaixo) monta uma lista nova por
   * locutor por tick; numa taverna cheia — 200 pessoas todas dentro do alcance
   * umas das outras — isso é 200 arrays de ~200 elementos a cada 150 ms, e o
   * `push(...bucket)` que os monta é a parte mais cara do recompute. O bench
   * mostrou o índice ficando **mais lento que o laço O(n²) original** nessa
   * topologia por causa disso: o trabalho útil era o mesmo, e a alocação era
   * pura perda.
   *
   * O spread também tem um limite duro que a lista não tem: `push(...bucket)`
   * empurra cada elemento como argumento, e um bucket grande o bastante
   * estoura a pilha. Visitar não tem esse teto.
   *
   * A grade é 2D (x, y) e a distância final é 3D. Ignorar z ao indexar é
   * deliberado: os raios de voz são horizontais na prática (450 a 3500
   * unidades), e a extensão vertical de um interior do Skyrim é uma fração
   * disso, então um terceiro eixo na grade multiplicaria os buckets varridos
   * sem descartar quase ninguém. O filtro de z acontece no `distance3D` de
   * quem chama, que precisa da distância exata de qualquer jeito.
   *
   * @param {VoiceSample} origin
   * @param {number} radius
   * @param {(sample: VoiceSample) => void} visit inclui a própria origem
   */
  function forEachWithin(origin, radius, visit) {
    if (!origin || !Array.isArray(origin.pos) || !Number.isFinite(radius) || radius <= 0) return 0;
    let visited = 0;

    // Origem sem espaço conhecido é compatível com todo mundo (regra de
    // `sameSpace`), então não há vizinhança a recortar: o candidato é o
    // servidor inteiro. Raro por construção — `cellOrWorldDesc` vem em toda
    // leitura de `locationalData` — e contado para que deixe de ser invisível
    // se virar comum.
    if (!origin.space) {
      metrics.count('spatial.query.fullScan');
      for (const sample of unknownSpace) { visit(sample); visited++; }
      for (const space of spaces.values()) {
        for (const sample of space.members) { visit(sample); visited++; }
      }
      return visited;
    }

    const space = spaces.get(origin.space);
    if (space) {
      const span = Math.ceil(radius / bucketSize);
      const bx = bucketOf(origin.pos[0]);
      const by = bucketOf(origin.pos[1]);
      for (let dx = -span; dx <= span; dx++) {
        for (let dy = -span; dy <= span; dy++) {
          const bucket = space.buckets.get(bucketKey(bx + dx, by + dy));
          if (!bucket) continue;
          for (let i = 0; i < bucket.length; i++) { visit(bucket[i]); visited++; }
        }
      }
    }

    // Quem não tem espaço conhecido entra em toda consulta pelo mesmo motivo:
    // não sabemos que ele está longe, e presumir que está o calaria.
    for (const sample of unknownSpace) { visit(sample); visited++; }

    metrics.count('spatial.query');
    metrics.observe('spatial.candidates', visited);
    return visited;
  }

  /**
   * A mesma consulta, materializada numa lista.
   *
   * Mantida porque é o que torna a equivalência com a força bruta legível em
   * teste — comparar dois arrays é uma asserção; comparar dois percursos é uma
   * máquina de estado. Fora do teste, use `forEachWithin`.
   *
   * @param {VoiceSample} origin
   * @param {number} radius
   * @returns {VoiceSample[]}
   */
  function queryWithin(origin, radius) {
    const results = [];
    forEachWithin(origin, radius, (sample) => results.push(sample));
    return results;
  }

  /** Diagnóstico: quantos espaços, buckets e o maior bucket. Usado pelo bench. */
  function describe() {
    let buckets = 0;
    let largestBucket = 0;
    for (const space of spaces.values()) {
      buckets += space.buckets.size;
      for (const bucket of space.buckets.values()) {
        if (bucket.length > largestBucket) largestBucket = bucket.length;
      }
    }
    return {
      bucketSize,
      total,
      spaces: spaces.size,
      buckets,
      largestBucket,
      unknownSpace: unknownSpace.length
    };
  }

  function clear() {
    spaces = new Map();
    unknownSpace = [];
    total = 0;
  }

  return { rebuild, forEachWithin, queryWithin, describe, clear, bucketSize };
}

module.exports = { createVoiceSpatialIndex, DEFAULT_BUCKET_SIZE };
