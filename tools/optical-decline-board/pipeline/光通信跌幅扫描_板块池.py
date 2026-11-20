# -*- coding: utf-8 -*-
"""生成板块池：光通信（核心/关联延伸）+ 科技股（宽口径）
数据来源（本地缓存，由 _ths_fetch.py / _sina_hy_fetch.py 生成）：
  _ths_blocks.json  同花顺概念&行业成分（分页受免费额度限制，取到前若干页）
  _sina_hy.json     新浪 电子器件 / 电子信息 全成分
输出：板块池.json
"""
import io, json, os, re, sys, time

BASE = os.environ.get("OPTICAL_BASE") or "D:/work_code2/"
MIN_MCAP = 30.0    # 科技股池市值门槛（亿元）
MAX_TECH = 260     # 科技股池上限（按市值降序，控制抓数耗时与页面体积）

# 消费池（申万一级口径）：必需+可选消费 8 个为「核心」，汽车/医药生物为「关联延伸」
CONS_CORE_L1 = ["食品饮料", "家用电器", "纺织服饰", "轻工制造",
                "商贸零售", "社会服务", "美容护理", "农林牧渔"]
CONS_EXT_L1 = ["汽车", "医药生物"]
CONS_MIN_MCAP = 50.0   # 消费核心市值门槛（消费小票多，50 亿以下对跌幅看板意义有限）
CONS_EXT_MAX = {"汽车": 80, "医药生物": 100}   # 压暗层按市值截断，控制页面体积

# ---------------------------------------------------------------- 光通信（人工核定）
# 核定依据：雪球 F10「主营业务 / 主要产品」（2026-11-13 抓取），见 光通信跌幅榜_成分核查.md
CORE = [
    ("300308", "中际旭创", "光模块"),
    ("300502", "新易盛", "光模块"),
    ("002281", "光迅科技", "光模块/器件"),
    ("000988", "华工科技", "光模块"),
    ("603083", "剑桥科技", "光模块"),
    ("301205", "联特科技", "光模块"),
    ("688205", "德科立", "光模块/子系统"),
    ("002902", "铭普光磁", "光模块/磁性件"),
    ("001267", "汇绿生态", "光模块"),
    ("603118", "共进股份", "光模块/网通设备"),
    ("002384", "东山精密", "光模块/光芯片"),
    ("002429", "兆驰股份", "光模块/光芯片"),
    ("300394", "天孚通信", "光器件/封装"),
    ("300570", "太辰光", "光器件/连接"),
    ("300548", "长芯博创", "光器件"),
    ("603042", "华脉科技", "光配线/光缆（保留）"),
    ("300620", "光库科技", "光器件/调制器"),
    ("688195", "腾景科技", "光器件/光学元件"),
    ("920045", "蘅东光", "光器件/连接"),
    ("920157", "宇特光电", "光器件/连接"),
    ("301486", "致尚科技", "光器件/连接"),
    ("301183", "东田微", "光学元件/硅光配套"),
    ("003031", "中瓷电子", "陶瓷封装"),
    ("300408", "三环集团", "陶瓷插芯"),
    ("688498", "源杰科技", "光芯片"),
    ("688313", "仕佳光子", "光芯片/PLC"),
    ("688048", "长光华芯", "激光芯片"),
    ("688807", "优迅股份", "光芯片/收发电芯片"),
    ("601869", "长飞光纤", "光纤光缆（保留）"),
    ("600487", "亨通光电", "光纤光缆（保留）"),
    ("600522", "中天科技", "光纤光缆（保留）"),
    ("600105", "永鼎股份", "光纤光缆（保留）"),
    ("002491", "通鼎互联", "光纤光缆（保留）"),
    ("000070", "特发信息", "光纤光缆（保留）"),
    ("000586", "汇源通信", "光缆/设备（保留）"),
    ("300265", "通光线缆", "特种光缆（保留）"),
    ("688635", "长进光子", "特种光纤（保留）"),
    ("688143", "长盈通", "保偏光纤（保留）"),
    ("603618", "杭电股份", "光纤光缆（保留）"),
    ("300252", "金信诺", "光缆/高速互联（保留）"),
    ("600498", "烽火通信", "光通信设备"),
    ("603803", "瑞斯康达", "光通信接入"),
    ("300504", "天邑股份", "光通信终端"),
    ("688609", "九联科技", "光接入终端"),
    ("000063", "中兴通讯", "光传输设备"),
    ("688400", "凌云光", "光通信测试"),
    ("300757", "罗博特科", "光模块封装设备"),
    ("300398", "飞凯材料", "光纤涂覆材料"),
    ("688618", "三旺通信", "工业光通信设备"),
    ("300710", "万隆光电", "光传输设备（广电）"),
    ("688418", "震有科技", "光网络/接入"),
    ("002179", "中航光电", "光连接器"),
]

