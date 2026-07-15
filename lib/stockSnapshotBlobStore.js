"use strict";

const crypto = require("crypto");
const { normalizeDate } = require("./stockSnapshot");
const {
  parseCurrentEnvelope,
  preparePublishedEnvelope,
  prepareServingPreviousEnvelope,
  snapshotStoreError
} = require("./stockSnapshotStore");

const DEFAULT_PREFIX = "stock-ytd";
const DEFAULT_MAX_BYTES = 12 * 1024 * 1024;
const DEFAULT_REFRESH_LOCK_STALE_MS = 2 * 60 * 60 * 1000;
const CURRENT_WRITE_ATTEMPTS = 3;

function defaultBlobClient() {
  const blob = require("@vercel/blob");
  return {
    del: blob.del,
    get: blob.get,
    list: blob.list,
    put: blob.put,
    isPreconditionFailure(error) {
      return error instanceof blob.BlobPreconditionFailedError;
    }
  };
}

function storePrefix(value) {
  const prefix = String(value || DEFAULT_PREFIX)
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  if (!prefix || prefix.includes("..") || !/^[A-Za-z0-9/_-]+$/.test(prefix)) {
    throw new TypeError("stock snapshot Blob prefix is invalid");
  }
  return prefix;
}

function boundedMaxBytes(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0
    ? Math.min(number, 50 * 1024 * 1024)
    : DEFAULT_MAX_BYTES;
}

function isPreconditionFailure(client, error) {
  if (client && typeof client.isPreconditionFailure === "function") {
    return client.isPreconditionFailure(error);
  }
  return Boolean(error && (
    error.code === "BLOB_PRECONDITION_FAILED" ||
    error.status === 412 ||
    error.statusCode === 412 ||
    /precondition/i.test(String(error.message || ""))
  ));
}

function isNotFound(error) {
  return Boolean(error && (
    error.code === "BLOB_NOT_FOUND" ||
    error.status === 404 ||
    error.statusCode === 404 ||
    /not found/i.test(String(error.message || ""))
  ));
}

async function streamToUtf8(stream, maxBytes) {
  if (!stream) {
    throw snapshotStoreError(
      "STOCK_SNAPSHOT_BLOB_READ_FAILED",
      "stock snapshot Blob returned an empty stream"
    );
  }
  const chunks = [];
  let size = 0;
  const append = (value) => {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    size += chunk.length;
    if (size > maxBytes) {
      throw snapshotStoreError(
        "STOCK_SNAPSHOT_TOO_LARGE",
        "stock snapshot Blob exceeds the configured size limit"
      );
    }
    chunks.push(chunk);
  };

  if (typeof stream.getReader === "function") {
    const reader = stream.getReader();
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        append(result.value);
      }
    } finally {
      reader.releaseLock();
    }
  } else if (stream[Symbol.asyncIterator]) {
    for await (const chunk of stream) append(chunk);
  } else {
    throw snapshotStoreError(
      "STOCK_SNAPSHOT_BLOB_READ_FAILED",
      "stock snapshot Blob stream is unsupported"
    );
  }
  return Buffer.concat(chunks).toString("utf8");
}

