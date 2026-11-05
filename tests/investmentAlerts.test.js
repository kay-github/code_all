const test = require('node:test');
const assert = require('node:assert/strict');
const { runGoalAlerts, matchesImport } = require('../lib/investmentAlerts');

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
