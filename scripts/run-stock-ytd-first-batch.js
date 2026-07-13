"use strict";

const fs = require("fs/promises");
const path = require("path");
const { fetchEastmoneyMarket } = require("../lib/stockSources");
const { fetchTushareTradeCalendar } = require("../lib/tushareYtd");
const { runStockDailyWorker } = require("../lib/stockDailyWorker");
const { loadCurrentEnvelope } = require("../lib/stockSnapshotFileStore");
const { queryStockSnapshot } = require("../lib/stockSnapshot");
const {
  deriveExpectedDates,
  shanghaiDateParts
} = require("../lib/stockTradingDates");
const {
  assessMarketRows,
  checkSymbol,
  checkTushare,
  reportHasFailures
} = require("./check-stock-sources");

const EXIT = Object.freeze({
  PASS: 0,
  INTERNAL: 1,
  PREFLIGHT: 2,
  DIAGNOSTIC: 3,
  PUBLISH: 4
});
const SENTINELS = ["300502.SZ", "600519.SH"];
const FIRST_BATCH_SOURCE = "validated";
const CODE_PATTERN = /^[A-Z0-9_-]{1,80}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const reportSecretValues = new WeakMap();

function cleanCode(value, fallback = "UNKNOWN_ERROR") {
  if (value == null || value === "") return fallback;
  const code = String(value).toUpperCase();
  return CODE_PATTERN.test(code) ? code : fallback;
}

function finiteOrNull(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits = 8) {
  const number = finiteOrNull(value);
  if (number == null) return null;
  return Number(number.toFixed(digits));
}

function issueCodes(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => cleanCode(value && value.code || value, null))
    .filter(Boolean))];
}

