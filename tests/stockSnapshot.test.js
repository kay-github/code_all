const assert = require("assert");
const {
  PASS_TOLERANCE_BP,
  QUARANTINE_TOLERANCE_BP,
  DEFAULT_MIN_COVERAGE_RATIO,
  normalizeDate,
  normalizeSymbol,
  buildStockSnapshot: buildStockSnapshotCore,
  queryStockSnapshot,
  assertSnapshotPublishable
} = require("../lib/stockSnapshot");

const BASE_DATE = "2025-12-31";
const AS_OF = "2026-07-10";

function buildStockSnapshot(input) {
  return buildStockSnapshotCore({
    expectedAsOf: AS_OF,
    expectedBaseDate: BASE_DATE,
    ...input
  });
}

function exchangeFor(symbol) {
  if (symbol.endsWith(".SH")) return "SH";
  if (symbol.endsWith(".SZ")) return "SZ";
  if (symbol.endsWith(".BJ")) return "BJ";
  throw new Error("unsupported fixture symbol");
}

function computedRecord(symbol, ytd, overrides = {}) {
  const baseRawClose = overrides.baseRawClose || 10;
  const baseAdjFactor = overrides.baseAdjFactor || 1;
  const lastAdjFactor = overrides.lastAdjFactor || 1;
  const lastRawClose = overrides.lastRawClose ||
    (baseRawClose * baseAdjFactor * (1 + ytd)) / lastAdjFactor;

  return {
    symbol,
    name: symbol,
    exchange: exchangeFor(symbol),
    securityType: "A_SHARE",
    listingStatus: "LISTED",
    listingDate: "2020-01-01",
    computedYtd: ytd,
    basePriceDate: BASE_DATE,
    lastPriceDate: AS_OF,
    baseRawClose,
    baseAdjFactor,
    baseAdjFactorDate: BASE_DATE,
    lastRawClose,
    lastAdjFactor,
    lastAdjFactorDate: AS_OF,
    source: "tushare",
    sourceAsOf: AS_OF,
    ...overrides
  };
}

function referenceRecord(symbol, ytd, overrides = {}) {
  return {
    symbol,
    name: symbol,
    exchange: exchangeFor(symbol),
    securityType: "A_SHARE",
    listingStatus: "LISTED",
    listingDate: "2020-01-01",
    referenceYtd: ytd,
    source: "eastmoney",
    sourceAsOf: AS_OF,
    ...overrides
  };
}

assert.strictEqual(PASS_TOLERANCE_BP, 5);
assert.strictEqual(QUARANTINE_TOLERANCE_BP, 20);
assert.strictEqual(DEFAULT_MIN_COVERAGE_RATIO, 0.998);
assert.strictEqual(normalizeDate("20260710"), AS_OF);
assert.strictEqual(normalizeDate("2026/07/10"), AS_OF);
assert.strictEqual(normalizeDate(new Date("2026-07-09T16:00:00.000Z")), AS_OF);
assert.throws(() => normalizeDate("2026-02-30"), /valid calendar date/);
assert.strictEqual(normalizeSymbol({ symbol: "sh600519" }), "600519.SH");
assert.throws(() => normalizeSymbol({ symbol: "ABC.SH" }), /six-digit A-share code/);

const computed = [
  computedRecord("300502.SZ", 0.70343),
  computedRecord("600000.SH", 0.1),
  computedRecord("000001.SZ", 0.70343),
  computedRecord("688001.SH", 0.8),
  computedRecord("920001.BJ", 0.2)
];
const references = [
  referenceRecord("300502.SZ", 0.7034),
  referenceRecord("600000.SH", 0.1004),
  referenceRecord("000001.SZ", 0.7034),
  referenceRecord("688001.SH", 0.8001),
  referenceRecord("920001.BJ", 0.2)
];
const snapshot = buildStockSnapshot({
  asOf: AS_OF,
  expectedAsOf: AS_OF,
  baseDate: BASE_DATE,
  computedRecords: computed,
  referenceRecords: references,
  expectedUniverseCount: 5,
  minCoverageRatio: 1
});

