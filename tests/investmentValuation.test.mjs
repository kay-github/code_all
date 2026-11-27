import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { indexSnapshot, indices, refresh, refreshStoredValuations, valuationPath, valuationSnapshot } from '../lib/investmentValuation.mjs';

const require = createRequire(import.meta.url);
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
    [dates[0], 0, 100, 0, 55, 10, 1.25], [dates[1], 20.12, 99, 15.17, 54, 11, 1.25],
    [dates[2], 40.25, 98, 30.33, 53, 12, 1.25],
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
  assert.deepEqual(snapshot.history[0], ['2000-01-04', 21, 53, 65, 90, 10, 1.25]);
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
  assert.deepEqual(snapshot.history, [[dates[0], 0, 100, 0, null, 10, 1.25], [dates[1], 20.12, 99, 15.17, 54, 11, 1.25]]);
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

test('the cloud job records a delayed source then publishes matching valuations when available', async () => {
  const previous = (await refresh([], (code, kind) => (kind === 'eod_price' ? closes(code) : valuations(code)).slice(0, 2),
    new Date('2026-11-25T20:00:00+08:00'))).next;
  const fallback = { indices: previous };
  let record;
  let writes = 0;
  const store = {
    async read(path) {
      assert.equal(path, valuationPath);
      return record;
    },
    async write(path, value, etag) {
      assert.equal(path, valuationPath);
      assert.equal(etag, record?.etag ?? null);
      record = { value, etag: String(++writes) };
    },
  };
  let published = false;
  let conditionalHits = 0;
  let valuationLoads = 0;
  const load = async (code, kind, request) => {
    if (kind === 'eod_price') return closes(code);
    valuationLoads++;
    const etag = published ? 'new' : 'old';
    if (request.etag === etag) {
      conditionalHits++;
      return null;
    }
    request.onETag(etag);
    return published ? valuations(code) : valuations(code).slice(0, 2);
  };
  const waiting = await refreshStoredValuations(store, fallback, load, afterClose);
  assert.ok(waiting.indices.every(row => row.date === dates[1] && row.closeDate === dates[2]));
  assert.equal(writes, 1);
  assert.equal((await refreshStoredValuations(store, fallback, load, afterClose)).changed, false);
  assert.equal(conditionalHits, indices.length);
  published = true;
  const updated = await refreshStoredValuations(store, fallback, load, afterClose);
  assert.ok(updated.indices.every(row => row.date === dates[2] && row.closeDate === dates[2]));
  assert.equal(writes, 2);
  assert.equal((await refreshStoredValuations(store, fallback, load, afterClose)).changed, false);
  assert.equal(valuationLoads, 3 * indices.length);
  assert.ok(valuationSnapshot(fallback, record.value).indices.every(row => row.history.length === 3));
  assert.ok(valuationSnapshot(record.value, fallback).indices.every(row => row.date === dates[2]));
});

test('the public endpoint supports conditional GET and keeps refresh authenticated', async t => {
  const store = require('../lib/gridStore');
  const handler = require('../api/investment-market');
  t.mock.method(store, 'read', async () => null);
  const request = async (method, headers = {}) => {
    const response = {
      headers: {}, body: undefined,
      setHeader(key, value) { this.headers[key] = value; },
      end(body) { this.body = body; },
    };
    await handler({ method, headers, query: { view: 'valuations', scheduled: '1' } }, response);
    return response;
  };
  const first = await request('GET');
  assert.equal(first.statusCode, 200);
  assert.equal(JSON.parse(first.body).indices.length, indices.length);
  const cached = await request('GET', { 'if-none-match': 'W/' + first.headers.ETag });
  assert.equal(cached.statusCode, 304);
  assert.equal(cached.body, undefined);
  assert.equal((await request('POST')).statusCode, 401);
});

test('older cloud snapshots acquire historical multiples even when the trading date is unchanged', async () => {
  const load = (code, kind, request) => {
    if (kind === 'eod_price') return closes(code);
    assert.equal(request.etag, undefined);
    request.onETag('same-provider-file');
    return valuations(code);
  };
  const full = { indices: (await refresh([], load, afterClose)).next };
  const legacy = {
    indices: full.indices.map(row => ({ ...row, history: row.history.map(point => point.slice(0, 5)) })),
    closeDates: Object.fromEntries(indices.map(([code]) => [code, dates[2]])),
    etags: Object.fromEntries(indices.map(([code]) => [code, 'same-provider-file'])),
  };
  assert.equal(valuationSnapshot(full, legacy).indices[0], full.indices[0]);
  let record = { value: legacy, etag: 'saved-revision' };
  const store = {
    read: async () => record,
    write: async (_path, value, etag) => {
      assert.equal(etag, 'saved-revision');
      record = { value, etag: 'updated-revision' };
    },
  };
  const result = await refreshStoredValuations(store, legacy, load, afterClose);
  assert.equal(result.changed, true);
  assert.deepEqual(record.value.indices, full.indices);
  assert.deepEqual(record.value.closeDates, legacy.closeDates);
});
