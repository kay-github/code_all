const assert = require("assert");
const { createFixtureSnapshot } = require("../lib/stockFixture");
const { createTradingCalendar } = require("../lib/stockTradingDates");
const { preparePublishedEnvelope } = require("../lib/stockSnapshotStore");
const {
  createStockSnapshotBlobStore
} = require("../lib/stockSnapshotBlobStore");

function preconditionError() {
  const error = new Error("precondition failed");
  error.code = "BLOB_PRECONDITION_FAILED";
  error.statusCode = 412;
  return error;
}

function memoryBlobClient() {
  const objects = new Map();
  let sequence = 0;
  let currentWriteConflicts = 0;
  return {
    objects,
    conflictCurrentWriteOnce() {
      currentWriteConflicts += 1;
    },
    isPreconditionFailure(error) {
      return error && error.code === "BLOB_PRECONDITION_FAILED";
    },
    async put(pathname, body, options = {}) {
      const existing = objects.get(pathname);
      if (pathname.endsWith("/current.json") && currentWriteConflicts > 0) {
        currentWriteConflicts -= 1;
        if (existing) existing.etag = `etag-${++sequence}`;
        throw preconditionError();
      }
      if (existing && options.allowOverwrite !== true) throw preconditionError();
      if (options.ifMatch && (!existing || existing.etag !== options.ifMatch)) {
        throw preconditionError();
      }
      const value = Buffer.isBuffer(body) ? body.toString("utf8") : String(body);
      const object = {
        body: value,
        etag: `etag-${++sequence}`,
        uploadedAt: new Date()
      };
      objects.set(pathname, object);
      return {
        pathname,
        etag: object.etag,
        url: `https://blob.invalid/${pathname}`,
        downloadUrl: `https://blob.invalid/${pathname}`,
        contentType: "application/json",
        contentDisposition: "inline"
      };
    },
    async get(pathname) {
      const object = objects.get(pathname);
      if (!object) return null;
      return {
        statusCode: 200,
        stream: new Blob([object.body]).stream(),
        headers: new Headers(),
        blob: {
          pathname,
          etag: object.etag,
          uploadedAt: object.uploadedAt,
          contentType: "application/json",
          size: Buffer.byteLength(object.body)
        }
      };
    },
    async list(options = {}) {
      const prefix = String(options.prefix || "");
      const offset = Number(options.cursor || 0);
      const limit = Number(options.limit || 1000);
      const matches = [...objects.entries()]
        .filter(([pathname]) => pathname.startsWith(prefix))
        .sort(([left], [right]) => left.localeCompare(right));
      const page = matches.slice(offset, offset + limit);
      const nextOffset = offset + page.length;
      return {
        blobs: page.map(([pathname, object]) => ({
          pathname,
          etag: object.etag,
          uploadedAt: object.uploadedAt,
          size: Buffer.byteLength(object.body),
          url: `https://blob.invalid/${pathname}`,
          downloadUrl: `https://blob.invalid/download/${pathname}`
        })),
        cursor: nextOffset < matches.length ? String(nextOffset) : undefined,
        hasMore: nextOffset < matches.length
      };
    },
    async del(pathname, options = {}) {
      const existing = objects.get(pathname);
      if (!existing) return;
      if (options.ifMatch && existing.etag !== options.ifMatch) {
        throw preconditionError();
      }
      objects.delete(pathname);
    }
  };
}

function productionSnapshot() {
  return {
    ...createFixtureSnapshot(),
    dataMode: "published",
    dataWarning: null,
    methodologyVersion: "adjusted-ytd.v1",
    poolVersion: "a-share.v1"
  };
}

function tradingCalendar() {
  return createTradingCalendar([
    { cal_date: "20251231", is_open: 1 },
    { cal_date: "20260710", is_open: 1 },
    { cal_date: "20260711", is_open: 1 }
  ], {
    coveredFrom: "2025-12-01",
    coveredThrough: "2026-12-31"
  });
}

