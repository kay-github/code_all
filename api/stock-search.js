"use strict";

const {
  fixtureEnabled,
  getFixtureSnapshot
} = require("../lib/stockFixture");

function sendJson(res, status, data) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
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

module.exports = function handler(req, res) {
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
  if (!fixtureEnabled()) {
    sendJson(res, 503, {
      error: "STOCK_DATA_NOT_READY",
      message: "股票生产快照尚未配置"
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

  const snapshot = getFixtureSnapshot();
  sendJson(res, 200, {
    items: searchStocks(snapshot, query),
    asOf: snapshot.asOf,
    dataMode: snapshot.dataMode,
    warning: snapshot.dataWarning
  });
};

module.exports.searchStocks = searchStocks;
