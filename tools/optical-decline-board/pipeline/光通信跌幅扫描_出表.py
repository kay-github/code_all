# -*- coding: utf-8 -*-
"""读 光通信跌幅榜_数据.json → 输出 Markdown 报告 + CSV（文件名/标题按数据日期与盘中状态自动生成）"""
import io, json, csv, statistics as st, os, glob

SRC = os.path.join(os.environ.get("OPTICAL_BASE") or "D:/work_code2/", "光通信跌幅榜_数据.json")
doc = json.load(open(SRC, encoding="utf-8"))
rows, meta = doc["rows"], doc["meta"]

DATA_DATE = meta["data_date"]
STAMP = DATA_DATE.replace("-", "")
MODE = "盘中实时" if meta["intraday"] else "收盘"
HHMM = meta["snapshot"][11:16]
CSV_PATH = os.path.join(os.environ.get("OPTICAL_BASE") or "D:/work_code2/", f"光通信板块跌幅榜_{STAMP}.csv")
MD_PATH = os.path.join(os.environ.get("OPTICAL_BASE") or "D:/work_code2/", f"光通信板块跌幅榜_{STAMP}.md")

EXT = {"交换芯片", "覆铜板", "PCB"}
core = [r for r in rows if r["tag"] not in EXT]
ext = [r for r in rows if r["tag"] in EXT]

COL = {"d1": "当日", "d5": "近5日", "d20": "近20日", "d60": "近60日", "ytd": "YTD", "dd250": "距高点"}
PRICE_HDR = "现价" if meta["intraday"] else "收盘"


def f(v, d=2):
    return "—" if v is None else f"{v:+.{d}f}%"


def table(rs, cols, title, top=None):
    lines = [f"\n### {title}\n"]
    head = f"| 代码 | 名称 | 环节 | {PRICE_HDR} | " + " | ".join(COL[c] for c in cols) + " | 总市值(亿) |"
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
out.append(f"数据日：**{DATA_DATE}**（{MODE} {HHMM}）｜样本 **{len(rows)}** 只（光通信核心 {len(core)} 只 + 关联延伸 {len(ext)} 只）")

s1 = sorted([r for r in core if r.get("d1") is not None], key=lambda x: x["d1"])
out.append(table(s1, ["d1", "d5", "d20", "ytd"], "一、当日跌幅榜 TOP15", 15))

s2 = sorted([r for r in core if r.get("d20") is not None], key=lambda x: x["d20"])
out.append(table(s2, ["d20", "d60", "ytd", "dd250"], "二、近 20 交易日跌幅榜 TOP15（本轮调整）", 15))

s3 = sorted([r for r in core if r.get("dd250") is not None], key=lambda x: x["dd250"])
out.append(table(s3, ["dd250", "d20", "ytd"], "三、距近 250 日高点回撤 TOP10", 10))

s4 = sorted([r for r in core if r.get("d20") is not None], key=lambda x: -x["d20"])
out.append(table(s4, ["d20", "d60", "ytd"], "四、近 20 日最抗跌 TOP8", 8))

tagmap = {"光模块": "光模块整机", "光模块/器件": "光模块整机", "光模块/子系统": "光模块整机",
          "光模块/磁性件": "光模块整机", "光模块(索尔思)": "光模块整机",
          "光器件": "光器件/封装", "光器件/封装": "光器件/封装", "光器件/连接": "光器件/封装",
          "光器件/调制器": "光器件/封装", "陶瓷封装": "光器件/封装",
          "光芯片": "光芯片/激光器", "光芯片/PLC": "光芯片/激光器", "激光芯片": "光芯片/激光器",
          "光芯片材料": "光芯片/激光器",
          "光学元件": "光学元件", "光学晶体": "光学元件", "红外光学": "光学元件", "光子器件": "光学元件",
          "光纤光缆": "光纤光缆", "光纤光缆/海缆": "光纤光缆", "特种光缆": "光纤光缆",
          "光缆/设备": "光纤光缆", "线缆": "光纤光缆", "保偏光纤": "光纤光缆",
          "连接器": "连接器/线缆", "连接器/结构件": "连接器/线缆",
          "连接器精密件": "连接器/线缆", "高速铜缆": "连接器/线缆",
          "高速线缆": "连接器/线缆", "屏蔽/散热件": "连接器/线缆", "陶瓷插芯": "连接器/线缆",
          "光通信设备": "设备/接入", "光通信": "设备/接入", "光通信器件": "设备/接入",
          "光通信/连接": "设备/接入", "光通信接入": "设备/接入", "光通信终端": "设备/接入",
          "光模块封装设备": "设备/接入"}
