# -*- coding: utf-8 -*-
"""Fetch SZSE margin detail for every date present in margin_sse.csv."""
import os
import sys
from datetime import datetime
from zoneinfo import ZoneInfo

import akshare as ak
import pandas as pd
from pathlib import Path

DATE = os.environ.get("MP_DATE") or (sys.argv[1] if len(sys.argv) > 1 else datetime.now(ZoneInfo("Asia/Shanghai")).strftime("%Y-%m-%d"))
ROOT = Path(os.environ.get("MP_ROOT", Path(__file__).resolve().parent.parent))
RAW = ROOT / "data" / DATE / "raw"
sse_path = RAW / "margin_sse.csv"
if not sse_path.exists():
    raise SystemExit(f"missing {sse_path}; run fetch_daily.py first")

sse = pd.read_csv(sse_path)
sse["信用交易日期"] = sse["信用交易日期"].astype(str)
for d in sse["信用交易日期"].tolist():
    p = RAW / f"margin_szse_{d}.csv"
    if p.exists():
        print("exists", d)
        continue
    try:
        df = ak.stock_margin_szse(date=d)
        df.to_csv(p, index=False, encoding="utf-8-sig")
        print("ok", d, df.iloc[0]["融资余额"])
    except Exception as exc:
        print("ERR", d, exc)