EXT = [
    ("600183", "生益科技", "覆铜板(光模块PCB)"),
    ("002463", "沪电股份", "PCB(光模块/AI)"),
    ("300476", "胜宏科技", "PCB(光模块/AI)"),
    ("002916", "深南电路", "PCB(通信/光模块)"),
    ("688183", "生益电子", "PCB(800G光模块)"),
    ("603228", "景旺电子", "PCB(光模块)"),
    ("603936", "博敏电子", "PCB(光模块)"),
    ("002436", "兴森科技", "PCB(光模块)"),
    ("300852", "四会富仕", "PCB(光模块)"),
    ("300739", "明阳电路", "PCB(光模块)"),
    ("301132", "满坤科技", "PCB(光模块)"),
    ("603459", "红板科技", "PCB(光模块)"),
    ("600601", "方正科技", "PCB(光模块)"),
    ("920060", "万源通", "PCB(光模块)"),
    ("920821", "则成电子", "PCB(光模块)"),
    ("002938", "鹏鼎控股", "PCB(光模块)"),
    ("002579", "中京电子", "PCB(光模块)"),
    ("300964", "本川智能", "PCB(光模块)"),
    ("301628", "强达电路", "PCB(光模块)"),
    ("301041", "金百泽", "PCB(光模块)"),
    ("301366", "一博科技", "PCBA(光模块)"),
    ("002897", "意华股份", "光模块结构件/连接器"),
    ("688668", "鼎通科技", "光模块连接器/散热件"),
    ("301182", "凯旺科技", "光模块结构件"),
    ("688629", "华丰科技", "高速连接器(光模块)"),
    ("002025", "航天电器", "光通信器件(小体量)"),
    ("688800", "瑞可达", "光纤连接器(小体量)"),
    ("301123", "奕东电子", "光通讯组件"),
    ("300709", "精研科技", "光模块壳体"),
    ("002130", "沃尔核材", "高速铜缆(光模块互补)"),
    ("300913", "兆龙互连", "高速线缆(光模块互补)"),
    ("301165", "锐捷网络", "交换机/CPO"),
    ("688702", "盛科通信", "交换芯片(CPO)"),
    ("688808", "联讯仪器", "光通信测试"),
    ("301689", "电科思仪", "光通信测试"),
    ("002980", "华盛昌", "光通信测试"),
    ("688337", "普源精电", "光通信测试"),
    ("688628", "优利德", "光通信测试"),
    ("688312", "燕麦科技", "硅光晶圆测试"),
    ("688135", "利扬芯片", "光芯片测试"),
    ("688383", "新益昌", "光模块封装设备"),
    ("603203", "快克智能", "光模块组装设备"),
    ("002957", "科瑞技术", "光模块自动化设备"),
    ("301312", "智立方", "光模块检测设备"),
    ("920178", "锐翔智能", "光模块精密加工设备"),
    ("300802", "矩子科技", "光模块AOI"),
    ("603688", "石英股份", "光纤级石英"),
    ("300395", "菲利华", "光纤级石英"),
    ("002428", "云南锗业", "光纤级锗"),
    ("300217", "东方电热", "光通信材料"),
    ("603938", "三孚股份", "光纤级四氯化硅"),
    ("688102", "斯瑞新材", "光模块芯片基座/壳体"),
    ("300684", "中石科技", "光模块散热"),
    ("601609", "金田股份", "光模块散热铜材"),
    ("688388", "嘉元科技", "光模块PCB铜箔"),
    ("603738", "泰晶科技", "光模块晶振"),
    ("920981", "晶赛科技", "光模块晶振"),
    ("688662", "富信科技", "光模块MicroTEC"),
    ("688536", "思瑞浦", "光模块模拟芯片"),
    ("688172", "燕东微", "硅光/光芯片"),
    ("600703", "三安光电", "光通信芯片"),
    ("300102", "乾照光电", "光通信芯片"),
    ("002222", "福晶科技", "光通信光学元件"),
    ("688167", "炬光科技", "CPO光源/激光光学"),
    ("688025", "杰普特", "光纤器件"),
    ("603306", "华懋科技", "参股富创优越(光模块)"),
    ("603052", "可川科技", "硅光模块(研发)"),
    ("301479", "弘景光电", "光纤阵列/光无源器件"),
    ("600103", "青山纸业", "光模块(子公司恒宝通)"),
    ("600869", "远东股份", "光纤预制棒(在建)"),
]

