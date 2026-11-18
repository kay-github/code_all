"""15分钟分段成交额基线：单源5分钟K -> 已收齐整段 -> 近20个交易日同段中位数。

只做「通道活跃度」的分母，不产出身份结论，不写正式份额，不进入发布闸门。
纪律：
  - 同一分段序列只认一个来源，不与分时快照、另一供应商拼接。
  - 只取已收齐的整段；缺段标 missing，不补 0。
  - 分段汇总必须与日线成交额勾稽；勾稽不通过则 complete=False，消费方不得升级。
  - 基线自身排除「被消费的业务日」与未来日期，不做前视比较。
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, time, timedelta, timezone
from pathlib import Path

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

from v2_common import CONFIG, CORE, DATA, now, quantile, read_json, symbol, write_json

TZ = timezone(timedelta(hours=8))
IDIR = Path(os.environ.get('GJD_INTRADAY_DIR', DATA.parent / 'intraday')).resolve()
OUT = IDIR / 'baseline15.json'
RAW_DIR = IDIR / 'baseline15_raw'
RULES = (read_json(CONFIG / 'intraday_rules.json') or {}).get('baseline15', {})

SINA = ('https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData'
        '?symbol={sym}&scale=5&ma=no&datalen={n}')
EM_DAILY = ('https://push2his.eastmoney.com/api/qt/stock/kline/get?secid={secid}'
            '&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57'
            '&klt=101&fqt=0&end=20500101&lmt={n}')
HEADERS = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
           'Referer': 'https://finance.sina.com.cn/'}

SESSIONS = ((9 * 60 + 30, 11 * 60 + 30), (13 * 60, 15 * 60))
STEP = 5
SEGMENT = int(RULES.get('segment_minutes', 15) or 15)


def _http(url, timeout=20, tries=2):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except Exception as exc:       # 单只失败不拖垮整批
            last = exc
    raise RuntimeError('%s 请求失败: %r' % (url[:80], last))


def _hhmm(minute):
    return '%02d:%02d' % (minute // 60, minute % 60)


def _slots():
    """16个15分钟整段：(标签, 起始分钟, 结束分钟, 需要的5分钟端点)。"""
    out = []
    for a, b in SESSIONS:
        m = a
        while m + SEGMENT <= b:
            ends = tuple(range(m + STEP, m + SEGMENT + 1, STEP))
            out.append((_hhmm(m + SEGMENT), m, m + SEGMENT, ends))
            m += SEGMENT
    return out


SLOTS = _slots()


def fetch_sina(code, datalen=None, cutoff=None):
    """返回 (元数据, [{t:datetime, amount_yi:float}])；只保留 cutoff 之前已收齐的5分钟端点。"""
    datalen = datalen or int(RULES.get('datalen', 1023))
    sym = symbol(code)
    url = SINA.format(sym=sym, n=datalen)
    raw = _http(url).decode('utf-8', 'ignore')
    rows = json.loads(raw)
    if not isinstance(rows, list) or not rows:
        raise ValueError('新浪未返回可识别的5分钟K')
    cutoff = cutoff or (datetime.now(TZ).replace(microsecond=0) - timedelta(seconds=20))
    bars = []
    for row in rows:
        try:
            t = datetime.strptime(row['day'], '%Y-%m-%d %H:%M:%S').replace(tzinfo=TZ)
            amount = float(row['amount'])
        except (KeyError, TypeError, ValueError):
            continue
        if not math.isfinite(amount) or amount < 0 or t > cutoff:
            continue
        bars.append(dict(t=t, amount_yi=amount / 1e8))
    if not bars:
        raise ValueError('新浪5分钟K无可用端点')
    return dict(url=url, fetched_at=now(), code=code), bars


def fetch_em_daily(code, days=8):
    """东财日线成交额（元），仅用于勾稽，不参与计算。"""
    prefix = '1' if symbol(code).startswith('sh') else '0'
    url = EM_DAILY.format(secid=prefix + '.' + str(code), n=days)
    body = json.loads(_http(url).decode('utf-8', 'ignore'))
    data = (body or {}).get('data') or {}
    klines = data.get('klines') or []
    out = {}
    for line in klines:
        f = line.split(',')
        if len(f) < 7:
            continue
        try:
            out[f[0]] = float(f[6])
        except ValueError:
            continue
    return dict(url=url, code=code, amount=out)


def assemble_days(bars):
    """把5分钟端点拼成15分钟整段；只有16段齐全的交易日才算完整日。"""
    by_day = {}
    for bar in bars:
        by_day.setdefault(bar['t'].date().isoformat(), {})[(bar['t'].hour * 60 + bar['t'].minute)] = bar['amount_yi']
    days = {}
    for day, minutes in by_day.items():
        seg = {}
        for slot, start, end, ends in SLOTS:
            if all(m in minutes for m in ends):
                total = sum(minutes[m] for m in ends)
                if math.isfinite(total) and total >= 0:
                    seg[slot] = total
        days[day] = seg
    return days


def build_payload(bars_by_code, crosschecks=None, *, min_days=None, max_days=None):
    """纯函数：由各代码的5分钟端点生成基线载荷。"""
    min_days = int(min_days or RULES.get('min_days', 5))
    max_days = int(max_days or RULES.get('max_days', 20))
    crosschecks = crosschecks or {}
    per_code, coverage, complete_days = {}, {}, []
    for code in sorted(bars_by_code):
        days = assemble_days(bars_by_code[code])
        full = sorted(d for d, seg in days.items() if len(seg) == len(SLOTS))
        sample = full[-max_days:]
        complete_days += sample
        slots = {}
        for slot, _, _, _ in SLOTS:
            values = [days[d][slot] for d in sample]
            if len(values) < min_days:
                continue
            slots[slot] = dict(median=quantile(values, .5), n=len(values),
                               prev=days[sample[-1]].get(slot) if sample else None,
                               prev_date=sample[-1] if sample else None)
        per_code[code] = dict(days=len(sample), first=sample[0] if sample else None,
                              last=sample[-1] if sample else None, slots=slots)
        coverage[code] = dict(complete_days=len(sample), slots=len(slots),
                              expected_slots=len(SLOTS), missing_slots=len(SLOTS) - len(slots))
    as_of = max(complete_days) if complete_days else None
    bad = [c for c, x in (crosschecks or {}).items() if x.get('status') != 'ok']
    complete = (bool(per_code) and as_of is not None
                and all(v['slots'] == len(SLOTS) for v in coverage.values()))
    return dict(
        as_of_date=as_of,
        per_code=per_code,
        coverage=coverage,
        crosschecks=crosschecks,
        complete_days=sorted(set(complete_days)),
        complete=bool(complete and (not crosschecks or not bad)),
        source=RULES.get('source'),
        note=('同一序列只认单一来源；分段汇总须与日线成交额勾稽。'
              '缺失段不补0；勾稽未通过或样本不足时 complete=False，消费方不得据此升级。'),
    )


def crosscheck_code(code, bars, em):
    """分段汇总 vs 东财日线成交额；只在双方都完整的日期比较。"""
    days = assemble_days(bars)
    limit = float(RULES.get('crosscheck_max_diff_pct', 0.2))
    checks = []
    for day in sorted(days)[-3:]:
        seg = days[day]
        if len(seg) != len(SLOTS) or day not in em.get('amount', {}):
            continue
        total = sum(seg.values())
        ref = em['amount'][day] / 1e8
        if ref <= 0:
            continue
        diff = (total - ref) / ref * 100
        checks.append(dict(date=day, ours_yi=total, reference_yi=ref, diff_pct=diff))
    if not checks:
        return dict(code=code, status='unavailable', note='无可比较的完整日期')
    worst = max(abs(x['diff_pct']) for x in checks)
    return dict(code=code, status='ok' if worst <= limit else 'mismatch',
                max_diff_pct=worst, limit_pct=limit, checks=checks)


def build(codes=None, datalen=None, min_days=None, max_days=None, with_crosscheck=True, out=None):
    codes = sorted(codes or CORE)
    run_id = now().replace(':', '').replace('-', '').replace('+', '_')
    run_dir = RAW_DIR / run_id
    cutoff = datetime.now(TZ).replace(microsecond=0) - timedelta(seconds=20)
    fetched, errors = {}, {}

    def grab(code):
        try:
            meta, bars = fetch_sina(code, datalen=datalen, cutoff=cutoff)
            write_json(run_dir / (code + '.json.gz'),
                       dict(meta=meta, bars=[dict(t=b['t'].isoformat(), amount_yi=b['amount_yi']) for b in bars]))
            return code, bars, None
        except Exception as exc:
            return code, None, repr(exc)

    with ThreadPoolExecutor(max_workers=5) as pool:
        for code, bars, err in pool.map(grab, codes):
            if err:
                errors[code] = err
            else:
                fetched[code] = bars
    if not fetched:
        raise RuntimeError('全部代码取数失败，保留上一版基线：%s' % errors)

    crosschecks = {}
    if with_crosscheck:
        def check(code):
            try:
                return code, crosscheck_code(code, fetched[code], fetch_em_daily(code))
            except Exception as exc:
                return code, dict(code=code, status='unavailable', note=repr(exc))
        with ThreadPoolExecutor(max_workers=5) as pool:
            for code, item in pool.map(check, sorted(fetched)):
                crosschecks[code] = item

    payload = build_payload(fetched, crosschecks, min_days=min_days, max_days=max_days)
    payload.update(generated_at=now(), run_id=run_id,
                   requested=len(codes), received=len(fetched),
                   errors=errors or None, raw_dir=str(run_dir))
    write_json(out or OUT, payload)
    return payload


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--build', action='store_true')
    p.add_argument('--status', action='store_true')
    p.add_argument('--codes')
    p.add_argument('--datalen', type=int)
    p.add_argument('--min-days', type=int)
    p.add_argument('--max-days', type=int)
    p.add_argument('--no-crosscheck', action='store_true')
    a = p.parse_args()
    if a.status:
        b = read_json(OUT) or {}
        print(json.dumps({k: b.get(k) for k in
                          ('generated_at', 'as_of_date', 'complete', 'requested', 'received',
                           'errors', 'run_id')}, ensure_ascii=False, indent=2))
        return
    if not a.build:
        p.print_help()
        return
    codes = a.codes.split(',') if a.codes else None
    b = build(codes=codes, datalen=a.datalen, min_days=a.min_days, max_days=a.max_days,
              with_crosscheck=not a.no_crosscheck)
    print(json.dumps(dict(as_of_date=b['as_of_date'], complete=b['complete'],
                          received=b['received'], requested=b['requested'],
                          complete_days=len(b['complete_days']),
                          mismatch=[c for c, x in (b.get('crosschecks') or {}).items()
                                    if x.get('status') != 'ok'],
                          errors=b.get('errors')), ensure_ascii=False))


if __name__ == '__main__':
    main()
