/**
 * voiceChannels.test.js
 *
 * Testes das partes de voiceChannels.js que não exigem conexão real com o
 * Discord: checagem de permissão de staff, sanitização de nome de canal, e
 * o ciclo de vida de agendamento/cancelamento de remoção de canal vazio.
 * A interação real com a API do Discord (criar/apagar canal, responder
 * interação) não é coberta aqui — precisa de um bot/guild reais pra validar.
 *
 * Executa com: node --test voiceChannels.test.js
 */

const assert = require('assert');
const { describe, it, beforeEach, afterEach } = require('node:test');

const voiceChannels = require('./voiceChannels');

/**
 * ─── O que este bloco substituiu, e por quê ─────────────────────────────────
 *
 * Havia aqui quatro testes de `isStaffMember`, que aceitava quem tivesse o
 * cargo `STAFF_ROLE_ID` **do Discord** ou a permissão `Administrator` da guild.
 * Os testes estavam certos sobre o comportamento e o comportamento estava
 * errado: era uma quarta fonte de autoridade fora de `staff_roles`, em que
 * promover alguém no Discord dava poder que o servidor de jogo não reconhecia,
 * e revogar no banco não tirava nada aqui.
 *
 * O bot agora pergunta ao painel, que consulta o catálogo único. O que estes
 * testes medem é o portão: quem decide, e o que acontece quando não dá para
 * perguntar.
 */
describe('autorização de staff — o bot não decide sozinho', () => {
  function fakeInteraction(overrides = {}) {
    const respostas = [];
    return {
      respostas,
      isChatInputCommand: () => true,
      commandName: 'voz-criar',
      user: { id: '123456789' },
      options: { getString: () => 'taverna' },
      guild: { channels: { create: async () => ({ id: 'novo-canal', members: { size: 0 } }) } },
      reply: async (payload) => { respostas.push(payload); },
      ...overrides
    };
  }

  it('pergunta ao painel pela capability voice.mute, nunca por cargo do Discord', async () => {
    const perguntas = [];
    const interaction = fakeInteraction();

    await voiceChannels.handleInteraction(interaction, {
      authorization: {
        authorize: async (discordId, permission) => {
          perguntas.push({ discordId, permission });
          return { allowed: false, role: null, reason: 'not_granted' };
        }
      },
      voiceCategoryId: 'cat-1'
    });

    assert.deepStrictEqual(perguntas, [{ discordId: '123456789', permission: 'voice.mute' }]);
    assert.strictEqual(voiceChannels.VOICE_CHANNEL_PERMISSION, 'voice.mute');
  });

  it('nega quando o painel nega, e diz por quê sem vazar infraestrutura', async () => {
    const interaction = fakeInteraction();
    await voiceChannels.handleInteraction(interaction, {
      authorization: { authorize: async () => ({ allowed: false, role: null, reason: 'not_granted' }) },
      voiceCategoryId: 'cat-1'
    });

    assert.strictEqual(interaction.respostas.length, 1);
    assert.match(interaction.respostas[0].content, /cargo de staff/i);
    assert.strictEqual(interaction.respostas[0].ephemeral, true);
  });

  it('NEGA quando o painel está fora do ar — nunca libera', async () => {
    // A regra é o oposto da do `moderationLog`, que manda-e-esquece: ali a ação
    // já aconteceu e o Discord é notificação. Aqui a resposta é a CONDIÇÃO para
    // a ação acontecer. Um bot que libera quando não consegue perguntar libera
    // todo mundo no minuto em que o painel cai.
    const interaction = fakeInteraction();
    let criou = false;
    interaction.guild.channels.create = async () => { criou = true; return { id: 'x', members: { size: 0 } }; };

    await voiceChannels.handleInteraction(interaction, {
      authorization: { authorize: async () => ({ allowed: false, role: null, reason: 'panel_unreachable' }) },
      voiceCategoryId: 'cat-1'
    });

    assert.strictEqual(criou, false, 'canal foi criado apesar de o painel estar inacessível');
    assert.match(interaction.respostas[0].content, /não foi possível verificar/i);
  });

  it('NEGA quando o cliente de autorização nem foi injetado', async () => {
    const interaction = fakeInteraction();
    let criou = false;
    interaction.guild.channels.create = async () => { criou = true; return { id: 'x', members: { size: 0 } }; };

    await voiceChannels.handleInteraction(interaction, { voiceCategoryId: 'cat-1' });

    assert.strictEqual(criou, false);
    assert.strictEqual(interaction.respostas.length, 1);
  });

  it('deixa passar quando o painel autoriza', async () => {
    const interaction = fakeInteraction();
    let criou = false;
    interaction.guild.channels.create = async () => { criou = true; return { id: 'x', members: { size: 0 } }; };

    await voiceChannels.handleInteraction(interaction, {
      authorization: { authorize: async () => ({ allowed: true, role: 'moderator', reason: 'granted' }) },
      voiceCategoryId: 'cat-1'
    });

    assert.strictEqual(criou, true, 'moderator autorizado deveria conseguir criar o canal');
  });

  it('a capability exigida existe e está ativa no catálogo', () => {
    const catalog = require('../../skymp/gamemode/core/permissions');
    const cap = catalog.CAPABILITIES[voiceChannels.VOICE_CHANNEL_PERMISSION];
    assert.ok(cap, 'o bot exige uma capability que o catálogo não conhece');
    assert.strictEqual(cap.status, 'active', 'reservada nega para todo cargo, inclusive owner');
  });
});

