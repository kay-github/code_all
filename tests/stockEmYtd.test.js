"use strict";

const assert = require("assert");
const {
  METHODOLOGY_VERSION,
  POOL_VERSION,
  tencentSymbol,
  normalizeEastmoneyListingDate,
  boardForCode,
  buildComputedRecords,
  parseTencentIndexRows,
  runSentinelGate,
  buildEmSnapshot
} = require("../lib/stockEmYtd");
const { queryStockSnapshot } = require("../lib/stockSnapshot");
const { validatePublishedSnapshot } = require("../lib/stockPublishedSnapshot");

const BASE_DATE = "2025-12-31";
const AS_OF = "2026-07-15";

function makeCalendar() {
  const openDates = [BASE_DATE];
  // 2026 年每周一至周五近似开市日，覆盖 asOf 与未来若干天
  const start = new Date(Date.UTC(2026, 0, 1));
  for (let i = 0; i < 240; i += 1) {
    const date = new Date(start.getTime() + i * 86400000);
    const day = date.getUTCDay();
    if (day === 0 || day === 6) continue;
    openDates.push(date.toISOString().slice(0, 10));
  }
  return {
    version: "sse-trading-calendar.v1",
    coveredFrom: "2025-12-01",
    coveredThrough: "2026-08-31",
    openDates: openDates.filter((date) => date <= "2026-08-31")
  };
}

function marketRow(code, exchange, ytd, extra = {}) {
  const suffix = exchange === "BJ" ? "BJ" : exchange;
  return {
    source: "eastmoney",
    code,
    exchange,
    symbol: `${code}.${suffix}`,
    name: `股票${code}`,
    ytd,
    listingDate: "20200101",
    ...extra
  };
}

function makeMarketRows(count) {
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    const code = String(600000 + i).padStart(6, "0");
    rows.push(marketRow(code, "SH", (i % 200 - 100) / 1000));
  }
  return rows;
}

// --- 基础工具 ---
assert.strictEqual(tencentSymbol("300502.SZ"), "sz300502");
assert.strictEqual(tencentSymbol("600989.SH"), "sh600989");
assert.strictEqual(normalizeEastmoneyListingDate("20260105"), "2026-01-05");
assert.strictEqual(normalizeEastmoneyListingDate("-"), null);
assert.strictEqual(boardForCode("688001", "SH"), "科创板");
assert.strictEqual(boardForCode("300502", "SZ"), "创业板");
assert.strictEqual(boardForCode("920001", "BJ"), "北交所");
assert.strictEqual(boardForCode("600519", "SH"), "主板");

// --- buildComputedRecords：新股豁免、缺 YTD 统计、BJ→BSE ---
{
  const dates = { baseDate: BASE_DATE, expectedAsOf: AS_OF };
  const { records, missingYtd } = buildComputedRecords([
    marketRow("600519", "SH", 0.1),
    marketRow("920001", "BJ", 0.25),
    marketRow("301999", "SZ", null, { listingDate: "20260501" }),
    marketRow("688825", "SH", 0.3, { listingDate: null }),
    marketRow("600000", "SH", null)
  ], dates);
  assert.strictEqual(records.length, 4);
  assert.strictEqual(missingYtd, 1);
  const newListing = records.find((r) => r.symbol === "301999.SZ");
  assert.strictEqual(newListing.ineligibilityReason, "NEW_LISTING");
  assert.strictEqual(newListing.computedYtd, null);
  // 东财缺上市日期（新股常见）按 NEW_LISTING 排除，不产生隔离告警
  const missingListing = records.find((r) => r.symbol === "688825.SH");
  assert.strictEqual(missingListing.ineligibilityReason, "NEW_LISTING");
  assert.strictEqual(missingListing.computedYtd, null);
  const bse = records.find((r) => r.symbol === "920001.BJ");
  assert.strictEqual(bse.exchange, "BSE");
  assert.strictEqual(records[0].source, "eastmoney");
  assert.strictEqual(records[0].adjustmentMethod, "reported");
}

// --- parseTencentIndexRows ---
{
  const rows = parseTencentIndexRows({
    data: { sh000300: { day: [[BASE_DATE, "4600", "4629.94"], [AS_OF, "4700", "4786.78"]] } }
  }, "sh000300");
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].ts_code, "000300.SH");
  assert.strictEqual(rows[1].close, 4786.78);
}

