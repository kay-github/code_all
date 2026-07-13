function assertFiniteNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number`);
  }

  return value;
}

function assertPositiveNumber(value, label) {
  assertFiniteNumber(value, label);

  if (value <= 0) {
    throw new RangeError(`${label} must be greater than zero`);
  }

  return value;
}

function assertReturn(value, label) {
  assertFiniteNumber(value, label);

  if (value <= -1) {
    throw new RangeError(`${label} must be greater than -1`);
  }

  return value;
}

function calculateAdjustedYtd({
  baseClose,
  baseAdjFactor,
  currentClose,
  currentAdjFactor
}) {
  assertPositiveNumber(baseClose, "baseClose");
  assertPositiveNumber(baseAdjFactor, "baseAdjFactor");
  assertPositiveNumber(currentClose, "currentClose");
  assertPositiveNumber(currentAdjFactor, "currentAdjFactor");

  const baseAdjustedPrice = baseClose * baseAdjFactor;
  const currentAdjustedPrice = currentClose * currentAdjFactor;
  assertPositiveNumber(baseAdjustedPrice, "baseAdjustedPrice");
  assertPositiveNumber(currentAdjustedPrice, "currentAdjustedPrice");

  const ytd = currentAdjustedPrice / baseAdjustedPrice - 1;
  return assertReturn(ytd, "ytd");
}

function readAdjustedBarClose(bar, label) {
  if (!bar || typeof bar !== "object" || Array.isArray(bar)) {
    throw new TypeError(`${label} must be an adjusted bar object`);
  }

  return assertPositiveNumber(bar.close, `${label}.close`);
}

function calculateYtdFromAdjustedBars(baseBar, currentBar) {
  const baseAdjustedClose = readAdjustedBarClose(baseBar, "baseBar");
  const currentAdjustedClose = readAdjustedBarClose(currentBar, "currentBar");
  const ytd = currentAdjustedClose / baseAdjustedClose - 1;
  return assertReturn(ytd, "ytd");
}

function assertSortedFiniteNumbers(values) {
  if (!Array.isArray(values)) {
    throw new TypeError("values must be an array");
  }

  let previous = -Infinity;

  for (let index = 0; index < values.length; index += 1) {
    const value = assertFiniteNumber(values[index], `values[${index}]`);

    if (value < previous) {
      throw new RangeError("values must be sorted in ascending order");
    }

    previous = value;
  }
}

function lowerBound(values, target) {
  assertSortedFiniteNumbers(values);
  assertFiniteNumber(target, "target");

  let left = 0;
  let right = values.length;

  while (left < right) {
    const middle = left + Math.floor((right - left) / 2);

    if (values[middle] < target) {
      left = middle + 1;
    } else {
      right = middle;
    }
  }

  return left;
}

function upperBound(values, target) {
  assertSortedFiniteNumbers(values);
  assertFiniteNumber(target, "target");

  let left = 0;
  let right = values.length;

  while (left < right) {
    const middle = left + Math.floor((right - left) / 2);

    if (values[middle] <= target) {
      left = middle + 1;
    } else {
      right = middle;
    }
  }

  return left;
}

function normalizeSymbol(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string`);
  }

  return value.trim().toUpperCase();
}

function validatePool(pool) {
  if (!Array.isArray(pool)) {
    throw new TypeError("pool must be an array");
  }

  const symbols = new Set();

  return pool.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new TypeError(`pool[${index}] must be an object`);
    }

    const symbol = normalizeSymbol(item.symbol, `pool[${index}].symbol`);
    const ytd = assertReturn(item.ytd, `pool[${index}].ytd`);

    if (symbols.has(symbol)) {
      throw new RangeError(`pool contains duplicate symbol: ${symbol}`);
    }

    symbols.add(symbol);
    return { symbol, ytd };
  });
}

function calculateComparison({ targetSymbol, targetYtd, pool }) {
  const normalizedTargetSymbol = normalizeSymbol(targetSymbol, "targetSymbol");
  assertReturn(targetYtd, "targetYtd");
  const records = validatePool(pool);
  const targetInPool = records.some((item) => item.symbol === normalizedTargetSymbol);
  const peerYtdValues = records
    .filter((item) => item.symbol !== normalizedTargetSymbol)
    .map((item) => item.ytd)
    .sort((left, right) => left - right);

  const firstEqual = lowerBound(peerYtdValues, targetYtd);
  const firstHigher = upperBound(peerYtdValues, targetYtd);
  const beatCount = firstEqual;
  const tieCount = firstHigher - firstEqual;
  const higherCount = peerYtdValues.length - firstHigher;
  const peerCount = peerYtdValues.length;
  const rankPosition = higherCount + 1;
  const rankPopulation = peerCount + 1;

  return {
    beatCount,
    peerCount,
    beatRatio: peerCount === 0 ? null : beatCount / peerCount,
    tieCount,
    higherCount,
    rankPosition,
    rankPopulation,
    topRatio: rankPosition / rankPopulation,
    poolEligibleCount: records.length,
    targetInPool
  };
}

module.exports = {
  assertFiniteNumber,
  calculateAdjustedYtd,
  calculateYtdFromAdjustedBars,
  calculateComparison,
  lowerBound,
  upperBound
};
