"""Publish a deterministic, end-of-day snapshot for the three index scenarios."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, time, timedelta, timezone
import hashlib
import json
import math
from pathlib import Path
import tempfile
from urllib.request import Request, urlopen

APP = Path(__file__).resolve().parent
OUTPUT = APP.parents[1] / 'tools' / 'wave-tracker' / 'data' / 'latest.json'
CHINA = timezone(timedelta(hours=8))
RULES = json.loads((APP / 'rules.json').read_text(encoding='utf-8'))
MODEL = '2026-11-23.1'
HISTORY_START = '2026-04-01'
DATE, OPEN, HIGH, LOW, CLOSE = range(5)


def encode(value):
    return (json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(',', ':')) + '\n').encode()


def fetch_json(url, referer):
    request = Request(url, headers={'User-Agent': 'Mozilla/5.0', 'Referer': referer, 'Accept': 'application/json'})
    with urlopen(request, timeout=14) as response:
        return json.load(response)


def quotes(symbol, cutoff, provider):
    if provider == '腾讯行情':
        url = f'https://ifzq.gtimg.cn/appstock/app/fqkline/get?param={symbol},day,,,400,qfq'
        node = fetch_json(url, 'https://gu.qq.com/')['data'][symbol]
        values = [(row[0], row[1], row[3], row[4], row[2]) for row in node['day']]
    else:
        base = 'https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData'
        url = f'{base}?symbol={symbol}&scale=240&ma=no&datalen=400'
        rows = fetch_json(url, 'https://finance.sina.com.cn/')
        values = [(r['day'], r['open'], r['high'], r['low'], r['close']) for r in rows]
    bars = []
    for day, *prices in values:
        day = date.fromisoformat(day[:10]).isoformat()
        if day > cutoff:
            continue
        o, h, l, c = map(float, prices)
        if not all(math.isfinite(p) and p > 0 for p in (o, h, l, c)) or not l <= min(o, c) <= max(o, c) <= h:
            raise ValueError(f'{symbol} {day} OHLC 校验失败')
        bars.append([day, o, h, l, c])
    if len(bars) < 180 or any(a[DATE] >= b[DATE] for a, b in zip(bars, bars[1:])):
        raise ValueError(f'{symbol} 日线缺失或日期顺序异常')
    return bars


def collect(cutoff):
    symbols = [item['symbol'] for item in RULES['indices']]
    providers = ('新浪财经', '腾讯行情')
    with ThreadPoolExecutor(max_workers=6) as pool:
        tasks = {pool.submit(quotes, symbol, cutoff, provider): (symbol, provider)
                 for symbol in symbols for provider in providers}
        results = {}
        for task in as_completed(tasks):
            symbol, provider = tasks[task]
            try:
                results[symbol, provider] = task.result()
            except Exception as error:
                print(f'{symbol} {provider}: {error}', flush=True)
    chosen = {}
    for symbol in symbols:
        available = {p: results[symbol, p] for p in providers if (symbol, p) in results}
        if not available:
            raise RuntimeError(f'{symbol} 两个来源均不可用')
        last = max(series[-1][DATE] for series in available.values())
        current = {p: series for p, series in available.items() if series[-1][DATE] == last}
        primary = next(p for p in providers if p in current)
        if len(current) == 2:
            for a, b in zip(current[providers[0]][-20:], current[providers[1]][-20:]):
                if a[DATE] != b[DATE] or any(abs(p - q) > 0.05 for p, q in zip(a[1:], b[1:])):
                    raise RuntimeError(f'{symbol} 两源近20日行情不一致：{a[DATE]} / {b[DATE]}')
        chosen[symbol] = (current[primary], primary, list(current))
    if len({bars[-1][DATE] for bars, _, _ in chosen.values()}) != 1:
        raise RuntimeError('三个指数末日不一致，保留上一版')
    return chosen


def point(row, field, label):
    return {'date': row[DATE], 'price': round(row[field], 2), 'label': label}


def retests(bars, first_low, origin, first_end):
    """Track one same-degree 3–4–5 interpretation from the low known on 11/20."""
    low = first_low
    rebound = None
    five = None
    for bar in bars:
        if rebound is None:
            if bar[LOW] < low[LOW]:
                low = bar
                continue
            threshold = low[LOW] + 0.236 * (origin - low[LOW])
            if bar[DATE] > low[DATE] and bar[CLOSE] >= threshold:
                rebound = bar
        elif five is None:
            if bar[LOW] < low[LOW]:
                # Daily bars cannot order a same-day high and new low. Use earlier highs.
                five = bar
            elif bar[HIGH] > rebound[HIGH]:
                rebound = bar
        elif bar[LOW] < five[LOW]:
            five = bar
    threshold = low[LOW] + 0.236 * (origin - low[LOW])
    if rebound is not None and rebound[HIGH] >= first_end:
        stage = '普通五浪候选失效：第4浪进入第1浪区间'
    elif five is not None:
        stage = '反弹后再破底：保留第5浪候选'
    elif rebound is not None:
        stage = '出现第4浪反弹候选，观察是否再破底'
    else:
        stage = '等待第4浪反弹证据'
    return {
        'stage': stage,
        'low': point(low, LOW, '第3浪候选低点'),
        'rebound': point(rebound, HIGH, '第4浪候选高点') if rebound else None,
        'five': point(five, LOW, '第5浪候选低点') if five else None,
        'threshold': round(threshold, 2),
    }


def analyze(bars, item, source, checks):
    by_day = {bar[DATE]: bar for bar in bars}
    start, a, b, c4 = (by_day[item[key]] for key in ('start', 'a', 'b', 'c4'))
    size_a = start[HIGH] - a[LOW]
    if not size_a > 0 or not a[LOW] < b[HIGH] < start[HIGH]:
        raise ValueError(f"{item['symbol']} A/B 锚点不满足当前方案")
    c_bars = [bar for bar in bars if bar[DATE] > b[DATE]]
    c_extreme = min(c_bars, key=lambda bar: bar[LOW])
    leg = [bar for bar in c_bars if bar[DATE] > c4[DATE]]
    terminal = min(leg, key=lambda bar: (bar[LOW], -date.fromisoformat(bar[DATE]).toordinal()))
    after_low = [bar for bar in leg if bar[DATE] > terminal[DATE]]
    after_reclaim = [bar for bar in after_low if bar[CLOSE] > c4[HIGH]]
    latest = bars[-1]
    if latest[DATE] == terminal[DATE]:
        state = '末段刷新低点，等待反弹确认'
    elif len(after_low) >= 2 and all(bar[CLOSE] > c4[HIGH] for bar in after_low[-2:]):
        state = '收盘站回末段前高，支持末段完成'
    elif after_reclaim:
        state = '曾收复末段前高，仍需观察能否站稳'
    else:
        state = '末段低点待确认'
    start_watch = '2026-11-20'
    baseline = min((bar for bar in c_bars if bar[DATE] <= start_watch), key=lambda bar: bar[LOW])
    alternative = retests([bar for bar in c_bars if bar[DATE] > baseline[DATE]], baseline, b[HIGH], a[LOW])
    wave3 = b[HIGH] - alternative['low']['price']
    wave5 = (alternative['rebound']['price'] - alternative['five']['price']) if alternative['five'] else None
    if wave5 is not None and wave3 < min(size_a, wave5) and '失效' not in alternative['stage']:
        alternative['stage'] = '普通五浪候选失效：第3浪短于第1浪和第5浪'
    alternative['wave3Ratio'] = round(wave3 / size_a, 4)
    alternative['extension'] = round(b[HIGH] - 1.618 * size_a, 2)
    anchors = [point(start, HIGH, '起点'), point(a, LOW, 'A / 1'), point(b, HIGH, 'B / 2')]
    if item.get('c3'):
        anchors.append(point(by_day[item['c3']], LOW, 'C3 候选'))
    anchors.extend([point(c4, HIGH, '末段前高'), point(terminal, LOW, '末段低点')])
    month_watch = None
    if item['symbol'] == 'sz399006':
        prior_low = min(bar[LOW] for bar in c_bars if bar[DATE] < '2026-12-01')
        breach = next((bar for bar in c_bars if '2026-12-01' <= bar[DATE] <= '2026-12-31' and bar[LOW] < prior_low), None)
        month_watch = {'priorLow': round(prior_low, 2), 'breach': point(breach, LOW, '12月新低') if breach else None}
    return {
        **item, 'monthWatch': month_watch, 'source': source, 'checks': checks, 'bars': [bar for bar in bars if bar[DATE] >= HISTORY_START], 'anchors': anchors,
        'change': round(latest[CLOSE] / bars[-2][CLOSE] - 1, 6),
        'abc': {
            'stage': state, 'aLength': round(size_a, 2),
            'bRetraction': round((b[HIGH] - a[LOW]) / size_a, 4),
            'cRatio': round((b[HIGH] - c_extreme[LOW]) / size_a, 4),
            'cExtreme': point(c_extreme, LOW, 'C 段最低'),
            'equal': round(b[HIGH] - size_a, 2),
            'retracement': round(terminal[LOW] + 0.382 * (start[HIGH] - terminal[LOW]), 2),
            'retest': round(c4[HIGH], 2), 'floor': round(terminal[LOW], 2),
        },
        'five': alternative,
    }


def cycle_check(sh, star):
    # The post refers to December 2026 and a 19-week low. The exact weekly
    # anchor is absent from the post, so use the preceding 19 ISO market weeks.
    old_low = min(bar[LOW] for bar in sh if '2026-05-14' <= bar[DATE] < '2026-12-01')
    dec = [bar for bar in sh if '2026-12-01' <= bar[DATE] <= '2026-12-31']
    through = date.fromisoformat(star[-1][DATE])
    weeks = {}
    cross = None
    current_hit = False
    for bar in star:
        d = date.fromisoformat(bar[DATE])
        weeks.setdefault(d - timedelta(days=d.weekday()), []).append(bar)
    entries = list(weeks.items())
    for i in range(19, len(entries)):
        week, group = entries[i]
        threshold = min(bar[LOW] for _, bars in entries[i-19:i] for bar in bars)
        touched = [bar for bar in group if bar[LOW] < threshold]
        current_hit = bool(touched)
        complete = i < len(entries) - 1 or through.weekday() == 4
        if week + timedelta(days=4) >= date(2026, 11, 23) and complete and group[-1][CLOSE] < threshold and cross is None:
            cross = group[-1][DATE]
    return {
        'shReference': round(old_low, 2), 'shBreak': next((bar[DATE] for bar in dec if bar[LOW] < old_low), None),
        'shWindow': '等待12月' if through.month < 12 and through.year == 2026 else ('窗口已结束' if through.year > 2026 else '12月观察中'),
        'starReference': round(threshold, 2), 'starIntraw': current_hit, 'starBreak': cross,
    }


def cutoff_from(now):
    day = now.date()
    if now.time() < time(15, 35):
        day -= timedelta(days=1)
    return day.isoformat()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--date', type=date.fromisoformat, help='Review through this completed date')
    parser.add_argument('--output', type=Path, default=OUTPUT)
    args = parser.parse_args()
    cutoff = cutoff_from(datetime.now(CHINA))
    if args.date:
        cutoff = min(cutoff, args.date.isoformat())
    quotes_by_symbol = collect(cutoff)
    latest = next(iter(quotes_by_symbol.values()))[0][-1][DATE]
    if latest < '2026-11-20':
        raise RuntimeError(f'{latest} 早于首期观察基线')
    previous = json.loads(args.output.read_text(encoding='utf-8')) if args.output.is_file() else {}
    if previous.get('date', '') > latest:
        raise RuntimeError('行情日期回退，保留上一版')
    results = []
    previous_bars = {item['symbol']: item['bars'] for item in previous.get('indices', [])}
    for item in RULES['indices']:
        symbol = item['symbol']
        bars, source, checks = quotes_by_symbol[symbol]
        saved = previous_bars.get(symbol, [])
        if saved and bars[0][DATE] > saved[-1][DATE]:
            raise RuntimeError(f'{symbol} 无法与上期历史日线衔接')
        bars = [row for row in saved if row[DATE] < bars[0][DATE]] + bars
        quotes_by_symbol[symbol] = bars, source, checks
        results.append(analyze(bars, item, source, checks))
    cycle = cycle_check(quotes_by_symbol['sh000001'][0], quotes_by_symbol['sh000688'][0])
    record = {
        'date': latest, 'revision': RULES['revision'],
        'indices': {r['symbol']: {'close': round(r['bars'][-1][CLOSE], 2), 'abc': r['abc']['stage'],
                                  'five': r['five']['stage'], 'ratio': r['abc']['cRatio'], 'floor': r['abc']['floor']}
                    for r in results},
    }
    history = [r for r in previous.get('history', []) if r['date'] < latest][-89:] + [record]
    payload = {
        'schema': 1, 'model': MODEL, 'date': latest, 'revision': RULES['revision'],
        'profile': RULES['profile'], 'evidence': RULES['evidence'], 'indices': results, 'cycle': cycle, 'history': history,
    }
    payload['build'] = f"{latest}-{hashlib.sha256(encode(payload)).hexdigest()[:12]}"
    content = encode(payload)
    if args.output.is_file() and args.output.read_bytes() == content:
        print(f"{payload['build']} 已是最新一版")
        return
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=args.output.parent, delete=False) as output:
        output.write(content)
        temporary = Path(output.name)
    temporary.replace(args.output)
    print(payload['build'])


if __name__ == '__main__':
    main()
