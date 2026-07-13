"use strict";

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 200;
const EASTMONEY_UT = "bd1d9ddb04089700cf9c27f6f7426281";

const ERROR_CODES = Object.freeze({
  CONFIG_ERROR: "CONFIG_ERROR",
  TIMEOUT: "TIMEOUT",
  NETWORK_ERROR: "NETWORK_ERROR",
  HTTP_ERROR: "HTTP_ERROR",
  RATE_LIMITED: "RATE_LIMITED",
  AUTH_ERROR: "AUTH_ERROR",
  INVALID_RESPONSE: "INVALID_RESPONSE",
  MISSING_FIELD: "MISSING_FIELD",
  PROVIDER_ERROR: "PROVIDER_ERROR"
});

class StockSourceError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "StockSourceError";
    this.code = code;
    this.source = options.source || "unknown";
    this.status = Number.isFinite(options.status) ? options.status : null;
    this.retryable = Boolean(options.retryable);
    this.attempts = Number.isFinite(options.attempts) ? options.attempts : 0;
    this.details = options.details || null;
    if (options.cause) {
      this.cause = options.cause;
    }
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toFiniteNonNegativeInteger(value, fallback, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.min(Math.floor(parsed), maximum);
}

function classifyHttpError(source, status) {
  if (status === 429) {
    return new StockSourceError(ERROR_CODES.RATE_LIMITED, `${source} request was rate limited`, {
      source,
      status,
      retryable: true
    });
  }

  if (status === 401 || status === 403) {
    return new StockSourceError(ERROR_CODES.AUTH_ERROR, `${source} authentication failed`, {
      source,
      status,
      retryable: false
    });
  }

  return new StockSourceError(ERROR_CODES.HTTP_ERROR, `${source} returned HTTP ${status}`, {
    source,
    status,
    retryable: status >= 500
  });
}

function normalizeRequestError(error, source) {
  if (error instanceof StockSourceError) {
    return error;
  }

  if (error && error.name === "AbortError") {
    return new StockSourceError(ERROR_CODES.TIMEOUT, `${source} request timed out`, {
      source,
      retryable: true,
      cause: error
    });
  }

  return new StockSourceError(ERROR_CODES.NETWORK_ERROR, `${source} network request failed`, {
    source,
    retryable: true,
    cause: error
  });
}

