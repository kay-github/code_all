"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { fetchEastmoneyMarket } = require("../lib/stockSources");
const { filterEastmoneyReferences, buildCandidate } = require("../lib/stockDailyWorker");
const { createTradingCalendar } = require("../lib/stockTradingDates");
const { GITHUB_OIDC_AUDIENCE } = require("../lib/stockPublishAuth");

const DATASET_VERSION = "free-stock-ytd-dataset.v1";
const MAX_COMPRESSED_BYTES = 4 * 1024 * 1024;
const EASTMONEY_MARKET_URLS = Object.freeze([
  "https://push2.eastmoney.com/api/qt/clist/get",
  "https://push2delay.eastmoney.com/api/qt/clist/get"
]);

function parseArguments(argv) {
  const args = {
    input: null,
    publishUrl: process.env.STOCK_PUBLISH_URL || null,
    dryRun: false,
    skipReference: false,
    snapshotOutput: null
  };
  for (const value of argv) {
    if (value === "--dry-run") args.dryRun = true;
    else if (value === "--skip-reference") args.skipReference = true;
    else if (value.startsWith("--input=")) args.input = value.slice(8);
    else if (value.startsWith("--publish-url=")) args.publishUrl = value.slice(14);
    else if (value.startsWith("--snapshot-output=")) args.snapshotOutput = value.slice(18);
    else throw new TypeError(`unknown argument: ${value}`);
  }
  if (!args.input) throw new TypeError("--input is required");
  if (!args.dryRun && !args.publishUrl) throw new TypeError("--publish-url is required");
  return args;
}

function readDataset(filename) {
  const resolved = path.resolve(filename);
  const stat = fs.statSync(resolved);
  if (!stat.isFile() || stat.size <= 0 || stat.size > 30 * 1024 * 1024) {
    throw new Error("free stock dataset file is invalid");
  }
  const dataset = JSON.parse(fs.readFileSync(resolved, "utf8"));
  if (
    !dataset ||
    dataset.version !== DATASET_VERSION ||
    dataset.diagnosticOnly === true ||
    !Array.isArray(dataset.computedRecords) ||
    !Array.isArray(dataset.indexRows) ||
    !dataset.tradingCalendar ||
    !Array.isArray(dataset.tradingCalendar.rows)
  ) {
    throw new Error("free stock dataset contract is invalid");
  }
  return dataset;
}

