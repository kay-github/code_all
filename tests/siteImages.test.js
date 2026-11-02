const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const sharp = require('sharp');
const { createHash } = require('node:crypto');
const images = require('../lib/siteImages');
const { makeSiteService } = require('../lib/siteService');

function fixture(format = 'png', width = 800, height = 400) {
  return sharp({ create: { width, height, channels: 4, background: { r: 24, g: 120, b: 240, alpha: 0.8 } } }).toFormat(format).toBuffer();
}
function memoryImages() {
  const rows = new Map();
  const sdk = {
    async put(path, body, options) {
      assert.match(path, /^tool-site\/icons\/[a-f0-9]{64}\.webp$/);
      assert.equal(options.access, 'private');
      assert.equal(options.contentType, 'image/webp');
      assert.equal(options.addRandomSuffix, false);
      assert.equal(options.allowOverwrite, true);
      rows.set(path, Buffer.from(body));
    },
    async get(path, options) {
      assert.match(path, /^tool-site\/icons\/[a-f0-9]{64}\.webp$/);
      assert.equal(options.access, 'private');
      assert.equal(options.useCache, false);
      return rows.has(path) ? { statusCode: 200, stream: new Response(rows.get(path)).body } : null;
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../lib/siteImages'), 'utf8'), { module, Buffer, Response, require: name => name === '@vercel/blob' ? sdk : name === './siteService' ? require('../lib/siteService') : require(name) });
  return { service: module.exports, rows };
}

test('all supported raster formats become small WebP icons; metadata, orientation and appended payload are removed', async () => {
  for (const format of ['png', 'jpeg', 'webp', 'gif']) {
    const original = await fixture(format);
    const output = await images.prepareImage(original.toString('base64'));
    const metadata = await sharp(output).metadata();
    assert.equal(metadata.format, 'webp');
    assert.equal(metadata.width, 256);
    assert.equal(metadata.height, 128);
    assert.ok(output.length < 20000);
    assert.equal(metadata.exif, undefined);
  }
  const oriented = await sharp(await fixture('jpeg')).withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const upright = await sharp(await images.prepareImage(oriented.toString('base64'))).metadata();
  assert.equal(upright.width, 128);
  assert.equal(upright.height, 256);
  assert.equal(upright.orientation, undefined);
  const withPayload = Buffer.concat([await fixture(), Buffer.from('<script>unique-untrusted-payload</script>')]);
  assert.equal((await images.prepareImage(withPayload.toString('base64'))).includes(Buffer.from('unique-untrusted-payload')), false);
});

test('invalid base64, disguised scripts, SVG, corrupted files, excess dimensions and byte limits fail closed', async () => {
  for (const value of ['not base64!', 'Zg=', 'Zh==', null]) await assert.rejects(images.prepareImage(value), { status: value === null ? 413 : 400 });
  for (const value of ['<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>', '<html>not a PNG</html>']) await assert.rejects(images.prepareImage(Buffer.from(value).toString('base64')), { status: 415 });
  await assert.rejects(images.prepareImage(Buffer.from('89504e470d0a1a0a0000', 'hex').toString('base64')), { status: 400 });
  await assert.rejects(images.prepareImage((await fixture('png', 10001, 1)).toString('base64')), { status: 400 });
  await assert.rejects(images.prepareImage(Buffer.alloc(images.MAX_IMAGE_BYTES + 1).toString('base64')), { status: 413 });
});

test('content-addressed private storage returns same-origin URLs, deduplicates, and cannot access other namespaces', async () => {
  const { service, rows } = memoryImages();
  const data = (await fixture()).toString('base64');
  const result = await service.upload(data);
  assert.match(result.image, /^\/api\/site\/image\?id=[a-f0-9]{64}$/);
  assert.deepEqual(await service.upload(data), result);
  assert.equal(rows.size, 1);
  const id = new URL(result.image, 'https://example.com').searchParams.get('id');
  const restored = await service.read(id);
  assert.equal(createHash('sha256').update(restored).digest('hex'), id);
  assert.equal((await sharp(restored).metadata()).format, 'webp');
  for (const id of ['../config.json', 'tool-site/security.json', ['a'.repeat(64)], 'https://evil.example', undefined, 'x'.repeat(64)]) await assert.rejects(service.read(id), { status: 404 });
  await assert.rejects(service.read('0'.repeat(64)), { status: 404 });
});

test('HTTP upload requires origin, session and CSRF; public image serving uses safe type and immutable cache', async () => {
  const store = require('../lib/gridStore');
  const { scryptSync } = require('node:crypto');
  const originalStore = { read: store.read, write: store.write, isConflict: store.isConflict };
  const originalImages = { upload: images.upload, read: images.read };
  const originalEnv = { hash: process.env.SITE_ADMIN_PASSWORD_HASH, secret: process.env.SITE_SESSION_SECRET };
  const rows = new Map();
  const salt = '00112233445566778899aabbccddeeff';
  process.env.SITE_ADMIN_PASSWORD_HASH = `scrypt:32768:${salt}:${scryptSync('test-only-password', salt, 32, { N: 32768, maxmem: 67108864 }).toString('hex')}`;
  process.env.SITE_SESSION_SECRET = 'test-only-image-session-secret-at-least-32-chars';
  Object.assign(store, {
    async read(key) { return rows.has(key) ? structuredClone(rows.get(key)) : null; },
    async write(key, value) { rows.set(key, { value: structuredClone(value), etag: String(Date.now()) }); },
    isConflict: () => false,
  });
  const inMemory = memoryImages();
  Object.assign(images, { upload: inMemory.service.upload, read: inMemory.service.read });
  const handler = require('../api/site/image');
  async function request(method, body, headers = {}, query = {}) {
    const result = { headers: {} };
    const res = { setHeader(key, value) { result.headers[key] = value; }, end(value) { result.status = this.statusCode; result.body = Buffer.isBuffer(value) || value === undefined ? value : JSON.parse(value); } };
    await handler({ method, body, query, headers: { host: '1.688680.xyz', origin: 'https://1.688680.xyz', 'content-type': 'application/json', ...headers } }, res);
    return result;
  }
  try {
    const input = { data: (await fixture()).toString('base64') };
    assert.equal((await request('POST', input)).status, 401);
    const site = makeSiteService({ store, passwordHash: process.env.SITE_ADMIN_PASSWORD_HASH, sessionSecret: process.env.SITE_SESSION_SECRET });
    const session = await site.login('test-only-password', 'test-ip');
    const headers = { cookie: `__Host-tools_admin=${session.token}`, 'x-csrf-token': session.csrf };
    assert.equal((await request('POST', input, { cookie: headers.cookie })).status, 403);
    assert.equal((await request('POST', input, { ...headers, origin: 'https://b.688680.xyz' })).status, 403);
    assert.equal((await request('POST', input, { ...headers, 'content-type': 'text/plain' })).status, 415);
    assert.equal((await request('POST', input, { ...headers, 'content-length': '3000001' })).status, 413);
    assert.equal(inMemory.rows.size, 0);
    const upload = await request('POST', input, headers);
    assert.equal(upload.status, 201);
    const query = { id: upload.body.image.split('=')[1] };
    const publicImage = await request('GET', undefined, {}, query);
    assert.equal(publicImage.status, 200);
    assert.equal(publicImage.headers['Content-Type'], 'image/webp');
    assert.equal(publicImage.headers['X-Content-Type-Options'], 'nosniff');
    assert.match(publicImage.headers['Cache-Control'], /public.*immutable/);
    assert.equal((await sharp(publicImage.body).metadata()).format, 'webp');
    assert.equal((await request('HEAD', undefined, {}, query)).body, undefined);
    assert.equal((await request('GET', undefined, {}, { id: '../../grid/account' })).status, 404);
    assert.equal((await request('DELETE', undefined, headers)).status, 405);
    await site.logout(session.token, session.csrf);
    assert.equal((await request('POST', input, headers)).status, 401);
  } finally {
    Object.assign(store, originalStore);
    Object.assign(images, originalImages);
    for (const [name, value] of [['SITE_ADMIN_PASSWORD_HASH', originalEnv.hash], ['SITE_SESSION_SECRET', originalEnv.secret]]) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
});
