const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const {
  buildCandidateFromDataset,
  loadReferenceRecords,
  parseArguments,
  publishSnapshot,
  readDataset,
  recoverSnapshot,
  recoverySummary,
  requestGithubOidcToken
} = require("../scripts/publish-free-stock-ytd");

const BASE_DATE = "2025-12-31";
const AS_OF = "2026-07-14";

function computedRecord(symbol, exchange, source, ytd) {
  const record = {
    symbol,
    code: symbol.slice(0, 6),
    name: symbol,
    exchange,
    board: exchange === "BSE" ? "BSE" : "MAIN",
    listingDate: "2020-01-01",
    listingStatus: "LISTED",
    securityType: "A_SHARE",
    computedYtd: ytd,
    basePriceDate: BASE_DATE,
    lastPriceDate: AS_OF,
    source,
    sourceAsOf: AS_OF
  };
  if (source === "baostock") {
    Object.assign(record, {
      baseAdjustedClose: 10,
      lastAdjustedClose: 10 * (1 + ytd),
      adjustmentMethod: "qfq"
    });
  } else {
    Object.assign(record, {
      baseRawClose: 10,
      baseAdjFactor: 1,
      baseAdjFactorDate: BASE_DATE,
      lastRawClose: 10 * (1 + ytd),
      lastAdjFactor: 1,
      lastAdjFactorDate: AS_OF,
      adjustmentMethod: "raw-factor"
    });
  }
  return record;
}

function dataset(overrides = {}) {
  return {
    version: "free-stock-ytd-dataset.v1",
    diagnosticOnly: false,
    generatedAt: "2026-07-14T12:20:00.000Z",
    baseDate: BASE_DATE,
    asOf: AS_OF,
    expectedUniverseCount: 3,
    computedRecords: [
      computedRecord("600000.SH", "SH", "baostock", 0.1),
      computedRecord("000001.SZ", "SZ", "baostock", 0.2),
      computedRecord("920001.BJ", "BSE", "sina", 0.3)
    ],
    indexRows: [
      { ts_code: "000300.SH", trade_date: BASE_DATE, close: 4000 },
      { ts_code: "000300.SH", trade_date: AS_OF, close: 4400 }
    ],
    benchmarkSource: "baostock",
    tradingCalendar: {
      coveredFrom: "2025-12-01",
      coveredThrough: "2026-12-31",
      rows: [
        { cal_date: "20251231", is_open: 1 },
        { cal_date: "20260714", is_open: 1 }
      ]
    },
    ...overrides
  };
}

