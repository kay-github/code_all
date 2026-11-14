import sys,unittest,copy,math,tempfile,contextlib,io
from unittest.mock import patch
from pathlib import Path
from datetime import date,timedelta,datetime
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from v3_common import CONFIG,read,TZ,sym
from v3_sources import parse_nav,group_key,category,make_pool
from v3_engine import *
from v3_pipeline import facts_for,disclosures,representative_groups

RULES=read(CONFIG/'rules.json')

def synthetic(n=120,seed=7):
    rng=np.random.default_rng(seed);days=[(date(2026,5,1)+timedelta(days=i)).isoformat() for i in range(n)]
    market=rng.normal(0,1,n);sector=.7*market+rng.normal(0,1,n);de=.5*market+rng.normal(0,1,n)
    contrast=rng.normal(0,.8,n);other=.6*market+rng.normal(0,.5,n)
    factors={d:dict(target=float(sector[i]+de[i]),contrast=float(contrast[i]),broad=float(sector[i]),core=float(sector[i]+.08*other[i]),hs300=float(market[i]),chinext=float(other[i])) for i,d in enumerate(days)}
    return days,factors

class NAVAndDates(unittest.TestCase):
    def test_missing_return_is_not_zero(self):
        d='2026-11-13';stamp=datetime(2026,11,13,tzinfo=TZ).timestamp()*1000
        out=parse_nav('var Data_netWorthTrend = [{"x":'+str(stamp)+',"y":2.5}];',d)
        self.assertIsNone(out[0]['ret']);self.assertEqual(out[0]['date'],d)

    def test_distribution_not_misclassified_as_loss(self):
        cal=['2026-11-12','2026-11-13'];rows=[dict(date=cal[0],nav=2,ret=0,distribution=''),dict(date=cal[1],nav=1.9,ret=0,distribution='每份派现金0.1元')]
        rets,issues=nav_returns(rows,cal);self.assertEqual(rets[cal[-1]],0)
        rows[-1]['distribution']='';rets,issues=nav_returns(rows,cal);self.assertNotIn(cal[-1],rets)

    def test_missing_previous_day_cannot_be_daily_return(self):
        cal=['2026-11-11','2026-11-12','2026-11-13'];rows=[dict(date=cal[0],nav=2,ret=0),dict(date=cal[2],nav=2.1,ret=5)]
        rets,issues=nav_returns(rows,cal);self.assertNotIn(cal[2],rets)

    def test_price_gap_does_not_bridge(self):
        cal=['2026-11-11','2026-11-12','2026-11-13'];self.assertEqual(price_returns([[cal[0],0,2],[cal[2],0,3]],cal),{})

    def test_no_future_nav_in_cutoff(self):
        stamps=[datetime(2026,11,12,tzinfo=TZ).timestamp()*1000,datetime(2026,11,13,tzinfo=TZ).timestamp()*1000]
        text='var Data_netWorthTrend = '+__import__('json').dumps([dict(x=s,y=2,equityReturn=0) for s in stamps])+';'
        self.assertEqual(len(parse_nav(text,'2026-11-12')),1)

    def test_stale_fund_does_not_get_latest_window_signal(self):
        ds,f=synthetic();r={d:float(f[d]['target']*.2) for d in ds[:-1]}
        self.assertFalse(window_fit(r,f,ds,ds[-1],40,'broad',RULES)['usable'])

