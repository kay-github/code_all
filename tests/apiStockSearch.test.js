const assert = require("assert");

process.env.NODE_ENV = "test";
const handler = require("../api/stock-search");

function invoke(query = {}, method = "GET") {
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
  handler(req, res);
  return {
    status: res.statusCode,
    headers: res.headers,
    data: res.body ? JSON.parse(res.body) : null
  };
}

let response = invoke({ q: "新易" });
assert.strictEqual(response.status, 200);
assert.strictEqual(response.data.items[0].symbol, "300502.SZ");
assert.strictEqual(response.data.items[0].exchange, "SZ");
assert.strictEqual(response.data.items[0].board, "创业板");
assert.strictEqual(response.data.dataMode, "fixture");

response = invoke({ q: "3005" });
assert.strictEqual(response.status, 200);
assert.strictEqual(response.data.items[0].name, "新易盛");

response = invoke({ q: "样本" });
assert.strictEqual(response.status, 200);
assert.ok(response.data.items.length <= 8);
assert.ok(response.data.items.some((item) => item.symbol === "301999.SZ"));

response = invoke({});
assert.strictEqual(response.status, 400);
assert.strictEqual(response.data.error, "EMPTY_QUERY");

response = invoke({ q: "3" });
assert.strictEqual(response.status, 400);
assert.strictEqual(response.data.error, "QUERY_TOO_SHORT");

response = invoke({ q: "新易" }, "POST");
assert.strictEqual(response.status, 405);

const previousVercelEnv = process.env.VERCEL_ENV;
const previousFixtureFlag = process.env.STOCK_YTD_FIXTURE_ENABLED;
process.env.VERCEL_ENV = "production";
process.env.STOCK_YTD_FIXTURE_ENABLED = "0";
response = invoke({ q: "新易" });
assert.strictEqual(response.status, 503);
assert.strictEqual(response.data.error, "STOCK_DATA_NOT_READY");
if (previousVercelEnv === undefined) delete process.env.VERCEL_ENV;
else process.env.VERCEL_ENV = previousVercelEnv;
if (previousFixtureFlag === undefined) delete process.env.STOCK_YTD_FIXTURE_ENABLED;
else process.env.STOCK_YTD_FIXTURE_ENABLED = previousFixtureFlag;

console.log("stock search API tests passed");
