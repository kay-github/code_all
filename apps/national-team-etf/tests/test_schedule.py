# -*- coding: utf-8 -*-
"""调度层验收：时间口径、命令清单、次晨判断、周报纪律。合成数据明确标注。"""
import json
import unittest
from pathlib import Path
from unittest import mock

import scheduler as S
import morning_review as M
import weekly_report as W
from v2_common import ROOT, DATA, CORE


class SchedulerTest(unittest.TestCase):
    def test_task_list_covers_all_required_times(self):
        names = [t['name'] for t in S.TASKS]
        self.assertEqual(len(names), len(set(names)))
        joined = ' '.join(' '.join(t['sc']) for t in S.TASKS)
        for hhmm in ('16:30', '19:00', '21:30', '10:00', '09:00'):
            self.assertIn(hhmm, joined)
        # 次日 10:00 必须覆盖周六：用 DAILY，不能只排工作日
        morning = next(t for t in S.TASKS if t['name'] == 'GJD_Morning_1000')
        self.assertIn('DAILY', morning['sc'])
        self.assertNotIn('BYDAY', ' '.join(morning['sc']))
        # 盘中常驻与看门狗都要在
        self.assertIn('GJD_Intraday_Loop', names)
        self.assertIn('GJD_Intraday_Watchdog', names)

    def test_no_hardcoded_business_date_in_scheduling_code(self):
        for name in ('scheduler.py', 'morning_review.py', 'weekly_report.py'):
            src = (ROOT / name).read_text(encoding='utf-8')
            self.assertNotIn('2026-11-13', src, '%s 不得硬编码业务日' % name)
        self.assertIn('Asia/Shanghai', (ROOT / 'config/intraday_rules.json').read_text(encoding='utf-8')
                      or 'Asia/Shanghai')

    def test_timezone_check_reports_required_fields(self):
        ok, tz = S.tz_check()
        for k in ('offset_hours', 'daylight_saving_active', 'tzname', 'local_time'):
            self.assertIn(k, tz)
        self.assertIsInstance(ok, bool)

    def test_prerequisites_include_scripts_and_rules(self):
        problems, _ = S.prerequisites()
        self.assertEqual(problems, [])

    def test_runner_is_pure_ascii_and_covers_modes(self):
        with mock.patch.object(S, 'RUNNER', Path(ROOT) / '_scheduled_run.test.tmp.cmd'):
            try:
                S.build_runner()
                raw = S.RUNNER.read_bytes()
                raw.decode('ascii')          # 中文编码坑的硬约束
                text = raw.decode('ascii')
                for mode in S.MODES:
                    self.assertIn('goto ' + mode, text)
                self.assertIn('intraday.py --loop', text)
                self.assertIn('morning_review.py', text)
            finally:
                S.RUNNER.unlink(missing_ok=True)


class MorningReviewTest(unittest.TestCase):
    def _mock_read(self, latest, postclose):
        def f(path):
            p = str(path).replace('\\', '/')
            if p.endswith('data/v2/latest.json'):
                return latest
            if p.endswith('postclose.json'):
                return postclose
            return None
        return f

    def test_new_business_day_needs_review(self):
        latest = dict(end='2026-11-12', build_id='20261113T101500_0800_aaaaaaaaaa')
        pc = dict(business_date='2026-11-13', pending_review=True)
        with mock.patch.object(M, 'read_json', side_effect=self._mock_read(latest, pc)):
            pd, reason = M.pending_business_day()
        self.assertEqual(pd, '2026-11-13')
        self.assertIn('晚于', reason)

    def test_same_day_build_still_needs_next_morning(self):
        latest = dict(end='2026-11-13', build_id='20261113T173000_0800_aaaaaaaaaa')
        pc = dict(business_date='2026-11-13', pending_review=True)
        with mock.patch.object(M, 'read_json', side_effect=self._mock_read(latest, pc)):
            pd, _ = M.pending_business_day()
        self.assertEqual(pd, '2026-11-13', '当日收盘初值构建不算次晨复核')

    def test_next_morning_build_is_skipped(self):
        latest = dict(end='2026-11-13', build_id='20261114T101500_0800_aaaaaaaaaa')
        pc = dict(business_date='2026-11-13', pending_review=True)
        with mock.patch.object(M, 'read_json', side_effect=self._mock_read(latest, pc)):
            pd, reason = M.pending_business_day()
        self.assertIsNone(pd)
        self.assertIn('无待复核', reason)

    def test_verify_targets_cover_page_json_and_csv(self):
        seen = []

        def fake(url, timeout=15, tries=2):
            seen.append(url)
            if url.endswith('.csv'):
                return 200, 'code,date,net\n510300,2026-11-13,-1\n', None
            if url.endswith('/gjd/'):
                return 200, '<html>build-XYZ</html>', None
            return 200, json.dumps({'build_id': 'build-XYZ'}), None

        with mock.patch.object(M, 'http_text', side_effect=fake):
            r = M.verify_online('build-XYZ')
        self.assertEqual(len(seen), 4, '页面、latest.json、release.json、CSV 四项都要核对')
        self.assertTrue(r['all_ok'])
        self.assertEqual(r['checks']['csv']['rows'], 2)
        self.assertEqual(r['checks']['latest_json']['remote_build_id'], 'build-XYZ')


class WeeklyReportTest(unittest.TestCase):
    def test_report_is_descriptive_and_does_not_tune_rules(self):
        s = W.summarize(['2026-11-14'], [], [], [])
        md = W.render(s)
        self.assertIn('不自动改参数', md)
        self.assertIn('盘中线索不等于国家队买卖确认', md)
        self.assertIn('不含国家队身份', md)
        self.assertEqual(s['collection']['ticks'], 0)
        before = (ROOT / 'config/intraday_rules.json').read_bytes()
        W.render(W.summarize(['2026-11-14'], [], [], []))
        self.assertEqual((ROOT / 'config/intraday_rules.json').read_bytes(), before,
                         '周报不得改写规则阈值')

    def test_duplicate_notifications_are_counted(self):
        notes = [dict(id='x', kind='new'), dict(id='x', kind='new'), dict(id='y', kind='fault')]
        with mock.patch.object(W, 'jlines', return_value=[]), \
             mock.patch.object(W, 'read_json', return_value={}):
            s = W.summarize(['2026-11-14'], [], [], notes)
        self.assertEqual(s['notifications']['duplicate_count'], 1)
        self.assertEqual(s['notifications']['duplicate_ids']['x'], 2)
        self.assertEqual(s['events']['faults'], 0)


if __name__ == '__main__':
    unittest.main(verbosity=2)
