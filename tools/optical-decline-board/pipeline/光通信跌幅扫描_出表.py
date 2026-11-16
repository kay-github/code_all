# -*- coding: utf-8 -*-
"""读 光通信跌幅榜_数据.json → 输出 Markdown 报告 + CSV（光通信 / 科技股 两份）
文件名按数据日期与盘中状态自动生成
"""
import io, json, csv, statistics as st, os

BASE = os.environ.get("OPTICAL_BASE") or "D:/work_code2/"
SRC = os.path.join(BASE, "光通信跌幅榜_数据.json")
doc = json.load(io.open(SRC, encoding="utf-8"))
rows, meta = doc["rows"], doc["meta"]

DATA_DATE = meta["data_date"]
STAMP = DATA_DATE.replace("-", "")
MODE = "盘中实时" if meta["intraday"] else "收盘"
HHMM = meta["snapshot"][11:16]

CSV_PATH = os.path.join(BASE, f"光通信板块跌幅榜_{STAMP}.csv")
TECH_CSV = os.path.join(BASE, f"科技股跌幅榜_{STAMP}.csv")
CONS_CSV = os.path.join(BASE, f"消费股跌幅榜_{STAMP}.csv")
MD_PATH = os.path.join(BASE, f"光通信板块跌幅榜_{STAMP}.md")

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

opt = [r for r in rows if r["board"] == "optical"]
tech = [r for r in rows if r["board"] == "tech"]
core = [r for r in opt if r["tier"] == "core"]
ext = [r for r in opt if r["tier"] != "core"]
cons = [r for r in rows if r["board"] == "cons"]
cons_core = [r for r in cons if r["tier"] == "core"]
cons_ext = [r for r in cons if r["tier"] != "core"]
CONS_GORDER = ["食品饮料", "家用电器", "纺织服饰", "轻工制造", "商贸零售",
               "社会服务", "美容护理", "农林牧渔", "汽车", "医药生物"]

COL = {"d1": "当日", "d5": "近5日", "d20": "近20日", "d60": "近60日", "ytd": "YTD", "dd250": "距高点"}
PRICE_HDR = "现价" if meta["intraday"] else "收盘"


def f(v, d=2):
    return "—" if v is None else f"{v:+.{d}f}%"


def table(rs, cols, title, top=None, colname="环节"):
    lines = [f"\n### {title}\n"]
    head = f"| 代码 | 名称 | {colname} | {PRICE_HDR} | " + " | ".join(COL[c] for c in cols) + " | 总市值(亿) |"
    sep = "|:--|:--|:--|--:|" + "--:|" * len(cols) + "--:|"
    lines += [head, sep]
    src = rs if top is None else rs[:top]
    for r in src:
        cells = [r["code"], r["name"], r["tag"], f'{r["last"]:.2f}']
        cells += [f(r.get(c)) for c in cols]
        cells.append(f'{r["mcap"]:.0f}' if r.get("mcap") else "—")
        lines.append("| " + " | ".join(cells) + " |")
    return "\n".join(lines)


out = []
out.append(f"数据日：**{DATA_DATE}**（{MODE} {HHMM}）｜光通信核心 **{len(core)}** 只 + 关联延伸 {len(ext)} 只"
           f"｜科技股口径 **{len(tech) + len(opt)}** 只｜消费核心 **{len(cons_core)}** 只 + 关联延伸 {len(cons_ext)} 只")

s1 = sorted([r for r in core if r.get("d1") is not None], key=lambda x: x["d1"])
out.append(table(s1, ["d1", "d5", "d20", "ytd"], "一、当日跌幅榜 TOP15", 15))

s2 = sorted([r for r in core if r.get("d20") is not None], key=lambda x: x["d20"])
out.append(table(s2, ["d20", "d60", "ytd", "dd250"], "二、近 20 交易日跌幅榜 TOP15（本轮调整）", 15))

s3 = sorted([r for r in core if r.get("dd250") is not None], key=lambda x: x["dd250"])
out.append(table(s3, ["dd250", "d20", "ytd"], "三、距近 250 日高点回撤 TOP10", 10))

s4 = sorted([r for r in core if r.get("d20") is not None], key=lambda x: -x["d20"])
out.append(table(s4, ["d20", "d60", "ytd"], "四、近 20 日最抗跌 TOP8", 8))

groups = {}
for r in opt:
    g = TAGMAP.get(r["tag"], "关联延伸") if r["tier"] == "core" else "关联延伸"
    groups.setdefault(g, []).append(r)
