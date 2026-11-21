# -*- coding: utf-8 -*-
"""Build per-sector JSON + summary for the Top Radar dashboard."""
import argparse
import json
import os
from datetime import datetime
from pathlib import Path

import pandas as pd
import requests

from config import (
    BENCH_SYMBOL, CONFIG_API, DATA, POOLS, REGISTRY, SECTORS, SITE,
    TIER_ACTION, TIER_NAME, V2_TIER_ACTION, V2_VERSION,
)
from escape import analyze, STATE_NAME
from features import build_features
from fetch import ensure_bars, load_bars, today_str
from score import score


def _json_default(o):
    if isinstance(o, (pd.Timestamp, datetime)):
        return o.strftime("%Y-%m-%d")
    if hasattr(o, "item"):
        return o.item()
    return str(o)


def _num(x, digits=4):
    try:
        v = float(x)
        if pd.isna(v):
            return None
        return round(v, digits)
    except Exception:
        return None


def _bool(x):
    try:
        return bool(x)
    except Exception:
        return False


def load_registry():
    remote = None
    try:
        r = requests.get(CONFIG_API + "?view=registry", timeout=8)
        if r.ok:
            data = r.json()
            if isinstance(data, dict) and data.get("sectors"):
                remote = data
    except Exception:
        pass
    try:
        with open(REGISTRY, encoding="utf-8") as fh:
            local = json.load(fh)
    except Exception:
        local = {"sectors": []}
    if remote:
        # Seed-only sectors (not yet written to Blob) still need to run daily.
        ids = {s.get("id") for s in remote.get("sectors", [])}
        for s in local.get("sectors", []):
            if s.get("id") not in ids:
                remote["sectors"].append(s)
        remote["sectors"] = sorted(remote["sectors"], key=lambda s: s.get("order", 99))
        return remote, "remote+local"
    return local, "local"


def load_pool(sector):
    sid = sector["id"]
    try:
        r = requests.get(CONFIG_API + f"?view=pool&id={sid}", timeout=8)
        if r.ok:
            data = r.json()
            if isinstance(data, dict) and (data.get("core") or data.get("ext")):
                return data, "remote"
    except Exception:
        pass
    rel = sector.get("pool") or f"pools/{sid}.json"
    with open(Path(rel) if Path(rel).is_absolute() else ROOT_POOL(rel), encoding="utf-8") as fh:
        return json.load(fh), "local"


def ROOT_POOL(rel):
    from config import ROOT
    return ROOT / rel


def _v2_trigger(row):
    """Human-readable reason for the shadow tier. No trading instruction."""
    if bool(row.get("v2_deep_latch")):
        return "V2 红色后回撤 ≥8% + C 确认"
    if bool(row.get("v2_red_accel")) and bool(row.get("v2_red_trend")):
        return "R≥80 质量 C 与 R≥98 衰竭红同时成立"
    if bool(row.get("v2_red_accel")):
        return "R≥98 + E≥3 衰竭红"
    if bool(row.get("v2_red_trend")):
        return "R≥80 + 质量 C + 高波"
    if bool(row.get("v2_orange")):
        return "R≥70 或 E≥3 + 高波 + 近高"
    if int(row.get("E", 0) or 0) >= 3:
        misses = []
        if not bool(row.get("near")):
            misses.append("近高")
        if not bool(row.get("v2_vol")):
            misses.append("高波")
        if not bool(row.get("v2_quality_c")) and bool(row.get("near")) and bool(row.get("v2_vol")):
            misses.append("质量C")
        return "E≥3 已出现，但" + (" / ".join(misses) if misses else "确认门") + "未过"
    if int(row.get("E", 0) or 0) >= 2:
        return "E=2，内部开始转弱"
    return "未触发"


