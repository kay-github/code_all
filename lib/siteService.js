const { randomBytes, createHash, createHmac, scrypt, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');
const defaults = require('../assets/site-defaults');
const deriveKey = promisify(scrypt);
const CONFIG_KEY = 'tool-site/config.json';
const SECURITY_KEY = 'tool-site/security.json';
const SESSION_MS = 4 * 60 * 60 * 1000;
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ITEMS = 50;
const COLORS = ['blue', 'orange', 'green', 'purple', 'slate'];

class SiteError extends Error {
  constructor(status, code, message, retryAfter) {
    super(message);
    Object.assign(this, { status, code, retryAfter });
  }
}

function text(value, label, max, required = false) {
  if (typeof value !== 'string' || value.trim().length > max || (required && !value.trim())) {
    throw new SiteError(400, 'validation', `${label}${required ? '不能为空，且' : ''}最多 ${max} 个字符`);
  }
  return value.trim();
}

function safeUrl(value, image = false) {
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x20\x7f\\]/.test(value)) return false;
  // Root-relative paths only; protocol-relative URLs and embedded credentials are forbidden.
  if (value.startsWith('/') && !value.startsWith('//')) return true;
  try {
    const url = new URL(value);
    return (image ? url.protocol === 'https:' : ['https:', 'http:'].includes(url.protocol)) && !url.username && !url.password;
  } catch { return false; }
}

function validateConfig(input) {
  const title = text(input?.title, '网站名称', 60, true);
  const subtitle = text(input?.subtitle, '网站简介', 160);
  if (!Array.isArray(input?.items) || input.items.length > MAX_ITEMS) throw new SiteError(400, 'validation', `最多可添加 ${MAX_ITEMS} 个入口`);
  const ids = new Set();
  const items = input.items.map(item => {
    if (!item || typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(item.id) || ids.has(item.id)) throw new SiteError(400, 'validation', '入口标识无效或重复');
    ids.add(item.id);
    const name = text(item.name, '入口名称', 40, true);
    const description = text(item.description, '入口描述', 200);
    const icon = text(item.icon, '文字图标', 8, true);
    const url = text(item.url, '入口地址', 2048, true);
    const image = text(item.image, '图片地址', 2048);
    if (!safeUrl(url)) throw new SiteError(400, 'validation', `${name}：地址须为 / 开头的站内路径或完整的 http(s) 链接`);
    if (image && !safeUrl(image, true)) throw new SiteError(400, 'validation', `${name}：图片须为站内路径或完整的 https 链接`);
    if (!COLORS.includes(item.color) || typeof item.visible !== 'boolean' || typeof item.newTab !== 'boolean') throw new SiteError(400, 'validation', '入口显示设置无效');
    return { id: item.id, name, description, url, icon, image, color: item.color, visible: item.visible, newTab: item.newTab };
  });
  return { title, subtitle, items };
}

