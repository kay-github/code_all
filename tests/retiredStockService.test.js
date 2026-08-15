"use strict";

const assert = require("assert");
const handler = require("../api/retired-stock-service");

const headers = new Map();
let statusCode = null;
let payload = null;
const res = {
  setHeader(name, value) {
    headers.set(name, value);
  },
  status(code) {
    statusCode = code;
    return this;
  },
  json(value) {
    payload = value;
  }
};

handler({}, res);

assert.strictEqual(statusCode, 410);
assert.strictEqual(headers.get("Cache-Control"), "public, max-age=300");
assert.deepStrictEqual(payload, {
  error: {
    code: "STOCK_SERVICE_RETIRED",
    message: "股票 YTD 与区间统计服务已下线。",
    retiredAt: "2026-08-15"
  }
});

console.log("retired stock service tests passed");
