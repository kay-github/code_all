# -*- coding: utf-8 -*-
"""三阶段版本：盘中线索 / 盘后初值 / 次日权威。

三个阶段的数据来源、可信度、展示位置都不同，不能互相替代：

  盘中（intraday）  浏览器端实时快照，逐笔方向缺失，只能给线索，不给份额。
  盘后（provisional）T 日收盘数据 + 供应商换手率反推份额；T 日分母可能仍是昨收份额，
                    收盘后会被修订，因此只能作初值，不得进入正式区。
  次日（verified）   交易所 T+1 早间更新的正式份额，经复核后发布，才是可引用的定稿。

本模块只负责把盘后初值整理成可发布的结构，不判断身份、不写正式区。
"""
from __future__ import annotations

import statistics

from v2_common import now

# 反推份额与前一交易日几乎完全一致，说明 T 日换手率分母仍用昨收份额，
# 当日净申赎被系统性抹成 0。严格阈值只用于「提示已抹平」，不用于修正数据。
FLAT_TOL = 1e-5
# 宽口径：比值贴近 1 但不是精确 1，可能是真小额申赎，也可能只是舍入。
# 单独统计，避免把「接近不动」当成「确认抹平」。
NEAR_TOL = 1e-3

STAGE_CONFIDENCE = dict(
    intraday='线索级：实时快照，无可靠逐笔方向，不产生份额',
    postclose='初值级：T 日反推份额，可能被事后修订，不可作定稿',
    verified='定稿级：交易所正式份额，经次日复核',
)


def _pair(rows):
    xs = [r for r in rows if r.get('shares')]
    if len(xs) < 2:
        return None, None
    return xs[-2], xs[-1]


def share_ratios(series, members):
    """当日反推份额 / 前一交易日反推份额。比值≈1 说明分母可能没换。"""
    out = []
    for code in members:
        prev, cur = _pair(series.get(code, []))
        if not prev or not cur or not prev.get('shares'):
            continue
        out.append(dict(code=code, date=cur.get('date'), ratio=cur['shares'] / prev['shares']))
    return out


def flattened_members(series, members):
    """严格口径：比值落在 1±FLAT_TOL，判定当日净申赎被抹平。"""
    return [dict(code=x['code'], date=x['date'], ratio=round(x['ratio'], 6))
            for x in share_ratios(series, members) if abs(x['ratio'] - 1) < FLAT_TOL]


def build(a, series, at=None):
    """由一次构建的分析结果与账本序列，整理出盘后初值摘要。"""
    at = at or now()
    end = a['end']
    core = a.get('pools', {}).get('core15', {})
    latest = core.get('latest') or {}
    members = core.get('members') or []
    ex = a.get('exchange') or {}
    exl = ex.get('latest') or {}
    ex_items = ex.get('instruments') or {}
    inv = (a.get('inventory') or {}).get('latest') or {}

    flat = flattened_members(series, members)
    ratios = share_ratios(series, members)
    near = [x for x in ratios if abs(x['ratio'] - 1) < NEAR_TOL]
    median = statistics.median([x['ratio'] for x in ratios]) if ratios else None
    amounts = {}
    for code in members:
        for row in series.get(code, []):
            if row.get('date') == end and row.get('amount'):
                amounts[code] = row['amount']
                break
    amount_yi = round(sum(amounts.values()), 2)
    disclosed = sum(
        1 for code in members
        if ((ex_items.get(code) or {}).get('latest') or {}).get('date') == end
    )

    vendor_net = latest.get('net')
    vendor_complete = bool(latest.get('complete')) and latest.get('valid_members') == latest.get('expected_members')
    # 反推口径永远不是「可信份额」：即使没有抹平痕迹，分母本身也未经验证。
    reliable = False
    reasons = ['供应商换手率反推，分母口径未经验证']
    if flat:
        reasons.append('%d/%d 只的份额比值落在 1.0000±%g，当日净申赎疑似被抹平' % (len(flat), len(members), FLAT_TOL))
    if disclosed < len(members):
        reasons.append('交易所正式份额当日仅披露 %d/%d 只' % (disclosed, len(members)))

    revision_risk = (
        'T 日换手率分母可能仍是昨收份额，收盘后才换成当日登记份额；'
        '11-13 实测 94/254 只被修订，核心15由 −24.9 亿修正为 −123.7 亿。'
        '本页初值不能当定稿，也不能据此判断国家队当日买卖。'
    )

    return dict(
        stage='postclose_provisional',
        stage_label='盘后初值',
        confidence='provisional',
        confidence_note=STAGE_CONFIDENCE['postclose'],
        business_date=end,
        generated_at=at,
        build_id=a['build_id'],
        built_at=a.get('built_at'),
        pending_review=True,
        superseded_by=None,
        official=dict(
            disclosure_stage=ex.get('stage'),
            coverage=disclosed,
            expected=len(members),
            complete=bool(exl.get('complete')) and disclosed == len(members),
            net_yi=exl.get('net_estimate'),
            valid_members=exl.get('valid_members'),
        ),
        vendor=dict(
            net_yi=vendor_net,
            net_low_yi=latest.get('net_low'),
            net_high_yi=latest.get('net_high'),
            valid_members=latest.get('valid_members'),
            expected_members=latest.get('expected_members'),
            complete=vendor_complete,
            amount_yi=amount_yi,
            reliable=reliable,
            reasons=reasons,
        ),
        inventory=dict(
            total_units=inv.get('total_units'),
            net_added_units=inv.get('net_added_units'),
            current_ratio=inv.get('current_ratio'),
            complete=bool(inv.get('complete')),
            provisional=True,
        ),
        flattened=dict(count=len(flat), members=flat,
                       near_count=len(near),
                       ratio_median=None if median is None else round(median, 6),
                       note='严格抹平按 1±%g 判定；near_count 为 1±%g 的宽口径，含真实小额申赎' % (FLAT_TOL, NEAR_TOL)),
        revision_risk=revision_risk,
        next_step='次日 10:00 复核交易所正式份额后发布权威版本；本初值届时自动标记为已被替代',
        identity='I0 当日买卖主体未确认',
        limitation='初值只反映 T 日收盘口径的通道变化，不能归属到国家队实名账户',
    )


def mark_superseded(summary, build_id):
    """次日权威版本发布后调用：把盘后初值标记为已被替代，不删除原值。"""
    if not summary:
        return summary
    out = dict(summary)
    out['pending_review'] = False
    out['superseded_by'] = build_id
    out['next_step'] = '已由权威构建 %s 复核替代；初值保留用于回看当时的判断依据' % build_id
    return out
