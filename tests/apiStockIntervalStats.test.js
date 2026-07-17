"use strict";

const assert = require("assert");

process.env.NODE_ENV = "test";
const { createHandler } = require("../api/stock-interval-stats");

function fixtureRecord(symbol, ytd, overrides = {}) {
  const exchange = overrides.exchange ||
    (symbol.endsWith(".SH") ? "SH" : symbol.endsWith(".SZ") ? "SZ" : "BSE");
  return {
    symbol,
    code: symbol.slice(0, 6),
    name: overrides.name || `股票${symbol.slice(0, 6)}`,
    exchange,
    ytd,
    isEligible: ytd != null,
    ineligibilityReason: ytd == null ? "NEW_LISTING" : null,
    lastPriceDate: null,
    ...overrides
  };
}

function baseSnapshot() {
  return {
    snapshotId: "stock-ytd-20260713-1111111111111111",
    asOf: "2026-07-13",
    baseDate: "2025-12-31",
    methodologyVersion: "adjusted-close.v2",
    productionPublishable: true,
    stocks: {},
    records: [
      fixtureRecord("600000.SH", 0.10),
      fixtureRecord("000001.SZ", 0.00),
      fixtureRecord("000002.SZ", 0.20),
      fixtureRecord("920001.BJ", 0.05)
    ]
  };
}

function currentSnapshot() {
  return {
    snapshotId: "stock-ytd-20260716-2222222222222222",
    asOf: "2026-07-16",
    expectedAsOf: "2026-07-16",
    publishedAt: "2026-07-16T11:00:00.000Z",
    isStale: false,
    baseDate: "2025-12-31",
    methodologyVersion: "reported-ytd.v1",
    records: [
      fixtureRecord("600000.SH", -0.30), // 区间 ≈ -36.4%
      fixtureRecord("000001.SZ", -0.45), // 区间 -45%
      fixtureRecord("000002.SZ", 0.50),  // 区间 +25%
      fixtureRecord("920001.BJ", -0.40)  // BSE，默认排除
    ]
  };
}

function makeStore(overrides = {}) {
  return {
    calls: { list: 0, load: 0, daily: 0 },
    async listAvailableSnapshotDates() {
      this.calls.list += 1;
      return ["2026-07-13", "2026-07-14", "2026-07-15", "2026-07-16"];
    },
    async listIntervalDailyDates() {
      return [];
    },
    async loadIntervalDailyMap() {
      this.calls.daily += 1;
      return null;
    },
    async loadLatestSnapshotForDate(asOf) {
      this.calls.load += 1;
      if (asOf !== "2026-07-13") return null;
      return { snapshot: baseSnapshot(), snapshotId: "x", uploadedAt: null };
    },
    ...overrides
  };
}

function makeHandler(options = {}) {
  return createHandler({
    store: makeStore(options.storeOverrides),
    loadStockSnapshot: options.loadStockSnapshot || (async () => ({
      snapshot: currentSnapshot(),
      mode: "published",
      warning: null
    })),
    logger: { error() {} },
    ...options.handlerOptions
  });
}

async function invoke(handler, query = {}, method = "GET") {
  const req = { method, query };
  const res = {
    headers: {},
    statusCode: 0,
    body: "",
    setHeader(name, value) { this.headers[name] = value; },
    end(body = "") { this.body = body; }
  };
  await handler(req, res);
  return {
    status: res.statusCode,
    headers: res.headers,
    data: res.body ? JSON.parse(res.body) : null
  };
}

