"""Read-only public requests, immutable payload archive, and explicit failures."""
from __future__ import annotations
import concurrent.futures
import json
import time
import urllib.request
from datetime import date, timedelta
from pathlib import Path
from v2_common import DATA, now, digest, read_json, write_json, classify, symbol

HEADERS = {'User-Agent': 'Mozilla/5.0', 'Referer': 'https://gu.qq.com/'}

def get(url, timeout=15, referer=None):
    headers = dict(HEADERS)
    if referer:
        headers['Referer'] = referer
    for attempt in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=timeout) as r:
                return r.read()
        except Exception:
            if attempt == 2:
                raise
            time.sleep(.3 * (attempt + 1))

def kline(sym, start, end, count=900):
    # Never use a live snapshot to manufacture a dated historical record.
    url = ('https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get?'
           f'param={sym},day,{start},{end},{count},bfq')
    try:
        payload = json.loads(get(url).decode('utf-8'))
        node = payload.get('data', {}).get(sym, {})
        rows = node.get('day')
        if not rows:
            raise ValueError('bfq day missing or empty; no qfq/snapshot substitution')
        dates = [r[0] for r in rows]
        return dict(url=url, fetched_at=now(), adjustment='bfq', payload=payload,
                    row_count=len(rows), first=min(dates), last=max(dates),
                    source='tencent_newfqkline', business_end=end)
    except Exception as exc:
        return dict(url=url, fetched_at=now(), adjustment='bfq', error=str(exc), business_end=end)

def rows_of(record, sym):
    return record.get('payload', {}).get('data', {}).get(sym, {}).get('day', [])

def catalogue():
    items, pages, errors = {}, [], []
    complete = False
    for page in range(1, 41):
        url = ('https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/'
               f'Market_Center.getHQNodeData?page={page}&num=100&sort=amount&asc=0&node=etf_hq_fund&symbol=')
        try:
            payload = json.loads(get(url, referer='https://finance.sina.com.cn').decode('utf-8'))
            pages.append(dict(url=url, payload=payload, fetched_at=now()))
            if not payload:
                complete = True
                break
            fresh = 0
            for item in payload:
                code = str(item['code'])
                fresh += code not in items
                items[code] = dict(code=code, name=item['name'], amount=float(item.get('amount') or 0),
                                   **classify(code, item['name']))
            if not fresh:
                errors.append('pagination repeated an entire page')
                break
            if len(payload) < 100:
                complete = True
                break
        except Exception as exc:
            errors.append(f'page {page}: {exc}')
            break
    return dict(items=list(items.values()), pages=pages, errors=errors,
                complete=complete, fetched_at=now(), note='当前目录快照；不作为历史时点目录')

def fetch_batch(symbols, start, end, count, folder, workers=6):
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    symbols = sorted(set(symbols))
    def fetch(sym):
        path = folder / (sym + '.json')
        cached = read_json(path)
        # Resumable only within this immutable collection run, never silently reuse old runs.
        if cached and not cached.get('error'):
            return sym, cached
        item = kline(sym, start, end, count)
        write_json(path, item)
        return sym, item
    out = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        for sym, item in pool.map(fetch, symbols):
            out[sym] = item
            if len(out) % 50 == 0 or len(out) == len(symbols):
                print(f'  {folder.name}: {len(out)}/{len(symbols)}，失败 {sum(bool(x.get("error")) for x in out.values())}', flush=True)
    return out

def crosscheck(codes, end, folder):
    """No automatic promotion: f84 is a vendor quote, with possibly different scope/date."""
    results = []
    for code in codes:
        secid = ('1.' if code[0] in '56789' else '0.') + code
        url = f'https://push2.eastmoney.com/api/qt/stock/get?secid={secid}&fields=f43,f84,f85,f86,f58'
        try:
            payload = json.loads(get(url, timeout=5, referer='https://quote.eastmoney.com/').decode('utf-8'))
            q = payload.get('data') or {}
            if not isinstance(q.get('f84'), (float, int)) or not q.get('f86'):
                raise ValueError('share or source timestamp missing')
            from datetime import datetime, timezone, timedelta
            source_date = datetime.fromtimestamp(q['f86'], timezone(timedelta(hours=8))).date().isoformat()
            results.append(dict(code=code, date=source_date, shares=q['f84'], url=url,
                                status='dated_quote' if source_date == end else 'date_mismatch',
                                payload=payload, fetched_at=now(), scope='vendor_total_unverified'))
        except Exception as exc:
            results.append(dict(code=code, url=url, status='unavailable', error=str(exc), fetched_at=now()))
    write_json(Path(folder) / 'crosscheck.json', results)
    return results
