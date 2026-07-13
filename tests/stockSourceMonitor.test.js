const assert = require("assert");
const {
  assessSymbol,
  assessMarketRows,
  countTushareExchanges,
  deriveExpectedDates,
  checkTushare,
  reportHasFailures
} = require("../scripts/check-stock-sources");

assert.deepStrictEqual(countTushareExchanges([
  { exchange: "SSE" },
  { exchange: "SZSE" },
  { exchange: "BSE" },
  { exchange: "unexpected" }
]), { SH: 1, SZ: 1, BSE: 1, UNKNOWN: 1 });

const symbolAssessment = assessSymbol(
  {
    ytd: 0.2,
    sourceAsOf: "2026-07-10"
  },
  [
    { date: "2025-12-31", close: 10 },
    { date: "2026-07-10", close: 12 }
  ],
  {
    baseDate: "2025-12-31",
    expectedAsOf: "2026-07-10"
  }
);
assert.strictEqual(symbolAssessment.status, "PASS");

assert.throws(
  () => assessSymbol(
    { ytd: 0.2, sourceAsOf: "2026-07-09" },
    [
      { date: "2025-12-31", close: 10 },
      { date: "2026-07-10", close: 12 }
    ],
    { baseDate: "2025-12-31", expectedAsOf: "2026-07-10" }
  ),
  /source dates do not match/
);

const marketRows = [
  { symbol: "600001.SH", exchange: "SH", ytd: 0.1 },
  { symbol: "000001.SZ", exchange: "SZ", ytd: 0.2 },
  { symbol: "920001.BJ", exchange: "BJ", ytd: 0.3 }
];
assert.strictEqual(
  assessMarketRows(marketRows, { minRows: 3, minBseRows: 1 }).status,
  "PASS"
);
assert.strictEqual(
  assessMarketRows(
    marketRows.concat(marketRows[0]),
    { minRows: 3, minBseRows: 1 }
  ).status,
  "FAIL"
);

const beforeCutoff = deriveExpectedDates(
  [
    { cal_date: "20251231", is_open: 1 },
    { cal_date: "20260709", is_open: 1 },
    { cal_date: "20260710", is_open: 1 }
  ],
  {
    year: "2026",
    month: "07",
    day: "10",
    hour: "17",
    minute: "00"
  }
);
assert.strictEqual(beforeCutoff.baseDate, "2025-12-31");
assert.strictEqual(beforeCutoff.expectedAsOf, "2026-07-09");

const afterCutoff = deriveExpectedDates(
  [
    { cal_date: "20251231", is_open: 1 },
    { cal_date: "20260709", is_open: 1 },
    { cal_date: "20260710", is_open: 1 }
  ],
  {
    year: "2026",
    month: "07",
    day: "10",
    hour: "18",
    minute: "30"
  }
);
assert.strictEqual(afterCutoff.expectedAsOf, "2026-07-10");

