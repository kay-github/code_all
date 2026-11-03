const test = require('node:test');
const assert = require('node:assert/strict');
const { scryptSync } = require('node:crypto');
const { makeSiteService, validateConfig, CONFIG_KEY, SECURITY_KEY, SESSION_MS, WINDOW_MS, MAX_ITEMS } = require('../lib/siteService');
const defaults = require('../assets/site-defaults');

const password = 'Test-Only-Admin-Password';
const salt = '00112233445566778899aabbccddeeff';
const hash = `scrypt:32768:${salt}:${scryptSync(password, salt, 32, { N: 32768, maxmem: 64 * 1024 * 1024 }).toString('hex')}`;
const secret = 'test-only-session-pepper-at-least-32-characters';
function memoryStore() {
  const rows = new Map();
  let revision = 0;
  return {
    rows,
    async read(key) { return rows.has(key) ? structuredClone(rows.get(key)) : null; },
    async write(key, value, etag) {
      if ((rows.get(key)?.etag ?? null) !== etag) throw Object.assign(new Error('Conflict'), { code: 'conflict' });
      rows.set(key, { value: structuredClone(value), etag: String(++revision) });
    },
    isConflict: error => error.code === 'conflict',
  };
}
function setup(extra = {}) {
  const store = memoryStore();
  const settings = { store, passwordHash: hash, sessionSecret: secret, ...extra };
  return { store, settings, site: makeSiteService(settings) };
}

test('case-sensitive passwords, opaque sessions, expiry and password rotation', async () => {
  let time = 1800000000000;
  const { site, settings, store } = setup({ now: () => time });
  for (const value of [password.toLowerCase(), ` ${password}`, `${password} `, null]) await assert.rejects(site.login(value, 'ip'), { status: 401 });
  const session = await site.login(password, 'ip');
  assert.match(session.token, /^[\w-]{43}$/);
  assert.equal((await makeSiteService(settings).authenticate(session.token)).csrf, session.csrf);
  assert.equal(JSON.stringify(store.rows.get(SECURITY_KEY).value).includes(session.token), false);
  await assert.rejects(site.authenticate('x'.repeat(43)), { status: 401 });
  await assert.rejects(site.authenticate(`${session.token}x`), { status: 401 });
  await assert.rejects(site.authenticate(session.token, 'bad-csrf'), { status: 403 });
  await assert.rejects(makeSiteService({ ...settings, sessionSecret: 'a'.repeat(64) }).authenticate(session.token), { status: 401 });
  await assert.rejects(makeSiteService({ ...settings, passwordHash: hash.slice(0, -1) + (hash.endsWith('a') ? 'b' : 'a') }).authenticate(session.token), { status: 401 });
  time += SESSION_MS;
  await assert.rejects(site.authenticate(session.token), { status: 401 });
  await assert.rejects(makeSiteService({ ...settings, passwordHash: '' }).login(password, 'ip'), { status: 503 });
});

test('logout revokes a copied cookie; new login rotates the previous session', async () => {
  const { site } = setup();
  const first = await site.login(password, 'ip');
  const second = await site.login(password, 'ip', first.token);
  await assert.rejects(site.authenticate(first.token), { status: 401 });
  await assert.rejects(site.logout(second.token, ''), { status: 403 });
  await site.logout(second.token, second.csrf);
  await assert.rejects(site.authenticate(second.token), { status: 401 });
});

test('login limit survives new service instances and concurrent attempts; global limit bounds rotating IPs', async () => {
  let time = 1800000000000;
  const { site, settings, store } = setup({ now: () => time });
  for (let index = 0; index < 8; index += 1) await assert.rejects(makeSiteService(settings).login(null, 'same-ip'), { status: 401 });
  await assert.rejects(site.login(password, 'same-ip'), { status: 429, code: 'rate_limit', retryAfter: 900 });
  for (let index = 0; index < 32; index += 1) await assert.rejects(site.login(null, `rotating-${index}`), { status: 401 });
  await assert.rejects(site.login(password, 'different-ip'), { status: 429 });
  const serialized = JSON.stringify(store.rows.get(SECURITY_KEY));
  assert.equal(serialized.includes('same-ip'), false);
  time += WINDOW_MS;
  const parallel = await Promise.allSettled(Array.from({ length: 16 }, () => makeSiteService(settings).login(null, 'parallel-ip')));
  assert.equal(parallel.every(result => result.status === 'rejected'), true);
  assert.ok(parallel.filter(result => result.reason.status === 401).length <= 8);
  assert.equal(store.rows.get(SECURITY_KEY).value.global.count <= 8, true);
  const valid = await site.login(password, 'valid-ip');
  assert.ok(valid.token);
});

