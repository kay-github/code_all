# -*- coding: utf-8 -*-
"""Sector features: equal-weight index, breadth, sentiment, flow, leader."""
import numpy as np
import pandas as pd

from config import BENCH_SYMBOL, MARKET_AMOUNT
from fetch import load_bars, tx_sym


def _limit_threshold(sym: str) -> float:
    code = sym[2:]
    if sym.startswith("bj"):
        return 0.29
    if code.startswith(("300", "301", "688", "689")):
        return 0.195
    return 0.098


def _consec(vals):
    out, c = [], 0
    for v in vals:
        c = c + 1 if v == 1 else 0
        out.append(c)
    return pd.Series(out)


def _rsi(s, n=14):
    d = s.diff()
    up = d.clip(lower=0).ewm(alpha=1 / n, adjust=False).mean()
    dn = (-d.clip(upper=0)).ewm(alpha=1 / n, adjust=False).mean()
    return 100 - 100 / (1 + up / (dn + 1e-12))


def _days_since_high(s):
    out, last_i, last_v = [], 0, -1
    for i, v in enumerate(s.values):
        if v >= last_v:
            last_v, last_i = v, i
        out.append(i - last_i)
    return pd.Series(out, index=s.index)


def build_features(pool):
    frames = {}
    for item in pool.get("core", []) + pool.get("ext", []):
        sym = tx_sym(item["code"])
        df = load_bars(sym)
        if df is None or len(df) < 60:
            continue
        df = df.copy()
        df["sym"] = sym
        frames[sym] = df
    if not frames:
        raise RuntimeError("no bars; run fetch first")

    px = pd.concat(frames.values()).reset_index()
    px["ret1"] = px.groupby("sym")["close"].pct_change()
    px["thr"] = px["sym"].map(_limit_threshold)
    px["limit_up"] = (px["ret1"] >= px["thr"]).astype(int)
    px["big_up"] = (px["ret1"] >= 0.05).astype(int)
    px["down"] = (px["ret1"] < 0).astype(int)
    px["up"] = (px["ret1"] > 0).astype(int)
    px["ma20"] = px.groupby("sym")["close"].transform(lambda x: x.rolling(20).mean())
    px["ma60"] = px.groupby("sym")["close"].transform(lambda x: x.rolling(60).mean())
    px["hi20"] = px.groupby("sym")["high"].transform(lambda x: x.rolling(20).max())
    px["newhigh20"] = (px["close"] >= px["hi20"] - 1e-9).astype(int)
    px["above20"] = (px["close"] > px["ma20"]).astype(int)
    px["above60"] = (px["close"] > px["ma60"]).astype(int)
    px["ret20s"] = px.groupby("sym")["close"].transform(lambda x: x.pct_change(20))
    px["close_pos"] = np.where(
        px["high"] > px["low"], (px["close"] - px["low"]) / (px["high"] - px["low"]), 0.5
    )
    px["range_pct"] = (px["high"] - px["low"]) / px["close"].shift(1)
    px = px.sort_values(["sym", "date"])
    px["consec_limit"] = px.groupby("sym")["limit_up"].transform(lambda s: _consec(s.values))

    g = px.groupby("date")
    agg = pd.DataFrame({
        "n": g["sym"].count(),
        "up_ratio": g["up"].mean(),
        "limit_up_count": g["limit_up"].sum(),
        "big_up_ratio": g["big_up"].mean(),
        "median_ret": g["ret1"].median(),
        "above20_ratio": g["above20"].mean(),
        "above60_ratio": g["above60"].mean(),
        "newhigh20_ratio": g["newhigh20"].mean(),
        "close_pos_mean": g["close_pos"].mean(),
        "range_pct_mean": g["range_pct"].mean(),
        "consec_limit_max": g["consec_limit"].max(),
        "amt_sum": g["amount"].sum(),
        "disp20": g["ret20s"].std(),
    })
    agg["ret_eq"] = g["ret1"].mean()

    # Market total amount for amt_share. Missing after 2026-09-24 -> fallback in score.
    if MARKET_AMOUNT.exists():
        mkt = pd.read_csv(MARKET_AMOUNT)
        mkt["date"] = pd.to_datetime(mkt["date"])
        mkt = mkt.set_index("date")
        agg = agg.join(mkt[["mkt_amt"]], how="left")
    else:
        agg["mkt_amt"] = np.nan
    agg["amt_share"] = agg["amt_sum"] / agg["mkt_amt"]

    agg["idx"] = (1 + agg["ret_eq"].fillna(0)).cumprod()
    idx = agg["idx"]
    agg["ret1_idx"] = idx.pct_change()
    agg["ret5"] = idx.pct_change(5)
    agg["ret20"] = idx.pct_change(20)
    agg["ret60"] = idx.pct_change(60)
    agg["ret120"] = idx.pct_change(120)
    agg["ret250"] = idx.pct_change(250)
    agg["ma20"] = idx.rolling(20).mean()
    agg["ma60"] = idx.rolling(60).mean()
    agg["ma120"] = idx.rolling(120).mean()
    agg["dist20"] = idx / agg["ma20"] - 1
    agg["dist60"] = idx / agg["ma60"] - 1
    agg["dist120"] = idx / agg["ma120"] - 1
    agg["ma20_slope"] = agg["ma20"] / agg["ma20"].shift(10) - 1
    agg["ma60_slope"] = agg["ma60"] / agg["ma60"].shift(20) - 1
    agg["dd250"] = idx / idx.rolling(250, min_periods=60).max() - 1
    agg["hi250"] = idx.rolling(250, min_periods=60).max()
    agg["days_since_hi"] = _days_since_high(idx)

    agg["below20"] = (idx < agg["ma20"]).astype(int)
    agg["break20_20d"] = agg["below20"].rolling(20).sum()
    agg["break20_60d"] = agg["below20"].rolling(60).sum()
    agg["reenter20"] = ((idx > agg["ma20"]) & (idx.shift(1) <= agg["ma20"].shift(1))).astype(int)
    agg["rebreak20"] = ((idx < agg["ma20"]) & (idx.shift(1) >= agg["ma20"].shift(1))).astype(int)
    agg["rebreak20_20d"] = agg["rebreak20"].rolling(20).sum()

    agg["rsi14"] = _rsi(idx, 14)
    ema12 = idx.ewm(span=12, adjust=False).mean()
    ema26 = idx.ewm(span=26, adjust=False).mean()
    macd = ema12 - ema26
    sig = macd.ewm(span=9, adjust=False).mean()
    agg["macd"] = macd
    agg["macd_hist"] = macd - sig
    mid = idx.rolling(20).mean()
    std = idx.rolling(20).std()
    agg["pctb"] = (idx - (mid - 2 * std)) / (4 * std + 1e-12)
    agg["atr_pct"] = agg["range_pct_mean"].rolling(14).mean()
    agg["vol20"] = agg["ret1_idx"].rolling(20).std() * np.sqrt(252)

    agg["amt_ma20"] = agg["amt_sum"].rolling(20).mean()
    agg["amt_ma60"] = agg["amt_sum"].rolling(60).mean()
    agg["amt_ratio"] = agg["amt_sum"] / agg["amt_ma20"]
    agg["amt_ratio60"] = agg["amt_sum"] / agg["amt_ma60"]

    up_amt = agg["amt_sum"].where(agg["ret_eq"] > 0, 0).rolling(20).sum()
    dn_amt = agg["amt_sum"].where(agg["ret_eq"] < 0, 0).rolling(20).sum()
    agg["flow_ratio20"] = up_amt / (dn_amt + 1e-12)
    roll_hi_idx = idx.rolling(20).max()
    roll_hi_amt = agg["amt_sum"].rolling(20).max()
    agg["vol_div20"] = ((idx >= roll_hi_idx - 1e-12) & (agg["amt_sum"] <= roll_hi_amt.shift(1))).astype(int)

    # Benchmark: ChiNext. Missing -> 0 so the score still works.
    bench = load_bars(BENCH_SYMBOL)
    if bench is not None:
        bench = bench["close"].reindex(agg.index).ffill()
        agg["bench_ret20"] = bench.pct_change(20)
        agg["excess20"] = agg["ret20"] - agg["bench_ret20"]
        agg["excess60"] = agg["ret60"] - bench.pct_change(60)
    else:
        agg["excess20"] = 0.0
        agg["excess60"] = 0.0

    # Leaders: sector-defined. Missing -> 0 (E4 simply will not fire).
    leads = []
    for code in pool.get("leaders", []):
        df = load_bars(tx_sym(str(code)))
        if df is not None and len(df) >= 30:
            leads.append(df["close"])
    if leads:
        lead = pd.concat(leads, axis=1).mean(axis=1).reindex(agg.index).ffill()
        agg["leader_ret20"] = lead.pct_change(20)
        agg["leader_excess20"] = agg["leader_ret20"] - agg["ret20"]
        agg["leader_dist20"] = lead / lead.rolling(20).mean() - 1
    else:
        agg["leader_excess20"] = 0.0
        agg["leader_dist20"] = 0.0

    return agg
