const assert = require("assert");
const {
  buildCsi300Benchmark,
  assertBenchmarkPublishable
} = require("../lib/stockBenchmark");

const rows = [
  { ts_code: "000300.SH", trade_date: "20251231", close: 4000 },
  { ts_code: "000300.SH", trade_date: "20260710", close: 4400 }
];
const benchmark = buildCsi300Benchmark(rows, {
  baseDate: "2025-12-31",
  asOf: "2026-07-10"
});
assert.ok(Math.abs(benchmark.ytd - 0.1) < 1e-12);
assert.strictEqual(benchmark.type, "PRICE_INDEX");
assertBenchmarkPublishable(benchmark, {
  baseDate: "2025-12-31",
  asOf: "2026-07-10"
});

const baostockBenchmark = buildCsi300Benchmark(rows, {
  baseDate: "2025-12-31",
  asOf: "2026-07-10",
  source: "baostock"
});
assert.strictEqual(baostockBenchmark.source, "baostock");

assert.throws(
  () => buildCsi300Benchmark(rows.slice(0, 1), {
    baseDate: "2025-12-31",
    asOf: "2026-07-10"
  }),
  (error) => error.code === "CSI300_ENDPOINT_MISSING"
);

assert.throws(
  () => buildCsi300Benchmark(rows.concat(rows[1]), {
    baseDate: "2025-12-31",
    asOf: "2026-07-10"
  }),
  (error) => error.code === "CSI300_DUPLICATE_ENDPOINT"
);

assert.throws(
  () => buildCsi300Benchmark([
    rows[0],
    { ...rows[1], close: 0 }
  ], {
    baseDate: "2025-12-31",
    asOf: "2026-07-10"
  }),
  (error) => error.code === "CSI300_INVALID_CLOSE"
);

assert.throws(
  () => assertBenchmarkPublishable(benchmark, {
    baseDate: "2025-12-31",
    asOf: "2026-07-11"
  }),
  (error) => error.code === "CSI300_DATE_MISMATCH"
);

console.log("stock benchmark tests passed");
