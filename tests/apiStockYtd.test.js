const assert = require("assert");

process.env.NODE_ENV = "test";
const { createFixtureSnapshot } = require("../lib/stockFixture");
const {
  StockPublishedSnapshotError
} = require("../lib/stockPublishedSnapshot");
const stockYtdApi = require("../api/stock-ytd");
const { createHandler } = stockYtdApi;

async function invoke(query = {}, method = "GET", handler = stockYtdApi) {
  const req = { method, query };
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
    data: res.body ? JSON.parse(res.body) : null
  };
}

async function run() {
  let response = await invoke({ symbol: "300502.SZ", includeBse: "false" });
  assert.strictEqual(response.status, 200);
  assert.strictEqual(response.data.stock.name, "新易盛");
  assert.strictEqual(response.data.stock.direction, "UP");
  assert.strictEqual(response.data.comparison.peerCount, 6);
  assert.strictEqual(response.data.benchmark.symbol, "000300.SH");
  assert.strictEqual(response.data.dataMode, "fixture");
  assert.strictEqual(response.headers["Cache-Control"], "no-store");
  const ytd = response.data.stock.ytd;

  response = await invoke({ symbol: "300502.SZ", includeBse: "true" });
  assert.strictEqual(response.status, 200);
  assert.strictEqual(response.data.comparison.peerCount, 7);
  assert.strictEqual(response.data.stock.ytd, ytd);

  response = await invoke({ symbol: "920001.BJ", includeBse: "false" });
  assert.strictEqual(response.status, 200);
  assert.strictEqual(response.data.comparison.targetInPool, false);
  assert.strictEqual(response.data.comparison.peerCount, 7);

  response = await invoke({ symbol: "301999.SZ" });
  assert.strictEqual(response.status, 200);
  assert.strictEqual(response.data.stock.ineligibilityReason, "NEW_LISTING");
  assert.strictEqual(response.data.comparison, null);

  response = await invoke({ symbol: "bad" });
  assert.strictEqual(response.status, 400);
  assert.strictEqual(response.data.error, "INVALID_SYMBOL");

  response = await invoke({ symbol: "999999.SH" });
  assert.strictEqual(response.status, 404);
  assert.strictEqual(response.data.error, "STOCK_NOT_FOUND");

  response = await invoke({ symbol: "300502.SZ", includeBse: "maybe" });
  assert.strictEqual(response.status, 400);
  assert.strictEqual(response.data.error, "INVALID_INCLUDE_BSE");

  response = await invoke({ symbol: "300502.SZ" }, "POST");
  assert.strictEqual(response.status, 405);

  const publishedSnapshot = {
    ...createFixtureSnapshot(),
    snapshotId: "published-v1",
    dataMode: "published"
  };
  const publishedHandler = createHandler({
    loadStockSnapshot: async () => ({
      snapshot: publishedSnapshot,
      mode: "published",
      warning: "最新批次更新未完成"
    })
  });
  response = await invoke(
    { symbol: "300502.SZ", includeBse: "false" },
    "GET",
    publishedHandler
  );
  assert.strictEqual(response.status, 200);
  assert.strictEqual(response.data.snapshotId, "published-v1");
  assert.strictEqual(response.data.dataMode, "published");
  assert.strictEqual(response.data.warning, "最新批次更新未完成");
  assert.ok(!Object.prototype.hasOwnProperty.call(response.data.stock, "computedYtd"));

  const unavailableHandler = createHandler({
    loadStockSnapshot: async () => {
      throw new StockPublishedSnapshotError(
        "STOCK_SNAPSHOT_FETCH_FAILED",
        "upstream unavailable"
      );
    }
  });
  response = await invoke({ symbol: "300502.SZ" }, "GET", unavailableHandler);
  assert.strictEqual(response.status, 503);
  assert.strictEqual(response.data.error, "STOCK_DATA_UNAVAILABLE");

  const internalErrorHandler = createHandler({
    loadStockSnapshot: async () => ({
      snapshot: publishedSnapshot,
      mode: "published"
    }),
    queryStockSnapshot() {
      throw new Error("secret implementation detail");
    },
    logger: { error() {} }
  });
  response = await invoke({ symbol: "300502.SZ" }, "GET", internalErrorHandler);
  assert.strictEqual(response.status, 500);
  assert.strictEqual(response.data.error, "INTERNAL_ERROR");
  assert.ok(!JSON.stringify(response.data).includes("secret implementation detail"));

  const previousVercelEnv = process.env.VERCEL_ENV;
  const previousFixtureFlag = process.env.STOCK_YTD_FIXTURE_ENABLED;
  try {
    process.env.VERCEL_ENV = "production";
    process.env.STOCK_YTD_FIXTURE_ENABLED = "0";
    response = await invoke({ symbol: "300502.SZ" });
    assert.strictEqual(response.status, 503);
    assert.strictEqual(response.data.error, "STOCK_DATA_UNAVAILABLE");
  } finally {
    if (previousVercelEnv === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = previousVercelEnv;
    if (previousFixtureFlag === undefined) delete process.env.STOCK_YTD_FIXTURE_ENABLED;
    else process.env.STOCK_YTD_FIXTURE_ENABLED = previousFixtureFlag;
  }

  console.log("stock YTD API tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