test('edits survive restarts: ordering, images, visibility, links, new windows, and empty list', async () => {
  const { site, settings } = setup();
  const session = await site.login(password, 'ip');
  const data = await site.read();
  assert.equal(data.items.length, defaults.items.length);
  data.items.reverse();
  Object.assign(data.items[0], { name: ' 自定义名称 ', image: 'https://example.com/icon.png', visible: false, newTab: true, color: 'purple', url: '/new-tool/' });
  data.items.push({ ...defaults.items[0], id: 'custom', name: '新增入口' });
  const saved = await site.save(session.token, session.csrf, data);
  assert.equal(saved.version, 1);
  assert.equal(saved.items[0].name, '自定义名称');
  assert.deepEqual(await makeSiteService(settings).read(), saved);
  saved.items = [];
  assert.deepEqual((await site.save(session.token, session.csrf, saved)).items, []);
});

test('authorization and concurrent edits prevent unauthorized writes or lost updates', async () => {
  const { site, store } = setup();
  const data = await site.read();
  await assert.rejects(site.save(null, '', data), { status: 401 });
  const session = await site.login(password, 'ip');
  await assert.rejects(site.save(session.token, '', data), { status: 403 });
  assert.equal(store.rows.has(CONFIG_KEY), false);
  const results = await Promise.allSettled([site.save(session.token, session.csrf, data), site.save(session.token, session.csrf, data)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.status, 409);
  await assert.rejects(site.save(session.token, session.csrf, data), { status: 409 });
});

test('validation rejects script URLs, credentials, invalid images, duplicate IDs and oversized values', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,test', '//evil.example', '/\\evil.example', '/\nevil', 'https://user:pass@example.com', 'file:///tmp/a']) {
    const data = structuredClone(defaults); data.items[0].url = url;
    assert.throws(() => validateConfig(data), { status: 400 });
  }
  for (const change of [
    data => { data.items[0].image = 'http://example.com/a.png'; },
    data => { data.items[0].image = 'data:image/svg+xml,test'; },
    data => { data.items[1].id = data.items[0].id; },
    data => { data.items[0].id = 'a" onclick="evil'; },
    data => { data.items[0].name = ''; },
    data => { data.items[0].description = '中'.repeat(201); },
    data => { data.items[0].visible = 'true'; },
    data => { data.items[0].color = 'red;evil'; },
    data => { data.items[0].icon = '123456789'; },
    data => { data.title = ''; },
    data => { data.items = null; },
  ]) {
    const data = structuredClone(defaults); change(data);
    assert.throws(() => validateConfig(data), { status: 400 });
  }
  const supported = { ...defaults, items: Array.from({ length: MAX_ITEMS }, (_, i) => ({ ...defaults.items[0], id: `entry-${i}`, name: '中'.repeat(40), description: '中'.repeat(200), url: '/'+ 'a'.repeat(2047), image: '/'+ 'b'.repeat(2047) })) };
  assert.equal(validateConfig(supported).items.length, MAX_ITEMS);
  const { jsonBody } = require('../lib/siteHttp');
  // The supported maximum fits the request bound, including UTF-8 text.
  assert.deepEqual(jsonBody({ headers: { 'content-type': 'application/json' }, body: supported }), supported);
  supported.items.push({ ...defaults.items[0], id: 'extra' });
  assert.throws(() => validateConfig(supported), { status: 400 });
});