class ExposureModels(unittest.TestCase):
    def test_other_holding_can_create_false_change_and_control_removes_it(self):
        ds,f=synthetic(seed=31);rng=np.random.default_rng(40)
        extra={d:(.1 if i<100 else 1.)*(f[d]['target']-f[d]['broad'])+float(rng.normal(0,.7)) for i,d in enumerate(ds)}
        r={d:.5*extra[d]+.3*f[d]['hs300'] for d in ds}
        raw=change_fit(r,f,ds,ds[-1],20,'broad',RULES)
        controlled=change_fit(r,f,ds,ds[-1],20,'broad',RULES,extra)
        self.assertGreater(raw['value'],.25)
        self.assertAlmostEqual(controlled['value'],0,places=8)

    def test_holdout_does_not_train_on_test_returns(self):
        ds,f=synthetic();r={d:.2*f[d]['target']+.3*f[d]['broad'] for d in ds}
        fit=holdout(r,f,ds,ds[-1],RULES)
        self.assertLess(fit['train_end'],fit['test_start'])
        self.assertEqual(fit['test_end'],ds[-1]);self.assertAlmostEqual(fit['model_mse'],0,places=10)

    def test_free_market_exposure_recovers_known_positive_weight(self):
        rng=np.random.default_rng(20261114);m=rng.normal(0,1,300);s=.8*m+rng.normal(0,.3,300);de=.5*m+rng.normal(0,.15,300);y=.2*(s+de)+.4*s+.1*m
        old=np.linalg.lstsq(np.column_stack([np.ones(len(m)),de,s-m]),y-m,rcond=None)[0][1]
        X=np.column_stack([np.ones(len(m)),de,s,m]);fit=fit_matrix(X,y,range(len(y)))
        self.assertLess(old,0);self.assertAlmostEqual(fit['coef'][1],.2,places=9)

    def test_unequal_stock_exposures_have_separate_contrast(self):
        ds,f=synthetic();r={d:.2*(f[d]['target']+f[d]['contrast'])+.3*f[d]['broad']+.1*f[d]['hs300'] for d in ds}
        fit=window_fit(r,f,ds,ds[-1],60,'broad',RULES)
        self.assertAlmostEqual(fit['value'],.2,places=8)
        self.assertAlmostEqual(fit['stock502_sensitivity'],.2,places=8)
        self.assertAlmostEqual(fit['stock308_sensitivity'],0,places=8)

    def test_change_uses_disjoint_windows_and_free_control_changes(self):
        ds,f=synthetic();r={d:(.1 if i<100 else .25)*f[d]['target']+(.3 if i<100 else .5)*f[d]['hs300']+.2*f[d]['broad'] for i,d in enumerate(ds)}
        change=change_fit(r,f,ds,ds[-1],20,'broad',RULES)
        self.assertEqual(change['before_end'],ds[-21]);self.assertEqual(change['recent_start'],ds[-20])
        self.assertAlmostEqual(change['value'],.15,places=8)

    def test_future_data_does_not_change_prefix(self):
        ds,f=synthetic();r={d:.2*f[d]['target']+.4*f[d]['broad'] for d in ds};cut=ds[89]
        full=window_fit(r,f,ds,cut,40,'broad',RULES)
        small=window_fit({d:r[d] for d in ds[:90]},{d:f[d] for d in ds[:90]},ds[:90],cut,40,'broad',RULES)
        self.assertEqual(full,small)

    def test_unidentifiable_stock_factor_is_rejected(self):
        ds,f=synthetic()
        for d in ds:f[d]['target']=f[d]['broad']
        r={d:f[d]['broad']*.8 for d in ds};fit=window_fit(r,f,ds,ds[-1],40,'broad',RULES)
        self.assertFalse(fit['usable'])

    def test_joint_hac_uncertainty_finite(self):
        ds,f=synthetic();rng=np.random.default_rng(16);r={d:.2*f[d]['target']+.3*f[d]['broad']+float(rng.normal(0,.2)) for d in ds}
        fit=change_fit(r,f,ds,ds[-1],20,'broad',RULES)
        self.assertTrue(fit['usable']);self.assertGreater(fit['se'],0);self.assertTrue(fit['low']<=fit['value']<=fit['high'])

    def test_zero_exposure_not_forced_into_long_position(self):
        ds,f=synthetic();r={d:.2*f[d]['hs300']+.3*f[d]['broad'] for d in ds}
        fit=window_fit(r,f,ds,ds[-1],60,'broad',RULES);self.assertAlmostEqual(fit['value'],0,places=9)

    def test_short_windows_do_not_expand_to_missing_older_dates(self):
        ds,f=synthetic();r={d:.2*f[d]['target'] for d in ds};r.pop(ds[-2]);r.pop(ds[-3]);r.pop(ds[-4])
        self.assertFalse(window_fit(r,f,ds,ds[-1],20,'broad',RULES)['usable'])

    def test_by_adjustment_known_values(self):
        out=by_adjust([.0001,.04,.7]);self.assertAlmostEqual(out[0],.00055);self.assertAlmostEqual(out[1],.11);self.assertEqual(out[2],1)

