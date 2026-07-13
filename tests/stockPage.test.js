const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const page = fs.readFileSync(
  path.join(root, "tools", "stock-ytd-ranking", "index.html"),
  "utf8"
);
const home = fs.readFileSync(path.join(root, "index.html"), "utf8");

assert.ok(page.includes('name="viewport"'));
assert.ok(page.includes('role="combobox"'));
assert.ok(page.includes('role="listbox"'));
assert.ok(page.includes('role="switch"'));
assert.ok(page.includes('id="retryButton"'));
assert.ok(page.includes('role="status" aria-live="polite" aria-busy="true"'));
assert.ok(page.includes("/api/stock-search"));
assert.ok(page.includes("/api/stock-ytd"));
assert.ok(page.includes("数据仅供参考，不构成投资建议"));
assert.ok(page.includes("@media (max-width: 380px)"));
assert.ok(page.includes("prefers-reduced-motion"));
assert.ok(home.includes("./tools/stock-ytd-ranking/"));
assert.ok(home.includes("A股年内表现"));

const scriptMatch = page.match(/<script>([\s\S]*?)<\/script>/);
assert.ok(scriptMatch, "stock page must include an inline script");
assert.doesNotThrow(() => new Function(scriptMatch[1]));

console.log("stock page tests passed");
