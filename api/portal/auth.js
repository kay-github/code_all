const { PortalError } = require('../../lib/portalService');
const { sendJson, sameOrigin, jsonBody, sessionToken, setSession, service, handleError } = require('../../lib/portalHttp');

// A small per-instance throttle avoids repeated password guesses on a warm function.
const attempts = new Map();
const WINDOW_MS = 10 * 60 * 1000;
module.exports = async function handler(req, res) {
  try {
    const portal = service();
    if (req.method === 'GET') return sendJson(res, 200, { authenticated: portal.authenticated(sessionToken(req)) });
    if (!['POST', 'DELETE'].includes(req.method)) throw new PortalError(405, 'method', '不支持的请求方法');
    sameOrigin(req);
    if (req.method === 'DELETE') {
      setSession(res, null, req);
      return sendJson(res, 200, { ok: true });
    }
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
    const current = attempts.get(ip);
    const entry = current && current.until > Date.now() ? current : { failures: 0, until: Date.now() + WINDOW_MS };
    if (entry.failures >= 10) {
      res.setHeader('Retry-After', Math.ceil((entry.until - Date.now()) / 1000));
      throw new PortalError(429, 'rate_limit', '尝试次数过多，请稍后再试');
    }
    let token;
    try {
      token = portal.login(jsonBody(req).password);
    } catch (error) {
      if (error.code === 'credentials') {
        if (attempts.size > 1000) attempts.clear();
        entry.failures += 1;
        attempts.set(ip, entry);
      }
      throw error;
    }
    attempts.delete(ip);
    setSession(res, token, req);
    return sendJson(res, 200, { authenticated: true });
  } catch (error) {
    return handleError(res, error);
  }
};
