# -*- coding: utf-8 -*-
"""Optional Eastmoney Shanghai main-flow snapshot.

This is the only source that gives the exchange-level "main / super / large /
medium / small" buckets in one shot. It is often rate-limited after the close
from residential IPs, so callers must treat it as optional.
"""
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import requests

DATE = os.environ.get("MP_DATE") or (sys.argv[1] if len(sys.argv) > 1 else datetime.now(ZoneInfo("Asia/Shanghai")).strftime("%Y-%m-%d"))
ROOT = Path(os.environ.get("MP_ROOT", Path(__file__).resolve().parent.parent))
RAW = ROOT / "data" / DATE / "raw"
RAW.mkdir(parents=True, exist_ok=True)

URL = "https://push2.eastmoney.com/api/qt/clist/get"
HEAD = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    "Referer": "https://data.eastmoney.com/zjlx/detail.html",
}
PARAMS = {
    "fid": "f62",
    "po": "1",
    "pz": "200",
    "pn": "1",
    "np": "1",
    "fltt": "2",
    "invt": "2",
    "ut": "b2884a393a59ad64002292a3e90d46a5",
    # Shanghai main board + STAR + Shanghai B-share exclusion markers.
    "fs": "m:1+t:2+f:!2,m:1+t:23+f:!2,m:1+t:3+f:!2",
    "fields": "f12,f14,f2,f3,f62,f66,f72,f78,f84",
}


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def fetch_page(session, page):
    params = dict(PARAMS, pn=str(page))
    for attempt in range(3):
        try:
            r = session.get(URL, params=params, headers=HEAD, timeout=20)
            r.raise_for_status()
            return r.json()
        except Exception as exc:
            print(f"[warn] em page {page} attempt {attempt+1}: {type(exc).__name__}: {exc}")
            time.sleep(1.5 + attempt)
    return None


def main():
    session = requests.Session()
    first = fetch_page(session, 1)
    if not first or not first.get("data") or not first["data"].get("diff"):
        print("[skip] Eastmoney push2 unavailable; leave em_sh_flow.json absent")
        return 0
    total = int(first["data"].get("total") or 0)
    pages = max(1, (total + 199) // 200)
    rows = list(first["data"]["diff"])
    for page in range(2, pages + 1):
        payload = fetch_page(session, page)
        if payload and payload.get("data") and payload["data"].get("diff"):
            rows.extend(payload["data"]["diff"])
        else:
            print(f"[warn] em page {page} missing")
    if not rows:
        print("[skip] no rows")
        return 0
    sums = {k: 0.0 for k in ("f62", "f66", "f72", "f78", "f84")}
    for row in rows:
        for k in sums:
            sums[k] += num(row.get(k))
    snap = {
        "date": DATE,
        "main_yi": round(sums["f62"] / 1e8, 2),
        "super_yi": round(sums["f66"] / 1e8, 2),
        "large_yi": round(sums["f72"] / 1e8, 2),
        "medium_yi": round(sums["f78"] / 1e8, 2),
        "small_yi": round(sums["f84"] / 1e8, 2),
        "stocks": len(rows),
        "source": "push2.eastmoney.com clist f62/f66/f72/f78/f84, Shanghai A-share sum",
        "fetched_at": datetime.now().isoformat(timespec="seconds"),
        "note": "沪市全 A 单点快照；深市未取到，不与深市同口径比较。",
    }
    (RAW / "em_sh_flow.json").write_text(json.dumps(snap, ensure_ascii=False, indent=2), encoding="utf-8")
    print("[ok] em_sh_flow", snap)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
