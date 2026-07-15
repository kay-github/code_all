"use strict";

const {
  StockSourceError,
  fetchEastmoneyMarket,
  fetchTencentQfqKlines,
  requestJson
} = require("./stockSources");
const { buildStockSnapshot, assertSnapshotPublishable, normalizeDate } = require("./stockSnapshot");
const {
  assertBenchmarkPublishable,
  buildCsi300Benchmark,
  CSI300_SYMBOL
} = require("./stockBenchmark");
const {
  createTradingCalendar,
  deriveExpectedDatesFromCalendar,
  shanghaiDateParts,
  validateTradingCalendar
} = require("./stockTradingDates");

const METHODOLOGY_VERSION = "reported-ytd.v1";
const POOL_VERSION = "eastmoney-a-share.v1";
const EASTMONEY_MARKET_URLS = Object.freeze([
  "https://push2.eastmoney.com/api/qt/clist/get",
  "https://push2delay.eastmoney.com/api/qt/clist/get"
]);
// 东财 f25 为两位小数百分比；哨兵与腾讯前复权自算的允许偏差。
// 舍入本身可造成 ±0.5bp/端点，再叠加两源复权口径差，超过 100bp 视为数据异常。
const SENTINEL_TOLERANCE_BP = 100;
const DEFAULT_SENTINEL_SYMBOLS = Object.freeze([
  "300502.SZ", // 新易盛：高波动，用户对照基准
  "600519.SH", // 贵州茅台：年内分红，验证复权口径
  "000001.SZ", // 平安银行：深主板大盘股
  "600989.SH"  // 宝丰能源：年内分红，历史偏差案例
]);

function workerError(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  return error;
}

function tencentSymbol(symbol) {
  const match = String(symbol).match(/^(\d{6})\.(SH|SZ|BJ)$/);
  if (!match) throw new TypeError(`sentinel symbol is invalid: ${symbol}`);
  const prefix = match[2] === "SH" ? "sh" : match[2] === "SZ" ? "sz" : "bj";
  return prefix + match[1];
}

function normalizeEastmoneyListingDate(value) {
  if (value == null || value === "" || value === "-") return null;
  const text = String(value).trim();
  if (/^\d{8}$/.test(text)) {
    return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  }
  try {
    return normalizeDate(text, "listingDate");
  } catch {
    return null;
  }
}

function boardForCode(code, exchange) {
  if (exchange === "BJ") return "北交所";
  if (code.startsWith("688") || code.startsWith("689")) return "科创板";
  if (code.startsWith("30")) return "创业板";
  return "主板";
}

// 东财 clist 快照行 → 快照 computed 记录。f25 即东财 app 展示的"年初至今涨跌幅"。
function buildComputedRecords(rows, dates) {
  if (!Array.isArray(rows)) {
    throw new TypeError("eastmoney rows must be an array");
  }
  const records = [];
  let missingYtd = 0;
  for (const row of rows) {
    if (!row || !row.symbol || !row.exchange) continue;
    const exchange = row.exchange === "BJ" ? "BSE" : row.exchange;
    if (!["SH", "SZ", "BSE"].includes(exchange)) continue;
    const listingDate = normalizeEastmoneyListingDate(row.listingDate);
    const isNewListing = Boolean(listingDate && listingDate > dates.baseDate);
    const hasYtd = Number.isFinite(row.ytd) && row.ytd > -1;
    if (!hasYtd && !isNewListing) {
      missingYtd += 1;
      continue;
    }
    records.push({
      symbol: row.symbol,
      code: row.code,
      name: row.name,
      exchange,
      board: boardForCode(row.code, row.exchange),
      securityType: "A_SHARE",
      listingStatus: "LISTED",
      listingDate,
      source: "eastmoney",
      sourceAsOf: dates.expectedAsOf,
      baseDate: dates.baseDate,
      computedYtd: isNewListing ? null : row.ytd,
      basePriceDate: isNewListing ? null : dates.baseDate,
      lastPriceDate: isNewListing ? null : dates.expectedAsOf,
      adjustmentMethod: "reported",
      ineligibilityReason: isNewListing ? "NEW_LISTING" : null
    });
  }
  return { records, missingYtd };
}