function argumentError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validIsoDate(value) {
  if (!DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

function parseArguments(args) {
  const result = {
    directory: path.resolve(".stock-ytd-data", "first-batch"),
    requireAsOf: null,
    expectedMasterCounts: null
  };
  const expectedMasterCounts = { SH: null, SZ: null, BSE: null };
  for (const argument of args || []) {
    if (argument.startsWith("--store-dir=")) {
      const value = argument.slice("--store-dir=".length).trim();
      if (!value) throw argumentError("INVALID_STORE_DIRECTORY", "store directory is required");
      result.directory = path.resolve(value);
      continue;
    }
    if (argument.startsWith("--require-as-of=")) {
      const value = argument.slice("--require-as-of=".length).trim();
      if (!validIsoDate(value)) {
        throw argumentError("INVALID_REQUIRED_AS_OF", "require-as-of must be YYYY-MM-DD");
      }
      result.requireAsOf = value;
      continue;
    }
    const countMatch = argument.match(/^--expected-(sh|sz|bse)=(.*)$/i);
    if (countMatch) {
      const value = Number(countMatch[2]);
      if (!Number.isInteger(value) || value <= 0) {
        throw argumentError(
          "INVALID_EXPECTED_MASTER_COUNT",
          "expected exchange counts must be positive integers"
        );
      }
      expectedMasterCounts[countMatch[1].toUpperCase()] = value;
      continue;
    }
    throw argumentError("UNKNOWN_ARGUMENT", "unsupported first-batch argument");
  }
  const providedCounts = Object.values(expectedMasterCounts).filter(
    (value) => value != null
  ).length;
  if (providedCounts > 0 && providedCounts < 3) {
    throw argumentError(
      "INCOMPLETE_EXPECTED_MASTER_COUNTS",
      "expected SH, SZ and BSE counts must be provided together"
    );
  }
  if (providedCounts === 3) result.expectedMasterCounts = expectedMasterCounts;
  return result;
}

function tokenConfigured(env) {
  return typeof env.TUSHARE_TOKEN === "string" && env.TUSHARE_TOKEN.trim() !== "";
}

async function inspectTarget(directory) {
  let entries;
  try {
    entries = await fs.readdir(directory);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (entries.length > 0) {
    throw argumentError(
      "FIRST_BATCH_STORE_NOT_EMPTY",
      "first-batch store must be absent or empty"
    );
  }
}

async function runDatePreflight(options = {}) {
  const env = options.env || process.env;
  const clients = options.clients || {};
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const nowParts = shanghaiDateParts(now);
  const year = Number(nowParts.year);
  const startDate = `${year - 1}-12-01`;
  const today = `${nowParts.year}-${nowParts.month}-${nowParts.day}`;
  const fetchCalendar = clients.fetchTushareTradeCalendar || fetchTushareTradeCalendar;
  const result = await fetchCalendar(startDate, today, {
    env,
    retries: 1,
    timeoutMs: 10000
  });
  return deriveExpectedDates(result.rows, nowParts);
}

function unavailableSymbol(symbol, error) {
  return {
    symbol,
    eastmoney: null,
    tencent: {
      status: "UNAVAILABLE",
      error: cleanCode(error && error.code)
    }
  };
}

async function runSourceDiagnostics(options = {}) {
  const env = options.env || process.env;
  const clients = options.clients || {};
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const dateParts = shanghaiDateParts(now);
  const year = Number(dateParts.year);
  const today = `${dateParts.year}-${dateParts.month}-${dateParts.day}`;
  const tushare = await checkTushare({
    env,
    clients,
    nowParts: dateParts
  });
  const dates = {
    today,
    startDate: `${year - 1}-12-01`,
    baseCutoff: `${year - 1}-12-31`,
    baseDate: tushare.baseDate || null,
    expectedAsOf: tushare.expectedAsOf || null
  };

  if (tushare.status !== "PASS") {
    return {
      report: {
        checkedAt: now.toISOString(),
        dates,
        thresholdsBp: { warning: 5, failure: 20 },
        tushare,
        symbols: [],
        market: null
      },
      marketRows: null
    };
  }

  const symbols = [];
  for (const symbol of SENTINELS) {
    try {
      symbols.push(await checkSymbol(symbol, dates, clients));
    } catch (error) {
      symbols.push(unavailableSymbol(symbol, error));
    }
  }

  let marketRows = null;
  let market;
  try {
    const fetchMarket = clients.fetchEastmoneyMarket || fetchEastmoneyMarket;
    const startedAt = Date.now();
    marketRows = await fetchMarket({ retries: 2, timeoutMs: 8000 });
    market = {
      ...assessMarketRows(marketRows),
      elapsedMs: Date.now() - startedAt
    };
  } catch (error) {
    market = {
      status: "UNAVAILABLE",
      failures: [cleanCode(error && error.code)],
      error: cleanCode(error && error.code)
    };
  }

  return {
    report: {
      checkedAt: now.toISOString(),
      dates,
      thresholdsBp: { warning: 5, failure: 20 },
      tushare,
      symbols,
      market
    },
    marketRows
  };
}

function sanitizeTushare(value) {
  const counts = value && value.counts || {};
  const stockBasicByExchange = counts.stockBasicByExchange || {};
  const masterByExchange = counts.masterByExchange || {};
  const expectedUniverseByExchange = counts.expectedUniverseByExchange || {};
  return {
    status: value && value.status || "UNAVAILABLE",
    error: value && value.error ? cleanCode(value.error) : null,
    failures: issueCodes(value && value.failures),
    expectedAsOf: value && value.expectedAsOf || null,
    baseDate: value && value.baseDate || null,
    counts: {
      stockBasic: finiteOrNull(counts.stockBasic),
      masterRecords: finiteOrNull(counts.masterRecords),
      expectedUniverse: finiteOrNull(counts.expectedUniverse),
      eligibleComputed: finiteOrNull(counts.eligibleComputed),
      computedCoverage: round(counts.computedCoverage),
      newListings: finiteOrNull(counts.newListings),
      baseBackfill: finiteOrNull(counts.baseBackfill),
      currentBackfill: finiteOrNull(counts.currentBackfill),
      stockBasicByExchange: {
        SH: finiteOrNull(stockBasicByExchange.SH),
        SZ: finiteOrNull(stockBasicByExchange.SZ),
        BSE: finiteOrNull(stockBasicByExchange.BSE),
        UNKNOWN: finiteOrNull(stockBasicByExchange.UNKNOWN)
      },
      masterByExchange: {
        SH: finiteOrNull(masterByExchange.SH),
        SZ: finiteOrNull(masterByExchange.SZ),
        BSE: finiteOrNull(masterByExchange.BSE),
        UNKNOWN: finiteOrNull(masterByExchange.UNKNOWN)
      },
      expectedUniverseByExchange: {
        SH: finiteOrNull(expectedUniverseByExchange.SH),
        SZ: finiteOrNull(expectedUniverseByExchange.SZ),
        BSE: finiteOrNull(expectedUniverseByExchange.BSE),
        UNKNOWN: finiteOrNull(expectedUniverseByExchange.UNKNOWN)
      }
    },
    sentinelYtd: round(value && value.sentinelYtd),
    benchmarkYtd: round(value && value.benchmarkYtd)
  };
}

function sanitizeSymbol(value) {
  const eastmoney = value && value.eastmoney;
  const tencent = value && value.tencent || {};
  return {
    symbol: value && value.symbol || null,
    eastmoney: eastmoney ? {
      ytd: round(eastmoney.ytd),
      sourceAsOf: eastmoney.sourceAsOf || null
    } : null,
    tencent: {
      status: tencent.status || "UNAVAILABLE",
      error: tencent.error ? cleanCode(tencent.error) : null,
      baseDate: tencent.baseDate || null,
      currentDate: tencent.currentDate || null,
      ytd: round(tencent.ytd),
      deviationBp: round(tencent.deviationBp, 4)
    }
  };
}

function sanitizeMarket(value) {
  const market = value || {};
  const byExchange = market.byExchange || {};
  return {
    status: market.status || "UNAVAILABLE",
    error: market.error ? cleanCode(market.error) : null,
    failures: issueCodes(market.failures),
    rows: finiteOrNull(market.rows),
    uniqueSymbols: finiteOrNull(market.uniqueSymbols),
    duplicateCount: finiteOrNull(market.duplicateCount),
    missingYtd: finiteOrNull(market.missingYtd),
    maximumMissingYtd: finiteOrNull(market.maximumMissingYtd),
    unknownExchange: finiteOrNull(market.unknownExchange),
    byExchange: {
      SH: finiteOrNull(byExchange.SH),
      SZ: finiteOrNull(byExchange.SZ),
      BJ: finiteOrNull(byExchange.BJ)
    },
    elapsedMs: finiteOrNull(market.elapsedMs)
  };
}

function sanitizeDiagnostics(value) {
  const report = value || {};
  return {
    checkedAt: report.checkedAt || null,
    dates: {
      baseDate: report.dates && report.dates.baseDate || null,
      expectedAsOf: report.dates && report.dates.expectedAsOf || null
    },
    thresholdsBp: { warning: 5, failure: 20 },
    tushare: sanitizeTushare(report.tushare),
    symbols: (report.symbols || []).map(sanitizeSymbol),
    market: sanitizeMarket(report.market)
  };
}

function detectTokenEmbedded(serializedArtifact, env) {
  const tokens = [env.TUSHARE_TOKEN, env.STOCK_SNAPSHOT_AUTH_TOKEN]
    .filter((value) => typeof value === "string" && value.length > 0);
  const normalized = serializedArtifact.toLowerCase();
  return tokens.some((value) => normalized.includes(value.toLowerCase()));
}

function secretValues(env) {
  return [env.TUSHARE_TOKEN, env.STOCK_SNAPSHOT_AUTH_TOKEN]
    .filter((value) => typeof value === "string" && value.length > 0);
}

function redactString(value, tokens) {
  let redacted = value;
  for (const token of tokens) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    redacted = redacted.replace(new RegExp(escaped, "gi"), "[REDACTED]");
  }
  return redacted;
}

function redactReportSecrets(report, tokens) {
  const visited = new WeakSet();
  function visit(value) {
    if (!value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === "string") {
        value[key] = redactString(child, tokens);
      } else {
        visit(child);
      }
    }
  }
  visit(report);
  return report;
}

function serializeReport(report, env) {
  const tokens = secretValues(env);
  const serialized = JSON.stringify(report, null, 2);
  return redactString(serialized, tokens);
}

function collectSensitiveKeyPaths(value, limit = 20) {
  const found = new Set();
  const visited = new WeakSet();
  const pattern = /token|secret|authorization|cookie|api[_-]?key/i;

  function visit(current, location) {
    if (!current || typeof current !== "object" || found.size >= limit) return;
    if (visited.has(current)) return;
    visited.add(current);
    if (Array.isArray(current)) {
      for (const item of current) visit(item, location + "[]");
      return;
    }
    for (const [key, child] of Object.entries(current)) {
      const childPath = location ? `${location}.${key}` : key;
      if (pattern.test(key)) found.add(childPath);
      visit(child, childPath);
      if (found.size >= limit) return;
    }
  }

  visit(value, "");
  return [...found].sort();
}

async function countResidualArtifacts(directory) {
  let count = 0;
  async function inspect(current, depth) {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (/\.tmp$|refresh\.lock|\.recovery|\.stale\.|\.abandoned\./.test(entry.name)) {
        count += 1;
      }
      if (entry.isDirectory() && depth < 2) {
        await inspect(path.join(current, entry.name), depth + 1);
      }
    }
  }
  await inspect(directory, 0);
  return count;
}

