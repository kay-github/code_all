# -*- coding: utf-8 -*-
"""趋势买卖点 · 生产数据管线（纯标准库）

抓取东财指数日线（不复权，含成交额）→ 合并全历史 → 计算指标与信号
→ 输出 data/history/*.csv、data/signals.json、data/meta.json
→ 可选 PushPlus 推送（仅当日新信号）。

用法：
  python update.py            # 抓数 + 重建 + 推送
  python update.py --no-push  # 只更新数据
  python update.py --rebuild  # 不抓数，用现有 CSV 重建
  python update.py --check    # 只检查数据新鲜度，不写文件
  python update.py --main-wave-only --no-push  # 用本地沪深300交易日历更新 ETF 快照
"""
import os, sys, csv, json, math, argparse, urllib.request, urllib.parse
from datetime import datetime, timedelta, timezone

try:
    import main_wave
except ImportError:
    main_wave = None

try:
    import main_wave_v2
except ImportError:
    main_wave_v2 = None

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, "data")
HIST = os.path.join(DATA, "history")
BJ = timezone(timedelta(hours=8))

INDICES = [
    ("sh000300", "1.000300", "沪深300"),
    ("sh000905", "1.000905", "中证500"),
    ("sh000852", "1.000852", "中证1000"),
    ("sz399006", "0.399006", "创业板指"),
    ("sh000688", "1.000688", "科创50"),
]
PARAMS = dict(entry_n=25, exit_n=22, atr_mult=3.0, ma=250, buf=0.005, hard_stop_n=2.0, cost=0.0005)

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/131.0 Safari/537.36"}


def now_bj():
    return datetime.now(BJ)


def log(*a):
    print(*a, flush=True)


def fetch_em(secid, beg="0", *, adjustment=0, end="20500101", host="push2his.eastmoney.com", timeout=45):
    url = ("https://" + host + "/api/qt/stock/kline/get?secid=" + secid +
           "&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58"
           "&klt=101&fqt=" + str(adjustment) + "&beg=" + beg + "&end=" + end + "&lmt=1000000")
    req = urllib.request.Request(url, headers=UA)
    raw = urllib.request.urlopen(req, timeout=timeout).read().decode("utf-8", "replace")
    j = json.loads(raw)
    if not j.get("data") or j["data"].get("code") != secid.split(".")[-1] or not j["data"].get("klines"):
        raise RuntimeError("eastmoney empty: " + raw[:160])
    rows = []
    for s in j["data"]["klines"]:
        p = s.split(",")
        if len(p) < 7:
            continue
        rows.append(dict(date=p[0], open=float(p[1]), close=float(p[2]), high=float(p[3]),
                         low=float(p[4]), volume=float(p[5]) * 100.0, amount=float(p[6])))
    return rows


def fetch_tx(code):
    """腾讯备用源（指数用 day 节点）"""
    url = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=%s,day,,,800" % code
    req = urllib.request.Request(url, headers=dict(UA, Referer="https://gu.qq.com/"))
    j = json.loads(urllib.request.urlopen(req, timeout=45).read().decode("utf-8", "replace"))
    data = (j.get("data") or {}).get(code) or {}
    ks = data.get("day") or data.get("qfqday") or []
    rows = []
    for p in ks:
        if len(p) < 6:
            continue
        rows.append(dict(date=p[0], open=float(p[1]), close=float(p[2]), high=float(p[3]),
                         low=float(p[4]), volume=float(p[5]) * 100.0, amount=0.0))
    return rows


