# -*- coding: utf-8 -*-
"""Build the structured daily market-pulse dataset from raw files."""
import json
import math
import os
import re
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import pandas as pd

from narrative import build_narrative

DATE = os.environ.get("MP_DATE") or (sys.argv[1] if len(sys.argv) > 1 else datetime.now(ZoneInfo("Asia/Shanghai")).strftime("%Y-%m-%d"))
ROOT = Path(os.environ.get("MP_ROOT", Path(__file__).resolve().parent.parent))
RAW = ROOT / "data" / DATE / "raw"
OUT = ROOT / "data" / DATE / "analysis.json"
WEEKDAY_CN = "周一 周二 周三 周四 周五 周六 周日".split()
WEEKDAY = WEEKDAY_CN[datetime.strptime(DATE, "%Y-%m-%d").weekday()]

def to_num(x):
    if isinstance(x, (int, float)) and not (isinstance(x, float) and math.isnan(x)):
        return float(x)
    if not isinstance(x, str):
        return 0.0
    s = x.strip().replace(",", "")
    if s in ("", "-", "--"):
        return 0.0
    if s.endswith("亿"):
        return float(s[:-1])
    if s.endswith("万"):
        return float(s[:-1]) / 1e4
    if s.endswith("%"):
        s = s[:-1]
    try:
        return float(s)
    except ValueError:
        return 0.0

def to_yi_stock(x):
    """同花顺个股表：带亿/万后缀；无后缀的是原始元。"""
    if isinstance(x, (int, float)) and not (isinstance(x, float) and math.isnan(x)):
        return float(x) / 1e8
    if not isinstance(x, str):
        return 0.0
    s = x.strip().replace(",", "")
    if s in ("", "-", "--"):
        return 0.0
    if s.endswith("亿"):
        return float(s[:-1])
    if s.endswith("万"):
        return float(s[:-1]) / 1e4
    try:
        return float(s) / 1e8
    except ValueError:
        return 0.0

def r2(x):
    return round(float(x), 2)

def quality(net, net5):
    """Classify today's flow against the prior 4 sessions.

    prior4 = rolling 5-day net - today's net. This is exact for THS' 5-day rolling table.
    """
    net = float(net or 0)
    net5 = float(net5 or 0)
    prior4 = net5 - net
    ratio = None
    if abs(prior4) > 0.01:
        ratio = net / abs(prior4)
    if prior4 < -0.01:
        if net <= 0:
            label, tone = "继续流出", "neg"
        elif ratio is not None and ratio >= 1:
            label, tone = "新钱", "pos"
        elif ratio is not None and ratio >= 0.5:
            label, tone = "强回补", "warn"
        else:
            label, tone = "弱回补", "warn"
    elif prior4 > 0.01:
        if net <= 0:
            label, tone = "转出", "neg"
        elif ratio is not None and ratio >= 1:
            label, tone = "加速流入", "pos"
        elif ratio is not None and ratio >= 0.5:
            label, tone = "持续流入", "pos"
        else:
            label, tone = "流入衰减", "warn"
    else:
        label, tone = ("新增流入" if net > 0 else "无基线"), ("pos" if net > 0 else "muted")
    return {
        "prior4": r2(prior4),
        "ratio": r2(ratio * 100) if ratio is not None else None,
        "label": label,
        "tone": tone,
    }

# ---------------- indices ----------------
raw_indices = json.loads((RAW / "indices.json").read_text(encoding="utf-8"))
if isinstance(raw_indices, dict):
    indices = [{"code": code, **quote} for code, quote in raw_indices.items()]
else:
    indices = raw_indices
for it in indices:
    it["prev_close"] = r2(it["price"] / (1 + it["change_pct"] / 100))
    it["reversal_from_low"] = r2((it["price"] - it["low"]) / it["low"] * 100)
    it["close_pos"] = r2((it["price"] - it["low"]) / (it["high"] - it["low"]) * 100) if it["high"] > it["low"] else 100
    it["amplitude"] = r2((it["high"] - it["low"]) / it["prev_close"] * 100)
    it["amount_yi"] = r2(it["amount_wan"] / 1e4)

