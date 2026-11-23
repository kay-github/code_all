import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateWeeks, buildStudy } from './stock-study.mjs';

const bar = (day, high, low, close = low) => [day, close, high, low, close];
const points = [
  bar('2026-09-18', 200, 194, 198), bar('2026-09-25', 150, 120),
  bar('2026-10-02', 165, 155), bar('2026-10-09', 105, 86),
  bar('2026-10-16', 116, 105), bar('2026-10-23', 96, 80),
];
const anchors = points.map(x => x[0]);
const spec = { main: anchors.slice(0, 3), alt: anchors.slice(0, 5), watch: anchors[4], reason: 'Fixture' };
const item = { symbol: 'sz300308', name: '测试标的', track: true, day: spec, week: spec };

test('weekly candles keep the actual extreme date and exclude an unfinished week', () => {
  const history = [bar('2026-11-16', 100, 90), bar('2026-11-19', 120, 85), bar('2026-11-20', 110, 80), bar('2026-11-23', 300, 1)];
  const weeks = aggregateWeeks(history);
  assert.equal(weeks.length, 1);
  assert.deepEqual(weeks[0].bar, ['2026-11-20', 90, 120, 80, 80]);
  assert.equal(weeks[0].highOn, '2026-11-19');
  assert.equal(weeks[0].lowOn, '2026-11-20');
});

test('ABC and ordinary five are concurrent hypotheses; wave 5 invalidates when 3 becomes shortest', () => {
  const result = buildStudy(item, points, '2026-10-23');
  assert.equal(result.week.main.ratio, 1.0625);
  assert.match(result.week.main.progress, /C浪延伸/);
  assert.equal(result.day.alt.ratio, 0.9875);
  assert.equal(result.day.alt.shortestLine, 37);
  assert.deepEqual(result.day.alt.invalid, []);
  const breach = [...points, bar('2026-10-30', 80, 32)];
  const later = buildStudy(item, breach, '2026-10-30');
  assert.match(later.week.alt.invalid.join(' '), /3浪短于/);
  assert.match(later.week.main.progress, /C浪延伸/);
});

test('two closes above the anchor confirm a low candidate, and a new low retires it', () => {
  const ended = [...points, bar('2026-10-30', 119, 97, 118), bar('2026-11-06', 121, 108, 120)];
  const after = buildStudy(item, ended, '2026-11-06');
  assert.equal(after.week.main.verifiedOn, '2026-11-06');
  const lower = [...ended, bar('2026-11-13', 103, 75)];
  const next = buildStudy(item, lower, '2026-11-13');
  assert.equal(next.week.main.verifiedOn, null);
  assert.equal(next.week.main.floor, 75);
});