async function requestJsonAttempt(fetchImpl, url, requestOptions, timeoutMs, source, validateJson) {
  const controller = new AbortController();
  let timer;

  const timeoutPromise = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new StockSourceError(ERROR_CODES.TIMEOUT, `${source} request timed out`, {
        source,
        retryable: true
      }));
    }, timeoutMs);
  });

  const requestPromise = Promise.resolve().then(async () => {
    const response = await fetchImpl(url, {
      ...requestOptions,
      signal: controller.signal
    });

    if (!response || typeof response.json !== "function") {
      throw new StockSourceError(ERROR_CODES.INVALID_RESPONSE, `${source} returned a non-JSON response`, {
        source,
        retryable: true
      });
    }

    const status = Number(response.status) || 0;
    if (response.ok === false || status >= 400) {
      throw classifyHttpError(source, status || 500);
    }

    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      throw new StockSourceError(ERROR_CODES.INVALID_RESPONSE, `${source} returned invalid JSON`, {
        source,
        retryable: true,
        cause: error
      });
    }

    if (typeof validateJson === "function") {
      validateJson(payload);
    }
    return payload;
  });

  try {
    return await Promise.race([requestPromise, timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}

async function requestJson(url, options = {}) {
  const source = options.source || "unknown";
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const sleepImpl = options.sleepImpl || defaultSleep;
  const timeoutMs = Math.max(1, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const retries = toFiniteNonNegativeInteger(options.retries, DEFAULT_RETRIES, 5);
  const configuredRetryDelay = Number(options.retryDelayMs);
  const retryDelayMs = Math.max(
    0,
    Number.isFinite(configuredRetryDelay) ? configuredRetryDelay : DEFAULT_RETRY_DELAY_MS
  );

  if (typeof fetchImpl !== "function") {
    throw new StockSourceError(ERROR_CODES.CONFIG_ERROR, `${source} fetch implementation is unavailable`, {
      source,
      retryable: false
    });
  }

  if (typeof sleepImpl !== "function") {
    throw new StockSourceError(ERROR_CODES.CONFIG_ERROR, `${source} sleep implementation is invalid`, {
      source,
      retryable: false
    });
  }

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await requestJsonAttempt(
        fetchImpl,
        url,
        options.requestOptions || {},
        timeoutMs,
        source,
        options.validateJson
      );
    } catch (error) {
      lastError = normalizeRequestError(error, source);
      lastError.attempts = attempt + 1;
      if (!lastError.retryable || attempt === retries) {
        throw lastError;
      }
      await sleepImpl(retryDelayMs * (2 ** attempt));
    }
  }

  throw lastError;
}

function providerPayloadValidator(parser, userValidator) {
  return (payload) => {
    if (typeof userValidator === "function") {
      userValidator(payload);
    }
    try {
      parser(payload);
    } catch (error) {
      if (
        error instanceof StockSourceError &&
        [ERROR_CODES.INVALID_RESPONSE, ERROR_CODES.MISSING_FIELD].includes(error.code)
      ) {
        error.retryable = true;
      }
      throw error;
    }
  };
}

function parseEastmoneyPercent(value) {
  if (value === null || value === undefined || value === "" || value === "-") {
    return null;
  }

  const normalized = typeof value === "string"
    ? value.trim().replace(/%$/, "")
    : value;
  if (normalized === "" || normalized === "-") {
    return null;
  }

  const percent = Number(normalized);
  return Number.isFinite(percent) ? percent / 100 : null;
}

function normalizeStockCode(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const code = String(value).trim();
  return /^\d{1,6}$/.test(code) ? code.padStart(6, "0") : code;
}

function inferExchange(code, marketId) {
  if (marketId === 1) {
    return "SH";
  }

  if (marketId === 0 && /^[489]/.test(code)) {
    return "BJ";
  }

  if (marketId === 0) {
    return "SZ";
  }

  return null;
}

function eastmoneyTimestampToDate(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return null;
  }
  const milliseconds = timestamp > 1000000000000 ? timestamp : timestamp * 1000;
  const date = new Date(milliseconds + 8 * 60 * 60 * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function normalizeEastmoneyQuote(row, index = 0) {
  if (!row || typeof row !== "object") {
    throw new StockSourceError(ERROR_CODES.INVALID_RESPONSE, `eastmoney quote ${index} is invalid`, {
      source: "eastmoney",
      retryable: false
    });
  }

  const code = normalizeStockCode(row.f12);
  if (!code) {
    throw new StockSourceError(ERROR_CODES.MISSING_FIELD, `eastmoney quote ${index} is missing f12`, {
      source: "eastmoney",
      retryable: false,
      details: { index, field: "f12" }
    });
  }

  const marketNumber = Number(row.f13);
  const marketId = Number.isFinite(marketNumber) ? marketNumber : null;
  const exchange = inferExchange(code, marketId);
  const ytd = parseEastmoneyPercent(row.f25);

  return {
    source: "eastmoney",
    code,
    exchange,
    symbol: exchange ? code + "." + exchange : null,
    marketId,
    secid: marketId === null ? null : `${marketId}.${code}`,
    name: row.f14 === null || row.f14 === undefined ? "" : String(row.f14),
    ytd,
    ytdPercent: ytd === null ? null : ytd * 100,
    listingDate: row.f26 === null || row.f26 === undefined ? null : String(row.f26),
    updatedAt: Number.isFinite(Number(row.f124)) ? Number(row.f124) : null,
    sourceAsOf: eastmoneyTimestampToDate(row.f124),
    qualityFlags: ytd === null ? ["MISSING_YTD"] : []
  };
}

function readEastmoneyDiff(payload) {
  if (!payload || typeof payload !== "object" || !payload.data || typeof payload.data !== "object") {
    throw new StockSourceError(ERROR_CODES.MISSING_FIELD, "eastmoney response is missing data", {
      source: "eastmoney",
      retryable: false,
      details: { field: "data" }
    });
  }

  const diff = payload.data.diff;
  if (Array.isArray(diff)) {
    return diff;
  }

  if (diff && typeof diff === "object") {
    return Object.keys(diff)
      .filter((key) => /^\d+$/.test(key))
      .sort((left, right) => Number(left) - Number(right))
      .map((key) => diff[key]);
  }

  if ((diff === null || diff === undefined) && Number(payload.data.total) === 0) {
    return [];
  }

  throw new StockSourceError(ERROR_CODES.MISSING_FIELD, "eastmoney response is missing data.diff", {
    source: "eastmoney",
    retryable: false,
    details: { field: "data.diff" }
  });
}

function parseEastmoneyQuotes(payload) {
  return readEastmoneyDiff(payload).map((row, index) => normalizeEastmoneyQuote(row, index));
}

function appendSearchParams(baseUrl, params) {
  const url = new URL(baseUrl);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== null && value !== undefined && value !== "") {
      url.searchParams.set(key, String(value));
    }
  });
  return url.toString();
}

