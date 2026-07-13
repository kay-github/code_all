"use strict";

const path = require("path");
const { fetchEastmoneyMarket } = require("./stockSources");
const {
  buildTushareComputedRecords,
  fetchTushareIndexDaily,
  fetchTushareStockBasic,
  fetchTushareTradeCalendar,
  fetchTushareYtdDataset
} = require("./tushareYtd");
const {
  buildStockSnapshot,
  assertSnapshotPublishable
} = require("./stockSnapshot");
const {
  buildCsi300Benchmark,
  assertBenchmarkPublishable
} = require("./stockBenchmark");
const {
  addCalendarDays,
  createTradingCalendar,
  deriveExpectedDatesFromCalendar,
  shanghaiDateParts,
  validateTradingCalendar
} = require("./stockTradingDates");
const { createStockSnapshotFileStore } = require("./stockSnapshotFileStore");

function workerError(code, message, cause, details = null) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  if (details) error.details = details;
  return error;
}

function errorCode(error) {
  return error && error.code ? String(error.code) : "UNKNOWN_ERROR";
}

function filterEastmoneyReferences(rows, computedRecords) {
  if (!Array.isArray(rows)) {
    throw new TypeError("Eastmoney rows must be an array");
  }
  const allowed = new Set(computedRecords.map((record) => record.symbol));
  const seen = new Set();
  const references = [];
  for (const row of rows) {
    if (!row || !allowed.has(row.symbol)) continue;
    if (seen.has(row.symbol)) {
      throw workerError(
        "EASTMONEY_DUPLICATE_REFERENCE",
        "Eastmoney returned a duplicate reference symbol"
      );
    }
    seen.add(row.symbol);
    references.push({
      symbol: row.symbol,
      code: row.code,
      name: row.name,
      exchange: row.exchange,
      referenceYtd: row.ytd,
      source: "eastmoney",
      sourceAsOf: row.sourceAsOf
    });
  }
  return references;
}

function buildCandidate(input) {
  const benchmark = buildCsi300Benchmark(input.indexRows, {
    baseDate: input.baseDate,
    asOf: input.asOf
  });
  const snapshot = buildStockSnapshot({
    asOf: input.asOf,
    expectedAsOf: input.asOf,
    baseDate: input.baseDate,
    expectedBaseDate: input.baseDate,
    computedRecords: input.computedRecords,
    referenceRecords: input.referenceRecords,
    expectedUniverseCount: input.expectedUniverseCount,
    minCoverageRatio: 0.998,
    generatedAt: input.generatedAt,
    publishedAt: input.publishedAt,
    methodologyVersion: "adjusted-ytd.v1",
    poolVersion: "a-share.v1"
  });
  const candidate = {
    ...snapshot,
    dataMode: "published",
    dataWarning: input.dataWarning || null,
    benchmark
  };
  assertBenchmarkPublishable(candidate.benchmark, candidate);
  assertSnapshotPublishable(candidate);
  return candidate;
}

function defaultStoreDirectory(env) {
  return path.resolve(env.STOCK_SNAPSHOT_DIR || ".stock-ytd-data");
}

