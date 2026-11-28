import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { indexSnapshot, indices, publishedValuationSnapshot, refresh, refreshStoredValuations, valuationPath, valuationSnapshot } from '../lib/investmentValuation.mjs';
import { auditIndexHubValuations } from '../lib/investmentValuationAudit.mjs';
import { packValuations, unpackValuations, valuationEncoding } from '../tools/investment-theory/valuation-codec.mjs';

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
  const waiting = await refreshStoredValuations(store, fallback, load, afterClose, async snapshot => {
    assert.ok(snapshot.indices.every(row => row.date === dates[1] && snapshot.closeDates[row.code] === dates[2]));
    return { status: 'checked' };
  });
  assert.ok(waiting.indices.every(row => row.date === dates[1] && row.closeDate === dates[2]));
  assert.equal(waiting.backup.status, 'checked');
  assert.equal(waiting.backup.rollout.enabledAt, null);
  assert.equal(record.value.backup, undefined);
  assert.equal(writes, 1);
  const auditFailure = await refreshStoredValuations(store, fallback, load, afterClose, async () => {
    throw new Error('audit fixture failure');
  });
  assert.equal(auditFailure.changed, false);
  assert.equal(auditFailure.backup.status, 'audit_failed');
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

test('Index Hub audits same-day coverage and six values against five published sessions per index', async () => {
  const sample = ['2026-11-19', '2026-11-20', '2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26'];
  const codes = ['000300', 'HSI', '399006', '000688'];
  const items = sample.map((trdDt, i) => ({
    trdDt, pETtm: 10 + i, pBLf: 1.25, pETtm10Y: 60.123, pBLf10Y: 40,
    pETtmBgn: 20, pBLfBgn: 0,
  }));
  const reference = {
    indices: codes.map(code => ({
      code, date: sample[4], history: sample.slice(0, 5).map((date, i) => [date, 60.12, 40, 20, 0, 10 + i, 1.25]),
    })),
    closeDates: { '000300': sample[5], HSI: sample[4], '399006': sample[5], '000688': sample[5] },
  };
  const report = await auditIndexHubValuations(reference, 'fixture-key', async (url, request) => {
    assert.equal(url.origin, 'https://www.etf.com.cn');
    assert.equal(url.pathname, '/api/etf-api-service/skill/v3/index/valuation/history');
    assert.deepEqual(Object.fromEntries(url.searchParams),
      { indexCodes: codes.join(','), beginDate: sample[0], endDate: sample[5] });
    assert.equal(request.headers.Authorization, 'Bearer fixture-key');
    assert.equal(request.headers['X-Caller-Type'], 'external');
    assert.equal(request.redirect, 'error');
    return Response.json({ success: true, data: [
      { trdCode: '000300', items: [...items].reverse() },
      { trdCode: 'HSI', items },
      { trdCode: '399006', items: items.map((row, i) => i === 4 ? { ...row, pETtmBgn: 21 } : row) },
      { trdCode: '000688', items: [...items.slice(0, 4), { ...items[5], pBLfBgn: null }] },
    ] });
  });
  assert.equal(report.status, 'checked');
  assert.ok(Number.isFinite(Date.parse(report.checkedAt)));
  assert.deepEqual(report.indices.map(row => [row.code, row.status, row.officialDate, row.matchedDays]), [
    ['000300', 'ahead', sample[5], 5],
    ['HSI', 'aligned', sample[4], 5],
    ['399006', 'mismatch', sample[5], 4],
    ['000688', 'insufficient_overlap', sample[3], 4],
  ]);
  assert.deepEqual(report.indices[2].mismatch, { day: sample[4], fields: ['pETtmBgn'] });
  assert.deepEqual(await auditIndexHubValuations(reference, 'fixture-key', async () =>
    Response.json({ success: false, message: 'authentication failed' })), { status: 'upstream_rejected' });
  assert.deepEqual(await auditIndexHubValuations(reference, 'fixture-key', async () => {
    throw new Error('upstream timeout');
  }), { status: 'request_failed' });
});

