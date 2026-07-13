"use strict";

const { buildStockSnapshot } = require("./stockSnapshot");

const BASE_DATE = "2025-12-31";
const AS_OF = "2026-07-10";
const PUBLISHED_AT = "2026-07-10T18:40:00+08:00";
const FIXTURE_WARNING = "当前为开发演示数据，尚未接入生产市场快照";

const STOCKS = [
  {
    symbol: "300502.SZ",
    name: "新易盛",
    exchange: "SZ",
    board: "创业板",
    listingDate: "2016-03-03",
    ytd: 0.7034296563830167
  },
  {
    symbol: "600519.SH",
    name: "贵州茅台",
    exchange: "SH",
    board: "主板",
    listingDate: "2001-08-27",
    ytd: -0.10686384673084504
  },
  {
    symbol: "688001.SH",
    name: "科创板样本",
    exchange: "SH",
    board: "科创板",
    listingDate: "2020-01-01",
    ytd: 0.3421
  },
  {
    symbol: "600000.SH",
    name: "沪市样本",
    exchange: "SH",
    board: "主板",
    listingDate: "1999-11-10",
    ytd: 0.0812
  },
  {
    symbol: "000001.SZ",
    name: "深市样本",
    exchange: "SZ",
    board: "主板",
    listingDate: "1991-04-03",
    ytd: -0.0215
  },
  {
    symbol: "002594.SZ",
    name: "中小盘样本",
    exchange: "SZ",
    board: "主板",
    listingDate: "2011-06-30",
    ytd: 0.1542
  },
  {
    symbol: "920001.BJ",
    name: "北交所样本",
    exchange: "BJ",
    board: "北交所",
    listingDate: "2021-11-15",
    ytd: 0.2511
  },
  {
    symbol: "600001.SH",
    name: "停牌样本",
    exchange: "SH",
    board: "主板",
    listingDate: "2000-01-01",
    ytd: 0,
    basePriceDate: "2025-12-30",
    lastPriceDate: "2025-12-30"
  },
  {
    symbol: "301999.SZ",
    name: "当年新股样本",
    exchange: "SZ",
    board: "创业板",
    listingDate: "2026-05-01",
    ineligibilityReason: "NEW_LISTING"
  }
];

function isProductionRuntime(env = process.env) {
  return env.VERCEL_ENV === "production" ||
    (!env.VERCEL_ENV && env.NODE_ENV === "production");
}

function fixtureEnabled(env = process.env) {
  if (isProductionRuntime(env)) return false;
  if (env.STOCK_YTD_FIXTURE_ENABLED === "0") return false;
  return true;
}

function computedRecord(stock) {
  const basePriceDate = stock.basePriceDate || BASE_DATE;
  const lastPriceDate = stock.lastPriceDate || AS_OF;
  const common = {
    symbol: stock.symbol,
    code: stock.symbol.slice(0, 6),
    name: stock.name,
    exchange: stock.exchange,
    board: stock.board,
    securityType: "A_SHARE",
    listingStatus: "LISTED",
    listingDate: stock.listingDate,
    source: "tushare",
    sourceAsOf: AS_OF,
    baseDate: BASE_DATE
  };

  if (stock.ineligibilityReason) {
    return {
      ...common,
      computedYtd: null,
      basePriceDate: null,
      lastPriceDate: null,
      baseRawClose: null,
      baseAdjFactor: null,
      baseAdjFactorDate: null,
      lastRawClose: null,
      lastAdjFactor: null,
      lastAdjFactorDate: null,
      ineligibilityReason: stock.ineligibilityReason
    };
  }

  const baseRawClose = 100;
  const baseAdjFactor = 1;
  const lastAdjFactor = 1;
  const lastRawClose = baseRawClose * (1 + stock.ytd);
  return {
    ...common,
    computedYtd: stock.ytd,
    basePriceDate,
    lastPriceDate,
    baseRawClose,
    baseAdjFactor,
    baseAdjFactorDate: basePriceDate,
    lastRawClose,
    lastAdjFactor,
    lastAdjFactorDate: lastPriceDate,
    ineligibilityReason: null
  };
}

function referenceRecord(stock) {
  if (stock.ineligibilityReason) return null;
  return {
    symbol: stock.symbol,
    code: stock.symbol.slice(0, 6),
    name: stock.name,
    exchange: stock.exchange,
    board: stock.board,
    referenceYtd: Math.round(stock.ytd * 10000) / 10000,
    source: "eastmoney",
    sourceAsOf: AS_OF
  };
}

function createFixtureSnapshot() {
  const snapshot = buildStockSnapshot({
    asOf: AS_OF,
    expectedAsOf: AS_OF,
    baseDate: BASE_DATE,
    expectedBaseDate: BASE_DATE,
    computedRecords: STOCKS.map(computedRecord),
    referenceRecords: STOCKS.map(referenceRecord).filter(Boolean),
    expectedUniverseCount: STOCKS.filter(
      (stock) => !stock.ineligibilityReason
    ).length,
    minCoverageRatio: 1,
    generatedAt: PUBLISHED_AT,
    publishedAt: PUBLISHED_AT,
    methodologyVersion: "adjusted-ytd.v1-fixture",
    poolVersion: "a-share.v1-fixture"
  });

  return {
    ...snapshot,
    dataMode: "fixture",
    dataWarning: FIXTURE_WARNING,
    benchmark: {
      symbol: "000300.SH",
      name: "沪深300（价格指数）",
      type: "PRICE_INDEX",
      ytd: 0.0526,
      asOf: AS_OF,
      baseDate: BASE_DATE
    }
  };
}

let cachedSnapshot;

function getFixtureSnapshot() {
  if (!cachedSnapshot) {
    cachedSnapshot = createFixtureSnapshot();
  }
  return cachedSnapshot;
}

module.exports = {
  BASE_DATE,
  AS_OF,
  PUBLISHED_AT,
  FIXTURE_WARNING,
  isProductionRuntime,
  fixtureEnabled,
  createFixtureSnapshot,
  getFixtureSnapshot
};