async function readPublishedArtifact(directory) {
  const envelope = await loadCurrentEnvelope(directory);
  if (!envelope) throw argumentError("FIRST_BATCH_CURRENT_MISSING", "current envelope is missing");
  if (!/^stock-ytd-\d{8}-[a-f0-9]{16}$/.test(envelope.snapshotId)) {
    throw argumentError("FIRST_BATCH_SNAPSHOT_ID_INVALID", "snapshot id is invalid");
  }
  const currentPath = path.join(directory, "current.json");
  const immutablePath = path.join(
    directory,
    "snapshots",
    envelope.snapshotId + ".json"
  );
  const [rawBody, immutableBody, residualArtifacts] = await Promise.all([
    fs.readFile(currentPath, "utf8"),
    fs.readFile(immutablePath, "utf8"),
    countResidualArtifacts(directory)
  ]);
  return {
    envelope,
    rawBody,
    immutableRawBody: immutableBody,
    immutableSnapshot: JSON.parse(immutableBody),
    residualArtifacts
  };
}

function auditAdjustment(record) {
  if (!record) return { available: false, passed: false, deltaBp: null, factorChanged: null };
  const baseClose = finiteOrNull(record.baseRawClose);
  const baseFactor = finiteOrNull(record.baseAdjFactor);
  const lastClose = finiteOrNull(record.lastRawClose);
  const lastFactor = finiteOrNull(record.lastAdjFactor);
  const publishedYtd = finiteOrNull(record.ytd);
  if (
    baseClose == null || baseFactor == null || lastClose == null ||
    lastFactor == null || publishedYtd == null ||
    baseClose <= 0 || baseFactor <= 0 || lastClose <= 0 || lastFactor <= 0
  ) {
    return { available: false, passed: false, deltaBp: null, factorChanged: null };
  }
  const recalculated = (lastClose * lastFactor) / (baseClose * baseFactor) - 1;
  const deltaBp = Math.abs(recalculated - publishedYtd) * 10000;
  return {
    available: true,
    passed: deltaBp <= 1e-6,
    deltaBp: round(deltaBp, 8),
    factorChanged: baseFactor !== lastFactor
  };
}

function safeComparison(snapshot, symbol, includeBse) {
  try {
    const result = queryStockSnapshot(snapshot, symbol, { includeBse });
    const value = result && result.comparison;
    if (!value) return null;
    return {
      scope: value.scope,
      beatCount: value.beatCount,
      peerCount: value.peerCount,
      beatRatio: round(value.beatRatio),
      rankPosition: value.rankPosition,
      rankPopulation: value.rankPopulation,
      topRatio: round(value.topRatio)
    };
  } catch (error) {
    return null;
  }
}

