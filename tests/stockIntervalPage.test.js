const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const page = fs.readFileSync(
  path.join(root, "tools", "stock-interval-stats", "index.html"),
  "utf8"
);
const home = fs.readFileSync(path.join(root, "index.html"), "utf8");
const vercel = JSON.parse(fs.readFileSync(path.join(root, "vercel.json"), "utf8"));

assert.ok(page.includes('name="viewport"'));
assert.ok(page.includes('id="baseDateButton"'));
assert.ok(page.includes('id="calendarPanel"'));
assert.ok(page.includes('id="calPrev"'));
assert.ok(page.includes('id="calNext"'));
assert.ok(page.includes('id="calGrid"'));
assert.ok(page.includes('id="quickChips"'));
assert.ok(page.includes('role="dialog"'));
assert.ok(page.includes("年初以来"));
assert.ok(!page.includes('<select'), "原生下拉已替换为日历选择器");
assert.ok(page.includes('id="includeBse"'));

// 内联脚本必须语法有效。
const script = page.match(/<script>([\s\S]*?)<\/script>/)[1];
assert.doesNotThrow(() => new Function(script));
assert.ok(page.includes('id="tabDown"'));
assert.ok(page.includes('id="tabUp"'));
assert.ok(page.includes('role="tablist"'));
assert.ok(page.includes("/api/stock-interval-stats"));
assert.ok(page.includes("BASE_SNAPSHOT_MISSING"));
assert.ok(page.includes("BASE_YEAR_MISMATCH"));
assert.ok(page.includes("纳入北交所"));
assert.ok(page.includes("当前比较池：沪深 A 股"));
assert.ok(page.includes("前复权口径合成值"));
assert.ok(page.includes("数据仅供参考，不构成投资建议"));

assert.ok(home.includes("./tools/stock-interval-stats/"));
assert.ok(home.includes("A股区间涨跌分布"));

const rewriteSources = vercel.rewrites.map((rule) => rule.source);
assert.ok(rewriteSources.includes("/qjfb"));
assert.ok(rewriteSources.includes("/qjfb/"));
const qjfb = vercel.rewrites.find((rule) => rule.source === "/qjfb");
assert.strictEqual(qjfb.destination, "/tools/stock-interval-stats/");

console.log("stockIntervalPage tests passed");