# ---------------- turnover ----------------
sh = next(x for x in indices if x["code"] == "sh000001")
sz = next(x for x in indices if x["code"] == "sz399001")
bj = next(x for x in indices if x["code"] == "bj899050")
turnover_total = r2(sh["amount_yi"] + sz["amount_yi"] + bj["amount_yi"])
turnover_hs = r2(sh["amount_yi"] + sz["amount_yi"])

# ---------------- breadth ----------------
breadth_raw = pd.read_csv(RAW / "breadth_legu.csv")
bmap = {str(k).strip(): v for k, v in zip(breadth_raw["item"], breadth_raw["value"])}
iv = lambda k: int(float(bmap[k])) if k in bmap else 0
breadth = {
    "up": iv("上涨"),
    "down": iv("下跌"),
    "flat": iv("平盘"),
    "suspended": iv("停牌"),
    "limit_up": iv("涨停"),
    "real_limit_up": iv("真实涨停"),
    "limit_down": iv("跌停"),
    "real_limit_down": iv("真实跌停"),
    "active": float(str(bmap["活跃度"]).replace("%", "")),
}

zt = json.loads((RAW / "limit_up_sentiment.json").read_text(encoding="utf-8"))
ladder = {str(k): int(v) for k, v in zt["ladder"].items()}

# ---------------- THS full-market flow ----------------
ths_path = RAW / "stock_flow_ths_v2.csv"
if not ths_path.exists():
    ths_path = RAW / "stock_flow_ths.csv"
ths = pd.read_csv(ths_path, dtype=str).drop_duplicates("股票代码")
ths["net_yi"] = ths["净额"].map(to_yi_stock)
ths["amt_yi"] = ths["成交额"].map(to_yi_stock)
ths["chg"] = ths["涨跌幅"].map(to_num)
ths["code6"] = ths["股票代码"].str.zfill(6)
ths_total_net = r2(ths["net_yi"].sum())
ths_total_amt = r2(ths["amt_yi"].sum())
ths_up = int((ths["chg"] > 0).sum())
ths_down = int((ths["chg"] < 0).sum())

ths5_path = RAW / "stock_flow_ths_5d_v2.csv"
if not ths5_path.exists():
    ths5_path = RAW / "stock_flow_ths_5d.csv"
if ths5_path.exists():
    ths5 = pd.read_csv(ths5_path, dtype=str).drop_duplicates("股票代码")
    ths5["net5_yi"] = ths5["资金流入净额"].map(to_yi_stock)
    ths5["code6"] = ths5["股票代码"].str.zfill(6)
else:
    # Degrade gracefully: no rolling table today, use today's net as the 5-day proxy
    # so the page still renders; the narrative will show "无基线".
    ths5 = ths[["code6", "net_yi"]].copy().rename(columns={"net_yi": "net5_yi"})
    print("[warn] 5-day THS table missing; using today's net as 5-day proxy")
ths5_total = r2(ths5["net5_yi"].sum())
prior4_total = r2(ths5_total - ths_total_net)

# ---------------- Sina super-large ----------------
sina = pd.read_csv(RAW / "sina_moneyflow_all.csv", dtype={"symbol": str})
sina = sina[sina["symbol"].str.match(r"^(sh6|sz(00|30)|bj(4|8|9))")].copy()
sina["code6"] = sina["symbol"].str[2:]
sina = sina[sina["code6"].isin(set(ths["code6"]))].copy()
sina["super_yi"] = pd.to_numeric(sina["r0_net"], errors="coerce") / 1e8
sina["small_yi"] = pd.to_numeric(sina["r3_net"], errors="coerce") / 1e8
sina["amt_yi"] = pd.to_numeric(sina["amount"], errors="coerce") / 1e8
sina["chg"] = pd.to_numeric(sina["changeratio"], errors="coerce") * 100
sina_market = sina.groupby(sina["symbol"].str[:2])[["super_yi", "small_yi", "amt_yi"]].sum().round(2)
sina_total = r2(sina["super_yi"].sum())
sina_counts = int(len(sina))

# ---------------- Eastmoney SH main flow (single verified snapshot) ----------------
em_path = RAW / "em_sh_flow.json"
if em_path.exists():
    em_sh = json.loads(em_path.read_text(encoding="utf-8"))