async function runStockDailyWorker(options = {}) {
  const env = options.env || process.env;
  const directory = path.resolve(options.directory || defaultStoreDirectory(env));
  const storage = options.storage || createStockSnapshotFileStore(directory);
  for (const method of [
    "loadCurrentEnvelope",
    "markServingPrevious",
    "publishSnapshot",
    "withRefreshLock"
  ]) {
    if (!storage || typeof storage[method] !== "function") {
      throw new TypeError(`stock snapshot storage must implement ${method}()`);
    }
  }
  const clients = options.clients || {};
  const nowValue = options.now == null ? Date.now() : options.now;
  const now = options.now instanceof Date ? options.now : new Date(nowValue);
  if (Number.isNaN(now.getTime())) {
    throw new TypeError("worker now must be a valid date");
  }
  const sourceOptions = {
    env,
    retries: 2,
    timeoutMs: 10000,
    ...(options.sourceOptions || {})
  };

  const tradeCalendar = clients.fetchTushareTradeCalendar || fetchTushareTradeCalendar;
  const stockBasic = clients.fetchTushareStockBasic || fetchTushareStockBasic;
  const ytdDataset = clients.fetchTushareYtdDataset || fetchTushareYtdDataset;
  const indexDaily = clients.fetchTushareIndexDaily || fetchTushareIndexDaily;
  const eastmoneyMarket = clients.fetchEastmoneyMarket || fetchEastmoneyMarket;
  let expectedAsOf = null;

  return storage.withRefreshLock(async () => {
    try {
      const nowParts = shanghaiDateParts(now);
      const calendarStart = String(Number(nowParts.year) - 1) + "-12-01";
      const today = nowParts.year + "-" + nowParts.month + "-" + nowParts.day;
      const configuredHorizon = Number(
        options.calendarHorizonDays == null
          ? env.STOCK_TRADING_CALENDAR_HORIZON_DAYS
          : options.calendarHorizonDays
      );
      const calendarHorizonDays = Number.isInteger(configuredHorizon) &&
        configuredHorizon >= 7 && configuredHorizon <= 370
        ? configuredHorizon
        : 45;
      const calendarEnd = addCalendarDays(today, calendarHorizonDays);
      let previous = null;
      try {
        previous = await storage.loadCurrentEnvelope();
      } catch (error) {
        if (error.code !== "STOCK_SNAPSHOT_CURRENT_INVALID") throw error;
      }

      let tradingCalendar;
      let calendarFailureCode = null;
      try {
        const calendarResult = await tradeCalendar(
          calendarStart,
          calendarEnd,
          sourceOptions
        );
        tradingCalendar = createTradingCalendar(calendarResult.rows, {
          coveredFrom: calendarStart,
          coveredThrough: calendarEnd
        });
      } catch (error) {
        calendarFailureCode = errorCode(error);
        if (!previous || !previous.tradingCalendar) throw error;
        tradingCalendar = validateTradingCalendar(previous.tradingCalendar);
      }
      const dates = deriveExpectedDatesFromCalendar(tradingCalendar, nowParts);
      expectedAsOf = dates.expectedAsOf;

      if (previous && previous.snapshot.asOf > dates.expectedAsOf) {
        throw workerError(
          "STOCK_SNAPSHOT_DATE_REGRESSION",
          "worker expectedAsOf is earlier than the current snapshot"
        );
      }
      if (
        previous &&
        previous.snapshot.asOf === dates.expectedAsOf &&
        previous.snapshot.baseDate === dates.baseDate &&
        options.force !== true
      ) {
        if (previous.refreshStatus !== "PUBLISHED") {
          await storage.publishSnapshot(previous.snapshot, {
            expectedAsOf: dates.expectedAsOf,
            refreshedAt: now.toISOString(),
            warningCodes: [
              ...(previous.warningCodes || []),
              calendarFailureCode
            ].filter(Boolean),
            tradingCalendar
          });
        }
        return {
          status: "no-op",
          snapshotId: previous.snapshotId,
          asOf: previous.snapshot.asOf,
          expectedAsOf: dates.expectedAsOf,
          sourceMode: previous.snapshot.sourceMode,
          calendarFailureCode
        };
      }

      const stockResult = await stockBasic(sourceOptions);
      const [dataset, indexResult] = await Promise.all([
        ytdDataset({
          baseDate: dates.baseDate,
          asOf: dates.expectedAsOf,
          stocks: stockResult.rows,
          maxBackfillSymbols: options.maxBackfillSymbols,
          concurrency: options.backfillConcurrency,
          clients,
          sourceOptions
        }),
        indexDaily(dates.baseDate, dates.expectedAsOf, sourceOptions)
      ]);
      const computedRecords = buildTushareComputedRecords({
        baseDate: dates.baseDate,
        asOf: dates.expectedAsOf,
        stocks: dataset.stocks,
        dailyBars: dataset.dailyBars,
        adjFactors: dataset.adjFactors
      });

      let referenceRecords = [];
      let referenceFailureCode = dates.ytdPeriodStarted
        ? null
        : "YTD_PERIOD_RESET";
      let eastmoneyRows = null;
      if (dates.ytdPeriodStarted) {
        try {
          eastmoneyRows = await eastmoneyMarket({
            retries: 2,
            timeoutMs: 8000
          });
        } catch (error) {
          referenceFailureCode = errorCode(error);
        }
      }
      if (eastmoneyRows) {
        referenceRecords = filterEastmoneyReferences(eastmoneyRows, computedRecords);
        if (referenceRecords.length === 0 && computedRecords.length > 0) {
          throw workerError(
            "EASTMONEY_REFERENCE_INTERSECTION_EMPTY",
            "Eastmoney succeeded but no reference symbols matched Tushare master data"
          );
        }
      }

      const timestamp = options.publishedAt || now.toISOString();
      const candidate = buildCandidate({
        asOf: dates.expectedAsOf,
        baseDate: dates.baseDate,
        computedRecords,
        referenceRecords,
        expectedUniverseCount: dataset.expectedUniverseCount,
        indexRows: indexResult.rows,
        generatedAt: timestamp,
        publishedAt: timestamp,
        dataWarning: dates.ytdPeriodStarted
          ? null
          : "新年度首个完整交易日尚未结束，当前年内收益按基准日重置为 0。"
      });
      const envelope = await storage.publishSnapshot(candidate, {
        expectedAsOf: dates.expectedAsOf,
        refreshedAt: timestamp,
        warningCodes: [referenceFailureCode, calendarFailureCode].filter(Boolean),
        tradingCalendar
      });
      return {
        status: "published",
        snapshotId: envelope.snapshotId,
        asOf: candidate.asOf,
        expectedAsOf: dates.expectedAsOf,
        sourceMode: candidate.sourceMode,
        coverageRatio: candidate.quality.coverage.ratio,
        referenceFailureCode,
        calendarFailureCode
      };
    } catch (error) {
      try {
        const previous = await storage.markServingPrevious(
          expectedAsOf,
          [errorCode(error)]
        );
        throw workerError(
          "STOCK_REFRESH_SERVING_PREVIOUS",
          "stock refresh failed; serving the previous snapshot",
          error,
          {
            causeCode: errorCode(error),
            snapshotId: previous.snapshotId,
            expectedAsOf: previous.expectedAsOf
          }
        );
      } catch (markError) {
        if (markError.code === "STOCK_REFRESH_SERVING_PREVIOUS") throw markError;
        throw workerError(
          "STOCK_REFRESH_FAILED",
          "stock refresh failed and no previous snapshot could be marked",
          error,
          {
            causeCode: errorCode(error),
            fallbackCode: errorCode(markError),
            expectedAsOf
          }
        );
      }
    }
  }, {
    staleAfterMs: options.lockStaleMs == null
      ? env.STOCK_REFRESH_LOCK_STALE_MS
      : options.lockStaleMs
  });
}

module.exports = {
  filterEastmoneyReferences,
  buildCandidate,
  runStockDailyWorker
};
