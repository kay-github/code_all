"use strict";

const { isDeepStrictEqual } = require("util");
const {
  assertSnapshotPublishable,
  normalizeDate
} = require("./stockSnapshot");
const {
  fixtureEnabled,
  getFixtureSnapshot,
  isProductionRuntime
} = require("./stockFixture");
const { assertBenchmarkPublishable } = require("./stockBenchmark");
const {
  deriveExpectedDatesFromCalendar,
  shanghaiDateParts,
  validateTradingCalendar
} = require("./stockTradingDates");

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_CACHE_TTL_MS = 60000;
const DEFAULT_MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
const MAX_TIMEOUT_MS = 20000;
const MAX_CACHE_TTL_MS = 300000;
const MAX_RESPONSE_BYTES = 50 * 1024 * 1024;
const COMPUTATION_TOLERANCE = 1e-10;

class StockPublishedSnapshotError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "StockPublishedSnapshotError";
    this.code = code;
    this.retryable = Boolean(options.retryable);
    this.status = Number.isFinite(options.status) ? options.status : null;
    this.cause = options.cause || null;
  }
}

const cache = new Map();
const inFlight = new Map();

function boundedNumber(value, fallback, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return fallback;
  return Math.min(number, maximum);
}

function validateSnapshotUrl(value, env) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch (error) {
    throw new StockPublishedSnapshotError(
      "STOCK_SNAPSHOT_INVALID_URL",
      "STOCK_SNAPSHOT_URL is invalid",
      { cause: error }
    );
  }

  const localHttp = url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(localHttp && !isProductionRuntime(env))) {
    throw new StockPublishedSnapshotError(
      "STOCK_SNAPSHOT_INVALID_URL",
      "production stock snapshot URL must use HTTPS"
    );
  }
  return url.toString();
}

function validateQueryPool(snapshot, poolName, exchanges, expectedScope, includeBse) {
  const pool = snapshot.pools[poolName];
  const scopedRecords = snapshot.records.filter((record) => exchanges.has(record.exchange));
  const expectedEntries = scopedRecords
    .filter((record) => record.isEligible === true)
    .map((record) => ({ symbol: record.symbol, ytd: record.ytd }))
    .sort((left, right) => left.ytd - right.ytd || left.symbol.localeCompare(right.symbol));

  if (
    pool.scope !== expectedScope ||
    pool.includeBse !== includeBse ||
    !Array.isArray(pool.entries) ||
    !Array.isArray(pool.sortedYtd) ||
    pool.entries.length !== expectedEntries.length ||
    pool.sortedYtd.length !== expectedEntries.length ||
    pool.poolEligibleCount !== expectedEntries.length ||
    pool.excludedCount !== scopedRecords.length - expectedEntries.length
  ) {
    throw new Error(`snapshot ${poolName} pool is invalid`);
  }

  expectedEntries.forEach((expected, index) => {
    const entry = pool.entries[index];
    if (
      !entry ||
      entry.symbol !== expected.symbol ||
      entry.ytd !== expected.ytd ||
      pool.sortedYtd[index] !== expected.ytd
    ) {
      throw new Error(`snapshot ${poolName} pool index is inconsistent`);
    }
  });
}

function positiveFinite(value) {
  return Number.isFinite(value) && value > 0;
}

