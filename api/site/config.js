const { SiteError } = require('../../lib/siteService');
const { token, adminHost, sameOrigin, jsonBody, sendJson, handleError, service } = require('../../lib/siteHttp');

function isPublicEntry(item) {
  if (!item.visible || item.id === 'proofreader' || item.id === 'shooter') return false;
  const url = new URL(item.url, 'https://1.688680.xyz');
  return url.hostname !== '1.688680.xyz' ||
    !/^\/(?:tools\/typo-proofreader(?:\/.*)?|cbz\/?|shooter(?:\.html)?\/?)$/i.test(url.pathname);
}

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
      return sendJson(res, 200, { ...config, items: config.items.filter(isPublicEntry) });
    }
    if (req.method !== 'PUT') {
      res.setHeader('Allow', 'GET, PUT');
      throw new SiteError(405, 'method', '不支持的请求方法');
    }
    sameOrigin(req);
    return sendJson(res, 200, await site.save(token(req), req.headers['x-csrf-token'], jsonBody(req)));
  } catch (error) { return handleError(res, error); }
};
