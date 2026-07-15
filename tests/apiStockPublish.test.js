const assert = require("assert");
const zlib = require("zlib");
const stockPublishApi = require("../api/stock-publish");
const { buildCandidate } = require("../lib/stockDailyWorker");
const { createTradingCalendar } = require("../lib/stockTradingDates");

const BASE_DATE = "2025-12-31";
const AS_OF = "2026-07-14";
const GENERATED_AT = "2026-07-14T12:20:00.000Z";

function computedRecord(symbol, exchange, source, ytd) {
  const base = 10;
  const current = base * (1 + ytd);
  const record = {
    symbol,
    code: symbol.slice(0, 6),
    name: symbol,
    exchange,
    board: exchange === "BSE" ? "BSE" : "MAIN",
    listingDate: "2020-01-01",
    listingStatus: "LISTED",
    securityType: "A_SHARE",
    computedYtd: ytd,
    basePriceDate: BASE_DATE,
    lastPriceDate: AS_OF,
    source,
    sourceAsOf: AS_OF
  };
  if (source === "baostock") {
    record.baseAdjustedClose = base;
    record.lastAdjustedClose = current;
    record.adjustmentMethod = "qfq";
  } else {
    record.baseRawClose = base;
    record.baseAdjFactor = 1;
    record.baseAdjFactorDate = BASE_DATE;
    record.lastRawClose = current;
    record.lastAdjFactor = 1;
    record.lastAdjFactorDate = AS_OF;
    record.adjustmentMethod = "raw-factor";
  }
  return record;
}

function candidate() {
  return buildCandidate({
    asOf: AS_OF,
    baseDate: BASE_DATE,
    computedRecords: [
      computedRecord("600000.SH", "SH", "baostock", 0.1),
      computedRecord("000001.SZ", "SZ", "baostock", 0.2),
      computedRecord("920001.BJ", "BSE", "sina", 0.3)
    ],
    referenceRecords: [],
    expectedUniverseCount: 3,
    indexRows: [
      { ts_code: "000300.SH", trade_date: BASE_DATE, close: 4000 },
      { ts_code: "000300.SH", trade_date: AS_OF, close: 4400 }
    ],
    benchmarkSource: "baostock",
    generatedAt: GENERATED_AT,
    publishedAt: GENERATED_AT,
    methodologyVersion: "adjusted-ytd.v2",
    poolVersion: "official-a-share.v2"
  });
}

function calendar() {
  return createTradingCalendar([
    { cal_date: BASE_DATE, is_open: 1 },
    { cal_date: AS_OF, is_open: 1 }
  ], {
    coveredFrom: "2025-12-01",
    coveredThrough: "2026-12-31"
  });
}

function gzipPayload(overrides = {}) {
  return zlib.gzipSync(Buffer.from(JSON.stringify({
    snapshot: candidate(),
    expectedAsOf: AS_OF,
    refreshedAt: GENERATED_AT,
    warningCodes: ["REFERENCE_SKIPPED"],
    tradingCalendar: calendar(),
    ...overrides
  })));
}

async function invoke(handler, options = {}) {
  const req = {
    method: options.method || "POST",
    headers: {
      authorization: options.authorization || "Bearer publish-secret",
      "content-type": options.contentType || "application/gzip",
      ...(options.headers || {})
    },
    query: options.query || {},
    body: options.body == null ? gzipPayload() : options.body
  };
  const res = {
    statusCode: 0,
    headers: {},
    body: "",
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(value = "") {
      this.body = value;
    }
  };
  await handler(req, res);
  return {
    status: res.statusCode,
    headers: res.headers,
    data: res.body ? JSON.parse(res.body) : null
  };
}

