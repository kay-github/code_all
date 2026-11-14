"""One source of truth for disclosure facts, return-exposure clues, and all report views."""
from __future__ import annotations
from collections import defaultdict,Counter
from datetime import datetime
import csv,hashlib,math,sys
from v3_common import *
from v3_engine import *


def load_snapshot(path=None,verify_raw=False):
    if path is None:path=read(DATA/'raw_latest.json')['manifest']
    p=Path(path);manifest=read(p);parsed=read(p.parent/'parsed.json.gz')
    if digest(parsed)!=manifest['parsed_hash']:raise ValueError('parsed input checksum mismatch')
    if verify_raw:
        for i,(name,ref) in enumerate(manifest['sources'].items(),1):
            if digest(read(p.parent/ref['file']))!=ref['hash']:raise ValueError('raw source checksum mismatch '+name)
            if i%500==0:print('原始响应校验',i,'/',len(manifest['sources']),flush=True)
    return p,manifest,parsed


def disclosures(reports,verified,end,knowledge_date=None):
    mapping=defaultdict(lambda:defaultdict(dict));issues=[]
    for report in reports:
        for row in report['rows']:
            code=str(row['HOLDER_CODE']);period=row['REPORT_DATE'][:10];stock=row['SECURITY_CODE']
            if period>end:continue
            w=row.get('NETASSET_RATIO');shares=row.get('TOTAL_SHARES');value=row.get('HOLD_MARKET_CAP')
            fact=dict(period=period,stock=stock,weight_pct=float(w) if w is not None else None,
                shares=float(shares) if shares is not None else None,market_value=float(value) if value is not None else None,
                source=f'https://fundf10.eastmoney.com/ccmx_{code}.html',source_kind='provider_report_summary',
                published_at=None,code=code,company=row.get('ORG_NAME_ABBR'),verified_original=False)
            if any(v is not None and (not math.isfinite(v) or v<0) for v in [fact['weight_pct'],fact['shares'],fact['market_value']]):
                issues.append(dict(code=code,period=period,stock=stock,kind='invalid_report_numbers'));continue
            old=mapping[code][period].get(stock)
            if old and old!=fact:
                issues.append(dict(code=code,period=period,stock=stock,kind='conflicting_disclosure'));continue
            mapping[code][period][stock]=fact
    verified_aliases={}
    for item in verified['items']:
        if item['status']!='verified_pdf' or item['published_at']>(knowledge_date or now()[:10]):continue
        verified_aliases.update({c:item['fund_id'] for c in item['share_codes']})
        for stock,h in item['holdings'].items():
            primary=mapping.get(item['fund_id'],{}).get(item['period'],{}).get(stock)
            if primary:
                matched=(abs(primary['weight_pct']-h['weight_pct'])<.011 and
                         abs(primary['shares']-h['shares'])<1 and abs(primary['market_value']-h['market_value'])<1)
                if not matched:issues.append(dict(code=item['fund_id'],stock=stock,kind='original_report_mismatch'))
                else:primary.update(verified_original=True,published_at=item['published_at'],original_source=item['source'])
            else:
                mapping[item['fund_id']][item['period']][stock]=dict(period=item['period'],stock=stock,
                    weight_pct=h['weight_pct'],shares=h['shares'],market_value=h['market_value'],
                    source=item['source'],source_kind='original_report',published_at=item['published_at'],
                    code=item['fund_id'],company=item.get('author'),verified_original=True,original_source=item['source'])
    return mapping,verified_aliases,issues


def facts_for(codes,mapping,global_period):
    sources=[]
    for code in codes:
        for period,stocks in mapping.get(code,{}).items():
            known=[f['weight_pct'] for f in stocks.values() if f['weight_pct'] is not None]
            sources.append(dict(code=code,period=period,stocks=stocks,known_sum_pct=sum(known) if known else None,
                both_reported=all(c in stocks for c in TARGETS),
                meaning='已列出的双龙权重；未列出的股票不能记为零'))
    sources.sort(key=lambda f:(f['period'],f['both_reported']),reverse=True)
    current=next((f for f in sources if f['period']==global_period),None)
    return dict(latest_period=global_period,current=current,last_known=sources[0] if sources else None,observations=sources,
        current_status='该期有目标持仓披露' if current else '该期反查未见目标记录，当前持有情况未知')


