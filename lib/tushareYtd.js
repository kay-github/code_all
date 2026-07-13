"use strict";

const { callTushare } = require("./stockSources");
const { calculateAdjustedYtd } = require("./stockYtd");
const { normalizeDate } = require("./stockSnapshot");

function toTushareDate(value) {
  return normalizeDate(value).replace(/-/g, "");
}

function normalizeTsCode(value) {
  const text = String(value == null ? "" : value).trim().toUpperCase();
  const match = text.match(/^(\d{6})\.(SH|SZ|BJ|BSE)$/);
  if (!match) {
    throw new TypeError("invalid Tushare ts_code: " + text);
  }
  const suffix = match[2] === "BSE" ? "BJ" : match[2];
  return match[1] + "." + suffix;
}

function exchangeFromSymbol(symbol) {
  if (symbol.endsWith(".SH")) return "SH";
  if (symbol.endsWith(".SZ")) return "SZ";
  if (symbol.endsWith(".BJ")) return "BJ";
  return null;
}

function normalizeTushareExchange(value) {
  const normalized = String(value == null ? "" : value).trim().toUpperCase();
  if (["SSE", "SH"].includes(normalized)) return "SH";
  if (["SZSE", "SZ"].includes(normalized)) return "SZ";
  if (["BSE", "BJ"].includes(normalized)) return "BJ";
  return null;
}

function readTushareMasterData(stock, symbol) {
  const exchange = normalizeTushareExchange(stock.exchange);
  const symbolExchange = exchangeFromSymbol(symbol);
  const currency = String(stock.curr_type == null ? "" : stock.curr_type)
    .trim()
    .toUpperCase();
  const market = String(stock.market == null ? "" : stock.market).trim();

  if (!exchange || !currency || !market || exchange !== symbolExchange) {
    return {
      exchange,
      securityType: null,
      ineligibilityReason: "DATA_QUALITY_REJECTED"
    };
  }
  if (currency !== "CNY" || /CDR|存托凭证/i.test(market)) {
    return {
      exchange,
      securityType: "UNSUPPORTED_SECURITY",
      ineligibilityReason: "NOT_ELIGIBLE_SECURITY"
    };
  }
  return {
    exchange,
    securityType: "A_SHARE",
    ineligibilityReason: null
  };
}

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function indexFactors(rows) {
  const factors = new Map();
  for (const row of rows || []) {
    const symbol = normalizeTsCode(row.ts_code);
    const date = normalizeDate(row.trade_date);
    const key = symbol + "|" + date;
    if (factors.has(key)) {
      throw new RangeError("duplicate Tushare adjustment factor: " + key);
    }
    factors.set(key, finitePositive(row.adj_factor));
  }
  return factors;
}

function indexDailyBars(rows) {
  const bySymbol = new Map();
  const keys = new Set();
  for (const row of rows || []) {
    const symbol = normalizeTsCode(row.ts_code);
    const date = normalizeDate(row.trade_date);
    const key = symbol + "|" + date;
    if (keys.has(key)) {
      throw new RangeError("duplicate Tushare daily bar: " + key);
    }
    keys.add(key);
    const records = bySymbol.get(symbol) || [];
    records.push({
      symbol,
      date,
      close: finitePositive(row.close)
    });
    bySymbol.set(symbol, records);
  }
  for (const records of bySymbol.values()) {
    records.sort((left, right) => left.date.localeCompare(right.date));
  }
  return bySymbol;
}

function lastBarOnOrBefore(records, date) {
  let result = null;
  for (const record of records || []) {
    if (record.date > date) break;
    if (record.close != null) result = record;
  }
  return result;
}

function normalizeListingStatus(value) {
  return String(value == null ? "" : value).trim().toUpperCase() === "L"
    ? "LISTED"
    : String(value == null ? "" : value).trim().toUpperCase();
}

function baseComputedRecord(stock, symbol, baseDate, asOf) {
  const master = readTushareMasterData(stock, symbol);
  return {
    symbol,
    code: symbol.slice(0, 6),
    name: stock.name || "",
    exchange: master.exchange,
    board: stock.market || null,
    securityType: master.securityType,
    listingStatus: normalizeListingStatus(stock.list_status),
    listingDate: stock.list_date ? normalizeDate(stock.list_date) : null,
    computedYtd: null,
    basePriceDate: null,
    lastPriceDate: null,
    baseRawClose: null,
    baseAdjFactor: null,
    baseAdjFactorDate: null,
    lastRawClose: null,
    lastAdjFactor: null,
    lastAdjFactorDate: null,
    source: "tushare",
    sourceAsOf: asOf,
    baseDate,
    ineligibilityReason: master.ineligibilityReason
  };
}

