"""区间涨跌分布 Phase 2 回填 Worker。

为 2026 年内每个交易日生成 compact 逐日 YTD 数据，供
`api/stock-interval-stats` 作为基准日数据源（格式见
docs/stock-ytd-ranking/INTERVAL_STATS.md §4）。

数据口径与日常管线一致：沪深用 Baostock 前复权日线，北交所用新浪
原始价 × 前复权因子；基准日（上年末收盘）当天 ytd=0。停牌日沿用最近
一个可用收盘（记录 lastPriceDate）。

用法：
    python scripts/backfill_interval_daily.py --output .stock-ytd-data/interval-backfill.json
    python scripts/backfill_interval_daily.py --limit-per-exchange 5 --output /tmp/diag.json
"""

from __future__ import annotations

import argparse
import concurrent.futures
import importlib.util
import json
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Callable
from zoneinfo import ZoneInfo

MODULE_PATH = Path(__file__).resolve().parent / "free_stock_ytd.py"
_SPEC = importlib.util.spec_from_file_location("free_stock_ytd", MODULE_PATH)
fsy = importlib.util.module_from_spec(_SPEC)
sys.modules.setdefault(_SPEC.name, fsy)
_SPEC.loader.exec_module(fsy)

BACKFILL_VERSION = "stock-ytd-interval-backfill.v1"
DAILY_METHODOLOGY_VERSION = "backfill-qfq.v1"
MIN_DAY_COVERAGE_RATIO = 0.995


def series_to_daily(
    prices: list[tuple[str, float]],
    base_date: str,
    trading_days: list[str],
) -> dict[str, dict[str, Any]] | str:
    """前复权收盘序列 → 逐交易日 {ytd, lastPriceDate}。

    prices 必须按日期升序且全部为正。返回失败原因字符串或逐日映射。
    停牌日沿用最近一个 ≤ D 的收盘并记录 lastPriceDate。
    """
    if not prices:
        return "MISSING_HISTORY"
    base = next((item for item in reversed(prices) if item[0] <= base_date), None)
    if base is None or base[1] <= 0:
        return "MISSING_BASE_PRICE"
    daily: dict[str, dict[str, Any]] = {}
    cursor = 0
    latest: tuple[str, float] | None = None
    for day in trading_days:
        while cursor < len(prices) and prices[cursor][0] <= day:
            latest = prices[cursor]
            cursor += 1
        if latest is None:
            continue
        entry: dict[str, Any] = {"ytd": latest[1] / base[1] - 1}
        if latest[0] != day:
            entry["lastPriceDate"] = latest[0]
        daily[day] = entry
    return daily


def baostock_daily_ytd(
    bs: Any,
    master: Any,
    base_date: str,
    trading_days: list[str],
    *,
    retries: int = 2,
    sleep: Callable[[float], None] = time.sleep,
) -> dict[str, dict[str, Any]] | str:
    if master.listing_date > base_date:
        return "NEW_LISTING"
    start = max(
        master.listing_date,
        (fsy.date.fromisoformat(base_date) - fsy.timedelta(days=62)).isoformat(),
    )
    end = trading_days[-1]
    rows = None
    last_error: Exception | None = None
    for attempt in range(retries + 1):
        try:
            query = bs.query_history_k_data_plus(
                master.provider_code,
                "date,code,close,tradestatus",
                start_date=start,
                end_date=end,
                frequency="d",
                adjustflag="2",
            )
            rows = fsy.collect_baostock_rows(query)
            break
        except Exception as error:
            last_error = error
            if attempt < retries:
                sleep(0.5 * (attempt + 1))
    if rows is None:
        raise fsy.FreeStockSourceError(
            "BAOSTOCK_HISTORY_FAILED", "Baostock history failed", source="baostock"
        ) from last_error
    prices: list[tuple[str, float]] = []
    for row in rows:
        if len(row) < 3:
            continue
        value = fsy.parse_number(row[2])
        if value is None or value <= 0:
            continue
        prices.append((fsy.normalize_date(row[0]), value))
    prices.sort(key=lambda item: item[0])
    return series_to_daily(prices, base_date, trading_days)