describe('sanitizeChannelName', () => {
  it('mantém nome válido', () => {
    assert.strictEqual(voiceChannels.sanitizeChannelName('Taverna do Bannered Mare'), 'Taverna do Bannered Mare');
  });

  it('corta nomes muito longos em 60 caracteres', () => {
    const long = 'x'.repeat(100);
    assert.strictEqual(voiceChannels.sanitizeChannelName(long).length, 60);
  });

  it('usa fallback pra entrada vazia', () => {
    assert.strictEqual(voiceChannels.sanitizeChannelName(''), 'sala-rp');
    assert.strictEqual(voiceChannels.sanitizeChannelName('   '), 'sala-rp');
    assert.strictEqual(voiceChannels.sanitizeChannelName(null), 'sala-rp');
  });
});

describe('ciclo de vida de canal gerenciado', () => {
  function fakeChannel(id, memberCount) {
    return { id, members: { size: memberCount }, delete: async () => {} };
  }

  beforeEach(() => {
    voiceChannels._managedChannels.clear();
  });

  afterEach(() => {
    for (const entry of voiceChannels._managedChannels.values()) {
      if (entry.emptyTimer) clearTimeout(entry.emptyTimer);
    }
    voiceChannels._managedChannels.clear();
  });

  it('agenda remoção só de canais gerenciados por nós', () => {
    const untracked = fakeChannel('untracked-channel', 0);
    voiceChannels._scheduleRemovalIfEmpty(untracked);
    assert.strictEqual(voiceChannels._managedChannels.has('untracked-channel'), false);
  });

  it('não agenda remoção se o canal ainda tem gente', () => {
    voiceChannels._managedChannels.set('c1', { createdBy: 'u1', emptyTimer: null });
    const channel = fakeChannel('c1', 2);
    voiceChannels._scheduleRemovalIfEmpty(channel);
    assert.strictEqual(voiceChannels._managedChannels.get('c1').emptyTimer, null);
  });

  it('agenda remoção quando o canal gerenciado fica vazio', () => {
    voiceChannels._managedChannels.set('c1', { createdBy: 'u1', emptyTimer: null });
    const channel = fakeChannel('c1', 0);
    voiceChannels._scheduleRemovalIfEmpty(channel);
    assert.ok(voiceChannels._managedChannels.get('c1').emptyTimer, 'deveria ter agendado um timer');
  });

  it('cancelPendingRemoval limpa o timer agendado', () => {
    voiceChannels._managedChannels.set('c1', { createdBy: 'u1', emptyTimer: null });
    const channel = fakeChannel('c1', 0);
    voiceChannels._scheduleRemovalIfEmpty(channel);
    assert.ok(voiceChannels._managedChannels.get('c1').emptyTimer);

    voiceChannels._cancelPendingRemoval('c1');
    assert.strictEqual(voiceChannels._managedChannels.get('c1').emptyTimer, null);
  });

  it('handleVoiceStateUpdate cancela remoção quando alguém entra no canal', () => {
    voiceChannels._managedChannels.set('c1', { createdBy: 'u1', emptyTimer: null });
    const channel = fakeChannel('c1', 0);
    voiceChannels._scheduleRemovalIfEmpty(channel);
    assert.ok(voiceChannels._managedChannels.get('c1').emptyTimer);

    // Alguém entra em c1: oldState sem canal, newState com channel c1.
    voiceChannels.handleVoiceStateUpdate({ channel: null }, { channel: fakeChannel('c1', 1) });
    assert.strictEqual(voiceChannels._managedChannels.get('c1').emptyTimer, null);
  });

  it('handleVoiceStateUpdate agenda remoção quando alguém sai deixando o canal vazio', () => {
    voiceChannels._managedChannels.set('c1', { createdBy: 'u1', emptyTimer: null });

    // Alguém sai de c1 (agora vazio): oldState com channel c1, newState sem canal.
    voiceChannels.handleVoiceStateUpdate({ channel: fakeChannel('c1', 0) }, { channel: null });
    assert.ok(voiceChannels._managedChannels.get('c1').emptyTimer, 'deveria ter agendado remoção ao esvaziar');
  });
});
