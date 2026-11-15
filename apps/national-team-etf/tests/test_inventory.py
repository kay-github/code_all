import copy,sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from v2_inventory import summarize

END='2026-11-13'

def case():
    items={'a':dict(name='A',fixed_price=2,reference_shares=100,cycle_start_shares=20,alternative_shares=110),
           'b':dict(name='B',fixed_price=4,reference_shares=50,cycle_start_shares=10,alternative_shares=60)}
    cfg=dict(version='test',baseline_units=10,reference_date='2025-12-31',reference_label='年末参照',
        cycle_anchor_date='2026-07-15',cycle_start='2026-07-16',price_date=END,
        alternative_reference_date='2025-04-22',alternative_label='峰值参照',source_kind='vendor_turnover_estimate',
        identity='ETF通道估算',provenance={},items=items)
    data={c:[dict(date=END,shares=sh,close=999,share_source='vendor_turnover_estimate',flags=[])] for c,sh in [('a',60),('b',20)]}
    return cfg,data


class Inventory(unittest.TestCase):
    def run_case(self,cfg,data,end=END,actions=()):return summarize(data,[end],end,actions,cfg,['a','b'])

    def test_total_and_net_increment_are_distinct_and_reconcile(self):
        cfg,data=case();x=self.run_case(cfg,data)
        self.assertAlmostEqual(x['latest']['total_units'],5)
        self.assertAlmostEqual(x['cycle_start_units'],2)
        self.assertAlmostEqual(x['latest']['net_added_units'],3)
        self.assertAlmostEqual(sum(r['current_yi'] for r in x['latest']['components']),x['latest']['current_yi'])

    def test_price_rally_alone_cannot_invent_accumulation(self):
        cfg,data=case();a=self.run_case(cfg,data)
        for rows in data.values():rows[0]['close']*=4
        self.assertEqual(a,self.run_case(cfg,data))

    def test_negative_net_addition_is_not_clamped_to_zero(self):
        cfg,data=case()
        for rows in data.values():rows[0]['shares']=1
        x=self.run_case(cfg,data);self.assertLess(x['latest']['net_added_units'],0);self.assertGreater(x['latest']['total_units'],0)

    def test_missing_or_stale_member_is_not_zero(self):
        cfg,data=case();data['b'][0]['date']='2026-11-12';x=self.run_case(cfg,data)
        self.assertFalse(x['complete']);self.assertIsNone(x['latest']['total_units']);self.assertIsNone(x['latest']['net_added_units'])
        self.assertEqual(x['latest']['valid_members'],1)

    def test_known_future_split_preserves_inventory(self):
        cfg,data=case();old=self.run_case(cfg,data);end='2026-11-16'
        for rows in data.values():rows[0]['date']=end
        data['a'][0]['shares']*=2
        actions=[dict(code='a',effective_date=end,share_ratio=2,status='verified')]
        new=self.run_case(cfg,data,end,actions)
        self.assertAlmostEqual(old['latest']['total_units'],new['latest']['total_units'])
        self.assertAlmostEqual(old['latest']['net_added_units'],new['latest']['net_added_units'])

    def test_split_before_price_anchor_transforms_reference_too(self):
        cfg,data=case();cfg['items']['a']['reference_shares']=200
        actions=[dict(code='a',effective_date='2026-01-02',share_ratio=.5,status='verified')]
        self.assertAlmostEqual(self.run_case(cfg,data,actions=actions)['latest']['total_units'],5)

    def test_unknown_action_quarantine_persists_beyond_event_day(self):
        cfg,data=case();data['a'].insert(0,dict(date='2026-11-12',shares=1,flags=['unregistered_share_action_quarantined']))
        x=self.run_case(cfg,data);self.assertFalse(x['complete']);self.assertIsNone(x['latest']['current_ratio'])

    def test_official_and_vendor_denominators_are_not_spliced(self):
        cfg,data=case();data['a'][0]['share_source']='official_registered'
        self.assertFalse(self.run_case(cfg,data)['complete'])

    def test_rolling_api_can_drop_old_dates_without_moving_frozen_reference(self):
        cfg,data=case();a=self.run_case(cfg,data)
        data['a'].insert(0,dict(date='2025-12-31',shares=999999,close=1))
        self.assertEqual(a,self.run_case(cfg,data))

    def test_reference_and_pool_changes_require_explicit_rebase(self):
        cfg,data=case();cfg['items']['x']=cfg['items']['a']
        with self.assertRaises(ValueError):self.run_case(cfg,data)

    def test_no_metric_before_price_anchor_is_known(self):
        cfg,data=case();end='2026-11-12'
        for rows in data.values():rows[0]['date']=end
        self.assertFalse(self.run_case(cfg,data,end)['complete'])

    def test_nonfinite_share_does_not_produce_nan(self):
        cfg,data=case();data['a'][0]['shares']=float('nan')
        self.assertFalse(self.run_case(cfg,data)['complete'])


if __name__=='__main__':unittest.main()
