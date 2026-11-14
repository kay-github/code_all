"""Official daily shares, kept separate from the vendor turnover denominator.

Paired differences always use the same exchange series on adjacent trading days.
The disclosure confirms fund shares, never the identity of the redeeming account.
"""
from __future__ import annotations
import concurrent.futures
from datetime import date, datetime, timedelta
from decimal import Decimal
import json
from pathlib import Path
import shutil
import urllib.parse
from v2_common import CORE, DATA, digest, now, read_json, write_json
from v2_sources import get


def fetch(code, end):
    sh=code.startswith(('5','6'))
    if sh:
        params=dict(sqlId='COMMON_SSE_ZQPZ_ETFZL_ETFJBXX_JJGM_MOREN_L',
                    SEC_CODE=code,isPagination='true',**{'pageHelp.pageSize':30,'pageHelp.pageNo':1})
        url='https://query.sse.com.cn/commonQuery.do?'+urllib.parse.urlencode(params)
        page='https://www.sse.com.cn/assortment/fund/list/etfinfo/basic/index.shtml?FUNDID='+code
        note='上交所ETF基本信息：统计数据为当日清算后数据；接口最近10个交易日'
    else:
        start=(date.fromisoformat(end)-timedelta(days=18)).isoformat()
        params=dict(SHOWTYPE='JSON',CATALOGID='scsj_fund_jjgm',TABKEY='tab1',PAGENO=1,
                    jjlb='ETF',txtDm=code,txtStart=start,txtEnd=end)
        url='https://www.szse.cn/api/report/ShowReport/data?'+urllib.parse.urlencode(params)
        page='https://www.szse.cn/market/fund/volume/etf/index.html'
        note='深交所接口说明：T日晚间更新的T日规模仅供参考，以T+1日早间更新的T日规模为准；使用size_date业务日，不自行平移日期'
    record=dict(code=code,url=url,source_page=page,source='sse' if sh else 'szse',
                scope='exchange_disclosed_total',unit='shares',fetched_at=now(),note=note)
    try:
        record['payload']=json.loads(get(url,referer=page).decode('utf-8'))
        # Parsing here makes schema/units/duplicate failures visible in raw provenance.
        parse(record,end)
        record['latest_available']=max(parse(record,'9999-12-31'),default=None)
    except Exception as exc:
        record['error']=str(exc)
    return record


def parse(record,end):
    if record.get('error'):return {}
    if record.get('scope')!='exchange_disclosed_total':
        raise ValueError('unverified share scope')
    code=record['code'];payload=record['payload'];out={}
    if record['source']!=('szse' if code.startswith('1') else 'sse'):
        raise ValueError('fund code/exchange mismatch')
    if record['source']=='sse':
        rows=payload.get('result')
        if not isinstance(rows,list) or not rows:raise ValueError('SSE result missing')
    elif record['source']=='szse':
        if not isinstance(payload,list) or not payload:raise ValueError('SZSE blocks missing')
        block=payload[0]
        if block.get('error'):raise ValueError(str(block['error']))
        meta=block.get('metadata',{})
        if int(meta.get('pagecount') or 0)>1:raise ValueError('SZSE incomplete pagination')
        if '万份' not in meta.get('cols',{}).get('current_size',''):raise ValueError('unverified SZSE unit')
        rows=block.get('data',[])
    else:raise ValueError('unknown exchange source')
    for row in rows:
        sh=record['source']=='sse'
        rowcode=str(row.get('SEC_CODE' if sh else 'fund_code','')).strip()
        if rowcode!=code:raise ValueError('official code mismatch')
        d=str(row['STAT_DATE' if sh else 'size_date']).strip()
        date.fromisoformat(d)
        if d>end:continue
        # Both endpoints disclose 0.01 万份; Decimal avoids binary unit conversion drift.
        val=Decimal(str(row['TOT_VOL' if sh else 'current_size']).replace(',',''))*10000
        if not val.is_finite() or val<=0:raise ValueError('invalid official shares')
        shares=float(val)
        if d in out and out[d]!=shares:raise ValueError('conflicting official duplicate')
        out[d]=shares
    return dict(sorted(out.items()))


def collect(codes,end,folder):
    folder=Path(folder);folder.mkdir(parents=True,exist_ok=True)
    refs={}
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for record in pool.map(lambda c:fetch(c,end),sorted(codes)):
            code=record['code'];write_json(folder/(code+'.json'),record)
            refs[code]=dict(file='exchange/'+code+'.json',hash=digest(record))
            print('  official',code,'失败 '+record['error'] if record.get('error') else '已留档',flush=True)
    return refs


