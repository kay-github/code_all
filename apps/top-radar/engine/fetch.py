# -*- coding: utf-8 -*-
"""Tencent qfq daily bars for a sector pool. No local absolute paths."""
import time
import json
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta
from pathlib import Path

import pandas as pd
import requests

from config import BARS, BENCH_SYMBOL, HEADERS, PROXIES, TENCENT_KLINE

SINA_KLINE = "https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData"
EASTMONEY_KLINE = "https://push2his.eastmoney.com/api/qt/stock/kline/get"


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


def fetch_sina_factors(sym: str):
    """Sina qfq step factors: qfq_price = raw_price / factor."""
    url = f"https://finance.sina.com.cn/realstock/company/{sym}/qfq.js"
    r = requests.get(
        url,
        headers={**HEADERS, "Referer": "https://finance.sina.com.cn/"},
        proxies=PROXIES,
        timeout=15,
    )
    text = r.text or ""
    brace = text.find("{")
    if brace < 0:
        return []
    try:
        data, _ = json.JSONDecoder().raw_decode(text[brace:])
    except Exception:
        return []
    out = []
    for item in data.get("data", []):
        try:
            out.append((pd.Timestamp(item["d"]), float(item["f"])))
        except Exception:
            continue
    return sorted(out)


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
    # Sina raw prices are unadjusted. Apply its qfq factor step when available;
    # indices have no factors and need no adjustment.
    factors = fetch_sina_factors(sym)
    if factors:
        fac = pd.DataFrame(factors, columns=["date", "factor"]).sort_values("date")
        df = pd.merge_asof(df.sort_values("date"), fac, on="date", direction="backward")
        df["factor"] = df["factor"].ffill().fillna(1.0)
        for col in ["open", "close", "high", "low"]:
            df[col] = df[col] / df["factor"]
        df = df.drop(columns=["factor"])
    # Sina volume is shares for stocks; for the index it is not used.
    df["amount"] = df["close"] * df["volume"]
    df.attrs["source"] = "sina_adjusted" if factors else "sina_raw"
    return df


def fetch_eastmoney(sym: str, end: str):
    """Adjusted (qfq) fallback when Tencent is blocked. Eastmoney's f57 is amount in CNY."""
    code = code_of(sym)
    secid = ("1." if sym.startswith("sh") else "0.") + code
    params = {
        "secid": secid,
        "fields1": "f1,f2,f3,f4,f5,f6",
        "fields2": "f51,f52,f53,f54,f55,f56,f57,f58",
        "klt": "101",
        "fqt": "1",
        "beg": "20201201",
        "end": "20500101",
        "ut": "fa5fd1943c7b386f172d6893dbfba10b",
    }
    r = requests.get(
        EASTMONEY_KLINE,
        params=params,
        headers={**HEADERS, "Referer": "https://quote.eastmoney.com/"},
        proxies=PROXIES,
        timeout=20,
    )
    js = r.json()
    klines = ((js.get("data") or {}).get("klines")) or []
    rows = []
    for line in klines:
        f = line.split(",")
        if len(f) < 7:
            continue
        rows.append([f[0], f[1], f[2], f[3], f[4], f[5], f[6]])
    if not rows:
        return None
    df = pd.DataFrame(rows, columns=["date", "open", "close", "high", "low", "volume", "amount"])
    for col in ["open", "close", "high", "low", "volume", "amount"]:
        df[col] = pd.to_numeric(df[col], errors="coerce")
    df["date"] = pd.to_datetime(df["date"])
    df = df[df["date"] <= pd.Timestamp(end)]
    df = df.dropna(subset=["close"]).drop_duplicates("date").sort_values("date")
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
        # Fallback 1: Eastmoney adjusted bars (qfq). Preferred when Tencent is blocked.
        try:
            df = fetch_eastmoney(sym, end)
            if df is not None and len(df) >= 60:
                return _save(sym, df) + ("eastmoney",)
        except Exception as exc:
            eastmoney_err = str(exc)[:80]
        # Fallback 2: Sina daily bars, adjusted with Sina qfq factors when available.
        try:
            df = fetch_sina(sym, end)
            if df is not None and len(df) >= 60:
                return _save(sym, df) + (df.attrs.get("source", "sina"),)
        except Exception as exc:
            return sym, 0, f"tencent blocked; eastmoney={locals().get('eastmoney_err', 'empty')}; sina failed: {exc}", "none"
        return sym, 0, "no data (tencent blocked, eastmoney/sina empty)", "none"

    df = pd.DataFrame([r[:6] for r in rows], columns=["date", "open", "close", "high", "low", "volume"])
    for col in ["open", "close", "high", "low", "volume"]:
        df[col] = pd.to_numeric(df[col], errors="coerce")
    df["date"] = pd.to_datetime(df["date"])
    df = df.dropna(subset=["close"]).drop_duplicates("date").sort_values("date")
    # Tencent volume is in shares for STAR/BJ, lots (100 shares) elsewhere.
    mult = 1.0 if (sym.startswith("sh68") or sym.startswith("bj")) else 100.0
    df["amount"] = df["close"] * df["volume"] * mult
    return _save(sym, df) + ("tencent",)


def fetch_many(symbols, end: str, backfill: bool = False):
    symbols = list(dict.fromkeys(symbols))
    ok = bad = 0
    errors = []
    sources = {}
    with ThreadPoolExecutor(max_workers=4) as ex:
        futs = {ex.submit(fetch_one, s, end, backfill): s for s in symbols}
        for fut in as_completed(futs):
            sym, n, err, source = fut.result()
            sources[source] = sources.get(source, 0) + 1
            if n:
                ok += 1
            else:
                bad += 1
                errors.append(f"{sym}: {err}")
    return {"ok": ok, "bad": bad, "errors": errors[:8], "sources": sources}


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
