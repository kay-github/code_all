"""Collect matched completed A-share sessions and build the fixed-anchor stock studies."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import tempfile

from update import CHINA, cutoff_from, encode, fetch_json, quotes

APP = Path(__file__).resolve().parent
ROOT = APP.parents[1]
OUTPUT = ROOT / 'tools' / 'wave-tracker' / 'data' / 'stocks.json'
CASES = json.loads((APP / 'stock-cases.json').read_text(encoding='utf-8'))
BASIS = '腾讯前复权 · 最新日线OHLC与新浪核对 · 周线从同源日线聚合'


def bars_from_tencent(symbol, until):
    for host in ('ifzq.gtimg.cn', 'web.ifzq.gtimg.cn'):
        try:
            request = f'https://{host}/appstock/app/fqkline/get?param={symbol},day,,,800,qfq'
            data = fetch_json(request, 'https://gu.qq.com/')['data'][symbol]
            original = data['qfqday']
            bars = [[r[0], float(r[1]), float(r[3]), float(r[4]), float(r[2])] for r in original if r[0] <= until]
            if not bars or any(not all(math.isfinite(x) and x > 0 for x in b[1:]) or not b[3] <= min(b[1], b[4]) <= max(b[1], b[4]) <= b[2] for b in bars):
                raise ValueError('前复权价缺失或无效')
            if any(a[0] >= b[0] for a, b in zip(bars, bars[1:])):
                raise ValueError('前复权日期不严格递增')
            return bars
        except (OSError, KeyError, TypeError, ValueError) as exc:
            error = exc
    raise RuntimeError(f'{symbol} 腾讯前复权不可用') from error


def compare_latest(bar, raw):
    if any(abs(a - b) > 0.025 for a, b in zip(bar[1:], raw[1:])):
        raise ValueError(f'{bar[0]} 前复权最新价格与独立未复权行情不一致')


def collect(item, session):
    symbol = item['symbol']
    bars = bars_from_tencent(symbol, session)
    if bars[-1][0] != session:
        raise RuntimeError(f'{symbol} 前复权最新交易日 {bars[-1][0]}，大盘交易日 {session}')
    base = 'https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData'
    payload = fetch_json(f'{base}?symbol={symbol}&scale=240&ma=no&datalen=50', 'https://finance.sina.com.cn/')
    raw = {r['day'][:10]: [r['day'][:10], float(r['open']), float(r['high']), float(r['low']), float(r['close'])] for r in payload}
    if session not in raw:
        raise RuntimeError(f'{symbol} 新浪最新交易日未到 {session}')
    compare_latest(bars[-1], raw[session])
    checked = 0
    for current in reversed(bars[-5:]):
        ref = raw.get(current[0])
        if not ref:
            break
        try:
            compare_latest(current, ref)
        except ValueError:
            # Older days can have a different price basis around a corporate action.
            # Keep the Tencent history intact; the latest session must match exactly.
            break
        checked += 1
    return {'item': item, 'bars': bars, 'compared': checked}


def completed_day(cutoff):
    with ThreadPoolExecutor(max_workers=2) as pool:
        dates = list(pool.map(lambda source: quotes('sz399006', cutoff, source)[-1][0], ('腾讯行情', '新浪财经')))
    if len(set(dates)) != 1:
        raise RuntimeError(f'基准交易日尚未对齐 {dates}')
    return dates[0]


def build_snapshot(session, archive, all_cases):
    items = [item for item in CASES['items'] if all_cases or item['track']]
    with ThreadPoolExecutor(max_workers=4) as pool:
        inputs = list(pool.map(lambda item: collect(item, session), items))
    process = subprocess.run(['node', str(APP / 'stock-study.mjs'), '--stdin'], input=encode({
        'revision': CASES['revision'], 'date': session, 'basis': BASIS, 'items': inputs,
    }), capture_output=True, check=False)
    if process.returncode:
        raise RuntimeError(process.stderr.decode('utf-8', 'replace'))
    payload = json.loads(process.stdout)
    now = {'date': session, 'results': {entry['symbol']: {
        'close': entry['day']['close'], 'day': entry['day']['main']['progress'], 'week': entry['week']['main']['progress'],
        'dayAlt': entry['day']['alt']['progress'], 'weekAlt': entry['week']['alt']['progress'],
    } for entry in payload['results']}}
    payload['history'] = [x for x in archive.get('history', []) if x['date'] < session][-59:] + [now]
    payload['build'] = session + '-' + hashlib.sha256(encode(payload)).hexdigest()[:12]
    return payload


def portable_html(payload, target):
    shared = (ROOT / 'assets' / 'workspace-theme.css').read_text(encoding='utf-8')
    style = (ROOT / 'tools' / 'wave-tracker' / 'style.css').read_text(encoding='utf-8')
    view = (ROOT / 'tools' / 'wave-tracker' / 'stock-view.mjs').read_text(encoding='utf-8')
    data = encode(payload).decode().replace('<', '\\u003c').strip()
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(f'''<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>四股日线与周线波浪实测</title><style>{shared}
{style}</style>
<main><header class="intro"><div><h1>四股日线与周线波浪实测</h1>
<p>中际旭创、新易盛、长光华芯、东田微 · 主案、备选与失效条件</p></div></header>
<section class="panel" id="stock-study-content"></section></main>
<script type="module">{view}
renderStockStudy(document.getElementById('stock-study-content'), {data});</script></html>''', encoding='utf-8')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--date', type=date.fromisoformat)
    parser.add_argument('--all', action='store_true', help='Build all four research cases instead of the online watchlist')
    parser.add_argument('--output', type=Path, default=OUTPUT)
    parser.add_argument('--html', type=Path, help='Write a standalone research view from the same result')
    args = parser.parse_args()
    if args.all and args.output.resolve() == OUTPUT.resolve():
        parser.error('四股一次性研究用独立输出路径')
    cutoff = cutoff_from(datetime.now(CHINA))
    if args.date:
        cutoff = min(cutoff, args.date.isoformat())
    session = completed_day(cutoff)
    archive = json.loads(args.output.read_text(encoding='utf-8')) if args.output.is_file() else {}
    if archive.get('date', '') > session:
        raise RuntimeError('行情日期回退，保留已发布结果')
    payload = build_snapshot(session, archive, args.all)
    if args.html:
        portable_html(payload, args.html)
    data = encode(payload)
    if args.output.is_file() and args.output.read_bytes() == data:
        print(f"{payload['build']} 已是最新一版")
        return
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=args.output.parent, delete=False) as temp:
        temp.write(data)
        name = temp.name
    os.replace(name, args.output)
    print(payload['build'], [entry['name'] for entry in payload['results']])


if __name__ == '__main__':
    main()
