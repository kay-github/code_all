"""Main-wave scanner v2: industry ETF early-discovery with a breadth context.

Two independent layers:
  * watch: close above prior 10-day high OR 20/60-day MA uptrend OR a
    pullback/reclaim setup, only when the ETF is not already stretched.
  * acceleration: 5-day thrust breakout. It is a later, higher-precision
    confirmation; it is not the early-warning trigger.

The 12-day cooldown / 5-day re-arm / one-of-three watch rule is exactly the
rule selected on the 2018-2023 development sample. The 2024-2026 holdout is
never used to choose parameters here.

Leader baskets are an industry thermometer only. They are not a hard gate:
the separate holdings study shows a 3-of-5 leader gate cuts early coverage
from 70% to 10%.
"""

import json
import math
import os
import statistics
import tempfile
from concurrent.futures import ThreadPoolExecutor

from wave_universe import (ALL_ETFS, ALL_LEADERS, HISTORY_START, MARKET,
                           MARKET_NAME, NAME_BY_CODE, SOURCE_BY_CODE, START_FETCH,
                           THEME_BY_CODE, THEMES)

START = HISTORY_START
WATCH_METHODS = ("range10", "ma", "reclaim")
CONFIRM_METHODS = ("thrust",)
COOLDOWN = 12
REARM = 5
LEADER_WINDOW = 5
WARMUP = 252

LABELS = {"early": "启动观察", "confirmed": "放量确认", "accel": "加速确认",
          "running": "趋势延续", "leaders": "龙头先动", "extended": "涨幅已扩大",
          "cooldown": "条件成立·冷却中", "watch": "继续观察", "missing": "数据待齐"}


def finite(value):
    return isinstance(value, (int, float)) and math.isfinite(value)


def daily_features(rows, market, start=WARMUP):
    """Return date -> feature dict. Rows must be unique, ascending daily bars."""
    closes = [row["close"] for row in rows]
    amounts = [row["amount"] for row in rows]
    out = {}
    for i in range(start, len(rows)):
        date = rows[i]["date"]
        if date not in market:
            continue
        c = closes[i]
        r5, r10, r20, r63, r252 = (c / closes[i - n] - 1 for n in (5, 10, 20, 63, 252))
        relative5 = r5 - (market[date] / market[rows[i - 5]["date"]] - 1)
        relative20 = r20 - (market[date] / market[rows[i - 20]["date"]] - 1)
        previous_relative5 = closes[i - 5] / closes[i - 10] - market[rows[i - 5]["date"]] / market[rows[i - 10]["date"]]
        ma10 = statistics.fmean(closes[i - 9:i + 1])
        ma20 = statistics.fmean(closes[i - 19:i + 1])
        ma60 = statistics.fmean(closes[i - 59:i + 1])
        old_ma20 = statistics.fmean(closes[i - 24:i - 4])
        high5 = max(closes[i - 5:i])
        high10 = max(closes[i - 10:i])
        high15 = max(closes[i - 15:i])
        high20 = max(closes[i - 20:i])
        high55 = max(closes[i - 55:i])
        high252 = max(closes[i - 252:i])
        low20 = min(closes[i - 20:i])
        prev10 = closes[i - 10:i]
        range10 = max(prev10) / min(prev10) - 1
        avg_amount = statistics.fmean(amounts[i - 20:i])
        if avg_amount <= 0 or amounts[i] <= 0:
            continue
        amount_ratio = amounts[i] / avg_amount
        flags = dict(
            range10=c > high10,
            range20=c > high20,
            range55=c > high55,
            ma=ma20 > ma60 and c > ma20 and ma20 > old_ma20,
            ts63=r63 > 0 and r20 > 0 and c > ma20,
            ts252=r252 > 0 and c > ma20,
            relative=relative20 >= 0.03 and c > ma20 and r20 > 0,
            relative_turn=relative5 >= 0.02 and previous_relative5 <= 0 and c > ma20 and c > high5,
            year_high=c >= 0.95 * high252 and c > ma20 and r20 > 0,
            volume=c > high10 and amount_ratio >= 1.30 and c > ma20,
            coil=c > high10 and range10 <= 0.08 and range10 <= 0.8 * (high20 / low20 - 1) and amount_ratio >= 1.10,
            reclaim=c > high5 and low20 <= high20 * 0.92 and 1.05 * low20 <= c <= 1.12 * low20
                    and relative5 >= 0.01 and c > ma10,
            thrust=c > high5 and r5 >= 0.045 and relative5 >= 0.01 and ma20 >= old_ma20 and c > ma10,
            not_stretched=c <= 1.12 * ma20 and r10 <= 0.18,
            leader_breakout=c > high15 and amount_ratio >= 1.30 and relative5 >= 0.02 and c > ma20,
        )
        out[date] = dict(
            close=c, chg=c / closes[i - 1] - 1, ma10=ma10, ma20=ma20, ma60=ma60,
            r5=r5, r10=r10, r20=r20, r63=r63, r252=r252,
            relative5=relative5, relative20=relative20, previous_relative5=previous_relative5,
            amount_ratio=amount_ratio, high10=high10, high20=high20, high55=high55, high252=high252,
            low20=low20, range10_pct=range10,
            to_high20=c / high20 - 1, to_ma20=c / ma20 - 1,
            **flags,
        )
    return out