groups = {}
for r in core:
    groups.setdefault(tagmap.get(r["tag"], "其他"), []).append(r)
order = ["光模块整机", "光器件/封装", "光芯片/激光器", "光学元件", "光纤光缆",
         "连接器/线缆", "设备/接入"]
out.append("\n### 五、细分环节汇总（等权中位数）\n")
out.append("| 环节 | 只数 | 当日 | 近20日 | 近60日 | YTD | 平均回撤 |")
out.append("|:--|--:|--:|--:|--:|--:|--:|")
for g in order:
    rs = groups.get(g, [])
    if not rs:
        continue
    def med(k):
        v = [x[k] for x in rs if x.get(k) is not None]
        return f"{st.median(v):+.2f}%" if v else "—"
    out.append(f"| {g} | {len(rs)} | {med('d1')} | {med('d20')} | {med('d60')} | {med('ytd')} | "
               f"{st.mean([x['dd250'] for x in rs]):+.2f}% |")

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

out.append(table(sorted(ext, key=lambda x: x["d1"]), ["d1", "d5", "d20", "ytd"],
                 "七、关联延伸（PCB / 覆铜板 / 交换芯片，非纯光通信）"))

out.append(f"\n> 时点：{meta['snapshot']}　口径：腾讯前复权日线 + 实时快照；"
           f"新浪交叉验证 {len(meta.get('crosscheck') or [])} 只，最大偏差 "
           f"{max([abs(x['diff_pct']) for x in (meta.get('crosscheck') or [{'diff_pct':0}])]):.3f}%")

io.open(MD_PATH, "w", encoding="utf-8").write("\n".join(out))

with io.open(CSV_PATH, "w", encoding="utf-8-sig", newline="") as fp:
    w = csv.writer(fp)
    w.writerow(["数据日期", "数据时点", "状态", "代码", "名称", "细分环节", "现价/收盘", "当日%",
                "近5日%", "近20日%", "近60日%", "年初至今%", "距250日盘中高点%", "250日盘中高点",
                "创60日新低", "换手率%", "总市值(亿)"])
    for r in sorted(rows, key=lambda x: (x.get("d1") is None, x.get("d1") or 0)):
        w.writerow([DATA_DATE, meta["snapshot"], MODE, r["code"], r["name"], r["tag"],
                    f'{r["last"]:.2f}',
                    "" if r.get("d1") is None else f'{r["d1"]:.2f}',
                    "" if r.get("d5") is None else f'{r["d5"]:.2f}',
                    "" if r.get("d20") is None else f'{r["d20"]:.2f}',
                    "" if r.get("d60") is None else f'{r["d60"]:.2f}',
                    "" if r.get("ytd") is None else f'{r["ytd"]:.2f}',
                    f'{r["dd250"]:.2f}',
                    f'{r["hi250"]:.2f}',
                    "是" if r.get("newlow60") else "",
                    "" if r.get("turnover") is None else f'{r["turnover"]:.2f}',
                    f'{r["mcap"]:.1f}' if r.get("mcap") else ""])

print("csv ->", os.path.basename(CSV_PATH), len(rows))
print("md  ->", os.path.basename(MD_PATH))
