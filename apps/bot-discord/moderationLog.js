/**
 * moderationLog.js
 *
 * Envio de eventos de moderação para um canal do Discord.
 *
 * `docs/ARCHITECTURE.md` 1.3 registrava isto como a intenção original do bot e
 * anotava que **nunca foi implementado** — até aqui o bot só expunha o sync de
 * cargo e os comandos de voz.
 *
 * ─── O canal do Discord não é o registro ────────────────────────────────────
 *
 * O registro de moderação é `audit_logs`, escrito pelo gamemode e pelo painel
 * no mesmo fluxo da ação. Este canal é **notificação**: serve pra staff ver
 * acontecendo, no celular, sem abrir o painel.
 *
 * A distinção decide o comportamento em falha: se o Discord estiver fora, a
 * ação de moderação **acontece do mesmo jeito** e nada é desfeito. Quem produz
 * o evento manda e esquece; ninguém espera resposta daqui, e um `/permakill`
 * nunca falha porque o bot caiu.
 *
 * ─── Por que push e não polling de audit_logs ───────────────────────────────
 *
 * A alternativa era o bot ler `audit_logs` de tempos em tempos — ele até já tem
 * `mysql2` em `dependencies` (sem usar). Foi descartada: daria credencial de
 * banco a um terceiro processo pra ler uma tabela que ele não escreve, em troca
 * de latência de polling. O push manda de onde a ação acontece, no instante em
 * que acontece, e o único segredo que atravessa é o `INTERNAL_API_SECRET` que o
 * painel já usa pra falar com este bot.
 */

const { EmbedBuilder } = require('discord.js');

/**
 * Os eventos que este canal cobre.
 *
 * `ban` está aqui e **não tem produtor nenhum hoje**: `ban` é uma permissão que
 * os cargos `admin` e `owner` concedem em `admin-service.js` e que nenhum
 * comando consome — não existe `/ban` no gamemode nem no painel. Deixar o tipo
 * declarado é o que faz o dia em que o comando existir custar uma linha, e o
 * teste abaixo trava o formato para que ele não nasça diferente dos outros.
 */
const EVENT_KINDS = Object.freeze({
  ban:                { titulo: 'Banimento',            cor: 0x992d22, icone: '⛔' },
  kick:               { titulo: 'Expulsão',             cor: 0xe67e22, icone: '👢' },
  // `voice_mute` é do `/calar` (admin-service). Fica ao lado de `kick` porque é
  // a mesma permissão e a mesma classe de ação: moderação de cena. Cor mais
  // fria de propósito — silenciar não é expulsar, e um canal de log em que as
  // duas coisas pintam igual treina quem lê a não distinguir.
  voice_mute:         { titulo: 'Voz silenciada',       cor: 0x546e7a, icone: '🔇' },
  permakill:          { titulo: 'Permakill',            cor: 0x71368a, icone: '⚰️' },
  whitelist_approve:  { titulo: 'Whitelist aprovada',   cor: 0x2ecc71, icone: '✅' },
  whitelist_reject:   { titulo: 'Whitelist recusada',   cor: 0xe74c3c, icone: '❌' },
  whitelist_reset:    { titulo: 'Whitelist revertida',  cor: 0x95a5a6, icone: '↩️' }
});

/** Corta e limpa texto que veio de fora antes de virar mensagem no Discord. */
function sanitize(texto, max = 512) {
  if (typeof texto !== 'string') return null;
  return texto
    // Zera mencao em massa: um motivo de kick com `@everyone` viraria ping pra
    // guild inteira, e quem escreve o motivo e staff digitando em jogo. O
    // separador e um zero-width space ESCAPADO — a versao com o caractere cru
    // deixou este arquivo binario pro `grep`, que e o mesmo defeito que o
    // `core/soul.js` levou a corrigir: quem lesse a linha veria `'@$1'` e
    // concluiria que ela nao faz nada.
    .replace(/@(everyone|here)/gi, '@\u200b$1')
    // Caracteres de controle viram espaco. Quebra de linha injetada num motivo
    // desmontaria o embed.
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, max) || null;
}

/**
 * Valida o evento recebido. Devolve `{ ok: true, evento }` ou `{ ok: false, erro }`.
 *
 * Separado do envio de propósito: é a parte que decide, e precisa ser
 * exercitável sem Discord nenhum.
 */
function parseEvent(bruto) {
  if (!bruto || typeof bruto !== 'object') return { ok: false, erro: 'corpo ausente' };

  const kind = bruto.kind;
  if (!EVENT_KINDS[kind]) {
    return { ok: false, erro: `tipo de evento desconhecido: ${JSON.stringify(kind)}` };
  }

  const alvo = sanitize(bruto.target, 128);
  if (!alvo) return { ok: false, erro: 'target obrigatorio' };

  return {
    ok: true,
    evento: {
      kind,
      target: alvo,
      // `moderator` é opcional porque nem todo evento tem pessoa por trás — uma
      // reversão automática de whitelist, por exemplo.
      moderator: sanitize(bruto.moderator, 128),
      reason: sanitize(bruto.reason),
      source: sanitize(bruto.source, 32) || 'desconhecido',
      at: typeof bruto.at === 'string' ? bruto.at : new Date().toISOString()
    }
  };
}

/**
 * Monta o embed. Função pura — o teste confere o conteúdo sem tocar no Discord.
 */
function buildEmbed(evento) {
  const meta = EVENT_KINDS[evento.kind];

  const embed = new EmbedBuilder()
    .setTitle(`${meta.icone} ${meta.titulo}`)
    .setColor(meta.cor)
    .setTimestamp(new Date(evento.at))
    // De onde veio importa numa arbitragem: `gamemode` é um comando em jogo,
    // `painel` é alguém logado na web. São responsabilidades diferentes.
    .setFooter({ text: `origem: ${evento.source}` });

  const campos = [{ name: 'Alvo', value: evento.target, inline: true }];
  if (evento.moderator) campos.push({ name: 'Staff', value: evento.moderator, inline: true });
  // Motivo é o campo que decide se o log serve pra alguma coisa. Sem ele a
  // linha diz que algo aconteceu e não diz por quê, que é o que a staff precisa
  // quando alguém contesta semanas depois.
  campos.push({ name: 'Motivo', value: evento.reason || '_não informado_', inline: false });

  embed.addFields(campos);
  return embed;
}

/**
 * Entrega o evento no canal configurado.
 *
 * **Nunca lança.** Devolve `{ sent: boolean, erro?: string }` — quem chama é um
 * endpoint que já respondeu, ou uma ação de moderação que já aconteceu.
 *
 * @param {object} client   cliente discord.js
 * @param {object} evento   saída de `parseEvent`
 * @param {string} channelId
 */
async function sendModerationLog(client, evento, channelId) {
  if (!channelId) {
    // Silêncio proposital: canal não configurado é "esta função está desligada",
    // não erro. Gritar a cada kick num servidor que não quer o log seria ruído.
    return { sent: false, erro: 'canal nao configurado' };
  }

  try {
    const canal = await client.channels.fetch(channelId);
    if (!canal || typeof canal.send !== 'function') {
      return { sent: false, erro: `canal ${channelId} nao existe ou nao aceita mensagem` };
    }
    await canal.send({ embeds: [buildEmbed(evento)] });
    return { sent: true };
  } catch (err) {
    console.error('[moderation-log] Falha ao enviar evento:', err.message);
    return { sent: false, erro: err.message };
  }
}

module.exports = { EVENT_KINDS, parseEvent, buildEmbed, sendModerationLog, sanitize };
