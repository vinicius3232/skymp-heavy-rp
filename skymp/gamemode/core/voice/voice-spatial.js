/**
 * core/voice/voice-spatial.js
 *
 * A conta que transforma "onde os dois estão" em "de que lado vem a voz".
 *
 * ## Por que isto é servidor, e não cliente
 *
 * O cliente **já sabe** onde os outros estão — ele os desenha. Então não é
 * segredo que se esteja guardando. O motivo de a conta ser aqui é outro, e é
 * mais forte: **a atenuação por distância já é do servidor**, e se o cliente
 * também posicionasse a fonte num `PannerNode` com modelo de distância ligado,
 * o volume passaria por duas quedas independentes — uma autoritativa e uma
 * não. O jogador ouviria mais baixo do que a regra manda, e o desvio seria
 * proporcional à distância, que é o disfarce perfeito para uma regra quebrada.
 *
 * A saída daqui é um **vetor unitário**, não uma posição. O cliente coloca a
 * fonte a raio 1 e desliga o rolloff; a distância continua morando no ganho, e
 * há um só lugar que a decide.
 *
 * Efeito colateral bem-vindo: nenhuma coordenada absoluta de ninguém viaja no
 * `proximity_update`. Antes desta etapa também não viajava, e trocar por
 * `pos: [x,y,z]` teria sido a forma mais fácil de piorar isso sem perceber.
 *
 * ## O sistema de coordenadas, nos dois lados
 *
 * **Skyrim:** `+X` leste, `+Y` norte, `+Z` cima. `rot[2]` é o ângulo Z em
 * **graus**, 0 = norte, crescendo no sentido horário (para leste). Logo:
 *
 * ```
 *   frente = ( sin(yaw),  cos(yaw), 0)
 *   direita= ( cos(yaw), -sin(yaw), 0)
 * ```
 *
 * **Web Audio:** o ouvinte padrão olha para `-Z`, com `+Y` para cima e `+X`
 * para a direita. Então o mapeamento é:
 *
 * ```
 *   x = componente à DIREITA
 *   y = componente para CIMA
 *   z = -componente à FRENTE      ← negativo: à frente é -Z
 * ```
 *
 * O sinal de `z` é o erro que se comete uma vez: sem ele, quem está na frente
 * soa atrás e quem está atrás soa na frente, e como `equalpower` panoramiza
 * quase só no eixo esquerda/direita, **o teste que só ouve L/R passa mesmo
 * assim**. Por isso há teste de frente e de trás separado.
 */

const DEG_TO_RAD = Math.PI / 180;

/**
 * Direção do locutor no referencial do ouvinte, como vetor unitário Web Audio.
 *
 * @param {number[]} listenerPos `[x, y, z]` do ouvinte
 * @param {number[]} listenerRot `[x, y, z]` em graus; só `rot[2]` (yaw) é usado
 * @param {number[]} speakerPos `[x, y, z]` do locutor
 * @returns {[number, number, number]} unitário; `[0, 0, -1]` (à frente) quando
 *   os dois ocupam o mesmo ponto — a alternativa seria `[0,0,0]`, que num
 *   `PannerNode` é o ouvinte dentro da fonte e produz panorâmica indefinida.
 */
function directionFor(listenerPos, listenerRot, speakerPos) {
  if (!Array.isArray(listenerPos) || !Array.isArray(speakerPos)) return [0, 0, -1];
  if (listenerPos.length < 3 || speakerPos.length < 3) return [0, 0, -1];

  const dx = speakerPos[0] - listenerPos[0];
  const dy = speakerPos[1] - listenerPos[1];
  const dz = speakerPos[2] - listenerPos[2];

  const yawDeg = Array.isArray(listenerRot) && Number.isFinite(listenerRot[2]) ? listenerRot[2] : 0;
  const yaw = yawDeg * DEG_TO_RAD;
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);

  const front = dx * sin + dy * cos;
  const right = dx * cos - dy * sin;
  const up = dz;

  const length = Math.sqrt(right * right + up * up + front * front);
  if (!Number.isFinite(length) || length < 1e-6) return [0, 0, -1];

  return [right / length, up / length, -front / length];
}

/**
 * Arredonda a direção para o fio.
 *
 * Duas casas decimais dão ~0.6° de resolução angular, que é uma ordem de
 * grandeza mais fina do que a menor diferença que uma pessoa localiza com
 * `equalpower` em fones. O que se ganha é `[0.71,0,-0.71]` em vez de
 * `[0.7071067811865476,0,-0.7071067811865475]` — três vezes menos bytes num
 * payload que sai por ouvinte a cada tick.
 *
 * @param {[number, number, number]} dir
 */
function quantizeDirection(dir) {
  return [
    Math.round(dir[0] * 100) / 100,
    Math.round(dir[1] * 100) / 100,
    Math.round(dir[2] * 100) / 100
  ];
}

module.exports = { directionFor, quantizeDirection, DEG_TO_RAD };
