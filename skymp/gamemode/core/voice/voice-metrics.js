/**
 * core/voice/voice-metrics.js
 *
 * VoiceMetrics — contadores e amostras de duração do Voice Core.
 *
 * ## Por que isto existe antes do resto
 *
 * A meta desta etapa é uma latência de proximidade entre ~100 e 250 ms, e a
 * instrução era explícita: **não declarar sucesso configurando um timer.**
 * Um `setInterval(150)` prova que a intenção é 150 ms; não prova que o cálculo
 * cabe em 150 ms, nem que a rota chegou ao ouvinte. A diferença entre as duas
 * coisas é exatamente o que este módulo mede.
 *
 * Por isso ele é o primeiro arquivo do Voice Core: os outros o recebem por
 * injeção, e um que não meça nada é substituível por `nullMetrics()` sem
 * espalhar `if (metrics)` por dentro da lógica.
 *
 * ## O que é contador e o que é duração
 *
 * - **Contador** responde "quantas vezes": recomputes, assinaturas emitidas,
 *   chamadas recusadas, falhas do gateway. É soma; nunca reseta sozinho.
 * - **Duração** responde "quanto tempo": recompute de rota, amostragem de
 *   posição, chamada ao gateway. Guarda uma janela circular das últimas N
 *   amostras e devolve p50/p95/max.
 *
 * Guardar janela em vez de só média é deliberado. A média de um recompute
 * esconde justamente o caso que interessa: a cena cheia. Um p95 de 40 ms com
 * média de 3 ms diz que a cidade lotada cabe no orçamento; a média sozinha
 * diria a mesma coisa se o p95 fosse 400 ms.
 *
 * ## O que ele NÃO faz
 *
 * Não exporta para lugar nenhum, não abre porta, não escreve em disco. É
 * memória do processo, lida por quem perguntar (`snapshot()`), e é isso.
 * Telemetria com destino externo é uma decisão de operação que este projeto não
 * tomou, e um módulo de métrica que abre socket sozinho é um módulo que decide
 * por ela.
 */

/** Amostras mantidas por série de duração. ~30 s de tick a 150 ms. */
const DEFAULT_WINDOW = 256;

/**
 * @typedef {object} DurationStats
 * @property {number} count   quantas amostras já entraram (não é o tamanho da janela)
 * @property {number} p50
 * @property {number} p95
 * @property {number} max     máximo da JANELA, não de sempre
 * @property {number} last
 */

/**
 * @param {object} [opts]
 * @param {number} [opts.window] amostras mantidas por série
 * @param {() => number} [opts.now] relógio monotônico em ms; injetável por teste
 */
function createVoiceMetrics(opts = {}) {
  const {
    window: windowSize = DEFAULT_WINDOW,
    // `performance.now()` e não `Date.now()`: a grandeza medida aqui é um
    // intervalo de milissegundos numa mesma máquina, e `Date.now` pode andar
    // para trás com ajuste de relógio — o que apareceria como duração negativa
    // num p95 e seria interpretado como bug do cálculo, não do relógio.
    now = () => performance.now()
  } = opts;

  /** @type {Map<string, number>} */
  const counters = new Map();
  /** @type {Map<string, {samples: number[], cursor: number, count: number}>} */
  const durations = new Map();

  /**
   * Incrementa um contador.
   * @param {string} name
   * @param {number} [by]
   */
  function count(name, by = 1) {
    counters.set(name, (counters.get(name) || 0) + by);
  }

  /**
   * Registra uma duração já medida, em milissegundos.
   * @param {string} name
   * @param {number} ms
   */
  function observe(name, ms) {
    if (!Number.isFinite(ms)) return;
    let series = durations.get(name);
    if (!series) {
      series = { samples: new Array(windowSize).fill(0), cursor: 0, count: 0 };
      durations.set(name, series);
    }
    series.samples[series.cursor] = ms;
    series.cursor = (series.cursor + 1) % windowSize;
    series.count++;
  }

  /**
   * Cronômetro para um trecho. Devolve a função que fecha a medição.
   *
   * O padrão `const done = metrics.timer('x'); ...; done();` existe para que o
   * ponto de início e o de fim estejam no mesmo bloco visível — medir com dois
   * `now()` soltos é como uma medição acaba cercando código que não era para
   * estar dentro dela.
   *
   * @param {string} name
   * @returns {() => number} devolve a duração medida
   */
  function timer(name) {
    const startedAt = now();
    return () => {
      const elapsed = now() - startedAt;
      observe(name, elapsed);
      return elapsed;
    };
  }

  /**
   * @param {string} name
   * @returns {DurationStats|null}
   */
  function stats(name) {
    const series = durations.get(name);
    if (!series || series.count === 0) return null;

    const filled = Math.min(series.count, windowSize);
    const ordered = series.samples.slice(0, filled).sort((a, b) => a - b);
    const at = (q) => ordered[Math.min(filled - 1, Math.floor(q * filled))];

    // `last` sai do cursor, não do array ordenado: `cursor` já apontou para o
    // próximo slot depois da última escrita.
    const lastIndex = (series.cursor - 1 + windowSize) % windowSize;

    return {
      count: series.count,
      p50: at(0.5),
      p95: at(0.95),
      max: ordered[filled - 1],
      last: series.samples[lastIndex]
    };
  }

  /** Fotografia completa, para log de diagnóstico e para o relatório. */
  function snapshot() {
    /** @type {Record<string, number>} */
    const c = {};
    for (const [k, v] of counters) c[k] = v;
    /** @type {Record<string, DurationStats>} */
    const d = {};
    for (const k of durations.keys()) {
      const s = stats(k);
      if (s) d[k] = s;
    }
    return { counters: c, durations: d };
  }

  function reset() {
    counters.clear();
    durations.clear();
  }

  return { count, observe, timer, stats, snapshot, reset };
}

/**
 * Métrica que não mede nada, com a mesma superfície.
 *
 * Existe para que o Voice Core nunca precise de `if (metrics)` — um `if` em
 * volta de cada medição é onde a medição some quando alguém instancia sem
 * métrica e não percebe.
 */
function nullMetrics() {
  const noop = () => {};
  return {
    count: noop,
    observe: noop,
    timer: () => () => 0,
    stats: () => null,
    snapshot: () => ({ counters: {}, durations: {} }),
    reset: noop
  };
}

module.exports = { createVoiceMetrics, nullMetrics, DEFAULT_WINDOW };