function createStockSnapshotBlobStore(options = {}) {
  const client = options.client || defaultBlobClient();
  const prefix = storePrefix(options.prefix);
  const maxBytes = boundedMaxBytes(
    options.maxBytes == null
      ? (options.env || process.env).STOCK_SNAPSHOT_MAX_BYTES
      : options.maxBytes
  );
  const currentPath = `${prefix}/current.json`;
  const lockPath = `${prefix}/refresh.lock`;
  const now = typeof options.now === "function" ? options.now : Date.now;

  function jsonPutOptions(extra = {}) {
    return {
      access: "private",
      addRandomSuffix: false,
      contentType: "application/json; charset=utf-8",
      cacheControlMaxAge: 60,
      ...extra
    };
  }

  async function readObject(pathname, readOptions = {}) {
    let result;
    try {
      result = await client.get(pathname, {
        access: "private",
        useCache: false
      });
    } catch (error) {
      if (readOptions.allowMissing && isNotFound(error)) return null;
      throw snapshotStoreError(
        readOptions.errorCode || "STOCK_SNAPSHOT_BLOB_READ_FAILED",
        readOptions.errorMessage || "failed to read stock snapshot Blob",
        error
      );
    }
    if (!result) return null;
    if (result.statusCode !== 200 || !result.stream) {
      throw snapshotStoreError(
        readOptions.errorCode || "STOCK_SNAPSHOT_BLOB_READ_FAILED",
        readOptions.errorMessage || "stock snapshot Blob returned an invalid response"
      );
    }
    const body = await streamToUtf8(result.stream, maxBytes);
    return {
      body,
      etag: result.blob && result.blob.etag,
      uploadedAt: result.blob && result.blob.uploadedAt
    };
  }

  async function loadCurrentEnvelopeWithMetadata() {
    const object = await readObject(currentPath, {
      allowMissing: true,
      errorCode: "STOCK_SNAPSHOT_CURRENT_READ_FAILED",
      errorMessage: "failed to read current stock snapshot envelope"
    });
    if (!object) return null;
    try {
      return {
        ...object,
        envelope: parseCurrentEnvelope(object.body)
      };
    } catch (error) {
      throw snapshotStoreError(
        "STOCK_SNAPSHOT_CURRENT_INVALID",
        error.message || "current stock snapshot envelope is invalid",
        error
      );
    }
  }

  async function loadCurrentEnvelope() {
    const current = await loadCurrentEnvelopeWithMetadata();
    return current ? current.envelope : null;
  }

  async function putCurrent(envelope, previous) {
    const body = JSON.stringify(envelope);
    let expected = previous;
    let lastConflict = null;
    for (let attempt = 0; attempt < CURRENT_WRITE_ATTEMPTS; attempt += 1) {
      const putOptions = expected
        ? jsonPutOptions({ allowOverwrite: true, ifMatch: expected.etag })
        : jsonPutOptions({ allowOverwrite: false });
      try {
        await client.put(currentPath, body, putOptions);
        return envelope;
      } catch (error) {
        if (!isPreconditionFailure(client, error)) {
          throw snapshotStoreError(
            "STOCK_SNAPSHOT_CURRENT_WRITE_FAILED",
            "failed to publish current stock snapshot envelope",
            error
          );
        }
        lastConflict = error;
      }

      const latest = await loadCurrentEnvelopeWithMetadata();
      if (latest) {
        const latestEnvelope = latest.envelope;
        const sameSnapshot = latestEnvelope.snapshotId === envelope.snapshotId;
        if (
          sameSnapshot &&
          latestEnvelope.expectedAsOf >= envelope.expectedAsOf
        ) {
          return latestEnvelope;
        }
        if (
          latestEnvelope.expectedAsOf > envelope.expectedAsOf ||
          latestEnvelope.snapshot.asOf > envelope.snapshot.asOf
        ) {
          throw snapshotStoreError(
            "STOCK_SNAPSHOT_EXPECTED_DATE_REGRESSION",
            "current stock snapshot cannot move backwards",
            lastConflict
          );
        }
      }
      expected = latest;
    }
    throw snapshotStoreError(
      "STOCK_SNAPSHOT_CURRENT_CONFLICT",
      "current stock snapshot changed during publication",
      lastConflict
    );
  }

  async function listSnapshotsForDate(asOf) {
    if (typeof client.list !== "function") {
      throw snapshotStoreError(
        "STOCK_SNAPSHOT_RECOVERY_LIST_FAILED",
        "stock snapshot Blob listing is unavailable"
      );
    }
    const datePrefix = `${prefix}/snapshots/stock-ytd-${asOf.replace(/-/g, "")}-`;
    const blobs = [];
    const seenCursors = new Set();
    let cursor;
    do {
      let result;
      try {
        result = await client.list({ prefix: datePrefix, cursor, limit: 1000 });
      } catch (error) {
        throw snapshotStoreError(
          "STOCK_SNAPSHOT_RECOVERY_LIST_FAILED",
          "failed to list recoverable stock snapshot Blobs",
          error
        );
      }
      if (!result || !Array.isArray(result.blobs)) {
        throw snapshotStoreError(
          "STOCK_SNAPSHOT_RECOVERY_LIST_FAILED",
          "stock snapshot Blob listing returned an invalid response"
        );
      }
      for (const blob of result.blobs) {
        if (
          blob &&
          typeof blob.pathname === "string" &&
          blob.pathname.startsWith(datePrefix) &&
          /^stock-ytd-\d{8}-[a-f0-9]{16}\.json$/.test(
            blob.pathname.slice(`${prefix}/snapshots/`.length)
          )
        ) {
          blobs.push({
            pathname: blob.pathname,
            uploadedAt: blob.uploadedAt
          });
        }
      }
      if (!result.hasMore) break;
      if (!result.cursor || seenCursors.has(result.cursor)) {
        throw snapshotStoreError(
          "STOCK_SNAPSHOT_RECOVERY_LIST_FAILED",
          "stock snapshot Blob listing returned an invalid cursor"
        );
      }
      seenCursors.add(result.cursor);
      cursor = result.cursor;
    } while (true);

    return blobs.sort((left, right) => {
      const leftTime = Date.parse(left.uploadedAt) || 0;
      const rightTime = Date.parse(right.uploadedAt) || 0;
      return rightTime - leftTime || right.pathname.localeCompare(left.pathname);
    });
  }

  async function putImmutable(pathname, value) {
    const body = JSON.stringify(value);
    try {
      await client.put(
        pathname,
        body,
        jsonPutOptions({ allowOverwrite: false })
      );
      return;
    } catch (error) {
      if (!isPreconditionFailure(client, error)) {
        throw snapshotStoreError(
          "STOCK_SNAPSHOT_IMMUTABLE_WRITE_FAILED",
          "failed to write immutable stock snapshot Blob",
          error
        );
      }
    }
    const existing = await readObject(pathname, {
      errorCode: "STOCK_SNAPSHOT_IMMUTABLE_WRITE_FAILED",
      errorMessage: "failed to verify immutable stock snapshot Blob"
    });
    if (!existing || existing.body !== body) {
      throw snapshotStoreError(
        "STOCK_SNAPSHOT_IMMUTABLE_CONFLICT",
        "immutable stock snapshot Blob already exists with different content"
      );
    }
  }

  async function publishSnapshot(snapshot, publishOptions = {}) {
    const prepared = preparePublishedEnvelope(snapshot, publishOptions);
    const previous = await loadCurrentEnvelopeWithMetadata();
    if (
      previous &&
      previous.envelope.expectedAsOf > prepared.envelope.expectedAsOf
    ) {
      throw snapshotStoreError(
        "STOCK_SNAPSHOT_EXPECTED_DATE_REGRESSION",
        "expectedAsOf cannot move backwards"
      );
    }
    await putImmutable(
      `${prefix}/snapshots/${prepared.snapshotId}.json`,
      prepared.publishedSnapshot
    );
    return putCurrent(prepared.envelope, previous);
  }

  async function promoteLatestSnapshot(asOf, promoteOptions = {}) {
    const normalizedAsOf = normalizeDate(asOf, "asOf");
    const current = await loadCurrentEnvelopeWithMetadata();
    if (!current) {
      throw snapshotStoreError(
        "STOCK_SNAPSHOT_RECOVERY_CURRENT_MISSING",
        "a current stock snapshot envelope is required for recovery"
      );
    }
    if (current.envelope.expectedAsOf > normalizedAsOf) {
      throw snapshotStoreError(
        "STOCK_SNAPSHOT_EXPECTED_DATE_REGRESSION",
        "expectedAsOf cannot move backwards"
      );
    }

    const candidates = await listSnapshotsForDate(normalizedAsOf);
    if (candidates.length === 0) {
      throw snapshotStoreError(
        "STOCK_SNAPSHOT_RECOVERY_MISSING",
        "no recoverable stock snapshot Blob was found"
      );
    }
    const candidate = candidates[0];
    const object = await readObject(candidate.pathname, {
      errorCode: "STOCK_SNAPSHOT_RECOVERY_READ_FAILED",
      errorMessage: "failed to read the recoverable stock snapshot Blob"
    });
    if (!object) {
      throw snapshotStoreError(
        "STOCK_SNAPSHOT_RECOVERY_READ_FAILED",
        "recoverable stock snapshot Blob disappeared before it could be read"
      );
    }

    let snapshot;
    try {
      snapshot = JSON.parse(object.body);
    } catch (error) {
      throw snapshotStoreError(
        "STOCK_SNAPSHOT_RECOVERY_INVALID",
        "recoverable stock snapshot Blob is invalid JSON",
        error
      );
    }

    let prepared;
    try {
      prepared = preparePublishedEnvelope(snapshot, {
        expectedAsOf: normalizedAsOf,
        refreshedAt: promoteOptions.refreshedAt,
        warningCodes: promoteOptions.warningCodes,
        tradingCalendar: current.envelope.tradingCalendar
      });
    } catch (error) {
      throw snapshotStoreError(
        "STOCK_SNAPSHOT_RECOVERY_INVALID",
        "recoverable stock snapshot Blob failed production validation",
        error
      );
    }
    const expectedPathname = `${prefix}/snapshots/${prepared.snapshotId}.json`;
    if (
      candidate.pathname !== expectedPathname ||
      snapshot.snapshotId !== prepared.snapshotId
    ) {
      throw snapshotStoreError(
        "STOCK_SNAPSHOT_RECOVERY_INVALID",
        "recoverable stock snapshot pathname does not match its snapshotId"
      );
    }
    return putCurrent(prepared.envelope, current);
  }

  async function markServingPrevious(expectedAsOf, errorCodes = []) {
    const current = await loadCurrentEnvelopeWithMetadata();
    if (!current) {
      throw snapshotStoreError(
        "STOCK_SNAPSHOT_PREVIOUS_MISSING",
        "no previous published stock snapshot is available"
      );
    }
    const envelope = prepareServingPreviousEnvelope(
      current.envelope,
      expectedAsOf,
      errorCodes
    );
    return putCurrent(envelope, current);
  }

  async function readLock() {
    const object = await readObject(lockPath, {
      allowMissing: true,
      errorCode: "STOCK_REFRESH_LOCK_FAILED",
      errorMessage: "failed to inspect the stock refresh Blob lock"
    });
    if (!object) return null;
    let metadata = null;
    try {
      metadata = JSON.parse(object.body);
    } catch (error) {
      metadata = null;
    }
    return { ...object, metadata };
  }

  function lockTimestamp(lock) {
    const metadataTime = Date.parse(
      lock && lock.metadata &&
      (lock.metadata.heartbeatAt || lock.metadata.createdAt)
    );
    if (Number.isFinite(metadataTime)) return metadataTime;
    const uploaded = new Date(lock && lock.uploadedAt).getTime();
    return Number.isFinite(uploaded) ? uploaded : now();
  }

  async function acquireLock(staleAfterMs) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const ownerToken = crypto.randomBytes(16).toString("hex");
      const timestamp = new Date(now()).toISOString();
      const metadata = { ownerToken, createdAt: timestamp, heartbeatAt: timestamp };
      try {
        const result = await client.put(
          lockPath,
          JSON.stringify(metadata),
          jsonPutOptions({ allowOverwrite: false })
        );
        return { ownerToken, etag: result.etag, metadata, failure: null };
      } catch (error) {
        if (!isPreconditionFailure(client, error)) {
          throw snapshotStoreError(
            "STOCK_REFRESH_LOCK_FAILED",
            "failed to acquire stock refresh Blob lock",
            error
          );
        }
      }

      const existing = await readLock();
      if (!existing) continue;
      if (now() - lockTimestamp(existing) <= staleAfterMs) {
        throw snapshotStoreError(
          "STOCK_REFRESH_LOCKED",
          "another stock refresh is already running"
        );
      }
      try {
        await client.del(lockPath, { ifMatch: existing.etag });
      } catch (error) {
        if (!isPreconditionFailure(client, error) && !isNotFound(error)) {
          throw snapshotStoreError(
            "STOCK_REFRESH_LOCK_FAILED",
            "failed to recover stale stock refresh Blob lock",
            error
          );
        }
      }
    }
    throw snapshotStoreError(
      "STOCK_REFRESH_LOCKED",
      "another stock refresh is already running"
    );
  }

  async function heartbeatLock(lease) {
    const heartbeatAt = new Date(now()).toISOString();
    const metadata = { ...lease.metadata, heartbeatAt };
    try {
      const result = await client.put(
        lockPath,
        JSON.stringify(metadata),
        jsonPutOptions({ allowOverwrite: true, ifMatch: lease.etag })
      );
      lease.etag = result.etag;
      lease.metadata = metadata;
    } catch (error) {
      lease.failure = snapshotStoreError(
        "STOCK_REFRESH_LOCK_LOST",
        "stock refresh Blob lock could not be renewed",
        error
      );
    }
  }

  async function releaseLock(lease) {
    const current = await readLock();
    if (
      !current ||
      !current.metadata ||
      current.metadata.ownerToken !== lease.ownerToken
    ) {
      return;
    }
    try {
      await client.del(lockPath, { ifMatch: current.etag });
    } catch (error) {
      if (!isPreconditionFailure(client, error) && !isNotFound(error)) {
        throw snapshotStoreError(
          "STOCK_REFRESH_LOCK_RELEASE_FAILED",
          "failed to release stock refresh Blob lock",
          error
        );
      }
    }
  }

  async function withRefreshLock(worker, lockOptions = {}) {
    if (typeof worker !== "function") {
      throw new TypeError("refresh worker must be a function");
    }
    const configured = Number(lockOptions.staleAfterMs);
    const staleAfterMs = Number.isFinite(configured) && configured >= 0
      ? Math.max(60 * 1000, configured)
      : DEFAULT_REFRESH_LOCK_STALE_MS;
    const lease = await acquireLock(staleAfterMs);
    const heartbeatMs = Math.max(1000, Math.min(60 * 1000, staleAfterMs / 3));
    let heartbeatInFlight = null;
    const heartbeat = setInterval(() => {
      if (heartbeatInFlight) return;
      heartbeatInFlight = heartbeatLock(lease)
        .catch((error) => {
          lease.failure = error;
        })
        .finally(() => {
          heartbeatInFlight = null;
        });
    }, heartbeatMs);
    if (typeof heartbeat.unref === "function") heartbeat.unref();
    try {
      const result = await worker();
      if (lease.failure) throw lease.failure;
      return result;
    } finally {
      clearInterval(heartbeat);
      if (heartbeatInFlight) await heartbeatInFlight;
      await releaseLock(lease);
    }
  }

  return {
    type: "blob",
    currentPath,
    loadCurrentEnvelope,
    loadCurrentEnvelopeWithMetadata,
    markServingPrevious,
    promoteLatestSnapshot,
    publishSnapshot,
    withRefreshLock
  };
}

module.exports = {
  createStockSnapshotBlobStore,
  streamToUtf8
};
