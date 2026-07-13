const assert = require("assert");
const {
  toTushareDate,
  normalizeTsCode,
  buildTushareComputedRecords,
  fetchTushareDaily,
  fetchTushareYtdDataset
} = require("../lib/tushareYtd");

function assertClose(actual, expected, tolerance = 1e-12) {
  assert.ok(Math.abs(actual - expected) <= tolerance);
}

assert.strictEqual(toTushareDate("2026-07-10"), "20260710");
assert.strictEqual(normalizeTsCode("920001.BSE"), "920001.BJ");

const stocks = [
  {
    ts_code: "600001.SH",
    name: "送股样本",
    market: "主板",
    exchange: "SSE",
    curr_type: "CNY",
    list_date: "20200101",
    list_status: "L"
  },
  {
    ts_code: "000001.SZ",
    name: "停牌样本",
    market: "主板",
    exchange: "SZSE",
    curr_type: "CNY",
    list_date: "19910403",
    list_status: "L"
  },
  {
    ts_code: "000002.SZ",
    name: "全年停牌样本",
    market: "主板",
    exchange: "SZSE",
    curr_type: "CNY",
    list_date: "19910129",
    list_status: "L"
  },
  {
    ts_code: "920001.BJ",
    name: "新股样本",
    market: "北交所",
    exchange: "BSE",
    curr_type: "CNY",
    list_date: "20260501",
    list_status: "L"
  },
  {
    ts_code: "688001.SH",
    name: "缺因子样本",
    market: "科创板",
    exchange: "SSE",
    curr_type: "CNY",
    list_date: "20200101",
    list_status: "L"
  }
];
const dailyBars = [
  { ts_code: "600001.SH", trade_date: "20251231", close: 20 },
  { ts_code: "600001.SH", trade_date: "20260710", close: 10 },
  { ts_code: "000001.SZ", trade_date: "20251230", close: 10 },
  { ts_code: "000001.SZ", trade_date: "20260708", close: 9 },
  { ts_code: "000002.SZ", trade_date: "20251230", close: 10 },
  { ts_code: "688001.SH", trade_date: "20251231", close: 10 },
  { ts_code: "688001.SH", trade_date: "20260710", close: 12 }
];
const adjFactors = [
  { ts_code: "600001.SH", trade_date: "20251231", adj_factor: 1 },
  { ts_code: "600001.SH", trade_date: "20260710", adj_factor: 2 },
  { ts_code: "000001.SZ", trade_date: "20251230", adj_factor: 1 },
  { ts_code: "000001.SZ", trade_date: "20260708", adj_factor: 10 / 9 },
  { ts_code: "000002.SZ", trade_date: "20251230", adj_factor: 1 },
  { ts_code: "688001.SH", trade_date: "20251231", adj_factor: 1 }
];

const records = buildTushareComputedRecords({
  baseDate: "2025-12-31",
  asOf: "2026-07-10",
  stocks,
  dailyBars,
  adjFactors
});
const bonus = records.find((record) => record.symbol === "600001.SH");
assertClose(bonus.computedYtd, 0);
assert.strictEqual(bonus.baseRawClose, 20);
assert.strictEqual(bonus.lastRawClose, 10);

const suspended = records.find((record) => record.symbol === "000001.SZ");
assertClose(suspended.computedYtd, 0);
assert.strictEqual(suspended.basePriceDate, "2025-12-30");
assert.strictEqual(suspended.lastPriceDate, "2026-07-08");

const fullySuspended = records.find((record) => record.symbol === "000002.SZ");
assertClose(fullySuspended.computedYtd, 0);
assert.strictEqual(fullySuspended.basePriceDate, "2025-12-30");
assert.strictEqual(fullySuspended.lastPriceDate, "2025-12-30");

const newListing = records.find((record) => record.symbol === "920001.BJ");
assert.strictEqual(newListing.ineligibilityReason, "NEW_LISTING");

const missingFactor = records.find((record) => record.symbol === "688001.SH");
assert.strictEqual(missingFactor.ineligibilityReason, "MISSING_ADJ_FACTOR");

assert.throws(
  () => buildTushareComputedRecords({
    baseDate: "2025-12-31",
    asOf: "2026-07-10",
    stocks: [stocks[0]],
    dailyBars: [dailyBars[0], dailyBars[0]],
    adjFactors
  }),
  /duplicate Tushare daily bar/
);

