# -*- coding: utf-8 -*-
"""A股光通信产业链 —— 多周期涨跌幅 + 回撤测算（腾讯行情/K线通道，支持盘中实时）

输出：D:/work_code2/光通信跌幅榜_数据.json （rows + meta）
"""
import json, os, time, io, datetime
from concurrent.futures import ThreadPoolExecutor

import requests

BASE = os.environ.get("OPTICAL_BASE") or "D:/work_code2/"

try:
    import akshare as ak
except Exception:
    ak = None

HDR = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Referer": "https://gu.qq.com/"}
S = requests.Session()
S.trust_env = False

# (代码, 名称, 细分环节)
POOL = [
    # A 光模块 / 光器件整机
    ("300308", "中际旭创", "光模块"),
    ("300502", "新易盛", "光模块"),
    ("002281", "光迅科技", "光模块/器件"),
    ("000988", "华工科技", "光模块"),
    ("603083", "剑桥科技", "光模块"),
    ("300394", "天孚通信", "光器件/封装"),
    ("300570", "太辰光", "光器件/连接"),
    ("300548", "博创科技", "光器件"),
    ("301205", "联特科技", "光模块"),
    ("688205", "德科立", "光模块/子系统"),
    ("002902", "铭普光磁", "光模块/磁性件"),
    ("603042", "华脉科技", "光通信器件"),
    ("600345", "长江通信", "光通信"),
    ("000936", "华西股份", "光模块(索尔思)"),
    ("600498", "烽火通信", "光通信设备"),
    ("300292", "吴通控股", "光通信/连接"),
    # B 光芯片 / 激光器 / 光学元件
    ("688498", "源杰科技", "光芯片"),
    ("688313", "仕佳光子", "光芯片/PLC"),
    ("688048", "长光华芯", "激光芯片"),
    ("300620", "光库科技", "光器件/调制器"),
    ("688195", "腾景科技", "光学元件"),
    ("688167", "炬光科技", "光子器件"),
    ("300489", "光智科技", "红外光学"),
    # C 光纤光缆
    ("601869", "长飞光纤", "光纤光缆"),
    ("600487", "亨通光电", "光纤光缆/海缆"),
    ("600522", "中天科技", "光纤光缆/海缆"),
    ("600105", "永鼎股份", "光纤光缆"),
    ("002491", "通鼎互联", "光纤光缆"),
    ("600973", "宝胜股份", "线缆"),
    # D 连接器 / 高速线缆 / 插芯结构件
    ("002130", "沃尔核材", "高速铜缆"),
    ("300563", "神宇股份", "高速线缆"),
    ("300913", "兆龙互连", "高速线缆"),
    ("002897", "意华股份", "连接器/结构件"),
    ("688668", "鼎通科技", "连接器精密件"),
    ("688800", "瑞可达", "连接器"),
    ("002179", "中航光电", "连接器"),
    ("002025", "航天电器", "连接器"),
    ("300602", "飞荣达", "屏蔽/散热件"),
    # F 上游材料/封装/光学元件补充
    ("002222", "福晶科技", "光学晶体"),
    ("003031", "中瓷电子", "陶瓷封装"),
    ("300408", "三环集团", "陶瓷插芯"),
    ("300346", "南大光电", "光芯片材料"),
    ("688127", "蓝特光学", "光学元件"),
    ("688143", "长盈通", "保偏光纤"),
    # G 光纤光缆补充
    ("300265", "通光线缆", "特种光缆"),
    ("000586", "汇源通信", "光缆/设备"),
    ("000070", "特发信息", "光纤光缆"),
    # H 光通信设备/终端补充
    ("603803", "瑞斯康达", "光通信接入"),
    ("300504", "天邑股份", "光通信终端"),
    ("300757", "罗博特科", "光模块封装设备"),
    # E 关联延伸（AI 网络 / 交换 / PCB）
    ("688702", "盛科通信", "交换芯片"),
    ("600183", "生益科技", "覆铜板"),
    ("002463", "沪电股份", "PCB"),
    ("300476", "胜宏科技", "PCB"),
]

CORE_TAGS = {"光模块", "光模块/器件", "光模块/子系统", "光模块/磁性件", "光模块(索尔思)", "光器件/封装",
             "光器件/连接", "光器件", "光器件/调制器", "光通信器件", "光通信", "光通信设备",
             "光通信/连接", "光芯片", "光芯片/PLC", "激光芯片", "光学元件", "光子器件", "红外光学",
             "光纤光缆", "光纤光缆/海缆", "光纤光缆2", "线缆",
             "高速铜缆", "高速线缆", "连接器/结构件", "连接器精密件", "连接器"}


