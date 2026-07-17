"use strict";

// 生产数据完整性自检（只读公开接口，不接触凭据）：
//   ① /api/stock-health 必须 READY 且 asOf 为按 16:00 截止点推算的最新交易日；
//   ② 可用基准日必须覆盖 [年初基期, asOf) 内全部交易日（快照或日频文件任一来源）；
//   ③ 演变聚合（若已建立）必须包含 asOf 当日切面。
// 任一失败以非零码退出 → workflow 变红 → GitHub 失败邮件即为告警。
// 调度上放在 21:35 最后一个重试窗口之后，避免把"预期的未结算 no-op"当故障。

const { validateTradingCalendar, deriveExpectedDatesFromCalendar } =
  require("../lib/stockTradingDates");

const DEFAULT_BASE_URL = "https://1.688680.xyz";

function shanghaiNowParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

async function fetchJson(url, options = {}) {
  const response = await (options.fetchImpl || fetch)(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(Number(options.timeoutMs) || 30000)
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) {
    throw new Error(`HTTP ${response.status} for ${new URL(url).pathname}`);
  }
  return data;
}

function checkCoverage(openDates, yearBaseDate, asOf, availableBaseDates) {
  const available = new Set(availableBaseDates);
  return openDates
    .filter((date) => date >= yearBaseDate && date < asOf)
    .filter((date) => !available.has(date));
}

async function verify(options = {}) {
  const baseUrl = options.baseUrl || process.env.STOCK_VERIFY_BASE_URL || DEFAULT_BASE_URL;
  const problems = [];

  const health = await fetchJson(`${baseUrl}/api/stock-health`, options);
  if (health.status !== "READY") problems.push(`health status is ${health.status}`);
  if (health.isStale) problems.push("health reports a stale snapshot");

  const envelope = await fetchJson(`${baseUrl}/api/stock-snapshot`, options);
  const calendar = validateTradingCalendar(envelope.tradingCalendar);
  const dates = deriveExpectedDatesFromCalendar(
    calendar,
    shanghaiNowParts(options.now ? new Date(options.now) : new Date())
  );
  if (health.asOf !== dates.expectedAsOf) {
    problems.push(`asOf ${health.asOf} != expected trading day ${dates.expectedAsOf}`);
  }

  const intervalDates = await fetchJson(
    `${baseUrl}/api/stock-interval-stats?dates=1`, options
  );
  const missing = checkCoverage(
    calendar.openDates,
    dates.baseDate,
    health.asOf,
    intervalDates.availableBaseDates || []
  );
  if (missing.length) {
    problems.push(`base dates missing: ${missing.slice(0, 10).join(",")}` +
      (missing.length > 10 ? ` (+${missing.length - 10})` : ""));
  }

  // 演变聚合是随灌入增量建立的：文件尚不存在时视为引导期而非故障。
  let seriesDayCount = null;
  try {
    const series = await fetchJson(`${baseUrl}/api/stock-interval-stats?series=1`, options);
    const days = (series.series && series.series.days) || [];
    seriesDayCount = days.length;
    if (!days.some((day) => day.date === health.asOf)) {
      problems.push(`series is missing the asOf day ${health.asOf}`);
    }
  } catch (error) {
    if (!/HTTP 404/.test(String(error.message))) throw error;
  }

  return {
    ok: problems.length === 0,
    asOf: health.asOf || null,
    expectedAsOf: dates.expectedAsOf,
    availableBaseDateCount: (intervalDates.availableBaseDates || []).length,
    seriesDayCount,
    problems
  };
}

async function main() {
  const result = await verify();
  console.log(JSON.stringify(result));
  if (!result.ok) process.exit(1);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      error: "STOCK_VERIFY_FAILED",
      message: error && error.message ? String(error.message).slice(0, 240) : null
    }));
    process.exit(1);
  });
}

module.exports = { verify, checkCoverage, shanghaiNowParts };