def _v2_payload(latest):
    tier = int(latest["v2_tier"])
    return {
        "version": V2_VERSION,
        "mode": "shadow",
        "tier": tier,
        "tier_name": TIER_NAME[tier],
        "action": V2_TIER_ACTION[tier],
        "R": _num(latest["R"], 1),
        "E": int(latest["E"]),
        "C": int(latest["C"]),
        "vol20": _num(latest.get("vol20"), 4),
        "quality_c": _bool(latest.get("v2_quality_c")),
        "red_trend": _bool(latest.get("v2_red_trend")),
        "red_accel": _bool(latest.get("v2_red_accel")),
        "red": _bool(latest.get("v2_red")),
        "deep": _bool(latest.get("v2_deep_latch")),
        "orange": _bool(latest.get("v2_orange_latch")),
        "recover": _bool(latest.get("v2_recover")),
        "trigger": _v2_trigger(latest),
        "gates": {
            "hot": _bool(latest.get("hot")),
            "near": _bool(latest.get("near")),
            "vol20": _bool(latest.get("v2_vol")),
            "quality_c": _bool(latest.get("v2_quality_c")),
        },
        "components": {
            "C1": int(latest.get("C1", 0) or 0),
            "C2": int(latest.get("C2", 0) or 0),
            "C3": int(latest.get("C3", 0) or 0),
            "C4": int(latest.get("C4", 0) or 0),
        },
        "note": "只展示与留痕，不驱动 PushPlus；现行推送仍按旧规则。",
    }


def build_sector_json(sector, pool, f, asof=None, stats=None):
    if asof:
        f = f.loc[:pd.Timestamp(asof)]
        if len(f) == 0:
            raise RuntimeError(f"{sector['id']}: no data up to {asof}")
    # Coverage guard: do not publish a date where only a minority of the pool
    # has printed. The 15:10 run can otherwise show a half-empty index.
    n_target = len(pool.get("core", [])) + len(pool.get("ext", []))
    coverage = f["n"] / max(1, n_target)
    complete = f[coverage >= 0.85]
    if len(complete) == 0:
        raise RuntimeError(f"{sector['id']}: no date with >=85% coverage")
    f = f.loc[:complete.index[-1]]
    coverage_pct = float(f["n"].iloc[-1]) / max(1, n_target)
    latest = f.iloc[-1]
    idx = f.index
    stale = (pd.Timestamp.now().normalize() - idx[-1].normalize()).days > 4

    history = []
    for d, row in f.tail(260).iterrows():
        history.append({
            "d": d.strftime("%Y-%m-%d"),
            "idx": _num(row["idx"], 4),
            "tier": int(row["tier"]),
            "R": _num(row["R"], 1),
            "v2t": int(row["v2_tier"]),
            "E": int(row["E"]),
        })

    signals = []
    prev_tier = None
    for d, row in f.iterrows():
        t = int(row["tier"])
        if prev_tier is not None and t != prev_tier:
            signals.append({
                "d": d.strftime("%Y-%m-%d"),
                "tier": t,
                "tier_name": TIER_NAME[t],
                "idx": _num(row["idx"], 4),
                "R": _num(row["R"], 1),
                "action": TIER_ACTION[t],
            })
        prev_tier = t
    signals = signals[-40:]

    v2_signals = []
    prev_v2 = None
    for d, row in f.iterrows():
        t = int(row["v2_tier"])
        if prev_v2 is not None and t != prev_v2:
            v2_signals.append({
                "d": d.strftime("%Y-%m-%d"),
                "tier": t,
                "tier_name": TIER_NAME[t],
                "idx": _num(row["idx"], 4),
                "R": _num(row["R"], 1),
                "E": int(row["E"]),
                "vol20": _num(row.get("vol20"), 4),
                "action": V2_TIER_ACTION[t],
                "trigger": _v2_trigger(row),
            })
        prev_v2 = t
    v2_signals = v2_signals[-40:]

    crowd_label = "成交额占比"
    crowd_value = _num(latest.get("amt_share"), 4)
    if crowd_value is None:
        crowd_label = "成交额/60日均"
        crowd_value = _num(latest.get("amt_ratio60"), 2)

    latest_obj = {
        "date": idx[-1].strftime("%Y-%m-%d"),
        "idx": _num(latest["idx"], 4),
        "R": _num(latest["R"], 1),
        "tier": int(latest["tier"]),
        "tier_name": TIER_NAME[int(latest["tier"])],
        "action": TIER_ACTION[int(latest["tier"])],
        "E": int(latest["E"]),
        "C": int(latest["C"]),
        "ret250": _num(latest["ret250"], 4),
        "ret60": _num(latest["ret60"], 4),
        "dist60": _num(latest["dist60"], 4),
        "dd250": _num(latest["dd250"], 4),
        "rsi14": _num(latest["rsi14"], 1),
        "amt_share": _num(latest.get("amt_share"), 4),
        "amt_ratio60": _num(latest.get("amt_ratio60"), 2),
        "crowd_label": crowd_label,
        "crowd_value": crowd_value,
        "limit_up": int(latest["limit_up_count"]),
        "break20_20d": int(latest["break20_20d"]),
        "rebreak20_20d": int(latest["rebreak20_20d"]),
        "hot": _bool(latest["hot"]),
        "near": _bool(latest["near"]),
        "ma20_slope": _num(latest["ma20_slope"], 4),
        "above60_ratio": _num(latest["above60_ratio"], 4),
        "newhigh20_ratio": _num(latest["newhigh20_ratio"], 4),
        "leader_excess20": _num(latest.get("leader_excess20"), 4),
    }

    gate = {
        "ret250": _bool(latest["gate_ret250"]),
        "accel": _bool(latest["gate_accel"]),
        "hot": _bool(latest["gate_hot"]),
        "near": _bool(latest["gate_near"]),
        "all": _bool(latest["gate_all"]),
        "score": int(sum(bool(latest[k]) for k in ["gate_ret250", "gate_accel", "gate_hot", "gate_near"])),
    }

    v2_obj = _v2_payload(latest)
    escape_obj = analyze(f)

    meta = {
        "id": sector["id"],
        "name": sector["name"],
        "enabled": bool(sector.get("enabled", True)),
        "as_of": idx[-1].strftime("%Y-%m-%d"),
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "data_start": idx[0].strftime("%Y-%m-%d"),
        "data_end": idx[-1].strftime("%Y-%m-%d"),
        "n_constituents": len(pool.get("core", [])) + len(pool.get("ext", [])),
        "effective_n": int(latest["n"]),
        "coverage": round(coverage_pct, 3),
        "n_target": n_target,
        "stale": bool(stale),
        "leaders": [str(x) for x in pool.get("leaders", [])],
        "sources": (stats or {}).get("sources") or {},
        "site": SITE,
    }

    return {
        "meta": meta,
        "latest": latest_obj,
        "gate": gate,
        "v2": v2_obj,
        "escape": escape_obj,
        "history": history,
        "signals": signals,
        "v2_signals": v2_signals,
        "stats": {
            "days": int(len(f)),
            "start": idx[0].strftime("%Y-%m-%d"),
            "end": idx[-1].strftime("%Y-%m-%d"),
        },
    }


