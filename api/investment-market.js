const { numeric } = require('../lib/stockMarket');
const { sendJson } = require('../lib/gridHttp');
const store = require('../lib/gridStore');
const { CONFIG, matchesSecret, matchesImport, runGoalAlerts } = require('../lib/investmentAlerts');
const { sendPushplus } = require('../lib/pushplus');

const FINANCE = 'https://finance.688680.xyz';
const cache = new Map();
const pending = new Map();
const SNAPSHOT_TTL = 15 * 60_000;
const indices = [
  ['szzs', '上证指数'], ['cybz', '创业板指'], ['kc50', '科创50'], ['hs300', '沪深300'],
];
const industryNames = ['电子', '通信', '计算机', '传媒', '电力设备', '汽车', '国防军工'];
const themeIds = ['tonghuashun:concept:885756', 'tonghuashun:concept:886069'];

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

function scoreOf(value) {
  const score = numeric(value);
  return score !== null && score >= 0 && score <= 100 ? score : null;
}

function fearItem(name, row, stale = false) {
  return {
    name, date: row?.trade_date ?? null, score: scoreOf(row?.score),
    zone: row?.zone?.label ?? null, zoneKey: row?.zone?.key ?? null,
    stale: stale || row?.stale === true,
  };
}

async function sentiment() {
  const [overview, kc50, hs300, major, themes] = (await Promise.allSettled([
    cached('fear-overview', SNAPSHOT_TTL, () => upstream('/api/fear-greed/overview')),
    cached('fear-kc50', SNAPSHOT_TTL, () => upstream('/api/fear-greed/targets/kc50')),
    cached('fear-hs300', SNAPSHOT_TTL, () => upstream('/api/fear-greed/targets/hs300')),
    cached('major-industries', SNAPSHOT_TTL, () => upstream('/api/fear-greed/sectors?level=major&limit=40')),
    cached('broad-themes', SNAPSHOT_TTL, () => upstream('/api/market-structure/crowding?limit=50')),
  ])).map(result => result.value ?? null);
  const details = { kc50, hs300 };
  const items = indices.map(([key, name]) => ({
    key, ...fearItem(name, details[key] ?? overview?.targets?.find(row => row.key === key), key === 'szzs' || key === 'cybz' ? overview?.stale === true : false),
  }));
  return {
    fear: { date: overview?.trade_date ?? null, model: overview?.model_version ?? kc50?.model_version ?? hs300?.model_version, items },
    industry: major && {
      model: major.model_version,
      items: industryNames.map(name => fearItem(name, major.items?.find(row => row.name === name), major.stale === true)),
    },
    crowding: themes && {
      date: themes.target_trade_date, stale: themes.stale === true,
      items: themeIds.flatMap(id => {
        const row = themes.items?.find(item => item.sector_id === id);
        return row ? [{
          name: row.native_name, date: row.trade_date, score: scoreOf(row.heat?.value), stale: row.stale === true,
        }] : [];
      }),
    },
  };
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
    if (req.query?.view === 'goal-alerts' && req.method === 'POST') {
      if (!matchesSecret(req.headers?.authorization, process.env.MONITOR_SECRET && 'Bearer ' + process.env.MONITOR_SECRET)) {
        return sendJson(res, 401, { error: '未授权' });
      }
      const config = (await store.read(CONFIG))?.value;
      if (!config?.alertIds?.length) return sendJson(res, 503, { error: '目标提醒尚未配置' });
      if (!process.env.PUSHPLUS_TOKEN) return sendJson(res, 503, { error: '推加尚未配置' });
      return sendJson(res, 200, await runGoalAlerts({
        store, config, quotes, send: sendPushplus, dryRun: req.query.dryRun === '1',
      }));
    }
    if (['goal-template', 'ledger-import'].includes(req.query?.view) && req.method === 'GET') {
      const isLedger = req.query.view === 'ledger-import';
      const token = req.headers?.authorization?.match(/^Bearer ([a-f0-9]{48})$/)?.[1];
      const config = token && (await store.read(isLedger ? 'investment/v1/ledger-import.json' : CONFIG))?.value;
      if (!matchesImport(token, config)) return sendJson(res, 401, { error: '导入链接无效或已过期' });
      return sendJson(res, 200, isLedger ? config.data : { goals: config.goals });
    }
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
