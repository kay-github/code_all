"""周报：整理延迟、重复提醒、故障和未解释事件（Asia/Shanghai）。

只读归档，不改任何阈值、不回写事件、不发结论级身份判断。
规则/阈值的调整只以「研究建议」文字列出，绝不自动改成有利于历史案例的参数。
"""
from __future__ import annotations
import argparse
import json
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

from v2_common import ROOT, DATA, CORE, now, read_json, write_json, quantile

TZ8 = timezone(timedelta(hours=8))
IDIR = DATA.parent / 'intraday'
WDIR = IDIR / 'weekly'
POSTCLOSE = IDIR / 'postclose.json'


def jlines(path):
    if not path.exists():
        return []
    out = []
    for line in path.read_text(encoding='utf-8', errors='replace').splitlines():
        if not line.strip():
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out


def dates_window(days):
    today = datetime.now(TZ8).date()
    return [(today - timedelta(days=i)).isoformat() for i in range(days - 1, -1, -1)]


def collect(days):
    dates = dates_window(days)
    snaps, events, notes = [], [], []
    for d in dates:
        sub = IDIR / d
        for x in jlines(sub / 'snapshots.jsonl'):
            snaps.append(dict(date=d, **x))
        for x in jlines(sub / 'events.jsonl'):
            events.append(dict(date=d, **x))
        for x in jlines(sub / 'notifications.jsonl'):
            notes.append(dict(date=d, **x))
    return dates, snaps, events, notes


def summarize(dates, snaps, events, notes):
    metas = [x.get('meta', {}) for x in snaps]
    lags = [m['lag_seconds'] for m in metas
            if isinstance(m.get('lag_seconds'), (int, float)) and m['lag_seconds'] >= 0]
    fresh = Counter(m.get('freshness', 'unknown') for m in metas)
    session = Counter(m.get('session', 'unknown') for m in metas)
    kinds = Counter(x.get('kind', 'unknown') for x in events)
    note_kinds = Counter(x.get('kind', 'unknown') for x in notes)
    ids = Counter(x.get('id') for x in notes if x.get('id'))
    duplicates = {k: v for k, v in ids.items() if v > 1}

    # 未解释事件：出现过 L1+ 线索，但归档里没有同日盘后核对记录，留作人工复核清单。
    pc = read_json(POSTCLOSE) or {}
    pc_day = pc.get('business_date')
    unexplained = []
    seen = set()
    for x in events:
        e = x.get('event', {}) or {}
        lvl = e.get('level', 'L0')
        key = (x['date'], e.get('family'), e.get('direction'))
        if lvl in ('L1', 'L2', 'L3') and key not in seen:
            seen.add(key)
            unexplained.append(dict(date=x['date'], family=e.get('family'),
                                    direction=e.get('direction'), level=lvl,
                                    postclose_checked=(pc_day == x['date'] and pc.get('complete')),
                                    note='盘中线索，不是国家队买卖确认；需与当日正式份额分别核对'))
    return dict(
        window=dict(start=dates[0], end=dates[-1], days=len(dates)),
        collection=dict(ticks=len(snaps), by_session=dict(session),
                        by_freshness=dict(fresh),
                        lag_seconds=dict(samples=len(lags),
                                         p50=quantile(lags, .5) if lags else None,
                                         p90=quantile(lags, .9) if lags else None,
                                         p95=quantile(lags, .95) if lags else None,
                                         maximum=max(lags) if lags else None)),
        events=dict(total=len(events), by_kind=dict(kinds),
                    faults=kinds.get('fault', 0), recoveries=kinds.get('recover', 0)),
        notifications=dict(total=len(notes), by_kind=dict(note_kinds),
                           duplicate_ids=duplicates, duplicate_count=len(duplicates),
                           pending_backlog=len(jlines(IDIR / 'notify_pending.jsonl'))),
        unexplained=unexplained,
        postclose=dict(business_date=pc_day, coverage=pc.get('coverage'),
                       complete=pc.get('complete'), pending_review=pc.get('pending_review')),
    )


