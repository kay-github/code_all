# -*- coding: utf-8 -*-
"""把 光通信跌幅榜_数据.json 渲染成单文件暗色看板 HTML（数据内嵌，file:// 可直开）
页面含两个 Table：所有科技股跌幅榜 / 光通信跌幅榜，顶部切换
"""
import io, json, os, statistics as st

BASE = os.environ.get("OPTICAL_BASE") or "D:/work_code2/"
TPL = os.path.join(BASE, "光通信跌幅看板_模板.html")
SRC = os.path.join(BASE, "光通信跌幅榜_数据.json")

TAGMAP = {"光模块": "光模块整机", "光模块/器件": "光模块整机", "光模块/子系统": "光模块整机",
          "光模块/磁性件": "光模块整机", "光模块/网通设备": "光模块整机",
          "光器件": "光器件/封装", "光器件/封装": "光器件/封装", "光器件/连接": "光器件/封装",
          "光器件/调制器": "光器件/封装", "光通信器件": "光器件/封装", "陶瓷封装": "光器件/封装",
          "光芯片": "光芯片/激光器", "光芯片/PLC": "光芯片/激光器", "激光芯片": "光芯片/激光器",
          "光芯片/收发电芯片": "光芯片/激光器", "特种光纤": "光纤光缆",
          "光器件/光学元件": "光学元件", "光学元件/硅光配套": "光学元件",
          "光纤光缆": "光纤光缆", "光纤光缆/海缆": "光纤光缆", "特种光缆": "光纤光缆",
          "光缆/设备": "光纤光缆", "保偏光纤": "光纤光缆",
          "连接器": "连接器/线缆", "连接器/结构件": "连接器/线缆", "连接器精密件": "连接器/线缆",
          "高速铜缆": "连接器/线缆", "高速线缆": "连接器/线缆", "陶瓷插芯": "连接器/线缆",
          "光缆/高速互联": "连接器/线缆",
          "光通信设备": "设备/接入", "光通信接入": "设备/接入", "光通信终端": "设备/接入",
          "光接入终端": "设备/接入", "光传输设备": "设备/接入", "光模块封装设备": "设备/接入",
          "光通信测试": "设备/接入",
          "光纤涂覆材料": "上游材料"}
GORDER = ["光模块整机", "光器件/封装", "光芯片/激光器", "光学元件", "光纤光缆",
          "连接器/线缆", "设备/接入", "上游材料", "关联延伸"]

# 科技股展示行业（板块池已输出展示口径，这里只做兜底归一）
INDMAP = {"半导体": "半导体", "半导体/元件": "半导体/元件", "元件/连接器": "元件/连接器",
          "电子器件": "半导体/元件", "光学光电子": "光学光电子", "消费电子": "消费电子",
          "电子材料": "电子材料", "电子化学品": "电子材料",
          "通信设备": "通信/计算机", "通信服务": "通信/计算机", "电子信息": "通信/计算机",
          "计算机设备": "通信/计算机", "通信/计算机": "通信/计算机",
          "软件开发": "软件/IT", "IT服务": "软件/IT", "软件/IT": "软件/IT"}
TGORDER = ["光通信", "半导体", "元件/连接器", "光学光电子", "消费电子", "通信/计算机",
           "软件/IT", "电子材料", "其他"]

# 消费 Tab 分组顺序（申万一级口径）
CONS_GORDER = ["食品饮料", "家用电器", "纺织服饰", "轻工制造", "商贸零售",
               "社会服务", "美容护理", "农林牧渔", "汽车", "医药生物"]


def num(v):
    return None if v is None else v


