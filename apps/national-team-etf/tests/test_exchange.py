"""Accounting safeguards for direct exchange shares, independent of turnover estimates."""
import sys
from pathlib import Path
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from v2_common import CORE
from v2_exchange import parse, summarize

DAYS=['2026-11-12','2026-11-13']

def record(code,values):
    if code.startswith('1'):
        return dict(code=code,scope='exchange_disclosed_total',source='szse',
            fetched_at='2026-11-14T11:30:00+08:00',payload=[dict(metadata=dict(pagecount=1,
                cols=dict(current_size='基金规模(万份)')),data=[
                dict(fund_code=code,size_date=d,current_size=str(s/10000)) for d,s in values.items()])])
    return dict(code=code,scope='exchange_disclosed_total',source='sse',
        fetched_at='2026-11-14T11:30:00+08:00',payload=dict(result=[
        dict(SEC_CODE=code,STAT_DATE=d,TOT_VOL=str(s/10000)) for d,s in values.items()]))

def prices():
    return {c:[dict(date=d,vwap=2,close=2,shares=1e10,share_low=1e10,share_high=1e10,net=999)
               for d in DAYS] for c in CORE}

class OfficialAccounting(unittest.TestCase):
    def test_real_sse_units_and_delta(self):
        rec=record('512100',dict(zip(DAYS,[18603217600,17135217600])))
        result=summarize({'512100':rec},prices(),DAYS,DAYS[-1])
        r=result['instruments']['512100']['latest']
        self.assertEqual(r['share_change'],-1468000000)
        self.assertAlmostEqual(r['net_estimate'],-29.36)
        self.assertEqual(r['vendor_net'],999)
        self.assertTrue(r['outside_vendor_rounding'])

    def test_official_pair_never_uses_vendor_previous_shares(self):
        rec=record('510300',{DAYS[-1]:1e10-1e8})
        result=summarize({'510300':rec},prices(),DAYS,DAYS[-1])
        r=result['instruments']['510300']['latest']
        self.assertIsNone(r['previous_shares']);self.assertIsNone(r['net_estimate'])
        self.assertFalse(result['latest']['complete']);self.assertIsNone(result['latest']['net_estimate'])

    def test_missing_one_member_cannot_be_reported_as_full_total(self):
        records={c:record(c,dict(zip(DAYS,[1e10,1e10-1e8]))) for c in CORE}
        full=summarize(records,prices(),DAYS,DAYS[-1])
        self.assertEqual(full['latest']['outflow_count'],15)
        self.assertAlmostEqual(full['latest']['net_estimate'],-30)
        records.pop('510300')
        partial=summarize(records,prices(),DAYS,DAYS[-1])
        self.assertIsNone(partial['latest']['net_estimate'])
        self.assertAlmostEqual(partial['latest']['partial_net_estimate'],-28)

    def test_skipped_official_business_day_is_not_daily_flow(self):
        rec=record('510300',{'2026-11-11':1e10,'2026-11-13':9e9})
        result=summarize({'510300':rec},prices(),['2026-11-11']+DAYS,DAYS[-1])
        self.assertIsNone(result['instruments']['510300']['latest']['share_change'])

    def test_wrong_code_scope_or_conflicting_duplicate_rejected(self):
        r=record('510300',{DAYS[-1]:1e10});r['payload']['result'][0]['SEC_CODE']='510500'
        with self.assertRaises(ValueError):parse(r,DAYS[-1])
        r=record('510300',{DAYS[-1]:1e10});r['scope']='unknown'
        with self.assertRaises(ValueError):parse(r,DAYS[-1])
        r=record('510300',{DAYS[-1]:1e10});r['payload']['result'].append(dict(r['payload']['result'][0],TOT_VOL='1'))
        with self.assertRaises(ValueError):parse(r,DAYS[-1])

    def test_szse_business_date_not_shifted_and_maturity_recorded(self):
        rec=dict(code='159915',scope='exchange_disclosed_total',source='szse',
            fetched_at='2026-11-13T18:00:00+08:00',payload=[dict(metadata=dict(pagecount=1,
                cols=dict(current_size='基金规模<br>(万份)')),data=[
                dict(size_date=DAYS[0],fund_code='159915',current_size='4,478,345.49'),
                dict(size_date=DAYS[1],fund_code='159915  ',current_size='4,520,045.49')])])
        parsed=parse(rec,DAYS[-1]);self.assertEqual(parsed[DAYS[-1]],45200454900)
        result=summarize({'159915':rec},prices(),DAYS,DAYS[-1])
        x=result['instruments']['159915']
        self.assertEqual(x['latest']['share_change'],417000000)
        self.assertFalse(x['next_morning_collected'])
        rec['fetched_at']='2026-11-14T11:30:00+08:00'
        self.assertTrue(summarize({'159915':rec},prices(),DAYS,DAYS[-1])['instruments']['159915']['next_morning_collected'])

    def test_verified_share_action_not_redemption(self):
        rec=record('510310',dict(zip(DAYS,[2e10,1e10])))
        action=[dict(code='510310',effective_date=DAYS[-1],share_ratio=.5,status='verified')]
        r=summarize({'510310':rec},prices(),DAYS,DAYS[-1],action)['instruments']['510310']['latest']
        self.assertEqual(r['share_change'],0);self.assertEqual(r['net_estimate'],0)

if __name__=='__main__':unittest.main()