else:
    em_sh = {
        "date": DATE,
        "main_yi": 0.0,
        "super_yi": 0.0,
        "large_yi": 0.0,
        "medium_yi": 0.0,
        "small_yi": 0.0,
        "close": sh["price"],
        "chg": sh["change_pct"],
        "note": "今日未取到东财 push2 沪市资金流快照（收盘后接口限流）；该口径留空，不用 0 值替代真实数据。",
    }

# ---------------- ETF national-team channel ----------------
def load_etf_official():
    env_path = os.environ.get("MP_ETF_FLOW")
    if env_path and Path(env_path).exists():
        return pd.read_csv(env_path)
    gjd_latest_path = ROOT.parent / "gjd_research" / "data" / "v2" / "latest.json"
    if gjd_latest_path.exists():
        gjd_latest = json.loads(gjd_latest_path.read_text(encoding="utf-8"))
        p = Path(gjd_latest["path"]) / "official_flow.csv"
        if p.exists():
            return pd.read_csv(p)
    # Cloud checkout: market-pulse sits under tools/, next to national-team-etf/
    for p in [
        ROOT.parent.parent / "national-team-etf" / "data" / "official_flow.csv",
        ROOT.parent.parent / "tools" / "national-team-etf" / "data" / "official_flow.csv",
        ROOT.parent / "national-team-etf" / "data" / "official_flow.csv",
    ]:
        if p.exists():
            return pd.read_csv(p)
    raise SystemExit("official_flow.csv not found; set MP_ETF_FLOW")

official = load_etf_official()
official["date"] = official["date"].astype(str)
etf_daily = official.groupby("date")["exposure_estimate_yi"].sum().round(2)
etf_dates = list(etf_daily.index)
etf_latest_date = etf_dates[-1]
etf_latest = r2(etf_daily.iloc[-1])
etf_d5 = r2(etf_daily.iloc[-5:].sum())
etf_seq = [{"date": d, "net": r2(etf_daily[d])} for d in etf_dates[-8:]]
sse_codes = {"510050", "510300", "510310", "510330", "510500", "512050", "512100", "563360", "588000", "588080"}
latest_rows = official[official["date"] == etf_latest_date]
sse_net = r2(latest_rows[latest_rows["code"].astype(str).isin(sse_codes)]["exposure_estimate_yi"].sum())
szse_net = r2(latest_rows[~latest_rows["code"].astype(str).isin(sse_codes)]["exposure_estimate_yi"].sum())

# ETF 5-day decomposition by index / style. Official flow only covers 15 broad-base ETFs.
ETF_INDEX_MAP = {
    "510300": "沪深300", "510310": "沪深300", "510330": "沪深300", "159919": "沪深300",
    "510050": "上证50",
    "510500": "中证500",
    "512100": "中证1000", "159845": "中证1000",
    "159915": "创业板", "159949": "创业板",
    "588000": "科创50", "588080": "科创50",
    "512050": "中证A500", "159338": "中证A500", "563360": "中证A500",
}
ETF_INDEX_STYLE = {
    "沪深300": ("大盘宽基", "red"),
    "上证50": ("大盘价值", "red2"),
    "中证500": ("中盘", "blue"),
    "中证1000": ("小盘", "green"),
    "创业板": ("成长", "gold"),
    "科创50": ("科技成长", "gold"),
    "中证A500": ("大盘宽基", "muted"),
}
ETF_FUND_NAMES = {
    "510300": "沪深300ETF（华泰柏瑞）",
    "510310": "沪深300ETF（易方达）",
    "510330": "沪深300ETF（华夏）",
    "159919": "沪深300ETF（嘉实）",
    "510050": "上证50ETF（华夏）",
    "510500": "中证500ETF（南方）",
    "512100": "中证1000ETF（南方）",
    "159845": "中证1000ETF（华夏）",
    "159915": "创业板ETF（易方达）",
    "159949": "创业板50ETF（华安）",
    "588000": "科创50ETF（华夏）",
    "588080": "科创板50ETF（易方达）",
    "512050": "中证A500ETF（华夏）",
    "159338": "中证A500ETF（国泰）",
    "563360": "中证A500ETF（华泰柏瑞）",
}
etf_window_dates = etf_dates[-5:]
etf_window = official[official["date"].isin(etf_window_dates)].copy()
by_code = etf_window.groupby("code")["exposure_estimate_yi"].sum().sort_values(ascending=False)
etf_funds = []
for code, net in by_code.items():
    code = str(code).zfill(6)
    idx = ETF_INDEX_MAP.get(code, "其他")
    etf_funds.append({
        "code": code,
        "name": ETF_FUND_NAMES.get(code, f"{idx}ETF"),
        "index": idx,
        "style": ETF_INDEX_STYLE.get(idx, ("其他", "muted"))[0],
        "net": r2(net),
        "share": r2(net / etf_d5 * 100) if etf_d5 else 0,
    })
