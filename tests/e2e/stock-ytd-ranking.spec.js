const { test, expect } = require("@playwright/test");

const stockItem = {
  symbol: "300502.SZ",
  code: "300502",
  name: "新易盛",
  exchange: "SZ",
  board: "创业板",
  listingStatus: "LISTED"
};

const benchmarkResponse = {
  snapshotId: "snapshot-20260710",
  dataMode: "published",
  warning: null,
  asOf: "2026-07-10",
  expectedAsOf: "2026-07-10",
  publishedAt: "2026-07-10T10:40:00.000Z",
  isStale: false,
  benchmark: {
    symbol: "000300.SH",
    name: "沪深300（价格指数）",
    type: "PRICE_INDEX",
    ytd: 0.0526,
    asOf: "2026-07-10",
    baseDate: "2025-12-31"
  }
};

function stockResponse(includeBse) {
  return {
    snapshotId: "snapshot-20260710",
    dataMode: "published",
    warning: null,
    asOf: "2026-07-10",
    expectedAsOf: "2026-07-10",
    publishedAt: "2026-07-10T10:40:00.000Z",
    isStale: false,
    periodResetRequired: false,
    calendarCoverageExpired: false,
    baseDate: "2025-12-31",
    methodologyVersion: "adjusted-ytd.v1",
    stock: {
      symbol: stockItem.symbol,
      code: stockItem.code,
      name: stockItem.name,
      exchange: stockItem.exchange,
      board: stockItem.board,
      ytd: 0.25,
      direction: "UP",
      basePriceDate: "2025-12-31",
      lastPriceDate: "2026-07-10",
      isSuspended: false,
      hasFullYtd: true,
      ineligibilityReason: null,
      sinceListingReturn: null
    },
    comparison: includeBse
      ? {
          scope: "SH_SZ_BSE",
          includeBse: true,
          beatCount: 8,
          peerCount: 12,
          beatRatio: 8 / 12,
          higherCount: 3,
          rankPosition: 4,
          rankPopulation: 13,
          topRatio: 4 / 13,
          poolEligibleCount: 13,
          excludedCount: 0,
          targetInPool: true
        }
      : {
          scope: "SH_SZ",
          includeBse: false,
          beatCount: 6,
          peerCount: 10,
          beatRatio: 0.6,
          higherCount: 3,
          rankPosition: 4,
          rankPopulation: 11,
          topRatio: 4 / 11,
          poolEligibleCount: 11,
          excludedCount: 0,
          targetInPool: true
        }
  };
}

async function fulfillJson(route, data, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(data)
  });
}

async function mockSearch(page) {
  await page.route("**/api/stock-search?*", (route) => fulfillJson(route, {
    items: [stockItem],
    asOf: "2026-07-10",
    dataMode: "published",
    warning: null
  }));
}

async function selectStockWithKeyboard(page) {
  await page.goto("/tools/stock-ytd-ranking/");
  const input = page.getByRole("combobox", { name: "股票名称或代码" });
  await input.fill("300502");
  await expect(page.locator("#stock-option-0")).toBeVisible();
  await input.press("ArrowDown");
  await input.press("Enter");
  await expect(page.locator("#stockName")).toHaveText("新易盛");
}

async function installStableRoutes(page, counters = {}) {
  counters.stock = 0;
  counters.benchmark = 0;
  await mockSearch(page);
  await page.route("**/api/stock-ytd?*", async (route) => {
    counters.stock += 1;
    const includeBse = new URL(route.request().url()).searchParams.get("includeBse") === "true";
    await fulfillJson(route, stockResponse(includeBse));
  });
  await page.route("**/api/stock-benchmark", async (route) => {
    counters.benchmark += 1;
    await fulfillJson(route, benchmarkResponse);
  });
}