function validateV2ComputationAudit(record, snapshot) {
  const basePriceDate = normalizeDate(record.basePriceDate, "record.basePriceDate");
  const lastPriceDate = normalizeDate(record.lastPriceDate, "record.lastPriceDate");
  const sourceAsOf = normalizeDate(
    record.sourceAsOf,
    "record.sourceAsOf"
  );
  if (
    basePriceDate > snapshot.baseDate ||
    lastPriceDate > snapshot.asOf ||
    sourceAsOf !== snapshot.asOf
  ) {
    throw new Error("snapshot computed record dates are invalid");
  }

  let auditedYtd;
  if (record.computedSource === "baostock") {
    if (
      record.adjustmentMethod !== "qfq" ||
      !positiveFinite(record.baseAdjustedClose) ||
      !positiveFinite(record.lastAdjustedClose)
    ) {
      throw new Error("snapshot qfq audit is incomplete");
    }
    auditedYtd = record.lastAdjustedClose / record.baseAdjustedClose - 1;
  } else if (record.computedSource === "sina") {
    if (
      record.adjustmentMethod !== "raw-factor" ||
      !positiveFinite(record.baseRawClose) ||
      !positiveFinite(record.baseAdjFactor) ||
      !positiveFinite(record.lastRawClose) ||
      !positiveFinite(record.lastAdjFactor) ||
      record.baseAdjFactorDate !== basePriceDate ||
      record.lastAdjFactorDate !== lastPriceDate
    ) {
      throw new Error("snapshot raw-factor audit is incomplete");
    }
    auditedYtd = (record.lastRawClose * record.lastAdjFactor) /
      (record.baseRawClose * record.baseAdjFactor) - 1;
  } else {
    throw new Error("snapshot computed source audit is invalid");
  }
  if (
    !Number.isFinite(auditedYtd) ||
    Math.abs(auditedYtd - record.ytd) > COMPUTATION_TOLERANCE
  ) {
    throw new Error("snapshot computed YTD audit failed");
  }
}

function snapshotWarning(snapshot, envelope = null) {
  const warnings = [];
  if (envelope && envelope.refreshStatus === "SERVING_PREVIOUS") {
    warnings.push("最新批次更新未完成，当前展示上一份已校验快照。");
  }
  if (snapshot.periodResetRequired) {
    warnings.push("新年度重置快照尚未生成，当前数据按过期状态处理。以 0 为起点的年内收益生成后恢复。");
  } else if (snapshot.calendarCoverageExpired) {
    warnings.push("交易日历覆盖已到期，当前展示上一份已校验快照并按过期数据处理。");
  } else if (snapshot.dataWarning) {
    warnings.push(String(snapshot.dataWarning));
  } else if (snapshot.sourceMode === "computed-fallback") {
    warnings.push("当前排名已由完整独立复权数据计算；辅助参考行情本批未参与校验。");
  } else if (
      snapshot.sourceMode === "partially-validated" ||
      snapshot.quality.status === "warning"
    ) {
    warnings.push("部分参考校验尚未完成，当前排名仍基于完整复权计算快照。");
  }
  return warnings.length ? warnings.join(" ") : null;
}

function applyDynamicFreshness(snapshot, tradingCalendar, envelopeExpectedAsOf, now) {
  if (!tradingCalendar) return snapshot;
  const dates = deriveExpectedDatesFromCalendar(
    tradingCalendar,
    shanghaiDateParts(new Date(now))
  );
  const expectedAsOf = [
    snapshot.publishExpectedAsOf || snapshot.asOf,
    envelopeExpectedAsOf,
    dates.expectedAsOf
  ].filter(Boolean).sort().at(-1);
  const periodResetRequired = snapshot.baseDate !== dates.baseDate;
  return {
    ...snapshot,
    expectedAsOf,
    isStale: snapshot.asOf < expectedAsOf || periodResetRequired,
    periodResetRequired
  };
}

function refreshCachedFreshness(cached, now) {
  try {
    return {
      snapshot: applyDynamicFreshness(
        cached.snapshot,
        cached.tradingCalendar,
        cached.envelopeExpectedAsOf,
        now
      ),
      warning: null
    };
  } catch (error) {
    if (error && error.code === "TRADING_CALENDAR_COVERAGE_MISSING") {
      return {
        snapshot: {
          ...cached.snapshot,
          isStale: true,
          calendarCoverageExpired: true
        },
        warning: "交易日历覆盖已到期，当前缓存按过期数据处理。"
      };
    }
    throw error;
  }
}

