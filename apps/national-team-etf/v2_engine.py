"""Pure calculations: consistent native units, bounded estimates, causal risk episodes.

Identity evidence and risk are independent. No function infers a named trader from flow alone.
"""
from __future__ import annotations
from collections import defaultdict
import math
from v2_common import quantile

def normalize(code, raw_rows, calendar, actions=(), official=(), start='2024-05-01', end='9999-12-31'):
    days=set(calendar); previous_day={d:calendar[i-1] if i else None for i,d in enumerate(calendar)}
    action_by_day={x['effective_date']:x for x in actions if x['code']==code and x['status']=='verified'}
    direct={x['date']:x for x in official if x['code']==code and x.get('scope')=='exchange_traded'
            and x.get('unit_basis')=='native' and x.get('source') and x.get('published_at')}
    parsed={};conflicts=set();issues=[]
    for row in raw_rows:
        if not row or not start<=row[0]<=end:
            continue
        d=row[0]
        if d not in days:
            issues.append(dict(code=code,date=d,kind='outside_exchange_calendar'));continue
        try:
            o,c,h,l,v,tr,amt=[float(row[i]) for i in [1,2,3,4,5,7,8]]
            if not all(math.isfinite(x) and x>0 for x in (o,c,h,l,v,tr,amt)):
                raise ValueError('nonpositive/nonfinite OHLCV/turnover/amount')
            px=amt*100/v
            if not l-.002<=px<=h+.002 or not l-.002<=c<=h+.002:
                raise ValueError('incompatible unadjusted price/volume/amount')
            if tr<=.005:
                raise ValueError('turnover rounding bound is unbounded')
            estimate=v*10000/tr
            r=dict(code=code,date=d,open=o,close=c,high=h,low=l,vol_hand=v,turnover=tr,
                   amount=amt/10000,vwap=px,shares=estimate,
                   share_low=v*10000/(tr+.005),share_high=v*10000/(tr-.005),
                   share_source='vendor_turnover_estimate',share_scope='vendor_denominator_unverified',
                   market_value=estimate*c/1e8,flags=[],net=None,net_low=None,net_high=None,
                   previous_date=previous_day[d],share_factor=1.)
            if d in direct:
                item=direct[d]
                if not isinstance(item['shares'],(int,float)) or item['shares']<=0:
                    raise ValueError('invalid official shares')
                r.update(shares=float(item['shares']),share_low=float(item['shares']),share_high=float(item['shares']),
                         share_source='official_registered',share_scope=item['scope'],official_source=item['source'],
                         official_published_at=item['published_at'],market_value=item['shares']*c/1e8)
                if abs(estimate/item['shares']-1)>.005:
                    r['flags'].append('vendor_official_share_mismatch')
            if d in parsed and parsed[d]!=r:
                conflicts.add(d)
            parsed[d]=r
        except (ValueError,TypeError,IndexError,ZeroDivisionError) as exc:
            issues.append(dict(code=code,date=d,kind='invalid_bar',error=str(exc)))
    for d in conflicts:
        parsed.pop(d,None);issues.append(dict(code=code,date=d,kind='conflicting_duplicate'))
    first=min(parsed) if parsed else None
    for d,r in sorted(parsed.items()):
        a=action_by_day.get(d)
        ratio=float(a['share_ratio']) if a else 1.
        r['share_factor']=ratio
        if a:
            r['flags'].append('verified_share_action_applied')
        p=parsed.get(previous_day[d])
        if not p:
            r['flags'].append('initial_no_prior' if d==first else 'gap_no_daily_flow')
            continue
        raw_ratio=r['shares']/p['shares']
        if not a and abs(raw_ratio-1)>.30 and abs(raw_ratio*r['close']/p['close']-1)<.12:
            r['flags'].append('unregistered_share_action_quarantined')
            issues.append(dict(code=code,date=d,kind='unregistered_share_action',share_ratio=raw_ratio))
            continue
        px=r['vwap']/1e8
        r['net']=(r['shares']-p['shares']*ratio)*px
        r['net_low']=(r['share_low']-p['share_high']*ratio)*px
        r['net_high']=(r['share_high']-p['share_low']*ratio)*px
        if r['net_low']<=0<=r['net_high']:
            r['flags'].append('flow_within_rounding_uncertainty')
        r['flow_ratio']=r['net']/p['market_value'] if p['market_value'] else None
    return list(sorted(parsed.values(),key=lambda r:r['date'])),issues

