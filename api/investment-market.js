const { createHash } = require('node:crypto');
const { numeric } = require('../lib/stockMarket');
const { sendJson } = require('../lib/gridHttp');
const store = require('../lib/gridStore');
const { CONFIG, investmentStatePath, matchesSecret, matchesImport, runGoalAlerts } = require('../lib/investmentAlerts');
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

function diagnosticQuotes(mode) {
  // Exercise the production resolver without touching its shared cache.
  return createInvestmentQuotes({ fetcher(url, options) {
    if (mode === 'fallback' && url.hostname === TENCENT_HOST) {
      return Promise.resolve(new Response(null, { status: 503 }));
    }
    return fetch(url, options);
  } });
}

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

const sentimentSource = (key, path) => cached(key, SNAPSHOT_TTL, () => upstream(path)).catch(() => null);

const sentimentSections = {
  async fear() {
    const [overview, kc50, hs300] = await Promise.all([
      sentimentSource('fear-overview', '/api/fear-greed/overview'),
      sentimentSource('fear-kc50', '/api/fear-greed/targets/kc50'),
      sentimentSource('fear-hs300', '/api/fear-greed/targets/hs300'),
    ]);
    const details = { kc50, hs300 };
    const items = indices.map(([key, name]) => ({
      key, ...fearItem(name, details[key] ?? overview?.targets?.find(row => row.key === key),
        key === 'szzs' || key === 'cybz' ? overview?.stale === true : false),
    }));
    return { date: overview?.trade_date ?? null, model: overview?.model_version ?? kc50?.model_version ?? hs300?.model_version, items };
  },
  async industry() {
    const major = await sentimentSource('major-industries', '/api/fear-greed/sectors?level=major&limit=40');
    return major && {
      model: major.model_version,
      items: industryNames.map(name => fearItem(name, major.items?.find(row => row.name === name), major.stale === true)),
    };
  },
  async crowding() {
    const themes = await sentimentSource('broad-themes', '/api/market-structure/crowding?limit=50');
    return themes && {
      date: themes.target_trade_date, stale: themes.stale === true,
      items: themeIds.flatMap(id => {
        const row = themes.items?.find(item => item.sector_id === id);
        return row ? [{
          name: row.native_name, date: row.trade_date, score: scoreOf(row.heat?.value), stale: row.stale === true,
        }] : [];
      }),
    };
  },
};

async function sentiment(section) {
  if (section && !Object.hasOwn(sentimentSections, section)) throw Object.assign(Error('情绪数据分类无效'), { status: 400 });
  const keys = section ? [section] : Object.keys(sentimentSections);
  return Object.fromEntries(await Promise.all(keys.map(async key => [key, await sentimentSections[key]()])));
}

