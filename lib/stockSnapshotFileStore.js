"use strict";

const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const { normalizeDate } = require("./stockSnapshot");
const {
  preparePublishedSnapshot,
  validatePublishedSnapshot
} = require("./stockPublishedSnapshot");
const { validateTradingCalendar } = require("./stockTradingDates");

const DEFAULT_REFRESH_LOCK_STALE_MS = 2 * 60 * 60 * 1000;
const activeRefreshLockOwners = new Set();

function storeError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function rootDirectory(directory) {
  if (!directory || typeof directory !== "string") {
    throw new TypeError("stock snapshot directory is required");
  }
  return path.resolve(directory);
}

function resolveInside(directory, relativePath) {
  const root = rootDirectory(directory);
  const target = path.resolve(root, relativePath);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw storeError(
      "STOCK_SNAPSHOT_PATH_ESCAPE",
      "stock snapshot path must stay inside its store directory"
    );
  }
  return target;
}

async function writeJsonAtomic(directory, relativePath, value) {
  const target = resolveInside(directory, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString("hex")}.tmp`
  );
  const body = JSON.stringify(value, null, 2) + "\n";
  try {
    await fs.writeFile(temp, body, { encoding: "utf8", flag: "wx" });
    await fs.rename(temp, target);
  } catch (error) {
    await fs.unlink(temp).catch(() => {});
    throw storeError(
      "STOCK_SNAPSHOT_ATOMIC_WRITE_FAILED",
      "failed to atomically write stock snapshot metadata",
      error
    );
  }
  return target;
}

async function writeJsonImmutable(directory, relativePath, value) {
  const target = resolveInside(directory, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString("hex")}.tmp`
  );
  const body = JSON.stringify(value, null, 2) + "\n";
  try {
    await fs.writeFile(temp, body, { encoding: "utf8", flag: "wx" });
    try {
      await fs.link(temp, target);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = await fs.readFile(target, "utf8");
      if (existing !== body) {
        throw storeError(
          "STOCK_SNAPSHOT_IMMUTABLE_CONFLICT",
          "immutable stock snapshot already exists with different content"
        );
      }
    }
  } catch (error) {
    throw error.code && error.code.startsWith("STOCK_SNAPSHOT_")
      ? error
      : storeError(
          "STOCK_SNAPSHOT_IMMUTABLE_WRITE_FAILED",
          "failed to write immutable stock snapshot",
          error
        );
  } finally {
    await fs.unlink(temp).catch(() => {});
  }
  return target;
}