async function run() {
  const unavailable = await checkTushare({ env: {} });
  assert.strictEqual(unavailable.status, "UNAVAILABLE");

  const rows = {
    calendar: {
      rows: [
        { cal_date: "20251231", is_open: 1 },
        { cal_date: "20260710", is_open: 1 }
      ]
    },
    stock: {
      rows: [{
        ts_code: "300502.SZ",
        name: "新易盛",
        market: "创业板",
        exchange: "SZSE",
        curr_type: "CNY",
        list_date: "20160303",
        list_status: "L"
      }]
    },
    baseDaily: {
      rows: [{ ts_code: "300502.SZ", trade_date: "20251231", close: 10 }]
    },
    baseFactors: {
      rows: [{ ts_code: "300502.SZ", trade_date: "20251231", adj_factor: 1 }]
    },
    currentDaily: {
      rows: [{ ts_code: "300502.SZ", trade_date: "20260710", close: 12 }]
    },
    currentFactors: {
      rows: [{ ts_code: "300502.SZ", trade_date: "20260710", adj_factor: 1 }]
    },
    index: {
      rows: [
        { ts_code: "000300.SH", trade_date: "20251231", close: 4000 },
        { ts_code: "000300.SH", trade_date: "20260710", close: 4400 }
      ]
    }
  };
  let dailyCalls = 0;
  let factorCalls = 0;
  const healthy = await checkTushare({
    env: { TUSHARE_TOKEN: "fixture-token" },
    nowParts: {
      year: "2026",
      month: "07",
      day: "10",
      hour: "19",
      minute: "00"
    },
    minStockCount: 1,
    minDailyCount: 1,
    minFactorCount: 1,
    clients: {
      fetchTushareTradeCalendar: async () => rows.calendar,
      fetchTushareStockBasic: async () => rows.stock,
      fetchTushareDaily: async () => {
        dailyCalls += 1;
        return dailyCalls === 1 ? rows.baseDaily : rows.currentDaily;
      },
      fetchTushareAdjFactors: async () => {
        factorCalls += 1;
        return factorCalls === 1 ? rows.baseFactors : rows.currentFactors;
      },
      fetchTushareIndexDaily: async () => rows.index
    }
  });
  assert.strictEqual(healthy.status, "PASS");
  assert.strictEqual(healthy.expectedAsOf, "2026-07-10");
  assert.ok(Math.abs(healthy.sentinelYtd - 0.2) < 1e-12);
  assert.ok(Math.abs(healthy.benchmarkYtd - 0.1) < 1e-12);
  assert.strictEqual(healthy.counts.newListings, 0);
  assert.deepStrictEqual(healthy.counts.stockBasicByExchange, {
    SH: 0,
    SZ: 1,
    BSE: 0,
    UNKNOWN: 0
  });
  assert.deepStrictEqual(healthy.counts.masterByExchange, {
    SH: 0,
    SZ: 1,
    BSE: 0,
    UNKNOWN: 0
  });

  const lowCoverage = await checkTushare({
    env: { TUSHARE_TOKEN: "fixture-token" },
    nowParts: {
      year: "2026",
      month: "07",
      day: "10",
      hour: "19",
      minute: "00"
    },
    minStockCount: 1,
    clients: {
      fetchTushareTradeCalendar: async () => rows.calendar,
      fetchTushareStockBasic: async () => ({
        rows: rows.stock.rows.concat([{
          ts_code: "600000.SH",
          name: "缺失股票",
          market: "主板",
          exchange: "SSE",
          curr_type: "CNY",
          list_date: "19991110",
          list_status: "L"
        }])
      }),
      fetchTushareYtdDataset: async () => ({
        baseDate: "2025-12-31",
        asOf: "2026-07-10",
        expectedUniverseCount: 2,
        stocks: rows.stock.rows.concat([{
          ts_code: "600000.SH",
          name: "缺失股票",
          market: "主板",
          exchange: "SSE",
          curr_type: "CNY",
          list_date: "19991110",
          list_status: "L"
        }]),
        dailyBars: rows.baseDaily.rows.concat(rows.currentDaily.rows),
        adjFactors: rows.baseFactors.rows.concat(rows.currentFactors.rows),
        backfill: {
          baseMissingSymbols: ["600000.SH"],
          currentMissingSymbols: ["600000.SH"]
        }
      }),
      fetchTushareIndexDaily: async () => rows.index
    }
  });
  assert.strictEqual(lowCoverage.status, "FAIL");
  assert.ok(lowCoverage.failures.includes("COMPUTED_YTD_COVERAGE_LOW"));

  assert.strictEqual(
    reportHasFailures({
      symbols: [{ tencent: { status: "UNAVAILABLE" } }],
      market: null,
      tushare: { status: "PASS" }
    }),
    true
  );
  assert.strictEqual(
    reportHasFailures({
      symbols: [{ tencent: { status: "PASS" } }],
      market: null,
      tushare: { status: "UNAVAILABLE" }
    }),
    true
  );
  assert.strictEqual(
    reportHasFailures({
      symbols: [{ tencent: { status: "PASS" } }],
      market: null,
      tushare: { status: "UNAVAILABLE" }
    }, { allowMissingTushare: true }),
    false
  );

  console.log("stock source monitor tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
