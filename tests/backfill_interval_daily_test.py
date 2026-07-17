import importlib.util
import sys
import unittest
from pathlib import Path

MODULE_PATH = (
    Path(__file__).resolve().parents[1] / "scripts" / "backfill_interval_daily.py"
)
SPEC = importlib.util.spec_from_file_location("backfill_interval_daily", MODULE_PATH)
backfill = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = backfill
SPEC.loader.exec_module(backfill)


class FakeResult:
    def __init__(self, rows):
        self.error_code = "0"
        self.error_msg = ""
        self._rows = list(rows)
        self._index = 0

    def next(self):
        return self._index < len(self._rows)

    def get_row_data(self):
        row = self._rows[self._index]
        self._index += 1
        return row


class SeriesToDailyTests(unittest.TestCase):
    TRADING_DAYS = ["2025-12-31", "2026-01-05", "2026-01-06", "2026-01-07"]

    def test_base_day_is_zero_and_daily_ytd_follows_series(self):
        prices = [
            ("2025-12-31", 100.0),
            ("2026-01-05", 90.0),
            ("2026-01-06", 81.0),
            ("2026-01-07", 121.0),
        ]
        daily = backfill.series_to_daily(prices, "2025-12-31", self.TRADING_DAYS)
        self.assertEqual(daily["2025-12-31"], {"ytd": 0.0})
        self.assertAlmostEqual(daily["2026-01-05"]["ytd"], -0.1)
        self.assertAlmostEqual(daily["2026-01-06"]["ytd"], -0.19)
        self.assertAlmostEqual(daily["2026-01-07"]["ytd"], 0.21)
        self.assertNotIn("lastPriceDate", daily["2026-01-07"])

    def test_suspended_day_reuses_latest_close_with_marker(self):
        prices = [("2025-12-31", 100.0), ("2026-01-05", 90.0)]
        daily = backfill.series_to_daily(prices, "2025-12-31", self.TRADING_DAYS)
        self.assertAlmostEqual(daily["2026-01-07"]["ytd"], -0.1)
        self.assertEqual(daily["2026-01-07"]["lastPriceDate"], "2026-01-05")
        self.assertNotIn("lastPriceDate", daily["2026-01-05"])

    def test_missing_base_price_is_reported(self):
        prices = [("2026-01-05", 90.0)]
        self.assertEqual(
            backfill.series_to_daily(prices, "2025-12-31", self.TRADING_DAYS),
            "MISSING_BASE_PRICE",
        )
        self.assertEqual(
            backfill.series_to_daily([], "2025-12-31", self.TRADING_DAYS),
            "MISSING_HISTORY",
        )

    def test_base_price_uses_last_close_on_or_before_base_date(self):
        prices = [("2025-12-30", 50.0), ("2026-01-06", 55.0)]
        daily = backfill.series_to_daily(prices, "2025-12-31", self.TRADING_DAYS)
        self.assertAlmostEqual(daily["2026-01-06"]["ytd"], 0.1)
        self.assertEqual(daily["2025-12-31"]["lastPriceDate"], "2025-12-30")


class BaostockDailyTests(unittest.TestCase):
    def test_baostock_daily_ytd_builds_series(self):
        master = backfill.fsy.MasterRecord(
            code="600000",
            name="浦发银行",
            exchange="SH",
            listing_date="1999-11-10",
            board="主板",
        )

        class Provider:
            def query_history_k_data_plus(self, code, fields, **options):
                assert options["adjustflag"] == "2"
                return FakeResult([
                    ["2025-12-31", "sh.600000", "10.00", "1"],
                    ["2026-01-05", "sh.600000", "9.00", "1"],
                ])

        daily = backfill.baostock_daily_ytd(
            Provider(), master, "2025-12-31",
            ["2025-12-31", "2026-01-05", "2026-01-06"],
        )
        self.assertAlmostEqual(daily["2026-01-05"]["ytd"], -0.1)
        self.assertAlmostEqual(daily["2026-01-06"]["ytd"], -0.1)
        self.assertEqual(daily["2026-01-06"]["lastPriceDate"], "2026-01-05")

    def test_new_listing_is_flagged(self):
        master = backfill.fsy.MasterRecord(
            code="301999",
            name="新股",
            exchange="SZ",
            listing_date="2026-03-01",
            board="创业板",
        )
        self.assertEqual(
            backfill.baostock_daily_ytd(object(), master, "2025-12-31", ["2025-12-31"]),
            "NEW_LISTING",
        )


class IndexClosesTests(unittest.TestCase):
    def test_index_closes_parse_and_skip_invalid(self):
        class Provider:
            def query_history_k_data_plus(self, code, fields, **options):
                assert code == "sh.000300"
                assert fields == "date,close"
                return FakeResult([
                    ["2025-12-31", "3999.99"],
                    ["2026-01-05", "0"],
                    ["2026-01-06", "3888.50"],
                ])

        closes = backfill.baostock_index_closes(
            Provider(), "sh.000300", "2025-12-31", "2026-01-06"
        )
        self.assertEqual(closes, {"2025-12-31": 3999.99, "2026-01-06": 3888.5})


class TradingDaysTests(unittest.TestCase):
    def test_trading_days_between_filters_open_days(self):
        rows = [
            ["2025-12-30", "1"],
            ["2025-12-31", "1"],
            ["2026-01-01", "0"],
            ["2026-01-05", "1"],
            ["2026-07-20", "1"],
        ]
        days = backfill._trading_days_between(rows, "2025-12-31", "2026-01-05")
        self.assertEqual(days, ["2025-12-31", "2026-01-05"])


if __name__ == "__main__":
    unittest.main()
