"use strict";

const zlib = require("zlib");
const { buildEmSnapshot } = require("../lib/stockEmYtd");
const { validateTradingCalendar } = require("../lib/stockTradingDates");
const {
  publishSnapshot,
  requestGithubOidcToken
} = require("./publish-free-stock-ytd");

const DEFAULT_SNAPSHOT_URL = "https://1.688680.xyz/api/stock-snapshot";

function parseArguments(argv) {
  const args = {
    publishUrl: process.env.STOCK_PUBLISH_URL || null,
    snapshotUrl: process.env.STOCK_SNAPSHOT_GATEWAY_URL || DEFAULT_SNAPSHOT_URL,
    dryRun: false,
    force: false,
    requireAsOf: null
  };
  for (const value of argv) {
    if (value === "--dry-run") args.dryRun = true;
    else if (value === "--force") args.force = true;
    else if (value.startsWith("--publish-url=")) args.publishUrl = value.slice(14);
    else if (value.startsWith("--snapshot-url=")) args.snapshotUrl = value.slice(15);
    else if (value.startsWith("--require-as-of=")) {
      const requireAsOf = value.slice(16);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(requireAsOf)) {
        throw new TypeError("--require-as-of must be YYYY-MM-DD");
      }
      args.requireAsOf = requireAsOf;
    } else throw new TypeError(`unknown argument: ${value}`);
  }
  if (!args.dryRun && !args.publishUrl) {
    throw new TypeError("--publish-url is required");
  }
  return args;
}

// 交易日历随 Published envelope 持久化滚动；worker 从当前快照网关取回复用。
async function loadCurrentEnvelope(snapshotUrl, options = {}) {
  const response = await (options.fetchImpl || fetch)(snapshotUrl, {
    headers: { "Accept-Encoding": "gzip" },
    signal: AbortSignal.timeout(Number(options.timeoutMs) || 30000)
  });
  if (!response.ok) {
    throw new Error(`snapshot gateway responded with HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (!payload || typeof payload !== "object" || !payload.tradingCalendar) {
    throw new Error("snapshot gateway response is missing tradingCalendar");
  }
  return payload;
}

function summary(build, extra = {}) {
  const snapshot = build.candidate;
  return {
    ok: true,
    dryRun: Boolean(extra.dryRun),
    noOp: Boolean(extra.noOp),
    asOf: snapshot ? snapshot.asOf : extra.asOf || null,
    baseDate: snapshot ? snapshot.baseDate : null,
    sourceMode: snapshot ? snapshot.sourceMode : null,
    methodologyVersion: snapshot ? snapshot.methodologyVersion : null,
    expectedUniverseCount: snapshot ? snapshot.quality.coverage.expectedCount : null,
    eligibleCount: snapshot ? snapshot.quality.coverage.eligibleCount : null,
    coverageRatio: snapshot ? snapshot.quality.coverage.ratio : null,
    sentinel: build.sentinel ? build.sentinel.results : null,
    stats: build.stats || null,
    compressedBytes: extra.compressedBytes || null,
    snapshotId: extra.snapshotId || null
  };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  const envelope = await loadCurrentEnvelope(args.snapshotUrl);
  const tradingCalendar = validateTradingCalendar(envelope.tradingCalendar);
  const build = await buildEmSnapshot({
    tradingCalendar,
    requireAsOf: args.requireAsOf,
    now: new Date()
  });

  const currentAsOf = envelope.snapshot && envelope.snapshot.asOf;
  if (
    !args.force &&
    !args.dryRun &&
    currentAsOf === build.candidate.asOf &&
    envelope.snapshot.methodologyVersion === build.candidate.methodologyVersion
  ) {
    console.log(JSON.stringify(summary({}, { noOp: true, asOf: currentAsOf })));
    return;
  }

  if (args.dryRun) {
    console.log(JSON.stringify(summary(build, { dryRun: true })));
    return;
  }

  const published = await publishSnapshot(
    {
      candidate: build.candidate,
      tradingCalendar: build.tradingCalendar,
      warningCodes: []
    },
    args.publishUrl
  );
  console.log(JSON.stringify(summary(build, {
    compressedBytes: published.compressedBytes,
    snapshotId: published.result.publish && published.result.publish.snapshotId
  })));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      error: error && error.code ? String(error.code) : "STOCK_EM_REFRESH_FAILED",
      details: error && error.details ? error.details : null,
      message: error && error.message ? String(error.message).slice(0, 240) : null
    }));
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_SNAPSHOT_URL,
  parseArguments,
  loadCurrentEnvelope,
  summary,
  main
};
