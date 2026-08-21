/**
 * animation-service.js — gestos de RP sincronizados (`/gesto`)
 *
 * ─── Resposta à §15 da Constituição (resumo; não é mecânica nova de economia,
 *      política ou combate — por isso a análise é curta) ──────────────────────
 *
 * Objetivo: dar corpo a cenas de RP hoje só descritas em texto (`/me`, `/do`).
 * Problema que resolve: não existe linguagem corporal sincronizada — toda ação
 * física vira `* descrição` sem efeito visual real no personagem.
 * Problemas que cria: flood visual/de rede se sem cooldown; nome de idle
 * arbitrário do cliente seria superfície de injeção se aceito sem allowlist.
 * Exploits: spam de chamada Papyrus (mitigado por cooldown por ator); tentar
 * forçar idle de combate/morte via nome livre (mitigado por allowlist restrita
 * a gestos cosméticos, fora da lista quem descreve estado de combate/morte).
 * Impacto econômico/político/militar/religioso: nenhum — não move ouro, item,
 * facção ou stat. Social/narrativo: vocabulário físico pequeno e recorrente
 * pra cena (saudar, reverenciar, aplaudir, rir, negar), sem depender de staff.
 * Balanceamento: allowlist fixa em código (não editável em runtime), cooldown
 * curto por ator, nenhuma emote altera actor value/item/gold.
 * Integração ao mundo: mesmo canal e mesmo raio de proximidade que `/me`/`/do`
 * já usam (`core/proximity-ranges.js`), nasce atrás de `ENABLE_ANIMATION_SERVICE`
 * como todo `lab`.
 *
 * ─── O que está provado e o que não está ─────────────────────────────────────
 *
 * O CALL de Papyrus segue exatamente o padrão já usado por
 * `admin-service.playAnimation` (`/anim`, comando de staff): `method` em
 * `Actor.PlayIdle`, `self` como `actorRef(actorId)` — a forma que
 * `core/papyrus.js` documenta como a única exercitada pelos testes oficiais do
 * SkyMP (achado 2.13 do QA_REPORT). Reaproveitar essa forma em vez de inventar
 * uma segunda convenção (havia uma alternativa via `Debug.SendAnimationEvent`
 * comentada em `jobs-service.js`, nunca ativada) é deliberado.
 *
 * **NÃO provado:** que `Actor.PlayIdle` aceitando uma string de evento (em vez
 * de uma referência a um formulário `Idle`) realmente reproduz a animação no
 * cliente. `/anim` também nunca foi visto em jogo — é a mesma lacuna do resto
 * do projeto (Fase 0). Os nomes de idle na allowlist são os nomes vanilla mais
 * comumente citados pela comunidade de modding; nenhum foi conferido contra o
 * ESM carregado. Se a Fase 0 mostrar que o formato está errado, o ponto único de
 * ajuste é `EMOTES` abaixo — nenhum outro arquivo assume o formato do nome.
 *
 * Desligado por padrão, como todo lab: `ENABLE_ANIMATION_SERVICE=true`.
 */

const commands = require('./commands');
const { actorRef } = require('./core/papyrus');
const { RANGES } = require('./core/proximity-ranges');

/**
 * Allowlist de gestos. Chave = o que o jogador digita em `/gesto <chave>`.
 *
 * Deliberadamente pequena e cosmética: nenhum idle de combate, morte, ou que
 * mude estado (sentar em móvel é mecânica diferente — usa `Actor.Sit`/mobiliário,
 * não idle solto — e fica fora daqui de propósito, para não confundir as duas
 * máquinas).
 *
 * `mensagem` vira o texto de proximidade, no mesmo formato que `/me` já usa
 * (`* <nome> <ação>`), então quem não vê a animação (ainda não validada em
 * jogo) ao menos lê a cena.
 */
const EMOTES = Object.freeze({
  acenar: { idle: 'IdleWave', mensagem: (nome) => `* ${nome} acena.` },
  reverenciar: { idle: 'IdleBow', mensagem: (nome) => `* ${nome} faz uma reverência.` },
  aplaudir: { idle: 'IdleApplaud', mensagem: (nome) => `* ${nome} aplaude.` },
  rir: { idle: 'IdleLaugh', mensagem: (nome) => `* ${nome} ri.` },
  negar: { idle: 'IdleShakeHead', mensagem: (nome) => `* ${nome} balança a cabeça, em negação.` },
  saudar: { idle: 'IdleSalute', mensagem: (nome) => `* ${nome} faz uma saudação.` }
});

/** Piso entre dois gestos do mesmo ator. Curto o bastante pra não travar RP, alto o bastante contra spam. */
const COOLDOWN_MS = 3000;

/** actorId → timestamp do último gesto aceito. */
const _ultimoGesto = new Map();

function listaDeGestos() {
  return Object.keys(EMOTES);
}

function _nomeDoAtor(actorId) {
  const charData = commands.getActiveCharacterData(actorId);
  if (!charData) return 'Alguém';
  const nome = `${charData.firstName || ''} ${charData.lastName || ''}`.trim();
  return nome || 'Alguém';
}

/**
 * Toca um gesto e anuncia a cena para quem está por perto.
 *
 * Server-authoritative por construção: `emoteKey` é validado contra `EMOTES`
 * antes de qualquer coisa tocar o Papyrus — o cliente nunca escolhe o nome do
 * idle, só a chave de uma lista fixa.
 *
 * @param {number} actorId
 * @param {string} emoteKey
 * @returns {{ok: true} | {ok: false, motivo: 'desconhecido'|'cooldown'}}
 */
function playEmote(actorId, emoteKey) {
  const chave = String(emoteKey || '').trim().toLowerCase();
  const gesto = EMOTES[chave];
  if (!gesto) return { ok: false, motivo: 'desconhecido' };

  const agora = Date.now();
  const ultimo = _ultimoGesto.get(actorId) || 0;
  if (agora - ultimo < COOLDOWN_MS) return { ok: false, motivo: 'cooldown' };
  _ultimoGesto.set(actorId, agora);

  if (typeof mp !== 'undefined') {
    try {
      mp.callPapyrusFunction('method', 'Actor', 'PlayIdle', actorRef(actorId), [gesto.idle]);
    } catch (err) {
      console.error(`[animation] Falha ao tocar '${chave}' em 0x${actorId.toString(16)}:`, err.message);
    }
  }

  const nome = _nomeDoAtor(actorId);
  commands.broadcastProximityMessage(actorId, gesto.mensagem(nome), RANGES.emote);

  return { ok: true };
}

/** Limpa o cooldown ao desconectar — o mesmo actorId é reaproveitado entre sessões. */
function limparAtor(actorId) {
  _ultimoGesto.delete(actorId);
}

function initAnimationService() {
  console.log('[animation] Servico de gestos ativo. NAO validado em jogo — ver o cabecalho do arquivo.');
}

function shutdownAnimationService() {
  _ultimoGesto.clear();
}

module.exports = {
  EMOTES,
  COOLDOWN_MS,
  listaDeGestos,
  playEmote,
  limparAtor,
  initAnimationService,
  shutdownAnimationService,
  _ultimoGesto
};
