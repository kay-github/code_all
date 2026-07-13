const assert = require("assert");
const { createFixtureSnapshot } = require("../lib/stockFixture");
const { createTradingCalendar } = require("../lib/stockTradingDates");
const {
  applyDynamicFreshness,
  loadStockSnapshot,
  resetStockSnapshotCache,
  snapshotWarning,
  validatePublishedSnapshot
} = require("../lib/stockPublishedSnapshot");

const TEST_NOW = Date.parse("2026-07-10T11:00:00.000Z");

function tradingCalendar() {
  return createTradingCalendar([
    { cal_date: "20251231", is_open: 1 },
    { cal_date: "20260710", is_open: 1 },
    { cal_date: "20260711", is_open: 1 },
    { cal_date: "20260713", is_open: 1 }
  ], {
    coveredFrom: "2025-12-01",
    coveredThrough: "2026-12-31"
  });
}

function productionSnapshot() {
  return {
    ...createFixtureSnapshot(),
    dataMode: "published",
    dataWarning: null,
    methodologyVersion: "adjusted-ytd.v1",
    poolVersion: "a-share.v1"
  };
}

function jsonResponse(payload, options = {}) {
  const status = options.status == null ? 200 : options.status;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return String(name).toLowerCase() === "etag" ? options.etag || null : null;
      }
    },
    async json() {
      return payload;
    }
  };
}

function textResponse(body, options = {}) {
  const status = options.status == null ? 200 : options.status;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        if (String(name).toLowerCase() === "content-length") {
          return options.contentLength == null ? null : String(options.contentLength);
        }
        return String(name).toLowerCase() === "etag" ? options.etag || null : null;
      }
    },
    async text() {
      return body;
    }
  };
}

