const { numeric } = require('./stockMarket');

const PRIMARY = '腾讯财经';
const BACKUP = '东方财富';
const TENCENT_HOST = 'qt.gtimg.cn';
const SHANGHAI_OFFSET = 8 * 60 * 60_000;
const DAY = 24 * 60 * 60_000;
const MAX_LAG = 3 * 60_000;

async function entriesFor(raw) {
  const { instrument, macroTargets, quoteKey } = await import('../tools/investment-theory/model.mjs');
  const symbols = [...new Set(String(raw || '').split(','))];
  if (!raw || symbols.length > 24) throw Object.assign(Error('每次可查询 1 至 24 个标的'), { status: 400 });
  try {
    const entries = symbols.map(value => {
      if (Object.hasOwn(macroTargets, value)) {
        return { id: value, macro: true, eastmoney: { AU9999: '118.AU9999', CL: '102.CL00Y' }[value] };
      }
      const index = value.startsWith('index:');
      const symbol = instrument(index ? value.slice(6) : value, index);
      const [code, exchange] = symbol.split('.');
      return {
        id: quoteKey(symbol, index), tencent: code === '932000' ? null : exchange.toLowerCase() + code,
        eastmoney: (code === '932000' ? '2.' : exchange === 'SH' ? '1.' : '0.') + code,
        stock: !index && !(exchange === 'SH' && code.startsWith('5')) && !(exchange === 'SZ' && code.startsWith('159')),
      };
    });
    return [...new Map(entries.map(entry => [entry.id, entry])).values()];
  } catch (error) { throw Object.assign(error, { status: 400 }); }
}

async function loadTencent(entries, fetcher) {
  const symbols = [...new Set(entries.map(row => row.tencent).filter(Boolean))].sort();
  if (!symbols.length) return new Map();
  const url = new URL('https://' + TENCENT_HOST + '/q=' + symbols.join(','));
  const response = await fetcher(url, {
    headers: { Referer: 'https://gu.qq.com/', 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(4000),
  });
  if (!response.ok) throw Error('腾讯行情暂不可用');
  const text = new TextDecoder('gb18030').decode(await response.arrayBuffer());
  const rows = new Map();
  for (const [, symbol, value] of text.matchAll(/v_((?:sh|sz|bj)\d{6})="([^"]*)"/g)) {
    const fields = value.split('~');
    if (fields[2] !== symbol.slice(2)) continue;
    const stamp = fields[30];
    const price = numeric(fields[3]);
    if (!(price > 0) || !/^\d{14}$/.test(stamp)) continue;
    const marketCap = numeric(fields[45]);
    // Tencent field 52 and East Money f9 are TTM. Field 39 is a different PE basis.
    rows.set(symbol, {
      name: fields[1], price, changePct: numeric(fields[32]), peTTM: numeric(fields[52]),
      marketCap: marketCap > 0 ? marketCap : null,
      suspended: fields[0] === 'S' || numeric(fields[5]) === 0, source: PRIMARY,
      time: stamp.replace(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/, '$1-$2-$3T$4:$5:$6+08:00'),
    });
  }
  return rows;
}