async function loadCurrentEnvelope(directory) {
  const currentPath = resolveInside(directory, "current.json");
  let body;
  try {
    body = await fs.readFile(currentPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw storeError(
      "STOCK_SNAPSHOT_CURRENT_READ_FAILED",
      "failed to read current stock snapshot envelope",
      error
    );
  }
  let envelope;
  try {
    envelope = JSON.parse(body);
  } catch (error) {
    throw storeError(
      "STOCK_SNAPSHOT_CURRENT_INVALID",
      "current stock snapshot envelope is invalid JSON",
      error
    );
  }
  if (
    !envelope ||
    envelope.envelopeVersion !== "stock-ytd-current.v1" ||
    !envelope.snapshotId ||
    !envelope.snapshot
  ) {
    throw storeError(
      "STOCK_SNAPSHOT_CURRENT_INVALID",
      "current stock snapshot envelope is invalid"
    );
  }
  try {
    preparePublishedSnapshot(
      envelope,
      { VERCEL_ENV: "production" },
      { now: Date.parse(envelope.snapshot.publishedAt) }
    );
  } catch (error) {
    throw storeError(
      "STOCK_SNAPSHOT_CURRENT_INVALID",
      "current stock snapshot failed integrity validation",
      error
    );
  }
  return envelope;
}

function snapshotIdentifier(snapshot) {
  const core = { ...snapshot };
  delete core.snapshotId;
  const hash = crypto
    .createHash("sha256")
    .update(JSON.stringify(core))
    .digest("hex")
    .slice(0, 16);
  return `stock-ytd-${snapshot.asOf.replace(/-/g, "")}-${hash}`;
}

async function publishSnapshot(directory, snapshot, options = {}) {
  validatePublishedSnapshot(snapshot, { VERCEL_ENV: "production" });
  if (
    snapshot.dataMode !== "published" ||
    String(snapshot.methodologyVersion || "").includes("fixture")
  ) {
    throw storeError(
      "STOCK_SNAPSHOT_NOT_PRODUCTION_DATA",
      "only production stock snapshots can be published"
    );
  }
  const expectedAsOf = normalizeDate(
    options.expectedAsOf || snapshot.asOf,
    "expectedAsOf"
  );
  if (expectedAsOf !== snapshot.asOf || snapshot.expectedAsOf !== snapshot.asOf) {
    throw storeError(
      "STOCK_SNAPSHOT_PUBLISH_DATE_MISMATCH",
      "new stock snapshot must be current when published"
    );
  }
  const tradingCalendar = validateTradingCalendar(options.tradingCalendar);
  if (
    !tradingCalendar.openDates.includes(snapshot.baseDate) ||
    !tradingCalendar.openDates.includes(snapshot.asOf) ||
    snapshot.asOf < tradingCalendar.coveredFrom ||
    snapshot.asOf > tradingCalendar.coveredThrough
  ) {
    throw storeError(
      "STOCK_SNAPSHOT_CALENDAR_MISMATCH",
      "stock snapshot dates are not certified by its trading calendar"
    );
  }

  const snapshotId = snapshotIdentifier(snapshot);
  const publishedSnapshot = { ...snapshot, snapshotId };
  const refreshedAt = options.refreshedAt || new Date().toISOString();
  const envelope = {
    envelopeVersion: "stock-ytd-current.v1",
    snapshotId,
    expectedAsOf,
    refreshStatus: "PUBLISHED",
    refreshedAt,
    errorCodes: [],
    warningCodes: sanitizedErrorCodes(options.warningCodes),
    tradingCalendar,
    snapshot: publishedSnapshot
  };
  await writeJsonImmutable(
    directory,
    path.join("snapshots", snapshotId + ".json"),
    publishedSnapshot
  );
  await writeJsonAtomic(directory, "current.json", envelope);
  return envelope;
}

function sanitizedErrorCodes(values) {
  return [...new Set((values || [])
    .map((value) => String(value || "UNKNOWN_ERROR").slice(0, 80))
    .filter((value) => /^[A-Z0-9_-]+$/.test(value)))]
    .slice(0, 20);
}

async function markServingPrevious(directory, expectedAsOf, errorCodes = []) {
  const current = await loadCurrentEnvelope(directory);
  if (!current) {
    throw storeError(
      "STOCK_SNAPSHOT_PREVIOUS_MISSING",
      "no previous published stock snapshot is available"
    );
  }
  const currentExpected = normalizeDate(
    current.expectedAsOf || current.snapshot.asOf,
    "current.expectedAsOf"
  );
  const normalizedExpected = expectedAsOf == null
    ? currentExpected
    : normalizeDate(expectedAsOf, "expectedAsOf");
  if (normalizedExpected < currentExpected) {
    throw storeError(
      "STOCK_SNAPSHOT_EXPECTED_DATE_REGRESSION",
      "expectedAsOf cannot move backwards"
    );
  }
  const envelope = {
    ...current,
    expectedAsOf: normalizedExpected,
    refreshStatus: "SERVING_PREVIOUS",
    refreshedAt: new Date().toISOString(),
    errorCodes: sanitizedErrorCodes(errorCodes)
  };
  await writeJsonAtomic(directory, "current.json", envelope);
  return envelope;
}

function lockOwnerIsActive(metadata) {
  if (!metadata || !metadata.ownerToken) return false;
  if (metadata.pid === process.pid) {
    return activeRefreshLockOwners.has(metadata.ownerToken);
  }
  return false;
}

async function moveAbandonedRecoveryGuard(recoveryPath, staleAfterMs, nowMs) {
  let stat;
  let metadata = null;
  try {
    const [body, recoveryStat] = await Promise.all([
      fs.readFile(recoveryPath, "utf8"),
      fs.stat(recoveryPath)
    ]);
    stat = recoveryStat;
    try {
      metadata = JSON.parse(body);
    } catch (error) {
      metadata = null;
    }
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw storeError(
      "STOCK_REFRESH_LOCK_FAILED",
      "failed to inspect the stock refresh recovery guard",
      error
    );
  }
  if (nowMs - stat.mtimeMs <= staleAfterMs || lockOwnerIsActive(metadata)) {
    return false;
  }

  const abandonedPath = `${recoveryPath}.abandoned.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
  try {
    await fs.rename(recoveryPath, abandonedPath);
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw storeError(
      "STOCK_REFRESH_LOCK_FAILED",
      "failed to quarantine the stock refresh recovery guard",
      error
    );
  }
  try {
    const movedMetadata = JSON.parse(await fs.readFile(abandonedPath, "utf8"));
    if (lockOwnerIsActive(movedMetadata)) {
      await fs.rename(abandonedPath, recoveryPath).catch(() => {});
      return false;
    }
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  await fs.unlink(abandonedPath).catch(() => {});
  return true;
}

async function acquireRecoveryGuard(recoveryPath, staleAfterMs, nowMs) {
  const ownerToken = crypto.randomBytes(16).toString("hex");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let handle;
    try {
      handle = await fs.open(recoveryPath, "wx");
      await handle.writeFile(JSON.stringify({
        pid: process.pid,
        ownerToken,
        createdAt: new Date(nowMs).toISOString()
      }));
      activeRefreshLockOwners.add(ownerToken);
      return { handle, ownerToken };
    } catch (error) {
      if (handle) {
        await handle.close().catch(() => {});
        await fs.unlink(recoveryPath).catch(() => {});
      }
      if (
        error.code === "EEXIST" &&
        attempt === 0 &&
        await moveAbandonedRecoveryGuard(recoveryPath, staleAfterMs, nowMs)
      ) {
        continue;
      }
      if (error.code === "EEXIST") return null;
      throw storeError(
        "STOCK_REFRESH_LOCK_FAILED",
        "failed to acquire the stock refresh lock recovery guard",
        error
      );
    }
  }
  return null;
}

async function moveStaleRefreshLock(lockPath, staleAfterMs, nowMs) {
  const recoveryPath = lockPath + ".recovery";
  const recovery = await acquireRecoveryGuard(recoveryPath, staleAfterMs, nowMs);
  if (!recovery) return false;

  try {
    let stat;
    let metadata = null;
    try {
      const [body, lockStat] = await Promise.all([
        fs.readFile(lockPath, "utf8"),
        fs.stat(lockPath)
      ]);
      stat = lockStat;
      try {
        metadata = JSON.parse(body);
      } catch (error) {
        metadata = null;
      }
    } catch (error) {
      if (error.code === "ENOENT") return true;
      throw storeError(
        "STOCK_REFRESH_LOCK_FAILED",
        "failed to inspect the stock refresh lock",
        error
      );
    }
    if (nowMs - stat.mtimeMs <= staleAfterMs || lockOwnerIsActive(metadata)) {
      return false;
    }

    const stalePath = `${lockPath}.stale.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
    try {
      await fs.rename(lockPath, stalePath);
    } catch (error) {
      if (error.code === "ENOENT") return true;
      throw storeError(
        "STOCK_REFRESH_LOCK_FAILED",
        "failed to quarantine a stale stock refresh lock",
        error
      );
    }
    await fs.unlink(stalePath).catch(() => {});
    return true;
  } finally {
    await releaseOwnedLockFile(
      recoveryPath,
      recovery.ownerToken,
      recovery.handle
    );
  }
}