function buildTushareComputedRecords(input = {}) {
  const baseDate = normalizeDate(input.baseDate, "baseDate");
  const asOf = normalizeDate(input.asOf, "asOf");
  if (baseDate >= asOf) {
    throw new RangeError("baseDate must be earlier than asOf");
  }
  if (!Array.isArray(input.stocks)) {
    throw new TypeError("stocks must be an array");
  }

  const barsBySymbol = indexDailyBars(input.dailyBars || []);
  const factors = indexFactors(input.adjFactors || []);
  const seen = new Set();

  return input.stocks.map((stock, index) => {
    if (!stock || typeof stock !== "object") {
      throw new TypeError("stocks[" + index + "] must be an object");
    }
    const symbol = normalizeTsCode(stock.ts_code);
    if (seen.has(symbol)) {
      throw new RangeError("duplicate Tushare stock: " + symbol);
    }
    seen.add(symbol);

    const result = baseComputedRecord(stock, symbol, baseDate, asOf);
    if (result.ineligibilityReason) {
      return result;
    }
    if (result.listingDate && result.listingDate > baseDate) {
      result.ineligibilityReason = "NEW_LISTING";
      return result;
    }

    const bars = barsBySymbol.get(symbol) || [];
    const baseBar = lastBarOnOrBefore(bars, baseDate);
    const lastBar = lastBarOnOrBefore(bars, asOf);
    if (!baseBar) {
      result.ineligibilityReason = "MISSING_BASE_PRICE";
      return result;
    }
    if (!lastBar || lastBar.date < baseBar.date) {
      result.ineligibilityReason = "MISSING_CURRENT_PRICE";
      return result;
    }

    result.basePriceDate = baseBar.date;
    result.lastPriceDate = lastBar.date;
    result.baseRawClose = baseBar.close;
    result.lastRawClose = lastBar.close;
    result.baseAdjFactor = factors.get(symbol + "|" + baseBar.date) || null;
    result.lastAdjFactor = factors.get(symbol + "|" + lastBar.date) || null;
    result.baseAdjFactorDate = result.baseAdjFactor == null ? null : baseBar.date;
    result.lastAdjFactorDate = result.lastAdjFactor == null ? null : lastBar.date;
    if (result.baseAdjFactor == null || result.lastAdjFactor == null) {
      result.ineligibilityReason = "MISSING_ADJ_FACTOR";
      return result;
    }

    result.computedYtd = calculateAdjustedYtd({
      baseClose: result.baseRawClose,
      baseAdjFactor: result.baseAdjFactor,
      currentClose: result.lastRawClose,
      currentAdjFactor: result.lastAdjFactor
    });
    return result;
  });
}

function fetchTushareStockBasic(options = {}) {
  return callTushare(
    "stock_basic",
    { exchange: "", list_status: "L" },
    [
      "ts_code",
      "symbol",
      "name",
      "market",
      "exchange",
      "curr_type",
      "list_date",
      "list_status"
    ],
    options
  );
}

function fetchTushareTradeCalendar(startDate, endDate, options = {}) {
  return callTushare(
    "trade_cal",
    {
      exchange: "SSE",
      start_date: toTushareDate(startDate),
      end_date: toTushareDate(endDate),
      is_open: "1"
    },
    ["exchange", "cal_date", "is_open", "pretrade_date"],
    options
  );
}

function fetchTushareDaily(tradeDate, options = {}) {
  return callTushare(
    "daily",
    { trade_date: toTushareDate(tradeDate) },
    ["ts_code", "trade_date", "close"],
    options
  );
}

function fetchTushareDailyHistory(symbol, startDate, endDate, options = {}) {
  return callTushare(
    "daily",
    {
      ts_code: normalizeTsCode(symbol),
      start_date: toTushareDate(startDate),
      end_date: toTushareDate(endDate)
    },
    ["ts_code", "trade_date", "close"],
    options
  );
}

function fetchTushareAdjFactors(tradeDate, options = {}) {
  return callTushare(
    "adj_factor",
    { trade_date: toTushareDate(tradeDate) },
    ["ts_code", "trade_date", "adj_factor"],
    options
  );
}

function fetchTushareAdjFactorHistory(symbol, startDate, endDate, options = {}) {
  return callTushare(
    "adj_factor",
    {
      ts_code: normalizeTsCode(symbol),
      start_date: toTushareDate(startDate),
      end_date: toTushareDate(endDate)
    },
    ["ts_code", "trade_date", "adj_factor"],
    options
  );
}