function normalizeSecids(secids) {
  const items = Array.isArray(secids) ? secids : [secids];
  const normalized = items
    .map((item) => item === null || item === undefined ? "" : String(item).trim())
    .filter(Boolean);
  if (normalized.length === 0) {
    throw new StockSourceError(ERROR_CODES.CONFIG_ERROR, "eastmoney secids must not be empty", {
      source: "eastmoney",
      retryable: false
    });
  }
  return normalized;
}

async function fetchEastmoneyYtd(secids, options = {}) {
  const single = !Array.isArray(secids);
  const normalizedSecids = normalizeSecids(secids);
  const url = appendSearchParams(
    options.baseUrl || "https://push2.eastmoney.com/api/qt/ulist.np/get",
    {
      secids: normalizedSecids.join(","),
      fields: options.fields || "f12,f13,f14,f25,f26,f124",
      fltt: 2,
      invt: 2,
      ut: options.ut || EASTMONEY_UT
    }
  );

  const payload = await requestJson(url, {
    ...options,
    source: "eastmoney",
    requestOptions: { ...(options.requestOptions || {}), method: "GET" },
    validateJson: providerPayloadValidator((value) => {
      const parsed = parseEastmoneyQuotes(value);
      const returned = new Set(parsed.map((item) => item.secid));
      for (const secid of normalizedSecids) {
        if (!returned.has(secid)) {
          throw new StockSourceError(
            ERROR_CODES.MISSING_FIELD,
            "eastmoney response is missing a requested security",
            {
              source: "eastmoney",
              retryable: true,
              details: { secid }
            }
          );
        }
      }
    }, options.validateJson)
  });
  const quotes = parseEastmoneyQuotes(payload);
  const bySecid = new Map(quotes.map((item) => [item.secid, item]));
  const ordered = normalizedSecids.map((secid) => bySecid.get(secid));
  return single ? ordered[0] : ordered;
}

