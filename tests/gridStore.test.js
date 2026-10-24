const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('large Blob documents retain a strong ETag for conditional writes and reject stale writes', async () => {
  let revision = 1;
  let value = { version: 1, items: Array.from({ length: 12 }, (_, id) => ({ id, remark: 'long content '.repeat(40) })) };
  class Conflict extends Error {}
  const sdk = {
    BlobPreconditionFailedError: Conflict,
    async get(key, options) {
      assert.equal(key, 'work-portal/config.json');
      assert.equal(options.access, 'private');
      assert.equal(options.useCache, false);
      // A compressed response changes the HTTP validator to a weak ETag.
      const compressed = options.headers?.['Accept-Encoding'] !== 'identity';
      return { statusCode: 200, stream: new Response(JSON.stringify(value)).body, blob: { etag: `${compressed ? 'W/' : ''}"revision-${revision}"` } };
    },
    async put(key, body, options) {
      if (options.ifMatch !== `"revision-${revision}"`) throw new Conflict();
      assert.equal(options.allowOverwrite, true);
      assert.equal(options.access, 'private');
      value = JSON.parse(body);
      revision += 1;
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../lib/gridStore'), 'utf8'), { module, Response, require: name => { assert.equal(name, '@vercel/blob'); return sdk; } });
  const store = module.exports;
  const current = await store.read('work-portal/config.json');
  assert.equal(current.value.version, 1);
  await store.write('work-portal/config.json', { ...current.value, version: 2 }, current.etag);
  assert.equal((await store.read('work-portal/config.json')).value.version, 2);
  await assert.rejects(store.write('work-portal/config.json', current.value, current.etag), error => store.isConflict(error));
});
