import assert from 'node:assert/strict';
import test from 'node:test';
import { indexSnapshot, indices, refresh } from '../scripts/update-investment-valuation.mjs';

const beforeHKClose = new Date('2026-11-26T15:50:00+08:00');
const afterClose = new Date('2026-11-26T16:25:00+08:00');
const dates = ['2026-11-24', '2026-11-25', '2026-11-26'];
const valuations = code => dates.map((trdDt, i) => ({
  trdCode: code, trdDt, pETtm: 10 + i, pBLf: 1.25, pETtm10Y: i * 20.123, pBLf10Y: 100 - i,
  pETtmBgn: i * 15.167, pBLfBgn: 55 - i,
}));
const closes = code => dates.map((trdDt, i) => ({ trdCode: code, trdDt, pxClose: 3900 + i }));

test('each market publishes only matching PE, PB and closing observations after its close', () => {
  const code = 'HSI';
  assert.equal(indexSnapshot(code, '恒生指数', valuations(code), closes(code), beforeHKClose).date, dates[1]);
  const mainland = indexSnapshot('000001', '上证指数', valuations('000001'), closes('000001'), beforeHKClose);
  assert.equal(mainland.date, dates[2]);
  const snapshot = indexSnapshot(code, '恒生指数', valuations(code), closes(code), afterClose);
  assert.deepEqual([snapshot.date, snapshot.close, snapshot.pe, snapshot.pb], [dates[2], 3902, 12, 1.25]);
  assert.deepEqual(snapshot.history, [
    [dates[0], 0, 100, 0, 55], [dates[1], 20.12, 99, 15.17, 54], [dates[2], 40.25, 98, 30.33, 53],
  ]);
  assert.equal(indexSnapshot(code, '恒生指数', valuations(code), closes(code).slice(0, 2), afterClose).date, dates[1]);
  const malformed = valuations(code).map((row, i) => i === 2 ? { ...row, pBLf10Y: null } : row);
  assert.equal(indexSnapshot(code, '恒生指数', malformed, closes(code), afterClose).date, dates[1]);
});

test('the full valuation history survives a shorter history of closing levels', () => {
  const code = '000001';
  const recent = valuations(code);
  const old = { ...recent[0], trdDt: '2000-01-04', pETtm10Y: 21, pBLf10Y: 53, pETtmBgn: 65, pBLfBgn: 90 };
  const invalid = { ...old, trdDt: '2000-01-03', pETtm10Y: null };
  const snapshot = indexSnapshot(code, '上证指数', [...recent, old, invalid], closes(code), afterClose);
  assert.deepEqual(snapshot.history[0], ['2000-01-04', 21, 53, 65, 90]);
  assert.equal(snapshot.history.length, recent.length + 1);
  assert.equal(snapshot.history.at(-1)[0], dates[2]);
});

test('missing full-history percentiles are not substituted with ten-year ranks', () => {
  const code = '000300';
  const [first, second, last] = valuations(code);
  const snapshot = indexSnapshot(code, '沪深300', [
    { ...first, pBLfBgn: null }, second, last, { ...last, pETtmBgn: 101 },
  ], closes(code), afterClose);
  assert.equal(snapshot.date, dates[1]);
  assert.deepEqual(snapshot.history, [[dates[0], 0, 100, 0, null], [dates[1], 20.12, 99, 15.17, 54]]);
});

test('refresh appends new observations without losing older published history', async () => {
  const get = (code, kind) => kind === 'eod_price' ? closes(code) : valuations(code);
  const { next: initial } = await refresh([], get, beforeHKClose);
  const previous = initial.map(row => ({ ...row, history: [['2000-01-04', 21, 53], ...row.history] }));
  const { next, warnings } = await refresh(previous, get, afterClose);
  assert.ok(next.every(row => row.history.length === 4));
  assert.ok(next.every(row => row.date === dates[2]));
  for (const row of next) assert.deepEqual(row.history[0], ['2000-01-04', 21, 53]);
  assert.deepEqual(warnings, []);
});

test('refresh is repeatable and retains published dates when a source fails or regresses', async () => {
  const get = (code, kind) => kind === 'eod_price' ? closes(code) : valuations(code);
  const earlier = new Date('2026-11-25T20:00:00+08:00');
  const { next: previous } = await refresh([], get, earlier);
  const { next: updated, warnings } = await refresh(previous, get, afterClose);
  assert.deepEqual(updated.map(row => row.code), indices.map(([code]) => code));
  assert.ok(updated.every(row => row.date === dates[2]));
  assert.deepEqual(warnings, []);
  assert.deepEqual((await refresh(updated, get, afterClose)).next, updated);
  const partial = async (code, kind) => {
    if (code === 'HSI') throw new Error('HTTP 503');
    return code === '000688' ? get(code, kind).slice(0, 2) : get(code, kind);
  };
  const retry = await refresh(updated, partial, afterClose);
  assert.deepEqual(retry.next, updated);
  assert.equal(retry.warnings.length, 2);
  await assert.rejects(refresh([], partial, afterClose), /HSI/);
  await assert.rejects(refresh(updated, () => { throw new Error('upstream offline'); }, afterClose), /upstream offline/);
});
