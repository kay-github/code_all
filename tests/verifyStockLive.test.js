"use strict";

const assert = require("assert");
const { verify, checkCoverage } = require("../scripts/verify-stock-live");

assert.deepStrictEqual(
  checkCoverage(
    ["2025-12-31", "2026-07-15", "2026-07-16", "2026-07-17"],
    "2025-12-31",
    "2026-07-17",
    ["2025-12-31", "2026-07-15"]
  ),
  ["2026-07-16"],
  "asOf 之前缺失的交易日必须被点名，asOf 当日不在基准日范围内"
);

function fakeFetch(routes) {
  return async (url) => {
    const key = Object.keys(routes).find((path) => String(url).includes(path));
    if (!key) throw new Error(`unexpected url: ${url}`);
    const body = routes[key];
    return {
      ok: body.status === undefined || body.status === 200,
      status: body.status || 200,
      async json() { return body.data; }
    };
  };
}

const calendar = {
  version: "sse-trading-calendar.v1",
  coveredFrom: "2025-12-01",
  coveredThrough: "2026-08-31",
  openDates: ["2025-12-31", "2026-07-16", "2026-07-17"]
};

async function run() {
  // 全部达标：READY、asOf 为最新交易日、基准日无空洞、series 覆盖当日。
  let result = await verify({
    now: "2026-07-17T21:35:00+08:00",
    fetchImpl: fakeFetch({
      "stock-health": { data: { status: "READY", isStale: false, asOf: "2026-07-17" } },
      "stock-snapshot": { data: { tradingCalendar: calendar } },
      "dates=1": { data: { availableBaseDates: ["2025-12-31", "2026-07-16"] } },
      "series=1": { data: { series: { days: [{ date: "2026-07-17" }] } } }
    })
  });
  assert.strictEqual(result.ok, true, JSON.stringify(result.problems));
  assert.strictEqual(result.seriesDayCount, 1);

  // 基准日空洞 + series 缺当日 + 快照过期，全部点名。
  result = await verify({
    now: "2026-07-17T21:35:00+08:00",
    fetchImpl: fakeFetch({
      "stock-health": { data: { status: "READY", isStale: true, asOf: "2026-07-17" } },
      "stock-snapshot": { data: { tradingCalendar: calendar } },
      "dates=1": { data: { availableBaseDates: ["2025-12-31"] } },
      "series=1": { data: { series: { days: [{ date: "2026-07-16" }] } } }
    })
  });
  assert.strictEqual(result.ok, false);
  assert.ok(result.problems.some((item) => item.includes("stale")));
  assert.ok(result.problems.some((item) => item.includes("2026-07-16")));
  assert.ok(result.problems.some((item) => item.includes("series is missing")));

  // 16:00 截止点前 asOf 应为上一交易日；series 未建立（404）属引导期。
  result = await verify({
    now: "2026-07-17T15:30:00+08:00",
    fetchImpl: fakeFetch({
      "stock-health": { data: { status: "READY", isStale: false, asOf: "2026-07-16" } },
      "stock-snapshot": { data: { tradingCalendar: calendar } },
      "dates=1": { data: { availableBaseDates: ["2025-12-31"] } },
      "series=1": { status: 404, data: { error: "SERIES_UNAVAILABLE" } }
    })
  });
  assert.strictEqual(result.expectedAsOf, "2026-07-16");
  assert.strictEqual(result.seriesDayCount, null);
  assert.ok(!result.problems.some((item) => item.includes("series")));

  console.log("verify stock live tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
