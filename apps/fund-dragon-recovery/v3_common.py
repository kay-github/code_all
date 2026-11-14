"""Shared provenance and file handling for the fund exposure tracker."""
from __future__ import annotations
from datetime import datetime,timezone,timedelta,date
from pathlib import Path
import hashlib,gzip,json,os

ROOT=Path(__file__).resolve().parent
DATA=Path(os.environ.get('FUND_TRACK_DATA',ROOT/'data/v3')).resolve()
CONFIG=ROOT/'config'
REPORTS=Path(os.environ.get('FUND_TRACK_REPORTS',ROOT.parent if ROOT.parent.name=='work_code2' else ROOT/'output')).resolve()
VERSION='3.0.0'
TZ=timezone(timedelta(hours=8))
TARGETS={'300502':'新易盛','300308':'中际旭创'}

def now():return datetime.now(TZ).isoformat(timespec='seconds')
def read(path,default=None):
    p=Path(path)
    if not p.exists():return default
    if p.suffix=='.gz':
        with gzip.open(p,'rt',encoding='utf-8-sig') as f:return json.load(f)
    return json.loads(p.read_text(encoding='utf-8-sig'))
def write(path,value):
    p=Path(path);p.parent.mkdir(parents=True,exist_ok=True);tmp=p.with_suffix(p.suffix+'.tmp')
    if p.suffix=='.gz':
        with gzip.open(tmp,'wt',encoding='utf8',compresslevel=6) as f:json.dump(value,f,ensure_ascii=False,separators=(',',':'),allow_nan=False)
    else:tmp.write_text(json.dumps(value,ensure_ascii=False,indent=2,allow_nan=False),encoding='utf8')
    os.replace(tmp,p)
def digest(value):return hashlib.sha256(json.dumps(value,sort_keys=True,ensure_ascii=False,separators=(',',':'),allow_nan=False).encode()).hexdigest()
def code_fingerprint():
    names=['v3_common.py','v3_sources.py','v3_engine.py','v3_pipeline.py','v3_report.py','v3_enrich.py','v3_expand_pool.py']
    return digest({n:hashlib.sha256((ROOT/n).read_bytes().replace(b'\r\n',b'\n')).hexdigest() for n in names})
def sym(code):return ('bj' if code.startswith(('4','8','92')) else 'sh' if code.startswith(('6','9')) else 'sz')+code
def periods(end,n=2):
    d=date.fromisoformat(end);out=[]
    for y in range(d.year,d.year-3,-1):
        for m,day in [(12,31),(9,30),(6,30),(3,31)]:
            q=date(y,m,day)
            if q<=d:out.append(q.isoformat())
    return out[:n]