class DisclosureAndGrouping(unittest.TestCase):
    def test_enhanced_index_disclosure_is_retained_without_trade_claim(self):
        cat={'000001':dict(code='000001',name='某指数增强A',type='指数型-股票'),
             '000002':dict(code='000002',name='某ETF',type='指数型-股票'),
             '000003':dict(code='000003',name='某增强债券A',type='债券型-混合二级')}
        pool=make_pool(cat,[dict(rows=[dict(HOLDER_CODE=c) for c in cat])],[])
        self.assertEqual([p['code'] for p in pool],['000001']);self.assertEqual(pool[0]['category'],'enhanced_index')
        result=signal(dict(date='2026-11-13',nav_date='2026-11-13',category='enhanced_index'),RULES)
        self.assertIsNone(result['level']);self.assertFalse(result['confirmed_transaction'])

    def test_enrichment_retry_preserves_archived_parent_sources(self):
        from v3_common import write,digest
        from v3_enrich import enrich
        from v3_pipeline import load_snapshot
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);parent=root/'parent';parent.mkdir();analysis=root/'analysis';analysis.mkdir()
            original=dict(url='old',body='original',fetched_at='2026-11-14T12:00:00+08:00')
            write(parent/'prices_sh688702.json.gz',original)
            parsed=dict(prices={'688702':dict(error='missing qfq')},fund_portfolios={'000001':dict(period='2026-09-30',holdings=[dict(code='688702',weight_pct=8)])})
            write(parent/'parsed.json.gz',parsed)
            manifest=dict(run_id='parent',end='2026-11-13',created_at='2026-11-14T12:00:00+08:00',parsed_hash=digest(parsed),sources={'688702':dict(file='prices_sh688702.json.gz',hash=digest(original))})
            write(parent/'manifest.json',manifest);write(analysis/'analysis.json.gz',dict(rows=[],report_period='2026-09-30'))
            def fake_kline(code,end,folder):
                rec=dict(url='new',body='retried');name='prices_'+code+'.json.gz';write(folder/name,rec)
                return rec,dict(file=name,hash=digest(rec)),dict(error='missing qfq')
            with patch('v3_enrich.DATA',root/'new'),patch('v3_enrich.kline',fake_kline),contextlib.redirect_stdout(io.StringIO()):
                enriched=enrich(parent/'manifest.json',analysis)
            target=root/'new/raw'/enriched['run_id']/'manifest.json'
            load_snapshot(target,True)
            self.assertEqual(read(parent/'prices_sh688702.json.gz'),original)
            self.assertNotEqual(enriched['sources']['688702']['file'],enriched['sources']['extra_688702']['file'])

    def test_beijing_stock_does_not_use_shanghai_symbol(self):
        self.assertEqual(sym('920045'),'bj920045');self.assertEqual(sym('300502'),'sz300502')

    def test_strong_candidate_requires_fund_specific_review(self):
        row=dict(date='2026-11-13',nav_date='2026-11-13',category='active_domestic',adjusted_p=.0001,
          change={s:dict(usable=True,value=.2,low=.1,high=.3,recent=.3,p_value=.00001,identifiable=True) for s in ['broad','core']},
          models={s:{'40':dict(usable=True,r2=.8)} for s in ['broad','core']},holdout=dict(usable=True,gain=.1))
        self.assertEqual(signal(row,RULES)['level'],2)
        row['fund_review']=dict(status='passed');self.assertEqual(signal(row,RULES)['level'],3)
        row['fund_review']=dict(status='not_supported');s=signal(row,RULES)
        self.assertEqual(s['level'],1);self.assertEqual(s['statistical_priority'],3)
        self.assertFalse(s['confirmed_transaction'])
        for f in row['change'].values():f['recent']=-.1
        self.assertIn('负向关联缓和',signal(row,RULES)['label'])

    def test_missing_portfolio_cannot_pass(self):
        ds,f=synthetic();r={d:.2*f[d]['target'] for d in ds}
        self.assertEqual(portfolio_review(None,{},r,f,ds,ds[-1],RULES,'2026-09-30')['status'],'not_reviewed')
        result=portfolio_review(dict(period='2026-09-30',holdings=[dict(code='000001',weight_pct=8)]),{},r,f,ds,ds[-1],RULES,'2026-09-30')
        self.assertEqual(result['status'],'insufficient');self.assertEqual(result['coverage'],0)

    def test_missing_stock_is_unknown_not_zero(self):
        mapping={'001170':{'2026-09-30':{'300502':dict(weight_pct=9.98)}}}
        facts=facts_for(['001170'],mapping,'2026-09-30');self.assertFalse(facts['current']['both_reported']);self.assertNotIn('300308',facts['current']['stocks'])

    def test_earlier_disclosure_does_not_become_current(self):
        mapping={'001170':{'2026-06-30':{'300502':dict(weight_pct=9)}}}
        f=facts_for(['001170'],mapping,'2026-09-30');self.assertIsNone(f['current']);self.assertEqual(f['last_known']['period'],'2026-06-30')

    def test_name_grouping_preserves_currency_and_tenor(self):
        self.assertNotEqual(group_key('某基金(人民币)A'),group_key('某基金(美元)A'))
        self.assertNotEqual(group_key('某基金一年持有A'),group_key('某基金三年持有A'))
        self.assertEqual(group_key('某基金混合A'),group_key('某基金混合C'))

    def test_no_active_fund_excluded_only_for_growth_name(self):
        self.assertEqual(category('某科创成长混合A','混合型-偏股'),'active_domestic')
        self.assertEqual(category('某创业板ETF','指数型-股票'),'passive_or_index')

    def test_representative_prefers_fresh_data_not_weight_or_return(self):
        pool=[dict(code='000001',name='某基金A',source='seed',group_key='某基金'),dict(code='000002',name='某基金C',source='disclosed_union',group_key='某基金')]
        nav={'000001':dict(last='2026-11-12',rows=[]),'000002':dict(last='2026-11-13',rows=[])}
        groups=representative_groups(pool,nav,['2026-11-12','2026-11-13'],{},'2026-11-13');self.assertEqual(groups[0]['code'],'000002')

    def test_future_original_report_not_used_for_earlier_knowledge_date(self):
        item=read(CONFIG/'verified_reports.json')['items'][0]
        mapping,aliases,issues=disclosures([],dict(items=[item]),'2026-11-13','2026-10-01')
        self.assertEqual(aliases,{});self.assertFalse(mapping)

    def test_verified_original_can_supply_missing_provider_record(self):
        item=read(CONFIG/'verified_reports.json')['items'][0]
        mapping,aliases,issues=disclosures([],dict(items=[item]),'2026-11-13','2026-11-14')
        self.assertEqual(mapping['001170']['2026-09-30']['300502']['shares'],1746575)
        self.assertEqual(aliases['017612'],'001170')

    def test_model_never_confirms_actual_trade(self):
        row=dict(date='2026-11-13',nav_date='2026-11-12',category='active_domestic')
        s=signal(row,RULES);self.assertIsNone(s['level']);self.assertFalse(s['confirmed_transaction'])

if __name__=='__main__':unittest.main()
