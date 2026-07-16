// 定时监控端点：由 GitHub Actions cron 触发，探活各提供商并按需微信推送。
// 鉴权：MONITOR_SECRET，通过 x-monitor-secret 头或 Authorization: Bearer 传入。
// 状态：持久化到 Vercel Blob typo-monitor/state.json（连续失败防抖 + 上次告警级别）。

const { put, list } = require("@vercel/blob");
const { runMonitorCycle } = require("../lib/proofreadMonitor");

const STATE_PREFIX = "typo-monitor";
const STATE_PATH = `${STATE_PREFIX}/state.json`;

function sendJson(res, status, data) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.statusCode = status;
  res.end(JSON.stringify(data));
}

function extractSecret(req) {
  const header = req.headers || {};
  if (header["x-monitor-secret"]) {
    return String(header["x-monitor-secret"]);
  }
  const auth = header.authorization || header.Authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(String(auth));
  return match ? match[1] : "";
}

async function readState(token) {
  try {
    const { blobs } = await list({ prefix: STATE_PATH, token, limit: 1 });
    const found = blobs.find((item) => item.pathname === STATE_PATH);
    if (!found) {
      return null;
    }
    const response = await fetch(`${found.url}?ts=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) {
      return null;
    }
    return await response.json();
  } catch {
    return null;
  }
}

async function writeState(state, token) {
  await put(STATE_PATH, JSON.stringify(state), {
    access: "public",
    contentType: "application/json; charset=utf-8",
    token,
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 0
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST" && req.method !== "GET") {
    sendJson(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED" });
    return;
  }

  const expectedSecret = process.env.MONITOR_SECRET || "";
  if (!expectedSecret) {
    sendJson(res, 500, { ok: false, error: "MONITOR_SECRET_NOT_CONFIGURED" });
    return;
  }
  if (extractSecret(req) !== expectedSecret) {
    sendJson(res, 401, { ok: false, error: "UNAUTHORIZED" });
    return;
  }

  const blobToken = process.env.BLOB_READ_WRITE_TOKEN || "";
  const nowMs = Date.now();

  let prevState = null;
  if (blobToken) {
    prevState = await readState(blobToken);
  }

  let cycle;
  try {
    cycle = await runMonitorCycle({ prevState, nowMs });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: "MONITOR_CYCLE_FAILED", message: String((error && error.message) || error) });
    return;
  }

  if (blobToken) {
    try {
      await writeState(cycle.state, blobToken);
    } catch (error) {
      // 状态写失败不阻断响应，但在结果里标记，便于排查。
      cycle.stateWriteError = String((error && error.message) || error);
    }
  } else {
    cycle.stateWriteError = "BLOB_TOKEN_NOT_CONFIGURED";
  }

  sendJson(res, 200, {
    ok: true,
    level: cycle.level,
    summary: cycle.summary,
    notified: cycle.notified,
    decision: cycle.decision,
    quietHour: cycle.quietHour,
    sendError: cycle.sendError || null,
    stateWriteError: cycle.stateWriteError || null,
    providers: cycle.providers.map((item) => ({
      key: item.key,
      healthy: item.healthy,
      latencyMs: item.latencyMs,
      failStreak: item.failStreak,
      confirmedDown: item.confirmedDown,
      error: item.error
    }))
  });
};