assert.strictEqual(snapshot.productionPublishable, true);
assert.strictEqual(snapshot.releaseDecision, "PUBLISH");
assert.strictEqual(snapshot.sourceMode, "validated");
assert.strictEqual(snapshot.pools.shSz.poolEligibleCount, 4);
assert.strictEqual(snapshot.pools.shSzBse.poolEligibleCount, 5);
assert.strictEqual(snapshot.stocks["300502.SZ"].ytd, 0.70343);
assert.ok(snapshot.stocks["300502.SZ"].qualityFlags.includes("REFERENCE_CHECK_PASSED"));
assertSnapshotPublishable(snapshot);

const shSzResult = queryStockSnapshot(snapshot, "300502.SZ");
assert.strictEqual(shSzResult.comparison.peerCount, 3);
assert.strictEqual(shSzResult.comparison.beatCount, 1);
assert.strictEqual(shSzResult.comparison.tieCount, 1);
assert.strictEqual(shSzResult.comparison.higherCount, 1);
assert.strictEqual(shSzResult.comparison.rankPosition, 2);
assert.strictEqual(shSzResult.comparison.rankPopulation, 4);
assert.strictEqual(shSzResult.comparison.poolEligibleCount, 4);

const allMarketResult = queryStockSnapshot(snapshot, "300502.SZ", { includeBse: true });
assert.strictEqual(allMarketResult.comparison.peerCount, 4);
assert.strictEqual(allMarketResult.comparison.beatCount, 2);
assert.strictEqual(allMarketResult.comparison.poolEligibleCount, 5);

const bseAgainstShSz = queryStockSnapshot(snapshot, "920001.BJ");
assert.strictEqual(bseAgainstShSz.comparison.targetInPool, false);
assert.strictEqual(bseAgainstShSz.comparison.peerCount, 4);
assert.strictEqual(bseAgainstShSz.comparison.beatCount, 1);

const warningSnapshot = buildStockSnapshot({
  asOf: AS_OF,
  baseDate: BASE_DATE,
  computedRecords: [computedRecord("600000.SH", 0.1)],
  referenceRecords: [referenceRecord("600000.SH", 0.101)],
  expectedUniverseCount: 1,
  minCoverageRatio: 1
});
assert.strictEqual(warningSnapshot.productionPublishable, true);
assert.strictEqual(warningSnapshot.stocks["600000.SH"].qualityStatus, "warning");
assert.ok(
  warningSnapshot.stocks["600000.SH"].qualityFlags.includes("REFERENCE_DEVIATION_WARNING")
);

const quarantinedSnapshot = buildStockSnapshot({
  asOf: AS_OF,
  baseDate: BASE_DATE,
  computedRecords: [
    computedRecord("600000.SH", 0.1),
    computedRecord("000001.SZ", 0.2)
  ],
  referenceRecords: [
    referenceRecord("600000.SH", 0.103),
    referenceRecord("000001.SZ", 0.2)
  ],
  expectedUniverseCount: 2,
  minCoverageRatio: 0.5
});
assert.strictEqual(quarantinedSnapshot.stocks["600000.SH"].isEligible, false);
assert.strictEqual(
  quarantinedSnapshot.stocks["600000.SH"].ineligibilityReason,
  "DATA_QUALITY_REJECTED"
);
assert.ok(
  quarantinedSnapshot.stocks["600000.SH"].qualityFlags.includes(
    "REFERENCE_DEVIATION_QUARANTINED"
  )
);
assert.strictEqual(quarantinedSnapshot.productionPublishable, false);
assert.ok(
  quarantinedSnapshot.quality.errors.some(
    (item) => item.code === "UNSAFE_MIN_COVERAGE_RATIO"
  )
);

