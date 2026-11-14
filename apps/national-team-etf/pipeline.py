"""Only active build path. python pipeline.py --refresh; python pipeline.py --verify."""
from __future__ import annotations
import argparse
import csv
from collections import defaultdict
from pathlib import Path
import sys
from v2_common import *
from v2_sources import rows_of
from v2_engine import normalize, metrics, window, family_metrics, risk_step, identity, behavior_clues

def load_snapshot(manifest_path=None):
    if manifest_path is None:
        pointer=read_json(DATA/'raw_latest.json')
        if not pointer:
            raise RuntimeError('尚无v2原始快照，请先运行 python pipeline.py --refresh')
        manifest_path=pointer['manifest']
    path=Path(manifest_path);manifest=read_json(path);folder=path.parent
    payloads={}
    for group in ('history','indices','discovery','exchange'):
        payloads[group]={}
        for sym,ref in manifest.get(group,{}).items():
            item=read_json(folder/ref['file'])
            if digest(item)!=ref['hash']:
                raise ValueError(f'原始快照哈希不符: {sym}')
            payloads[group][sym]=item
    payloads['exchange_history']={}
    if manifest.get('exchange_history'):
        ref=manifest['exchange_history'];item=read_json(folder/ref['file'])
        if digest(item)!=ref['hash']:raise ValueError('正式份额历史哈希不符')
        payloads['exchange_history']=item
    return manifest,payloads

def attach_risks(items,rules):
    state=None
    for m in items:
        result=risk_step(m,state,rules);state=result['memory'];m['risk']=result

def evaluate_proxy(items,calendar=None):
    """Forward fund-flow outcome, explicitly NOT a trader-identity accuracy statistic."""
    trials=[];last_episode=None
    calendar=calendar or [m['date'] for m in items]
    positions={d:i for i,d in enumerate(calendar)};by={m['date']:m for m in items}
    for i,m in enumerate(items):
        episode=m['risk']['memory'].get('episode_start')
        if not episode or m['risk']['memory']['peak_level']<2 or episode==last_episode:
            continue
        last_episode=episode
        at=positions[m['date']];future_days=calendar[at+1:at+11]
        future=[by.get(d) for d in future_days]
        if len(future)!=10 or any(x is None or x['net'] is None for x in future):
            continue
        flow=sum(x['net'] for x in future)
        trials.append(dict(date=m['date'],future10_net=flow,
            future10_ratio=flow/m['market_value'] if m['market_value'] else None,
            negative_days=sum(x['net_high']<0 for x in future),
            proxy_persistent=flow < -.01*m['market_value'] and sum(x['net_high']<0 for x in future)>=5))
    return dict(target='之后10个交易日的资金流持续性代理，不是国家队身份真值，也不是交易收益',
                data_vintage='当前修订后日线回放，尚非原始发布时点回测',trials=trials,
                n=len(trials),proxy_hits=sum(x['proxy_persistent'] for x in trials),
                identity_precision=None,identity_recall=None)