def representative_groups(pool,nav,calendar,aliases,end):
    groups=defaultdict(list)
    for x in pool:
        key='verified:'+aliases[x['code']] if x['code'] in aliases else 'name:'+x['group_key']
        groups[key].append(x)
    out=[]
    for key,items in groups.items():
        def rank(x):
            v=nav.get(x['code'],{});rows=v.get('rows',[])
            return (v.get('last')==end,not bool(v.get('error')),sum(r['date'] in calendar[-80:] for r in rows),x['source']=='seed',x['code'])
        items.sort(key=rank,reverse=True)
        chosen=dict(items[0]);chosen.update(group_id=key,members=[x['code'] for x in items],
            membership_status='原报确认同基金份额' if key.startswith('verified:') else '仅名称归并的观察组，组合身份未逐份核验',
            seed_group=any(x['source']=='seed' for x in items))
        out.append(chosen)
    return sorted(out,key=lambda r:r['code'])


def assess_release(a):
    problems=[];coverage=a['summary']['latest_nav_coverage']
    if coverage<a['rules']['min_complete_fraction']:problems.append('同日净值覆盖不足')
    if a['quality']['disclosure_issues']:problems.append('存在未解决披露冲突')
    if not a['quality']['report_pages_complete']:problems.append('披露目录未完整翻页')
    if not a['market'].get(a['end']):problems.append('缺少业务日行情或对照篮子')
    if a.get('stop_signal') is not False:problems.append('不允许模型结果自动停止长期追踪')
    if a['summary']['groups']==0:problems.append('空观察池')
    age=(datetime.fromisoformat(now())-datetime.fromisoformat(a['collected_at'])).total_seconds()/3600
    if age<0 or age>36:problems.append('本次数据获取时间过旧，请重新采集')
    return dict(passed=not problems,problems=problems,build_id=a['build_id'],business_date=a['end'],checked_at=now())


def verify_build(folder):
    p=Path(folder);m=read(p/'manifest.json');a=read(p/'analysis.json.gz');problems=[]
    if digest(a)!=m['analysis_hash']:problems.append('analysis checksum mismatch')
    if digest(read(p/'configuration.json'))!=m['configuration_hash']:problems.append('configuration checksum mismatch')
    for name,h in {**m.get('views',{}),**m.get('artifacts',{})}.items():
        if not (p/name).exists() or hashlib.sha256((p/name).read_bytes()).hexdigest()!=h:problems.append('view checksum mismatch '+name)
    if a['build_id']!=m['build_id']:problems.append('mixed build')
    ids=[r['group_id'] for r in a['rows']]
    if len(ids)!=len(set(ids)):problems.append('duplicate observation group')
    if a['summary']['groups']!=len(a['rows']):problems.append('group count mismatch')
    if any(r['signal']['confirmed_transaction'] for r in a['rows']):problems.append('model falsely confirms transaction')
    if any(r['nav_date']!=a['end'] and r['signal']['level'] is not None for r in a['rows']):problems.append('stale NAV signal')
    if any(r['facts']['current'] and r['facts']['current']['period']!=a['report_period'] for r in a['rows']):problems.append('mixed report periods')
    return dict(passed=not problems,problems=problems,build_id=a['build_id'])


