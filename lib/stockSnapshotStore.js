"use strict";

const crypto = require("crypto");
const { normalizeDate } = require("./stockSnapshot");
const {
  preparePublishedSnapshot,
  validatePublishedSnapshot
} = require("./stockPublishedSnapshot");
const { validateTradingCalendar } = require("./stockTradingDates");

function snapshotStoreError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function sanitizedErrorCodes(values) {
  return [...new Set((values || [])
    .map((value) => String(value || "UNKNOWN_ERROR").slice(0, 80))
    .filter((value) => /^[A-Z0-9_-]+$/.test(value)))]
    .slice(0, 20);
}

function snapshotIdentifier(snapshot) {
  const core = { ...snapshot };
  delete core.snapshotId;
  const hash = crypto
    .createHash("sha256")
    .update(JSON.stringify(core))
    .digest("hex")
    .slice(0, 16);
  return `stock-ytd-${snapshot.asOf.replace(/-/g, "")}-${hash}`;
}

function validateCurrentEnvelope(envelope) {
  if (
    !envelope ||
    envelope.envelopeVersion !== "stock-ytd-current.v1" ||
    !envelope.snapshotId ||
    !envelope.snapshot
  ) {
    throw snapshotStoreError(
      "STOCK_SNAPSHOT_CURRENT_INVALID",
      "current stock snapshot envelope is invalid"
    );
  }
  try {
    preparePublishedSnapshot(
      envelope,
      { VERCEL_ENV: "production" },
      { now: Date.parse(envelope.snapshot.publishedAt) }
    );
  } catch (error) {
    throw snapshotStoreError(
      "STOCK_SNAPSHOT_CURRENT_INVALID",
      "current stock snapshot failed integrity validation",
      error
    );
  }
  return envelope;
}

function parseCurrentEnvelope(body) {
  let envelope;
  try {
    envelope = JSON.parse(body);
  } catch (error) {
    throw snapshotStoreError(
      "STOCK_SNAPSHOT_CURRENT_INVALID",
      "current stock snapshot envelope is invalid JSON",
      error
    );
  }
  return validateCurrentEnvelope(envelope);
}

function preparePublishedEnvelope(snapshot, options = {}) {
  validatePublishedSnapshot(snapshot, { VERCEL_ENV: "production" });
  if (
    snapshot.dataMode !== "published" ||
    String(snapshot.methodologyVersion || "").includes("fixture")
  ) {
    throw snapshotStoreError(
      "STOCK_SNAPSHOT_NOT_PRODUCTION_DATA",
      "only production stock snapshots can be published"
    );
  }
  const expectedAsOf = normalizeDate(
    options.expectedAsOf || snapshot.asOf,
    "expectedAsOf"
  );
  if (expectedAsOf !== snapshot.asOf || snapshot.expectedAsOf !== snapshot.asOf) {
    throw snapshotStoreError(
      "STOCK_SNAPSHOT_PUBLISH_DATE_MISMATCH",
      "new stock snapshot must be current when published"
    );
  }
  const tradingCalendar = validateTradingCalendar(options.tradingCalendar);
  if (
    !tradingCalendar.openDates.includes(snapshot.baseDate) ||
    !tradingCalendar.openDates.includes(snapshot.asOf) ||
    snapshot.asOf < tradingCalendar.coveredFrom ||
    snapshot.asOf > tradingCalendar.coveredThrough
  ) {
    throw snapshotStoreError(
      "STOCK_SNAPSHOT_CALENDAR_MISMATCH",
      "stock snapshot dates are not certified by its trading calendar"
    );
  }

  const snapshotId = snapshotIdentifier(snapshot);
  const publishedSnapshot = { ...snapshot, snapshotId };
  const envelope = {
    envelopeVersion: "stock-ytd-current.v1",
    snapshotId,
    expectedAsOf,
    refreshStatus: "PUBLISHED",
    refreshedAt: options.refreshedAt || new Date().toISOString(),
    errorCodes: [],
    warningCodes: sanitizedErrorCodes(options.warningCodes),
    tradingCalendar,
    snapshot: publishedSnapshot
  };
  return { snapshotId, publishedSnapshot, envelope };
}

function prepareServingPreviousEnvelope(current, expectedAsOf, errorCodes = [], options = {}) {
  validateCurrentEnvelope(current);
  const currentExpected = normalizeDate(
    current.expectedAsOf || current.snapshot.asOf,
    "current.expectedAsOf"
  );
  const normalizedExpected = expectedAsOf == null
    ? currentExpected
    : normalizeDate(expectedAsOf, "expectedAsOf");
  if (normalizedExpected < currentExpected) {
    throw snapshotStoreError(
      "STOCK_SNAPSHOT_EXPECTED_DATE_REGRESSION",
      "expectedAsOf cannot move backwards"
    );
  }
  return {
    ...current,
    expectedAsOf: normalizedExpected,
    refreshStatus: "SERVING_PREVIOUS",
    refreshedAt: options.refreshedAt || new Date().toISOString(),
    errorCodes: sanitizedErrorCodes(errorCodes)
  };
}

module.exports = {
  parseCurrentEnvelope,
  preparePublishedEnvelope,
  prepareServingPreviousEnvelope,
  sanitizedErrorCodes,
  snapshotIdentifier,
  snapshotStoreError,
  validateCurrentEnvelope
};
