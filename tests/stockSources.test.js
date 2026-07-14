"use strict";

const assert = require("assert");
const {
  ERROR_CODES,
  StockSourceError,
  requestJson,
  parseEastmoneyPercent,
  inferExchange,
  eastmoneyTimestampToDate,
  parseEastmoneyQuotes,
  fetchEastmoneyYtd,
  fetchEastmoneyMarket,
  parseTencentQfqKlines,
  mapTushareRows,
  callTushare
} = require("../lib/stockSources");

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    }
  };
}

async function run() {
  assert.strictEqual(parseEastmoneyPercent(12.34), 0.1234);
  assert.strictEqual(parseEastmoneyPercent("-5.50%"), -0.055);
  assert.strictEqual(parseEastmoneyPercent("-"), null);
  assert.strictEqual(parseEastmoneyPercent(undefined), null);
  assert.strictEqual(inferExchange("600519", 1), "SH");
  assert.strictEqual(inferExchange("300502", 0), "SZ");
  assert.strictEqual(inferExchange("920992", 0), "BJ");
  assert.strictEqual(eastmoneyTimestampToDate(1783668894), "2026-07-10");
  assert.strictEqual(eastmoneyTimestampToDate(0), null);

  const eastmoneyArray = parseEastmoneyQuotes({
    data: {
      total: 2,
      diff: [
        {
          f12: "300502",
          f13: 0,
          f14: "新易盛",
          f25: 12.34,
          f26: "20160303",
          f124: 1783668894
        },
        { f12: "600000", f13: 1, f14: "浦发银行" }
      ]
    }
  });
  assert.strictEqual(eastmoneyArray[0].ytd, 0.1234);
  assert.strictEqual(eastmoneyArray[0].secid, "0.300502");
  assert.strictEqual(eastmoneyArray[0].symbol, "300502.SZ");
  assert.strictEqual(eastmoneyArray[0].sourceAsOf, "2026-07-10");
  assert.strictEqual(eastmoneyArray[1].ytd, null);
  assert.deepStrictEqual(eastmoneyArray[1].qualityFlags, ["MISSING_YTD"]);

  const eastmoneyObject = parseEastmoneyQuotes({
    data: {
      total: 2,
      diff: {
        1: { f12: "000002", f13: 0, f14: "万科A", f25: "-2.50" },
        0: { f12: 1, f13: 0, f14: "平安银行", f25: "1.25%" }
      }
    }
  });
  assert.strictEqual(eastmoneyObject[0].code, "000001");
  assert.strictEqual(eastmoneyObject[0].ytd, 0.0125);
  assert.strictEqual(eastmoneyObject[1].ytd, -0.025);

  assert.throws(
    () => parseEastmoneyQuotes({ data: { total: 1 } }),
    (error) => error instanceof StockSourceError && error.code === ERROR_CODES.MISSING_FIELD
  );
  assert.throws(
    () => parseEastmoneyQuotes({ data: { total: 1, diff: [{ f14: "缺代码", f25: 1 }] } }),
    (error) => error instanceof StockSourceError && error.code === ERROR_CODES.MISSING_FIELD
  );

  const ulistCalls = [];
  const ulistFetch = async (url) => {
    ulistCalls.push(new URL(url));
    return jsonResponse({
      data: {
        total: 2,
        diff: {
          0: { f12: "300502", f13: 0, f14: "新易盛", f25: 10 },
          1: { f12: "600000", f13: 1, f14: "浦发银行", f25: -4 }
        }
      }
    });
  };
  const singleQuote = await fetchEastmoneyYtd("0.300502", {
    fetchImpl: ulistFetch,
    sleepImpl: async () => {},
    retries: 0
  });
  assert.strictEqual(singleQuote.code, "300502");
  assert.strictEqual(singleQuote.ytd, 0.1);
  assert.strictEqual(ulistCalls[0].searchParams.get("secids"), "0.300502");

  const batchQuotes = await fetchEastmoneyYtd(["0.300502", "1.600000"], {
    fetchImpl: ulistFetch,
    sleepImpl: async () => {},
    retries: 0
  });
  assert.strictEqual(batchQuotes.length, 2);
  assert.strictEqual(ulistCalls[1].searchParams.get("secids"), "0.300502,1.600000");

  let emptyEastmoneyAttempts = 0;
  const recoveredQuote = await fetchEastmoneyYtd("0.300502", {
    fetchImpl: async () => {
      emptyEastmoneyAttempts += 1;
      if (emptyEastmoneyAttempts === 1) {
        return jsonResponse({ data: null });
      }
      return jsonResponse({
        data: {
          total: 1,
          diff: [{ f12: "300502", f13: 0, f14: "新易盛", f25: 10 }]
        }
      });
    },
    sleepImpl: async () => {},
    retries: 1
  });
  assert.strictEqual(emptyEastmoneyAttempts, 2);
  assert.strictEqual(recoveredQuote.symbol, "300502.SZ");

  await assert.rejects(
    fetchEastmoneyYtd("0.300502", {
      fetchImpl: async () => jsonResponse({
        data: {
          total: 1,
          diff: [{ f12: "600519", f13: 1, f14: "贵州茅台", f25: 1 }]
        }
      }),
      sleepImpl: async () => {},
      retries: 0
    }),
    (error) => error instanceof StockSourceError &&
      error.code === ERROR_CODES.MISSING_FIELD
  );

  const pageCalls = [];
  const pageFetch = async (url) => {
    const page = Number(new URL(url).searchParams.get("pn"));
    pageCalls.push(page);
    if (page === 1) {
      return jsonResponse({
        data: {
          total: 3,
          diff: {
            1: { f12: "000002", f13: 0, f14: "万科A", f25: 2 },
            0: { f12: "000001", f13: 0, f14: "平安银行", f25: 1 }
          }
        }
      });
    }
    return jsonResponse({
      data: {
        total: 3,
        diff: [{ f12: "600000", f13: 1, f14: "浦发银行", f25: 3 }]
      }
    });
  };
  const market = await fetchEastmoneyMarket({
    fetchImpl: pageFetch,
    sleepImpl: async () => {},
    pageSize: 2,
    retries: 0
  });
  assert.deepStrictEqual(pageCalls, [1, 2]);
  assert.deepStrictEqual(market.map((item) => item.code), ["000001", "000002", "600000"]);
  assert.deepStrictEqual(market.map((item) => item.ytd), [0.01, 0.02, 0.03]);

  const cappedPageCalls = [];
  const cappedPageFetch = async (url) => {
    const parsedUrl = new URL(url);
    const page = Number(parsedUrl.searchParams.get("pn"));
    cappedPageCalls.push({
      page,
      pageSize: Number(parsedUrl.searchParams.get("pz")),
      sortField: parsedUrl.searchParams.get("fid")
    });
    const start = (page - 1) * 100;
    const count = Math.min(100, 150 - start);
    return jsonResponse({
      data: {
        total: 150,
        diff: Array.from({ length: count }, (_, index) => ({
          f12: String(start + index + 1).padStart(6, "0"),
          f13: 0,
          f14: "股票" + (start + index + 1),
          f25: 1
        }))
      }
    });
  };
  const cappedPageDelays = [];
  const cappedMarket = await fetchEastmoneyMarket({
    fetchImpl: cappedPageFetch,
    sleepImpl: async (ms) => cappedPageDelays.push(ms),
    pageSize: 1000,
    pageDelayMs: 25,
    retries: 0
  });
  assert.strictEqual(cappedMarket.length, 150);
  assert.deepStrictEqual(cappedPageCalls, [
    { page: 1, pageSize: 100, sortField: "f12" },
    { page: 2, pageSize: 100, sortField: "f12" }
  ]);
  assert.deepStrictEqual(cappedPageDelays, [25]);

  await assert.rejects(
    fetchEastmoneyMarket({
      pageSize: 2,
      pageDelayMs: 0,
      retries: 1,
      sleepImpl: async () => {},
      fetchImpl: async (url) => {
        const page = Number(new URL(url).searchParams.get("pn"));
        return page === 1
          ? jsonResponse({
            data: {
              total: 3,
              diff: [
                { f12: "000001", f13: 0, f14: "股票1", f25: 1 },
                { f12: "000002", f13: 0, f14: "股票2", f25: 1 }
              ]
            }
          })
          : jsonResponse({
            data: {
              total: 3,
              diff: [
                { f12: "000002", f13: 0, f14: "股票2", f25: 1 },
                { f12: "000003", f13: 0, f14: "股票3", f25: 1 }
              ]
            }
          });
      }
    }),
    (error) => error instanceof StockSourceError &&
      error.code === ERROR_CODES.INVALID_RESPONSE &&
      error.attempts === 2 &&
      error.details.page === 2
  );

  await assert.rejects(
    fetchEastmoneyMarket({
      pageSize: 1,
      pageDelayMs: 0,
      retries: 0,
      sleepImpl: async () => {},
      fetchImpl: async (url) => {
        const page = Number(new URL(url).searchParams.get("pn"));
        return jsonResponse({
          data: {
            total: page === 1 ? 2 : 1,
            diff: [{
              f12: page === 1 ? "000001" : "000002",
              f13: 0,
              f14: "股票",
              f25: 1
            }]
          }
        });
      }
    }),
    (error) => error instanceof StockSourceError &&
      error.code === ERROR_CODES.INVALID_RESPONSE
  );

  let retryAttempts = 0;
  const retrySleeps = [];
  const retriedPayload = await requestJson("https://example.test/retry", {
    source: "fixture",
    fetchImpl: async () => {
      retryAttempts += 1;
      if (retryAttempts === 1) {
        throw new TypeError("temporary network failure");
      }
      return jsonResponse({ ok: true });
    },
    sleepImpl: async (ms) => retrySleeps.push(ms),
    retries: 1,
    retryDelayMs: 10,
    timeoutMs: 50
  });
  assert.deepStrictEqual(retriedPayload, { ok: true });
  assert.strictEqual(retryAttempts, 2);
  assert.deepStrictEqual(retrySleeps, [10]);

  await assert.rejects(
    requestJson("https://example.test/timeout", {
      source: "fixture",
      fetchImpl: async () => new Promise(() => {}),
      sleepImpl: async () => {},
      retries: 0,
      timeoutMs: 5
    }),
    (error) => error instanceof StockSourceError &&
      error.code === ERROR_CODES.TIMEOUT &&
      error.attempts === 1
  );

  await assert.rejects(
    requestJson("https://example.test/body-timeout", {
      source: "fixture",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => new Promise(() => {})
      }),
      sleepImpl: async () => {},
      retries: 0,
      timeoutMs: 5
    }),
    (error) => error instanceof StockSourceError && error.code === ERROR_CODES.TIMEOUT
  );

  await assert.rejects(
    requestJson("https://example.test/rate-limit", {
      source: "fixture",
      fetchImpl: async () => jsonResponse({}, 429),
      sleepImpl: async () => {},
      retries: 0,
      timeoutMs: 50
    }),
    (error) => error instanceof StockSourceError &&
      error.code === ERROR_CODES.RATE_LIMITED &&
      error.retryable === true
  );

  const tencentFixture = {
    code: 0,
    data: {
      sz300502: {
        qfqday: [
          ["2026-01-05", "100.00", "102.50", "104.00", "99.00", "123456"],
          ["2026-01-06", "102.50", "101.25", "103.00", "100.00", "110000"]
        ]
      }
    }
  };
  const tencentBars = parseTencentQfqKlines(tencentFixture, "sz300502");
  assert.strictEqual(tencentBars.length, 2);
  assert.deepStrictEqual(tencentBars[0], {
    source: "tencent",
    adjustment: "qfq",
    symbol: "sz300502",
    date: "2026-01-05",
    open: 100,
    close: 102.5,
    high: 104,
    low: 99,
    volume: 123456
  });
  assert.throws(
    () => parseTencentQfqKlines({ code: 0, data: { sz300502: { day: [] } } }, "sz300502"),
    (error) => error instanceof StockSourceError && error.code === ERROR_CODES.MISSING_FIELD
  );
  assert.throws(
    () => parseTencentQfqKlines({
      code: 0,
      data: { sh600519: tencentFixture.data.sz300502 }
    }, "sz300502"),
    (error) => error instanceof StockSourceError && error.code === ERROR_CODES.MISSING_FIELD
  );
  assert.throws(
    () => parseTencentQfqKlines({
      code: 0,
      data: {
        sz300502: {
          qfqday: [
            ["2026-01-06", "1", "1", "1", "1", "1"],
            ["2026-01-05", "1", "1", "1", "1", "1"]
          ]
        }
      }
    }, "sz300502"),
    (error) => error instanceof StockSourceError && error.code === ERROR_CODES.INVALID_RESPONSE
  );
  assert.throws(
    () => parseTencentQfqKlines({
      code: 0,
      data: {
        sz300502: {
          qfqday: [["2026-02-30", "1", "1", "1", "1", "1"]]
        }
      }
    }, "sz300502"),
    (error) => error instanceof StockSourceError && error.code === ERROR_CODES.INVALID_RESPONSE
  );

  const mappedRows = mapTushareRows({
    fields: ["ts_code", "trade_date", "close", "adj_factor"],
    items: [
      ["300502.SZ", "20260710", 123.45, 4.5678],
      ["600000.SH", "20260710", 10.2, 1.25]
    ]
  });
  assert.deepStrictEqual(mappedRows[0], {
    ts_code: "300502.SZ",
    trade_date: "20260710",
    close: 123.45,
    adj_factor: 4.5678
  });

  let tushareRequest;
  const tushareResult = await callTushare(
    "daily",
    { trade_date: "20260710" },
    ["ts_code", "trade_date", "close"],
    {
      env: { TUSHARE_TOKEN: "fixture-token" },
      fetchImpl: async (url, options) => {
        tushareRequest = { url, options };
        return jsonResponse({
          code: 0,
          msg: null,
          data: {
            fields: ["ts_code", "trade_date", "close"],
            items: [["300502.SZ", "20260710", 123.45]]
          }
        });
      },
      sleepImpl: async () => {},
      retries: 0
    }
  );
  assert.strictEqual(tushareResult.rows[0].ts_code, "300502.SZ");
  assert.strictEqual(tushareRequest.options.method, "POST");
  assert.strictEqual(tushareRequest.options.headers["Content-Type"], "application/json");
  assert.deepStrictEqual(JSON.parse(tushareRequest.options.body), {
    api_name: "daily",
    token: "fixture-token",
    params: { trade_date: "20260710" },
    fields: "ts_code,trade_date,close"
  });

  await assert.rejects(
    callTushare("trade_cal", {}, [], {
      env: { TUSHARE_TOKEN: "fixture-token" },
      retries: 0,
      fetchImpl: async () => jsonResponse({
        code: -2001,
        msg: "每分钟最多访问该接口 0 次",
        data: null
      })
    }),
    (error) => error instanceof StockSourceError &&
      error.code === ERROR_CODES.RATE_LIMITED &&
      error.details.apiName === "trade_cal" &&
      error.details.rateLimitPerMinute === 0
  );

  const previousTushareToken = process.env.TUSHARE_TOKEN;
  process.env.TUSHARE_TOKEN = "process-token";
  try {
    let processTokenBody;
    await callTushare("daily", {}, ["ts_code"], {
      retries: 0,
      fetchImpl: async (url, options) => {
        processTokenBody = JSON.parse(options.body);
        return jsonResponse({
          code: 0,
          data: {
            fields: ["ts_code"],
            items: [["300502.SZ"]]
          }
        });
      }
    });
    assert.strictEqual(processTokenBody.token, "process-token");
  } finally {
    if (previousTushareToken === undefined) {
      delete process.env.TUSHARE_TOKEN;
    } else {
      process.env.TUSHARE_TOKEN = previousTushareToken;
    }
  }

  let tushareEmptyAttempts = 0;
  const recoveredTushare = await callTushare("daily", {}, ["ts_code"], {
    env: { TUSHARE_TOKEN: "fixture-token" },
    retries: 1,
    sleepImpl: async () => {},
    fetchImpl: async () => {
      tushareEmptyAttempts += 1;
      return tushareEmptyAttempts === 1
        ? jsonResponse({ code: 0, data: null })
        : jsonResponse({
          code: 0,
          data: {
            fields: ["ts_code"],
            items: [["300502.SZ"]]
          }
        });
    }
  });
  assert.strictEqual(tushareEmptyAttempts, 2);
  assert.strictEqual(recoveredTushare.rows[0].ts_code, "300502.SZ");

  await assert.rejects(
    callTushare("daily", {}, [], {
      env: {},
      fetchImpl: async () => {
        throw new Error("fetch must not be called without a token");
      }
    }),
    (error) => error instanceof StockSourceError && error.code === ERROR_CODES.CONFIG_ERROR
  );

  console.log("stock source tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