test('the trial requires all eight mainland indices to lead on November 30 and match all six values before enabling', async () => {
  const tradingDays = ['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27',
    '2026-11-30', '2026-12-01', '2026-12-02'];
  const [friday, trial, tuesday, wednesday] = tradingDays.slice(-4);
  const codes = indices.map(([code]) => code);
  const mainland = codes.filter(code => code !== 'HSI');
  const rows = code => tradingDays.map((trdDt, i) => ({
    trdCode: code, trdDt, pxClose: 3000 + i, pETtm: 20 + i, pBLf: 1.25 + i / 10,
    pETtm10Y: 30 + i, pBLf10Y: 40 + i, pETtmBgn: 50 + i, pBLfBgn: 60 + i,
  }));
  const snapshot = { indices: indices.map(([code, name]) =>
    indexSnapshot(code, name, rows(code).slice(0, 5), rows(code).slice(0, 5), new Date('2026-11-28T15:30:00+08:00'))) };

  async function runScenario(problem) {
    let data;
    let primaryEnd = friday;
    let hubEnd = trial;
    const store = {
      async read() { return data; },
      async write(path, value, etag) {
        assert.equal(path, valuationPath);
        assert.equal(data?.etag ?? null, etag);
        data = { value, etag: String(Number(etag ?? 0) + 1) };
      },
    };
    const run = async (date, time = '16:30:00') => {
      const now = new Date(date + 'T' + time + '+08:00');
      return await refreshStoredValuations(store, snapshot, async (code, kind) => {
        if (kind === 'eod_price') return rows(code);
        if (problem === 'primary-offline' && code === '000985' && primaryEnd === friday) throw Error('timeout');
        return rows(code).filter(row => row.trdDt <= primaryEnd);
      }, now, async primary => {
        const audit = await auditIndexHubValuations(primary, 'fixture-key', url => Response.json({
          success: true, data: codes.map(code => ({
            trdCode: code,
            items: rows(code).filter(row => row.trdDt <= hubEnd && row.trdDt <= url.searchParams.get('endDate') &&
              !(problem === 'not-ahead' && code === '000985' && primaryEnd === friday && row.trdDt === trial))
              .map(row => problem === 'wrong-rank' && code === '000985' && row.trdDt === trial ?
                { ...row, pBLfBgn: row.pBLfBgn + 1 } : row),
          })),
        }));
        return { ...audit, checkedAt: now.toISOString() };
      });
    };
    const publicRows = () => publishedValuationSnapshot(snapshot, data?.value).indices;
    await run(trial, '14:59:00');
    assert.ok(publicRows().every(row => row.date === friday));
    const earlier = await run(trial);
    const expectedLeads = ['primary-offline', 'not-ahead'].includes(problem) ? mainland.slice(1) : mainland;
    assert.deepEqual(Object.keys(earlier.backup.rollout.observedAhead).sort(), [...expectedLeads].sort());
    assert.equal(earlier.backup.rollout.enabledAt, null);
    assert.equal(earlier.backup.candidates, undefined);
    assert.ok(publicRows().every(row => row.date === friday));

    primaryEnd = trial;
    const compared = await run(tuesday, '08:30:00');
    if (problem) {
      assert.deepEqual(compared.backup.rollout.confirmed, mainland.slice(1));
      assert.equal(compared.backup.rollout.enabledAt, null);
      hubEnd = tuesday;
      await run(tuesday);
      assert.ok(publicRows().every(row => row.date === trial));
      return;
    }
    assert.deepEqual(compared.backup.rollout.confirmed, mainland);
    assert.ok(compared.backup.rollout.enabledAt);
    hubEnd = tuesday;
    const next = await run(tuesday);
    assert.deepEqual(next.backup.rollout.supplemental, mainland);
    assert.ok(valuationSnapshot(snapshot, data.value).indices.every(row => row.date === trial));
    for (const row of publicRows()) {
      assert.equal(row.date, row.code === 'HSI' ? trial : tuesday);
      assert.equal(row.history.length, row.code === 'HSI' ? 6 : 7);
      assert.deepEqual(row.history.slice(0, 5), snapshot.indices.find(item => item.code === row.code).history);
      assert.equal(row.close, row.code === 'HSI' ? 3005 : 3006);
      assert.deepEqual(row.history.at(-1).slice(5), [row.pe, row.pb]);
    }
    assert.equal((await run(tuesday)).changed, false);
    await run(wednesday);
    assert.ok(publicRows().filter(row => row.code !== 'HSI').every(row => row.date === tuesday));
    hubEnd = wednesday;
    await run(wednesday);
    assert.ok(publicRows().filter(row => row.code !== 'HSI').every(row =>
      row.date === wednesday && row.history.some(([day]) => day === tuesday)));
    primaryEnd = wednesday;
    const caughtUp = await run(wednesday, '21:00:00');
    assert.deepEqual(caughtUp.backup.rollout.supplemental, []);
    assert.ok(publicRows().every(row => row.date === wednesday && row.history.length === 8));
  }

  for (const problem of [null, 'not-ahead', 'wrong-rank', 'primary-offline']) await runScenario(problem);
});

