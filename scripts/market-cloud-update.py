"""Run and verify the existing market pipelines in a clean GitHub Actions checkout."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
ETF = 'national-team-etf'
FUND = 'fund-dragon-recovery'
SITE = 'https://1.688680.xyz'
META = {ETF: 'gjd-build-id', FUND: 'fund-track-build'}
CHINA = timezone(timedelta(hours=8))
PAGES = {
    ETF: {'/gjd/': 'index.html', '/gjd/cycle': 'cycle.html',
          '/tools/national-team-etf/segments.html': 'segments.html'},
    FUND: {'/jjhc': 'index.html', '/fund-dragon-recovery': 'index.html'},
}
MARKET_DATA = {
    ETF: ('latest.json', 'official_flow.csv', 'inventory.csv', 'intraday/baseline15.json',
          'intraday/latest.json', 'intraday/postclose.json'),
    FUND: ('latest.json', 'observations.csv'),
}


def read(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def summary(message):
    print(message, flush=True)
    if path := os.getenv('GITHUB_STEP_SUMMARY'):
        with open(path, 'a', encoding='utf-8') as log:
            log.write(message + '\n\n')


def app(name):
    return REPO / 'apps' / name


def web(name):
    return REPO / 'tools' / name


def run(name, *args):
    subprocess.run([sys.executable, '-X', 'utf8', *args], cwd=app(name), check=True)


def git(*args):
    return subprocess.check_output(['git', *args], cwd=REPO, text=True, encoding='utf-8').strip()


def release(name):
    return read(web(name) / 'data/release.json')


def day_from_indices(cutoff):
    from v2_sources import kline, rows_of

    start = (cutoff - timedelta(days=21)).isoformat()
    end = cutoff.isoformat()
    codes = ('sh000300', 'sz399006')
    with ThreadPoolExecutor(max_workers=2) as pool:
        records = list(pool.map(lambda code: kline(code, start, end, 20), codes))
    dates = [
        max((r[0] for r in rows_of(record, code) if r[0] <= end), default=None)
        for code, record in zip(codes, records)
    ]
    if dates[0] is None or dates[0] != dates[1]:
        raise RuntimeError(f'沪深基准交易日无法共同确认: {dates}')
    return dates[0]


def publish(paths, name, message):
    files = sorted({Path(path).relative_to(REPO).as_posix() for path in paths})
    if git('diff', '--cached', '--name-only'):
        raise RuntimeError('云端暂存区预期为空')
    git('add', '--', *files)
    if not git('diff', '--cached', '--name-only'):
        return
    git('config', '--local', 'user.name', 'github-actions[bot]')
    git('config', '--local', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com')
    git('commit', '-m', message)
    if git('diff', '--name-only'):
        raise RuntimeError('发布白名单之外出现未预期的工作区改动')

    for _ in range(3):
        git('fetch', 'origin', 'main')
        parent = git('rev-parse', 'HEAD^')
        # Disjoint site updates can land while the collector runs. Never rebuild
        # the commit on top of newer inputs or outputs of the same pipeline.
        protected = [f'apps/{name}', f'tools/{name}', *files]
        if git('diff', '--name-only', parent, 'origin/main', '--', *protected):
            raise RuntimeError(f'{name} 有更新的源码或产物，请从 main 重新运行')
        git('rebase', 'origin/main')
        if subprocess.run(['git', 'push', 'origin', 'HEAD:main'], cwd=REPO).returncode == 0:
            summary(f'已提交 {git("rev-parse", "--short", "HEAD")}')
            return
        time.sleep(3)
    raise RuntimeError('推送 main 失败')


def sha(body):
    return hashlib.sha256(body.replace(b'\r\n', b'\n')).hexdigest()


def fetch(path):
    req = urllib.request.Request(
        SITE + path + '?verify=' + str(time.time_ns()),
        headers={'User-Agent': 'Market release verifier', 'Cache-Control': 'no-cache'},
    )
    with urllib.request.urlopen(req, timeout=20) as response:
        if response.status != 200:
            raise RuntimeError(f'{path}: HTTP {response.status}')
        return response.read()


def verify(name, *, provisional=False, attempts=30):
    receipt_path = f'/tools/{name}/data/release.json'
    expected = release(name)
    postclose = f'/tools/{name}/data/postclose/latest.json'
    marker_path = postclose if provisional else receipt_path
    marker = read(REPO / marker_path.lstrip('/'))
    build_id = marker['build_id']

    def check(path, digest):
        if sha(fetch(path)) != digest:
            raise ValueError(f'{path} 的公开文件哈希与已提交版本不一致')

    for attempt in range(attempts):
        try:
            if json.loads(fetch(marker_path)) != marker:
                raise ValueError(f'{marker_path} 尚未更新到 {build_id}')
            if provisional:
                check(postclose, sha((REPO / postclose.lstrip('/')).read_bytes()))
            else:
                targets = [(url, expected['files'][f'tools/{name}/{filename}'])
                           for url, filename in PAGES[name].items()]
                targets.extend((f'/tools/{name}/data/{filename}',
                                expected['files'][f'tools/{name}/data/{filename}'])
                               for filename in MARKET_DATA[name])
                with ThreadPoolExecutor(max_workers=4) as pool:
                    list(pool.map(lambda item: check(*item), targets))
                meta = f'<meta name="{META[name]}" content="{build_id}">'.encode()
                if meta not in fetch(next(iter(PAGES[name]))):
                    raise ValueError('线上页面构建号不一致')
            summary(f'生产核验通过 · {name} · {marker["business_date"]} · {build_id}')
            return
        except (OSError, ValueError, RuntimeError) as exc:
            if attempt == attempts - 1:
                raise
            if attempt % 5 == 0:
                print(f'等待生产版本 {build_id}: {exc}', flush=True)
            time.sleep(10)


def seed_etf():
    from v2_common import DATA, digest, read_json, write_json

    state = app(ETF) / 'cloud-state'
    history = read(state / 'exchange-history.json')
    checkpoint = DATA / 'official-history-checkpoint'
    snapshot = history['exchange_history']
    if digest(snapshot) != history['exchange_history_hash']:
        raise ValueError('交易所历史检查点哈希不一致')
    write_json(checkpoint / 'exchange_history.json', snapshot)
    manifest = checkpoint / 'manifest.json'
    write_json(manifest, {
        'end': snapshot['end'], 'source_manifest_hash': history['source_manifest_hash'],
        'exchange_history': {'file': 'exchange_history.json', 'hash': digest(snapshot)},
    })
    write_json(DATA / 'raw_latest.json', {'manifest': str(manifest)})
    for filename in ('latest.json', 'baseline15.json', 'postclose.json'):
        current = read(web(ETF) / 'data/intraday' / filename)
        saved = read_json(state / ('intraday-' + filename)) or {}
        chosen = max((current, saved), key=lambda x: x.get('generated_at') or '')
        write_json(DATA.parent / 'intraday' / filename, chosen)
    postclose = read(web(ETF) / 'data/postclose/latest.json')
    write_json(DATA.parent / 'postclose/latest.json', postclose)
    return state


def save_etf_history(state):
    from v2_common import DATA, digest, write_json

    manifest = Path(read(DATA / 'raw_latest.json')['manifest'])
    source = read(manifest)
    ref = source['exchange_history']
    archive = read(manifest.parent / ref['file'])
    if digest(archive) != ref['hash']:
        raise ValueError('交易所原始留档哈希不一致')
    output = state / 'exchange-history.json'
    write_json(output, {
        'source_manifest_hash': digest(source), 'exchange_history_hash': ref['hash'],
        'exchange_history': archive,
    })
    return output


def etf_work(task, end, state, rebuild):
    from v2_common import write_json
    from pipeline import latest
    from update import POSTCLOSE, publish_provisional, supersede_previous

    public_postclose = web(ETF) / 'data/postclose/latest.json'
    official = release(ETF)
    if task == 'etf-close':
        prior = read(public_postclose)
        prior_close = prior.get('business_date') or ''
        official_day = official['business_date']
        if end <= official_day:
            summary(f'正式区已覆盖 {end}（正式业务日 {official_day}），不重复盘后发布')
            return
        if end < prior_close:
            summary(f'已有更晚盘后快照 {prior_close}，覆盖 {end}')
            return
        if end == prior_close:
            complete_evening = (
                prior.get('stage') == 'postclose_evening'
                and bool((prior.get('official') or {}).get('complete'))
            )
            if complete_evening:
                summary(f'晚间值已完整覆盖 {end}，核对生产文件')
                verify(ETF, provisional=True)
                return
            summary(f'已有同日 {prior.get("stage") or "初值"}，重跑升级为晚间值')
        run(ETF, 'collect_data.py', '--end', end)
        run(ETF, 'pipeline.py')
        analysis, path = latest()
        if analysis['end'] != end:
            raise RuntimeError('采集构建的业务日与盘后业务日不一致')
        result = publish_provisional(analysis, path, False)
        write_json(public_postclose, result)
        files = [public_postclose, save_etf_history(state)]
        try:
            from v2_intraday_baseline import build
            baseline = build()
            if baseline.get('complete') and baseline['as_of_date'] == end:
                public_baseline = {k: v for k, v in baseline.items()
                                   if k not in {'raw_dir', 'errors', 'crosschecks'}}
                output = state / 'intraday-baseline15.json'
                write_json(output, public_baseline)
                files.append(output)
        except Exception as exc:
            summary(f'15 分钟基线刷新失败，沿用已核验基线 · {exc}')
        publish(files, ETF, f'Update provisional ETF data for {end}')
        verify(ETF, provisional=True)
        return

    if end < official['business_date'] or (end == official['business_date'] and not rebuild):
        summary(f'ETF 正式区已覆盖 {end}')
        return
    run(ETF, 'update.py', '--phase', 'final', '--end', end)
    analysis, _ = latest()
    if analysis['end'] != end:
        raise RuntimeError('ETF 正式构建业务日偏离已确认交易日')
    files = release_files(ETF) + [save_etf_history(state)]
    if supersede_previous(analysis):
        shutil.copyfile(POSTCLOSE, public_postclose)
        files.append(public_postclose)
    publish(files, ETF, f'Update verified ETF data for {end}')
    verify(ETF)
    if public_postclose in files:
        verify(ETF, provisional=True)


def etf_intraday(state, today):
    from intraday import LATEST_FILE, session_state
    from v2_common import write_json

    if session_state() != 'open':
        summary('实际运行时间已离开连续竞价，跳过盘中留档')
        return
    output = state / 'intraday-latest.json'
    if output.exists() and read(output)['business_date'] == today:
        summary(f'已有 {today} 的盘中留档')
        return
    # Do not hydrate the older public snapshot for this one-shot collector.
    LATEST_FILE.unlink(missing_ok=True)
    run(ETF, 'intraday.py', '--platform-tick')
    if not LATEST_FILE.exists():
        summary('实际采集已离开连续竞价，跳过盘中留档')
        return
    record = read(LATEST_FILE)
    if record['business_date'] != today:
        summary('供应商快照未进入当天交易日，跳过盘中留档')
        return
    if record['freshness'] != 'fresh' or record['out_of_session']:
        raise RuntimeError('交易时段内盘中快照未通过鲜度检查')
    write_json(output, record)
    summary(f'盘中留档 {today} · {record["level"]} · 核心覆盖 {record["coverage"]["core_received"]}/15')
    publish([output], ETF, f'Archive low-frequency ETF snapshot for {today}')


def release_files(name):
    target = web(name) / 'data/release.json'
    paths = set(read(target)['files']) | {target.relative_to(REPO).as_posix()}
    if name == FUND:
        paths.add('assets/site-defaults.js')
    return [REPO / p for p in sorted(paths)]


def probe():
    from v2_exchange import fetch as exchange
    import v2_sources

    sys.path.insert(0, str(app(FUND)))
    from v3_sources import catalogue, get_nav, holdings
    from v3_common import periods

    current = datetime.now(CHINA).date()
    end = day_from_indices(current - timedelta(days=1))
    for code in ('510300', '159919'):
        result = exchange(code, end)
        if result.get('error') or not result.get('latest_available'):
            raise RuntimeError(f'交易所 {code}: {result.get("error")}')
        summary(f'交易所 {code} 可达 · {result["latest_available"]}')
    lookup = v2_sources.catalogue()
    if not lookup['complete']:
        raise RuntimeError(f'新浪 ETF 目录未完成: {lookup["errors"]}')
    with tempfile.TemporaryDirectory() as directory:
        folder = Path(directory)
        funds, _ = catalogue(folder)
        _, _, nav = get_nav('001170', end, folder)
        if nav.get('error'):
            raise RuntimeError(f'东方财富净值: {nav["error"]}')
        report = holdings('300502', periods(end)[0], folder)
        summary(f'数据源预检通过 · ETF 目录 {len(lookup["items"])} · 基金目录 {len(funds)} · 持仓披露 {report["count"]} · 净值 {nav["last"]}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('task', choices=('etf-final', 'etf-close', 'etf-intraday', 'fund', 'probe', 'verify'))
    parser.add_argument('--rebuild', action='store_true', help='重建已发布的同日正式数据')
    args = parser.parse_args()
    sys.path.insert(0, str(app(ETF)))
    os.chdir(REPO)
    if args.task == 'probe':
        probe()
        return
    if args.task == 'verify':
        verify(ETF)
        verify(ETF, provisional=True)
        verify(FUND)
        return
    current = datetime.now(CHINA)
    today = current.date()
    if args.task == 'etf-intraday':
        etf_intraday(seed_etf(), today.isoformat())
        return
    if args.task == 'etf-close' and (current.hour, current.minute) < (15, 15):
        summary('尚未到收盘后，跳过盘后初值')
        return
    cutoff = today if args.task == 'etf-close' else today - timedelta(days=1)
    end = day_from_indices(cutoff)
    summary(f'{args.task} · 行情确认的业务日 {end} · 北京时间 {current:%F %R}')
    if args.task == 'etf-close' and end != today.isoformat():
        summary('行情未提供当天完整日线，等待下一轮')
        return
    if args.task.startswith('etf-'):
        etf_work(args.task, end, seed_etf(), args.rebuild)
        return
    prior = release(FUND)['business_date']
    if end < prior or (end == prior and not args.rebuild):
        summary(f'双龙已覆盖 {end}')
        return
    run(FUND, 'update.py', '--end', end, '--publish')
    if release(FUND)['business_date'] != end:
        raise RuntimeError('双龙正式构建业务日偏离已确认交易日')
    publish(release_files(FUND), FUND, f'Update verified fund dragon data for {end}')
    verify(FUND)


if __name__ == '__main__':
    main()