async function fetchEastmoneyMarket(options = {}) {
  // The public endpoint currently caps each response at 100 rows. Keeping the
  // requested page size within that cap prevents page offsets from skipping
  // most of the market while still returning HTTP 200.
  const pageSize = Math.min(100, Math.max(1, Math.floor(Number(options.pageSize) || 100)));
  const maxPages = Math.max(1, Math.floor(Number(options.maxPages) || 100));
  const pageDelayMs = toFiniteNonNegativeInteger(options.pageDelayMs, 100, 10000);
  const sleepImpl = options.sleepImpl || defaultSleep;
  const baseUrl = options.baseUrl || "https://push2.eastmoney.com/api/qt/clist/get";
  const rows = [];
  const seenSecids = new Set();
  let expectedTotal = null;
  let lastCode = null;

  for (let page = 1; page <= maxPages; page += 1) {
    const url = appendSearchParams(baseUrl, {
      pn: page,
      pz: pageSize,
      po: 0,
      np: 1,
      fid: "f12",
      fs: options.fs || "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048",
      fields: options.fields || "f12,f13,f14,f25,f26,f124",
      fltt: 2,
      invt: 2,
      ut: options.ut || EASTMONEY_UT
    });

    let payload;
    try {
      payload = await requestJson(url, {
        ...options,
        source: "eastmoney",
        requestOptions: { ...(options.requestOptions || {}), method: "GET" },
        validateJson: providerPayloadValidator((value) => {
          const parsedRows = parseEastmoneyQuotes(value);
          const parsedTotal = Number(value.data && value.data.total);
          if (!Number.isInteger(parsedTotal) || parsedTotal < 0) {
            throw new StockSourceError(
              ERROR_CODES.MISSING_FIELD,
              "eastmoney market response is missing a valid total",
              { source: "eastmoney", retryable: true }
            );
          }
          if (expectedTotal !== null && parsedTotal !== expectedTotal) {
            throw new StockSourceError(
              ERROR_CODES.INVALID_RESPONSE,
              "eastmoney market total changed during pagination",
              {
                source: "eastmoney",
                retryable: true,
                details: { expectedTotal, actualTotal: parsedTotal, page }
              }
            );
          }
          if (parsedTotal > 0 && parsedRows.length === 0) {
            throw new StockSourceError(
              ERROR_CODES.INVALID_RESPONSE,
              "eastmoney market page is unexpectedly empty",
              {
                source: "eastmoney",
                retryable: true,
                details: { expectedTotal: parsedTotal, page }
              }
            );
          }
          const pageSeen = new Set();
          let pageLastCode = lastCode;
          for (const row of parsedRows) {
            if (!row.secid || pageSeen.has(row.secid) || seenSecids.has(row.secid)) {
              throw new StockSourceError(
                ERROR_CODES.INVALID_RESPONSE,
                "eastmoney market pagination returned a duplicate security",
                {
                  source: "eastmoney",
                  retryable: true,
                  details: { secid: row.secid, page }
                }
              );
            }
            if (pageLastCode && row.code < pageLastCode) {
              throw new StockSourceError(
                ERROR_CODES.INVALID_RESPONSE,
                "eastmoney market pagination is not ordered by code",
                {
                  source: "eastmoney",
                  retryable: true,
                  details: { previousCode: pageLastCode, code: row.code, page }
                }
              );
            }
            pageSeen.add(row.secid);
            pageLastCode = row.code;
          }
        }, options.validateJson)
      });
    } catch (error) {
      if (error instanceof StockSourceError) {
        error.details = {
          ...(error.details || {}),
          page,
          received: rows.length,
          expectedTotal
        };
      }
      throw error;
    }
    const pageRows = parseEastmoneyQuotes(payload);
    const total = Number(payload.data && payload.data.total);
    if (expectedTotal === null) {
      expectedTotal = total;
    }

    for (const row of pageRows) {
      seenSecids.add(row.secid);
      rows.push(row);
      lastCode = row.code;
    }
    if (rows.length > expectedTotal) {
      throw new StockSourceError(
        ERROR_CODES.INVALID_RESPONSE,
        "eastmoney pagination exceeded the initial total",
        {
          source: "eastmoney",
          retryable: false,
          details: { page, received: rows.length, expectedTotal }
        }
      );
    }
    if (rows.length === expectedTotal) {
      return rows;
    }

    if (pageRows.length === 0) {
      throw new StockSourceError(ERROR_CODES.INVALID_RESPONSE, "eastmoney pagination ended before total was reached", {
        source: "eastmoney",
        retryable: false,
        details: { page, received: rows.length, expectedTotal }
      });
    }

    if (pageDelayMs > 0) {
      await sleepImpl(pageDelayMs);
    }
  }

  throw new StockSourceError(ERROR_CODES.INVALID_RESPONSE, "eastmoney pagination exceeded maxPages", {
    source: "eastmoney",
    retryable: false,
    details: { maxPages, received: rows.length, expectedTotal }
  });
}