bucket_rows = etf_window.assign(index=etf_window["code"].astype(str).map(lambda c: ETF_INDEX_MAP.get(c, "其他")))
bucket_rows = bucket_rows.groupby("index")["exposure_estimate_yi"].sum().sort_values(ascending=False)
etf_buckets = []
for idx, net in bucket_rows.items():
    etf_buckets.append({
        "name": idx,
        "style": ETF_INDEX_STYLE.get(idx, ("其他", "muted"))[0],
        "tone": ETF_INDEX_STYLE.get(idx, ("其他", "muted"))[1],
        "net": r2(net),
        "share": r2(net / etf_d5 * 100) if etf_d5 else 0,
    })

# ---------------- margin ----------------
sse_m = pd.read_csv(RAW / "margin_sse.csv")
sse_m["date"] = sse_m["信用交易日期"].astype(str)
sse_m["fin_yi"] = sse_m["融资余额"] / 1e8
sse_m["all_yi"] = sse_m["融资融券余额"] / 1e8
sse_m = sse_m.sort_values("date", ascending=False).reset_index(drop=True)
# 取最近一个有深交所明细的交易日，避免拿 T 日未披露的两融硬算
margin_idx = None
for i, row in sse_m.iterrows():
    if (RAW / f"margin_szse_{row['date']}.csv").exists():
        margin_idx = i
        break
if margin_idx is None:
    raise SystemExit("no margin_szse_*.csv found")
sse_latest = sse_m.iloc[margin_idx]
sz_latest = pd.read_csv(RAW / f"margin_szse_{sse_latest['date']}.csv").iloc[0]
sse_prev4 = sse_m.iloc[margin_idx + 4]
sse_prev5 = sse_m.iloc[margin_idx + 5]
sz_prev4 = pd.read_csv(RAW / f"margin_szse_{sse_prev4['date']}.csv").iloc[0]
sz_prev5 = pd.read_csv(RAW / f"margin_szse_{sse_prev5['date']}.csv").iloc[0]
margin_date = f"{sse_latest['date'][:4]}-{sse_latest['date'][4:6]}-{sse_latest['date'][6:]}"
margin = {
    "date": margin_date,
    "total_fin": r2(sse_latest["fin_yi"] + sz_latest["融资余额"]),
    "total_all": r2(sse_latest["all_yi"] + sz_latest["融资融券余额"]),
    "sse_fin": r2(sse_latest["fin_yi"]),
    "szse_fin": r2(sz_latest["融资余额"]),
    "chg4": r2((sse_latest["fin_yi"] + sz_latest["融资余额"]) - (sse_prev4["fin_yi"] + sz_prev4["融资余额"])),
    "chg5": r2((sse_latest["fin_yi"] + sz_latest["融资余额"]) - (sse_prev5["fin_yi"] + sz_prev5["融资余额"])),
}
margin_series = []
for _, row in sse_m.sort_values("date").iterrows():
    d = row["date"]
    sz_path = RAW / f"margin_szse_{d}.csv"
    if not sz_path.exists():
        continue
    sz_row = pd.read_csv(sz_path).iloc[0]
    margin_series.append({"date": f"{d[:4]}-{d[4:6]}-{d[6:]}",
                          "total": r2(row["fin_yi"] + sz_row["融资余额"])})
margin["series"] = margin_series

