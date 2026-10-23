const { PortalError } = require('../../lib/portalService');
const { sendJson, sameOrigin, jsonBody, sessionToken, service, handleError } = require('../../lib/portalHttp');

module.exports = async function handler(req, res) {
  try {
    const portal = service();
    if (req.method === 'GET') return sendJson(res, 200, await portal.read());
    if (req.method !== 'PUT') throw new PortalError(405, 'method', '不支持的请求方法');
    sameOrigin(req);
    if (!portal.authenticated(sessionToken(req))) throw new PortalError(401, 'unauthenticated', '请先输入授权密码');
    return sendJson(res, 200, await portal.save(sessionToken(req), jsonBody(req)));
  } catch (error) {
    return handleError(res, error);
  }
};
