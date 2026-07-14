const assert = require("assert");
const stockRefreshApi = require("../api/stock-refresh");
const { createHandler, secretMatches, sourceFailureMetadata } = stockRefreshApi;

async function invoke(handler, method = "GET", authorization = "") {
  const req = { method, headers: { authorization } };
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
  assert.strictEqual(secretMatches("Bearer cron-test", "cron-test"), true);
  assert.strictEqual(secretMatches("Bearer wrong", "cron-test"), false);
  assert.deepStrictEqual(sourceFailureMetadata({
    cause: {
      source: "tushare",
      details: {
        apiName: "trade_cal",
        providerCode: -2001,
        rateLimitPerMinute: 0,
        message: "secret upstream detail"
      }
    }
  }), {
    causeSource: "tushare",
    causeOperation: "trade_cal",
    providerCode: -2001,
    rateLimitPerMinute: 0
  });

  let handler = createHandler({ env: {}, logger: { error() {} } });
  let response = await invoke(handler);
  assert.strictEqual(response.status, 503);
  assert.strictEqual(response.data.error, "STOCK_REFRESH_NOT_CONFIGURED");

  handler = createHandler({
    env: { CRON_SECRET: "cron-test", TUSHARE_TOKEN: "token-test" },
    logger: { error() {} },
    storage: { type: "mock" },
    runStockDailyWorker: async (options) => {
      assert.strictEqual(options.storage.type, "mock");
      return {
        status: "published",
        snapshotId: "stock-ytd-20260710-test",
        asOf: "2026-07-10",
        expectedAsOf: "2026-07-10",
        sourceMode: "validated",
        coverageRatio: 1,
        records: [{ rawClose: 123 }],
        token: "must-not-leak"
      };
    }
  });
  response = await invoke(handler, "GET", "Bearer wrong");
  assert.strictEqual(response.status, 401);

  response = await invoke(handler, "GET", "Bearer cron-test");
  assert.strictEqual(response.status, 200);
  assert.strictEqual(response.headers["Cache-Control"], "no-store");
  assert.strictEqual(response.data.refresh.status, "published");
  assert.ok(!JSON.stringify(response.data).includes("rawClose"));
  assert.ok(!JSON.stringify(response.data).includes("must-not-leak"));
  assert.ok(!JSON.stringify(response.data).includes("token-test"));

  handler = createHandler({
    env: { CRON_SECRET: "cron-test", TUSHARE_TOKEN: "token-test" },
    logger: { error() {} },
    storage: {},
    runStockDailyWorker: async () => {
      const error = new Error("private detail");
      error.code = "STOCK_REFRESH_LOCKED";
      throw error;
    }
  });
  response = await invoke(handler, "POST", "Bearer cron-test");
  assert.strictEqual(response.status, 409);
  assert.strictEqual(response.data.error, "STOCK_REFRESH_ALREADY_RUNNING");
  assert.ok(!JSON.stringify(response.data).includes("private detail"));

  response = await invoke(handler, "DELETE", "Bearer cron-test");
  assert.strictEqual(response.status, 405);

  console.log("stock refresh API tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
