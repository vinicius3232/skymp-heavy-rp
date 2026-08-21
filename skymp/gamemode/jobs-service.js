/**
 * jobs-service.js
 * Coleta de recursos: lenha, minério e peixe. Trabalho livre — sem profissão
 * fixa, qualquer personagem carregado pode fazer.
 *
 * Registrado em `core/module-registry.js` como módulo `jobs` (fase `lab`,
 * `ENABLE_JOBS_SERVICE`, nasce desligado). A migração para o
 * `transaction-service` descrita abaixo — que corrigiu o defeito registrado em
 * docs/technical/PARKED_SERVICES_DECISION.md §7.3 — foi o que tornou a
 * reativação possível; até 20/08/2026 o arquivo existia no disco sem comando
 * de chat nenhum. Ver §7.3 para o histórico do defeito original.
 *
 * ─── Por que este arquivo mudou ──────────────────────────────────────────────
 *
 * Ele entregava recurso chamando `AddItem` do Papyrus direto no ator,
 * contornando `inventory-service` e `core/transaction-service` inteiros. A
 * consequência: lenha, minério e peixe nasciam **sem linha em
 * `character_inventory` e sem linha no ledger** — não existiam para o servidor.
 *
 * Isso é mais forte que o achado do `/setgold` (ouro que aparecia sem origem
 * registrada, mas ao menos mudava o saldo no banco). Aqui o item existia só no
 * cliente até a próxima sincronização, e o `syncInventoryToClient` reconcilia a
 * partir do **banco**, que nunca soube dele. Inverte a regra que o resto do
 * projeto segue: inventário só existe se o MariaDB confirmar.
 *
 * Agora toda entrega passa por `transactionService.giveItem`, que é atômico,
 * grava no ledger e só então aplica no cliente. A função pública é a certa
 * aqui (e não as primitivas `tx.*`): a entrega é uma perna só, não precisa
 * commitar junto com mais nada.
 *
 * ─── O que continua pendente ─────────────────────────────────────────────────
 *
 * `Math.random()` decide quantidade e raridade. Não cai sob a §14.3 da
 * Afinidade da Alma (que rege rolagem *oculta de alma*, e esta não é), mas
 * produção de recurso irreproduzível é um problema de economia por si só —
 * registrado na §7.3 do PARKED_SERVICES_DECISION, não resolvido aqui.
 */

const commands = require('./commands');
const transactionService = require('./core/transaction-service');
const { actorRef } = require('./core/papyrus');

const MODULE = 'jobs';

// IDs Base de itens do Skyrim
const ITEM_FIREWOOD = 0x00033760; // Lenha
const ITEM_WOODCUTTER_AXE = 0x0002F2F4; // Machado de Lenhador

const ITEM_PICKAXE = 0x000E3C16; // Picareta
const ITEM_IRON_ORE = 0x00071CF3;
const ITEM_CORUNDUM_ORE = 0x0005ACDB;
const ITEM_EBONY_ORE = 0x0005ACDC;

const ITEM_FISHING_ROD = 0x00044E20; // TODO: Substituir pelo ID correto do mod
const FISH_SALMON = 0x00065C34;
const FISH_RIVER_BETTY = 0x00106E1A;
const FISH_SPADETAIL = 0x00106E19;

// Previne spam mantendo controle de quem esta coletando.
//
// Chaveado por characterId, nao por actorId. O actorId e um slot que o SkyMP
// reaproveita entre sessoes: com a chave antiga, quem entrasse no slot de
// alguem que saiu no meio de uma coleta ficava bloqueado ate o timer daquela
// outra pessoa expirar. E a mesma classe do cache de vida do death-service.
const activeGatherers = new Set();

function notify(text) {
  if (typeof mp === 'undefined') return;
  mp.callPapyrusFunction('global', 'Debug', 'notification', null, [text]);
}

/**
 * Abre uma coleta: resolve o personagem, checa a ferramenta e marca ocupado.
 *
 * @returns {{characterId: number}|null} null quando a coleta nao pode comecar
 */