const fallbackSnapshot = buildStockSnapshot({
  asOf: AS_OF,
  baseDate: BASE_DATE,
  computedRecords: [
    computedRecord("600000.SH", 0.1),
    computedRecord("000001.SZ", 0.2)
  ],
  referenceRecords: [],
  expectedUniverseCount: 2,
  minCoverageRatio: 1
});
assert.strictEqual(fallbackSnapshot.sourceMode, "computed-fallback");
assert.strictEqual(fallbackSnapshot.productionPublishable, true);
assert.ok(
  fallbackSnapshot.quality.warnings.some((item) => item.code === "REFERENCE_SOURCE_UNAVAILABLE")
);

const partialReferenceSnapshot = buildStockSnapshot({
  asOf: AS_OF,
  baseDate: BASE_DATE,
  computedRecords: [
    computedRecord("600000.SH", 0.1),
    computedRecord("000001.SZ", 0.2),
    computedRecord("688001.SH", 0.3)
  ],
  referenceRecords: [referenceRecord("600000.SH", 0.1)],
  expectedUniverseCount: 3,
  minCoverageRatio: 1
});
assert.strictEqual(partialReferenceSnapshot.productionPublishable, true);
assert.strictEqual(partialReferenceSnapshot.sourceMode, "partially-validated");
assert.ok(
  partialReferenceSnapshot.quality.warnings.some(
    (item) => item.code === "PARTIAL_REFERENCE_COVERAGE"
  )
);

const mixedComputedSourcesSnapshot = buildStockSnapshot({
  asOf: AS_OF,
  baseDate: BASE_DATE,
  computedRecords: [
    computedRecord("600000.SH", 0.1),
    computedRecord("000001.SZ", 0.2, { source: "tencent" })
  ],
  referenceRecords: [],
  expectedUniverseCount: 2,
  minCoverageRatio: 1
});
assert.strictEqual(mixedComputedSourcesSnapshot.productionPublishable, false);
assert.ok(
  mixedComputedSourcesSnapshot.quality.errors.some(
    (item) => item.code === "MIXED_COMPUTED_SOURCES"
  )
);

const partitionedSourceSnapshot = buildStockSnapshot({
  asOf: AS_OF,
  baseDate: BASE_DATE,
  methodologyVersion: "adjusted-ytd.v2",
  poolVersion: "official-a-share.v2",
  computedRecords: [
    computedRecord("600000.SH", 0.1, { source: "baostock" }),
    computedRecord("000001.SZ", 0.2, { source: "baostock" }),
    computedRecord("920001.BJ", 0.3, { source: "sina" })
  ],
  referenceRecords: [],
  expectedUniverseCount: 3,
  minCoverageRatio: 1
});
assert.strictEqual(partitionedSourceSnapshot.productionPublishable, true);
assert.deepStrictEqual(
  partitionedSourceSnapshot.quality.computedSources.active,
  ["baostock", "sina"]
);
assert.strictEqual(
  partitionedSourceSnapshot.quality.computedSources.exchangeMismatchCount,
  0
);

const partitionedSourceMismatch = buildStockSnapshot({
  asOf: AS_OF,
  baseDate: BASE_DATE,
  methodologyVersion: "adjusted-ytd.v2",
  poolVersion: "official-a-share.v2",
  computedRecords: [
    computedRecord("600000.SH", 0.1, { source: "sina" }),
    computedRecord("920001.BJ", 0.3, { source: "baostock" })
  ],
  referenceRecords: [],
  expectedUniverseCount: 2,
  minCoverageRatio: 1
});
assert.strictEqual(partitionedSourceMismatch.productionPublishable, false);
assert.ok(
  partitionedSourceMismatch.quality.errors.some(
    (item) => item.code === "COMPUTED_SOURCE_EXCHANGE_MISMATCH"
  )
);
assert.ok(
  mixedComputedSourcesSnapshot.quality.errors.some(
    (item) => item.code === "UNSUPPORTED_COMPUTED_SOURCE"
  )
);