test('HTTP APIs enforce CSRF, origin, host, secure cookies, logout and hidden item privacy', async () => {
  const realStore = require('../lib/gridStore');
  const originals = { read: realStore.read, write: realStore.write, isConflict: realStore.isConflict };
  const oldEnv = { hash: process.env.SITE_ADMIN_PASSWORD_HASH, secret: process.env.SITE_SESSION_SECRET };
  const fakeStore = memoryStore();
  Object.assign(realStore, fakeStore);
  process.env.SITE_ADMIN_PASSWORD_HASH = hash;
  process.env.SITE_SESSION_SECRET = secret;
  const auth = require('../api/site/auth');
  const config = require('../api/site/config');
  async function request(handler, method, body, headers = {}, query = {}) {
    const result = { headers: {} };
    const res = { setHeader(key, value) { result.headers[key] = value; }, end(value) { result.status = this.statusCode; result.body = JSON.parse(value); } };
    await handler({ method, body, query, headers: { host: '1.688680.xyz', origin: 'https://1.688680.xyz', 'content-type': 'application/json', ...headers } }, res);
    return result;
  }
  try {
    assert.deepEqual((await request(auth, 'GET')).body, { authenticated: false });
    assert.equal((await request(config, 'GET')).body.items.length, defaults.items.length);
    assert.equal((await request(config, 'GET', null, {}, { admin: '1' })).status, 401);
    assert.equal((await request(config, 'PUT', defaults)).status, 401);
    for (const headers of [{ origin: '' }, { origin: 'https://b.688680.xyz' }, { origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }, { host: 'b.688680.xyz', origin: 'https://b.688680.xyz' }]) assert.equal((await request(auth, 'POST', { password }, headers)).status, 403);
    assert.equal((await request(auth, 'POST', { password }, { 'content-type': 'text/plain' })).status, 415);
    assert.equal((await request(auth, 'POST', '{bad json')).status, 400);
    assert.equal((await request(auth, 'POST', { password }, { 'content-length': '400000' })).status, 413);
    const login = await request(auth, 'POST', { password });
    assert.equal(login.status, 200);
    assert.match(login.headers['Set-Cookie'], /^__Host-tools_admin=/);
    assert.match(login.headers['Set-Cookie'], /Path=\/; HttpOnly; SameSite=Strict; Max-Age=14400; Secure$/);
    assert.equal(login.headers['Cache-Control'], 'private, no-store');
    assert.equal('token' in login.body, false);
    const cookie = login.headers['Set-Cookie'].split(';')[0];
    const headers = { cookie, 'x-csrf-token': login.body.csrf };
    assert.equal((await request(auth, 'GET', null, headers)).body.authenticated, true);
    assert.equal((await request(config, 'PUT', defaults, { cookie })).status, 403);
    const data = (await request(config, 'GET', null, headers, { admin: '1' })).body;
    data.items[0].visible = false;
    assert.equal((await request(config, 'PUT', data, headers)).status, 200);
    assert.equal((await request(config, 'GET')).body.items.length, defaults.items.length - 1);
    assert.equal((await request(config, 'GET', null, headers, { admin: '1' })).body.items.length, defaults.items.length);
    assert.equal((await request(config, 'PUT', { ...data, version: 1 }, { ...headers, origin: 'https://b.688680.xyz' })).status, 403);
    assert.equal((await request(config, 'PATCH')).status, 405);
    const logout = await request(auth, 'DELETE', null, headers);
    assert.equal(logout.status, 200);
    assert.match(logout.headers['Set-Cookie'], /Max-Age=0/);
    assert.equal((await request(config, 'PUT', data, headers)).status, 401);
    assert.equal((await request(auth, 'GET', null, headers)).body.authenticated, false);
  } finally {
    Object.assign(realStore, originals);
    delete realStore.rows;
    if (oldEnv.hash === undefined) delete process.env.SITE_ADMIN_PASSWORD_HASH; else process.env.SITE_ADMIN_PASSWORD_HASH = oldEnv.hash;
    if (oldEnv.secret === undefined) delete process.env.SITE_SESSION_SECRET; else process.env.SITE_SESSION_SECRET = oldEnv.secret;
  }
});
