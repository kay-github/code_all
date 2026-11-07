const test = require('node:test');
const assert = require('node:assert/strict');
const { CONFIG, runGoalAlerts, matchesImport, goalAlertsForAccount } = require('../lib/investmentAlerts');
const { createInvestmentQuotes, TENCENT_HOST } = require('../lib/investmentQuotes');

function memory() {
  let row;
  let rev = 0;
  return {
    read: async () => structuredClone(row),
    async write(_, value, etag) {
      if ((row?.etag ?? null) !== etag) throw Object.assign(Error('Conflict'), { code: 'conflict' });
      row = { value: structuredClone(value), etag: String(++rev) };
    },
    isConflict: error => error.code === 'conflict',
  };
}
const now = Date.parse('2026-11-05T10:01:00+08:00');
const time = '2026-11-05T10:00:00+08:00';
const config = {
  alertIds: ['short'],
  goals: [
    { id: 'short', title: '目标 <例>', note: '利润假设', symbol: '300502.SZ', horizon: '短期', metric: 'marketCap', operator: '>=', threshold: 2700 },
    { id: 'mid', title: '中期目标', symbol: '399006.SZ', index: true, horizon: '中期', metric: 'price', operator: '>=', threshold: 2866 },
  ],
};

test('badge rules disclose only the signed-in owner’s enabled conditions', () => {
  const owned = { ...config, ownerId: 'owner' };
  assert.deepEqual(goalAlertsForAccount(owned, 'another'), []);
  assert.deepEqual(goalAlertsForAccount(owned), []);
  assert.deepEqual(goalAlertsForAccount(config, 'owner'), []);
  assert.deepEqual(goalAlertsForAccount(owned, 'owner'), [
    { id: 'short', symbol: '300502.SZ', index: false, metric: 'marketCap', operator: '>=', threshold: 2700 },
  ]);
});

test('reminders evaluate only subscribed rules and send a single concise HTML card', async () => {
  const store = memory();
  const quotes = async keys => {
    assert.equal(keys, '300502.SZ');
    return { quotes: { '300502.SZ': { marketCap: 2701, time } } };
  };
  let sends = 0;
  const send = async payload => {
    sends++;
    assert.equal(payload.template, 'html');
    assert.match(payload.content, /目标 &lt;例&gt;/);
    assert.match(payload.content, /2,701/);
    return { serial: 'fixture' };
  };
  const input = { store, config, quotes, send, now };
  assert.equal((await runGoalAlerts({ ...input, dryRun: true })).matched, 1);
  assert.equal(sends, 0);
  await Promise.all([runGoalAlerts(input), runGoalAlerts(input)]);
  assert.equal(sends, 1);
  assert.equal((await runGoalAlerts(input)).sent, 0);
});

test('old, suspended or below-target quotes do not send and invalid import access fails closed', async () => {
  for (const quote of [
    { marketCap: 2699, time }, { marketCap: 2700, time, stale: true },
    { marketCap: 2700, time, suspended: true }, { marketCap: 2700, time: '2026-11-04T10:00:00+08:00' },
  ]) {
    const stats = await runGoalAlerts({ store: memory(), config, now,
      quotes: async () => ({ quotes: { '300502.SZ': quote } }), send: () => assert.fail('unexpected push') });
    assert.equal(stats.matched, 0);
  }
  assert.equal(matchesImport('f'.repeat(48), null, now), false);
});

test('evaluates and sends backup-source hits, then retries missing targets without repeating sent cards', async () => {
  const store = memory();
  let at = now;
  let complete = false;
  const quotes = createInvestmentQuotes({ clock: () => at, fetcher: async (url) => {
    if (url.hostname === TENCENT_HOST) return new Response(null, { status: 503 });
    const stock = { f2: 180, f3: 1, f5: 100, f9: 15, f12: '300502', f13: 0, f14: '示例股',
      f20: 2701 * 1e8, f124: Date.parse(time) / 1000 };
    const index = { ...stock, f2: 2866, f12: '399006', f14: '创业板指' };
    return Response.json({ data: { diff: complete ? [stock, index] : [stock] } });
  } });
  const { evaluateGoals } = await import('../tools/investment-theory/model.mjs');
  const result = await quotes('300502.SZ,index:399006.SZ');
  assert.equal(evaluateGoals(config.goals, result.quotes, now)[0].hit.value, 2701);
  const cards = [];
  const input = { store, config: { ...config, alertIds: ['short', 'mid'] }, quotes,
    send: async ({ content }) => { cards.push(content); return { serial: 'fixture' }; } };

  const first = await runGoalAlerts({ ...input, now });
  assert.deepEqual(first, { monitored: 2, quotes: 1, sources: { 东方财富: 1 }, unchecked: 1, matched: 1, sent: 1 });
  assert.match(cards[0], /东方财富（备用）/);

  complete = true;
  at += 31_000;
  const second = await runGoalAlerts({ ...input, now: at });
  assert.equal(second.unchecked, 0);
  assert.equal(second.sent, 1);
  assert.match(cards[1], /中期目标/);
  assert.doesNotMatch(cards[1], /目标 &lt;例&gt;/);
  assert.equal((await runGoalAlerts({ ...input, now: at })).sent, 0);
});

