"use strict";

const { createStockSnapshotBlobStore } = require("../lib/stockSnapshotBlobStore");
const {
  StockPublishedSnapshotError,
  loadStockSnapshot
} = require("../lib/stockPublishedSnapshot");
const {
  extractYtdMap,
  computeIntervalStats,
  sliceThresholdList
} = require("../lib/stockIntervalStats");

const DATES_CACHE_TTL_MS = 60 * 60 * 1000;
const MAP_CACHE_MAX_ENTRIES = 16;
const STATS_CACHE_MAX_ENTRIES = 32;
const PRECISION_NOTE = "区间涨跌幅为前复权口径合成值，整体精度约 ±0.5 个百分点，个股精确值以行情软件为准。";

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

function parseIncludeBse(value) {
  if (value == null || value === "") return false;
  if (value === true || value === "true" || value === "1") return true;
  if (value === false || value === "false" || value === "0") return false;
  return null;
}

function boundedSet(map, key, value, maxEntries) {
  if (!map.has(key) && map.size >= maxEntries) {
    map.delete(map.keys().next().value);
  }
  map.set(key, value);
}

function createHandler(options = {}) {
  const load = options.loadStockSnapshot || loadStockSnapshot;
  const store = options.store || createStockSnapshotBlobStore(options.storeOptions);
  const logger = options.logger || console;
  const now = typeof options.now === "function" ? options.now : Date.now;

  // 不可变快照派生数据的进程内缓存：基准日映射按日期、
  // 统计结果按 (基准日, 当前快照, 池) 键控，实例生命周期内有效。
  const baseMapCache = new Map();
  const currentMapCache = new Map();
  const statsCache = new Map();
  let datesCache = null;

  async function availableBaseDates(currentAsOf) {
    if (!datesCache || now() - datesCache.fetchedAt > DATES_CACHE_TTL_MS) {
      datesCache = {
        fetchedAt: now(),
        dates: await store.listAvailableSnapshotDates()
      };
    }
    return datesCache.dates.filter((date) => date < currentAsOf);
  }

  async function resolveBaseMap(baseDate) {
    const cached = baseMapCache.get(baseDate);
    if (cached) return cached;
    const loaded = await store.loadLatestSnapshotForDate(baseDate);
    if (!loaded) return null;
    const map = extractYtdMap(loaded.snapshot);
    boundedSet(baseMapCache, baseDate, map, MAP_CACHE_MAX_ENTRIES);
    return map;
  }

  function resolveCurrentMap(snapshot) {
    const key = snapshot.snapshotId || snapshot.asOf;
    const cached = currentMapCache.get(key);
    if (cached) return cached;
    const map = extractYtdMap(snapshot);
    boundedSet(currentMapCache, key, map, MAP_CACHE_MAX_ENTRIES);
    return map;
  }

  return async function handler(req, res) {
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

    try {
      const loaded = await load();
      const snapshot = loaded.snapshot;
      const meta = {
        asOf: snapshot.asOf,
        expectedAsOf: snapshot.expectedAsOf,
        publishedAt: snapshot.publishedAt || null,
        isStale: Boolean(snapshot.isStale),
        dataMode: loaded.mode,
        warning: loaded.warning || snapshot.dataWarning || null,
        periodResetRequired: Boolean(snapshot.periodResetRequired),
        calendarCoverageExpired: Boolean(snapshot.calendarCoverageExpired)
      };

      if (readQueryValue(req, "dates") === "1") {
        sendJson(res, 200, {
          ...meta,
          availableBaseDates: await availableBaseDates(snapshot.asOf)
        });
        return;
      }

      const baseDate = String(readQueryValue(req, "baseDate") || "").trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(baseDate) || baseDate >= snapshot.asOf) {
        sendJson(res, 400, {
          error: "INVALID_BASE_DATE",
          message: "baseDate 必须为早于最新交易日的 YYYY-MM-DD 日期"
        });
        return;
      }
      const includeBse = parseIncludeBse(readQueryValue(req, "includeBse"));
      if (includeBse == null) {
        sendJson(res, 400, {
          error: "INVALID_INCLUDE_BSE",
          message: "includeBse 只能为 true 或 false"
        });
        return;
      }

      const baseMap = await resolveBaseMap(baseDate);
      if (!baseMap) {
        sendJson(res, 404, {
          error: "BASE_SNAPSHOT_MISSING",
          message: "该日期没有可用的历史快照",
          availableBaseDates: await availableBaseDates(snapshot.asOf)
        });
        return;
      }

      const statsKey = `${baseDate}|${snapshot.snapshotId || snapshot.asOf}|${includeBse}`;
      let stats = statsCache.get(statsKey);
      if (!stats) {
        stats = computeIntervalStats(baseMap, resolveCurrentMap(snapshot), { includeBse });
        boundedSet(statsCache, statsKey, stats, STATS_CACHE_MAX_ENTRIES);
      }

      const listValue = readQueryValue(req, "list");
      if (listValue != null && listValue !== "") {
        const thresholdPct = Number(listValue);
        const limitValue = readQueryValue(req, "limit");
        const offsetValue = readQueryValue(req, "offset");
        const limit = limitValue == null || limitValue === "" ? undefined : Number(limitValue);
        const offset = offsetValue == null || offsetValue === "" ? undefined : Number(offsetValue);
        if (
          !Number.isFinite(thresholdPct) || thresholdPct === 0 ||
          (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) ||
          (offset !== undefined && (!Number.isInteger(offset) || offset < 0))
        ) {
          sendJson(res, 400, {
            error: "INVALID_LIST_PARAMS",
            message: "list 必须为非零百分数，limit/offset 必须为非负整数"
          });
          return;
        }
        const list = sliceThresholdList(stats, thresholdPct, { limit, offset });
        sendJson(res, 200, {
          ...meta,
          baseDate: stats.baseDate,
          includeBse,
          list: {
            ...list,
            items: list.items.map((item) => ({
              symbol: item.symbol,
              code: item.code,
              name: item.name,
              exchange: item.exchange,
              intervalReturn: item.intervalReturn,
              isSuspended: item.isSuspended
            }))
          }
        });
        return;
      }

      sendJson(res, 200, {
        ...meta,
        baseDate: stats.baseDate,
        yearBaseDate: stats.yearBaseDate,
        methodologyVersions: stats.methodologyVersions,
        includeBse,
        matchedCount: stats.matchedCount,
        suspendedCount: stats.suspendedCount,
        excluded: stats.excluded,
        declines: stats.declines,
        gains: stats.gains,
        precisionNote: PRECISION_NOTE
      });
    } catch (error) {
      if (error && error.code === "BASE_YEAR_MISMATCH") {
        sendJson(res, 409, {
          error: "BASE_YEAR_MISMATCH",
          message: "基准日与当前快照属于不同年度基期，暂不支持跨年区间"
        });
        return;
      }
      if (error && error.code === "INVALID_BASE_DATE") {
        sendJson(res, 400, {
          error: "INVALID_BASE_DATE",
          message: "baseDate 必须为早于最新交易日的 YYYY-MM-DD 日期"
        });
        return;
      }
      const knownDataError = error instanceof StockPublishedSnapshotError ||
        (error && (
          error.code === "SNAPSHOT_NOT_PUBLISHABLE" ||
          /^STOCK_SNAPSHOT_/.test(String(error.code || ""))
        ));
      if (!knownDataError) {
        logger.error("stock interval stats internal error", {
          name: error && error.name,
          code: error && error.code
        });
      }
      sendJson(res, knownDataError ? 503 : 500, knownDataError
        ? {
            error: "STOCK_DATA_UNAVAILABLE",
            message: "股票数据暂未准备好，请稍后重试"
          }
        : {
            error: "INTERNAL_ERROR",
            message: "区间统计服务暂时不可用"
          });
    }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
module.exports.parseIncludeBse = parseIncludeBse;
