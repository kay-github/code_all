const { test } = require('node:test');
const assert = require('node:assert/strict');
const trial = require('../lib/sectorRotationTrial');
const { SECTORS } = require('../lib/sectorRotation');
const seed = require('../tools/sector-rotation/trial-opening.json');

function market(through, { blocked = false } = {}) {
  const dates = [];
  for (let i = Date.parse('2026-02-01'); i <= Date.parse(through); i += 86_400_000) {
    const day = new Date(i);
    if (![0, 6].includes(day.getUTCDay())) dates.push(day.toISOString().slice(0, 10));
  }
  const common = dates.map(date => {
    const close = date >= '2026-11-30' ? 0.98 : 1;
    const open = date === '2026-11-30' ? 1 : close;
    return [date, { open, close, volume: 5_000, previousClose: open }];
  });
  const front = Object.fromEntries(SECTORS.map(({ code }) => [code, new Map(common)]));
  const raw = Object.fromEntries(SECTORS.map(({ code }) => [code, new Map(common)]));
  if (blocked) {
    const code = seed.opening.groups.trend.selected[0];
    raw[code].set('2026-11-30', { open: 1.1, close: 0.98, volume: 5_000, previousClose: 1 });
  }
  return { dates, front, raw, adjusted: front };
}

const time = day => new Date(day + 'T17:00:00+08:00');

test('锁定开盘计划，首日使用上一期目标，到第二日开盘才执行新评估', () => {
  const initial = trial.initialState(seed);
  assert.equal(initial.asOf, '2026-11-27');
  assert.equal(initial.days.length, 0);
  const monday = trial.advance(initial, market('2026-12-01'), time('2026-11-30'));
  assert.equal(monday.days.length, 1);
  assert.equal(monday.days[0].groups.trend.execution, 'filled');
  assert.deepEqual(monday.days[0].groups.trend.held, seed.opening.groups.trend.selected);
  assert.equal(monday.days[0].groups.trend.total, -0.0063);
  assert.ok(monday.stress.trend.value < monday.base.trend.value);
  assert.equal(monday.signals.at(-1).date, '2026-11-30');
  assert.deepEqual(monday.signals.at(-1).groups.trend.exited, seed.opening.groups.trend.selected);

  const tuesday = trial.advance(monday, market('2026-12-01'), time('2026-12-01'));
  assert.equal(tuesday.days.length, 2);
  assert.deepEqual(tuesday.days[0], monday.days[0]);
  assert.equal(tuesday.days[1].groups.trend.execution, 'filled');
  assert.deepEqual(tuesday.days[1].groups.trend.held, []);
  assert.ok(tuesday.days[1].groups.trend.total < tuesday.days[0].groups.trend.total);
  assert.equal(initial.days.length, 0);
  assert.equal(trial.published(tuesday, seed).days.length, 2);
});

test('涨停阻挡模拟买单，缺一只行情时保留上一日账本', () => {
  const initial = trial.initialState(seed);
  const blocked = trial.advance(initial, market('2026-11-30', { blocked: true }), time('2026-11-30'));
  assert.equal(blocked.days[0].groups.trend.execution, 'deferred');
  assert.deepEqual(blocked.days[0].groups.trend.held, []);
  assert.equal(blocked.days[0].groups.trend.total, 0);

  const incomplete = market('2026-11-30');
  incomplete.raw[SECTORS[0].code].delete('2026-11-30');
  assert.throws(() => trial.advance(initial, incomplete, time('2026-11-30')), /缺少 2026-11-30/);
  assert.equal(initial.days.length, 0);
});

test('120 个新样本只出一次复核结论，后续记录独立累积', () => {
  const data = market('2027-06-01');
  const cutoff = data.dates.indexOf(trial.SPEC.start) + trial.SPEC.reviewSessions - 1;
  const reviewDay = data.dates[cutoff];
  const review = trial.advance(trial.initialState(seed), data, time(reviewDay));
  const subsequent = trial.advance(review, data, time(data.dates[cutoff + 1]));
  assert.equal(review.days.length, 120);
  assert.equal(review.review.asOf, reviewDay);
  assert.equal(review.review.sessions, 120);
  assert.equal(subsequent.days.length, 121);
  assert.deepEqual(subsequent.review, review.review);
});

test('预启动仅登记计划，首日刷新后同日重试不会重复计费', async () => {
  let row = null;
  const store = {
    read: async () => row,
    async write(path, value, etag) {
      assert.equal(path, trial.PATH);
      assert.equal(etag, row?.etag ?? null);
      row = { value, etag: value.asOf };
    },
  };
  const scheduled = await trial.refresh({
    store, seed, now: time('2026-11-28'), load: async () => assert.fail('预启动不应请求交易日行情'),
  });
  assert.deepEqual(scheduled, { status: 'scheduled', date: '2026-11-27', sessions: 0 });

  const first = await trial.refresh({
    store, seed, now: time('2026-11-30'), load: async () => market('2026-11-30'),
  });
  assert.deepEqual(first, { status: 'published', date: '2026-11-30', sessions: 1 });
  const state = row.value;
  const retry = await trial.refresh({
    store, seed, now: time('2026-11-30'), load: async () => assert.fail('同日已发布'),
  });
  assert.equal(retry.status, 'current');
  assert.equal(row.value, state);
});
