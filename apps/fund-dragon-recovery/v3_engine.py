"""Causal return-exposure estimates, not reconstructed shareholdings.

All market loadings are free. Separate target contrast accounts for unequal holdings.
Changes compare disjoint trading-day windows and use a joint HAC covariance matrix.
"""
from __future__ import annotations
import math
import numpy as np


def price_returns(rows,calendar):
    by={};conflicts=set()
    for r in rows:
        d=r[0];v=float(r[2])
        if not math.isfinite(v) or v<=0:continue
        if d in by and by[d]!=v:conflicts.add(d)
        by[d]=v
    for d in conflicts:by.pop(d,None)
    out={}
    for i,d in enumerate(calendar):
        if i and d in by and calendar[i-1] in by:out[d]=(by[d]/by[calendar[i-1]]-1)*100
    return out


def nav_returns(rows,calendar):
    by={};issues=[];conflicts=set();previous=None;valid={}
    previous_day={d:calendar[i-1] if i else None for i,d in enumerate(calendar)}
    for row in rows:
        d=row['date']
        if d in by and by[d]!=row:conflicts.add(d)
        by[d]=row
    for d in conflicts:by.pop(d,None);issues.append(dict(date=d,kind='conflicting_nav'))
    for d,row in sorted(by.items()):
        if d not in previous_day:continue
        p=by.get(previous_day[d]);r=row.get('ret')
        if not p or r is None:
            issues.append(dict(date=d,kind='missing_adjacent_nav_or_return'));continue
        if not math.isfinite(float(r)) or float(r)<=-100:continue
        implied=(row['nav']/p['nav']-1)*100
        # A disclosed distribution/split can make unit NAV fall without an investment loss.
        if abs(implied-r)>.15 and not row.get('distribution'):
            issues.append(dict(date=d,kind='nav_return_conflict',published_return=r,unit_nav_return=implied));continue
        valid[d]=float(r)
    return valid,issues


def make_factors(prices,indices,calendar,securities,min_peer_coverage=.9):
    returns={c:price_returns(x.get('rows',[]),calendar) for c,x in prices.items()}
    markets={c:price_returns(rs,calendar) for c,rs in indices.items()}
    out={};issues=[]
    # Fixed membership across every model/holdout window prevents changing peer
    # composition from masquerading as an exposure change.
    recent=calendar[-80:]
    fixed={g:[c for c in securities[g] if all(d in returns.get(c,{}) for d in recent)] for g in ['peer_broad','peer_core']}
    for d in calendar:
        target=[returns.get(c,{}).get(d) for c in ['300502','300308']]
        m=[markets.get(c,{}).get(d) for c in ['sh000300','sz399006']]
        if any(x is None for x in target+m):continue
        peers={}
        for group in ['peer_broad','peer_core']:
            members=fixed[group];v=[returns.get(c,{}).get(d) for c in members]
            good=[x for x in v if x is not None]
            peers[group]=sum(good)/len(good) if good and len(good)==len(members) and len(members)>=len(securities[group])*min_peer_coverage else None
        if any(v is None for v in peers.values()):
            issues.append(dict(date=d,kind='peer_coverage_incomplete'));continue
        avg=sum(target)/2;contrast=(target[0]-target[1])/2
        out[d]=dict(r502=target[0],r308=target[1],hs300=m[0],chinext=m[1],
            broad=peers['peer_broad'],core=peers['peer_core'],target=avg,contrast=contrast)
    return out,issues


def design(factors,days,spec='broad',extra=None):
    # de = target basket minus peer basket; the raw fund return is the dependent variable.
    X=np.asarray([[1.,factors[d]['target']-factors[d][spec],factors[d]['contrast'],
        factors[d][spec],factors[d]['hs300'],factors[d]['chinext']] for d in days],dtype=float)
    return np.column_stack([X,[extra[d] for d in days]]) if extra is not None else X