async function run() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "free-stock-publisher-"));
  try {
    const recoveryArgs = parseArguments([
      `--recover-as-of=${AS_OF}`,
      "--publish-url=https://publish.example.test/api/stock-publish"
    ]);
    assert.strictEqual(recoveryArgs.input, null);
    assert.strictEqual(recoveryArgs.recoverAsOf, AS_OF);
    assert.throws(
      () => parseArguments(["--recover-as-of=2026-02-30", "--publish-url=https://example.test"]),
      /must be YYYY-MM-DD/
    );
    assert.throws(
      () => parseArguments([
        `--recover-as-of=${AS_OF}`,
        "--dry-run",
        "--publish-url="
      ]),
      /--publish-url is required/
    );

    const filename = path.join(directory, "dataset.json");
    fs.writeFileSync(filename, JSON.stringify(dataset()));
    assert.strictEqual(readDataset(filename).computedRecords.length, 3);
    fs.writeFileSync(filename, JSON.stringify(dataset({ diagnosticOnly: true })));
    assert.throws(() => readDataset(filename), /contract is invalid/);

    const skipped = await loadReferenceRecords(dataset(), { skipReference: true });
    assert.deepStrictEqual(skipped, {
      records: [],
      warningCode: "REFERENCE_SKIPPED"
    });

    const references = await loadReferenceRecords(dataset(), {
      fetchEastmoneyMarket: async () => [
        {
          symbol: "600000.SH",
          code: "600000",
          name: "600000.SH",
          exchange: "SH",
          ytd: 0.1,
          sourceAsOf: AS_OF
        },
        {
          symbol: "999999.SH",
          code: "999999",
          name: "outside",
          exchange: "SH",
          ytd: 0.9,
          sourceAsOf: AS_OF
        }
      ]
    });
    assert.strictEqual(references.records.length, 1);
    assert.strictEqual(references.warningCode, null);

    const attemptedHosts = [];
    const fallbackReferences = await loadReferenceRecords(dataset(), {
      eastmoneyBaseUrls: ["https://primary.test/clist", "https://delay.test/clist"],
      fetchEastmoneyMarket: async (options) => {
        attemptedHosts.push(options.baseUrl);
        if (options.baseUrl.includes("primary")) {
          const error = new Error("primary unavailable");
          error.code = "HTTP_ERROR";
          throw error;
        }
        return [{
          symbol: "600000.SH",
          code: "600000",
          name: "600000.SH",
          exchange: "SH",
          ytd: 0.1,
          sourceAsOf: AS_OF
        }];
      }
    });
    assert.deepStrictEqual(attemptedHosts, [
      "https://primary.test/clist",
      "https://delay.test/clist"
    ]);
    assert.strictEqual(fallbackReferences.records.length, 1);
    assert.strictEqual(fallbackReferences.warningCode, null);

    const rejectedReference = await buildCandidateFromDataset(dataset(), {
      fetchEastmoneyMarket: async () => [
        {
          symbol: "600000.SH",
          code: "600000",
          name: "600000.SH",
          exchange: "SH",
          ytd: 0.9,
          sourceAsOf: AS_OF
        },
        {
          symbol: "000001.SZ",
          code: "000001",
          name: "000001.SZ",
          exchange: "SZ",
          ytd: 0.8,
          sourceAsOf: AS_OF
        },
        {
          symbol: "920001.BJ",
          code: "920001",
          name: "920001.BJ",
          exchange: "BSE",
          ytd: 0.7,
          sourceAsOf: AS_OF
        }
      ]
    });
    assert.strictEqual(rejectedReference.candidate.sourceMode, "computed-fallback");
    assert.ok(rejectedReference.warningCodes.includes("REFERENCE_VALIDATION_REJECTED"));
    assert.strictEqual(rejectedReference.candidate.quality.coverage.ratio, 1);

    const build = await buildCandidateFromDataset(dataset(), {
      skipReference: true
    });
    assert.strictEqual(build.candidate.productionPublishable, true);
    assert.strictEqual(build.candidate.methodologyVersion, "adjusted-ytd.v2");
    assert.strictEqual(build.candidate.poolVersion, "official-a-share.v2");
    assert.strictEqual(build.candidate.benchmark.source, "baostock");
    assert.deepStrictEqual(build.warningCodes, ["REFERENCE_SKIPPED"]);

    let oidcRequest;
    const oidcToken = await requestGithubOidcToken({
      requestUrl: "https://oidc.example.test/token?x=1",
      requestToken: "request-secret",
      fetchImpl: async (url, options) => {
        oidcRequest = { url: String(url), options };
        return {
          ok: true,
          async json() {
            return { value: "oidc-token" };
          }
        };
      }
    });
    assert.strictEqual(oidcToken, "oidc-token");
    assert.ok(oidcRequest.url.includes("audience=stock-ytd-publish"));
    assert.strictEqual(
      oidcRequest.options.headers.Authorization,
      "Bearer request-secret"
    );

    let publishRequest;
    const published = await publishSnapshot(
      build,
      "https://publish.example.test/api/stock-publish",
      {
        token: "publish-token",
        fetchImpl: async (url, options) => {
          publishRequest = { url, options };
          return {
            ok: true,
            status: 200,
            async text() {
              return JSON.stringify({
                ok: true,
                publish: { snapshotId: "stock-ytd-test" }
              });
            }
          };
        }
      }
    );
    assert.ok(published.compressedBytes > 0);
    assert.strictEqual(publishRequest.options.method, "POST");
    assert.strictEqual(
      publishRequest.options.headers.Authorization,
      "Bearer publish-token"
    );
    const payload = JSON.parse(
      zlib.gunzipSync(publishRequest.options.body).toString("utf8")
    );
    assert.strictEqual(payload.snapshot.methodologyVersion, "adjusted-ytd.v2");
    assert.strictEqual(payload.tradingCalendar.version, "sse-trading-calendar.v1");

    let recoveryRequest;
    const recovered = await recoverSnapshot(
      AS_OF,
      "https://publish.example.test/api/stock-publish?existing=1",
      {
        token: "publish-token",
        fetchImpl: async (url, options) => {
          recoveryRequest = { url: String(url), options };
          return {
            ok: true,
            status: 200,
            async text() {
              return JSON.stringify({
                ok: true,
                publish: {
                  snapshotId: "stock-ytd-recovered",
                  asOf: AS_OF,
                  expectedAsOf: AS_OF,
                  sourceMode: "computed-fallback",
                  coverageRatio: 1,
                  computedSources: ["baostock", "sina"],
                  authorization: "github-oidc",
                  privateBlobUrl: "must-not-be-logged"
                }
              });
            }
          };
        }
      }
    );
    const recoveryUrl = new URL(recoveryRequest.url);
    assert.strictEqual(recoveryUrl.searchParams.get("existing"), "1");
    assert.strictEqual(recoveryUrl.searchParams.get("recoverAsOf"), AS_OF);
    assert.strictEqual(recoveryRequest.options.method, "POST");
    assert.strictEqual(recoveryRequest.options.body, undefined);
    assert.strictEqual(recoveryRequest.options.headers["Content-Type"], undefined);
    const safeRecovery = recoverySummary(recovered.result.publish);
    assert.strictEqual(safeRecovery.snapshotId, "stock-ytd-recovered");
    assert.ok(!Object.prototype.hasOwnProperty.call(safeRecovery, "privateBlobUrl"));

    const recoveryFetches = [];
    await recoverSnapshot(
      AS_OF,
      "https://publish.example.test/api/stock-publish",
      {
        requestUrl: "https://oidc.example.test/token",
        requestToken: "request-secret",
        fetchImpl: async (url, options) => {
          recoveryFetches.push({ url: String(url), options });
          if (String(url).startsWith("https://oidc.example.test/")) {
            return {
              ok: true,
              async json() {
                return { value: "oidc-recovery-token" };
              }
            };
          }
          assert.strictEqual(
            options.headers.Authorization,
            "Bearer oidc-recovery-token"
          );
          return {
            ok: true,
            status: 200,
            async text() {
              return JSON.stringify({
                ok: true,
                publish: { snapshotId: "stock-ytd-oidc-recovered" }
              });
            }
          };
        }
      }
    );
    assert.strictEqual(recoveryFetches.length, 2);

    const originalCronSecret = process.env.CRON_SECRET;
    process.env.CRON_SECRET = "manual-recovery-token";
    try {
      await recoverSnapshot(
        AS_OF,
        "https://publish.example.test/api/stock-publish",
        {
          fetchImpl: async (url, options) => {
            assert.strictEqual(
              options.headers.Authorization,
              "Bearer manual-recovery-token"
            );
            return {
              ok: true,
              status: 200,
              async text() {
                return JSON.stringify({
                  ok: true,
                  publish: { snapshotId: "stock-ytd-manual-recovered" }
                });
              }
            };
          }
        }
      );
    } finally {
      if (originalCronSecret == null) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = originalCronSecret;
    }

    await assert.rejects(
      () => publishSnapshot(
        build,
        "https://publish.example.test/api/stock-publish",
        {
          token: "publish-token",
          timeoutMs: 123456,
          fetchImpl: async (url, options) => {
            assert.ok(options.signal);
            return {
              ok: false,
              status: 503,
              async text() {
                return JSON.stringify({ ok: false, error: "STOCK_REFRESH_LOCKED" });
              }
            };
          }
        }
      ),
      (error) => error &&
        error.code === "STOCK_PUBLISH_HTTP_ERROR" &&
        error.status === 503 &&
        error.responseError === "STOCK_REFRESH_LOCKED"
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }

  console.log("free stock publisher tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
