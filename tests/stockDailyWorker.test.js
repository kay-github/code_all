const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const {
  filterEastmoneyReferences,
  runStockDailyWorker
} = require("../lib/stockDailyWorker");
const { preparePublishedSnapshot } = require("../lib/stockPublishedSnapshot");
const { loadCurrentEnvelope } = require("../lib/stockSnapshotFileStore");

const BASE_DATE = "2025-12-31";
const AS_OF = "2026-07-10";

const stocks = [
  {
    ts_code: "300502.SZ",
    name: "新易盛",
    market: "创业板",
    exchange: "SZSE",
    curr_type: "CNY",
    list_date: "20160303",
    list_status: "L"
  },
  {
    ts_code: "600000.SH",
    name: "沪市样本",
    market: "主板",
    exchange: "SSE",
    curr_type: "CNY",
    list_date: "19991110",
    list_status: "L"
  }
];

const dataset = {
  baseDate: BASE_DATE,
  asOf: AS_OF,
  stocks,
  expectedUniverseCount: 2,
  dailyBars: [
    { ts_code: "300502.SZ", trade_date: "20251231", close: 10 },
    { ts_code: "300502.SZ", trade_date: "20260710", close: 12 },
    { ts_code: "600000.SH", trade_date: "20251231", close: 10 },
    { ts_code: "600000.SH", trade_date: "20260710", close: 11 }
  ],
  adjFactors: [
    { ts_code: "300502.SZ", trade_date: "20251231", adj_factor: 1 },
    { ts_code: "300502.SZ", trade_date: "20260710", adj_factor: 1 },
    { ts_code: "600000.SH", trade_date: "20251231", adj_factor: 1 },
    { ts_code: "600000.SH", trade_date: "20260710", adj_factor: 1 }
  ],
  backfill: {
    baseMissingSymbols: [],
    currentMissingSymbols: []
  }
};

const referenceRows = [
  {
    symbol: "300502.SZ",
    code: "300502",
    name: "新易盛",
    exchange: "SZ",
    ytd: 0.2,
    sourceAsOf: AS_OF
  },
  {
    symbol: "600000.SH",
    code: "600000",
    name: "沪市样本",
    exchange: "SH",
    ytd: 0.1,
    sourceAsOf: AS_OF
  }
];

function calendarRows(includeNextDay = false) {
  return [
    { cal_date: "20251231", is_open: 1 },
    { cal_date: "20260710", is_open: 1 },
    ...(includeNextDay ? [{ cal_date: "20260711", is_open: 1 }] : [])
  ];
}

function clients(overrides = {}) {
  return {
    fetchTushareTradeCalendar: async () => ({ rows: calendarRows(true) }),
    fetchTushareStockBasic: async () => ({ rows: stocks }),
    fetchTushareYtdDataset: async () => dataset,
    fetchTushareIndexDaily: async () => ({
      rows: [
        { ts_code: "000300.SH", trade_date: "20251231", close: 4000 },
        { ts_code: "000300.SH", trade_date: "20260710", close: 4400 }
      ]
    }),
    fetchEastmoneyMarket: async () => referenceRows,
    ...overrides
  };
}

function priorYearClients() {
  return clients({
    fetchTushareTradeCalendar: async () => ({
      rows: [
        { cal_date: "20241231", is_open: 1 },
        { cal_date: "20251231", is_open: 1 }
      ]
    }),
    fetchTushareYtdDataset: async () => ({
      ...dataset,
      baseDate: "2024-12-31",
      asOf: "2025-12-31",
      dailyBars: [
        { ts_code: "300502.SZ", trade_date: "20241231", close: 10 },
        { ts_code: "300502.SZ", trade_date: "20251231", close: 12 },
        { ts_code: "600000.SH", trade_date: "20241231", close: 10 },
        { ts_code: "600000.SH", trade_date: "20251231", close: 11 }
      ],
      adjFactors: [
        { ts_code: "300502.SZ", trade_date: "20241231", adj_factor: 1 },
        { ts_code: "300502.SZ", trade_date: "20251231", adj_factor: 1 },
        { ts_code: "600000.SH", trade_date: "20241231", adj_factor: 1 },
        { ts_code: "600000.SH", trade_date: "20251231", adj_factor: 1 }
      ]
    }),
    fetchTushareIndexDaily: async () => ({
      rows: [
        { ts_code: "000300.SH", trade_date: "20241231", close: 4000 },
        { ts_code: "000300.SH", trade_date: "20251231", close: 4400 }
      ]
    }),
    fetchEastmoneyMarket: async () => referenceRows.map((row) => ({
      ...row,
      sourceAsOf: "2025-12-31"
    }))
  });
}

