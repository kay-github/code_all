"use strict";

const assert = require("assert");
const path = require("path");
const { createFixtureSnapshot } = require("../lib/stockFixture");
const {
  EXIT,
  parseArguments,
  runSourceDiagnostics,
  buildSnapshotAudit,
  evaluateSnapshotAudit,
  serializeReport,
  runFirstBatch
} = require("../scripts/run-stock-ytd-first-batch");

const NOW = new Date("2026-07-10T11:00:00.000Z");
const AS_OF = "2026-07-10";
const TOKEN = "fixture-token-do-not-print";

function healthyDiagnostic() {
  return {
    report: {
      checkedAt: NOW.toISOString(),
      dates: {
        baseDate: "2025-12-31",
        expectedAsOf: AS_OF
      },
      thresholdsBp: { warning: 5, failure: 20 },
      tushare: {
        status: "PASS",
        failures: [],
        expectedAsOf: AS_OF,
        baseDate: "2025-12-31",
        counts: {
          stockBasic: 9,
          masterRecords: 9,
          expectedUniverse: 8,
          eligibleComputed: 8,
          computedCoverage: 1,
          newListings: 1,
          baseBackfill: 0,
          currentBackfill: 0,
          stockBasicByExchange: { SH: 4, SZ: 4, BSE: 1, UNKNOWN: 0 },
          masterByExchange: { SH: 4, SZ: 4, BSE: 1, UNKNOWN: 0 },
          expectedUniverseByExchange: { SH: 4, SZ: 3, BSE: 1, UNKNOWN: 0 }
        },
        sentinelYtd: 0.7,
        benchmarkYtd: 0.0526
      },
      symbols: [
        {
          symbol: "300502.SZ",
          eastmoney: { ytd: 0.7034, sourceAsOf: AS_OF },
          tencent: {
            status: "PASS",
            baseDate: "2025-12-31",
            currentDate: AS_OF,
            ytd: 0.70343,
            deviationBp: 0.3
          }
        },
        {
          symbol: "600519.SH",
          eastmoney: { ytd: -0.1069, sourceAsOf: AS_OF },
          tencent: {
            status: "PASS",
            baseDate: "2025-12-31",
            currentDate: AS_OF,
            ytd: -0.106864,
            deviationBp: 0.4
          }
        }
      ],
      market: {
        status: "PASS",
        failures: [],
        rows: 9,
        uniqueSymbols: 9,
        duplicateCount: 0,
        missingYtd: 0,
        maximumMissingYtd: 20,
        unknownExchange: 0,
        byExchange: { SH: 4, SZ: 4, BJ: 1 },
        elapsedMs: 1000
      }
    },
    marketRows: []
  };
}

function publishedArtifact(overrides = {}) {
  const snapshot = {
    ...createFixtureSnapshot(),
    methodologyVersion: "adjusted-ytd.v1",
    poolVersion: "a-share.v1",
    dataMode: "published",
    dataWarning: null,
    benchmark: {
      symbol: "000300.SH",
      name: "沪深300（价格指数）",
      type: "PRICE_INDEX",
      source: "tushare",
      asOf: AS_OF,
      baseDate: "2025-12-31",
      baseClose: 100,
      currentClose: 105.26,
      ytd: 0.0526
    },
    snapshotId: "stock-ytd-20260710-0123456789abcdef",
    ...(overrides.snapshot || {})
  };
  const envelope = {
    envelopeVersion: "stock-ytd-current.v1",
    snapshotId: snapshot.snapshotId,
    expectedAsOf: AS_OF,
    refreshStatus: "PUBLISHED",
    refreshedAt: NOW.toISOString(),
    errorCodes: [],
    warningCodes: [],
    tradingCalendar: {
      version: "sse-trading-calendar.v1",
      coveredFrom: "2025-12-01",
      coveredThrough: "2026-08-24",
      openDates: ["2025-12-31", AS_OF]
    },
    snapshot,
    ...(overrides.envelope || {})
  };
  return {
    envelope,
    rawBody: overrides.rawBody == null ? JSON.stringify(envelope) : overrides.rawBody,
    immutableSnapshot: overrides.immutableSnapshot || snapshot,
    residualArtifacts: overrides.residualArtifacts == null ? 0 : overrides.residualArtifacts
  };
}

