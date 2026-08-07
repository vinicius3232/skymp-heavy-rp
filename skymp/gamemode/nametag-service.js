/**
 * nametag-service.js — PROVA DE CONCEITO da nametag visual acima da cabeça.
 *
 * ⚠️ ESTADO: código completo, **nunca visto na tela de ninguém**. Ver §4.
 *
 * ─── 1. O que a investigação achou, e o que isso derrubou ───────────────────
 *
 * A pergunta que travava a nametag desde 12/07/2026 era *"o servidor consegue
 * saber onde um ator aparece na tela do observador?"*. A resposta é **sim, mas
 * não o servidor** — e essa distinção é a peça inteira.
 *
 *   [DOC] `worldPointToScreenPoint` — Skyrim Platform.
 *         "convert an array of points in the game world to an array of points
 *         on the user's screen. The dot on the screen is indicated by 3 numbers
 *         from -1 to 1."
 *         Fonte: skyrim-multiplayer/skymp, `docs/skyrim_platform/new_methods.md`.
 *         Assinatura, das tipagens oficiais (`skyrim-platform/skyrim-platform`,
 *         `index.d.ts`): `worldPointToScreenPoint(...args: number[][]): number[][]`.
 *
 *   [DOC] Evento `update` — "Called once for every frame in the game (60 times
 *         per second at 60 FPS) after you've loaded a save or started a new
 *         game." Fonte: `docs/skyrim_platform/new_events.md`.
 *
 * **Isso roda no cliente, dentro do motor JS do Skyrim Platform — não é
 * `mp.callPapyrusFunction`.** O medo registrado (nametag por polling Papyrus
 * seria inviável) vinha das medições que o Red House deixou anotadas: 13 ms num
 * `getEquipment`, 35 ms num `av.set`
 * (`REFERENCE_STUDY_SKYMP_RED_HOUSE.md` §4.1). Aquelas medições são de chamadas
 * do **servidor** para o Papyrus do cliente — ida e volta pela rede. O painel do
 * jogador paga esse preço porque lê vida/magicka/stamina de lá. A projeção não:
 * ela é uma função nativa do próprio processo do jogo, chamada por JS que já
 * está dentro dele. Nenhuma chamada Papyrus por quadro, por pessoa. O
 * argumento que bloqueava simplesmente não se aplica a este caminho.
 *
 * O que o servidor faz aqui é o que ele sempre faz: **decide o nome**. Quem
 * projeta é o cliente, e ele projeta um texto que recebeu pronto.
 *
 * ─── 2. Por que 2 s no servidor e ~20 Hz na tela ────────────────────────────
 *
 * São duas frequências porque são duas grandezas diferentes.
 *
 * **O nome e quem é o alvo: 2 s**, o mesmo tick da voz. Um nome só muda quando
 * alguém se apresenta ou recebe apelido — evento humano, digitado. Quem é a
 * pessoa mais próxima muda em velocidade de caminhada. A defasagem de até 2 s é
 * exatamente a que o `proximity_update` do VOIP já carrega e que foi aceita lá
 * pelo mesmo motivo: o custo é O(n²) de distância 3D, e pagá-lo mais vezes por
 * segundo não compra nada que uma pessoa perceba.
 *
 * **A posição na tela: até 20 vezes por segundo, no cliente.** Aqui a defasagem
 * é percebida: uma etiqueta que se atualiza a cada 2 s não parece atrasada,
 * parece quebrada — ela fica parada no ar enquanto a pessoa anda. O laço roda no
 * evento `update` (60 fps) mas só trabalha a cada `INTERVALO_DE_TELA_MS`, e o
 * CSS interpola o intervalo.
 *
 * **Por que não a cada quadro, se a projeção é barata.** Não é a projeção que
 * custa: é o `browser.executeJavaScript`, que serializa uma string e a atravessa
 * para o processo da CEF. A 60 fps seriam 60 travessias por segundo por
 * etiqueta. Esse custo **não foi medido** — e é justamente por não ter sido que
 * o padrão é conservador. O `index.html` já tomou a mesma decisão pelo mesmo
 * motivo, no HUD de voz: *"sem a guarda seriam 50 escritas de DOM por segundo
 * por locutor"*.
 *
 * ─── 3. O que esta POC deliberadamente NÃO é ────────────────────────────────
 *
 * **Uma etiqueta, a do personagem mais próximo.** Não todos os vizinhos. O que
 * precisa ser provado primeiro é que a projeção funciona e que o texto certo
 * chega — e isso uma etiqueta prova igual a dez. Dez multiplicariam por dez um
 * custo de CEF que ninguém mediu ainda.
 *
 * **Não toca `getDisplayName()`.** Ela é chamada como está, e continua com os
 * degraus que tinha. Isso é requisito, não conveniência: a
 * `PARKED_SERVICES_DECISION.md` §7.1 já decidiu que o disfarce entra como
 * **degrau naquela função** quando voltar. No dia em que entrar, a nametag passa
 * a exibir o nome disfarçado sem uma linha de mudança aqui — porque ela nunca
 * soube resolver nome nenhum.
 *
 * ─── 4. O que está provado e o que não está ─────────────────────────────────
 *
 * **Provado:** que as duas APIs existem e o que elas prometem (documentação
 * oficial do SkyMP, citada em §1); que a resolução de nome por observador
 * funciona (`identity-service.test.js`, e os testes deste arquivo); que a
 * escolha do alvo mais próximo e o formato do payload estão corretos (testes
 * deste arquivo, com `mp` falso).
 *
 * **NÃO provado — e isto tem o mesmo peso que "ninguém ouviu ainda" tem na voz
 * nativa, não é nota de rodapé:**
 *
 *   - `ctx.sp.worldPointToScreenPoint` nunca foi chamada. Que ela seja
 *     alcançável por esse caminho é **inferência**, não observação: o `ctx.sp` é
 *     o namespace do Skyrim Platform e este projeto já usa `ctx.sp.on` e
 *     `ctx.sp.browser.*` com sucesso, mas isso não é o mesmo que ter visto esta
 *     função responder. É a mesma classe de suposição que já custou caro duas
 *     vezes aqui (o `self` do Papyrus, o require nu de dotenv).
 *   - **A convenção dos eixos não foi verificada.** O código assume
 *     `x = -1 esquerda / +1 direita` e `y = -1 embaixo / +1 em cima`, que é o
 *     padrão de espaço normalizado. Se a etiqueta aparecer espelhada na
 *     vertical, o conserto é trocar o sinal do `y` em `_paraCss`, uma linha.
 *   - **Ponto atrás da câmera é um buraco conhecido.** A documentação diz "3
 *     números de -1 a 1" e não diz o que acontece com quem está atrás. O código
 *     esconde a etiqueta fora da faixa, o que resolve o caso comum e **não**
 *     resolve um ponto atrás que projete dentro dela — a etiqueta apareceria
 *     na tela com a pessoa às costas. Não dá pra fechar isso lendo documentação;
 *     fecha-se olhando.
 *   - **O custo do `executeJavaScript` a 20 Hz não foi medido.**
 *   - **Ninguém validou com dois clientes.** O próprio
 *     `NAMETAG_IDENTITY_SYSTEM.md` lista isso como requisito de alfa desde a
 *     origem, e é o que separa "A vê 'Desconhecido' e B vê 'Brenna'" de "o
 *     código calcula que A deveria ver 'Desconhecido'".
 *
 * Desligado por padrão, como todo lab: `ENABLE_NAMETAG_SERVICE=true`.
 */