async function loadEastmoney(entries, fetcher) {
  const ids = new Set(entries.map(row => row.eastmoney).filter(Boolean));
  if (!ids.size) return new Map();
  const url = new URL('https://push2.eastmoney.com/api/qt/ulist.np/get');
  url.search = new URLSearchParams({
    secids: [...ids].sort().join(','),
    fields: 'f2,f3,f5,f9,f12,f13,f14,f20,f124', fltt: '2', invt: '2',
  });
  const response = await fetcher(url, {
    headers: { Referer: 'https://quote.eastmoney.com/', 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(4000),
  });
  if (!response.ok) throw Error('东方财富行情暂不可用');
  const diff = (await response.json()).data?.diff;
  const rows = new Map();
  for (const row of Object.values(diff ?? {})) {
    if (!row || !ids.has(row.f13 + '.' + row.f12) || typeof row.f14 !== 'string') continue;
    const price = numeric(row.f2), seconds = numeric(row.f124);
    if (!(price > 0) || !Number.isSafeInteger(seconds) || seconds <= 0 || seconds >= 1e10) continue;
    const marketCap = numeric(row.f20);
    rows.set(row.f13 + '.' + row.f12, {
      name: row.f14, price, changePct: numeric(row.f3), peTTM: numeric(row.f9),
      marketCap: marketCap > 0 ? marketCap / 1e8 : null,
      suspended: numeric(row.f5) === 0, time: new Date(seconds * 1000).toISOString(), source: BACKUP,
    });
  }
  return rows;
}

async function loadSinaMacro(entries, fetcher) {
  const codes = { CL: 'hf_CL', AU9999: 'SGE_AU9999' };
  const ids = entries.map(row => row.id).filter(id => Object.hasOwn(codes, id));
  if (!ids.length) return new Map();
  const url = new URL('https://hq.sinajs.cn/list=' + ids.map(id => codes[id]).join(','));
  const response = await fetcher(url, {
    headers: { Referer: 'https://finance.sina.com.cn/', 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(4000),
  });
  if (!response.ok) throw Error('新浪商品行情暂不可用');
  const body = new TextDecoder('gb18030').decode(await response.arrayBuffer());
  const rows = new Map();
  for (const id of ids) {
    const fields = body.match(new RegExp('hq_str_' + codes[id] + '="([^"]*)"'))?.[1].split(',') ?? [];
    if (id === 'AU9999' && fields[0] !== id) continue;
    const price = numeric(fields[id === 'CL' ? 0 : 3]);
    const stamp = id === 'CL' ? fields[12] + ' ' + fields[6] : fields[16];
    if (price > 0 && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(stamp)) {
      rows.set(id, { name: id === 'CL' ? '纽约原油 CL 连续' : '黄金 Au99.99', price,
        source: '新浪财经', time: stamp.replace(' ', 'T') + '+08:00' });
    }
  }
  return rows;
}

async function loadBitcoin(fetcher, now) {
  const feeds = [
    ['https://api.exchange.coinbase.com/products/BTC-USD/ticker', 'Coinbase', row => [row.price, row.time]],
    ['https://www.bitstamp.net/api/v2/ticker/btcusd/', 'Bitstamp', row => [row.last, Number(row.timestamp) * 1000]],
  ];
  for (const [url, source, fields] of feeds) {
    try {
      const response = await fetcher(new URL(url), { signal: AbortSignal.timeout(3500) });
      if (!response.ok) continue;
      const [raw, stamp] = fields(await response.json());
      const value = new Date(stamp);
      if (numeric(raw) > 0 && Number.isFinite(value.valueOf())) {
        const quote = { name: '比特币 BTC/USD', source, price: numeric(raw), time: value.toISOString() };
        if (isRecent(quote, now(), { macro: true })) return quote;
      }
    } catch { /* Continue with the next venue. */ }
  }
  return null;
}

async function loadCsi2000(fetcher) {
  const url = new URL('https://push2his.eastmoney.com/api/qt/stock/trends2/get');
  url.search = new URLSearchParams({ secid: '2.932000', ndays: '1',
    fields1: 'f1,f2,f3,f4,f5,f6,f7,f8', fields2: 'f51,f52,f53,f54,f55,f56,f57,f58' });
  const response = await fetcher(url, { signal: AbortSignal.timeout(4000) });
  if (!response.ok) return null;
  const { data } = await response.json();
  if (data?.code !== '932000' || data.market !== 2 || !Array.isArray(data.trends)) return null;
  const [stamp, , closing] = String(data.trends.at(-1) ?? '').split(',');
  const price = numeric(closing);
  if (!(price > 0) || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(stamp)) return null;
  const pre = numeric(data.preClose);
  return { price, name: '中证2000', changePct: pre > 0 ? (price / pre - 1) * 100 : null,
    source: BACKUP, time: stamp.replace(' ', 'T') + ':00+08:00' };
}

function timestamp(quote, now) {
  const time = Date.parse(quote?.time);
  return time > 0 && time <= now + 60_000 ? time : 0;
}

function isRecent(quote, now, entry) {
  const time = timestamp(quote, now);
  if (!time) return false;
  if (entry.macro) return now - time <= 20 * 60_000;
  const china = new Date(now + SHANGHAI_OFFSET);
  const weekday = china.getUTCDay();
  const minute = china.getUTCHours() * 60 + china.getUTCMinutes();
  const inSession = weekday % 6 !== 0 &&
    ((minute >= 570 && minute <= 690) || (minute >= 780 && minute <= 900));
  const dayStart = Math.floor((now + SHANGHAI_OFFSET) / DAY) * DAY - SHANGHAI_OFFSET;
  if (!inSession) {
    const daysBack = weekday === 0 ? 2 : weekday === 6 ? 1 : minute >= 570 ? 0 : weekday === 1 ? 3 : 1;
    return time >= dayStart - daysBack * DAY;
  }
  if (time < dayStart) return false;
  const sessionStart = dayStart + (minute < 780 ? 570 : 780) * 60_000;
  return quote.suspended || now - sessionStart < MAX_LAG || now - time <= MAX_LAG;
}

const quoteFields = entry => entry.macro ? [] : entry.stock ? ['changePct', 'marketCap', 'peTTM'] : ['changePct'];
const fieldCount = (quote, entry) => quoteFields(entry).filter(field => Number.isFinite(quote?.[field])).length;

function createInvestmentQuotes({ fetcher = fetch, clock = Date.now } = {}) {
  const cache = new Map();
  const pending = new Map();
  let retryPrimaryAt = 0;

  async function refresh(entries) {
    const tencent = clock() >= retryPrimaryAt ? loadTencent(entries, fetcher).catch(() => {
      retryPrimaryAt = clock() + 30_000;
      return new Map();
    }) : new Map();
    const [primary, macro, bitcoin, csi2000] = await Promise.all([
      tencent, loadSinaMacro(entries, fetcher).catch(() => new Map()),
      entries.some(entry => entry.id === 'BTC-USD') ? loadBitcoin(fetcher, clock) : null,
      entries.some(entry => entry.id === 'index:932000.SH') ? loadCsi2000(fetcher).catch(() => null) : null,
    ]);
    if (bitcoin) macro.set('BTC-USD', bitcoin);
    const firstQuote = entry => entry.id === 'index:932000.SH' ? csi2000 : entry.macro ? macro.get(entry.id) : primary.get(entry.tencent);
    const missing = entries.filter(entry => {
      const quote = firstQuote(entry);
      return entry.eastmoney && (!isRecent(quote, clock(), entry) || (!quote.suspended && fieldCount(quote, entry) < quoteFields(entry).length));
    });
    let backup = new Map();
    if (missing.length) {
      try { backup = await loadEastmoney(missing, fetcher); }
      catch { /* Return usable primary quotes and any cached marks. */ }
    }
    const now = clock();
    return Object.fromEntries(entries.flatMap(entry => {
      const first = firstQuote(entry);
      const second = backup.get(entry.eastmoney);
      const previous = cache.get(entry.id)?.quote;
      let fetched = first;
      if (isRecent(first, now, entry)) {
        if (!first.suspended && isRecent(second, now, entry) && !second.suspended &&
            fieldCount(second, entry) > fieldCount(first, entry)) fetched = second;
      } else if (isRecent(second, now, entry) || timestamp(second, now) > timestamp(first, now)) {
        fetched = second;
      }
      const time = timestamp(fetched, now);
      const confirmedPrice = isRecent(fetched, now, entry) && fetched.price === previous?.price;
      if (time && (time >= timestamp(previous, now) || confirmedPrice)) {
        const quote = { ...fetched, stale: !isRecent(fetched, now, entry) };
        if (!entry.stock) Object.assign(quote, { marketCap: null, peTTM: null });
        cache.delete(entry.id);
        if (cache.size >= 400) cache.delete(cache.keys().next().value);
        cache.set(entry.id, { quote, at: now });
        return [[entry.id, quote]];
      }
      return previous ? [[entry.id, { ...previous, stale: true }]] : [];
    }));
  }

  return async function quotes(raw) {
    const entries = await entriesFor(raw);
    const now = clock();
    const result = {};
    const missing = entries.filter(entry => {
      const { id } = entry;
      const cached = cache.get(id);
      if (!cached || now - cached.at >= 25_000 || !isRecent(cached.quote, now, entry) || cached.quote.stale) return true;
      result[id] = cached.quote;
      return false;
    });
    if (missing.length) {
      const key = missing.map(entry => entry.id).sort().join(',');
      if (!pending.has(key)) pending.set(key, refresh(missing).finally(() => pending.delete(key)));
      Object.assign(result, await pending.get(key));
    }
    if (!Object.keys(result).length) throw Error('行情暂不可用');
    return { quotes: result, source: [...new Set(Object.values(result).map(quote => quote.source))].join(' / ') };
  };
}

module.exports = { createInvestmentQuotes, TENCENT_HOST };