function syncArtifact(artifact) {
  artifact.rawBody = JSON.stringify(artifact.envelope);
  artifact.immutableSnapshot = artifact.envelope.snapshot;
  artifact.immutableRawBody = JSON.stringify(artifact.immutableSnapshot);
  return artifact;
}

function successfulWorker(overrides = {}) {
  return {
    status: "published",
    snapshotId: "stock-ytd-20260710-0123456789abcdef",
    asOf: AS_OF,
    expectedAsOf: AS_OF,
    sourceMode: "validated",
    coverageRatio: 1,
    referenceFailureCode: null,
    calendarFailureCode: null,
    ...overrides
  };
}

function dateReady(expectedAsOf = AS_OF) {
  return {
    baseDate: "2025-12-31",
    expectedAsOf
  };
}

function batchArgs(extra = []) {
  return [
    "--expected-sh=4",
    "--expected-sz=4",
    "--expected-bse=1",
    ...extra
  ];
}

async function run() {
  const defaults = parseArguments([]);
  assert.strictEqual(
    defaults.directory,
    path.resolve(".stock-ytd-data", "first-batch")
  );
  assert.strictEqual(defaults.requireAsOf, null);
  assert.strictEqual(defaults.expectedMasterCounts, null);
  assert.strictEqual(
    parseArguments(["--require-as-of=2026-07-10"]).requireAsOf,
    AS_OF
  );
  assert.throws(
    () => parseArguments(["--require-as-of=2026-7-10"]),
    (error) => error.code === "INVALID_REQUIRED_AS_OF"
  );
  assert.throws(
    () => parseArguments(["--require-as-of=2026-02-30"]),
    (error) => error.code === "INVALID_REQUIRED_AS_OF"
  );
  assert.throws(
    () => parseArguments(["--force"]),
    (error) => error.code === "UNKNOWN_ARGUMENT"
  );
  assert.throws(
    () => parseArguments(["--expected-sh=4"]),
    (error) => error.code === "INCOMPLETE_EXPECTED_MASTER_COUNTS"
  );

  let calls = 0;
  const missingToken = await runFirstBatch({
    args: batchArgs(),
    env: {},
    now: NOW,
    inspectTarget: async () => { calls += 1; },
    runDiagnostic: async () => { calls += 1; },
    runWorker: async () => { calls += 1; },
    readArtifact: async () => { calls += 1; }
  });
  assert.strictEqual(missingToken.exitCode, EXIT.PREFLIGHT);
  assert.strictEqual(missingToken.report.errorCode, "TUSHARE_TOKEN_NOT_CONFIGURED");
  assert.strictEqual(missingToken.report.tokenConfigured, false);
  assert.strictEqual(missingToken.report.publishAttempted, false);
  assert.strictEqual(calls, 0);

  const nonEmpty = await runFirstBatch({
    args: batchArgs(),
    env: { TUSHARE_TOKEN: TOKEN },
    now: NOW,
    inspectTarget: async () => {
      const error = new Error("not empty");
      error.code = "FIRST_BATCH_STORE_NOT_EMPTY";
      throw error;
    },
    runDiagnostic: async () => { throw new Error("must not run"); }
  });
  assert.strictEqual(nonEmpty.exitCode, EXIT.PREFLIGHT);
  assert.strictEqual(nonEmpty.report.errorCode, "FIRST_BATCH_STORE_NOT_EMPTY");

  let workerCalls = 0;
  let diagnosticCalls = 0;
  const wrongDate = await runFirstBatch({
    args: batchArgs(["--require-as-of=2026-07-13"]),
    env: { TUSHARE_TOKEN: TOKEN },
    now: NOW,
    inspectTarget: async () => {},
    runDatePreflight: async () => dateReady("2026-07-10"),
    runDiagnostic: async () => { diagnosticCalls += 1; },
    runWorker: async () => { workerCalls += 1; }
  });
  assert.strictEqual(wrongDate.exitCode, EXIT.PREFLIGHT);
  assert.strictEqual(wrongDate.report.errorCode, "REQUIRED_AS_OF_NOT_READY");
  assert.strictEqual(workerCalls, 0);
  assert.strictEqual(diagnosticCalls, 0);

  let publicSourceCalls = 0;
  const coreFailure = await runSourceDiagnostics({
    env: { TUSHARE_TOKEN: TOKEN },
    now: NOW,
    clients: {
      fetchTushareTradeCalendar: async () => {
        const error = new Error("limited");
        error.code = "RATE_LIMITED";
        throw error;
      },
      fetchEastmoneyYtd: async () => { publicSourceCalls += 1; },
      fetchTencentQfqKlines: async () => { publicSourceCalls += 1; },
      fetchEastmoneyMarket: async () => { publicSourceCalls += 1; }
    }
  });
  assert.strictEqual(coreFailure.report.tushare.status, "UNAVAILABLE");
  assert.deepStrictEqual(coreFailure.report.symbols, []);
  assert.strictEqual(coreFailure.report.market, null);
  assert.strictEqual(publicSourceCalls, 0);

  const failedDiagnostic = healthyDiagnostic();
  failedDiagnostic.report.symbols[0].tencent.status = "WARN";
  const diagnosticFailure = await runFirstBatch({
    args: batchArgs(),
    env: { TUSHARE_TOKEN: TOKEN },
    now: NOW,
    inspectTarget: async () => {},
    runDiagnostic: async () => failedDiagnostic,
    runWorker: async () => { workerCalls += 1; }
  });
  assert.strictEqual(diagnosticFailure.exitCode, EXIT.DIAGNOSTIC);
  assert.strictEqual(diagnosticFailure.report.errorCode, "SOURCE_DIAGNOSTIC_FAILED");
  assert.strictEqual(workerCalls, 0);

  let workerDirectory = null;
  let artifactDirectory = null;
  const success = await runFirstBatch({
    args: batchArgs(["--require-as-of=2026-07-10"]),
    env: { TUSHARE_TOKEN: TOKEN },
    now: NOW,
    inspectTarget: async () => {},
    runDatePreflight: async () => dateReady(),
    runDiagnostic: async () => healthyDiagnostic(),
    runWorker: async (options) => {
      workerDirectory = options.directory;
      return successfulWorker();
    },
    readArtifact: async (directory) => {
      artifactDirectory = directory;
      return publishedArtifact();
    }
  });
  assert.strictEqual(success.exitCode, EXIT.PASS);
  assert.strictEqual(success.report.ok, true);
  assert.strictEqual(success.report.status, "PASSED");
  assert.notStrictEqual(success.report.finishedAt, success.report.startedAt);
  assert.strictEqual(success.report.published, true);
  assert.strictEqual(path.basename(workerDirectory), "candidate");
  assert.strictEqual(artifactDirectory, workerDirectory);
  assert.strictEqual(success.report.audit.security.tokenEmbedded, false);
  assert.deepStrictEqual(success.report.audit.security.sensitiveKeyPaths, []);
  assert.deepStrictEqual(evaluateSnapshotAudit(success.report.audit), []);

  const strictAudit = buildSnapshotAudit(
    publishedArtifact(),
    { TUSHARE_TOKEN: TOKEN }
  );
  strictAudit.quality.counts.quarantined = 1;
  strictAudit.deviations.over5To20Bp = 1;
  const strictIssues = evaluateSnapshotAudit(strictAudit);
  assert.ok(strictIssues.includes("QUARANTINED_RECORDS_PRESENT"));
  assert.ok(strictIssues.includes("REFERENCE_DEVIATIONS_OVER_5BP"));

  const fallbackArtifact = publishedArtifact({
    snapshot: { sourceMode: "computed-fallback" }
  });
  const fallback = await runFirstBatch({
    args: batchArgs(),
    env: { TUSHARE_TOKEN: TOKEN },
    now: NOW,
    inspectTarget: async () => {},
    runDiagnostic: async () => healthyDiagnostic(),
    runWorker: async () => successfulWorker({ sourceMode: "computed-fallback" }),
    readArtifact: async () => fallbackArtifact
  });
  assert.strictEqual(fallback.exitCode, EXIT.PUBLISH);
  assert.strictEqual(fallback.report.errorCode, "FIRST_BATCH_ACCEPTANCE_FAILED");
  assert.ok(fallback.report.warningCodes.includes("SOURCE_MODE_NOT_VALIDATED"));

  const changedUniverseDiagnostic = healthyDiagnostic();
  changedUniverseDiagnostic.report.tushare.counts.expectedUniverse = 7;
  let changedUniverseWorkerCalls = 0;
  const changedUniverse = await runFirstBatch({
    args: batchArgs(),
    env: { TUSHARE_TOKEN: TOKEN },
    now: NOW,
    inspectTarget: async () => {},
    runDiagnostic: async () => changedUniverseDiagnostic,
    runWorker: async () => {
      changedUniverseWorkerCalls += 1;
      return successfulWorker();
    },
    readArtifact: async () => publishedArtifact()
  });
  assert.strictEqual(changedUniverse.exitCode, EXIT.DIAGNOSTIC);
  assert.strictEqual(
    changedUniverse.report.errorCode,
    "EXPECTED_ELIGIBLE_UNIVERSE_MISMATCH"
  );
  assert.strictEqual(changedUniverseWorkerCalls, 0);

  const dateDriftArtifact = publishedArtifact();
  dateDriftArtifact.envelope.expectedAsOf = "2026-07-09";
  dateDriftArtifact.envelope.snapshot.asOf = "2026-07-09";
  dateDriftArtifact.envelope.snapshot.expectedAsOf = "2026-07-09";
  dateDriftArtifact.envelope.snapshot.benchmark.asOf = "2026-07-09";
  syncArtifact(dateDriftArtifact);
  const dateDrift = await runFirstBatch({
    args: batchArgs(),
    env: { TUSHARE_TOKEN: TOKEN },
    now: NOW,
    inspectTarget: async () => {},
    runDiagnostic: async () => healthyDiagnostic(),
    runWorker: async () => successfulWorker(),
    readArtifact: async () => dateDriftArtifact
  });
  assert.strictEqual(dateDrift.exitCode, EXIT.PUBLISH);
  assert.ok(dateDrift.report.warningCodes.includes(
    "DIAGNOSTIC_PUBLISH_DATE_MISMATCH"
  ));

  const eligibleDriftDiagnostic = healthyDiagnostic();
  eligibleDriftDiagnostic.report.tushare.counts.eligibleComputed = 7;
  eligibleDriftDiagnostic.report.tushare.counts.computedCoverage = 0.875;
  const eligibleDrift = await runFirstBatch({
    args: batchArgs(),
    env: { TUSHARE_TOKEN: TOKEN },
    now: NOW,
    inspectTarget: async () => {},
    runDiagnostic: async () => eligibleDriftDiagnostic,
    runWorker: async () => successfulWorker(),
    readArtifact: async () => publishedArtifact()
  });
  assert.strictEqual(eligibleDrift.exitCode, EXIT.PUBLISH);
  assert.ok(eligibleDrift.report.warningCodes.includes(
    "DIAGNOSTIC_PUBLISH_ELIGIBLE_COUNT_MISMATCH"
  ));
  assert.ok(eligibleDrift.report.warningCodes.includes(
    "DIAGNOSTIC_PUBLISH_COVERAGE_RATIO_MISMATCH"
  ));

  const exchangeDriftDiagnostic = healthyDiagnostic();
  exchangeDriftDiagnostic.report.tushare.counts.expectedUniverseByExchange = {
    SH: 5,
    SZ: 2,
    BSE: 1,
    UNKNOWN: 0
  };
  const exchangeDrift = await runFirstBatch({
    args: batchArgs(),
    env: { TUSHARE_TOKEN: TOKEN },
    now: NOW,
    inspectTarget: async () => {},
    runDiagnostic: async () => exchangeDriftDiagnostic,
    runWorker: async () => successfulWorker(),
    readArtifact: async () => publishedArtifact()
  });
  assert.strictEqual(exchangeDrift.exitCode, EXIT.PUBLISH);
  assert.ok(exchangeDrift.report.warningCodes.includes(
    "DIAGNOSTIC_PUBLISH_SH_EXPECTED_MISMATCH"
  ));

  let coreFailureWorkerCalls = 0;
  const coreFailureE2e = await runFirstBatch({
    args: batchArgs(),
    env: { TUSHARE_TOKEN: TOKEN },
    now: NOW,
    inspectTarget: async () => {},
    runDiagnostic: async () => coreFailure,
    runWorker: async () => { coreFailureWorkerCalls += 1; }
  });
  assert.strictEqual(coreFailureE2e.exitCode, EXIT.DIAGNOSTIC);
  assert.strictEqual(coreFailureWorkerCalls, 0);

  const warningArtifact = publishedArtifact();
  const warningRecord = warningArtifact.envelope.snapshot.records.find(
    (record) => record.symbol === "600000.SH"
  );
  warningRecord.deviationBp = 6;
  warningArtifact.envelope.snapshot.quality.status = "warning";
  warningArtifact.envelope.snapshot.quality.warnings = [
    { code: "REFERENCE_DEVIATION_WARNINGS" }
  ];
  syncArtifact(warningArtifact);
  const warningResult = await runFirstBatch({
    args: batchArgs(),
    env: { TUSHARE_TOKEN: TOKEN },
    now: NOW,
    inspectTarget: async () => {},
    runDiagnostic: async () => healthyDiagnostic(),
    runWorker: async () => successfulWorker(),
    readArtifact: async () => warningArtifact
  });
  assert.strictEqual(warningResult.exitCode, EXIT.PUBLISH);
  assert.ok(warningResult.report.warningCodes.includes("QUALITY_HAS_WARNINGS"));
  assert.ok(warningResult.report.warningCodes.includes(
    "REFERENCE_DEVIATIONS_OVER_5BP"
  ));

  const tokenLeakArtifact = publishedArtifact();
  tokenLeakArtifact.rawBody += TOKEN;
  const tokenLeak = await runFirstBatch({
    args: batchArgs(),
    env: { TUSHARE_TOKEN: TOKEN },
    now: NOW,
    inspectTarget: async () => {},
    runDiagnostic: async () => healthyDiagnostic(),
    runWorker: async () => successfulWorker(),
    readArtifact: async () => tokenLeakArtifact
  });
  const serializedReport = JSON.stringify(tokenLeak.report);
  assert.strictEqual(tokenLeak.exitCode, EXIT.PUBLISH);
  assert.strictEqual(tokenLeak.report.audit.security.tokenEmbedded, true);
  assert.strictEqual(typeof tokenLeak.report.audit.security.tokenEmbedded, "boolean");
  assert.strictEqual(serializedReport.includes(TOKEN), false);
  assert.strictEqual(serializedReport.includes("baseRawClose"), false);
  assert.strictEqual(serializedReport.includes("baseAdjFactor"), false);

  const projectedLeakArtifact = publishedArtifact();
  projectedLeakArtifact.envelope.snapshot.stocks["300502.SZ"].name = TOKEN;
  projectedLeakArtifact.rawBody = JSON.stringify(projectedLeakArtifact.envelope);
  projectedLeakArtifact.immutableSnapshot = projectedLeakArtifact.envelope.snapshot;
  projectedLeakArtifact.immutableRawBody = JSON.stringify(
    projectedLeakArtifact.immutableSnapshot
  );
  const projectedLeak = await runFirstBatch({
    args: batchArgs(),
    env: { TUSHARE_TOKEN: TOKEN },
    now: NOW,
    inspectTarget: async () => {},
    runDiagnostic: async () => healthyDiagnostic(),
    runWorker: async () => successfulWorker(),
    readArtifact: async () => projectedLeakArtifact
  });
  assert.strictEqual(projectedLeak.exitCode, EXIT.PUBLISH);
  assert.strictEqual(JSON.stringify(projectedLeak.report).includes(TOKEN), false);
  assert.strictEqual(
    projectedLeak.report.audit.sentinels[0].name,
    "[REDACTED]"
  );

  const immutableLeakArtifact = publishedArtifact();
  immutableLeakArtifact.immutableRawBody = TOKEN;
  const immutableLeakAudit = buildSnapshotAudit(
    immutableLeakArtifact,
    { TUSHARE_TOKEN: TOKEN }
  );
  assert.strictEqual(immutableLeakAudit.security.tokenEmbedded, true);
  const immutableLeak = await runFirstBatch({
    args: batchArgs(),
    env: { TUSHARE_TOKEN: TOKEN },
    now: NOW,
    inspectTarget: async () => {},
    runDiagnostic: async () => healthyDiagnostic(),
    runWorker: async () => successfulWorker(),
    readArtifact: async () => immutableLeakArtifact
  });
  assert.strictEqual(immutableLeak.exitCode, EXIT.PUBLISH);
  assert.strictEqual(immutableLeak.report.audit.security.tokenEmbedded, true);
  assert.strictEqual(JSON.stringify(immutableLeak.report).includes(TOKEN), false);

  let artifactReads = 0;
  const workerSecretFailure = await runFirstBatch({
    args: batchArgs(),
    env: { TUSHARE_TOKEN: TOKEN },
    now: NOW,
    inspectTarget: async () => {},
    runDiagnostic: async () => healthyDiagnostic(),
    runWorker: async () => {
      const error = new Error("FULL_SNAPSHOT_CANARY");
      error.code = TOKEN;
      error.details = {
        causeCode: TOKEN,
        snapshot: { records: ["FULL_SNAPSHOT_CANARY"] }
      };
      throw error;
    },
    readArtifact: async () => { artifactReads += 1; }
  });
  assert.strictEqual(workerSecretFailure.exitCode, EXIT.PUBLISH);
  assert.strictEqual(artifactReads, 0);
  const workerFailureOutput = serializeReport(
    workerSecretFailure.report,
    { TUSHARE_TOKEN: TOKEN }
  );
  assert.strictEqual(workerFailureOutput.includes(TOKEN), false);
  assert.strictEqual(workerFailureOutput.includes(TOKEN.toUpperCase()), false);
  assert.strictEqual(workerFailureOutput.includes("FULL_SNAPSHOT_CANARY"), false);
  assert.strictEqual(workerFailureOutput.includes("records"), false);

  assert.deepStrictEqual(Object.keys(success.report), [
    "ok", "mode", "status", "stage", "startedAt", "finishedAt",
    "requireAsOf", "expectedMasterCounts", "tokenConfigured", "datePreflight", "publishAttempted",
    "published", "errorCode", "causeCode", "warningCodes", "diagnostics",
    "worker", "audit"
  ]);
  assert.deepStrictEqual(Object.keys(success.report.audit.security), [
    "tokenEmbedded", "sensitiveKeyPaths"
  ]);

  const sensitiveArtifact = publishedArtifact({
    envelope: { authorizationToken: "FULL_SECRET_CANARY" }
  });
  sensitiveArtifact.rawBody = JSON.stringify(sensitiveArtifact.envelope);
  const sensitiveAudit = buildSnapshotAudit(
    sensitiveArtifact,
    { TUSHARE_TOKEN: TOKEN }
  );
  assert.deepStrictEqual(
    sensitiveAudit.security.sensitiveKeyPaths,
    ["authorizationToken"]
  );
  assert.strictEqual(JSON.stringify(sensitiveAudit).includes("FULL_SECRET_CANARY"), false);

  console.log("stock first-batch tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