function fetchTushareIndexDaily(startDate, endDate, options = {}) {
  return callTushare(
    "index_daily",
    {
      ts_code: "000300.SH",
      start_date: toTushareDate(startDate),
      end_date: toTushareDate(endDate)
    },
    ["ts_code", "trade_date", "close"],
    options
  );
}

function dedupeTushareRows(rows, valueField) {
  const indexed = new Map();
  for (const row of rows || []) {
    const symbol = normalizeTsCode(row.ts_code);
    const date = normalizeDate(row.trade_date);
    const key = symbol + "|" + date;
    if (indexed.has(key)) {
      const previous = indexed.get(key);
      if (Number(previous[valueField]) !== Number(row[valueField])) {
        const error = new Error("conflicting Tushare rows: " + key);
        error.code = "TUSHARE_CONFLICTING_ROWS";
        throw error;
      }
      continue;
    }
    indexed.set(key, { ...row, ts_code: symbol, trade_date: date });
  }
  return [...indexed.values()];
}

async function mapWithConcurrency(items, concurrency, worker) {
  const limit = Math.max(1, Math.floor(Number(concurrency) || 1));
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => runWorker())
  );
  return results;
}

function currentlyListedStocks(stocks) {
  if (!Array.isArray(stocks)) {
    throw new TypeError("stocks must be an array");
  }

  const seen = new Set();
  return stocks.filter((stock, index) => {
    if (!stock || typeof stock !== "object") {
      throw new TypeError("stocks[" + index + "] must be an object");
    }
    if (String(stock.list_status || "").toUpperCase() !== "L") return false;

    const symbol = normalizeTsCode(stock.ts_code);
    if (seen.has(symbol)) {
      throw new RangeError("duplicate Tushare stock: " + symbol);
    }
    seen.add(symbol);
    if (readTushareMasterData(stock, symbol).ineligibilityReason === "NOT_ELIGIBLE_SECURITY") {
      return false;
    }
    return true;
  });
}

function comparableStocks(stocks, baseDate) {
  return stocks.filter((stock) => {
    if (!stock.list_date) return false;
    return normalizeDate(stock.list_date) <= baseDate;
  });
}

async function backfillTushareEndpoint(input) {
  const endpointDate = normalizeDate(input.endpointDate, "endpointDate");
  const lookbackStartDate = normalizeDate(input.lookbackStartDate, "lookbackStartDate");
  const stocks = input.stocks || [];
  const exactDailyRows = dedupeTushareRows(input.exactDailyRows || [], "close");
  const exactFactorRows = dedupeTushareRows(input.exactFactorRows || [], "adj_factor");
  const requiredSymbols = stocks.map((stock) => normalizeTsCode(stock.ts_code));
  const requiredSet = new Set(requiredSymbols);
  const invalidDailyRows = exactDailyRows.filter((row) =>
    requiredSet.has(normalizeTsCode(row.ts_code)) &&
    (normalizeDate(row.trade_date) !== endpointDate || finitePositive(row.close) == null)
  );
  const invalidFactorRows = exactFactorRows.filter((row) =>
    requiredSet.has(normalizeTsCode(row.ts_code)) &&
    (normalizeDate(row.trade_date) !== endpointDate || finitePositive(row.adj_factor) == null)
  );
  if (invalidDailyRows.length || invalidFactorRows.length) {
    const error = new Error("Tushare returned an invalid endpoint row");
    error.code = "TUSHARE_INVALID_ENDPOINT_ROW";
    error.details = {
      endpointDate,
      invalidDailyRows: invalidDailyRows.length,
      invalidFactorRows: invalidFactorRows.length
    };
    throw error;
  }

  const dailyKeys = new Set(exactDailyRows
    .filter((row) => finitePositive(row.close) != null)
    .map((row) => normalizeTsCode(row.ts_code) + "|" + normalizeDate(row.trade_date)));
  const factorKeys = new Set(exactFactorRows
    .filter((row) => finitePositive(row.adj_factor) != null)
    .map((row) => normalizeTsCode(row.ts_code) + "|" + normalizeDate(row.trade_date)));
  const missingSymbols = requiredSymbols
    .filter((symbol) => {
      const key = symbol + "|" + endpointDate;
      return !dailyKeys.has(key) || !factorKeys.has(key);
    });
  const maxBackfillSymbols = input.maxBackfillSymbols == null
    ? 500
    : Math.max(0, Math.floor(Number(input.maxBackfillSymbols)));
  if (missingSymbols.length > maxBackfillSymbols) {
    const error = new Error("Tushare backfill symbol limit exceeded");
    error.code = "TUSHARE_BACKFILL_LIMIT_EXCEEDED";
    error.details = {
      endpointDate,
      missingCount: missingSymbols.length,
      maxBackfillSymbols
    };
    throw error;
  }

  const clients = input.clients || {};
  const fetchDailyHistory = clients.fetchTushareDailyHistory || fetchTushareDailyHistory;
  const fetchFactorHistory =
    clients.fetchTushareAdjFactorHistory || fetchTushareAdjFactorHistory;
  const sourceOptions = input.sourceOptions || {};
  const histories = await mapWithConcurrency(
    missingSymbols,
    input.concurrency == null ? 4 : input.concurrency,
    async (symbol) => {
      const [dailyResult, factorResult] = await Promise.all([
        fetchDailyHistory(symbol, lookbackStartDate, endpointDate, sourceOptions),
        fetchFactorHistory(symbol, lookbackStartDate, endpointDate, sourceOptions)
      ]);
      return {
        symbol,
        dailyRows: dailyResult.rows,
        factorRows: factorResult.rows
      };
    }
  );

  return {
    endpointDate,
    missingSymbols,
    dailyRows: dedupeTushareRows(
      exactDailyRows.concat(histories.flatMap((item) => item.dailyRows)),
      "close"
    ),
    adjFactorRows: dedupeTushareRows(
      exactFactorRows.concat(histories.flatMap((item) => item.factorRows)),
      "adj_factor"
    )
  };
}

