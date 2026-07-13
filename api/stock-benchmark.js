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

function publicBenchmark(benchmark) {
  if (
    !benchmark ||
    typeof benchmark.symbol !== "string" ||
    typeof benchmark.name !== "string" ||
    typeof benchmark.type !== "string" ||
    !Number.isFinite(benchmark.ytd) ||
    typeof benchmark.asOf !== "string" ||
    typeof benchmark.baseDate !== "string"
  ) {
    return null;
  }
  return {
    symbol: benchmark.symbol,
    name: benchmark.name,
    type: benchmark.type,
    ytd: benchmark.ytd,
    asOf: benchmark.asOf,
    baseDate: benchmark.baseDate
  };
}

function createHandler(options = {}) {
  const load = options.loadStockSnapshot || loadStockSnapshot;
  const logger = options.logger || console;

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
        error: "METHOD_NOT_ALLOWED",
        message: "仅支持 GET 请求"
      });
      return;
    }

    try {
      const loaded = await load();
      const snapshot = loaded.snapshot;
      const benchmark = publicBenchmark(snapshot.benchmark);
      if (!benchmark) {
        sendJson(res, 503, {
          error: "BENCHMARK_DATA_UNAVAILABLE",
          message: "暂未获取沪深300数据"
        });
        return;
      }

      sendJson(res, 200, {
        snapshotId: snapshot.snapshotId || `${loaded.mode}-${snapshot.asOf}`,
        dataMode: loaded.mode,
        warning: loaded.warning || snapshot.dataWarning || null,
        asOf: benchmark.asOf,
        expectedAsOf: snapshot.expectedAsOf,
        publishedAt: snapshot.publishedAt,
        isStale: snapshot.isStale,
        benchmark
      });
    } catch (error) {
      const knownDataError = error instanceof StockPublishedSnapshotError ||
        error && error.code === "SNAPSHOT_NOT_PUBLISHABLE";
      if (!knownDataError) {
        logger.error("stock benchmark internal error", {
          name: error && error.name,
          code: error && error.code
        });
      }
      sendJson(res, knownDataError ? 503 : 500, {
        error: knownDataError ? "BENCHMARK_DATA_UNAVAILABLE" : "INTERNAL_ERROR",
        message: "暂未获取沪深300数据"
      });
    }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
module.exports.publicBenchmark = publicBenchmark;