def fit_matrix(X,y,positions,lags=3):
    X=np.asarray(X,dtype=float);y=np.asarray(y,dtype=float);pos=np.asarray(positions,dtype=int)
    n,k=X.shape
    if n<=k+5 or not np.isfinite(X).all() or not np.isfinite(y).all():return dict(usable=False,reason='样本不足或非有限数据',n=n)
    scale=np.std(X,axis=0);scale[scale<1e-12]=1
    sx=X/scale
    singular=np.linalg.svd(sx,compute_uv=False);rank=int(np.linalg.matrix_rank(sx))
    condition=float(singular[0]/singular[-1]) if singular[-1]>1e-14 else None
    if rank<k:return dict(usable=False,reason='因子无法区分（矩阵秩不足）',n=n,condition=condition)
    coef=np.linalg.lstsq(X,y,rcond=None)[0];resid=y-X@coef
    bread=np.linalg.pinv(X.T@X);score=X*resid[:,None];meat=score.T@score
    # Calendar distances, rather than compressed observation positions, define the HAC lags.
    lookup={int(p):i for i,p in enumerate(pos)}
    for lag in range(1,lags+1):
        pairs=[(i,lookup[int(p)-lag]) for i,p in enumerate(pos) if int(p)-lag in lookup]
        if not pairs:continue
        a=np.asarray([i for i,j in pairs]);b=np.asarray([j for i,j in pairs])
        gamma=score[a].T@score[b];meat+=(1-lag/(lags+1))*(gamma+gamma.T)
    covariance=bread@meat@bread*n/(n-k);covariance=(covariance+covariance.T)/2
    sst=float(np.sum((y-y.mean())**2));ssr=float(resid@resid)
    return dict(usable=True,n=n,condition=condition,coef=coef,covariance=covariance,
        r2=1-ssr/sst if sst>1e-12 else None,residual_std=float(np.sqrt(ssr/(n-k))))


def idio_std(X):
    others=np.delete(X,1,axis=1);z=X[:,1]-others@np.linalg.lstsq(others,X[:,1],rcond=None)[0]
    return float(np.std(z,ddof=1)) if len(z)>1 else 0.


def summarize_fit(fit,vector,rules):
    if not fit['usable']:return {k:v for k,v in fit.items() if k not in ['coef','covariance']}
    value=float(vector@fit['coef']);var=float(vector@fit['covariance']@vector)
    se=math.sqrt(max(0,var));margin=rules['confidence_z']*se
    # Approximate model-based intervals; not intervals for the actual shareholding weight.
    p=math.erfc(abs(value/se)/math.sqrt(2)) if se>1e-12 else 1. if abs(value)<1e-12 else 0.
    return dict(usable=True,value=value,se=se,low=value-margin,high=value+margin,p_value=p,
        n=fit['n'],condition=fit['condition'],r2=fit['r2'],residual_std=fit['residual_std'])


def window_fit(returns,factors,calendar,end,n,spec,rules,extra=None):
    at=calendar.index(end);wanted=calendar[max(0,at-n+1):at+1]
    days=[d for d in wanted if d in returns and d in factors and (extra is None or d in extra)]
    if len(wanted)!=n or len(days)<n*rules['min_coverage'] or not days or days[-1]!=end:
        return dict(usable=False,reason='窗口缺日或当日净值缺失',n=len(days),expected=n)
    X=design(factors,days,spec,extra);y=np.asarray([returns[d] for d in days]);positions=[calendar.index(d) for d in days]
    fit=fit_matrix(X,y,positions,rules['hac_lags']);v=np.zeros(X.shape[1]);v[1]=1
    out=summarize_fit(fit,v,rules);out.update(start=wanted[0],end=end,expected=n,idio_std_pp=idio_std(X))
    if out.get('usable'):
        out['identifiable']=out['condition']<=rules['condition_limit'] and out['idio_std_pp']>=rules['min_idio_std_pp']
        out['stock502_sensitivity']=float((fit['coef'][1]+fit['coef'][2])/2)
        out['stock308_sensitivity']=float((fit['coef'][1]-fit['coef'][2])/2)
    return out


