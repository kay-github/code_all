"""Public source collection; raw responses are archived, never executed as JavaScript."""
from __future__ import annotations
import concurrent.futures,csv,json,math,re,time,urllib.parse,urllib.request
from datetime import datetime
from v3_common import *

def request(url,folder,name,referer='https://fund.eastmoney.com/'):
    path=Path(folder)/(name+'.json.gz')
    headers={'User-Agent':'Mozilla/5.0','Referer':referer}
    record=dict(url=url,fetched_at=now())
    for attempt in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url,headers=headers),timeout=22) as r:
                record.update(status=r.status,body=r.read().decode('utf-8-sig'))
            break
        except Exception as exc:
            if attempt==2:record['error']=str(exc)
            else:time.sleep(.3*(attempt+1))
    write(path,record)
    return record,dict(file=str(path.relative_to(folder)).replace('\\','/'),hash=digest(record))

def json_payload(record):
    if record.get('error'):raise ValueError(record['error'])
    return json.loads(record['body'])

def kline(code,end,folder):
    start=(date.fromisoformat(end)-timedelta(days=550)).isoformat()
    url='https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get?'+urllib.parse.urlencode({'param':f'{code},day,{start},{end},700,qfq'})
    record,ref=request(url,folder,'prices_'+code,referer='https://gu.qq.com/')
    try:
        node=json_payload(record)['data'][code]
        rows=node.get('qfqday') if not code.startswith(('sh000','sz399')) else node.get('day') or node.get('qfqday')
        if not rows:raise ValueError('requested adjusted price series missing; no unadjusted fallback')
        dates=[r[0] for r in rows if r[0]<=end]
        if not dates:raise ValueError('no price date within cutoff')
        return record,ref,rows
    except Exception as exc:return record,ref,dict(error=str(exc))

def parse_nav(body,end,keep=300):
    m=re.search(r'var\s+Data_netWorthTrend\s*=\s*(\[.*?\]);',body,re.S)
    if not m:raise ValueError('published NAV array missing')
    arr=json.loads(m.group(1));out={}
    for p in arr:
        d=datetime.fromtimestamp(float(p['x'])/1000,TZ).date().isoformat()
        if d>end:continue
        value=float(p['y']);raw=p.get('equityReturn')
        ret=None if raw is None or raw=='' else float(raw)
        if not math.isfinite(value) or value<=0:raise ValueError('invalid published NAV')
        if ret is not None and (not math.isfinite(ret) or ret<=-100):raise ValueError('invalid return')
        row=dict(date=d,nav=value,ret=ret,distribution=p.get('unitMoney') or '')
        if d in out and out[d]!=row:raise ValueError('conflicting NAV dates')
        out[d]=row
    if not out:raise ValueError('empty NAV series')
    return sorted(out.values(),key=lambda r:r['date'])[-keep:]

def get_nav(code,end,folder):
    u=f'https://fund.eastmoney.com/pingzhongdata/{code}.js'
    rec,ref=request(u,folder,'nav_'+code)
    try:
        if rec.get('error'):raise ValueError(rec['error'])
        rows=parse_nav(rec['body'],end)
        return code,ref,dict(rows=rows,last=rows[-1]['date'],source=u,fetched_at=rec['fetched_at'])
    except Exception as exc:return code,ref,dict(error=str(exc),rows=[],source=u,fetched_at=rec['fetched_at'])

def holdings(stock,period,folder):
    rows=[];refs=[];seen=set();total=None;pages=None
    for page in range(1,101):
        params=dict(reportName='RPT_MAINDATA_MAIN_POSITIONDETAILS',columns='ALL',
            filter=f'(SECURITY_CODE="{stock}")(REPORT_DATE=\'{period}\')',pageNumber=page,pageSize=200,
            sortColumns='HOLDER_CODE',sortTypes='1')
        u='https://datacenter-web.eastmoney.com/api/data/v1/get?'+urllib.parse.urlencode(params)
        rec,ref=request(u,folder,f'hold_{stock}_{period}_{page}',referer='https://data.eastmoney.com/')
        refs.append(ref);j=json_payload(rec);result=j.get('result')
        if not j.get('success') or result is None:raise ValueError('holdings API failed '+str(j.get('message')))
        total=int(result['count']);pages=int(result['pages']);data=result.get('data') or []
        sig=digest(data)
        if data and sig in seen:raise ValueError('holdings pagination repeated')
        seen.add(sig)
        for r in data:
            if r['SECURITY_CODE']!=stock or r['REPORT_DATE'][:10]!=period:raise ValueError('holdings cutoff/code mismatch')
        rows.extend(data)
        if page>=pages:
            if len(rows)!=total:raise ValueError('holdings page count mismatch')
            return dict(stock=stock,period=period,count=total,rows=rows,refs=refs,complete=True)
    raise ValueError('holdings pagination limit')