def sym(code: str) -> str:
    if code.startswith(("60", "68", "90")):
        return "sh" + code
    if code.startswith(("4", "8")):
        return "bj" + code
    return "sz" + code


TM_BLOCKED = {"v": False}  # 腾讯 K线整体被风控（501 挑战页）后不再逐只重试


def fetch_kline(code, n=360):
    if TM_BLOCKED["v"]:
        return code, None
    s = sym(code)
    for i in range(2):
        try:
            u = (f"https://web.ifzq.gtimg.cn/appstock/app/fqkline/get"
                 f"?param={s},day,,,{n},qfq")
            r = S.get(u, headers=HDR, timeout=10)
            if r.status_code != 200 or r.text.lstrip().startswith("<"):
                TM_BLOCKED["v"] = True
                break
            js = r.json()
            node = js["data"][s]
            k = node.get("qfqday") or node.get("day")
            if k and len(k) > 20:
                return code, k
        except Exception:
            pass
        time.sleep(1.2 * (i + 1))
    return code, None


SINA_HDR = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
            "Referer": "https://finance.sina.com.cn/"}


def fetch_kline_sina(code, n=400):
    """回退通道：新浪日K（不复权，接口含盘中最新价可能滞后，最终价以实时快照覆盖）"""
    s = sym(code)
    u = ("https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData"
         f"?symbol={s}&scale=240&ma=no&datalen={n}")
    for i in range(3):
        try:
            r = S.get(u, headers=SINA_HDR, timeout=15)
            js = json.loads(r.text)
            if isinstance(js, list) and len(js) > 20:
                k = [[x["day"], x["open"], x["close"], x["high"], x["low"],
                      x.get("volume", "")] for x in js]
                return code, k
        except Exception:
            pass
        time.sleep(1.0 + i)
    return code, None


def fetch_kline_ak(code):
    """二通道：akshare（新浪后端）前复权日线，用于腾讯限流时保住复权口径"""
    if ak is None:
        return code, None
    s = sym(code)
    for i in range(2):
        try:
            df = ak.stock_zh_a_daily(symbol=s, adjust="qfq")
            if df is None or len(df) < 30:
                return code, None
            k = []
            for _, r in df.iterrows():
                dv = r["date"]
                ds = dv.strftime("%Y-%m-%d") if hasattr(dv, "strftime") else str(dv)[:10]
                k.append([ds, float(r["open"]), float(r["close"]),
                          float(r["high"]), float(r["low"]), float(r["volume"])])
            return code, k[-400:]
        except Exception:
            time.sleep(1.0 + i)
    return code, None


def fetch_one(code):
    """优先腾讯前复权 → akshare 前复权 → 新浪不复权"""
    c, k = fetch_kline(code)
    if k:
        return code, k, True
    c, k = fetch_kline_ak(code)
    if k:
        return code, k, True
    c, k = fetch_kline_sina(code)
    return code, k, False


def fetch_quote(codes):
    """批量实时快照（每 60 只一批）"""
    out = {}
    for i in range(0, len(codes), 50):
        batch = codes[i:i + 50]
        q = ",".join(sym(c) for c in batch)
        for attempt in range(4):
            try:
                r = S.get(f"https://qt.gtimg.cn/q={q}", headers=HDR, timeout=12)
                txt = r.content.decode("gbk", "ignore")
                for line in txt.split(";"):
                    line = line.strip()
                    if not line.startswith("v_"):
                        continue
                    body = line.split('="', 1)
                    if len(body) != 2:
                        continue
                    f = body[1].rstrip('"').split("~")
                    if len(f) < 50:
                        continue
                    out[f[2]] = f
                break
            except Exception:
                time.sleep(0.5 + attempt)
    return out


def pct(a, b):
    if not b:
        return None
    return (a / b - 1.0) * 100.0