async function run() {
  const published = [];
  const promoted = [];
  const storage = {
    async withRefreshLock(worker) {
      return worker();
    },
    async publishSnapshot(snapshot, options) {
      published.push({ snapshot, options });
      return {
        snapshotId: "stock-ytd-20260714-test",
        expectedAsOf: options.expectedAsOf,
        snapshot
      };
    },
    async promoteLatestSnapshot(asOf, options) {
      promoted.push({ asOf, options });
      return {
        snapshotId: "stock-ytd-20260714-recovered",
        expectedAsOf: asOf,
        snapshot: candidate()
      };
    }
  };
  let handler = stockPublishApi.createHandler({
    env: { CRON_SECRET: "publish-secret" },
    storage,
    logger: { error() {} }
  });
  let response = await invoke(handler);
  assert.strictEqual(response.status, 200);
  assert.strictEqual(response.headers["Cache-Control"], "no-store");
  assert.strictEqual(response.data.publish.authorization, "manual");
  assert.deepStrictEqual(response.data.publish.computedSources, ["baostock", "sina"]);
  assert.strictEqual(published.length, 1);
  assert.strictEqual(published[0].snapshot.methodologyVersion, "adjusted-ytd.v2");
  assert.ok(!JSON.stringify(response.data).includes("baseAdjustedClose"));
  assert.ok(!JSON.stringify(response.data).includes("publish-secret"));

  response = await invoke(handler, {
    query: { recoverAsOf: AS_OF },
    contentType: "application/json",
    body: Buffer.from("recovery requests do not need a body")
  });
  assert.strictEqual(response.status, 200);
  assert.strictEqual(response.data.publish.snapshotId, "stock-ytd-20260714-recovered");
  assert.strictEqual(response.data.publish.authorization, "manual");
  assert.strictEqual(promoted.length, 1);
  assert.strictEqual(promoted[0].asOf, AS_OF);
  assert.ok(Number.isFinite(Date.parse(promoted[0].options.refreshedAt)));
  assert.strictEqual(published.length, 1);

  response = await invoke(handler, {
    query: { recoverAsOf: "2026-02-30" },
    contentType: "application/json"
  });
  assert.strictEqual(response.status, 400);
  assert.strictEqual(response.data.error, "PUBLISH_RECOVERY_DATE_INVALID");

  response = await invoke(handler, {
    query: { recoverAsOf: [AS_OF, "2026-07-13"] },
    contentType: "application/json"
  });
  assert.strictEqual(response.status, 400);
  assert.strictEqual(response.data.error, "PUBLISH_RECOVERY_DATE_INVALID");

  response = await invoke(handler, {
    authorization: "Bearer wrong",
    query: { recoverAsOf: "invalid-private-value" }
  });
  assert.strictEqual(response.status, 401);
  assert.strictEqual(response.data.error, "UNAUTHORIZED");

  response = await invoke(handler, { method: "GET" });
  assert.strictEqual(response.status, 405);

  response = await invoke(handler, { contentType: "application/json" });
  assert.strictEqual(response.status, 400);
  assert.strictEqual(response.data.error, "PUBLISH_CONTENT_TYPE_INVALID");

  response = await invoke(handler, { body: Buffer.from("not-gzip") });
  assert.strictEqual(response.status, 400);
  assert.strictEqual(response.data.error, "PUBLISH_BODY_INVALID");

  response = await invoke(handler, {
    body: gzipPayload({ refreshedAt: "not-a-date" })
  });
  assert.strictEqual(response.status, 400);
  assert.strictEqual(response.data.error, "PUBLISH_BODY_INVALID");

  const corruptedSnapshot = candidate();
  const corruptedRecord = {
    ...corruptedSnapshot.records[0],
    lastAdjustedClose: corruptedSnapshot.records[0].lastAdjustedClose + 1
  };
  corruptedSnapshot.records = [
    corruptedRecord,
    ...corruptedSnapshot.records.slice(1)
  ];
  corruptedSnapshot.stocks = {
    ...corruptedSnapshot.stocks,
    [corruptedRecord.symbol]: corruptedRecord
  };
  response = await invoke(handler, {
    body: gzipPayload({ snapshot: corruptedSnapshot })
  });
  assert.strictEqual(response.status, 400);
  assert.strictEqual(response.data.error, "STOCK_SNAPSHOT_INVALID");

  handler = stockPublishApi.createHandler({
    env: { CRON_SECRET: "publish-secret" },
    storage: {
      async withRefreshLock() {
        const error = new Error("private lock detail");
        error.code = "STOCK_REFRESH_LOCKED";
        throw error;
      }
    },
    logger: { error() {} }
  });
  response = await invoke(handler);
  assert.strictEqual(response.status, 409);
  assert.strictEqual(response.data.error, "STOCK_REFRESH_LOCKED");
  assert.ok(!JSON.stringify(response.data).includes("private lock detail"));

  handler = stockPublishApi.createHandler({
    env: { CRON_SECRET: "publish-secret" },
    storage: {
      async withRefreshLock(worker) {
        return worker();
      },
      async promoteLatestSnapshot() {
        const error = new Error("private orphan inventory detail");
        error.code = "STOCK_SNAPSHOT_ORPHAN_NOT_FOUND";
        throw error;
      }
    },
    logger: { error() {} }
  });
  response = await invoke(handler, {
    query: { recoverAsOf: AS_OF },
    contentType: "application/json"
  });
  assert.strictEqual(response.status, 503);
  assert.strictEqual(response.data.error, "STOCK_PUBLISH_FAILED");
  assert.ok(!JSON.stringify(response.data).includes("private orphan inventory detail"));

  console.log("stock publish API tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