async function fetchTushareYtdDataset(input = {}) {
  const baseDate = normalizeDate(input.baseDate, "baseDate");
  const asOf = normalizeDate(input.asOf, "asOf");
  const stocks = currentlyListedStocks(input.stocks || []);
  const endpointStocks = comparableStocks(stocks, baseDate).filter(
    (stock) => !readTushareMasterData(stock, normalizeTsCode(stock.ts_code)).ineligibilityReason
  );
  const expectedUniverseCount = stocks.filter(
    (stock) => !stock.list_date || normalizeDate(stock.list_date) <= baseDate
  ).length;
  const clients = input.clients || {};
  const daily = clients.fetchTushareDaily || fetchTushareDaily;
  const factors = clients.fetchTushareAdjFactors || fetchTushareAdjFactors;
  const sourceOptions = input.sourceOptions || {};
  const lookbackStartDate = input.lookbackStartDate || endpointStocks
    .map((stock) => normalizeDate(stock.list_date))
    .sort()[0] || baseDate;
  const [baseDaily, baseFactors, currentDaily, currentFactors] = await Promise.all([
    daily(baseDate, sourceOptions),
    factors(baseDate, sourceOptions),
    daily(asOf, sourceOptions),
    factors(asOf, sourceOptions)
  ]);
  const common = {
    stocks: endpointStocks,
    lookbackStartDate,
    maxBackfillSymbols: input.maxBackfillSymbols,
    concurrency: input.concurrency,
    clients,
    sourceOptions
  };
  // Run endpoint backfills sequentially so the configured per-endpoint
  // concurrency remains the actual upstream request bound.
  const baseEndpoint = await backfillTushareEndpoint({
    ...common,
    endpointDate: baseDate,
    exactDailyRows: baseDaily.rows,
    exactFactorRows: baseFactors.rows
  });
  const currentEndpoint = await backfillTushareEndpoint({
    ...common,
    endpointDate: asOf,
    exactDailyRows: currentDaily.rows,
    exactFactorRows: currentFactors.rows
  });

  return {
    baseDate,
    asOf,
    stocks,
    expectedUniverseCount,
    dailyBars: dedupeTushareRows(
      baseEndpoint.dailyRows.concat(currentEndpoint.dailyRows),
      "close"
    ),
    adjFactors: dedupeTushareRows(
      baseEndpoint.adjFactorRows.concat(currentEndpoint.adjFactorRows),
      "adj_factor"
    ),
    backfill: {
      baseMissingSymbols: baseEndpoint.missingSymbols,
      currentMissingSymbols: currentEndpoint.missingSymbols
    }
  };
}

module.exports = {
  toTushareDate,
  normalizeTsCode,
  buildTushareComputedRecords,
  fetchTushareStockBasic,
  fetchTushareTradeCalendar,
  fetchTushareDaily,
  fetchTushareDailyHistory,
  fetchTushareAdjFactors,
  fetchTushareAdjFactorHistory,
  fetchTushareIndexDaily,
  dedupeTushareRows,
  backfillTushareEndpoint,
  fetchTushareYtdDataset
};
