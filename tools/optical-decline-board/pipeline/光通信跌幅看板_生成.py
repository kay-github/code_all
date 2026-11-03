# -*- coding: utf-8 -*-
"""把光通信跌幅榜 CSV 渲染成单文件暗色看板 HTML（数据内嵌，file:// 可直开）

自动选取 D:/work_code2/ 下最新的 光通信板块跌幅榜_*.csv，按其中的「数据日期/时点/状态」
生成标题与口径说明，输出同名 .html。
"""
import csv, io, json, glob, os, statistics as st

BASE = os.environ.get("OPTICAL_BASE") or "D:/work_code2/"
TPL = os.path.join(BASE, "光通信跌幅看板_模板.html")

TAGMAP = {"光模块": "光模块整机", "光模块/器件": "光模块整机", "光模块/子系统": "光模块整机",
          "光模块/磁性件": "光模块整机", "光模块(索尔思)": "光模块整机",
          "光器件": "光器件/封装", "光器件/封装": "光器件/封装", "光器件/连接": "光器件/封装",
          "光器件/调制器": "光器件/封装", "陶瓷封装": "光器件/封装",
          "光芯片": "光芯片/激光器", "光芯片/PLC": "光芯片/激光器", "激光芯片": "光芯片/激光器",
          "光芯片材料": "光芯片/激光器",
          "光学元件": "光学元件", "光学晶体": "光学元件", "红外光学": "光学元件", "光子器件": "光学元件",
          "光纤光缆": "光纤光缆", "光纤光缆/海缆": "光纤光缆", "特种光缆": "光纤光缆",
          "光缆/设备": "光纤光缆", "线缆": "光纤光缆", "保偏光纤": "光纤光缆",
          "连接器": "连接器/线缆", "连接器/结构件": "连接器/线缆", "连接器精密件": "连接器/线缆",
          "高速铜缆": "连接器/线缆", "高速线缆": "连接器/线缆", "屏蔽/散热件": "连接器/线缆",
          "陶瓷插芯": "连接器/线缆",
          "光通信设备": "设备/接入", "光通信": "设备/接入", "光通信器件": "设备/接入",
          "光通信/连接": "设备/接入", "光通信接入": "设备/接入", "光通信终端": "设备/接入",
          "光模块封装设备": "设备/接入"}
EXT = {"PCB", "覆铜板", "交换芯片"}
GORDER = ["光模块整机", "光器件/封装", "光芯片/激光器", "光学元件",
          "光纤光缆", "连接器/线缆", "设备/接入"]


def num(v):
    v = (v or "").strip()
    if v == "":
        return None
    try:
        return float(v)
    except ValueError:
        return None


def pick_latest():
    files = glob.glob(os.path.join(BASE, "光通信板块跌幅榜_*.csv"))
    if not files:
        raise SystemExit("找不到 CSV")
    return max(files, key=os.path.getmtime)


