"""Collect a coherent v2 snapshot. Does not calculate or publish reports."""
from __future__ import annotations
import argparse
from datetime import date, timedelta
from pathlib import Path
from v2_common import *
from v2_sources import catalogue, fetch_batch, crosscheck, rows_of

def collect(end, discover=True, workers=6):
    parent=read_json(DATA/'raw_latest.json',{}).get('manifest')
    requested_end=end
    current=__import__('datetime').datetime.fromisoformat(now())
    if end>=current.date().isoformat() and (current.hour,current.minute)<(15,10):
        end=(current.date()-timedelta(days=1)).isoformat()
    run_id = now().replace(':','').replace('-','').replace('+','_')
    folder = DATA / 'raw' / run_id
    folder.mkdir(parents=True, exist_ok=False)
    registry = read_json(CONFIG/'registry.json')
    fixed = {x['code']:x for x in registry['items'] if x['watch']}
    print('采集批次',run_id,'固定境内池',len(fixed),flush=True)
    indices = fetch_batch(INDEX.values(), '2024-05-01',end,900,folder/'indices',workers)
    last_dates=[max((r[0] for r in rows_of(indices.get(s,{}),s) if r[0]<=end),default=None)
                for s in ('sh000300','sz399006')]
    if not last_dates[0] or last_dates[0]!=last_dates[1]:raise RuntimeError('沪深两条日历代理最新日不一致，停止采集')
    end=last_dates[0]
    history = fetch_batch([symbol(c) for c in fixed], '2024-05-01',end,900,folder/'history',workers)
    cat = catalogue() if discover else dict(items=[],complete=False,errors=['discovery not requested'],pages=[])
    write_json(folder/'catalogue.json',cat)
    discovery = {}
    candidates=[]
    if discover:
        eligible=[x for x in cat['items'] if x['scope']=='domestic_equity']
        print('目录',len(cat['items']),'境内候选',len(eligible),'分页完整',cat['complete'],flush=True)
        discovery=fetch_batch([symbol(x['code']) for x in eligible],
            (date.fromisoformat(end)-timedelta(days=50)).isoformat(),end,26,folder/'discovery',workers)
        metrics=[]
        for item in eligible:
            sym=symbol(item['code']);r=discovery.get(sym,{})
            k=[x for x in rows_of(r,sym) if len(x)>8 and x[7] and float(x[7])>0 and float(x[5])>0 and x[0]<=end]
            if not k or k[-1][0]!=end:
                continue
            s=float(k[-1][5])*10000/float(k[-1][7]);previous=float(k[-6][5])*10000/float(k[-6][7]) if len(k)>=6 else None
            metrics.append(dict(**item,estimated_market_value=s*float(k[-1][2]),
                                share_growth5=s/previous-1 if previous else None))
        selected=set(fixed)
        for key,n in [('amount',100),('estimated_market_value',100),('share_growth5',50)]:
            selected.update(x['code'] for x in sorted(metrics,key=lambda x:x.get(key) if x.get(key) is not None else -1e99,reverse=True)[:n])
        selected.update(x['code'] for x in metrics if x['family'] in INDEX)
        candidates=[dict(x,selection='amount_or_size_or_share_growth_or_index_family') for x in metrics if x['code'] in selected and x['code'] not in fixed]
        print('新候选并集',len(candidates),'逐只留档；不悄然并入固定历史总额',flush=True)
        history.update(fetch_batch([symbol(x['code']) for x in candidates], '2025-05-01',end,400,folder/'history',workers))
    checks=crosscheck(['510300','510310','510330','159915','588000','510500'],end,folder)
    from v2_exchange import collect as collect_exchange
    exchange=collect_exchange(CORE,end,folder/'exchange')
    from v2_exchange import archive_history
    exchange_history=archive_history(parent,{c:read_json(folder/ref['file']) for c,ref in exchange.items()},end,folder)
    manifest=dict(version=VERSION,run_id=run_id,end=end,requested_end=requested_end,created_at=now(),
        registry_hash=digest(registry),indices={s:dict(file=f'indices/{s}.json',hash=digest(v)) for s,v in indices.items()},
        history={s:dict(file=f'history/{s}.json',hash=digest(v)) for s,v in history.items()},
        discovery={s:dict(file=f'discovery/{s}.json',hash=digest(v)) for s,v in discovery.items()},
        catalogue_complete=cat['complete'],catalogue_count=len(cat['items']),
        candidates=candidates,crosscheck=checks,exchange=exchange,exchange_history=exchange_history,
        errors=[dict(symbol=s,error=v['error']) for s,v in history.items() if v.get('error')])
    write_json(folder/'manifest.json',manifest)
    write_json(DATA/'raw_latest.json',dict(run_id=run_id,manifest=str((folder/'manifest.json').resolve())))
    print('采集完成',folder/'manifest.json',flush=True)
    return manifest

if __name__=='__main__':
    import cfg
    p=argparse.ArgumentParser();p.add_argument('--end',default=cfg.END);p.add_argument('--no-discover',action='store_true');p.add_argument('--workers',type=int,default=6)
    a=p.parse_args();collect(a.end,not a.no_discover,a.workers)