function auditSentinel(snapshot, symbol) {
  const record = snapshot.stocks && snapshot.stocks[symbol] || null;
  if (!record) return { symbol, found: false };
  return {
    symbol,
    found: true,
    name: record.name || null,
    ytd: round(record.ytd),
    referenceYtd: round(record.referenceYtd),
    deviationBp: round(record.deviationBp, 4),
    isEligible: record.isEligible === true,
    ineligibilityReason: record.ineligibilityReason || null,
    qualityStatus: record.qualityStatus || null,
    qualityFlags: issueCodes(record.qualityFlags),
    basePriceDate: record.basePriceDate || null,
    lastPriceDate: record.lastPriceDate || null,
    adjustmentAudit: auditAdjustment(record),
    comparisons: {
      shSz: safeComparison(snapshot, symbol, false),
      shSzBse: safeComparison(snapshot, symbol, true)
    }
  };
}

function deviationSummary(snapshot) {
  const values = (snapshot.records || [])
    .map((record) => finiteOrNull(record.deviationBp))
    .filter((value) => value != null)
    .map(Math.abs)
    .sort((left, right) => left - right);
  const p95Index = values.length ? Math.max(0, Math.ceil(values.length * 0.95) - 1) : -1;
  const comparable = values.length;
  const independent = finiteOrNull(
    snapshot.quality && snapshot.quality.coverage &&
    snapshot.quality.coverage.independentCount
  ) || 0;
  return {
    comparable,
    within5Bp: values.filter((value) => value <= 5).length,
    over5To20Bp: values.filter((value) => value > 5 && value <= 20).length,
    over20Bp: values.filter((value) => value > 20).length,
    withoutComparableReference: Math.max(0, independent - comparable),
    p95Bp: p95Index >= 0 ? round(values[p95Index], 4) : null,
    maxBp: values.length ? round(values.at(-1), 4) : null
  };
}

function exchangeSummary(snapshot) {
  const result = {
    SH: { total: 0, expected: 0, eligible: 0, excluded: 0 },
    SZ: { total: 0, expected: 0, eligible: 0, excluded: 0 },
    BSE: { total: 0, expected: 0, eligible: 0, excluded: 0 }
  };
  for (const record of snapshot.records || []) {
    const exchange = record.exchange === "BJ" ? "BSE" : record.exchange;
    if (!result[exchange]) continue;
    result[exchange].total += 1;
    if (!record.listingDate || record.listingDate <= snapshot.baseDate) {
      result[exchange].expected += 1;
    }
    result[exchange][record.isEligible ? "eligible" : "excluded"] += 1;
  }
  return result;
}

function benchmarkAudit(benchmark) {
  const base = finiteOrNull(benchmark && benchmark.baseClose);
  const current = finiteOrNull(benchmark && benchmark.currentClose);
  const publishedYtd = finiteOrNull(benchmark && benchmark.ytd);
  let deltaBp = null;
  if (base != null && current != null && publishedYtd != null && base > 0 && current > 0) {
    deltaBp = Math.abs(current / base - 1 - publishedYtd) * 10000;
  }
  return {
    symbol: benchmark && benchmark.symbol || null,
    name: benchmark && benchmark.name || null,
    type: benchmark && benchmark.type || null,
    source: benchmark && benchmark.source || null,
    asOf: benchmark && benchmark.asOf || null,
    baseDate: benchmark && benchmark.baseDate || null,
    ytd: round(benchmark && benchmark.ytd),
    endpointAuditPassed: deltaBp != null && deltaBp <= 1e-6,
    endpointAuditDeltaBp: round(deltaBp, 8)
  };
}

function safePool(value) {
  return {
    scope: value && value.scope || null,
    includeBse: value && value.includeBse === true,
    poolEligibleCount: finiteOrNull(value && value.poolEligibleCount),
    excludedCount: finiteOrNull(value && value.excludedCount)
  };
}

