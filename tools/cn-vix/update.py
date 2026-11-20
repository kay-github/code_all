#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
CNVIX · A 股"中国波指"重建（运行时引擎，仅用标准库）

数据：中金所每日日行情 CSV（IO/HO/MO 全部期权合约）
方法：CBOE 方差互换法，近月/次近月（>=7 自然日）→ 30 天线性插值
输出：data/history.csv、data/cnvix.json

用法：
  python update.py                 # 增量（最近 10 天）
  python update.py --rebuild       # 从 2019-12-23 全量重建
  python update.py --date 20261119 # 单日调试
"""
import argparse
import csv
import gzip
import io
import json
import math
import os
import re
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, "data")
RAW = os.path.join(ROOT, "raw")
HIST = os.path.join(DATA, "history.csv")
QV = os.path.join(DATA, "qvix_ref.csv")
OUT = os.path.join(DATA, "cnvix.json")

CFFEX_URL = "http://www.cffex.com.cn/sj/hqsj/rtj/{ym}/{dd}/{ymd}_1.csv"
CONTRACT_RE = re.compile(r"^(IO|HO|MO)(\d{4})-([CP])-(\d+(?:\.\d+)?)$")
PRODUCTS = {"IO": "沪深300", "HO": "上证50", "MO": "中证1000"}
START = "2019-12-23"
RISK_FREE = 0.02
ROLL_DAYS = 7
UA = "Mozilla/5.0 (compatible; cnvix/1.0; +https://1.688680.xyz/cnvix)"


def log(msg):
    print(msg, flush=True)


def third_friday(year, month):
    d = date(year, month, 1)
    fridays = [d + timedelta(days=i) for i in range(31)
               if (d + timedelta(days=i)).month == month and (d + timedelta(days=i)).weekday() == 4]
    return fridays[2]


def fetch_day(ymd, retries=3):
    cache = os.path.join(RAW, ymd[:4], ymd[:6], ymd + ".csv.gz")
    text = None
    if os.path.exists(cache):
        try:
            with gzip.open(cache, "rt", encoding="gbk", errors="replace") as f:
                text = f.read()
        except Exception:
            text = None
    if text is None:
        url = CFFEX_URL.format(ym=ymd[:6], dd=ymd[6:8], ymd=ymd)
        for i in range(retries):
            try:
                req = urllib.request.Request(url, headers={"User-Agent": UA})
                with urllib.request.urlopen(req, timeout=25) as r:
                    raw = r.read()
                text = raw.decode("gbk", errors="replace")
                os.makedirs(os.path.dirname(cache), exist_ok=True)
                with gzip.open(cache, "wb") as f:
                    f.write(raw)
                break
            except Exception:
                text = None
                time.sleep(0.4 + i * 0.6)
        if text is None:
            return None, None
    if "合约代码" not in text:
        return None, None
    return datetime.strptime(ymd, "%Y%m%d").date(), parse_text(text)


def parse_text(text):
    chain = {}
    reader = csv.reader(io.StringIO(text))
    header = next(reader, None)
    if not header:
        return chain
    i_code = header.index("合约代码")
    i_settle = header.index("今结算")
    i_close = header.index("今收盘")
    need = max(i_code, i_settle, i_close)
    for row in reader:
        if len(row) <= need:
            continue
        m = CONTRACT_RE.match(row[i_code].strip())
        if not m:
            continue
        prod, yymm, cp, strike = m.groups()
        try:
            settle = float(row[i_settle])
        except ValueError:
            settle = 0.0
        try:
            close = float(row[i_close])
        except ValueError:
            close = 0.0
        price = settle if settle > 0 else close
        if price <= 0:
            continue
        chain.setdefault(prod, {}).setdefault((2000 + int(yymm[:2]), int(yymm[2:])), {}).setdefault(float(strike), {})[cp] = price
    return chain


def vix_for_expiry(legs, t_years, r=RISK_FREE):
    strikes = sorted(k for k, v in legs.items() if "C" in v and "P" in v)
    if len(strikes) < 6 or t_years <= 0:
        return None
    # 平值候选必须两侧都有实际价格（>0.5 点），否则深虚合约同报 0.2 会让 |C-P|=0 被误选
    cands = [k for k in strikes if min(legs[k]["C"], legs[k]["P"]) > 0.5] or strikes
    k_star = min(cands, key=lambda k: abs(legs[k]["C"] - legs[k]["P"]))
    fwd = k_star + math.exp(r * t_years) * (legs[k_star]["C"] - legs[k_star]["P"])
    below = [k for k in strikes if k <= fwd]
    if not below:
        return None
    k0 = max(below)
    otm = []
    for k in strikes:
        if k < k0:
            p = legs[k]["P"]
        elif k > k0:
            p = legs[k]["C"]
        else:
            p = (legs[k]["C"] + legs[k]["P"]) / 2.0
        if p > 0:
            otm.append((k, p))
    if len(otm) < 6:
        return None
    total = 0.0
    for i, (k, p) in enumerate(otm):
        if i == 0:
            dk = otm[1][0] - k
        elif i == len(otm) - 1:
            dk = k - otm[-2][0]
        else:
            dk = (otm[i + 1][0] - otm[i - 1][0]) / 2.0
        total += (dk / (k * k)) * math.exp(r * t_years) * p
    sigma2 = (2.0 / t_years) * total - (1.0 / t_years) * (fwd / k0 - 1.0) ** 2
    return sigma2 if sigma2 > 0 else None


def compute_product(chain_prod, trade_date):
    terms = []
    for (year, month), legs in chain_prod.items():
        expiry = third_friday(year, month)
        days = (expiry - trade_date).days
        if days < ROLL_DAYS:
            continue
        s2 = vix_for_expiry(legs, days / 365.0)
        if s2 is not None:
            terms.append((days, s2))
    if len(terms) < 2:
        return None
    terms.sort(key=lambda x: x[0])
    (n1, s1), (n2, s2_) = terms[0], terms[1]
    t1, t2 = n1 / 365.0, n2 / 365.0
    n30, n365 = 30.0, 365.0
    var30 = (t1 * s1 * (n2 - n30) + t2 * s2_ * (n30 - n1)) / (n2 - n1)
    var30 *= n365 / n30
    return {
        "vix": round(100 * math.sqrt(var30), 2),
        "near_t": round(t1, 4), "next_t": round(t2, 4),
        "near_iv": round(100 * math.sqrt(s1), 2), "next_iv": round(100 * math.sqrt(s2_), 2),
    }


def load_history():
    rows = {}
    if os.path.exists(HIST):
        with open(HIST, "r", encoding="utf-8", newline="") as f:
            for rec in csv.DictReader(f):
                if rec.get("date"):
                    rows[rec["date"]] = rec
    return rows


def load_ref():
    rows = {}
    if os.path.exists(QV):
        with open(QV, "r", encoding="utf-8", newline="") as f:
            for rec in csv.DictReader(f):
                if rec.get("date"):
                    rows[rec["date"]] = rec
    return rows


def save_history(rows):
    fields = ["date"]
    for p in PRODUCTS:
        fields += [p, p + "_near_iv", p + "_next_iv", p + "_near_t", p + "_next_t"]
    os.makedirs(DATA, exist_ok=True)
    with open(HIST, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        for d in sorted(rows):
            w.writerow({k: rows[d].get(k, "") for k in fields})


def fetch_range(rows, start, end):
    days = []
    d = start
    while d <= end:
        if d.weekday() < 5:
            days.append(d.strftime("%Y%m%d"))
        d += timedelta(days=1)
    if not days:
        return 0
    added = 0
    with ThreadPoolExecutor(max_workers=4) as ex:
        futs = {ex.submit(fetch_day, ymd): ymd for ymd in days}
        for fut in as_completed(futs):
            d, chain = fut.result()
            if d is None:
                continue
            row = {"date": d.isoformat()}
            for code in PRODUCTS:
                if code in chain:
                    res = compute_product(chain[code], d)
                    if res:
                        row[code] = res["vix"]
                        row[code + "_near_iv"] = res["near_iv"]
                        row[code + "_next_iv"] = res["next_iv"]
                        row[code + "_near_t"] = res["near_t"]
                        row[code + "_next_t"] = res["next_t"]
            if any(code in row for code in PRODUCTS):
                rows[d.isoformat()] = row
                added += 1
    return added


def pct_rank(values, window=None):
    vals = [v for v in values if v is not None]
    if window:
        vals = vals[-window:]
    if len(vals) < 20:
        return None
    last = vals[-1]
    return round(sum(1 for x in vals if x <= last) / len(vals) * 100, 1)


def to_float(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def build_json(rows, ref):
    dates = sorted(rows)
    series = {"dates": dates}
    for code in PRODUCTS:
        series[code] = [to_float(rows[d].get(code)) for d in dates]
    for k in ("qvix_300etf", "qvix_50etf"):
        if ref:
            series[k] = [to_float(ref.get(d, {}).get(k)) for d in dates]

    latest = {}
    for code, name in PRODUCTS.items():
        vals = [v for v in series[code] if v is not None]
        if not vals:
            continue
        last = dates[max(i for i, v in enumerate(series[code]) if v is not None)]
        rec = rows[last]
        latest[code] = {
            "name": name, "vix": vals[-1],
            "chg": round(vals[-1] - vals[-2], 2) if len(vals) > 1 else 0.0,
            "chg_pct": round((vals[-1] / vals[-2] - 1) * 100, 2) if len(vals) > 1 else 0.0,
            "pctile_1y": pct_rank(series[code], 252),
            "pctile_3y": pct_rank(series[code], 756),
            "pctile_all": pct_rank(series[code]),
            "date": last, "n": len(vals),
            "near_iv": to_float(rec.get(code + "_near_iv")),
            "next_iv": to_float(rec.get(code + "_next_iv")),
            "near_t": to_float(rec.get(code + "_near_t")),
            "next_t": to_float(rec.get(code + "_next_t")),
        }

    validation = {}
    ref_map = {"IO": "qvix_300etf", "HO": "qvix_50etf"}
    for code, refkey in ref_map.items():
        pairs = [(a, b) for a, b in zip(series[code], series.get(refkey, [])) if a is not None and b is not None]
        if len(pairs) < 30:
            continue
        xs = [p[0] for p in pairs]; ys = [p[1] for p in pairs]
        mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
        cov = sum((x - mx) * (y - my) for x, y in pairs)
        sx = math.sqrt(sum((x - mx) ** 2 for x in xs)); sy = math.sqrt(sum((y - my) ** 2 for y in ys))
        corr = cov / (sx * sy) if sx and sy else 0.0
        diffs = [a - b for a, b in pairs]
        validation[code] = {
            "ref": refkey, "n": len(pairs), "corr": round(corr, 4),
            "mae": round(sum(abs(d) for d in diffs) / len(diffs), 2),
            "bias": round(sum(diffs) / len(diffs), 2),
            "last_ref": ys[-1], "last_self": xs[-1],
        }

    recent = []
    for d in dates[-10:]:
        recent.append({"date": d, "IO": to_float(rows[d].get("IO")),
                       "HO": to_float(rows[d].get("HO")), "MO": to_float(rows[d].get("MO"))})

    return {
        "meta": {
            "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "trade_date": max((latest[c]["date"] for c in latest), default=dates[-1]),
            "history_start": dates[0],
            "params": {
                "method": "CBOE VIX 方差互换法，30 天线性插值",
                "price": "中金所日行情「今结算」，缺失退回「今收盘」",
                "roll": "近月/次近月取到期日距当日 ≥ 7 自然日的前两个合约",
                "risk_free": "常数 2.0%",
                "strike": "仅用虚值期权积分，K0 取不高于远期价的最大行权价",
            },
            "sources": {"option": "中国金融期货交易所 每日日行情 CSV（IO/HO/MO）",
                        "reference": "期权论坛 QVIX（akshare 接口，本地刷新）"},
        },
        "latest": latest,
        "validation": validation,
        "series": series,
        "recent": recent,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rebuild", action="store_true")
    ap.add_argument("--date", help="单日调试 YYYYMMDD")
    ap.add_argument("--days", type=int, default=10)
    args = ap.parse_args()

    rows = load_history()
    if args.date:
        d, chain = fetch_day(args.date)
        if d is None:
            log("无数据（非交易日或下载失败）")
            return
        for code in PRODUCTS:
            if code in chain:
                log(code, compute_product(chain[code], d))
        return

    if args.rebuild or not rows:
        start = datetime.strptime(START, "%Y-%m-%d").date()
    else:
        start = datetime.strptime(max(rows), "%Y-%m-%d").date() - timedelta(days=args.days)
    end = date.today()
    if start > end:
        start = end - timedelta(days=1)
    log("增量区间 %s → %s（已有 %d 行）" % (start, end, len(rows)))
    before = set(rows)
    added = fetch_range(rows, start, end)
    new_days = len(set(rows) - before)
    log("新增/覆盖 %d 个交易日，其中新增 %d 天" % (added, new_days))
    if new_days == 0 and os.path.exists(HIST) and not args.rebuild:
        log("无新数据，跳过写入")
        return
    save_history(rows)
    ref = load_ref()
    payload = build_json(rows, ref)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    log("trade_date=%s IO=%s HO=%s MO=%s bytes=%d" % (
        payload["meta"]["trade_date"],
        payload["latest"].get("IO", {}).get("vix"),
        payload["latest"].get("HO", {}).get("vix"),
        payload["latest"].get("MO", {}).get("vix"),
        os.path.getsize(OUT)))


if __name__ == "__main__":
    main()