def main():
    src = pick_latest()
    rows = []
    meta = {}
    with io.open(src, encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            if not meta:
                meta = {"date": r["数据日期"], "snapshot": r["数据时点"], "mode": r["状态"]}
            grp = "关联延伸" if r["细分环节"] in EXT else TAGMAP.get(r["细分环节"], "其他")
            rows.append({
                "c": r["代码"], "n": r["名称"], "t": r["细分环节"], "g": grp,
                "p": num(r["现价/收盘"]),
                "d1": num(r["当日%"]), "d5": num(r["近5日%"]), "d20": num(r["近20日%"]),
                "d60": num(r["近60日%"]), "ytd": num(r["年初至今%"]), "dd": num(r["距250日盘中高点%"]),
                "hi": num(r["250日盘中高点"]), "nl": 1 if r["创60日新低"] == "是" else 0,
                "to": num(r["换手率%"]), "mcap": num(r["总市值(亿)"]),
            })

    core = [r for r in rows if r["g"] != "关联延伸"]
    kpi = {
        "n": len(rows), "ncore": len(core),
        "d1_med": round(st.median([r["d1"] for r in core if r["d1"] is not None]), 2),
        "d1_down": sum(1 for r in core if (r["d1"] or 0) < 0),
        "d1_5": sum(1 for r in core if (r["d1"] or 0) <= -5),
        "d20_med": round(st.median([r["d20"] for r in core if r["d20"] is not None]), 2),
        "d20_30": sum(1 for r in core if (r["d20"] or 0) <= -30),
        "dd_med": round(st.median([r["dd"] for r in core if r["dd"] is not None]), 2),
        "dd_50": sum(1 for r in core if (r["dd"] or 0) <= -50),
        "ytd_med": round(st.median([r["ytd"] for r in core if r["ytd"] is not None]), 2),
        "ytd_up": sum(1 for r in core if (r["ytd"] or 0) > 0),
        "nl": sum(1 for r in core if r["nl"]),
    }

    groups = {}
    for r in core:
        groups.setdefault(r["g"], []).append(r)
    gsum = []
    for g in GORDER:
        rs = groups.get(g, [])
        if not rs:
            continue
        def med(k):
            v = [x[k] for x in rs if x[k] is not None]
            return round(st.median(v), 2) if v else None
        gsum.append({"g": g, "n": len(rs), "d1": med("d1"), "d20": med("d20"),
                     "d60": med("d60"), "ytd": med("ytd"),
                     "dd": round(st.mean([x["dd"] for x in rs if x["dd"] is not None]), 2)})

    intraday = meta["mode"].startswith("盘中")

    # 内嵌交易日历 + 收盘/最低价序列（页面端用 JSONP 实时价重算区间涨跌）
    cal, seq = [], {}
    try:
        jdoc = json.load(io.open(os.path.join(BASE, "光通信跌幅榜_数据.json"), encoding="utf-8"))
        cal = jdoc.get("meta", {}).get("cal") or []
        for jr in jdoc.get("rows", []):
            if jr.get("cs"):
                seq[jr["code"]] = (jr["cs"], jr["ls"], jr.get("hs"))
    except Exception as e:
        print("seq load skip:", e)
    for r in rows:
        s = seq.get(r["c"])
        if s:
            r["cs"], r["ls"] = s[0], s[1]
            if s[2]:
                r["hs"] = s[2]

    payload = {
        "meta": {"data_date": meta["date"], "snapshot": meta["snapshot"], "intraday": intraday,
                 "cal_last": cal[-1] if cal else None},
        "cal": cal,
        "rows": rows, "kpi": kpi, "gs": gsum, "gorder": GORDER + ["关联延伸"],
    }

    hhmm = meta["snapshot"][11:16]
    title = f"A股光通信产业链 · 跌幅榜单（{meta['date']} {meta['mode']}）"
    stamp = (f"数据日 {meta['date']} {meta['mode']} {hhmm}" if intraday
             else f"数据日 {meta['date']} 收盘")
    if intraday:
        caliber = (f"「当前」为 {meta['date']} {hhmm} 盘中实时价对前一交易日收盘；"
                   f"盘中数据随成交变动，非最终收盘值")
    else:
        caliber = f"「当日」为 {meta['date']} 对前一交易日收盘"
    # 交叉验证偏差（读抓数阶段留下的 meta）
    maxdiff, nprobe = None, 0
    try:
        jm = json.load(io.open(os.path.join(BASE, "光通信跌幅榜_数据.json"), encoding="utf-8")).get("meta", {})
        if jm.get("data_date") == meta["date"]:
            xc = jm.get("crosscheck") or []
            if xc:
                maxdiff = max(abs(x["diff_pct"]) for x in xc)
                nprobe = len(xc)
    except Exception:
        pass
    if maxdiff is None:
        xcheck = f"现价与当日涨跌取自行情源实时快照字段；生成时点 {meta['snapshot']}"
    else:
        xcheck = (f"现价与当日涨跌取自行情源实时快照字段；另用新浪行情对 {nprobe} 只抽样比价，"
                  f"最大偏差 {maxdiff:.2f}%（盘中两源快照时点差）；生成时点 {meta['snapshot']}")

    html = io.open(TPL, encoding="utf-8").read()
    html = (html.replace("/*__DATA__*/", json.dumps(payload, ensure_ascii=False))
                .replace("__TITLE__", title)
                .replace("__STAMP__", stamp)
                .replace("__CALIBER__", caliber)
                .replace("__XCHECK__", xcheck)
                .replace("__N__", str(len(rows)))
                .replace("__NC__", str(len(core)))
                .replace("__NX__", str(len(rows) - len(core))))

    out = os.path.join(BASE, f"光通信板块跌幅榜_{meta['date'].replace('-', '')}.html")
    io.open(out, "w", encoding="utf-8").write(html)
    latest = os.path.join(BASE, "光通信板块跌幅榜_最新.html")
    io.open(latest, "w", encoding="utf-8").write(html)
    print("html ->", os.path.basename(out), "+ 最新.html |", len(rows), "rows |", meta["date"], meta["mode"], hhmm)


if __name__ == "__main__":
    main()
