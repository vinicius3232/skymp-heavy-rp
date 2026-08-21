/**
 * voiceChannels.js
 *
 * Canais de voz temporários — alternativa prática de voz enquanto o VOIP
 * nativo do gamemode (`/voz` in-game) depende de um patch de client que
 * ainda não existe upstream (ver docs/technical/VOICE_CLIENT_PATCH.md).
 *
 * Fluxo:
 *   - Staff roda /voz-criar <nome> → cria um canal de voz temporário sob
 *     VOICE_CATEGORY_ID, marcado como "gerenciado" em memória.
 *   - Quando o canal fica vazio, é apagado automaticamente após um período
 *     de graça (evita flicker se alguém reconectar rápido).
 *   - /voz-fechar apaga o canal atual na hora (staff, ou quem criou).
 *
 * Não persiste nada em banco — se o bot reiniciar, canais temporários já
 * criados deixam de ser "gerenciados" (não serão auto-apagados), mas
 * continuam existindo até alguém apagar manualmente. Aceitável pro escopo:
 * é uma ferramenta de conveniência de staff, não um sistema de RP crítico.
 */

const {
  SlashCommandBuilder,
  ChannelType
} = require('discord.js');

// `PermissionFlagsBits` saiu junto com `isStaffMember`: a permissão
// `Administrator` da guild era metade da quarta fonte de autoridade que este
// arquivo tinha. Ver staffAuthorization.js.
const { explainDenial } = require('./staffAuthorization');

const EMPTY_CHANNEL_GRACE_MS = 30 * 1000;

// channelId -> { createdBy, emptyTimer }
const _managedChannels = new Map();

/**
 * A capability que gerenciar canal de voz temporário exige.
 *
 * `voice.mute` e não uma nova: quem já pode silenciar a voz de alguém em jogo é
 * exatamente quem organiza uma cena por voz, e criar uma capability própria para
 * isto daria ao projeto mais uma para justificar sem que ninguém tivesse pedido.
 * É moderador+, que é onde o portão do Discord já estava na prática.
 */
const VOICE_CHANNEL_PERMISSION = 'voice.mute';

function sanitizeChannelName(raw) {
  const cleaned = String(raw || '').trim().slice(0, 60);
  return cleaned || 'sala-rp';
}

/**
 * Cancela o timer de auto-remoção de um canal (se houver) — chamado quando
 * alguém entra num canal que estava na janela de graça pra ser apagado.
 */
function cancelPendingRemoval(channelId) {
  const entry = _managedChannels.get(channelId);
  if (entry && entry.emptyTimer) {
    clearTimeout(entry.emptyTimer);
    entry.emptyTimer = null;
  }
}

/**
 * Agenda a remoção de um canal gerenciado vazio após o período de graça.
 * Se alguém entrar antes do timer disparar, cancelPendingRemoval cuida disso
 * via o listener de voiceStateUpdate em index.js.
 */
function scheduleRemovalIfEmpty(channel) {
  const entry = _managedChannels.get(channel.id);
  if (!entry) return; // não é um canal gerenciado por nós
  if (channel.members.size > 0) return;

  cancelPendingRemoval(channel.id);
  entry.emptyTimer = setTimeout(async () => {
    try {
      if (channel.members.size === 0) {
        await channel.delete('Canal de voz temporário vazio (RP)');
        _managedChannels.delete(channel.id);
        console.log(`[voice-channels] Canal temporário ${channel.id} removido (vazio).`);
      }
    } catch (err) {
      console.error('[voice-channels] Falha ao remover canal vazio:', err.message);
    }
  }, EMPTY_CHANNEL_GRACE_MS);
  if (typeof entry.emptyTimer.unref === 'function') entry.emptyTimer.unref();
}