async function makeDirectory() {
  return fs.mkdtemp(path.join(os.tmpdir(), "stock-ytd-worker-"));
}

async function cleanDirectory(directory) {
  const resolved = path.resolve(directory);
  const tempRoot = path.resolve(os.tmpdir()) + path.sep;
  if (!resolved.startsWith(tempRoot)) {
    throw new Error("refusing to clean a directory outside the temp root");
  }
  await fs.rm(resolved, { recursive: true, force: true });
}

async function run() {
  const filtered = filterEastmoneyReferences(
    referenceRows.concat([{
      symbol: "999999.SH",
      code: "999999",
      name: "额外证券",
      exchange: "SH",
      ytd: 0.5,
      sourceAsOf: AS_OF
    }]),
    [{ symbol: "300502.SZ" }, { symbol: "600000.SH" }]
  );
  assert.strictEqual(filtered.length, 2);

  const directories = [];
  try {
    const normalDirectory = await makeDirectory();
    directories.push(normalDirectory);
    const normal = await runStockDailyWorker({
      directory: normalDirectory,
      now: new Date("2026-07-10T11:00:00.000Z"),
      publishedAt: "2026-07-10T11:00:00.000Z",
      clients: clients()
    });
    assert.strictEqual(normal.status, "published");
    assert.strictEqual(normal.sourceMode, "validated");
    let current = await loadCurrentEnvelope(normalDirectory);
    assert.strictEqual(current.refreshStatus, "PUBLISHED");
    assert.ok(current.snapshot.benchmark);
    assert.strictEqual(current.snapshot.quality.coverage.ratio, 1);

    const noOp = await runStockDailyWorker({
      directory: normalDirectory,
      now: new Date("2026-07-10T11:05:00.000Z"),
      clients: clients()
    });
    assert.strictEqual(noOp.status, "no-op");
    assert.strictEqual(noOp.snapshotId, normal.snapshotId);

    const calendarFallback = await runStockDailyWorker({
      directory: normalDirectory,
      now: new Date("2026-07-10T11:06:00.000Z"),
      clients: clients({
        fetchTushareTradeCalendar: async () => {
          const error = new Error("calendar unavailable");
          error.code = "CALENDAR_UNAVAILABLE";
          throw error;
        }
      })
    });
    assert.strictEqual(calendarFallback.status, "no-op");
    assert.strictEqual(calendarFallback.calendarFailureCode, "CALENDAR_UNAVAILABLE");
    current = await loadCurrentEnvelope(normalDirectory);
    assert.strictEqual(current.refreshStatus, "PUBLISHED");
    assert.strictEqual(current.expectedAsOf, AS_OF);
    assert.deepStrictEqual(current.errorCodes, []);

    const recoveredNoOp = await runStockDailyWorker({
      directory: normalDirectory,
      now: new Date("2026-07-10T11:07:00.000Z"),
      clients: clients()
    });
    assert.strictEqual(recoveredNoOp.status, "no-op");
    current = await loadCurrentEnvelope(normalDirectory);
    assert.strictEqual(current.refreshStatus, "PUBLISHED");
    assert.deepStrictEqual(current.errorCodes, []);

    await assert.rejects(
      runStockDailyWorker({
        directory: normalDirectory,
        now: new Date("2026-07-11T11:00:00.000Z"),
        clients: clients({
          fetchTushareTradeCalendar: async () => {
            const error = new Error("calendar unavailable");
            error.code = "CALENDAR_UNAVAILABLE";
            throw error;
          },
          fetchTushareStockBasic: async () => {
            const error = new Error("Tushare unavailable");
            error.code = "NETWORK_ERROR";
            throw error;
          }
        })
      }),
      (error) => error.code === "STOCK_REFRESH_SERVING_PREVIOUS" &&
        error.details.causeCode === "NETWORK_ERROR"
    );
    current = await loadCurrentEnvelope(normalDirectory);
    assert.strictEqual(current.snapshotId, normal.snapshotId);
    assert.strictEqual(current.expectedAsOf, "2026-07-11");
    assert.strictEqual(current.refreshStatus, "SERVING_PREVIOUS");
    const staleView = preparePublishedSnapshot(current, {
      VERCEL_ENV: "production"
    });
    assert.strictEqual(staleView.isStale, true);

    const fallbackDirectory = await makeDirectory();
    directories.push(fallbackDirectory);
    const fallback = await runStockDailyWorker({
      directory: fallbackDirectory,
      now: new Date("2026-07-10T11:00:00.000Z"),
      publishedAt: "2026-07-10T11:00:00.000Z",
      clients: clients({
        fetchEastmoneyMarket: async () => {
          const error = new Error("Eastmoney unavailable");
          error.code = "NETWORK_ERROR";
          throw error;
        }
      })
    });
    assert.strictEqual(fallback.status, "published");
    assert.strictEqual(fallback.sourceMode, "computed-fallback");
    current = await loadCurrentEnvelope(fallbackDirectory);
    assert.deepStrictEqual(current.warningCodes, ["NETWORK_ERROR"]);

    const qualityDirectory = await makeDirectory();
    directories.push(qualityDirectory);
    const initial = await runStockDailyWorker({
      directory: qualityDirectory,
      now: new Date("2026-07-10T11:00:00.000Z"),
      publishedAt: "2026-07-10T11:00:00.000Z",
      clients: clients()
    });
    await assert.rejects(
      runStockDailyWorker({
        directory: qualityDirectory,
        now: new Date("2026-07-10T11:10:00.000Z"),
        force: true,
        clients: clients({
          fetchEastmoneyMarket: async () => [
            { ...referenceRows[0], ytd: 0.5 },
            referenceRows[1]
          ]
        })
      }),
      (error) => error.code === "STOCK_REFRESH_SERVING_PREVIOUS" &&
        error.details.causeCode === "SNAPSHOT_NOT_PUBLISHABLE"
    );
    current = await loadCurrentEnvelope(qualityDirectory);
    assert.strictEqual(current.snapshotId, initial.snapshotId);
    assert.strictEqual(current.refreshStatus, "SERVING_PREVIOUS");

    const rolloverDirectory = await makeDirectory();
    directories.push(rolloverDirectory);
    const priorYear = await runStockDailyWorker({
      directory: rolloverDirectory,
      now: new Date("2025-12-31T11:00:00.000Z"),
      clients: priorYearClients()
    });
    assert.strictEqual(priorYear.status, "published");
    const rollover = await runStockDailyWorker({
      directory: rolloverDirectory,
      now: new Date("2026-01-01T11:00:00.000Z"),
      clients: clients({
        fetchTushareTradeCalendar: async () => ({
          rows: [
            { cal_date: "20251231", is_open: 1 }
          ]
        })
      })
    });
    assert.strictEqual(rollover.status, "published");
    assert.strictEqual(rollover.sourceMode, "computed-fallback");
    assert.strictEqual(rollover.referenceFailureCode, "YTD_PERIOD_RESET");
    current = await loadCurrentEnvelope(rolloverDirectory);
    assert.strictEqual(current.snapshot.baseDate, "2025-12-31");
    assert.strictEqual(current.snapshot.asOf, "2025-12-31");
    assert.strictEqual(current.snapshot.benchmark.ytd, 0);
    assert.ok(current.snapshot.dataWarning.includes("重置为 0"));
    assert.ok(current.snapshot.records
      .filter((record) => record.isEligible)
      .every((record) => record.ytd === 0));
  } finally {
    for (const directory of directories) {
      await cleanDirectory(directory);
    }
  }

  console.log("stock daily worker tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
