const { numeric } = require('./stockMarket');

const PRIMARY = '腾讯财经';
const BACKUP = '东方财富';
const TENCENT_HOST = 'qt.gtimg.cn';
const SHANGHAI_OFFSET = 8 * 60 * 60_000;
const DAY = 24 * 60 * 60_000;
const MAX_LAG = 3 * 60_000;

async function entriesFor(raw) {
  const { instrument, quoteKey } = await import('../tools/investment-theory/model.mjs');
  const symbols = [...new Set(String(raw || '').split(','))];
  if (!raw || symbols.length > 24) throw Object.assign(Error('每次可查询 1 至 24 个标的'), { status: 400 });
  try {
    const entries = symbols.map(value => {
      const index = value.startsWith('index:');
      const symbol = instrument(index ? value.slice(6) : value, index);
      const [code, exchange] = symbol.split('.');
      return {
        id: quoteKey(symbol, index), tencent: exchange.toLowerCase() + code,
        eastmoney: (exchange === 'SH' ? '1.' : '0.') + code,
        stock: !index && !(exchange === 'SH' && code.startsWith('5')) && !(exchange === 'SZ' && code.startsWith('159')),
      };
    });
    return [...new Map(entries.map(entry => [entry.id, entry])).values()];
  } catch (error) { throw Object.assign(error, { status: 400 }); }
}

async function loadTencent(entries, fetcher) {
  const symbols = [...new Set(entries.map(row => row.tencent))].sort();
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
  const url = new URL('https://push2.eastmoney.com/api/qt/ulist.np/get');
  url.search = new URLSearchParams({
    secids: [...new Set(entries.map(row => row.eastmoney))].sort().join(','),
    fields: 'f2,f3,f5,f9,f12,f13,f14,f20,f124', fltt: '2', invt: '2',
  });
  const response = await fetcher(url, {
    headers: { Referer: 'https://quote.eastmoney.com/', 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(4000),
  });
  if (!response.ok) throw Error('东方财富行情暂不可用');
  const diff = (await response.json()).data?.diff;
  const rows = new Map();
  for (const row of Object.values(diff ?? {})) {
    if (!row || ![0, 1].includes(row.f13) || !/^\d{6}$/.test(row.f12) || typeof row.f14 !== 'string') continue;
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

function timestamp(quote, now) {
  const time = Date.parse(quote?.time);
  return time > 0 && time <= now + 60_000 ? time : 0;
}

function isRecent(quote, now) {
  const time = timestamp(quote, now);
  if (!time) return false;
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

const quoteFields = entry => entry.stock ? ['changePct', 'marketCap', 'peTTM'] : ['changePct'];
const fieldCount = (quote, entry) => quoteFields(entry).filter(field => Number.isFinite(quote?.[field])).length;

function createInvestmentQuotes({ fetcher = fetch, clock = Date.now } = {}) {
  const cache = new Map();
  const pending = new Map();
  let retryPrimaryAt = 0;

  async function refresh(entries) {
    let primary = new Map();
    if (clock() >= retryPrimaryAt) {
      try { primary = await loadTencent(entries, fetcher); }
      catch { retryPrimaryAt = clock() + 30_000; }
    }
    const missing = entries.filter(entry => {
      const quote = primary.get(entry.tencent);
      return !isRecent(quote, clock()) || (!quote.suspended && fieldCount(quote, entry) < quoteFields(entry).length);
    });
    let backup = new Map();
    if (missing.length) {
      try { backup = await loadEastmoney(missing, fetcher); }
      catch { /* Return usable primary quotes and any cached marks. */ }
    }
    const now = clock();
    return Object.fromEntries(entries.flatMap(entry => {
      const first = primary.get(entry.tencent);
      const second = backup.get(entry.eastmoney);
      const previous = cache.get(entry.id)?.quote;
      let fetched = first;
      if (isRecent(first, now)) {
        if (!first.suspended && isRecent(second, now) && !second.suspended &&
            fieldCount(second, entry) > fieldCount(first, entry)) fetched = second;
      } else if (isRecent(second, now) || timestamp(second, now) > timestamp(first, now)) {
        fetched = second;
      }
      const time = timestamp(fetched, now);
      const confirmedPrice = isRecent(fetched, now) && fetched.price === previous?.price;
      if (time && (time >= timestamp(previous, now) || confirmedPrice)) {
        const quote = { ...fetched, stale: !isRecent(fetched, now) };
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
    const missing = entries.filter(({ id }) => {
      const cached = cache.get(id);
      if (!cached || now - cached.at >= 25_000 || !isRecent(cached.quote, now) || cached.quote.stale) return true;
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