async function unlinkOwnedLockFile(lockPath, ownerToken) {
  try {
    const metadata = JSON.parse(await fs.readFile(lockPath, "utf8"));
    if (metadata.ownerToken === ownerToken) {
      await fs.unlink(lockPath);
    }
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) {
      throw storeError(
        "STOCK_REFRESH_LOCK_RELEASE_FAILED",
        "failed to release the stock refresh lock",
        error
      );
    }
  }
}

async function releaseOwnedLockFile(lockPath, ownerToken, handle) {
  await handle.close().catch(() => {});
  activeRefreshLockOwners.delete(ownerToken);
  await unlinkOwnedLockFile(lockPath, ownerToken);
}

async function releaseMainRefreshLock(
  lockPath,
  ownerToken,
  handle,
  staleAfterMs
) {
  await handle.close().catch(() => {});
  const recoveryPath = lockPath + ".recovery";
  const recovery = await acquireRecoveryGuard(
    recoveryPath,
    staleAfterMs,
    Date.now()
  );
  if (!recovery) {
    activeRefreshLockOwners.delete(ownerToken);
    return;
  }
  try {
    await unlinkOwnedLockFile(lockPath, ownerToken);
  } finally {
    activeRefreshLockOwners.delete(ownerToken);
    await releaseOwnedLockFile(
      recoveryPath,
      recovery.ownerToken,
      recovery.handle
    );
  }
}

