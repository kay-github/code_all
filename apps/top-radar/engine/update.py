# -*- coding: utf-8 -*-
"""Build per-sector JSON + summary for the Top Radar dashboard."""
import argparse
import json
import os
from datetime import datetime
from pathlib import Path

import pandas as pd
import requests

from config import CONFIG_API, DATA, POOLS, REGISTRY, SECTORS, SITE, TIER_ACTION, TIER_NAME
from features import build_features
from fetch import ensure_bars, today_str
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
    try:
        r = requests.get(CONFIG_API + "?view=registry", timeout=8)
        if r.ok:
            data = r.json()
            if isinstance(data, dict) and data.get("sectors"):
                return data, "remote"
    except Exception:
        pass
    with open(REGISTRY, encoding="utf-8") as fh:
        return json.load(fh), "local"


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


def build_sector_json(sector, pool, f, asof=None):
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
        "site": SITE,
    }

    return {
        "meta": meta,
        "latest": latest_obj,
        "gate": gate,
        "history": history,
        "signals": signals,
        "stats": {
            "days": int(len(f)),
            "start": idx[0].strftime("%Y-%m-%d"),
            "end": idx[-1].strftime("%Y-%m-%d"),
        },
    }


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
        obj = build_sector_json(sector, pool, f, asof=args.asof)
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
            "updated_at": obj["meta"]["generated_at"],
        })
    summary = {
        "updated_at": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "source": source,
        "sectors": summary_sectors,
    }
    sp.write_text(json.dumps(summary, ensure_ascii=False, indent=1), encoding="utf-8")
    print("summary:", json.dumps(summary_sectors, ensure_ascii=False))


if __name__ == "__main__":
    main()
