"""Supplement a versioned snapshot after an explicit pool rule change; no old raw overwrites."""
import concurrent.futures,csv,json,re,shutil
from v3_common import *
from v3_sources import make_pool,get_nav
from v3_pipeline import load_snapshot


def expand():
    old,m,parsed=load_snapshot(verify_raw=True)
    rec=read(old.parent/m['sources']['catalogue']['file'])
    arr=json.loads(re.search(r'var\s+r\s*=\s*(\[.*?\]);',rec['body'],re.S).group(1))
    cat={r[0]:dict(code=r[0],name=r[2],type=r[3]) for r in arr}
    seed=list(csv.DictReader((ROOT/'seed_image.csv').open(encoding='utf-8-sig')))
    pool=make_pool(cat,parsed['reports'],seed);extra=[x for x in pool if x['code'] not in parsed['nav']]
    run=now().replace(':','').replace('-','').replace('+','_')+'_pool'
    folder=DATA/'raw'/run;shutil.copytree(old.parent,folder);add=folder/('pool_sources_'+run);add.mkdir();refs={}
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as workers:
        for i,(code,ref,item) in enumerate(workers.map(lambda x:get_nav(x['code'],m['end'],add),extra),1):
            refs['nav_'+code]=dict(ref,file=str(Path(add.name)/ref['file']).replace('\\','/'));parsed['nav'][code]=item
            if i%50==0 or i==len(extra):print('补充净值',i,'/',len(extra),flush=True)
    parsed['pool']=pool;write(folder/'parsed.json.gz',parsed)
    manifest=dict(m,run_id=run,created_at=now(),source_cutoff_created_at=m.get('source_cutoff_created_at',m['created_at']),
        parent_manifest_hash=digest(m),pool_count=len(pool),parsed_hash=digest(parsed),sources={**m['sources'],**refs},
        scope='双龙最近两期主动/指数增强披露持有人并集及原始观察种子；不代表全市场全部基金')
    write(folder/'manifest.json',manifest);write(DATA/'raw_latest.json',dict(manifest=str((folder/'manifest.json').resolve()),run_id=run))
    print('样本补充完成',len(pool),'条目；新净值',len(extra),run,flush=True)


if __name__=='__main__':expand()
