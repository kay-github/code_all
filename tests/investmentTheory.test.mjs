import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, instrument, validateState, replay, evaluateGoals } from '../tools/investment-theory/model.mjs';

const symbol = '300502.SZ';
const row = (id, type, extras) => ({ id, type, date: '2026-11-05', bucket: 'core', symbol, ...extras });

test('investment ledger replays opening cost, weighted sales, cash, split and dividends', () => {
  const trades = [
    row('1', 'deposit', { amount: 10000 }),
    row('2', 'opening', { qty: 100, price: 10, fee: 5 }),
    row('3', 'buy', { qty: 100, price: 20, fee: 10 }),
    row('4', 'adjustment', { qty: 200 }),
    row('5', 'sell', { qty: 100, price: 12, fee: 4 }),
    row('6', 'dividend', { amount: 50 }),
    row('7', 'opening', { bucket: 'flex', qty: 1, price: 0 }),
  ];
  const result = replay(validateState({ ...initialState(), trades }).trades);
  assert.equal(result.cash, 923600);
  assert.equal(result.realized, 49225);
  assert.deepEqual(result.positions, [
    { symbol, bucket: 'core', qty: 300, cost: 226125 },
    { symbol, bucket: 'flex', qty: 1, cost: 0 },
  ]);
  assert.throws(() => validateState({ ...initialState(), trades: trades.filter(row => row.id !== '3' && row.id !== '2') }));
  assert.throws(() => validateState({ ...initialState(), trades: [...trades, row('8', 'sell', { qty: 301, price: 1 })] }), /超过/);
  assert.throws(() => validateState({ ...initialState(), allocation: [{ name: 'A', target: 50 }, { name: 'B', target: 30 }, { name: 'C', target: 21 }] }), /100%/);
});

test('investment conditions distinguish indices, fire once per crossing, and reject stale quotes', () => {
  assert.equal(instrument('sh510300'), '510300.SH');
  assert.equal(instrument('159915'), '159915.SZ');
  assert.equal(instrument('000001.SH', true), '000001.SH');
  assert.equal(instrument('000001'), '000001.SZ');
  assert.throws(() => instrument('000001', true));
  const now = Date.parse('2026-11-05T10:05:00+08:00');
  const time = '2026-11-05T10:00:00+08:00';
  const [rule] = validateState({ ...initialState(), goals: [
    { id: '1', horizon: '短期', title: '指数观察', symbol: '000001.SH', index: true, metric: 'price', operator: '>=', threshold: 4000 },
  ] }).goals;
  const key = 'index:000001.SH';
  const [triggered] = evaluateGoals([rule], { [key]: { price: 4010, time } }, now);
  assert.deepEqual(triggered.hit, { time, value: 4010 });
  assert.equal(evaluateGoals([triggered], { [key]: { price: 4050, time } }, now)[0].hit, triggered.hit);
  const [cleared] = evaluateGoals([triggered], { [key]: { price: 3999, time } }, now);
  assert.equal(cleared.matched, false);
  assert.equal(evaluateGoals([cleared], { [key]: { price: 4100, time } }, now)[0].hit.value, 4100);
  assert.equal(evaluateGoals([rule], { [key]: { price: 4050, time } }, now + 900_000)[0].hit, null);
  assert.equal(evaluateGoals([rule], { [key]: { price: 4050, time, suspended: true } }, now)[0].hit, null);
});
