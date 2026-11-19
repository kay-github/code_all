# -*- coding: utf-8 -*-
"""Tencent qfq daily bars for a sector pool. No local absolute paths."""
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta
from pathlib import Path

import pandas as pd
import requests

from config import BARS, BENCH_SYMBOL, HEADERS, PROXIES, TENCENT_KLINE

SINA_KLINE = "https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData"


def tx_sym(code: str) -> str:
    code = str(code).zfill(6)
    if code.startswith(("60", "68", "5")):
        return "sh" + code
    if code.startswith(("00", "30", "1", "2")):
        return "sz" + code
    if code.startswith(("8", "9", "4")):
        return "bj" + code
    return "sz" + code


def code_of(sym: str) -> str:
    return sym[2:]


def _segments(end: str, backfill: bool):
    # Always start at 2020-12-01 so the index base never shifts between runs.
    return [("2020-12-01", "2022-12-31"), ("2023-01-01", "2024-12-31"), ("2025-01-01", end)]


def _save(sym: str, df: pd.DataFrame):
    out = BARS / (sym + ".parquet")
    out.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(out, index=False)
    return sym, len(df), ""


def fetch_sina(sym: str, end: str):
    url = f"{SINA_KLINE}?symbol={sym}&scale=240&ma=no&datalen=1500"
    r = requests.get(url, headers=HEADERS, proxies=PROXIES, timeout=20)
    js = r.json()
    if not isinstance(js, list) or not js:
        return None
    rows = []
    for x in js:
        rows.append([x["day"], x["open"], x["close"], x["high"], x["low"], x["volume"]])
    df = pd.DataFrame(rows, columns=["date", "open", "close", "high", "low", "volume"])
    for col in ["open", "close", "high", "low", "volume"]:
        df[col] = pd.to_numeric(df[col], errors="coerce")
    df["date"] = pd.to_datetime(df["date"])
    df = df[df["date"] <= pd.Timestamp(end)]
    df = df.dropna(subset=["close"]).drop_duplicates("date").sort_values("date")
    # Sina volume is shares for stocks; for the index it is not used.
    df["amount"] = df["close"] * df["volume"]
    return df


def fetch_one(sym: str, end: str, backfill: bool = False):
    rows = []
    tencent_failed = False
    for start, stop in _segments(end, backfill):
        url = f"{TENCENT_KLINE}?param={sym},day,{start},{stop},800,qfq"
        last_err = None
        for attempt in range(3):
            try:
                r = requests.get(url, headers=HEADERS, proxies=PROXIES, timeout=15)
                js = r.json()
                node = (js.get("data") or {}).get(sym) or {}
                k = node.get("qfqday") or node.get("day") or []
                if k:
                    rows.extend(k)
                last_err = None
                break
            except Exception as exc:
                last_err = exc
                time.sleep(0.5 + attempt * 0.5)
        if last_err:
            tencent_failed = True
            break
    if tencent_failed:
        rows = []
    if not rows:
        # Fallback: Sina unadjusted daily bars. Used only when Tencent is blocked.
        try:
            df = fetch_sina(sym, end)
            if df is not None and len(df) >= 60:
                return _save(sym, df)
        except Exception as exc:
            return sym, 0, f"tencent blocked; sina failed: {exc}"
        return sym, 0, "no data (tencent blocked, sina empty)"

    df = pd.DataFrame([r[:6] for r in rows], columns=["date", "open", "close", "high", "low", "volume"])
    for col in ["open", "close", "high", "low", "volume"]:
        df[col] = pd.to_numeric(df[col], errors="coerce")
    df["date"] = pd.to_datetime(df["date"])
    df = df.dropna(subset=["close"]).drop_duplicates("date").sort_values("date")
    # Tencent volume is in shares for STAR/BJ, lots (100 shares) elsewhere.
    mult = 1.0 if (sym.startswith("sh68") or sym.startswith("bj")) else 100.0
    df["amount"] = df["close"] * df["volume"] * mult
    return _save(sym, df)


def fetch_many(symbols, end: str, backfill: bool = False):
    symbols = list(dict.fromkeys(symbols))
    ok = bad = 0
    errors = []
    with ThreadPoolExecutor(max_workers=4) as ex:
        futs = {ex.submit(fetch_one, s, end, backfill): s for s in symbols}
        for fut in as_completed(futs):
            sym, n, err = fut.result()
            if n:
                ok += 1
            else:
                bad += 1
                errors.append(f"{sym}: {err}")
    return {"ok": ok, "bad": bad, "errors": errors[:8]}


def load_bars(sym: str):
    p = BARS / (sym + ".parquet")
    if not p.exists():
        return None
    df = pd.read_parquet(p)
    df["date"] = pd.to_datetime(df["date"])
    return df.set_index("date").sort_index()


def pool_symbols(pool):
    codes = [x["code"] for x in pool.get("core", [])] + [x["code"] for x in pool.get("ext", [])]
    codes += [str(x) for x in pool.get("leaders", [])]
    return [tx_sym(c) for c in codes]


def ensure_bars(pool, end: str, backfill: bool = False, no_fetch: bool = False):
    symbols = pool_symbols(pool) + [BENCH_SYMBOL]
    if no_fetch:
        return {"ok": 0, "bad": 0, "errors": ["skip fetch"], "symbols": len(symbols)}
    # local cache: if every file exists and covers end, skip network
    if not backfill:
        stale = []
        for sym in symbols:
            p = BARS / (sym + ".parquet")
            if not p.exists():
                stale.append(sym)
                continue
            last = pd.read_parquet(p, columns=["date"])["date"].max()
            if pd.Timestamp(last) < pd.Timestamp(end):
                stale.append(sym)
        if not stale:
            return {"ok": 0, "bad": 0, "errors": [], "symbols": len(symbols), "cached": True}
        symbols = stale
    stats = fetch_many(symbols, end, backfill)
    stats["symbols"] = len(symbols)
    return stats


def today_str():
    return date.today().strftime("%Y-%m-%d")
