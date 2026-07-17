"use strict";

// 把 backfill_interval_daily.py 生成的回填数据集拆成逐日文件，
// 经 /api/stock-publish?intervalDailyDate=<date> 逐个上传（OIDC/CRON_SECRET）。
// 用法：
//   node scripts/upload-interval-daily.js --input .stock-ytd-data/interval-backfill.json \
//     --publish-url https://1.688680.xyz/api/stock-publish
//   node scripts/upload-interval-daily.js --input ... --dry-run

const fs = require("fs");
const zlib = require("zlib");
const { requestGithubOidcToken } = require("./publish-free-stock-ytd");

const DAILY_VERSION = "stock-ytd-interval-daily.v1";
const DEFAULT_TIMEOUT_MS = 30000;

function parseArguments(argv) {
  const args = {
    input: null,
    publishUrl: process.env.STOCK_PUBLISH_URL || null,
    dryRun: false,
    onlyDates: null
  };
  for (const value of argv) {
    if (value === "--dry-run") args.dryRun = true;
    else if (value.startsWith("--input=")) args.input = value.slice(8);
    else if (value.startsWith("--publish-url=")) args.publishUrl = value.slice(14);
    else if (value.startsWith("--dates=")) {
      args.onlyDates = new Set(value.slice(8).split(",").map((item) => item.trim()).filter(Boolean));
    } else throw new TypeError(`unknown argument: ${value}`);
  }
  if (!args.input) throw new TypeError("--input is required");
  if (!args.dryRun && !args.publishUrl) throw new TypeError("--publish-url is required");
  return args;
}

function loadBackfillDataset(inputPath) {
  const dataset = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  if (!dataset || dataset.version !== "stock-ytd-interval-backfill.v1") {
    throw new TypeError("backfill dataset version is unsupported");
  }
  if (dataset.diagnosticOnly) {
    throw new TypeError("diagnostic backfill datasets must not be uploaded");
  }
  if (!dataset.days || typeof dataset.days !== "object") {
    throw new TypeError("backfill dataset has no days");
  }
  return dataset;
}

function dailyPayload(dataset, day) {
  return {
    version: DAILY_VERSION,
    asOf: day,
    baseDate: dataset.baseDate,
    methodologyVersion: dataset.methodologyVersion || "backfill-qfq.v1",
    generatedAt: dataset.generatedAt,
    records: dataset.days[day]
  };
}

async function uploadDay(publishUrl, day, payload, token, options = {}) {
  const body = zlib.gzipSync(Buffer.from(JSON.stringify(payload)), {
    level: zlib.constants.Z_BEST_COMPRESSION,
    mtime: 0
  });
  const url = `${publishUrl}${publishUrl.includes("?") ? "&" : "?"}intervalDailyDate=${day}`;
  const response = await (options.fetchImpl || fetch)(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/gzip",
      "Content-Length": String(body.length)
    },
    body,
    signal: AbortSignal.timeout(Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS)
  });
  const text = await response.text();
  let result = null;
  try {
    result = text ? JSON.parse(text) : null;
  } catch {
    result = null;
  }
  if (!response.ok || !result || result.ok !== true) {
    const error = new Error(
      `interval daily upload failed for ${day}: HTTP ${response.status}` +
      (result && result.error ? ` ${result.error}` : "")
    );
    error.status = response.status;
    throw error;
  }
  return { day, compressedBytes: body.length, recordCount: result.publish && result.publish.recordCount };
}

async function resolveToken(options = {}) {
  if (process.env.STOCK_PUBLISH_TOKEN) return process.env.STOCK_PUBLISH_TOKEN;
  if (process.env.CRON_SECRET) return process.env.CRON_SECRET;
  return requestGithubOidcToken(options);
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  const dataset = loadBackfillDataset(args.input);
  const days = Object.keys(dataset.days)
    .filter((day) => !args.onlyDates || args.onlyDates.has(day))
    .sort();
  if (days.length === 0) throw new TypeError("no days selected for upload");

  if (args.dryRun) {
    console.log(JSON.stringify({
      ok: true,
      dryRun: true,
      baseDate: dataset.baseDate,
      dayCount: days.length,
      firstDay: days[0],
      lastDay: days[days.length - 1]
    }));
    return;
  }

  let token = await resolveToken();
  const uploaded = [];
  const failed = [];
  for (const [index, day] of days.entries()) {
    // OIDC 短期 JWT 约 5 分钟过期；批量上传时定期换新。
    if (index > 0 && index % 40 === 0 && !process.env.STOCK_PUBLISH_TOKEN && !process.env.CRON_SECRET) {
      token = await resolveToken();
    }
    try {
      uploaded.push(await uploadDay(args.publishUrl, day, dailyPayload(dataset, day), token));
    } catch (error) {
      if (error && error.status === 401) {
        token = await resolveToken();
        try {
          uploaded.push(await uploadDay(args.publishUrl, day, dailyPayload(dataset, day), token));
          continue;
        } catch (retryError) {
          failed.push({ day, message: String(retryError.message).slice(0, 160) });
          continue;
        }
      }
      failed.push({ day, message: String(error.message).slice(0, 160) });
    }
  }
  console.log(JSON.stringify({
    ok: failed.length === 0,
    baseDate: dataset.baseDate,
    uploadedCount: uploaded.length,
    failed
  }));
  if (failed.length > 0) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      error: error && error.code ? String(error.code) : "INTERVAL_DAILY_UPLOAD_FAILED",
      message: error && error.message ? String(error.message).slice(0, 240) : null
    }));
    process.exit(1);
  });
}

module.exports = {
  parseArguments,
  loadBackfillDataset,
  dailyPayload,
  uploadDay,
  resolveToken,
  main
};