def event_indices(flags, cooldown=COOLDOWN, rearm=REARM):
    """Same episode logic as the frozen research protocol."""
    alerts = []
    previous_candidate = -rearm - 1
    previous_alert = -cooldown
    eligible_episode = True
    for i, flag in enumerate(flags):
        if not flag:
            continue
        eligible_episode = eligible_episode or i - previous_candidate > rearm
        if eligible_episode and i - previous_alert >= cooldown:
            alerts.append(i)
            previous_alert = i
            eligible_episode = False
        previous_candidate = i
    return alerts


def _candidate(feature, methods):
    return bool(feature) and any(feature[name] for name in methods) and feature["not_stretched"]


def _event_reasons(feature):
    reasons = []
    for name, label in (("range10", "10日新高"), ("ma", "20/60日均线多头"), ("reclaim", "回踩再启动")):
        if feature[name]:
            reasons.append(label)
    if feature["thrust"]:
        reasons.append("5日加速")
    if feature["amount_ratio"] >= 1.25:
        reasons.append("放量")
    if feature["relative5"] >= 0.02:
        reasons.append("相对强度")
    return reasons


def leader_counts(dates, leader_features):
    last_breakout = [None] * len(leader_features)
    out = {}
    for i, day in enumerate(dates):
        active = available = 0
        for j, feature_map in enumerate(leader_features):
            feature = feature_map.get(day)
            if feature is None:
                continue
            available += 1
            if not (feature["close"] > feature["ma20"]):
                last_breakout[j] = None
                continue
            if feature["leader_breakout"]:
                last_breakout[j] = i
            last = last_breakout[j]
            active += last is not None and i - last < LEADER_WINDOW
        out[day] = (active, available)
    return out


def _status(feature, today_event, last_event, last_index, leaders_active, leader_total):
    if feature is None:
        return "missing", "当日没有可用的 ETF 日线。"
    if today_event:
        return today_event["stage"], today_event["description"]
    if last_event and last_index - last_event["index"] <= 20 and feature["close"] > feature["ma20"]:
        return "running", "最近一次提醒仍在有效期内，ETF 保持 20 日线上方。"
    if feature["to_ma20"] > 0.12 or feature["r10"] > 0.18:
        return "extended", "ETF 已偏离 20 日线超过 12% 或 10 日涨幅超过 18%，暂停追高提醒。"
    if _candidate(feature, WATCH_METHODS):
        return "cooldown", "启动条件成立，但同一轮提醒仍在冷却期。"
    if leaders_active >= 2:
        return "leaders", f"{leaders_active}/{leader_total} 只代表成分股先放量走强，等 ETF 自身确认。"
    return "watch", "等待 ETF 突破、均线转多或回踩再启动。"