def change_fit(returns,factors,calendar,end,n,spec,rules,extra=None):
    at=calendar.index(end);wanted=calendar[max(0,at-2*n+1):at+1]
    if len(wanted)!=2*n:return dict(usable=False,reason='前后窗口不足',n=len(wanted))
    before=set(wanted[:n]);days=[d for d in wanted if d in returns and d in factors and (extra is None or d in extra)]
    d0=[d for d in days if d in before];d1=[d for d in days if d not in before]
    if min(len(d0),len(d1))<n*rules['min_coverage'] or not days or days[-1]!=end:
        return dict(usable=False,reason='前后窗口缺日或当日缺失',n=len(days))
    base=design(factors,days,spec,extra);recent=np.asarray([d not in before for d in days],dtype=float)
    X=np.column_stack([base*(1-recent[:,None]),base*recent[:,None]])
    y=np.asarray([returns[d] for d in days]);fit=fit_matrix(X,y,[calendar.index(d) for d in days],rules['hac_lags'])
    v=np.zeros(X.shape[1]);v[1]=-1;v[base.shape[1]+1]=1
    out=summarize_fit(fit,v,rules)
    out.update(before_start=wanted[0],before_end=wanted[n-1],recent_start=wanted[n],end=end,
        n_before=len(d0),n_recent=len(d1),idio_std_pp=min(idio_std(design(factors,d0,spec,extra)),idio_std(design(factors,d1,spec,extra))))
    if fit['usable']:
        out.update(before=float(fit['coef'][1]),recent=float(fit['coef'][base.shape[1]+1]))
        out['identifiable']=out['condition']<=rules['condition_limit'] and out['idio_std_pp']>=rules['min_idio_std_pp']
    return out


def holdout(returns,factors,calendar,end,rules):
    at=calendar.index(end);wanted=calendar[max(0,at-59):at+1];train=wanted[:-10];test=wanted[-10:]
    train=[d for d in train if d in returns and d in factors];test=[d for d in test if d in returns and d in factors]
    if len(train)<rules.get('min_holdout_train',45) or len(test)<9:return dict(usable=False,reason='留出检验缺数据')
    X=design(factors,train);Xt=design(factors,test);y=np.asarray([returns[d] for d in train]);yt=np.asarray([returns[d] for d in test])
    fit=np.linalg.lstsq(X,y,rcond=None)[0];base_cols=[0,3,4,5]
    bfit=np.linalg.lstsq(X[:,base_cols],y,rcond=None)[0]
    mse=float(np.mean((yt-Xt@fit)**2));base=float(np.mean((yt-Xt[:,base_cols]@bfit)**2))
    return dict(usable=True,train_start=train[0],train_end=train[-1],test_start=test[0],test_end=test[-1],
        model_mse=mse,control_mse=base,gain=1-mse/base if base>1e-12 else None,
        note='顺序留出的收益解释检验，不是实际仓位准确率')


def by_adjust(pvalues):
    """Benjamini-Yekutieli adjustment; repeated classes are grouped before this step."""
    m=len(pvalues)
    if not m:return []
    harmonic=sum(1/i for i in range(1,m+1));order=sorted(range(m),key=lambda i:pvalues[i]);out=[1.]*m;best=1.
    for j in range(m-1,-1,-1):
        i=order[j];best=min(best,pvalues[i]*m*harmonic/(j+1));out[i]=min(1.,best)
    return out


