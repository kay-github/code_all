const cache = new Map();
const pending = new Map();
const limits = new Map();
const SOURCE_EM = '东方财富', SOURCE_QQ = '腾讯财经';
function numeric(v) { return v !== '' && v != null && v !== '-' && Number.isFinite(Number(v)) ? Number(v) : null; }
function normalizeSymbol(input) {
  const s = String(input || '').trim().toUpperCase();
  const match = s.match(/^(?:(SH|SZ|BJ))?(\d{6})(?:\.(SH|SZ|BJ))?$/);
  if (!match) throw Object.assign(new Error('请输入有效的沪深京 A 股六位代码'), { status: 400 });
  const code = match[2];
  const exchange = /^[489]/.test(code) ? 'BJ' : code.startsWith('6') ? 'SH' : /^[03]/.test(code) ? 'SZ' : null;
  if (!exchange || (match[1] && match[1] !== exchange) || (match[3] && match[3] !== exchange)) throw Object.assign(new Error('代码与沪深京 A 股交易所不匹配'), { status: 400 });
  return { code, exchange, symbol: `${code}.${exchange}`, qq: exchange.toLowerCase() + code, secid: (exchange === 'SH' ? '1.' : '0.') + code };
}
async function request(url, { encoding = 'utf-8', timeout = 6500, fetcher = fetch, deadline = Date.now() + 48000 } = {}) {
  const remaining = Math.min(timeout,deadline-Date.now()); if (remaining <= 0) throw new Error('行情请求总时限已到');
  const response = await fetcher(url, { signal: AbortSignal.timeout(remaining), headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://gu.qq.com/' } });
  if (!response.ok) throw new Error('行情源 HTTP ' + response.status);
  return new TextDecoder(encoding).decode(await response.arrayBuffer());
}
const json = async (url, options) => JSON.parse(await request(url, options));
function parseTencentQuote(text, stock) {
  const match = text.match(/="([^"]+)"/), f = match?.[1].split('~');
  if (!f || f.length < 46 || f[2] !== stock.code || !(numeric(f[3]) > 0)) throw new Error('腾讯未返回该股票有效行情');
  const price = numeric(f[3]), stamp = f[30];
  const time = /^\d{14}$/.test(stamp) ? `${stamp.slice(0,4)}-${stamp.slice(4,6)}-${stamp.slice(6,8)}T${stamp.slice(8,10)}:${stamp.slice(10,12)}:${stamp.slice(12,14)}+08:00` : null;
  if (!time) throw new Error('行情时间缺失');
  const marketCap = numeric(f[45]), shares = numeric(f[73]);
  return { ...stock, name: f[1], price, previousClose: numeric(f[4]), open: numeric(f[5]), high: numeric(f[33]), low: numeric(f[34]),
    change: numeric(f[31]), changePct: numeric(f[32]), volume: numeric(f[6]) == null ? null : numeric(f[6]) * 100,
    amount: numeric(f[37]) == null ? null : numeric(f[37]) * 10000, turnover: numeric(f[38]), marketCap,
    floatCap: numeric(f[44]), capital: shares > 0 ? shares / 1e8 : marketCap > 0 ? marketCap / price : null,
    peTTM: numeric(f[39]), time, source: SOURCE_QQ, delayed: true, currency: 'CNY' };
}
async function quoteTencent(stock, opts) { return parseTencentQuote(await request('https://qt.gtimg.cn/q=' + stock.qq, { ...opts, encoding: 'gb18030' }), stock); }
async function quoteEastmoney(stock, opts) {
  const r = await json(`https://push2.eastmoney.com/api/qt/stock/get?secid=${stock.secid}&fields=f57,f58,f43,f44,f45,f46,f47,f48,f60,f116,f117,f84,f85,f162,f168,f86&fltt=2`, opts);
  const d = r.data; if (!d || d.f57 !== stock.code || !(numeric(d.f43) > 0) || !(numeric(d.f86) > 0)) throw new Error('东方财富未返回有效行情');
  const price = numeric(d.f43), prev = numeric(d.f60);
  return { ...stock, name: d.f58, price, previousClose: prev, open: numeric(d.f46), high: numeric(d.f44), low: numeric(d.f45),
    change: prev > 0 ? price - prev : null, changePct: prev > 0 ? (price / prev - 1) * 100 : null,
    volume: numeric(d.f47) == null ? null : numeric(d.f47) * 100, amount: numeric(d.f48), turnover: numeric(d.f168),
    marketCap: numeric(d.f116) == null ? null : numeric(d.f116) / 1e8, floatCap: numeric(d.f117) == null ? null : numeric(d.f117) / 1e8,
    capital: numeric(d.f84) == null ? null : numeric(d.f84) / 1e8, peTTM: numeric(d.f162),
    time: new Date(d.f86 * 1000).toISOString(), source: SOURCE_EM, delayed: true, currency: 'CNY' };
}
async function historyEastmoney(stock, adjust, opts) {
  const fqt = { none: 0, qfq: 1, hfq: 2 }[adjust];
  const r = await json(`https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${stock.secid}&klt=101&fqt=${fqt}&beg=0&end=20500101&lmt=10000&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61`, opts);
  if (!r.data?.klines?.length) throw new Error('东方财富历史日线为空');
  const bars = r.data.klines.map(line => { const v = line.split(','); return { time: v[0], open: +v[1], close: +v[2], high: +v[3], low: +v[4], volume: +v[5] * 100, amount: numeric(v[6]) }; });
  return { bars, source: SOURCE_EM, complete: bars.length < 10000, name: r.data.name };
}
async function historyTencent(stock, adjust, opts) {
  const suffix = adjust === 'none' ? '' : adjust;
  let end = '', all = [], previous = '', complete = false;
  const deadline = Date.now() + 35000;
  for (let page = 0; page < 18 && Date.now() < deadline; page++) {
    const r = await json(`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${stock.qq},day,,${end},640,${suffix}`, opts);
    const d = r.data?.[stock.qq];
    // Never fall back from qfq/hfq to unadjusted prices, unless the provider explicitly reports no corporate actions.
    let rows = d?.[suffix + 'day'];
    if (!rows && suffix && d?.day && !d?.qfqday && !d?.hfqday) {
      // An adjusted request returning only `day` cannot prove its adjustment basis.
      throw new Error('备用源未返回所选复权口径，拒绝混用');
    }
    if (!Array.isArray(rows) || !rows.length) { if (all.length && r.code === 0) { complete = true; break; } throw new Error('腾讯历史日线为空或口径不可用'); }
    if (rows[0][0] === previous) throw new Error('备用源历史分页停滞');
    all.push(...rows.map(v => ({ time: v[0], open: +v[1], close: +v[2], high: +v[3], low: +v[4], volume: +v[5] * 100, amount: null })));
    if (opts?.referenceOnly) break;
    previous = rows[0][0];
    if (rows.length < 640) { complete = true; break; }
    const date = new Date(previous + 'T00:00:00Z'); date.setUTCDate(date.getUTCDate() - 1); end = date.toISOString().slice(0,10);
  }
  return { bars: all, source: SOURCE_QQ, complete };
}
async function searchEastmoney(query, opts) {
  const r = await json('https://searchapi.eastmoney.com/api/suggest/get?input=' + encodeURIComponent(query) + '&type=14&count=15', opts);
  return (r.QuotationCodeTable?.Data || []).filter(v => /^(深A|沪A|京A)$/.test(v.SecurityTypeName)).map(v => ({ ...normalizeSymbol(v.Code), name: v.Name })).slice(0,12);
}
async function searchTencent(query, opts) {
  const text = await request('https://smartbox.gtimg.cn/s3/?q=' + encodeURIComponent(query) + '&t=all', { ...opts, encoding: 'gb18030' });
  const raw = text.match(/="(.*)"/)?.[1] || '';
  const decoded = raw.replace(/\\u([0-9a-f]{4})/gi, (_, n) => String.fromCharCode(parseInt(n,16)));
  return decoded.split('^').flatMap(s => { const f = s.split('~'); if (!/^(sh|sz|bj)$/.test(f[0]) || !/GP-A/.test(f[4] || '')) return []; try { return [{ ...normalizeSymbol(f[1]), name: f[2] }]; } catch { return []; } }).slice(0,12);
}
async function fallback(providers) {
  const failures = []; let nonpositive = false;
  for (const provider of providers) try { const result = await provider(); return { ...result, failures }; } catch (error) { nonpositive ||= error.code === 'NON_POSITIVE_ADJUSTED'; failures.push('数据源暂不可用'); }
  throw Object.assign(new Error('主备行情源暂不可用，请稍后重试；已缓存数据仍可在本机查看'), { status: 503, code: nonpositive ? 'NON_POSITIVE_ADJUSTED' : 'UNAVAILABLE' });
}
async function getMarketData(action, params, opts = {}) {
  opts = {...opts,deadline:opts.deadline || Date.now()+48000};
  const stock = action === 'search' ? null : normalizeSymbol(params.symbol);
  if (action === 'quote') return fallback([() => quoteTencent(stock, opts), () => quoteEastmoney(stock, opts)]);
  if (action === 'history') {
    let adjust = params.adjust || 'qfq';
    const requestedAdjust = adjust;
    if (!['none','qfq','hfq'].includes(adjust)) throw Object.assign(new Error('无效复权口径'), { status: 400 });
    const { validateBars } = await import('../tools/stock-rebound-lab/analysis.mjs');
    const checked = async provider => { const result = await provider();
      if (result.bars.some(b => ['open','high','low','close'].some(k => Number(b[k]) <= 0))) throw Object.assign(new Error('复权价格非正'), { code: 'NON_POSITIVE_ADJUSTED' });
      result.bars = validateBars(result.bars); if (result.bars.length < 2) throw new Error('有效历史数据不足'); return result; };
    const load = () => fallback([() => checked(() => historyEastmoney(stock, adjust, opts)), () => checked(() => historyTencent(stock, adjust, opts))]);
    let result, warning = null;
    try { result = await load(); } catch (error) {
      if (adjust !== 'qfq' || error.code !== 'NON_POSITIVE_ADJUSTED') throw error;
      adjust = 'hfq'; result = await load(); warning = '前复权早期存在非正价格，已整段切换为后复权；禁止对非正价格计算回撤比例';
    }
    const bars = result.bars;
    let referenceScale = adjust === 'qfq' ? 1 : null, referenceDate = null;
    if (adjust === 'hfq') try {
      const raw = result.source === SOURCE_EM ? await historyEastmoney(stock,'none',opts) : await historyTencent(stock,'none',{...opts,referenceOnly:true});
      const rawMap = new Map(raw.bars.map(b => [b.time,b]));
      const chinaDay = new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date());
      const anchor = [...bars].reverse().find(b => b.time < chinaDay && rawMap.get(b.time)?.close > 0);
      if (anchor) { referenceScale = rawMap.get(anchor.time).close / anchor.close; referenceDate = anchor.time; }
    } catch { /* History remains usable; current-price presets stay unavailable. */ }
    return { ...result, ...stock, bars, adjust, requestedAdjust, warning, referenceScale, referenceDate,
      referenceLabel: adjust === 'hfq' ? '后复权等比归一参考（非传统前复权）' : adjust === 'qfq' ? '前复权参考' : null,
      basis: `${result.source}:${adjust}`, start: bars[0].time, end: bars.at(-1).time, fetchedAt: new Date().toISOString(), delayed: true };
  }
  if (action === 'search') {
    const q = String(params.q || '').trim();
    if (!q || q.length > 30) throw Object.assign(new Error('请输入 1—30 个字符的代码或名称'), { status: 400 });
    let direct; try { direct = normalizeSymbol(q); } catch {}
    const result = await fallback([async () => { const items = await searchEastmoney(direct?.code || q, opts); if (!items.length) return { items: [], source: SOURCE_EM }; return { items, source: SOURCE_EM }; }, async () => ({ items: await searchTencent(direct?.code || q, opts), source: SOURCE_QQ })]);
    if (!result.items.length && direct) try { const quote = await quoteTencent(direct, opts); result.items = [{ ...direct, name: quote.name }]; } catch {}
    return result;
  }
  throw Object.assign(new Error('无效请求类型'), { status: 400 });
}
async function cachedMarketData(action, params, opts = {}) {
  const key = action + ':' + (action === 'search' ? params.q : normalizeSymbol(params.symbol).symbol) + ':' + (params.adjust || 'qfq');
  const ttl = action === 'history' ? 20 * 60e3 : action === 'search' ? 3600e3 : 25e3;
  const old = cache.get(key);
  if (!params.force && old && Date.now() - old.at < ttl) return { ...old.value, cached: true, cacheTime: new Date(old.at).toISOString() };
  if (pending.has(key)) return pending.get(key);
  const task = getMarketData(action, params, opts).then(value => { if (cache.size > 200) cache.delete(cache.keys().next().value); cache.set(key,{ at: Date.now(), value }); return { ...value, cached: false }; }).catch(error => {
    if (old) return { ...old.value, cached: true, stale: true, cacheTime: new Date(old.at).toISOString(), warning: '数据源中断，使用服务端临时缓存' };
    throw error;
  }).finally(() => pending.delete(key));
  pending.set(key,task); return task;
}
function rateLimit(ip) {
  const now = Date.now(), entry = limits.get(ip);
  if (!entry || now - entry.at > 60e3) { if (limits.size > 1000) limits.clear(); limits.set(ip, { at: now, n: 1 }); return true; }
  return ++entry.n <= 80;
}
module.exports = { normalizeSymbol, numeric, parseTencentQuote, getMarketData, cachedMarketData, rateLimit };
