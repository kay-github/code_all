import copy
from datetime import date,timedelta
import json
from pathlib import Path
import sys
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from v2_engine import normalize,window,metrics,risk_step,identity,family_metrics,behavior_clues
from v2_common import classify,CORE,read_json,CONFIG

def dates(n=40):
    d=date(2026,1,1);out=[]
    while len(out)<n:
        if d.weekday()<5:out.append(d.isoformat())
        d+=timedelta(days=1)
    return out

def bar(day,shares=1e10,price=2,tr=5):
    vol=shares*tr/10000
    return [day,str(price),str(price),str(price+.01),str(price-.01),str(vol),{},str(tr),str(vol*price/100)]

RULES=read_json(CONFIG/'rules.json')

class Economics(unittest.TestCase):
    def test_share_consolidation_no_fake_redemption(self):
        ds=dates(3);bars=[bar(ds[0],9e9,1),bar(ds[1],1e10,1),bar(ds[2],5e9,2)]
        rows,_=normalize('510310',bars,ds,[dict(code='510310',effective_date=ds[2],share_ratio=.5,status='verified')])
        self.assertAlmostEqual(rows[1]['net'],10)
        self.assertAlmostEqual(rows[2]['net'],0)

    def test_new_shares_on_consolidation_day(self):
        ds=dates(2);rs,_=normalize('x',[bar(ds[0],1e10,1),bar(ds[1],5.5e9,2)],ds,[dict(code='x',effective_date=ds[1],share_ratio=.5,status='verified')])
        self.assertAlmostEqual(rs[-1]['net'],10)

    def test_unregistered_action_is_not_zero(self):
        ds=dates(2);rs,issues=normalize('x',[bar(ds[0],1e10,1),bar(ds[1],5e9,2)],ds)
        self.assertIsNone(rs[-1]['net']);self.assertEqual(issues[-1]['kind'],'unregistered_share_action')

    def test_gap_is_not_a_multiday_flow(self):
        ds=dates(3);rs,_=normalize('x',[bar(ds[0]),bar(ds[2],1.2e10)],ds)
        self.assertIsNone(rs[-1]['net']);self.assertIn('gap_no_daily_flow',rs[-1]['flags'])

    def test_first_observation_not_zero(self):
        ds=dates(2);rs,_=normalize('x',[bar(ds[0]),bar(ds[1])],ds)
        self.assertIsNone(rs[0]['net'])

    def test_bad_price_and_volume_not_mixed(self):
        ds=dates(1);b=bar(ds[0]);b[2]='4';b[3]='4.1';b[4]='3.9'
        rs,issues=normalize('x',[b],ds);self.assertFalse(rs);self.assertEqual(issues[0]['kind'],'invalid_bar')

    def test_duplicate_conflict_is_removed(self):
        ds=dates(2);rs,issues=normalize('x',[bar(ds[0]),bar(ds[0],1.1e10),bar(ds[1])],ds)
        self.assertNotIn(ds[0],[r['date'] for r in rs]);self.assertIsNone(rs[-1]['net'])

    def test_invalid_turnover_does_not_bridge(self):
        ds=dates(3);b=bar(ds[1]);b[7]='0';rs,_=normalize('x',[bar(ds[0]),b,bar(ds[2])],ds)
        self.assertIsNone(rs[-1]['net'])

    def test_calendar_rejects_fabricated_day(self):
        ds=dates(1);rs,issues=normalize('x',[bar('2026-01-03')],ds)
        self.assertFalse(rs);self.assertEqual(issues[0]['kind'],'outside_exchange_calendar')

    def test_rounding_endpoints_cancel(self):
        ds=dates(8);rs,_=normalize('x',[bar(d) for d in ds],ds)
        w=window(rs,ds[-5:]);lo=(rs[-1]['share_low']-rs[-6]['share_high'])*2/1e8
        self.assertAlmostEqual(w['low'],lo);self.assertLess(abs(w['low']),sum(abs(r['net_low']) for r in rs[-5:]))
        self.assertLessEqual(w['low'],w['net']);self.assertGreaterEqual(w['high'],w['net'])

    def test_official_scope_is_not_silently_mixed(self):
        ds=dates(2);entry=dict(code='x',date=ds[-1],shares=9e9,source='https://issuer.example',published_at=ds[-1],unit_basis='native',scope='total')
        rs,_=normalize('x',[bar(d) for d in ds],ds,official=[entry]);self.assertEqual(rs[-1]['shares'],1e10)
        entry['scope']='exchange_traded';rs,_=normalize('x',[bar(d) for d in ds],ds,official=[entry]);self.assertEqual(rs[-1]['shares'],9e9)

    def test_window_uses_start_value(self):
        ds=dates(8);rs,_=normalize('x',[bar(d,1e10+i*1e8) for i,d in enumerate(ds)],ds);ms=metrics(rs,ds)
        self.assertAlmostEqual(ms[-1]['w5']['base_market_value'],rs[-6]['market_value'])

    def test_correct_family_maps(self):
        self.assertEqual(classify('159967','创成长')['family'],'创业板成长')
        self.assertEqual(classify('588220','科创鹏华')['index'],'sh000698')
        self.assertEqual(classify('159941','纳指ETF')['scope'],'cross_border')
        self.assertEqual(classify('512400','有色ETF')['scope'],'domestic_equity')
        self.assertIn('510330',CORE);self.assertIn('512050',CORE)
        self.assertEqual(classify('159980','有色ETF')['scope'],'non_equity')
        self.assertEqual(classify('159636','港科技30')['scope'],'cross_border')

