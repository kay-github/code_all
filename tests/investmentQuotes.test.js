const assert = require('node:assert/strict');
const test = require('node:test');
const { createInvestmentQuotes, TENCENT_HOST } = require('../lib/investmentQuotes');

const now = Date.parse('2026-11-06T10:15:00+08:00');
const tencent = (key, price, stamp = '20261106101445') => {
  const fields = Array(53).fill('');
  fields[0] = '1';
  fields[1] = key;
  fields[2] = key.slice(2);
  fields[3] = price;
  fields[5] = 100;
  fields[30] = stamp;
  fields[32] = 2.1;
  fields[39] = 17.2;
  fields[45] = 2400;
  fields[52] = 15.83;
  return `v_${key}="${fields.join('~')}";`;
};
const eastmoney = (secid, price, time = now - 5_000, extra = {}) => ({
  f2: price, f3: 2.2, f5: 100, f9: 15.83, f12: secid.slice(2), f13: Number(secid[0]),
  f14: secid, f20: 240_034_285_200, f124: Math.floor(time / 1000), ...extra,
});
const response = (...diff) => Response.json({ data: { diff } });

test('keeps fresh Tencent prices and only sends missing or lagged symbols to the backup', async () => {
  const quotes = createInvestmentQuotes({ clock: () => now, fetcher: async url => {
    if (url.hostname === TENCENT_HOST) {
      return new Response(tencent('sz300502', 172) + tencent('sh688521', 100, '20261106100800'));
    }
    assert.equal(url.searchParams.get('secids'), '0.399006,1.688521');
    return response(eastmoney('0.399006', 2465), eastmoney('1.688521', 105.3));
  } });
  const result = await quotes('300502.SZ,688521.SH,index:399006.SZ');
  assert.equal(result.source, '腾讯财经 / 东方财富');
  assert.equal(result.quotes['300502.SZ'].price, 172);
  assert.equal(result.quotes['300502.SZ'].peTTM, 15.83);
  assert.equal(result.quotes['688521.SH'].marketCap, 2400.342852);
  assert.equal(result.quotes['688521.SH'].peTTM, 15.83);
  assert.equal(result.quotes['index:399006.SZ'].marketCap, null);
  assert.equal(result.quotes['index:399006.SZ'].peTTM, null);
});

test('batch backup covers stocks, Beijing, ETFs and same-code Shanghai index after a timeout', async () => {
  let primaryRequests = 0;
  let at = now;
  const quotes = createInvestmentQuotes({ clock: () => at, fetcher: async (url, { signal }) => {
    assert.ok(signal instanceof AbortSignal);
    if (url.hostname === TENCENT_HOST) {
      primaryRequests++;
      throw new DOMException('Provider timed out', 'TimeoutError');
    }
    return response(eastmoney('0.000001', 11.81), eastmoney('1.000001', 3649.18),
      eastmoney('1.510300', 4.124), eastmoney('0.920002', 47.51));
  } });
  const symbols = '000001.SZ,index:000001.SH,510300.SH,920002.BJ';
  const result = await quotes(symbols);
  assert.equal(result.source, '东方财富');
  assert.equal(result.quotes['000001.SZ'].price, 11.81);
  assert.equal(result.quotes['index:000001.SH'].price, 3649.18);
  assert.equal(result.quotes['510300.SH'].price, 4.124);
  assert.equal(result.quotes['510300.SH'].peTTM, null);
  assert.equal(result.quotes['920002.BJ'].price, 47.51);
  assert.ok(Object.values(result.quotes).every(quote => !quote.stale));
  at += 26_000;
  await quotes(symbols);
  assert.equal(primaryRequests, 1);
  at += 26_000;
  await quotes(symbols);
  assert.equal(primaryRequests, 2);
});

test('keeps the last known quote marked stale if both feeds fail or regress', async () => {
  let at = now;
  let phase = 0;
  const quotes = createInvestmentQuotes({ clock: () => at, fetcher: async url => {
    if (phase === 0) return new Response(tencent('sz300502', 172));
    if (phase === 1 || url.hostname === TENCENT_HOST) return new Response(null, { status: 503 });
    return response(eastmoney('0.300502', 80, now - 40 * 60_000));
  } });
  assert.equal((await quotes('300502.SZ')).quotes['300502.SZ'].stale, false);
  at += 26_000;
  phase++;
  const cached = (await quotes('300502.SZ')).quotes['300502.SZ'];
  assert.equal(cached.stale, true);
  assert.equal(cached.price, 172);
  phase++;
  assert.deepEqual((await quotes('300502.SZ')).quotes['300502.SZ'], cached);
  await assert.rejects(quotes('688521.SH'), /行情暂不可用/);
});