function buildSnapshotAudit(artifact, env) {
  const envelope = artifact.envelope;
  const snapshot = envelope.snapshot || {};
  const quality = snapshot.quality || {};
  const coverage = quality.coverage || {};
  const computedSources = quality.computedSources || {};
  const counts = quality.counts || {};
  const duplicates = quality.duplicates || {};
  const rawBody = String(artifact.rawBody || "") + "\n" +
    String(artifact.immutableRawBody || "");
  return {
    envelope: {
      envelopeVersion: envelope.envelopeVersion || null,
      snapshotId: envelope.snapshotId || null,
      innerSnapshotId: snapshot.snapshotId || null,
      expectedAsOf: envelope.expectedAsOf || null,
      refreshStatus: envelope.refreshStatus || null,
      refreshedAt: envelope.refreshedAt || null,
      errorCodes: issueCodes(envelope.errorCodes),
      warningCodes: issueCodes(envelope.warningCodes),
      calendar: {
        version: envelope.tradingCalendar && envelope.tradingCalendar.version || null,
        coveredFrom: envelope.tradingCalendar && envelope.tradingCalendar.coveredFrom || null,
        coveredThrough: envelope.tradingCalendar && envelope.tradingCalendar.coveredThrough || null,
        openDateCount: Array.isArray(envelope.tradingCalendar && envelope.tradingCalendar.openDates)
          ? envelope.tradingCalendar.openDates.length
          : 0
      }
    },
    snapshot: {
      schemaVersion: snapshot.schemaVersion || null,
      methodologyVersion: snapshot.methodologyVersion || null,
      poolVersion: snapshot.poolVersion || null,
      dataMode: snapshot.dataMode || null,
      sourceMode: snapshot.sourceMode || null,
      releaseDecision: snapshot.releaseDecision || null,
      productionPublishable: snapshot.productionPublishable === true,
      asOf: snapshot.asOf || null,
      expectedAsOf: snapshot.expectedAsOf || null,
      baseDate: snapshot.baseDate || null,
      expectedBaseDate: snapshot.expectedBaseDate || null,
      isStale: snapshot.isStale === true,
      generatedAt: snapshot.generatedAt || null,
      publishedAt: snapshot.publishedAt || null
    },
    quality: {
      status: quality.status || null,
      errorCodes: issueCodes(quality.errors),
      warningCodes: issueCodes(quality.warnings),
      invalidRecordCount: Array.isArray(quality.invalidRecords) ? quality.invalidRecords.length : null,
      dateMismatchCount: Array.isArray(quality.dateMismatches) ? quality.dateMismatches.length : null,
      duplicateComputedCount: Array.isArray(duplicates.computed) ? duplicates.computed.length : null,
      duplicateReferenceCount: Array.isArray(duplicates.reference) ? duplicates.reference.length : null,
      coverage: {
        expectedCount: finiteOrNull(coverage.expectedCount),
        eligibleCount: finiteOrNull(coverage.eligibleCount),
        independentCount: finiteOrNull(coverage.independentCount),
        ratio: round(coverage.ratio),
        independentRatio: round(coverage.independentRatio),
        minimumRatio: round(coverage.minimumRatio),
        passed: coverage.passed === true,
        basis: coverage.basis || null
      },
      computedSources: {
        active: Array.isArray(computedSources.active)
          ? computedSources.active.map((value) => String(value))
          : [],
        missingCount: finiteOrNull(computedSources.missingCount)
      },
      counts: {
        computedInput: finiteOrNull(counts.computedInput),
        referenceInput: finiteOrNull(counts.referenceInput),
        merged: finiteOrNull(counts.merged),
        eligible: finiteOrNull(counts.eligible),
        excluded: finiteOrNull(counts.excluded),
        quarantined: finiteOrNull(counts.quarantined),
        referenceOnly: finiteOrNull(counts.referenceOnly),
        comparableReference: finiteOrNull(counts.comparableReference),
        newListings: finiteOrNull(counts.newListings)
      }
    },
    pools: {
      shSz: safePool(snapshot.pools && snapshot.pools.shSz),
      shSzBse: safePool(snapshot.pools && snapshot.pools.shSzBse)
    },
    exchanges: exchangeSummary(snapshot),
    deviations: deviationSummary(snapshot),
    benchmark: benchmarkAudit(snapshot.benchmark),
    sentinels: SENTINELS.map((symbol) => auditSentinel(snapshot, symbol)),
    storage: {
      immutableSnapshotMatches: JSON.stringify(snapshot) ===
        JSON.stringify(artifact.immutableSnapshot),
      residualArtifactCount: finiteOrNull(artifact.residualArtifacts)
    },
    security: {
      tokenEmbedded: detectTokenEmbedded(rawBody, env),
      sensitiveKeyPaths: collectSensitiveKeyPaths(envelope)
    }
  };
}

