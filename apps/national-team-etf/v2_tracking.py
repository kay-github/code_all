"""Persistent channel signals calculated solely on direct exchange share observations."""
from v2_engine import metrics, risk_step, family_metrics


def attach(exchange,prices,calendar,actions,rules):
    all_metrics={};action={(x['code'],x['effective_date']):x['share_ratio'] for x in actions if x['status']=='verified'}
    for code,item in exchange['instruments'].items():
        price={r['date']:r for r in prices.get(code,[])};rows=[];days=set()
        for r in item['series']:
            p=price.get(r['date'])
            if not p or not p.get('close'):continue
            ratio=action.get((code,r['date']),1.)
            valid=r['net_estimate'] is not None and r['previous_date'] in days
            row=dict(p,shares=r['shares'],share_low=max(0,r['shares']-50),share_high=r['shares']+50,
                share_source='exchange_disclosed_total',share_scope=item['scope'],
                previous_date=r['previous_date'],share_factor=ratio,
                flags=['unregistered_share_action_quarantined'] if r.get('share_action_quarantined') else [],
                market_value=r['shares']*p['close']/1e8,
                net=r['net_estimate'] if valid else None,net_low=None,net_high=None,flow_ratio=None)
            if valid:
                px=r['vwap']/1e8;prev=rows[-1]
                row.update(net_low=(row['share_low']-prev['share_high']*ratio)*px,
                    net_high=(row['share_high']-prev['share_low']*ratio)*px,
                    flow_ratio=row['net']/prev['market_value'] if prev['market_value'] else None)
            rows.append(row);days.add(r['date'])
        ms=metrics(rows,calendar,rules['peak_sessions'],rules['rolling_history'],rules['min_history'])
        memory=None
        for m in ms:
            m['risk']=risk_step(m,memory,rules);memory=m['risk']['memory']
        all_metrics[code]=ms
        latest=ms[-1] if ms and ms[-1]['date']==exchange['latest']['date'] else None
        item['tracking']=dict(latest=latest,observed_sessions=len(rows),series=ms,
            peak_window_complete=len(rows)>=rules['peak_sessions'],
            note='仅用正式披露历史；未覆盖满63日时回撤仅为已观察区间，不回填换手率历史')
    def group(members):
        ms=family_metrics(members,all_metrics,calendar);memory=None
        for m in ms:
            if m['expected_members']!=len(members):
                m.update(net=None,net_low=None,net_high=None)
                for n in (5,10,20):m['w'+str(n)]['complete']=False
            m['risk']=risk_step(m,memory,rules);memory=m['risk']['memory']
        return dict(members=members,series=ms,latest=ms[-1] if ms else None)
    families={}
    for family in sorted({x['family'] for x in exchange['instruments'].values()}):
        families[family]=group([c for c,x in exchange['instruments'].items() if x['family']==family])
    exchange['tracking']=group(list(exchange['instruments']))
    exchange['families']=families
    return exchange
