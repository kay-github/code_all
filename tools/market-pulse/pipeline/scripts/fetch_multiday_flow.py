# -*- coding: utf-8 -*-
import os
import sys
from datetime import datetime
from zoneinfo import ZoneInfo

import akshare as ak
from pathlib import Path

DATE = os.environ.get("MP_DATE") or (sys.argv[1] if len(sys.argv) > 1 else datetime.now(ZoneInfo("Asia/Shanghai")).strftime("%Y-%m-%d"))
ROOT = Path(os.environ.get("MP_ROOT", Path(__file__).resolve().parent.parent))
RAW = ROOT / "data" / DATE / "raw"
RAW.mkdir(parents=True, exist_ok=True)

CASES = [
    ("industry_flow_ths_5d", lambda: ak.stock_fund_flow_industry(symbol="5日排行")),
    ("industry_flow_ths_10d", lambda: ak.stock_fund_flow_industry(symbol="10日排行")),
    ("concept_flow_ths_5d", lambda: ak.stock_fund_flow_concept(symbol="5日排行")),
    ("stock_flow_ths_5d", lambda: ak.stock_fund_flow_individual(symbol="5日排行")),
]

for name, fn in CASES:
    try:
        df = fn()
        df.to_csv(RAW / f"{name}.csv", index=False, encoding="utf-8-sig")
        print(f"[ok] {name}: {df.shape}")
        print(df.head(8).to_string(index=False))
    except Exception as exc:
        print(f"[ERR] {name}: {type(exc).__name__}: {exc}")
