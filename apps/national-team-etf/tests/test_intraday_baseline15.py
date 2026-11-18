# -*- coding: utf-8 -*-
"""15分钟分段基线与交易分钟窗口验收。全部为合成数据，不冒充真实行情。"""
import json
import tempfile
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

import intraday as I
import v2_intraday_baseline as B

TZ = timezone(timedelta(hours=8))


def snap(code, day, hhmmss, amount, pct=0.1, premium=0.0):
    return dict(code=code, name='合成-' + code, price=4.0, prev_close=4.0, open=4.0,
                vol_hand=1000.0, amount_wan=amount, turnover_pct=1.0, pct=pct,
                high=4.0, low=4.0, premium_pct=premium, iopv=4.0,
                quote_time=day.replace('-', '') + hhmmss, raw='')


def feed(state, code, rows):
    for row in rows:
        I.push_window(state, code, row)


def bars_for_day(day, base=10.0, skip=None):
    out = []
    for a, b in B.SESSIONS:
        m = a
        while m + 5 <= b:
            label = B._hhmm(m + 5)
            if label != skip:
                t = datetime.combine(date.fromisoformat(day),
                                     datetime.min.time().replace(hour=(m + 5) // 60, minute=(m + 5) % 60),
                                     tzinfo=TZ)
                out.append(dict(t=t, amount_yi=base))
            m += 5
    return out


class SessionMathTest(unittest.TestCase):
    def test_session_index_skips_lunch(self):
        def at(h, m):
            return datetime(2026, 11, 18, h, m, tzinfo=TZ)
        self.assertEqual(I.session_index(at(9, 0)), 0)
        self.assertEqual(I.session_index(at(11, 30)), 120)
        self.assertEqual(I.session_index(at(13, 0)), 120)
        self.assertEqual(I.session_index(at(13, 5)), 125)
        self.assertEqual(I.session_index(at(15, 30)), 240)
        self.assertEqual(I.trading_gap_minutes(at(11, 20), at(13, 5)), 15)
        self.assertIsNone(I.trading_gap_minutes(at(11, 20), at(13, 5) + timedelta(days=1)))

    def test_segments_have_16_slots_and_correct_bounds(self):
        segs = I.session_segments(date(2026, 11, 18))
        self.assertEqual(len(segs), 16)
        self.assertEqual(segs[0][0], '09:45')
        self.assertEqual(segs[7][0], '11:30')
        self.assertEqual(segs[8][0], '13:15')
        self.assertEqual(segs[-1][0], '15:00')


class WindowTest(unittest.TestCase):
    def test_window_never_crosses_lunch(self):
        state = I.init_state()
        feed(state, '510300', [snap('510300', '2026-11-18', '132500', 1000.0),
                               snap('510300', '2026-11-18', '132600', 1010.0)])
        self.assertIsNone(I.window_delta(state, '510300', 'premium', 15),
                          '13:00 重开后不足15交易分钟，不得回溯到上午')
        feed(state, '510300', [snap('510300', '2026-11-18', '134000', 1100.0)])
        self.assertEqual(I.window_delta(state, '510300', 'amount', 15), 100.0,
                         '13:25→13:40 是完整15交易分钟')

    def test_window_requires_close_anchor(self):
        state = I.init_state()
        feed(state, '510300', [snap('510300', '2026-11-18', '130500', 1000.0),
                               snap('510300', '2026-11-18', '132400', 1100.0)])
        self.assertIsNone(I.window_delta(state, '510300', 'amount', 15),
                          '锚点偏离目标超过2分钟时必须缺数，不能拿近似值')


class SegmentTest(unittest.TestCase):
    def test_latest_closed_segment_from_snapshots(self):
        state = I.init_state()
        feed(state, '510300', [snap('510300', '2026-11-18', '094500', 1000.0),
                               snap('510300', '2026-11-18', '100000', 1200.0)])
        cutoff = datetime(2026, 11, 18, 10, 0, 5, tzinfo=TZ)
        seg = I.latest_segment(state, '510300', date(2026, 11, 18), cutoff)
        self.assertIsNotNone(seg)
        self.assertEqual(seg['slot'], '10:00')
        self.assertAlmostEqual(seg['amount_wan'], 200.0)
        self.assertLessEqual(max(seg['start_offset'], seg['end_offset']), 2.0)

    def test_missing_endpoint_is_not_fabricated(self):
        state = I.init_state()
        feed(state, '510300', [snap('510300', '2026-11-18', '094500', 1000.0),
                               snap('510300', '2026-11-18', '100500', 1200.0)])
        cutoff = datetime(2026, 11, 18, 10, 5, 5, tzinfo=TZ)
        self.assertIsNone(I.latest_segment(state, '510300', date(2026, 11, 18), cutoff),
                          '端点过期只能缺数，不能用错位快照凑段')


class ProfileGapTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.d = Path(self.tmp.name)
        self.p = mock.patch.object(I, 'PROFILE_DIR', self.d)
        self.p.start()
        self.addCleanup(self.p.stop)
        self.addCleanup(self.tmp.cleanup)

    def test_low_frequency_delta_not_poured_into_one_minute(self):
        state = I.init_state()
        state['prev'] = {'510300': dict(quote_time='20261118093100', amount_wan=1000.0)}
        records = {'510300': snap('510300', '2026-11-18', '094600', 2000.0)}
        I.accumulate_profile('2026-11-18', records, state)
        prof = json.loads((self.d / '2026-11-18.json').read_text(encoding='utf-8'))
        self.assertEqual(prof, {}, '跨15分钟的差值不得塞进单分钟桶')

    def test_one_minute_delta_is_archived(self):
        state = I.init_state()
        state['prev'] = {'510300': dict(quote_time='20261118093100', amount_wan=1000.0)}
        records = {'510300': snap('510300', '2026-11-18', '093200', 1100.0)}
        I.accumulate_profile('2026-11-18', records, state)
        prof = json.loads((self.d / '2026-11-18.json').read_text(encoding='utf-8'))
        self.assertEqual(prof['510300']['09:32'], 100.0)


class BaselinePayloadTest(unittest.TestCase):
    def test_median_prev_and_incomplete_day(self):
        days = ['2026-11-%02d' % d for d in (10, 11, 12, 13, 16, 17)]
        bars = []
        for d in days:
            bars += bars_for_day(d, base=10.0)
        bars += bars_for_day('2026-11-09', base=99.0, skip='10:00')
        payload = B.build_payload({'510300': bars}, crosschecks={'510300': dict(status='ok')},
                                  min_days=5, max_days=20)
        self.assertTrue(payload['complete'])
        self.assertEqual(payload['as_of_date'], '2026-11-17')
        self.assertNotIn('2026-11-09', payload['complete_days'], '缺一段的交易日必须整日剔除')
        slot = payload['per_code']['510300']['slots']['10:00']
        self.assertEqual(slot['n'], 6)
        self.assertAlmostEqual(slot['median'], 30.0)
        self.assertAlmostEqual(slot['prev'], 30.0)
        self.assertEqual(slot['prev_date'], '2026-11-17')

    def test_crosscheck_mismatch_blocks_complete(self):
        bars = []
        for d in ['2026-11-%02d' % x for x in (10, 11, 12, 13, 16)]:
            bars += bars_for_day(d, base=10.0)
        bad = B.build_payload({'510300': bars},
                              crosschecks={'510300': dict(status='mismatch', max_diff_pct=5.0)},
                              min_days=5)
        self.assertFalse(bad['complete'], '勾稽不通过不得解除冷启动')

    def test_insufficient_days_keeps_cold_start(self):
        bars = []
        for d in ['2026-11-16', '2026-11-17']:
            bars += bars_for_day(d, base=10.0)
        payload = B.build_payload({'510300': bars}, crosschecks={'510300': dict(status='ok')},
                                  min_days=5)
        self.assertEqual(payload['per_code']['510300']['slots'], {})
        self.assertFalse(payload['complete'])


class SegmentSignalTest(unittest.TestCase):
    def _state(self):
        state = I.init_state()
        feed(state, '510300', [snap('510300', '2026-11-18', '094500', 10000.0),
                               snap('510300', '2026-11-18', '100000', 12000.0)])
        return state

    def _records(self):
        return {'510300': snap('510300', '2026-11-18', '100000', 12000.0),
                '000300': snap('000300', '2026-11-18', '100000', 5000.0, pct=0.0)}

    @staticmethod
    def _b15(as_of):
        return dict(complete=True, as_of_date=as_of, complete_days=['2026-11-17'],
                    source='合成',
                    per_code={'510300': {'slots': {'10:00': dict(median=0.1, n=20,
                                                              prev=0.09, prev_date=as_of)}}})

    def test_segment_ratio_uses_published_median(self):
        sig = I.compute_signals(self._records(), self._state(), None,
                                baseline15=self._b15('2026-11-17'),
                                business_date='2026-11-18')
        row = next(x for x in sig['rows'] if x['code'] == '510300')
        self.assertEqual(row['activity_basis'], 'segment15')
        self.assertAlmostEqual(row['activity_ratio'], 2.0, places=3)
        self.assertIn('放量', row['channels'])
        self.assertFalse(sig['cold_start'])
        self.assertEqual(sig['segment_summary']['slot'], '10:00')

    def test_same_day_baseline_is_refused(self):
        sig = I.compute_signals(self._records(), self._state(), None,
                                baseline15=self._b15('2026-11-18'),
                                business_date='2026-11-18')
        row = next(x for x in sig['rows'] if x['code'] == '510300')
        self.assertIsNone(row['activity_ratio'], '基线包含业务日本身时不得自比')
        self.assertEqual(row['baseline15_status'], 'no_baseline')
        self.assertTrue(sig['cold_start'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