async function run() {
  resetStockSnapshotCache();
  const fixture = await loadStockSnapshot({ env: { NODE_ENV: "test" } });
  assert.strictEqual(fixture.mode, "fixture");
  assert.strictEqual(fixture.cacheStatus, "fixture");

  await assert.rejects(
    loadStockSnapshot({ env: { VERCEL_ENV: "production" } }),
    (error) => error.code === "STOCK_SNAPSHOT_NOT_CONFIGURED"
  );

  assert.throws(
    () => validatePublishedSnapshot(createFixtureSnapshot(), {
      VERCEL_ENV: "production"
    }),
    (error) => error.code === "STOCK_SNAPSHOT_INVALID"
  );

  const snapshot = productionSnapshot();
  const snapshotWithoutBenchmark = productionSnapshot();
  delete snapshotWithoutBenchmark.benchmark;
  assert.doesNotThrow(
    () => validatePublishedSnapshot(snapshotWithoutBenchmark, { VERCEL_ENV: "production" })
  );

  const invalidBenchmark = productionSnapshot();
  invalidBenchmark.benchmark = { ...invalidBenchmark.benchmark, ytd: null };
  assert.throws(
    () => validatePublishedSnapshot(invalidBenchmark, { VERCEL_ENV: "production" }),
    (error) => error.code === "STOCK_SNAPSHOT_INVALID"
  );

  const corruptedPool = productionSnapshot();
  corruptedPool.pools.shSz.sortedYtd = [...corruptedPool.pools.shSz.sortedYtd];
  corruptedPool.pools.shSz.sortedYtd[0] += 0.01;
  assert.throws(
    () => validatePublishedSnapshot(corruptedPool, { VERCEL_ENV: "production" }),
    (error) => error.code === "STOCK_SNAPSHOT_INVALID"
  );

  const corruptedIndex = productionSnapshot();
  const firstSymbol = corruptedIndex.records[0].symbol;
  corruptedIndex.stocks = {
    ...corruptedIndex.stocks,
    [firstSymbol]: { ...corruptedIndex.stocks[firstSymbol], name: "错误名称" }
  };
  assert.throws(
    () => validatePublishedSnapshot(corruptedIndex, { VERCEL_ENV: "production" }),
    (error) => error.code === "STOCK_SNAPSHOT_INVALID"
  );

  const corruptedCoverage = productionSnapshot();
  corruptedCoverage.quality = {
    ...corruptedCoverage.quality,
    coverage: { ...corruptedCoverage.quality.coverage, ratio: "not-a-number" }
  };
  assert.throws(
    () => validatePublishedSnapshot(corruptedCoverage, { VERCEL_ENV: "production" }),
    (error) => error.code === "STOCK_SNAPSHOT_INVALID"
  );

  const fallbackWarningSnapshot = productionSnapshot();
  fallbackWarningSnapshot.sourceMode = "computed-fallback";
  fallbackWarningSnapshot.quality = {
    ...fallbackWarningSnapshot.quality,
    status: "warning"
  };
  assert.ok(snapshotWarning(fallbackWarningSnapshot).includes("独立复权计算"));
  assert.ok(snapshotWarning(fallbackWarningSnapshot, {
    refreshStatus: "SERVING_PREVIOUS"
  }).includes("上一份"));

  const rolloverFreshness = applyDynamicFreshness({
    asOf: "2025-12-31",
    baseDate: "2024-12-31",
    publishExpectedAsOf: "2025-12-31",
    quality: { status: "pass" },
    sourceMode: "validated"
  }, createTradingCalendar([
    { cal_date: "20251231", is_open: 1 }
  ], {
    coveredFrom: "2025-12-01",
    coveredThrough: "2026-02-28"
  }), "2025-12-31", Date.parse("2026-01-01T11:00:00.000Z"));
  assert.strictEqual(rolloverFreshness.periodResetRequired, true);
  assert.strictEqual(rolloverFreshness.isStale, true);
  assert.ok(snapshotWarning(rolloverFreshness).includes("新年度重置"));

  const calls = [];
  const env = {
    VERCEL_ENV: "production",
    STOCK_SNAPSHOT_URL: "https://snapshots.example.test/current.json",
    STOCK_SNAPSHOT_AUTH_TOKEN: "fixture-secret"
  };
  const first = await loadStockSnapshot({
    env,
    now: TEST_NOW,
    cacheTtlMs: 100,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({
        envelopeVersion: "stock-ytd-current.v1",
        snapshot,
        snapshotId: "snapshot-v1",
        expectedAsOf: snapshot.asOf,
        refreshStatus: "PUBLISHED",
        tradingCalendar: tradingCalendar()
      }, { etag: '"envelope-v1"' });
    }
  });
  assert.strictEqual(first.mode, "published");
  assert.strictEqual(first.cacheStatus, "fresh");
  assert.strictEqual(first.snapshot.snapshotId, "snapshot-v1");
  assert.strictEqual(first.snapshot.isStale, false);
  assert.strictEqual(first.refreshStatus, "PUBLISHED");
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].options.headers.Authorization, "Bearer fixture-secret");

  const cached = await loadStockSnapshot({
    env,
    now: TEST_NOW + 50,
    cacheTtlMs: 100,
    fetchImpl: async () => {
      throw new Error("cache hit must not fetch");
    }
  });
  assert.strictEqual(cached.cacheStatus, "hit");

  let revalidateHeaders;
  const revalidated = await loadStockSnapshot({
    env,
    now: TEST_NOW + 150,
    cacheTtlMs: 100,
    fetchImpl: async (url, options) => {
      revalidateHeaders = options.headers;
      return jsonResponse(null, { status: 304 });
    }
  });
  assert.strictEqual(revalidated.cacheStatus, "revalidated");
  assert.strictEqual(revalidateHeaders["If-None-Match"], '"envelope-v1"');

  const staleFallback = await loadStockSnapshot({
    env,
    now: Date.parse("2026-07-11T11:00:00.000Z"),
    cacheTtlMs: 100,
    fetchImpl: async () => {
      throw new Error("temporary storage failure");
    }
  });
  assert.strictEqual(staleFallback.cacheStatus, "stale-fallback");
  assert.ok(staleFallback.warning);
  assert.strictEqual(staleFallback.snapshot.expectedAsOf, "2026-07-11");
  assert.strictEqual(staleFallback.snapshot.isStale, true);

  resetStockSnapshotCache();
  const fallbackEnv = {
    VERCEL_ENV: "production",
    STOCK_SNAPSHOT_URL: "https://snapshots.example.test/computed-fallback.json"
  };
  const freshFallback = await loadStockSnapshot({
    env: fallbackEnv,
    now: TEST_NOW,
    cacheTtlMs: 100,
    fetchImpl: async () => jsonResponse({
      envelopeVersion: "stock-ytd-current.v1",
      snapshot: fallbackWarningSnapshot,
      snapshotId: "computed-fallback-v1",
      expectedAsOf: fallbackWarningSnapshot.asOf,
      refreshStatus: "PUBLISHED",
      tradingCalendar: tradingCalendar()
    }, { etag: '"computed-fallback-v1"' })
  });
  assert.ok(freshFallback.warning.includes("独立复权计算"));
  const cachedFallback = await loadStockSnapshot({
    env: fallbackEnv,
    now: TEST_NOW + 200,
    cacheTtlMs: 100,
    fetchImpl: async () => {
      throw new Error("snapshot store unavailable");
    }
  });
  assert.ok(cachedFallback.warning.includes("服务端缓存"));
  assert.ok(cachedFallback.warning.includes("独立复权计算"));

  resetStockSnapshotCache();
  await assert.rejects(
    loadStockSnapshot({
      env: {
        VERCEL_ENV: "production",
        STOCK_SNAPSHOT_URL: "https://snapshots.example.test/no-etag.json"
      },
      fetchImpl: async () => jsonResponse({
        envelopeVersion: "stock-ytd-current.v1",
        snapshot,
        snapshotId: "snapshot-no-etag",
        expectedAsOf: snapshot.asOf,
        tradingCalendar: tradingCalendar()
      })
    }),
    (error) => error.code === "STOCK_SNAPSHOT_ETAG_MISSING"
  );

  resetStockSnapshotCache();
  await assert.rejects(
    loadStockSnapshot({
      env: {
        VERCEL_ENV: "production",
        STOCK_SNAPSHOT_URL: "https://snapshots.example.test/no-id.json"
      },
      fetchImpl: async () => jsonResponse({
        envelopeVersion: "stock-ytd-current.v1",
        snapshot,
        expectedAsOf: snapshot.asOf,
        tradingCalendar: tradingCalendar()
      }, { etag: '"missing-id"' })
    }),
    (error) => error.code === "STOCK_SNAPSHOT_INVALID"
  );

  resetStockSnapshotCache();
  await assert.rejects(
    loadStockSnapshot({
      env: {
        VERCEL_ENV: "production",
        STOCK_SNAPSHOT_URL: "https://snapshots.example.test/no-calendar.json"
      },
      fetchImpl: async () => jsonResponse({
        envelopeVersion: "stock-ytd-current.v1",
        snapshot,
        snapshotId: "snapshot-no-calendar",
        expectedAsOf: snapshot.asOf
      }, { etag: '"no-calendar"' })
    }),
    (error) => error.code === "STOCK_SNAPSHOT_FRESHNESS_MISSING"
  );

  resetStockSnapshotCache();
  await assert.rejects(
    loadStockSnapshot({
      env: {
        VERCEL_ENV: "production",
        STOCK_SNAPSHOT_URL: "https://snapshots.example.test/mismatched-id.json"
      },
      fetchImpl: async () => jsonResponse({
        envelopeVersion: "stock-ytd-current.v1",
        snapshot: { ...snapshot, snapshotId: "snapshot-inside" },
        snapshotId: "snapshot-outside",
        expectedAsOf: snapshot.asOf,
        tradingCalendar: tradingCalendar()
      }, { etag: '"mismatched-id"' })
    }),
    (error) => error.code === "STOCK_SNAPSHOT_INVALID"
  );

  resetStockSnapshotCache();
  await assert.rejects(
    loadStockSnapshot({
      env: {
        NODE_ENV: "test",
        STOCK_SNAPSHOT_URL: "https://snapshots.example.test/too-large.json"
      },
      maxResponseBytes: 16,
      fetchImpl: async () => textResponse("x".repeat(32))
    }),
    (error) => error.code === "STOCK_SNAPSHOT_TOO_LARGE"
  );

  resetStockSnapshotCache();
  await assert.rejects(
    loadStockSnapshot({
      env: {
        NODE_ENV: "test",
        STOCK_SNAPSHOT_URL: "https://snapshots.example.test/timeout.json"
      },
      timeoutMs: 1,
      fetchImpl: async (url, options) => new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      })
    }),
    (error) => error.code === "STOCK_SNAPSHOT_FETCH_FAILED" && error.retryable
  );

  resetStockSnapshotCache();
  let redirectMode;
  await assert.rejects(
    loadStockSnapshot({
      env: {
        NODE_ENV: "test",
        STOCK_SNAPSHOT_URL: "https://snapshots.example.test/redirect.json"
      },
      fetchImpl: async (url, options) => {
        redirectMode = options.redirect;
        return jsonResponse(null, { status: 302 });
      }
    }),
    (error) => error.code === "STOCK_SNAPSHOT_FETCH_FAILED"
  );
  assert.strictEqual(redirectMode, "error");

  resetStockSnapshotCache();
  await assert.rejects(
    loadStockSnapshot({
      env: {
        VERCEL_ENV: "production",
        STOCK_SNAPSHOT_URL: "https://snapshots.example.test/fixture.json"
      },
      fetchImpl: async () => jsonResponse({
        envelopeVersion: "stock-ytd-current.v1",
        snapshot: createFixtureSnapshot(),
        snapshotId: "fixture",
        expectedAsOf: "2026-07-10",
        tradingCalendar: tradingCalendar()
      }, { etag: '"fixture-envelope"' })
    }),
    (error) => error.code === "STOCK_SNAPSHOT_INVALID"
  );

  await assert.rejects(
    loadStockSnapshot({
      env: {
        VERCEL_ENV: "production",
        STOCK_SNAPSHOT_URL: "http://snapshots.example.test/current.json"
      }
    }),
    (error) => error.code === "STOCK_SNAPSHOT_INVALID_URL"
  );

  resetStockSnapshotCache();
  const staleByCalendar = await loadStockSnapshot({
    env: {
      VERCEL_ENV: "production",
      STOCK_SNAPSHOT_URL: "https://snapshots.example.test/stale.json"
    },
    fetchImpl: async () => jsonResponse({
      envelopeVersion: "stock-ytd-current.v1",
      snapshot,
      snapshotId: "snapshot-v1",
      expectedAsOf: "2026-07-11",
      tradingCalendar: tradingCalendar()
    }, { etag: '"stale-envelope"' })
    ,
    now: Date.parse("2026-07-11T11:00:00.000Z")
  });
  assert.strictEqual(staleByCalendar.snapshot.expectedAsOf, "2026-07-11");
  assert.strictEqual(staleByCalendar.snapshot.isStale, true);

  resetStockSnapshotCache();
  const expiredCalendar = createTradingCalendar([
    { cal_date: "20251231", is_open: 1 },
    { cal_date: "20260710", is_open: 1 }
  ], {
    coveredFrom: "2025-12-01",
    coveredThrough: "2026-07-10"
  });
  const coldExpired = await loadStockSnapshot({
    env: {
      VERCEL_ENV: "production",
      STOCK_SNAPSHOT_URL: "https://snapshots.example.test/expired-calendar.json"
    },
    now: Date.parse("2026-07-13T11:00:00.000Z"),
    fetchImpl: async () => jsonResponse({
      envelopeVersion: "stock-ytd-current.v1",
      snapshot,
      snapshotId: "snapshot-expired-calendar",
      expectedAsOf: snapshot.asOf,
      refreshStatus: "SERVING_PREVIOUS",
      tradingCalendar: expiredCalendar
    }, { etag: '"expired-calendar"' })
  });
  assert.strictEqual(coldExpired.snapshot.isStale, true);
  assert.strictEqual(coldExpired.snapshot.calendarCoverageExpired, true);
  assert.ok(coldExpired.warning.includes("交易日历覆盖已到期"));

  resetStockSnapshotCache();
  const boundaryEnv = {
    VERCEL_ENV: "production",
    STOCK_SNAPSHOT_URL: "https://snapshots.example.test/calendar-boundary.json"
  };
  const boundaryFirst = await loadStockSnapshot({
    env: boundaryEnv,
    now: Date.parse("2026-07-10T15:59:00.000Z"),
    cacheTtlMs: 300000,
    fetchImpl: async () => jsonResponse({
      envelopeVersion: "stock-ytd-current.v1",
      snapshot,
      snapshotId: "snapshot-calendar-boundary",
      expectedAsOf: snapshot.asOf,
      refreshStatus: "PUBLISHED",
      tradingCalendar: expiredCalendar
    }, { etag: '"calendar-boundary"' })
  });
  assert.strictEqual(boundaryFirst.snapshot.calendarCoverageExpired, undefined);
  const boundaryHit = await loadStockSnapshot({
    env: boundaryEnv,
    now: Date.parse("2026-07-10T16:01:00.000Z"),
    cacheTtlMs: 300000,
    fetchImpl: async () => {
      throw new Error("cache hit must not fetch");
    }
  });
  assert.strictEqual(boundaryHit.cacheStatus, "hit");
  assert.strictEqual(boundaryHit.snapshot.calendarCoverageExpired, true);
  assert.ok(boundaryHit.warning.includes("交易日历覆盖已到期"));

  resetStockSnapshotCache();
  await assert.rejects(
    loadStockSnapshot({
      env: {
        VERCEL_ENV: "production",
        STOCK_SNAPSHOT_URL: "https://snapshots.example.test/raw.json"
      },
      fetchImpl: async () => jsonResponse(snapshot)
    }),
    (error) => error.code === "STOCK_SNAPSHOT_FRESHNESS_MISSING"
  );

  resetStockSnapshotCache();
  let concurrentFetches = 0;
  let releaseFetch;
  const concurrentFetch = async () => {
    concurrentFetches += 1;
    await new Promise((resolve) => {
      releaseFetch = resolve;
    });
    return jsonResponse({
      envelopeVersion: "stock-ytd-current.v1",
      snapshot,
      snapshotId: "snapshot-concurrent",
      expectedAsOf: snapshot.asOf,
      tradingCalendar: tradingCalendar()
    }, { etag: '"concurrent-envelope"' });
  };
  const concurrentEnv = {
    VERCEL_ENV: "production",
    STOCK_SNAPSHOT_URL: "https://snapshots.example.test/concurrent.json"
  };
  const pendingOne = loadStockSnapshot({
    env: concurrentEnv,
    fetchImpl: concurrentFetch,
    now: TEST_NOW
  });
  const pendingTwo = loadStockSnapshot({
    env: concurrentEnv,
    fetchImpl: concurrentFetch,
    now: TEST_NOW
  });
  await Promise.resolve();
  assert.strictEqual(concurrentFetches, 1);
  releaseFetch();
  const concurrentResults = await Promise.all([pendingOne, pendingTwo]);
  assert.strictEqual(concurrentResults[0].snapshot.snapshotId, "snapshot-concurrent");
  assert.strictEqual(concurrentResults[1].snapshot.snapshotId, "snapshot-concurrent");

  console.log("published stock snapshot tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
