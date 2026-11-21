# -*- coding: utf-8 -*-
"""三阶段版本：盘后初值的口径与替代关系。"""
import unittest

import v2_stages as S


def analysis(**over):
    a = dict(
        build_id='B1', end='2026-11-16', built_at='2026-11-16T17:00:00+08:00',
        pools=dict(core15=dict(
            members=['510300', '159919'],
            latest=dict(net=2.5, net_low=-1.0, net_high=6.0,
                        valid_members=2, expected_members=2, complete=True))),
        exchange=dict(
            stage='初值或不完整',
            latest=dict(complete=False, net_estimate=None, valid_members=0),
            instruments=dict(
                {'510300': dict(latest=dict(date='2026-11-13')),
                 '159919': dict(latest=dict(date='2026-11-13'))})),
        inventory=dict(latest=dict(total_units=5.6, net_added_units=3.1,
                                   current_ratio=0.56, complete=True)),
    )
    a.update(over)
    return a


def series(ratios):
    out = {}
    for code, (prev, cur) in ratios.items():
        out[code] = [dict(date='2026-11-13', shares=prev, amount=10.0),
                     dict(date='2026-11-16', shares=cur, amount=12.0)]
    return out


def analysis_full_official(**over):
    a = analysis()
    a['exchange'] = dict(
        stage='初值或不完整',
        latest=dict(complete=True, net_estimate=7.5, valid_members=2, expected_members=2),
        instruments={
            '510300': dict(source='sse', latest=dict(date='2026-11-16', net_estimate=2.5)),
            '159919': dict(source='szse', latest=dict(date='2026-11-16', net_estimate=5.0)),
        })
    a.update(over)
    return a


class StageSummary(unittest.TestCase):
    def test_stage_identity_and_confidence(self):
        x = S.build(analysis(), series({'510300': (100, 101), '159919': (50, 50)}))
        self.assertEqual(x['stage'], 'postclose_provisional')
        self.assertEqual(x['confidence'], 'provisional')
        self.assertTrue(x['pending_review'])
        self.assertIsNone(x['superseded_by'])
        self.assertEqual(x['business_date'], '2026-11-16')

    def test_vendor_is_never_marked_reliable(self):
        x = S.build(analysis(), series({'510300': (100, 101), '159919': (50, 50)}))
        self.assertFalse(x['vendor']['reliable'])
        self.assertTrue(any('反推' in r for r in x['vendor']['reasons']))

    def test_flattened_detects_unchanged_shares(self):
        x = S.build(analysis(), series({'510300': (100, 101), '159919': (50, 50)}))
        self.assertEqual(x['flattened']['count'], 1)
        self.assertEqual(x['flattened']['members'][0]['code'], '159919')

    def test_no_flattening_when_shares_really_move(self):
        x = S.build(analysis(), series({'510300': (100, 101), '159919': (50, 47)}))
        self.assertEqual(x['flattened']['count'], 0)

    def test_ratio_median_and_near_count_are_reported(self):
        x = S.build(analysis(), series({'510300': (100, 101), '159919': (50, 50)}))
        self.assertAlmostEqual(x['flattened']['ratio_median'], 1.005, places=6)
        self.assertEqual(x['flattened']['near_count'], 1)

    def test_official_coverage_counts_only_current_business_day(self):
        x = S.build(analysis(), series({'510300': (100, 101), '159919': (50, 50)}))
        self.assertEqual(x['official']['coverage'], 0)
        self.assertFalse(x['official']['complete'])
        self.assertIsNone(x['official']['net_yi'])

    def test_amount_sums_only_current_day(self):
        x = S.build(analysis(), series({'510300': (100, 101), '159919': (50, 50)}))
        self.assertAlmostEqual(x['vendor']['amount_yi'], 24.0, places=2)

    def test_missing_series_does_not_crash_or_zero_fill(self):
        x = S.build(analysis(), {})
        self.assertEqual(x['flattened']['count'], 0)
        self.assertAlmostEqual(x['vendor']['amount_yi'], 0.0)
        self.assertIsNone(x['flattened']['ratio_median'])

    def test_missing_inventory_stays_none(self):
        a = analysis(inventory={})
        x = S.build(a, series({'510300': (100, 101), '159919': (50, 50)}))
        self.assertIsNone(x['inventory']['total_units'])
        self.assertFalse(x['inventory']['complete'])

    def test_revision_risk_is_explicit(self):
        x = S.build(analysis(), series({'510300': (100, 101), '159919': (50, 50)}))
        self.assertIn('不能当定稿', x['revision_risk'])
        self.assertIn('I0', x['identity'])


class EveningAndPartial(unittest.TestCase):
    def test_evening_uses_official_total_and_exchange_split(self):
        x = S.build(analysis_full_official(), series({'510300': (100, 101), '159919': (50, 50)}))
        self.assertEqual(x['stage'], 'postclose_evening')
        self.assertEqual(x['confidence'], 'evening')
        self.assertEqual(x['primary'], 'official')
        self.assertAlmostEqual(x['primary_net_yi'], 7.5)
        self.assertAlmostEqual(x['official']['net_yi'], 7.5)
        self.assertAlmostEqual(x['official']['sse']['net_yi'], 2.5)
        self.assertAlmostEqual(x['official']['szse']['net_yi'], 5.0)
        self.assertTrue(x['official']['complete'])
        self.assertFalse(x['inventory']['comparable'])
        self.assertIn('SZSE', x['revision_risk'])
        self.assertIn('次晨', x['revision_risk'])

    def test_partial_shows_only_sse_subtotal_and_no_full_total(self):
        a = analysis_full_official()
        a['exchange']['latest'] = dict(complete=False, net_estimate=None, valid_members=1, expected_members=2)
        a['exchange']['instruments']['159919']['latest'] = dict(date='2026-11-13')
        x = S.build(a, series({'510300': (100, 101), '159919': (50, 50)}))
        self.assertEqual(x['stage'], 'postclose_partial')
        self.assertEqual(x['confidence'], 'partial')
        self.assertEqual(x['primary'], 'official_sse')
        self.assertAlmostEqual(x['primary_net_yi'], 2.5)
        self.assertIsNone(x['official']['net_yi'])
        self.assertFalse(x['official']['complete'])
        self.assertEqual(x['official']['sse']['coverage'], 1)
        self.assertEqual(x['official']['szse']['coverage'], 0)
        self.assertIn('不展示核心15只完整合计', x['complete_total_policy'])
        self.assertFalse(x['inventory']['comparable'])

    def test_provisional_keeps_vendor_primary(self):
        x = S.build(analysis(), series({'510300': (100, 101), '159919': (50, 50)}))
        self.assertEqual(x['stage'], 'postclose_provisional')
        self.assertEqual(x['primary'], 'vendor')
        self.assertAlmostEqual(x['primary_net_yi'], 2.5)
        self.assertTrue(x['inventory']['comparable'])


class Supersede(unittest.TestCase):
    def test_supersede_keeps_original_values(self):
        src = S.build(analysis(), series({'510300': (100, 101), '159919': (50, 50)}))
        fixed = S.mark_superseded(src, 'B2')
        self.assertIsNone(src['superseded_by'])
        self.assertTrue(src['pending_review'])
        self.assertEqual(fixed['superseded_by'], 'B2')
        self.assertFalse(fixed['pending_review'])
        self.assertEqual(fixed['vendor']['net_yi'], src['vendor']['net_yi'])
        self.assertIn('B2', fixed['next_step'])

    def test_supersede_empty_is_noop(self):
        self.assertIsNone(S.mark_superseded(None, 'B2'))


if __name__ == '__main__':
    unittest.main()
