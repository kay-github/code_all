# -*- coding: utf-8 -*-
"""Fetch LHB institutional seat stats for the target date; fall back to the latest disclosed day."""
import json
import os
import sys
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import akshare as ak
from pathlib import Path

DATE = os.environ.get("MP_DATE") or (sys.argv[1] if len(sys.argv) > 1 else datetime.now(ZoneInfo("Asia/Shanghai")).strftime("%Y-%m-%d"))
ROOT = Path(os.environ.get("MP_ROOT", Path(__file__).resolve().parent.parent))
RAW = ROOT / "data" / DATE / "raw"
RAW.mkdir(parents=True, exist_ok=True)
target = datetime.strptime(DATE, "%Y-%m-%d")

found = False
for back in range(0, 8):
    d = (target - timedelta(days=back)).strftime("%Y%m%d")
    try:
        df = ak.stock_lhb_jgmmtj_em(start_date=d, end_date=d)
    except Exception as exc:
        print("LHB ERR", d, type(exc).__name__, exc)
        continue
    if df is None or len(df) == 0:
        print("LHB empty", d)
        continue
    df.to_csv(RAW / "lhb_jg.csv", index=False, encoding="utf-8-sig")
    meta = {
        "date": f"{d[:4]}-{d[4:6]}-{d[6:]}",
        "source": "stock_lhb_jgmmtj_em",
        "note": "目标日龙虎榜未披露时，自动沿用最近披露日" if back else "目标日龙虎榜",
    }
    (RAW / "lhb_meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    if back == 0:
        df.to_csv(RAW / "lhb_jg_today.csv", index=False, encoding="utf-8-sig")
    print("LHB ok", d, df.shape)
    found = True
    break

if not found:
    print("LHB no data in last 7 days; keep existing lhb_jg.csv if any")
