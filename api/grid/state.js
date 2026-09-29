const {
  sendJson, sameOrigin, jsonBody, sessionToken, service, handleError,
} = require('../../lib/gridHttp');
const { GridError } = require('../../lib/gridService');

module.exports = async function handler(req, res) {
  try {
    const grid = service();
    const token = sessionToken(req);
    if (req.method === 'GET') return sendJson(res, 200, await grid.pull(token));
    if (req.method === 'PUT') {
      sameOrigin(req);
      return sendJson(res, 200, await grid.push(token, jsonBody(req)));
    }
    if (req.method === 'DELETE') {
      sameOrigin(req);
      await grid.deleteState(token);
      return sendJson(res, 200, { ok: true });
    }
    throw new GridError(405, 'method', '不支持的请求方法');
  } catch (error) {
    return handleError(res, error);
  }
};