def read_csv(path):
    rows = []
    if not os.path.exists(path):
        return rows
    with open(path, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            rows.append(dict(date=r["date"], open=float(r["open"]), high=float(r["high"]),
                             low=float(r["low"]), close=float(r["close"]),
                             volume=float(r["volume"]), amount=float(r.get("amount") or 0)))
    return rows


def write_csv(path, rows):
    tmp = path + ".tmp"
    with open(tmp, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["date", "open", "high", "low", "close", "volume", "amount"])
        for r in rows:
            w.writerow([r["date"], f"{r['open']:.2f}", f"{r['high']:.2f}", f"{r['low']:.2f}",
                        f"{r['close']:.2f}", str(int(round(r["volume"]))), f"{r['amount']:.2f}"])
    os.replace(tmp, path)


def merge(base, inc):
    m = {r["date"]: r for r in base}
    for r in inc:
        m[r["date"]] = r          # 同日以最新抓取为准，修正盘中/除权误差
    return [m[k] for k in sorted(m)]


def validate(rows, code):
    if not rows:
        raise RuntimeError(code + " empty")
    ds = [r["date"] for r in rows]
    if len(ds) != len(set(ds)):
        raise RuntimeError(code + " duplicate dates")
    maxjump = 0.0
    for i, r in enumerate(rows):
        if not (r["low"] <= min(r["open"], r["close"]) <= max(r["open"], r["close"]) <= r["high"]):
            raise RuntimeError(code + " bad OHLC at " + r["date"])
        if min(r["open"], r["high"], r["low"], r["close"]) <= 0:
            raise RuntimeError(code + " nonpositive price at " + r["date"])
        if r["volume"] < 0:
            raise RuntimeError(code + " negative volume at " + r["date"])
        if i:
            chg = abs(r["close"] / rows[i - 1]["close"] - 1)
            maxjump = max(maxjump, chg)
            if chg > 0.35:
                raise RuntimeError("%s jump %.1f%% at %s" % (code, chg * 100, r["date"]))
        if r["date"] > now_bj().strftime("%Y-%m-%d"):
            raise RuntimeError(code + " future date " + r["date"])
    return round(maxjump, 4)


def sma(v, n):
    out = [None] * len(v)
    s = 0.0
    for i, x in enumerate(v):
        s += x
        if i >= n:
            s -= v[i - n]
        if i >= n - 1:
            out[i] = s / n
    return out


def ema(v, n):
    a = 2.0 / (n + 1)
    out = [0.0] * len(v)
    for i, x in enumerate(v):
        out[i] = x if i == 0 else a * x + (1 - a) * out[i - 1]
    return out


def rma(v, n):
    a = 1.0 / n
    out = [0.0] * len(v)
    for i, x in enumerate(v):
        out[i] = x if i == 0 else a * x + (1 - a) * out[i - 1]
    return out


def rolling_max(v, n):
    out = [None] * len(v)
    for i in range(n - 1, len(v)):
        out[i] = max(v[i - n + 1:i + 1])
    return out


def rolling_min(v, n):
    out = [None] * len(v)
    for i in range(n - 1, len(v)):
        out[i] = min(v[i - n + 1:i + 1])
    return out


def indicators(rows):
    o = [r["open"] for r in rows]; h = [r["high"] for r in rows]; l = [r["low"] for r in rows]; c = [r["close"] for r in rows]
    n = len(rows)
    ma = sma(c, PARAMS["ma"])
    hh25 = rolling_max(h, PARAMS["entry_n"])
    hh22 = rolling_max(h, PARAMS["exit_n"])
    tr = [0.0] * n
    tr[0] = h[0] - l[0]
    for i in range(1, n):
        tr[i] = max(h[i] - l[i], abs(h[i] - c[i - 1]), abs(l[i] - c[i - 1]))
    atr22 = rma(tr, PARAMS["exit_n"])
    return dict(o=o, h=h, l=l, c=c, ma=ma, hh25=hh25, hh22=hh22, atr22=atr22)


def simulate(rows, ind):
    n = len(rows); o = ind["o"]; c = ind["c"]; ma = ind["ma"]; hh25 = ind["hh25"]; hh22 = ind["hh22"]; atr = ind["atr22"]
    pos = 0; entry_i = -1; entry_px = 0.0; stop = -1e9; hard = -1e9; pend = None; events = []
    for t in range(1, n):
        if pos == 0 and pend == "BUY" and o[t] > 0:
            pos = 1; entry_i = t; entry_px = o[t] * (1 + PARAMS["cost"])
            stop = -1e9; hard = o[t] - PARAMS["hard_stop_n"] * atr[t - 1]
            events.append(dict(type="BUY", sig_date=rows[t - 1]["date"], exec_date=rows[t]["date"],
                               px=round(entry_px, 2), sig_close=round(c[t - 1], 2), stop=round(hard, 2),
                               hold=None, ret=None))
            pend = None
        elif pos == 1 and pend == "SELL" and o[t] > 0:
            px = o[t] * (1 - PARAMS["cost"])
            eff = max(stop, hard)
            events.append(dict(type="SELL", sig_date=rows[t - 1]["date"], exec_date=rows[t]["date"],
                               px=round(px, 2), sig_close=round(c[t - 1], 2), stop=round(eff, 2),
                               hold=t - entry_i, ret=round(px / entry_px - 1, 4)))
            pos = 0; pend = None; entry_px = 0.0
        if pos == 1:
            stop = max(stop, hh22[t] - PARAMS["atr_mult"] * atr[t])
        pend = None
        if ma[t] is None or t < 60 or ma[t - 60] is None:
            trend = False
        else:
            trend = c[t] > ma[t] and ma[t] > ma[t - 60]
        if pos == 0:
            if hh25[t - 1] is not None and c[t] > hh25[t - 1] * (1 + PARAMS["buf"]) and trend:
                pend = "BUY"
        else:
            if c[t] < max(stop, hard) * (1 - PARAMS["buf"]):
                pend = "SELL"
    return events, dict(pos=pos, entry_i=entry_i, entry_px=entry_px, stop=stop, hard=hard, pend=pend)


def build_index(code, name, rows):
    ind = simulate(rows, indicators(rows))
    events, st = ind
    t = len(rows) - 1
    ind2 = indicators(rows)
    c = ind2["c"]; ma = ind2["ma"]; chg = c[t] / c[t - 1] - 1 if t else 0
    year = rows[t]["date"][:4]
    base = [r["close"] for r in rows if r["date"] < year + "-01-01"]
    ytd = c[t] / base[-1] - 1 if base else None
    last250 = rows[-250:]
    rets = [c[i] / c[i - 1] - 1 for i in range(max(1, t - 19), t + 1)]
    vol20 = (sum((x - sum(rets) / len(rets)) ** 2 for x in rets) / (len(rets) - 1)) ** 0.5 * math.sqrt(252) if len(rets) > 2 else None
    ma_up = bool(ma[t] is not None and t >= 60 and ma[t - 60] is not None and ma[t] > ma[t - 60])
    buy_trigger = ind2["hh25"][t - 1] * (1 + PARAMS["buf"]) if ind2["hh25"][t - 1] is not None else None
    stop_eff = max(st["stop"], st["hard"]) if st["pos"] == 1 else None
    return {
        "code": code, "name": name, "start": rows[0]["date"], "end": rows[t]["date"], "bars": len(rows),
        "state": {"pos": st["pos"],
                  "entry_date": rows[st["entry_i"]]["date"] if st["pos"] == 1 else None,
                  "entry_px": round(st["entry_px"], 2) if st["pos"] == 1 else None,
                  "stop": round(stop_eff, 2) if st["pos"] == 1 else None,
                  "hard_stop": round(st["hard"], 2) if st["pos"] == 1 else None,
                  "pending": st["pend"] or "", "pending_since": rows[t]["date"] if st["pend"] else None},
        "levels": {"close": round(c[t], 2), "chg": round(chg, 4),
                   "ma250": round(ma[t], 2) if ma[t] is not None else None, "ma250_slope_up": ma_up,
                   "ma250_lag60": round(ma[t - 60], 2) if ma_up or (ma[t - 60] is not None) else None,
                   "hh25": round(ind2["hh25"][t - 1], 2) if ind2["hh25"][t - 1] is not None else None,
                   "buy_trigger": round(buy_trigger, 2) if buy_trigger else None,
                   "chandelier": round(ind2["hh22"][t] - PARAMS["atr_mult"] * ind2["atr22"][t], 2),
                   "atr22": round(ind2["atr22"][t], 2)},
        "stats": {"ytd": round(ytd, 4) if ytd is not None else None,
                  "high52": round(max(r["high"] for r in last250), 2),
                  "low52": round(min(r["low"] for r in last250), 2),
                  "vol20": round(vol20, 4) if vol20 is not None else None,
                  "dist_ma250": round(c[t] / ma[t] - 1, 4) if ma[t] else None},
        "events": events,
    }


def push_plus(title, content):
    token = os.environ.get("PUSHPLUS_TOKEN", "").strip()
    if token:
        try:
            body = json.dumps({"token": token, "title": title, "content": content, "template": "markdown"}).encode()
            req = urllib.request.Request("https://www.pushplus.plus/send", data=body,
                                         headers={"Content-Type": "application/json"})
            r = json.loads(urllib.request.urlopen(req, timeout=30).read().decode())
            log("PushPlus:", r.get("code"), r.get("msg"))
            if r.get("code") == 200:
                return True
        except Exception as e:
            log("PushPlus 直连失败:", e)
    # 复用站点已有的 Vercel PushPlus 通道，避免在 GitHub 再存一份 token
    secret = os.environ.get("MONITOR_SECRET", "").strip()
    if secret:
        try:
            html = (content.replace("&", "&amp;").replace("<", "&lt;")
                    .replace("\n", "<br>").replace("**", ""))
            body = json.dumps({"title": title, "content": html}).encode()
            req = urllib.request.Request(
                "https://1.688680.xyz/api/top-radar?action=notify", data=body,
                headers={"Content-Type": "application/json", "Authorization": "Bearer " + secret})
            r = json.loads(urllib.request.urlopen(req, timeout=30).read().decode())
            log("PushPlus relay:", r.get("ok"), r.get("error", ""))
            return bool(r.get("ok"))
        except Exception as e:
            log("PushPlus relay 失败:", e)
            return False
    if not token:
        log("PUSHPLUS_TOKEN / MONITOR_SECRET 均未配置，跳过推送")
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-push", action="store_true")
    ap.add_argument("--rebuild", action="store_true")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--main-wave-only", action="store_true", help="只更新主升浪发现器")
    a = ap.parse_args()
    now = now_bj()
    today = now.strftime("%Y-%m-%d")
    log("北京时间", now.strftime("%Y-%m-%d %H:%M"), "交易日数据日", today)

    if a.main_wave_only:
        if a.rebuild or a.check:
            ap.error("--main-wave-only 需要读取行情，不能与 --rebuild 或 --check 同用")
        if main_wave_v2 is None and main_wave is None:
            ap.error("主升浪模块未部署，无法执行 --main-wave-only")
        update_main_wave(now, a.no_push)
        return

    prev_push = {}
    push_path = os.path.join(DATA, "push_state.json")
    if os.path.exists(push_path):
        try:
            prev_push = json.load(open(push_path, encoding="utf-8"))
        except Exception:
            prev_push = {}

    built = {}
    changed = False
    for code, secid, name in INDICES:
        path = os.path.join(HIST, code + ".csv")
        base = read_csv(path)
        if a.rebuild:
            inc = []
        else:
            beg = (datetime.strptime(base[-1]["date"], "%Y-%m-%d") - timedelta(days=12)).strftime("%Y%m%d") if base else "0"
            try:
                inc = fetch_em(secid, beg)
            except Exception as e:
                log(code, "东财失败:", e, "→ 尝试腾讯")
                try:
                    inc = fetch_tx(code)
                except Exception as e2:
                    log(code, "腾讯也失败:", e2)
                    inc = []
        # 盘中保护：15:05 前剔除当日未收盘 bar
        if now.hour * 60 + now.minute < 15 * 60 + 5:
            inc = [r for r in inc if r["date"] < today]
            base = [r for r in base if r["date"] < today]
        rows = merge(base, inc)
        maxjump = validate(rows, code)
        if a.check:
            log(code, "bars", len(rows), "last", rows[-1]["date"], "maxjump", maxjump)
            continue
        if rows != base:
            changed = True
        write_csv(path, rows)
        info = build_index(code, name, rows)
        info["backtest"] = None
        built[code] = info
        log(code, "bars", len(rows), "last", rows[-1]["date"], "state", info["state"]["pos"],
            "pending", info["state"]["pending"], "maxjump", maxjump)

    if a.check:
        return

    # 合并已有统计与回测
    sig_path = os.path.join(DATA, "signals.json")
    old = {}
    if os.path.exists(sig_path):
        try:
            old = json.load(open(sig_path, encoding="utf-8"))
        except Exception:
            old = {}
    for code, info in built.items():
        if code in old.get("indices", {}):
            info["backtest"] = old["indices"][code].get("backtest")
    out = {"updated": now.strftime("%Y-%m-%d %H:%M"), "data_date": max(v["end"] for v in built.values()),
           "indices": {k: v for k, v in built.items()}}
    tmp = sig_path + ".tmp"
    json.dump(out, open(tmp, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, sig_path)

    meta = {"updated": out["updated"], "data_date": out["data_date"],
            "source": "东方财富指数日线（不复权，成交量已换算为股）",
            "bars": {k: v["bars"] for k, v in built.items()},
            "disclaimer": "历史回测不构成投资建议；信号为收盘后生成，下一交易日开盘执行。"}
    json.dump(meta, open(os.path.join(DATA, "meta.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)

    if not a.rebuild and (main_wave_v2 is not None or main_wave is not None):
        try:
            update_main_wave(now, a.no_push)
        except Exception as e:
            log("主升浪发现器更新失败:", e)

    # 新信号推送
    if not a.no_push:
        sent = prev_push.get("sent")
        if not isinstance(sent, list):
            # 兼容旧版只记录 last 的 push_state.json
            sent = [prev_push.get("last")] if prev_push.get("last") else []
        for code, info in built.items():
            p = info["state"]["pending"]
            if not p:
                continue
            key = "%s|%s|%s" % (code, info["end"], p)
            if key in sent:
                log("已推送过", key, "跳过")
                continue
            # 只推“当日收盘信号”；补跑隔日且已开盘则不推
            if info["end"] != today:
                log(code, "信号日", info["end"], "非今日，跳过推送")
                continue
            nm = info["name"]; lv = info["levels"]
            if p == "BUY":
                title = "趋势买点 | %s 买入信号" % nm
                lines = ["**%s** 收盘 %.2f（%+.2f%%）" % (nm, lv["close"], lv["chg"] * 100),
                         "- 信号：收盘突破 25 日高点 %.2f（含 0.5%% 缓冲）" % lv["buy_trigger"],
                         "- 条件：站上 250 日年线 %.2f，且年线高于 60 个交易日前" % lv["ma250"],
                         "- 执行：下一交易日开盘买入（回测按开盘价 + 5bp）",
                         "- 初始止损：入场价 - 2×ATR22（当前 ATR %.2f）" % lv["atr22"],
                         "", "> 规则化趋势跟随，不预测顶底；信号可能失败，严格按止损执行。"]
            else:
                title = "趋势卖点 | %s 卖出信号" % nm
                lines = ["**%s** 收盘 %.2f（%+.2f%%）" % (nm, lv["close"], lv["chg"] * 100),
                         "- 信号：收盘跌破跟踪止损 %.2f（22 日高 - 3×ATR22，只上移）" % lv["chandelier"],
                         "- 执行：下一交易日开盘卖出（回测按开盘价 - 5bp）",
                         "- 卖出是风险退出，不代表看空后市；趋势重新成立会再买回。",
                         "", "> 规则化趋势跟随，不预测顶底；信号可能失败，严格按止损执行。"]
            ok = push_plus(title, "\n".join(lines))
            if ok:
                sent.append(key)
                sent = sent[-50:]
                prev_push = {"sent": sent, "last": key, "time": now.strftime("%Y-%m-%d %H:%M"), "title": title}
                json.dump(prev_push, open(push_path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)

    log("完成，数据日", out["data_date"], "变更", changed)


def update_main_wave(now, no_push):
    if main_wave_v2 is not None:
        benchmark = read_csv(os.path.join(HIST, "sh000300.csv"))
        snapshot = main_wave_v2.refresh(benchmark, DATA, now, fetch_em)
        log("主升浪发现器v2", snapshot["data_date"], "ETF", len(snapshot["etfs"]), "覆盖", snapshot["coverage"])
        if not no_push:
            main_wave_v2.send_alerts(snapshot, DATA, now, push_plus)
        return
    if main_wave is None:
        return
    benchmark = read_csv(os.path.join(HIST, "sh000300.csv"))
    snapshot = main_wave.refresh(benchmark, DATA, now, fetch_em)
    log("主升浪发现器", snapshot["data_date"], "ETF", len(snapshot["etfs"]))
    if not no_push:
        main_wave.send_alerts(snapshot, DATA, now, push_plus)


if __name__ == "__main__":
    main()