function _beginGather(actorId, toolBaseId, toolName) {
  if (typeof mp === 'undefined') return null;

  // Item so existe se o banco confirmar, e o banco fala em characterId. Sem
  // personagem carregado nao ha onde creditar — coletar seria criar item do
  // nada, que e exatamente o que esta migracao veio consertar.
  const character = commands.getActiveCharacterData(actorId);
  if (!character) {
    notify('Personagem nao carregado.');
    return null;
  }

  if (activeGatherers.has(character.characterId)) {
    notify('Você já está ocupado fazendo algo.');
    return null;
  }

  // Ferramenta continua sendo lida do cliente, e isso e aceitavel aqui: ela
  // decide se a acao COMECA, nao o que o jogador recebe. Quem burlar ganha uma
  // animacao; o item so nasce pelo transaction-service, no fim.
  if (toolBaseId !== null) {
    const hasTool = mp.callPapyrusFunction('method', 'Actor', 'GetItemCount', actorRef(actorId), [toolBaseId]);
    if (hasTool <= 0) {
      notify(`Você precisa de ${toolName}.`);
      return null;
    }
  }

  activeGatherers.add(character.characterId);
  return { characterId: character.characterId };
}

/**
 * Fecha uma coleta e credita o resultado.
 *
 * Confere que o slot ainda e da mesma pessoa antes de entregar: entre o inicio
 * e o fim passam 10 a 20 segundos, tempo de sobra pra alguem cair e outro
 * jogador entrar no mesmo actorId. Sem esta checagem, o recurso ia pro
 * personagem errado — o banco registraria a entrega corretamente, no dono
 * errado, que e pior que nao entregar.
 */
async function _finishGather(actorId, characterId, baseId, count, reason) {
  activeGatherers.delete(characterId);

  const atual = commands.getActiveCharacterData(actorId);
  if (!atual || atual.characterId !== characterId) {
    console.log(`[jobs-service] Coleta descartada: actor ${actorId.toString(16)} nao e mais o char ${characterId}.`);
    return false;
  }

  const ok = await transactionService.giveItem({
    actorId, characterId, baseId, count,
    reason, module: MODULE,
    idempotencyKey: `${MODULE}_${reason}_${characterId}_${Date.now()}`
  });

  if (!ok) {
    notify('A coleta se perdeu antes de chegar na sua mochila.');
    return false;
  }
  return true;
}

function chopWood(actorId) {
  const sessao = _beginGather(actorId, ITEM_WOODCUTTER_AXE, 'um Machado de Lenhador');
  if (!sessao) return;

  commands.broadcastProximityMessage(actorId, `* Começa a cortar lenha energicamente.`, 1500);

  // Toca a animacao do Skyrim (se disponivel no ator).
  // `Debug.SendAnimationEvent` e global: o `self` e null e a referencia do ator
  // vai como ARGUMENTO — e argumento que e referencia tambem precisa ser objeto
  // (ver core/papyrus.js e o achado 2.13 do QA_REPORT). A versao anterior desta
  // linha passava `actorId` cru na posicao do self, que e invalida nas duas
  // contas; ficaria assim se alguem descomentasse sem reler o contrato.
  // mp.callPapyrusFunction('global', 'Debug', 'SendAnimationEvent', null, [actorRef(actorId), 'WoodChopping']);

  notify('Cortando lenha... aguarde.');

  setTimeout(() => {
    const woodAmount = Math.floor(Math.random() * 3) + 1; // 1 a 3 madeiras
    _finishGather(actorId, sessao.characterId, ITEM_FIREWOOD, woodAmount, 'woodcutting')
      .then(ok => {
        if (ok) {
          notify(`Você coletou ${woodAmount}x Lenha.`);
          console.log(`[jobs-service] Char ${sessao.characterId} chopped ${woodAmount} wood.`);
        }
      })
      .catch(err => console.error('[jobs-service] Falha ao entregar lenha:', err.message));
  }, 10000);
}