const commands = require('./commands');
const identity = require('./identity-service');
const { RANGES } = require('./core/proximity-ranges');

/**
 * Property por onde o alvo e o nome chegam ao cliente. Mesmo caminho já
 * comprovado de `browserModal`/`panelData`/`voipTicket` — ver phase0-basic.js.
 */
const PROPERTY = 'nametagTarget';

/** Tick do servidor. Igual ao da voz, e pelo motivo da §2. */
const INTERVALO_DO_TICK_MS = 2000;

/**
 * Piso entre duas escritas na tela, no cliente. 50 ms = até 20 Hz.
 * Ver §2 para por que não é por quadro.
 */
const INTERVALO_DE_TELA_MS = 50;

/**
 * Quanto acima da origem do ator fica a etiqueta, em unidades do Skyrim.
 *
 * `getPositionZ()` devolve o pé, não a cabeça. Um humanoide de Skyrim tem cerca
 * de 128 unidades; 145 põe a etiqueta um pouco acima do topo da cabeça, que é
 * onde ela não cobre o rosto. É estimativa de mesa — o número certo sai da
 * primeira sessão com duas pessoas, não daqui.
 */
const ALTURA_DA_CABECA = 145;

/**
 * Alcance da etiqueta: o mesmo raio da fala normal.
 *
 * Vem de `core/proximity-ranges.js` de propósito, e não de uma constante local.
 * Aquele arquivo existe porque três tabelas de raio discordavam entre si e
 * produziam um bug de RP silencioso; inventar uma quarta aqui seria repetir
 * exatamente o defeito que ele foi criado para apagar. E o critério bate: a
 * etiqueta deve cobrir quem está na mesma cena que você, e `say` é o raio
 * canônico de "esta cena".
 */
