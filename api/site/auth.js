const { SiteError } = require('../../lib/siteService');
const { token, setSession, adminHost, sameOrigin, jsonBody, sendJson, handleError, service } = require('../../lib/siteHttp');

module.exports = async function handler(req, res) {
  try {
    adminHost(req);
    const site = service();
    if (req.method === 'GET') {
      if (!token(req)) return sendJson(res, 200, { authenticated: false });
      try { return sendJson(res, 200, { authenticated: true, ...await site.authenticate(token(req)) }); }
      catch (error) {
        if (error.code !== 'unauthenticated') throw error;
        setSession(req, res, null);
        return sendJson(res, 200, { authenticated: false });
      }
    }
    if (!['POST', 'DELETE'].includes(req.method)) {
      res.setHeader('Allow', 'GET, POST, DELETE');
      throw new SiteError(405, 'method', '不支持的请求方法');
    }
    sameOrigin(req);
    if (req.method === 'DELETE') {
      await site.logout(token(req), req.headers['x-csrf-token']);
      setSession(req, res, null);
      return sendJson(res, 200, { ok: true });
    }
    const body = jsonBody(req);
    // Vercel overwrites x-forwarded-for at its edge; never accept a client-supplied IP field.
    const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
    const session = await site.login(body.password, ip, token(req));
    setSession(req, res, session.token);
    return sendJson(res, 200, { authenticated: true, csrf: session.csrf, expires: session.expires });
  } catch (error) { return handleError(res, error); }
};
