const {
  sendJson, sameOrigin, jsonBody, sessionToken, setSession, service, handleError,
} = require('../../lib/gridHttp');
const { GridError } = require('../../lib/gridService');

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      return sendJson(res, 200, { user: await service().me(sessionToken(req)) });
    }
    if (req.method !== 'POST') throw new GridError(405, 'method', '不支持的请求方法');
    sameOrigin(req);
    const input = jsonBody(req);
    if (input?.action === 'logout') {
      setSession(res, null, req);
      return sendJson(res, 200, { ok: true });
    }
    const grid = service();
    let result;
    if (input?.action === 'register') result = await grid.register(input);
    else if (input?.action === 'login') result = await grid.login(input);
    else if (input?.action === 'reset') result = await grid.resetPassword(input);
    else throw new GridError(400, 'action', '操作无效');
    setSession(res, result.token, req);
    const body = { user: result.user };
    if (result.recoveryCode) body.recoveryCode = result.recoveryCode;
    return sendJson(res, 200, body);
  } catch (error) {
    return handleError(res, error);
  }
};