async function run() {
  const dates = { baseDate: BASE_DATE, expectedAsOf: AS_OF };

  // --- 哨兵闸门：通过 ---
  {
    const recordsBySymbol = new Map([
      ["300502.SZ", { computedYtd: 0.8107 }],
      ["600519.SH", { computedYtd: -0.05 }]
    ]);
    const fetchTencentQfqKlines = async (symbol) => {
      const base = 100;
      const ytd = symbol === "sz300502" ? 0.8104 : -0.0502;
      return [
        { date: BASE_DATE, close: base },
        { date: AS_OF, close: base * (1 + ytd) }
      ];
    };
    const gate = await runSentinelGate(recordsBySymbol, dates, {
      sentinelSymbols: ["300502.SZ", "600519.SH"],
      fetchTencentQfqKlines
    });
    assert.strictEqual(gate.comparable, 2);
    assert.ok(gate.results.every((item) => item.status === "PASS"));
  }

  // --- 哨兵闸门：偏差超限 → 拒绝整批 ---
  {
    const recordsBySymbol = new Map([["300502.SZ", { computedYtd: 0.8107 }]]);
    const fetchTencentQfqKlines = async () => [
      { date: BASE_DATE, close: 100 },
      { date: AS_OF, close: 150 } // 50% vs 81.07% → 远超 100bp
    ];
    await assert.rejects(
      () => runSentinelGate(recordsBySymbol, dates, {
        sentinelSymbols: ["300502.SZ"],
        fetchTencentQfqKlines
      }),
      (error) => error.code === "SENTINEL_DEVIATION_EXCEEDED"
    );
  }

  // --- 哨兵闸门：全部不可比 → 默认拒绝 ---
  {
    const fetchTencentQfqKlines = async () => {
      throw Object.assign(new Error("down"), { code: "SOURCE_DOWN" });
    };
    await assert.rejects(
      () => runSentinelGate(new Map([["300502.SZ", { computedYtd: 0.8 }]]), dates, {
        sentinelSymbols: ["300502.SZ"],
        fetchTencentQfqKlines
      }),
      (error) => error.code === "SENTINEL_UNAVAILABLE"
    );
  }

  // --- 端到端：buildEmSnapshot 生成可发布快照 ---
  {
    const rows = makeMarketRows(5300);
    rows.push(marketRow("300502", "SZ", 0.8107));
    rows.push(marketRow("920001", "BJ", 0.25));
    rows.push(marketRow("301999", "SZ", null, { listingDate: "20260501" }));
    const build = await buildEmSnapshot({
      tradingCalendar: makeCalendar(),
      now: new Date("2026-07-15T22:00:00+08:00"),
      fetchEastmoneyMarket: async () => rows,
      sentinelSymbols: ["300502.SZ"],
      fetchTencentQfqKlines: async () => [
        { date: BASE_DATE, close: 100 },
        { date: AS_OF, close: 181.07 }
      ],
      benchmarkOptions: {
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          headers: { get: () => "application/json" },
          async json() {
            return {
              code: 0,
              data: { sh000300: { day: [
                [BASE_DATE, "4600", "4629.94"],
                [AS_OF, "4700", "4786.78"]
              ] } }
            };
          },
          async text() { return ""; }
        })
      }
    });

    const snapshot = build.candidate;
    assert.strictEqual(snapshot.asOf, AS_OF);
    assert.strictEqual(snapshot.baseDate, BASE_DATE);
    assert.strictEqual(snapshot.methodologyVersion, METHODOLOGY_VERSION);
    assert.strictEqual(snapshot.poolVersion, POOL_VERSION);
    assert.strictEqual(snapshot.sourceMode, "reported");
    assert.strictEqual(snapshot.productionPublishable, true);
    assert.strictEqual(snapshot.quality.status, "pass");
    assert.deepStrictEqual(snapshot.quality.computedSources.active, ["eastmoney"]);
    assert.strictEqual(snapshot.benchmark.source, "tencent");
    assert.ok(Math.abs(snapshot.benchmark.ytd - (4786.78 / 4629.94 - 1)) < 1e-12);

    // 生产发布校验闸门也要放行 reported 快照
    validatePublishedSnapshot(snapshot, { VERCEL_ENV: "production" });

    // 查询：目标股 + 北交所开关语义
    const result = queryStockSnapshot(snapshot, "300502.SZ", { includeBse: false });
    assert.ok(Math.abs(result.stock.ytd - 0.8107) < 1e-12);
    assert.strictEqual(result.comparison.scope, "SH_SZ");
    const withBse = queryStockSnapshot(snapshot, "300502.SZ", { includeBse: true });
    assert.strictEqual(withBse.comparison.scope, "SH_SZ_BSE");
    assert.strictEqual(
      withBse.comparison.poolEligibleCount,
      result.comparison.poolEligibleCount + 1
    );

    // 新股不参与排名
    const newListing = queryStockSnapshot(snapshot, "301999.SZ", { includeBse: false });
    assert.strictEqual(newListing.comparison, null);
    assert.strictEqual(newListing.stock.ineligibilityReason, "NEW_LISTING");
  }

  // --- 端到端：requireAsOf 未就绪 → 阻断 ---
  {
    await assert.rejects(
      () => buildEmSnapshot({
        tradingCalendar: makeCalendar(),
        now: new Date("2026-07-15T22:00:00+08:00"),
        requireAsOf: "2026-07-16",
        fetchEastmoneyMarket: async () => makeMarketRows(5300)
      }),
      (error) => error.code === "AS_OF_NOT_READY"
    );
  }

  // --- 端到端：市场行数不足 → 阻断 ---
  {
    await assert.rejects(
      () => buildEmSnapshot({
        tradingCalendar: makeCalendar(),
        now: new Date("2026-07-15T22:00:00+08:00"),
        fetchEastmoneyMarket: async () => makeMarketRows(100)
      }),
      (error) => error.code === "MARKET_SWEEP_INCOMPLETE"
    );
  }

  console.log("stock EM YTD tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
