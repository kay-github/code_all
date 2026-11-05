const { numeric } = require('../lib/stockMarket');
const { sendJson } = require('../lib/gridHttp');

const FINANCE = 'https://finance.688680.xyz';
const cache = new Map();
const pending = new Map();
const labels = { market: '中证全指', szzs: '上证指数', cybz: '创业板指' };

async function cached(key, ttl, load) {
  const old = cache.get(key);
  if (old && Date.now() - old.at < ttl) return old.value;
  if (!pending.has(key)) {
    pending.set(key, load().then(value => {
      if (cache.size >= 100) cache.delete(cache.keys().next().value);
      cache.set(key, { value, at: Date.now() });
      return value;
    }).catch(error => {
      if (!old) throw error;
      return { ...old.value, stale: true };
    }).finally(() => pending.delete(key)));
  }
  return pending.get(key);
}

async function upstream(path) {
  const res = await fetch(FINANCE + path, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw Error('上游快照暂不可用');
  return res.json();
}

async function sentiment() {
  const results = await Promise.allSettled([
    cached('fear', 15 * 60_000, async () => {
      const data = await upstream('/api/fear-greed/overview');
      return { date: data.trade_date, model: data.model_version, items: data.targets
        .filter(row => Object.hasOwn(labels, row.key))
        .map(row => ({ name: labels[row.key], date: row.trade_date, score: numeric(row.score), zone: row.zone?.label })) };
    }),
    cached('crowding', 15 * 60_000, async () => {
      const data = await upstream('/api/market-structure/crowding?limit=6');
      return { date: data.target_trade_date, items: data.items.slice(0, 6).map(row => ({
        name: row.native_name || row.provider_name, date: row.trade_date, score: numeric(row.heat?.value), stale: row.stale === true,
      })) };
    }),
  ]);
  return { fear: results[0].value ?? null, crowding: results[1].value ?? null };
}

function parseQuote(fields) {
  const stamp = fields[30];
  const price = numeric(fields[3]);
  if (!(price > 0) || !/^\d{14}$/.test(stamp)) return null;
  return {
    name: fields[1], price, changePct: numeric(fields[32]), peTTM: numeric(fields[39]),
    marketCap: numeric(fields[45]), suspended: fields[0] === 'S' || numeric(fields[5]) === 0,
    time: `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(8, 10)}:${stamp.slice(10, 12)}:${stamp.slice(12)}+08:00`,
  };
}

async function quotes(raw) {
  const { instrument, quoteKey } = await import('../tools/investment-theory/model.mjs');
  const symbols = [...new Set(String(raw || '').split(','))];
  if (!raw || symbols.length > 24) throw Object.assign(Error('每次可查询 1 至 24 个标的'), { status: 400 });
  let entries;
  try {
    entries = symbols.map(value => {
      const index = value.startsWith('index:');
      const symbol = instrument(index ? value.slice(6) : value, index);
      const [code, exchange] = symbol.split('.');
      return { id: quoteKey(symbol, index), provider: exchange.toLowerCase() + code, index };
    });
  } catch (error) { throw Object.assign(error, { status: 400 }); }
  const keys = [...new Set(entries.map(row => row.provider))].sort();
  const response = await cached(keys.join(','), 25_000, async () => {
    const res = await fetch('https://qt.gtimg.cn/q=' + keys.join(','), {
      headers: { Referer: 'https://gu.qq.com/', 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(7000),
    });
    if (!res.ok) throw Error('行情暂不可用');
    const body = new TextDecoder('gb18030').decode(await res.arrayBuffer());
    const rows = Object.fromEntries([...body.matchAll(/v_((?:sh|sz|bj)\d{6})="([^"]*)"/g)]
      .map(match => [match[1], parseQuote(match[2].split('~'))]));
    if (!Object.values(rows).some(Boolean)) throw Error('行情暂不可用');
    return { rows };
  });
  return { quotes: Object.fromEntries(entries.flatMap(row => {
    const quote = response.rows[row.provider];
    if (!quote) return [];
    const isStock = !row.index && !/^(?:sh5|sz159)/.test(row.provider);
    return [[row.id, { ...quote, ...(isStock ? {} : { marketCap: null, peTTM: null }), stale: response.stale === true }]];
  })), source: '腾讯财经' };
}

module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'GET') return sendJson(res, 405, { error: '只支持 GET' });
    const data = req.query?.view === 'sentiment' ? await sentiment() : await quotes(req.query?.symbols);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', req.query?.view === 'sentiment' ? 'public, s-maxage=300' : 'private, no-store');
    res.end(JSON.stringify(data));
  } catch (error) {
    return sendJson(res, error.status || 503, { error: error.status === 400 ? error.message : '行情暂不可用' });
  }
};
