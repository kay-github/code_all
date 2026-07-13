const assert = require("assert");

process.env.NODE_ENV = "test";
const { createFixtureSnapshot } = require("../lib/stockFixture");
const {
  StockPublishedSnapshotError
} = require("../lib/stockPublishedSnapshot");
const stockSearchApi = require("../api/stock-search");
const { createHandler } = stockSearchApi;

async function invoke(query = {}, method = "GET", handler = stockSearchApi) {
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
  let response = await invoke({ q: "新易" });
  assert.strictEqual(response.status, 200);
  assert.strictEqual(response.data.items[0].symbol, "300502.SZ");
  assert.strictEqual(response.data.items[0].exchange, "SZ");
  assert.strictEqual(response.data.items[0].board, "创业板");
  assert.strictEqual(response.data.dataMode, "fixture");
  assert.strictEqual(response.headers["Cache-Control"], "no-store");

  response = await invoke({ q: "3005" });
  assert.strictEqual(response.status, 200);
  assert.strictEqual(response.data.items[0].name, "新易盛");

  response = await invoke({ q: "样本" });
  assert.strictEqual(response.status, 200);
  assert.ok(response.data.items.length <= 8);
  assert.ok(response.data.items.some((item) => item.symbol === "301999.SZ"));

  response = await invoke({});
  assert.strictEqual(response.status, 400);
  assert.strictEqual(response.data.error, "EMPTY_QUERY");

  response = await invoke({ q: "3" });
  assert.strictEqual(response.status, 400);
  assert.strictEqual(response.data.error, "QUERY_TOO_SHORT");

  response = await invoke({ q: "新易" }, "POST");
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
      warning: "已进入备用计算模式"
    })
  });
  response = await invoke({ q: "新易" }, "GET", publishedHandler);
  assert.strictEqual(response.status, 200);
  assert.strictEqual(response.data.dataMode, "published");
  assert.strictEqual(response.data.warning, "已进入备用计算模式");

  const unavailableHandler = createHandler({
    loadStockSnapshot: async () => {
      throw new StockPublishedSnapshotError(
        "STOCK_SNAPSHOT_FETCH_FAILED",
        "upstream unavailable"
      );
    }
  });
  response = await invoke({ q: "新易" }, "GET", unavailableHandler);
  assert.strictEqual(response.status, 503);
  assert.strictEqual(response.data.error, "STOCK_DATA_UNAVAILABLE");

  const internalErrorHandler = createHandler({
    loadStockSnapshot: async () => {
      throw new Error("secret implementation detail");
    },
    logger: { error() {} }
  });
  response = await invoke({ q: "新易" }, "GET", internalErrorHandler);
  assert.strictEqual(response.status, 500);
  assert.strictEqual(response.data.error, "INTERNAL_ERROR");
  assert.ok(!JSON.stringify(response.data).includes("secret implementation detail"));

  const previousVercelEnv = process.env.VERCEL_ENV;
  const previousFixtureFlag = process.env.STOCK_YTD_FIXTURE_ENABLED;
  try {
    process.env.VERCEL_ENV = "production";
    process.env.STOCK_YTD_FIXTURE_ENABLED = "0";
    response = await invoke({ q: "新易" });
    assert.strictEqual(response.status, 503);
    assert.strictEqual(response.data.error, "STOCK_DATA_UNAVAILABLE");
  } finally {
    if (previousVercelEnv === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = previousVercelEnv;
    if (previousFixtureFlag === undefined) delete process.env.STOCK_YTD_FIXTURE_ENABLED;
    else process.env.STOCK_YTD_FIXTURE_ENABLED = previousFixtureFlag;
  }

  console.log("stock search API tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