async function loadReferenceRecords(dataset, options = {}) {
  if (options.skipReference) {
    return { records: [], warningCode: "REFERENCE_SKIPPED" };
  }
  const fetchMarket = options.fetchEastmoneyMarket || fetchEastmoneyMarket;
  const baseUrls = options.eastmoneyBaseUrls || EASTMONEY_MARKET_URLS;
  let rows = null;
  let lastError = null;
  for (const baseUrl of baseUrls) {
    try {
      rows = await fetchMarket({
        retries: 3,
        timeoutMs: 10000,
        pageDelayMs: 150,
        baseUrl
      });
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!rows) {
    return {
      records: [],
      warningCode: lastError && lastError.code
        ? String(lastError.code)
        : "REFERENCE_SOURCE_UNAVAILABLE"
    };
  }
  try {
    const currentRows = rows.filter(
      (row) => row && row.sourceAsOf === dataset.asOf && row.ytd != null
    );
    return {
      records: filterEastmoneyReferences(currentRows, dataset.computedRecords),
      warningCode: currentRows.length ? null : "REFERENCE_DATE_UNAVAILABLE"
    };
  } catch (error) {
    return {
      records: [],
      warningCode: error && error.code ? String(error.code) : "REFERENCE_SOURCE_UNAVAILABLE"
    };
  }
}

async function buildCandidateFromDataset(dataset, options = {}) {
  const reference = await loadReferenceRecords(dataset, options);
  const build = (referenceRecords) => buildCandidate({
    asOf: dataset.asOf,
    baseDate: dataset.baseDate,
    computedRecords: dataset.computedRecords,
    referenceRecords,
    expectedUniverseCount: dataset.expectedUniverseCount,
    indexRows: dataset.indexRows,
    benchmarkSource: dataset.benchmarkSource || "baostock",
    generatedAt: dataset.generatedAt,
    publishedAt: dataset.generatedAt,
    methodologyVersion: "adjusted-ytd.v2",
    poolVersion: "official-a-share.v2"
  });
  let candidate;
  let warningCodes = [reference.warningCode].filter(Boolean);
  try {
    candidate = build(reference.records);
  } catch (error) {
    const quality = error && error.quality;
    const referenceQualityFailed =
      error && error.code === "SNAPSHOT_NOT_PUBLISHABLE" &&
      quality &&
      Number(quality.counts && quality.counts.quarantined) > 0;
    if (!referenceQualityFailed || reference.records.length === 0) throw error;
    candidate = build([]);
    warningCodes.push("REFERENCE_VALIDATION_REJECTED");
  }
  const tradingCalendar = createTradingCalendar(dataset.tradingCalendar.rows, {
    coveredFrom: dataset.tradingCalendar.coveredFrom,
    coveredThrough: dataset.tradingCalendar.coveredThrough
  });
  return {
    candidate,
    tradingCalendar,
    warningCodes
  };
}

async function requestGithubOidcToken(options = {}) {
  const requestUrl = options.requestUrl || process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = options.requestToken || process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) return null;
  const url = new URL(requestUrl);
  url.searchParams.set("audience", GITHUB_OIDC_AUDIENCE);
  const response = await (options.fetchImpl || fetch)(url, {
    headers: { Authorization: `Bearer ${requestToken}` },
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error("GitHub OIDC token request failed");
  const payload = await response.json();
  if (!payload || typeof payload.value !== "string" || !payload.value) {
    throw new Error("GitHub OIDC token response is invalid");
  }
  return payload.value;
}

async function publishSnapshot(build, publishUrl, options = {}) {
  const token = options.token || process.env.STOCK_PUBLISH_TOKEN ||
    await requestGithubOidcToken(options);
  if (!token) throw new Error("stock publish authorization is unavailable");
  const payload = {
    snapshot: build.candidate,
    expectedAsOf: build.candidate.asOf,
    refreshedAt: new Date().toISOString(),
    warningCodes: build.warningCodes,
    tradingCalendar: build.tradingCalendar
  };
  const body = zlib.gzipSync(Buffer.from(JSON.stringify(payload)), {
    level: zlib.constants.Z_BEST_COMPRESSION,
    mtime: 0
  });
  if (body.length > MAX_COMPRESSED_BYTES) {
    throw new Error("compressed stock snapshot exceeds publish limit");
  }
  const response = await (options.fetchImpl || fetch)(publishUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/gzip",
      "Content-Length": String(body.length)
    },
    body,
    signal: AbortSignal.timeout(90000)
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result || result.ok !== true) {
    throw new Error(`stock publish failed with HTTP ${response.status}`);
  }
  return { result, compressedBytes: body.length };
}

function summary(build, extra = {}) {
  const snapshot = build.candidate;
  return {
    ok: true,
    dryRun: Boolean(extra.dryRun),
    asOf: snapshot.asOf,
    baseDate: snapshot.baseDate,
    sourceMode: snapshot.sourceMode,
    computedSources: snapshot.quality.computedSources.active,
    expectedUniverseCount: snapshot.quality.coverage.expectedCount,
    eligibleCount: snapshot.quality.coverage.eligibleCount,
    coverageRatio: snapshot.quality.coverage.ratio,
    warningCodes: build.warningCodes,
    compressedBytes: extra.compressedBytes || null,
    snapshotId: extra.snapshotId || null
  };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  const dataset = readDataset(args.input);
  const build = await buildCandidateFromDataset(dataset, {
    skipReference: args.skipReference
  });
  if (args.snapshotOutput) {
    fs.writeFileSync(path.resolve(args.snapshotOutput), JSON.stringify({
      snapshot: build.candidate,
      tradingCalendar: build.tradingCalendar,
      warningCodes: build.warningCodes
    }));
  }
  if (args.dryRun) {
    console.log(JSON.stringify(summary(build, { dryRun: true })));
    return;
  }
  const published = await publishSnapshot(build, args.publishUrl);
  console.log(JSON.stringify(summary(build, {
    compressedBytes: published.compressedBytes,
    snapshotId: published.result.publish && published.result.publish.snapshotId
  })));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      error: error && error.code ? String(error.code) : "FREE_STOCK_PUBLISH_FAILED"
    }));
    process.exit(1);
  });
}

module.exports = {
  EASTMONEY_MARKET_URLS,
  parseArguments,
  readDataset,
  loadReferenceRecords,
  buildCandidateFromDataset,
  requestGithubOidcToken,
  publishSnapshot,
  summary,
  main
};