function normalizeProviderDate(value, source) {
  const text = String(value == null ? "" : value).trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    throw new StockSourceError(ERROR_CODES.INVALID_RESPONSE, source + " returned an invalid date", {
      source,
      retryable: true,
      details: { value }
    });
  }
  const checked = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (
    checked.getUTCFullYear() !== Number(match[1]) ||
    checked.getUTCMonth() !== Number(match[2]) - 1 ||
    checked.getUTCDate() !== Number(match[3])
  ) {
    throw new StockSourceError(ERROR_CODES.INVALID_RESPONSE, source + " returned an invalid date", {
      source,
      retryable: true,
      details: { value }
    });
  }
  return text;
}

function parseTencentNumber(value) {
  if (value === null || value === undefined || value === "" || value === "-") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseTencentQfqKlines(payload, symbol) {
  if (!payload || typeof payload !== "object") {
    throw new StockSourceError(ERROR_CODES.INVALID_RESPONSE, "tencent response is invalid", {
      source: "tencent",
      retryable: false
    });
  }

  if (Number(payload.code) !== 0) {
    throw new StockSourceError(ERROR_CODES.PROVIDER_ERROR, "tencent returned a provider error", {
      source: "tencent",
      retryable: false,
      details: { providerCode: payload.code, message: payload.msg || null }
    });
  }

  const data = payload.data;
  if (!data || typeof data !== "object") {
    throw new StockSourceError(ERROR_CODES.MISSING_FIELD, "tencent response is missing data", {
      source: "tencent",
      retryable: false,
      details: { field: "data" }
    });
  }

  const resolvedSymbol = symbol
    ? Object.prototype.hasOwnProperty.call(data, symbol)
      ? symbol
      : null
    : Object.keys(data).find((key) => data[key] && typeof data[key] === "object");
  const quoteData = resolvedSymbol ? data[resolvedSymbol] : null;
  if (!quoteData || !Array.isArray(quoteData.qfqday)) {
    throw new StockSourceError(ERROR_CODES.MISSING_FIELD, "tencent response is missing qfqday", {
      source: "tencent",
      retryable: false,
      details: { field: "data.<symbol>.qfqday", symbol: symbol || null }
    });
  }

  let previousDate = null;
  const seenDates = new Set();
  return quoteData.qfqday.map((row, index) => {
    if (!Array.isArray(row) || !row[0] || parseTencentNumber(row[2]) === null) {
      throw new StockSourceError(ERROR_CODES.MISSING_FIELD, `tencent qfqday row ${index} is incomplete`, {
        source: "tencent",
        retryable: false,
        details: { index }
      });
    }
    const date = normalizeProviderDate(row[0], "tencent");
    if (seenDates.has(date) || (previousDate && date <= previousDate)) {
      throw new StockSourceError(
        ERROR_CODES.INVALID_RESPONSE,
        "tencent qfqday dates must be unique and ascending",
        {
          source: "tencent",
          retryable: true,
          details: { index, date, previousDate }
        }
      );
    }
    seenDates.add(date);
    previousDate = date;
    return {
      source: "tencent",
      adjustment: "qfq",
      symbol: resolvedSymbol,
      date,
      open: parseTencentNumber(row[1]),
      close: parseTencentNumber(row[2]),
      high: parseTencentNumber(row[3]),
      low: parseTencentNumber(row[4]),
      volume: parseTencentNumber(row[5])
    };
  });
}

async function fetchTencentQfqKlines(symbol, options = {}) {
  if (!symbol || typeof symbol !== "string") {
    throw new StockSourceError(ERROR_CODES.CONFIG_ERROR, "tencent symbol is required", {
      source: "tencent",
      retryable: false
    });
  }

  const normalizedSymbol = symbol.trim();
  const startDate = options.startDate || "1990-01-01";
  const endDate = options.endDate || "2050-12-31";
  const count = Math.max(1, Math.floor(Number(options.count) || 640));
  const url = appendSearchParams(
    options.baseUrl || "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get",
    { param: `${normalizedSymbol},day,${startDate},${endDate},${count},qfq` }
  );
  const payload = await requestJson(url, {
    ...options,
    source: "tencent",
    requestOptions: { ...(options.requestOptions || {}), method: "GET" },
    validateJson: providerPayloadValidator(
      (value) => parseTencentQfqKlines(value, normalizedSymbol),
      options.validateJson
    )
  });
  return parseTencentQfqKlines(payload, normalizedSymbol);
}

function mapTushareRows(data) {
  if (!data || !Array.isArray(data.fields) || !Array.isArray(data.items)) {
    throw new StockSourceError(ERROR_CODES.MISSING_FIELD, "tushare response is missing fields or items", {
      source: "tushare",
      retryable: false,
      details: { field: "data.fields/data.items" }
    });
  }

  return data.items.map((item, rowIndex) => {
    if (!Array.isArray(item) || item.length < data.fields.length) {
      throw new StockSourceError(ERROR_CODES.MISSING_FIELD, `tushare row ${rowIndex} is incomplete`, {
        source: "tushare",
        retryable: false,
        details: { rowIndex }
      });
    }
    const row = {};
    data.fields.forEach((field, fieldIndex) => {
      row[field] = item[fieldIndex];
    });
    return row;
  });
}

function classifyTusharePayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw new StockSourceError(ERROR_CODES.INVALID_RESPONSE, "tushare response is invalid", {
      source: "tushare",
      retryable: true
    });
  }

  if (Number(payload.code) === 0) {
    return;
  }

  const message = String(payload.msg || "tushare provider error");
  if (/token|权限|认证|无权限/i.test(message)) {
    throw new StockSourceError(ERROR_CODES.AUTH_ERROR, "tushare authentication or permission failed", {
      source: "tushare",
      retryable: false,
      details: { providerCode: payload.code, message }
    });
  }

  if (/频率|每分钟|rate|too many/i.test(message)) {
    throw new StockSourceError(ERROR_CODES.RATE_LIMITED, "tushare request was rate limited", {
      source: "tushare",
      retryable: true,
      details: { providerCode: payload.code, message }
    });
  }

  throw new StockSourceError(ERROR_CODES.PROVIDER_ERROR, "tushare returned a provider error", {
    source: "tushare",
    retryable: false,
    details: { providerCode: payload.code, message }
  });
}