def verify_build(folder, expected_build_id=None):
    folder=Path(folder);a=read_json(folder/'analysis.json.gz');l=read_json(folder/'ledger.json.gz');manifest=read_json(folder/'manifest.json')
    problems=[]
    if expected_build_id and a['build_id']!=expected_build_id:problems.append('build_id mismatch')
    if a['build_id']!=l['build_id'] or manifest['build_id']!=a['build_id']:problems.append('mixed build versions')
    if manifest['ledger_hash']!=digest(l):problems.append('ledger hash mismatch')
    if manifest['analysis_hash']!=digest(a):problems.append('analysis hash mismatch')
    if manifest.get('configuration_hash') and digest(read_json(folder/'configuration.json'))!=manifest['configuration_hash']:
        problems.append('configuration snapshot hash mismatch')
    if (folder/'raw_manifest.json').exists() and digest(read_json(folder/'raw_manifest.json'))!=manifest['raw_manifest_hash']:
        problems.append('raw manifest snapshot hash mismatch')
    for name,hash_value in manifest.get('views',{}).items():
        if not (folder/name).is_file() or __import__('hashlib').sha256((folder/name).read_bytes()).hexdigest()!=hash_value:
            problems.append('report view hash mismatch '+name)
    core=a['pools']['core15'];r=core['latest']
    if len(core['members'])!=15 or set(core['members'])!=CORE:problems.append('core membership changed')
    if any(a['instruments'][c]['scope']!='domestic_equity' for c in core['members']):problems.append('cross-border leaked into core')
    if r['date']!=a['end']:problems.append('latest calendar mismatch')
    if r['coverage']!=1:problems.append('core daily coverage incomplete')
    latest_rows=[next((x for x in l['series'][c] if x['date']==a['end']),{}) for c in CORE]
    if any(x.get('net') is None for x in latest_rows):problems.append('missing core flow')
    if r['net'] is not None and abs(sum(x['net'] for x in latest_rows)-r['net'])>1e-7:problems.append('core totals do not reconcile')
    exchange=a.get('exchange',{})
    er=exchange.get('latest',{})
    if er.get('complete'):
        pairs=[x['latest'] for x in exchange['instruments'].values()]
        if any(not x or x['date']!=a['end'] or x['share_change'] is None for x in pairs):
            problems.append('official share pairs not aligned')
        elif abs(sum(x['net_estimate'] for x in pairs)-er['net_estimate'])>1e-7:
            problems.append('official totals do not reconcile')
        for c,v in exchange['instruments'].items():
            for x in v['series']:
                if x['share_change'] is not None and x['previous_date'] not in {y['date'] for y in v['series']}:
                    problems.append('official previous share missing '+c)
        if l.get('exchange')!=exchange:problems.append('official ledger/analysis mismatch')
    for code,rows in l['series'].items():
        dates=[x['date'] for x in rows]
        if dates!=sorted(set(dates)):problems.append('unsorted/duplicate ledger '+code)
        for row in rows:
            if row['net'] is not None and not row['net_low']-1e-6<=row['net']<=row['net_high']+1e-6:
                problems.append('invalid flow bound '+code+row['date']);break
    return dict(passed=not problems,problems=problems,build_id=a['build_id'],
                date=a['end'],core_members=len(CORE),core_coverage=r['coverage'],
                identity_accuracy_validated=False)