def merge_history(previous, records, end):
    """Only direct exchange observations may extend this series; record every revision."""
    import copy
    result=copy.deepcopy(previous or dict(version=1,items={},revisions=[]))
    result.setdefault('items',{});result.setdefault('revisions',[])
    for code,record in records.items():
        if record.get('error'):continue
        values=parse(record,end)
        if not values:continue
        item=result['items'].setdefault(code,dict(source=record['source'],scope=record['scope'],observations={}))
        if (item['source'],item['scope'])!=(record['source'],record['scope']):
            raise ValueError('official history source/scope changed '+code)
        for d,shares in values.items():
            old=item['observations'].get(d)
            if old and old['fetched_at']>record['fetched_at']:continue
            if old and old['shares']!=shares:
                result['revisions'].append(dict(code=code,date=d,old=old,new_shares=shares,
                    revised_at=record['fetched_at'],url=record['url']))
            item['observations'][d]=dict(shares=shares,fetched_at=record['fetched_at'],
                first_seen_at=old.get('first_seen_at',old['fetched_at']) if old else record['fetched_at'],
                url=record['url'])
    result['end']=end
    return result


def archive_history(parent_path, records, end, folder):
    previous={};parent_hash=None
    if parent_path:
        path=Path(parent_path);manifest=read_json(path);parent_hash=digest(manifest)
        if manifest.get('exchange_history'):
            ref=manifest['exchange_history'];previous=read_json(path.parent/ref['file'])
            if digest(previous)!=ref['hash']:raise ValueError('official history hash mismatch')
        else:
            prior={}
            for code,ref in manifest.get('exchange',{}).items():
                rec=read_json(path.parent/ref['file'])
                if digest(rec)!=ref['hash']:raise ValueError('official parent payload hash mismatch')
                prior[code]=rec
            previous=merge_history({},prior,end)
    history=merge_history(previous,records,end)
    history['parent_manifest_hash']=parent_hash
    write_json(Path(folder)/'exchange_history.json',history)
    return dict(file='exchange_history.json',hash=digest(history))


