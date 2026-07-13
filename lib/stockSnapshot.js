const { lowerBound, upperBound } = require("./stockYtd");

const PASS_TOLERANCE_BP = 5;
const QUARANTINE_TOLERANCE_BP = 20;
const DEFAULT_MIN_COVERAGE_RATIO = 0.998;
const COMPUTATION_TOLERANCE = 1e-10;
const PRODUCTION_COMPUTED_SOURCES = new Set(["tushare"]);

const EXCHANGE_ALIASES = new Map([
  ["SH", "SH"],
  ["SSE", "SH"],
  ["XSHG", "SH"],
  ["上海", "SH"],
  ["上交所", "SH"],
  ["SZ", "SZ"],
  ["SZSE", "SZ"],
  ["XSHE", "SZ"],
  ["深圳", "SZ"],
  ["深交所", "SZ"],
  ["BJ", "BSE"],
  ["BSE", "BSE"],
  ["XBSE", "BSE"],
  ["北京", "BSE"],
  ["北交所", "BSE"]
]);

function normalizeDate(value, label = "date") {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new TypeError(`${label} must be a valid date`);
    }
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(value);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  }

  const text = String(value == null ? "" : value).trim();
  let match = text.match(/^(\d{4})(\d{2})(\d{2})$/);

  if (!match) {
    match = text.match(/^(\d{4})[-/.](\d{2})[-/.](\d{2})(?:$|[T\s])/);
  }

  if (!match) {
    throw new TypeError(`${label} must contain a YYYY-MM-DD date`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const checked = new Date(Date.UTC(year, month - 1, day));

  if (
    checked.getUTCFullYear() !== year ||
    checked.getUTCMonth() !== month - 1 ||
    checked.getUTCDate() !== day
  ) {
    throw new TypeError(`${label} must be a valid calendar date`);
  }

  return `${match[1]}-${match[2]}-${match[3]}`;
}

function optionalDate(value, label, flags, dateErrors) {
  if (value == null || value === "") {
    return null;
  }

  try {
    return normalizeDate(value, label);
  } catch (error) {
    flags.add("INVALID_DATE");
    dateErrors.push({ field: label, value, message: error.message });
    return null;
  }
}

function finiteNumber(value) {
  if (value == null || value === "") {
    return null;
  }

  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveNumber(value) {
  const number = finiteNumber(value);
  return number != null && number > 0 ? number : null;
}

function ytdNumber(value) {
  const number = finiteNumber(value);
  return number != null && number > -1 ? number : null;
}

function firstValue(...values) {
  return values.find((value) => value != null && value !== "") ?? null;
}

function normalizeExchange(value, symbol) {
  const text = String(value == null ? "" : value).trim().toUpperCase();

  if (EXCHANGE_ALIASES.has(text)) {
    return EXCHANGE_ALIASES.get(text);
  }

  const suffix = String(symbol || "").toUpperCase().match(/\.([A-Z]+)$/);
  return suffix && EXCHANGE_ALIASES.has(suffix[1])
    ? EXCHANGE_ALIASES.get(suffix[1])
    : null;
}

function exchangeSuffix(exchange) {
  if (exchange === "SH") return "SH";
  if (exchange === "SZ") return "SZ";
  if (exchange === "BSE") return "BJ";
  return null;
}

function normalizeSymbol(record, label = "record") {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new TypeError(`${label} must be an object`);
  }

  let symbol = String(record.symbol == null ? "" : record.symbol)
    .trim()
    .toUpperCase();
  const exchange = normalizeExchange(record.exchange, symbol);

  if (!symbol) {
    const code = String(record.code == null ? "" : record.code).trim();
    const suffix = exchangeSuffix(exchange);

    if (!code || !suffix) {
      throw new TypeError(`${label}.symbol is required`);
    }

    symbol = `${code}.${suffix}`;
  }

  const prefixed = symbol.match(/^(SH|SZ|BJ)(\d{6})$/);
  if (prefixed) {
    symbol = `${prefixed[2]}.${prefixed[1]}`;
  }

  const bareCode = symbol.match(/^\d{6}$/);
  if (bareCode && exchangeSuffix(exchange)) {
    symbol = `${symbol}.${exchangeSuffix(exchange)}`;
  }

  symbol = symbol
    .replace(/\.(SSE|XSHG)$/, ".SH")
    .replace(/\.(SZSE|XSHE)$/, ".SZ")
    .replace(/\.(BSE|XBSE)$/, ".BJ");

  if (!/^\d{6}\.(SH|SZ|BJ)$/.test(symbol)) {
    throw new TypeError(label + ".symbol must use a six-digit A-share code and exchange suffix");
  }

  return symbol;
}

function indexRecords(records, kind, invalidRecords) {
  if (!Array.isArray(records)) {
    throw new TypeError(`${kind}Records must be an array`);
  }

  const index = new Map();

  records.forEach((record, position) => {
    try {
      const symbol = normalizeSymbol(record, `${kind}Records[${position}]`);
      const matches = index.get(symbol) || [];
      matches.push(record);
      index.set(symbol, matches);
    } catch (error) {
      invalidRecords.push({ kind, position, message: error.message });
    }
  });

  return index;
}

function isCurrentlyListed(value) {
  if (value == null || value === "") return true;
  if (value === true) return true;
  const normalized = String(value).trim().toUpperCase();
  return ["LISTED", "ACTIVE", "L", "上市", "正常上市"].includes(normalized);
}

function isSupportedSecurity(value) {
  if (value == null || value === "") return true;
  const normalized = String(value).trim().toUpperCase();
  return ["A", "A_SHARE", "ASHARE", "STOCK", "EQUITY", "A股"].includes(normalized);
}

function makeIssue(code, details = {}) {
  return { code, ...details };
}

function mergeRecord({
  symbol,
  computedMatches,
  referenceMatches,
  asOf,
  baseDate,
  allowReferenceOnly,
  requireAdjustmentAudit,
  requireMasterData,
  defaultReferenceSourceAsOf,
  defaultComputedSourceAsOf,
  dateMismatches
}) {
  const computed = computedMatches[0] || null;
  const reference = referenceMatches[0] || null;
  const flags = new Set();
  const dateErrors = [];
  const computedDuplicate = computedMatches.length > 1;
  const referenceDuplicate = referenceMatches.length > 1;

  if (computedDuplicate) flags.add("DUPLICATE_COMPUTED_RECORD");
  if (referenceDuplicate) flags.add("DUPLICATE_REFERENCE_RECORD");

  const master = computed || (allowReferenceOnly ? reference : null);
  if (!computed && master) flags.add("REFERENCE_MASTER_DATA");
  const exchange = normalizeExchange(
    master && master.exchange,
    symbol
  );
  const name = firstValue(computed && computed.name, reference && reference.name);
  const code = firstValue(
    master && master.code,
    symbol.match(/^([^.]+)/) && symbol.match(/^([^.]+)/)[1]
  );
  const symbolCode = symbol.slice(0, 6);
  const symbolExchange = normalizeExchange(null, symbol);
  const normalizedCode = String(code == null ? "" : code).padStart(6, "0");
  const board = master && master.board;
  const listingStatus = master && master.listingStatus;
  const securityType = master && master.securityType;
  const listingDate = optionalDate(
    master && firstValue(master.listingDate, master.listDate),
    `${symbol}.listingDate`,
    flags,
    dateErrors
  );
  const basePriceDate = optionalDate(
    computed && computed.basePriceDate,
    `${symbol}.basePriceDate`,
    flags,
    dateErrors
  );
  const lastPriceDate = optionalDate(
    computed && computed.lastPriceDate,
    `${symbol}.lastPriceDate`,
    flags,
    dateErrors
  );
  const baseAdjFactorDate = optionalDate(
    computed && computed.baseAdjFactorDate,
    symbol + ".baseAdjFactorDate",
    flags,
    dateErrors
  );
  const lastAdjFactorDate = optionalDate(
    computed && computed.lastAdjFactorDate,
    symbol + ".lastAdjFactorDate",
    flags,
    dateErrors
  );
  const referenceSourceAsOf = optionalDate(
    firstValue(
      reference && firstValue(reference.sourceAsOf, reference.asOf),
      defaultReferenceSourceAsOf
    ),
    `${symbol}.referenceSourceAsOf`,
    flags,
    dateErrors
  );
  const computedSourceAsOf = optionalDate(
    firstValue(
      computed && firstValue(computed.sourceAsOf, computed.asOf),
      defaultComputedSourceAsOf
    ),
    `${symbol}.computedSourceAsOf`,
    flags,
    dateErrors
  );

  dateErrors.forEach((error) => dateMismatches.push({ symbol, ...error }));

  const computedYtd = ytdNumber(computed && firstValue(computed.computedYtd, computed.ytd));
  const referenceYtd = ytdNumber(
    reference && firstValue(reference.referenceYtd, reference.reportYtd, reference.ytd)
  );
  const baseRawClose = positiveNumber(
    computed && firstValue(computed.baseRawClose, computed.baseClose)
  );
  const baseAdjFactor = positiveNumber(computed && computed.baseAdjFactor);
  const lastRawClose = positiveNumber(
    computed && firstValue(computed.lastRawClose, computed.lastClose, computed.currentClose)
  );
  const lastAdjFactor = positiveNumber(
    computed && firstValue(computed.lastAdjFactor, computed.currentAdjFactor)
  );
  const computedReason = computed && computed.ineligibilityReason
    ? String(computed.ineligibilityReason)
    : null;
  const isNewListing = computedReason === "NEW_LISTING" || Boolean(listingDate && listingDate > baseDate);

  let ineligibilityReason = null;
  let selectedYtd = null;
  let ytdSource = null;
  let deviationBp = null;
  let quarantined = false;

  if (exchange !== symbolExchange || normalizedCode !== symbolCode) {
    ineligibilityReason = "DATA_QUALITY_REJECTED";
    flags.add("SYMBOL_MASTER_DATA_MISMATCH");
    quarantined = true;
  } else if (requireMasterData && (securityType == null || securityType === "")) {
    ineligibilityReason = "DATA_QUALITY_REJECTED";
    flags.add("MISSING_SECURITY_TYPE");
    quarantined = true;
  } else if (requireMasterData && (listingStatus == null || listingStatus === "")) {
    ineligibilityReason = "DATA_QUALITY_REJECTED";
    flags.add("MISSING_LISTING_STATUS");
    quarantined = true;
  } else if (!exchange || !["SH", "SZ", "BSE"].includes(exchange) || !isSupportedSecurity(securityType)) {
    ineligibilityReason = "NOT_ELIGIBLE_SECURITY";
    flags.add("NOT_ELIGIBLE_SECURITY");
  } else if (!isCurrentlyListed(listingStatus)) {
    ineligibilityReason = "NOT_ELIGIBLE_SECURITY";
    flags.add("NOT_CURRENTLY_LISTED");
  } else if (isNewListing) {
    ineligibilityReason = "NEW_LISTING";
    flags.add("NEW_LISTING");
  } else if (!listingDate) {
    ineligibilityReason = "DATA_QUALITY_REJECTED";
    flags.add("MISSING_LISTING_DATE");
    quarantined = true;
  } else if (computedDuplicate) {
    ineligibilityReason = "DATA_QUALITY_REJECTED";
    quarantined = true;
  } else if (computedReason) {
    ineligibilityReason = computedReason;
    flags.add(computedReason);
  }

  if (!ineligibilityReason && computedYtd != null) {
    if (!basePriceDate) {
      ineligibilityReason = "MISSING_BASE_PRICE";
      flags.add("MISSING_BASE_PRICE_DATE");
    } else if (!lastPriceDate) {
      ineligibilityReason = "MISSING_CURRENT_PRICE";
      flags.add("MISSING_LAST_PRICE_DATE");
    } else if (basePriceDate > baseDate || lastPriceDate > asOf) {
      ineligibilityReason = "DATA_QUALITY_REJECTED";
      flags.add(basePriceDate > baseDate ? "BASE_PRICE_AFTER_BASE_DATE" : "LAST_PRICE_AFTER_AS_OF");
      quarantined = true;
    } else if (lastPriceDate < basePriceDate) {
      ineligibilityReason = "DATA_QUALITY_REJECTED";
      flags.add("PRICE_DATE_ORDER_INVALID");
      quarantined = true;
    } else if (!computedSourceAsOf) {
      ineligibilityReason = "DATA_QUALITY_REJECTED";
      flags.add("MISSING_COMPUTED_SOURCE_DATE");
      quarantined = true;
    } else if (computedSourceAsOf !== asOf) {
      ineligibilityReason = "DATA_QUALITY_REJECTED";
      flags.add("COMPUTED_DATE_MISMATCH");
      dateMismatches.push({
        symbol,
        field: "computedSourceAsOf",
        expected: asOf,
        actual: computedSourceAsOf
      });
      quarantined = true;
    } else {
      const hasAdjustmentValues =
        baseRawClose != null &&
        baseAdjFactor != null &&
        lastRawClose != null &&
        lastAdjFactor != null;
      const hasAdjustmentDates =
        baseAdjFactorDate != null &&
        lastAdjFactorDate != null;

      if ((!hasAdjustmentValues || !hasAdjustmentDates) && requireAdjustmentAudit) {
        ineligibilityReason =
          !hasAdjustmentDates || baseAdjFactor == null || lastAdjFactor == null
            ? "MISSING_ADJ_FACTOR"
            : baseRawClose == null
              ? "MISSING_BASE_PRICE"
              : "MISSING_CURRENT_PRICE";
        flags.add("ADJUSTMENT_AUDIT_INCOMPLETE");
      } else if (
        hasAdjustmentDates &&
        (baseAdjFactorDate !== basePriceDate || lastAdjFactorDate !== lastPriceDate)
      ) {
        ineligibilityReason = "DATA_QUALITY_REJECTED";
        flags.add("ADJ_FACTOR_DATE_MISMATCH");
        quarantined = true;
      } else if (hasAdjustmentValues) {
        const auditedYtd =
          (lastRawClose * lastAdjFactor) / (baseRawClose * baseAdjFactor) - 1;

        if (Math.abs(auditedYtd - computedYtd) > COMPUTATION_TOLERANCE) {
          ineligibilityReason = "DATA_QUALITY_REJECTED";
          flags.add("COMPUTED_YTD_AUDIT_MISMATCH");
          quarantined = true;
        }
      } else {
        flags.add("ADJUSTMENT_AUDIT_INCOMPLETE");
      }
    }

    if (!ineligibilityReason) {
      selectedYtd = computedYtd;
      ytdSource = "computed";
    }
  }

  if (!ineligibilityReason && computedYtd == null) {
    if (
      allowReferenceOnly &&
      referenceYtd != null &&
      referenceSourceAsOf === asOf &&
      !referenceDuplicate
    ) {
      selectedYtd = referenceYtd;
      ytdSource = "reference-only";
      flags.add("REFERENCE_ONLY");
    } else {
      ineligibilityReason = "DATA_QUALITY_REJECTED";
      flags.add(allowReferenceOnly ? "REFERENCE_ONLY_UNAVAILABLE" : "MISSING_COMPUTED_YTD");
      quarantined = true;
    }
  }

  if (reference) {
    if (!referenceSourceAsOf) {
      flags.add("REFERENCE_DATE_MISSING");
    } else if (referenceSourceAsOf !== asOf) {
      flags.add("REFERENCE_DATE_MISMATCH");
      dateMismatches.push({
        symbol,
        field: "referenceSourceAsOf",
        expected: asOf,
        actual: referenceSourceAsOf
      });
      if (ytdSource === "reference-only") {
        selectedYtd = null;
        ytdSource = null;
        ineligibilityReason = "DATA_QUALITY_REJECTED";
        quarantined = true;
      }
    } else if (referenceYtd == null) {
      flags.add("REFERENCE_YTD_MISSING");
    } else if (selectedYtd != null && ytdSource === "computed") {
      deviationBp = Math.abs(computedYtd - referenceYtd) * 10000;

      if (deviationBp <= PASS_TOLERANCE_BP + Number.EPSILON) {
        flags.add("REFERENCE_CHECK_PASSED");
      } else if (deviationBp <= QUARANTINE_TOLERANCE_BP + Number.EPSILON) {
        flags.add("REFERENCE_DEVIATION_WARNING");
      } else {
        flags.add("REFERENCE_DEVIATION_QUARANTINED");
        selectedYtd = null;
        ineligibilityReason = "DATA_QUALITY_REJECTED";
        quarantined = true;
      }
    }
  } else {
    flags.add("REFERENCE_MISSING");
  }

  const isEligible = selectedYtd != null && !ineligibilityReason;
  const warningFlags = new Set([
    "REFERENCE_DEVIATION_WARNING",
    "REFERENCE_MISSING",
    "REFERENCE_DATE_MISSING",
    "REFERENCE_DATE_MISMATCH",
    "ADJUSTMENT_AUDIT_INCOMPLETE",
    "REFERENCE_ONLY"
  ]);
  const hasWarning = [...flags].some((flag) => warningFlags.has(flag));

  return {
    symbol,
    code: normalizedCode,
    name,
    exchange,
    board,
    listingDate,
    listingStatus,
    securityType,
    ytd: isEligible ? selectedYtd : null,
    computedYtd,
    referenceYtd,
    deviationBp,
    basePriceDate,
    lastPriceDate,
    baseRawClose,
    baseAdjFactor,
    baseAdjFactorDate,
    lastRawClose,
    lastAdjFactor,
    lastAdjFactorDate,
    source: ytdSource === "reference-only"
      ? firstValue(reference && reference.source, "eastmoney-reference")
      : firstValue(computed && computed.source),
    computedSource: firstValue(computed && computed.source),
    referenceSource: firstValue(reference && reference.source),
    sourceAsOf: ytdSource === "reference-only"
      ? referenceSourceAsOf
      : computedSourceAsOf,
    referenceSourceAsOf,
    ytdSource,
    hasFullYtd: isEligible,
    isEligible,
    ineligibilityReason,
    quarantined,
    qualityStatus: quarantined
      ? "quarantined"
      : !isEligible
        ? "excluded"
        : hasWarning
          ? "warning"
          : "pass",
    qualityFlags: [...flags]
  };
}

function buildPool(records, exchanges, scope, includeBse) {
  const scopeRecords = records.filter((record) => exchanges.has(record.exchange));
  const entries = scopeRecords
    .filter((record) => record.isEligible)
    .map((record) => ({ symbol: record.symbol, ytd: record.ytd }))
    .sort((left, right) => left.ytd - right.ytd || left.symbol.localeCompare(right.symbol));

  return {
    scope,
    includeBse,
    entries,
    sortedYtd: entries.map((entry) => entry.ytd),
    poolEligibleCount: entries.length,
    excludedCount: scopeRecords.length - entries.length
  };
}

function countExpectedRecords(records, baseDate) {
  return records.filter((record) => {
    if (!["SH", "SZ", "BSE"].includes(record.exchange)) return false;
    if (!isCurrentlyListed(record.listingStatus)) return false;
    return !record.listingDate || record.listingDate <= baseDate;
  }).length;
}

function buildStockSnapshot(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("snapshot input must be an object");
  }

  const asOf = normalizeDate(input.asOf, "asOf");
  const baseDate = normalizeDate(input.baseDate, "baseDate");
  const expectedAsOfValue = input.expectedAsOf;
  const expectedBaseDateValue = input.expectedBaseDate;
  const expectedAsOf = normalizeDate(expectedAsOfValue || asOf, "expectedAsOf");
  const expectedBaseDate = normalizeDate(
    expectedBaseDateValue || baseDate,
    "expectedBaseDate"
  );

  if (baseDate > asOf) {
    throw new RangeError("baseDate must not be later than asOf");
  }
  if (
    baseDate !== asOf &&
    Number(baseDate.slice(0, 4)) !== Number(asOf.slice(0, 4)) - 1
  ) {
    throw new RangeError("baseDate must be in the calendar year before asOf");
  }

  const computedRecords = input.computedRecords || [];
  const referenceRecords = input.referenceRecords || [];
  const allowReferenceOnly = input.allowReferenceOnly === true;
  const requireAdjustmentAudit = input.requireAdjustmentAudit !== false;
  const requireMasterData = input.requireMasterData !== false;
  const defaultReferenceSourceAsOf = firstValue(input.referenceSourceAsOf, input.sourceAsOf);
  const defaultComputedSourceAsOf = firstValue(input.computedSourceAsOf, input.sourceAsOf);
  const minCoverageRatio = input.minCoverageRatio == null
    ? DEFAULT_MIN_COVERAGE_RATIO
    : finiteNumber(input.minCoverageRatio);

  if (minCoverageRatio == null || minCoverageRatio < 0 || minCoverageRatio > 1) {
    throw new RangeError("minCoverageRatio must be between 0 and 1");
  }

  const invalidRecords = [];
  const dateMismatches = [];
  const computedIndex = indexRecords(computedRecords, "computed", invalidRecords);
  const referenceIndex = indexRecords(referenceRecords, "reference", invalidRecords);
  const symbols = [...new Set([...computedIndex.keys(), ...referenceIndex.keys()])].sort();
  const duplicates = {
    computed: [...computedIndex.entries()]
      .filter(([, matches]) => matches.length > 1)
      .map(([symbol]) => symbol),
    reference: [...referenceIndex.entries()]
      .filter(([, matches]) => matches.length > 1)
      .map(([symbol]) => symbol)
  };

  const records = symbols.map((symbol) => mergeRecord({
    symbol,
    computedMatches: computedIndex.get(symbol) || [],
    referenceMatches: referenceIndex.get(symbol) || [],
    asOf,
    baseDate,
    allowReferenceOnly,
    requireAdjustmentAudit,
    requireMasterData,
    defaultReferenceSourceAsOf,
    defaultComputedSourceAsOf,
    dateMismatches
  }));
  const pools = {
    shSz: buildPool(records, new Set(["SH", "SZ"]), "SH_SZ", false),
    shSzBse: buildPool(records, new Set(["SH", "SZ", "BSE"]), "SH_SZ_BSE", true)
  };
  const automaticExpectedCount = countExpectedRecords(records, baseDate);
  const expectedCountValue = firstValue(input.expectedUniverseCount, input.expectedCount);
  const expectedCount = expectedCountValue == null
    ? automaticExpectedCount
    : finiteNumber(expectedCountValue);

  if (expectedCount == null || !Number.isInteger(expectedCount) || expectedCount < 0) {
    throw new RangeError("expectedUniverseCount must be a non-negative integer");
  }

  const eligibleCount = pools.shSzBse.poolEligibleCount;
  const independentCount = records.filter(
    (record) => record.isEligible && record.ytdSource === "computed"
  ).length;
  const comparableReferenceCount = records.filter(
    (record) =>
      record.isEligible &&
      record.ytdSource === "computed" &&
      record.referenceYtd != null &&
      record.referenceSourceAsOf === asOf
  ).length;
  const coverageRatio = expectedCount === 0 ? 0 : Math.min(1, eligibleCount / expectedCount);
  const independentCoverageRatio = expectedCount === 0
    ? 0
    : Math.min(1, independentCount / expectedCount);
  const coverage = {
    expectedCount,
    eligibleCount,
    independentCount,
    ratio: coverageRatio,
    independentRatio: independentCoverageRatio,
    minimumRatio: minCoverageRatio,
    passed: expectedCount > 0 && coverageRatio >= minCoverageRatio,
    basis: expectedCountValue == null ? "record-union" : "explicit-count"
  };

  const referenceOnlyCount = records.filter(
    (record) => record.isEligible && record.ytdSource === "reference-only"
  ).length;
  const computedEligibleRecords = records.filter(
    (record) => record.isEligible && record.ytdSource === "computed"
  );
  const missingComputedSourceCount = computedEligibleRecords.filter(
    (record) => !String(record.computedSource || "").trim()
  ).length;
  const computedSources = [...new Set(computedEligibleRecords
    .map((record) => String(record.computedSource || "").trim().toLowerCase())
    .filter(Boolean))].sort();
  const unsupportedComputedSources = computedSources.filter(
    (source) => !PRODUCTION_COMPUTED_SOURCES.has(source)
  );
  const quarantinedCount = records.filter((record) => record.quarantined).length;
  const errors = [];
  const warnings = [];

  if (expectedCountValue == null) {
    errors.push(makeIssue("MISSING_EXPECTED_UNIVERSE_COUNT", {
      automaticExpectedCount
    }));
  }
  if (expectedAsOfValue == null) {
    errors.push(makeIssue("MISSING_EXPECTED_AS_OF"));
  }
  if (expectedBaseDateValue == null) {
    errors.push(makeIssue("MISSING_EXPECTED_BASE_DATE"));
  }
  if (asOf !== expectedAsOf) {
    errors.push(makeIssue("AS_OF_MISMATCH", { asOf, expectedAsOf }));
  }
  if (baseDate !== expectedBaseDate) {
    errors.push(makeIssue("BASE_DATE_MISMATCH", { baseDate, expectedBaseDate }));
  }
  if (minCoverageRatio < DEFAULT_MIN_COVERAGE_RATIO) {
    errors.push(makeIssue("UNSAFE_MIN_COVERAGE_RATIO", {
      configured: minCoverageRatio,
      minimum: DEFAULT_MIN_COVERAGE_RATIO
    }));
  }
  if (!requireAdjustmentAudit || !requireMasterData) {
    errors.push(makeIssue("UNSAFE_QUALITY_GATE_OVERRIDE", {
      requireAdjustmentAudit,
      requireMasterData
    }));
  }
  if (invalidRecords.length) errors.push(makeIssue("INVALID_RECORDS", { count: invalidRecords.length }));
  if (duplicates.computed.length) {
    errors.push(makeIssue("DUPLICATE_COMPUTED_SYMBOLS", { symbols: duplicates.computed }));
  }
  if (duplicates.reference.length) {
    errors.push(makeIssue("DUPLICATE_REFERENCE_SYMBOLS", { symbols: duplicates.reference }));
  }
  if (!coverage.passed) errors.push(makeIssue("INSUFFICIENT_COVERAGE", coverage));
  if (eligibleCount > expectedCount) {
    errors.push(makeIssue("ELIGIBLE_COUNT_EXCEEDS_EXPECTED", {
      eligibleCount,
      expectedCount
    }));
  }
  if (pools.shSz.poolEligibleCount === 0) errors.push(makeIssue("EMPTY_SH_SZ_POOL"));
  if (referenceOnlyCount) {
    errors.push(makeIssue("REFERENCE_ONLY_NOT_PRODUCTION_SAFE", { count: referenceOnlyCount }));
  }
  if (missingComputedSourceCount) {
    errors.push(makeIssue("MISSING_COMPUTED_SOURCE", {
      count: missingComputedSourceCount
    }));
  }
  if (computedSources.length > 1) {
    errors.push(makeIssue("MIXED_COMPUTED_SOURCES", {
      sources: computedSources
    }));
  }
  if (unsupportedComputedSources.length) {
    errors.push(makeIssue("UNSUPPORTED_COMPUTED_SOURCE", {
      sources: unsupportedComputedSources
    }));
  }
  if (referenceRecords.length === 0) {
    warnings.push(makeIssue("REFERENCE_SOURCE_UNAVAILABLE"));
  }
  if (independentCount > 0 && comparableReferenceCount < independentCount) {
    warnings.push(makeIssue(
      comparableReferenceCount === 0
        ? "REFERENCE_SOURCE_UNUSABLE"
        : "PARTIAL_REFERENCE_COVERAGE",
      {
        comparableReferenceCount,
        independentCount
      }
    ));
  }
  if (dateMismatches.length) {
    warnings.push(makeIssue("DATE_INCONSISTENCIES", { count: dateMismatches.length }));
  }
  if (quarantinedCount) {
    warnings.push(makeIssue("QUARANTINED_RECORDS", { count: quarantinedCount }));
  }
  if (records.some((record) => record.qualityFlags.includes("REFERENCE_DEVIATION_WARNING"))) {
    warnings.push(makeIssue("REFERENCE_DEVIATION_WARNINGS"));
  }

  const productionPublishable = errors.length === 0;
  const stocks = Object.create(null);
  records.forEach((record) => {
    stocks[record.symbol] = record;
  });

  return {
    schemaVersion: "stock-ytd-snapshot.v1",
    methodologyVersion: input.methodologyVersion || "adjusted-ytd.v1",
    poolVersion: input.poolVersion || "a-share.v1",
    asOf,
    expectedAsOf,
    expectedBaseDate,
    isStale: asOf < expectedAsOf,
    baseDate,
    generatedAt: input.generatedAt || null,
    publishedAt: input.publishedAt || null,
    sourceMode: independentCount > 0
      ? comparableReferenceCount === independentCount
        ? "validated"
        : comparableReferenceCount === 0
          ? "computed-fallback"
          : "partially-validated"
      : referenceOnlyCount > 0
        ? "reference-only"
        : "empty",
    productionPublishable,
    releaseDecision: productionPublishable ? "PUBLISH" : "BLOCK",
    records,
    stocks,
    pools,
    quality: {
      status: errors.length ? "error" : warnings.length ? "warning" : "pass",
      errors,
      warnings,
      duplicates,
      invalidRecords,
      dateMismatches,
      coverage,
      computedSources: {
        allowed: [...PRODUCTION_COMPUTED_SOURCES],
        active: computedSources,
        missingCount: missingComputedSourceCount
      },
      counts: {
        computedInput: computedRecords.length,
        referenceInput: referenceRecords.length,
        merged: records.length,
        eligible: eligibleCount,
        excluded: records.length - eligibleCount,
        quarantined: quarantinedCount,
        referenceOnly: referenceOnlyCount,
        comparableReference: comparableReferenceCount,
        newListings: records.filter((record) => record.ineligibilityReason === "NEW_LISTING").length
      }
    }
  };
}

