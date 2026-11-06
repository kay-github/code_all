const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSeries, parseReference, publicSnapshot, refreshCrowding } = require('../lib/investmentCrowding');

const now = Date.parse('2026-11-06T18:00:00+08:00');
const dates = Array.from({ length: 122 }, (_, index) =>
  new Date(Date.UTC(2026, 10, 6 - (121 - index))).toISOString().slice(0, 10));
const loadReference = async () => new Map();

function memoryStore() {
  let value;
  return {
    read: async () => value && { value, etag: 'v1' },
    write: async (_, next) => { value = next; },
    isConflict: () => false,
  };
}

function history({ through, missing, gap } = {}) {
  return async (code, to) => new Map(dates.filter(date => date <= to && (!through || date <= through))
    .filter(date => !(code === missing && date === '2026-11-06') && !(code === gap && date === dates[25]))
    .map((date, index) => [date, code === '801003' ? 1000 : code === '801780' ? 10 + index : 20]));
}

test('accepts only dated official turnover from the requested index', () => {
  const row = { swindexcode: '801780', bargaindate: '2026-11-06', bargainsum: 354.36, bargainamount: 42.89 };
  assert.equal(parseSeries({ data: [row] }, '801780', '2026-11-06').get(row.bargaindate), 354.36);
  assert.throws(() => parseSeries({ data: [row, row] }, '801780', '2026-11-06'), /成交额或交易日无效/);
  assert.throws(() => parseSeries({ data: [row] }, '801770', '2026-11-06'), /成交额或交易日无效/);
  assert.throws(() => parseSeries({ data: [{ ...row, bargainsum: null }] }, '801780', '2026-11-06'), /成交额或交易日无效/);
});

test('uses the index turnover in yuan and validates the quote identity', () => {
  const payload = { data: { code: '000922', market: 1, klines: ['2026-11-06,1,2,3,4,5,61892149977.00'] } };
  assert.equal(parseReference(payload, '1.000922', '2026-11-06', '2026-11-01').get('2026-11-06'), 618.92149977);
  assert.throws(() => parseReference(payload, '2.000922', '2026-11-06', '2026-11-01'), /缺少指数日线/);
});

test('sums baskets on matching sessions and computes direction-specific metrics', async () => {
  const store = memoryStore();
  const result = await refreshCrowding({ store, load: history({ gap: '801770' }), loadReference, now });
  assert.deepEqual(result, { status: 'published', date: '2026-11-06', sessions: 121 });
  const snapshot = publicSnapshot((await store.read()).value, now);
  assert.equal(snapshot.items.tmt.share, 8);
  assert.equal(snapshot.items.communication.share, 2);
  assert.equal(snapshot.items.tmt.percentile, null);
  assert.equal(snapshot.items.bank.percentile, 100);
  assert.ok(Math.abs(snapshot.items.bank.change5 - 0.5) < 0.0001);
  assert.equal(snapshot.history.length, 20);
  assert.equal(snapshot.history.at(-1).date, snapshot.date);
});

test('keeps the previous date if the upstream rolls over before a sector is available', async () => {
  const store = memoryStore();
  await refreshCrowding({ store, load: history({ through: '2026-11-05' }), loadReference, now });
  assert.deepEqual(await refreshCrowding({ store, load: history({ missing: '801770' }), loadReference, now }),
    { status: 'waiting', date: '2026-11-05' });
  const snapshot = publicSnapshot((await store.read()).value, now);
  assert.equal(snapshot.status, 'waiting');
  assert.equal(snapshot.date, '2026-11-05');
  assert.equal(snapshot.items.communication.share, 2);
});

test('a late supplemental index can fill the same day without delaying the official board', async () => {
  const store = memoryStore();
  const first = { store, load: history(), loadReference, now };
  await refreshCrowding(first);
  const snapshot = () => store.read().then(({ value }) => publicSnapshot(value, now));
  assert.equal((await snapshot()).items.dividend.share, null);
  await refreshCrowding({ ...first,
    load: () => { throw Error('Official series should already be cached'); },
    loadReference: async () => new Map(dates.map(date => [date, 50])),
  });
  assert.deepEqual((await snapshot()).items.dividend, { share: 5, change5: 0, percentile: 50 });
});
