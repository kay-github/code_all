const assert = require("assert");
const {
  addCalendarDays,
  createTradingCalendar,
  deriveExpectedDatesFromCalendar,
  validateTradingCalendar
} = require("../lib/stockTradingDates");

const calendar = createTradingCalendar([
  { cal_date: "20251231", is_open: 1 },
  { cal_date: "20260710", is_open: 1 },
  { cal_date: "20260713", is_open: 1 }
], {
  coveredFrom: "2025-12-01",
  coveredThrough: "2026-08-31"
});

assert.deepStrictEqual(validateTradingCalendar(calendar), calendar);
assert.strictEqual(addCalendarDays("2026-07-31", 1), "2026-08-01");

let dates = deriveExpectedDatesFromCalendar(calendar, {
  year: "2026",
  month: "07",
  day: "13",
  hour: "18",
  minute: "29"
});
assert.strictEqual(dates.expectedAsOf, "2026-07-10");
assert.strictEqual(dates.baseDate, "2025-12-31");
assert.strictEqual(dates.ytdPeriodStarted, true);

dates = deriveExpectedDatesFromCalendar(calendar, {
  year: "2026",
  month: "07",
  day: "13",
  hour: "18",
  minute: "30"
});
assert.strictEqual(dates.expectedAsOf, "2026-07-13");

const rolloverCalendar = createTradingCalendar([
  { cal_date: "20251231", is_open: 1 }
], {
  coveredFrom: "2025-12-01",
  coveredThrough: "2026-02-28"
});
dates = deriveExpectedDatesFromCalendar(rolloverCalendar, {
  year: "2026",
  month: "01",
  day: "01",
  hour: "18",
  minute: "30"
});
assert.strictEqual(dates.expectedAsOf, "2025-12-31");
assert.strictEqual(dates.baseDate, "2025-12-31");
assert.strictEqual(dates.ytdPeriodStarted, false);

assert.throws(
  () => deriveExpectedDatesFromCalendar(calendar, {
    year: "2026",
    month: "09",
    day: "01",
    hour: "18",
    minute: "30"
  }),
  (error) => error.code === "TRADING_CALENDAR_COVERAGE_MISSING"
);

console.log("stock trading date tests passed");
