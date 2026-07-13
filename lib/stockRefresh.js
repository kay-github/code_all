"use strict";

const { assertSnapshotPublishable, normalizeDate } = require("./stockSnapshot");

function errorSummary(error, source, phase) {
  return {
    source,
    phase,
    code: error && error.code ? String(error.code) : "UNKNOWN_ERROR",
    message: error && error.message ? String(error.message) : "unknown error"
  };
}

function requireFunction(value, name) {
  if (typeof value !== "function") {
    throw new TypeError(name + " must be a function");
  }
  return value;
}

function staleCopy(snapshot, expectedAsOf) {
  if (!snapshot || typeof snapshot !== "object") {
    return null;
  }

  const normalizedAsOf = normalizeDate(snapshot.asOf, "snapshot.asOf");
  const normalizedExpected = expectedAsOf
    ? normalizeDate(expectedAsOf, "expectedAsOf")
    : snapshot.expectedAsOf || normalizedAsOf;
  return {
    ...snapshot,
    asOf: normalizedAsOf,
    expectedAsOf: normalizedExpected,
    isStale: normalizedAsOf < normalizedExpected
  };
}

function requireExpectedAsOf(value) {
  if (value == null || value === "") {
    const error = new TypeError("expectedAsOf is required for stock refresh");
    error.code = "EXPECTED_AS_OF_REQUIRED";
    throw error;
  }
  return normalizeDate(value, "expectedAsOf");
}

function assertRefreshDate(candidate, expectedAsOf) {
  const candidateAsOf = normalizeDate(candidate && candidate.asOf, "candidate.asOf");
  const candidateExpectedAsOf = normalizeDate(
    candidate && candidate.expectedAsOf,
    "candidate.expectedAsOf"
  );
  if (candidateAsOf !== expectedAsOf || candidateExpectedAsOf !== expectedAsOf) {
    const error = new Error("stock snapshot date does not match refresh date");
    error.code = "SNAPSHOT_REFRESH_DATE_MISMATCH";
    error.details = {
      expectedAsOf,
      candidateAsOf,
      candidateExpectedAsOf
    };
    throw error;
  }
  return candidate;
}

async function refreshStockSnapshot(options = {}) {
  const expectedAsOf = requireExpectedAsOf(options.expectedAsOf);
  const buildPrimary = requireFunction(options.buildPrimary, "buildPrimary");
  const buildFallback = requireFunction(options.buildFallback, "buildFallback");
  const publishSnapshot = requireFunction(options.publishSnapshot, "publishSnapshot");
  const loadCurrentSnapshot = requireFunction(
    options.loadCurrentSnapshot,
    "loadCurrentSnapshot"
  );
  const attempts = [];
  const builders = [
    { source: options.primaryName || "primary", build: buildPrimary },
    { source: options.fallbackName || "fallback", build: buildFallback }
  ];
  let publishFailed = false;

  for (const item of builders) {
    let candidate;
    try {
      candidate = await item.build();
      assertSnapshotPublishable(candidate);
      assertRefreshDate(candidate, expectedAsOf);
    } catch (error) {
      attempts.push(errorSummary(error, item.source, "build-or-quality"));
      continue;
    }

    try {
      await publishSnapshot(candidate, {
        source: item.source,
        attempts: attempts.slice()
      });
      return {
        status: "published",
        source: item.source,
        snapshot: candidate,
        attempts
      };
    } catch (error) {
      attempts.push(errorSummary(error, item.source, "publish"));
      publishFailed = true;
      break;
    }
  }

  let previous;
  try {
    previous = await loadCurrentSnapshot();
    if (previous) {
      assertSnapshotPublishable(previous);
    }
  } catch (error) {
    attempts.push(errorSummary(error, "previous", "load-or-quality"));
    previous = null;
  }

  if (previous) {
    return {
      status: "serving-previous",
      source: "previous",
      snapshot: staleCopy(previous, expectedAsOf),
      publishFailed,
      attempts
    };
  }

  const error = new Error("no usable stock snapshot is available");
  error.code = "NO_USABLE_STOCK_SNAPSHOT";
  error.attempts = attempts;
  throw error;
}

module.exports = {
  errorSummary,
  staleCopy,
  refreshStockSnapshot
};
