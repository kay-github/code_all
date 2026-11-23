import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, impulseChecks, parseCsv, confirmedPivots, validateBars } from '../../tools/wave-tracker/scenarios.mjs';

const day = n => new Date(Date.UTC(2025, 0, 1 + n)).toISOString().slice(0, 10);
const row = (i, price) => [day(i), price, price + 0.2, price - 0.2, price];
const p = (index, price, kind) => ({ index, date: day(index), price, kind, confirmed: day(index + 1) });

test('pivot confirmation is causal and never assigned to the extreme date', () => {
  const bars = Array.from({ length: 75 }, (_, i) => row(i, 100 + Math.sin(i / 5) * 20));
  const full = confirmedPivots(bars);
  assert.ok(full.length > 2);
  for (let i = 20; i < bars.length; i++) {
    assert.deepEqual(confirmedPivots(bars.slice(0, i + 1)), full.filter(point => point.confirmed <= day(i)));
  }
  assert.ok(full.every(point => point.date < point.confirmed));
});

test('hard impulse rules are symmetric, distinguish extension and permit a truncated fifth', () => {
  const prices = values => values.map(price => ({ price }));
  assert.deepEqual(impulseChecks(prices([100, 80, 90, 65, 77, 67]), 'down'), []);
  assert.deepEqual(impulseChecks(prices([100, 120, 110, 135, 123, 133]), 'up'), []);
  assert.ok(impulseChecks(prices([100, 80, 90, 78, 81, 61]), 'down').includes('第4浪进入第1浪区间'));
  assert.ok(impulseChecks(prices([100, 80, 90, 78, 79, 60]), 'down').includes('第3浪短于第1浪与第5浪'));
  assert.deepEqual(impulseChecks(prices([100, 80, 105]), 'down'), ['第2浪越过第1浪起点']);
});

test('A/B projection uses price length, B extension and completed fifth are independent of ABC feasibility', () => {
  const bars = Array.from({ length: 22 }, (_, i) => row(i, [100, 80, 90, 65, 77, 67][i] ?? 71));
  const pivots = [p(3, 65, 'low'), p(4, 77, 'high'), p(5, 67, 'low')];
  const r = evaluate(bars, { dates: [day(0), day(1), day(2)], pivots });
  assert.equal(r.impulseStatus, 'truncated');
  assert.equal(r.c.date, day(3));
  const one = r.cLevels.find(level => level.ratio === 1);
  assert.ok(Math.abs(one.price - 69.8) < 1e-9);
  assert.ok(r.impulseRatio < 1.618);
  assert.equal(r.invalid.length, 0);
});

test('reversed or nonpositive bars and dates later than imported data are rejected', () => {
  const bars = Array.from({ length: 22 }, (_, i) => row(i, 55));
  assert.throws(() => validateBars(bars.toReversed()), /排序/);
  assert.throws(() => evaluate(bars, { dates: [day(0), day(1), day(25)] }), /不在/);
  assert.throws(() => parseCsv('date,open,high,close,low\n2025-04-03,10,11,9,5'), /首行/);
  const csv = '\uFEFFdate,open,high,low,close\r\n' + bars.map(row => row.join(',')).join('\r\n');
  assert.deepEqual(parseCsv(csv), bars);
});


test('an unfolding fifth survives a newer three-pivot subcount', () => {
  const values = [110, 91, 101, 73, 88, 69, 72];
  const bars = Array.from({ length: 22 }, (_, i) => row(i, values[i - 14] ?? 72));
  const pivots = values.slice(0, 6).map((price, i) => p(14 + i, price, i % 2 ? 'low' : 'high'));
  const result = evaluate(bars, { pivots });
  assert.equal(result.fixed[0].date, day(14));
  assert.equal(result.impulseStatus, 'five');
  assert.equal(result.impulse.at(-1).price, 69);
  assert.ok(result.alternatives.length);
});