def write_v2_shadow(summary_sectors, built):
    """Persist the shadow track separately from push state.

    This file is the audit trail: it records what V2 said while the legacy
    rules remained responsible for notifications. It is safe to delete/rebuild;
    history inside each sector JSON is the primary series.
    """
    path = DATA / "v2_shadow.json"
    old = {}
    if path.exists():
        try:
            old = json.load(open(path, encoding="utf-8"))
        except Exception:
            old = {}
    old_by = {s.get("id"): s for s in old.get("sectors", [])}
    events = list(old.get("events", []))
    event_keys = {(e.get("sector"), e.get("d"), e.get("to")) for e in events}

    entries = []
    for s in summary_sectors:
        if s.get("status") != "ok":
            continue
        sid = s["id"]
        obj = built.get(sid)
        if obj is None:
            p = SECTORS / f"{sid}.json"
            if not p.exists():
                continue
            try:
                obj = json.load(open(p, encoding="utf-8"))
            except Exception:
                continue
        v2 = obj.get("v2")
        if not v2:
            continue
        entry = {
            "id": sid,
            "name": s.get("name") or sid,
            "as_of": s.get("as_of"),
            "tier": v2.get("tier"),
            "tier_name": v2.get("tier_name"),
            "action": v2.get("action"),
            "R": v2.get("R"),
            "E": v2.get("E"),
            "vol20": v2.get("vol20"),
            "trigger": v2.get("trigger"),
            "red_trend": v2.get("red_trend"),
            "red_accel": v2.get("red_accel"),
            "deep": v2.get("deep"),
            "recover": v2.get("recover"),
            "stale": s.get("stale", False),
            "coverage": s.get("coverage"),
        }
        entries.append(entry)

        prev = old_by.get(sid)
        if not prev:
            key = (sid, entry["as_of"], entry["tier"])
            if key not in event_keys:
                events.append({
                    "type": "init",
                    "sector": sid,
                    "name": entry["name"],
                    "d": entry["as_of"],
                    "from": None,
                    "from_name": None,
                    "to": entry["tier"],
                    "to_name": entry["tier_name"],
                    "R": entry["R"],
                    "E": entry["E"],
                    "vol20": entry["vol20"],
                    "trigger": entry["trigger"],
                })
                event_keys.add(key)
        elif prev.get("tier") != entry["tier"] and (
            not prev.get("as_of") or entry["as_of"] >= prev["as_of"]
        ):
            key = (sid, entry["as_of"], entry["tier"])
            if key not in event_keys:
                events.append({
                    "type": "tier_change",
                    "sector": sid,
                    "name": entry["name"],
                    "d": entry["as_of"],
                    "from": prev.get("tier"),
                    "from_name": prev.get("tier_name"),
                    "to": entry["tier"],
                    "to_name": entry["tier_name"],
                    "R": entry["R"],
                    "E": entry["E"],
                    "vol20": entry["vol20"],
                    "trigger": entry["trigger"],
                })
                event_keys.add(key)

    payload = {
        "version": V2_VERSION,
        "mode": "shadow",
        "push_policy": "legacy_only",
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "note": "V2 只计算、展示、留痕；PushPlus 仍由旧规则触发。",
        "sectors": entries,
        "events": events[-200:],
    }
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=1, default=_json_default), encoding="utf-8")
    print(f"v2 shadow: {len(entries)} sectors, {len(payload['events'])} events")