def main():
    codes = [c for c, _, _ in POOL]
    name_map = {c: n for c, n, _ in POOL}
    tag_map = {c: t for c, _, t in POOL}

    quotes = fetch_quote(codes)
    print("quotes", len(quotes))

    # 第一轮：腾讯（多线程；被封则整体快速跳过）
    with ThreadPoolExecutor(max_workers=6) as ex:
        first = list(ex.map(lambda c: (c, fetch_kline(c)[1]), codes))

    # 第二轮：akshare 前复权 —— py_mini_racer 非线程安全，必须串行
    results = []
    for code, k in first:
        is_qfq = bool(k)
        if not k:
            _, k2 = fetch_kline_ak(code)
            if k2:
                k, is_qfq = k2, True
        if not k:
            _, k3 = fetch_kline_sina(code)
            if k3:
                k, is_qfq = k3, False
        results.append((code, k, is_qfq))
        if not is_qfq and k:
            time.sleep(0.2)

    ok = sum(1 for _, k, _ in results if k)
    qfq_ok = sum(1 for _, k, f in results if k and f)
    print("kline ok", ok, "/", len(codes), "| qfq", qfq_ok, "| sina_fallback", ok - qfq_ok)
    if ok < len(codes) * 0.9:
        raise SystemExit(f"K线成功率过低({ok}/{len(codes)})，保留原有数据不覆盖，请稍后重试")

    rows = []
    for code, k, is_qfq in results:
        if not k:
            rows.append({"code": code, "name": name_map[code], "tag": tag_map[code], "err": "no_kline"})
            continue
        dates = [x[0] for x in k]
        close = [float(x[2]) for x in k]
        high = [float(x[3]) for x in k]
        low = [float(x[4]) for x in k]
        last_k = close[-1]
        last_date = dates[-1]
        # K 线是否已含「今日」bar：决定 N 日前基准的索引偏移
        #   含今日  -> close[-1]=今日，N 日前 = close[-1-N]
        #   不含今日 -> close[-1]=上一交易日，N 日前 = close[-N]
        has_today = (last_date == datetime.date.today().strftime("%Y-%m-%d"))
        off = 0 if has_today else 1

        q = quotes.get(code)
        # 实时快照优先（腾讯官方字段）：[3]现价 [4]昨收 [32]涨跌幅 [38]换手 [45]总市值
        live_px = live_chg = None
        if q:
            try:
                v = float(q[3])
                live_px = v if v > 0 else None
            except Exception:
                pass
            try:
                live_chg = float(q[32])
            except Exception:
                pass

        diverged = (live_px is not None and last_k > 0 and abs(live_px / last_k - 1) > 0.005)
        last = live_px if live_px is not None else last_k

        def back(n):
            idx = -(n + 1 - off)
            return close[idx] if len(close) >= n + 1 - off else None

        # 年初至今基准：2025 年最后一个交易日收盘
        base_ytd = None
        for d, c in zip(dates, close):
            if d < "2026-01-01":
                base_ytd = c
        # 近 250 日最高（前复权·盘中最高价口径，与工作台/东财软件一致，更具标识意义）
        win = high[-250:] if len(high) >= 250 else high
        hi250 = max(win)
        dd = (last / hi250 - 1) * 100
        # 60 日新低：今价 vs 前 59 个交易日最低价（排除当日 bar，盘中/收盘通用）
        hist_low = low[:-1] if has_today else low
        base_low = min(hist_low[-59:]) if len(hist_low) >= 59 else None
        newlow = bool(base_low and last < base_low)

        mcap = turnover = None
        if q:
            try:
                mcap = float(q[45])  # 亿元
            except Exception:
                mcap = None
            try:
                turnover = float(q[38])
            except Exception:
                turnover = None

        rows.append({
            "code": code,
            "name": name_map[code],
            "tag": tag_map[code],
            "last_date": last_date,
            "last": last,
            "last_kline": last_k,
            "qfq": is_qfq,
            "diverged": diverged,
            "d1": live_chg if live_chg is not None else (pct(last, close[-2]) if len(close) >= 2 else None),
            "d5": pct(last, back(5)),
            "d20": pct(last, back(20)),
            "d60": pct(last, back(60)),
            "ytd": pct(last, base_ytd) if base_ytd else None,
            "dd250": dd,
            "hi250": hi250,
            "newlow60": newlow,
            "mcap": mcap,
            "turnover": turnover,
        })

    # ---------- 数据日期与盘中判定 ----------
    # 关键：收盘后 K 线源可能尚未生成当日 bar（kline_date 落后一天），
    # 此刻实时快照的行情时间戳（q[30]）才代表真实数据日 —— 取两者较新者。
    now = datetime.datetime.now()
    today = now.strftime("%Y-%m-%d")
    dates_seen = sorted({r["last_date"] for r in rows if r.get("last_date")})
    kline_date = dates_seen[-1] if dates_seen else today
    hhmm = now.hour * 100 + now.minute
    in_session = (now.weekday() < 5) and ((930 <= hhmm <= 1130) or (1300 <= hhmm <= 1500))
    live_ratio = sum(1 for r in rows if r.get("diverged")) / max(len(rows), 1)
    day_votes = {}
    for qf in quotes.values():
        ts = qf[30] if len(qf) > 30 else ""
        if len(ts) >= 8:
            day = ts[:4] + "-" + ts[4:6] + "-" + ts[6:8]
            day_votes[day] = day_votes.get(day, 0) + 1
    live_day = max(day_votes, key=day_votes.get) if day_votes else None
    intraday = bool(in_session and live_day == today)
    data_date = max(x for x in [kline_date, live_day] if x) if (kline_date or live_day) else today

    meta = {
        "snapshot": now.strftime("%Y-%m-%d %H:%M:%S"),
        "data_date": data_date,
        "live_day": live_day,
        "kline_date": kline_date,
        "today": today,
        "intraday": intraday,
        "weekday": now.weekday(),
        "n": len(rows),
        "n_diverged": sum(1 for r in rows if r.get("diverged")),
        "n_qfq": sum(1 for r in rows if r.get("qfq")),
        "n_sina_fallback": sum(1 for r in rows if r.get("qfq") is False),
        "stale": sorted({r["last_date"] for r in rows if r.get("last_date") and r["last_date"] < data_date}),
        "source": "腾讯财经 实时快照 + 前复权日线（限流时回退新浪不复权日线）",
    }

    # ---------- 新浪交叉验证（抽 6 只比价） ----------
    probe = ["300308", "300502", "300570", "688048", "002281", "601869"]
    xc = []
    try:
        qs = ",".join(sym(c) for c in probe)
        r = S.get(f"https://hq.sinajs.cn/list={qs}",
                  headers={"Referer": "https://finance.sina.com.cn", "User-Agent": HDR["User-Agent"]},
                  timeout=12)
        for line in r.content.decode("gbk", "ignore").split(";"):
            if "hq_str_" not in line:
                continue
            body = line.split('="', 1)
            if len(body) != 2:
                continue
            f = body[1].rstrip('"\n ').split(",")
            if len(f) < 4:
                continue
            c = body[0].split("hq_str_")[-1][2:]
            px = float(f[3]) if f[3] else 0
            rec = next((x for x in rows if x["code"] == c), None)
            if rec and px > 0:
                xc.append({"code": c, "name": rec["name"], "sina": px, "tencent": rec["last"],
                           "diff_pct": round((rec["last"] / px - 1) * 100, 4)})
    except Exception as e:
        meta["crosscheck_error"] = str(e)
    meta["crosscheck"] = xc

    # ---------- 交易日历对齐序列（供 HTML 页面内嵌，支持页面端实时重算区间涨跌） ----------
    date_set = set()
    for code, k, _q in results:
        if k:
            date_set.update(x[0] for x in k)
    cal = sorted(date_set)[-420:]          # 最近 420 个交易日（覆盖跨年 YTD 基准）
    N = len(cal)
    for r, (_code, k, _q) in zip(rows, results):
        if not k:
            continue
        mp = {}
        for x in k:
            try:
                mp[x[0]] = (float(x[2]), float(x[3]), float(x[4]))
            except Exception:
                pass
        cs = [None] * N
        hs = [None] * N
        ls = [None] * N
        lc = lh = ll = None
        for i, dd in enumerate(cal):
            if dd in mp:
                lc, lh, ll = mp[dd]
            cs[i] = lc
            hs[i] = lh
            ls[i] = ll
        r["cs"] = cs
        r["hs"] = hs
        r["ls"] = ls
    meta["cal"] = cal
    meta["cal_last"] = cal[-1] if cal else None

    with io.open(os.path.join(BASE, "光通信跌幅榜_数据.json"), "w", encoding="utf-8") as f:
        json.dump({"meta": meta, "rows": rows}, f, ensure_ascii=False, indent=1)

    print("rows", len(rows), "| data_date", data_date, "| intraday", intraday,
          "| diverged", meta["n_diverged"], "| qfq", meta["n_qfq"], "| sina_fb", meta["n_sina_fallback"])
    print("crosscheck", [(x["code"], x["diff_pct"]) for x in xc])


if __name__ == "__main__":
    main()
