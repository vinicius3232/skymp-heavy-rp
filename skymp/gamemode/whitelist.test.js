const assert = require('node:assert/strict');
const { after, beforeEach, test } = require('node:test');
const Module = require('node:module');

const queries = [];
const originalLoad = Module._load;

// Controla o que a query de bind (game_sessions JOIN characters) devolve.
// Vazio por padrão: a maioria dos testes existentes assume o caminho de
// fallback (sem game_session vinculada), que é o comportamento pré-AUTH-003.
let boundCharacterRows = [];

Module._load = function (request, parent, isMain) {
  if (request === './database') {
    return {
      query: async (sql, params = []) => {
        queries.push({ sql, params });
        if (/FROM accounts a\s+WHERE a\.id = \?/i.test(sql)) {
          return [{ id: 42, status: 'active', vip_level: 0 }];
        }
        if (/FROM whitelist_applications/i.test(sql)) return [{ status: 'approved' }];
        if (/FROM game_sessions gs\s+JOIN characters c/i.test(sql)) return boundCharacterRows;
        if (/FROM characters/i.test(sql)) {
          return [{ id: 7, first_name: 'Alvara', last_name: 'Dawnmere', pos_x: 0, pos_y: 0, pos_z: 0, angle_z: 0, cell_id: '0x3c' }];
        }
        return [];
      }
    };
  }
  if (request === './commands') return { registerActiveCharacter: () => {} };
  if (request === './inventory-service') return { syncInventoryToClient: async () => {} };
  if (request === './admin-service') return { registerStaffRole: async () => {} };
  if (request === './core/character-state') return { initialize: async () => {} };
  if (request === './core/server-options') return { get: () => 0 };
  if (request === './core/transaction-service') return { addGold: async () => {} };
  if (request === './core/module-registry') return { isEnabled: () => false };
  return originalLoad.apply(this, arguments);
};

const whitelist = require('./whitelist');
Module._load = originalLoad;

beforeEach(() => {
  queries.length = 0;
  boundCharacterRows = [];
});

after(() => {
  delete global.mp;
});

test('whitelist resolves online profileId directly as accounts.id', async () => {
  const allowed = await whitelist.checkWhitelist(1, 42, 0xff000001);

  assert.equal(allowed, true);
  const accountLookup = queries.find(({ sql }) => /FROM accounts a\s+WHERE a\.id = \?/i.test(sql));
  assert.deepEqual(accountLookup.params, [42]);
  assert.equal(
    queries.some(({ sql }) => /discord_identities|d\.discord_id/i.test(sql)),
    false,
    'the gamemode must not interpret profileId as a Discord ID'
  );
});

test('AUTH-003: personagem vinculado pela game_session vence o fallback antigo', async () => {
  boundCharacterRows = [{ id: 501, first_name: 'Brenna', last_name: 'Coldhearth', pos_x: 1, pos_y: 2, pos_z: 3, angle_z: 0, cell_id: '0x1a' }];

  const allowed = await whitelist.checkWhitelist(1, 42, 0xff000002);
  assert.equal(allowed, true);

  const bindQuery = queries.find(({ sql }) => /FROM game_sessions gs\s+JOIN characters c/i.test(sql));
  assert.ok(bindQuery, 'deveria ter consultado o bind de game_session');
  assert.deepEqual(bindQuery.params, [42]);

  // A query de fallback ("mais recente approved") não deveria nem ter sido
  // tentada — o bind já resolveu o personagem.
  assert.equal(
    queries.some(({ sql }) => /^\s*SELECT \* FROM characters WHERE account_id/i.test(sql)),
    false,
    'com bind resolvido, o fallback antigo é desnecessário'
  );
});

test('sem game_session vinculada, cai no fallback do personagem approved mais recente', async () => {
  boundCharacterRows = []; // nenhuma sessão vinculada — comportamento pré-AUTH-003

  const allowed = await whitelist.checkWhitelist(1, 42, 0xff000003);
  assert.equal(allowed, true);

  assert.ok(
    queries.some(({ sql }) => /SELECT \* FROM characters WHERE account_id = \? AND status = 'approved'/i.test(sql)),
    'deveria ter caído no fallback quando não há bind'
  );
});

test('profile contract accepts only a positive safe integer', () => {
  assert.equal(whitelist.accountIdFromProfileId(42), 42);
  assert.equal(whitelist.accountIdFromProfileId('42'), 42);
  assert.equal(whitelist.accountIdFromProfileId(0), null);
  assert.equal(whitelist.accountIdFromProfileId('discord-id'), null);
});