def build_snapshot(benchmark, series, themes=THEMES):
    market = {row["date"]: row["close"] for row in benchmark}
    dates = sorted(market)
    if len(dates) < WARMUP + 20:
        raise ValueError("沪深300日线不足，无法生成主升浪信号")
    start_index = next((i for i, day in enumerate(dates) if day >= START), None)
    if start_index is None:
        raise ValueError("沪深300缺少研究起点之后的日线")
    out_etfs, history = [], []
    for theme, leaders, members in themes:
        leader_features = []
        for code in leaders:
            rows = series.get(code, [])
            leader_features.append(daily_features(rows, market) if len(rows) > WARMUP + 20 else {})
        counts = leader_counts(dates, leader_features)
        for code, name, source in members:
            rows = series.get(code, [])
            if len(rows) <= WARMUP + 20:
                current = dict(code=code.split(".")[-1], name=name, theme=theme, source=source,
                               status="missing", reason="ETF 日线不足。", leaders_active=0, leaders_total=len(leaders),
                               leaders_available=0, values=None, conditions={}, last_alert=None, last_stage=None)
                out_etfs.append(current)
                continue
            features = daily_features(rows, market)
            day_list = [day for day in dates if day >= START]
            watch_flags = [_candidate(features.get(day), WATCH_METHODS) for day in day_list]
            confirm_flags = [_candidate(features.get(day), CONFIRM_METHODS) for day in day_list]
            watch_indices = event_indices(watch_flags)
            confirm_indices = event_indices(confirm_flags)
            confirm_set = set(confirm_indices)
            events = []
            for i in watch_indices:
                stage = "confirmed" if i in confirm_set else "early"
                events.append(dict(index=i, date=day_list[i], stage=stage,
                                   description="ETF 与成交额同步突破，启动观察升级为放量确认。"
                                   if stage == "confirmed" else "ETF 出现启动结构，但尚未形成放量确认。"))
            for i in confirm_indices:
                if i not in {event["index"] for event in events}:
                    events.append(dict(index=i, date=day_list[i], stage="accel",
                                       description="5 日加速突破，属于较晚的确认层，不是早期触发。"))
            events.sort(key=lambda event: event["index"])
            last_index = len(day_list) - 1
            last_day = day_list[last_index]
            today_events = [event for event in events if event["date"] == last_day]
            last_event = events[-1] if events else None
            feature = features.get(last_day)
            active, available = counts.get(last_day, (0, 0))
            status, reason = _status(feature, today_events[-1] if today_events else None,
                                    last_event, last_index, active, len(leaders))
            values = None
            conditions = {}
            if feature:
                values = {key: (round(feature[key], 6) if finite(feature[key]) else None)
                          for key in ("close", "chg", "r5", "r10", "r20", "relative5", "relative20",
                                      "amount_ratio", "to_high20", "to_ma20", "ma20", "high20")}
                conditions = {key: bool(feature[key]) for key in
                              ("range10", "range20", "ma", "reclaim", "thrust", "volume", "not_stretched")}
            out_etfs.append(dict(
                code=code.split(".")[-1], name=name, theme=theme, source=source, status=status,
                reason=reason, leaders_active=active, leaders_total=len(leaders), leaders_available=available,
                values=values, conditions=conditions, conditions_text=_event_reasons(feature) if feature else [],
                last_alert=last_event["date"] if last_event else None,
                last_stage=last_event["stage"] if last_event else None,
                last_alert_index=last_event["index"] if last_event else None,
            ))
            history.extend(dict(date=event["date"], code=code.split(".")[-1], name=name, theme=theme,
                                stage=event["stage"], leaders_active=counts.get(event["date"], (0, 0))[0],
                                description=event["description"]) for event in events)
    history.sort(key=lambda event: event["date"], reverse=True)
    current_dates = [event["date"] for event in history]
    data_date = dates[-1]
    etf_coverage = sum(1 for etf in out_etfs if etf["values"] is not None) / max(len(out_etfs), 1)
    status_counts = {}
    for etf in out_etfs:
        status_counts[etf["status"]] = status_counts.get(etf["status"], 0) + 1
    return dict(
        data_date=data_date, history_start=max(dates[start_index], START), fetch_start=dates[0],
        market=MARKET_NAME, universe=dict(themes=len(themes), etfs=len(out_etfs)),
        coverage=round(etf_coverage, 3), status_counts=status_counts,
        new_today=sum(1 for event in history if event["date"] == data_date),
        etfs=out_etfs, history=history[:80],
        latest_event_date=current_dates[0] if current_dates else None,
    )


