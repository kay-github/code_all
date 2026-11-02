const images = require('../../lib/siteImages');
const { SiteError } = require('../../lib/siteService');
const { token, sameOrigin, jsonBody, sendJson, handleError, service } = require('../../lib/siteHttp');

module.exports = async function handler(req, res) {
  try {
    if (['GET', 'HEAD'].includes(req.method)) {
      // Only a fixed icon namespace is readable; private accounts/configuration cannot be requested.
      const buffer = await images.read(req.query?.id);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'image/webp');
      res.setHeader('Content-Length', buffer.length);
      res.setHeader('Cache-Control', 'public, max-age=31536000, s-maxage=31536000, immutable');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
      return res.end(req.method === 'HEAD' ? undefined : buffer);
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, HEAD, POST');
      throw new SiteError(405, 'method', '不支持的请求方法');
    }
    sameOrigin(req);
    await service().authenticate(token(req), req.headers['x-csrf-token'] || '');
    return sendJson(res, 201, await images.upload(jsonBody(req, 3_000_000).data));
  } catch (error) { return handleError(res, error); }
};