function validatePublishedSnapshot(snapshot, env = process.env) {
  try {
    assertSnapshotPublishable(snapshot);
    if (snapshot.schemaVersion !== "stock-ytd-snapshot.v1") {
      throw new Error("unsupported stock snapshot schema");
    }
    normalizeDate(snapshot.asOf, "snapshot.asOf");
    normalizeDate(snapshot.expectedAsOf, "snapshot.expectedAsOf");
    if (!snapshot.publishedAt || Number.isNaN(Date.parse(snapshot.publishedAt))) {
      throw new Error("snapshot.publishedAt is invalid");
    }
    if (!snapshot.stocks || !snapshot.pools || !snapshot.pools.shSz || !snapshot.pools.shSzBse) {
      throw new Error("snapshot query indexes are missing");
    }
    if (snapshot.releaseDecision !== "PUBLISH") {
      throw new Error("snapshot release decision is not PUBLISH");
    }
    if (
      !snapshot.quality ||
      !Array.isArray(snapshot.quality.errors) ||
      snapshot.quality.errors.length > 0
    ) {
      throw new Error("snapshot quality errors are present");
    }
    if (!Array.isArray(snapshot.quality.warnings) || !["pass", "warning"].includes(snapshot.quality.status)) {
      throw new Error("snapshot quality status is invalid");
    }
    const coverage = snapshot.quality.coverage;
    const minimumCoverage = Number(coverage && coverage.minimumRatio);
    const coverageRatio = Number(coverage && coverage.ratio);
    if (
      !coverage ||
      coverage.passed !== true ||
      !Number.isFinite(minimumCoverage) ||
      minimumCoverage < 0.998 ||
      minimumCoverage > 1 ||
      !Number.isFinite(coverageRatio) ||
      coverageRatio < minimumCoverage ||
      coverageRatio > 1 ||
      !Number.isInteger(coverage.expectedCount) ||
      coverage.expectedCount <= 0 ||
      !Number.isInteger(coverage.eligibleCount) ||
      coverage.eligibleCount < 0 ||
      coverage.eligibleCount > coverage.expectedCount
    ) {
      throw new Error("snapshot coverage gate is invalid");
    }
    if (snapshot.baseDate !== snapshot.expectedBaseDate) {
      throw new Error("snapshot base date is not independently certified");
    }
    if (!Array.isArray(snapshot.records)) {
      throw new Error("snapshot records are missing");
    }
    const stockKeys = Object.keys(snapshot.stocks);
    if (stockKeys.length !== snapshot.records.length) {
      throw new Error("snapshot stock index does not match records");
    }
    const partitionedSourcePolicy = snapshot.methodologyVersion === "adjusted-ytd.v2";
    const reportedSourcePolicy = snapshot.methodologyVersion === "reported-ytd.v1";
    if (
      !["adjusted-ytd.v1", "adjusted-ytd.v2", "reported-ytd.v1"].includes(snapshot.methodologyVersion)
    ) {
      throw new Error("unsupported stock snapshot methodology");
    }
    if (
      snapshot.poolVersion !== (
        reportedSourcePolicy
          ? "eastmoney-a-share.v1"
          : partitionedSourcePolicy
            ? "official-a-share.v2"
            : "a-share.v1"
      )
    ) {
      throw new Error("stock snapshot pool version does not match methodology");
    }
    const expectedSourceByExchange = {
      SH: "baostock",
      SZ: "baostock",
      BSE: "sina"
    };
    const symbols = new Set();
    for (const record of snapshot.records) {
      if (
        !record ||
        typeof record !== "object" ||
        typeof record.symbol !== "string" ||
        !/^\d{6}\.(SH|SZ|BJ)$/.test(record.symbol) ||
        symbols.has(record.symbol)
      ) {
        throw new Error("snapshot records contain an invalid or duplicate symbol");
      }
      symbols.add(record.symbol);
      if (
        record.isEligible === true &&
        (
          !Number.isFinite(record.ytd) ||
          record.ytd <= -1 ||
          record.hasFullYtd !== true ||
          record.ytdSource !== "computed" ||
          String(record.computedSource || "").toLowerCase() !== (
            reportedSourcePolicy
              ? "eastmoney"
              : partitionedSourcePolicy
                ? expectedSourceByExchange[record.exchange]
                : "tushare"
          )
        )
      ) {
        throw new Error("snapshot contains an invalid eligible computed record");
      }
      if (partitionedSourcePolicy && record.isEligible === true) {
        validateV2ComputationAudit(record, snapshot);
      }
      if (!isDeepStrictEqual(snapshot.stocks[record.symbol], record)) {
        throw new Error("snapshot stock index is inconsistent with records");
      }
    }
    const expectedCoverageRatio = Math.min(
      1,
      snapshot.pools.shSzBse.poolEligibleCount / coverage.expectedCount
    );
    if (
      coverage.eligibleCount !== snapshot.pools.shSzBse.poolEligibleCount ||
      Math.abs(coverageRatio - expectedCoverageRatio) > 1e-12
    ) {
      throw new Error("snapshot coverage does not match the query pool");
    }
    const sourceAudit = snapshot.quality.computedSources;
    const expectedActiveSources = reportedSourcePolicy
      ? ["eastmoney"]
      : partitionedSourcePolicy
        ? ["baostock", "sina"]
        : ["tushare"];
    if (
      !sourceAudit ||
      sourceAudit.missingCount !== 0 ||
      Number(sourceAudit.exchangeMismatchCount || 0) !== 0 ||
      !Array.isArray(sourceAudit.active) ||
      sourceAudit.active.length !== expectedActiveSources.length ||
      !expectedActiveSources.every((source, index) => sourceAudit.active[index] === source)
    ) {
      throw new Error("snapshot computed source audit is invalid");
    }
    if (
      isProductionRuntime(env) &&
      (
        snapshot.dataMode !== "published" ||
        !["validated", "partially-validated", "computed-fallback", "reported"].includes(snapshot.sourceMode)
      )
    ) {
      throw new Error("snapshot production mode is invalid");
    }
    validateQueryPool(snapshot, "shSz", new Set(["SH", "SZ"]), "SH_SZ", false);
    validateQueryPool(
      snapshot,
      "shSzBse",
      new Set(["SH", "SZ", "BSE"]),
      "SH_SZ_BSE",
      true
    );

    const looksLikeFixture = snapshot.dataMode === "fixture" ||
      String(snapshot.methodologyVersion || "").includes("fixture") ||
      String(snapshot.poolVersion || "").includes("fixture");
    if (isProductionRuntime(env) && looksLikeFixture) {
      throw new Error("fixture snapshot is forbidden in production");
    }
    if (isProductionRuntime(env) && snapshot.benchmark != null) {
      assertBenchmarkPublishable(snapshot.benchmark, snapshot);
    }
  } catch (error) {
    if (error instanceof StockPublishedSnapshotError) throw error;
    throw new StockPublishedSnapshotError(
      "STOCK_SNAPSHOT_INVALID",
      "published stock snapshot is invalid",
      { cause: error }
    );
  }
  return snapshot;
}

