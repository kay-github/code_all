const assert = require("assert");
const {
  calculateAdjustedYtd,
  calculateYtdFromAdjustedBars,
  calculateComparison,
  lowerBound,
  upperBound
} = require("../lib/stockYtd");

function assertClose(actual, expected, tolerance = 1e-12) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${actual} to be within ${tolerance} of ${expected}`
  );
}

const normalYtd = calculateAdjustedYtd({
  baseClose: 10,
  baseAdjFactor: 1,
  currentClose: 12,
  currentAdjFactor: 1
});
assertClose(normalYtd, 0.2);

// A 1 yuan cash dividend changes the raw close from 10 to 9. The adjusted
// factor removes the mechanical price gap, so the economic return is zero.
const cashDividendYtd = calculateAdjustedYtd({
  baseClose: 10,
  baseAdjFactor: 1,
  currentClose: 9,
  currentAdjFactor: 10 / 9
});
assertClose(cashDividendYtd, 0);

// A 10-for-10 bonus issue halves the raw price and doubles the share count.
const bonusIssueYtd = calculateAdjustedYtd({
  baseClose: 20,
  baseAdjFactor: 1,
  currentClose: 10,
  currentAdjFactor: 2
});
assertClose(bonusIssueYtd, 0);

const originalFactorScale = calculateAdjustedYtd({
  baseClose: 20,
  baseAdjFactor: 1,
  currentClose: 12,
  currentAdjFactor: 2
});
const rebasedFactorScale = calculateAdjustedYtd({
  baseClose: 20,
  baseAdjFactor: 100,
  currentClose: 12,
  currentAdjFactor: 200
});
assertClose(originalFactorScale, 0.2);
assertClose(rebasedFactorScale, originalFactorScale);

const forwardAdjustedYtd = calculateYtdFromAdjustedBars(
  { date: "2025-12-31", close: 8 },
  { date: "2026-07-10", close: 10 }
);
assertClose(forwardAdjustedYtd, 0.25);

const values = [-0.1, 0.2, 0.2, 0.4];
assert.strictEqual(lowerBound(values, 0.2), 1);
assert.strictEqual(upperBound(values, 0.2), 3);

const normalComparison = calculateComparison({
  targetSymbol: "300502.SZ",
  targetYtd: 0.3,
  pool: [
    { symbol: "300502.SZ", ytd: 0.3 },
    { symbol: "600000.SH", ytd: 0.1 },
    { symbol: "000001.SZ", ytd: 0.4 },
    { symbol: "688001.SH", ytd: -0.2 }
  ]
});
assert.deepStrictEqual(normalComparison, {
  beatCount: 2,
  peerCount: 3,
  beatRatio: 2 / 3,
  tieCount: 0,
  higherCount: 1,
  rankPosition: 2,
  rankPopulation: 4,
  topRatio: 0.5,
  poolEligibleCount: 4,
  targetInPool: true
});

const tiedComparison = calculateComparison({
  targetSymbol: "300502.SZ",
  targetYtd: 0.2,
  pool: [
    { symbol: "300502.SZ", ytd: 0.2 },
    { symbol: "600000.SH", ytd: 0.2 },
    { symbol: "000001.SZ", ytd: 0.1 },
    { symbol: "688001.SH", ytd: 0.3 }
  ]
});
assert.strictEqual(tiedComparison.beatCount, 1);
assert.strictEqual(tiedComparison.tieCount, 1);
assert.strictEqual(tiedComparison.higherCount, 1);
assert.strictEqual(tiedComparison.rankPosition, 2);
assert.strictEqual(tiedComparison.rankPopulation, 4);

const externalTargetComparison = calculateComparison({
  targetSymbol: "920001.BJ",
  targetYtd: 0.15,
  pool: [
    { symbol: "600000.SH", ytd: 0.1 },
    { symbol: "000001.SZ", ytd: 0.2 },
    { symbol: "688001.SH", ytd: 0.15 }
  ]
});
assert.deepStrictEqual(externalTargetComparison, {
  beatCount: 1,
  peerCount: 3,
  beatRatio: 1 / 3,
  tieCount: 1,
  higherCount: 1,
  rankPosition: 2,
  rankPopulation: 4,
  topRatio: 0.5,
  poolEligibleCount: 3,
  targetInPool: false
});

assert.throws(
  () => calculateAdjustedYtd({
    baseClose: 0,
    baseAdjFactor: 1,
    currentClose: 10,
    currentAdjFactor: 1
  }),
  /baseClose must be greater than zero/
);
assert.throws(
  () => calculateYtdFromAdjustedBars({ close: "8" }, { close: 10 }),
  /baseBar.close must be a finite number/
);
assert.throws(() => lowerBound([0.2, 0.1], 0.15), /sorted in ascending order/);
assert.throws(
  () => calculateComparison({
    targetSymbol: "300502.SZ",
    targetYtd: Infinity,
    pool: []
  }),
  /targetYtd must be a finite number/
);
assert.throws(
  () => calculateComparison({
    targetSymbol: "300502.SZ",
    targetYtd: 0.1,
    pool: [
      { symbol: "600000.SH", ytd: 0.1 },
      { symbol: "600000.sh", ytd: 0.2 }
    ]
  }),
  /duplicate symbol/
);

console.log("stock YTD tests passed");
