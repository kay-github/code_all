# -*- coding: utf-8 -*-
"""A股 科技股 / 光通信产业链 —— 多周期涨跌幅 + 回撤测算（腾讯行情/K线，支持盘中实时）

池来源：板块池.json（由 光通信跌幅扫描_板块池.py 生成）；缺失时回退内置 POOL
输出：光通信跌幅榜_数据.json （meta + rows，rows 含 board: optical/tech 与 tier: core/ext）
"""
import json, os, time, io, datetime
from concurrent.futures import ThreadPoolExecutor

import requests

BASE = os.environ.get("OPTICAL_BASE") or "D:/work_code2/"
SKIP_TECH = os.environ.get("OPTICAL_TECH", "1") == "0"

try:
    import akshare as ak
except Exception:
    ak = None

HDR = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Referer": "https://gu.qq.com/"}
S = requests.Session()
S.trust_env = False

# 兜底池（板块池.json 缺失时使用）：(代码, 名称, 细分环节)
POOL = [
    ("300308", "中际旭创", "光模块"), ("300502", "新易盛", "光模块"),
    ("002281", "光迅科技", "光模块/器件"), ("000988", "华工科技", "光模块"),
    ("603083", "剑桥科技", "光模块"), ("300394", "天孚通信", "光器件/封装"),
    ("300570", "太辰光", "光器件/连接"), ("300548", "长芯博创", "光器件"),
    ("301205", "联特科技", "光模块"), ("688205", "德科立", "光模块/子系统"),
    ("002902", "铭普光磁", "光模块/磁性件"), ("603042", "华脉科技", "光通信器件"),
    ("600498", "烽火通信", "光通信设备"), ("688498", "源杰科技", "光芯片"),
    ("688313", "仕佳光子", "光芯片/PLC"), ("688048", "长光华芯", "激光芯片"),
    ("300620", "光库科技", "光器件/调制器"), ("688195", "腾景科技", "光器件/光学元件"),
    ("601869", "长飞光纤", "光纤光缆"), ("600487", "亨通光电", "光纤光缆/海缆"),
    ("600522", "中天科技", "光纤光缆/海缆"), ("600105", "永鼎股份", "光纤光缆"),
    ("002491", "通鼎互联", "光纤光缆"), ("002130", "沃尔核材", "高速铜缆"),
    ("300913", "兆龙互连", "高速线缆"), ("002897", "意华股份", "连接器/结构件"),
    ("688668", "鼎通科技", "连接器精密件"), ("002179", "中航光电", "连接器"),
]

CAL_LEN = 300        # 内嵌交易日序列长度（覆盖 250 日回撤 + YTD 基准）
POOL_VER = {"v": "2026-11-21"}   # 实际取值来自 板块池.json 的 version


def sym(code: str) -> str:
    if code.startswith(("60", "68", "90")):
        return "sh" + code
    if code.startswith(("4", "8", "92")):
        return "bj" + code
    return "sz" + code


def load_pool():
    """返回 (光学核心, 光学延伸, 科技股全部, 消费核心, 消费延伸, 存储核心, 存储延伸)
    消费元素为 (code, name, 二级行业, 一级行业)
    存储元素为 (code, name, 细分标签, 汇总分组)
    """
    p = os.path.join(BASE, "板块池.json")
    try:
        d = json.load(io.open(p, encoding="utf-8"))
        POOL_VER["v"] = str(d.get("version") or POOL_VER["v"])
        core = [(x["code"], x["name"], x["tag"]) for x in d["optical"]["core"]]
        ext = [(x["code"], x["name"], x["tag"]) for x in d["optical"]["ext"]]
        tech = [(x["code"], x["name"], x["ind"]) for x in d["tech"]]
        cons = d.get("cons") or {}
        cc = [(x["code"], x["name"], x.get("ind2") or x["l1"], x["l1"]) for x in cons.get("core", [])]
        ce = [(x["code"], x["name"], x.get("ind2") or x["l1"], x["l1"]) for x in cons.get("ext", [])]
        st = d.get("storage") or {}
        stc = [(x["code"], x["name"], x["tag"], x.get("g") or "其他") for x in st.get("core", [])]
        ste = [(x["code"], x["name"], x["tag"], x.get("g") or "其他") for x in st.get("ext", [])]
        if core and len(tech) > len(core):
            return core, ext, tech, cc, ce, stc, ste
    except Exception as e:
        print("pool fallback:", e)
    return POOL, [], [], [], [], [], []


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
        time.sleep(1.0 * (i + 1))
    return code, None


SINA_HDR = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
            "Referer": "https://finance.sina.com.cn/"}


