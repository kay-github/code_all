"use strict";

const zlib = require("zlib");
const { createStockSnapshotBlobStore } = require("../lib/stockSnapshotBlobStore");
const { validatePublishedSnapshot } = require("../lib/stockPublishedSnapshot");
const { assertBenchmarkPublishable } = require("../lib/stockBenchmark");
const { validateTradingCalendar } = require("../lib/stockTradingDates");
const { authorizeStockPublish } = require("../lib/stockPublishAuth");
const { normalizeDate } = require("../lib/stockSnapshot");

const MAX_COMPRESSED_BYTES = 4 * 1024 * 1024;
const MAX_JSON_BYTES = 30 * 1024 * 1024;

function sendJson(res, status, data) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.statusCode = status;
  res.end(JSON.stringify(data));
}

function requestHeader(req, name) {
  const headers = req && req.headers;
  if (!headers) return null;
  const value = headers[name.toLowerCase()] || headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function parseRecoveryAsOf(req) {
  let values = null;
  if (req && req.query && Object.prototype.hasOwnProperty.call(req.query, "recoverAsOf")) {
    const value = req.query.recoverAsOf;
    values = Array.isArray(value) ? value : [value];
  } else if (req && req.url) {
    try {
      values = new URL(req.url, "https://stock-publish.local")
        .searchParams
        .getAll("recoverAsOf");
    } catch {
      values = null;
    }
  }
  if (!values || values.length === 0) return null;
  const value = values.length === 1 ? values[0] : null;
  try {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new TypeError("recoverAsOf must be YYYY-MM-DD");
    }
    const normalized = normalizeDate(value, "recoverAsOf");
    if (normalized !== value) throw new TypeError("recoverAsOf must be YYYY-MM-DD");
    return normalized;
  } catch {
    const error = new Error("recovery date is invalid");
    error.code = "PUBLISH_RECOVERY_DATE_INVALID";
    throw error;
  }
}