test("loads stock and benchmark independently with keyboard selection", async ({ page }) => {
  const counters = {};
  await installStableRoutes(page, counters);
  await selectStockWithKeyboard(page);

  await expect(page.locator("#ytdValue")).toHaveText("+25.00%");
  await expect(page.locator("#beatValue")).toHaveText("60.00%");
  await expect(page.locator("#benchmarkValue")).toHaveText("+5.26%");
  await expect(page.locator("#benchmarkDate")).toHaveText("截至 2026-07-10 收盘");
  expect(counters.stock).toBe(1);
  expect(counters.benchmark).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("search failure retries and renders options", async ({ page }) => {
  let searchAttempts = 0;
  await page.route("**/api/stock-search?*", async (route) => {
    searchAttempts += 1;
    if (searchAttempts === 1) {
      await fulfillJson(route, { message: "搜索服务暂时不可用" }, 503);
      return;
    }
    await fulfillJson(route, {
      items: [stockItem],
      asOf: "2026-07-10",
      dataMode: "published",
      warning: null
    });
  });

  await page.goto("/tools/stock-ytd-ranking/");
  const input = page.getByRole("combobox", { name: "股票名称或代码" });
  await input.fill("300502");
  await expect(page.locator("#requestError")).toBeVisible();
  await expect(page.locator("#requestErrorText")).toContainText("搜索服务暂时不可用");

  await page.locator("#retryButton").click();
  await expect(page.locator("#stock-option-0")).toBeVisible();
  await expect(page.locator("#requestError")).not.toBeVisible();
  expect(searchAttempts).toBe(2);
});

test("initial stock result failure retries in place", async ({ page }) => {
  const counters = { stock: 0, benchmark: 0 };
  await mockSearch(page);
  await page.route("**/api/stock-ytd?*", async (route) => {
    counters.stock += 1;
    const includeBse = new URL(route.request().url()).searchParams.get("includeBse") === "true";
    if (counters.stock === 1) {
      await fulfillJson(route, { message: "股票结果暂时不可用" }, 503);
      return;
    }
    await fulfillJson(route, stockResponse(includeBse));
  });
  await page.route("**/api/stock-benchmark", async (route) => {
    counters.benchmark += 1;
    await fulfillJson(route, benchmarkResponse);
  });

  await selectStockWithKeyboard(page);
  await expect(page.locator("#stockRetryButton")).toBeVisible();
  await expect(page.locator("#stockRetryButton")).toContainText("重试股票结果");
  await expect(page.locator("#requestError")).not.toBeVisible();

  await page.locator("#stockRetryButton").click();
  await expect(page.locator("#ytdValue")).toHaveText("+25.00%");
  await expect(page.locator("#stockRetryButton")).not.toBeVisible();
  expect(counters.stock).toBe(2);
  expect(counters.benchmark).toBe(1);
});

test("BSE switch mutates only ranking data", async ({ page }) => {
  const counters = { stock: 0, benchmark: 0 };
  let releaseBse;
  const bseGate = new Promise((resolve) => {
    releaseBse = resolve;
  });
  await mockSearch(page);
  await page.route("**/api/stock-ytd?*", async (route) => {
    counters.stock += 1;
    const includeBse = new URL(route.request().url()).searchParams.get("includeBse") === "true";
    if (includeBse) await bseGate;
    await fulfillJson(route, stockResponse(includeBse));
  });
  await page.route("**/api/stock-benchmark", async (route) => {
    counters.benchmark += 1;
    await fulfillJson(route, benchmarkResponse);
  });
  await selectStockWithKeyboard(page);
  await expect(page.locator("#benchmarkValue")).toHaveText("+5.26%");

  await page.evaluate(() => {
    window.__immutableMutations = 0;
    window.__immutableObservers = ["stockName", "ytdValue", "asOf", "benchmarkCard"].map((id) => {
      const observer = new MutationObserver((items) => {
        window.__immutableMutations += items.length;
      });
      observer.observe(document.getElementById(id), {
        attributes: true,
        characterData: true,
        childList: true,
        subtree: true
      });
      return observer;
    });
  });

  await page.getByRole("switch", { name: /纳入北交所/ }).check();
  await expect(page.locator("#rankingPanel")).toHaveAttribute("aria-busy", "true");
  await expect(page.locator("#rankingStatus")).toBeVisible();
  await expect(page.locator("#benchmarkCard")).not.toHaveAttribute("aria-busy", "true");
  await expect(page.locator("#beatValue")).toHaveText("60.00%");

  releaseBse();
  await expect(page.locator("#beatValue")).toHaveText("66.67%");
  await expect(page.locator("#rankingCopy")).toContainText("8 / 12");
  await expect(page.locator("#metaScope")).toHaveText("沪深 A 股及北交所 A 股");
  expect(await page.evaluate(() => window.__immutableMutations)).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(counters.stock).toBe(2);
  expect(counters.benchmark).toBe(1);
});

test("ranking failure preserves old data and retries in place", async ({ page }) => {
  const counters = { stock: 0, benchmark: 0 };
  let bseAttempts = 0;
  await mockSearch(page);
  await page.route("**/api/stock-ytd?*", async (route) => {
    counters.stock += 1;
    const includeBse = new URL(route.request().url()).searchParams.get("includeBse") === "true";
    if (includeBse && ++bseAttempts === 1) {
      await fulfillJson(route, { message: "排名服务暂时不可用" }, 503);
      return;
    }
    await fulfillJson(route, stockResponse(includeBse));
  });
  await page.route("**/api/stock-benchmark", async (route) => {
    counters.benchmark += 1;
    await fulfillJson(route, benchmarkResponse);
  });
  await selectStockWithKeyboard(page);
  await expect(page.locator("#benchmarkValue")).toHaveText("+5.26%");

  const scopeSwitch = page.getByRole("switch", { name: /纳入北交所/ });
  await scopeSwitch.click();
  await expect(page.locator("#rankingError")).toBeVisible();
  await expect(page.locator("#rankingError")).toContainText("已保留原排名");
  await expect(page.locator("#beatValue")).toHaveText("60.00%");
  await expect(scopeSwitch).not.toBeChecked();
  await expect(page.locator("#requestError")).not.toBeVisible();

  await page.getByRole("button", { name: "重试排名" }).click();
  await expect(page.locator("#beatValue")).toHaveText("66.67%");
  await expect(scopeSwitch).toBeChecked();
  await expect(page.locator("#rankingError")).not.toBeVisible();
  expect(counters.stock).toBe(3);
  expect(counters.benchmark).toBe(1);
});

test("ranking refresh rejects a mismatched snapshot and preserves old data", async ({ page }) => {
  const counters = { stock: 0, benchmark: 0 };
  let bseAttempts = 0;
  await mockSearch(page);
  await page.route("**/api/stock-ytd?*", async (route) => {
    counters.stock += 1;
    const includeBse = new URL(route.request().url()).searchParams.get("includeBse") === "true";
    if (includeBse && ++bseAttempts === 1) {
      await fulfillJson(route, {
        ...stockResponse(true),
        snapshotId: "snapshot-20260711",
        asOf: "2026-07-11",
        baseDate: "2025-12-30"
      });
      return;
    }
    await fulfillJson(route, stockResponse(includeBse));
  });
  await page.route("**/api/stock-benchmark", async (route) => {
    counters.benchmark += 1;
    await fulfillJson(route, benchmarkResponse);
  });

  await selectStockWithKeyboard(page);
  await expect(page.locator("#beatValue")).toHaveText("60.00%");

  const scopeSwitch = page.getByRole("switch", { name: /纳入北交所/ });
  await scopeSwitch.check();
  await expect(page.locator("#rankingError")).toBeVisible();
  await expect(page.locator("#rankingError")).toContainText("已保留原排名");
  await expect(page.locator("#beatValue")).toHaveText("60.00%");
  await expect(scopeSwitch).not.toBeChecked();

  await page.locator("#rankingRetryButton").click();
  await expect(page.locator("#beatValue")).toHaveText("66.67%");
  await expect(scopeSwitch).toBeChecked();
  await expect(page.locator("#rankingError")).not.toBeVisible();
  expect(counters.stock).toBe(3);
  expect(counters.benchmark).toBe(1);
});

test("benchmark failure retries without refetching stock", async ({ page }) => {
  const counters = { stock: 0, benchmark: 0 };
  await mockSearch(page);
  await page.route("**/api/stock-ytd?*", async (route) => {
    counters.stock += 1;
    await fulfillJson(route, stockResponse(false));
  });
  await page.route("**/api/stock-benchmark", async (route) => {
    counters.benchmark += 1;
    if (counters.benchmark === 1) {
      await fulfillJson(route, { message: "暂未获取沪深300数据" }, 503);
      return;
    }
    await fulfillJson(route, benchmarkResponse);
  });
  await selectStockWithKeyboard(page);

  await expect(page.locator("#ytdValue")).toHaveText("+25.00%");
  await expect(page.locator("#benchmarkError")).toBeVisible();
  await expect(page.locator("#benchmarkValue")).toHaveText("--");
  await expect(page.locator("#requestError")).not.toBeVisible();

  await page.getByRole("button", { name: "重试基准" }).click();
  await expect(page.locator("#benchmarkValue")).toHaveText("+5.26%");
  await expect(page.locator("#benchmarkError")).not.toBeVisible();
  expect(counters.stock).toBe(1);
  expect(counters.benchmark).toBe(2);
});

test("rapid BSE toggles ignore the stale response", async ({ page }) => {
  await mockSearch(page);
  await page.route("**/api/stock-ytd?*", async (route) => {
    const includeBse = new URL(route.request().url()).searchParams.get("includeBse") === "true";
    if (includeBse) await new Promise((resolve) => setTimeout(resolve, 250));
    await fulfillJson(route, stockResponse(includeBse));
  });
  await page.route("**/api/stock-benchmark", (route) => fulfillJson(route, benchmarkResponse));
  await selectStockWithKeyboard(page);
  await expect(page.locator("#beatValue")).toHaveText("60.00%");

  const scopeSwitch = page.getByRole("switch", { name: /纳入北交所/ });
  await scopeSwitch.check();
  await scopeSwitch.uncheck();
  await expect(page.locator("#rankingPanel")).not.toHaveAttribute("aria-busy", "true");
  await expect(page.locator("#beatValue")).toHaveText("60.00%");
  await page.waitForTimeout(350);
  await expect(scopeSwitch).not.toBeChecked();
  await expect(page.locator("#beatValue")).toHaveText("60.00%");
  await expect(page.locator("#metaScope")).toHaveText("沪深 A 股");
});