def main():
    doc = json.load(io.open(SRC, encoding="utf-8"))
    meta, rows = doc["meta"], doc["rows"]
    cal = meta.get("cal") or []

    seq = {}
    for r in rows:
        if r.get("cs"):
            if r.get("ls"):
                seq[r["code"]] = [r["cs"], r["ls"], r.get("hs") or r["cs"]]
            else:
                seq[r["code"]] = [r["cs"]]      # 消费池只存收盘序列，最高/最低用标量

    def mk(r, tagcol, group, ext):
        o = {"c": r["code"], "n": r["name"], "t": tagcol, "g": group,
             "p": num(r.get("last")),
             "d1": num(r.get("d1")), "d5": num(r.get("d5")), "d20": num(r.get("d20")),
             "d60": num(r.get("d60")), "ytd": num(r.get("ytd")), "dd": num(r.get("dd250")),
             "to": num(r.get("turnover")), "mcap": num(r.get("mcap")),
             "hi": num(r.get("hi250")), "lo": num(r.get("lo60")),
             "nl": 1 if r.get("newlow60") else 0, "x": 1 if ext else 0}
        if r.get("grade"):
            o["gr"] = r["grade"]
            o["sc"] = num(r.get("score"))
        return o

    opt_core, opt_ext = [], []
    for r in rows:
        if r["board"] != "optical" or not r.get("last"):
            continue
        if r["tier"] == "core":
            opt_core.append(mk(r, r["tag"], TAGMAP.get(r["tag"], "设备/接入"), False))
        else:
            opt_ext.append(mk(r, r["tag"], "关联延伸", True))

    tech_rows, opt_codes = [], {r["code"] for r in rows if r["board"] == "optical"}
    opt_core_codes = {r["code"] for r in rows if r["board"] == "optical" and r["tier"] == "core"}
    for r in rows:
        if r["board"] != "tech" or not r.get("last"):
            continue
        # 光通信核心成员在科技股 Table 里单列「光通信」行业，避免与半导体/通信混淆
        g = "光通信" if r["code"] in opt_core_codes else INDMAP.get(r["tag"], "其他")
        t = mk(r, g, g, False)
        t["o"] = 1 if r["code"] in opt_codes else 0     # 标记光通信成分
        tech_rows.append(t)

    # 科技股口径 = 科技股池自身 + 光通信全部（避免池截断导致漏项）
    have = {y["c"] for y in tech_rows}
    # 光通信延伸成员（未进科技股池）按环节归到对应科技行业，避免落到「其他」
    OPTAG2IND = {"PCB": "元件/连接器", "覆铜板": "元件/连接器", "交换芯片": "半导体",
                 "交换机": "通信/计算机", "通信服务/算力": "通信/计算机",
                 "工业光通信设备": "通信/计算机", "光通讯组件": "元件/连接器",
                 "服务器ODM": "通信/计算机", "以太网PHY芯片": "半导体",
                 "高速通讯连接器": "元件/连接器", "微型连接器": "元件/连接器",
                 "连接器(新能源)": "元件/连接器", "射频连接器": "通信/计算机",
                 "射频同轴电缆": "元件/连接器", "天线/射频": "通信/计算机",
                 "天线/连接器": "通信/计算机", "光学元件(消费)": "光学光电子",
                 "红外光学": "光学光电子", "激光光学": "光学光电子", "激光晶体": "光学光电子",
                 "光纤激光器": "光学光电子", "屏蔽/散热件": "元件/连接器",
                 "精密制造/铜缆": "元件/连接器", "电力电缆": "元件/连接器",
                 "电子材料": "电子材料", "移动信息服务": "软件/IT",
                 "光通信测试": "通信/计算机", "光纤级石英": "电子材料",
                 "光通信光纤器件": "元件/连接器",
                 "应急通信(参股长飞)": "通信/计算机", "化纤(参股索尔思)": "其他"}
    tech_all = tech_rows + [dict(x, t="光通信", g="光通信", o=1) for x in opt_core if x["c"] not in have] \
                          + [dict(x, t=OPTAG2IND.get(x["t"], "其他"), g=OPTAG2IND.get(x["t"], "其他"), o=1)
                             for x in opt_ext if x["c"] not in have]

    # 光模块评级：光通信核心池，按综合分降序
    rating_rows = [dict(x, g=x["gr"]) for x in opt_core if x.get("gr")]
    rating_rows.sort(key=lambda x: -(x.get("sc") or 0))

    # 消费：核心 = 8 个必需/可选消费一级行业；关联延伸（汽车/医药）压暗、不参与中位数
    cons_core, cons_ext = [], []
    for r in rows:
        if r["board"] != "cons" or not r.get("last"):
            continue
        l1 = r.get("grp") or "其他"
        item = mk(r, r["tag"], l1, r["tier"] == "ext")
        (cons_ext if r["tier"] == "ext" else cons_core).append(item)
    cons_order = {g: i for i, g in enumerate(CONS_GORDER)}
    cons_core.sort(key=lambda x: cons_order.get(x["g"], 99))
    cons_ext.sort(key=lambda x: cons_order.get(x["g"], 99))

    payload = {
        "meta": {"data_date": meta["data_date"], "snapshot": meta["snapshot"],
                 "intraday": bool(meta.get("intraday")), "cal_last": meta.get("cal_last"),
                 "pool_version": meta.get("pool_version"),
                 "n_opt": len(opt_core) + len(opt_ext), "n_tech": len(tech_all),
                 "n_cons": len(cons_core) + len(cons_ext), "n_cons_core": len(cons_core),
                 "n_rating": len(rating_rows)},
        "cal": cal,
        "seq": seq,
        "boards": {
            "tech": {"rows": tech_all, "gorder": TGORDER,
                     "label": "所有科技股跌幅榜", "ncore": len(tech_all), "next": 0},
            "optical": {"rows": opt_core + opt_ext, "gorder": GORDER,
                        "label": "光通信跌幅榜",
                        "ncore": len(opt_core), "next": len(opt_ext)},
            "cons": {"rows": cons_core + cons_ext, "gorder": CONS_GORDER,
                     "label": "消费跌幅榜",
                     "ncore": len(cons_core), "next": len(cons_ext)},
            "rating": {"rows": rating_rows, "gorder": ["A", "B", "C", "D", "E"],
                       "label": "光模块评级", "kind": "rating",
                       "ncore": len(rating_rows), "next": 0},
        },
    }

    hhmm = meta["snapshot"][11:16]
    intraday = bool(meta.get("intraday"))
    title = f"A股 科技 · 光通信 · 消费 · 跌幅榜单（{meta['data_date']} {MODE(meta)}）"
    stamp = (f"数据日 {meta['data_date']} {'盘中' if intraday else '收盘'} {hhmm}" if intraday
             else f"数据日 {meta['data_date']} 收盘")
    if intraday:
        caliber = (f"「当前」为 {meta['data_date']} {hhmm} 盘中实时价对前一交易日收盘；"
                   f"盘中数据随成交变动，非最终收盘值")
    else:
        caliber = f"「当日」为 {meta['data_date']} 对前一交易日收盘"

    maxdiff, nprobe = None, 0
    xc = meta.get("crosscheck") or []
    if xc:
        maxdiff = max(abs(x["diff_pct"]) for x in xc)
        nprobe = len(xc)
    xcheck = (f"现价与当日涨跌取自行情源实时快照字段；另用新浪行情对 {nprobe} 只抽样比价，"
              f"最大偏差 {maxdiff:.2f}%；生成时点 {meta['snapshot']}"
              if maxdiff is not None else
              f"现价与当日涨跌取自行情源实时快照字段；生成时点 {meta['snapshot']}")

    # 前复权覆盖率：腾讯日线被限流时会回退新浪（不复权），需在页面上如实披露
    nsf = meta.get("n_sina_fallback") or 0
    ntot = meta.get("n") or 1
    if nsf > ntot * 0.02:
        qnote = (f"本次共 <b>{nsf}</b> 只（{nsf / ntot * 100:.0f}%）因腾讯前复权日线限流回退<b>新浪不复权日线</b>，"
                 f"这些标的的区间涨跌幅与「距250日高点」在除权日附近可能偏大；"
                 f"下一个交易日 15:01 的自动任务会用前复权数据重算覆盖。")
    else:
        qnote = f"全部标的均为前复权日线（{meta.get('n_qfq')} 只），回撤与区间涨跌幅口径可比。"

    html = io.open(TPL, encoding="utf-8").read()
    html = (html.replace("/*__DATA__*/", json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
                .replace("__TITLE__", title)
                .replace("__STAMP__", stamp)
                .replace("__CALIBER__", caliber)
                .replace("__XCHECK__", xcheck)
                .replace("__QFQNOTE__", qnote)
                .replace("__N__", str(len(tech_all)))
                .replace("__NC__", str(len(opt_core) + len(opt_ext)))
                .replace("__NOPT__", str(len(opt_core)))
                .replace("__NX__", str(len(opt_ext)))
                .replace("__NCONS__", str(len(cons_core) + len(cons_ext)))
                .replace("__NCONSC__", str(len(cons_core)))
                .replace("__NCONSX__", str(len(cons_ext))))

    out = os.path.join(BASE, f"光通信板块跌幅榜_{meta['data_date'].replace('-', '')}.html")
    io.open(out, "w", encoding="utf-8").write(html)
    latest = os.path.join(BASE, "光通信板块跌幅榜_最新.html")
    io.open(latest, "w", encoding="utf-8").write(html)
    print("html ->", os.path.basename(out), "+ 最新.html |",
          len(payload["boards"]["tech"]["rows"]), "tech /",
          len(payload["boards"]["optical"]["rows"]), "optical /",
          len(payload["boards"]["cons"]["rows"]), "cons |",
          meta["data_date"], "| %.2f MB" % (os.path.getsize(out) / 1048576))


def MODE(meta):
    return "盘中实时" if meta.get("intraday") else "收盘"


if __name__ == "__main__":
    main()
