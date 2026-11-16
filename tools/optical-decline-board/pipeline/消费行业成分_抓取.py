# -*- coding: utf-8 -*-
"""消费行业成分抓取（同花顺二级行业 ∪ 新浪行业，全量合并）
输出：_cons_raw.json   {"v_stamp", "by_l1": {一级行业: [{code,name,ind2,src}]}}

为什么要双源：
  同花顺免费额度每板块最多 5 页（100 只），按「涨幅降序」返回 → 超大板块（汽车零部件/化学制药/
  医疗器械）会漏中间部分；新浪行业无上限但分类滞后（次新股、新细分缺失）。
  两源并集再按市值门槛筛，可把漏项压到可接受范围。
"""
import io, json, os, re, sys, time

import requests
from bs4 import BeautifulSoup

BASE = os.environ.get("OPTICAL_BASE") or "D:/work_code2/"

# 同花顺二级行业 → 一级展示口径（消费）
THS_MAP = {
    "881273": ("白酒", "食品饮料"), "881133": ("饮料制造", "食品饮料"),
    "881134": ("食品加工制造", "食品饮料"),
    "881131": ("白色家电", "家用电器"), "881132": ("黑色家电", "家用电器"),
    "881173": ("小家电", "家用电器"), "881174": ("厨卫电器", "家用电器"),
    "881135": ("纺织制造", "纺织服饰"), "881136": ("服装家纺", "纺织服饰"),
    "881139": ("家居用品", "轻工制造"), "881137": ("造纸", "轻工制造"),
    "881138": ("包装印刷", "轻工制造"),
    "881158": ("零售", "商贸零售"), "881159": ("贸易", "商贸零售"),
    "881177": ("互联网电商", "商贸零售"),
    "881160": ("旅游及酒店", "社会服务"), "881179": ("其他社会服务", "社会服务"),
    "881178": ("教育", "社会服务"),
    "881182": ("美容护理", "美容护理"),
    "881101": ("种植业与林业", "农林牧渔"), "881102": ("养殖业", "农林牧渔"),
    "881103": ("农产品加工", "农林牧渔"),
    "881125": ("汽车整车", "汽车"), "881126": ("汽车零部件", "汽车"),
    "881128": ("汽车服务", "汽车"),
    "881140": ("化学制药", "医药生物"), "881141": ("中药", "医药生物"),
    "881142": ("生物制品", "医药生物"), "881143": ("医药商业", "医药生物"),
    "881144": ("医疗器械", "医药生物"), "881175": ("医疗服务", "医药生物"),
}

# 新浪行业 → 一级展示口径（补同花顺截断/分类滞后）
SINA_MAP = {
    "new_sphy": ("食品", "食品饮料"), "new_ljhy": ("酿酒", "食品饮料"),
    "new_jdhy": ("家电", "家用电器"),
    "new_fzhy": ("纺织", "纺织服饰"), "new_fzxl": ("服装鞋类", "纺织服饰"),
    "new_jjhy": ("家具", "轻工制造"),
    "new_sybh": ("商业百货", "商贸零售"),
    "new_jdly": ("酒店旅游", "社会服务"),
    "new_nlmy": ("农林牧渔", "农林牧渔"),
    "new_qczz": ("汽车制造", "汽车"), "new_mtc": ("摩托车", "汽车"),
    "new_swzz": ("生物制药", "医药生物"),
}

L1_ORDER = ["食品饮料", "家用电器", "纺织服饰", "轻工制造", "商贸零售",
            "社会服务", "美容护理", "农林牧渔", "汽车", "医药生物"]

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")


def ths_session():
    import py_mini_racer
    from akshare.datasets import get_ths_js
    js = py_mini_racer.MiniRacer()
    with open(get_ths_js("ths.js"), encoding="utf-8") as f:
        js.eval(f.read())
    S = requests.Session()
    S.trust_env = False
    S.headers.update({"User-Agent": UA, "Cookie": "v=" + js.call("v"),
                      "Referer": "https://q.10jqka.com.cn/"})
    return S


