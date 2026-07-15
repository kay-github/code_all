import importlib.util
import json
import sys
import unittest
import zipfile
from datetime import datetime
from io import BytesIO
from pathlib import Path
from unittest import mock
from zoneinfo import ZoneInfo

from openpyxl import Workbook


MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "free_stock_ytd.py"
SPEC = importlib.util.spec_from_file_location("free_stock_ytd", MODULE_PATH)
free_stock_ytd = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = free_stock_ytd
SPEC.loader.exec_module(free_stock_ytd)


class FakeResult:
    def __init__(self, rows, error_code="0"):
        self.rows = rows
        self.error_code = error_code
        self.position = -1

    def next(self):
        self.position += 1
        return self.position < len(self.rows)

    def get_row_data(self):
        return self.rows[self.position]


class FakeBaostock:
    def __init__(self, rows):
        self.rows = rows
        self.calls = []

    def query_history_k_data_plus(self, code, fields, **options):
        self.calls.append((code, fields, options))
        return FakeResult(self.rows)


class FreeStockYtdTests(unittest.TestCase):
    def test_normalization_and_master_identity(self):
        self.assertEqual(free_stock_ytd.normalize_code(1), "000001")
        self.assertEqual(free_stock_ytd.normalize_code("920001.0"), "920001")
        self.assertEqual(free_stock_ytd.normalize_date("20260714"), "2026-07-14")
        record = free_stock_ytd.MasterRecord(
            "920001", "BSE sample", "BSE", "2020-01-01", "BSE"
        )
        self.assertEqual(record.symbol, "920001.BJ")
        self.assertEqual(record.provider_code, "bj920001")
        with self.assertRaisesRegex(free_stock_ytd.FreeStockSourceError, "invalid"):
            free_stock_ytd.normalize_code("bad")

    def test_retry_boundary(self):
        response = mock.Mock(status_code=200)
        session = mock.Mock()
        session.request.side_effect = [RuntimeError("not a requests error"), response]
        with self.assertRaises(RuntimeError):
            free_stock_ytd.request_with_retry(
                session,
                "GET",
                "https://example.test",
                source="test",
                retries=1,
                sleep=lambda _: None,
            )

        session.request.side_effect = [
            free_stock_ytd.requests.ConnectionError("temporary"),
            response,
        ]
        result = free_stock_ytd.request_with_retry(
            session,
            "GET",
            "https://example.test",
            source="test",
            retries=1,
            sleep=lambda _: None,
        )
        self.assertIs(result, response)

    def test_szse_workbook_ignores_stale_dimension(self):
        workbook = Workbook()
        sheet = workbook.active
        sheet.append(["板块", "A股代码", "A股简称", "A股上市日期"])
        sheet.append(["主板", "000001", "平安银行", "1991-04-03"])
        source = BytesIO()
        workbook.save(source)
        rewritten = BytesIO()
        with zipfile.ZipFile(BytesIO(source.getvalue())) as original, zipfile.ZipFile(
            rewritten, "w"
        ) as output:
            for item in original.infolist():
                content = original.read(item.filename)
                if item.filename == "xl/worksheets/sheet1.xml":
                    content = content.replace(b'ref="A1:D2"', b'ref="A1:A1"')
                output.writestr(item, content)

        response = mock.Mock(status_code=200, content=rewritten.getvalue())
        session = mock.Mock()
        session.request.return_value = response
        records = free_stock_ytd.fetch_szse_master(session)
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0].symbol, "000001.SZ")
        self.assertEqual(records[0].name, "平安银行")

    def test_dates_and_endpoint_selection(self):
        calendar = [
            ["2025-12-31", "1"],
            ["2026-07-13", "1"],
            ["2026-07-14", "1"],
            ["2026-07-15", "1"],
        ]
        before_cutoff = datetime(
            2026, 7, 14, 18, 29, tzinfo=ZoneInfo("Asia/Shanghai")
        )
        base_date, as_of, open_dates = free_stock_ytd.derive_dates(
            calendar, before_cutoff
        )
        self.assertEqual(base_date, "2025-12-31")
        self.assertEqual(as_of, "2026-07-13")
        self.assertIn("2026-07-15", open_dates)
        after_cutoff = before_cutoff.replace(hour=18, minute=30)
        self.assertEqual(
            free_stock_ytd.derive_dates(calendar, after_cutoff)[1], "2026-07-14"
        )
        rows = [
            ["2025-12-30", "x", "9.5"],
            ["2026-07-10", "x", "11"],
            ["2026-07-14", "x", "12"],
        ]
        self.assertEqual(
            free_stock_ytd.select_endpoints(rows, "2025-12-31", "2026-07-14"),
            (("2025-12-30", 9.5), ("2026-07-14", 12.0)),
        )

    def test_baostock_qfq_record(self):
        bs = FakeBaostock(
            [
                ["2025-12-31", "sh.600000", "10", "1"],
                ["2026-07-14", "sh.600000", "12", "1"],
            ]
        )
        master = free_stock_ytd.MasterRecord(
            "600000", "SH sample", "SH", "1999-11-10", "MAIN"
        )
        record = free_stock_ytd.baostock_computed_record(
            bs, master, "2025-12-31", "2026-07-14"
        )
        self.assertAlmostEqual(record["computedYtd"], 0.2)
        self.assertEqual(record["adjustmentMethod"], "qfq")
        self.assertEqual(record["baseAdjustedClose"], 10.0)
        self.assertEqual(bs.calls[0][2]["adjustflag"], "2")

    def test_baostock_login_retries_transient_failure(self):
        provider = mock.Mock()
        provider.login.side_effect = [
            RuntimeError("temporary login failure"),
            mock.Mock(error_code="0"),
        ]
        sleeps = []

        free_stock_ytd.login_baostock(provider, sleep=sleeps.append)

        self.assertEqual(provider.login.call_count, 2)
        self.assertEqual(sleeps, [0.5])

    def test_baostock_records_reconnect_periodically_and_after_session_reset(self):
        class ResettingProvider:
            def __init__(self):
                self.active = False
                self.login_calls = 0
                self.logout_calls = 0
                self.reset_done = False

            def login(self):
                self.active = True
                self.login_calls += 1
                return mock.Mock(error_code="0")

            def logout(self):
                self.active = False
                self.logout_calls += 1

            def query_history_k_data_plus(self, code, fields, **options):
                if not self.active:
                    return FakeResult([], error_code="10002007")
                if code == "sh.600001" and not self.reset_done:
                    self.active = False
                    self.reset_done = True
                    return FakeResult([], error_code="10002007")
                return FakeResult(
                    [
                        ["2025-12-31", code, "10", "1"],
                        ["2026-07-14", code, "12", "1"],
                    ]
                )

        provider = ResettingProvider()
        masters = [
            free_stock_ytd.MasterRecord(
                f"60000{index}", f"SH sample {index}", "SH", "2000-01-01", "MAIN"
            )
            for index in range(3)
        ]
        free_stock_ytd.login_baostock(provider, sleep=lambda _: None)

        records, failures = free_stock_ytd.collect_baostock_records(
            provider,
            masters,
            "2025-12-31",
            "2026-07-14",
            reconnect_every=2,
            sleep=lambda _: None,
        )

        self.assertEqual(failures, [])
        self.assertEqual(len(records), 3)
        for record in records:
            self.assertAlmostEqual(record["computedYtd"], 0.2)
        self.assertEqual(provider.login_calls, 3)
        self.assertEqual(provider.logout_calls, 2)

    def test_build_dataset_queries_benchmark_before_stock_history(self):
        events = []

        class OrderedProvider:
            def login(self):
                events.append("login")
                return mock.Mock(error_code="0")

            def logout(self):
                events.append("logout")

            def query_trade_dates(self, **options):
                events.append("calendar")
                return FakeResult(
                    [
                        ["2025-12-31", "1"],
                        ["2026-07-14", "1"],
                        ["2026-07-15", "1"],
                    ]
                )

            def query_history_k_data_plus(self, code, fields, **options):
                if code == "sh.000300":
                    events.append("benchmark")
                    return FakeResult(
                        [
                            ["2025-12-31", code, "4000"],
                            ["2026-07-14", code, "4400"],
                        ]
                    )
                events.append(f"stock:{code}")
                return FakeResult(
                    [
                        ["2025-12-31", code, "10", "1"],
                        ["2026-07-14", code, "12", "1"],
                    ]
                )

        provider = OrderedProvider()
        sh = free_stock_ytd.MasterRecord(
            "600000", "SH sample", "SH", "2000-01-01", "MAIN"
        )
        sz = free_stock_ytd.MasterRecord(
            "000001", "SZ sample", "SZ", "2000-01-01", "MAIN"
        )
        bse = free_stock_ytd.MasterRecord(
            "920001", "BSE sample", "BSE", "2020-01-01", "BSE"
        )
        options = mock.Mock(
            timeout=1,
            limit_per_exchange=1,
            now=datetime(2026, 7, 14, 20, 0, tzinfo=ZoneInfo("Asia/Shanghai")),
            as_of="2026-07-14",
            progress_every=0,
            bse_workers=1,
        )

        def fake_sina_record(master, base_date, as_of, **kwargs):
            return {
                **free_stock_ytd._record_master_fields(master, "sina", as_of),
                "computedYtd": 0.1,
            }

        with mock.patch.dict(sys.modules, {"baostock": provider}), mock.patch.object(
            free_stock_ytd, "default_session", return_value=mock.Mock()
        ), mock.patch.object(
            free_stock_ytd, "fetch_sse_master", return_value=[sh]
        ), mock.patch.object(
            free_stock_ytd, "fetch_szse_master", return_value=[sz]
        ), mock.patch.object(
            free_stock_ytd, "fetch_bse_master", return_value=[bse]
        ), mock.patch.object(
            free_stock_ytd,
            "validate_master",
            return_value={"SH": 1, "SZ": 1, "BSE": 1},
        ), mock.patch.object(
            free_stock_ytd, "sina_computed_record", side_effect=fake_sina_record
        ):
            dataset = free_stock_ytd.build_dataset(options)

        first_stock = min(
            index for index, event in enumerate(events) if event.startswith("stock:")
        )
        self.assertLess(events.index("benchmark"), first_stock)
        self.assertEqual(dataset["indexRows"][1]["close"], 4400.0)

    def test_benchmark_query_retries_after_transient_failure(self):
        class FlakyBenchmark:
            def __init__(self):
                self.calls = 0

            def query_history_k_data_plus(self, *args, **kwargs):
                self.calls += 1
                if self.calls == 1:
                    raise RuntimeError("temporary benchmark failure")
                return FakeResult([
                    ["2025-12-31", "sh.000300", "4000"],
                    ["2026-07-14", "sh.000300", "4400"],
                ])

        benchmark = free_stock_ytd.benchmark_rows(
            FlakyBenchmark(),
            "2025-12-31",
            "2026-07-14",
            sleep=lambda _: None,
        )
        self.assertEqual(len(benchmark), 2)
        self.assertEqual(benchmark[1]["close"], 4400.0)

    def test_benchmark_query_retries_when_endpoint_is_missing(self):
        class MissingEndpointThenHealthy:
            def __init__(self):
                self.calls = 0

            def query_history_k_data_plus(self, *args, **kwargs):
                self.calls += 1
                if self.calls == 1:
                    return FakeResult([["2025-12-31", "sh.000300", "4000"]])
                return FakeResult(
                    [
                        ["2025-12-31", "sh.000300", "4000"],
                        ["2026-07-14", "sh.000300", "4400"],
                    ]
                )

        sleeps = []
        provider = MissingEndpointThenHealthy()
        benchmark = free_stock_ytd.benchmark_rows(
            provider,
            "2025-12-31",
            "2026-07-14",
            sleep=sleeps.append,
        )
        self.assertEqual(provider.calls, 2)
        self.assertEqual(sleeps, [0.5])
        self.assertEqual(benchmark[0]["close"], 4000.0)
        self.assertEqual(benchmark[1]["close"], 4400.0)

    def test_benchmark_query_fails_after_missing_endpoint_retries(self):
        class MissingEndpoint:
            def __init__(self):
                self.calls = 0

            def query_history_k_data_plus(self, *args, **kwargs):
                self.calls += 1
                return FakeResult([["2025-12-31", "sh.000300", "4000"]])

        sleeps = []
        provider = MissingEndpoint()
        with self.assertRaisesRegex(
            free_stock_ytd.FreeStockSourceError, "endpoint is missing"
        ) as context:
            free_stock_ytd.benchmark_rows(
                provider,
                "2025-12-31",
                "2026-07-14",
                retries=2,
                sleep=sleeps.append,
            )
        self.assertEqual(context.exception.code, "CSI300_ENDPOINT_MISSING")
        self.assertEqual(provider.calls, 3)
        self.assertEqual(sleeps, [0.5, 1.0])

    def test_sina_parsing_and_adjusted_return(self):
        history = (
            'var _bj920001=([{"day":"2025-12-31","close":"10"},'
            '{"day":"2026-07-14","close":"12"}]);'
        )
        factors = (
            'var qfq={"data":[{"d":"2025-01-01","f":"2"},'
            '{"d":"2026-01-01","f":"1"}]}\n/* trailing provider comment */'
        )
        self.assertEqual(
            free_stock_ytd.parse_sina_history(history)[-1],
            ("2026-07-14", 12.0),
        )
        self.assertEqual(
            free_stock_ytd.factor_for_date(
                free_stock_ytd.parse_sina_factors(factors), "2025-12-31"
            ),
            (2.0, "2025-01-01"),
        )

        responses = [mock.Mock(text=history), mock.Mock(text=factors)]
        master = free_stock_ytd.MasterRecord(
            "920001", "BSE sample", "BSE", "2020-01-01", "BSE"
        )
        with mock.patch.object(
            free_stock_ytd, "default_session", return_value=mock.Mock()
        ), mock.patch.object(
            free_stock_ytd, "request_with_retry", side_effect=responses
        ):
            record = free_stock_ytd.sina_computed_record(
                master, "2025-12-31", "2026-07-14"
            )
        self.assertAlmostEqual(record["computedYtd"], 1.4)
        self.assertEqual(record["baseAdjFactor"], 0.5)
        self.assertEqual(record["lastAdjFactor"], 1.0)

    def test_bse_jsonp_payload(self):
        payload = {"totalPages": 1, "content": []}
        parsed = free_stock_ytd.parse_bse_payload(
            "callback(" + json.dumps([payload]) + ")"
        )
        self.assertEqual(parsed["totalPages"], 1)
        with self.assertRaisesRegex(free_stock_ytd.FreeStockSourceError, "invalid"):
            free_stock_ytd.parse_bse_payload("not jsonp")

    def test_bse_master_uses_named_fields(self):
        payload = {
            "totalPages": 1,
            "content": [
                {
                    "xxzqdm": "920001",
                    "xxzqjc": "BSE sample",
                    "fxssrq": "20201223",
                }
            ],
        }
        response = mock.Mock(
            status_code=200,
            text="null(" + json.dumps([payload]) + ")",
        )
        session = mock.Mock()
        session.request.return_value = response
        records = free_stock_ytd.fetch_bse_master(session)
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0].symbol, "920001.BJ")
        self.assertEqual(records[0].listing_date, "2020-12-23")


if __name__ == "__main__":
    unittest.main()
