const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { createFixtureSnapshot } = require("../lib/stockFixture");
const { preparePublishedSnapshot } = require("../lib/stockPublishedSnapshot");
const { createTradingCalendar } = require("../lib/stockTradingDates");
const {
  resolveInside,
  loadCurrentEnvelope,
  publishSnapshot,
  markServingPrevious,
  withRefreshLock
} = require("../lib/stockSnapshotFileStore");

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
    { cal_date: "20260711", is_open: 1 },
    { cal_date: "20260713", is_open: 1 }
  ], {
    coveredFrom: "2025-12-01",
    coveredThrough: "2026-12-31"
  });
}

async function run() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "stock-ytd-store-"));
  try {
    assert.throws(
      () => resolveInside(directory, "..\\outside.json"),
      (error) => error.code === "STOCK_SNAPSHOT_PATH_ESCAPE"
    );

    const inconsistentSnapshot = productionSnapshot();
    inconsistentSnapshot.stocks = inconsistentSnapshot.records.slice();
    await assert.rejects(
      publishSnapshot(directory, inconsistentSnapshot),
      (error) => error.code === "STOCK_SNAPSHOT_INVALID"
    );

    const envelope = await publishSnapshot(directory, productionSnapshot(), {
      expectedAsOf: "2026-07-10",
      refreshedAt: "2026-07-10T10:40:00.000Z",
      tradingCalendar: tradingCalendar()
    });
    assert.strictEqual(envelope.refreshStatus, "PUBLISHED");
    assert.ok(envelope.snapshotId.startsWith("stock-ytd-20260710-"));

    let current = await loadCurrentEnvelope(directory);
    assert.strictEqual(current.snapshotId, envelope.snapshotId);
    const immutablePath = resolveInside(
      directory,
      path.join("snapshots", envelope.snapshotId + ".json")
    );
    assert.ok((await fs.stat(immutablePath)).isFile());

    current = await markServingPrevious(directory, "2026-07-11", [
      "NETWORK_ERROR",
      "NETWORK_ERROR",
      "bad message"
    ]);
    assert.strictEqual(current.snapshotId, envelope.snapshotId);
    assert.strictEqual(current.refreshStatus, "SERVING_PREVIOUS");
    assert.deepStrictEqual(current.errorCodes, ["NETWORK_ERROR"]);
    await assert.rejects(
      markServingPrevious(directory, "2026-07-10", ["REGRESSION"]),
      (error) => error.code === "STOCK_SNAPSHOT_EXPECTED_DATE_REGRESSION"
    );
    current = await markServingPrevious(directory, null, ["CALENDAR_UNAVAILABLE"]);
    assert.strictEqual(current.expectedAsOf, "2026-07-11");
    assert.deepStrictEqual(current.errorCodes, ["CALENDAR_UNAVAILABLE"]);

    const hydrated = preparePublishedSnapshot(
      current,
      { VERCEL_ENV: "production" },
      { now: Date.parse("2026-07-11T11:00:00.000Z") }
    );
    assert.strictEqual(hydrated.expectedAsOf, "2026-07-11");
    assert.strictEqual(hydrated.isStale, true);

    let releaseLock;
    let reportLockAcquired;
    const lockAcquired = new Promise((resolve) => {
      reportLockAcquired = resolve;
    });
    const firstLock = withRefreshLock(directory, async () => {
      reportLockAcquired();
      await new Promise((resolve) => {
        releaseLock = resolve;
      });
    });
    await lockAcquired;
    await assert.rejects(
      withRefreshLock(directory, async () => {}, {
        staleAfterMs: 0,
        now: Date.now() + 24 * 60 * 60 * 1000
      }),
      (error) => error.code === "STOCK_REFRESH_LOCKED"
    );
    releaseLock();
    await firstLock;

    const staleLockPath = resolveInside(directory, "refresh.lock");
    const staleRecoveryPath = staleLockPath + ".recovery";
    await withRefreshLock(directory, async () => {
      await fs.writeFile(staleRecoveryPath, "busy", "utf8");
    });
    assert.ok((await fs.stat(staleLockPath)).isFile());
    assert.ok((await fs.stat(staleRecoveryPath)).isFile());

    await fs.writeFile(staleLockPath, "stale", "utf8");
    await fs.writeFile(staleRecoveryPath, "stale", "utf8");
    await fs.utimes(staleLockPath, new Date(0), new Date(0));
    await fs.utimes(staleRecoveryPath, new Date(0), new Date(0));
    let staleLockRecovered = false;
    await withRefreshLock(directory, async () => {
      staleLockRecovered = true;
    });
    assert.strictEqual(staleLockRecovered, true);
    await assert.rejects(
      fs.stat(staleRecoveryPath),
      (error) => error.code === "ENOENT"
    );

    await fs.writeFile(staleLockPath, JSON.stringify({
      pid: process.ppid,
      ownerToken: "owner-from-an-exited-process",
      createdAt: "2000-01-01T00:00:00.000Z"
    }), "utf8");
    await fs.utimes(staleLockPath, new Date(0), new Date(0));
    let reusedPidLockRecovered = false;
    await withRefreshLock(directory, async () => {
      reusedPidLockRecovered = true;
    });
    assert.strictEqual(reusedPidLockRecovered, true);

    const invalidDirectory = path.join(directory, "invalid-current");
    await fs.mkdir(invalidDirectory, { recursive: true });
    await fs.writeFile(path.join(invalidDirectory, "current.json"), JSON.stringify({
      envelopeVersion: "stock-ytd-current.v1",
      snapshotId: "broken",
      expectedAsOf: "2026-07-10",
      snapshot: {
        snapshotId: "broken",
        asOf: "2026-07-10",
        sourceMode: "validated"
      }
    }), "utf8");
    await assert.rejects(
      loadCurrentEnvelope(invalidDirectory),
      (error) => error.code === "STOCK_SNAPSHOT_CURRENT_INVALID"
    );
  } finally {
    const resolved = path.resolve(directory);
    const tempRoot = path.resolve(os.tmpdir()) + path.sep;
    if (!resolved.startsWith(tempRoot)) {
      throw new Error("refusing to clean a directory outside the temp root");
    }
    await fs.rm(resolved, { recursive: true, force: true });
  }

  console.log("stock snapshot file store tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