def ths_page(S, code, pg, order=None, retry=2):
    if order:
        u = (f"https://q.10jqka.com.cn/thshy/detail/order/{order}/page/{pg}/code/{code}/")
    else:
        u = (f"https://q.10jqka.com.cn/thshy/detail/code/{code}/" if pg == 1 else
             f"https://q.10jqka.com.cn/thshy/detail/page/{pg}/code/{code}/")
    for _ in range(retry + 1):
        try:
            r = S.get(u, timeout=20)
            r.encoding = "gbk"
            if r.status_code != 200:
                time.sleep(1.5)
                continue
            soup = BeautifulSoup(r.text, "lxml")
            pi = soup.select_one(".page_info")
            tp = 1
            if pi:
                m = re.search(r"(\d+)\s*/\s*(\d+)", pi.get_text(" ", strip=True))
                if m:
                    tp = int(m.group(2))
            rows = []
            for tr in soup.select("table.m-table tbody tr"):
                tds = [td.get_text(strip=True) for td in tr.find_all("td")]
                if len(tds) >= 3 and re.match(r"^\d{6}$", tds[1]):
                    rows.append((tds[1], tds[2]))
            return rows, tp
        except Exception:
            time.sleep(1.5)
    return [], 0


def fetch_sina(sec):
    try:
        import akshare as ak
        df = ak.stock_sector_detail(sector=sec)
        out = []
        for _, x in df.iterrows():
            c = str(x.get("code") or "")[:6]
            n = str(x.get("name") or "").strip()
            if len(c) == 6:
                out.append((c, n))
        return out
    except Exception as e:
        print("  sina fail", sec, type(e).__name__, str(e)[:60], flush=True)
        return []


def main():
    res = {"v_stamp": time.strftime("%Y-%m-%d %H:%M:%S"),
           "by_l1": {k: [] for k in L1_ORDER}, "stat": {}}
    S = ths_session()

    # ---------- 同花顺：每个二级行业最多 5 页；超 5 页的再加「涨幅升序」5 页 ----------
    t0 = time.time()
    for code, (ind2, l1) in THS_MAP.items():
        got = {}
        rows, tp = ths_page(S, code, 1)
        n_pages = min(tp, 5) if tp else 1
        for pg in range(1, n_pages + 1):
            if pg > 1:
                rows, _ = ths_page(S, code, pg)
            for c, n in rows:
                got[c] = n
            time.sleep(0.35)
        extra = 0
        if tp > 5:                      # 被截断 → 反向再取 5 页
            for pg in range(1, 6):
                rows, _ = ths_page(S, code, pg, order="asc")
                for c, n in rows:
                    if c not in got:
                        got[c] = n
                        extra += 1
                time.sleep(0.35)
        for c, n in got.items():
            res["by_l1"][l1].append({"code": c, "name": n, "ind2": ind2, "src": "ths"})
        print(f"ths {ind2}({code}) 总页{tp} 取{len(got)} 反向补{extra}", flush=True)
    print("同花顺耗时 %.0fs" % (time.time() - t0), flush=True)

    # ---------- 新浪：全量补充 ----------
    for sec, (ind2, l1) in SINA_MAP.items():
        lst = fetch_sina(sec)
        for c, n in lst:
            res["by_l1"][l1].append({"code": c, "name": n, "ind2": ind2, "src": "sina"})
        print(f"sina {sec} {ind2} {len(lst)}", flush=True)
        time.sleep(0.3)

    # ---------- 合并去重（同花顺优先） ----------
    for l1 in L1_ORDER:
        seen, uniq = set(), []
        for x in res["by_l1"][l1]:
            if x["code"] in seen:
                continue
            seen.add(x["code"])
            uniq.append(x)
        res["by_l1"][l1] = uniq
        res["stat"][l1] = {"n": len(uniq),
                           "ths": sum(1 for x in uniq if x["src"] == "ths"),
                           "sina_only": sum(1 for x in uniq if x["src"] == "sina")}

    with io.open(os.path.join(BASE, "_cons_raw.json"), "w", encoding="utf-8") as f:
        json.dump(res, f, ensure_ascii=False, indent=1)
    tot = sum(len(v) for v in res["by_l1"].values())
    print("TOTAL 去重后", tot, "只", flush=True)
    for l1 in L1_ORDER:
        s = res["stat"][l1]
        print(f"  {l1}: {s['n']}（同花顺 {s['ths']}，仅新浪 {s['sina_only']}）", flush=True)
    sys.stdout.flush()
    os._exit(0)


if __name__ == "__main__":
    main()
