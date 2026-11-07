const { numeric } = require('../lib/stockMarket');
const { sendJson } = require('../lib/gridHttp');
const store = require('../lib/gridStore');
const { CONFIG, matchesSecret, matchesImport, runGoalAlerts } = require('../lib/investmentAlerts');
const { sendPushplus } = require('../lib/pushplus');
const crowding = require('../lib/investmentCrowding');
const { createInvestmentQuotes, TENCENT_HOST } = require('../lib/investmentQuotes');
const quotes = createInvestmentQuotes();

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

module.exports = async function handler(req, res) {
  try {
    if (req.query?.view === 'quote-health' && req.method === 'POST') {
      if (!matchesSecret(req.headers?.authorization, process.env.MONITOR_SECRET && 'Bearer ' + process.env.MONITOR_SECRET)) {
        return sendJson(res, 401, { error: '未授权' });
      }
      // Exercise the production resolver and backup without touching its shared cache.
      const check = createInvestmentQuotes({ fetcher(url, options) {
        if (req.query.mode === 'fallback' && url.hostname === TENCENT_HOST) {
          return Promise.resolve(new Response(null, { status: 503 }));
        }
        return fetch(url, options);
      } });
      return sendJson(res, 200, await check(req.query.symbols));
    }
    if (req.query?.view === 'crowding') {
      if (req.method === 'POST') {
        if (!matchesSecret(req.headers?.authorization, process.env.MONITOR_SECRET && 'Bearer ' + process.env.MONITOR_SECRET)) {
          return sendJson(res, 401, { error: '未授权' });
        }
        try {
          return sendJson(res, 200, await crowding.refreshCrowding({ store, force: req.query.force === '1' }));
        } catch (error) {
          console.error('Crowding refresh:', error.message, error.cause?.cause?.code ?? error.cause?.message ?? '');
          return sendJson(res, 503, { error: '板块拥挤度更新暂不可用' });
        }
      }
      if (req.method !== 'GET') return sendJson(res, 405, { error: '只支持 GET' });
      const saved = (await store.read(crowding.PATH))?.value;
      const snapshot = crowding.publicSnapshot(saved);
      if (req.query.history === 'long') snapshot.history = crowding.publicHistory(saved);
      return sendJson(res, 200, snapshot);
    }
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
