const { makeSiteService, SiteError, SESSION_MS } = require('./siteService');
const store = require('./gridStore');

function local(req) { return /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || ''); }
function cookieName(req) { return local(req) ? 'tools_admin_dev' : '__Host-tools_admin'; }
function token(req) {
  const entries = (req.headers.cookie || '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${cookieName(req)}=`));
  return entries.length === 1 ? entries[0].slice(cookieName(req).length + 1) : null;
}
function setSession(req, res, value) {
  res.setHeader('Set-Cookie', `${cookieName(req)}=${value || ''}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${value ? SESSION_MS / 1000 : 0}${local(req) ? '' : '; Secure'}`);
}
function adminHost(req) {
  if (req.headers.host !== '1.688680.xyz' && !local(req)) throw new SiteError(403, 'host', '请通过主站域名打开后台');
}
function sameOrigin(req) {
  adminHost(req);
  const expected = `${local(req) ? 'http' : 'https'}://${req.headers.host}`;
  if (req.headers.origin !== expected || (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')) throw new SiteError(403, 'origin', '请求来源无效，请刷新页面后重试');
}
function jsonBody(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new SiteError(415, 'content_type', '请使用 JSON 请求');
  if (Number(req.headers['content-length']) > 300_000) throw new SiteError(413, 'too_large', '请求内容过大');
  try {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : req.body;
    const body = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    if (Buffer.byteLength(JSON.stringify(body)) > 300_000) throw new SiteError(413, 'too_large', '请求内容过大');
    return body;
  } catch (error) {
    if (error instanceof SiteError) throw error;
    throw new SiteError(400, 'json', '请求内容无效');
  }
}
function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  res.end(JSON.stringify(body));
}
function handleError(res, error) {
  if (error instanceof SiteError) {
    if (error.retryAfter) res.setHeader('Retry-After', error.retryAfter);
    return sendJson(res, error.status, { error: error.message, code: error.code });
  }
  // Do not log passwords, cookies, CSRF tokens or storage contents.
  console.error('[site-admin] request failed:', error?.name || 'Error');
  return sendJson(res, 503, { error: '服务暂时不可用，请稍后重试', code: 'unavailable' });
}
function service() {
  return makeSiteService({ store, passwordHash: process.env.SITE_ADMIN_PASSWORD_HASH?.trim(), sessionSecret: process.env.SITE_SESSION_SECRET?.trim() });
}
module.exports = { token, setSession, adminHost, sameOrigin, jsonBody, sendJson, handleError, service };