const ALCANCE = RANGES.say;

let _timer = null;

/** actorId do observador → último payload enviado (JSON), para diffing. */
const _ultimoEnvio = new Map();

/**
 * O trecho que roda NO CLIENTE, dentro do Skyrim Platform.
 *
 * String porque é isso que `makeProperty.updateOwner` recebe: o texto é enviado
 * e avaliado no cliente, sem fechar sobre nada daqui. Mesmo padrão e mesmas
 * regras de `core/hit-events.js` — curto de propósito, porque cada linha roda no
 * loop do jogo da máquina de outra pessoa e não há como depurar remotamente.
 *
 * `ctx.state` persiste entre chamadas (ver `ClientCtx` em `types/mp.d.ts`), e é
 * onde mora o alvo atual e a guarda que impede registrar o `update` mais de uma
 * vez — `updateOwner` roda a cada mudança da property, e sem a guarda cada
 * mudança pendura mais um handler no loop do jogo.
 */
const SNIPPET_DO_CLIENTE = `
  ctx.state.nametag = ctx.state.nametag || { ligado: false, alvo: null, ultimoEnvio: 0, visivel: false };
  var nt = ctx.state.nametag;
  nt.alvo = (ctx.value && ctx.value.actorId) ? ctx.value : null;

  if (!nt.ligado) {
    nt.ligado = true;

    var mandarPraTela = function (payload) {
      if (!ctx.sp || !ctx.sp.browser || !ctx.sp.browser.executeJavaScript) return;
      ctx.sp.browser.executeJavaScript(
        'window.handleNametag && window.handleNametag(' + JSON.stringify(payload) + ')'
      );
    };

    var esconder = function () {
      if (!nt.visivel) return;   // esconder o que ja esta escondido e travessia de CEF a toa
      nt.visivel = false;
      mandarPraTela({ visivel: false });
    };

    ctx.sp.on('update', function () {
      try {
        var agora = Date.now();
        if (agora - nt.ultimoEnvio < ${INTERVALO_DE_TELA_MS}) return;
        nt.ultimoEnvio = agora;

        if (!nt.alvo) { esconder(); return; }

        // FormID de servidor e de cliente sao espacos diferentes. Mandar o
        // numero cru daria outro objeto — mesmo detalhe que o hit-events
        // registra, e pelo mesmo motivo.
        var idCliente = ctx.getFormIdInClientFormat(nt.alvo.actorId);
        var form = ctx.sp.Game.getFormEx(idCliente);
        var ref = form && ctx.sp.ObjectReference.from(form);
        if (!ref) { esconder(); return; }

        var pontos = ctx.sp.worldPointToScreenPoint([
          ref.getPositionX(),
          ref.getPositionY(),
          ref.getPositionZ() + ${ALTURA_DA_CABECA}
        ]);
        var p = pontos && pontos[0];
        if (!p) { esconder(); return; }

        // Fora da faixa = fora da tela. Nao cobre quem esta ATRAS da camera e
        // ainda assim projeta dentro da faixa — buraco conhecido, so uma sessao
        // real fecha (ver §4 do cabecalho do servidor).
        if (p[0] < -1 || p[0] > 1 || p[1] < -1 || p[1] > 1) { esconder(); return; }

        nt.visivel = true;
        mandarPraTela({
          visivel: true,
          nome: nt.alvo.nome,
          // -1..1 vira 0..100 aqui e nao no CSS: e uma conta so, e deixa o
          // index.html sem nenhuma regra sobre a convencao de eixos do jogo.
          x: (p[0] + 1) * 50,
          y: (1 - p[1]) * 50
        });
      } catch (e) {
        // Erro aqui roda no cliente e nao tem pra onde ir. Engolir e o certo:
        // derrubar o handler mataria a etiqueta pelo resto da sessao.
      }
    });
  }
`;

