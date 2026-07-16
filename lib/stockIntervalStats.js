"use strict";

// 区间涨跌分布核心：从两份 Published 快照合成区间收益并分桶。
// 口径与精度声明见 docs/stock-ytd-ranking/INTERVAL_STATS.md：
//   区间收益 = (1 + YTD_今) ÷ (1 + YTD_基) − 1
// 送转场景严格恒等；现金分红为仿射修正，偏差典型 <0.5pp。

const DECLINE_THRESHOLDS_PCT = Object.freeze([10, 15, 20, 25, 30, 35, 40, 45, 50, 60, 70, 80]);
const GAIN_THRESHOLDS_PCT = Object.freeze([10, 15, 20, 25, 30, 35, 40, 45, 50, 60, 80, 100]);
const MAX_LIST_LIMIT = 200;
// 合成除法带来 ~1e-16 级浮点噪声；数据粒度为 1e-4（f25 两位小数百分比），
// 用 1e-9 容差保证"恰好等于阈值"不被误判为严格超过。
const THRESHOLD_EPSILON = 1e-9;

function intervalStatsError(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  return error;
}

function normalizeExchange(value) {
  return value === "BJ" ? "BSE" : value;
}

// Published 快照 → 紧凑映射。只保留区间统计必需字段，
// 结果按 snapshotId 不可变，调用方可无限期缓存。
function extractYtdMap(snapshot) {
  if (
    !snapshot ||
    typeof snapshot !== "object" ||
    !Array.isArray(snapshot.records) ||
    typeof snapshot.asOf !== "string" ||
    typeof snapshot.baseDate !== "string"
  ) {
    throw intervalStatsError("INVALID_SNAPSHOT", "snapshot is missing records or dates");
  }
  const records = Object.create(null);
  for (const record of snapshot.records) {
    if (!record || typeof record.symbol !== "string") continue;
    const exchange = normalizeExchange(record.exchange);
    if (!["SH", "SZ", "BSE"].includes(exchange)) continue;
    const eligible = record.isEligible === true &&
      Number.isFinite(record.ytd) &&
      record.ytd > -1;
    records[record.symbol] = {
      code: record.code || record.symbol.slice(0, 6),
      name: record.name || null,
      exchange,
      ytd: eligible ? record.ytd : null,
      lastPriceDate: record.lastPriceDate || null,
      ineligibilityReason: eligible ? null : (record.ineligibilityReason || "INELIGIBLE")
    };
  }
  return {
    snapshotId: snapshot.snapshotId || null,
    asOf: snapshot.asOf,
    baseDate: snapshot.baseDate,
    methodologyVersion: snapshot.methodologyVersion || null,
    records
  };
}

function assertComposablePair(baseMap, currentMap) {
  if (!baseMap || !currentMap || !baseMap.records || !currentMap.records) {
    throw intervalStatsError("INVALID_SNAPSHOT", "both ytd maps are required");
  }
  if (baseMap.baseDate !== currentMap.baseDate) {
    throw intervalStatsError(
      "BASE_YEAR_MISMATCH",
      "base snapshot belongs to a different year base date",
      { base: baseMap.baseDate, current: currentMap.baseDate }
    );
  }
  if (!(baseMap.asOf < currentMap.asOf)) {
    throw intervalStatsError(
      "INVALID_BASE_DATE",
      "base date must be earlier than the current snapshot asOf",
      { baseAsOf: baseMap.asOf, currentAsOf: currentMap.asOf }
    );
  }
}

