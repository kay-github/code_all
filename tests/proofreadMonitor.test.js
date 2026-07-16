const assert = require("assert");
const {
  applyStreak,
  classify,
  decideNotification,
  getFallbackKeys,
  isQuietHour,
  runMonitorCycle
} = require("../lib/proofreadMonitor");
const { buildAlertHtml } = require("../lib/pushplus");

// 北京时间静默时段（默认 23:00-08:00）
// 2026-07-16T15:30:00Z = 北京 23:30 → 静默
assert.strictEqual(isQuietHour(Date.parse("2026-07-16T15:30:00Z")), true);
// 2026-07-16T00:30:00Z = 北京 08:30 → 非静默
assert.strictEqual(isQuietHour(Date.parse("2026-07-16T00:30:00Z")), false);
// 2026-07-16T20:00:00Z = 北京 04:00 → 静默
assert.strictEqual(isQuietHour(Date.parse("2026-07-16T20:00:00Z")), true);
// 自定义时段可关闭（start===end）
assert.strictEqual(isQuietHour(Date.parse("2026-07-16T15:30:00Z"), { MONITOR_QUIET_START: "0", MONITOR_QUIET_END: "0" }), false);

// 兜底组配置
assert.deepStrictEqual(getFallbackKeys({}), ["zhipu", "google"]);
assert.deepStrictEqual(getFallbackKeys({ MONITOR_FALLBACK_KEYS: "siliconflow, google" }), ["siliconflow", "google"]);

// applyStreak：连续失败累计，healthy 归零
const streak1 = applyStreak(
  [{ key: "xfyun", name: "X", healthy: false, latencyMs: 10, error: "boom" }],
  { providers: [{ key: "xfyun", failStreak: 1 }] },
  2
);
assert.strictEqual(streak1[0].failStreak, 2);
assert.strictEqual(streak1[0].confirmedDown, true);

const streak2 = applyStreak(
  [{ key: "xfyun", name: "X", healthy: true, latencyMs: 10 }],
  { providers: [{ key: "xfyun", failStreak: 5 }] },
  2
);
assert.strictEqual(streak2[0].failStreak, 0);
assert.strictEqual(streak2[0].confirmedDown, false);

// 单轮失败尚未确认（防抖）
const streak3 = applyStreak(
  [{ key: "xfyun", name: "X", healthy: false, latencyMs: 10, error: "boom" }],
  null,
  2
);
assert.strictEqual(streak3[0].failStreak, 1);
assert.strictEqual(streak3[0].confirmedDown, false);

// classify：全挂 → critical
const allDown = classify(
  [
    { key: "xfyun", name: "X", confirmedDown: true },
    { key: "zhipu", name: "Z", confirmedDown: true },
    { key: "google", name: "G", confirmedDown: true }
  ],
  ["zhipu", "google"]
);
assert.strictEqual(allDown.level, "critical");

// classify：兜底组全挂但前面还活 → warning
const fallbackDown = classify(
  [
    { key: "xfyun", name: "X", confirmedDown: false },
    { key: "zhipu", name: "Z", confirmedDown: true },
    { key: "google", name: "G", confirmedDown: true }
  ],
  ["zhipu", "google"]
);
assert.strictEqual(fallbackDown.level, "warning");
assert.ok(fallbackDown.summary.includes("Z") && fallbackDown.summary.includes("G"));

// classify：兜底组只挂一半 → ok
const fallbackHalf = classify(
  [
    { key: "zhipu", name: "Z", confirmedDown: true },
    { key: "google", name: "G", confirmedDown: false }
  ],
  ["zhipu", "google"]
);
assert.strictEqual(fallbackHalf.level, "ok");

// decideNotification：级别未变不推
assert.strictEqual(
  decideNotification("ok", { lastNotifiedLevel: "ok" }, Date.parse("2026-07-16T02:00:00Z"), {}).notify,
  false
);
// 级别变化且非静默 → 推
assert.strictEqual(
  decideNotification("warning", { lastNotifiedLevel: "ok" }, Date.parse("2026-07-16T02:00:00Z"), {}).notify,
  true
);
// 静默时段 warning 延后
const quietWarn = decideNotification("warning", { lastNotifiedLevel: "ok" }, Date.parse("2026-07-16T15:30:00Z"), {});
assert.strictEqual(quietWarn.notify, false);
assert.strictEqual(quietWarn.reason, "QUIET_HOURS");
// 静默时段 critical 仍推
assert.strictEqual(
  decideNotification("critical", { lastNotifiedLevel: "ok" }, Date.parse("2026-07-16T15:30:00Z"), {}).notify,
  true
);