function _distancia3D(a, b) {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Célula/worldspace, lida do jeito defensivo que o `broadcastProximityMessage` já usa. */
function _celula(loc) {
  return loc.cellOrWorldDesc || loc.cellOrWorldSpaceId || loc.cellId || loc.worldOrCell || null;
}

/**
 * Personagem ativo mais próximo do observador, dentro do alcance e na mesma
 * célula. `null` se não houver ninguém.
 *
 * Exportada porque é a regra de escolha, e ela precisa ser exercitável sem
 * cliente e sem servidor.
 *
 * @param {number} observadorActorId
 * @param {Array<{actorId: number, pos: number[], celula: any}>} candidatos
 * @returns {{actorId: number, distancia: number}|null}
 */
function escolherAlvo(observadorActorId, candidatos) {
  const eu = candidatos.find(c => c.actorId === observadorActorId);
  if (!eu) return null;

  let melhor = null;
  for (const outro of candidatos) {
    if (outro.actorId === observadorActorId) continue;
    // Sem célula de um dos dois não dá pra afirmar que estão no mesmo lugar, e
    // etiqueta atravessando parede de interior é pior que etiqueta ausente.
    if (!eu.celula || !outro.celula || eu.celula !== outro.celula) continue;

    const distancia = _distancia3D(eu.pos, outro.pos);
    if (distancia > ALCANCE) continue;
    if (!melhor || distancia < melhor.distancia) melhor = { actorId: outro.actorId, distancia };
  }
  return melhor;
}

/**
 * Monta o payload que vai para o cliente de um observador.
 *
 * O nome sai de `identity.getDisplayName(observador, alvo)` — a mesma função que
 * o chat local usa. Este arquivo não sabe resolver nome nenhum, e é isso que faz
 * o disfarce (§7.1) chegar aqui de graça no dia em que virar degrau lá.
 *
 * @returns {{actorId: number|null, nome?: string}}
 */
function montarPayload(observadorActorId, alvoActorId) {
  if (alvoActorId === null || alvoActorId === undefined) return { actorId: null };

  const observador = commands.getActiveCharacterData(observadorActorId);
  const alvo = commands.getActiveCharacterData(alvoActorId);
  if (!alvo) return { actorId: null };

  return {
    actorId: alvoActorId,
    nome: identity.getDisplayName(observador, alvo)
  };
}

/**
 * Um tick: lê posições, escolhe o alvo de cada observador e empurra a property
 * de quem mudou.
 *
 * Exportada porque o teste precisa de um tick determinístico em vez de esperar o
 * timer — mesmo motivo pelo qual `voip-service` exporta `tickProximity`.
 */
function tick() {
  if (typeof mp === 'undefined') return;

  const candidatos = [];
  for (const actorId of commands.listActiveActorIds()) {
    try {
      const loc = mp.get(actorId, 'locationalData');
      if (!loc || !loc.pos) continue;
      candidatos.push({ actorId, pos: loc.pos, celula: _celula(loc) });
    } catch { continue; }
  }

  const presentes = new Set(candidatos.map(c => c.actorId));
  for (const actorId of _ultimoEnvio.keys()) {
    if (!presentes.has(actorId)) _ultimoEnvio.delete(actorId);
  }

  for (const observador of candidatos) {
    const alvo = escolherAlvo(observador.actorId, candidatos);
    const payload = montarPayload(observador.actorId, alvo ? alvo.actorId : null);

    // Diffing pelo mesmo motivo do player-panel: `mp.set` propaga para o
    // cliente, e reenviar "o alvo continua sendo o mesmo, com o mesmo nome" a
    // cada 2 s por pessoa é tráfego que não muda um pixel. A POSIÇÃO não passa
    // por aqui — ela é calculada no cliente e nunca sai do cliente.
    const serializado = JSON.stringify(payload);
    if (_ultimoEnvio.get(observador.actorId) === serializado) continue;
    _ultimoEnvio.set(observador.actorId, serializado);

    try {
      mp.set(observador.actorId, PROPERTY, { ...payload, sentAt: Date.now() });
    } catch (err) {
      console.error(`[nametag] Falha ao enviar etiqueta para 0x${observador.actorId.toString(16)}:`, err.message);
    }
  }
}

function initNametagService() {
  if (_timer) return;
  _timer = setInterval(() => {
    try {
      tick();
    } catch (err) {
      console.error('[nametag] Falha no tick:', err.message);
    }
  }, INTERVALO_DO_TICK_MS);
  if (typeof _timer.unref === 'function') _timer.unref();
  console.log('[nametag] POC ativa (alvo mais proximo). NAO validada em jogo — ver o cabecalho do arquivo.');
}

function shutdownNametagService() {
  if (_timer) clearInterval(_timer);
  _timer = null;
  _ultimoEnvio.clear();
}

module.exports = {
  PROPERTY,
  SNIPPET_DO_CLIENTE,
  INTERVALO_DO_TICK_MS,
  INTERVALO_DE_TELA_MS,
  ALTURA_DA_CABECA,
  ALCANCE,
  escolherAlvo,
  montarPayload,
  tick,
  initNametagService,
  shutdownNametagService,
  _ultimoEnvio
};