# ---------------- industries ----------------
ind_today = pd.read_csv(RAW / "industry_flow_ths.csv")
ind_today["net"] = ind_today["净额"].map(to_num)
ind_today["chg"] = ind_today["行业-涨跌幅"].map(to_num)
ind5 = pd.read_csv(RAW / "industry_flow_ths_5d.csv") if (RAW / "industry_flow_ths_5d.csv").exists() else pd.DataFrame(columns=["行业", "净额", "阶段涨跌幅"])
ind5["net5"] = ind5["净额"].map(to_num)
ind10 = pd.read_csv(RAW / "industry_flow_ths_10d.csv") if (RAW / "industry_flow_ths_10d.csv").exists() else pd.DataFrame(columns=["行业", "净额", "阶段涨跌幅"])
ind10["net10"] = ind10["净额"].map(to_num)
ind_sum = pd.read_csv(RAW / "industry_summary_ths.csv") if (RAW / "industry_summary_ths.csv").exists() else pd.DataFrame(columns=["板块", "总成交额", "上涨家数", "下跌家数", "领涨股"])
ind_sum["amount"] = ind_sum["总成交额"].map(to_num)

ind = ind_today.merge(ind5[["行业", "净额", "阶段涨跌幅"]].rename(columns={"净额": "net5", "阶段涨跌幅": "chg5"}), on="行业", how="left")
ind = ind.merge(ind10[["行业", "净额", "阶段涨跌幅"]].rename(columns={"净额": "net10", "阶段涨跌幅": "chg10"}), on="行业", how="left")
ind = ind.merge(
    ind_sum[["板块", "总成交额", "上涨家数", "下跌家数", "领涨股"]]
    .rename(columns={"板块": "行业", "领涨股": "summary_leader"}),
    on="行业", how="left")
ind = ind.fillna({"net5": 0, "net10": 0, "总成交额": 0, "上涨家数": 0, "下跌家数": 0})
industries = []
for _, row in ind.iterrows():
    q = quality(row["net"], row["net5"])
    industries.append({
        "name": row["行业"],
        "chg": r2(row["chg"]),
        "net": r2(row["net"]),
        "net5": r2(row["net5"]),
        "net10": r2(row["net10"]),
        "amount": r2(row["总成交额"]),
        "up": int(row["上涨家数"]),
        "down": int(row["下跌家数"]),
        "leader": row["summary_leader"] if isinstance(row["summary_leader"], str) else "",
        **q,
    })

# ---------------- concepts ----------------
con_today = pd.read_csv(RAW / "concept_flow_ths.csv")
con_today["net"] = con_today["净额"].map(to_num)
con_today["chg"] = con_today["行业-涨跌幅"].map(to_num)
con5 = pd.read_csv(RAW / "concept_flow_ths_5d.csv") if (RAW / "concept_flow_ths_5d.csv").exists() else pd.DataFrame(columns=["行业", "净额"])
con5["net5"] = con5["净额"].map(to_num)
con = con_today.merge(con5[["行业", "净额"]].rename(columns={"净额": "net5"}), on="行业", how="left").fillna({"net5": 0})
concepts = []
for _, row in con.iterrows():
    q = quality(row["net"], row["net5"])
    concepts.append({
        "name": row["行业"],
        "chg": r2(row["chg"]),
        "net": r2(row["net"]),
        "net5": r2(row["net5"]),
        "stocks": int(row["公司家数"]),
        "leader": row["领涨股"] if isinstance(row["领涨股"], str) else "",
        **q,
    })

# ---------------- stocks ----------------
sina_idx = sina.set_index("code6")
stock_rows = []
for _, row in ths.iterrows():
    code = row["code6"]
    srow = sina_idx.loc[code] if code in sina_idx.index else None
    d5row = ths5[ths5["code6"] == code]
    d5 = r2(d5row.iloc[0]["net5_yi"]) if len(d5row) else 0.0
    q = quality(row["net_yi"], d5)
    stock_rows.append({
        "code": code,
        "name": row["股票简称"],
        "price": r2(to_num(row["最新价"])),
        "chg": r2(row["chg"]),
        "amount": r2(row["amt_yi"]),
        "net": r2(row["net_yi"]),
        "super": r2(srow["super_yi"]) if srow is not None else 0.0,
        "small": r2(srow["small_yi"]) if srow is not None else 0.0,
        "d5": d5,
        "turnover": row["换手率"] if isinstance(row["换手率"], str) else "",
        **q,
    })