const missingComputedSourceSnapshot = buildStockSnapshot({
  asOf: AS_OF,
  baseDate: BASE_DATE,
  computedRecords: [computedRecord("600000.SH", 0.1, { source: null })],
  referenceRecords: [],
  expectedUniverseCount: 1,
  minCoverageRatio: 1
});
assert.strictEqual(missingComputedSourceSnapshot.productionPublishable, false);
assert.ok(
  missingComputedSourceSnapshot.quality.errors.some(
    (item) => item.code === "MISSING_COMPUTED_SOURCE"
  )
);

const eastmoneyAdapterReference = referenceRecord("300502.SZ", 0.7034);
delete eastmoneyAdapterReference.referenceYtd;
eastmoneyAdapterReference.ytd = 0.7034;
const referenceOnlySnapshot = buildStockSnapshot({
  asOf: AS_OF,
  baseDate: BASE_DATE,
  computedRecords: [],
  referenceRecords: [eastmoneyAdapterReference],
  allowReferenceOnly: true,
  allowReferenceOnlyProduction: true,
  expectedUniverseCount: 1,
  minCoverageRatio: 1
});
assert.strictEqual(referenceOnlySnapshot.sourceMode, "reference-only");
assert.strictEqual(referenceOnlySnapshot.stocks["300502.SZ"].isEligible, true);
assert.strictEqual(referenceOnlySnapshot.productionPublishable, false);
assert.ok(
  referenceOnlySnapshot.quality.errors.some(
    (item) => item.code === "REFERENCE_ONLY_NOT_PRODUCTION_SAFE"
  )
);
assert.throws(
  () => assertSnapshotPublishable(referenceOnlySnapshot),
  (error) => error.code === "SNAPSHOT_NOT_PUBLISHABLE"
);
assert.throws(
  () => queryStockSnapshot(referenceOnlySnapshot, "300502.SZ"),
  (error) => error.code === "SNAPSHOT_NOT_PUBLISHABLE"
);
const diagnosticReferenceOnly = queryStockSnapshot(
  referenceOnlySnapshot,
  "300502.SZ",
  { allowBlocked: true }
);
assert.strictEqual(diagnosticReferenceOnly.expectedAsOf, AS_OF);
assert.strictEqual(diagnosticReferenceOnly.isStale, false);

const newListingSnapshot = buildStockSnapshot({
  asOf: AS_OF,
  baseDate: BASE_DATE,
  computedRecords: [
    computedRecord("600000.SH", 0.1),
    computedRecord("301999.SZ", 1.2, { listingDate: "2026-05-01" })
  ],
  referenceRecords: [
    referenceRecord("600000.SH", 0.1),
    referenceRecord("301999.SZ", 1.2, { listingDate: "2026-05-01" })
  ],
  expectedUniverseCount: 1,
  minCoverageRatio: 1
});
assert.strictEqual(newListingSnapshot.stocks["301999.SZ"].isEligible, false);
assert.strictEqual(newListingSnapshot.stocks["301999.SZ"].ineligibilityReason, "NEW_LISTING");
assert.strictEqual(newListingSnapshot.productionPublishable, true);

const fullySuspendedSnapshot = buildStockSnapshot({
  asOf: AS_OF,
  baseDate: BASE_DATE,
  computedRecords: [
    computedRecord("600001.SH", 0, {
      basePriceDate: "2025-12-30",
      baseAdjFactorDate: "2025-12-30",
      lastPriceDate: "2025-12-30",
      lastAdjFactorDate: "2025-12-30"
    })
  ],
  referenceRecords: [referenceRecord("600001.SH", 0)],
  expectedUniverseCount: 1,
  minCoverageRatio: 1
});
assert.strictEqual(fullySuspendedSnapshot.productionPublishable, true);
assert.strictEqual(fullySuspendedSnapshot.stocks["600001.SH"].ytd, 0);

