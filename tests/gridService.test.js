const test = require('node:test');
const assert = require('node:assert/strict');
const { makeGridService } = require('../lib/gridService');

function memoryStore() {
  const rows = new Map();
  let revision = 0;
  return {
    async read(path) {
      const row = rows.get(path);
      return row ? { value: structuredClone(row.value), etag: row.etag } : null;
    },
    async write(path, value, etag = null) {
      const row = rows.get(path);
      if ((etag === null && row) || (etag !== null && row?.etag !== etag)) {
        const error = new Error('ETag conflict');
        error.code = 'conflict';
        throw error;
      }
      rows.set(path, { value: structuredClone(value), etag: String(++revision) });
    },
    async remove(path, etag) {
      const row = rows.get(path);
      if (row && row.etag !== etag) {
        const error = new Error('ETag conflict');
        error.code = 'conflict';
        throw error;
      }
      rows.delete(path);
    },
    isConflict: (error) => error.code === 'conflict',
  };
}
const secret = 'test-only-session-secret-at-least-32-characters';

test('registration, login, account isolation, revision conflict, and recovery', async () => {
  const service = makeGridService({ store: memoryStore(), secret });
  const alice = await service.register({ username: 'Alice_1', password: 'correct horse battery staple' });
  const bob = await service.register({ username: 'bob_2', password: 'correct horse battery staple' });
  assert.equal(alice.user.username, 'alice_1');
  assert.notEqual(alice.user.id, bob.user.id);
  assert.equal((await service.me(alice.token)).id, alice.user.id);
  await assert.rejects(service.register({ username: 'alice_1', password: 'another long password' }), { code: 'username_taken' });
  await assert.rejects(service.login({ username: 'alice_1', password: 'bad password' }), { code: 'credentials' });
  const relogin = await service.login({ username: 'alice_1', password: 'correct horse battery staple' });
  assert.equal(relogin.user.id, alice.user.id);

  const data = { version: 1, varieties: [{ name: '仅甲可见' }] };
  assert.deepEqual(await service.pull(alice.token), { kind: 'empty' });
  assert.deepEqual(await service.push(alice.token, { baseRev: null, data }), { rev: 1 });
  assert.deepEqual(await service.pull(bob.token), { kind: 'empty' });
  assert.deepEqual((await service.pull(alice.token)).data, data);
  await assert.rejects(service.push(alice.token, { baseRev: null, data }), { code: 'conflict', remoteRev: 1 });
  assert.deepEqual(await service.push(alice.token, { baseRev: 1, data }), { rev: 2 });
  await service.deleteState(bob.token);
  assert.equal((await service.pull(alice.token)).rev, 2);

  const reset = await service.resetPassword({
    username: 'alice_1', recoveryCode: alice.recoveryCode, password: 'replacement password',
  });
  await assert.rejects(service.me(alice.token), { code: 'unauthenticated' });
  await assert.rejects(service.resetPassword({
    username: 'alice_1', recoveryCode: alice.recoveryCode, password: 'another replacement',
  }), { code: 'recovery' });
  assert.equal((await service.me(reset.token)).id, alice.user.id);
  await service.deleteState(reset.token);
  assert.deepEqual(await service.pull(reset.token), { kind: 'empty' });
});

test('invalid sessions and large or malformed state are rejected', async () => {
  const service = makeGridService({ store: memoryStore(), secret });
  const account = await service.register({ username: 'tester', password: 'a long password' });
  await assert.rejects(service.me('forged.session'), { code: 'unauthenticated' });
  await assert.rejects(service.push(account.token, { baseRev: null, data: { version: 2, varieties: [] } }), { code: 'data' });
  await assert.rejects(service.push(account.token, { baseRev: null, data: { version: 1, varieties: [{ name: 'x'.repeat(2_100_000) }] } }), { code: 'too_large' });
  await assert.rejects(service.push(account.token, { baseRev: 0, data: { version: 1, varieties: [] } }), { code: 'revision' });
});