def render(s):
    c, e, n = s['collection'], s['events'], s['notifications']
    lag = c['lag_seconds']
    lines = [
        '# 国家队ETF持续追踪 · 运行周报',
        '',
        '- 统计窗口（Asia/Shanghai）：%s ~ %s（%d 天）' % (s['window']['start'], s['window']['end'], s['window']['days']),
        '- 本报告只描述采集器运行情况，不含国家队身份或买卖金额结论。',
        '',
        '## 采集与延迟',
        '',
        '- 采集轮数：%d；时段分布：%s' % (c['ticks'], json.dumps(c['by_session'], ensure_ascii=False)),
        '- 时效分布：%s' % json.dumps(c['by_freshness'], ensure_ascii=False),
        '- 行情延迟（秒）：样本 %d，p50=%s，p90=%s，p95=%s，最大=%s'
        % (lag['samples'], lag['p50'], lag['p90'], lag['p95'], lag['maximum']),
        '',
        '## 事件与提醒',
        '',
        '- 事件 %d 条：%s' % (e['total'], json.dumps(e['by_kind'], ensure_ascii=False)),
        '- 采集故障 %d 次，恢复 %d 次。' % (e['faults'], e['recoveries']),
        '- 提醒 %d 条：%s' % (n['total'], json.dumps(n['by_kind'], ensure_ascii=False)),
        '- 重复提醒 id：%d 个；通知队列积压：%d 条。' % (n['duplicate_count'], n['pending_backlog']),
        '',
        '## 未解释事件（人工复核清单）',
        '',
    ]
    if s['unexplained']:
        for x in s['unexplained']:
            lines.append('- %s %s %s %s；盘后已核对=%s'
                         % (x['date'], x['family'], x['direction'], x['level'], x['postclose_checked']))
    else:
        lines.append('- 无。')
    lines += [
        '',
        '> 盘中线索不等于国家队买卖确认。二级市场买卖可能不改变总份额，盘后无净申购不能单独判定盘中线索错误。',
        '',
        '## 盘后状态',
        '',
        '- 业务日 %s，覆盖 %s/%s，complete=%s，pending_review=%s'
        % (s['postclose']['business_date'], s['postclose']['coverage'],
           len(CORE), s['postclose']['complete'], s['postclose']['pending_review']),
        '',
        '## 研究建议（不自动改参数）',
        '',
        '- 若某周故障/重复提醒偏多，先补采证据与样本，再单独评估阈值；本报告不修改 config/intraday_rules.json。',
        '- 若要调整放量、折溢价、同步宽度或持续性阈值，必须同时记录误报、漏报与发现延迟的变化，不能只挑有利案例。',
        '- 冷启动解除需累计可用交易日达到 min_days，并保持来源可追溯。',
        '',
        '生成时间：%s' % now(),
    ]
    return '\n'.join(lines) + '\n'


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--days', type=int, default=7)
    p.add_argument('--stdout', action='store_true', help='只打印，不写文件')
    a = p.parse_args()
    dates, snaps, events, notes = collect(a.days)
    s = summarize(dates, snaps, events, notes)
    s['generated_at'] = now()
    md = render(s)
    if a.stdout:
        print(md)
        return
    WDIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(TZ8).date().isoformat()
    (WDIR / (stamp + '.md')).write_text(md, encoding='utf-8')
    write_json(WDIR / (stamp + '.json'), s)
    (IDIR / 'weekly_report.log').open('a', encoding='utf-8').write(
        '%s 周报 %s~%s 采集%d 提醒%d 故障%d\n'
        % (now(), s['window']['start'], s['window']['end'],
           s['collection']['ticks'], s['notifications']['total'], s['events']['faults']))
    print(md)


if __name__ == '__main__':
    main()
