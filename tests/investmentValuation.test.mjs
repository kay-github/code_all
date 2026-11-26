import assert from 'node:assert/strict';
import test from 'node:test';
import { indexSnapshot, indices, refresh } from '../scripts/update-investment-valuation.mjs';

const beforeHKClose = new Date('2026-11-26T15:50:00+08:00');
const afterClose = new Date('2026-11-26T16:25:00+08:00');
const dates = ['2026-11-24', '2026-11-25', '2026-11-26'];
const valuations = code => dates.map((trdDt, i) => ({
  trdCode: code, trdDt, pETtm: 10 + i, pBLf: 1.25, pETtm10Y: i * 20.123, pBLf10Y: 100 - i,
}));
const closes = code => dates.map((trdDt, i) => ({ trdCode: code, trdDt, pxClose: 3900 + i }));

test('each market publishes only matching PE, PB and closing observations after its close', () => {
  const code = 'HSI';
  assert.equal(indexSnapshot(code, '恒生指数', valuations(code), closes(code), beforeHKClose).date, dates[1]);
  const mainland = indexSnapshot('000001', '上证指数', valuations('000001'), closes('000001'), beforeHKClose);
  assert.equal(mainland.date, dates[2]);
  const snapshot = indexSnapshot(code, '恒生指数', valuations(code), closes(code), afterClose);
  assert.deepEqual([snapshot.date, snapshot.close, snapshot.pe, snapshot.pb], [dates[2], 3902, 12, 1.25]);
  assert.deepEqual(snapshot.history, [[dates[0], 0, 100], [dates[1], 20.12, 99], [dates[2], 40.25, 98]]);
  assert.equal(indexSnapshot(code, '恒生指数', valuations(code), closes(code).slice(0, 2), afterClose).date, dates[1]);
  const malformed = valuations(code).map((row, i) => i === 2 ? { ...row, pBLf10Y: null } : row);
  assert.equal(indexSnapshot(code, '恒生指数', malformed, closes(code), afterClose).date, dates[1]);
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