def sina_daily_ytd(
    master: Any,
    base_date: str,
    trading_days: list[str],
    *,
    timeout: float = 20,
) -> dict[str, dict[str, Any]] | str:
    if master.listing_date > base_date:
        return "NEW_LISTING"
    symbol = master.provider_code
    session = fsy.default_session("https://finance.sina.com.cn/")
    history_response = fsy.request_with_retry(
        session,
        "GET",
        fsy.SINA_KLINE_URL.format(symbol=symbol),
        source="sina-history",
        timeout=timeout,
        params={"symbol": symbol, "scale": "240", "ma": "no", "datalen": "1023"},
    )
    factor_response = fsy.request_with_retry(
        session,
        "GET",
        fsy.SINA_QFQ_URL.format(symbol=symbol),
        source="sina-factor",
        timeout=timeout,
    )
    raw_prices = fsy.parse_sina_history(history_response.text)
    factors = fsy.parse_sina_factors(factor_response.text)
    adjusted: list[tuple[str, float]] = []
    for price_date, raw_close in raw_prices:
        qfq_factor, _ = fsy.factor_for_date(factors, price_date)
        adjusted.append((price_date, raw_close / qfq_factor))
    return series_to_daily(adjusted, base_date, trading_days)


def _trading_days_between(
    calendar_rows: list[list[str]], start: str, end: str
) -> list[str]:
    days = []
    for row in calendar_rows:
        if len(row) < 2 or str(row[1]) not in {"1", "1.0"}:
            continue
        day = fsy.normalize_date(row[0])
        if start <= day <= end:
            days.append(day)
    return sorted(days)


def build_backfill(options: argparse.Namespace) -> dict[str, Any]:
    started = time.perf_counter()
    now = options.now
    masters = [
        *fsy.fetch_sse_master(fsy.default_session("https://www.sse.com.cn/"), options.timeout),
        *fsy.fetch_szse_master(
            fsy.default_session("https://www.szse.cn/market/product/stock/list/index.html"),
            options.timeout,
        ),
        *fsy.fetch_bse_master(fsy.default_session("https://www.bse.cn/"), options.timeout),
    ]
    master_counts = fsy.validate_master(masters)
    if options.limit_per_exchange:
        limited = []
        for exchange in ("SH", "SZ", "BSE"):
            limited.extend(
                [record for record in masters if record.exchange == exchange][
                    : options.limit_per_exchange
                ]
            )
        masters = limited

    try:
        import baostock as bs
    except ImportError as error:
        raise fsy.FreeStockSourceError(
            "BAOSTOCK_NOT_INSTALLED", "baostock is required", source="baostock"
        ) from error

    fsy.login_baostock(bs)
    per_symbol: dict[str, dict[str, dict[str, Any]]] = {}
    exchanges: dict[str, str] = {}
    failures: list[dict[str, str]] = []
    ineligible: dict[str, str] = {}
    try:
        calendar_start = f"{now.year - 1}-12-01"
        calendar_query = bs.query_trade_dates(
            start_date=calendar_start, end_date=f"{now.year + 1}-12-31"
        )
        calendar_rows = fsy.collect_baostock_rows(calendar_query)
        base_date, derived_as_of, _ = fsy.derive_dates(calendar_rows, now, None)
        end_date = options.end or derived_as_of
        if end_date > derived_as_of:
            end_date = derived_as_of
        trading_days = _trading_days_between(calendar_rows, base_date, end_date)
        if not trading_days or trading_days[0] != base_date:
            trading_days = [base_date, *[d for d in trading_days if d > base_date]]

        sh_sz = [record for record in masters if record.exchange in {"SH", "SZ"}]
        for index, master in enumerate(sh_sz, start=1):
            if index > 1 and (index - 1) % fsy.BAOSTOCK_RECONNECT_EVERY == 0:
                fsy.reconnect_baostock(bs)
            try:
                result = baostock_daily_ytd(bs, master, base_date, trading_days)
            except Exception:
                fsy.reconnect_baostock(bs)
                try:
                    result = baostock_daily_ytd(bs, master, base_date, trading_days)
                except Exception as recovery_error:
                    failures.append({
                        "symbol": master.symbol,
                        "source": "baostock",
                        "code": getattr(recovery_error, "code", "BAOSTOCK_HISTORY_FAILED"),
                    })
                    continue
            if isinstance(result, str):
                ineligible[master.symbol] = result
            else:
                per_symbol[master.symbol] = result
                exchanges[master.symbol] = master.exchange
            if options.progress_every and index % options.progress_every == 0:
                print(
                    json.dumps({"stage": "baostock", "completed": index, "total": len(sh_sz)}),
                    file=sys.stderr,
                    flush=True,
                )

        bse = [record for record in masters if record.exchange == "BSE"]
        with concurrent.futures.ThreadPoolExecutor(max_workers=options.bse_workers) as executor:
            future_map = {
                executor.submit(
                    sina_daily_ytd, master, base_date, trading_days, timeout=options.timeout
                ): master
                for master in bse
            }
            for future in concurrent.futures.as_completed(future_map):
                master = future_map[future]
                try:
                    result = future.result()
                except Exception as error:
                    failures.append({
                        "symbol": master.symbol,
                        "source": "sina",
                        "code": getattr(error, "code", "SINA_HISTORY_FAILED"),
                    })
                    continue
                if isinstance(result, str):
                    ineligible[master.symbol] = result
                else:
                    per_symbol[master.symbol] = result
                    exchanges[master.symbol] = "BSE"
    finally:
        bs.logout()

    expected_count = sum(1 for master in masters if master.listing_date <= base_date)
    days: dict[str, dict[str, dict[str, Any]]] = {}
    day_coverage: dict[str, float] = {}
    dropped_days: list[str] = []
    for day in trading_days:
        records: dict[str, dict[str, Any]] = {}
        for symbol, daily in per_symbol.items():
            entry = daily.get(day)
            if not entry:
                continue
            record = {"exchange": exchanges[symbol], "ytd": entry["ytd"]}
            if "lastPriceDate" in entry:
                record["lastPriceDate"] = entry["lastPriceDate"]
            records[symbol] = record
        coverage = len(records) / expected_count if expected_count else 0.0
        day_coverage[day] = round(coverage, 6)
        if not options.limit_per_exchange and coverage < MIN_DAY_COVERAGE_RATIO:
            dropped_days.append(day)
            continue
        days[day] = records

    generated_at = datetime.now(tz=fsy.SHANGHAI).astimezone(ZoneInfo("UTC")) \
        .isoformat().replace("+00:00", "Z")
    return {
        "version": BACKFILL_VERSION,
        "diagnosticOnly": bool(options.limit_per_exchange),
        "generatedAt": generated_at,
        "methodologyVersion": DAILY_METHODOLOGY_VERSION,
        "baseDate": base_date,
        "startDate": trading_days[0],
        "endDate": trading_days[-1],
        "expectedUniverseCount": expected_count,
        "masterCounts": master_counts,
        "days": days,
        "quality": {
            "dayCoverage": day_coverage,
            "droppedDays": dropped_days,
            "ineligibleCounts": _count_reasons(ineligible),
            "failureCount": len(failures),
            "failures": failures[:100],
            "elapsedSeconds": round(time.perf_counter() - started, 3),
        },
    }