let requestBody;
fetchTushareDaily("2026-07-10", {
  env: { TUSHARE_TOKEN: "fixture-token" },
  retries: 0,
  fetchImpl: async (url, options) => {
    requestBody = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          code: 0,
          data: {
            fields: ["ts_code", "trade_date", "close"],
            items: [["300502.SZ", "20260710", 523.05]]
          }
        };
      }
    };
  }
}).then(async (result) => {
  assert.strictEqual(requestBody.api_name, "daily");
  assert.deepStrictEqual(requestBody.params, { trade_date: "20260710" });
  assert.strictEqual(result.rows[0].close, 523.05);

  const datasetStocks = [
    {
      ts_code: "300502.SZ",
      name: "正常股票",
      market: "创业板",
      exchange: "SZSE",
      curr_type: "CNY",
      list_date: "20160303",
      list_status: "L"
    },
    {
      ts_code: "600001.SH",
      name: "停牌股票",
      market: "主板",
      exchange: "SSE",
      curr_type: "CNY",
      list_date: "20200101",
      list_status: "L"
    },
    {
      ts_code: "301999.SZ",
      name: "当年新股",
      market: "创业板",
      exchange: "SZSE",
      curr_type: "CNY",
      list_date: "20260501",
      list_status: "L"
    },
    {
      ts_code: "689009.SH",
      name: "存托凭证样本",
      market: "CDR",
      exchange: "SSE",
      curr_type: "CNY",
      list_date: "20200101",
      list_status: "L"
    },
    {
      ts_code: "200001.SZ",
      name: "B股样本",
      market: "主板",
      exchange: "SZSE",
      curr_type: "HKD",
      list_date: "20200101",
      list_status: "L"
    }
  ];
  const dataset = await fetchTushareYtdDataset({
    baseDate: "2025-12-31",
    asOf: "2026-07-10",
    stocks: datasetStocks,
    maxBackfillSymbols: 10,
    clients: {
      fetchTushareDaily: async (date) => ({
        rows: [{
          ts_code: "300502.SZ",
          trade_date: date,
          close: date === "2025-12-31" ? 10 : 12
        }]
      }),
      fetchTushareAdjFactors: async (date) => ({
        rows: [{
          ts_code: "300502.SZ",
          trade_date: date,
          adj_factor: 1
        }]
      }),
      fetchTushareDailyHistory: async (symbol, startDate, endDate) => ({
        rows: endDate === "2025-12-31"
          ? [{ ts_code: symbol, trade_date: "2025-12-30", close: 10 }]
          : [
            { ts_code: symbol, trade_date: "2025-12-30", close: 10 },
            { ts_code: symbol, trade_date: "2026-07-08", close: 9 }
          ]
      }),
      fetchTushareAdjFactorHistory: async (symbol, startDate, endDate) => ({
        rows: endDate === "2025-12-31"
          ? [{ ts_code: symbol, trade_date: "2025-12-30", adj_factor: 1 }]
          : [
            { ts_code: symbol, trade_date: "2025-12-30", adj_factor: 1 },
            { ts_code: symbol, trade_date: "2026-07-08", adj_factor: 10 / 9 }
          ]
      })
    }
  });
  assert.strictEqual(dataset.expectedUniverseCount, 2);
  assert.strictEqual(dataset.stocks.length, 3);
  assert.strictEqual(dataset.stocks.some((item) => item.ts_code === "689009.SH"), false);
  assert.strictEqual(dataset.stocks.some((item) => item.ts_code === "200001.SZ"), false);
  assert.deepStrictEqual(dataset.backfill.baseMissingSymbols, ["600001.SH"]);
  assert.deepStrictEqual(dataset.backfill.currentMissingSymbols, ["600001.SH"]);
  const datasetRecords = buildTushareComputedRecords({
    baseDate: dataset.baseDate,
    asOf: dataset.asOf,
    stocks: dataset.stocks,
    dailyBars: dataset.dailyBars,
    adjFactors: dataset.adjFactors
  });
  const backfilled = datasetRecords.find((item) => item.symbol === "600001.SH");
  assertClose(backfilled.computedYtd, 0);
  assert.strictEqual(backfilled.basePriceDate, "2025-12-30");
  assert.strictEqual(backfilled.lastPriceDate, "2026-07-08");
  const datasetNewListing = datasetRecords.find((item) => item.symbol === "301999.SZ");
  assert.strictEqual(datasetNewListing.ineligibilityReason, "NEW_LISTING");

  await assert.rejects(
    fetchTushareYtdDataset({
      baseDate: "2025-12-31",
      asOf: "2026-07-10",
      stocks: [datasetStocks[0]],
      clients: {
        fetchTushareDaily: async (date) => ({
          rows: [{
            ts_code: "300502.SZ",
            trade_date: date,
            close: date === "2025-12-31" ? 10 : null
          }]
        }),
        fetchTushareAdjFactors: async (date) => ({
          rows: [{ ts_code: "300502.SZ", trade_date: date, adj_factor: 1 }]
        })
      }
    }),
    (error) => error.code === "TUSHARE_INVALID_ENDPOINT_ROW"
  );

  await assert.rejects(
    fetchTushareYtdDataset({
      baseDate: "2025-12-31",
      asOf: "2026-07-10",
      stocks: datasetStocks,
      maxBackfillSymbols: 0,
      clients: {
        fetchTushareDaily: async () => ({ rows: [] }),
        fetchTushareAdjFactors: async () => ({ rows: [] })
      }
    }),
    (error) => error.code === "TUSHARE_BACKFILL_LIMIT_EXCEEDED"
  );

  console.log("Tushare YTD tests passed");
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