def write_json(path, data):
    with tempfile.NamedTemporaryFile(mode="w", dir=os.path.dirname(path), encoding="utf-8", delete=False) as dest:
        try:
            json.dump(data, dest, ensure_ascii=False, indent=1, allow_nan=False)
            dest.write("\n")
            dest.close()
            os.replace(dest.name, path)
        finally:
            if os.path.exists(dest.name):
                os.unlink(dest.name)


def refresh(benchmark, data_dir, now, fetch):
    today = now.date().isoformat()
    benchmark = [bar for bar in benchmark if bar["date"] < today or
                 (bar["date"] == today and (now.hour, now.minute) >= (15, 5))]
    if not benchmark:
        raise RuntimeError("缺少沪深300已收盘日线")
    through = benchmark[-1]["date"]
    codes = sorted(set(ALL_ETFS) | set(ALL_LEADERS))

    def load(code):
        for host in ("push2his.eastmoney.com", "33.push2his.eastmoney.com"):
            try:
                rows = fetch(code, START_FETCH.replace("-", ""), adjustment=1,
                             end=through.replace("-", ""), host=host, timeout=15)
                rows = sorted((row for row in rows if START_FETCH <= row["date"] <= through), key=lambda row: row["date"])
                dates = [row["date"] for row in rows]
                if (len(rows) < WARMUP + 20 or len(dates) != len(set(dates)) or
                        any(not all(finite(row[k]) and row[k] > 0 for k in ("open", "close", "high", "low", "amount"))
                            or not row["low"] <= min(row["open"], row["close"]) <= max(row["open"], row["close"]) <= row["high"]
                            for row in rows)):
                    raise ValueError("日线数量、日期或价格/成交额异常")
                return code, rows
            except (OSError, ValueError, RuntimeError) as error:
                if host.startswith("33."):
                    raise RuntimeError(f"主升浪行情读取失败（{code}）") from error

    with ThreadPoolExecutor(max_workers=5) as pool:
        series = dict(pool.map(load, codes))
    snapshot = build_snapshot(benchmark, series)
    if snapshot["coverage"] < 0.8:
        raise RuntimeError(f"主升浪 ETF 日线覆盖不足：{snapshot['coverage']:.0%}，保留上次快照")
    write_json(os.path.join(data_dir, "main-wave.json"), snapshot)
    return snapshot


def send_alerts(snapshot, data_dir, now, send):
    day = now.date().isoformat()
    if snapshot["data_date"] != day or (now.hour, now.minute) < (15, 5):
        return
    path = os.path.join(data_dir, "main-wave-push-state.json")
    state = {}
    if os.path.exists(path):
        with open(path, encoding="utf-8") as src:
            state = json.load(src)
    sent = set(state.get("keys", [])) if state.get("date") == day else set()
    fresh = {}
    for event in snapshot["history"]:
        if event["date"] != day:
            continue
        key = f"{event['code']}:{event['stage']}"
        if key not in sent:
            fresh.setdefault(event["code"], event)
    if not fresh:
        return
    lines = [f"{day} 收盘后生成", ""]
    for event in fresh.values():
        lines.append(f"- **{event['name']}（{event['code']}）** · {LABELS.get(event['stage'], event['stage'])}，"
                     f"{event['leaders_active']} 只代表成分股共振")
    if send("主升浪发现器｜行业ETF早期提醒", "\n".join(lines)):
        write_json(path, dict(date=day, keys=sorted(sent | {f"{e['code']}:{e['stage']}" for e in fresh.values()})))
