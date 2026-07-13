const assert = require("assert");
const { refreshStockSnapshot } = require("../lib/stockRefresh");

function snapshot(name, asOf = "2026-07-10") {
  return {
    name,
    asOf,
    expectedAsOf: asOf,
    isStale: false,
    productionPublishable: true
  };
}

async function run() {
  const published = [];
  let fallbackCalls = 0;
  const primaryResult = await refreshStockSnapshot({
    expectedAsOf: "2026-07-10",
    buildPrimary: async () => snapshot("primary"),
    buildFallback: async () => {
      fallbackCalls += 1;
      return snapshot("fallback");
    },
    publishSnapshot: async (value, meta) => published.push({ value, meta }),
    loadCurrentSnapshot: async () => snapshot("previous")
  });
  assert.strictEqual(primaryResult.status, "published");
  assert.strictEqual(primaryResult.source, "primary");
  assert.strictEqual(fallbackCalls, 0);
  assert.strictEqual(published.length, 1);

  const fallbackPublished = [];
  const fallbackResult = await refreshStockSnapshot({
    expectedAsOf: "2026-07-10",
    primaryName: "eastmoney-validated",
    fallbackName: "tushare-fallback",
    buildPrimary: async () => {
      const error = new Error("eastmoney unavailable");
      error.code = "NETWORK_ERROR";
      throw error;
    },
    buildFallback: async () => snapshot("tushare"),
    publishSnapshot: async (value, meta) => fallbackPublished.push({ value, meta }),
    loadCurrentSnapshot: async () => null
  });
  assert.strictEqual(fallbackResult.status, "published");
  assert.strictEqual(fallbackResult.source, "tushare-fallback");
  assert.strictEqual(fallbackPublished.length, 1);
  assert.strictEqual(fallbackResult.attempts[0].code, "NETWORK_ERROR");

  const qualityFallbackResult = await refreshStockSnapshot({
    expectedAsOf: "2026-07-10",
    buildPrimary: async () => ({
      productionPublishable: false,
      quality: { errors: [{ code: "INSUFFICIENT_COVERAGE" }] }
    }),
    buildFallback: async () => snapshot("fallback"),
    publishSnapshot: async () => {},
    loadCurrentSnapshot: async () => null
  });
  assert.strictEqual(qualityFallbackResult.source, "fallback");
  assert.strictEqual(
    qualityFallbackResult.attempts[0].code,
    "SNAPSHOT_NOT_PUBLISHABLE"
  );

  const previousResult = await refreshStockSnapshot({
    expectedAsOf: "2026-07-13",
    buildPrimary: async () => {
      throw new Error("primary failed");
    },
    buildFallback: async () => {
      throw new Error("fallback failed");
    },
    publishSnapshot: async () => {
      throw new Error("must not publish");
    },
    loadCurrentSnapshot: async () => snapshot("previous", "2026-07-10")
  });
  assert.strictEqual(previousResult.status, "serving-previous");
  assert.strictEqual(previousResult.snapshot.isStale, true);
  assert.strictEqual(previousResult.snapshot.expectedAsOf, "2026-07-13");
  assert.strictEqual(previousResult.attempts.length, 2);

  let fallbackAfterPublishFailure = 0;
  const publishFailureResult = await refreshStockSnapshot({
    expectedAsOf: "2026-07-11",
    buildPrimary: async () => snapshot("primary", "2026-07-11"),
    buildFallback: async () => {
      fallbackAfterPublishFailure += 1;
      return snapshot("fallback");
    },
    publishSnapshot: async () => {
      const error = new Error("storage unavailable");
      error.code = "STORE_ERROR";
      throw error;
    },
    loadCurrentSnapshot: async () => snapshot("previous", "2026-07-10")
  });
  assert.strictEqual(fallbackAfterPublishFailure, 0);
  assert.strictEqual(publishFailureResult.status, "serving-previous");
  assert.strictEqual(publishFailureResult.publishFailed, true);
  assert.strictEqual(publishFailureResult.attempts[0].phase, "publish");

  await assert.rejects(
    refreshStockSnapshot({
      buildPrimary: async () => snapshot("primary"),
      buildFallback: async () => snapshot("fallback"),
      publishSnapshot: async () => {},
      loadCurrentSnapshot: async () => null
    }),
    (error) => error.code === "EXPECTED_AS_OF_REQUIRED"
  );

  await assert.rejects(
    refreshStockSnapshot({
      expectedAsOf: "2026-07-11",
      buildPrimary: async () => snapshot("wrong-date", "2026-07-10"),
      buildFallback: async () => snapshot("wrong-date", "2026-07-10"),
      publishSnapshot: async () => {},
      loadCurrentSnapshot: async () => null
    }),
    (error) => error.code === "NO_USABLE_STOCK_SNAPSHOT" &&
      error.attempts.every((attempt) => attempt.code === "SNAPSHOT_REFRESH_DATE_MISMATCH")
  );

  await assert.rejects(
    refreshStockSnapshot({
      expectedAsOf: "2026-07-10",
      buildPrimary: async () => {
        throw new Error("primary failed");
      },
      buildFallback: async () => {
        throw new Error("fallback failed");
      },
      publishSnapshot: async () => {},
      loadCurrentSnapshot: async () => null
    }),
    (error) => error.code === "NO_USABLE_STOCK_SNAPSHOT" &&
      error.attempts.length === 2
  );

  await assert.rejects(
    refreshStockSnapshot({
      expectedAsOf: "2026-07-10",
      buildPrimary: async () => {
        throw new Error("primary failed");
      },
      buildFallback: async () => {
        throw new Error("fallback failed");
      },
      publishSnapshot: async () => {},
      loadCurrentSnapshot: async () => ({
        ...snapshot("blocked"),
        productionPublishable: false
      })
    }),
    (error) => error.code === "NO_USABLE_STOCK_SNAPSHOT" &&
      error.attempts.some(
        (attempt) => attempt.source === "previous" &&
          attempt.code === "SNAPSHOT_NOT_PUBLISHABLE"
      )
  );

  console.log("stock refresh tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
