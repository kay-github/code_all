const assert = require("assert");

process.env.NODE_ENV = "test";
const handler = require("../api/stock-ytd");

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
    data: res.body ? JSON.parse(res.body) : null
  };
}

let response = invoke({ symbol: "300502.SZ", includeBse: "false" });
assert.strictEqual(response.status, 200);
assert.strictEqual(response.data.stock.name, "新易盛");
assert.strictEqual(response.data.stock.direction, "UP");
assert.strictEqual(response.data.comparison.peerCount, 6);
assert.strictEqual(response.data.benchmark.symbol, "000300.SH");
assert.strictEqual(response.data.dataMode, "fixture");
const ytd = response.data.stock.ytd;

response = invoke({ symbol: "300502.SZ", includeBse: "true" });
assert.strictEqual(response.status, 200);
assert.strictEqual(response.data.comparison.peerCount, 7);
assert.strictEqual(response.data.stock.ytd, ytd);

response = invoke({ symbol: "920001.BJ", includeBse: "false" });
assert.strictEqual(response.status, 200);
assert.strictEqual(response.data.comparison.targetInPool, false);
assert.strictEqual(response.data.comparison.peerCount, 7);

response = invoke({ symbol: "301999.SZ" });
assert.strictEqual(response.status, 200);
assert.strictEqual(response.data.stock.ineligibilityReason, "NEW_LISTING");
assert.strictEqual(response.data.comparison, null);

response = invoke({ symbol: "bad" });
assert.strictEqual(response.status, 400);
assert.strictEqual(response.data.error, "INVALID_SYMBOL");

response = invoke({ symbol: "999999.SH" });
assert.strictEqual(response.status, 404);
assert.strictEqual(response.data.error, "STOCK_NOT_FOUND");

response = invoke({ symbol: "300502.SZ", includeBse: "maybe" });
assert.strictEqual(response.status, 400);
assert.strictEqual(response.data.error, "INVALID_INCLUDE_BSE");

response = invoke({ symbol: "300502.SZ" }, "POST");
assert.strictEqual(response.status, 405);

console.log("stock YTD API tests passed");