def build(manifest_path=None,verify_raw=True):
    raw_path,m,raw=load_snapshot(manifest_path,verify_raw)
    rules=read(CONFIG/'rules.json');securities=read(CONFIG/'securities.json');verified=read(CONFIG/'verified_reports.json')
    if digest(securities)!=m['securities_hash']:raise ValueError('对照篮子已修改，需重新采集对应证券')
    # Calendar rows are independently fetched; no date inferred from a fund's stale snapshot.
    cals=[sorted({r[0] for r in rows if r[0]<=m['end']}) for rows in raw['indices'].values()]
    lo=max(c[0] for c in cals);calendar=sorted(set.intersection(*[set(c) for c in cals]))
    if any({d for d in c if d>=lo}!={d for d in calendar if d>=lo} for c in cals):raise ValueError('index calendars disagree')
    if not calendar or calendar[-1]!=m['end']:raise ValueError('calendar cutoff mismatch')
    end=m['end'];factors,factor_issues=make_factors(raw['prices'],raw['indices'],calendar,securities)
    if end not in factors:raise ValueError('missing latest factor observation')
    cutoff=m.get('source_cutoff_created_at',m['created_at'])
    mapping,aliases,disclosure_issues=disclosures(raw['reports'],verified,end,cutoff[:10])
    groups=representative_groups(raw['pool'],raw['nav'],calendar,aliases,end);rows=[];nav_issues={}
    period=max(r['period'] for r in raw['reports'])
    for i,x in enumerate(groups,1):
        code=x['code'];data=raw['nav'].get(code,{})
        returns,issues=nav_returns(data.get('rows',[]),calendar)
        if issues:nav_issues[code]=issues
        models={};changes={}
        for spec in ['broad','core']:
            models[spec]={str(n):window_fit(returns,factors,calendar,end,n,spec,rules) for n in rules['windows']}
            changes[spec]=change_fit(returns,factors,calendar,end,rules['change_window'],spec,rules)
        codes=x['members']
        if x['group_id'].startswith('verified:'):
            codes=sorted(set(codes)|{c for c,g in aliases.items() if g==x['group_id'].split(':',1)[1]})
        row=dict(x,date=end,nav_date=data.get('last'),nav_fetched_at=data.get('fetched_at'),nav_source=data.get('source'),
            nav_error=data.get('error'),models=models,change=changes,holdout=holdout(returns,factors,calendar,end,rules),
            current_return=returns.get(end),facts=facts_for(codes,mapping,period),
            recent_return_coverage=sum(d in returns for d in calendar[-60:])/min(60,len(calendar)))
        recent=[returns[d] for d in calendar[-60:] if d in returns]
        row['nav_frequency_warning']=len(recent)>=40 and sum(abs(v)<1e-12 for v in recent)/len(recent)>.6
        fact=row['facts']['current'] or row['facts']['last_known']
        row['company']=next((x.get('company','') for x in fact['stocks'].values() if x.get('company')),'') if fact else ''
        p=[v.get('p_value',1.) for v in changes.values()]
        row['comparison_p']=max(p) if row['category']=='active_domestic' else 1.
        row['fund_review']=portfolio_review(raw.get('fund_portfolios',{}).get(code),raw['prices'],returns,factors,calendar,end,rules,period)
        rows.append(row)
        if i%200==0 or i==len(groups):print('模型与数据核对',i,'/',len(groups),flush=True)
    adjusted=by_adjust([r['comparison_p'] for r in rows])
    for row,p in zip(rows,adjusted):row['adjusted_p']=p;row['signal']=signal(row,rules)
    rows.sort(key=lambda r:(-(r['signal']['level'] if r['signal']['level'] is not None else -1),
        -(min(x.get('value',-1e9) for x in r['change'].values())),r['code']))
    configuration=dict(rules=rules,securities=securities,verified_reports=verified)
    code_hash=code_fingerprint()
    build_id=now().replace(':','').replace('-','').replace('+','_')+'_'+digest([m,configuration,code_hash])[:10]
    folder=DATA/'builds'/build_id;folder.mkdir(parents=True,exist_ok=False)
    coverage=sum(r['nav_date']==end for r in rows)/len(rows) if rows else 0
    summary=dict(groups=len(rows),share_entries=len(raw['pool']),latest_nav_count=sum(r['nav_date']==end for r in rows),
        categories=dict(Counter(r['category'] for r in rows)),
        latest_nav_coverage=coverage,states=dict(Counter(r['signal']['label'] for r in rows)),
        verified_portfolios=sum(x['status']=='verified_pdf' and x['published_at']<=cutoff[:10] for x in verified['items']),confirmed_current_positions=0,
        fund_review_states=dict(Counter(r['fund_review']['status'] for r in rows)),
        model_usable=sum(r['models']['broad']['40'].get('usable',False) for r in rows),
        identifiable=sum(r['change']['broad'].get('identifiable',False) and r['change']['core'].get('identifiable',False) for r in rows))
    price_series={c:price_returns(v.get('rows',[]),calendar) for c,v in raw['prices'].items()}
    peer_coverage={g:dict(expected=len(securities[g]),complete=sum(all(d in price_series.get(c,{}) for d in calendar[-80:]) for c in securities[g])) for g in ['peer_broad','peer_core']}
    a=dict(version=VERSION,build_id=build_id,end=end,report_period=period,built_at=now(),collected_at=cutoff,
        raw_run=m['run_id'],raw_manifest=str(raw_path.resolve()),rules=rules,calendar=calendar,market=factors,
        summary=summary,rows=rows,stop_signal=False,
        quality=dict(disclosure_issues=disclosure_issues,nav_issues=nav_issues,factor_issues=factor_issues,
            report_pages_complete=all(r['complete'] for r in raw['reports']),catalogue_count=m['catalogue_count'],peer_coverage=peer_coverage,
            nav_fetch_errors={c:v.get('error') for c,v in raw['nav'].items() if v.get('error')},
            price_fetch_errors={c:v.get('error') for c,v in raw['prices'].items() if v.get('error')}),
        scope=m['scope'],limitations=['模型估计收益关联，不能直接恢复实时实际持仓或确认买卖',
            '未列入前十大或本期反查未见，不代表零持仓',
            '大部分来源为定报第三方汇总，原始报告仅样本核验',
            '名称归并不等于已确认全部份额共享组合；不汇总未知基金的当前规模',
            '留出检验和模拟检验不能给出真实市场持仓识别准确率',
            '新建仓且两期报告均未列出的基金可能遗漏，需要后续扩展发现池'])
    write(folder/'analysis.json.gz',a);write(folder/'configuration.json',configuration);write(folder/'raw_manifest.json',m)
    write(folder/'manifest.json',dict(version=VERSION,build_id=build_id,end=end,code_hash=code_hash,
        analysis_hash=digest(a),configuration_hash=digest(configuration),raw_manifest=str(raw_path.resolve()),raw_manifest_hash=digest(m)))
    with (folder/'observations.csv').open('w',encoding='utf-8-sig',newline='') as f:
        w=csv.writer(f,lineterminator='\n');w.writerow(['group_id','representative_code','name','business_date','latest_nav_date','disclosure_period','known_disclosed_weight_pct','beta40_association','change20_association','change20_low','change20_high','adjusted_p','signal','confirmed_transaction','build_id'])
        for r in rows:
            current=r['facts']['current'];change=r['change']['broad'];w.writerow([r['group_id'],r['code'],r['name'],end,r['nav_date'],period,
                current['known_sum_pct'] if current else None,r['models']['broad']['40'].get('value'),change.get('value'),change.get('low'),change.get('high'),r['adjusted_p'],r['signal']['label'],False,build_id])
    from v3_report import render
    render(a,folder)
    bm=read(folder/'manifest.json');bm['views']={name:hashlib.sha256((folder/name).read_bytes()).hexdigest() for name in ['report.html','combined.html','association.html']}
    bm['artifacts']={'observations.csv':hashlib.sha256((folder/'observations.csv').read_bytes()).hexdigest()};write(folder/'manifest.json',bm)
    validation=verify_build(folder);write(folder/'validation.json',validation)
    if not validation['passed']:raise RuntimeError(validation)
    gate=assess_release(a);write(folder/'release_gate.json',gate)
    # A failed gate is reviewable locally, and cannot be published by the release script.
    write(DATA/'latest.json',dict(build_id=build_id,path=str(folder.resolve()),end=end))
    REPORTS.mkdir(parents=True,exist_ok=True)
    for target,name in [('光模块双龙仓位回补跟踪.html','report.html'),('光模块双龙_合并页.html','combined.html'),('谁还没卖双龙_坚守名单.html','association.html')]:
        (REPORTS/target).write_bytes((folder/name).read_bytes())
    with (DATA/'observations.jsonl').open('a',encoding='utf8') as f:
        for r in rows:f.write(json.dumps(dict(date=end,build_id=build_id,raw_run=m['run_id'],group_id=r['group_id'],nav_date=r['nav_date'],signal=r['signal'],delta=r['change']['broad'].get('value'),rule_version=rules['version']),ensure_ascii=False)+'\n')
    print('构建完成',build_id,'正式净值覆盖',coverage,'发布检查',gate['passed'],flush=True)
    return a,folder


def latest():
    p=read(DATA/'latest.json')
    if not p:raise RuntimeError('尚无新版本构建')
    check=verify_build(p['path'])
    if not check['passed']:raise RuntimeError(check)
    return read(Path(p['path'])/'analysis.json.gz'),Path(p['path'])

if __name__=='__main__':
    import argparse
    p=argparse.ArgumentParser();p.add_argument('--manifest');p.add_argument('--verify',action='store_true');a=p.parse_args()
    if a.verify:
        x,path=latest();print(verify_build(path))
    else:build(a.manifest)
