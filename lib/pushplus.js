// PushPlus（推送加）微信推送封装。
// 接口：POST https://www.pushplus.plus/send，template=html 在微信 webview 内渲染卡片。
// code=200 仅代表服务端已收到（异步发送），非最终送达。

const DEFAULT_ENDPOINT = "https://www.pushplus.plus/send";
const DEFAULT_TIMEOUT_MS = 15000;

const LEVEL_THEME = {
  critical: { color: "#c0392b", bg: "#fdecec", label: "严重", emoji: "🔴" },
  warning: { color: "#c77700", bg: "#fff6e6", label: "告警", emoji: "🟠" },
  ok: { color: "#0f8a4d", bg: "#eafaf1", label: "恢复", emoji: "🟢" }
};

function getPushplusConfig(env = process.env) {
  return {
    token: env.PUSHPLUS_TOKEN || "",
    endpoint: env.PUSHPLUS_ENDPOINT || DEFAULT_ENDPOINT,
    topic: env.PUSHPLUS_TOPIC || "",
    timeoutMs: Number(env.PUSHPLUS_TIMEOUT_MS || String(DEFAULT_TIMEOUT_MS))
  };
}

function isPushplusConfigured(env = process.env) {
  return Boolean(getPushplusConfig(env).token);
}

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"]/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;"
  })[char]);
}

function formatBeijing(nowMs) {
  // 统一转北京时间（UTC+8）展示，避免依赖运行环境时区。
  const date = new Date(nowMs + 8 * 60 * 60 * 1000);
  const pad = (num) => String(num).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

function providerRowsHtml(providers) {
  if (!Array.isArray(providers) || !providers.length) {
    return `<tr><td colspan="4" style="padding:10px 12px;color:#888;">无提供商数据</td></tr>`;
  }

  return providers.map((item) => {
    const healthy = item.healthy === true;
    const dot = healthy ? "#0f8a4d" : "#c0392b";
    const stateText = healthy ? "正常" : "异常";
    const latency = Number.isFinite(item.latencyMs) ? `${item.latencyMs} ms` : "—";
    const detail = healthy
      ? (item.model ? escapeHtml(item.model) : "")
      : escapeHtml(item.error || "请求失败").slice(0, 60);
    return `<tr>
      <td style="padding:9px 12px;border-top:1px solid #eee;">
        <span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${dot};margin-right:7px;"></span>
        <b>${escapeHtml(item.name || item.key || "")}</b>
      </td>
      <td style="padding:9px 12px;border-top:1px solid #eee;color:${healthy ? "#0f8a4d" : "#c0392b"};white-space:nowrap;">${stateText}</td>
      <td style="padding:9px 12px;border-top:1px solid #eee;color:#555;white-space:nowrap;">${latency}</td>
      <td style="padding:9px 12px;border-top:1px solid #eee;color:#666;font-size:12px;word-break:break-all;">${detail}</td>
    </tr>`;
  }).join("");
}

// 生成微信内渲染的 HTML 卡片。report: { level, summary, providers[], nowMs, healthUrl }
function buildAlertHtml(report) {
  const theme = LEVEL_THEME[report.level] || LEVEL_THEME.warning;
  const when = formatBeijing(report.nowMs || Date.now());
  const healthUrl = report.healthUrl || "https://1.688680.xyz/api/health";
  const okCount = (report.providers || []).filter((item) => item.healthy).length;
  const total = (report.providers || []).length;

  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;color:#222;">
  <div style="background:${theme.bg};border:1px solid ${theme.color}33;border-radius:12px;padding:16px 16px 14px;">
    <div style="display:flex;align-items:center;gap:8px;">
      <span style="font-size:20px;">${theme.emoji}</span>
      <span style="background:${theme.color};color:#fff;font-size:12px;font-weight:700;padding:2px 10px;border-radius:999px;">${theme.label}</span>
      <span style="margin-left:auto;color:#888;font-size:12px;">校对服务监控</span>
    </div>
    <div style="margin-top:12px;font-size:16px;font-weight:700;line-height:1.5;color:${theme.color};">
      ${escapeHtml(report.summary || "")}
    </div>
    <div style="margin-top:6px;color:#666;font-size:13px;">正常 ${okCount} / ${total} 家提供商</div>
  </div>

  <table style="width:100%;border-collapse:collapse;margin-top:14px;font-size:13px;border:1px solid #eee;border-radius:10px;overflow:hidden;">
    <thead>
      <tr style="background:#fafafa;color:#888;font-size:12px;text-align:left;">
        <th style="padding:9px 12px;font-weight:600;">提供商</th>
        <th style="padding:9px 12px;font-weight:600;">状态</th>
        <th style="padding:9px 12px;font-weight:600;">耗时</th>
        <th style="padding:9px 12px;font-weight:600;">详情</th>
      </tr>
    </thead>
    <tbody>${providerRowsHtml(report.providers)}</tbody>
  </table>

  <div style="margin-top:14px;color:#999;font-size:12px;line-height:1.7;">
    <div>探测时间：${when}（北京时间）</div>
    <div>健康详情：<a href="${escapeHtml(healthUrl)}" style="color:#1570ef;text-decoration:none;">${escapeHtml(healthUrl)}</a></div>
  </div>
</div>`;
}

async function sendPushplus(payload, options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || fetch;
  const config = getPushplusConfig(env);

  if (!config.token) {
    throw new Error("PUSHPLUS_NOT_CONFIGURED");
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const body = {
      token: config.token,
      title: payload.title,
      content: payload.content,
      template: payload.template || "html"
    };
    if (config.topic) {
      body.topic = config.topic;
    }

    const response = await fetchImpl(config.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.code !== 200) {
      throw new Error(`PUSHPLUS_SEND_FAILED:${data.code || response.status}:${(data.msg || "").slice(0, 120)}`);
    }
    return { ok: true, serial: data.data || "" };
  } finally {
    clearTimeout(timeoutId);
  }
}

module.exports = {
  LEVEL_THEME,
  buildAlertHtml,
  escapeHtml,
  formatBeijing,
  getPushplusConfig,
  isPushplusConfigured,
  sendPushplus
};
