"use strict";

const {
  fetchEastmoneyMarket,
  fetchEastmoneyYtd,
  fetchTencentQfqKlines
} = require("../lib/stockSources");
const {
  fetchTushareStockBasic,
  fetchTushareTradeCalendar,
  fetchTushareIndexDaily,
  fetchTushareYtdDataset,
  buildTushareComputedRecords
} = require("../lib/tushareYtd");
const {
  calculateYtdFromAdjustedBars
} = require("../lib/stockYtd");
const { normalizeDate } = require("../lib/stockSnapshot");
const {
  shanghaiDateParts,
  deriveExpectedDates
} = require("../lib/stockTradingDates");

const WARNING_BP = 5;
const FAILURE_BP = 20;

function providerSymbols(symbol) {
  const normalized = String(symbol || "").trim().toUpperCase();
  const match = normalized.match(/^(\d{6})\.(SH|SZ|BJ)$/);
  if (!match) {
    throw new TypeError("symbol must look like 300502.SZ, 600519.SH or 920992.BJ");
  }

  const code = match[1];
  const exchange = match[2];
  return {
    canonical: normalized,
    eastmoney: (exchange === "SH" ? "1." : "0.") + code,
    tencent: exchange.toLowerCase() + code
  };
}

function lastOnOrBefore(bars, date) {
  return bars.filter((bar) => bar.date <= date).at(-1) || null;
}

function assessSymbol(reference, bars, dates) {
  if (!reference || reference.ytd == null || !reference.sourceAsOf) {
    throw new Error("Eastmoney reference YTD or source date is missing");
  }
  const base = lastOnOrBefore(bars, dates.baseDate || dates.baseCutoff);
  const current = bars.at(-1) || null;
  if (!base || !current || current.date <= (dates.baseDate || dates.baseCutoff)) {
    throw new Error("Tencent qfq bars do not cover both YTD endpoints");
  }
  if (current.date !== reference.sourceAsOf) {
    throw new Error("Eastmoney and Tencent source dates do not match");
  }
  if (dates.expectedAsOf && current.date !== dates.expectedAsOf) {
    throw new Error("source date does not match expectedAsOf");
  }

  const ytd = calculateYtdFromAdjustedBars(base, current);
  const deviationBp = Math.abs(reference.ytd - ytd) * 10000;
  return {
    baseDate: base.date,
    baseAdjustedClose: base.close,
    currentDate: current.date,
    currentAdjustedClose: current.close,
    ytd,
    ytdPercent: ytd * 100,
    deviationBp,
    status: deviationBp > FAILURE_BP
      ? "FAIL"
      : deviationBp > WARNING_BP
        ? "WARN"
        : "PASS"
  };
}

async function checkSymbol(symbol, dates, clients = {}) {
  const ids = providerSymbols(symbol);
  const fetchReference = clients.fetchEastmoneyYtd || fetchEastmoneyYtd;
  const fetchAdjustedBars = clients.fetchTencentQfqKlines || fetchTencentQfqKlines;
  const reference = await fetchReference(ids.eastmoney, {
    retries: 2,
    timeoutMs: 8000
  });

  let tencent;
  try {
    const bars = await fetchAdjustedBars(ids.tencent, {
      startDate: dates.startDate,
      endDate: dates.today,
      count: 640,
      retries: 2,
      timeoutMs: 8000
    });
    tencent = assessSymbol(reference, bars, dates);
  } catch (error) {
    const unavailableCodes = new Set(["NETWORK_ERROR", "TIMEOUT", "RATE_LIMITED"]);
    tencent = {
      status: unavailableCodes.has(error.code) ? "UNAVAILABLE" : "FAIL",
      error: error.code || error.message
    };
  }

  return {
    symbol: ids.canonical,
    eastmoney: reference && {
      ytd: reference.ytd,
      ytdPercent: reference.ytdPercent,
      listingDate: reference.listingDate,
      sourceAsOf: reference.sourceAsOf,
      updatedAt: reference.updatedAt
    },
    tencent
  };
}

