"use strict";

const {
  StockPublishedSnapshotError,
  loadStockSnapshot
} = require("../lib/stockPublishedSnapshot");

function sendJson(res, status, data) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.statusCode = status;
  res.end(JSON.stringify(data));
}

function healthStatus(loaded) {
  if (loaded.mode === "fixture") return "DEMO";
  const snapshot = loaded.snapshot;
  const degraded = snapshot.isStale ||
    snapshot.sourceMode !== "validated" ||
    snapshot.quality.status !== "pass" ||
    loaded.refreshStatus === "SERVING_PREVIOUS" ||
    loaded.cacheStatus === "stale-fallback";
  return degraded ? "DEGRADED" : "READY";
}

function createHandler(options = {}) {
  const load = options.loadStockSnapshot || loadStockSnapshot;
  return async function handler(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }
    if (req.method !== "GET") {
      sendJson(res, 405, {
        ok: false,
        status: "METHOD_NOT_ALLOWED"
      });
      return;
    }

    try {
      const loaded = await load();
      const snapshot = loaded.snapshot;
      sendJson(res, 200, {
        ok: true,
        status: healthStatus(loaded),
        mode: loaded.mode,
        snapshotId: snapshot.snapshotId || null,
        asOf: snapshot.asOf,
        expectedAsOf: snapshot.expectedAsOf,
        publishedAt: snapshot.publishedAt,
        isStale: snapshot.isStale,
        sourceMode: snapshot.sourceMode,
        qualityStatus: snapshot.quality.status,
        coverageRatio: snapshot.quality.coverage.ratio,
        cacheStatus: loaded.cacheStatus,
        refreshStatus: loaded.refreshStatus || null,
        lastValidatedAt: loaded.lastValidatedAt || null,
        benchmarkAvailable: Boolean(snapshot.benchmark)
      });
    } catch (error) {
      const knownDataError = error instanceof StockPublishedSnapshotError ||
        error && error.code === "SNAPSHOT_NOT_PUBLISHABLE";
      if (!knownDataError) {
        console.error("stock health internal error", {
          name: error && error.name,
          code: error && error.code
        });
      }
      sendJson(res, knownDataError ? 503 : 500, {
        ok: false,
        status: knownDataError ? "NOT_READY" : "INTERNAL_ERROR",
        errorCode: knownDataError ? error.code : "INTERNAL_ERROR"
      });
    }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
module.exports.healthStatus = healthStatus;