const commands = [
  new SlashCommandBuilder()
    .setName('voz-criar')
    .setDescription('[Staff] Cria um canal de voz temporário pra uma cena de RP')
    .addStringOption(opt =>
      opt.setName('nome').setDescription('Nome da cena/local').setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('voz-fechar')
    .setDescription('[Staff] Fecha o canal de voz temporário atual')
];

/**
 * @param {any} interaction
 * @param {{authorization: {authorize: Function}, voiceCategoryId?: string}} deps
 *   `authorization` consulta o painel, que consulta o catálogo. O bot não
 *   resolve cargo sozinho — ver `staffAuthorization.js`.
 */
async function handleInteraction(interaction, { authorization, voiceCategoryId }) {
  if (!interaction.isChatInputCommand()) return false;
  if (interaction.commandName !== 'voz-criar' && interaction.commandName !== 'voz-fechar') return false;

  if (!authorization || typeof authorization.authorize !== 'function') {
    // Sem o cliente de autorização não há como saber quem é quem, e a resposta
    // segura é negar. Um bot que libera quando não consegue perguntar libera
    // todo mundo no minuto em que o painel cai.
    console.error('[voice-channels] Cliente de autorizacao ausente: negando.');
    await interaction.reply({ content: explainDenial('not_configured'), ephemeral: true });
    return true;
  }

  const decisao = await authorization.authorize(interaction.user.id, VOICE_CHANNEL_PERMISSION);
  if (!decisao.allowed) {
    await interaction.reply({ content: explainDenial(decisao.reason), ephemeral: true });
    return true;
  }

  if (interaction.commandName === 'voz-criar') {
    const rawName = interaction.options.getString('nome');
    const channelName = `🎙️ ${sanitizeChannelName(rawName)}`;

    if (!voiceCategoryId) {
      await interaction.reply({ content: 'VOICE_CATEGORY_ID não configurado no .env do bot.', ephemeral: true });
      return true;
    }

    try {
      const channel = await interaction.guild.channels.create({
        name: channelName,
        type: ChannelType.GuildVoice,
        parent: voiceCategoryId
      });
      _managedChannels.set(channel.id, { createdBy: interaction.user.id, emptyTimer: null });
      scheduleRemovalIfEmpty(channel); // começa vazio — agenda remoção se ninguém entrar
      await interaction.reply({ content: `Canal criado: ${channel}`, ephemeral: false });
    } catch (err) {
      console.error('[voice-channels] Falha ao criar canal:', err.message);
      await interaction.reply({ content: 'Não foi possível criar o canal.', ephemeral: true });
    }
    return true;
  }

  // /voz-fechar
  const voiceChannel = interaction.member.voice.channel;
  if (!voiceChannel || !_managedChannels.has(voiceChannel.id)) {
    await interaction.reply({ content: 'Você precisa estar num canal de voz temporário gerenciado pra fechá-lo.', ephemeral: true });
    return true;
  }

  try {
    cancelPendingRemoval(voiceChannel.id);
    await voiceChannel.delete('Fechado manualmente via /voz-fechar');
    _managedChannels.delete(voiceChannel.id);
    await interaction.reply({ content: 'Canal fechado.', ephemeral: true });
  } catch (err) {
    console.error('[voice-channels] Falha ao fechar canal:', err.message);
    await interaction.reply({ content: 'Não foi possível fechar o canal.', ephemeral: true });
  }
  return true;
}

/**
 * Chamado pelo listener voiceStateUpdate em index.js sempre que alguém
 * entra/sai de um canal de voz — mantém o ciclo de vida dos canais
 * gerenciados (cancela remoção se alguém entrar, agenda se ficar vazio).
 */
function handleVoiceStateUpdate(oldState, newState) {
  const oldChannel = oldState.channel;
  const newChannel = newState.channel;

  if (newChannel && _managedChannels.has(newChannel.id)) {
    cancelPendingRemoval(newChannel.id);
  }
  if (oldChannel && oldChannel.id !== newChannel?.id && _managedChannels.has(oldChannel.id)) {
    scheduleRemovalIfEmpty(oldChannel);
  }
}

module.exports = {
  commands,
  handleInteraction,
  handleVoiceStateUpdate,
  VOICE_CHANNEL_PERMISSION,
  sanitizeChannelName,
  // Exposto só pra testes
  _managedChannels,
  _scheduleRemovalIfEmpty: scheduleRemovalIfEmpty,
  _cancelPendingRemoval: cancelPendingRemoval
};
