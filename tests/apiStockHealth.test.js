const assert = require("assert");
const { createFixtureSnapshot } = require("../lib/stockFixture");
const {
  StockPublishedSnapshotError
} = require("../lib/stockPublishedSnapshot");
const { createHandler } = require("../api/stock-health");

async function invoke(handler, method = "GET") {
  const req = { method };
  const res = {
    headers: {},
    statusCode: 0,
    body: "",
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(body = "") {
      this.body = body;
    }
  };
  await handler(req, res);
  return {
    status: res.statusCode,
    headers: res.headers,
    data: res.body ? JSON.parse(res.body) : null,
    raw: res.body
  };
}

async function run() {
  const fixtureSnapshot = createFixtureSnapshot();
  let handler = createHandler({
    loadStockSnapshot: async () => ({
      snapshot: fixtureSnapshot,
      mode: "fixture",
      cacheStatus: "fixture"
    })
  });
  let response = await invoke(handler);
  assert.strictEqual(response.status, 200);
  assert.strictEqual(response.data.status, "DEMO");
  assert.strictEqual(response.headers["Cache-Control"], "no-store");

  const publishedSnapshot = {
    ...fixtureSnapshot,
    snapshotId: "snapshot-v1",
    dataMode: "published",
    methodologyVersion: "adjusted-ytd.v1",
    poolVersion: "a-share.v1"
  };
  handler = createHandler({
    loadStockSnapshot: async () => ({
      snapshot: publishedSnapshot,
      mode: "published",
      cacheStatus: "fresh",
      lastValidatedAt: "2026-07-10T10:40:00.000Z"
    })
  });
  response = await invoke(handler);
  assert.strictEqual(response.status, 200);
  assert.strictEqual(response.data.status, "READY");
  assert.strictEqual(response.data.snapshotId, "snapshot-v1");
  assert.strictEqual(response.data.benchmarkAvailable, true);
  assert.strictEqual(response.data.refreshStatus, null);
  assert.ok(!response.raw.includes("STOCK_SNAPSHOT_URL"));
  assert.ok(!response.raw.includes("token"));

  handler = createHandler({
    loadStockSnapshot: async () => ({
      snapshot: publishedSnapshot,
      mode: "published",
      cacheStatus: "stale-fallback"
    })
  });
  response = await invoke(handler);
  assert.strictEqual(response.data.status, "DEGRADED");

  handler = createHandler({
    loadStockSnapshot: async () => ({
      snapshot: publishedSnapshot,
      mode: "published",
      cacheStatus: "fresh",
      refreshStatus: "SERVING_PREVIOUS"
    })
  });
  response = await invoke(handler);
  assert.strictEqual(response.data.status, "DEGRADED");
  assert.strictEqual(response.data.refreshStatus, "SERVING_PREVIOUS");

  handler = createHandler({
    loadStockSnapshot: async () => {
      throw new StockPublishedSnapshotError(
        "STOCK_SNAPSHOT_NOT_CONFIGURED",
        "not configured"
      );
    }
  });
  response = await invoke(handler);
  assert.strictEqual(response.status, 503);
  assert.strictEqual(response.data.status, "NOT_READY");
  assert.strictEqual(response.data.errorCode, "STOCK_SNAPSHOT_NOT_CONFIGURED");

  response = await invoke(handler, "POST");
  assert.strictEqual(response.status, 405);

  console.log("stock health API tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
