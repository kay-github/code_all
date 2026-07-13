const assert = require("assert");

process.env.NODE_ENV = "test";
const { createFixtureSnapshot } = require("../lib/stockFixture");
const {
  StockPublishedSnapshotError
} = require("../lib/stockPublishedSnapshot");
const stockBenchmarkApi = require("../api/stock-benchmark");
const { createHandler } = stockBenchmarkApi;

async function invoke(handler = stockBenchmarkApi, method = "GET") {
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
    data: res.body ? JSON.parse(res.body) : null
  };
}

async function run() {
  const snapshot = createFixtureSnapshot();
  let handler = createHandler({
    loadStockSnapshot: async () => ({
      snapshot,
      mode: "fixture"
    })
  });
  let response = await invoke(handler);
  assert.strictEqual(response.status, 200);
  assert.strictEqual(response.headers["Cache-Control"], "no-store");
  assert.strictEqual(response.headers["Access-Control-Allow-Origin"], "*");
  assert.deepStrictEqual(response.data.benchmark, {
    symbol: "000300.SH",
    name: "沪深300（价格指数）",
    type: "PRICE_INDEX",
    ytd: 0.0526,
    asOf: snapshot.asOf,
    baseDate: snapshot.baseDate
  });
  assert.ok(!Object.prototype.hasOwnProperty.call(response.data.benchmark, "baseClose"));

  const snapshotWithoutBenchmark = { ...snapshot };
  delete snapshotWithoutBenchmark.benchmark;
  handler = createHandler({
    loadStockSnapshot: async () => ({
      snapshot: snapshotWithoutBenchmark,
      mode: "fixture"
    })
  });
  response = await invoke(handler);
  assert.strictEqual(response.status, 503);
  assert.strictEqual(response.data.error, "BENCHMARK_DATA_UNAVAILABLE");

  const snapshotWithInvalidBenchmark = {
    ...snapshot,
    benchmark: { ...snapshot.benchmark, ytd: null }
  };
  handler = createHandler({
    loadStockSnapshot: async () => ({
      snapshot: snapshotWithInvalidBenchmark,
      mode: "fixture"
    })
  });
  response = await invoke(handler);
  assert.strictEqual(response.status, 503);
  assert.strictEqual(response.data.error, "BENCHMARK_DATA_UNAVAILABLE");

  handler = createHandler({
    loadStockSnapshot: async () => {
      throw new StockPublishedSnapshotError(
        "STOCK_SNAPSHOT_FETCH_FAILED",
        "upstream unavailable"
      );
    }
  });
  response = await invoke(handler);
  assert.strictEqual(response.status, 503);
  assert.strictEqual(response.data.error, "BENCHMARK_DATA_UNAVAILABLE");

  response = await invoke(handler, "POST");
  assert.strictEqual(response.status, 405);

  response = await invoke(handler, "OPTIONS");
  assert.strictEqual(response.status, 204);

  handler = createHandler({
    loadStockSnapshot: async () => {
      throw new Error("secret implementation detail");
    },
    logger: { error() {} }
  });
  response = await invoke(handler);
  assert.strictEqual(response.status, 500);
  assert.strictEqual(response.data.error, "INTERNAL_ERROR");
  assert.ok(!JSON.stringify(response.data).includes("secret implementation detail"));

  console.log("stock benchmark API tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
