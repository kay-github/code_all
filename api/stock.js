const { cachedMarketData, rateLimit } = require('../lib/stockMarket');
module.exports = async function handler(req, res) {
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options','nosniff');
  if (req.method !== 'GET') { res.statusCode = 405; res.setHeader('Allow','GET'); return res.end(JSON.stringify({ error: '仅支持 GET 请求' })); }
  if (!rateLimit(String(req.headers?.['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0])) { res.statusCode = 429; res.setHeader('Retry-After','60'); return res.end(JSON.stringify({ error: '请求过于频繁，请稍后重试' })); }
  const q = req.query || Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
  try {
    const action = q.action || 'quote';
    const result = await cachedMarketData(action, { symbol: q.symbol, adjust: q.adjust, q: q.q, force: q.force === '1' });
    res.setHeader('Cache-Control', result.stale || q.force === '1' ? 'no-store' : `public, s-maxage=${action === 'history' ? 1200 : action === 'search' ? 3600 : 25}`);
    res.statusCode = 200; res.end(JSON.stringify(result));
  } catch (error) { res.statusCode = error.status || 502; res.setHeader('Cache-Control','no-store'); res.end(JSON.stringify({ error: error.status ? error.message : '行情数据暂不可用，请稍后重试或导入历史 CSV' })); }
};
module.exports.config = { maxDuration: 60 };
