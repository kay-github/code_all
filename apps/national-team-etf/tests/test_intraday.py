# -*- coding: utf-8 -*-
"""盘中模块验收：合成数据明确标注，绝不冒充真实行情。"""
import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest import mock

import intraday as I
from v2_common import CORE, INDEX


def rec(code, *, pct=0.0, price=4.0, premium=0.0, amount=100000.0,
        quote='20261114103000', vol=100000.0):
    return dict(code=code, name='合成-' + code, price=price, prev_close=price,
                open=price, vol_hand=vol, amount_wan=amount, turnover_pct=1.0,
                pct=pct, high=price, low=price, premium_pct=premium,
                iopv=price, quote_time=quote, raw='')


class IntradayTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        d = Path(self.tmp.name)
        self.patches = [
            mock.patch.object(I, 'IDIR', d),
            mock.patch.object(I, 'LOCK', d / 'intraday.lock'),
            mock.patch.object(I, 'STATE_FILE', d / 'state.json'),
            mock.patch.object(I, 'LATEST_FILE', d / 'latest.json'),
            mock.patch.object(I, 'BASELINE_FILE', d / 'baseline.json'),
            mock.patch.object(I, 'PENDING_FILE', d / 'pending.jsonl'),
            mock.patch.object(I, 'LOG_FILE', d / 'run.log'),
            mock.patch.object(I, 'PROFILE_DIR', d / 'profiles'),
        ]
        for p in self.patches:
            p.start()
        d.mkdir(parents=True, exist_ok=True)
        self.d = d
        self.addCleanup(self._cleanup)

    def _cleanup(self):
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    # ---- 交易时段与日期 ----
    def test_session_state_weekend_and_lunch(self):
        sat = datetime(2026, 11, 14, 10, 0, tzinfo=I.TZ)
        self.assertEqual(I.session_state(sat), 'holiday')
        fri = datetime(2026, 11, 13, 12, 0, tzinfo=I.TZ)
        self.assertEqual(I.session_state(fri), 'lunch')
        self.assertEqual(I.session_state(datetime(2026, 11, 13, 10, 0, tzinfo=I.TZ)), 'open')
        self.assertEqual(I.session_state(datetime(2026, 11, 13, 9, 20, tzinfo=I.TZ)), 'auction')

    def test_freshness_never_means_no_support(self):
        at = datetime(2026, 11, 13, 10, 31, tzinfo=I.TZ)
        fresh = {'a': dict(quote_time='20261114103000')}  # 日期错位
        self.assertEqual(I.freshness(fresh, at)[3], 'date_mismatch')
        stale = {'a': dict(quote_time='20261113090000')}
        self.assertEqual(I.freshness(stale, at)[3], 'stale')
        good = {'a': dict(quote_time='20261113103030')}
        self.assertEqual(I.freshness(good, at)[3], 'fresh')
        self.assertEqual(I.freshness({}, at)[3], 'unavailable')
        # 过期行情不得产出高等级结论
        sig = dict(sync=dict(active_count=10, total=15, breadth=.9, family_count=5),
                   cold_start=False)
        self.assertEqual(I.decide_level(sig, {}, 'stale'), 'L0')

    # ---- 规则 ----
    def test_cold_start_never_escalates(self):
        records = {c: rec(c, pct=.5) for c in list(CORE)[:5]}
        for fam, sym in list(INDEX.items())[:3]:
            records[sym[2:]] = rec(sym[2:], pct=0.0)
        state = I.init_state()
        sig = I.compute_signals(records, state, dict(complete=False, per_code={}))
        self.assertTrue(sig['cold_start'])
        self.assertIn('L1', I.decide_level(sig, state, 'fresh'))
        # 冷启动最多 L1，即使多通道共振
        sig['sync']['breadth'], sig['sync']['family_count'] = .95, 6
        self.assertEqual(I.decide_level(sig, state, 'fresh'), 'L1')

    def test_no_new_event_is_silent(self):
        state = I.init_state()
        sig = dict(rows=[dict(code='510300', family='沪深300', channels=['放量'],
                              premium=0.3, activity_ratio=3.0, relative=0.4,
                              direction='support_clue', counter_evidence=[])],
                   sync=dict(active_count=1, total=15, breadth=.07,
                             families=['沪深300'], family_count=1),
                   leadership='support_clue', cold_start=False)
        first = I.update_events(state, sig, 'L1', '2026-11-13', '2026-11-13T10:31:00+08:00')
        self.assertEqual([k for k, _ in first], ['new'])
        second = I.update_events(state, sig, 'L1', '2026-11-13', '2026-11-13T10:32:00+08:00')
        self.assertEqual(second, [], '同一事件状态不变时必须静默')
        third = I.update_events(state, sig, 'L2', '2026-11-13', '2026-11-13T10:33:00+08:00')
        self.assertEqual([k for k, _ in third], ['escalate'])

    def test_notification_fields_and_identity_discipline(self):
        state = I.init_state()
        sig = dict(rows=[dict(code='510300', family='沪深300', channels=['放量'],
                              premium=0.3, activity_ratio=3.0, relative=0.4,
                              direction='support_clue', counter_evidence=['溢价收窄'])],
                   sync=dict(active_count=1, total=15, breadth=.07,
                             families=['沪深300'], family_count=1),
                   leadership='support_clue', cold_start=False, quote_time='2026-11-13T10:30:00+08:00')
        emitted = I.update_events(state, sig, 'L1', '2026-11-13', '2026-11-13T10:31:00+08:00')
        n = I.build_notification(emitted[0][0], emitted[0][1], sig, 'fresh', 30,
                                 '2026-11-13T10:31:00+08:00')
        for f in I.RULES['alerts']['require_fields']:
            self.assertIn(f, n, '提醒缺少字段 ' + f)
        self.assertIn('未确认', n['identity_status'])
        # 合规声明可以出现「概率/金额」字样，但不得输出任何数值型金额或概率字段
        for forbidden in ('national_team_amount', 'buy_amount', 'probability', 'confidence'):
            self.assertNotIn(forbidden, n)
        self.assertNotIn(forbidden, n['evidence'])
        self.assertTrue(n['counter_evidence'])
        self.assertTrue(n['pending_verification'])

    def test_replay_is_marked_not_live(self):
        state = I.init_state()
        sig = dict(rows=[dict(code='510300', family='沪深300', channels=['放量'],
                              premium=0.3, activity_ratio=3.0, relative=0.4,
                              direction='support_clue', counter_evidence=[])],
                   sync=dict(active_count=1, total=15, breadth=.07,
                             families=['沪深300'], family_count=1),
                   leadership='support_clue', cold_start=False)
        emitted = I.update_events(state, sig, 'L1', '2026-11-13',
                                  '2026-11-13T10:31:00+08:00', replay=True)
        self.assertTrue(emitted[0][1]['replayed'])
        n = I.build_notification('new', emitted[0][1], sig, 'fresh', 30,
                                 '2026-11-13T10:31:00+08:00', replay=True)
        self.assertTrue(n['replayed'])

    # ---- 断网、休市与恢复（对应 intraday.py 最后一轮编辑） ----
    @staticmethod
    def _friday():
        return datetime(2026, 11, 13, 10, 31, tzinfo=I.TZ)

    def test_network_failure_is_logged_not_crashed(self):
        state = I.init_state()
        with mock.patch.object(I, 'tz_now', return_value=self._friday()), \
             mock.patch.object(I, 'fetch_snapshot', side_effect=RuntimeError('network down')):
            out = I.tick(state, None, at='2026-11-13T10:31:00+08:00')
        self.assertEqual(out['session'], 'open')
        self.assertEqual(out['freshness'], 'unavailable')
        self.assertEqual(out['level'], 'L0', '数据不可用不得产出高等级结论')
        self.assertEqual(out['coverage']['total_received'], 0)
        faults = [n for n in out['alerts'] if n['kind'] == 'fault']
        self.assertEqual(len(faults), 1)
        self.assertEqual(faults[0]['data_freshness']['status'], 'unavailable')
        self.assertIn('未确认', faults[0]['identity_status'])

    def test_out_of_session_is_not_a_data_fault(self):
        state = I.init_state()
        sat = datetime(2026, 11, 14, 10, 31, tzinfo=I.TZ)
        empty = ({}, dict(requested=15, received=0, source='qt.gtimg.cn'))
        with mock.patch.object(I, 'tz_now', return_value=sat), \
             mock.patch.object(I, 'fetch_snapshot', return_value=empty):
            out = I.tick(state, None, at='2026-11-14T10:31:00+08:00')
        self.assertEqual(out['session'], 'holiday')
        self.assertTrue(out['out_of_session'])
        self.assertEqual(out['freshness'], 'out_of_session')
        self.assertEqual(out['level'], 'L0')
        self.assertFalse([n for n in out['alerts'] if n['kind'] == 'fault'],
                         '休市不刷新行情属正常，不得误报采集故障')
        self.assertIn('不解释为没有托底', out['session_note'])

    def test_fault_recovers_once_then_is_silent(self):
        state = I.init_state()
        t = self._friday()
        with mock.patch.object(I, 'tz_now', return_value=t), \
             mock.patch.object(I, 'fetch_snapshot', side_effect=RuntimeError('down')):
            out1 = I.tick(state, None, at='2026-11-13T10:31:00+08:00')
        self.assertTrue([n for n in out1['alerts'] if n['kind'] == 'fault'])

        recs = {'510300': rec('510300', quote='20261113103200')}
        good = (recs, dict(requested=15, received=1, source='qt.gtimg.cn'))
        with mock.patch.object(I, 'tz_now', return_value=t.replace(minute=32)), \
             mock.patch.object(I, 'fetch_snapshot', return_value=good):
            out2 = I.tick(state, None, at='2026-11-13T10:32:00+08:00')
        kinds = [n['kind'] for n in out2['alerts']]
        self.assertIn('recover', kinds, '断网时业务日未知，恢复后仍须找到原故障并发 recover')
        self.assertNotIn('fault', kinds)
        self.assertEqual(out2['freshness'], 'fresh')

        recs2 = {'510300': rec('510300', quote='20261113103300')}
        good2 = (recs2, dict(requested=15, received=1, source='qt.gtimg.cn'))
        with mock.patch.object(I, 'tz_now', return_value=t.replace(minute=33)), \
             mock.patch.object(I, 'fetch_snapshot', return_value=good2):
            out3 = I.tick(state, None, at='2026-11-13T10:33:00+08:00')
        self.assertNotIn('recover', [n['kind'] for n in out3['alerts']],
                         '恢复后不得重复提醒')
        self.assertFalse(state['fault_sent'])

    # ---- 并发锁 ----
    def test_duplicate_start_blocked(self):
        I.acquire_lock()
        with self.assertRaises(SystemExit):
            I.acquire_lock()
        I.release_lock()
        I.acquire_lock()
        I.release_lock()

    # ---- 基线 ----
    def test_baseline_cold_start_without_history(self):
        b = I.build_baseline()
        self.assertFalse(b['complete'])
        self.assertEqual(b['observed_days'], 0)
        self.assertIn('不伪造', b['note'])

    def test_baseline_needs_min_trading_days(self):
        for i in range(3):
            day = '2026-11-%02d' % (10 + i)
            prof = {c: {'10:%02d' % m: 1000.0 + m for m in range(60)} for c in list(CORE)[:5]}
            I.write_json(I.PROFILE_DIR / (day + '.json'), prof)
        b = I.build_baseline()
        self.assertEqual(b['observed_days'], 3)
        self.assertFalse(b['complete'], '交易日不足 min_days 时不得解除冷启动')

    # ---- 快照解析 ----
    def test_qt_fields_mapping(self):
        # 合成一行，验证字段位（价格/时间戳/折溢价/估值）与文档一致
        f = ['1'] * 88
        f[1], f[2], f[3], f[6], f[30], f[32], f[37], f[38], f[77], f[78] = (
            '测试ETF', '510300', '4.083', '8510502', '20261114103000',
            '-0.75', '348904', '1.87', '-0.24', '4.0927')
        body = '~'.join(f)
        seg = 'v_sh510300="' + body + '"'
        with mock.patch.object(I, 'http_get', return_value=seg.encode('gbk')):
            out, meta = I.fetch_snapshot(I.etf_pairs(['510300']))
        self.assertEqual(out['510300']['price'], 4.083)
        self.assertEqual(out['510300']['premium_pct'], -0.24)
        self.assertEqual(out['510300']['iopv'], 4.0927)
        self.assertEqual(out['510300']['quote_time'], '20261114103000')
        self.assertEqual(meta['received'], 1)


class OfficialGateTest(unittest.TestCase):
    def test_missing_official_share_blocks_release(self):
        from v2_release import assess
        a = dict(end='2026-11-13', build_id='test',
                 exchange=dict(instruments={}, latest=dict(complete=False),
                               w5=dict(complete=False), issues=[]),
                 discovery=dict(catalogue_complete=True, scanned=True))
        gate = assess(a)
        self.assertFalse(gate['passed'])
        self.assertTrue(any('核心正式份额' in x for x in gate['problems']))


if __name__ == '__main__':
    unittest.main(verbosity=2)