async function run() {
  // 可用日期模式：排除 ≥ 当前 asOf 的日期。
  {
    const handler = makeHandler();
    const response = await invoke(handler, { dates: "1" });
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(response.data.availableBaseDates, [
      "2026-07-13", "2026-07-14", "2026-07-15"
    ]);
    assert.strictEqual(response.headers["Cache-Control"], "no-store");
  }

  // 分布统计主模式。
  {
    const handler = makeHandler();
    const response = await invoke(handler, {
      baseDate: "2026-07-13",
      includeBse: "false"
    });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.data.baseDate, "2026-07-13");
    assert.strictEqual(response.data.asOf, "2026-07-16");
    assert.strictEqual(response.data.matchedCount, 3);
    assert.strictEqual(response.data.methodologyVersions.base, "adjusted-close.v2");
    const bucket30 = response.data.declines.find((entry) => entry.thresholdPct === 30);
    const bucket40 = response.data.declines.find((entry) => entry.thresholdPct === 40);
    assert.strictEqual(bucket30.count, 2);
    assert.strictEqual(bucket40.count, 1);
    const gain20 = response.data.gains.find((entry) => entry.thresholdPct === 20);
    assert.strictEqual(gain20.count, 1);
    assert.ok(response.data.precisionNote.includes("前复权"));
  }

  // includeBse=true 纳入北交所。
  {
    const handler = makeHandler();
    const response = await invoke(handler, {
      baseDate: "2026-07-13",
      includeBse: "true"
    });
    assert.strictEqual(response.data.matchedCount, 4);
    const bucket40 = response.data.declines.find((entry) => entry.thresholdPct === 40);
    assert.strictEqual(bucket40.count, 2);
  }

  // 名单钻取：排序、分页契约。
  {
    const handler = makeHandler();
    let response = await invoke(handler, {
      baseDate: "2026-07-13",
      includeBse: "false",
      list: "-30",
      limit: "1",
      offset: "0"
    });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.data.list.total, 2);
    assert.strictEqual(response.data.list.items.length, 1);
    assert.strictEqual(response.data.list.items[0].symbol, "000001.SZ", "最深跌幅在前");

    response = await invoke(handler, {
      baseDate: "2026-07-13",
      includeBse: "false",
      list: "-30",
      limit: "1",
      offset: "1"
    });
    assert.strictEqual(response.data.list.items[0].symbol, "600000.SH");

    response = await invoke(handler, {
      baseDate: "2026-07-13",
      includeBse: "false",
      list: "20"
    });
    assert.strictEqual(response.data.list.total, 1);
    assert.strictEqual(response.data.list.items[0].symbol, "000002.SZ");
  }

  // 参数校验。
  {
    const handler = makeHandler();
    let response = await invoke(handler, { baseDate: "bad" });
    assert.strictEqual(response.status, 400);
    assert.strictEqual(response.data.error, "INVALID_BASE_DATE");

    response = await invoke(handler, { baseDate: "2026-07-16" });
    assert.strictEqual(response.status, 400, "基准日不得等于当前 asOf");

    response = await invoke(handler, { baseDate: "2026-07-13", includeBse: "maybe" });
    assert.strictEqual(response.status, 400);
    assert.strictEqual(response.data.error, "INVALID_INCLUDE_BSE");

    response = await invoke(handler, { baseDate: "2026-07-13", list: "0" });
    assert.strictEqual(response.status, 400);
    assert.strictEqual(response.data.error, "INVALID_LIST_PARAMS");

    response = await invoke(handler, { baseDate: "2026-07-13", list: "-30", limit: "-5" });
    assert.strictEqual(response.status, 400);
    assert.strictEqual(response.data.error, "INVALID_LIST_PARAMS");

    response = await invoke(handler, {}, "POST");
    assert.strictEqual(response.status, 405);
  }

  // 缺基准快照：404 且附可用日期。
  {
    const handler = makeHandler();
    const response = await invoke(handler, { baseDate: "2026-07-14" });
    assert.strictEqual(response.status, 404);
    assert.strictEqual(response.data.error, "BASE_SNAPSHOT_MISSING");
    assert.ok(Array.isArray(response.data.availableBaseDates));
  }

  // 跨年守卫 → 409。
  {
    const handler = makeHandler({
      storeOverrides: {
        async loadLatestSnapshotForDate() {
          const snapshot = baseSnapshot();
          snapshot.baseDate = "2024-12-31";
          return { snapshot, snapshotId: "x", uploadedAt: null };
        }
      }
    });
    const response = await invoke(handler, { baseDate: "2026-07-13" });
    assert.strictEqual(response.status, 409);
    assert.strictEqual(response.data.error, "BASE_YEAR_MISMATCH");
  }

  // 当前快照不可用 → 503 已知语义。
  {
    const { StockPublishedSnapshotError } = require("../lib/stockPublishedSnapshot");
    const handler = makeHandler({
      loadStockSnapshot: async () => {
        throw new StockPublishedSnapshotError("STOCK_SNAPSHOT_UNAVAILABLE", "boom");
      }
    });
    const response = await invoke(handler, { baseDate: "2026-07-13" });
    assert.strictEqual(response.status, 503);
    assert.strictEqual(response.data.error, "STOCK_DATA_UNAVAILABLE");
  }

  // 内部错误脱敏 → 500，不回传细节。
  {
    const handler = makeHandler({
      storeOverrides: {
        async loadLatestSnapshotForDate() {
          throw new Error("secret internal detail");
        }
      }
    });
    const response = await invoke(handler, { baseDate: "2026-07-13" });
    assert.strictEqual(response.status, 500);
    assert.strictEqual(response.data.error, "INTERNAL_ERROR");
    assert.ok(!JSON.stringify(response.data).includes("secret"));
  }

  // 统计结果缓存：同一 (baseDate, snapshotId, includeBse) 不重复读基准快照。
  {
    const store = makeStore();
    const handler = createHandler({
      store,
      loadStockSnapshot: async () => ({
        snapshot: currentSnapshot(),
        mode: "published",
        warning: null
      }),
      logger: { error() {} }
    });
    await invoke(handler, { baseDate: "2026-07-13" });
    await invoke(handler, { baseDate: "2026-07-13" });
    assert.strictEqual(store.calls.load, 1, "第二次命中映射缓存");
  }

  // 回填日频文件优先于历史快照，且可用日期合并两个来源。
  {
    const store = makeStore({
      async listIntervalDailyDates() {
        return ["2025-12-31", "2026-03-18"];
      },
      async loadIntervalDailyMap(asOf) {
        if (asOf !== "2026-03-18") return null;
        return {
          version: "stock-ytd-interval-daily.v1",
          asOf: "2026-03-18",
          baseDate: "2025-12-31",
          methodologyVersion: "backfill-qfq.v1",
          records: {
            "600000.SH": { exchange: "SH", ytd: 0.10 },
            "000001.SZ": { exchange: "SZ", ytd: 0.00, lastPriceDate: "2026-03-17" },
            "000002.SZ": { exchange: "SZ", ytd: 0.20 }
          }
        };
      }
    });
    const handler = createHandler({
      store,
      loadStockSnapshot: async () => ({
        snapshot: currentSnapshot(),
        mode: "published",
        warning: null
      }),
      logger: { error() {} }
    });

    let response = await invoke(handler, { dates: "1" });
    assert.deepStrictEqual(response.data.availableBaseDates, [
      "2025-12-31", "2026-03-18", "2026-07-13", "2026-07-14", "2026-07-15"
    ]);

    response = await invoke(handler, { baseDate: "2026-03-18" });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.data.methodologyVersions.base, "backfill-qfq.v1");
    assert.strictEqual(response.data.matchedCount, 3);
    assert.strictEqual(store.calls.load, 0, "日频文件命中时不读快照");
    const bucket40 = response.data.declines.find((entry) => entry.thresholdPct === 40);
    assert.strictEqual(bucket40.count, 1, "600000.SH 区间 (1-0.30)/(1+0.10)-1 ≈ -36.4% 不入 40 档；000001.SZ -45% 入");
  }

  // isStale / 警告透传。
  {
    const handler = makeHandler({
      loadStockSnapshot: async () => {
        const snapshot = currentSnapshot();
        snapshot.isStale = true;
        return { snapshot, mode: "published", warning: "服务上一份快照" };
      }
    });
    const response = await invoke(handler, { baseDate: "2026-07-13" });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.data.isStale, true);
    assert.strictEqual(response.data.warning, "服务上一份快照");
  }

  console.log("apiStockIntervalStats tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
