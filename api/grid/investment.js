const { GridError, makeGridService } = require('../../lib/gridService');
const { handleError, sendJson, sameOrigin, jsonBody, sessionToken } = require('../../lib/gridHttp');
const store = require('../../lib/gridStore');

module.exports = async function handler(req, res) {
  try {
    const { validateState } = await import('../../tools/investment-theory/model.mjs');
    const service = makeGridService({
      store, secret: process.env.GRID_SESSION_SECRET, validateState,
      statePathFor: userId => `investment/v1/states/${userId}.json`,
    });
    const token = sessionToken(req);
    if (req.method === 'GET') return sendJson(res, 200, await service.pull(token));
    if (req.method === 'PUT') {
      sameOrigin(req);
      return sendJson(res, 200, await service.push(token, jsonBody(req)));
    }
    throw new GridError(405, 'method', '不支持的请求方法');
  } catch (error) {
    return handleError(res, error);
  }
};
