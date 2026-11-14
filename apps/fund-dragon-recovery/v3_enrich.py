"""Review priority candidates against their own other disclosed holdings.

This is an additional confound check, never confirmation of a transaction.
"""
from html.parser import HTMLParser
import re,shutil,concurrent.futures,urllib.parse
from v3_common import *
from v3_sources import request,kline,json_payload


class Table(HTMLParser):
    def __init__(self):super().__init__();self.row=None;self.cell=None;self.rows=[]
    def handle_starttag(self,t,a):
        if t=='tr':self.row=[]
        if t=='td' and self.row is not None:self.cell=''
    def handle_data(self,s):
        if self.cell is not None:self.cell+=s
    def handle_endtag(self,t):
        if t=='td' and self.cell is not None:self.row.append(self.cell.strip());self.cell=None
        if t=='tr' and self.row is not None:self.rows.append(self.row);self.row=None


def parse_portfolio(body,period):
    at=body.find(period)
    if at<0:raise ValueError('requested quarter not found')
    segment=body[at:];next_heading=segment.find('<h4',10)
    if next_heading>=0:segment=segment[:next_heading]
    parser=Table();parser.feed(segment)
    rows=[]
    for cells in parser.rows:
        if len(cells)<9 or not re.fullmatch(r'\d{5,6}',cells[1]):continue
        if not cells[6].endswith('%'):continue
        rows.append(dict(code=cells[1],name=cells[2],weight_pct=float(cells[6][:-1].replace(',',''))))
    if not rows or len({r['code'] for r in rows})!=len(rows):raise ValueError('empty or conflicting top holdings')
    return rows


def enrich(manifest_path,analysis_path,limit=80):
    old=Path(manifest_path);m=read(old);a=read(Path(analysis_path)/'analysis.json.gz')
    selected=[r for r in a['rows'] if r['signal'].get('statistical_priority',r['signal']['level'] or 0)>=2]
    selected.sort(key=lambda r:(-r['signal'].get('statistical_priority',r['signal']['level'] or 0),r['comparison_p']))
    selected=selected[:limit]
    run_id=now().replace(':','').replace('-','').replace('+','_')+'_review'
    folder=DATA/'raw'/run_id;shutil.copytree(old.parent,folder)
    parsed=read(folder/'parsed.json.gz');reviews=dict(parsed.get('fund_portfolios',{}));refs={}
    # Retried core prices must not overwrite copied source files still referenced
    # by the parent's manifest. Each enrichment batch has its own source namespace.
    additions=folder/('review_sources_'+run_id);additions.mkdir()
    def prefixed(ref):return dict(ref,file=str(Path(additions.name)/ref['file']).replace('\\','/'))
    def fetch(row):
        code=(row['facts']['current'] or row['facts']['last_known'] or {}).get('code',row['code'])
        params=dict(type='jjcc',code=code,topline=10,year=m['end'][:4],month=int(a['report_period'][5:7]))
        url='https://fundf10.eastmoney.com/FundArchivesDatas.aspx?'+urllib.parse.urlencode(params)
        rec,ref=request(url,additions,'portfolio_'+row['code'],referer='https://fundf10.eastmoney.com/');ref=prefixed(ref)
        try:
            if rec.get('error'):raise ValueError(rec['error'])
            holdings=parse_portfolio(rec['body'],a['report_period'])
            return row['code'],ref,dict(code=code,period=a['report_period'],holdings=holdings,source=url,fetched_at=rec['fetched_at'])
        except Exception as exc:return row['code'],ref,dict(error=str(exc),source=url)
    needed=[r for r in selected if reviews.get(r['code'],{}).get('period')!=a['report_period'] or reviews.get(r['code'],{}).get('error')]
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        for i,(code,ref,result) in enumerate(pool.map(fetch,needed),1):
            refs['portfolio_'+code]=ref;reviews[code]=result
            if i%10==0 or i==len(needed):print('个基持仓对照',i,'/',len(needed),flush=True)
    extras=sorted({x['code'] for v in reviews.values() for x in v.get('holdings',[]) if re.fullmatch(r'\d{6}',x['code']) and (x['code'] not in parsed['prices'] or parsed['prices'][x['code']].get('error'))})
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        for code,(rec,ref,rows) in zip(extras,pool.map(lambda c:kline(sym(c),m['end'],additions),extras)):
            refs['extra_'+code]=prefixed(ref);parsed['prices'][code]=dict(rows=rows) if isinstance(rows,list) else rows
    parsed['fund_portfolios']=reviews
    write(folder/'parsed.json.gz',parsed)
    manifest=dict(m,run_id=run_id,parent_manifest_hash=digest(m),created_at=now(),
        source_cutoff_created_at=m.get('source_cutoff_created_at',m['created_at']),parsed_hash=digest(parsed),sources={**m['sources'],**refs})
    write(folder/'manifest.json',manifest);write(DATA/'raw_latest.json',dict(manifest=str((folder/'manifest.json').resolve()),run_id=run_id))
    print('个基复核资料完成',len(reviews),'新增证券',len(extras),run_id,flush=True)
    return manifest


if __name__=='__main__':
    p=read(DATA/'latest.json');a=read(Path(p['path'])/'analysis.json.gz');enrich(a['raw_manifest'],p['path'])