SECTOR_MAP = {
    "300308": "光模块", "300502": "光模块", "300394": "光模块", "002281": "光模块",
    "603986": "存储/芯片", "688008": "芯片", "603893": "芯片", "002156": "封测",
    "688981": "晶圆制造", "002371": "半导体设备", "688012": "半导体设备",
    "300750": "动力电池", "000725": "面板", "000100": "面板",
    "002384": "PCB", "300476": "PCB", "600183": "覆铜板", "002916": "PCB",
    "002050": "机器人/热管理", "601689": "机器人/汽零", "300124": "工控/机器人",
    "688836": "人形机器人", "688017": "机器人/减速器",
    "603259": "CXO", "300363": "CXO", "300759": "CXO",
    "601138": "AI服务器", "000001": "银行", "601916": "银行", "600036": "银行",
    "601318": "保险", "600519": "白酒", "601899": "有色", "603993": "有色",
    "300059": "券商", "600030": "券商", "002685": "题材/机械", "600715": "传媒",
    "002579": "PCB", "002242": "小家电", "300829": "化工", "002771": "通信",
}

for s in stock_rows:
    s["sector"] = SECTOR_MAP.get(s["code"], "")

# top inflow / outflow by THS net
top_in = sorted(stock_rows, key=lambda x: x["net"], reverse=True)[:20]
top_out = sorted(stock_rows, key=lambda x: x["net"])[:12]
featured = sorted([s for s in stock_rows if s["super"] >= 2.5], key=lambda x: x["super"], reverse=True)[:16]

# 资金质量：新钱 / 强回补 / 持续流入。只保留有意义的净流入标的，避免小分母噪声。
def stock_quality(row):
    return row["ratio"] if row["ratio"] is not None else -999

new_money = sorted(
    [s for s in stock_rows if s["net"] >= 2 and s["prior4"] <= -2 and s["ratio"] is not None and s["ratio"] >= 100],
    key=lambda s: (s["ratio"], s["net"]), reverse=True)[:12]
strong_refill = sorted(
    [s for s in stock_rows if s["net"] >= 2 and s["prior4"] <= -2 and s["ratio"] is not None and 0 <= s["ratio"] < 100],
    key=lambda s: (s["ratio"], s["net"]), reverse=True)[:12]
steady_inflow = sorted(
    [s for s in stock_rows if s["net"] >= 1 and s["prior4"] > 1],
    key=lambda s: s["net"], reverse=True)[:12]

# 行业质量榜：只展示“前4日净流出、今日净流入”的回补/新钱，按比例排序。
industry_refill = sorted(
    [x for x in industries if x["net"] > 0 and x["prior4"] <= -3 and x["ratio"] is not None],
    key=lambda x: (x["ratio"], x["net"]), reverse=True)
industry_distribution = sorted(
    [x for x in industries if x["net"] < 0 and x["prior4"] > 1],
    key=lambda x: x["ratio"])[:8]

# divergence: super-large vs all-order
big_buy_sell = sorted([s for s in stock_rows if s["super"] > 1 and s["net"] < -1], key=lambda x: x["super"], reverse=True)[:15]
big_sell_buy = sorted([s for s in stock_rows if s["super"] < -1 and s["net"] > 1], key=lambda x: x["super"])[:8]

# ---------------- LHB ----------------
lhb_meta_path = RAW / "lhb_meta.json"
lhb_path = RAW / "lhb_jg.csv"
if lhb_path.exists():
    lhb_date_raw = json.loads(lhb_meta_path.read_text(encoding="utf-8"))["date"] if lhb_meta_path.exists() else ""
    lhb_date = lhb_date_raw or ""
else:
    lhb_path = RAW / "lhb_jg_1120.csv"
    lhb_date = "2026-11-20"
lhb_rows = []
lhb_top_buy = []
lhb_top_sell = []
if lhb_path.exists():
    lhb = pd.read_csv(lhb_path)
    lhb = lhb.drop_duplicates("代码")
    lhb["机构净买"] = lhb["机构买入净额"] / 1e8
    lhb_rows = [{
        "code": str(r["代码"]).zfill(6),
        "name": r["名称"],
        "chg": r2(r["涨跌幅"]),
        "net": r2(r["机构净买"]),
        "buyers": int(r["买方机构数"]),
        "sellers": int(r["卖方机构数"]),
        "reason": r["上榜原因"],
    } for _, r in lhb.iterrows()]
    lhb_top_buy = sorted(lhb_rows, key=lambda x: x["net"], reverse=True)[:8]
    lhb_top_sell = sorted(lhb_rows, key=lambda x: x["net"])[:5]