module.exports = async function handler(req, res) {
  try {
    const authorization = req.headers?.authorization;
    const cron = req.query?.scheduled === '1' &&
      matchesSecret(authorization, process.env.CRON_SECRET && 'Bearer ' + process.env.CRON_SECRET);
    if (req.query?.view === 'quote-health' && req.method === 'POST') {
      if (!matchesSecret(req.headers?.authorization, process.env.MONITOR_SECRET && 'Bearer ' + process.env.MONITOR_SECRET)) {
        return sendJson(res, 401, { error: '未授权' });
      }
      const check = diagnosticQuotes(req.query.mode);
      return sendJson(res, 200, await check(req.query.symbols));
    }
    if (req.query?.view === 'valuations') {
      if (req.method === 'POST') {
        const monitor = matchesSecret(authorization, process.env.MONITOR_SECRET && 'Bearer ' + process.env.MONITOR_SECRET);
        if (!cron && !monitor) return sendJson(res, 401, { error: '未授权' });
        const { refreshStoredValuations } = await import('../lib/investmentValuation.mjs');
        try {
          const key = process.env.INDEX_HUB_API_KEY?.trim();
          const audit = key && (await import('../lib/investmentValuationAudit.mjs')).auditIndexHubValuations;
          const result = await refreshStoredValuations(store, require('../tools/investment-theory/valuations.json'),
            undefined, undefined, audit ? snapshot => audit(snapshot, key) : undefined);
          if (result.backup) console.info('Index Hub valuation audit:', JSON.stringify(result.backup));
          return sendJson(res, 200, result);
        } catch (error) {
          console.warn('Index valuation refresh:', error.message);
          return sendJson(res, 503, { error: '估值自动更新暂不可用' });
        }
      }
      if (req.method !== 'GET') return sendJson(res, 405, { error: '只支持 GET' });
      const { valuationPath, publishedValuationSnapshot } = await import('../lib/investmentValuation.mjs');
      const { valuationEncoding, packValuations } = await import('../tools/investment-theory/valuation-codec.mjs');
      const saved = await store.read(valuationPath).catch(() => null);
      const payload = {
        ...publishedValuationSnapshot(require('../tools/investment-theory/valuations.json'), saved?.value),
        fallback: !saved,
      };
      const body = JSON.stringify(req.query.format === valuationEncoding ? packValuations(payload) : payload);
      const etag = '"' + createHash('sha256').update(body).digest('base64url') + '"';
      res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=60, must-revalidate');
      res.setHeader('ETag', etag);
      const validators = (req.headers?.['if-none-match'] ?? '').split(',').map(value => value.trim().replace(/^W\//, ''));
      if (validators.includes(etag) || validators.includes('*')) {
        res.statusCode = 304;
        return res.end();
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.end(body);
    }
    if (req.query?.view === 'crowding') {
      if (req.method === 'POST') {
        const monitor = matchesSecret(authorization, process.env.MONITOR_SECRET && 'Bearer ' + process.env.MONITOR_SECRET);
        if (!cron && !monitor) {
          return sendJson(res, 401, { error: '未授权' });
        }
        try {
          return sendJson(res, 200, await crowding.refreshCrowding({ store, force: monitor && req.query.force === '1' }));
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
      if (!cron && !matchesSecret(authorization, process.env.MONITOR_SECRET && 'Bearer ' + process.env.MONITOR_SECRET)) {
        return sendJson(res, 401, { error: '未授权' });
      }
      const config = (await store.read(CONFIG))?.value;
      if (!config) return sendJson(res, 503, { error: '目标提醒尚未配置' });
      if (!process.env.PUSHPLUS_TOKEN) return sendJson(res, 503, { error: '推加尚未配置' });
      const dryRun = req.query.dryRun === '1';
      const scheduled = req.query.scheduled === '1';
      const snapshot = config.ownerId && (await store.read(investmentStatePath(config.ownerId)))?.value?.payload;
      const stats = await runGoalAlerts({
        store, config, snapshot, quotes: dryRun && req.query.mode === 'fallback' ? diagnosticQuotes('fallback') : quotes,
        send: sendPushplus, dryRun, scheduled,
      });
      return sendJson(res, !dryRun && !scheduled && stats.unchecked ? 503 : 200, stats);
    }
    if (['goal-template', 'ledger-import'].includes(req.query?.view) && req.method === 'GET') {
      const isLedger = req.query.view === 'ledger-import';
      const token = req.headers?.authorization?.match(/^Bearer ([a-f0-9]{48})$/)?.[1];
      const config = token && (await store.read(isLedger ? 'investment/v1/ledger-import.json' : CONFIG))?.value;
      if (!matchesImport(token, config)) return sendJson(res, 401, { error: '导入链接无效或已过期' });
      return sendJson(res, 200, isLedger ? config.data : { goals: config.goals });
    }
    if (req.method !== 'GET') return sendJson(res, 405, { error: '只支持 GET' });
    const data = req.query?.view === 'sentiment' ? await sentiment(req.query.section) : await quotes(req.query?.symbols);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', req.query?.view === 'sentiment' ? 'public, s-maxage=300' : 'private, no-store');
    res.end(JSON.stringify(data));
  } catch (error) {
    return sendJson(res, error.status || 503, { error: error.status === 400 ? error.message : '行情暂不可用' });
  }
};