function queryStockSnapshot(snapshot, symbol, options = {}) {
  if (!snapshot || typeof snapshot !== "object" || !snapshot.pools || !snapshot.stocks) {
    throw new TypeError("snapshot is invalid");
  }
  if (snapshot.productionPublishable !== true && options.allowBlocked !== true) {
    const error = new Error("blocked stock snapshot cannot be queried");
    error.code = "SNAPSHOT_NOT_PUBLISHABLE";
    error.quality = snapshot.quality;
    throw error;
  }

  const normalizedSymbol = normalizeSymbol({ symbol }, "query");
  const stock = snapshot.stocks[normalizedSymbol];

  if (!stock) {
    return null;
  }

  if (!stock.isEligible) {
    return {
      asOf: snapshot.asOf,
      expectedAsOf: snapshot.expectedAsOf,
      publishedAt: snapshot.publishedAt,
      isStale: snapshot.isStale,
      baseDate: snapshot.baseDate,
      methodologyVersion: snapshot.methodologyVersion,
      stock,
      comparison: null
    };
  }

  const includeBse = options.includeBse === true;
  const pool = includeBse ? snapshot.pools.shSzBse : snapshot.pools.shSz;
  const targetInPool = pool.entries.some((entry) => entry.symbol === normalizedSymbol);
  const firstEqual = lowerBound(pool.sortedYtd, stock.ytd);
  const firstHigher = upperBound(pool.sortedYtd, stock.ytd);
  const beatCount = firstEqual;
  const higherCount = pool.sortedYtd.length - firstHigher;
  const tieCount = firstHigher - firstEqual - (targetInPool ? 1 : 0);
  const peerCount = pool.poolEligibleCount - (targetInPool ? 1 : 0);
  const rankPosition = higherCount + 1;
  const rankPopulation = peerCount + 1;

  return {
    asOf: snapshot.asOf,
    expectedAsOf: snapshot.expectedAsOf,
    publishedAt: snapshot.publishedAt,
    isStale: snapshot.isStale,
    baseDate: snapshot.baseDate,
    methodologyVersion: snapshot.methodologyVersion,
    stock,
    comparison: {
      scope: pool.scope,
      includeBse,
      beatCount,
      peerCount,
      beatRatio: peerCount === 0 ? null : beatCount / peerCount,
      tieCount,
      higherCount,
      rankPosition,
      rankPopulation,
      topRatio: rankPosition / rankPopulation,
      poolEligibleCount: pool.poolEligibleCount,
      excludedCount: pool.excludedCount,
      targetInPool
    }
  };
}

function assertSnapshotPublishable(snapshot) {
  if (!snapshot || snapshot.productionPublishable !== true) {
    const error = new Error("stock snapshot did not pass production quality gates");
    error.code = "SNAPSHOT_NOT_PUBLISHABLE";
    error.quality = snapshot && snapshot.quality;
    throw error;
  }

  return snapshot;
}

module.exports = {
  PASS_TOLERANCE_BP,
  QUARANTINE_TOLERANCE_BP,
  DEFAULT_MIN_COVERAGE_RATIO,
  normalizeDate,
  normalizeSymbol,
  buildStockSnapshot,
  queryStockSnapshot,
  assertSnapshotPublishable
};