test('unavailable metrics and cached quotes remain unchecked, while halted and negative PE quotes do not alert', async () => {
  const pe = { ...config.goals[0], metric: 'peTTM', operator: '<=', threshold: 15 };
  for (const [quote, unchecked] of [
    [{ time }, 1], [{ time, peTTM: 10, stale: true }, 1],
    [{ time, suspended: true }, 0], [{ time, peTTM: -10 }, 0],
  ]) {
    const stats = await runGoalAlerts({ store: memory(), config: { ...config, goals: [pe] }, now,
      quotes: async () => ({ quotes: { '300502.SZ': quote } }), send: () => assert.fail('unexpected push') });
    assert.equal(stats.unchecked, unchecked);
    assert.equal(stats.matched, 0);
  }
});

test('delayed schedules can check same-day closing quotes but cannot use an older intraday or prior-day reading', async () => {
  const late = Date.parse('2026-11-05T22:40:00+08:00');
  const cases = [
    ['2026-11-05T15:08:00+08:00', late, 1],
    ['2026-11-05T14:55:00+08:00', late, 0],
    ['2026-11-05T15:08:00+08:00', late + 86400_000, 0],
  ];
  for (const [time, now, matched] of cases) {
    const stats = await runGoalAlerts({ store: memory(), config, now, dryRun: true,
      quotes: async () => ({ quotes: { '300502.SZ': { marketCap: 2701, time } } }),
      send: () => assert.fail('unexpected push') });
    assert.equal(stats.matched, matched);
  }
});

test('scheduled checks report partial coverage as retryable while the backup drill stays read-only', async t => {
  const previous = { MONITOR_SECRET: process.env.MONITOR_SECRET, PUSHPLUS_TOKEN: process.env.PUSHPLUS_TOKEN };
  process.env.MONITOR_SECRET = 'fixture-monitor';
  process.env.PUSHPLUS_TOKEN = 'fixture-pushplus';
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const storage = require('../lib/gridStore');
  t.mock.method(storage, 'read', async path => {
    assert.equal(path, CONFIG);
    return { value: { ...config, alertIds: ['short', 'mid'] } };
  });
  t.mock.method(storage, 'write', () => assert.fail('unexpected storage write'));
  t.mock.method(global, 'fetch', async url => {
    if (url.hostname === TENCENT_HOST) return new Response(null, { status: 503 });
    assert.equal(url.hostname, 'push2.eastmoney.com');
    const row = { f2: 180, f3: 1, f5: 100, f9: 15, f12: '300502', f13: 0, f14: '示例股',
      f20: 2600 * 1e8, f124: Math.floor(Date.now() / 1000) };
    return Response.json({ data: { diff: [row] } });
  });
  const handler = require('../api/investment-market');
  const invoke = async query => {
    let body;
    const res = { statusCode: 0, setHeader() {}, end(value) { body = JSON.parse(value); } };
    await handler({ method: 'POST', headers: { authorization: 'Bearer fixture-monitor' },
      query: { view: 'goal-alerts', ...query } }, res);
    return { status: res.statusCode, body };
  };
  const scheduled = await invoke({});
  assert.equal(scheduled.status, 503);
  assert.equal(scheduled.body.unchecked, 1);
  assert.equal(scheduled.body.sent, 0);
  const dryRun = await invoke({ dryRun: '1', mode: 'fallback' });
  assert.equal(dryRun.status, 200);
  assert.deepEqual(dryRun.body.sources, { 东方财富: 1 });
  assert.equal(dryRun.body.sent, 0);
});
