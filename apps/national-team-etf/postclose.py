"""盘后初值轻量检查：只刷新交易所正式份额，不跑全量历史/发现扫描，不改正式构建、不发布。

用于 16:30 / 19:00 / 21:30 的有界重试。次晨 10:00 的完整复核仍走
`python update.py --phase final --deploy`，本脚本绝不绕过次晨发布检查。
"""
from __future__ import annotations
import argparse
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

import v2_exchange
from v2_common import CORE, DATA, ROOT, now, read_json, write_json

TZ8 = __import__('datetime').timezone(timedelta(hours=8))
OUT = DATA.parent / 'intraday'
POSTCLOSE = OUT / 'postclose.json'
LOG = OUT / 'postclose.log'


def log(msg):
    OUT.mkdir(parents=True, exist_ok=True)
    line = '%s %s\n' % (now(), msg)
    with LOG.open('a', encoding='utf-8') as f:
        f.write(line)
    print(line.rstrip(), flush=True)


def actual_business_day():
    """周末/休市保留最近实际业务日；不硬编码日期。"""
    las = read_json(DATA / 'latest.json') or {}
    if las.get('end'):
        return las['end']
    d = datetime.now(TZ8).date()
    while d.weekday() >= 5:
        d -= timedelta(days=1)
    return d.isoformat()


def run_once(end):
    run = OUT / 'postclose_raw' / now().replace(':', '').replace('-', '').replace('+', '_')
    refs = v2_exchange.collect(sorted(CORE), end, run)
    records = {}
    for code in sorted(CORE):
        r = read_json(run / (code + '.json')) or {}
        if not r.get('error'):
            records[code] = r
    parsed = {}
    for code, r in records.items():
        try:
            values = v2_exchange.parse(r, end)
        except Exception:
            values = {}
        if values:
            d = max(values)
            parsed[code] = dict(date=d, shares=values[d], source=r.get('source'),
                                fetched_at=r.get('fetched_at'), url=r.get('url'),
                                next_morning_collected=bool(r.get('next_morning_collected')))
    n = sum(1 for x in parsed.values() if x['date'] == end)
    return dict(
        generated_at=now(), business_date=end,
        disclosure_stage='收盘初值 / 待次晨复核',
        pending_review=True,
        coverage=n, expected=len(CORE), complete=(n == len(CORE)),
        instruments=parsed,
        raw_run=str(run.relative_to(ROOT)) if run.is_relative_to(ROOT) else str(run),
        complete_total_policy='覆盖不足时不展示核心15只完整合计，缺口不补0',
        note='深交所T日晚间初值仅供参考，以T+1早间更新为准；本文件不覆盖生产页、不作为正式发布依据',
        next_step='次晨10:00运行 python update.py --phase final --deploy 完成复核与发布',
    )


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--end', help='业务日；默认取最新已核验构建的业务日，周末不硬编码')
    p.add_argument('--retries', type=int, default=3, help='有界重试次数')
    p.add_argument('--wait', type=int, default=20, help='退避基数秒')
    p.add_argument('--status', action='store_true')
    a = p.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    if a.status:
        print((read_json(POSTCLOSE) or {'status': '尚无盘后初值'}).__repr__())
        return
    end = a.end or actual_business_day()
    last = None
    for i in range(a.retries):
        try:
            last = run_once(end)
            write_json(POSTCLOSE, last)
            log('第%d次：覆盖 %d/%d，阶段 %s' % (i + 1, last['coverage'], last['expected'],
                                              last['disclosure_stage']))
            if last['complete']:
                log('正式份额已齐；仍保留待复核状态，等待次晨完整流程')
                return
            log('数据尚未更新，保留等待状态（不把部分样本包装成完整合计）')
        except Exception as exc:
            log('第%d次采集异常：%r' % (i + 1, exc))
        if i < a.retries - 1:
            wait = a.wait * (2 ** i)
            log('等待 %d 秒后重试' % wait)
            time.sleep(wait)
    if last:
        write_json(POSTCLOSE, dict(last, retries_exhausted=True))
    log('有界重试结束，保留上一版线上页面；不自动发布')


if __name__ == '__main__':
    main()