# 剔除（原池误纳，主业与光通信无实质关联且无参股/供应关系）
DROP = {
    "300489": "红外光学整机，不在光通信链",   # 保留在 EXT 观察，不参与核心统计
}

# 科技股宽口径的来源（同花顺行业名）→ 展示用行业
IND_MAP = {
    "半导体": "半导体", "元件": "元件/连接器", "光学光电子": "光学光电子",
    "消费电子": "消费电子", "电子化学品": "电子材料", "通信设备": "通信/计算机",
    "通信服务": "通信/计算机", "计算机设备": "通信/计算机", "软件开发": "软件/IT",
    "IT服务": "软件/IT",
}
SINA_MAP = {"电子器件": "半导体/元件", "电子信息": "通信/计算机"}

# 人工剔除：行业口径归入电子、但主业为光伏/锂电等新能源，不属于科技股主口径
EXCLUDE = {
    "601012": "隆基绿能(光伏)", "002129": "TCL中环(光伏硅片)", "002506": "协鑫集成(光伏组件)",
    "300014": "亿纬锂能(电池)", "300207": "欣旺达(电池)", "300390": "天华新能(锂电材料)",
    "002389": "航天彩虹(无人机薄膜)", "002218": "拓日新能(光伏)", "002623": "亚玛顿(光伏玻璃)",
    "002610": "爱康科技(光伏)", "300118": "东方日升(光伏)", "300111": "向日葵(光伏)",
    "600207": "安彩高科(光伏玻璃)", "600151": "航天机电(光伏)", "002005": "德豪润达(LED/光伏)",
}
BAD_NAME = re.compile(r"ST|退|\*")


def load_json(p):
    with io.open(p, encoding="utf-8") as f:
        return json.load(f)


def sym(code):
    if code.startswith(("60", "68", "90")):
        return "sh" + code
    if code.startswith(("4", "8", "92")):
        return "bj" + code
    return "sz" + code


def fetch_mcap(codes):
    """腾讯批量快照取总市值（亿元，字段 45）"""
    import requests
    S = requests.Session()
    S.trust_env = False
    H = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Referer": "https://gu.qq.com/"}
    out = {}
    for i in range(0, len(codes), 50):
        batch = codes[i:i + 50]
        q = ",".join(sym(c) for c in batch)
        for _ in range(3):
            try:
                r = S.get(f"https://qt.gtimg.cn/q={q}", headers=H, timeout=12)
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
                    try:
                        out[f[2]] = float(f[45])
                    except Exception:
                        pass
                break
            except Exception:
                time.sleep(0.6)
    return out


