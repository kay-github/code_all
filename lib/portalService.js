const { createHmac, randomBytes, scryptSync, timingSafeEqual } = require('node:crypto');

const STORE_KEY = 'work-portal/config.json';
const SESSION_MS = 8 * 60 * 60 * 1000;
const DEFAULT_ITEMS = [
  { id: 'overtime', name: '加班登记', url: 'https://f.wps.cn/g/A5hI2Xf5/', remark: '记录加班时间与工作事项' },
  { id: 'grievance', name: '委屈登记', url: 'https://rcnvsexb7hbh.feishu.cn/share/base/form/shrcnYrO20vTPU8RHdSG4m5iubf', remark: '说出工作中遇到的委屈' },
  { id: 'complaint', name: '投诉登记', url: 'https://rcnvsexb7hbh.feishu.cn/share/base/form/shrcnEDuwKmxBMkvYYQm77iwsFd', remark: '反馈问题，提交投诉事项' },
  { id: 'praise', name: '表扬登记', url: 'https://rcnvsexb7hbh.feishu.cn/share/base/form/shrcnltOf69UelZhe8ebJA3J3Sc', remark: '记录出色表现，传递认可' },
  { id: 'system', name: '登录系统', url: 'http://10.1.235.190:18082/houback/xlogin', remark: '连接单位内网后访问系统' },
  { id: 'inspection', name: '10月质检更改', url: 'https://f.wps.cn/g/Kp0hUkLQ/', remark: '提交10月质检更改事项' },
];

class PortalError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function validateItems(items) {
  if (!Array.isArray(items) || items.length !== DEFAULT_ITEMS.length) {
    throw new PortalError(400, 'items', '请保留全部六个功能入口');
  }
  return DEFAULT_ITEMS.map((original, index) => {
    const item = items[index];
    if (item?.id !== original.id) throw new PortalError(400, 'items', '功能入口不匹配，请刷新后重试');
    if (typeof item.name !== 'string' || !item.name.trim() || item.name.trim().length > 40) {
      throw new PortalError(400, 'name', '功能名称须为 1 至 40 个字符');
    }
    if (typeof item.remark !== 'string' || item.remark.trim().length > 160) {
      throw new PortalError(400, 'remark', '备注最多 160 个字符');
    }
    try {
      if (typeof item.url !== 'string' || item.url.length > 2048 || /[\x00-\x20\x7f]/.test(item.url.trim())) throw new Error();
      const url = new URL(item.url.trim());
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
    } catch {
      throw new PortalError(400, 'url', '请输入完整的 http:// 或 https:// 链接，且不能包含用户名和密码');
    }
    return { id: original.id, name: item.name.trim(), url: item.url.trim(), remark: item.remark.trim() };
  });
}

function makePortalService({ store, passwordHash, sessionSecret, now = Date.now }) {
  function requireSecrets() {
    if (!/^[a-f0-9]{32}:[a-f0-9]{64}$/.test(passwordHash || '') || typeof sessionSecret !== 'string' || sessionSecret.length < 32) {
      throw new PortalError(503, 'unavailable', '后台暂时不可用，请稍后重试');
    }
  }
  function signature(body) {
    return createHmac('sha256', sessionSecret).update(`work-portal:${body}`).digest('base64url');
  }
  function authenticated(token) {
    if (typeof token !== 'string' || token.length > 512) return false;
    requireSecrets();
    try {
      const parts = token.split('.');
      if (parts.length !== 2) return false;
      const expected = Buffer.from(signature(parts[0]));
      const supplied = Buffer.from(parts[1]);
      if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return false;
      const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      return Number.isSafeInteger(payload.exp) && payload.exp > now() && payload.exp <= now() + SESSION_MS;
    } catch {
      return false;
    }
  }
  function login(password) {
    requireSecrets();
    if (typeof password !== 'string' || password.length > 128) throw new PortalError(401, 'credentials', '授权密码不正确');
    const [salt, hash] = passwordHash.split(':');
    const actual = scryptSync(password.trim().toLowerCase(), salt, 32);
    if (!timingSafeEqual(actual, Buffer.from(hash, 'hex'))) throw new PortalError(401, 'credentials', '授权密码不正确');
    const body = Buffer.from(JSON.stringify({ exp: now() + SESSION_MS, nonce: randomBytes(16).toString('hex') })).toString('base64url');
    return `${body}.${signature(body)}`;
  }
  async function read() {
    const row = await store.read(STORE_KEY);
    return row ? { version: row.value.version, items: validateItems(row.value.items), updatedAt: row.value.updatedAt } : { version: 0, items: structuredClone(DEFAULT_ITEMS), updatedAt: null };
  }
  async function save(token, input) {
    if (!authenticated(token)) throw new PortalError(401, 'unauthenticated', '请先输入授权密码');
    const items = validateItems(input?.items);
    if (!Number.isSafeInteger(input?.version) || input.version < 0) throw new PortalError(400, 'version', '配置版本无效，请刷新后重试');
    const row = await store.read(STORE_KEY);
    if ((row?.value.version || 0) !== input.version) throw new PortalError(409, 'conflict', '配置已在其他页面更新，请重新加载后再保存');
    const value = { version: input.version + 1, items, updatedAt: new Date(now()).toISOString() };
    try {
      await store.write(STORE_KEY, value, row?.etag ?? null);
    } catch (error) {
      if (store.isConflict(error)) throw new PortalError(409, 'conflict', '配置已在其他页面更新，请重新加载后再保存');
      throw error;
    }
    return value;
  }
  return { login, authenticated, read, save };
}

module.exports = { DEFAULT_ITEMS, STORE_KEY, SESSION_MS, PortalError, makePortalService, validateItems };