async function callTushare(apiName, params = {}, fields = [], options = {}) {
  if (!apiName || typeof apiName !== "string") {
    throw new StockSourceError(ERROR_CODES.CONFIG_ERROR, "tushare apiName is required", {
      source: "tushare",
      retryable: false
    });
  }

  const env = options.env || process.env;
  const token = env.TUSHARE_TOKEN;
  if (!token) {
    throw new StockSourceError(ERROR_CODES.CONFIG_ERROR, "TUSHARE_TOKEN is not configured", {
      source: "tushare",
      retryable: false
    });
  }

  const requestedFields = Array.isArray(fields) ? fields.join(",") : String(fields || "");
  const payload = await requestJson(options.baseUrl || "https://api.tushare.pro", {
    ...options,
    source: "tushare",
    requestOptions: {
      ...(options.requestOptions || {}),
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...((options.requestOptions && options.requestOptions.headers) || {})
      },
      body: JSON.stringify({
        api_name: apiName,
        token,
        params: params || {},
        fields: requestedFields
      })
    },
    validateJson: (value) => {
      classifyTusharePayload(value);
      providerPayloadValidator(
        (payloadValue) => mapTushareRows(payloadValue.data),
        options.validateJson
      )(value);
    }
  });

  return {
    fields: payload.data && Array.isArray(payload.data.fields) ? payload.data.fields.slice() : [],
    rows: mapTushareRows(payload.data),
    raw: payload
  };
}

module.exports = {
  ERROR_CODES,
  StockSourceError,
  requestJson,
  parseEastmoneyPercent,
  inferExchange,
  eastmoneyTimestampToDate,
  normalizeEastmoneyQuote,
  parseEastmoneyQuotes,
  fetchEastmoneyYtd,
  fetchEastmoneyMarket,
  normalizeProviderDate,
  parseTencentQfqKlines,
  fetchTencentQfqKlines,
  mapTushareRows,
  callTushare
};
