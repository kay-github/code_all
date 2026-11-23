# -*- coding: utf-8 -*-
"""Fetch Sina MoneyFlow full A-share snapshot (size-bucket net flows)."""
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import requests
import pandas as pd

DATE = os.environ.get("MP_DATE") or (sys.argv[1] if len(sys.argv) > 1 else datetime.now(ZoneInfo("Asia/Shanghai")).strftime("%Y-%m-%d"))
ROOT = Path(os.environ.get("MP_ROOT", Path(__file__).resolve().parent.parent))
OUT = ROOT / "data" / DATE / "raw"
OUT.mkdir(parents=True, exist_ok=True)

URL = "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/MoneyFlow.ssl_bkzj_ssggzj"
HEAD = {"Referer": "https://finance.sina.com.cn/", "User-Agent": "Mozilla/5.0"}

rows = []
s = requests.Session()
s.trust_env = True
for page in range(1, 80):
    params = {"page": page, "num": 100, "sort": "netamount", "asc": 0}
    r = s.get(URL, params=params, headers=HEAD, timeout=20)
    text = r.text.strip()
    if text in ("", "[]", "null"):
        print("empty page", page)
        break
    batch = json.loads(text)
    if not batch:
        break
    rows.extend(batch)
    print(f"page {page}: {len(batch)} rows, total {len(rows)}")
    if len(batch) < 100:
        break
    time.sleep(0.2)

df = pd.DataFrame(rows)
df.to_csv(OUT / "sina_moneyflow_all.csv", index=False, encoding="utf-8-sig")
print("\nrows", len(df))
print("columns:", list(df.columns))
print("first row keys:", list(rows[0].keys()))

for col in ["trade", "changeratio", "turnover", "amount", "inamount", "outamount", "netamount",
            "ratioamount", "r0_in", "r0_out", "r0", "r1_in", "r1_out", "r1", "r2_in", "r2_out",
            "r2", "r3_in", "r3_out", "r3"]:
    if col in df:
        df[col] = pd.to_numeric(df[col], errors="coerce")

df["main_net"] = (df["r0_in"] - df["r0_out"])
if "r1_in" in df:
    df["main_net"] = df["main_net"] + (df["r1_in"] - df["r1_out"])
df["main_net_yi"] = df["main_net"] / 1e8
df["netamount_yi"] = pd.to_numeric(df["netamount"], errors="coerce") / 1e8
df["amount_yi"] = pd.to_numeric(df["amount"], errors="coerce") / 1e8
df["market"] = df["symbol"].str[:2]
df.to_csv(OUT / "sina_moneyflow_all.csv", index=False, encoding="utf-8-sig")

print("\nrows", len(df), "cols", list(df.columns))
print("sum netamount (亿):", round(df["netamount_yi"].sum(), 2))
print("sum main(r0+r1 if any) (亿):", round(df["main_net_yi"].sum(), 2))
print("sum r0 net (亿):", round(((df["r0_in"] - df["r0_out"]) / 1e8).sum(), 2))
print("by market:\n", df.groupby("market")[["netamount_yi", "main_net_yi", "amount_yi"]].sum().round(2))
print("\nTOP 20 by main_net")
print(df.nlargest(20, "main_net")[["symbol", "name", "trade", "changeratio", "amount_yi", "netamount_yi", "main_net_yi"]].to_string(index=False))
print("\nBOTTOM 15 by main_net")
print(df.nsmallest(15, "main_net")[["symbol", "name", "trade", "changeratio", "amount_yi", "netamount_yi", "main_net_yi"]].to_string(index=False))