const missingMaster = computedRecord("600000.SH", 0.1);
delete missingMaster.securityType;
const missingMasterSnapshot = buildStockSnapshot({
  asOf: AS_OF,
  baseDate: BASE_DATE,
  computedRecords: [missingMaster],
  referenceRecords: [referenceRecord("600000.SH", 0.1)],
  expectedUniverseCount: 1,
  minCoverageRatio: 1
});
assert.strictEqual(missingMasterSnapshot.productionPublishable, false);
assert.ok(missingMasterSnapshot.stocks["600000.SH"].qualityFlags.includes("MISSING_SECURITY_TYPE"));

const implicitCoverageSnapshot = buildStockSnapshot({
  asOf: AS_OF,
  baseDate: BASE_DATE,
  computedRecords: [computedRecord("600000.SH", 0.1)],
  referenceRecords: []
});
assert.strictEqual(implicitCoverageSnapshot.productionPublishable, false);
assert.ok(
  implicitCoverageSnapshot.quality.errors.some(
    (item) => item.code === "MISSING_EXPECTED_UNIVERSE_COUNT"
  )
);

const selfCertifiedDatesSnapshot = buildStockSnapshotCore({
  asOf: AS_OF,
  baseDate: BASE_DATE,
  computedRecords: [computedRecord("600000.SH", 0.1)],
  referenceRecords: [],
  expectedUniverseCount: 1,
  minCoverageRatio: 1
});
assert.strictEqual(selfCertifiedDatesSnapshot.productionPublishable, false);
assert.ok(
  selfCertifiedDatesSnapshot.quality.errors.some(
    (item) => item.code === "MISSING_EXPECTED_AS_OF"
  )
);
assert.ok(
  selfCertifiedDatesSnapshot.quality.errors.some(
    (item) => item.code === "MISSING_EXPECTED_BASE_DATE"
  )
);

const unsafeOverrideSnapshot = buildStockSnapshot({
  asOf: AS_OF,
  baseDate: BASE_DATE,
  computedRecords: [computedRecord("600000.SH", 0.1)],
  referenceRecords: [],
  expectedUniverseCount: 1,
  minCoverageRatio: 1,
  requireAdjustmentAudit: false
});
assert.strictEqual(unsafeOverrideSnapshot.productionPublishable, false);
assert.ok(
  unsafeOverrideSnapshot.quality.errors.some(
    (item) => item.code === "UNSAFE_QUALITY_GATE_OVERRIDE"
  )
);

const wrongBaseDateSnapshot = buildStockSnapshot({
  asOf: AS_OF,
  baseDate: BASE_DATE,
  expectedBaseDate: "2025-12-30",
  computedRecords: [computedRecord("600000.SH", 0.1)],
  referenceRecords: [],
  expectedUniverseCount: 1,
  minCoverageRatio: 1
});
assert.strictEqual(wrongBaseDateSnapshot.productionPublishable, false);
assert.ok(
  wrongBaseDateSnapshot.quality.errors.some(
    (item) => item.code === "BASE_DATE_MISMATCH"
  )
);

const missingSourceDate = computedRecord("600000.SH", 0.1);
delete missingSourceDate.sourceAsOf;
const missingSourceDateSnapshot = buildStockSnapshot({
  asOf: AS_OF,
  baseDate: BASE_DATE,
  computedRecords: [missingSourceDate],
  referenceRecords: [referenceRecord("600000.SH", 0.1)],
  expectedUniverseCount: 1,
  minCoverageRatio: 1
});
assert.strictEqual(missingSourceDateSnapshot.productionPublishable, false);
assert.ok(
  missingSourceDateSnapshot.stocks["600000.SH"].qualityFlags.includes(
    "MISSING_COMPUTED_SOURCE_DATE"
  )
);

const reversedDatesSnapshot = buildStockSnapshot({
  asOf: AS_OF,
  baseDate: BASE_DATE,
  computedRecords: [
    computedRecord("600000.SH", 0.1, { lastPriceDate: "2020-01-02" })
  ],
  referenceRecords: [referenceRecord("600000.SH", 0.1)],
  expectedUniverseCount: 1,
  minCoverageRatio: 1
});
assert.ok(
  reversedDatesSnapshot.stocks["600000.SH"].qualityFlags.includes(
    "PRICE_DATE_ORDER_INVALID"
  )
);