def build_primary():
    """Build the ChiNext escape-top monitor.

    ChiNext is the primary monitoring object, not merely a reference. The page
    and the PushPlus transition loop both read this object. Sector states stay
    available as same-engine context.
    """
    bench = load_bars(BENCH_SYMBOL)
    if bench is None or len(bench) < 140:
        return None
    b = bench.copy()
    b["idx"] = pd.to_numeric(b["close"], errors="coerce")
    r = analyze(b)
    latest = dict(r.get("latest") or {})
    latest["state_name"] = latest.get("state_name") or "—"
    latest["role"] = "primary"
    latest["monitor"] = True

    # The state machine's own history starts at the crash low. A standalone
    # monitor needs the full peak-to-now path, otherwise a fresh low would
    # render as a single point. Keep at most 260 bars.
    history = []
    peak_date = latest.get("peak_date")
    low_date = latest.get("low_date")
    if peak_date and low_date:
        peak_ts = pd.Timestamp(peak_date)
        low_ts = pd.Timestamp(low_date)
        chart = b.loc[peak_ts:].copy()
        if len(chart) > 260:
            chart = chart.tail(260)
        post = b.loc[low_ts:].copy()
        post["rebound_high"] = post["idx"].cummax()
        event_state = "waiting"
        state_events = r.get("events") or []
        for d, row in chart.iterrows():
            dstr = d.strftime("%Y-%m-%d")
            idx = _num(row.get("idx"), 4)
            if d < low_ts:
                history.append({
                    "d": dstr, "idx": idx, "phase": "crash",
                    "state": "waiting", "rebound_gain": None,
                    "retracement": None, "high_drawdown": None,
                })
                continue
            for e in state_events:
                if dstr >= e.get("d", ""):
                    event_state = e.get("to")
            high = _num(post.loc[d, "rebound_high"], 4)
            history.append({
                "d": dstr,
                "idx": idx,
                "phase": "rebound",
                "state": event_state,
                "rebound_gain": _num(row["idx"] / latest["crash_low"] - 1, 4),
                "retracement": _num((row["idx"] - latest["crash_low"]) / (latest["crash_high"] - latest["crash_low"]), 4),
                "high_drawdown": _num(row["idx"] / high - 1, 4) if high else None,
            })

    return {
        "id": "399006",
        "name": "创业板指",
        "role": "primary",
        "monitor": True,
        "as_of": latest.get("as_of"),
        "state": latest.get("state"),
        "state_name": latest.get("state_name"),
        "action": latest.get("action"),
        "trigger": latest.get("trigger"),
        "index": latest.get("index"),
        "crash_dd": latest.get("crash_dd"),
        "rebound_gain": latest.get("rebound_gain"),
        "retracement": latest.get("retracement"),
        "high_drawdown": latest.get("high_drawdown"),
        "color": latest.get("color"),
        "warn_date": latest.get("warn_date"),
        "confirm_date": latest.get("confirm_date"),
        "latest": latest,
        "history": history,
        "events": r.get("events") or [],
    }


def _summary_reference(reference):
    """Keep summary.json small; full chart belongs in escape_shadow.json."""
    if not reference:
        return None
    out = dict(reference)
    out.pop("history", None)
    out.pop("events", None)
    return out


