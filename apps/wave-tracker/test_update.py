import json
import unittest

from update import OUTPUT, cycle_check, video_study, RULES


class WaveUpdateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.snapshot = json.loads(OUTPUT.read_text(encoding='utf-8'))
        cls.bars = {index['symbol']: index['bars'] for index in cls.snapshot['indices']}

    def test_anchored_projections_use_different_degrees(self):
        bars = self.bars['sz399006']
        item = RULES['indices'][0]
        by_day = {row[0]: row for row in bars}
        size_a = by_day[item['start']][2] - by_day[item['a']][3]
        case = video_study(bars, item, by_day, size_a)
        levels = {(line['of'], line['ratio']): line for line in case['lines']}
        self.assertAlmostEqual(levels['C/A', 1.236]['computed'], 2236.80, delta=0.02)
        self.assertAlmostEqual(levels['C5/C1', 0.809]['computed'], 2205.02, delta=0.02)
        self.assertEqual(levels['C/A', 1.236]['drawn'], 2246.95)
        self.assertGreater(case['c3Ratio'], 2)

    def test_star_video_elapsed_includes_the_anchor_as_a_separate_convention(self):
        item = RULES['indices'][1]
        bars = [row for row in self.bars[item['symbol']] if row[0] <= '2026-11-16']
        by_day = {row[0]: row for row in bars}
        size_a = by_day[item['start']][2] - by_day[item['a']][3]
        case = video_study(bars, item, by_day, size_a)
        self.assertEqual(case['c5Sessions'] + int(case['duration']['includeAnchor']), 3)
        self.assertEqual((case['duration']['min'], case['duration']['max']), (12, 13))
        self.assertEqual(case['duration']['spokenFrom'], '2026-11-26')

    def test_star_19_week_reference_stays_fixed_after_new_low(self):
        sh = [row for row in self.bars['sh000001'] if row[0] <= '2026-11-20']
        star = [row for row in self.bars['sh000688'] if row[0] <= '2026-11-20']
        next_week = [['2026-11-23', 1160, 1170, 1120, 1145]]
        pending = cycle_check(sh, star + next_week)
        self.assertAlmostEqual(pending['starReference'], 1132.33, delta=0.02)
        self.assertEqual(pending['starPriceBreak'], '2026-11-23')
        self.assertIsNone(pending['starBreak'])
        final = cycle_check(sh, star + next_week + [['2026-11-27', 1120, 1131, 1100, 1110]])
        self.assertEqual(final['starBreak'], '2026-11-27')
        self.assertEqual(final['starReference'], pending['starReference'])


if __name__ == '__main__':
    unittest.main()