def window(records, dates):
    """Coefficients preserve shared endpoint errors; never add independent daily error bands."""
    by=records if isinstance(records,dict) else {r['date']:r for r in records}
    coeff=defaultdict(float);net=0.;valid=neg=pos=neg_point=0
    for d in dates:
        r=by.get(d)
        if r is None or r['net'] is None:
            continue
        valid+=1;net+=r['net'];neg+=r['net_high']<0;pos+=r['net_low']>0;neg_point+=r['net']<0
        coeff[d]+=r['vwap']/1e8
        coeff[r['previous_date']]-=r['vwap']*r['share_factor']/1e8
    low=high=0.
    for d,c in coeff.items():
        r=by[d]
        low+=c*(r['share_low'] if c>=0 else r['share_high'])
        high+=c*(r['share_high'] if c>=0 else r['share_low'])
    return dict(net=net if valid else None,low=low if valid else None,high=high if valid else None,
                valid=valid,expected=len(dates),complete=valid==len(dates) and bool(dates),
                negative_days=neg,negative_point_days=neg_point,positive_days=pos)

def combine_windows(windows, expected_members=None):
    ws=list(windows);valid=[w for w in ws if w['net'] is not None]
    base=sum(w.get('base_market_value') or 0 for w in ws)
    return dict(net=sum(w['net'] for w in valid) if valid else None,
                low=sum(w['low'] for w in valid) if valid else None,
                high=sum(w['high'] for w in valid) if valid else None,
                complete=bool(ws) and all(w['complete'] for w in ws) and (expected_members is None or len(ws)==expected_members),
                members=len(ws),valid_members=len(valid),base_market_value=base,
                ratio=sum(w['net'] for w in valid)/base if valid and base else None)

def metrics(records, calendar, peak_sessions=63, rolling_history=120, min_history=30):
    """One prefix at a time: no future threshold, price, peak, or regime selection."""
    by={r['date']:r for r in records};out=[];past_ratios=[]
    cumulative={};f=1.
    for d,r in sorted(by.items()):
        f*=r['share_factor'];cumulative[d]=f
    for i,d in enumerate(calendar):
        r=by.get(d)
        if r is None:
            continue
        m=dict(date=d,net=r['net'],net_low=r['net_low'],net_high=r['net_high'],
               shares=r['shares'],share_low=r['share_low'],share_high=r['share_high'],
               market_value=r['market_value'],close=r['close'],flags=r['flags'],flow_ratio=r.get('flow_ratio'))
        for n in (5,10,20):
            dates=calendar[max(0,i-n+1):i+1]
            w=window(by,dates)
            w['complete']=w['complete'] and len(dates)==n
            prev=by.get(by.get(dates[0],{}).get('previous_date'))
            w['base_market_value']=prev['market_value'] if prev else None
            w['ratio']=w['net']/prev['market_value'] if prev and w['net'] is not None and prev['market_value'] else None
            m['w'+str(n)]=w
        last_unverified=max((x for x in by if x<=d and 'unregistered_share_action_quarantined' in by[x]['flags']),default='0000')
        prior=[by[x] for x in calendar[max(0,i-peak_sessions+1):i+1] if x in by and x>=last_unverified]
        # All shares must first be expressed in today's units across any verified action.
        def comparable(x):
            factor=cumulative[d]/cumulative[x['date']]
            return x['shares']*factor,x['share_low']*factor
        pk=max(prior,key=lambda x:comparable(x)[0])
        peak,peak_low=comparable(pk)
        m.update(peak_date=pk['date'],peak_shares=peak,share_dd=max(0,1-r['shares']/peak),
                 share_dd_robust=max(0,1-r['share_high']/peak_low))
        hist=past_ratios[-rolling_history:]
        m['prior_flow_p10']=quantile(hist,.1) if len(hist)>=min_history else None
        prior_amount=[by[x]['amount'] for x in calendar[max(0,i-20):i] if x in by]
        m['volume_ratio']=r['amount']/(sum(prior_amount)/20) if len(prior_amount)==20 and sum(prior_amount)>0 else None
        out.append(m)
        if r.get('flow_ratio') is not None:
            past_ratios.append(r['flow_ratio'])
    return out