function assessMarketRows(rows, options = {}) {
  const minRows = options.minRows == null ? 5000 : Number(options.minRows);
  const minBseRows = options.minBseRows == null ? 100 : Number(options.minBseRows);
  const uniqueSymbols = new Set(rows.map((row) => row.symbol));
  const missingYtd = rows.filter((row) => row.ytd == null).length;
  const unknownExchange = rows.filter(
    (row) => !["SH", "SZ", "BJ"].includes(row.exchange)
  ).length;
  const byExchange = rows.reduce((counts, row) => {
    const key = row.exchange || "UNKNOWN";
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
  const maximumMissingYtd = Math.max(20, Math.floor(rows.length * 0.005));
  const duplicateCount = rows.length - uniqueSymbols.size;
  const failures = [];
  if (rows.length < minRows) failures.push("ROW_COUNT_TOO_LOW");
  if (duplicateCount > 0) failures.push("DUPLICATE_SYMBOLS");
  if (unknownExchange > 0) failures.push("UNKNOWN_EXCHANGE");
  if (missingYtd > maximumMissingYtd) failures.push("MISSING_YTD_TOO_HIGH");
  if ((byExchange.SH || 0) === 0 || (byExchange.SZ || 0) === 0) {
    failures.push("SH_SZ_COVERAGE_MISSING");
  }
  if ((byExchange.BJ || 0) < minBseRows) failures.push("BSE_COVERAGE_TOO_LOW");

  return {
    status: failures.length ? "FAIL" : "PASS",
    failures,
    rows: rows.length,
    uniqueSymbols: uniqueSymbols.size,
    duplicateCount,
    missingYtd,
    maximumMissingYtd,
    unknownExchange,
    byExchange
  };
}

async function checkMarket(clients = {}) {
  const fetchMarket = clients.fetchEastmoneyMarket || fetchEastmoneyMarket;
  const startedAt = Date.now();
  const rows = await fetchMarket({
    retries: 2,
    timeoutMs: 8000
  });
  return {
    ...assessMarketRows(rows),
    elapsedMs: Date.now() - startedAt
  };
}

function findRow(rows, symbol, date) {
  return rows.find(
    (row) => String(row.ts_code).toUpperCase() === symbol &&
      normalizeDate(row.trade_date) === date
  ) || null;
}

function tushareExchange(value) {
  const exchange = String(value || "").trim().toUpperCase();
  if (exchange === "SSE" || exchange === "SH") return "SH";
  if (exchange === "SZSE" || exchange === "SZ") return "SZ";
  if (exchange === "BSE" || exchange === "BJ") return "BSE";
  return "UNKNOWN";
}

function countTushareExchanges(rows, predicate = () => true) {
  return (rows || []).reduce((counts, row) => {
    if (!predicate(row)) return counts;
    const exchange = tushareExchange(row.exchange);
    counts[exchange] = (counts[exchange] || 0) + 1;
    return counts;
  }, { SH: 0, SZ: 0, BSE: 0, UNKNOWN: 0 });
}

async function checkTushare(options = {}) {
  const env = options.env || process.env;
  if (!env.TUSHARE_TOKEN) {
    return {
      status: "UNAVAILABLE",
      error: "TUSHARE_TOKEN_NOT_CONFIGURED"
    };
  }

  const clients = options.clients || {};
  const stockBasic = clients.fetchTushareStockBasic || fetchTushareStockBasic;
  const tradeCalendar = clients.fetchTushareTradeCalendar || fetchTushareTradeCalendar;
  const indexDaily = clients.fetchTushareIndexDaily || fetchTushareIndexDaily;
  const ytdDataset = clients.fetchTushareYtdDataset || fetchTushareYtdDataset;
  const nowParts = options.nowParts || shanghaiDateParts();
  const startDate = String(Number(nowParts.year) - 1) + "-12-01";
  const today = nowParts.year + "-" + nowParts.month + "-" + nowParts.day;
  const sourceOptions = {
    env,
    retries: 1,
    timeoutMs: 10000,
    ...(options.sourceOptions || {})
  };

  try {
    const calendarResult = await tradeCalendar(startDate, today, sourceOptions);
    const dates = deriveExpectedDates(calendarResult.rows, nowParts);
    const stockResult = await stockBasic(sourceOptions);
    const [dataset, indexResult] = await Promise.all([
      ytdDataset({
        baseDate: dates.baseDate,
        asOf: dates.expectedAsOf,
        stocks: stockResult.rows,
        maxBackfillSymbols: options.maxBackfillSymbols == null
          ? 200
          : options.maxBackfillSymbols,
        concurrency: options.backfillConcurrency == null
          ? 4
          : options.backfillConcurrency,
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

    const minStockCount = options.minStockCount == null ? 5000 : options.minStockCount;
    const stockBasicByExchange = countTushareExchanges(stockResult.rows);
    const masterByExchange = countTushareExchanges(computedRecords);
    const expectedUniverseByExchange = countTushareExchanges(
      computedRecords,
      (row) => !row.listingDate || row.listingDate <= dates.baseDate
    );
    const eligibleComputed = computedRecords.filter(
      (record) => record.computedYtd != null && !record.ineligibilityReason
    );
    const computedCoverage = dataset.expectedUniverseCount === 0
      ? 0
      : eligibleComputed.length / dataset.expectedUniverseCount;
    const failures = [];
    if (stockResult.rows.length < minStockCount) failures.push("STOCK_BASIC_COVERAGE_LOW");
    const minimumExchangeCounts = options.minimumExchangeCounts ||
      (minStockCount >= 5000 ? { SH: 2000, SZ: 2500, BSE: 100 } : null);
    if (minimumExchangeCounts) {
      for (const exchange of ["SH", "SZ", "BSE"]) {
        if (masterByExchange[exchange] < minimumExchangeCounts[exchange]) {
          failures.push(`MASTER_${exchange}_COVERAGE_LOW`);
        }
      }
      if (masterByExchange.UNKNOWN > 0) {
        failures.push("MASTER_UNKNOWN_EXCHANGE");
      }
    }
    if (computedCoverage < 0.998) failures.push("COMPUTED_YTD_COVERAGE_LOW");

    const sentinel = "300502.SZ";
    const sentinelRecord = computedRecords.find((record) => record.symbol === sentinel);
    if (!sentinelRecord || sentinelRecord.computedYtd == null) {
      failures.push("SENTINEL_YTD_INPUT_MISSING");
    }

    const indexBase = findRow(indexResult.rows, "000300.SH", dates.baseDate);
    const indexCurrent = findRow(indexResult.rows, "000300.SH", dates.expectedAsOf);
    if (!indexBase || !indexCurrent) failures.push("CSI300_ENDPOINT_MISSING");

    const sentinelYtd = sentinelRecord ? sentinelRecord.computedYtd : null;
    const benchmarkYtd = indexBase && indexCurrent
      ? Number(indexCurrent.close) / Number(indexBase.close) - 1
      : null;

    return {
      status: failures.length ? "FAIL" : "PASS",
      failures,
      expectedAsOf: dates.expectedAsOf,
      baseDate: dates.baseDate,
      counts: {
        stockBasic: stockResult.rows.length,
        masterRecords: computedRecords.length,
        expectedUniverse: dataset.expectedUniverseCount,
        eligibleComputed: eligibleComputed.length,
        computedCoverage,
        newListings: computedRecords.filter(
          (record) => record.ineligibilityReason === "NEW_LISTING"
        ).length,
        baseBackfill: dataset.backfill.baseMissingSymbols.length,
        currentBackfill: dataset.backfill.currentMissingSymbols.length,
        stockBasicByExchange,
        masterByExchange,
        expectedUniverseByExchange
      },
      sentinelYtd,
      benchmarkYtd
    };
  } catch (error) {
    return {
      status: "UNAVAILABLE",
      error: error.code || error.message
    };
  }
}

function reportHasFailures(report, options = {}) {
  if (report.symbols.some((result) => result.tencent.status !== "PASS")) return true;
  if (report.market && report.market.status !== "PASS") return true;
  if (
    report.tushare.status !== "PASS" &&
    !(options.allowMissingTushare && report.tushare.status === "UNAVAILABLE")
  ) {
    return true;
  }
  return false;
}

async function main() {
  const args = process.argv.slice(2);
  const includeMarket = args.includes("--market");
  const allowMissingTushare = args.includes("--allow-missing-tushare");
  const requestedSymbols = args.filter((value) => !value.startsWith("--"));
  const symbols = requestedSymbols.length
    ? requestedSymbols
    : ["300502.SZ", "600519.SH"];
  const dateParts = shanghaiDateParts();
  const year = Number(dateParts.year);
  const today = dateParts.year + "-" + dateParts.month + "-" + dateParts.day;
  const tushare = await checkTushare({ nowParts: dateParts });
  const dates = {
    today,
    startDate: String(year - 1) + "-12-01",
    baseCutoff: String(year - 1) + "-12-31",
    baseDate: tushare.baseDate || null,
    expectedAsOf: tushare.expectedAsOf || null
  };

  const results = [];
  for (const symbol of symbols) {
    results.push(await checkSymbol(symbol, dates));
  }

  const report = {
    checkedAt: new Date().toISOString(),
    dates,
    thresholdsBp: {
      warning: WARNING_BP,
      failure: FAILURE_BP
    },
    tushare,
    symbols: results,
    market: includeMarket ? await checkMarket() : null
  };
  console.log(JSON.stringify(report, null, 2));

  if (reportHasFailures(report, { allowMissingTushare })) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  shanghaiDateParts,
  providerSymbols,
  assessSymbol,
  checkSymbol,
  assessMarketRows,
  checkMarket,
  countTushareExchanges,
  deriveExpectedDates,
  checkTushare,
  reportHasFailures,
  main
};