function preparePublishedSnapshot(payload, env = process.env, options = {}) {
  const envelope = payload && typeof payload === "object" && payload.snapshot
    ? payload
    : null;
  const rawSnapshot = envelope ? envelope.snapshot : payload;
  if (isProductionRuntime(env) && (!envelope || !envelope.expectedAsOf)) {
    throw new StockPublishedSnapshotError(
      "STOCK_SNAPSHOT_FRESHNESS_MISSING",
      "production snapshot response must include trusted expectedAsOf metadata"
    );
  }
  if (
    isProductionRuntime(env) &&
    envelope.envelopeVersion !== "stock-ytd-current.v1"
  ) {
    throw new StockPublishedSnapshotError(
      "STOCK_SNAPSHOT_INVALID",
      "production snapshot envelope version is invalid"
    );
  }
  if (
    isProductionRuntime(env) &&
    (
      typeof envelope.snapshotId !== "string" ||
      !envelope.snapshotId.trim() ||
      envelope.snapshotId.length > 200
    )
  ) {
    throw new StockPublishedSnapshotError(
      "STOCK_SNAPSHOT_INVALID",
      "production snapshot envelope identifier is invalid"
    );
  }
  let tradingCalendar = null;
  if (envelope && envelope.tradingCalendar) {
    try {
      tradingCalendar = validateTradingCalendar(envelope.tradingCalendar);
    } catch (error) {
      throw new StockPublishedSnapshotError(
        "STOCK_SNAPSHOT_INVALID",
        "stock snapshot trading calendar is invalid",
        { cause: error }
      );
    }
  } else if (isProductionRuntime(env)) {
    throw new StockPublishedSnapshotError(
      "STOCK_SNAPSHOT_FRESHNESS_MISSING",
      "production snapshot envelope must include a trusted trading calendar"
    );
  }
  if (
    envelope &&
    envelope.refreshStatus != null &&
    !["PUBLISHED", "SERVING_PREVIOUS"].includes(envelope.refreshStatus)
  ) {
    throw new StockPublishedSnapshotError(
      "STOCK_SNAPSHOT_INVALID",
      "stock snapshot refresh status is invalid"
    );
  }
  if (
    envelope &&
    rawSnapshot &&
    rawSnapshot.snapshotId &&
    String(rawSnapshot.snapshotId) !== String(envelope.snapshotId)
  ) {
    throw new StockPublishedSnapshotError(
      "STOCK_SNAPSHOT_INVALID",
      "stock snapshot envelope identifier does not match its payload"
    );
  }

  let asOf;
  let expectedAsOf;
  try {
    asOf = normalizeDate(rawSnapshot && rawSnapshot.asOf, "snapshot.asOf");
    const publishedExpectedAsOf = normalizeDate(
      rawSnapshot && rawSnapshot.expectedAsOf,
      "snapshot.publishedExpectedAsOf"
    );
    if (publishedExpectedAsOf !== asOf) {
      throw new Error("published snapshot was not current when released");
    }
    expectedAsOf = normalizeDate(
      envelope && envelope.expectedAsOf
        ? envelope.expectedAsOf
        : rawSnapshot && rawSnapshot.expectedAsOf,
      "snapshot.expectedAsOf"
    );
  } catch (error) {
    throw new StockPublishedSnapshotError(
      "STOCK_SNAPSHOT_INVALID",
      "published stock snapshot dates are invalid",
      { cause: error }
    );
  }
  if (expectedAsOf < asOf) {
    throw new StockPublishedSnapshotError(
      "STOCK_SNAPSHOT_INVALID",
      "snapshot expectedAsOf cannot be earlier than asOf"
    );
  }
  if (
    tradingCalendar &&
    ![
      rawSnapshot && rawSnapshot.baseDate,
      asOf,
      expectedAsOf
    ].every((date) => tradingCalendar.openDates.includes(date))
  ) {
    throw new StockPublishedSnapshotError(
      "STOCK_SNAPSHOT_INVALID",
      "stock snapshot dates are not certified by its trading calendar"
    );
  }

  const snapshot = validatePublishedSnapshot({
    ...rawSnapshot,
    publishExpectedAsOf: rawSnapshot && rawSnapshot.expectedAsOf,
    snapshotId: envelope && envelope.snapshotId
      ? String(envelope.snapshotId)
      : rawSnapshot && rawSnapshot.snapshotId,
    expectedAsOf,
    isStale: asOf < expectedAsOf
  }, env);
  const now = options.now instanceof Date
    ? options.now.getTime()
    : Number.isFinite(options.now)
      ? options.now
      : Date.now();
  try {
    return applyDynamicFreshness(
      snapshot,
      tradingCalendar,
      expectedAsOf,
      now
    );
  } catch (error) {
    if (error && error.code === "TRADING_CALENDAR_COVERAGE_MISSING") {
      return {
        ...snapshot,
        isStale: true,
        calendarCoverageExpired: true
      };
    }
    throw error;
  }
}