def signal(row,rules):
    if row.get('category')=='enhanced_index':
        return dict(level=None,label='指数增强，仅作披露与收益观察',confirmed_transaction=False)
    if row.get('nav_date')!=row['date'] or row.get('category')!='active_domestic' or row.get('nav_frequency_warning'):
        return dict(level=None,label='数据或口径不足',confirmed_transaction=False)
    fits=[row['change'][x] for x in ['broad','core']]
    if not all(x.get('usable') for x in fits):return dict(level=None,label='数据不足',confirmed_transaction=False)
    point=[x['value'] for x in fits];identifiable=all(x.get('identifiable') for x in fits)
    levels=[row['models'][spec].get('40',{}) for spec in ['broad','core']]
    explained=all(x.get('usable') and x.get('r2') is not None and x['r2']>=rules['min_model_r2'] for x in levels)
    positive_now=all(x.get('recent',-1)>0 for x in fits)
    robust=identifiable and explained and positive_now and all(x['low']>0 for x in fits) and row.get('adjusted_p',1)<=rules['fdr_q']
    pred=row.get('holdout',{});validation_ok=pred.get('usable') and pred.get('gain') is not None and pred['gain']>=rules['min_validation_gain']
    if robust and min(point)>=rules['change_threshold'] and validation_ok:
        label='较强回补/增配线索';level=3
        if row.get('fund_review',{}).get('status')!='passed':
            label='收益升温较强，待个基复核';level=2
    elif max(point)>=rules['change_threshold'] and not identifiable:
        label='升温迹象，辨识度不足';level=1
    elif min(point)>=rules['change_threshold'] and max(x.get('recent',-1) for x in fits)<=0:
        label='负向关联缓和，不足以指向回补';level=1
    elif min(point)>=rules['change_threshold'] and positive_now and max(x['p_value'] for x in fits)<=.1 and validation_ok and explained:
        label='初步升温线索';level=2
    elif min(point)>=rules['change_threshold']:
        label='点估计升温，证据不足';level=1
    elif min(point)<0<max(point) and max(point)>=rules['change_threshold']:
        label='模型分歧，保留线索';level=1
    elif max(point)<=-rules['change_threshold'] and identifiable:
        label='收益关联走弱';level=0
    elif not identifiable:
        label='辨识度不足';level=None
    else:
        f=row['models']['broad'].get('40',{})
        label='保持正向收益关联' if f.get('low') is not None and f['low']>0 else '暂无清晰升温证据';level=0
    priority=3 if robust and min(point)>=rules['change_threshold'] and validation_ok else level
    review=row.get('fund_review',{}).get('status')
    if level is not None and level>=2 and review=='not_supported':
        label='升温未获个基对照支持';level=1
    elif level==2 and review=='insufficient':
        label='初步升温，个基资料不足'
    return dict(level=level,label=label,confirmed_transaction=False,statistical_priority=priority,
        note='模型证据只用于核查顺序，不确认买入、未卖、清仓或实时仓位')


def portfolio_review(portfolio,prices,returns,factors,calendar,end,rules,period):
    """A fixed basket of known non-target holdings is an extra confound control.

    Passing is a model robustness check, never an independent holdings truth.
    Unknown holdings, turnover, and stale disclosure weights remain limitations.
    """
    base=dict(status='not_reviewed',note='未完成个基其他重仓股对照，不升级较强线索')
    if not portfolio:return base
    base.update(source=portfolio.get('source'),period=portfolio.get('period'),fetched_at=portfolio.get('fetched_at'))
    if portfolio.get('error') or portfolio.get('period')!=period:
        return dict(base,status='insufficient',reason=portfolio.get('error','持仓报告期不一致'))
    holdings=[x for x in portfolio['holdings'] if x['code'] not in ['300502','300308'] and x['weight_pct']>0]
    total=sum(x['weight_pct'] for x in holdings)
    horizon=calendar[-80:];valid=[];series={}
    for h in holdings:
        r=price_returns(prices.get(h['code'],{}).get('rows',[]),calendar)
        if all(d in r for d in horizon):valid.append(h);series[h['code']]=r
    covered=sum(h['weight_pct'] for h in valid);coverage=covered/total if total else 0.
    base.update(known_other_weight_pct=total,covered_other_weight_pct=covered,coverage=coverage,
        covered_codes=[h['code'] for h in valid],missing_codes=[h['code'] for h in holdings if h not in valid],
        note='按披露权重固定的其他重仓股篮子；只检验收益混淆，不还原当前持仓')
    if coverage<rules.get('min_portfolio_coverage',.9) or len(valid)<2:
        return dict(base,status='insufficient',reason='其他已披露重仓股的完整复权行情覆盖不足')
    extra={d:sum(h['weight_pct']*series[h['code']][d] for h in valid)/covered for d in horizon}
    changes={s:change_fit(returns,factors,calendar,end,rules['change_window'],s,rules,extra) for s in ['broad','core']}
    base['change']=changes
    if not all(x.get('usable') and x.get('identifiable') for x in changes.values()):
        return dict(base,status='insufficient',reason='加入个基对照后数据或辨识度不足')
    passed=all(x['low']>0 and x['value']>=rules['change_threshold'] and x['recent']>0 for x in changes.values())
    return dict(base,status='passed' if passed else 'not_supported',
        reason='加入已知其他重仓股后仍有正向变化区间' if passed else '加入已知其他重仓股后，原升温证据不再稳健')
