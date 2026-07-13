const assert = require("assert");
const { createFixtureSnapshot } = require("../lib/stockFixture");
const { createTradingCalendar } = require("../lib/stockTradingDates");
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
  return {
    objects,
    isPreconditionFailure(error) {
      return error && error.code === "BLOB_PRECONDITION_FAILED";
    },
    async put(pathname, body, options = {}) {
      const existing = objects.get(pathname);
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

  const marked = await store.markServingPrevious("2026-07-11", [
    "NETWORK_ERROR",
    "NETWORK_ERROR",
    "bad message"
  ]);
  assert.strictEqual(marked.refreshStatus, "SERVING_PREVIOUS");
  assert.deepStrictEqual(marked.errorCodes, ["NETWORK_ERROR"]);
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

  console.log("stock snapshot Blob store tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
