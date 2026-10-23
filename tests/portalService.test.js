const test = require('node:test');
const assert = require('node:assert/strict');
const { scryptSync } = require('node:crypto');
const { makePortalService, DEFAULT_ITEMS, STORE_KEY, SESSION_MS } = require('../lib/portalService');

const salt = '00112233445566778899aabbccddeeff';
const passwordHash = `${salt}:${scryptSync('test-admin-password', salt, 32).toString('hex')}`;
const sessionSecret = 'test-only-portal-session-secret-at-least-32-chars';
function memoryStore() {
  const rows = new Map();
  let revision = 0;
  return {
    rows,
    async read(key) { return rows.has(key) ? structuredClone(rows.get(key)) : null; },
    async write(key, value, etag) {
      const row = rows.get(key);
      if ((etag === null && row) || (etag !== null && row?.etag !== etag)) {
        const error = new Error('Conflict'); error.code = 'conflict'; throw error;
      }
      rows.set(key, { value: structuredClone(value), etag: String(++revision) });
    },
    isConflict: error => error.code === 'conflict',
  };
}
function setup(options = {}) {
  const store = memoryStore();
  const settings = { store, passwordHash, sessionSecret, ...options };
  return { store, settings, portal: makePortalService(settings) };
}

test('password is case insensitive; wrong, forged and expired credentials fail', () => {
  let time = 1800000000000;
  const { portal } = setup({ now: () => time });
  assert.throws(() => portal.login('incorrect'), { status: 401 });
  const token = portal.login('TEST-ADMIN-PASSWORD');
  assert.equal(portal.authenticated(token), true);
  assert.equal(portal.authenticated(`${token.slice(0, -4)}xxxx`), false);
  assert.equal(portal.authenticated('invalid.session.extra'), false);
  assert.equal(portal.authenticated(null), false);
  time += SESSION_MS;
  assert.equal(portal.authenticated(token), false);
  assert.throws(() => setup({ sessionSecret: '' }).portal.login('test-admin-password'), { status: 503 });
});

test('six defaults are readable; changed names, URLs and remarks survive a new service instance', async () => {
  const { portal, store, settings } = setup();
  const initial = await portal.read();
  assert.equal(initial.version, 0);
  assert.deepEqual(initial.items, DEFAULT_ITEMS);
  await assert.rejects(portal.save(null, initial), { status: 401 });
  initial.items[0] = { id: 'overtime', name: '新的登记名称', url: 'https://example.com/new-form?q=1', remark: '新的备注说明' };
  const saved = await portal.save(portal.login('test-admin-password'), initial);
  assert.equal(saved.version, 1);
  assert.deepEqual((await makePortalService(settings).read()).items[0], initial.items[0]);
  assert.deepEqual([...store.rows.keys()], [STORE_KEY]);
  assert.ok(saved.updatedAt);
});

test('unsafe URLs and malformed fields cannot be stored', async () => {
  const { portal, store } = setup();
  const token = portal.login('test-admin-password');
  for (const url of ['javascript:alert(1)', 'data:text/html,test', '//example.com', 'https://user:password@example.com', 'https://example.com/\nfoo']) {
    const data = await portal.read(); data.items[0].url = url;
    await assert.rejects(portal.save(token, data), { status: 400, code: 'url' });
  }
  for (const change of [data => { data.items[0].name = ''; }, data => { data.items[0].remark = 'x'.repeat(161); }, data => { data.items[1].id = data.items[0].id; }, data => { data.items.pop(); }, data => { data.version = -1; }]) {
    const data = await portal.read(); change(data);
    await assert.rejects(portal.save(token, data), { status: 400 });
  }
  assert.equal(store.rows.size, 0);
});

test('stale edits and simultaneous writes cannot overwrite a newer configuration', async () => {
  const { portal } = setup();
  const token = portal.login('test-admin-password');
  const initial = await portal.read();
  const writes = await Promise.allSettled([portal.save(token, initial), portal.save(token, initial)]);
  assert.equal(writes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(writes.find(result => result.status === 'rejected').reason.status, 409);
  await assert.rejects(portal.save(token, initial), { status: 409 });
  assert.equal((await portal.read()).version, 1);
});

test('HTTP handlers enforce authorization, origin and secure cookies', async () => {
  const auth = require('../api/portal/auth');
  const config = require('../api/portal/config');
  const realStore = require('../lib/gridStore');
  const fakeStore = memoryStore();
  const original = { read: realStore.read, write: realStore.write, isConflict: realStore.isConflict };
  const oldHash = process.env.PORTAL_ADMIN_PASSWORD_HASH;
  const oldSecret = process.env.PORTAL_SESSION_SECRET;
  Object.assign(realStore, { read: fakeStore.read, write: fakeStore.write, isConflict: fakeStore.isConflict });
  process.env.PORTAL_ADMIN_PASSWORD_HASH = passwordHash;
  process.env.PORTAL_SESSION_SECRET = sessionSecret;
  async function request(handler, method, body, headers = {}) {
    const result = { headers: {} };
    const res = { setHeader(name, value) { result.headers[name] = value; }, end(value) { result.status = this.statusCode; result.body = JSON.parse(value); } };
    await handler({ method, body, headers: { host: 'b2.688680.xyz', origin: 'https://b2.688680.xyz', 'content-type': 'application/json', ...headers } }, res);
    return result;
  }
  try {
    assert.equal((await request(config, 'GET')).body.items.length, 6);
    assert.equal((await request(config, 'PUT', { version: 0, items: DEFAULT_ITEMS })).status, 401);
    assert.equal((await request(auth, 'POST', { password: 'TEST-ADMIN-PASSWORD' }, { origin: 'https://other.example' })).status, 403);
    assert.equal((await request(auth, 'POST', { password: 'wrong' })).status, 401);
    const login = await request(auth, 'POST', { password: 'TEST-ADMIN-PASSWORD' });
    assert.equal(login.status, 200);
    assert.deepEqual(login.body, { authenticated: true });
    const cookie = login.headers['Set-Cookie'];
    assert.match(cookie, /HttpOnly; SameSite=Strict/);
    assert.match(cookie, /; Secure$/);
    assert.match(cookie, /Path=\/api\/portal/);
    const headers = { cookie: cookie.split(';')[0] };
    assert.equal((await request(auth, 'GET', null, headers)).body.authenticated, true);
    assert.equal((await request(config, 'PUT', { version: 0, items: DEFAULT_ITEMS }, headers)).status, 200);
    assert.equal((await request(config, 'GET')).body.version, 1);
    assert.equal((await request(config, 'PUT', { version: 1, items: DEFAULT_ITEMS }, { ...headers, origin: 'https://b.688680.xyz' })).status, 403);
    const logout = await request(auth, 'DELETE', null, headers);
    assert.match(logout.headers['Set-Cookie'], /Max-Age=0/);
    for (let i = 0; i < 10; i += 1) await request(auth, 'POST', { password: 'wrong' }, { 'x-forwarded-for': 'test-throttled-ip' });
    assert.equal((await request(auth, 'POST', { password: 'wrong' }, { 'x-forwarded-for': 'test-throttled-ip' })).status, 429);
  } finally {
    Object.assign(realStore, original);
    if (oldHash === undefined) delete process.env.PORTAL_ADMIN_PASSWORD_HASH; else process.env.PORTAL_ADMIN_PASSWORD_HASH = oldHash;
    if (oldSecret === undefined) delete process.env.PORTAL_SESSION_SECRET; else process.env.PORTAL_SESSION_SECRET = oldSecret;
  }
});
