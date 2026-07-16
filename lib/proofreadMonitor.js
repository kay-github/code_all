// 校对服务监控：主动探活各提供商，分级告警，带防抖状态机与静默时段。
// 级别：ok（正常）/ warning（兜底组全挂）/ critical（全挂，仅剩本地规则）。

const { getConfiguredProviders, probeProvider } = require("./modelProofreader");
const { buildAlertHtml, isPushplusConfigured, sendPushplus } = require("./pushplus");

const DEFAULT_FALLBACK_KEYS = ["zhipu", "google"];
const DEFAULT_CONFIRM_ROUNDS = 2;
const DEFAULT_QUIET_START = 23; // 北京时间 23:00 起静默
const DEFAULT_QUIET_END = 8; // 至次日 08:00 结束

function getFallbackKeys(env = process.env) {
  const raw = (env.MONITOR_FALLBACK_KEYS || "").trim();
  if (!raw) {
    return DEFAULT_FALLBACK_KEYS;
  }
  return raw.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
}

// 北京时间小时，判断是否落在静默时段（跨零点）。
function isQuietHour(nowMs, env = process.env) {
  const start = Number(env.MONITOR_QUIET_START || String(DEFAULT_QUIET_START));
  const end = Number(env.MONITOR_QUIET_END || String(DEFAULT_QUIET_END));
  const hour = new Date(nowMs + 8 * 60 * 60 * 1000).getUTCHours();
  if (start === end) {
    return false;
  }
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

// 探测所有已配置提供商（失败立即重试一次，滤掉瞬时抖动）。
async function probeAllProviders(options = {}) {
  const env = options.env || process.env;
  const providers = getConfiguredProviders(env);
  const results = [];
  for (const config of providers) {
    let result = await probeProvider(config, options);
    if (!result.healthy) {
      result = await probeProvider(config, options);
    }
    results.push(result);
  }
  return results;
}

// 合并上一轮 failStreak：连续 confirmRounds 轮失败才算“确认异常”。
function applyStreak(results, prevState, confirmRounds) {
  const prevByKey = new Map(((prevState && prevState.providers) || []).map((item) => [item.key, item]));
  return results.map((item) => {
    const prev = prevByKey.get(item.key);
    const failStreak = item.healthy ? 0 : ((prev && prev.failStreak) || 0) + 1;
    return {
      key: item.key,
      name: item.name,
      model: item.model,
      healthy: item.healthy,
      latencyMs: item.latencyMs,
      error: item.error,
      failStreak,
      confirmedDown: failStreak >= confirmRounds
    };
  });
}

// 依据“确认异常”状态分级。
function classify(providers, fallbackKeys) {
  const configuredKeys = providers.map((item) => item.key);
  const activeFallback = providers.filter((item) => fallbackKeys.includes(item.key));
  const allDown = providers.length > 0 && providers.every((item) => item.confirmedDown);
  const fallbackAllDown = activeFallback.length > 0 && activeFallback.every((item) => item.confirmedDown);

  if (allDown) {
    return { level: "critical", summary: "所有大模型提供商均不可用，当前仅靠本地规则兜底。" };
  }
  if (fallbackAllDown) {
    const names = activeFallback.map((item) => item.name).join("、");
    return { level: "warning", summary: `兜底提供商（${names}）全部不可用，请尽快检查。` };
  }
  return { level: "ok", summary: "校对服务恢复正常，所有关键提供商可用。", configuredKeys };
}

// 决定是否推送：级别变化才推；静默时段只放行 critical，其余延后。
function decideNotification(level, prevState, nowMs, env) {
  const lastNotifiedLevel = (prevState && prevState.lastNotifiedLevel) || "ok";
  if (level === lastNotifiedLevel) {
    return { notify: false, reason: "SAME_LEVEL" };
  }
  if (isQuietHour(nowMs, env) && level !== "critical") {
    return { notify: false, reason: "QUIET_HOURS" };
  }
  return { notify: true, reason: "LEVEL_CHANGED" };
}

// 运行一轮监控：探测 → 合并防抖 → 分级 → 决策 → （可选）推送 → 返回新状态。
async function runMonitorCycle(options = {}) {
  const env = options.env || process.env;
  const nowMs = options.nowMs || Date.now();
  const fetchImpl = options.fetchImpl || fetch;
  const confirmRounds = Number(env.MONITOR_CONFIRM_ROUNDS || String(DEFAULT_CONFIRM_ROUNDS));
  const fallbackKeys = getFallbackKeys(env);
  const healthUrl = env.MONITOR_HEALTH_URL || "https://1.688680.xyz/api/health";
  const prevState = options.prevState || null;

  const rawResults = await probeAllProviders({ env, fetchImpl, now: () => nowMs });
  const providers = applyStreak(rawResults, prevState, confirmRounds);
  const { level, summary } = classify(providers, fallbackKeys);
  const decision = decideNotification(level, prevState, nowMs, env);

  let notified = false;
  let sendResult = null;
  let sendError = null;

  if (decision.notify && isPushplusConfigured(env)) {
    const html = buildAlertHtml({ level, summary, providers, nowMs, healthUrl });
    const titlePrefix = level === "critical" ? "🔴 校对服务严重故障" : (level === "warning" ? "🟠 校对兜底告警" : "🟢 校对服务恢复");
    try {
      sendResult = await sendPushplus(
        { title: titlePrefix, content: html, template: "html" },
        { env, fetchImpl }
      );
      notified = true;
    } catch (error) {
      sendError = String((error && error.message) || error);
    }
  }

  const state = {
    level,
    summary,
    // 只有成功推送才更新 lastNotifiedLevel，否则下轮仍会尝试（如静默结束后补发）。
    lastNotifiedLevel: notified ? level : ((prevState && prevState.lastNotifiedLevel) || "ok"),
    lastCheckedMs: nowMs,
    lastNotifiedMs: notified ? nowMs : ((prevState && prevState.lastNotifiedMs) || null),
    providers
  };

  return {
    level,
    summary,
    providers,
    decision,
    notified,
    sendResult,
    sendError,
    quietHour: isQuietHour(nowMs, env),
    state
  };
}

module.exports = {
  DEFAULT_FALLBACK_KEYS,
  applyStreak,
  classify,
  decideNotification,
  getFallbackKeys,
  isQuietHour,
  probeAllProviders,
  runMonitorCycle
};
