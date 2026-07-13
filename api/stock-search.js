"use strict";

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

function matchPriority(record, query) {
  const code = record.code.toUpperCase();
  const symbol = record.symbol.toUpperCase();
  const name = record.name.toUpperCase();
  const normalized = query.toUpperCase();

  if (code === normalized || symbol === normalized) return 0;
  if (name === normalized) return 1;
  if (name.startsWith(normalized)) return 2;
  if (code.startsWith(normalized)) return 3;
  if (name.includes(normalized)) return 4;
  if (code.includes(normalized) || symbol.includes(normalized)) return 5;
  return null;
}

function searchStocks(snapshot, query) {
  return snapshot.records
    .map((record) => ({ record, priority: matchPriority(record, query) }))
    .filter((item) => item.priority != null)
    .sort((left, right) =>
      left.priority - right.priority ||
      left.record.name.localeCompare(right.record.name, "zh-CN") ||
      left.record.symbol.localeCompare(right.record.symbol)
    )
    .slice(0, 8)
    .map(({ record }) => ({
      symbol: record.symbol,
      code: record.code,
      name: record.name,
      exchange: record.exchange,
      board: record.board,
      listingStatus: record.listingStatus
    }));
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
    const query = String(readQueryValue(req, "q") || "").trim();
    if (!query) {
      sendJson(res, 400, {
        error: "EMPTY_QUERY",
        message: "请输入股票名称或代码"
      });
      return;
    }
    if (/^\d+$/.test(query) && query.length < 2) {
      sendJson(res, 400, {
        error: "QUERY_TOO_SHORT",
        message: "股票代码至少输入两位"
      });
      return;
    }

    try {
      const loaded = await load();
      const snapshot = loaded.snapshot;
      sendJson(res, 200, {
        items: searchStocks(snapshot, query),
        asOf: snapshot.asOf,
        dataMode: loaded.mode,
        warning: loaded.warning || snapshot.dataWarning || null
      });
    } catch (error) {
      const knownDataError = error instanceof StockPublishedSnapshotError ||
        error && error.code === "SNAPSHOT_NOT_PUBLISHABLE";
      if (!knownDataError) {
        logger.error("stock search internal error", {
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
            message: "股票搜索服务暂时不可用"
          });
    }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
module.exports.searchStocks = searchStocks;