function responseEtag(response) {
  return response && response.headers && typeof response.headers.get === "function"
    ? response.headers.get("etag")
    : null;
}

function responseHeader(response, name) {
  return response && response.headers && typeof response.headers.get === "function"
    ? response.headers.get(name)
    : null;
}

function nextShanghaiCutoff(now) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(now));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  let cutoff = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    10,
    30
  );
  if (cutoff <= now) cutoff += 24 * 60 * 60 * 1000;
  return cutoff;
}

function cacheExpiry(now, cacheTtlMs) {
  return Math.min(now + cacheTtlMs, nextShanghaiCutoff(now));
}

async function fetchRemoteSnapshot(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const headers = { Accept: "application/json" };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.etag) headers["If-None-Match"] = options.etag;

  try {
    const response = await options.fetchImpl(url, {
      method: "GET",
      headers,
      signal: controller.signal,
      redirect: "error"
    });
    if (response && response.status === 304) {
      return { notModified: true, etag: options.etag };
    }
    if (!response || response.ok === false || Number(response.status) >= 400) {
      throw new StockPublishedSnapshotError(
        "STOCK_SNAPSHOT_FETCH_FAILED",
        `stock snapshot endpoint returned HTTP ${Number(response && response.status) || 500}`,
        {
          retryable: Number(response && response.status) >= 500,
          status: Number(response && response.status) || 500
        }
      );
    }
    const contentLength = Number(responseHeader(response, "content-length"));
    if (Number.isFinite(contentLength) && contentLength > options.maxResponseBytes) {
      throw new StockPublishedSnapshotError(
        "STOCK_SNAPSHOT_TOO_LARGE",
        "stock snapshot response exceeds the configured size limit"
      );
    }
    let snapshot;
    if (typeof response.text === "function") {
      const body = await response.text();
      if (Buffer.byteLength(body, "utf8") > options.maxResponseBytes) {
        throw new StockPublishedSnapshotError(
          "STOCK_SNAPSHOT_TOO_LARGE",
          "stock snapshot response exceeds the configured size limit"
        );
      }
      try {
        snapshot = JSON.parse(body);
      } catch (error) {
        throw new StockPublishedSnapshotError(
          "STOCK_SNAPSHOT_FETCH_FAILED",
          "stock snapshot endpoint returned invalid JSON",
          { cause: error }
        );
      }
    } else if (typeof response.json === "function") {
      snapshot = await response.json();
    } else {
      throw new StockPublishedSnapshotError(
        "STOCK_SNAPSHOT_FETCH_FAILED",
        "stock snapshot endpoint did not return JSON",
        { retryable: true }
      );
    }
    return {
      snapshot,
      etag: responseEtag(response),
      notModified: false
    };
  } catch (error) {
    if (error instanceof StockPublishedSnapshotError) throw error;
    throw new StockPublishedSnapshotError(
      "STOCK_SNAPSHOT_FETCH_FAILED",
      error && error.name === "AbortError"
        ? "stock snapshot request timed out"
        : "stock snapshot request failed",
      { retryable: true, cause: error }
    );
  } finally {
    clearTimeout(timer);
  }
}

