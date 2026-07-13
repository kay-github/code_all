"use strict";

const { queryStockSnapshot } = require("../lib/stockSnapshot");
const {
  StockPublishedSnapshotError,
  loadStockSnapshot
} = require("../lib/stockPublishedSnapshot");

function sendJson(res, status, data, cacheControl = "no-store") {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", cacheControl);
  res.statusCode = status;
  res.end(JSON.stringify(data));
}

function readQueryValue(req, name) {
  const value = req.query && req.query[name];
  return Array.isArray(value) ? value[0] : value;
}

function parseIncludeBse(value) {
  if (value == null || value === "") return false;
  if (value === true || value === "true" || value === "1") return true;
  if (value === false || value === "false" || value === "0") return false;
  return null;
}

function directionFor(ytd) {
  if (ytd == null) return null;
  if (ytd > 0) return "UP";
  if (ytd < 0) return "DOWN";
  return "FLAT";
}

function publicStock(record, asOf) {
  return {
    symbol: record.symbol,
    code: record.code,
    name: record.name,
    exchange: record.exchange,
    board: record.board,
    ytd: record.ytd,
    direction: directionFor(record.ytd),
    basePriceDate: record.basePriceDate,
    lastPriceDate: record.lastPriceDate,
    isSuspended: Boolean(record.lastPriceDate && record.lastPriceDate < asOf),
    hasFullYtd: record.hasFullYtd,
    ineligibilityReason: record.ineligibilityReason,
    sinceListingReturn: null
  };
}

function createHandler(options = {}) {
  const load = options.loadStockSnapshot || loadStockSnapshot;
  const query = options.queryStockSnapshot || queryStockSnapshot;
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
    const symbol = String(readQueryValue(req, "symbol") || "")
      .trim()
      .toUpperCase();
    if (!/^\d{6}\.(SH|SZ|BJ)$/.test(symbol)) {
      sendJson(res, 400, {
        error: "INVALID_SYMBOL",
        message: "股票代码格式错误"
      });
      return;
    }
    const includeBse = parseIncludeBse(readQueryValue(req, "includeBse"));
    if (includeBse == null) {
      sendJson(res, 400, {
        error: "INVALID_INCLUDE_BSE",
        message: "includeBse 只能为 true 或 false"
      });
      return;
    }

    try {
      const loaded = await load();
      const snapshot = loaded.snapshot;
      const result = query(snapshot, symbol, { includeBse });
      if (!result) {
        sendJson(res, 404, {
          error: "STOCK_NOT_FOUND",
          message: "未找到该股票"
        });
        return;
      }

      sendJson(res, 200, {
        snapshotId: snapshot.snapshotId || `${loaded.mode}-${snapshot.asOf}`,
        dataMode: loaded.mode,
        warning: loaded.warning || snapshot.dataWarning || null,
        asOf: result.asOf,
        expectedAsOf: result.expectedAsOf,
        publishedAt: result.publishedAt,
        isStale: result.isStale,
        periodResetRequired: Boolean(snapshot.periodResetRequired),
        calendarCoverageExpired: Boolean(snapshot.calendarCoverageExpired),
        baseDate: result.baseDate,
        methodologyVersion: result.methodologyVersion,
        stock: publicStock(result.stock, result.asOf),
        comparison: result.comparison,
        benchmark: snapshot.benchmark || null
      });
    } catch (error) {
      const knownDataError = error instanceof StockPublishedSnapshotError ||
        error && error.code === "SNAPSHOT_NOT_PUBLISHABLE";
      if (!knownDataError) {
        logger.error("stock YTD internal error", {
          name: error && error.name,
          code: error && error.code
        });
      }
      sendJson(res, knownDataError ? 503 : 500, knownDataError
        ? {
            error: "STOCK_DATA_UNAVAILABLE",
            message: "股票数据暂未准备好，请稍后重试"
          }
        : {
            error: "INTERNAL_ERROR",
            message: "股票查询服务暂时不可用"
          });
    }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
module.exports.parseIncludeBse = parseIncludeBse;
module.exports.publicStock = publicStock;
