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
    if b'name="wave-tracker-version" content="4"' not in page or '/tools/wave-tracker/app.js?v=4'.encode() not in page:
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


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--wait', type=int, default=0)
    deadline = time.monotonic() + parser.parse_args().wait
    while True:
        try:
            verify()
            break
        except Exception as error:
            if time.monotonic() >= deadline:
                raise
            print(str(error), flush=True)
            time.sleep(12)
