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
assert.ok(page.includes('id="stockRetryButton"'));
assert.ok(page.includes('id="rankingRetryButton"'));
assert.ok(page.includes('id="benchmarkRetryButton"'));
assert.ok(page.includes('role="status" aria-live="polite" aria-busy="true"'));
assert.ok(page.includes("/api/stock-search"));
assert.ok(page.includes("/api/stock-ytd"));
assert.ok(page.includes("/api/stock-benchmark"));
assert.ok(page.includes("function setDataWarning(data)"));
assert.ok(!page.includes("function setDemoWarning(data)"));
assert.ok(page.includes("数据仅供参考，不构成投资建议"));
assert.ok(page.includes("@media (max-width: 380px)"));
assert.ok(page.includes("prefers-reduced-motion"));
assert.ok(home.includes("./tools/stock-ytd-ranking/"));
assert.ok(home.includes("A股年内表现"));

const scriptMatch = page.match(/<script>([\s\S]*?)<\/script>/);
assert.ok(scriptMatch, "stock page must include an inline script");
assert.doesNotThrow(() => new Function(scriptMatch[1]));

function assertInOrder(source, snippets, message) {
  let cursor = 0;
  snippets.forEach((snippet) => {
    const index = source.indexOf(snippet, cursor);
    assert.ok(index >= 0, `${message}: missing or out of order: ${snippet}`);
    cursor = index + snippet.length;
  });
}

const script = scriptMatch[1];
const inputHandler = script.match(
  /elements\.input\.addEventListener\("input", \(\) => \{([\s\S]*?)\n      \}\);/
);
assert.ok(inputHandler, "stock search input handler must exist");
assertInOrder(
  inputHandler[1],
  [
    "const query = elements.input.value.trim();",
    "cancelSearchRequest();",
    "closeOptions();",
    "if (!query) {",
    "clearCurrentResult();",
    "return;",
    "scheduleSearch();"
  ],
  "stock search input must invalidate stale state before scheduling a new request"
);

const clearResult = script.match(
  /function clearCurrentResult\(\) \{([\s\S]*?)\n      \}/
);
assert.ok(clearResult, "stock result reset helper must exist");
assertInOrder(
  clearResult[1],
  ["state.currentResult = null;", "cancelResultRequest();"],
  "stock result reset must clear persisted data before updating the view"
);

const clearHandler = script.match(
  /elements\.clear\.addEventListener\("click", \(\) => \{([\s\S]*?)\n      \}\);/
);
assert.ok(clearHandler, "stock search clear handler must exist");
assert.ok(
  clearHandler[1].includes("clearCurrentResult();"),
  "clearing stock search must clear the previous result"
);
assert.ok(
  script.includes('elements.options.classList.contains("is-open") &&\n          state.activeIndex >= 0'),
  "Enter selection must require an open option list and an active option"
);
assert.ok(
  script.includes("loadResult(false);\n        loadBenchmark();"),
  "stock selection must start stock and benchmark requests independently"
);
const renderResultBlock = script.slice(
  script.indexOf("function renderResult(data)"),
  script.indexOf("async function loadResult(scopeOnly)")
);
assert.ok(
  !renderResultBlock.includes("renderBenchmark(data.benchmark)"),
  "stock result rendering must not depend on the benchmark payload"
);
assert.ok(
  script.includes("renderRanking(data.comparison);"),
  "scope-only responses must support ranking-only rendering"
);

console.log("stock page tests passed");