async function heartbeatRefreshLock(lockPath, ownerToken) {
  try {
    const metadata = JSON.parse(await fs.readFile(lockPath, "utf8"));
    if (metadata.ownerToken !== ownerToken) return;
    const now = new Date();
    await fs.utimes(lockPath, now, now);
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
}

async function withRefreshLock(directory, worker, options = {}) {
  if (typeof worker !== "function") {
    throw new TypeError("refresh worker must be a function");
  }
  const lockPath = resolveInside(directory, "refresh.lock");
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const configuredStaleMs = Number(options.staleAfterMs);
  const staleAfterMs = Number.isFinite(configuredStaleMs) && configuredStaleMs >= 0
    ? Math.max(60 * 1000, configuredStaleMs)
    : DEFAULT_REFRESH_LOCK_STALE_MS;
  const nowMs = Number.isFinite(options.now) ? options.now : Date.now();
  const ownerToken = crypto.randomBytes(16).toString("hex");
  let handle;
  for (let attempt = 0; attempt < 2 && !handle; attempt += 1) {
    try {
      handle = await fs.open(lockPath, "wx");
      await handle.writeFile(JSON.stringify({
        pid: process.pid,
        ownerToken,
        createdAt: new Date(nowMs).toISOString()
      }));
      activeRefreshLockOwners.add(ownerToken);
    } catch (error) {
      if (handle) {
        await handle.close().catch(() => {});
        handle = null;
        await fs.unlink(lockPath).catch(() => {});
      }
      if (
        error.code === "EEXIST" &&
        attempt === 0 &&
        await moveStaleRefreshLock(lockPath, staleAfterMs, nowMs)
      ) {
        continue;
      }
      if (error.code === "EEXIST") {
        throw storeError(
          "STOCK_REFRESH_LOCKED",
          "another stock refresh is already running"
        );
      }
      throw storeError(
        "STOCK_REFRESH_LOCK_FAILED",
        "failed to acquire stock refresh lock",
        error
      );
    }
  }

  const heartbeatMs = Math.max(1000, Math.min(60 * 1000, staleAfterMs / 3));
  const heartbeat = setInterval(() => {
    heartbeatRefreshLock(lockPath, ownerToken).catch(() => {});
  }, heartbeatMs);
  if (typeof heartbeat.unref === "function") heartbeat.unref();
  try {
    return await worker();
  } finally {
    clearInterval(heartbeat);
    await releaseMainRefreshLock(
      lockPath,
      ownerToken,
      handle,
      staleAfterMs
    );
  }
}

module.exports = {
  resolveInside,
  writeJsonAtomic,
  loadCurrentEnvelope,
  publishSnapshot,
  markServingPrevious,
  withRefreshLock
};