async function fetchMarketRows(options = {}) {
  const fetchMarket = options.fetchEastmoneyMarket || fetchEastmoneyMarket;
  const baseUrls = options.eastmoneyBaseUrls || EASTMONEY_MARKET_URLS;
  let lastError = null;
  for (const baseUrl of baseUrls) {
    try {
      return await fetchMarket({
        retries: 3,
        timeoutMs: 10000,
        pageDelayMs: 150,
        ...options.marketOptions,
        baseUrl
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw workerError(
    "EASTMONEY_MARKET_UNAVAILABLE",
    "eastmoney market sweep failed on all hosts",
    { causeCode: lastError && lastError.code ? String(lastError.code) : null }
  );
}

// 腾讯日K（原始价，指数无复权概念）提取沪深300基准端点。
function parseTencentIndexRows(payload, symbol) {
  const data = payload && payload.data && payload.data[symbol];
  const rows = data && (Array.isArray(data.day) ? data.day : null);
  if (!rows) {
    throw new StockSourceError("MISSING_FIELD", "tencent index response is missing day klines", {
      source: "tencent",
      retryable: true,
      details: { symbol }
    });
  }
  return rows.map((row) => ({
    ts_code: CSI300_SYMBOL,
    trade_date: row[0],
    close: Number(row[2])
  }));
}

async function fetchCsi300Rows(dates, options = {}) {
  const symbol = "sh000300";
  const url = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=" +
    `${symbol},day,${dates.baseDate},${dates.expectedAsOf},640,day`;
  const payload = await requestJson(url, {
    retries: 2,
    timeoutMs: 10000,
    ...options.benchmarkOptions,
    source: "tencent",
    requestOptions: { method: "GET" }
  });
  return parseTencentIndexRows(payload, symbol).filter(
    (row) => row.trade_date === dates.baseDate || row.trade_date === dates.expectedAsOf
  );
}

// 哨兵闸门：抽样对比东财 f25 与腾讯前复权自算 YTD，防止 f25 整批口径漂移。
async function runSentinelGate(recordsBySymbol, dates, options = {}) {
  const symbols = options.sentinelSymbols || DEFAULT_SENTINEL_SYMBOLS;
  const fetchKlines = options.fetchTencentQfqKlines || fetchTencentQfqKlines;
  const toleranceBp = Number(options.sentinelToleranceBp) > 0
    ? Number(options.sentinelToleranceBp)
    : SENTINEL_TOLERANCE_BP;
  const results = [];
  let comparable = 0;
  for (const symbol of symbols) {
    const record = recordsBySymbol.get(symbol);
    if (!record || record.computedYtd == null) {
      results.push({ symbol, status: "SKIPPED_NO_RECORD" });
      continue;
    }
    let klines;
    try {
      klines = await fetchKlines(tencentSymbol(symbol), {
        startDate: dates.baseDate,
        endDate: dates.expectedAsOf,
        retries: 2,
        timeoutMs: 10000
      });
    } catch (error) {
      results.push({
        symbol,
        status: "SKIPPED_SOURCE_ERROR",
        code: error && error.code ? String(error.code) : null
      });
      continue;
    }
    const byDate = new Map(klines.map((bar) => [bar.date, bar.close]));
    const baseClose = byDate.get(dates.baseDate);
    const lastClose = byDate.get(dates.expectedAsOf);
    if (!baseClose || !lastClose) {
      results.push({ symbol, status: "SKIPPED_ENDPOINT_MISSING" });
      continue;
    }
    const tencentYtd = lastClose / baseClose - 1;
    const deviationBp = Math.abs(tencentYtd - record.computedYtd) * 10000;
    comparable += 1;
    results.push({
      symbol,
      status: deviationBp <= toleranceBp ? "PASS" : "FAIL",
      reportedYtd: record.computedYtd,
      tencentYtd,
      deviationBp: Math.round(deviationBp * 100) / 100
    });
  }
  const failed = results.filter((item) => item.status === "FAIL");
  if (failed.length > 0) {
    throw workerError(
      "SENTINEL_DEVIATION_EXCEEDED",
      "eastmoney reported YTD deviates from tencent qfq beyond tolerance",
      { toleranceBp, results }
    );
  }
  if (comparable === 0 && options.requireSentinel !== false) {
    throw workerError(
      "SENTINEL_UNAVAILABLE",
      "no sentinel symbol could be cross-checked",
      { results }
    );
  }
  return { results, comparable };
}

async function buildEmSnapshot(options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  if (Number.isNaN(now.getTime())) {
    throw new TypeError("worker now must be a valid date");
  }
  const tradingCalendar = validateTradingCalendar(options.tradingCalendar);
  const dates = deriveExpectedDatesFromCalendar(tradingCalendar, shanghaiDateParts(now));
  if (options.requireAsOf && options.requireAsOf !== dates.expectedAsOf) {
    throw workerError(
      "AS_OF_NOT_READY",
      "requested asOf is not the latest completed trading day",
      { requested: options.requireAsOf, expectedAsOf: dates.expectedAsOf }
    );
  }

  const rows = await fetchMarketRows(options);
  const { records: computedRecords, missingYtd } = buildComputedRecords(rows, dates);
  if (computedRecords.length < 5000) {
    throw workerError(
      "MARKET_SWEEP_INCOMPLETE",
      "eastmoney market sweep returned fewer records than the A-share universe",
      { count: computedRecords.length, missingYtd }
    );
  }
  // 年内新股不具备完整 YTD，不进入覆盖率分母。
  const expectedUniverseCount = computedRecords.filter(
    (record) => !record.ineligibilityReason
  ).length;

  const recordsBySymbol = new Map(computedRecords.map((record) => [record.symbol, record]));
  const sentinel = await runSentinelGate(recordsBySymbol, dates, options);

  const indexRows = await fetchCsi300Rows(dates, options);
  const timestamp = options.publishedAt || now.toISOString();
  const snapshot = buildStockSnapshot({
    asOf: dates.expectedAsOf,
    expectedAsOf: dates.expectedAsOf,
    baseDate: dates.baseDate,
    expectedBaseDate: dates.baseDate,
    computedRecords,
    referenceRecords: [],
    expectedUniverseCount,
    minCoverageRatio: 0.998,
    generatedAt: timestamp,
    publishedAt: timestamp,
    methodologyVersion: METHODOLOGY_VERSION,
    poolVersion: POOL_VERSION,
    requireAdjustmentAudit: false
  });
  const candidate = {
    ...snapshot,
    dataMode: "published",
    dataWarning: null,
    benchmark: buildCsi300Benchmark(indexRows, {
      baseDate: dates.baseDate,
      asOf: dates.expectedAsOf,
      source: "tencent"
    })
  };
  assertBenchmarkPublishable(candidate.benchmark, candidate);
  assertSnapshotPublishable(candidate);
  return {
    candidate,
    tradingCalendar,
    dates,
    sentinel,
    stats: {
      marketRows: rows.length,
      computedRecords: computedRecords.length,
      missingYtd
    }
  };
}

module.exports = {
  METHODOLOGY_VERSION,
  POOL_VERSION,
  EASTMONEY_MARKET_URLS,
  SENTINEL_TOLERANCE_BP,
  DEFAULT_SENTINEL_SYMBOLS,
  tencentSymbol,
  normalizeEastmoneyListingDate,
  boardForCode,
  buildComputedRecords,
  fetchMarketRows,
  parseTencentIndexRows,
  fetchCsi300Rows,
  runSentinelGate,
  buildEmSnapshot
};