// buildAlertHtml：包含状态与提供商名
const html = buildAlertHtml({
  level: "warning",
  summary: "兜底提供商全部不可用",
  providers: [
    { key: "zhipu", name: "Zhipu", healthy: false, latencyMs: 1200, error: "500 boom" },
    { key: "google", name: "Gemini", healthy: true, latencyMs: 800, model: "gemini-flash-latest" }
  ],
  nowMs: Date.parse("2026-07-16T02:00:00Z"),
  healthUrl: "https://1.688680.xyz/api/health"
});
assert.ok(html.includes("兜底提供商全部不可用"));
assert.ok(html.includes("Zhipu") && html.includes("Gemini"));
assert.ok(html.includes("正常 1 / 2"));
assert.ok(html.includes("10:00:00")); // 北京时间 = UTC+8

async function run() {
  const now = Date.parse("2026-07-16T02:00:00Z"); // 北京 10:00，非静默

  // 场景 A：全部提供商第一次探测就挂，但只有 1 轮 → 尚未确认，级别 ok，不推送
  const env = { XFYUN_API_KEY: "x", ZHIPU_API_KEY: "z", GEMINI_API_KEY: "g", PUSHPLUS_TOKEN: "t" };
  const downFetch = async (url) => {
    if (url.includes("pushplus")) {
      return { ok: true, async json() { return { code: 200, data: "serial" }; } };
    }
    return { ok: false, status: 500, async text() { return "server down"; } };
  };
  const cycle1 = await runMonitorCycle({ env, nowMs: now, fetchImpl: downFetch, prevState: null });
  assert.strictEqual(cycle1.level, "ok");
  assert.strictEqual(cycle1.notified, false);
  assert.ok(cycle1.state.providers.every((item) => item.failStreak === 1));

  // 场景 B：第二轮仍全挂 → 确认 critical，推送
  const cycle2 = await runMonitorCycle({ env, nowMs: now + 7200000, fetchImpl: downFetch, prevState: cycle1.state });
  assert.strictEqual(cycle2.level, "critical");
  assert.strictEqual(cycle2.notified, true);
  assert.strictEqual(cycle2.sendResult.serial, "serial");
  assert.strictEqual(cycle2.state.lastNotifiedLevel, "critical");

  // 场景 C：第三轮仍 critical，级别未变 → 不重复推送
  const cycle3 = await runMonitorCycle({ env, nowMs: now + 14400000, fetchImpl: downFetch, prevState: cycle2.state });
  assert.strictEqual(cycle3.level, "critical");
  assert.strictEqual(cycle3.notified, false);
  assert.strictEqual(cycle3.decision.reason, "SAME_LEVEL");

  // 场景 D：恢复 → 推送恢复通知
  const upFetch = async (url) => {
    if (url.includes("pushplus")) {
      return { ok: true, async json() { return { code: 200, data: "serial2" }; } };
    }
    return { ok: true, async json() { return { choices: [{ message: { content: "已修正" } }] }; } };
  };
  const cycle4 = await runMonitorCycle({ env, nowMs: now + 21600000, fetchImpl: upFetch, prevState: cycle3.state });
  assert.strictEqual(cycle4.level, "ok");
  assert.strictEqual(cycle4.notified, true);
  assert.strictEqual(cycle4.state.lastNotifiedLevel, "ok");

  // 场景 E：静默时段的 warning 延后，不推送但状态记录级别
  // xfyun 存活、兜底组（zhipu+google）全挂 → warning
  const quietNow = Date.parse("2026-07-16T15:30:00Z"); // 北京 23:30
  const warnEnv = { XFYUN_API_KEY: "x", ZHIPU_API_KEY: "z", GEMINI_API_KEY: "g", PUSHPLUS_TOKEN: "t" };
  const warnFetch = async (url) => {
    if (url.includes("pushplus")) {
      return { ok: true, async json() { return { code: 200, data: "s" }; } };
    }
    if (url.includes("xf-yun")) {
      return { ok: true, async json() { return { choices: [{ message: { content: "已修正" } }] }; } };
    }
    return { ok: false, status: 500, async text() { return "down"; } };
  };
  const seed = {
    providers: [
      { key: "xfyun", failStreak: 0 },
      { key: "zhipu", failStreak: 1 },
      { key: "google", failStreak: 1 }
    ],
    lastNotifiedLevel: "ok"
  };
  const cycleQuiet = await runMonitorCycle({ env: warnEnv, nowMs: quietNow, fetchImpl: warnFetch, prevState: seed });
  assert.strictEqual(cycleQuiet.level, "warning");
  assert.strictEqual(cycleQuiet.notified, false);
  assert.strictEqual(cycleQuiet.decision.reason, "QUIET_HOURS");
  assert.strictEqual(cycleQuiet.state.lastNotifiedLevel, "ok"); // 未推送，级别不推进，静默结束后会补发

  console.log("proofread monitor tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
