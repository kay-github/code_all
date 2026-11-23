# -*- coding: utf-8 -*-
"""Daily market pulse raw-data collector.

Data layer:
  - a-stock-data (simonlin1212/a-stock-data, Apache-2.0) for Tencent index quotes
  - AKShare (MIT) wrappers for 同花顺 / 东财 datacenter / exchange margin data
  - direct Eastmoney push2 flow endpoints are fetched by fetch_em_flow.py
"""
import json
import os
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import pandas as pd
import akshare as ak

DATE = os.environ.get("MP_DATE") or (sys.argv[1] if len(sys.argv) > 1 else datetime.now(ZoneInfo("Asia/Shanghai")).strftime("%Y-%m-%d"))
COMPACT = DATE.replace("-", "")
START = os.environ.get("MP_START") or (datetime.strptime(DATE, "%Y-%m-%d") - timedelta(days=18)).strftime("%Y%m%d")
ROOT = Path(os.environ.get("MP_ROOT", Path(__file__).resolve().parent.parent))
RAW = ROOT / "data" / DATE / "raw"
RAW.mkdir(parents=True, exist_ok=True)

sys.path.insert(0, str(ROOT / "vendor" / "a-stock-data"))
import astock_skill as ast

meta = {"date": DATE, "fetched_at": datetime.now().isoformat(timespec="seconds"), "sources": {}, "errors": []}

pd.set_option("display.width", 240)


def save_df(name, df):
    path = RAW / f"{name}.csv"
    df.to_csv(path, index=False, encoding="utf-8-sig")
    print(f"[ok] {name}: {df.shape} -> {path.name}")


def run(name, fn, save=True):
    t0 = time.time()
    try:
        df = fn()
        if isinstance(df, pd.DataFrame) and save:
            save_df(name, df)
        meta["sources"][name] = {"rows": len(df) if hasattr(df, "__len__") else None,
                                 "seconds": round(time.time() - t0, 1)}
        return df
    except Exception as exc:
        meta["errors"].append({"name": name, "error": f"{type(exc).__name__}: {exc}"})
        print(f"[ERR] {name}: {type(exc).__name__}: {exc}")
        return None


# 1) index quotes via Tencent (a-stock-data)
codes = ["000001", "399001", "399006", "000688", "000300", "000905", "000852", "899050"]
try:
    quotes = ast.tencent_quote(codes)
    (RAW / "indices.json").write_text(json.dumps(quotes, ensure_ascii=False, indent=2), encoding="utf-8")
    meta["sources"]["indices"] = {"rows": len(quotes)}
    print("[ok] indices", {k: (v.get("name"), v.get("price"), v.get("change_pct")) for k, v in quotes.items()})
except Exception as exc:
    meta["errors"].append({"name": "indices", "error": f"{type(exc).__name__}: {exc}"})
    print("[ERR] indices", exc)

# 2) breadth
breadth = run("breadth_legu", lambda: ak.stock_market_activity_legu())
if breadth is not None:
    print(breadth.to_string(index=False))

# 3) 同花顺 industry / concept / stock flows
ind_flow = run("industry_flow_ths", lambda: ak.stock_fund_flow_industry(symbol="即时"))
ind_sum = run("industry_summary_ths", lambda: ak.stock_board_industry_summary_ths())
con_flow = run("concept_flow_ths", lambda: ak.stock_fund_flow_concept(symbol="即时"))
stock_flow = run("stock_flow_ths", lambda: ak.stock_fund_flow_individual(symbol="即时"))

# 4) limit-up pools
zt = run("zt_pool", lambda: ak.stock_zt_pool_em(date=COMPACT))
yzt = run("yzt_pool", lambda: ak.stock_zt_pool_previous_em(date=COMPACT))
dt = run("dt_pool", lambda: ak.stock_zt_pool_dtgc_em(date=COMPACT))

# 5) LHB: today first; fallback to the latest disclosed day within 7 days
lhb_today = run("lhb_today", lambda: ak.stock_lhb_detail_em(start_date=COMPACT, end_date=COMPACT))
if lhb_today is None or len(lhb_today) == 0:
    for back in range(1, 8):
        d = (datetime.strptime(DATE, "%Y-%m-%d") - timedelta(days=back)).strftime("%Y%m%d")
        lhb_prev = run("lhb_prev", lambda d=d: ak.stock_lhb_detail_em(start_date=d, end_date=d))
        if lhb_prev is not None and len(lhb_prev):
            (RAW / "lhb_prev_date.txt").write_text(d, encoding="utf-8")
            break

# 6) margin: SSE range; SZSE latest disclosed day (T+1, so today usually empty)
sse = run("margin_sse", lambda: ak.stock_margin_sse(start_date=START, end_date=COMPACT))
for back in range(1, 12):
    d = (datetime.strptime(DATE, "%Y-%m-%d") - timedelta(days=back)).strftime("%Y%m%d")
    try:
        szse = ak.stock_margin_szse(date=d)
        if szse is None or len(szse) == 0:
            continue
        szse.to_csv(RAW / "margin_szse.csv", index=False, encoding="utf-8-sig")
        szse.to_csv(RAW / f"margin_szse_{d}.csv", index=False, encoding="utf-8-sig")
        meta["sources"]["margin_szse"] = {"date": d, "rows": len(szse)}
        print("[ok] margin_szse", d, szse.iloc[0]["融资余额"])
        break
    except Exception as exc:
        meta["errors"].append({"name": f"margin_szse_{d}", "error": f"{type(exc).__name__}: {exc}"})
        print("[ERR] margin_szse", d, exc)

# 7) northbound summary (net value is no longer disclosed; only counts)
hsgt = run("hsgt_summary", lambda: ak.stock_hsgt_fund_flow_summary_em())

# 8) limit-up sentiment summary from a-stock-data (if available)
try:
    sent = ast.limit_up_sentiment(COMPACT)
    (RAW / "limit_up_sentiment.json").write_text(json.dumps(sent, ensure_ascii=False, indent=2), encoding="utf-8")
    meta["sources"]["limit_up_sentiment"] = {"ok": True}
    print("[ok] limit_up_sentiment", json.dumps(sent, ensure_ascii=False)[:300])
except Exception as exc:
    meta["errors"].append({"name": "limit_up_sentiment", "error": f"{type(exc).__name__}: {exc}"})
    print("[ERR] limit_up_sentiment", exc)

(RAW / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
print("\nDONE", RAW)
print("errors:", len(meta["errors"]))