def risk_step(m, memory, rules):
    """Persistent episode; no national-team identity claim and no cost/policy gate."""
    memory=dict(memory or dict(active=False,peak_level=0,positive_streak=0,episode_start=None,negative_window_streak=0))
    if m['net'] is None or not m['w5']['complete']:
        return dict(level=None,state='数据不足',why=['缺少连续交易日的有效份额，保留既有观察状态'],memory=memory)
    w5,w10=m['w5'],m['w10'];ratio=w5.get('ratio') or 0
    clear_negative=w5['high']<0
    memory['negative_window_streak']=memory.get('negative_window_streak',0)+1 if clear_negative else 0
    sustained=(w5.get('negative_point_days',w5.get('negative_days',0))>=rules['persistent_negative_days'] or
               (m.get('share_dd_robust',0)>rules['persistent_share_dd'] and memory['negative_window_streak']>=2))
    persistent=(clear_negative and sustained
                and (ratio < -rules['watch_flow5_ratio'] or m.get('share_dd_robust',0)>rules['persistent_share_dd']))
    if w10['complete'] and w10['high']<0 and (w10.get('ratio') or 0)<-rules['watch_flow5_ratio']:
        persistent=True
    accelerated=persistent and (ratio < -rules['accelerated_flow5_ratio'] or
                  (m.get('flow_ratio') is not None and m['flow_ratio'] < -rules['accelerated_flow1_ratio']))
    clues=w5['net']<0 or m['net_high']<0 or (m.get('share_dd_robust',0)>.002 and w10.get('net') is not None and w10['net']<0)
    raw_level=3 if accelerated else 2 if persistent else 1 if clues else 0
    why=[]
    recovering=(w5['low']>0 and w10['complete'] and w10['low']>0)
    if memory['active'] and raw_level<2 and recovering:
        memory['positive_streak']+=1
        if memory['positive_streak']>=rules['release_positive_days']:
            memory.update(active=False,peak_level=0,episode_start=None,positive_streak=0)
            return dict(level=0,state='观察解除',why=['连续多个交易日5日及10日累计均稳健回补，解除旧事件'],memory=memory)
        return dict(level=0,state='恢复承接待确认',why=['累计回补正在恢复；一次回补不自动清除旧事件'],memory=memory)
    if raw_level:
        if not memory['active']:
            memory.update(active=True,episode_start=m['date'],peak_level=0)
        memory['peak_level']=max(memory['peak_level'],raw_level)
        memory['positive_streak']=0
        state={1:'流出线索',2:'持续流出',3:'流出加速'}[raw_level]
        if raw_level==1 and memory['peak_level']>=2:
            state='流出观察持续'
        why.append('5日/10日累计、份额回撤和持续性联合判断；资金身份另行核验')
        if raw_level==1 and w5['low']<=0<=w5['high']:
            why.append('累计变化仍在换手率舍入误差内，暂不升级')
    elif memory['active']:
        memory['positive_streak']=0
        state='流出暂缓';why.append('单日回补不抹去此前流出；尚未满足连续恢复条件')
    else:
        state='未见持续流出';why.append('当前未触发流出观察条件')
    return dict(level=raw_level,state=state,why=why,memory=memory)