def summarize(records,series,calendar,end,actions=(),meta=None,history=None):
    meta=meta or {};prev={d:calendar[i-1] if i else None for i,d in enumerate(calendar)}
    actions={(a['code'],a['effective_date']):float(a['share_ratio']) for a in actions if a['status']=='verified'}
    instruments={};issues=[];by_date={};last5=calendar[max(0,len(calendar)-5):]
    for code in sorted(CORE):
        rec=records.get(code,{})
        try:
            shares=parse(rec,end) if rec else {}
        except (ValueError,KeyError,TypeError,ArithmeticError) as exc:
            shares={};issues.append(dict(code=code,error=str(exc)))
        if rec.get('error'):issues.append(dict(code=code,error=rec['error']))
        archived=(history or {}).get('items',{}).get(code,{})
        if archived:
            if (archived['source'],archived['scope'])!=(rec.get('source'),rec.get('scope')):
                raise ValueError('official archive/source conflict '+code)
            prior={d:v['shares'] for d,v in archived['observations'].items() if d<=end}
            shares={**prior,**shares}
        prices={r['date']:r for r in series.get(code,[])};rows=[]
        for d,s in shares.items():
            if d not in prev:continue
            p=shares.get(prev[d]);px=prices.get(d,{}).get('vwap')
            ratio=actions.get((code,d),1.)
            change=s-p*ratio if p is not None else None
            quarantined=False
            if change is not None and p and abs(s/(p*ratio)-1)>.30:
                oldpx=prices.get(prev[d],{}).get('close');newpx=prices.get(d,{}).get('close')
                if ratio==1 and oldpx and newpx and abs(s/p*newpx/oldpx-1)<.12:
                    issues.append(dict(code=code,date=d,error='疑似未登记份额行动，隔离差分'))
                    change=None
                    quarantined=True
            net=change*px/1e8 if change is not None and px else None
            estimate=prices.get(d,{})
            outside=bool(estimate.get('share_low') is not None and
                         (s<estimate['share_low']-50 or s>estimate['share_high']+50))
            row=dict(date=d,shares=s,previous_date=prev[d],previous_shares=p,
                     share_factor=ratio,
                     share_action_quarantined=quarantined,
                     share_change=change,share_change_pct=change/(p*ratio)*100 if change is not None and p else None,
                     vwap=px,net_estimate=net,vendor_net=estimate.get('net'),
                     vendor_shares=estimate.get('shares'),outside_vendor_rounding=outside,
                     fetched_at=archived.get('observations',{}).get(d,{}).get('fetched_at',rec.get('fetched_at')),
                     source_url=archived.get('observations',{}).get(d,{}).get('url',rec.get('url')),
                     basis='同交易所、同披露总份额序列相邻交易日差分；金额=份额变化×当日不复权成交均价')
            rows.append(row);by_date.setdefault(d,{})[code]=row
        latest=next((r for r in rows if r['date']==end),None)
        last={r['date']:r for r in rows};w5=[last.get(d,{}) for d in last5]
        complete5=len(last5)==5 and all(r.get('net_estimate') is not None for r in w5)
        fetched=latest.get('fetched_at') if latest else rec.get('fetched_at')
        mature=None
        if fetched and rec.get('source')=='szse':
            t=datetime.fromisoformat(fetched)
            mature=t.date()>date.fromisoformat(end) and (t.date()>date.fromisoformat(end)+timedelta(days=1) or t.hour>=9)
        instruments[code]=dict(code=code,name=meta.get(code,{}).get('name',code),
            family=meta.get(code,{}).get('family','待核验'),source=rec.get('source'),
            source_page=rec.get('source_page'),url=rec.get('url'),fetched_at=fetched,
            scope=rec.get('scope'),note=rec.get('note'),next_morning_collected=mature,
            latest_available=rec.get('latest_available'),
            share_rows=len(shares),latest=latest,series=rows,
            w5=dict(complete=complete5,net_estimate=sum(r['net_estimate'] for r in w5) if complete5 else None),
            error=rec.get('error'))
    daily=[]
    for d,members in sorted(by_date.items()):
        valid=[r for r in members.values() if r['net_estimate'] is not None]
        share_valid=[r for r in members.values() if r['share_change'] is not None]
        complete=len(valid)==len(CORE)
        daily.append(dict(date=d,valid_members=len(valid),expected_members=len(CORE),complete=complete,
            net_estimate=sum(r['net_estimate'] for r in valid) if complete else None,
            partial_net_estimate=sum(r['net_estimate'] for r in valid) if valid else None,
            share_change_members=len(share_valid),outflow_count=sum(r['share_change']<0 for r in share_valid),
            inflow_count=sum(r['share_change']>0 for r in share_valid)))
    latest=next((r for r in daily if r['date']==end),dict(date=end,valid_members=0,expected_members=len(CORE),
        complete=False,net_estimate=None,partial_net_estimate=None,outflow_count=0,inflow_count=0))
    days={r['date']:r for r in daily};complete5=len(last5)==5 and all(days.get(d,{}).get('complete') for d in last5)
    return dict(instruments=instruments,series=daily,latest=latest,issues=issues,
        w5=dict(complete=complete5,net_estimate=sum(days[d]['net_estimate'] for d in last5) if complete5 else None),
        method='正式披露份额与供应商换手率反推各自保留，不跨序列拼接；净赎回不等于国家队账户卖出，也看不到全部二级市场买卖',
        valuation='份额变化×当日成交均价，仅表示证券敞口变化估算，不是实际现金流',
        resolution_shares=100,revisions=(history or {}).get('revisions',[]),
        stage='次晨复核' if latest['complete'] and all(x['next_morning_collected'] for x in instruments.values() if x['source']=='szse') else '初值或不完整')


def attach_latest():
    """Create a new immutable snapshot; never mutate the previous vendor archive."""
    pointer=read_json(DATA/'raw_latest.json');old=Path(pointer['manifest']);manifest=read_json(old)
    run_id=now().replace(':','').replace('-','').replace('+','_')+'_official'
    folder=DATA/'raw'/run_id
    shutil.copytree(old.parent,folder)
    manifest.update(run_id=run_id,created_at=now(),parent_manifest_hash=digest(manifest))
    manifest['exchange']=collect(CORE,manifest['end'],folder/'exchange')
    records={c:read_json(folder/ref['file']) for c,ref in manifest['exchange'].items()}
    manifest['exchange_history']=archive_history(old,records,manifest['end'],folder)
    write_json(folder/'manifest.json',manifest)
    write_json(DATA/'raw_latest.json',dict(run_id=run_id,manifest=str((folder/'manifest.json').resolve())))
    print('正式份额快照',folder/'manifest.json',flush=True)


if __name__=='__main__':attach_latest()
