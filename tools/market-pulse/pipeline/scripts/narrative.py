# -*- coding: utf-8 -*-
"""Compose the data-driven Chinese narrative for the daily market-pulse page.

Keep all numbers here, so template.html can stay structural and tomorrow's page
will not inherit today's prose.
"""
from html import escape


def _num(v, d=1):
    try:
        v = float(v)
    except (TypeError, ValueError):
        v = 0.0
    body = f"{abs(v):,.{d}f}"
    return ("+" if v > 0 else "-" if v < 0 else "") + body


def _pct(v, d=2):
    return _num(v, d) + "%"


def _name(v):
    return escape(str(v or ""), quote=False)


def _pick_top(rows, key="net", n=3):
    return sorted(rows, key=lambda x: x.get(key, 0), reverse=True)[:n]


def _pick_bottom(rows, key="net", n=3):
    return sorted(rows, key=lambda x: x.get(key, 0))[:n]


def _join_names(rows):
    return "、".join(_name(x.get("name")) for x in rows)


def _double_positive(rows):
    return [x for x in rows if x.get("net", 0) > 0 and x.get("d5", 0) > 0]


def build_narrative(d):
    idx = d.get("indices", [])
    sh = idx[0] if idx else {}
    sm = d.get("session") or {}
    is_am = (sm.get("key") or "pm") == "am"
    close_word = "午盘" if is_am else "收盘"
    position_word = "午盘位置" if is_am else "收盘位置"
    price_verb = "午盘收" if is_am else "收"
    cyb = next((x for x in idx if x.get("code") == "sz399006"), idx[2] if len(idx) > 2 else {})
    kc = next((x for x in idx if x.get("code") == "sh000688"), {})
    breadth = d.get("breadth", {})
    flows = d.get("flows", {})
    etf = d.get("etf", {})
    margin = d.get("margin", {})
    industries = d.get("industries", [])
    concepts = d.get("concepts", [])
    stocks = d.get("stocks", {})
    top_in = stocks.get("top_in", [])
    top_out = stocks.get("top_out", [])
    featured = stocks.get("featured", [])
    lhb = d.get("lhb", {})
    zt = d.get("zt", {})

    sh_chg = sh.get("change_pct", 0)
    sh_low = (sh.get("low", 0) / sh.get("prev_close", 1) - 1) * 100 if sh.get("prev_close") else 0
    sh_pos = sh.get("close_pos", 0)
    breadth_up = breadth.get("up", 0)
    breadth_down = breadth.get("down", 0)
    lu = breadth.get("limit_up", 0)
    ld = breadth.get("limit_down", 0)

    ths_net = flows.get("ths", {}).get("total", 0)
    prior4 = flows.get("prior4", {}).get("ths", 0)
    etf_d5 = etf.get("d5", 0)
    etf_net = etf.get("net", 0)
    etf_date = etf.get("date", "")
    margin_chg4 = margin.get("chg4", 0)
    margin_chg5 = margin.get("chg5", 0)
    margin_total = margin.get("total_fin", 0)
    margin_date = margin.get("date", "")

    if sh_chg > 0 and sh_pos >= 65 and sh_low < -0.5:
        move = "深V反转"
    elif sh_chg > 0:
        move = "指数午盘收红" if is_am else "指数收红"
    elif sh_chg < 0 and sh_pos >= 65:
        move = "探底回稳"
    else:
        move = "指数调整"

    title_bits = []
    if etf_d5 > 0:
        title_bits.append("ETF 在托底")
    if ths_net > 0:
        title_bits.append("大单在回补")
    if margin_chg4 < 0:
        title_bits.append("杠杆仍在出清")
    if not title_bits:
        title_bits.append("资金仍在分歧")
    hero_title = f"{move}：<em>{'，'.join(title_bits)}</em>"

    refill_pct = (ths_net / abs(prior4) * 100) if prior4 < -0.01 else None
    if refill_pct is not None:
        refill_text = f"今天回补了 <b>{refill_pct:.1f}%</b>"
    elif prior4 > 0.01 and ths_net > 0:
        refill_text = f"今天在前期流入上继续加 <b>{_num(ths_net)} 亿</b>"
    else:
        refill_text = f"今天净额 <b>{_num(ths_net)} 亿</b>"

    hero_dek = (
        f"上证最低 {_pct(sh_low)}、{price_verb} {sh.get('price', 0):,.2f}（{_pct(sh_chg)}），"
        f"创业板 {_pct(cyb.get('change_pct', 0))}；上涨 <b>{breadth_up}</b> 家、下跌 <b>{breadth_down}</b> 家，"
        f"涨停 <b>{lu}</b> 家。ETF 5 日净申购 <b>{_num(etf_d5)} 亿</b>；主动全单今天 <b>{_num(ths_net)} 亿</b>、"
        f"前 4 日 <b>{_num(prior4)} 亿</b>；融资余额 4 日 <b>{_num(margin_chg4)} 亿</b>。"
        f"一句话：<b>被动资金在{'持续建仓' if etf_d5 > 0 else '撤退'}，主动资金在{'做超跌回补' if ths_net > 0 and prior4 < 0 else '按自身节奏交易'}，"
        f"杠杆{'仍在撤退' if margin_chg4 < 0 else '已经转向'}</b>。"
    )

    # ---- lead cards ----
    lead_cards = []
    if sh_low < -0.5 and sh_chg > 0:
        lead1_title = "深 V，不是普通反弹"
        lead1_body = (
            f"上证最低 <b>{_pct(sh_low)}</b>，{close_word} <b>{_pct(sh_chg)}</b>；创业板从低点拉回 "
            f"<b>{_pct(cyb.get('reversal_from_low', 0))}</b>。上涨 <b>{breadth_up}</b> 家、下跌 <b>{breadth_down}</b> 家，"
            f"涨停 <b>{lu}</b> 家——早盘的恐慌盘被资金接走了。"
        )
    else:
        lead1_title = f"指数与广度：先看{position_word}"
        lead1_body = (
            f"上证{price_verb} <b>{sh.get('price', 0):,.2f}</b>（{_pct(sh_chg)}），{position_word} <b>{sh_pos:.0f}%</b>；"
            f"创业板 {_pct(cyb.get('change_pct', 0))}。上涨 <b>{breadth_up}</b> 家、下跌 <b>{breadth_down}</b> 家，"
            f"涨停 <b>{lu}</b> 家、跌停 <b>{ld}</b> 家。"
        )
    lead_cards.append({"kicker": "01 · 指数", "title": lead1_title, "body": lead1_body})

    if etf_d5 > 0 and ths_net > 0 and prior4 < 0:
        lead2_title = "ETF 在持续买，主动资金只是回补"
    elif etf_d5 > 0 and ths_net > 0:
        lead2_title = "ETF 与主动资金同向流入"
    elif etf_d5 > 0:
        lead2_title = "ETF 在托底，主动资金还在卖"
    else:
        lead2_title = "ETF 没有接力，主动资金主导"
    lead2_body = (
        f"15 只宽基 ETF 在 {etf.get('decomp', {}).get('start', '')} 至 {etf.get('decomp', {}).get('end', '')} "
        f"合计净申购 <b>{_num(etf_d5)} 亿</b>，{etf_date} 单日 <b>{_num(etf_net)} 亿</b>。"
        f"主动全单今天 <b>{_num(ths_net)} 亿</b>，但过去 4 日累计 <b>{_num(prior4)} 亿</b>，{refill_text}。"
    )
    lead_cards.append({"kicker": "02 · 钱", "title": lead2_title, "body": lead2_body})

    opt = [x for x in top_in if x.get("sector") == "光模块"]
    opt_double = _double_positive(opt)
    if len(opt_double) >= 2:
        lead3_title = "光模块仍是“今天 + 5日”双正的成长主线"
    else:
        lead3_title = "今天的主线：看谁今天和 5 日同时为正"
    lead3_body_parts = []
    for x in (opt[:3] if opt else top_in[:3]):
        lead3_body_parts.append(f"{_name(x.get('name'))} <b>{_num(x.get('net'))} / 5日 {_num(x.get('d5'))} 亿</b>")
    lead3_body = "，".join(lead3_body_parts) + "。"
    bank = next((x for x in industries if x.get("name") == "银行"), None)
    if bank and bank.get("net", 0) > 0 and bank.get("net5", 0) > 0:
        lead3_body += f"银行也是双正（{_num(bank.get('net'))} / {_num(bank.get('net5'))}），但属防守方向。"
    lead_cards.append({"kicker": "03 · 主线", "title": lead3_title, "body": lead3_body})

    # ---- signals ----
    signals = []
    etf_pos_days = sum(1 for x in etf.get("seq", [])[-5:] if x.get("net", 0) > 0)
    if etf_d5 > 0 and etf_pos_days >= 3:
        signals.append({
            "status": "成立", "cls": "ok", "kicker": "01 · 被动资金",
            "title": "ETF 通道持续净申购",
            "body": f"5 日 {_num(etf_d5)} 亿，{etf_date} 单日 {_num(etf_net)} 亿；最近 5 日有 {etf_pos_days} 日为净申购。",
        })
    else:
        signals.append({
            "status": "待确认" if etf_d5 > 0 else "不成立", "cls": "warn" if etf_d5 > 0 else "bad",
            "kicker": "01 · 被动资金", "title": "ETF 申购不连续",
            "body": f"5 日合计 {_num(etf_d5)} 亿，最近 5 日仅 {etf_pos_days} 日为正；托底力度还不稳定。",
        })
    if len(opt_double) >= 2:
        signals.append({
            "status": "成立", "cls": "ok", "kicker": "02 · 主动大单",
            "title": "龙头集中加仓",
            "body": f"{_join_names(opt_double)} 今日与 5 日双正；大单集中在少数龙头，不是全面铺开。",
        })
    else:
        signals.append({
            "status": "待确认", "cls": "warn", "kicker": "02 · 主动大单",
            "title": "龙头加仓还不够集中",
            "body": f"今日与 5 日双正的成长龙头只有 {len(opt_double)} 只，持续性需要再观察一天。",
        })
    if ths_net > 0 and prior4 > 0:
        signals.append({
            "status": "成立", "cls": "ok", "kicker": "03 · 全市场",
            "title": "主动资金连续流入",
            "body": f"今日全单 {_num(ths_net)} 亿，前 4 日 {_num(prior4)} 亿；不是单日脉冲。",
        })
    elif ths_net > 0:
        signals.append({
            "status": "待确认", "cls": "warn", "kicker": "03 · 全市场",
            "title": "单日回补，不是全面加仓",
            "body": f"今日全单 {_num(ths_net)} 亿，但前 4 日 {_num(prior4)} 亿；只回补 {refill_pct:.1f}%." if refill_pct is not None
            else f"今日全单 {_num(ths_net)} 亿，前 4 日 {_num(prior4)} 亿；还需要连续确认。",
        })
    else:
        signals.append({
            "status": "不成立", "cls": "bad", "kicker": "03 · 全市场",
            "title": "主动资金仍在净流出",
            "body": f"今日全单 {_num(ths_net)} 亿，前 4 日 {_num(prior4)} 亿；卖压没有解除。",
        })
    if margin_chg4 >= 0:
        signals.append({
            "status": "成立", "cls": "ok", "kicker": "04 · 杠杆",
            "title": "融资余额止跌回升",
            "body": f"融资余额 {margin_total:,.1f} 亿（{margin_date}），4 日 {_num(margin_chg4)} 亿、5 日 {_num(margin_chg5)} 亿。",
        })
    else:
        signals.append({
            "status": "不成立", "cls": "bad", "kicker": "04 · 杠杆",
            "title": "融资余额仍在撤",
            "body": f"融资余额 {margin_total:,.1f} 亿（{margin_date}），4 日 {_num(margin_chg4)} 亿、5 日 {_num(margin_chg5)} 亿；上涨不是杠杆推的。",
        })

    # ---- notes ----
    max_rev_pool = [
        x for x in idx
        if x.get("change_pct", 0) < 0 or ((x.get("low", 0) / x.get("prev_close", 1) - 1) * 100 if x.get("prev_close") else 0) <= -2
    ] or idx
    max_rev = max(max_rev_pool, key=lambda x: x.get("reversal_from_low", -999)) if max_rev_pool else {}
    reversal_note = (
        f"{_name(max_rev.get('name'))} {price_verb} {_pct(max_rev.get('change_pct', 0))}，但盘中最低 "
        f"{_pct((max_rev.get('low', 0) / max_rev.get('prev_close', 1) - 1) * 100 if max_rev.get('prev_close') else 0)}、"
        f"{close_word}从低点拉回 {_pct(max_rev.get('reversal_from_low', 0))}——{'上午' if is_am else '今天'}最典型的“深水打捞”。"
    )
    flows_note = (
        "东财沪市为单点快照；深市同接口收盘后常被限流，未取到的不做同口径展示。"
        "新浪为全 A 超大单，同花顺为全 A 主动买卖全单；口径不同，只看方向与量级，不能相加。"
    )
    seq5 = etf.get("seq", [])[-5:]
    etf_note = (
        f"{' → '.join(_num(x.get('net'), 0) for x in seq5)} 亿；5 日合计 {_num(etf_d5)} 亿。"
        if seq5 else f"最新正式披露 {etf_date}，单日 {_num(etf_net)} 亿。"
    )
    buckets = etf.get("decomp", {}).get("buckets", [])
    hs300 = next((x for x in buckets if x.get("name") == "沪深300"), {})
    sz50 = next((x for x in buckets if x.get("name") == "上证50"), {})
    growth_b = sum(x.get("net", 0) for x in buckets if x.get("name") in ("创业板", "科创50"))
    small_b = sum(x.get("net", 0) for x in buckets if x.get("name") in ("中证500", "中证1000"))
    etf_decomp_note = (
        f"沪深300 <b>{_num(hs300.get('net'))} 亿（{hs300.get('share', 0):.0f}%）</b>、"
        f"上证50 <b>{_num(sz50.get('net'))} 亿（{sz50.get('share', 0):.0f}%）</b>，两者合计约 "
        f"<b>{(hs300.get('share', 0) + sz50.get('share', 0)):.0f}%</b>；中证500+1000 约 {small_b:.0f} 亿，"
        f"创业板+科创50 约 {growth_b:.0f} 亿。买盘主要在大盘宽基，托底属性强于进攻属性。"
    )

    refill_pct_text = f"{refill_pct:.0f}%" if refill_pct is not None else "—"
    active_desc = (
        f"全 A 主动买卖净额（同花顺口径）。过去 4 日 <b class=\"down\">{_num(prior4)} 亿</b>，"
        f"今天回补 <b>{refill_pct_text}</b>。" if prior4 < 0 and ths_net > 0
        else f"全 A 主动买卖净额（同花顺口径）。今日 <b>{_num(ths_net)} 亿</b>，前 4 日 <b>{_num(prior4)} 亿</b>。"
    )
    margin_desc = (
        f"融资余额（{margin_date}）。4 个交易日 <b class=\"down\">{_num(margin_chg4)} 亿</b>，"
        f"5 日 <b class=\"down\">{_num(margin_chg5)} 亿</b>。今天上涨不是杠杆推的。"
        if margin_chg4 < 0 else
        f"融资余额（{margin_date}）。4 个交易日 <b class=\"up\">{_num(margin_chg4)} 亿</b>，"
        f"5 日 <b class=\"up\">{_num(margin_chg5)} 亿</b>；杠杆开始回补。"
    )
    etf_desc = (
        f"{etf.get('decomp', {}).get('start', '')} 至 {etf.get('decomp', {}).get('end', '')} 的 5 日净申购；"
        f"{etf_date} 单日 <b>{_num(etf_net)} 亿</b>。其中大盘宽基占比约 "
        f"<b>{(hs300.get('share', 0) + sz50.get('share', 0)):.0f}%</b>。"
    )

    zt_ladder = zt.get("ladder", {})
    fourth = int(zt_ladder.get("4", 0) or 0)
    third = int(zt_ladder.get("3", 0) or 0)
    if fourth == 0 and third <= 1:
        zt_note = (
            f"3 板仅 {third} 家、4 板空缺——普涨特征明显，接力意愿不强。"
            "明天看的是“首板晋级率”，不是涨停总数。"
        )
    else:
        zt_note = (
            f"首板 {zt.get('first', 0)}、2 板 {zt.get('second', 0)}、3 板 {third}、4 板 {fourth}；"
            "高度和接力意愿看明天首板晋级率。"
        )
    series = margin.get("series", [])
    if series:
        peak = max(series, key=lambda x: x.get("total", 0))
        margin_note = (
            f"{peak.get('date', '')} 见顶 {peak.get('total', 0):,.0f} 亿，"
            f"{margin_date} 回落至 {margin_total:,.0f} 亿；杠杆资金在科技抛售中持续降仓。"
        )
    else:
        margin_note = f"最新融资余额 {margin_total:,.0f} 亿（{margin_date}）。"

    top3 = top_in[:3]
    topin_note = "、".join(f"{_name(x.get('name'))} {_num(x.get('net'))}（5日 {_num(x.get('d5'))}）" for x in top3) + "。"
    out3 = top_out[:3]
    topout_note = "、".join(f"{_name(x.get('name'))} {_num(x.get('net'))}（5日 {_num(x.get('d5'))}）" for x in out3) + "。"
    div = d.get("divergence", {}).get("big_buy_sell", [])[:3]
    stock_note = (
        "、".join(f"{_name(x.get('name'))} 超大单 {_num(x.get('super'))} / 全单 {_num(x.get('net'))}" for x in div)
        + "——大单买、中小单卖，更像游资/量化大单接力，不宜直接当成机构建仓。"
        if div else "今天没有明显的“大单买、全单卖”分歧。"
    )
    lhb_note = lhb.get("note", "")

    # industry notes
    ind_top = _pick_top(industries, "net", 3)
    ind_bottom = _pick_bottom(industries, "net", 3)
    ind5_top = _pick_top(industries, "net5", 2)
    ind5_bottom = _pick_bottom(industries, "net5", 2)
    industry_note = (
        f"今日：{_join_names(ind_top)} 净流入靠前；{_join_names(ind_bottom)} 净流出靠前。"
        f"5 日：{_join_names(ind5_top)} 靠前，{_join_names(ind5_bottom)} 靠后。"
        f"今天的强，要放到 5 日/10 日里看，不能只看单日。"
    )
    left_top = sorted(
        [x for x in industries if x.get("net", 0) > 0 and x.get("net5", 0) < 0],
        key=lambda x: x.get("net", 0), reverse=True)[:4]
    right_bottom = sorted(
        [x for x in industries if x.get("net", 0) < 0 and x.get("net5", 0) > 0],
        key=lambda x: x.get("net", 0))[:3]
    scatter_note = (
        f"左上角最密集：{_join_names(left_top)}——今天涨/流入，但 5 日仍是净流出，属于回补。"
        f"右下角：{_join_names(right_bottom)}——5 日流入、今天流出，是今天的“提款机”。"
    )
    concept_exclude = ["融资融券", "深股通", "沪股通", "2026中报预增", "人民币贬值受益", "证金持股", "高股息精选",
                       "同花顺漂亮100", "同花顺中特估100", "超级品牌"]
    ctop = [x for x in concepts if x.get("name") not in concept_exclude]
    ctop = _pick_top(ctop, "net", 3)
    c5 = _pick_top([x for x in concepts if x.get("name") not in concept_exclude], "net5", 3)
    concept_note = (
        f"今日：{_join_names(ctop)}；5 日仍靠前的是 {_join_names(c5)}。"
        "主题资金是脉冲还是趋势，看 5 日能否接上。"
    )
    refill_note = (
        f"按“今日净额 / |前 4 日净额|”排序：行业里回补比例最高的是 "
        f"{_join_names(d.get('flow_quality', {}).get('industries', [])[:4])}。"
        "比例超过 100% 才算新钱，50%–100% 是强回补，低于 50% 只是弱回补。"
    )
    stock_quality_note = (
        f"新钱榜：{_join_names(stocks.get('new_money', [])[:4])}；"
        f"强回补：{_join_names(stocks.get('strong_refill', [])[:4])}；"
        f"持续流入：{_join_names(stocks.get('steady_inflow', [])[:4])}。"
        "新钱是“前 4 日卖、今天买回更多”，持续流入是“前 4 日已在买、今天继续买”。"
    )
    conclusion = (
        f"<strong>今天的结论：</strong>大资金在买，但买法是“ETF 托底 + 龙头集中加仓”，不是全面建仓。"
        f"ETF 5 日 {_num(etf_d5)} 亿，主动全单今天 {_num(ths_net)} 亿、前 4 日 {_num(prior4)} 亿，"
        f"融资余额 4 日 {_num(margin_chg4)} 亿。要确认“逐渐建仓”升级为“全面加仓”，至少看三个信号："
        "① 通信设备/半导体连续 2–3 日净流入；② 融资余额止跌回升；③ 光模块龙头继续放量、不出现高位放量长阴。"
    )
    method_note = (
        "工作日 11:36 起抓午盘快照；收盘后 16:10 抓正式版、17:10 补龙虎榜并二次更新。"
        "午盘与收盘同页切换，数据源失败时保留上一版并在页面注明。"
    )
    footer_date = f"{d.get('date', '')} · {d.get('weekday', '')}"

    return {
        "hero_title": hero_title,
        "hero_dek": hero_dek,
        "lead_cards": lead_cards,
        "signals": signals,
        "reversal_note": reversal_note,
        "flows_note": flows_note,
        "etf_note": etf_note,
        "etf_decomp_note": etf_decomp_note,
        "active_desc": active_desc,
        "margin_desc": margin_desc,
        "etf_desc": etf_desc,
        "signal_note": "升级为“全面加仓”的三个确认条件：① 通信设备/半导体连续 2–3 日净流入；② 融资余额止跌回升；③ 光模块龙头继续放量且不出现高位放量长阴。少一个，都只能定义为“结构性建仓”。",
        "zt_note": zt_note,
        "margin_note": margin_note,
        "conclusion": conclusion,
        "industry_note": industry_note,
        "scatter_note": scatter_note,
        "concept_note": concept_note,
        "stock_note": stock_note,
        "topin_note": topin_note,
        "divergence_note": "这不是“机构建仓”的证据，更像大单/游资在涨停板上接货、中小单兑现。要看次日能否继续封板、有没有机构席位接力。",
        "lhb_note": lhb_note,
        "topout_note": topout_note,
        "refill_note": refill_note,
        "stock_quality_note": stock_quality_note,
        "method_note": method_note,
        "footer_date": footer_date,
    }