def _count_reasons(ineligible: dict[str, str]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for reason in ineligible.values():
        counts[reason] = counts.get(reason, 0) + 1
    return counts


def parse_arguments(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    parser.add_argument("--end", default=None, help="回填终点交易日 YYYY-MM-DD，默认最近完整交易日")
    parser.add_argument("--timeout", type=float, default=20.0)
    parser.add_argument("--bse-workers", type=int, default=4)
    parser.add_argument("--limit-per-exchange", type=int, default=0)
    parser.add_argument("--progress-every", type=int, default=500)
    parser.add_argument("--now", type=fsy.parse_now, default=fsy.parse_now(None))
    args = parser.parse_args(argv)
    if args.end is not None:
        args.end = fsy.normalize_date(args.end)
    return args


def main(argv: list[str] | None = None) -> int:
    options = parse_arguments(argv)
    dataset = build_backfill(options)
    fsy._atomic_write_json(Path(options.output), dataset)
    print(json.dumps({
        "ok": True,
        "version": dataset["version"],
        "diagnosticOnly": dataset["diagnosticOnly"],
        "baseDate": dataset["baseDate"],
        "startDate": dataset["startDate"],
        "endDate": dataset["endDate"],
        "dayCount": len(dataset["days"]),
        "droppedDays": dataset["quality"]["droppedDays"],
        "failureCount": dataset["quality"]["failureCount"],
        "elapsedSeconds": dataset["quality"]["elapsedSeconds"],
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
