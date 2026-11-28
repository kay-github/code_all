const assert = require('node:assert/strict');
const { test } = require('node:test');
const { CALENDAR, SECTORS, buildSnapshot, completedThrough, parseKlines, refreshStoredSnapshot } = require('../lib/sectorRotation');

function buildSeries() {
  const dates = [];
  for (let date = new Date('2026-04-01'); date <= new Date('2026-11-17'); date.setUTCDate(date.getUTCDate() + 1)) {
    const day = date.toISOString().slice(0, 10);
    if (![0, 6].includes(date.getUTCDay()) && day !== '2026-11-16') dates.push(day);
  }
  const series = Object.fromEntries(SECTORS.map(({ code }, i) => [code, new Map(dates.map((date, j) => {
    const rate = date === '2026-11-17' && i === 9 ? 0.08 : (10 - i) / 10_000;
    const close = 1 + j / 10_000;
    return [date, { open: close / (1 + rate), close }];
  }))]));
  return { ...series, [CALENDAR]: new Map(dates.map(date => [date, { open: 1, close: 1 }])) };
}

test('收盘轮动使用双周首个开市日，次日行情到齐后给出模拟调仓日期', () => {
  const series = buildSeries();
  const before = buildSnapshot(series, new Date('2026-11-17T15:00:00+08:00'));
  assert.equal(before.asOf, '2026-11-13');
  const after = buildSnapshot(series, new Date('2026-11-17T16:43:00+08:00'));
  assert.equal(after.latest.signalDate, '2026-11-17');
  assert.equal(after.latest.referenceDate, null);
  assert.deepEqual(after.latest.entered, [SECTORS[9].code]);
  assert.equal(after.latest.exited.length, 1);
  assert.equal(after.current.filter(row => ['enter', 'hold'].includes(row.signal)).length, 5);
  assert.equal(after.backtest.end, '2026-11-17');
  const prices = series[SECTORS[0].code];
  const daily = prices.get(after.asOf).close / prices.get(before.asOf).close;
  const net = (1 + after.backtest.strategy.total) / (1 + before.backtest.strategy.total);
  assert.ok(Math.abs(net - daily) < 0.000002);
  assert.equal(completedThrough(new Date('2026-11-17T15:14:59+08:00')), '2026-11-16');
});

test('行情口径拒绝缺失、重复或非正价格', () => {
  const code = SECTORS[0].code;
  const through = '2026-11-17';
  const one = '2026-11-17,1.23,1.25';
  const data = klines => ({ data: { code, klines } });
  assert.deepEqual([...parseKlines(data([one, '2026-11-18,1.24,1.28']), code, through)], [
    [through, { open: 1.23, close: 1.25 }],
  ]);
  assert.throws(() => parseKlines(data([one, one]), code, through), /日线无效/);
  assert.throws(() => parseKlines(data(['2026-11-17,0,1.25']), code, through), /日线无效/);
  const series = buildSeries();
  series[code].delete(through);
  assert.throws(() => buildSnapshot(series, new Date('2026-11-17T16:43:00+08:00')), /交易日历不一致/);
});

test('刷新只向前推进，发生写入竞争时读取已发布快照', async () => {
  const seed = { asOf: '2026-11-13' };
  const now = new Date('2026-11-17T16:43:00+08:00');
  const snapshot = { asOf: '2026-11-17' };
  let row = { value: seed, etag: 'old' };
  let writes = 0;
  const store = {
    read: async () => row,
    async write(path, value, etag) {
      writes++;
      assert.equal(etag, 'old');
      assert.equal(value, snapshot);
      row = { value, etag: 'new' };
      throw new Error('conflict');
    },
    isConflict: error => error.message === 'conflict',
  };
  await assert.rejects(refreshStoredSnapshot({ store, seed, now, load: async () => ({ asOf: '2026-11-12' }) }), /早于发布快照/);
  assert.equal(writes, 0);
  assert.deepEqual(await refreshStoredSnapshot({ store, seed, now, load: async () => snapshot }), { status: 'unchanged', date: snapshot.asOf });
  assert.equal(writes, 1);
  assert.deepEqual(await refreshStoredSnapshot({
    store, seed, now, load: async () => { throw new Error('已有当日数据时不调用行情源'); },
  }), { status: 'current', date: snapshot.asOf });
});