async function loadStockSnapshot(options = {}) {
  const env = options.env || process.env;
  const configuredUrl = options.url || env.STOCK_SNAPSHOT_URL;
  if (!configuredUrl) {
    if (fixtureEnabled(env)) {
      const snapshot = getFixtureSnapshot();
      return {
        snapshot,
        mode: "fixture",
        cacheStatus: "fixture",
        warning: snapshot.dataWarning
      };
    }
    throw new StockPublishedSnapshotError(
      "STOCK_SNAPSHOT_NOT_CONFIGURED",
      "production stock snapshot is not configured"
    );
  }

  const url = validateSnapshotUrl(configuredUrl, env);
  const cacheKey = `${isProductionRuntime(env) ? "production" : "nonproduction"}:${url}`;
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const timeoutMs = boundedNumber(
    options.timeoutMs == null ? env.STOCK_SNAPSHOT_TIMEOUT_MS : options.timeoutMs,
    DEFAULT_TIMEOUT_MS,
    MAX_TIMEOUT_MS
  );
  const cacheTtlMs = boundedNumber(
    options.cacheTtlMs == null ? env.STOCK_SNAPSHOT_CACHE_TTL_MS : options.cacheTtlMs,
    DEFAULT_CACHE_TTL_MS,
    MAX_CACHE_TTL_MS
  );
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const maxResponseBytes = boundedNumber(
    options.maxResponseBytes == null
      ? env.STOCK_SNAPSHOT_MAX_BYTES
      : options.maxResponseBytes,
    DEFAULT_MAX_RESPONSE_BYTES,
    MAX_RESPONSE_BYTES
  );
  if (typeof fetchImpl !== "function") {
    throw new StockPublishedSnapshotError(
      "STOCK_SNAPSHOT_FETCH_FAILED",
      "stock snapshot fetch implementation is unavailable"
    );
  }

  const cached = cache.get(cacheKey);
  if (!options.forceRefresh && cached && cached.expiresAt > now) {
      const refreshed = refreshCachedFreshness(cached, now);
      cached.snapshot = refreshed.snapshot;
      return {
        snapshot: refreshed.snapshot,
        mode: "published",
        cacheStatus: "hit",
        warning: [cached.warning, refreshed.warning].filter(Boolean).join(" ") || null,
        refreshStatus: cached.refreshStatus,
        lastValidatedAt: cached.lastValidatedAt == null
          ? null
          : new Date(cached.lastValidatedAt).toISOString()
    };
  }

  const refresh = async () => {
    try {
      const fetched = await fetchRemoteSnapshot(url, {
        fetchImpl,
        timeoutMs,
        token: options.token || env.STOCK_SNAPSHOT_AUTH_TOKEN || null,
        etag: cached && cached.etag,
        maxResponseBytes
      });
      if (fetched.notModified) {
        if (!cached) {
          throw new StockPublishedSnapshotError(
            "STOCK_SNAPSHOT_FETCH_FAILED",
            "stock snapshot returned 304 without a cached value",
            { retryable: true }
          );
        }
        cached.expiresAt = cacheExpiry(now, cacheTtlMs);
        cached.lastValidatedAt = now;
        const refreshed = refreshCachedFreshness(cached, now);
        cached.snapshot = refreshed.snapshot;
        return {
          snapshot: cached.snapshot,
          mode: "published",
          cacheStatus: "revalidated",
          warning: [cached.warning, refreshed.warning].filter(Boolean).join(" ") || null,
          refreshStatus: cached.refreshStatus,
          lastValidatedAt: new Date(now).toISOString()
        };
      }

      const snapshot = preparePublishedSnapshot(fetched.snapshot, env, { now });
      const envelope = fetched.snapshot && fetched.snapshot.snapshot
        ? fetched.snapshot
        : null;
      const tradingCalendar = envelope && envelope.tradingCalendar
        ? validateTradingCalendar(envelope.tradingCalendar)
        : null;
      const warning = snapshotWarning(snapshot, envelope);
      const refreshStatus = envelope && envelope.refreshStatus
        ? envelope.refreshStatus
        : "PUBLISHED";
      if (isProductionRuntime(env) && !fetched.etag) {
        throw new StockPublishedSnapshotError(
          "STOCK_SNAPSHOT_ETAG_MISSING",
          "production snapshot envelope must provide an ETag"
        );
      }
      cache.set(cacheKey, {
        snapshot,
        etag: fetched.etag,
        expiresAt: cacheExpiry(now, cacheTtlMs),
        lastValidatedAt: now,
        warning,
        refreshStatus,
        tradingCalendar,
        envelopeExpectedAsOf: envelope && envelope.expectedAsOf
      });
      return {
        snapshot,
        mode: "published",
        cacheStatus: "fresh",
        warning,
        refreshStatus,
        lastValidatedAt: new Date(now).toISOString()
      };
    } catch (error) {
      if (cached) {
        const cacheWarning = "快照存储暂时不可用，当前展示最近一次已校验的服务端缓存。";
        const refreshed = refreshCachedFreshness(cached, now);
        cached.snapshot = refreshed.snapshot;
        return {
          snapshot: refreshed.snapshot,
          mode: "published",
          cacheStatus: "stale-fallback",
          warning: [cacheWarning, cached.warning, refreshed.warning]
            .filter(Boolean)
            .join(" "),
          refreshStatus: cached.refreshStatus,
          lastValidatedAt: cached.lastValidatedAt == null
            ? null
            : new Date(cached.lastValidatedAt).toISOString(),
          cacheAgeMs: cached.lastValidatedAt == null
            ? null
            : Math.max(0, now - cached.lastValidatedAt),
          upstreamErrorCode: error && error.code
        };
      }
      throw error;
    }
  };

  if (!options.forceRefresh && inFlight.has(cacheKey)) {
    return inFlight.get(cacheKey);
  }
  const pending = refresh();
  if (!options.forceRefresh) inFlight.set(cacheKey, pending);
  try {
    return await pending;
  } finally {
    if (inFlight.get(cacheKey) === pending) inFlight.delete(cacheKey);
  }
}

function resetStockSnapshotCache() {
  cache.clear();
  inFlight.clear();
}

module.exports = {
  StockPublishedSnapshotError,
  validatePublishedSnapshot,
  preparePublishedSnapshot,
  snapshotWarning,
  applyDynamicFreshness,
  loadStockSnapshot,
  resetStockSnapshotCache
};