out.append("\n### 五、细分环节汇总（等权中位数）\n")
out.append("| 环节 | 只数 | 当日 | 近20日 | 近60日 | YTD | 平均回撤 |")
out.append("|:--|--:|--:|--:|--:|--:|--:|")
for g in GORDER:
    rs = groups.get(g, [])
    if not rs:
        continue
    def med(k):
        v = [x[k] for x in rs if x.get(k) is not None]
        return f"{st.median(v):+.2f}%" if v else "—"
    ddv = [x["dd250"] for x in rs if x.get("dd250") is not None]
    out.append(f"| {g} | {len(rs)} | {med('d1')} | {med('d20')} | {med('d60')} | {med('ytd')} | "
               f"{(st.mean(ddv) if ddv else 0):+.2f}% |")

v1 = [r["d1"] for r in core if r.get("d1") is not None]
v20 = [r["d20"] for r in core if r.get("d20") is not None]
v60 = [r["d60"] for r in core if r.get("d60") is not None]
ytd = [r["ytd"] for r in core if r.get("ytd") is not None]
dd = [r["dd250"] for r in core if r.get("dd250") is not None]
out.append(f"\n### 六、板块画像（核心 {len(core)} 只）\n")
out.append(f"- **当日**：中位 {st.median(v1):+.2f}%，下跌 {sum(1 for x in v1 if x<0)}/{len(v1)}，跌超 5% 者 {sum(1 for x in v1 if x<=-5)} 只")
out.append(f"- **近20日**：中位 {st.median(v20):+.2f}%，下跌 {sum(1 for x in v20 if x<0)}/{len(v20)}，跌超 30% 者 {sum(1 for x in v20 if x<=-30)} 只")
out.append(f"- **近60日**：中位 {st.median(v60):+.2f}%，下跌 {sum(1 for x in v60 if x<0)}/{len(v60)}")
out.append(f"- **YTD**：中位 {st.median(ytd):+.2f}%，仍为正收益 {sum(1 for x in ytd if x>0)}/{len(ytd)} 只")
out.append(f"- **距250日高点**：中位回撤 {st.median(dd):+.2f}%，回撤超 50% 者 {sum(1 for x in dd if x<=-50)} 只")
out.append(f"- **创60日新低**：{sum(1 for r in core if r.get('newlow60'))} 只")

out.append(table(sorted(ext, key=lambda x: (x.get("d1") is None, x.get("d1") or 0)),
                 ["d1", "d5", "d20", "ytd"], "七、关联延伸（PCB / 覆铜板 / 交换芯片 / 参股与弱关联）"))

# 科技股概览
tk = [r for r in tech + opt if r.get("d1") is not None]
t20 = [r for r in tech + opt if r.get("d20") is not None]
out.append(f"\n### 八、科技股整体（{len(tk)} 只有效）\n")
out.append(f"- 当日跌幅前 10：" + "、".join(
    f'{r["name"]} {r["d1"]:+.1f}%' for r in sorted(tk, key=lambda x: x["d1"])[:10]))
out.append(f"- 当日中位 {st.median([r['d1'] for r in tk]):+.2f}%，下跌 {sum(1 for r in tk if r['d1']<0)}/{len(tk)}")
out.append(f"- 近20日中位 {st.median([r['d20'] for r in t20]):+.2f}%，近20日跌幅前 10：" + "、".join(
    f'{r["name"]} {r["d20"]:+.1f}%' for r in sorted(t20, key=lambda x: x["d20"])[:10]))

GRADE_DESC = {"A": "抗跌（跌幅与回撤均居池内前列）", "B": "偏强（跌幅低于中位、趋势未破）",
              "C": "中性（跌幅与回撤居中）", "D": "偏弱（跌幅与回撤均高于中位）",
              "E": "破位（跌幅与回撤居池内尾部）"}

rated = sorted([r for r in core if r.get("grade")], key=lambda x: -x["score"])
out.append(f"\n### 九、光模块 / 光通信评级（技术面强弱，非投资建议）\n")
out.append("| 代码 | 名称 | 环节 | 评级 | 综合分 | 近5日 | 近20日 | 距高点 | YTD | 总市值(亿) |")
out.append("|:--|:--|:--|:--:|--:|--:|--:|--:|--:|--:|")
for r in rated:
    out.append(f'| {r["code"]} | {r["name"]} | {r["tag"]} | **{r["grade"]}** | {r["score"]:.1f} | '
               f'{f(r.get("d5"))} | {f(r.get("d20"))} | {f(r.get("dd250"))} | {f(r.get("ytd"))} | '
               f'{r["mcap"]:.0f} |' if r.get("mcap") else
               f'| {r["code"]} | {r["name"]} | {r["tag"]} | **{r["grade"]}** | {r["score"]:.1f} | '
               f'{f(r.get("d5"))} | {f(r.get("d20"))} | {f(r.get("dd250"))} | {f(r.get("ytd"))} | — |')
cnt = {g: sum(1 for r in rated if r["grade"] == g) for g in "ABCDE"}
out.append(f"\n评级分布：A {cnt['A']} / B {cnt['B']} / C {cnt['C']} / D {cnt['D']} / E {cnt['E']}"
           f"（共 {len(rated)} 只）　中位综合分 {st.median([r['score'] for r in rated]):.1f}")
