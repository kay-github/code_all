"use strict";

const { normalizeDate } = require("./stockSnapshot");

const CSI300_SYMBOL = "000300.SH";

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function buildCsi300Benchmark(rows, options = {}) {
  if (!Array.isArray(rows)) {
    throw new TypeError("CSI300 rows must be an array");
  }
  const baseDate = normalizeDate(options.baseDate, "baseDate");
  const asOf = normalizeDate(options.asOf, "asOf");
  if (baseDate > asOf) {
    throw new RangeError("CSI300 baseDate must not be later than asOf");
  }

  const endpoints = new Map();
  for (const row of rows) {
    if (String(row && row.ts_code || "").trim().toUpperCase() !== CSI300_SYMBOL) {
      continue;
    }
    const date = normalizeDate(row.trade_date, "CSI300 trade_date");
    if (date !== baseDate && date !== asOf) continue;
    if (endpoints.has(date)) {
      const error = new Error("duplicate CSI300 endpoint: " + date);
      error.code = "CSI300_DUPLICATE_ENDPOINT";
      throw error;
    }
    const close = positiveNumber(row.close);
    if (close == null) {
      const error = new Error("invalid CSI300 close: " + date);
      error.code = "CSI300_INVALID_CLOSE";
      throw error;
    }
    endpoints.set(date, close);
  }

  if (!endpoints.has(baseDate) || !endpoints.has(asOf)) {
    const error = new Error("CSI300 YTD endpoint is missing");
    error.code = "CSI300_ENDPOINT_MISSING";
    throw error;
  }
  const baseClose = endpoints.get(baseDate);
  const currentClose = endpoints.get(asOf);
  const ytd = currentClose / baseClose - 1;
  if (!Number.isFinite(ytd) || ytd <= -1) {
    const error = new Error("CSI300 YTD is invalid");
    error.code = "CSI300_YTD_INVALID";
    throw error;
  }

  return {
    symbol: CSI300_SYMBOL,
    name: "沪深300（价格指数）",
    type: "PRICE_INDEX",
    ytd,
    asOf,
    baseDate,
    baseClose,
    currentClose,
    source: options.source || "tushare"
  };
}

function assertBenchmarkPublishable(benchmark, snapshot) {
  if (!benchmark || benchmark.symbol !== CSI300_SYMBOL) {
    throw new TypeError("CSI300 benchmark is required");
  }
  if (benchmark.type !== "PRICE_INDEX") {
    throw new TypeError("CSI300 benchmark must be a price index");
  }
  const asOf = normalizeDate(benchmark.asOf, "benchmark.asOf");
  const baseDate = normalizeDate(benchmark.baseDate, "benchmark.baseDate");
  if (!snapshot || asOf !== snapshot.asOf || baseDate !== snapshot.baseDate) {
    const error = new Error("CSI300 benchmark dates do not match snapshot");
    error.code = "CSI300_DATE_MISMATCH";
    throw error;
  }
  if (!Number.isFinite(benchmark.ytd) || benchmark.ytd <= -1) {
    const error = new Error("CSI300 benchmark YTD is invalid");
    error.code = "CSI300_YTD_INVALID";
    throw error;
  }
  return benchmark;
}

module.exports = {
  CSI300_SYMBOL,
  buildCsi300Benchmark,
  assertBenchmarkPublishable
};