function evaluateSnapshotAudit(audit) {
  const issues = [];
  const envelope = audit.envelope;
  const snapshot = audit.snapshot;
  const quality = audit.quality;
  const coverage = quality.coverage;
  const activeSources = quality.computedSources.active;
  function require(condition, code) {
    if (!condition) issues.push(code);
  }

  require(envelope.envelopeVersion === "stock-ytd-current.v1", "ENVELOPE_VERSION_INVALID");
  require(envelope.snapshotId === envelope.innerSnapshotId, "SNAPSHOT_ID_MISMATCH");
  require(envelope.refreshStatus === "PUBLISHED", "REFRESH_NOT_PUBLISHED");
  require(envelope.errorCodes.length === 0, "ENVELOPE_HAS_ERRORS");
  require(envelope.warningCodes.length === 0, "ENVELOPE_HAS_WARNINGS");
  require(snapshot.schemaVersion === "stock-ytd-snapshot.v1", "SNAPSHOT_SCHEMA_INVALID");
  require(snapshot.methodologyVersion === "adjusted-ytd.v1", "METHODOLOGY_INVALID");
  require(snapshot.poolVersion === "a-share.v1", "POOL_VERSION_INVALID");
  require(snapshot.dataMode === "published", "DATA_MODE_INVALID");
  require(snapshot.sourceMode === FIRST_BATCH_SOURCE, "SOURCE_MODE_NOT_VALIDATED");
  require(snapshot.productionPublishable, "SNAPSHOT_NOT_PRODUCTION_PUBLISHABLE");
  require(snapshot.releaseDecision === "PUBLISH", "RELEASE_NOT_PUBLISH");
  require(snapshot.asOf === snapshot.expectedAsOf, "SNAPSHOT_AS_OF_MISMATCH");
  require(snapshot.asOf === envelope.expectedAsOf, "ENVELOPE_AS_OF_MISMATCH");
  require(snapshot.baseDate === snapshot.expectedBaseDate, "BASE_DATE_MISMATCH");
  require(snapshot.isStale === false, "SNAPSHOT_STALE");
  require(quality.errorCodes.length === 0, "QUALITY_HAS_ERRORS");
  require(quality.warningCodes.length === 0, "QUALITY_HAS_WARNINGS");
  require(quality.invalidRecordCount === 0, "INVALID_RECORDS_PRESENT");
  require(quality.dateMismatchCount === 0, "DATE_MISMATCHES_PRESENT");
  require(quality.duplicateComputedCount === 0, "DUPLICATE_COMPUTED_PRESENT");
  require(quality.duplicateReferenceCount === 0, "DUPLICATE_REFERENCE_PRESENT");
  require(coverage.passed && coverage.ratio >= 0.998, "COVERAGE_BELOW_THRESHOLD");
  require(coverage.basis === "explicit-count", "COVERAGE_BASIS_INVALID");
  require(activeSources.length === 1 && activeSources[0] === "tushare", "COMPUTED_SOURCE_INVALID");
  require(quality.computedSources.missingCount === 0, "COMPUTED_SOURCE_MISSING");
  require(quality.counts.referenceOnly === 0, "REFERENCE_ONLY_PRESENT");
  require(quality.counts.quarantined === 0, "QUARANTINED_RECORDS_PRESENT");
  require(audit.deviations.over5To20Bp === 0, "REFERENCE_DEVIATIONS_OVER_5BP");
  require(audit.deviations.over20Bp === 0, "REFERENCE_DEVIATIONS_OVER_20BP");
  require(
    audit.deviations.withoutComparableReference === 0,
    "REFERENCE_COMPARISON_MISSING"
  );
  require(audit.pools.shSzBse.poolEligibleCount === coverage.eligibleCount, "POOL_COVERAGE_MISMATCH");
  require(audit.benchmark.asOf === snapshot.asOf, "BENCHMARK_AS_OF_MISMATCH");
  require(audit.benchmark.baseDate === snapshot.baseDate, "BENCHMARK_BASE_DATE_MISMATCH");
  require(audit.benchmark.endpointAuditPassed, "BENCHMARK_AUDIT_FAILED");
  require(audit.storage.immutableSnapshotMatches, "IMMUTABLE_SNAPSHOT_MISMATCH");
  require(audit.storage.residualArtifactCount === 0, "RESIDUAL_ARTIFACTS_PRESENT");
  require(audit.security.tokenEmbedded === false, "TOKEN_EMBEDDED");
  require(audit.security.sensitiveKeyPaths.length === 0, "SENSITIVE_KEY_PRESENT");
  for (const sentinel of audit.sentinels) {
    const sentinelCode = sentinel.symbol.replace(/[^A-Z0-9]+/g, "_");
    require(sentinel.found, `SENTINEL_${sentinelCode}_MISSING`);
    if (!sentinel.found) continue;
    require(sentinel.isEligible, `SENTINEL_${sentinelCode}_INELIGIBLE`);
    require(sentinel.adjustmentAudit.passed, `SENTINEL_${sentinelCode}_ADJUSTMENT_AUDIT_FAILED`);
    require(
      sentinel.deviationBp != null && sentinel.deviationBp <= 5,
      `SENTINEL_${sentinelCode}_DEVIATION_HIGH`
    );
  }
  return issueCodes(issues);
}

function baseReport(now, args, env) {
  const report = {
    ok: false,
    mode: "first-batch",
    status: "BLOCKED",
    stage: "preflight",
    startedAt: now.toISOString(),
    finishedAt: null,
    requireAsOf: args.requireAsOf,
    expectedMasterCounts: args.expectedMasterCounts,
    tokenConfigured: tokenConfigured(env),
    datePreflight: null,
    publishAttempted: false,
    published: false,
    errorCode: null,
    causeCode: null,
    warningCodes: [],
    diagnostics: null,
    worker: null,
    audit: null
  };
  reportSecretValues.set(report, secretValues(env));
  return report;
}

function finish(report, exitCode) {
  report.finishedAt = new Date().toISOString();
  redactReportSecrets(report, reportSecretValues.get(report) || []);
  reportSecretValues.delete(report);
  return { exitCode, report };
}

function errorResult(report, exitCode, errorCode, causeCode = null) {
  report.ok = false;
  report.errorCode = cleanCode(errorCode);
  report.causeCode = causeCode ? cleanCode(causeCode) : null;
  report.status = exitCode === EXIT.PREFLIGHT ? "BLOCKED" : "FAILED";
  return finish(report, exitCode);
}

