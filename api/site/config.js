const { SiteError } = require('../../lib/siteService');
const { token, adminHost, sameOrigin, jsonBody, sendJson, handleError, service } = require('../../lib/siteHttp');

module.exports = async function handler(req, res) {
  try {
    const site = service();
    if (req.method === 'GET') {
      if (req.query?.admin === '1') {
        adminHost(req);
        await site.authenticate(token(req));
        return sendJson(res, 200, await site.read());
      }
      const config = await site.read();
      return sendJson(res, 200, { ...config, items: config.items.filter(item => item.visible) });
    }
    if (req.method !== 'PUT') {
      res.setHeader('Allow', 'GET, PUT');
      throw new SiteError(405, 'method', '不支持的请求方法');
    }
    sameOrigin(req);
    return sendJson(res, 200, await site.save(token(req), req.headers['x-csrf-token'], jsonBody(req)));
  } catch (error) { return handleError(res, error); }
};