def build_cons(mcap):
    """消费池：同花顺二级行业 ∪ 新浪行业（_cons_raw.json），剔除 ST/退市、市值门槛后分层
    核心 = 8 个必需/可选消费一级行业；关联延伸（压暗）= 汽车、医药生物，按市值截前 CONS_EXT_MAX
    """
    p = os.path.join(BASE, "_cons_raw.json")
    try:
        d = load_json(p)
        by_l1 = d["by_l1"]
    except Exception as e:
        print("cons raw skip:", e)
        return [], []
    core, ext = [], []
    for l1 in CONS_CORE_L1 + CONS_EXT_L1:
        lst = []
        for x in by_l1.get(l1, []):
            name = (x.get("name") or "").strip()
            if not name or BAD_NAME.search(name):
                continue
            m = mcap.get(x["code"], 0)
            if m < CONS_MIN_MCAP:
                continue
            lst.append((x["code"], name, l1, x.get("ind2") or l1, m))
        lst.sort(key=lambda z: -z[4])
        if l1 in CONS_EXT_L1:
            lst = lst[:CONS_EXT_MAX.get(l1, 100)]
            ext.extend({"code": c, "name": n, "l1": l1, "ind2": i} for c, n, l1_, i, m in lst)
        else:
            core.extend({"code": c, "name": n, "l1": l1, "ind2": i} for c, n, l1_, i, m in lst)
    return core, ext


def build_tech():
    codes = {}   # code -> {name, ind}
    try:
        ths = load_json(os.path.join(BASE, "_ths_blocks.json"))
        for k, v in ths.get("industry", {}).items():
            for x in v["list"]:
                c = x["code"]
                if c not in codes:
                    codes[c] = {"name": x["name"], "ind": IND_MAP.get(k, k)}
    except Exception as e:
        print("ths industry skip", e)
    try:
        sina = load_json(os.path.join(BASE, "_sina_hy.json"))
        for k, lst in sina.items():
            for x in lst:
                c = x["code"]
                if c not in codes:
                    codes[c] = {"name": x["name"], "ind": SINA_MAP.get(k, k)}
    except Exception as e:
        print("sina skip", e)
    codes = {c: v for c, v in codes.items() if not BAD_NAME.search(v["name"])}
    codes = {c: v for c, v in codes.items() if c not in EXCLUDE}
    return codes


def main():
    opt_codes = [c for c, _, _ in CORE] + [c for c, _, _ in EXT]
    dup = {c for c in opt_codes if opt_codes.count(c) > 1}
    assert not dup, f"光通信池重复代码 {dup}"

    tech = build_tech()
    # 光通信成员并入科技股池；保留其原始行业（未分类者标为「其他」），另用 opt 标记标注归属
    for c, n, t in CORE + EXT:
        tech.setdefault(c, {"name": n, "ind": "其他"})

    # 消费池候选（尚未筛市值）
    cons_all = []
    try:
        _d = load_json(os.path.join(BASE, "_cons_raw.json"))
        for _l1, _lst in _d["by_l1"].items():
            cons_all += [x["code"] for x in _lst]
    except Exception as e:
        print("cons raw skip:", e)

    mcap = fetch_mcap(list(tech.keys()) + cons_all)
    print("快照覆盖", len(mcap), "/", len(tech) + len(cons_all))

    # 市值门槛 + 截断（光通信成员不参与截断）
    opt_set = set(opt_codes)
    keep = []
    for c, v in tech.items():
        m = mcap.get(c, 0)
        if c in opt_set or m >= MIN_MCAP:
            keep.append((c, v["name"], v["ind"], m))
    keep.sort(key=lambda x: -x[3])
    tech_list = [{"code": c, "name": n, "ind": i} for c, n, i, m in keep[:MAX_TECH]]

    cons_core, cons_ext = build_cons(mcap)

    pool = {
        "version": "2026-11-20-audit",
        "optical": {
            "core": [{"code": c, "name": n, "tag": t} for c, n, t in CORE],
            "ext": [{"code": c, "name": n, "tag": t} for c, n, t in EXT],
        },
        "tech": tech_list,
        "cons": {"core": cons_core, "ext": cons_ext},
    }
    with io.open(os.path.join(BASE, "板块池.json"), "w", encoding="utf-8") as f:
        json.dump(pool, f, ensure_ascii=False, indent=1)
    from collections import Counter
    cdist = Counter(x["l1"] for x in cons_core)
    edist = Counter(x["l1"] for x in cons_ext)
    print("光通信核心", len(CORE), "关联延伸", len(EXT), "| 科技股池", len(tech_list),
          "（候选", len(keep), "，门槛", MIN_MCAP, "亿）")
    print("消费核心", len(cons_core), dict(cdist), "| 关联延伸", len(cons_ext), dict(edist))
    sys.stdout.flush()
    os._exit(0)


if __name__ == "__main__":
    main()