const factorDateMismatchSnapshot = buildStockSnapshot({
  asOf: AS_OF,
  baseDate: BASE_DATE,
  computedRecords: [
    computedRecord("600000.SH", 0.1, { baseAdjFactorDate: "2025-12-30" })
  ],
  referenceRecords: [referenceRecord("600000.SH", 0.1)],
  expectedUniverseCount: 1,
  minCoverageRatio: 1
});
assert.ok(
  factorDateMismatchSnapshot.stocks["600000.SH"].qualityFlags.includes(
    "ADJ_FACTOR_DATE_MISMATCH"
  )
);

const conflictingExchangeSnapshot = buildStockSnapshot({
  asOf: AS_OF,
  baseDate: BASE_DATE,
  computedRecords: [
    computedRecord("920001.BJ", 0.1, { exchange: "SZ" })
  ],
  referenceRecords: [referenceRecord("920001.BJ", 0.1)],
  expectedUniverseCount: 1,
  minCoverageRatio: 1
});
assert.ok(
  conflictingExchangeSnapshot.stocks["920001.BJ"].qualityFlags.includes(
    "SYMBOL_MASTER_DATA_MISMATCH"
  )
);
assert.strictEqual(conflictingExchangeSnapshot.pools.shSz.poolEligibleCount, 0);

const staleSnapshot = buildStockSnapshot({
  asOf: AS_OF,
  expectedAsOf: "2026-07-13",
  baseDate: BASE_DATE,
  computedRecords: [computedRecord("600000.SH", 0.1)],
  referenceRecords: [],
  expectedUniverseCount: 1,
  minCoverageRatio: 1
});
assert.strictEqual(staleSnapshot.isStale, true);
assert.strictEqual(staleSnapshot.productionPublishable, false);
assert.ok(staleSnapshot.quality.errors.some((item) => item.code === "AS_OF_MISMATCH"));

const duplicateSnapshot = buildStockSnapshot({
  asOf: AS_OF,
  baseDate: BASE_DATE,
  computedRecords: [
    computedRecord("600000.SH", 0.1),
    computedRecord("600000.SH", 0.1)
  ],
  referenceRecords: [referenceRecord("600000.SH", 0.1)],
  expectedUniverseCount: 1,
  minCoverageRatio: 1
});
assert.strictEqual(duplicateSnapshot.productionPublishable, false);
assert.ok(
  duplicateSnapshot.quality.errors.some((item) => item.code === "DUPLICATE_COMPUTED_SYMBOLS")
);

const excessUniverseSnapshot = buildStockSnapshot({
  asOf: AS_OF,
  baseDate: BASE_DATE,
  computedRecords: [
    computedRecord("600000.SH", 0.1),
    computedRecord("000001.SZ", 0.2)
  ],
  referenceRecords: [
    referenceRecord("600000.SH", 0.1),
    referenceRecord("000001.SZ", 0.2)
  ],
  expectedUniverseCount: 1,
  minCoverageRatio: 1
});
assert.strictEqual(excessUniverseSnapshot.productionPublishable, false);
assert.ok(
  excessUniverseSnapshot.quality.errors.some(
    (item) => item.code === "ELIGIBLE_COUNT_EXCEEDS_EXPECTED"
  )
);

assert.strictEqual(queryStockSnapshot(snapshot, "999999.SH"), null);

assert.throws(
  () => buildStockSnapshotCore({
    asOf: "2026-07-10",
    expectedAsOf: "2026-07-10",
    baseDate: "2026-06-30",
    expectedBaseDate: "2026-06-30",
    computedRecords: [],
    referenceRecords: [],
    expectedUniverseCount: 0
  }),
  /calendar year before asOf/
);

console.log("stock snapshot tests passed");