def identity(code, day, evidence, core=False):
    usable=[x for x in evidence if x.get('status')=='verified' and x.get('source') and
            x.get('published_at','9999')[:10]<=day and x.get('event_date','9999')<=day and
            (code in x.get('codes',[]) or x.get('scope')=='market')]
    # An old signed holding is not evidence for today's buy/sell direction.
    transactions=[x for x in usable if x.get('kind')=='signed_transaction' and x['event_date']==day and code in x.get('codes',[])]
    holdings=[x for x in usable if x.get('kind')=='named_holding' and code in x.get('codes',[])]
    announcements=[x for x in usable if x.get('kind')=='announcement' and (day<=x.get('valid_until',x['event_date']))]
    if transactions:
        level='I3 当日实名证据';direction=transactions[-1].get('direction','unknown')
    elif announcements or holdings:
        level='I2 有公开关联证据';direction='unconfirmed'
    elif core:
        level='I1 核心通道线索';direction='unconfirmed'
    else:
        level='I0 身份未知';direction='unconfirmed'
    return dict(level=level,direction=direction,evidence=usable,
                conclusion='当日实名交易有公开证据' if transactions else '当日买卖主体未确认',
                alternatives=['配置与再平衡','套利申赎','其他机构或个人交易','二级市场买卖可不改变总份额'])

def behavior_clues(m, same_direction_families=0, core=False):
    """A review queue, not an attribution probability or named-account confirmation."""
    clues=[]
    if m is None or m['net'] is None:
        return dict(label='数据不足',conditions=[],direction='unknown',identity_confirmed=False)
    w=m['w5'];direction='redemption' if w['complete'] and w['high']<0 else 'subscription' if w['complete'] and w['low']>0 else 'uncertain'
    if direction!='uncertain' and abs(w.get('ratio') or 0)>=.005:
        clues.append('5日变化超出舍入误差且占期初规模至少0.5%')
    if m.get('prior_flow_p10') is not None and m.get('flow_ratio') is not None and m['flow_ratio']<m['prior_flow_p10']:
        clues.append('单日流出强于此前历史第10分位')
    if m.get('volume_ratio') is not None and m['volume_ratio']>=1.5:
        clues.append('成交额高于此前20日均额1.5倍')
    if same_direction_families>=3 and direction!='uncertain':
        clues.append(f'{same_direction_families}个核心指数家族的5日变化方向一致')
    if m.get('share_dd_robust',0)>=.01:
        clues.append('份额回撤超出舍入误差至少1%')
    label='优先核查的资金行为候选' if len(clues)>=3 and core else '保留行为线索' if clues else '暂无足够行为证据'
    return dict(label=label,conditions=clues,direction=direction,identity_confirmed=False,
                note='观察条件可能相关；满足项数不是独立证据数、概率或国家队身份确认')

def family_metrics(members, all_metrics, calendar):
    maps={c:{x['date']:x for x in all_metrics.get(c,[])} for c in members};out=[]
    for calendar_i,d in enumerate(calendar):
        expected=[c for c in members if maps[c] and min(maps[c])<=d]
        rows=[maps[c][d] for c in expected if d in maps[c]]
        if not rows:
            continue
        good=[r for r in rows if r['net'] is not None]
        complete=len(good)==len(expected)
        m=dict(date=d,net=sum(r['net'] for r in good) if complete else None,
               net_low=sum(r['net_low'] for r in good) if complete else None,
               net_high=sum(r['net_high'] for r in good) if complete else None,
               market_value=sum(r['market_value'] for r in rows),
               expected_members=len(expected),valid_members=len(good),coverage=len(good)/len(expected),
               flags=[],shares=None,share_dd=0,share_dd_robust=0,flow_ratio=None)
        for n in (5,10,20):
            w=combine_windows([x['w'+str(n)] for x in rows],len(expected))
            # Days where the whole channel has clear negative flow, rather than sum of fund-day counts.
            m['w'+str(n)]=w
        prior_day=calendar[calendar_i-1] if calendar_i else None
        prior=[maps[c].get(prior_day) for c in expected]
        prior_value=sum(x['market_value'] for x in prior) if prior and all(x and x['market_value'] is not None for x in prior) else None
        m['flow_ratio']=m['net']/prior_value if m['net'] is not None and prior_value else None
        m['outflow_breadth']=sum(x['net_high']<0 for x in good)/len(good) if good else None
        m['volume_ratio']=None
        out.append(m)
    for i,m in enumerate(out):
        for n in (5,10,20):
            m['w'+str(n)]['negative_days']=sum(x['net_high'] is not None and x['net_high']<0 for x in out[max(0,i-n+1):i+1])
            m['w'+str(n)]['negative_point_days']=sum(x['net'] is not None and x['net']<0 for x in out[max(0,i-n+1):i+1])
    return out