def build(manifest_path=None):
    if manifest_path is None:manifest_path=read_json(DATA/'raw_latest.json')['manifest']
    manifest_path=Path(manifest_path).resolve()
    manifest,raw=load_snapshot(manifest_path)
    registry=read_json(CONFIG/'registry.json');rules=read_json(CONFIG/'rules.json')
    actions=read_json(CONFIG/'actions.json');evidence=read_json(CONFIG/'evidence.json')
    official=read_json(CONFIG/'official_shares.json')['items']
    instrument={x['code']:dict(x,pool='fixed_watch') for x in registry['items'] if x['watch']}
    for x in manifest['candidates']:
        updated={**x,**classify(x['code'],x['name'])}
        if x['code'] not in instrument and updated['scope']=='domestic_equity':
            instrument[x['code']]=dict(updated,core=False,watch=False,pool='discovery_candidate',identity='unconfirmed')
    cal_payload=raw['indices'].get('sh000300',{})
    calendar=sorted({x[0] for x in rows_of(cal_payload,'sh000300') if '2024-05-01'<=x[0]<=manifest['end']})
    if not calendar:raise RuntimeError('缺少交易所日期代理日线，停止计算')
    end=calendar[-1]
    other=sorted({x[0] for x in rows_of(raw['indices'].get('sz399006',{}),'sz399006') if '2024-05-01'<=x[0]<=manifest['end']})
    if other:
        lo=max(calendar[0],other[0]);hi=min(calendar[-1],other[-1])
        if {d for d in calendar if lo<=d<=hi}!={d for d in other if lo<=d<=hi}:
            raise RuntimeError('沪深300与创业板指数的共同区间交易日期不一致，停止跨日差分')
    if end<manifest['end']:
        from datetime import date
        if (date.fromisoformat(manifest['end'])-date.fromisoformat(end)).days>3:
            raise RuntimeError('日历数据明显陈旧，停止计算')
    series={};issues=[];index_series={};source_status={}
    for code,meta in instrument.items():
        sym=symbol(code);rec=raw['history'].get(sym,{})
        rows,errors=normalize(code,rows_of(rec,sym),calendar,actions,official,end=end)
        series[code]=rows;issues.extend(errors)
        source_status[code]=dict(source='tencent_newfqkline_bfq',fetched_at=rec.get('fetched_at'),
            first=rows[0]['date'] if rows else None,last=rows[-1]['date'] if rows else None,
            raw_hash=digest(rec),raw_error=rec.get('error'),current=bool(rows and rows[-1]['date']==end))
    for name,sym in INDEX.items():
        rec=raw['indices'].get(sym,{})
        index_series[name]={x[0]:float(x[2]) for x in rows_of(rec,sym) if x[0] in calendar}
    all_metrics={}
    for j,(code,rows) in enumerate(series.items()):
        ms=metrics(rows,calendar,rules['peak_sessions'],rules['rolling_history'],rules['min_history']);attach_risks(ms,rules);all_metrics[code]=ms
        if j%50==0:print('标准化与风险回放',j+1,'/',len(series),flush=True)
    families={}
    for name in sorted({x['family'] for x in instrument.values() if x['pool']=='fixed_watch'}):
        members=[c for c,x in instrument.items() if x['pool']=='fixed_watch' and x['family']==name]
        ms=family_metrics(members,all_metrics,calendar);attach_risks(ms,rules)
        families[name]=dict(members=members,series=ms,latest=ms[-1] if ms else None)
    pools={}
    for key,members in [('core15',sorted(CORE)),('fixed_domestic',sorted(c for c,x in instrument.items() if x['pool']=='fixed_watch'))]:
        ms=family_metrics(members,all_metrics,calendar);attach_risks(ms,rules)
        pools[key]=dict(members=members,series=ms,latest=ms[-1],evaluation=evaluate_proxy(ms,calendar))
    instruments={}
    core_family_signs={}
    for name in sorted({instrument[c]['family'] for c in CORE}):
        members=[c for c in CORE if instrument[c]['family']==name]
        recent=[all_metrics[c][-1]['w5'] for c in members if all_metrics[c]]
        if len(recent)==len(members) and all(w['complete'] for w in recent):
            low=sum(w['low'] for w in recent);high=sum(w['high'] for w in recent)
            core_family_signs[name]='redemption' if high<0 else 'subscription' if low>0 else 'uncertain'
    for code,meta in instrument.items():
        ms=all_metrics[code];latest=ms[-1] if ms else None
        if latest and latest['date']!=end:
            latest=dict(latest,stale=True)
        position=[]
        for a in ['2026-07-01','2026-09-01','2026-10-01']:
            index=index_series.get(meta.get('family'),{})
            valid=[r for r in series[code] if a<=r['date']<=end and r['net'] is not None and r['net']>0 and r['date'] in index]
            amount=sum(r['net'] for r in valid)
            expected=sum(1 for r in series[code] if a<=r['date']<=end and r['net'] is not None and r['net']>0)
            position.append(dict(start=a,end=end,label='净增日金额加权指数位置（不是持仓成本）',
                value=sum(r['net']*index[r['date']] for r in valid)/amount if amount else None,
                positive_flow=amount,covered_positive_days=len(valid),expected_positive_days=expected,
                index_current=index.get(end),index_date=max(index) if index else None))
        direction='redemption' if latest and latest['w5']['complete'] and latest['w5']['high']<0 else 'subscription' if latest and latest['w5']['complete'] and latest['w5']['low']>0 else 'uncertain'
        instruments[code]=dict(**meta,latest=latest,source=source_status[code],
            identity_evidence=identity(code,end,evidence['items'],meta['core']),
            behavior_clues=behavior_clues(latest,sum(x==direction for x in core_family_signs.values()),meta['core']),
            entry_position_reference=position)
    # Separate today-discovered queue: keep small observations, never silently change historical denominator.
    discovery_queue=[]
    cat=read_json(manifest_path.parent/'catalogue.json',{})
    catalogue_by={x['code']:x for x in cat.get('items',[])}
    for sym,rec in raw['discovery'].items():
        code=sym[2:];oldmeta=catalogue_by.get(code,dict(code=code,name=code));meta={**oldmeta,**classify(code,oldmeta['name'])}
        if meta['scope']!='domestic_equity':continue
        rows,err=normalize(code,rows_of(rec,sym),calendar,actions,official,end=end)
        issues.extend(err)
        if not rows:continue
        latest=rows[-1];i=calendar.index(latest['date']);w=window(rows,calendar[max(0,i-4):i+1])
        discovery_queue.append(dict(**meta,date=latest['date'],current=latest['date']==end,
            net=latest['net'],net_low=latest['net_low'],net_high=latest['net_high'],w5=w,
            market_value=latest['market_value'],in_fixed=code in pools['fixed_domestic']['members'],
            identity=identity(code,end,evidence['items'],code in CORE)['level']))
    # Explicit retrospective reporting windows; they never enter the risk engine.
    phase_rows=[]
    for title,a,b in [('早期区间','2024-06-03','2025-12-31'),('2026上半年区间','2026-01-05','2026-07-15'),('7月中旬以来','2026-07-16',end)]:
        dates=[d for d in calendar if a<=d<=b]
        per={c:window(series[c],dates) for c in CORE}
        total=sum(w['net'] or 0 for w in per.values())
        phase_rows.append(dict(label=title,start=a,end=min(b,end),flow=total,
            valid_observations=sum(w['valid'] for w in per.values()),
            expected_observations=sum(sum(d>=source_status[c]['first'] for d in dates) for c in CORE if source_status[c]['first']),
            note='当前核心15只回溯的有效观测估算；人工区间仅展示，不代表资金身份；首个记录无前值不算0'))
    official_checks=[]
    for item in official:
        row=next((r for r in series.get(item['code'],[]) if r['date']==item['date']),None)
        official_checks.append(dict(code=item['code'],date=item['date'],scope=item['scope'],source=item['source'],
            status='historical_anchor_compared' if row else 'no_same_date_bar',
            registered_shares=item['shares'],estimated_shares=row['shares'] if row else None,
            deviation_pct=(row['shares']/item['shares']-1)*100 if row else None,
            note='历史披露锚点，不代表当日全样本登记份额对账'))
    config_hash=digest([registry,rules,actions,evidence,official])
    from v2_exchange import summarize as summarize_exchange
    exchange=summarize_exchange(raw['exchange'],series,calendar,end,actions,instrument,raw['exchange_history'])
    from v2_tracking import attach as attach_official_tracking
    attach_official_tracking(exchange,series,calendar,actions,rules)
    code_hash=digest({p.name:__import__('hashlib').sha256(p.read_bytes()).hexdigest() for p in list(ROOT.glob('v2_*.py'))+[ROOT/'pipeline.py',ROOT/'collect_data.py',ROOT/'cfg.py']})
    build_id=now().replace(':','').replace('-','').replace('+','_')+'_'+digest([manifest,config_hash,code_hash])[:10]
    folder=DATA/'builds'/build_id
    folder.mkdir(parents=True,exist_ok=False)
    ledger=dict(version=VERSION,build_id=build_id,end=end,raw_run=manifest['run_id'],calendar=calendar,
                series=series,index=index_series,actions=actions,issues=issues,exchange=exchange,
                method='原生份额/不复权成交均价；合并仅转换相邻日比较单位；估算非实际账户现金流')
    analysis=dict(version=VERSION,rule_version=rules['version'],build_id=build_id,end=end,requested_end=manifest['end'],
        built_at=now(),raw_run=manifest['run_id'],method=ledger['method'],rules=rules,
        raw_manifest=str(manifest_path),
        calendar=calendar,pools=pools,families=families,instruments=instruments,exchange=exchange,
        discovery=dict(catalogue_complete=manifest['catalogue_complete'],catalogue_count=manifest['catalogue_count'],
            scanned=len(discovery_queue),requested=len(raw['discovery']),valid_current=sum(r['current'] for r in discovery_queue),
            queue=discovery_queue,scope='境内股票ETF候选，按当前目录识别；非历史时点全市场',
            cross_border_excluded=sum(classify(x['code'],x['name'])['scope']=='cross_border' for x in cat.get('items',[]))),
        history_phases=phase_rows,evidence=evidence,
        quality=dict(core_coverage=pools['core15']['latest']['coverage'],issues=issues,
            missing_indices=[name for name,vals in index_series.items() if end not in vals],
            crosscheck=manifest['crosscheck'],official_share_observations=len(official),official_share_checks=official_checks,
            statement='换手率反推为估算；舍入区间不是统计置信区间；无独立登记份额核验时不宣称精确'),
        limitations=['当前修订后日线回放，不是原始发布时点的真实样本外回测',
            '核心15为当前固定载体回溯，存在样本选择偏差；非国家队全渠道持仓',
            '份额变化不能识别全部二级市场交易；身份未知不意味着没有行动',
            '净申赎金额为证券敞口估算；不输出国家队实际成本或已实现收益'])
    write_json(folder/'ledger.json.gz',ledger);write_json(folder/'analysis.json.gz',analysis)
    configuration=dict(registry=registry,rules=rules,actions=actions,evidence=evidence,official_shares=dict(items=official))
    write_json(folder/'configuration.json',configuration)
    write_json(folder/'raw_manifest.json',manifest)
    write_json(folder/'manifest.json',dict(version=VERSION,build_id=build_id,raw_run=manifest['run_id'],
        raw_manifest=str(manifest_path),raw_manifest_hash=digest(manifest),configuration_hash=digest(configuration),
        config_hash=config_hash,code_hash=code_hash,ledger_hash=digest(ledger),analysis_hash=digest(analysis),
        requested_end=manifest['end'],end=end,created_at=now()))
    validation=verify_build(folder,build_id);write_json(folder/'validation.json',validation)
    if not validation['passed']:
        raise RuntimeError('构建验证失败，未切换最新版本: '+str(validation['problems']))
    from v2_report import render
    render(analysis,folder)
    build_manifest=read_json(folder/'manifest.json')
    build_manifest['raw_manifest_hash']=digest(manifest)
    build_manifest['views']={name:__import__('hashlib').sha256((folder/name).read_bytes()).hexdigest() for name in ['report.html','cycle.html']}
    write_json(folder/'manifest.json',build_manifest)
    final_validation=verify_build(folder,build_id)
    if not final_validation['passed']:raise RuntimeError('报告一致性校验失败，未切换最新版本')
    write_json(folder/'validation.json',final_validation)
    with (folder/'daily_flow.csv').open('w',newline='',encoding='utf-8-sig') as f:
        w=csv.writer(f);w.writerow(['date','core15_net_estimate_yi','rounding_low','rounding_high','coverage','state','build_id'])
        for r in pools['core15']['series']:
            w.writerow([r['date'],r['net'],r['net_low'],r['net_high'],r['coverage'],r['risk']['state'],build_id])
    with (folder/'official_flow.csv').open('w',newline='',encoding='utf-8-sig') as f:
        w=csv.writer(f);w.writerow(['code','date','previous_date','official_shares','previous_official_shares',
            'share_change','unadjusted_vwap','exposure_estimate_yi','source','fetched_at','build_id'])
        for c,item in exchange['instruments'].items():
            for r in item['series']:
                w.writerow([c,r['date'],r['previous_date'],r['shares'],r['previous_shares'],
                    r['share_change'],r['vwap'],r['net_estimate'],r['source_url'],r['fetched_at'],build_id])
    logs=[dict(date=end,channel=c,build_id=build_id,rule_version=rules['version'],
               raw_run=manifest['run_id'],risk=v['latest']['risk'] if v['latest'] else None,
               official_share_observation=exchange['instruments'].get(c,{}).get('latest'),
               official_w5=exchange['instruments'].get(c,{}).get('w5'),
               official_risk=(exchange['instruments'].get(c,{}).get('tracking',{}).get('latest') or {}).get('risk'),
               identity=v['identity_evidence']) for c,v in instruments.items()]
    with (folder/'signal_log.jsonl').open('w',encoding='utf-8') as f:
        for x in logs:f.write(__import__('json').dumps(x,ensure_ascii=False)+'\n')
    with (DATA/'signal_log.jsonl').open('a',encoding='utf-8') as f:
        for x in logs:f.write(__import__('json').dumps(x,ensure_ascii=False)+'\n')
    write_json(DATA/'latest.json',dict(build_id=build_id,end=end,path=str(folder.resolve())))
    # Human-facing aliases are only replaced after all consistency checks pass.
    import shutil
    REPORTS.mkdir(parents=True,exist_ok=True)
    for name,src in [('国家队ETF托底分析_最新.html','report.html'),
                     (f'国家队ETF托底分析_{end.replace("-","")}.html','report.html'),
                     ('国家队ETF完整周期复盘_最新.html','cycle.html')]:
        shutil.copyfile(folder/src,REPORTS/name)
    print('构建完成',build_id,'核心覆盖',validation['core_coverage'],'报告',folder/'report.html',flush=True)
    return analysis

def latest():
    pointer=read_json(DATA/'latest.json')
    if not pointer:raise RuntimeError('没有已验证的v2构建，请运行 python pipeline.py --refresh')
    validation=verify_build(pointer['path'],pointer['build_id'])
    if not validation['passed']:raise RuntimeError('最新构建验证失败: '+str(validation))
    return read_json(Path(pointer['path'])/'analysis.json.gz'),Path(pointer['path'])

def main(argv=None):
    import cfg
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--refresh',action='store_true');p.add_argument('--end',default=cfg.END)
    p.add_argument('--no-discover',action='store_true');p.add_argument('--manifest')
    p.add_argument('--verify',action='store_true')
    a=p.parse_args(argv)
    actual_args=sys.argv[1:] if argv is None else argv
    if '--end' in actual_args and not a.refresh:
        p.error('--end指定采集截止日，需与--refresh一起使用；离线重算使用原始批次自带的业务日期')
    if a.verify:
        data,path=latest();print(__import__('json').dumps(verify_build(path),ensure_ascii=False,indent=2));return
    if a.refresh:
        from collect_data import collect
        collect(a.end,not a.no_discover)
    build(a.manifest)

if __name__=='__main__':main()
