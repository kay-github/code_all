"""Independent accounting checks and real-history replay acceptance report."""
from __future__ import annotations
from collections import Counter
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from v2_common import *
from v2_engine import metrics,risk_step,normalize,family_metrics,identity
from v2_sources import rows_of
import pipeline

def validate():
    a,path=pipeline.latest();l=read_json(path/'ledger.json.gz');checks=[]
    def check(name,ok,detail):
        checks.append(dict(name=name,passed=bool(ok),detail=detail))
    rules=a['rules'];core=a['pools']['core15']
    check('核心15完整且含510330、512050',set(core['members'])==CORE and core['latest']['coverage']==1,core['members'])
    check('当前样本不混跨境或非股票',all(classify(c,v['name'])['scope']=='domestic_equity' for c,v in a['instruments'].items()),len(a['instruments']))
    # Compare the same domestic members with the audited correction branch, not unlike pool totals.
    fixture=read_json(ROOT/'tests/fixtures/regression_20261113.json.gz')
    if not fixture:raise RuntimeError('缺少已归档的独立回归样本，不能完成验收')
    old=fixture['legacy']
    comparisons=[];stable_comparisons=[];revisions=[]
    # Replay the old correction branch against its archived source vintage. Comparing its
    # provisional last day directly to a T+1 revision would test data freezing, not arithmetic.
    build_manifest=read_json(path/'manifest.json')
    current_manifest,current_raw=pipeline.load_snapshot(build_manifest.get('raw_manifest'))
    configuration=read_json(path/'configuration.json')
    if not configuration:raise RuntimeError('缺少本次构建的配置快照')
    official=configuration['official_shares']['items']
    for v in old['rows']:
        if v['code'] not in l['series']:continue
        code=v['code'];sym=symbol(code)
        oldbars=fixture['history'].get(code,{}).get('rows',[])
        archived,_=normalize(code,oldbars,fixture['calendar'],l['actions'],official,end=fixture['end'])
        archived={r['date']:r for r in archived}
        old_by={r[0]:r for r in oldbars}
        new_by={r[0]:r for r in rows_of(current_raw['history'].get(sym,{}),sym)}
        new={r['date']:r for r in l['series'][v['code']]}
        for d,net in v['net'].items():
            if d not in archived or archived[d]['net'] is None:continue
            comparisons.append(abs(net-archived[d]['net']))
            if d not in new or new[d]['net'] is None:continue
            dates=[d,new[d]['previous_date']]
            # Compare the actual OHLC/volume/turnover/amount inputs, not a fetch timestamp.
            changed=[day for day in dates if old_by.get(day,[])[1:9]!=new_by.get(day,[])[1:9]]
            if changed:
                revisions.append(dict(code=code,date=d,input_revision_days=changed,
                    archived_net=archived[d]['net'],current_net=new[d]['net']))
            else:stable_comparisons.append(abs(net-new[d]['net']))
    check('原修正版在相同原始批次中逐笔对账',bool(comparisons) and max(comparisons)<.02,
          dict(observations=len(comparisons),max_difference_yi=max(comparisons) if comparisons else None))
    check('未修订原始输入的同日结果一致',bool(stable_comparisons) and max(stable_comparisons)<.02,
        dict(observations=len(stable_comparisons),max_difference_yi=max(stable_comparisons) if stable_comparisons else None,
             revised_observations=len(revisions),revision_dates=sorted({r['date'] for r in revisions}),
             largest_revisions=sorted(revisions,key=lambda r:abs(r['current_net']-r['archived_net']),reverse=True)[:5]))
    # Independently sum native share deltas for all core dates, including the consolidation.
    max_diff=0;count=0;by={c:{r['date']:r for r in rs} for c,rs in l['series'].items()}
    for c in CORE:
        for r in l['series'][c]:
            if r['net'] is None:continue
            prev=by[c][r['previous_date']]
            expected=(r['shares']-prev['shares']*r['share_factor'])*r['amount']*1e8/(r['vol_hand']*100)/1e8
            max_diff=max(max_diff,abs(expected-r['net']));count+=1
    check('原生份额与原始金额独立公式一致',max_diff<1e-7,dict(observations=count,max_difference_yi=max_diff))
    # Prefix invariance over real data, including changing prices, volume and large flows.
    historical={c:normalize(c,fixture['history'][c]['rows'],fixture['calendar'],l['actions'],official,end=fixture['end'])[0] for c in CORE}
    code='510300';allrows=historical[code];cut='2026-01-20';cal=[d for d in fixture['calendar'] if d<=cut]
    full=metrics(allrows,fixture['calendar'],rules['peak_sessions'],rules['rolling_history'],rules['min_history'])
    prefix=metrics([r for r in allrows if r['date']<=cut],cal,rules['peak_sessions'],rules['rolling_history'],rules['min_history'])
    check('真实行情前缀不受未来日期影响',[r for r in full if r['date']<=cut]==prefix,dict(code=code,cut=cut,days=len(prefix)))
    hm={c:metrics(rs,fixture['calendar'],rules['peak_sessions'],rules['rolling_history'],rules['min_history']) for c,rs in historical.items()}
    historical_core=family_metrics(sorted(CORE),hm,fixture['calendar']);pipeline.attach_risks(historical_core,rules)
    relevant=[r for r in historical_core if '2026-01-06'<=r['date']<='2026-07-01']
    states=Counter(r['risk']['state'] for r in relevant)
    first=next((r for r in relevant if r['risk']['level'] is not None and r['risk']['level']>=2),None)
    cumulative=sum(r['net'] or 0 for r in relevant if first and r['date']<=first['date'])
    check('历史持续流出能触发预警',first is not None,dict(first_alert=first['date'] if first else None,
        cumulative_at_first_alert_yi=cumulative,state_counts=dict(states),scope='核心15；不是国家队交易真值'))
    checks_official=a['quality']['official_share_checks']
    check('历史官方份额锚点可复核',len(checks_official)>=2 and all(x['deviation_pct'] is not None and abs(x['deviation_pct'])<.5 for x in checks_official),checks_official)
    exchange=a.get('exchange',{});pairs=[]
    for c,x in exchange.get('instruments',{}).items():
        for r in x['series']:
            if r['net_estimate'] is None:continue
            expected=(r['shares']-r['previous_shares']*r.get('share_factor',1))*r['vwap']/1e8
            pairs.append(abs(expected-r['net_estimate']))
    check('当日正式份额15只完整且独立逐日差分一致',exchange.get('latest',{}).get('complete') and
          bool(pairs) and max(pairs)<1e-7,
          dict(latest=exchange.get('latest'),official_pairs=len(pairs),max_difference_yi=max(pairs) if pairs else None))
    check('深交所正式份额于次日早间后采集',all(x['next_morning_collected'] for x in
          exchange.get('instruments',{}).values() if x['source']=='szse'),
          {c:x['fetched_at'] for c,x in exchange.get('instruments',{}).items() if x['source']=='szse'})
    tracked=exchange.get('tracking',{}).get('latest') or {}
    check('正式份额预警与当日及5日独立总额一致',tracked.get('net') is not None and
          abs(tracked['net']-exchange['latest']['net_estimate'])<1e-7 and
          abs(tracked['w5']['net']-exchange['w5']['net_estimate'])<1e-7,
          dict(state=tracked.get('risk'),observed_days={c:x.get('tracking',{}).get('observed_sessions') for c,x in exchange['instruments'].items()}))
    check('当前验收绑定原始批次与构建配置快照',digest(current_manifest)==build_manifest['raw_manifest_hash'] and
          digest(configuration)==build_manifest['configuration_hash'] and
          digest(configuration['registry'])==current_manifest['registry_hash'],
          dict(raw_run=current_manifest['run_id'],build_id=a['build_id']))
    check('当日身份结论符合独立证据约束',all(x['identity_evidence']==identity(c,a['end'],configuration['evidence']['items'],c in CORE) for c,x in a['instruments'].items()),
        dict(identities=dict(Counter(x['identity_evidence']['level'] for x in a['instruments'].values())),
        behavior_candidates=sum(x['behavior_clues']['label']=='优先核查的资金行为候选' for x in a['instruments'].values())))
    # The generated JavaScript must parse before browser testing.
    from html.parser import HTMLParser
    class Scripts(HTMLParser):
        def __init__(self):super().__init__();self.active=False;self.parts=[];self.dataset=False;self.data=[];self.ids=[]
        def handle_starttag(self,t,attrs):
            at=dict(attrs)
            if at.get('id'):self.ids.append(at['id'])
            if t=='script':
                self.active=not at.get('src') and at.get('type')!='application/json';self.dataset=at.get('id')=='dataset'
        def handle_endtag(self,t):
            if t=='script':self.active=False;self.dataset=False
        def handle_data(self,s):
            if self.active:self.parts.append(s)
            if self.dataset:self.data.append(s)
    parser=Scripts();parser.feed((path/'report.html').read_text(encoding='utf8'))
    data=json.loads(''.join(parser.data));check('页面与计算同版本同数字',data['build_id']==a['build_id'] and data['pools']['core15']['latest']['net']==core['latest']['net'],a['build_id'])
    with tempfile.TemporaryDirectory() as tmp:
        p=Path(tmp)/'report.js';p.write_text('\n'.join(parser.parts),encoding='utf8')
        result=subprocess.run(['node','--check',str(p)],capture_output=True,text=True)
        check('浏览器脚本语法',result.returncode==0,result.stderr)
        # Execute all view calculations against a minimal DOM; this catches missing datasets/ids.
        smoke=Path(tmp)/'smoke.js'
        smoke.write_text('const vm=require("node:vm"),assert=require("node:assert/strict");\n'+
            'const ids='+json.dumps(parser.ids)+';const data='+json.dumps(data,ensure_ascii=False)+';\n'+
            'const nodes=Object.fromEntries(ids.map(id=>[id,{innerHTML:"",textContent:"",value:"",checked:false,clientWidth:1000,handlers:{},addEventListener(k,f){this.handlers[k]=f;}}]));\n'+
            'nodes.dataset.textContent=JSON.stringify(data);nodes.pool.value="core";nodes.direction.value="out";\n'+
            'const context={document:{getElementById:id=>nodes[id]},window:{addEventListener(){}},setTimeout};\n'+
            'vm.runInNewContext('+json.dumps('\n'.join(parser.parts),ensure_ascii=False)+',context);\n'+
            'assert.equal(context.window.GJD.officialNet,data.exchange.latest.net_estimate);\n'+
            'assert.equal((nodes.officialRows.innerHTML.match(/<tr>/g)||[]).length,15);\n'+
            'assert.equal((nodes.fundRows.innerHTML.match(/<tr>/g)||[]).length,15);\n'+
            'nodes.search.value="510330";nodes.search.handlers.input();assert.equal((nodes.fundRows.innerHTML.match(/<tr>/g)||[]).length,1);\n'+
            'assert.ok(nodes.officialScope.textContent.includes(data.end));\n',encoding='utf8')
        result=subprocess.run(['node',str(smoke)],capture_output=True,text=True,encoding='utf8')
        check('页面动态渲染与官方数值及搜索一致',result.returncode==0,result.stderr)
    # Every line really is an independently parseable JSON object, with the required provenance.
    logs=[json.loads(s) for s in (path/'signal_log.jsonl').read_text(encoding='utf8').splitlines()]
    check('JSONL日志保留版本与来源',bool(logs) and all(x['build_id']==a['build_id'] and x.get('raw_run') and x.get('rule_version') for x in logs),len(logs))
    out=dict(version=VERSION,build_id=a['build_id'],date=a['end'],checks=checks,
        passed=all(x['passed'] for x in checks),
        limitations=['正式份额仅覆盖核心15只的近期序列；历史反推与扩展池未全面核验','身份真值不足，不报告身份准确率','事后修订日线回放不等于时点样本外回测'])
    write_json(path/'acceptance.json',out)
    write_json(DATA/'acceptance.json',out)
    print(json.dumps(out,ensure_ascii=False,indent=2))
    if not out['passed']:raise SystemExit(1)
    return out

if __name__=='__main__':validate()