class RiskAndIdentity(unittest.TestCase):
    def test_no_future_data_in_signal_metrics(self):
        ds=dates(80);bars=[bar(d,1e10*(.997**i),2+(i%3)*.01) for i,d in enumerate(ds)]
        allrows,_=normalize('x',bars,ds);full=metrics(allrows,ds)
        prefix,_=normalize('x',bars[:45],ds[:45]);part=metrics(prefix,ds[:45])
        self.assertEqual(full[:45],part)

    def test_steady_redemption_is_not_normalized_away(self):
        ds=dates(80);rs,_=normalize('x',[bar(d,1e10*.99**i) for i,d in enumerate(ds)],ds);ms=metrics(rs,ds)
        memory=None;last=None
        for m in ms:last=risk_step(m,memory,RULES);memory=last['memory']
        self.assertEqual(last['state'],'流出加速')

    def fake_metric(self):
        return dict(date='2026-11-13',net=1,net_low=.8,net_high=1.2,share_dd_robust=.04,flow_ratio=.001,
            w5=dict(complete=True,net=-10,low=-11,high=-9,ratio=-.01,negative_days=4),
            w10=dict(complete=True,net=-20,low=-21,high=-19,ratio=-.02))

    def test_one_green_day_does_not_clear_episode(self):
        m=self.fake_metric();r=risk_step(m,None,RULES)
        self.assertTrue(r['memory']['active']);self.assertGreaterEqual(r['memory']['peak_level'],2)
        m['w5'].update(net=1,low=.1,high=2,ratio=.001,negative_days=0)
        r2=risk_step(m,r['memory'],RULES);self.assertTrue(r2['memory']['active'])

    def test_missing_data_retains_episode(self):
        m=self.fake_metric();r=risk_step(m,None,RULES);m['net']=None
        r2=risk_step(m,r['memory'],RULES);self.assertTrue(r2['memory']['active']);self.assertEqual(r2['state'],'数据不足')

    def test_clear_requires_sustained_recovery(self):
        m=self.fake_metric();r=risk_step(m,None,RULES)
        m['w5'].update(net=10,low=9,high=11,ratio=.01,negative_days=0)
        m['w10'].update(net=10,low=9,high=11,ratio=.01)
        for i in range(RULES['release_positive_days']-1):
            r=risk_step(m,r['memory'],RULES);self.assertTrue(r['memory']['active'])
        r=risk_step(m,r['memory'],RULES);self.assertFalse(r['memory']['active'])

    def test_core_role_never_identifies_transaction(self):
        r=identity('510300','2026-11-13',[],True)
        self.assertEqual(r['level'],'I1 核心通道线索');self.assertEqual(r['direction'],'unconfirmed')

    def test_future_disclosure_not_used(self):
        e=[dict(status='verified',source='https://issuer.example',published_at='2026-12-01',event_date='2026-11-13',codes=['x'],kind='signed_transaction',direction='sell')]
        self.assertEqual(identity('x','2026-11-13',e)['direction'],'unconfirmed')

    def test_old_holding_does_not_prove_todays_trade(self):
        e=[dict(status='verified',source='https://issuer.example',published_at='2026-08-29',event_date='2026-06-30',codes=['x'],kind='named_holding')]
        r=identity('x','2026-11-13',e);self.assertTrue(r['level'].startswith('I2'));self.assertEqual(r['direction'],'unconfirmed')

    def test_evidence_requires_source_and_verified(self):
        e=[dict(status='unverified',source='https://issuer.example',published_at='2026-11-13',event_date='2026-11-13',codes=['x'],kind='signed_transaction',direction='sell')]
        self.assertEqual(identity('x','2026-11-13',e)['direction'],'unconfirmed')

    def test_no_cost_or_policy_gate(self):
        m=self.fake_metric();m.update(under_cost=True,policy_support=True)
        self.assertGreaterEqual(risk_step(m,None,RULES)['level'],2)

    def test_family_missing_member_does_not_imply_zero(self):
        ds=dates(10);r1,_=normalize('a',[bar(d) for d in ds],ds);r2,_=normalize('b',[bar(d) for d in ds[:-1]],ds)
        f=family_metrics(['a','b'],{'a':metrics(r1,ds),'b':metrics(r2,ds)},ds)
        self.assertIsNone(f[-1]['net']);self.assertLess(f[-1]['coverage'],1)

    def test_recovery_can_include_small_uncertain_daily_redemption(self):
        m=self.fake_metric();r=risk_step(m,None,RULES)
        m.update(net=-.01,net_low=-.1,net_high=.08,share_dd_robust=0)
        m['w5'].update(net=10,low=9,high=11,ratio=.01,negative_days=0,negative_point_days=1)
        m['w10'].update(net=10,low=9,high=11,ratio=.01)
        for _ in range(RULES['release_positive_days']):r=risk_step(m,r['memory'],RULES)
        self.assertFalse(r['memory']['active'])

    def test_unknown_split_does_not_pollute_peak(self):
        ds=dates(10);rs,_=normalize('x',[bar(d,1e10 if i<3 else 5e9,1 if i<3 else 2) for i,d in enumerate(ds)],ds)
        ms=metrics(rs,ds)
        self.assertAlmostEqual(ms[-1]['share_dd'],0)

    def test_many_behavior_conditions_do_not_confirm_identity(self):
        m=self.fake_metric();m.update(prior_flow_p10=.01,flow_ratio=-.03,volume_ratio=2,share_dd_robust=.05)
        b=behavior_clues(m,5,True)
        self.assertEqual(b['label'],'优先核查的资金行为候选');self.assertFalse(b['identity_confirmed'])
        self.assertEqual(identity('510300',m['date'],[],True)['direction'],'unconfirmed')

    def test_ambiguous_flow_does_not_get_a_direction(self):
        m=self.fake_metric();m['w5'].update(low=-1,high=1)
        self.assertEqual(behavior_clues(m,5,True)['direction'],'uncertain')

    def test_slow_but_robust_recovery_can_clear_old_episode(self):
        m=self.fake_metric();r=risk_step(m,None,RULES)
        m.update(net=.01,net_low=-.01,net_high=.03,share_dd_robust=0)
        m['w5'].update(net=.2,low=.1,high=.3,ratio=.0001,negative_days=0,negative_point_days=0)
        m['w10'].update(net=.3,low=.2,high=.4,ratio=.00015)
        for _ in range(RULES['release_positive_days']):r=risk_step(m,r['memory'],RULES)
        self.assertFalse(r['memory']['active'])

if __name__=='__main__':unittest.main()