out.append("\n打分口径：抗跌分位 35% + 回撤分位 25% + 相对科技股中位强度 20% + 趋势位置 20%；"
           "A≥75、B≥60、C≥45、D≥30、E<30。评级衡量的是「本轮下跌中的相对强弱」，不代表未来收益。")

out.append(f"\n> 时点：{meta['snapshot']}　口径：腾讯前复权日线 + 实时快照；"
           f"新浪交叉验证 {len(meta.get('crosscheck') or [])} 只，最大偏差 "
           f"{max([abs(x['diff_pct']) for x in (meta.get('crosscheck') or [{'diff_pct':0}])]):.3f}%")

# ---------------- 消费 ----------------
if cons:
    out.append(f"\n### 十、消费行业（核心 {len(cons_core)} 只 + 关联延伸 {len(cons_ext)} 只）\n")
    cg = {}
    for r in cons:
        cg.setdefault(r.get("grp") or "其他", []).append(r)
    out.append("| 行业（申万一级） | 只数 | 当日 | 近20日 | 近60日 | YTD | 平均回撤 |")
    out.append("|:--|--:|--:|--:|--:|--:|--:|")
    for g in CONS_GORDER:
        rs = cg.get(g, [])
        if not rs:
            continue

        def cmed(k, rs=rs):
            v = [x[k] for x in rs if x.get(k) is not None]
            return f"{st.median(v):+.2f}%" if v else "—"
        cdd = [x["dd250"] for x in rs if x.get("dd250") is not None]
        out.append(f"| {g} | {len(rs)} | {cmed('d1')} | {cmed('d20')} | {cmed('d60')} | "
                   f"{cmed('ytd')} | {(st.mean(cdd) if cdd else 0):+.2f}% |")
    cc20 = [r for r in cons_core if r.get("d20") is not None]
    out.append(f"\n- 核心当日中位 {st.median([r['d1'] for r in cons_core if r.get('d1') is not None]):+.2f}%"
               f"，下跌 {sum(1 for r in cons_core if (r.get('d1') or 0) < 0)}/{len(cons_core)}")
    out.append(f"- 核心近20日中位 {st.median([r['d20'] for r in cc20]):+.2f}%，跌幅前 10：" +
               "、".join(f'{r["name"]} {r["d20"]:+.1f}%' for r in sorted(cc20, key=lambda x: x["d20"])[:10]))
    out.append(table(sorted([r for r in cons_core if r.get("d20") is not None], key=lambda x: x["d20"]),
                     ["d20", "d60", "ytd", "dd250"], "消费核心 · 近20日跌幅 TOP15", 15, colname="行业"))

io.open(MD_PATH, "w", encoding="utf-8").write("\n".join(out))

HDRS = ["数据日期", "数据时点", "状态", "代码", "名称", "细分环节", "现价/收盘", "当日%",
        "近5日%", "近20日%", "近60日%", "年初至今%", "距250日盘中高点%", "250日盘中高点",
        "创60日新低", "换手率%", "总市值(亿)", "评级", "综合分"]


def dump_csv(path, rs, with_tier=False):
    with io.open(path, "w", encoding="utf-8-sig", newline="") as fp:
        w = csv.writer(fp)
        w.writerow(HDRS + (["分层"] if with_tier else []))
        for r in sorted(rs, key=lambda x: (x.get("d1") is None, x.get("d1") or 0)):
            if not r.get("last"):
                continue
            row = [DATA_DATE, meta["snapshot"], MODE, r["code"], r["name"], r["tag"], f'{r["last"]:.2f}']
            row += ["" if r.get(k) is None else f'{r[k]:.2f}'
                    for k in ("d1", "d5", "d20", "d60", "ytd", "dd250")]
            row += [f'{r["hi250"]:.2f}' if r.get("hi250") else "",
                    "是" if r.get("newlow60") else "",
                    "" if r.get("turnover") is None else f'{r["turnover"]:.2f}',
                    f'{r["mcap"]:.1f}' if r.get("mcap") else "",
                    r.get("grade") or "", "" if r.get("score") is None else f'{r["score"]:.1f}']
            if with_tier:
                row.append("核心" if r["tier"] == "core" else "关联延伸")
            w.writerow(row)


dump_csv(CSV_PATH, opt, with_tier=True)
dump_csv(TECH_CSV, tech + opt)
if cons:
    dump_csv(CONS_CSV, cons, with_tier=True)

print("csv ->", os.path.basename(CSV_PATH), len(opt), "|", os.path.basename(TECH_CSV), len(tech + opt),
      "|", os.path.basename(CONS_CSV), len(cons))
print("md  ->", os.path.basename(MD_PATH))
