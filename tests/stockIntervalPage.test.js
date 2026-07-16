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
assert.ok(page.includes('id="baseDate"'));
assert.ok(page.includes('id="includeBse"'));
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