def _escape_entry(sid, name, latest, *, stale=False, coverage=None, role=None):
    entry = {
        "id": sid,
        "name": name or sid,
        "as_of": latest.get("as_of"),
        "state": latest.get("state"),
        "state_name": latest.get("state_name") or STATE_NAME.get(latest.get("state"), latest.get("state")),
        "action": latest.get("action"),
        "trigger": latest.get("trigger"),
        "index": latest.get("index"),
        "crash_dd": latest.get("crash_dd"),
        "rebound_gain": latest.get("rebound_gain"),
        "retracement": latest.get("retracement"),
        "high_drawdown": latest.get("high_drawdown"),
        "color": latest.get("color"),
        "warn_date": latest.get("warn_date"),
        "confirm_date": latest.get("confirm_date"),
        "stale": stale,
        "coverage": coverage,
        "latest": latest,
    }
    if role:
        entry["role"] = role
        entry["monitor"] = role == "primary"
    return entry


def write_escape_shadow(summary_sectors, built, reference=None):
    """Persist the escape-top state and its transitions.

    This file is the audit trail and the source of PushPlus transitions. It is
    independent of the legacy tier and of the V2 shadow. `primary` is ChiNext
    and is also consumed by /taoding/escape; `sectors` are same-engine context.
    """
    path = DATA / "escape_shadow.json"
    old = {}
    if path.exists():
        try:
            old = json.load(open(path, encoding="utf-8"))
        except Exception:
            old = {}
    old_by = {s.get("id"): s for s in old.get("sectors", [])}
    old_primary = old.get("primary") or old.get("reference")
    events = list(old.get("events", []))
    event_keys = {(e.get("sector"), e.get("d"), e.get("to")) for e in events}

    def record(prev, entry):
        sid = entry["id"]
        if not prev:
            key = (sid, entry["as_of"], entry["state"])
            if key not in event_keys:
                events.append({
                    "type": "init", "sector": sid, "name": entry["name"], "d": entry["as_of"],
                    "from": None, "from_name": None, "to": entry["state"], "to_name": entry["state_name"],
                    "index": entry["index"], "trigger": entry["trigger"],
                })
                event_keys.add(key)
        elif prev.get("state") != entry["state"] and (
            not prev.get("as_of") or entry["as_of"] >= prev["as_of"]
        ):
            key = (sid, entry["as_of"], entry["state"])
            if key not in event_keys:
                events.append({
                    "type": "state_change", "sector": sid, "name": entry["name"], "d": entry["as_of"],
                    "from": prev.get("state"), "from_name": prev.get("state_name"),
                    "to": entry["state"], "to_name": entry["state_name"],
                    "index": entry["index"], "trigger": entry["trigger"],
                })
                event_keys.add(key)

    entries = []
    for s in summary_sectors:
        if s.get("status") != "ok":
            continue
        sid = s["id"]
        obj = built.get(sid)
        if obj is None:
            p = SECTORS / f"{sid}.json"
            if not p.exists():
                continue
            try:
                obj = json.load(open(p, encoding="utf-8"))
            except Exception:
                continue
        esc = obj.get("escape") or {}
        latest = esc.get("latest")
        if not latest:
            continue
        entry = _escape_entry(
            sid, s.get("name") or sid, latest,
            stale=s.get("stale", False), coverage=s.get("coverage"),
        )
        entries.append(entry)
        record(old_by.get(sid), entry)

    primary = None
    if reference and reference.get("latest"):
        primary = _escape_entry(
            "399006", reference.get("name") or "创业板指",
            reference["latest"], coverage=1.0, role="primary",
        )
        primary["history"] = reference.get("history") or []
        # Keep an explicit init event even when an older file only had
        # `reference`, so the standalone page has a visible starting point.
        has_primary_event = any(e.get("sector") == "399006" for e in events)
        if not has_primary_event:
            record(None, primary)
        else:
            record(old_primary, primary)

    payload = {
        "version": "escape-2026-11",
        "mode": "live",
        "push_policy": "state_change",
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "note": "创业板指为主监测对象；行业状态为同源背景。逃命顶不替换旧档位，也不改变 V2 影子。",
        "primary": primary,
        "reference": _summary_reference(reference),
        "sectors": entries,
        "events": events[-200:],
    }
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=1, default=_json_default), encoding="utf-8")
    print(f"escape shadow: primary={'yes' if primary else 'no'}, {len(entries)} sectors, {len(payload['events'])} events")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sector", default="enabled", help="enabled | all | <id>")
    ap.add_argument("--no-fetch", action="store_true")
    ap.add_argument("--backfill", action="store_true")
    ap.add_argument("--asof", default=None)
    args = ap.parse_args()

    registry, source = load_registry()
    all_sectors = sorted(registry.get("sectors", []), key=lambda s: s.get("order", 99))
    if args.sector == "all":
        selected = all_sectors
    elif args.sector == "enabled":
        selected = [s for s in all_sectors if s.get("enabled")]
    else:
        selected = [s for s in all_sectors if s["id"] == args.sector]
    if not selected:
        raise SystemExit(f"no sector selected: {args.sector}")

    old_summary = None
    sp = DATA / "summary.json"
    if sp.exists():
        try:
            old_summary = json.load(open(sp, encoding="utf-8"))
            (DATA / "_prev_summary.json").write_text(
                json.dumps(old_summary, ensure_ascii=False, indent=1), encoding="utf-8"
            )
        except Exception:
            old_summary = None

    end = args.asof or today_str()
    built = {}
    for sector in selected:
        sid = sector["id"]
        pool, psrc = load_pool(sector)
        print(f"[{sid}] pool={len(pool.get('core', []))}+{len(pool.get('ext', []))} ({psrc})")
        stats = ensure_bars(pool, end, backfill=args.backfill, no_fetch=args.no_fetch)
        print(f"[{sid}] bars {stats}")
        agg = build_features(pool)
        f = score(agg)
        obj = build_sector_json(sector, pool, f, asof=args.asof, stats=stats)
        out = SECTORS / f"{sid}.json"
        out.write_text(json.dumps(obj, ensure_ascii=False, indent=1, default=_json_default), encoding="utf-8")
        built[sid] = obj
        print(f"[{sid}] {obj['latest']['date']} tier={obj['latest']['tier_name']} R={obj['latest']['R']}")

    # summary: include every registry sector; unused sectors keep their last JSON.
    summary_sectors = []
    for sector in all_sectors:
        sid = sector["id"]
        obj = built.get(sid)
        if obj is None:
            p = SECTORS / f"{sid}.json"
            if p.exists():
                obj = json.load(open(p, encoding="utf-8"))
            else:
                summary_sectors.append({
                    "id": sid, "name": sector["name"], "enabled": bool(sector.get("enabled")),
                    "status": "pending",
                })
                continue
        latest = obj["latest"]
        v2 = obj.get("v2") or {}
        esc = obj.get("escape") or {}
        el = esc.get("latest") or {}
        summary_sectors.append({
            "id": sid,
            "name": sector["name"],
            "enabled": bool(sector.get("enabled")),
            "order": sector.get("order", 99),
            "status": "ok",
            "as_of": latest["date"],
            "tier": latest["tier"],
            "tier_name": latest["tier_name"],
            "action": latest["action"],
            "R": latest["R"],
            "idx": latest["idx"],
            "dd250": latest["dd250"],
            "coverage": obj["meta"].get("coverage"),
            "stale": obj["meta"].get("stale", False),
            "v2_tier": v2.get("tier"),
            "v2_tier_name": v2.get("tier_name"),
            "v2_action": v2.get("action"),
            "v2_R": v2.get("R"),
            "v2_E": v2.get("E"),
            "v2_vol20": v2.get("vol20"),
            "v2_updated_at": obj["meta"]["generated_at"] if v2 else None,
            "escape_state": el.get("state"),
            "escape_state_name": el.get("state_name"),
            "escape_action": el.get("action"),
            "escape_trigger": el.get("trigger"),
            "escape_color": el.get("color"),
            "escape_warn_date": el.get("warn_date"),
            "escape_confirm_date": el.get("confirm_date"),
            "updated_at": obj["meta"]["generated_at"],
        })
    reference_full = build_primary()
    reference = _summary_reference(reference_full)
    summary = {
        "updated_at": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "source": source,
        "escape_reference": reference,
        "sectors": summary_sectors,
    }
    sp.write_text(json.dumps(summary, ensure_ascii=False, indent=1), encoding="utf-8")
    print("summary:", json.dumps(summary_sectors, ensure_ascii=False))
    write_v2_shadow(summary_sectors, built)
    write_escape_shadow(summary_sectors, built, reference_full)


if __name__ == "__main__":
    main()
