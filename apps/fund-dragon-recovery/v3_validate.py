"""Independent release acceptance. No claim of real-world holdings accuracy."""
from __future__ import annotations
import csv,hashlib,json,math,re,subprocess,sys
import numpy as np
from v3_common import *
from v3_pipeline import latest,load_snapshot,verify_build,assess_release
from v3_sources import parse_nav
from v3_enrich import parse_portfolio
from v3_engine import nav_returns,window_fit,change_fit
from v3_report import public_data


def acceptance_fingerprint():
    names=['v3_validate.py','tests/test_v3.py','tests/site_release.test.cjs']
    return digest({n:hashlib.sha256((ROOT/n).read_bytes().replace(b'\r\n',b'\n')).hexdigest() for n in names})


def validate(folder=None):
    a,p=latest() if folder is None else (read(Path(folder)/'analysis.json.gz'),Path(folder))
    checks=[];skipped=[]
    def check(name,condition,evidence):
        checks.append(dict(name=name,passed=bool(condition),evidence=evidence))
        if not condition:raise AssertionError(name+': '+str(evidence))
    check('immutable_build',verify_build(p)['passed'],a['build_id'])
    bm=read(p/'manifest.json');rp,m,raw=load_snapshot(a['raw_manifest'],True)
    check('code_and_raw_binding',bm['code_hash']==code_fingerprint() and bm['raw_manifest_hash']==digest(m),'normalized source code + immutable source manifest')
    configuration=dict(rules=read(CONFIG/'rules.json'),securities=read(CONFIG/'securities.json'),verified_reports=read(CONFIG/'verified_reports.json'))
    check('current_configuration_binding',digest(configuration)==bm['configuration_hash'],'all current configuration files')
    n=0;errors=[]
    for code,v in raw['nav'].items():
        rec=read(rp.parent/m['sources']['nav_'+code]['file'])
        try:rows=parse_nav(rec.get('body',''),a['end'])
        except Exception:
            check('unavailable_nav_'+code,bool(v.get('error')),v.get('error'));errors.append(code);continue
        check('nav_reparse_'+code,rows==v['rows'] and rows[-1]['date']==v['last'],len(rows));n+=1
    check('nav_failure_visibility',set(errors)==set(a['quality']['nav_fetch_errors']),errors)
    for report in raw['reports']:
        rows=[]
        for ref in report['refs']:
            payload=read(rp.parent/ref['file']);j=json.loads(payload['body']);rows+=j['result'].get('data') or []
        check('disclosure_'+report['stock']+'_'+report['period'],rows==report['rows'] and len(rows)==report['count'],report['count'])
    for code,v in raw.get('fund_portfolios',{}).items():
        if v.get('error'):continue
        ref=m['sources']['portfolio_'+code];rec=read(rp.parent/ref['file'])
        check('portfolio_reparse_'+code,parse_portfolio(rec['body'],v['period'])==v['holdings'],v['period'])
        fund=next(r for r in a['rows'] if r['code']==code)
        disclosed=next((f for f in fund['facts']['observations'] if f['code']==v['code'] and f['period']==v['period']),None)
        if disclosed:
            matches=[abs(h['weight_pct']-disclosed['stocks'][h['code']]['weight_pct'])<=.011 for h in v['holdings'] if h['code'] in disclosed['stocks'] and disclosed['stocks'][h['code']]['weight_pct'] is not None]
            check('portfolio_crosscheck_'+code,all(matches),len(matches))
    for code,v in raw['prices'].items():
        if v.get('error'):continue
        ref=m['sources'].get('extra_'+code,m['sources'].get(code));rec=read(rp.parent/ref['file'])
        node=json.loads(rec['body'])['data'][sym(code)]
        check('adjusted_prices_'+code,node.get('qfqday')==v['rows'],len(v['rows']))
    for code,rows in raw['indices'].items():
        rec=read(rp.parent/m['sources'][code]['file']);node=json.loads(rec['body'])['data'][code]
        check('calendar_'+code,(node.get('day') or node.get('qfqday'))==rows,len(rows))
    rows=a['rows'];s=a['summary'];gate=assess_release(a)
    check('freshness_and_release_gate',gate['passed'],gate)
    check('counts_reconcile',s['groups']==len(rows) and s['share_entries']==len(raw['pool']) and s['latest_nav_count']==sum(r['nav_date']==a['end'] for r in rows),s)
    check('no_stale_or_false_trade',all(not r['signal']['confirmed_transaction'] and (r['nav_date']==a['end'] or r['signal']['level'] is None) for r in rows),a['end'])
    check('strong_review_gate',all(r['fund_review']['status']=='passed' for r in rows if r['signal']['level']==3),'all level 3 require fund-specific control')
    check('no_false_zero_holdings',all(not r['facts']['current'] or r['facts']['current']['both_reported']==all(c in r['facts']['current']['stocks'] for c in TARGETS) for r in rows),'unreported target stays absent, not zero')
    verified=read(CONFIG/'verified_reports.json')['items'][0];sample=next(r for r in rows if verified['fund_id'] in r['members'])
    for stock,h in verified['holdings'].items():
        original=next(f for f in sample['facts']['observations'] if f['period']==verified['period'] and f['code']==verified['fund_id'])
        f=original['stocks'][stock]
        check('primary_report_'+stock,all(abs(f[k]-h[k])<.001 for k in ['shares','market_value','weight_pct']) and f['verified_original'],h)
    assets=verified['portfolio_net_assets']
    check('primary_report_assets_arithmetic',abs(sum(c['nav_assets'] for c in verified['share_classes'].values())-assets)<1,
        dict(assets=assets,classes=verified['share_classes']))
    check('primary_report_weights_arithmetic',all(abs(h['market_value']/assets*100-h['weight_pct'])<=.0051 for h in verified['holdings'].values()),'market value / total portfolio assets, not A-class assets')
    for code,cl in verified['share_classes'].items():
        navs=raw['nav'].get(code,{}).get('rows',[])
        observed=next((x['nav'] for x in navs if x['date']==verified['period']),None)
        if observed is not None:
            check('primary_report_nav_'+code,abs(observed-cl['nav'])<.0001,dict(report=cl['nav'],provider=observed,date=verified['period']))
        else:skipped.append(dict(name='primary_report_nav_'+code,reason='该份额/日期未在本批次净值范围；未声称完成供应商交叉核对'))
    # Recompute selected real-data prefixes and verify the 20+20 disjoint boundary.
    from v3_engine import make_factors
    factors,_=make_factors(raw['prices'],raw['indices'],a['calendar'],read(CONFIG/'securities.json'))
    for r in [x for x in rows if x['change']['broad'].get('usable')][:12]:
        ret,_=nav_returns(raw['nav'][r['code']]['rows'],a['calendar'])
        calc=change_fit(ret,factors,a['calendar'],a['end'],20,'broad',a['rules'])
        check('recompute_'+r['code'],calc==r['change']['broad'] and calc['before_end']<calc['recent_start'],calc['value'])
        cut=a['calendar'][-21];want=window_fit(ret,factors,a['calendar'],cut,40,'broad',a['rules'])
        prefix=window_fit({d:v for d,v in ret.items() if d<=cut},{d:v for d,v in factors.items() if d<=cut},[d for d in a['calendar'] if d<=cut],cut,40,'broad',a['rules'])
        check('prefix_causality_'+r['code'],want==prefix,'fixed factors; no future NAV used; historical pool not point-in-time')
    records=list(csv.DictReader((p/'observations.csv').open(encoding='utf-8-sig')))
    by={r['code']:r for r in rows}
    check('csv_count',len(records)==len(rows),len(records))
    for record in records:
        r=by[record['representative_code']];value=r['change']['broad'].get('value')
        if record['build_id']!=a['build_id'] or record['signal']!=r['signal']['label'] or (record['change20_association']!='' and abs(float(record['change20_association'])-value)>1e-12):raise AssertionError('CSV mixed values')
    check('csv_values',True,'all rows reconcile against exact analysis')
    html=(p/'report.html').read_text(encoding='utf8');embedded=json.loads(re.search(r'<script type="application/json" id="dataset">(.*?)</script>',html,re.S).group(1))
    check('page_data',embedded==public_data(a),'all public rows, rounded to 7 decimals')
    check('three_views_identical',len({(p/f).read_bytes() for f in ['report.html','combined.html','association.html']})==1,'same facts and signals; no old keepers calculation')
    test=subprocess.run([sys.executable,'-X','utf8','-m','unittest','discover','-s',str(ROOT/'tests'),'-p','test_v3.py'],cwd=ROOT,capture_output=True,text=True,encoding='utf8')
    check('model_unit_tests',test.returncode==0,(test.stdout+test.stderr).strip()[-800:])
    import os
    env=dict(os.environ,FUND_TRACK_SITE_DIR=str(p),FUND_TRACK_LOCAL_TEST='1')
    node=subprocess.run(['node','--test',str(ROOT/'tests/site_release.test.cjs')],cwd=ROOT,env=env,capture_output=True,text=True,encoding='utf8')
    check('javascript_interactions',node.returncode==0,(node.stdout+node.stderr).strip()[-1500:])
    receipt=dict(passed=True,build_id=a['build_id'],business_date=a['end'],checked_at=now(),code_hash=code_fingerprint(),
        acceptance_hash=acceptance_fingerprint(),analysis_hash=bm['analysis_hash'],raw_manifest_hash=bm['raw_manifest_hash'],
        checks=checks,skipped_checks=skipped,verification_limits=['无真实实时持仓真值，不证明市场仓位识别准确率','仅脚本/DOM交互校验；未进行真实浏览器视觉验收','定报原文仅一个样本核验，其余为第三方汇总'])
    write(p/'acceptance.json',receipt)
    print('独立验收通过',a['build_id'],len(checks),'项；净值重解析',n,'不可用',errors,flush=True)
    return receipt


if __name__=='__main__':validate()