function computeIntervalStats(baseMap, currentMap, options = {}) {
  assertComposablePair(baseMap, currentMap);
  const includeBse = options.includeBse === true;
  const inScope = (exchange) => exchange === "SH" || exchange === "SZ" ||
    (includeBse && exchange === "BSE");

  const matched = [];
  let suspendedCount = 0;
  let excludedNewSinceBase = 0;
  let excludedIneligible = 0;

  for (const symbol of Object.keys(currentMap.records)) {
    const current = currentMap.records[symbol];
    if (!inScope(current.exchange)) continue;
    if (current.ytd == null) {
      excludedIneligible += 1;
      continue;
    }
    const base = baseMap.records[symbol];
    if (!base) {
      excludedNewSinceBase += 1;
      continue;
    }
    if (base.ytd == null) {
      if (base.ineligibilityReason === "NEW_LISTING") excludedNewSinceBase += 1;
      else excludedIneligible += 1;
      continue;
    }
    const intervalReturn = (1 + current.ytd) / (1 + base.ytd) - 1;
    if (!Number.isFinite(intervalReturn)) {
      excludedIneligible += 1;
      continue;
    }
    const isSuspended = Boolean(
      current.lastPriceDate && current.lastPriceDate < currentMap.asOf
    );
    if (isSuspended) suspendedCount += 1;
    matched.push({
      symbol,
      code: current.code,
      name: current.name,
      exchange: current.exchange,
      intervalReturn,
      isSuspended
    });
  }

  let excludedMissingCurrent = 0;
  for (const symbol of Object.keys(baseMap.records)) {
    const base = baseMap.records[symbol];
    if (!inScope(base.exchange) || base.ytd == null) continue;
    if (!currentMap.records[symbol]) excludedMissingCurrent += 1;
  }

  matched.sort((left, right) =>
    left.intervalReturn - right.intervalReturn ||
    left.symbol.localeCompare(right.symbol));

  // "跌超 30%" 为严格超过：intervalReturn < -0.30（含浮点容差）；涨幅同理。
  const declines = DECLINE_THRESHOLDS_PCT.map((thresholdPct) => ({
    thresholdPct,
    count: matched.reduce(
      (total, record) =>
        total + (record.intervalReturn < -thresholdPct / 100 - THRESHOLD_EPSILON ? 1 : 0),
      0
    )
  }));
  const gains = GAIN_THRESHOLDS_PCT.map((thresholdPct) => ({
    thresholdPct,
    count: matched.reduce(
      (total, record) =>
        total + (record.intervalReturn > thresholdPct / 100 + THRESHOLD_EPSILON ? 1 : 0),
      0
    )
  }));

  return {
    baseDate: baseMap.asOf,
    asOf: currentMap.asOf,
    yearBaseDate: currentMap.baseDate,
    methodologyVersions: {
      base: baseMap.methodologyVersion,
      current: currentMap.methodologyVersion
    },
    includeBse,
    matchedCount: matched.length,
    suspendedCount,
    excluded: {
      newSinceBase: excludedNewSinceBase,
      missingCurrent: excludedMissingCurrent,
      ineligible: excludedIneligible
    },
    declines,
    gains,
    records: matched
  };
}

// 名单钻取：thresholdPct 负数为"跌超"（升序），正数为"涨超"（降序）。
function sliceThresholdList(stats, thresholdPct, options = {}) {
  if (!stats || !Array.isArray(stats.records)) {
    throw intervalStatsError("INVALID_SNAPSHOT", "interval stats are required");
  }
  const threshold = Number(thresholdPct);
  if (!Number.isFinite(threshold) || threshold === 0) {
    throw intervalStatsError("INVALID_LIST_PARAMS", "list threshold must be a non-zero percent");
  }
  const limit = Math.min(
    MAX_LIST_LIMIT,
    Math.max(1, Number.isFinite(Number(options.limit)) ? Math.floor(Number(options.limit)) : 100)
  );
  const offset = Math.max(
    0,
    Number.isFinite(Number(options.offset)) ? Math.floor(Number(options.offset)) : 0
  );
  const bound = threshold / 100;
  const hits = threshold < 0
    ? stats.records.filter((record) => record.intervalReturn < bound - THRESHOLD_EPSILON)
    : stats.records.filter((record) => record.intervalReturn > bound + THRESHOLD_EPSILON).reverse();
  return {
    thresholdPct: threshold,
    total: hits.length,
    limit,
    offset,
    items: hits.slice(offset, offset + limit)
  };
}

module.exports = {
  DECLINE_THRESHOLDS_PCT,
  GAIN_THRESHOLDS_PCT,
  MAX_LIST_LIMIT,
  extractYtdMap,
  computeIntervalStats,
  sliceThresholdList
};
