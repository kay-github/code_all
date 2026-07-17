"use strict";

const zlib = require("zlib");
const { buildEmSnapshot } = require("../lib/stockEmYtd");
const { validateTradingCalendar } = require("../lib/stockTradingDates");
const {
  publishSnapshot,
  requestGithubOidcToken
} = require("./publish-free-stock-ytd");
const { uploadDay, resolveToken } = require("./upload-interval-daily");

const INTERVAL_DAILY_VERSION = "stock-ytd-interval-daily.v1";
const INTERVAL_DAILY_METHODOLOGY = "snapshot-em-f25.v1";

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

// Phase 2.5：快照发布成功后顺带写当日 interval/daily 文件，让该日日后作为
// 基准日时的冷查询走 ~100KB 日频快路径而非整包快照。精度与快照相同
//（东财 f25 口径）；回填任务重跑时会以更高精度的 backfill-qfq.v1 覆盖同名文件。
function snapshotIntervalDailyPayload(candidate) {
  const records = {};
  for (const record of candidate.records || []) {
    if (!record || record.isEligible !== true) continue;
    if (typeof record.symbol !== "string") continue;
    if (!Number.isFinite(record.ytd) || record.ytd <= -1) continue;
    const entry = { exchange: record.exchange, ytd: record.ytd };
    if (record.lastPriceDate && record.lastPriceDate !== candidate.asOf) {
      entry.lastPriceDate = record.lastPriceDate;
    }
    records[record.symbol] = entry;
  }
  const payload = {
    version: INTERVAL_DAILY_VERSION,
    asOf: candidate.asOf,
    baseDate: candidate.baseDate,
    methodologyVersion: INTERVAL_DAILY_METHODOLOGY,
    generatedAt: candidate.generatedAt || candidate.publishedAt,
    records
  };
  const close = candidate.benchmark && candidate.benchmark.currentClose;
  if (Number.isFinite(close) && close > 0) payload.csi300Close = close;
  return payload;
}

// 上传失败不推翻已成功的快照发布：该日仅退回快照慢路径，正确性不受影响。
async function uploadSnapshotIntervalDaily(candidate, publishUrl, options = {}) {
  try {
    const payload = snapshotIntervalDailyPayload(candidate);
    const token = await resolveToken(options);
    const result = await uploadDay(publishUrl, candidate.asOf, payload, token, options);
    return { ok: true, day: result.day, recordCount: result.recordCount };
  } catch (error) {
    return {
      ok: false,
      day: candidate.asOf,
      error: String(error && error.message || error).slice(0, 200)
    };
  }
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
    snapshotId: extra.snapshotId || null,
    intervalDaily: extra.intervalDaily || null
  };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  const envelope = await loadCurrentEnvelope(args.snapshotUrl);
  const tradingCalendar = validateTradingCalendar(envelope.tradingCalendar);
  const currentAsOf = envelope.snapshot && envelope.snapshot.asOf;
  let build;
  try {
    build = await buildEmSnapshot({
      tradingCalendar,
      requireAsOf: args.requireAsOf,
      now: new Date()
    });
  } catch (error) {
    // 盘中/未过截止点时东财返回实时数据，属预期状态而非故障：
    // 以 no-op 成功退出，等晚间调度窗口重跑。
    if (error && error.code === "MARKET_DATA_NOT_SETTLED") {
      console.log(JSON.stringify({
        ok: true,
        noOp: true,
        reason: error.code,
        details: error.details || null,
        currentAsOf: currentAsOf || null
      }));
      return;
    }
    throw error;
  }
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
  const intervalDaily = await uploadSnapshotIntervalDaily(build.candidate, args.publishUrl);
  console.log(JSON.stringify(summary(build, {
    compressedBytes: published.compressedBytes,
    snapshotId: published.result.publish && published.result.publish.snapshotId,
    intervalDaily
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
  INTERVAL_DAILY_METHODOLOGY,
  parseArguments,
  loadCurrentEnvelope,
  snapshotIntervalDailyPayload,
  uploadSnapshotIntervalDaily,
  summary,
  main
};
