"""次晨 10:00 复核入口（Asia/Shanghai，DAILY 含周六）。

职责：
  1. 判断是否存在「待复核交易日」，没有就静默跳过，不重复发布、不重复采集。
  2. 有待复核时调用现有 `update.py --phase final --deploy`，绝不绕过发布闸门。
  3. 发布后核对线上页面、最新 JSON、发布回执、CSV 与本机构建号一致。

纪律：本脚本不自己算份额、不自己改线上文件、不因校验失败伪造成功，也不回滚已推送的提交。
"""
from __future__ import annotations
import argparse
import json
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

from v2_common import ROOT, DATA, now, read_json, write_json

TZ8 = timezone(timedelta(hours=8))
IDIR = DATA.parent / 'intraday'
OUT = IDIR / 'morning_review.json'
LOG = IDIR / 'morning_review.log'
SITE = 'https://1.688680.xyz'
STATIC = SITE + '/tools/national-team-etf/data/'


def log(msg):
    IDIR.mkdir(parents=True, exist_ok=True)
    line = '%s %s\n' % (now(), msg)
    with LOG.open('a', encoding='utf-8') as f:
        f.write(line)
    print(line.rstrip(), flush=True)


def pending_business_day():
    """返回 (待复核业务日 或 None, 原因)。

    判定只用不可变字段：
      - 盘后初值业务日 > 正式构建 end            -> 新交易日需要复核
      - 盘后初值业务日 == end 且构建日 <= 业务日 -> 仍是当日初值，次晨还没跑
      - 构建日晚于业务日                          -> 次晨已完成，跳过
    """
    latest = read_json(DATA / 'latest.json') or {}
    pc = read_json(IDIR / 'postclose.json') or {}
    end = latest.get('end')
    build_id = str(latest.get('build_id') or '')
    pd = pc.get('business_date')
    if not pd:
        return None, '无盘后初值记录，暂无待复核交易日'
    if not end:
        return pd, '无正式构建，需完整复核'
    if pd > end:
        return pd, '盘后初值 %s 晚于正式构建 %s' % (pd, end)
    build_day = build_id[:8]
    pd_key = pd.replace('-', '')
    if build_day and build_day <= pd_key:
        return pd, '构建 %s 仍是业务日 %s 当日或更早，次晨复核未完成' % (build_id, pd)
    return None, '业务日 %s 已由次晨构建 %s 复核，无待复核' % (pd, build_id)


def http_text(url, timeout=15, tries=2):
    last = None
    for i in range(tries):
        try:
            sep = '&' if '?' in url else '?'
            req = urllib.request.Request(
                url + sep + '_=' + str(int(time.time() * 1000)),
                headers={'User-Agent': 'Mozilla/5.0 (gjd-morning-review)',
                         'Cache-Control': 'no-cache', 'Pragma': 'no-cache'})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.status, r.read().decode('utf-8', 'replace'), None
        except Exception as exc:
            last = exc
            if i < tries - 1:
                time.sleep(1.5)
    return None, '', repr(last)


def verify_online(build_id):
    checks = {}
    targets = dict(page=SITE + '/gjd/', latest_json=STATIC + 'latest.json',
                   release_json=STATIC + 'release.json', csv=STATIC + 'official_flow.csv')
    for key, url in targets.items():
        status, text, err = http_text(url)
        item = dict(url=url, http_status=status, ok=False, detail=err or '')
        if key == 'csv':
            lines = [x for x in text.splitlines() if x.strip()]
            item['rows'] = len(lines)
            item['ok'] = status == 200 and len(lines) > 1
            item['detail'] = (lines[0][:120] if lines else '空响应')
        elif key == 'page':
            item['ok'] = status == 200 and build_id in text
            item['detail'] = '页面含本机构建号' if item['ok'] else '页面构建号不一致或未取到'
        else:
            try:
                got = json.loads(text)
                item['remote_build_id'] = got.get('build_id')
                item['ok'] = status == 200 and got.get('build_id') == build_id
                item['detail'] = '构建号一致' if item['ok'] else '构建号不一致'
            except (ValueError, AttributeError):
                item['detail'] = 'JSON 解析失败'
        checks[key] = item
    return dict(checked_at=now(), build_id=build_id,
                all_ok=all(x['ok'] for x in checks.values()), checks=checks,
                note='校验失败只记录告警，不回滚已推送提交；需人工复核后重跑发布')


def run_final():
    cmd = [sys.executable, '-X', 'utf8', 'update.py', '--phase', 'final', '--deploy']
    log('执行次晨完整复核：%s' % ' '.join(cmd))
    p = subprocess.run(cmd, cwd=str(ROOT), capture_output=True, timeout=2400)
    out = (p.stdout + b'\n' + p.stderr).decode('utf-8', 'replace')
    for line in out.splitlines()[-25:]:
        log('  ' + line)
    return p.returncode, out


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--dry-run', action='store_true', help='只判断是否有待复核，不采集、不发布')
    p.add_argument('--verify-only', action='store_true', help='只核对线上四项，不运行发布')
    p.add_argument('--force', action='store_true', help='明知无待复核仍强制执行（仅用于演练，谨慎）')
    a = p.parse_args()

    IDIR.mkdir(parents=True, exist_ok=True)
    latest_before = read_json(DATA / 'latest.json') or {}
    pd, reason = pending_business_day()
    result = dict(checked_at=now(), timezone='Asia/Shanghai',
                  weekday=datetime.now(TZ8).strftime('%A'),
                  pending_business_day=pd, reason=reason,
                  build_before=latest_before.get('build_id'))

    if a.verify_only:
        bid = str(latest_before.get('build_id') or '')
        result['verification'] = verify_online(bid)
        write_json(OUT, result)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return

    log('待复核判断：%s（%s）' % (pd or '无', reason))
    if a.dry_run:
        result['action'] = 'dry-run，未采集未发布'
        write_json(OUT, result)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return

    if not pd and not a.force:
        result['action'] = 'skip：无待复核交易日，不重复采集、不重复发布'
        log(result['action'])
        result['verification'] = verify_online(str(latest_before.get('build_id') or ''))
        write_json(OUT, result)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return

    try:
        rc, out = run_final()
    except subprocess.TimeoutExpired:
        rc, out = -1, '次晨完整流程超时（2400 秒）'
    result['final_returncode'] = rc
    result['final_tail'] = out[-1500:]
    latest_after = read_json(DATA / 'latest.json') or {}
    result['build_after'] = latest_after.get('build_id')
    result['verification'] = verify_online(str(latest_after.get('build_id') or ''))
    result['action'] = ('published_and_verified' if rc == 0 and result['verification']['all_ok']
                        else '需人工复核：发布或线上校验未全部通过')
    log('次晨复核结束：rc=%d，%s' % (rc, result['action']))
    write_json(OUT, result)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    raise SystemExit(0 if rc == 0 else 1)


if __name__ == '__main__':
    main()
