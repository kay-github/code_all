"use strict";

const { normalizeDate } = require("./stockSnapshot");

const TRADING_CALENDAR_VERSION = "sse-trading-calendar.v1";

function shanghaiDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function deriveExpectedDates(calendarRows, nowParts) {
  if (!Array.isArray(calendarRows)) {
    throw new TypeError("calendarRows must be an array");
  }
  const today = nowParts.year + "-" + nowParts.month + "-" + nowParts.day;
  const cutoffPassed =
    Number(nowParts.hour) > 18 ||
    (Number(nowParts.hour) === 18 && Number(nowParts.minute) >= 30);
  const openDates = [...new Set(
    calendarRows
      .filter((row) => String(row.is_open) === "1")
      .map((row) => normalizeDate(row.cal_date))
  )].sort();
  const expectedAsOf = openDates.filter(
    (date) => date < today || (date === today && cutoffPassed)
  ).at(-1);
  const baseCutoff = String(Number(nowParts.year) - 1) + "-12-31";
  const baseDate = openDates.filter((date) => date <= baseCutoff).at(-1);
  if (!expectedAsOf || !baseDate || expectedAsOf < baseDate) {
    throw new Error("trade calendar does not cover YTD endpoints");
  }
  return {
    today,
    expectedAsOf,
    baseDate,
    ytdPeriodStarted: expectedAsOf > baseDate
  };
}

function addCalendarDays(value, days) {
  const date = normalizeDate(value, "calendar date");
  const offset = Number(days);
  if (!Number.isInteger(offset)) {
    throw new TypeError("calendar day offset must be an integer");
  }
  const timestamp = Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10)) + offset
  );
  return new Date(timestamp).toISOString().slice(0, 10);
}

function createTradingCalendar(calendarRows, options = {}) {
  if (!Array.isArray(calendarRows)) {
    throw new TypeError("calendarRows must be an array");
  }
  const coveredFrom = normalizeDate(options.coveredFrom, "calendar.coveredFrom");
  const coveredThrough = normalizeDate(
    options.coveredThrough,
    "calendar.coveredThrough"
  );
  if (coveredFrom > coveredThrough) {
    throw new RangeError("trading calendar coverage is invalid");
  }
  const openDates = [...new Set(calendarRows
    .filter((row) => String(row && row.is_open) === "1")
    .map((row) => normalizeDate(row.cal_date, "calendar.cal_date")))]
    .sort();
  if (
    openDates.length === 0 ||
    openDates.some((date) => date < coveredFrom || date > coveredThrough)
  ) {
    throw new RangeError("trading calendar open dates are invalid");
  }
  return {
    version: TRADING_CALENDAR_VERSION,
    coveredFrom,
    coveredThrough,
    openDates
  };
}

function validateTradingCalendar(calendar) {
  if (
    !calendar ||
    calendar.version !== TRADING_CALENDAR_VERSION ||
    !Array.isArray(calendar.openDates)
  ) {
    throw new TypeError("trading calendar is invalid");
  }
  const rebuilt = createTradingCalendar(
    calendar.openDates.map((calDate) => ({ cal_date: calDate, is_open: 1 })),
    {
      coveredFrom: calendar.coveredFrom,
      coveredThrough: calendar.coveredThrough
    }
  );
  if (
    rebuilt.openDates.length !== calendar.openDates.length ||
    rebuilt.openDates.some((date, index) => date !== calendar.openDates[index])
  ) {
    throw new TypeError("trading calendar open dates must be unique and sorted");
  }
  return rebuilt;
}

function deriveExpectedDatesFromCalendar(calendar, nowParts) {
  const validated = validateTradingCalendar(calendar);
  const today = nowParts.year + "-" + nowParts.month + "-" + nowParts.day;
  if (today < validated.coveredFrom || today > validated.coveredThrough) {
    const error = new RangeError("trading calendar does not cover the current date");
    error.code = "TRADING_CALENDAR_COVERAGE_MISSING";
    throw error;
  }
  return deriveExpectedDates(
    validated.openDates.map((calDate) => ({ cal_date: calDate, is_open: 1 })),
    nowParts
  );
}

module.exports = {
  TRADING_CALENDAR_VERSION,
  shanghaiDateParts,
  deriveExpectedDates,
  addCalendarDays,
  createTradingCalendar,
  validateTradingCalendar,
  deriveExpectedDatesFromCalendar
};