async function run() {
  const client = memoryBlobClient();
  let now = Date.parse("2026-07-10T11:00:00.000Z");
  const store = createStockSnapshotBlobStore({
    client,
    now: () => now
  });
  assert.strictEqual(await store.loadCurrentEnvelope(), null);

  const envelope = await store.publishSnapshot(productionSnapshot(), {
    expectedAsOf: "2026-07-10",
    refreshedAt: "2026-07-10T11:00:00.000Z",
    tradingCalendar: tradingCalendar()
  });
  assert.strictEqual(envelope.refreshStatus, "PUBLISHED");
  const immutablePath = `stock-ytd/snapshots/${envelope.snapshotId}.json`;
  assert.ok(client.objects.has(immutablePath));
  assert.ok(client.objects.has("stock-ytd/current.json"));

  const current = await store.loadCurrentEnvelopeWithMetadata();
  assert.strictEqual(current.envelope.snapshotId, envelope.snapshotId);
  assert.ok(current.etag);
  assert.deepStrictEqual(JSON.parse(current.body), current.envelope);

  const orphanSnapshot = {
    ...productionSnapshot(),
    publishedAt: "2026-07-10T11:30:00.000Z"
  };
  const orphanPrepared = preparePublishedEnvelope(orphanSnapshot, {
    expectedAsOf: "2026-07-10",
    refreshedAt: "2026-07-10T11:31:00.000Z",
    tradingCalendar: tradingCalendar()
  });
  const orphanPath = `stock-ytd/snapshots/${orphanPrepared.snapshotId}.json`;
  await client.put(
    orphanPath,
    JSON.stringify(orphanPrepared.publishedSnapshot),
    { allowOverwrite: false }
  );
  client.objects.get(immutablePath).uploadedAt = new Date("2026-07-10T11:00:00.000Z");
  client.objects.get(orphanPath).uploadedAt = new Date("2026-07-10T11:30:00.000Z");

  const promoted = await store.promoteLatestSnapshot("2026-07-10", {
    refreshedAt: "2026-07-10T11:32:00.000Z"
  });
  assert.strictEqual(promoted.snapshotId, orphanPrepared.snapshotId);
  assert.strictEqual(promoted.refreshedAt, "2026-07-10T11:32:00.000Z");
  assert.deepStrictEqual(promoted.tradingCalendar, tradingCalendar());
  assert.ok(!JSON.stringify(promoted).includes("blob.invalid"));
  assert.strictEqual(
    (await store.loadCurrentEnvelope()).snapshotId,
    orphanPrepared.snapshotId
  );

  const originalImmutable = client.objects.get(immutablePath);
  client.objects.set(immutablePath, {
    ...originalImmutable,
    body: "{}"
  });
  await assert.rejects(
    store.publishSnapshot(productionSnapshot(), {
      expectedAsOf: "2026-07-10",
      tradingCalendar: tradingCalendar()
    }),
    (error) => error.code === "STOCK_SNAPSHOT_IMMUTABLE_CONFLICT"
  );
  client.objects.set(immutablePath, originalImmutable);

  client.conflictCurrentWriteOnce();
  const marked = await store.markServingPrevious("2026-07-11", [
    "NETWORK_ERROR",
    "NETWORK_ERROR",
    "bad message"
  ]);
  assert.strictEqual(marked.refreshStatus, "SERVING_PREVIOUS");
  assert.deepStrictEqual(marked.errorCodes, ["NETWORK_ERROR"]);
  assert.strictEqual(
    (await store.loadCurrentEnvelope()).refreshStatus,
    "SERVING_PREVIOUS"
  );
  await assert.rejects(
    store.markServingPrevious("2026-07-10", ["REGRESSION"]),
    (error) => error.code === "STOCK_SNAPSHOT_EXPECTED_DATE_REGRESSION"
  );

  let release;
  let acquired;
  const lockAcquired = new Promise((resolve) => { acquired = resolve; });
  const first = store.withRefreshLock(async () => {
    acquired();
    await new Promise((resolve) => { release = resolve; });
  });
  await lockAcquired;
  await assert.rejects(
    store.withRefreshLock(async () => {}),
    (error) => error.code === "STOCK_REFRESH_LOCKED"
  );
  release();
  await first;
  assert.ok(!client.objects.has("stock-ytd/refresh.lock"));

  client.objects.set("stock-ytd/refresh.lock", {
    body: JSON.stringify({
      ownerToken: "abandoned-owner",
      createdAt: "2026-07-10T08:00:00.000Z",
      heartbeatAt: "2026-07-10T08:00:00.000Z"
    }),
    etag: "abandoned-etag",
    uploadedAt: new Date("2026-07-10T08:00:00.000Z")
  });
  now = Date.parse("2026-07-10T11:05:00.000Z");
  let recovered = false;
  await store.withRefreshLock(async () => {
    recovered = true;
  }, { staleAfterMs: 60 * 1000 });
  assert.strictEqual(recovered, true);
  assert.ok(!client.objects.has("stock-ytd/refresh.lock"));

  // 历史快照只读能力：日期列表来自不可变快照文件名。
  const availableDates = await store.listAvailableSnapshotDates();
  assert.deepStrictEqual(availableDates, ["2026-07-10"]);

  // 同日多份快照取上传时间最新且校验通过者。
  const historical = await store.loadLatestSnapshotForDate("2026-07-10");
  assert.ok(historical);
  assert.strictEqual(historical.snapshotId, orphanPrepared.snapshotId);
  assert.strictEqual(historical.snapshot.asOf, "2026-07-10");
  assert.strictEqual(historical.snapshot.productionPublishable, true);

  // 损坏的最新快照被跳过，回退到次新可解析快照。
  const corruptPrepared = preparePublishedEnvelope({
    ...productionSnapshot(),
    publishedAt: "2026-07-10T11:40:00.000Z"
  }, {
    expectedAsOf: "2026-07-10",
    refreshedAt: "2026-07-10T11:41:00.000Z",
    tradingCalendar: tradingCalendar()
  });
  const corruptPath = `stock-ytd/snapshots/${corruptPrepared.snapshotId}.json`;
  await client.put(corruptPath, "{not json", { allowOverwrite: false });
  client.objects.get(corruptPath).uploadedAt = new Date("2026-07-10T11:45:00.000Z");
  const fallback = await store.loadLatestSnapshotForDate("2026-07-10");
  assert.ok(fallback);
  assert.strictEqual(fallback.snapshotId, orphanPrepared.snapshotId);

  // 无快照日期返回 null；非法日期抛错。
  assert.strictEqual(await store.loadLatestSnapshotForDate("2026-07-09"), null);
  await assert.rejects(store.loadLatestSnapshotForDate("not-a-date"));

  // 区间统计逐日回填文件读写与列表。
  const dailyPayload = {
    version: "stock-ytd-interval-daily.v1",
    asOf: "2026-03-18",
    baseDate: "2025-12-31",
    methodologyVersion: "backfill-qfq.v1",
    generatedAt: "2026-07-16T12:00:00.000Z",
    records: { "600000.SH": { exchange: "SH", ytd: -0.12 } }
  };
  await store.putIntervalDailyMap("2026-03-18", dailyPayload);
  assert.ok(client.objects.has("stock-ytd/interval/daily/2026-03-18.json"));

  const loadedDaily = await store.loadIntervalDailyMap("2026-03-18");
  assert.deepStrictEqual(loadedDaily, dailyPayload);
  assert.strictEqual(await store.loadIntervalDailyMap("2026-03-17"), null);

  // 覆盖写允许（因子修订重灌）。
  const revised = { ...dailyPayload, records: { "600000.SH": { exchange: "SH", ytd: -0.13 } } };
  await store.putIntervalDailyMap("2026-03-18", revised);
  assert.strictEqual(
    (await store.loadIntervalDailyMap("2026-03-18")).records["600000.SH"].ytd,
    -0.13
  );

  // 版本或日期不符的文件按缺失处理。
  client.objects.set("stock-ytd/interval/daily/2026-03-19.json", {
    body: JSON.stringify({ ...dailyPayload, asOf: "2026-03-20" }),
    etag: "mismatch",
    uploadedAt: new Date()
  });
  assert.strictEqual(await store.loadIntervalDailyMap("2026-03-19"), null);

  await store.putIntervalDailyMap("2025-12-31", {
    ...dailyPayload,
    asOf: "2025-12-31",
    records: { "600000.SH": { exchange: "SH", ytd: 0 } }
  });
  assert.deepStrictEqual(
    await store.listIntervalDailyDates(),
    ["2025-12-31", "2026-03-18", "2026-03-19"]
  );

  console.log("stock snapshot Blob store tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