test('checks for a newer closing quote over the weekend without claiming it is a live tick', async () => {
  const saturday = Date.parse('2026-11-07T10:00:00+08:00');
  const fridayClose = Date.parse('2026-11-06T15:00:00+08:00');
  const quotes = createInvestmentQuotes({ clock: () => saturday, fetcher: async url =>
    url.hostname === TENCENT_HOST
      ? new Response(tencent('sz300502', 170, '20261105150000'))
      : response(eastmoney('0.300502', 172, fridayClose)),
  });
  const quote = (await quotes('300502.SZ')).quotes['300502.SZ'];
  assert.equal(quote.source, '东方财富');
  assert.equal(Date.parse(quote.time), fridayClose);
  assert.equal(quote.stale, false);
});

test('can confirm a cached closing price using a backup with an earlier publication timestamp', async () => {
  let at = Date.parse('2026-11-07T10:00:00+08:00');
  let failed = false;
  const quotes = createInvestmentQuotes({ clock: () => at, fetcher: async url => {
    if (url.hostname === TENCENT_HOST) {
      return failed ? new Response(null, { status: 503 }) : new Response(tencent('sz300502', 172, '20261106161400'));
    }
    return response(eastmoney('0.300502', 172, Date.parse('2026-11-06T15:35:00+08:00')));
  } });
  await quotes('300502.SZ');
  failed = true;
  at += 26_000;
  const quote = (await quotes('300502.SZ')).quotes['300502.SZ'];
  assert.equal(quote.source, '东方财富');
  assert.equal(quote.stale, false);
  assert.equal(Date.parse(quote.time), Date.parse('2026-11-06T15:35:00+08:00'));
});

test('deduplicates concurrent reads and reuses the verified quote within its cache lifetime', async () => {
  let requests = 0;
  const quotes = createInvestmentQuotes({ clock: () => now, fetcher: async () => {
    requests++;
    return new Response(tencent('sz300502', 172));
  } });
  const [a, b] = await Promise.all([quotes('300502.SZ'), quotes('sz300502,300502.SZ')]);
  assert.deepEqual(a, b);
  await quotes('300502.SZ');
  assert.equal(requests, 1);
});

test('aborts a stalled primary and reaches the backup within the page request budget', async () => {
  const start = Date.now();
  const quotes = createInvestmentQuotes({ clock: () => now, fetcher: async (url, { signal }) => {
    if (url.hostname !== TENCENT_HOST) return response(eastmoney('0.300502', 172));
    return new Promise((_, reject) => {
      const timer = setTimeout(() => reject(Error('The primary deadline was not enforced')), 6_000);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(signal.reason);
      }, { once: true });
    });
  } });
  assert.equal((await quotes('300502.SZ')).source, '东方财富');
  assert.ok(Date.now() - start < 6000);
});

test('rejects invalid quotes and invalid inputs before they can be used for a position or a goal', async () => {
  let requests = 0;
  const quotes = createInvestmentQuotes({ clock: () => now, fetcher: async url => {
    requests++;
    return url.hostname === TENCENT_HOST
      ? new Response(tencent('sz300502', 999, '20261107150000'))
      : response(eastmoney('0.300502', '-', now), eastmoney('0.688521', 100, now));
  } });
  await assert.rejects(quotes('300502.SZ'), /行情暂不可用/);
  const before = requests;
  await assert.rejects(quotes('http://example.com'), error => error.status === 400);
  await assert.rejects(quotes(Array.from({ length: 25 }, (_, i) => '600' + String(i).padStart(3, '0')).join(',')),
    error => error.status === 400);
  assert.equal(requests, before);
});

test('the private live check requires monitor authentication and can exercise the deployed backup path', async t => {
  const before = process.env.MONITOR_SECRET;
  process.env.MONITOR_SECRET = 'test-monitor-only';
  t.after(() => {
    if (before === undefined) delete process.env.MONITOR_SECRET;
    else process.env.MONITOR_SECRET = before;
  });
  let requests = 0;
  t.mock.method(global, 'fetch', async url => {
    requests++;
    assert.equal(url.hostname, 'push2.eastmoney.com');
    return response(eastmoney('0.300502', 172, Date.now() - 5_000));
  });
  const handler = require('../api/investment-market');
  const invoke = async authorization => {
    let body;
    const res = { statusCode: 0, setHeader() {}, end(value) { body = JSON.parse(value); } };
    await handler({ method: 'POST', headers: { authorization },
      query: { view: 'quote-health', mode: 'fallback', symbols: '300502.SZ' } }, res);
    return { status: res.statusCode, body };
  };
  assert.equal((await invoke('Bearer wrong')).status, 401);
  assert.equal(requests, 0);
  const result = await invoke('Bearer test-monitor-only');
  assert.equal(result.status, 200);
  assert.equal(result.body.quotes['300502.SZ'].source, '东方财富');
  assert.equal(requests, 1);
});
