const {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} = require('node:crypto');
const { promisify } = require('node:util');

const deriveKey = promisify(scrypt);
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;
const MAX_STATE_BYTES = 2 * 1024 * 1024;
const USERNAME_RE = /^[a-z0-9_]{3,32}$/;

class GridError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.status = status;
    this.code = code;
    Object.assign(this, details);
  }
}

function usernameOf(value) {
  const username = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!USERNAME_RE.test(username)) {
    throw new GridError(400, 'username', '账号名须为 3–32 位英文字母、数字或下划线');
  }
  return username;
}

function passwordOf(value) {
  if (typeof value !== 'string' || value.length < 10 || value.length > 128) {
    throw new GridError(400, 'password', '密码须为 10–128 位');
  }
  return value;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function userPath(username) {
  return `grid/v1/users/${sha256(username)}.json`;
}

function statePath(userId) {
  return `grid/v1/states/${userId}.json`;
}

async function passwordHash(password, salt) {
  const key = await deriveKey(password, Buffer.from(salt, 'base64url'), 64, {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 32 * 1024 * 1024,
  });
  return key.toString('base64url');
}

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function publicUser(user) {
  return { id: user.id, username: user.username };
}

function makeGridService({ store, secret, now = Date.now }) {
  if (!store || typeof store.read !== 'function' || typeof store.write !== 'function') {
    throw new Error('Grid store is missing');
  }
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new GridError(503, 'configuration', '云备份暂未配置');
  }

  function signSession(user) {
    const payload = Buffer.from(JSON.stringify({
      id: user.id,
      username: user.username,
      version: user.sessionVersion,
      expires: now() + SESSION_MS,
    })).toString('base64url');
    const signature = createHmac('sha256', secret).update(payload).digest('base64url');
    return `${payload}.${signature}`;
  }

  function parseSession(token) {
    if (typeof token !== 'string' || token.length > 2048) return null;
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const expected = createHmac('sha256', secret).update(parts[0]).digest('base64url');
    if (!safeEqual(parts[1], expected)) return null;
    try {
      const parsed = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      if (typeof parsed.id !== 'string' || typeof parsed.username !== 'string'
        || typeof parsed.version !== 'string' || !Number.isFinite(parsed.expires)
        || parsed.expires <= now()) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  async function authenticate(token) {
    const session = parseSession(token);
    if (!session || !USERNAME_RE.test(session.username)) {
      throw new GridError(401, 'unauthenticated', '请先登录');
    }
    const row = await store.read(userPath(session.username));
    const user = row?.value;
    if (!user || user.id !== session.id || user.sessionVersion !== session.version) {
      throw new GridError(401, 'unauthenticated', '登录已失效，请重新登录');
    }
    return user;
  }

  async function register(input) {
    const username = usernameOf(input?.username);
    const password = passwordOf(input?.password);
    const path = userPath(username);
    if (await store.read(path)) throw new GridError(409, 'username_taken', '账号名已被使用');

    const recoveryCode = randomBytes(24).toString('base64url');
    const salt = randomBytes(16).toString('base64url');
    const user = {
      id: randomUUID(),
      username,
      salt,
      passwordHash: await passwordHash(password, salt),
      recoveryHash: sha256(recoveryCode),
      sessionVersion: randomUUID(),
      failedLogins: 0,
      lockedUntil: 0,
      createdAt: new Date(now()).toISOString(),
    };
    try {
      await store.write(path, user);
    } catch (error) {
      // A concurrent request may have registered the same name after our read.
      if (await store.read(path)) throw new GridError(409, 'username_taken', '账号名已被使用');
      throw error;
    }
    return { user: publicUser(user), token: signSession(user), recoveryCode };
  }

  async function login(input) {
    const username = usernameOf(input?.username);
    const password = typeof input?.password === 'string' ? input.password : '';
    const path = userPath(username);
    const row = await store.read(path);
    if (!row) {
      // Keep nonexistent accounts from having a much faster response.
      await passwordHash(password, 'AAAAAAAAAAAAAAAAAAAAAA');
      throw new GridError(401, 'credentials', '账号名或密码不正确');
    }
    const user = row.value;
    if (user.lockedUntil > now()) {
      throw new GridError(429, 'locked', '尝试次数过多，请 15 分钟后重试');
    }
    const actual = await passwordHash(password, user.salt);
    if (!safeEqual(actual, user.passwordHash)) {
      const failedLogins = (user.lockedUntil && user.lockedUntil <= now() ? 0 : user.failedLogins || 0) + 1;
      const next = {
        ...user,
        failedLogins,
        lockedUntil: failedLogins >= 8 ? now() + LOCK_MS : 0,
      };
      try { await store.write(path, next, row.etag); } catch { /* next attempt checks the latest state */ }
      throw new GridError(401, 'credentials', '账号名或密码不正确');
    }
    if (user.failedLogins || user.lockedUntil) {
      try { await store.write(path, { ...user, failedLogins: 0, lockedUntil: 0 }, row.etag); }
      catch { /* a correct password still authenticates; next request rechecks the account */ }
    }
    return { user: publicUser(user), token: signSession(user) };
  }

  async function resetPassword(input) {
    const username = usernameOf(input?.username);
    const password = passwordOf(input?.password);
    const recoveryCode = typeof input?.recoveryCode === 'string' ? input.recoveryCode.trim() : '';
    const path = userPath(username);
    const row = await store.read(path);
    if (!row || !safeEqual(sha256(recoveryCode), row.value.recoveryHash)) {
      throw new GridError(401, 'recovery', '账号名或恢复码不正确');
    }
    const newRecoveryCode = randomBytes(24).toString('base64url');
    const salt = randomBytes(16).toString('base64url');
    const user = {
      ...row.value,
      salt,
      passwordHash: await passwordHash(password, salt),
      recoveryHash: sha256(newRecoveryCode),
      sessionVersion: randomUUID(),
      failedLogins: 0,
      lockedUntil: 0,
    };
    try {
      await store.write(path, user, row.etag);
    } catch (error) {
      if (store.isConflict?.(error)) throw new GridError(409, 'conflict', '账号刚被修改，请重试');
      throw error;
    }
    return { user: publicUser(user), token: signSession(user), recoveryCode: newRecoveryCode };
  }

  async function me(token) {
    return publicUser(await authenticate(token));
  }

  async function pull(token) {
    const user = await authenticate(token);
    const row = await store.read(statePath(user.id));
    if (!row) return { kind: 'empty' };
    const { rev, payload, updatedAt } = row.value;
    return { kind: 'ok', rev, data: payload, updatedAt };
  }

  function checkedPayload(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)
      || data.version !== 1 || !Array.isArray(data.varieties)
      || data.varieties.length > 1000) {
      throw new GridError(400, 'data', '数据结构不符合当前版本');
    }
    if (Buffer.byteLength(JSON.stringify(data)) > MAX_STATE_BYTES) {
      throw new GridError(413, 'too_large', '云备份超过 2 MB，请先导出并精简数据');
    }
    return data;
  }

  async function push(token, input) {
    const user = await authenticate(token);
    const data = checkedPayload(input?.data);
    const baseRev = input?.baseRev;
    if (baseRev !== null && (!Number.isSafeInteger(baseRev) || baseRev < 1)) {
      throw new GridError(400, 'revision', '版本号无效');
    }
    const pathname = statePath(user.id);
    const row = await store.read(pathname);
    const remoteRev = row?.value?.rev ?? null;
    if (remoteRev !== baseRev) {
      throw new GridError(409, 'conflict', '云端数据已更新', { remoteRev });
    }
    const nextRev = remoteRev === null ? 1 : remoteRev + 1;
    const next = {
      rev: nextRev,
      payload: data,
      clientId: typeof input.clientId === 'string' ? input.clientId.slice(0, 64) : '',
      updatedAt: new Date(now()).toISOString(),
    };
    try {
      await store.write(pathname, next, row?.etag ?? null);
    } catch (error) {
      const latest = await store.read(pathname);
      if (store.isConflict?.(error) || latest?.value?.rev !== remoteRev) {
        throw new GridError(409, 'conflict', '云端数据已更新', { remoteRev: latest?.value?.rev ?? null });
      }
      throw error;
    }
    return { rev: nextRev };
  }

  async function deleteState(token) {
    const user = await authenticate(token);
    const pathname = statePath(user.id);
    const row = await store.read(pathname);
    if (!row) return;
    try {
      await store.remove(pathname, row.etag);
    } catch (error) {
      if (store.isConflict?.(error)) throw new GridError(409, 'conflict', '云端数据刚被修改，请重试');
      throw error;
    }
  }

  return { register, login, resetPassword, me, pull, push, deleteState };
}

module.exports = { GridError, makeGridService, SESSION_MS };
