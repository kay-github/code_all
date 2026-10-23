const { makePortalService, PortalError, SESSION_MS } = require('./portalService');
const store = require('./gridStore');
const COOKIE_NAME = 'portal_admin';

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(body));
}
function sameOrigin(req) {
  try {
    const origin = new URL(req.headers.origin);
    const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '');
    if (origin.host !== req.headers.host || (origin.protocol !== 'https:' && !local)) throw new Error();
  } catch {
    throw new PortalError(403, 'origin', '请求来源无效，请刷新页面后重试');
  }
}
function jsonBody(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new PortalError(415, 'content_type', '请使用 JSON 请求');
  if (Number(req.headers['content-length']) > 64_000) throw new PortalError(413, 'too_large', '请求内容过大');
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || JSON.stringify(body).length > 20_000) throw new Error();
    return body;
  } catch {
    throw new PortalError(400, 'json', '请求内容无效');
  }
}
function sessionToken(req) {
  const part = (req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith(`${COOKIE_NAME}=`));
  return part ? part.slice(COOKIE_NAME.length + 1) : null;
}
function setSession(res, token, req) {
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '');
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token || ''}; Path=/api/portal; HttpOnly; SameSite=Strict; Max-Age=${token ? SESSION_MS / 1000 : 0}${local ? '' : '; Secure'}`);
}
function service() {
  return makePortalService({ store, passwordHash: process.env.PORTAL_ADMIN_PASSWORD_HASH?.trim(), sessionSecret: process.env.PORTAL_SESSION_SECRET?.trim() });
}
function handleError(res, error) {
  if (error instanceof PortalError) return sendJson(res, error.status, { error: error.message, code: error.code });
  console.error('[portal] request failed:', error?.name || 'Error');
  return sendJson(res, 503, { error: '服务暂时不可用，请稍后重试', code: 'unavailable' });
}
module.exports = { sendJson, sameOrigin, jsonBody, sessionToken, setSession, service, handleError };
