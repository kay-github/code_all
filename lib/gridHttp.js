const { GridError, makeGridService, SESSION_MS } = require('./gridService');
const store = require('./gridStore');

const COOKIE_NAME = 'grid_session';

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(body));
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  const host = req.headers.host;
  try {
    const parsed = new URL(origin);
    const local = /^localhost(?::\d+)?$|^127\.0\.0\.1(?::\d+)?$/.test(host);
    if (parsed.host !== host || (parsed.protocol !== 'https:' && !local)) throw new Error();
  } catch {
    throw new GridError(403, 'origin', '请求来源无效');
  }
}

function jsonBody(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) {
    throw new GridError(415, 'content_type', '请使用 JSON 请求');
  }
  try {
    return typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    throw new GridError(400, 'json', '请求内容不是合法 JSON');
  }
}

function sessionToken(req) {
  const raw = req.headers.cookie || '';
  const item = raw.split(';').map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE_NAME}=`));
  return item ? item.slice(COOKIE_NAME.length + 1) : null;
}

function setSession(res, token, req) {
  const local = /^localhost(?::\d+)?$|^127\.0\.0\.1(?::\d+)?$/.test(req.headers.host || '');
  const maxAge = token ? Math.floor(SESSION_MS / 1000) : 0;
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token || ''}; Path=/api/grid; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${local ? '' : '; Secure'}`);
}

function service() {
  return makeGridService({ store, secret: process.env.GRID_SESSION_SECRET });
}

function handleError(res, error) {
  if (error instanceof GridError) {
    const body = { error: error.message, code: error.code };
    if (Object.hasOwn(error, 'remoteRev')) body.remoteRev = error.remoteRev;
    return sendJson(res, error.status, body);
  }
  // Never log request bodies, credentials, cookies, account names, or payloads.
  console.error('[grid] request failed:', error?.name || 'Error');
  return sendJson(res, 503, { error: '云服务暂时不可用，请稍后重试', code: 'unavailable' });
}

module.exports = { sendJson, sameOrigin, jsonBody, sessionToken, setSession, service, handleError };