async function readRawBody(req) {
  const length = Number(requestHeader(req, "content-length"));
  if (Number.isFinite(length) && length > MAX_COMPRESSED_BYTES) {
    const error = new Error("compressed publish body is too large");
    error.code = "PUBLISH_BODY_TOO_LARGE";
    throw error;
  }
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === "string") return Buffer.from(req.body, "binary");
  const chunks = [];
  let size = 0;
  if (!req || !req[Symbol.asyncIterator]) {
    const error = new Error("publish body is missing");
    error.code = "PUBLISH_BODY_INVALID";
    throw error;
  }
  for await (const value of req) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    size += chunk.length;
    if (size > MAX_COMPRESSED_BYTES) {
      const error = new Error("compressed publish body is too large");
      error.code = "PUBLISH_BODY_TOO_LARGE";
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function parsePublishPayload(req) {
  if (!/^application\/gzip(?:\s*;|$)/i.test(String(requestHeader(req, "content-type") || ""))) {
    const error = new Error("publish body must be application/gzip");
    error.code = "PUBLISH_CONTENT_TYPE_INVALID";
    throw error;
  }
  const compressed = await readRawBody(req);
  let body;
  try {
    body = zlib.gunzipSync(compressed, { maxOutputLength: MAX_JSON_BYTES });
  } catch (error) {
    const wrapped = new Error("publish gzip body is invalid");
    wrapped.code = error && error.code === "ERR_BUFFER_TOO_LARGE"
      ? "PUBLISH_BODY_TOO_LARGE"
      : "PUBLISH_BODY_INVALID";
    throw wrapped;
  }
  let payload;
  try {
    payload = JSON.parse(body.toString("utf8"));
  } catch (error) {
    const wrapped = new Error("publish body JSON is invalid");
    wrapped.code = "PUBLISH_BODY_INVALID";
    throw wrapped;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    const error = new Error("publish payload is invalid");
    error.code = "PUBLISH_BODY_INVALID";
    throw error;
  }
  return payload;
}

function validatePublishPayload(payload) {
  const snapshot = validatePublishedSnapshot(payload.snapshot, { VERCEL_ENV: "production" });
  assertBenchmarkPublishable(snapshot.benchmark, snapshot);
  const tradingCalendar = validateTradingCalendar(payload.tradingCalendar);
  if (
    payload.expectedAsOf !== snapshot.asOf ||
    snapshot.expectedAsOf !== snapshot.asOf
  ) {
    const error = new Error("publish dates do not match the snapshot");
    error.code = "PUBLISH_DATE_MISMATCH";
    throw error;
  }
  if (!Array.isArray(payload.warningCodes || [])) {
    const error = new Error("publish warning codes are invalid");
    error.code = "PUBLISH_BODY_INVALID";
    throw error;
  }
  if (payload.refreshedAt != null && Number.isNaN(Date.parse(payload.refreshedAt))) {
    const error = new Error("publish refreshedAt is invalid");
    error.code = "PUBLISH_BODY_INVALID";
    throw error;
  }
  return {
    snapshot,
    tradingCalendar,
    warningCodes: payload.warningCodes || [],
    refreshedAt: payload.refreshedAt || new Date().toISOString()
  };
}

function publicSummary(envelope, auth) {
  const snapshot = envelope.snapshot;
  return {
    status: "published",
    snapshotId: envelope.snapshotId,
    asOf: snapshot.asOf,
    expectedAsOf: envelope.expectedAsOf,
    sourceMode: snapshot.sourceMode,
    coverageRatio: snapshot.quality.coverage.ratio,
    computedSources: snapshot.quality.computedSources.active,
    authorization: auth.type
  };
}

function createHandler(options = {}) {
  const env = options.env || process.env;
  const logger = options.logger || console;
  const authorize = options.authorize || authorizeStockPublish;
  return async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "POST") {
      sendJson(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED" });
      return;
    }
    let auth;
    try {
      auth = await authorize(req, env, options.authOptions || {});
    } catch (error) {
      sendJson(res, 401, { ok: false, error: "UNAUTHORIZED" });
      return;
    }
    try {
      const recoverAsOf = parseRecoveryAsOf(req);
      let envelope;
      if (recoverAsOf) {
        const storage = options.storage || createStockSnapshotBlobStore({ env });
        envelope = await storage.withRefreshLock(
          () => storage.promoteLatestSnapshot(recoverAsOf, {
            refreshedAt: new Date().toISOString()
          }),
          { staleAfterMs: env.STOCK_REFRESH_LOCK_STALE_MS }
        );
      } else {
        const payload = validatePublishPayload(await parsePublishPayload(req));
        const storage = options.storage || createStockSnapshotBlobStore({ env });
        envelope = await storage.withRefreshLock(
          () => storage.publishSnapshot(payload.snapshot, {
            expectedAsOf: payload.snapshot.asOf,
            refreshedAt: payload.refreshedAt,
            warningCodes: payload.warningCodes,
            tradingCalendar: payload.tradingCalendar
          }),
          { staleAfterMs: env.STOCK_REFRESH_LOCK_STALE_MS }
        );
      }
      sendJson(res, 200, { ok: true, publish: publicSummary(envelope, auth) });
    } catch (error) {
      const code = error && error.code ? String(error.code).slice(0, 80) : "UNKNOWN_ERROR";
      logger.error("stock publish failed", { code, name: error && error.name });
      const status = code === "PUBLISH_BODY_TOO_LARGE"
        ? 413
        : code.startsWith("PUBLISH_") || code === "STOCK_SNAPSHOT_INVALID"
          ? 400
          : code === "STOCK_REFRESH_LOCKED" || code === "STOCK_SNAPSHOT_CURRENT_CONFLICT"
            ? 409
            : 503;
      sendJson(res, status, {
        ok: false,
        error: status === 503 ? "STOCK_PUBLISH_FAILED" : code
      });
    }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
module.exports.readRawBody = readRawBody;
module.exports.parsePublishPayload = parsePublishPayload;
module.exports.parseRecoveryAsOf = parseRecoveryAsOf;
module.exports.validatePublishPayload = validatePublishPayload;
module.exports.publicSummary = publicSummary;
module.exports.MAX_COMPRESSED_BYTES = MAX_COMPRESSED_BYTES;
module.exports.MAX_JSON_BYTES = MAX_JSON_BYTES;
