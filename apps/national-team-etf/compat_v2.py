"""Old command names delegate to the same versioned build; no separate arithmetic."""
from pathlib import Path
import json
import sys
from v2_common import DATA

def main(entry):
    import pipeline
    args=sys.argv[1:]
    if entry in {'fetch_etf','fetch_idx','fetch_idx_today','fetch_hist'} or '--refresh' in args:
        date_arg=next((x for x in args if len(x)==10 and x[4:5]=='-' and x[7:8]=='-'),None)
        print('旧入口已统一到v2完整采集/计算链路；推荐 python pipeline.py --refresh')
        pipeline.main(['--refresh']+(['--end',date_arg] if date_arg else []));return
    if entry in {'build_report','build','final','export','baseline','recompute_bfq','series','cycle'}:
        pipeline.main([]);return
    a,path=pipeline.latest()
    date_arg=next((x for x in args if len(x)==10 and x[4:5]=='-' and x[7:8]=='-'),None)
    if date_arg and date_arg!=a['end']:
        raise SystemExit('请求日期与最新构建不同；请显式运行 pipeline.py --refresh --end '+date_arg+'，避免把最新数据贴上历史日期。')
    print(f'v{a["version"]}  数据截止 {a["end"]}  构建 {a["build_id"]}')
    print('同一标准日表；旧入口不再使用快照反推、旧成本线或人工阶段阈值。')
    exchange=a.get('exchange',{});official=exchange.get('latest',{})
    print('正式份额核心15：覆盖',official.get('valid_members',0),'/15，敞口估算/亿元',
          round(official['net_estimate'],2) if official.get('net_estimate') is not None else '不完整，暂不合计',
          '；减少',official.get('outflow_count',0),'只，增加',official.get('inflow_count',0),'只；买卖主体未确认')
    if entry in {'audit','audit2','verify_share','verify_cyb'}:
        print(json.dumps(pipeline.verify_build(path),ensure_ascii=False,indent=2))
        print('跨源核对:',[(x['code'],x['status']) for x in a['quality']['crosscheck']]);return
    if entry in {'scan_today','analyze_today','analyze'}:
        queue=sorted((x for x in a['discovery']['queue'] if x['current'] and x['net'] is not None),key=lambda x:x['net'])
        print('当前境内目录扫描（换手率反推）',a['discovery']['scanned'],'只；完整目录',a['discovery']['catalogue_complete'])
        for x in queue[:25]:print(x['code'],x['name'],'今日',round(x['net'],2),'5日',round(x['w5']['net'],2) if x['w5']['net'] is not None else None)
        return
    if entry in {'by_etf','dist'}:
        print('以下为固定境内扩展池家族的换手率历史反推，不与核心15正式份额混接')
        for name,x in a['families'].items():
            r=x['latest'];print(name,len(x['members']),'只，5日',round(r['w5']['net'],2) if r['w5']['net'] is not None else None,r['risk']['state'])
        return
    if entry in {'cost_cyb','make_cost_ref'}:
        print('实际持仓成本不可由净申赎还原；以下仅是净增日金额加权指数位置。')
        print(json.dumps(a['instruments']['159915']['entry_position_reference'],ensure_ascii=False,indent=2));return
    for c in a['pools']['core15']['members']:
        x=a['instruments'][c];r=x['latest']
        official_item=exchange.get('instruments',{}).get(c,{})
        pair=official_item.get('latest') or {};w5=official_item.get('w5',{})
        print(c,x['name'],'正式份额敞口/亿元',round(pair['net_estimate'],2) if pair.get('net_estimate') is not None else None,
              '正式5日',round(w5['net_estimate'],2) if w5.get('net_estimate') is not None else None,
              '正式份额状态',(official_item.get('tracking',{}).get('latest') or {}).get('risk',{}).get('state','数据不足'),x['identity_evidence']['level'])
    print('报告:',path/'report.html')