async function runFirstBatch(options = {}) {
  const env = options.env || process.env;
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  if (Number.isNaN(now.getTime())) throw new TypeError("first-batch now must be valid");
  let args;
  try {
    args = Array.isArray(options.args) ? parseArguments(options.args) :
      options.args || parseArguments([]);
  } catch (error) {
    const fallbackArgs = {
      requireAsOf: null,
      expectedMasterCounts: null
    };
    return errorResult(baseReport(now, fallbackArgs, env), EXIT.PREFLIGHT, error.code);
  }
  const report = baseReport(now, args, env);
  if (!report.tokenConfigured) {
    return errorResult(report, EXIT.PREFLIGHT, "TUSHARE_TOKEN_NOT_CONFIGURED");
  }
  if (!args.expectedMasterCounts) {
    return errorResult(report, EXIT.PREFLIGHT, "EXPECTED_MASTER_BASELINE_REQUIRED");
  }

  const inspect = options.inspectTarget || inspectTarget;
  try {
    await inspect(args.directory);
  } catch (error) {
    return errorResult(report, EXIT.PREFLIGHT, error.code || "FIRST_BATCH_STORE_CHECK_FAILED");
  }

  if (args.requireAsOf) {
    const dateRunner = options.runDatePreflight || runDatePreflight;
    let dates;
    try {
      dates = await dateRunner({
        env,
        now,
        clients: options.clients || {}
      });
    } catch (error) {
      return errorResult(
        report,
        EXIT.DIAGNOSTIC,
        error.code || "DATE_PREFLIGHT_FAILED"
      );
    }
    report.datePreflight = {
      baseDate: dates.baseDate || null,
      expectedAsOf: dates.expectedAsOf || null
    };
    if (report.datePreflight.expectedAsOf !== args.requireAsOf) {
      return errorResult(report, EXIT.PREFLIGHT, "REQUIRED_AS_OF_NOT_READY");
    }
  }

  const diagnosticRunner = options.runDiagnostic || runSourceDiagnostics;
  let diagnosticResult;
  try {
    diagnosticResult = await diagnosticRunner({
      env,
      now,
      clients: options.clients || {}
    });
  } catch (error) {
    return errorResult(report, EXIT.DIAGNOSTIC, error.code || "SOURCE_DIAGNOSTIC_FAILED");
  }
  const diagnostic = diagnosticResult.report || diagnosticResult;
  report.stage = "diagnostic";
  report.diagnostics = sanitizeDiagnostics(diagnostic);
  if (
    args.requireAsOf &&
    report.diagnostics.tushare.expectedAsOf !== args.requireAsOf
  ) {
    return errorResult(report, EXIT.PREFLIGHT, "REQUIRED_AS_OF_NOT_READY");
  }
  if (
    report.datePreflight &&
    (
      report.datePreflight.expectedAsOf !== report.diagnostics.dates.expectedAsOf ||
      report.datePreflight.baseDate !== report.diagnostics.dates.baseDate
    )
  ) {
    return errorResult(
      report,
      EXIT.DIAGNOSTIC,
      "DATE_PREFLIGHT_DIAGNOSTIC_MISMATCH"
    );
  }
  if (reportHasFailures(diagnostic)) {
    return errorResult(report, EXIT.DIAGNOSTIC, "SOURCE_DIAGNOSTIC_FAILED");
  }
  const diagnosticCounts = report.diagnostics.tushare.counts;
  const baselineMismatch = ["SH", "SZ", "BSE"].find(
    (exchange) =>
      args.expectedMasterCounts[exchange] !==
      diagnosticCounts.masterByExchange[exchange]
  );
  if (baselineMismatch) {
    report.warningCodes = [`EXPECTED_MASTER_${baselineMismatch}_MISMATCH`];
    return errorResult(
      report,
      EXIT.DIAGNOSTIC,
      "EXPECTED_MASTER_BASELINE_MISMATCH",
      report.warningCodes[0]
    );
  }
  const baselineTotal = Object.values(args.expectedMasterCounts).reduce(
    (sum, count) => sum + count,
    0
  );
  if (
    baselineTotal - diagnosticCounts.newListings !==
    diagnosticCounts.expectedUniverse
  ) {
    return errorResult(
      report,
      EXIT.DIAGNOSTIC,
      "EXPECTED_ELIGIBLE_UNIVERSE_MISMATCH"
    );
  }

  report.stage = "publish";
  report.publishAttempted = true;
  const candidateDirectory = path.join(args.directory, "candidate");
  const clients = { ...(options.clients || {}) };
  if (Array.isArray(diagnosticResult.marketRows)) {
    clients.fetchEastmoneyMarket = async () => diagnosticResult.marketRows;
  }
  const workerRunner = options.runWorker || runStockDailyWorker;
  let worker;
  try {
    worker = await workerRunner({
      directory: candidateDirectory,
      env,
      now,
      clients
    });
  } catch (error) {
    return errorResult(
      report,
      EXIT.PUBLISH,
      error.code || "STOCK_REFRESH_FAILED",
      error.details && error.details.causeCode
    );
  }
  report.worker = {
    status: worker.status || null,
    snapshotId: worker.snapshotId || null,
    asOf: worker.asOf || null,
    expectedAsOf: worker.expectedAsOf || null,
    sourceMode: worker.sourceMode || null,
    coverageRatio: round(worker.coverageRatio),
    referenceFailureCode: worker.referenceFailureCode
      ? cleanCode(worker.referenceFailureCode)
      : null,
    calendarFailureCode: worker.calendarFailureCode
      ? cleanCode(worker.calendarFailureCode)
      : null
  };
  report.published = worker.status === "published";
  if (!report.published) {
    return errorResult(report, EXIT.PUBLISH, "FIRST_BATCH_NOT_PUBLISHED");
  }

  report.stage = "audit";
  const artifactReader = options.readArtifact || readPublishedArtifact;
  let artifact;
  try {
    artifact = await artifactReader(candidateDirectory);
    report.audit = buildSnapshotAudit(artifact, env);
  } catch (error) {
    return errorResult(report, EXIT.PUBLISH, error.code || "FIRST_BATCH_AUDIT_FAILED");
  }
  const auditIssues = evaluateSnapshotAudit(report.audit);
  const publishedDiagnosticCounts = report.diagnostics.tushare.counts;
  const diagnosticMasterExchanges = publishedDiagnosticCounts.masterByExchange;
  const diagnosticExpectedExchanges =
    publishedDiagnosticCounts.expectedUniverseByExchange;
  for (const exchange of ["SH", "SZ", "BSE"]) {
    if (
      args.expectedMasterCounts[exchange] !==
      diagnosticMasterExchanges[exchange]
    ) {
      auditIssues.push(`EXPECTED_MASTER_${exchange}_MISMATCH`);
    }
    if (
      diagnosticMasterExchanges[exchange] !==
      report.audit.exchanges[exchange].total
    ) {
      auditIssues.push(`DIAGNOSTIC_PUBLISH_${exchange}_COUNT_MISMATCH`);
    }
    if (
      diagnosticExpectedExchanges[exchange] !==
      report.audit.exchanges[exchange].expected
    ) {
      auditIssues.push(`DIAGNOSTIC_PUBLISH_${exchange}_EXPECTED_MISMATCH`);
    }
  }
  if (diagnosticMasterExchanges.UNKNOWN !== 0) {
    auditIssues.push("DIAGNOSTIC_MASTER_UNKNOWN_EXCHANGE");
  }
  if (
    baselineTotal - report.audit.quality.counts.newListings !==
    report.audit.quality.coverage.expectedCount
  ) {
    auditIssues.push("EXPECTED_ELIGIBLE_UNIVERSE_MISMATCH");
  }
  const marketRows = report.diagnostics.market.rows;
  const masterCount = publishedDiagnosticCounts.masterRecords;
  if (
    marketRows == null || masterCount == null || marketRows <= 0 ||
    masterCount / marketRows < 0.93 || masterCount / marketRows > 1.05
  ) {
    auditIssues.push("INDEPENDENT_MARKET_COUNT_MISMATCH");
  }
  if (
    publishedDiagnosticCounts.expectedUniverse !==
    report.audit.quality.coverage.expectedCount
  ) {
    auditIssues.push("DIAGNOSTIC_PUBLISH_UNIVERSE_MISMATCH");
  }
  if (
    publishedDiagnosticCounts.eligibleComputed !==
    report.audit.quality.coverage.independentCount
  ) {
    auditIssues.push("DIAGNOSTIC_PUBLISH_ELIGIBLE_COUNT_MISMATCH");
  }
  if (
    publishedDiagnosticCounts.computedCoverage !==
    report.audit.quality.coverage.independentRatio
  ) {
    auditIssues.push("DIAGNOSTIC_PUBLISH_COVERAGE_RATIO_MISMATCH");
  }
  if (
    publishedDiagnosticCounts.masterRecords !==
    report.audit.quality.counts.computedInput
  ) {
    auditIssues.push("DIAGNOSTIC_PUBLISH_MASTER_COUNT_MISMATCH");
  }
  if (
    report.diagnostics.dates.expectedAsOf !== report.audit.snapshot.asOf ||
    report.diagnostics.dates.baseDate !== report.audit.snapshot.baseDate
  ) {
    auditIssues.push("DIAGNOSTIC_PUBLISH_DATE_MISMATCH");
  }
  if (
    report.datePreflight &&
    (
      report.datePreflight.expectedAsOf !== report.audit.snapshot.asOf ||
      report.datePreflight.baseDate !== report.audit.snapshot.baseDate
    )
  ) {
    auditIssues.push("DATE_PREFLIGHT_PUBLISH_MISMATCH");
  }
  if (args.requireAsOf && report.audit.snapshot.asOf !== args.requireAsOf) {
    auditIssues.push("REQUIRED_AS_OF_MISMATCH");
  }
  if (auditIssues.length) {
    report.warningCodes = issueCodes(auditIssues);
    return errorResult(
      report,
      EXIT.PUBLISH,
      "FIRST_BATCH_ACCEPTANCE_FAILED",
      auditIssues[0]
    );
  }

  report.ok = true;
  report.status = "PASSED";
  report.stage = "complete";
  report.errorCode = null;
  report.causeCode = null;
  return finish(report, EXIT.PASS);
}