function mineOre(actorId) {
  const sessao = _beginGather(actorId, ITEM_PICKAXE, 'uma Picareta');
  if (!sessao) return;

  commands.broadcastProximityMessage(actorId, `* Começa a bater a picareta contra a rocha vigorosamente.`, 1500);
  notify('Minerando... aguarde 15 segundos.');

  setTimeout(() => {
    const chance = Math.random();
    let oreItem = ITEM_IRON_ORE;
    let oreName = 'Minério de Ferro';

    if (chance > 0.9) {
      oreItem = ITEM_EBONY_ORE;
      oreName = 'Minério de Ébano';
    } else if (chance > 0.6) {
      oreItem = ITEM_CORUNDUM_ORE;
      oreName = 'Minério de Corundum';
    }

    const amount = Math.floor(Math.random() * 2) + 1;

    _finishGather(actorId, sessao.characterId, oreItem, amount, 'mining')
      .then(ok => {
        if (ok) {
          notify(`Você extraiu ${amount}x ${oreName}.`);
          console.log(`[jobs-service] Char ${sessao.characterId} mined ${amount}x 0x${oreItem.toString(16)}.`);
        }
      })
      .catch(err => console.error('[jobs-service] Falha ao entregar minerio:', err.message));
  }, 15000);
}

function catchFish(actorId) {
  // TODO: passar ITEM_FISHING_ROD no lugar de null quando o FormID correto do
  // mod for confirmado. Enquanto for null, a pesca nao exige ferramenta.
  const sessao = _beginGather(actorId, null, 'uma Vara de Pescar');
  if (!sessao) return;

  commands.broadcastProximityMessage(actorId, `* Lança a linha na água e aguarda pacientemente.`, 1500);
  notify('Pescando... aguarde 20 segundos.');

  setTimeout(() => {
    const chance = Math.random();
    let fishItem = null;
    let fishName = '';

    if (chance > 0.8) {
      fishItem = FISH_RIVER_BETTY;
      fishName = 'River Betty';
    } else if (chance > 0.5) {
      fishItem = FISH_SPADETAIL;
      fishName = 'Cyrodilic Spadetail';
    } else if (chance > 0.2) {
      fishItem = FISH_SALMON;
      fishName = 'Carne de Salmão';
    }

    if (!fishItem) {
      // Nao houve item, entao nao ha nada pra creditar — mas o "ocupado"
      // precisa sair do mesmo jeito, senao o jogador fica travado pra sempre.
      activeGatherers.delete(sessao.characterId);
      notify('O peixe escapou!');
      commands.broadcastProximityMessage(actorId, `* Puxa a vara de pescar vazia com frustração.`, 1000);
      return;
    }

    _finishGather(actorId, sessao.characterId, fishItem, 1, 'fishing')
      .then(ok => {
        if (ok) {
          notify(`Você pescou: ${fishName}.`);
          console.log(`[jobs-service] Char ${sessao.characterId} caught fish 0x${fishItem.toString(16)}.`);
        }
      })
      .catch(err => console.error('[jobs-service] Falha ao entregar peixe:', err.message));
  }, 20000);
}

/**
 * Comandos de chat — a interface inteira, sem UI CEF, no mesmo padrão de
 * `trade-service.commandDefs()`. Não há checagem de profissão nem de rank:
 * este é o "bico" livre, deliberadamente mais fraco que a mineração via
 * `mining-service` (que exige a profissão `miner`).
 */
function commandDefs() {
  return [
    {
      name: '/cortarlenha',
      description: '[Trabalho livre] Corta lenha (precisa de Machado de Lenhador)',
      usage: '/cortarlenha',
      handler: (actorId) => chopWood(actorId)
    },
    {
      name: '/garimpar',
      description: '[Trabalho livre] Garimpa minério a mão (precisa de Picareta)',
      usage: '/garimpar',
      handler: (actorId) => mineOre(actorId)
    },
    {
      name: '/pescar',
      description: '[Trabalho livre] Pesca no rio ou lago',
      usage: '/pescar',
      handler: (actorId) => catchFish(actorId)
    }
  ];
}

module.exports = {
  chopWood,
  mineOre,
  catchFish,
  commandDefs,
  // Exposto so pra teste: permite exercitar o bloqueio de coleta concorrente e
  // a liberacao sem depender de timer real.
  _activeGatherers: activeGatherers
};
