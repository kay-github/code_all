# -*- coding: utf-8 -*-
"""Escape-top (post-crash rebound top) state machine.

Research-only conclusions that drive this module:
- A deep crash (peak-to-trough >= 38%) followed by a mature rebound is the
  scene. 38% cuts the shallow 35-38% noise while keeping the 2021-2022 ChiNext
  anchor (-39.7%) and the 2022 optical anchor (-38.1%) in the sample.
- Early "top prediction" is noisy. The useful action signal is a state change
  after the rebound has already lost short-term momentum: watch -> warn ->
  confirm. The module therefore exposes state, not a single boolean.
- A new high after a warning cancels it. A failed breakout is not allowed to
  keep the old warning alive.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

DEFAULT_D = 0.38
DEFAULT_G = 0.20
DEFAULT_TOL = 0.03
LOOKBACK = 500
MIN_BARS = 140

STATE_NAME = {
    "idle": "无深跌场景",
    "waiting": "深跌后等待反弹",
    "watch": "反弹观察",
    "warn": "逃命预警",
    "confirm": "逃命确认",
    "trend": "趋势反转",
    "sideways": "转入震荡",
    "failed": "反弹失败",
}
STATE_ACTION = {
    "idle": "正常跟踪，不操作",
    "waiting": "等待反弹成形，不操作",
    "watch": "只观察，不新增；记录反弹高点与阻力位",
    "warn": "减 1/3；剩余止损上移至反弹高点下方",
    "confirm": "再减 1/3；不接飞刀，等重新站上 MA20",
    "trend": "移交常规趋势雷达，不再按逃命顶跟踪",
    "sideways": "结束逃命顶跟踪，转入震荡观察",
    "failed": "反弹失败；结束本次跟踪，等待下一次深跌",
}
STATE_COLOR = {
    "idle": "#6D675B",
    "waiting": "#8A7A55",
    "watch": "#C77A2E",
    "warn": "#B3392C",
    "confirm": "#7A1F1A",
    "trend": "#3E6B52",
    "sideways": "#6D675B",
    "failed": "#6D675B",
}


def _f(x):
    try:
        v = float(x)
        return v if math.isfinite(v) else None
    except Exception:
        return None


def _resistance(idx: float, levels: dict) -> tuple[float, str, float]:
    best = None
    for name, level in levels.items():
        v = _f(level)
        if v is None or v <= 0:
            continue
        dist = abs(idx / v - 1)
        if best is None or dist < best[2]:
            best = (v, name, dist)
    if best is None:
        return None, "—", None
    return best


def _sideways(close: pd.Series, days: int = 30) -> bool:
    if len(close) < days:
        return False
    w = close.tail(days)
    mid = float(w.mean())
    return bool(mid > 0 and (w.max() - w.min()) / mid <= 0.12)


def _idle(as_of, trigger, **extra):
    latest = {
        "state": "idle", "state_name": STATE_NAME["idle"], "action": STATE_ACTION["idle"],
        "color": STATE_COLOR["idle"], "trigger": trigger, "as_of": as_of,
    }
    latest.update(extra)
    return {"latest": latest, "events": [], "history": []}


def analyze(f: pd.DataFrame, D: float = DEFAULT_D, G: float = DEFAULT_G,
            tol: float = DEFAULT_TOL, lookback: int = LOOKBACK,
            peak_date=None, low_date=None) -> dict:
    """Run the escape-top state machine on one index series.

    `f` must be indexed by date and contain `idx`. Optional columns: ma10,
    ma20, ma60, ma120, rsi14, dist20, vol20. Missing optional columns are
    computed from `idx` where possible.
    """
    if f is None or len(f) < MIN_BARS or "idx" not in f.columns:
        return _idle(None, "历史长度不足，无法判断")

    f = f.copy()
    idx = pd.to_numeric(f["idx"], errors="coerce")
    f = f.loc[idx.notna()].copy()
    f["idx"] = idx.loc[idx.notna()]
    if len(f) < MIN_BARS:
        return _idle(f.index[-1].strftime("%Y-%m-%d"), "有效历史长度不足")

    # Optional moving averages / RSI / extension.
    c = f["idx"].astype(float)
    for n in (10, 20, 60, 120):
        col = f"ma{n}"
        if col not in f.columns or f[col].isna().all():
            f[col] = c.rolling(n, min_periods=max(3, n // 2)).mean()
    if "rsi14" not in f.columns or f["rsi14"].isna().all():
        d = c.diff()
        up = d.clip(lower=0).ewm(alpha=1 / 14, adjust=False).mean()
        dn = (-d.clip(upper=0)).ewm(alpha=1 / 14, adjust=False).mean()
        f["rsi14"] = 100 - 100 / (1 + up / (dn + 1e-12))
    if "dist20" not in f.columns or f["dist20"].isna().all():
        f["dist20"] = c / f["ma20"] - 1

    if peak_date is not None and low_date is not None:
        peak_date = pd.Timestamp(peak_date)
        low_date = pd.Timestamp(low_date)
        if peak_date not in f.index or low_date not in f.index:
            return _idle(f.index[-1].strftime("%Y-%m-%d"), "指定的顶部/低点不在数据内")
        peak_i = f.index.get_loc(peak_date)
        low_i = f.index.get_loc(low_date)
    else:
        window = f.tail(lookback)
        peak_date = window["idx"].idxmax()
        after = f.loc[peak_date:]
        low_date = after["idx"].idxmin()
        peak_i = f.index.get_loc(peak_date)
        low_i = f.index.get_loc(low_date)
    if low_i <= peak_i:
        return _idle(f.index[-1].strftime("%Y-%m-%d"), "未找到有效低点")

    crash_high = float(f.loc[peak_date, "idx"])
    crash_low = float(f.loc[low_date, "idx"])
    crash_dd = crash_low / crash_high - 1
    now_i = len(f) - 1
    since_low = now_i - low_i
    cur = float(f["idx"].iloc[-1])
    as_of = f.index[-1].strftime("%Y-%m-%d")

    if crash_dd > -D:
        return _idle(
            as_of,
            f"近 {lookback} 日最大回撤 {crash_dd*100:.1f}%，未达 {D*100:.0f}% 深跌门槛",
            crash_high=round(crash_high, 4), crash_low=round(crash_low, 4),
            crash_dd=round(crash_dd, 4), peak_date=peak_date.strftime("%Y-%m-%d"),
            low_date=low_date.strftime("%Y-%m-%d"), days_since_low=since_low,
            index=round(cur, 4), rebound_gain=round(cur / crash_low - 1, 4),
            retracement=round((cur - crash_low) / (crash_high - crash_low), 4),
        )

    # Rebound frame from the low.
    ep = f.loc[low_date:].copy()
    ep["rebound_high"] = ep["idx"].cummax()
    ep["rebound_gain"] = ep["idx"] / crash_low - 1
    ep["retracement"] = (ep["idx"] - crash_low) / (crash_high - crash_low)
    ep["days_since_low"] = np.arange(len(ep))
    ep["m1"] = ep["days_since_low"] >= 15
    ep["m2"] = (ep["rebound_gain"] >= 0.20) | (ep["retracement"] >= 0.50)
    ep["m3"] = ep["dist20"] >= 0.08
    ep["m4"] = ep["rsi14"] >= 65
    ep["maturity_count"] = ep[["m1", "m2", "m3", "m4"]].sum(axis=1)
    ep["maturity"] = ep["maturity_count"] >= 2

    fib382 = crash_low + 0.382 * (crash_high - crash_low)
    fib500 = crash_low + 0.500 * (crash_high - crash_low)
    fib618 = crash_low + 0.618 * (crash_high - crash_low)
    levels = {
        "38.2%回撤": fib382,
        "50%回撤": fib500,
        "61.8%回撤": fib618,
        "MA60": ep["ma60"].iloc[-1],
        "MA120": ep["ma120"].iloc[-1],
    }
    near = []
    nearest_name = []
    nearest_dist = []
    for v in ep["idx"]:
        best = None
        for name, level in levels.items():
            lv = _f(level)
            if lv is None or lv <= 0:
                continue
            dist = abs(v / lv - 1)
            if best is None or dist < best[2]:
                best = (lv, name, dist)
        if best is None:
            near.append(False); nearest_name.append("—"); nearest_dist.append(None)
        else:
            near.append(best[2] <= tol); nearest_name.append(best[1]); nearest_dist.append(best[2])
    ep["near_res"] = near
    ep["nearest_res"] = nearest_name
    ep["res_distance"] = nearest_dist
    ep["watch"] = (ep["maturity"] & ep["near_res"] & (ep["rebound_gain"] >= G)
                   & (ep["idx"] < crash_high) & (ep["days_since_low"] >= 10)).fillna(False)
    ep["warn"] = ((ep["idx"] < ep["ma10"]) | (ep["idx"] <= ep["rebound_high"] * 0.97)).fillna(False)
    ep["confirm"] = ((ep["idx"] < ep["ma20"]) | (ep["idx"] <= ep["rebound_high"] * 0.95)).fillna(False)

    # State machine replay. The current state is the last state, never a
    # hindsight label. Events are emitted only when the state changes.
    state = "waiting"
    events: list[dict] = []
    warn_high = None
    warn_date = None
    confirm_date = None
    watch_date = None
    last_event = None

    def emit(d, to, trigger, idx_value):
        nonlocal last_event
        e = {
            "d": d.strftime("%Y-%m-%d"),
            "to": to,
            "to_name": STATE_NAME.get(to, to),
            "idx": round(float(idx_value), 4),
            "trigger": trigger,
        }
        events.append(e)
        last_event = e

    for i in range(len(ep)):
        d = ep.index[i]
        v = float(ep["idx"].iloc[i])
        gain = float(ep["rebound_gain"].iloc[i])
        retr = float(ep["retracement"].iloc[i])
        high = float(ep["rebound_high"].iloc[i])

        # A new low invalidates the rebound. In live data the low date would
        # move; this branch is mainly for replay.
        if v <= crash_low * 0.999 and state in ("watch", "warn", "confirm"):
            state = "failed"
            emit(d, "failed", "反弹失败，跌破前低", v)
            warn_high = None
            continue

        if v > crash_high or gain >= 0.80 or retr >= 0.80:
            if state != "trend":
                state = "trend"
                emit(d, "trend", "收复前高或修复超 80%，移交趋势雷达", v)
            warn_high = None
            continue

        if state == "waiting":
            if bool(ep["watch"].iloc[i]):
                state = "watch"
                watch_date = d
                emit(d, "watch", f"反弹 {gain*100:.1f}%，接近{ep['nearest_res'].iloc[i]}", v)
            continue

        if state == "watch":
            if warn_high is not None and v > warn_high * 1.03:
                # Defensive: should not happen in watch, but keeps the state clean.
                warn_high = None
            if bool(ep["warn"].iloc[i]):
                state = "warn"
                warn_high = high
                warn_date = d
                why = []
                if v < float(ep["ma10"].iloc[i]):
                    why.append("跌破 MA10")
                if v <= high * 0.97:
                    why.append("自反弹高点回落 3%")
                emit(d, "warn", "；".join(why) or "短线动能转弱", v)
                if bool(ep["confirm"].iloc[i]):
                    state = "confirm"
                    confirm_date = d
                    emit(d, "confirm", "跌破 MA20 或自反弹高点回落 5%，逃命确认", v)
            continue

        if state == "warn":
            if warn_high is not None and v > warn_high * 1.03:
                state = "watch"
                emit(d, "watch", "反弹创新高，预警撤销，恢复观察", v)
                warn_high = None
                warn_date = None
                continue
            if bool(ep["confirm"].iloc[i]):
                state = "confirm"
                confirm_date = d
                why = []
                if v < float(ep["ma20"].iloc[i]):
                    why.append("跌破 MA20")
                if v <= high * 0.95:
                    why.append("自反弹高点回落 5%")
                emit(d, "confirm", "；".join(why) or "逃命确认", v)
            continue

        if state == "confirm":
            if warn_high is not None and v > warn_high * 1.03:
                state = "watch"
                emit(d, "watch", "反弹创新高，确认撤销，恢复观察", v)
                warn_high = None
                warn_date = None
                confirm_date = None
                continue
            # Do not end on a low-volatility range before a top is actually
            # confirmed. That would have killed the 2022 optical and 2015
            # CSI300 anchors. Sideways is a display note, not a state exit.
            continue

    # If the episode is still waiting and the current price is already at a
    # mature rebound but never touched a resistance, keep waiting; the page
    # explains that the resistance gate is not met.
    cur_gain = cur / crash_low - 1
    cur_retr = (cur - crash_low) / (crash_high - crash_low)
    cur_high = float(ep["rebound_high"].iloc[-1])
    cur_dd = cur / cur_high - 1
    nearest = _resistance(cur, levels)
    mat_count = int(ep["maturity_count"].iloc[-1])
    watch_now = bool(ep["watch"].iloc[-1])

    if state == "waiting":
        if cur < crash_low * 1.08:
            trigger = f"深跌 {crash_dd*100:.1f}% 已满足；当前仅自低点反弹 {cur_gain*100:.1f}%，等待反弹成形"
        elif not watch_now:
            trigger = f"反弹 {cur_gain*100:.1f}%，但未同时满足成熟度与阻力位条件（成熟 {mat_count}/4）"
        else:
            trigger = "已进入反弹观察"
    elif state == "watch":
        trigger = f"反弹 {cur_gain*100:.1f}% / 修复 {cur_retr*100:.1f}%；接近{nearest[1]}，等待短线转弱"
    elif state == "warn":
        trigger = f"自反弹高点回落 {abs(cur_dd)*100:.1f}%；等待跌破 MA20 或回落 5% 确认"
    elif state == "confirm":
        trigger = f"已跌破 MA20 / 自高点回落 {abs(cur_dd)*100:.1f}%；逃命确认"
    elif state == "trend":
        trigger = "已收复前高或修复超 80%，不再按逃命顶跟踪"
    elif state == "sideways":
        trigger = "已转入 30 日低振幅震荡，结束跟踪"
    elif state == "failed":
        trigger = "已跌破本轮反弹前低，反弹失败"
    else:
        trigger = "—"

    latest = {
        "state": state,
        "state_name": STATE_NAME.get(state, state),
        "action": STATE_ACTION.get(state, "—"),
        "color": STATE_COLOR.get(state, "#6D675B"),
        "trigger": trigger,
        "as_of": as_of,
        "index": round(cur, 4),
        "crash_high": round(crash_high, 4),
        "crash_low": round(crash_low, 4),
        "crash_dd": round(crash_dd, 4),
        "peak_date": peak_date.strftime("%Y-%m-%d"),
        "low_date": low_date.strftime("%Y-%m-%d"),
        "days_since_low": since_low,
        "rebound_high": round(cur_high, 4),
        "rebound_gain": round(cur_gain, 4),
        "retracement": round(cur_retr, 4),
        "high_drawdown": round(cur_dd, 4),
        "fib_382": round(fib382, 4),
        "fib_500": round(fib500, 4),
        "fib_618": round(fib618, 4),
        "ma20": _f(ep["ma20"].iloc[-1]),
        "ma60": _f(ep["ma60"].iloc[-1]),
        "ma120": _f(ep["ma120"].iloc[-1]),
        "nearest_res": nearest[1],
        "res_distance": round(nearest[2], 4) if nearest[2] is not None else None,
        "maturity_count": mat_count,
        "watch_date": watch_date.strftime("%Y-%m-%d") if watch_date is not None else None,
        "warn_date": warn_date.strftime("%Y-%m-%d") if warn_date is not None else None,
        "confirm_date": confirm_date.strftime("%Y-%m-%d") if confirm_date is not None else None,
    }

    hist = []
    for d, row in ep.tail(260).iterrows():
        hist.append({
            "d": d.strftime("%Y-%m-%d"),
            "idx": round(float(row["idx"]), 4),
            "rebound_high": round(float(row["rebound_high"]), 4),
            "rebound_gain": round(float(row["rebound_gain"]), 4),
            "retracement": round(float(row["retracement"]), 4),
            "state": "waiting" if not bool(row["watch"]) else ("watch" if row["idx"] < row["rebound_high"] else "watch"),
        })
    # Mark actual state history from events; the daily `state` above is a
    # coarse display, the authoritative current state is `latest`.
    for e in events:
        for h in hist:
            if h["d"] >= e["d"]:
                h["state"] = e["to"]

    return {"latest": latest, "events": events[-40:], "history": hist}


def analyze_reference(f: pd.DataFrame, **kwargs) -> dict:
    """ChiNext / benchmark reference, no action, only context."""
    r = analyze(f, **kwargs)
    if "latest" in r:
        r["latest"]["action"] = "仅作创业板参照，不单独触发行业动作"
    r["reference"] = True
    return r
