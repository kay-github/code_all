import copy
from datetime import date,timedelta
import sys
from pathlib import Path
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from v2_common import CORE,CONFIG,read_json
from v2_exchange import merge_history,summarize
from v2_tracking import attach
from v2_release import assess
from test_exchange import record
from test_v2 import bar
from v2_engine import normalize,metrics,family_metrics
from pipeline import evaluate_proxy


class ArchiveAndSignals(unittest.TestCase):
    def test_family_single_day_ratio_uses_previous_day_size(self):
        ds=['2026-11-12','2026-11-13']
        rows,_=normalize('x',[bar(ds[0],1e10,2),bar(ds[1],.95e10,3)],ds)
        ms=metrics(rows,ds);family=family_metrics(['x'],{'x':ms},ds)
        self.assertAlmostEqual(family[-1]['flow_ratio'],ms[-1]['flow_ratio'])

    def test_proxy_outcome_does_not_skip_missing_trading_day(self):
        ds=[(date(2026,11,1)+timedelta(days=i)).isoformat() for i in range(12)]
        rows=[dict(date=d,net=-1,net_high=-.9,market_value=100,
            risk=dict(level=2,memory=dict(episode_start=ds[0],peak_level=2))) for d in ds]
        self.assertEqual(evaluate_proxy(rows,ds)['n'],1)
        self.assertEqual(evaluate_proxy([r for r in rows if r['date']!=ds[1]],ds)['n'],0)

    def test_archive_keeps_dates_outside_latest_api_window(self):
        a=record('510300',{'2026-11-10':1e10,'2026-11-11':9.9e9})
        a.update(url='https://query.sse.com.cn/old')
        old=merge_history({}, {'510300':a},'2026-11-11')
        b=record('510300',{'2026-11-12':9.8e9,'2026-11-13':9.7e9});b.update(url='https://query.sse.com.cn/new')
        new=merge_history(old,{'510300':b},'2026-11-13')
        self.assertEqual(len(old['items']['510300']['observations']),2)
        self.assertEqual(len(new['items']['510300']['observations']),4)

    def test_revision_records_old_value_and_first_seen(self):
        a=record('510300',{'2026-11-13':1e10});a.update(url='a',fetched_at='2026-11-13T19:00:00+08:00')
        old=merge_history({}, {'510300':a},'2026-11-13')
        b=record('510300',{'2026-11-13':9e9});b.update(url='b')
        new=merge_history(old,{'510300':b},'2026-11-13')
        self.assertEqual(new['revisions'][0]['old']['shares'],1e10)
        self.assertEqual(new['items']['510300']['observations']['2026-11-13']['first_seen_at'],a['fetched_at'])
        self.assertEqual(old['items']['510300']['observations']['2026-11-13']['shares'],1e10)
        older=merge_history(new,{'510300':a},'2026-11-13')
        self.assertEqual(older,new)

    def test_no_turnover_estimates_allowed_in_official_archive(self):
        a=record('510300',{'2026-11-13':1e10});a.update(url='a',scope='vendor_denominator_unverified')
        with self.assertRaises(ValueError):merge_history({}, {'510300':a},'2026-11-13')

    def test_official_signal_survives_api_window_roll_forward(self):
        ds=[(date(2026,10,20)+timedelta(days=i)).isoformat() for i in range(18)]
        values={d:1e10*.99**i for i,d in enumerate(ds)}
        a=record('510300',values);a.update(url='a')
        history=merge_history({}, {'510300':a},ds[-1])
        recent=record('510300',{d:values[d] for d in ds[-7:]});recent.update(url='a')
        prices={'510300':[dict(code='510300',date=d,close=2,vwap=2,amount=100,shares=1,share_low=.9,share_high=1.1,net=0) for d in ds]}
        rules=read_json(CONFIG/'rules.json')
        full=attach(summarize({'510300':a},prices,ds,ds[-1]),prices,ds,[],rules)
        rolled=attach(summarize({'510300':recent},prices,ds,ds[-1],history=history),prices,ds,[],rules)
        self.assertEqual(full['instruments']['510300']['tracking'],rolled['instruments']['510300']['tracking'])
        r=rolled['instruments']['510300']['tracking']['latest']
        self.assertEqual(r['risk']['state'],'流出加速')
        self.assertFalse(r['w20']['complete'])
        self.assertTrue(r['w10']['complete'])


def releasable():
    instruments={c:dict(source='szse' if c.startswith('1') else 'sse',next_morning_collected=True,
        fetched_at='2026-11-14T11:00:00+08:00',latest=dict(date='2026-11-13',share_change=-1,fetched_at='2026-11-14T11:00:00+08:00')) for c in CORE}
    return dict(build_id='test',end='2026-11-13',discovery=dict(catalogue_complete=True,scanned=759),
        exchange=dict(instruments=instruments,latest=dict(complete=True,date='2026-11-13'),w5=dict(complete=True),issues=[]))


class PublicationGates(unittest.TestCase):
    def test_complete_verified_data_allowed(self):
        self.assertTrue(assess(releasable(),'2026-11-14T12:00:00+08:00')['passed'])

    def test_provisional_deep_exchange_data_not_published_as_final(self):
        a=releasable();a['exchange']['instruments']['159915']['next_morning_collected']=False
        self.assertFalse(assess(a,'2026-11-14T12:00:00+08:00')['passed'])

    def test_failed_fetch_cannot_be_hidden_by_cached_complete_data(self):
        a=releasable();a['exchange']['instruments']['510300']['error']='timeout'
        self.assertFalse(assess(a,'2026-11-14T12:00:00+08:00')['passed'])

    def test_missing_stale_or_wrong_date_cannot_be_published(self):
        a=releasable();a['exchange']['instruments'].pop('510300')
        self.assertFalse(assess(a,'2026-11-14T12:00:00+08:00')['passed'])
        a=releasable();self.assertFalse(assess(a,'2026-11-16T12:00:00+08:00')['passed'])
        a=releasable();a['exchange']['instruments']['510300']['latest']['date']='2026-11-12'
        self.assertFalse(assess(a,'2026-11-14T12:00:00+08:00')['passed'])

if __name__=='__main__':unittest.main()
