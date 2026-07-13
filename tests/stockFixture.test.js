const assert = require("assert");
const {
  FIXTURE_WARNING,
  createFixtureSnapshot,
  fixtureEnabled
} = require("../lib/stockFixture");
const { queryStockSnapshot } = require("../lib/stockSnapshot");

const snapshot = createFixtureSnapshot();
assert.strictEqual(snapshot.productionPublishable, true);
assert.strictEqual(snapshot.dataMode, "fixture");
assert.strictEqual(snapshot.dataWarning, FIXTURE_WARNING);
assert.strictEqual(snapshot.records.length, 9);
assert.strictEqual(snapshot.pools.shSz.poolEligibleCount, 7);
assert.strictEqual(snapshot.pools.shSzBse.poolEligibleCount, 8);
assert.strictEqual(snapshot.benchmark.symbol, "000300.SH");

const normal = queryStockSnapshot(snapshot, "300502.SZ");
assert.strictEqual(normal.stock.name, "新易盛");
assert.strictEqual(normal.comparison.peerCount, 6);

const withBse = queryStockSnapshot(snapshot, "300502.SZ", { includeBse: true });
assert.strictEqual(withBse.comparison.peerCount, 7);
assert.strictEqual(withBse.stock.ytd, normal.stock.ytd);

const newListing = queryStockSnapshot(snapshot, "301999.SZ");
assert.strictEqual(newListing.stock.ineligibilityReason, "NEW_LISTING");
assert.strictEqual(newListing.comparison, null);

assert.strictEqual(fixtureEnabled({ NODE_ENV: "test" }), true);
assert.strictEqual(fixtureEnabled({ NODE_ENV: "production" }), false);
assert.strictEqual(
  fixtureEnabled({ NODE_ENV: "production", STOCK_YTD_FIXTURE_ENABLED: "1" }),
  false
);
assert.strictEqual(
  fixtureEnabled({ NODE_ENV: "production", VERCEL_ENV: "preview" }),
  true
);

console.log("stock fixture tests passed");