function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function makeSiteService({ store, passwordHash, sessionSecret, now = Date.now }) {
  function requireSecrets() {
    if (!/^scrypt:32768:[a-f0-9]{32}:[a-f0-9]{64}$/.test(passwordHash || '') || typeof sessionSecret !== 'string' || sessionSecret.length < 32) throw new SiteError(503, 'unavailable', '后台暂时不可用，请稍后重试');
  }
  const digest = value => createHash('sha256').update(value).digest('hex');
  const fingerprint = value => createHmac('sha256', sessionSecret).update(value).digest('hex');
  function prune(state) {
    state.sessions = (state.sessions || []).filter(session => session.expires > now());
    state.attempts = Object.fromEntries(Object.entries(state.attempts || {}).filter(([, entry]) => entry.until > now()));
    if (!state.global || state.global.until <= now()) state.global = { count: 0, until: now() + WINDOW_MS };
    return state;
  }
  // CAS retries make limits and revocation shared across cold starts and concurrent instances.
  async function updateSecurity(change) {
    requireSecrets();
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const row = await store.read(SECURITY_KEY);
      const state = prune(row ? structuredClone(row.value) : {});
      const result = change(state);
      try {
        await store.write(SECURITY_KEY, state, row?.etag ?? null);
        return result;
      } catch (error) {
        if (!store.isConflict(error)) throw error;
      }
    }
    throw new SiteError(429, 'busy', '请求较多，请稍后重试', 3);
  }
  async function login(password, ip, previousToken) {
    requireSecrets();
    const ipKey = fingerprint(`ip:${ip}`);
    await updateSecurity(state => {
      const entry = state.attempts[ipKey] || { count: 0, until: now() + WINDOW_MS };
      const blocked = entry.count >= 8 ? entry : state.global.count >= 40 ? state.global : null;
      if (blocked) throw new SiteError(429, 'rate_limit', '尝试次数过多，请 15 分钟后再试', Math.max(1, Math.ceil((blocked.until - now()) / 1000)));
      entry.count += 1;
      state.global.count += 1;
      state.attempts[ipKey] = entry;
    });
    if (typeof password !== 'string' || !password.length || password.length > 128) throw new SiteError(401, 'credentials', '密码不正确');
    const [, , salt, expected] = passwordHash.split(':');
    const actual = await deriveKey(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    if (!equal(actual.toString('hex'), expected)) throw new SiteError(401, 'credentials', '密码不正确');
    const token = randomBytes(32).toString('base64url');
    const session = { hash: digest(token), csrf: randomBytes(32).toString('base64url'), expires: now() + SESSION_MS, credential: fingerprint(passwordHash) };
    await updateSecurity(state => {
      delete state.attempts[ipKey];
      state.sessions = state.sessions.filter(entry => !previousToken || entry.hash !== digest(previousToken)).slice(-9);
      state.sessions.push(session);
    });
    return { token, csrf: session.csrf, expires: session.expires };
  }
  async function authenticate(token, csrf) {
    requireSecrets();
    if (typeof token !== 'string' || !/^[a-zA-Z0-9_-]{43}$/.test(token)) throw new SiteError(401, 'unauthenticated', '登录已过期，请重新输入密码');
    const row = await store.read(SECURITY_KEY);
    const session = row?.value.sessions?.find(entry => equal(entry.hash, digest(token)) && entry.expires > now() && equal(entry.credential, fingerprint(passwordHash)));
    if (!session) throw new SiteError(401, 'unauthenticated', '登录已过期，请重新输入密码');
    if (csrf !== undefined && !equal(csrf, session.csrf)) throw new SiteError(403, 'csrf', '请求验证失败，请刷新页面后重试');
    return { csrf: session.csrf, expires: session.expires };
  }
  async function logout(token, csrf) {
    await authenticate(token, csrf || '');
    await updateSecurity(state => { state.sessions = state.sessions.filter(entry => !equal(entry.hash, digest(token))); });
  }
  async function read() {
    const row = await store.read(CONFIG_KEY);
    return row ? { ...validateConfig(row.value), version: row.value.version, updatedAt: row.value.updatedAt } : { ...structuredClone(defaults), version: 0, updatedAt: null };
  }
  async function save(token, csrf, input) {
    await authenticate(token, csrf || '');
    const config = validateConfig(input);
    if (!Number.isSafeInteger(input.version) || input.version < 0) throw new SiteError(400, 'version', '配置版本无效，请重新加载');
    const row = await store.read(CONFIG_KEY);
    if ((row?.value.version ?? 0) !== input.version) throw new SiteError(409, 'conflict', '其他页面已更新配置，请先重新加载后再编辑');
    const value = { ...config, version: input.version + 1, updatedAt: new Date(now()).toISOString() };
    try { await store.write(CONFIG_KEY, value, row?.etag ?? null); }
    catch (error) {
      if (store.isConflict(error)) throw new SiteError(409, 'conflict', '其他页面已更新配置，请先重新加载后再编辑');
      throw error;
    }
    return value;
  }
  return { login, authenticate, logout, read, save };
}
module.exports = { makeSiteService, SiteError, validateConfig, safeUrl, CONFIG_KEY, SECURITY_KEY, SESSION_MS, WINDOW_MS, MAX_ITEMS };
