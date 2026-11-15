"""Fixed-price, fixed-reference ETF channel inventory. Never a named-account position."""
from __future__ import annotations
import math


def convert_units(code,shares,day,target,actions):
    """Convert native shares into target-date units, including later consolidations."""
    lo,hi=sorted([day,target]);factor=1.
    for action in actions:
        if action['code']==code and lo<action['effective_date']<=hi:
            if action.get('status')!='verified':raise ValueError('存在未核验份额行动')
            ratio=float(action['share_ratio'])
            if not math.isfinite(ratio) or ratio<=0:raise ValueError('份额行动比例无效')
            factor*=ratio
    return shares*factor if day<=target else shares/factor


def summarize(series,calendar,end,actions,config,expected_members):
    """Freeze the reference/price weights; only current shares change daily.

    All endpoints use the vendor-estimate ledger; official recent series remain
    separate. Missing current members suppress the complete metric, never fill 0.
    """
    members=sorted(config['items']);expected=sorted(expected_members)
    if members!=expected:raise ValueError('存量基准成员与固定核心池不一致；须升版本重建基准')
    if not config['reference_date']<config['cycle_anchor_date']<config['cycle_start']:
        raise ValueError('上一轮与本轮锚点日期顺序无效')
    units=float(config['baseline_units'])
    if units<=0 or not math.isfinite(units):raise ValueError('归一化基准无效')
    prices={};reference=initial=alternative=0.;components=[]
    for c,v in config['items'].items():
        price=float(v['fixed_price']);nums=[float(v[k]) for k in ['reference_shares','cycle_start_shares','alternative_shares']]
        if price<=0 or not math.isfinite(price) or any(x<=0 or not math.isfinite(x) for x in nums):raise ValueError('存量锚点数字无效 '+c)
        prices[c]=price
        ref=convert_units(c,nums[0],config['reference_date'],config['price_date'],actions)*price/1e8
        start=convert_units(c,nums[1],config['cycle_anchor_date'],config['price_date'],actions)*price/1e8
        alt=convert_units(c,nums[2],config['alternative_reference_date'],config['price_date'],actions)*price/1e8
        reference+=ref;initial+=start;alternative+=alt
        components.append(dict(code=c,name=v['name'],reference_yi=ref,cycle_start_yi=start))
    by={c:{r['date']:r for r in series.get(c,[])} for c in members}
    def point(day):
        values=[];missing=[]
        for c in members:
            r=by[c].get(day)
            try:
                if end<config['price_date']:raise ValueError('固定价格锚点晚于数据日，不作当时已知指标')
                if not r:raise ValueError('当日数据缺失')
                if r.get('share_source')!='vendor_turnover_estimate':raise ValueError('不得混入不同份额口径')
                # Unresolved actions contaminate later levels too, not only that day's flow.
                if any('unregistered_share_action_quarantined' in x.get('flags',[]) for d,x in by[c].items()
                       if min(config['reference_date'],config['alternative_reference_date'])<=d<=day):raise ValueError('未解决的份额行动')
                sh=float(r['shares'])
                if not math.isfinite(sh) or sh<=0:raise ValueError('份额无效')
                val=convert_units(c,sh,day,config['price_date'],actions)*prices[c]/1e8
                values.append((c,val))
            except (ValueError,KeyError,TypeError) as exc:missing.append(dict(code=c,reason=str(exc)))
        complete=not missing;total=sum(v for _,v in values) if complete else None
        return dict(date=day,complete=complete,valid_members=len(values),expected_members=len(members),missing=missing,
            current_yi=total,net_added_yi=total-initial if complete else None,
            total_units=total/reference*units if complete else None,
            net_added_units=(total-initial)/reference*units if complete else None,
            current_ratio=total/reference if complete else None,
            alternative_units=total/alternative*units if complete else None,
            components=[dict(code=c,current_yi=v) for c,v in values])
    days=[d for d in calendar if config['cycle_start']<=d<=end]
    points=[point(d) for d in days]
    latest=points[-1] if points and points[-1]['date']==end else point(end)
    return dict(version=config['version'],date=end,complete=latest['complete'],latest=latest,
        baseline_units=units,reference_date=config['reference_date'],reference_label=config['reference_label'],
        cycle_start=config['cycle_start'],cycle_anchor_date=config['cycle_anchor_date'],price_date=config['price_date'],
        alternative_reference_date=config['alternative_reference_date'],alternative_label=config['alternative_label'],
        reference_yi=reference,cycle_start_yi=initial,cycle_start_units=initial/reference*units,
        alternative_reference_yi=alternative,members=members,components=components,series=points,
        source_kind=config['source_kind'],identity=config['identity'],provenance=config['provenance'],
        method='固定参考份额、固定价格权重；当日同源反推份额归一为上一轮10份',
        limitations=['ETF全部持有人通道存量，不能归属于国家队实名账户',
            '本轮净新增为起点至今的恒价存量差，已含净减少；非毛买入金额或实际现金流',
            '历史反推份额存在分母、舍入及修订风险；当前正式份额另列，不混接口径',
            f"固定{config['price_date']}价格权重，价格单独变化不会使指标跳动；锚点修订须升版本"])