def catalogue(folder):
    rec,ref=request('https://fund.eastmoney.com/js/fundcode_search.js',folder,'fund_catalogue')
    if rec.get('error'):raise ValueError(rec['error'])
    m=re.search(r'var\s+r\s*=\s*(\[.*?\]);',rec['body'],re.S)
    if not m:raise ValueError('fund catalogue missing')
    arr=json.loads(m.group(1))
    return {r[0]:dict(code=r[0],name=r[2],type=r[3]) for r in arr},ref

def category(name,kind):
    if '指数' in kind and '增强' in name and not any(x in name for x in ['ETF','联接']):return 'enhanced_index'
    if any(x in kind for x in ['指数','ETF']) or any(x in name for x in ['ETF','联接']):return 'passive_or_index'
    if any(x in kind for x in ['QDII','FOF','债券','货币','REIT','商品']):return 'other'
    if '混合' in kind or '股票' in kind:return 'active_domestic'
    return 'unknown'

def group_key(name):
    # Only a terminal share class is a tentative grouping key; preserve currency/LOF/tenor.
    return re.sub(r'(?:[ABCEIHRY](?:类)?)$','',name.strip())


def make_pool(cat,reports,seed):
    seedcodes={r['code'] for r in seed}
    candidates={str(r['HOLDER_CODE']) for report in reports for r in report['rows'] if re.fullmatch(r'\d{6}',str(r.get('HOLDER_CODE','')))}|seedcodes
    out=[]
    for code in sorted(candidates):
        meta=cat.get(code,dict(code=code,name=code,type='unknown'));kind=category(meta['name'],meta['type'])
        if kind not in {'active_domestic','enhanced_index'} and code not in seedcodes:continue
        out.append(dict(meta,category=kind,source='seed' if code in seedcodes else 'disclosed_union',group_key=group_key(meta['name'])))
    return out

def collect(end,workers=8):
    requested_end=end;current=datetime.now(TZ)
    if end>=current.date().isoformat() and (current.hour,current.minute)<(15,15):
        end=(current.date()-__import__('datetime').timedelta(days=1)).isoformat()
    run_id=now().replace(':','').replace('-','').replace('+','_')
    folder=DATA/'raw'/run_id;folder.mkdir(parents=True,exist_ok=False)
    source_refs={};indices={};prices={}
    for code in ['sh000300','sz399006']:
        rec,ref,rows=kline(code,end,folder);source_refs[code]=ref
        if isinstance(rows,dict):raise RuntimeError(rows)
        indices[code]=rows
    latest=[max(r[0] for r in rows if r[0]<=end) for rows in indices.values()]
    if len(set(latest))!=1:raise RuntimeError('index business dates disagree')
    actual_end=latest[0];rules=read(CONFIG/'rules.json');securities=read(CONFIG/'securities.json')
    codes=sorted(set(securities['peer_broad'])|set(TARGETS))
    print('行情与控制篮子',len(codes),'实际业务日',actual_end,flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        for code,(rec,ref,rows) in zip(codes,pool.map(lambda c:kline(sym(c),actual_end,folder),codes)):
            source_refs[code]=ref
            if isinstance(rows,dict):prices[code]=rows
            else:prices[code]=dict(rows=rows)
    cat,catref=catalogue(folder);source_refs['catalogue']=catref
    reports=[]
    for period in periods(actual_end,2):
        for stock in TARGETS:
            report=holdings(stock,period,folder);reports.append(report)
            for i,ref in enumerate(report['refs']):source_refs[f'hold_{stock}_{period}_{i}']=ref
            print('披露目录',stock,period,report['count'],flush=True)
    seed=list(csv.DictReader((ROOT/'seed_image.csv').open(encoding='utf-8-sig')))
    pool_items=make_pool(cat,reports,seed)
    print('采集净值条目',len(pool_items),'不按季报权重下限删候选',flush=True)
    nav={}
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        for i,(code,ref,item) in enumerate(pool.map(lambda x:get_nav(x['code'],actual_end,folder),pool_items),1):
            source_refs['nav_'+code]=ref;nav[code]=item
            if i%50==0 or i==len(pool_items):print('净值',i,'/',len(pool_items),'失败',sum(bool(x.get('error')) for x in nav.values()),flush=True)
    parsed=dict(indices=indices,prices=prices,reports=reports,pool=pool_items,nav=nav)
    write(folder/'parsed.json.gz',parsed)
    manifest=dict(version=VERSION,run_id=run_id,requested_end=requested_end,end=actual_end,created_at=now(),sources=source_refs,
        parsed_hash=digest(parsed),rules_hash=digest(rules),securities_hash=digest(securities),
        catalogue_count=len(cat),pool_count=len(pool_items),scope='双龙最近两期主动/指数增强披露持有人并集及原始观察种子；不代表全市场全部基金')
    write(folder/'manifest.json',manifest);write(DATA/'raw_latest.json',dict(manifest=str((folder/'manifest.json').resolve()),run_id=run_id))
    print('原始批次完成',run_id,flush=True)
    return manifest

if __name__=='__main__':
    import argparse
    p=argparse.ArgumentParser();p.add_argument('--end',default=datetime.now(TZ).date().isoformat());p.add_argument('--workers',type=int,default=8)
    a=p.parse_args();collect(a.end,a.workers)