# ---------------- assemble ----------------
data = {
    "date": DATE,
    "weekday": WEEKDAY,
    "generated_at": datetime.now().isoformat(timespec="seconds"),
    "headline": "",
    "indices": indices,
    "turnover": {
        "total": turnover_total,
        "hs": turnover_hs,
        "sh": sh["amount_yi"],
        "sz": sz["amount_yi"],
        "bj": bj["amount_yi"],
        "ths": ths_total_amt,
    },
    "breadth": breadth,
    "zt": {
        "count": zt["zt_count"],
        "broken": zt["zb_count"],
        "break_rate": zt["break_rate"],
        "max_height": zt["max_height"],
        "ladder": ladder,
        "first": ladder.get("1", 0),
        "second": ladder.get("2", 0),
        "third": ladder.get("3", 0),
        "fourth": ladder.get("4", 0),
        "fifth_plus": sum(v for k, v in ladder.items() if int(k) >= 5),
        "breadth_limit_up": breadth["limit_up"],
        "breadth_real_limit_up": breadth["real_limit_up"],
    },
    "flows": {
        "ths": {"total": ths_total_net, "up": ths_up, "down": ths_down, "amount": ths_total_amt},
        "sina": {"super_total": sina_total, "sh": r2(sina_market.loc["sh", "super_yi"]) if "sh" in sina_market.index else 0,
                 "sz": r2(sina_market.loc["sz", "super_yi"]) if "sz" in sina_market.index else 0,
                 "bj": r2(sina_market.loc["bj", "super_yi"]) if "bj" in sina_market.index else 0,
                 "small_total": r2(sina["small_yi"].sum()), "stocks": sina_counts},
        "em_sh": em_sh,
        "prior4": {"ths": prior4_total, "margin": margin["chg4"], "etf5": etf_d5},
        "d5_total": ths5_total,
    },
    "etf": {"date": etf_latest_date, "net": etf_latest, "sse": sse_net, "szse": szse_net,
            "d5": etf_d5, "seq": etf_seq, "codes": 15,
            "decomp": {"start": etf_window_dates[0], "end": etf_window_dates[-1],
                       "total": etf_d5, "buckets": etf_buckets, "funds": etf_funds}},
    "margin": margin,
    "industries": industries,
    "concepts": concepts,
    "flow_quality": {"industries": industry_refill[:14], "distribution": industry_distribution},
    "stocks": {"top_in": top_in, "top_out": top_out, "featured": featured,
               "new_money": new_money, "strong_refill": strong_refill, "steady_inflow": steady_inflow},
    "divergence": {"big_buy_sell": big_buy_sell, "big_sell_buy": big_sell_buy},
    "lhb": {"date": lhb_date, "top_buy": lhb_top_buy if lhb_rows else [], "top_sell": lhb_top_sell if lhb_rows else [],
            "note": (f"目标日 {DATE} 龙虎榜 17:00 后披露；此处为最近披露日 {lhb_date} 机构席位统计。"
                     if lhb_date and lhb_date != DATE else "目标日龙虎榜机构席位统计。")},
    "sources": [
        "腾讯行情（a-stock-data tencent_quote）",
        "东方财富 push2 资金流（沪市单点快照）",
        "同花顺资金流（行业/概念/个股，即时与5日）",
        "新浪 MoneyFlow（超大单/小单）",
        "东方财富涨停池/跌停池/昨日涨停",
        "上交所/深交所两融数据",
        "gjd_research 国家队 ETF 申赎（15只宽基，估算口径）",
        f"东方财富龙虎榜机构统计（{lhb_date or '待披露'}）",
    ],
}

data["narrative"] = build_narrative(data)
data["headline"] = re.sub(r"<[^>]+>", "", data["narrative"].get("hero_title", "")).strip()

OUT.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
print("written", OUT, OUT.stat().st_size, "bytes")
print("headline:", data["headline"])
print("turnover", turnover_total, "ths", ths_total_amt)
print("ths net", ths_total_net, "d5", ths5_total, "prior4", prior4_total)
print("sina super", sina_total, data["flows"]["sina"])
print("etf", etf_latest, etf_d5, "margin", margin)
print("zt", data["zt"])
print("industries", len(industries), "concepts", len(concepts))
print("top_in first", top_in[0])
print("divergence", len(big_buy_sell), len(big_sell_buy))
