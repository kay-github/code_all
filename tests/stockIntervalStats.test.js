"use strict";

const assert = require("assert");
const {
  DECLINE_THRESHOLDS_PCT,
  GAIN_THRESHOLDS_PCT,
  extractYtdMap,
  computeIntervalStats,
  summarizeIntervalDay,
  sliceThresholdList
} = require("../lib/stockIntervalStats");

function record(symbol, overrides = {}) {
  const exchange = overrides.exchange ||
    (symbol.endsWith(".SH") ? "SH" : symbol.endsWith(".SZ") ? "SZ" : "BSE");
  return {
    symbol,
    code: symbol.slice(0, 6),
    name: overrides.name || `股票${symbol.slice(0, 6)}`,
    exchange,
    ytd: 0,
    isEligible: true,
    ineligibilityReason: null,
    lastPriceDate: null,
    ...overrides
  };
}

function snapshot(asOf, records, overrides = {}) {
  return {
    snapshotId: `stock-ytd-${asOf.replace(/-/g, "")}-abcdefabcdefabcd`,
    asOf,
    baseDate: "2025-12-31",
    methodologyVersion: "reported-ytd.v1",
    records,
    ...overrides
  };
}

function run() {
  // 合成恒等式：送转场景。基准日 YTD 20%、真实区间 -25%。
  // 前复权重锚定为纯乘性，(1+0.20×0.75... ) 按公式应严格还原 -25%。
  {
    const ytdBase = 0.2;
    const trueInterval = -0.25;
    const ytdNow = (1 + ytdBase) * (1 + trueInterval) - 1;
    const base = snapshot("2026-07-13", [record("600000.SH", { ytd: ytdBase })]);
    const current = snapshot("2026-07-16", [record("600000.SH", { ytd: ytdNow })]);
    const stats = computeIntervalStats(extractYtdMap(base), extractYtdMap(current));
    assert.strictEqual(stats.matchedCount, 1);
    assert.ok(Math.abs(stats.records[0].intervalReturn - trueInterval) < 1e-12);
  }

  // 分红仿射误差方向：区间内除息使合成值低估跌幅（数值更接近 0）。
  // 模拟：基准日价 70（相对基期 100 跌 30%），随后派息 d=1 并再无价格变动。
  // 派息后新锚 YTD 两端同减 d：合成值应大于真实区间收益（更接近 0）。
  {
    const d = 1;
    const ytdBaseDay = 70 / 100 - 1;
    const ytdNow = (70 - d) / (100 - d) - 1;
    const trueInterval = 0; // 除息本身不是真实亏损
    const base = snapshot("2026-07-13", [record("600519.SH", { ytd: ytdBaseDay })]);
    const current = snapshot("2026-07-16", [record("600519.SH", { ytd: ytdNow })]);
    const stats = computeIntervalStats(extractYtdMap(base), extractYtdMap(current));
    const composed = stats.records[0].intervalReturn;
    assert.ok(composed < trueInterval, "除息使合成值略低于真实值（此构造下为负）");
    assert.ok(Math.abs(composed - trueInterval) < 0.005, "偏差在 0.5pp 声明内");
  }

  // 阈值边界：跌超 30% 为严格超过。
  {
    const base = snapshot("2026-07-13", [
      record("000001.SZ", { ytd: 0 }),
      record("000002.SZ", { ytd: 0 }),
      record("000003.SZ", { ytd: 0 })
    ]);
    const current = snapshot("2026-07-16", [
      record("000001.SZ", { ytd: -0.3 }),
      record("000002.SZ", { ytd: -0.300001 }),
      record("000003.SZ", { ytd: -0.5 })
    ]);
    const stats = computeIntervalStats(extractYtdMap(base), extractYtdMap(current));
    const bucket30 = stats.declines.find((entry) => entry.thresholdPct === 30);
    const bucket50 = stats.declines.find((entry) => entry.thresholdPct === 50);
    assert.strictEqual(bucket30.count, 2, "恰好 -30% 不计入，累计包含 -50%");
    assert.strictEqual(bucket50.count, 0, "恰好 -50% 不计入");
    assert.strictEqual(DECLINE_THRESHOLDS_PCT.length, stats.declines.length);
    assert.strictEqual(GAIN_THRESHOLDS_PCT.length, stats.gains.length);
  }

  // 样本资格：新股、退市、无效、北交所开关、停牌计数。
  {
    const base = snapshot("2026-07-13", [
      record("600000.SH", { ytd: 0.1 }),
      record("000001.SZ", { ytd: -0.2 }),
      record("920001.BJ", { exchange: "BSE", ytd: 0.05 }),
      record("600888.SH", { ytd: 0.3 }), // 之后退市
      record("300999.SZ", {
        ytd: null,
        isEligible: false,
        ineligibilityReason: "NEW_LISTING"
      })
    ]);
    const current = snapshot("2026-07-16", [
      record("600000.SH", { ytd: 0.21 }),
      record("000001.SZ", { ytd: -0.44, lastPriceDate: "2026-07-15" }), // 停牌
      record("920001.BJ", { exchange: "BSE", ytd: 0.15 }),
      record("300999.SZ", { ytd: 0.8 }), // 基准日为新股 → 排除
      record("301888.SZ", { ytd: 0.5 }), // 基准快照无记录 → 新股排除
      record("600777.SH", { ytd: null, isEligible: false, ineligibilityReason: "QUARANTINED" })
    ]);

    const shSz = computeIntervalStats(extractYtdMap(base), extractYtdMap(current));
    assert.strictEqual(shSz.matchedCount, 2);
    assert.strictEqual(shSz.suspendedCount, 1);
    assert.strictEqual(shSz.excluded.newSinceBase, 2);
    assert.strictEqual(shSz.excluded.ineligible, 1);
    assert.strictEqual(shSz.excluded.missingCurrent, 1, "600888 退市");
    assert.strictEqual(shSz.includeBse, false);

    const withBse = computeIntervalStats(
      extractYtdMap(base),
      extractYtdMap(current),
      { includeBse: true }
    );
    assert.strictEqual(withBse.matchedCount, 3);

    // 排序稳定：升序。
    assert.ok(
      withBse.records[0].intervalReturn <= withBse.records[1].intervalReturn
    );
  }

  // 跨年守卫与日期守卫。
  {
    const base = snapshot("2026-07-13", [record("600000.SH", { ytd: 0.1 })], {
      baseDate: "2024-12-31"
    });
    const current = snapshot("2026-07-16", [record("600000.SH", { ytd: 0.2 })]);
    assert.throws(
      () => computeIntervalStats(extractYtdMap(base), extractYtdMap(current)),
      (error) => error.code === "BASE_YEAR_MISMATCH"
    );

    const sameDay = snapshot("2026-07-16", [record("600000.SH", { ytd: 0.1 })]);
    assert.throws(
      () => computeIntervalStats(extractYtdMap(sameDay), extractYtdMap(current)),
      (error) => error.code === "INVALID_BASE_DATE"
    );
  }

  // 跨方法论合成允许，版本透传。
  {
    const base = snapshot("2026-07-13", [record("600000.SH", { ytd: 0.1 })], {
      methodologyVersion: "adjusted-close.v2"
    });
    const current = snapshot("2026-07-16", [record("600000.SH", { ytd: 0.2 })]);
    const stats = computeIntervalStats(extractYtdMap(base), extractYtdMap(current));
    assert.strictEqual(stats.methodologyVersions.base, "adjusted-close.v2");
    assert.strictEqual(stats.methodologyVersions.current, "reported-ytd.v1");
  }

  // 名单钻取：方向、排序、分页、上限。
  {
    const symbols = [];
    for (let i = 0; i < 5; i += 1) {
      symbols.push([`60000${i}.SH`, -0.31 - i * 0.05]);
    }
    symbols.push(["600100.SH", 0.42]);
    const base = snapshot(
      "2026-07-13",
      symbols.map(([symbol]) => record(symbol, { ytd: 0 }))
    );
    const current = snapshot(
      "2026-07-16",
      symbols.map(([symbol, ytd]) => record(symbol, { ytd }))
    );
    const stats = computeIntervalStats(extractYtdMap(base), extractYtdMap(current));

    const declineList = sliceThresholdList(stats, -30, { limit: 3, offset: 0 });
    assert.strictEqual(declineList.total, 5);
    assert.strictEqual(declineList.items.length, 3);
    assert.ok(declineList.items[0].intervalReturn <= declineList.items[1].intervalReturn);

    const nextPage = sliceThresholdList(stats, -30, { limit: 3, offset: 3 });
    assert.strictEqual(nextPage.items.length, 2);
    assert.notStrictEqual(nextPage.items[0].symbol, declineList.items[0].symbol);

    const gainList = sliceThresholdList(stats, 40);
    assert.strictEqual(gainList.total, 1);
    assert.strictEqual(gainList.items[0].symbol, "600100.SH");

    const capped = sliceThresholdList(stats, -30, { limit: 5000 });
    assert.ok(capped.limit <= 200);

    assert.throws(
      () => sliceThresholdList(stats, 0),
      (error) => error.code === "INVALID_LIST_PARAMS"
    );
  }

  // extractYtdMap 对无效快照抛错；ytd ≤ -1 记录按无效排除。
  {
    assert.throws(() => extractYtdMap(null), (error) => error.code === "INVALID_SNAPSHOT");
    assert.throws(
      () => extractYtdMap({ asOf: "2026-07-16" }),
      (error) => error.code === "INVALID_SNAPSHOT"
    );
    const map = extractYtdMap(snapshot("2026-07-16", [
      record("600000.SH", { ytd: -1.2 })
    ]));
    assert.strictEqual(map.records["600000.SH"].ytd, null);
  }

  {
    // 中位数与板块拆分：板块由代码前缀推导，中位数取自升序 matched。
    const base = snapshot("2026-07-13", [
      record("600001.SH", { ytd: 0 }),
      record("300001.SZ", { ytd: 0 }),
      record("688001.SH", { ytd: 0 }),
      record("920001.BJ", { ytd: 0 })
    ]);
    const current = snapshot("2026-07-16", [
      record("600001.SH", { ytd: -0.10 }),
      record("300001.SZ", { ytd: -0.30 }),
      record("688001.SH", { ytd: -0.20 }),
      record("920001.BJ", { ytd: 0.40 })
    ]);
    const stats = computeIntervalStats(
      extractYtdMap(base),
      extractYtdMap(current),
      { includeBse: true }
    );
    assert.ok(Math.abs(stats.medianIntervalReturn - -0.15) < 1e-9, "偶数个取中间两值均值");
    const boards = Object.fromEntries(stats.byBoard.map((entry) => [entry.board, entry]));
    assert.strictEqual(boards["主板"].matchedCount, 1);
    assert.ok(Math.abs(boards["主板"].medianIntervalReturn - -0.10) < 1e-9);
    assert.ok(Math.abs(boards["创业板"].medianIntervalReturn - -0.30) < 1e-9);
    assert.ok(Math.abs(boards["科创板"].medianIntervalReturn - -0.20) < 1e-9);
    assert.ok(Math.abs(boards["北交所"].medianIntervalReturn - 0.40) < 1e-9);
    const shSz = computeIntervalStats(extractYtdMap(base), extractYtdMap(current));
    assert.ok(!shSz.byBoard.some((entry) => entry.board === "北交所"), "未纳入北交所时无该板块");
  }

  {
    // 逐日演变聚合：hs 池不含北交所，all 池含；阈值为严格超过。
    const day = summarizeIntervalDay({
      "600001.SH": { exchange: "SH", ytd: -0.12 },
      "000001.SZ": { exchange: "SZ", ytd: -0.35 },
      "300001.SZ": { exchange: "SZ", ytd: 0.22 },
      "920001.BJ": { exchange: "BSE", ytd: -0.55 },
      "999999.SH": { exchange: "SH", ytd: null }
    });
    assert.strictEqual(day.hs.count, 3);
    assert.strictEqual(day.all.count, 4);
    const d10 = DECLINE_THRESHOLDS_PCT.indexOf(10);
    const d30 = DECLINE_THRESHOLDS_PCT.indexOf(30);
    const d50 = DECLINE_THRESHOLDS_PCT.indexOf(50);
    const g20 = GAIN_THRESHOLDS_PCT.indexOf(20);
    assert.strictEqual(day.hs.declines[d10], 2);
    assert.strictEqual(day.hs.declines[d30], 1);
    assert.strictEqual(day.hs.declines[d50], 0);
    assert.strictEqual(day.all.declines[d50], 1);
    assert.strictEqual(day.hs.gains[g20], 1);
    assert.ok(Math.abs(day.hs.median - -0.12) < 1e-12);
    assert.ok(Math.abs(day.all.median - -0.235) < 1e-12);
  }

  console.log("stockIntervalStats tests passed");
}

run();
