#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
周期镜像 · 5·19(1999) vs 9·24(2024) 走势叠加日更

纯标准库，可在 GitHub Actions 直接跑。
数据：腾讯 800 日 K 线窗口（增量） + data/*.csv 深历史底稿（bootstrap 生成）

产出：
  data/sh000001.csv   上证综指全历史（追加）
  data/cn985.csv      中证全指（追加）
  data/baseline.json  定标参数（首次生成后冻结，保证主图参数不随日漂移）
  data/mirror.json    页面数据

用法：
  python update.py                # 增量 + 重算
  python update.py --no-fetch     # 只用本地 CSV 重算（离线/调试）
  python update.py --reset-baseline  # 重算并覆盖冻结的定标参数（谨慎）
"""
import json, math, os, sys, time, urllib.request, urllib.error, datetime

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, "data")
SH_CSV = os.path.join(DATA, "sh000001.csv")
CN_CSV = os.path.join(DATA, "cn985.csv")
BASE_JSON = os.path.join(DATA, "baseline.json")
OUT_JSON = os.path.join(DATA, "mirror.json")

TEMPLATE_START = "1999-05-19"
CURRENT_START = "2024-09-24"
PAD_PRE, PAD_POST = 200, 1000
BASE_N = 250          # 定标窗口：前 250 个交易日
ROLL_WIN = 60         # 滚动相关窗口
SCAN_STEP = 10        # 历史扫描起点步长（交易日）
SCAN_KMAX = 1.8

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Referer": "https://gu.qq.com/"}


# ---------------------------------------------------------------- 网络 / 文件
def http_get(url, timeout=25, retries=3):
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read().decode("utf-8", "ignore")
        except Exception as e:      # noqa: BLE001
            last = e
            time.sleep(2 + i * 3)
    raise last


def fetch_tencent(sym, n=800):
    """腾讯日 K：[date, open, close, high, low, volume]"""
    u = f"https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param={sym},day,,,{n},"
    js = json.loads(http_get(u))
    node = js["data"][sym]
    arr = node.get("qfqday") or node.get("day") or []
    out = []
    for row in arr:
        try:
            out.append((row[0][:10], float(row[2])))
        except (IndexError, ValueError, TypeError):
            continue
    return sorted(out)


def read_csv(path):
    rows = []
    if not os.path.exists(path):
        return rows
    with open(path, encoding="utf-8") as f:
        for i, line in enumerate(f):
            line = line.strip()
            if not line or (i == 0 and line.lower().startswith("date")):
                continue
            p = line.split(",")
            if len(p) < 2:
                continue
            try:
                rows.append((p[0], float(p[1])))
            except ValueError:
                continue
    return rows


def write_csv(path, rows):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write("date,close\n")
        for d, c in rows:
            f.write(f"{d},{c:.4f}\n")
    os.replace(tmp, path)


def merge(old, new):
    m = {d: c for d, c in old}
    m.update({d: c for d, c in new})
    return sorted(m.items())


# ---------------------------------------------------------------- 数学
def logret(closes, base):
    return [100.0 * math.log(c / base) for c in closes]


def interp_arr(r, x):
    """r 为按交易日索引的序列，x 为浮点索引"""
    n = len(r)
    if x <= 0:
        return r[0]
    if x >= n - 1:
        return r[-1]
    i = int(x)
    f = x - i
    return r[i] * (1 - f) + r[i + 1] * f


def fit(r_tpl, r_cur, kmin=0.5, kmax=SCAN_KMAX, nk=261, nfit=None):
    """最小二乘拟合 时间拉伸 k、幅度 a：最小化 Σ(a*r_tpl(k*t) - r_cur(t))^2"""
    n = len(r_cur) if nfit is None else nfit
    best = None
    for j in range(nk):
        k = kmin + (kmax - kmin) * j / (nk - 1)
        if (n - 1) * k > len(r_tpl) - 1:
            continue
        sxy = sxx = 0.0
        yy = [0.0] * n
        for t in range(n):
            v = interp_arr(r_tpl, t * k)
            yy[t] = v
            sxy += v * r_cur[t]
            sxx += v * v
        if sxx <= 0:
            continue
        a = sxy / sxx
        sse = 0.0
        for t in range(n):
            d = a * yy[t] - r_cur[t]
            sse += d * d
        if best is None or sse < best[0]:
            best = (sse, k, a, yy)
    if best is None:
        raise RuntimeError("fit failed")
    sse, k, a, yy = best
    mean = sum(r_cur[:n]) / n
    sst = sum((v - mean) ** 2 for v in r_cur[:n])
    r2 = 1 - sse / sst if sst > 0 else 0.0
    return dict(k=k, a=a, sse=sse, r2=r2, yy=yy)


def predict(r_tpl, n, k, a):
    return [a * interp_arr(r_tpl, t * k) for t in range(n)]


def corr(x, y):
    n = len(x)
    mx = sum(x) / n; my = sum(y) / n
    sxx = sum((v - mx) ** 2 for v in x); syy = sum((v - my) ** 2 for v in y)
    sxy = sum((x[i] - mx) * (y[i] - my) for i in range(n))
    if sxx <= 0 or syy <= 0:
        return 0.0
    return sxy / math.sqrt(sxx * syy)


def rmse(v):
    return math.sqrt(sum(x * x for x in v) / len(v)) if v else 0.0


# ---------------------------------------------------------------- 主流程
def beijing_now():
    return datetime.datetime.utcnow() + datetime.timedelta(hours=8)


def load_series(no_fetch=False):
    sh = read_csv(SH_CSV)
    cn = read_csv(CN_CSV)
    if not no_fetch:
        try:
            new_sh = fetch_tencent("sh000001")
            sh = merge(sh, new_sh)
            print(f"[fetch] sh000001 +{len(new_sh)} → {len(sh)} 行，末日 {sh[-1][0]} {sh[-1][1]:.2f}")
        except Exception as e:                      # noqa: BLE001
            print(f"[warn] sh000001 抓取失败，沿用本地：{e}")
        try:
            new_cn = fetch_tencent("sh000985")
            cn = merge(cn, new_cn)
            print(f"[fetch] sh000985 +{len(new_cn)} → {len(cn)} 行，末日 {cn[-1][0]} {cn[-1][1]:.2f}")
        except Exception as e:                      # noqa: BLE001
            print(f"[warn] sh000985 抓取失败，沿用本地：{e}")
    if not sh:
        raise SystemExit("缺少上证历史底稿：先跑 bootstrap.py")
    # 盘中保护：北京时间 15:00 前，丢掉当日未收盘的 bar
    now = beijing_now()
    today = now.strftime("%Y-%m-%d")
    if now.hour * 60 + now.minute < 15 * 60:
        if sh and sh[-1][0] == today:
            print("[guard] 未收盘，剔除当日 bar（上证）")
            sh = sh[:-1]
        if cn and cn[-1][0] == today:
            print("[guard] 未收盘，剔除当日 bar（中证全指）")
            cn = cn[:-1]
    write_csv(SH_CSV, sh)
    write_csv(CN_CSV, cn)
    return sh, cn


def build(no_fetch=False, reset_baseline=False):
    sh, cn = load_series(no_fetch=no_fetch)
    dates_sh = [d for d, _ in sh]; close_sh = [c for _, c in sh]
    dates_cn = [d for d, _ in cn]; close_cn = [c for _, c in cn]

    if TEMPLATE_START not in dates_sh:
        raise SystemExit(f"上证历史里没有 {TEMPLATE_START}")
    ia = dates_sh.index(TEMPLATE_START)
    lo = max(0, ia - PAD_PRE)
    hi = min(len(sh), ia + PAD_POST + 1)
    tpl_dates = dates_sh[lo:hi]
    tpl_r = logret(close_sh[lo:hi], close_sh[ia])
    t0 = ia - lo
    tpl_fit = tpl_r[t0:]          # 拟合只用 T 起往后的部分（索引 0 = 1999-05-19）

    if CURRENT_START not in dates_cn:
        raise SystemExit(f"中证全指历史里没有 {CURRENT_START}")

    def cur_block(dates, closes, start):
        i0 = dates.index(start)
        d = dates[i0:]; c = closes[i0:]
        return d, logret(c, c[0]), c

    legs = {}
    d_cn, r_cn, px_cn = cur_block(dates_cn, close_cn, CURRENT_START)
    d_sh, r_sh, px_sh = cur_block(dates_sh, close_sh, CURRENT_START)
    legs["alla"] = dict(label="全A口径", index_name="中证全指 000985.CSI",
                        dates=d_cn, r=r_cn, px=px_cn,
                        note="当前腿用中证全指（2004 起），1999 腿只能用上证；两者在各自时代都是全A的最佳可得代理")
    legs["sh"] = dict(label="上证同源", index_name="上证综指 000001.SH",
                      dates=d_sh, r=r_sh, px=px_sh,
                      note="两段完全同一指数、同一口径，用于检验结论对指数选择是否稳健")

    # ---- 定标参数（冻结）
    base_store = {}

    def stages(r, dates):
        """阶段节点：起点 / 第一波顶 / 回调底 / 主峰 / 至今"""
        n = len(r)
        hi = max(range(5, min(n, 90)), key=lambda i: r[i])
        lo = min(range(hi, min(n, hi + 250)), key=lambda i: r[i])
        pk = max(range(n), key=lambda i: r[i])
        return dict(
            start=dict(t=0, date=dates[0], r=0.0),
            hi=dict(t=hi, date=dates[hi], r=round(r[hi], 2)),
            lo=dict(t=lo, date=dates[lo], r=round(r[lo], 2)),
            pk=dict(t=pk, date=dates[pk], r=round(r[pk], 2)),
            now=dict(t=n - 1, date=dates[-1], r=round(r[-1], 2)),
        )
    if os.path.exists(BASE_JSON) and not reset_baseline:
        try:
            base_store = json.load(open(BASE_JSON, encoding="utf-8"))
        except Exception:                          # noqa: BLE001
            base_store = {}

    modes = {}
    for key, leg in legs.items():
        r = leg["r"]; n = len(r)
        f = fit(tpl_fit, r, nk=261)
        pred_f = predict(tpl_fit, n, f["k"], f["a"])
        resid_f = [pred_f[i] - r[i] for i in range(n)]
        fb = fit(tpl_fit, r, nk=261, nfit=min(BASE_N, n))
        # 定标参数：已冻结就沿用，保证主图坐标不随日漂移
        if key in base_store:
            b = base_store[key]
        else:
            pred_b = predict(tpl_fit, n, fb["k"], fb["a"])
            resid_b = [pred_b[i] - r[i] for i in range(n)]
            oos = resid_b[min(BASE_N, n):]
            b = dict(k=fb["k"], a=fb["a"],
                     sigma=rmse(oos) or rmse(resid_b),
                     sigma_in=rmse(resid_b[:min(BASE_N, n)]),
                     n=min(BASE_N, n),
                     asof=leg["dates"][min(BASE_N, n) - 1])
            base_store[key] = b
            print(f"[baseline] {key}: k={b['k']:.3f} a={b['a']:.3f} sigma={b['sigma']:.2f} asof={b['asof']}")

        pred_b = predict(tpl_fit, n, b["k"], b["a"])
        resid_b = [pred_b[i] - r[i] for i in range(n)]
        z = resid_b[-1] / b["sigma"] if b["sigma"] else 0.0

        # 滚动 60 日收益相关（模板按 k 重采样）
        dr_t = [interp_arr(tpl_fit, (i + 1) * b["k"]) - interp_arr(tpl_fit, i * b["k"]) for i in range(n - 1)]
        dr_c = [r[i + 1] - r[i] for i in range(n - 1)]
        roll = [None] * len(dr_c)
        for i in range(ROLL_WIN, len(dr_c) + 1):
            roll[i - 1] = round(corr(dr_t[i - ROLL_WIN:i], dr_c[i - ROLL_WIN:i]), 3)
        roll_valid = [v for v in roll[-250:] if v is not None]

        # 样本外指标（用定标参数，从第 250 日起）
        oos_r2 = None; oos_corr = None; oos_rmse = None
        if n > BASE_N:
            ro = resid_b[BASE_N:]
            mo = sum(r[BASE_N:]) / len(r[BASE_N:])
            ssto = sum((v - mo) ** 2 for v in r[BASE_N:])
            sseo = sum(v * v for v in ro)
            oos_r2 = 1 - sseo / ssto if ssto else None
            oos_rmse = math.sqrt(sseo / len(ro))
            oos_corr = corr(pred_b[BASE_N:], r[BASE_N:])

        # 主图口径的拟合残差（全区间最优参数）
        modes[key] = dict(
            label=leg["label"], index_name=leg["index_name"], note=leg["note"],
            dates=leg["dates"], r=[round(v, 2) for v in r], px=[round(v, 2) for v in leg["px"]],
            fit=dict(k=round(f["k"], 4), a=round(f["a"], 4), r2=round(f["r2"], 4),
                     corr=round(corr(pred_f, r), 4), rmse=round(rmse(resid_f), 2)),
            base=dict(k=round(b["k"], 4), a=round(b["a"], 4), sigma=round(b["sigma"], 2),
                      sigma_in=round(b["sigma_in"], 2), n=b["n"], asof=b["asof"]),
            oos=dict(r2=None if oos_r2 is None else round(oos_r2, 3),
                     corr=None if oos_corr is None else round(oos_corr, 3),
                     rmse=None if oos_rmse is None else round(oos_rmse, 2), n=max(0, n - BASE_N)),
            pred=[round(v, 2) for v in pred_b],
            resid=[round(v, 2) for v in resid_b],
            gap=dict(value=round(resid_b[-1], 2), z=round(z, 2)),
            roll=roll, roll_last=roll[-1], roll_mean_1y=(round(sum(roll_valid) / len(roll_valid), 3) if roll_valid else None),
            stages=stages(r, leg["dates"]),
        )
        # 峰值
        ipk = max(range(n), key=lambda i: r[i])
        modes[key]["peak"] = dict(t=ipk, date=leg["dates"][ipk], r=round(r[ipk], 2),
                                  mapped=round(ipk * b["k"], 1),
                                  tpl_r_at_mapped=round(interp_arr(tpl_fit, ipk * b["k"]), 2))

    # 模板自身峰值（1999-2003 段）
    ipk_t = max(range(0, min(len(tpl_fit), 700)), key=lambda i: tpl_fit[i])
    tpl_peak = dict(t=ipk_t, date=tpl_dates[t0 + ipk_t], r=round(tpl_fit[ipk_t], 2))
    tpl_stages = stages(tpl_fit, tpl_dates[t0:])
    after = {}
    for h in (250, 500, 750, 1000):
        j = ipk_t + h
        if j < len(tpl_fit):
            after[str(h)] = dict(date=tpl_dates[t0 + j], r=round(tpl_fit[j], 2),
                                 delta=round(tpl_fit[j] - tpl_fit[ipk_t], 2))

    # ---- 历史扫描：谁最像当前这段
    ref = legs["sh"]["r"]
    nN = len(ref)
    need = int(math.ceil((nN - 1) * SCAN_KMAX)) + 2
    cand = list(range(0, len(sh) - need + 1, SCAN_STEP))
    ia_scan = dates_sh.index(TEMPLATE_START)
    if ia_scan not in cand:
        cand.append(ia_scan)
        cand.sort()
    rows = []
    for s in cand:
        T = logret(close_sh[s:], close_sh[s])
        if len(T) < need:
            continue
        try:
            f = fit(T, ref, kmin=0.5, kmax=SCAN_KMAX, nk=71)
        except RuntimeError:
            continue
        if f["a"] <= 0:
            continue
        pred = predict(T, nN, f["k"], f["a"])
        sse = sum((pred[i] - ref[i]) ** 2 for i in range(nN))
        mo = sum(ref) / nN
        sst = sum((v - mo) ** 2 for v in ref)
        rows.append(dict(start=dates_sh[s], k=round(f["k"], 3), a=round(f["a"], 3),
                         r2=round(1 - sse / sst, 4)))
    rows.sort(key=lambda x: -x["r2"])
    rank = next((i + 1 for i, x in enumerate(rows) if x["start"] == TEMPLATE_START), None)
    nrow = len(rows)
    pct = None
    if rank and nrow:
        pct = round(100.0 * (1 - (rank - 1) / nrow), 1)
    r2s = sorted(x["r2"] for x in rows)
    q = lambda p: round(r2s[min(len(r2s) - 1, int(p * len(r2s)))], 3) if r2s else None
    scan = dict(n=nrow, step=SCAN_STEP, rank=rank, pct=pct,
                q50=q(0.50), q75=q(0.75), q90=q(0.90), q95=q(0.95),
                top=rows[:12])
    print(f"[scan] {nrow} 个候选，模板起点排名 {rank}，R² 分位 50/90/95 = {q(0.5)}/{q(0.9)}/{q(0.95)}")


    # ---- 模板前瞻（用全A口径的定标参数）
    bA = modes["alla"]["base"]
    n_now = len(legs["alla"]["r"]) - 1
    pos = n_now * bA["k"]
    fwd = []
    for h in (20, 60, 120, 250):
        p = int(round(pos)) + h
        if p < len(tpl_fit):
            dr = tpl_fit[p] - interp_arr(tpl_fit, pos)
            fwd.append(dict(h=h, tpl_date=tpl_dates[t0 + p], tpl_r=round(tpl_fit[p], 2),
                            delta=round(dr, 2), scaled=round(dr * bA["a"], 2)))
    # 备用：用每日最优 k 对齐，展示"对齐位置对前瞻有多敏感"
    kA = modes["alla"]["fit"]["k"]
    aA = modes["alla"]["fit"]["a"]
    pos2 = n_now * kA
    fwd2 = []
    for h in (20, 60, 120, 250):
        p = int(round(pos2)) + h
        if p < len(tpl_fit):
            dr = tpl_fit[p] - interp_arr(tpl_fit, pos2)
            fwd2.append(dict(h=h, tpl_date=tpl_dates[t0 + p], delta=round(dr, 2),
                             scaled=round(dr * aA, 2)))

    now = beijing_now()
    trade_date = legs["alla"]["dates"][-1]
    stale = trade_date < (now.date() - datetime.timedelta(days=4)).strftime("%Y-%m-%d")
    meta = dict(
        generated_at=now.strftime("%Y-%m-%dT%H:%M:%S+08:00"),
        build=now.strftime("%Y%m%dT%H%M"),
        trade_date=trade_date,
        stale=stale,
        template=dict(name="上证综指 000001.SH", start=TEMPLATE_START, t0=t0,
                      pad_pre=PAD_PRE, pad_post=PAD_POST, peak=tpl_peak, after=after),
        current_start=CURRENT_START,
        source="腾讯 800 日 K 线增量 + 新浪/中证官网全历史底稿；对数收益口径",
        params=dict(base_n=BASE_N, roll_win=ROLL_WIN, scan_step=SCAN_STEP),
    )

    out = dict(meta=meta,
               template=dict(dates=tpl_dates, r=[round(v, 2) for v in tpl_r], t0=t0),
               modes=modes,
               scan=scan,
               forward=fwd,
               forward_alt=fwd2,
               template_stages=tpl_stages,
               current_pos=dict(t=n_now, mapped=round(pos, 1),
                                tpl_r=round(interp_arr(tpl_fit, pos), 2),
                                tpl_date_equiv=None))
    if int(round(pos)) < len(tpl_fit):
        out["current_pos"]["tpl_date_equiv"] = tpl_dates[t0 + int(round(pos))]

    with open(BASE_JSON, "w", encoding="utf-8") as f:
        json.dump(base_store, f, ensure_ascii=False, indent=1)
    with open(OUT_JSON, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print(f"[out] {OUT_JSON}  {os.path.getsize(OUT_JSON)/1024:.1f} KB  trade_date={trade_date}")
    for k, m in modes.items():
        print(f"    {k}: T+{len(m['r'])-1} r={m['r'][-1]:+.2f}% gap={m['gap']['value']:+.2f}pp "
              f"(z={m['gap']['z']:+.2f}) fit k={m['fit']['k']} a={m['fit']['a']} "
              f"R2={m['fit']['r2']} OOS R2={m['oos']['r2']}")
    return out


if __name__ == "__main__":
    args = set(sys.argv[1:])
    build(no_fetch="--no-fetch" in args, reset_baseline="--reset-baseline" in args)


