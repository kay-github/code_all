"use strict";

const crypto = require("crypto");
const { runStockDailyWorker } = require("../lib/stockDailyWorker");
const { createStockSnapshotBlobStore } = require("../lib/stockSnapshotBlobStore");

function sendJson(res, status, data) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.statusCode = status;
  res.end(JSON.stringify(data));
}

function requestHeader(req, name) {
  const headers = req && req.headers;
  if (!headers) return "";
  const value = headers[name.toLowerCase()] || headers[name];
  return String(Array.isArray(value) ? value[0] : value || "");
}

function secretMatches(authorization, secret) {
  if (!secret || !authorization.startsWith("Bearer ")) return false;
  const provided = Buffer.from(authorization.slice(7), "utf8");
  const expected = Buffer.from(String(secret), "utf8");
  return provided.length === expected.length &&
    crypto.timingSafeEqual(provided, expected);
}

function publicSummary(result) {
  return {
    status: result.status,
    snapshotId: result.snapshotId || null,
    asOf: result.asOf || null,
    expectedAsOf: result.expectedAsOf || null,
    sourceMode: result.sourceMode || null,
    coverageRatio: Number.isFinite(result.coverageRatio)
      ? result.coverageRatio
      : null,
    referenceFailureCode: result.referenceFailureCode || null,
    calendarFailureCode: result.calendarFailureCode || null
  };
}

function createHandler(options = {}) {
  const env = options.env || process.env;
  const runWorker = options.runStockDailyWorker || runStockDailyWorker;
  const logger = options.logger || console;
  return async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "GET" && req.method !== "POST") {
      sendJson(res, 405, {
        ok: false,
        error: "METHOD_NOT_ALLOWED"
      });
      return;
    }
    if (!env.CRON_SECRET) {
      sendJson(res, 503, {
        ok: false,
        error: "STOCK_REFRESH_NOT_CONFIGURED"
      });
      return;
    }
    if (!secretMatches(requestHeader(req, "authorization"), env.CRON_SECRET)) {
      sendJson(res, 401, {
        ok: false,
        error: "UNAUTHORIZED"
      });
      return;
    }
    if (!env.TUSHARE_TOKEN) {
      sendJson(res, 503, {
        ok: false,
        error: "STOCK_REFRESH_NOT_CONFIGURED"
      });
      return;
    }

    try {
      const storage = options.storage || createStockSnapshotBlobStore({ env });
      const result = await runWorker({ env, storage });
      sendJson(res, 200, {
        ok: true,
        refresh: publicSummary(result)
      });
    } catch (error) {
      logger.error("stock refresh failed", {
        name: error && error.name,
        code: error && error.code,
        causeCode: error && error.details && error.details.causeCode
      });
      sendJson(res, error && error.code === "STOCK_REFRESH_LOCKED" ? 409 : 503, {
        ok: false,
        error: error && error.code === "STOCK_REFRESH_LOCKED"
          ? "STOCK_REFRESH_ALREADY_RUNNING"
          : "STOCK_REFRESH_FAILED",
        errorCode: error && error.code ? String(error.code).slice(0, 80) : "UNKNOWN_ERROR"
      });
    }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
module.exports.publicSummary = publicSummary;
module.exports.secretMatches = secretMatches;
