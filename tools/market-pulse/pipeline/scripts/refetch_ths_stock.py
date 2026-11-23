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
for sym, tag in [("即时", "stock_flow_ths_v2"), ("5日排行", "stock_flow_ths_5d_v2")]:
    try:
        df = ak.stock_fund_flow_individual(symbol=sym)
        codes = df["股票代码"].astype(str).str.zfill(6)
        unique = codes.nunique()
        print(tag, df.shape, "unique", unique)
        print("contains 宁德/兆易/中际:", df[df["股票简称"].isin(["宁德时代", "兆易创新", "中际旭创"])][["股票代码", "股票简称"]].to_string(index=False))
        if unique < 4900:
            print(f"[warn] {tag} only {unique} unique; keep partial file, do not overwrite production table")
            df.to_csv(RAW / f"{tag}_partial.csv", index=False, encoding="utf-8-sig")
            continue
        df.to_csv(RAW / f"{tag}.csv", index=False, encoding="utf-8-sig")
    except Exception as exc:
        print("ERR", tag, exc)