test('the public endpoint supports conditional GET and keeps refresh authenticated', async t => {
  const store = require('../lib/gridStore');
  const handler = require('../api/investment-market');
  t.mock.method(store, 'read', async () => null);
  const request = async (method, headers = {}, query = {}) => {
    const response = {
      headers: {}, body: undefined,
      setHeader(key, value) { this.headers[key] = value; },
      end(body) { this.body = body; },
    };
    await handler({ method, headers, query: { view: 'valuations', scheduled: '1', ...query } }, response);
    return response;
  };
  const first = await request('GET');
  assert.equal(first.statusCode, 200);
  assert.equal(JSON.parse(first.body).indices.length, indices.length);
  const cached = await request('GET', { 'if-none-match': 'W/' + first.headers.ETag });
  assert.equal(cached.statusCode, 304);
  assert.equal(cached.body, undefined);
  const query = { format: valuationEncoding };
  const packed = await request('GET', {}, query);
  assert.equal(packed.statusCode, 200);
  assert.notEqual(packed.headers.ETag, first.headers.ETag);
  assert.deepEqual(unpackValuations(JSON.parse(packed.body)), JSON.parse(first.body));
  const cachedPacked = await request('GET', { 'if-none-match': 'W/' + packed.headers.ETag }, query);
  assert.equal(cachedPacked.statusCode, 304);
  assert.equal(cachedPacked.body, undefined);
  assert.equal((await request('POST')).statusCode, 401);
});

test('packed valuation history retains missing fields and falls back exactly for legacy or higher precision rows', () => {
  const payload = { fallback: false, closeDates: { code: dates[2] }, indices: [
    { code: 'normal', history: [
      [dates[0], 0, 100, null, 55, 10.2345, 1.25],
      [dates[1], 20.12, 99, 15.17, 54, 9.1111, 1.2512],
      [dates[2], 20, 99, 16, null, 9.1111, 1.2],
    ] },
    { code: 'legacy', history: [[dates[0], 20.12, 90]] },
    { code: 'precise', history: [[dates[0], 10.12345, 99, 0, 90, 10.2345, 1.25]] },
  ] };
  const packed = packValuations(payload);
  assert.ok(Array.isArray(packed.indices[0].history.days));
  assert.equal(packed.indices[1].history, payload.indices[1].history);
  assert.equal(packed.indices[2].history, payload.indices[2].history);
  assert.deepEqual(unpackValuations(JSON.parse(JSON.stringify(packed))), payload);
  assert.equal(unpackValuations(payload), payload);
});

test('an emotional snapshot section reads only its own upstream while the legacy request retains all sections', async t => {
  const handler = require('../api/investment-market');
  const calls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    const { pathname } = new URL(url);
    calls.push(pathname);
    if (pathname === '/api/fear-greed/sectors') return Response.json({ items: [{ name: '电子', score: 42 }] });
    return new Response(null, { status: 503 });
  });
  const request = async section => {
    const response = { setHeader() {}, end(body) { this.body = JSON.parse(body); } };
    await handler({ method: 'GET', query: { view: 'sentiment', section } }, response);
    return response;
  };
  const industry = await request('industry');
  assert.deepEqual(calls, ['/api/fear-greed/sectors']);
  assert.equal(industry.statusCode, 200);
  assert.equal(industry.body.industry.items[0].score, 42);
  assert.equal(industry.body.fear, undefined);
  const all = await request();
  assert.equal(all.statusCode, 200);
  assert.equal(all.body.fear.items.length, 4);
  assert.equal(all.body.crowding, null);
  assert.equal(all.body.industry.items[0].score, 42);
  assert.equal((await request('__proto__')).statusCode, 400);
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

test('the published order includes the full A-share market first and keeps new indices during a cloud upgrade', async () => {
  const load = (code, kind) => kind === 'eod_price' ? closes(code) : valuations(code);
  const { next: fallback } = await refresh([], load, new Date('2026-11-25T20:00:00+08:00'));
  const { next: current } = await refresh(fallback, load, afterClose);
  const newCodes = ['000932', '399989'];
  const prior = current.filter(row => !newCodes.includes(row.code)).reverse();
  const { indices: published } = valuationSnapshot({ indices: fallback }, { indices: prior });
  assert.equal(published[0].name, '中证全指（全A）');
  assert.deepEqual(published.slice(-2).map(row => [row.code, row.name]), [
    ['000932', '中证主要消费'], ['399989', '中证医疗'],
  ]);
  assert.equal(published.length, 9);
  for (const row of published) {
    assert.equal(row.date, newCodes.includes(row.code) ? dates[1] : dates[2]);
    assert.equal(row.history.at(-1).length, 7);
  }
});
