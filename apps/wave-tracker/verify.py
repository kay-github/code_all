"""Check the production page, build metadata, and snapshot content independently."""
import argparse
import hashlib
import json
from pathlib import Path
import time
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[2]
WEB = ROOT / 'tools' / 'wave-tracker'
BASE = 'https://1.688680.xyz'


def fetch(path):
    url = f'{BASE}{path}?verify={time.time_ns()}'
    request = Request(url, headers={'Cache-Control': 'no-cache', 'User-Agent': 'Wave tracker release verifier'})
    with urlopen(request, timeout=12) as response:
        if response.status != 200:
            raise RuntimeError(f'{path} HTTP {response.status}')
        return response.read()


def digest(raw):
    return hashlib.sha256(raw.replace(b'\r\n', b'\n')).hexdigest()


def verify():
    name = '/tools/wave-tracker/data/latest.json'
    payload = (ROOT / name.lstrip('/')).read_bytes()
    expected = json.loads(payload)
    page = fetch('/waves')
    if b'name="wave-tracker-version" content="5"' not in page or '/tools/wave-tracker/app.js?v=4'.encode() not in page:
        raise RuntimeError('功能页构建版本尚未上线')
    online = fetch(name)
    actual = json.loads(online)
    if (actual['date'], actual['build'], digest(online)) != (expected['date'], expected['build'], digest(payload)):
        raise RuntimeError(f"线上数据构建 {actual['build']}，预期 {expected['build']}")
    for asset in ['app.js', 'style.css', 'lab.mjs', 'scenarios.mjs']:
        if digest(fetch(f'/tools/wave-tracker/{asset}')) != digest((WEB / asset).read_bytes()):
            raise RuntimeError(f'{asset} 哈希不一致')
    if b"id: 'waveTracker'" not in fetch('/assets/site-defaults.js') or b"waveTracker: '/waves'" not in fetch('/assets/site-home.js'):
        raise RuntimeError('首页入口尚未上线')
    print(f"HTTP 200 · {actual['date']} · {actual['build']} · SHA256 {digest(online)}", flush=True)


def verify_stocks():
    name = '/tools/wave-tracker/data/stocks.json'
    expected = (ROOT / name.lstrip('/')).read_bytes()
    page = fetch('/waves')
    if b'id="stock-study-content"' not in page or b'/tools/wave-tracker/stocks.mjs?v=1' not in page:
        raise RuntimeError('个股跟踪组件尚未上线')
    actual = fetch(name)
    snapshot = json.loads(actual)
    if digest(expected) != digest(actual):
        raise RuntimeError(f"线上个股构建 {snapshot['build']} 尚未与本地一致")
    for asset in ['stocks.mjs', 'stock-view.mjs']:
        if digest(fetch(f'/tools/wave-tracker/{asset}')) != digest((WEB / asset).read_bytes()):
            raise RuntimeError(f'{asset} 哈希不一致')
    cases = json.loads(Path(__file__).with_name('stock-cases.json').read_text(encoding='utf-8'))
    symbols = {item['symbol'] for item in cases['items'] if item['track']}
    if {item['symbol'] for item in snapshot['results']} != symbols:
        raise RuntimeError('线上个股名单不一致')
    print(f"HTTP 200 · {snapshot['date']} · {snapshot['build']} · SHA256 {digest(actual)}", flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--wait', type=int, default=0)
    parser.add_argument('--stocks', action='store_true')
    args = parser.parse_args()
    deadline = time.monotonic() + args.wait
    while True:
        try:
            (verify_stocks if args.stocks else verify)()
            break
        except Exception as error:
            if time.monotonic() >= deadline:
                raise
            print(str(error), flush=True)
            time.sleep(12)