async function main() {
  let result;
  try {
    result = await runFirstBatch({ args: process.argv.slice(2) });
  } catch (error) {
    const now = new Date();
    result = {
      exitCode: EXIT.INTERNAL,
      report: {
        ok: false,
        mode: "first-batch",
        status: "FAILED",
        stage: "internal",
        startedAt: now.toISOString(),
        finishedAt: now.toISOString(),
        requireAsOf: null,
        expectedMasterCounts: null,
        tokenConfigured: tokenConfigured(process.env),
        datePreflight: null,
        publishAttempted: false,
        published: false,
        errorCode: cleanCode(error && error.code),
        causeCode: null,
        warningCodes: [],
        diagnostics: null,
        worker: null,
        audit: null
      }
    };
  }
  console.log(serializeReport(result.report, process.env));
  process.exitCode = result.exitCode;
}

if (require.main === module) {
  main();
}

module.exports = {
  EXIT,
  SENTINELS,
  parseArguments,
  runDatePreflight,
  runSourceDiagnostics,
  sanitizeDiagnostics,
  detectTokenEmbedded,
  redactReportSecrets,
  serializeReport,
  collectSensitiveKeyPaths,
  buildSnapshotAudit,
  evaluateSnapshotAudit,
  runFirstBatch,
  main
};
