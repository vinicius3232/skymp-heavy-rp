const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const pollGrants = require('./pollGrants');
const credential = require('../../skymp/gamemode/core/opaque-credential');

describe('pollGrants — emissão e consumo', () => {
  test('token emitido tem o kind queue_grant', () => {
    pollGrants._reset();
    const token = pollGrants.issue(1, 'd1');
    assert.equal(credential.parse(token).kind, 'queue_grant');
  });

  test('consome um token válido e devolve a identidade', () => {
    pollGrants._reset();
    const token = pollGrants.issue(7, 'd7');
    const identity = pollGrants.consume(token);
    assert.deepEqual(identity, { accountId: 7, discordId: 'd7' });
  });

  test('reapresentar o mesmo token depois de consumido falha', () => {
    pollGrants._reset();
    const token = pollGrants.issue(1, 'd1');
    assert.ok(pollGrants.consume(token));
    assert.equal(pollGrants.consume(token), null, 'uso único — segunda apresentação não pode funcionar');
  });

  test('token de outro kind (launch_grant/game_session) é rejeitado sem tocar o store', () => {
    pollGrants._reset();
    const outroKind = credential.generate('launch_grant');
    assert.equal(pollGrants.consume(outroKind), null);
    assert.equal(pollGrants._size(), 0, 'nada deveria ter sido inserido/removido por um kind errado');
  });

  test('token malformado é rejeitado antes de qualquer lookup', () => {
    pollGrants._reset();
    assert.equal(pollGrants.consume('nao-e-um-token-opaco'), null);
    assert.equal(pollGrants.consume(''), null);
    assert.equal(pollGrants.consume(undefined), null);
  });

  test('token expirado é rejeitado e removido — não fica preso no store', () => {
    pollGrants._reset();
    const now0 = 1_000_000;
    const token = pollGrants.issue(1, 'd1', now0);
    assert.equal(pollGrants._size(), 1);

    const depoisDoTtl = now0 + pollGrants.TTL_MS + 1;
    assert.equal(pollGrants.consume(token, depoisDoTtl), null);
    assert.equal(pollGrants._size(), 0, 'consumir um expirado deveria limpar o registro mesmo rejeitando');
  });

  test('emitir não afeta grants de outras contas', () => {
    pollGrants._reset();
    const tokenA = pollGrants.issue(1, 'd1');
    pollGrants.issue(2, 'd2');
    assert.deepEqual(pollGrants.consume(tokenA), { accountId: 1, discordId: 'd1' });
  });
});