def fetch_kline_sina(code, n=400):
    s = sym(code)
    u = ("https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData"
         f"?symbol={s}&scale=240&ma=no&datalen={n}")
    for i in range(2):
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


def fetch_quote(codes):
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
        time.sleep(0.15)
    return out


def pct(a, b):
    if not b:
        return None
    return (a / b - 1.0) * 100.0


def add_rating(rows):
    """光通信核心池技术面评级（0-100 → A/B/C/D/E）
    四个分量，权重固定、口径公开，可随数据日复算：
      抗跌 rank 35%：近20日跌幅在核心池内的分位（跌得少 = 高分位）
      回撤 rank 25%：距250日高点回撤在核心池内的分位（撤得少 = 高分位）
      相对强度 20%：近20日相对「科技股整体中位」的超额，0.5 + 超额/20，截断到 [0,1]
      趋势位置 20%：YTD>0 记 0.4；未创60日新低记 0.3；近5日>0 记 0.3
    """
    import bisect
    core = [r for r in rows
            if r["board"] == "optical" and r["tier"] == "core"
            and r.get("d20") is not None and r.get("dd250") is not None]
    if not core:
        return
    d20s = sorted(r["d20"] for r in core)
    dds = sorted(r["dd250"] for r in core)
    tech = [r["d20"] for r in rows if r["board"] == "tech" and r.get("d20") is not None]
    tmed = None
    if tech:
        tech.sort()
        n = len(tech)
        tmed = tech[n // 2] if n % 2 else (tech[n // 2 - 1] + tech[n // 2]) / 2

    def rank(arr, v):
        return bisect.bisect_right(arr, v) / len(arr)

    for r in core:
        a = rank(d20s, r["d20"])
        b = rank(dds, r["dd250"])
        c = 0.5 if tmed is None else max(0.0, min(1.0, 0.5 + (r["d20"] - tmed) / 20.0))
        t = (0.4 if (r.get("ytd") or 0) > 0 else 0.0) + (0.0 if r.get("newlow60") else 0.3) \
            + (0.3 if (r.get("d5") or 0) > 0 else 0.0)
        sc = 100 * (0.35 * a + 0.25 * b + 0.20 * c + 0.20 * t)
        r["score"] = round(sc, 1)
        r["grade"] = "A" if sc >= 75 else "B" if sc >= 60 else "C" if sc >= 45 else "D" if sc >= 30 else "E"
        r["comp"] = {"d20": round(a, 2), "dd": round(b, 2), "rel": round(c, 2), "trend": round(t, 2)}


def main():
    core, ext, tech, cons_core, cons_ext, storage_core, storage_ext = load_pool()
    optical = [(c, n, t, "core") for c, n, t in core] + [(c, n, t, "ext") for c, n, t in ext]
    storage = [(c, n, t, "core", g) for c, n, t, g in storage_core] + \
              [(c, n, t, "ext", g) for c, n, t, g in storage_ext]
    opt_codes = [x[0] for x in optical]
    st_codes = [x[0] for x in storage]
    tech_map = {c: (n, i) for c, n, i in tech}

    if SKIP_TECH:
        extra = []
    else:
        extra = [(c, n, i) for c, n, i in tech if c not in set(opt_codes)]

    CONS = os.environ.get("OPTICAL_CONS", "1") != "0"
    cons = []
    if CONS:
        cons = [(c, n, t, "core", l1) for c, n, t, l1 in cons_core] + \
               [(c, n, t, "ext", l1) for c, n, t, l1 in cons_ext]
    cons_codes = [x[0] for x in cons]

    seen = set()
    all_codes = []
    for c in opt_codes + [x[0] for x in extra] + st_codes + cons_codes:
        if c not in seen:
            seen.add(c)
            all_codes.append(c)

    quotes = fetch_quote(all_codes)
    print("quotes", len(quotes), "/", len(all_codes))

    # 行情快照里的交易日（决定 K 线是否已含当日 bar）：不能拿「自然日」判断，
    # 否则周末/节假日/跨零点运行会把 off 错置为 1，使近 N 日基准整体前移一天。
    day_votes = {}
    for qf in quotes.values():
        ts = qf[30] if len(qf) > 30 else ""
        if len(ts) >= 8:
            day = ts[:4] + "-" + ts[4:6] + "-" + ts[6:8]
            day_votes[day] = day_votes.get(day, 0) + 1
    live_day = max(day_votes, key=day_votes.get) if day_votes else None

    t0 = time.time()
    with ThreadPoolExecutor(max_workers=6) as ex:
        first = list(ex.map(lambda c: (c, fetch_kline(c)[1]), all_codes))
    print("kline 一轮耗时 %.1fs" % (time.time() - t0), "| 腾讯封禁", TM_BLOCKED["v"])

    results = []
    n_ak = 0
    t_fb = time.time()
    for code, k in first:
        is_qfq = bool(k)
        if not k:
            # akshare 前复权是串行通道（py_mini_racer 非线程安全），耗时不可控；
            # 超过预算后不再调用，统一交给新浪并行回退
            if time.time() - t_fb < 300:
                _, k2 = fetch_kline_ak(code)
                if k2:
                    k, is_qfq = k2, True
                    n_ak += 1
        results.append((code, k, is_qfq))

    # 新浪（不复权）回退：纯 requests，可并行；池子扩大后必须并行，否则云端会超时
    miss = [c for c, k, _ in results if not k]
    n_sina = 0
    if miss:
        t_s = time.time()
        with ThreadPoolExecutor(max_workers=8) as ex:
            fb = dict(ex.map(lambda c: fetch_kline_sina(c), miss))
        results = [(c, k if k else fb.get(c), f if k else False) for c, k, f in results]
        n_sina = sum(1 for c in miss if fb.get(c))
        print("sina 回退 缺%d 补回%d %.0fs" % (len(miss), n_sina, time.time() - t_s))

    kmap = {c: (k, f) for c, k, f in results}
    ok_opt = sum(1 for c in opt_codes if kmap.get(c, (None, 0))[0])
    ok_st = sum(1 for c in st_codes if kmap.get(c, (None, 0))[0])
    ok_cons = sum(1 for c in cons_codes if kmap.get(c, (None, 0))[0])
    print("kline ok", sum(1 for _, k, _ in results if k), "/", len(all_codes),
          "| 光通信", ok_opt, "/", len(opt_codes), "| 存储", ok_st, "/", len(st_codes),
          "| 消费", ok_cons, "/", len(cons_codes),
          "| akshare", n_ak)
    if ok_opt < len(opt_codes) * 0.9:
        raise SystemExit(f"光通信K线成功率过低({ok_opt}/{len(opt_codes)})，保留原有数据不覆盖，请稍后重试")
    if st_codes and ok_st < len(st_codes) * 0.85:
        raise SystemExit(f"存储K线成功率过低({ok_st}/{len(st_codes)})，保留原有数据不覆盖，请稍后重试")
    if cons_codes and ok_cons < len(cons_codes) * 0.7:
        print(f"WARN 消费K线成功率偏低({ok_cons}/{len(cons_codes)})，榜单将出现缺项")

    rows = []

    def build(code, name, tag, board, tier, grp=None):
        k, is_qfq = kmap.get(code, (None, True))
        rec = {"code": code, "name": name, "tag": tag, "board": board, "tier": tier}
        if grp:
            rec["grp"] = grp
        if not k:
            rec["err"] = "no_kline"
            rows.append(rec)
            return
        dates = [x[0] for x in k]
        close = [float(x[2]) for x in k]
        high = [float(x[3]) for x in k]
        low = [float(x[4]) for x in k]
        last_k = close[-1]
        last_date = dates[-1]
        # 实时快照已进入新交易日而 K 线还没有当日 bar → 基准指数整体前移一位
        has_today = bool(live_day and live_day > last_date)
        off = 1 if has_today else 0

        q = quotes.get(code)
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

        base_ytd = None
        for d, c in zip(dates, close):
            if d < "2026-01-01":
                base_ytd = c
        win = high[-250:] if len(high) >= 250 else high
        hi250 = max(win)
        dd = (last / hi250 - 1) * 100
        hist_low = low if has_today else low[:-1]   # has_today=True 表示最后一根 K 线是上一交易日
        base_low = min(hist_low[-59:]) if len(hist_low) >= 59 else None
        newlow = bool(base_low and last < base_low)

        mcap = turnover = None
        if q:
            try:
                mcap = float(q[45])
            except Exception:
                mcap = None
            try:
                turnover = float(q[38])
            except Exception:
                turnover = None

        rec.update({
            "last_date": last_date, "last": last, "last_kline": last_k,
            "qfq": is_qfq, "diverged": diverged,
            "d1": live_chg if live_chg is not None else (pct(last, close[-2]) if len(close) >= 2 else None),
            "d5": pct(last, back(5)), "d20": pct(last, back(20)), "d60": pct(last, back(60)),
            "ytd": pct(last, base_ytd) if base_ytd else None,
            "dd250": dd, "hi250": hi250, "newlow60": newlow, "lo60": base_low,
            "mcap": mcap, "turnover": turnover,
        })
        rows.append(rec)

    for code, name, tag, tier in optical:
        build(code, name, tag, "optical", tier)
    for code, name, tag, tier, grp in storage:
        build(code, name, tag, "storage", tier, grp=grp)
    for code, name, ind in extra:
        build(code, name, ind, "tech", "tech")
    for code, name, ind2, tier, l1 in cons:
        build(code, name, ind2, "cons", tier, grp=l1)

    # ---------- 数据日期与盘中判定 ----------
    now = datetime.datetime.now()
    today = now.strftime("%Y-%m-%d")
    dates_seen = sorted({r["last_date"] for r in rows if r.get("last_date")})
    kline_date = dates_seen[-1] if dates_seen else today
    hhmm = now.hour * 100 + now.minute
    # 09:30–15:00 之间（含 11:30–13:00 午间休市）当日行情都未定稿，不能算「收盘」；
    # 只有 15:00 之后数据才是当日收盘终值
    in_session = (now.weekday() < 5) and (930 <= hhmm < 1500)
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
        "data_date": data_date, "live_day": live_day, "kline_date": kline_date,
        "today": today, "intraday": intraday, "weekday": now.weekday(),
        "n": len(rows),
        "n_optical": sum(1 for r in rows if r["board"] == "optical"),
        "n_storage": sum(1 for r in rows if r["board"] == "storage"),
        "n_storage_core": sum(1 for r in rows if r["board"] == "storage" and r["tier"] == "core"),
        "n_tech": sum(1 for r in rows if r["board"] == "tech"),
        "n_cons": sum(1 for r in rows if r["board"] == "cons"),
        "n_cons_core": sum(1 for r in rows if r["board"] == "cons" and r["tier"] == "core"),
        "n_diverged": sum(1 for r in rows if r.get("diverged")),
        "n_qfq": sum(1 for r in rows if r.get("qfq")),
        "n_sina_fallback": sum(1 for r in rows if r.get("qfq") is False),
        "stale": sorted({r["last_date"] for r in rows if r.get("last_date") and r["last_date"] < data_date}),
        "source": "腾讯财经 实时快照 + 前复权日线（限流时回退 akshare / 新浪不复权日线）",
        "pool_version": POOL_VER["v"],
    }

    # ---------- 新浪交叉验证 ----------
    probe = [c for c in ["300308", "300502", "300570", "688048", "002281", "601869",
                         "301183", "920045", "688498", "002130"] if c in kmap]
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
            if rec and px > 0 and rec.get("last"):
                xc.append({"code": c, "name": rec["name"], "sina": px, "tencent": rec["last"],
                           "diff_pct": round((rec["last"] / px - 1) * 100, 4)})
    except Exception as e:
        meta["crosscheck_error"] = str(e)
    meta["crosscheck"] = xc

    # ---------- 交易日历序列（供页面端实时重算） ----------
    date_set = set()
    for code, k, _q in results:
        if k:
            date_set.update(x[0] for x in k)
    cal = sorted(date_set)[-CAL_LEN:]
    N = len(cal)
    for r in rows:
        k = kmap.get(r["code"], (None, 0))[0]
        if not k:
            continue
        mp = {}
        for x in k:
            try:
                mp[x[0]] = (round(float(x[2]), 2), round(float(x[3]), 2), round(float(x[4]), 2))
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
        # 消费池只保留收盘序列（页面用 hi250 / lo60 标量替代最高/最低序列），
        # 单只从约 5.4KB 降到 1.8KB，594 只可省约 2MB
        if r["board"] != "cons":
            r["hs"] = hs
            r["ls"] = ls
    meta["cal"] = cal
    meta["cal_last"] = cal[-1] if cal else None

    add_rating(rows)

    with io.open(os.path.join(BASE, "光通信跌幅榜_数据.json"), "w", encoding="utf-8") as f:
        json.dump({"meta": meta, "rows": rows}, f, ensure_ascii=False, separators=(",", ":"))

    print("rows", len(rows), "| 光通信", meta["n_optical"], "存储", meta["n_storage"],
          "(核心", meta["n_storage_core"], ") 科技股", meta["n_tech"],
          "消费", meta["n_cons"], "(核心", meta["n_cons_core"], ")",
          "| data_date", data_date, "| intraday", intraday,
          "| diverged", meta["n_diverged"], "| qfq", meta["n_qfq"], "| sina_fb", meta["n_sina_fallback"])
    print("crosscheck", [(x["code"], x["diff_pct"]) for x in xc])


if __name__ == "__main__":
    main()
