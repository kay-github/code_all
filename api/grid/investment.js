const { GridError, makeGridService } = require('../../lib/gridService');
const { handleError, sendJson, sameOrigin, jsonBody, sessionToken } = require('../../lib/gridHttp');
const { CONFIG, goalAlertsForAccount } = require('../../lib/investmentAlerts');
const store = require('../../lib/gridStore');

module.exports = async function handler(req, res) {
  try {
    const { validateState } = await import('../../tools/investment-theory/model.mjs');
    const expectedUser = req.headers['x-investment-account'];
    const checkAccount = userId => {
      if (expectedUser !== undefined && expectedUser !== userId) {
        throw new GridError(401, 'account_changed', '登录账号已切换，请重新登录');
      }
    };
    const service = makeGridService({
      store, secret: process.env.GRID_SESSION_SECRET, validateState,
      statePathFor: userId => {
        checkAccount(userId);
        return `investment/v1/states/${userId}.json`;
      },
    });
    const token = sessionToken(req);
    if (req.method === 'GET' && req.query?.view === 'reminders') {
      const { id } = await service.me(token);
      checkAccount(id);
      const config = (await store.read(CONFIG))?.value;
      return sendJson(res, 200, { rules: goalAlertsForAccount(config, id) });
    }
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
