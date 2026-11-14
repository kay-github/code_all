"""国家队ETF持续追踪 · 本机计划任务（时区 Asia/Shanghai）。

只负责 Windows 计划任务的安装 / 卸载 / 查询 / 清单打印，不改数据链、不发布、
不发送通知。任务只调用 `_scheduled_run.cmd`，业务纪律仍由各脚本自己保证。

设计约束：
  - 任务名、cmd 内容一律 ASCII，避开 PowerShell 5.1 / ANSI(936) 中文脚本编码坑。
  - 安装前强制核对本机为 UTC+08:00 且未启用夏令时，否则拒绝安装。
  - 盘中 60 秒粒度靠常驻 --loop；每 10 分钟看门狗负责断线/崩溃恢复。
  - 16:30 / 19:00 / 21:30 / 次日 10:00 都是 DAILY，不按周一至周五过滤（含周六）。
"""
from __future__ import annotations
import argparse
import os
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

from v2_common import ROOT, DATA, now, read_json, write_json

TZ8 = timezone(timedelta(hours=8))
IDIR = DATA.parent / 'intraday'
RUNNER = ROOT / '_scheduled_run.cmd'
LOG = IDIR / 'scheduler.log'
INSTALL_RECORD = IDIR / 'scheduler_install.json'

# (任务名, 运行模式, schtasks 调度参数, 说明)
TASKS = [
    dict(name='GJD_Intraday_Loop', mode='intraday',
         sc=['/SC', 'ONLOGON'],
         desc='登录时启动盘中轻量采集常驻进程：连续竞价 60 秒，其余时段 300 秒'),
    dict(name='GJD_Intraday_Watchdog', mode='watchdog',
         sc=['/SC', 'MINUTE', '/MO', '10'],
         desc='每 10 分钟看门狗：last_tick 超时且无有效锁时清锁并补跑一轮'),
    dict(name='GJD_PostClose_1630', mode='postclose',
         sc=['/SC', 'DAILY', '/ST', '16:30'],
         desc='盘后初值第 1 次有界重试（只刷交易所正式份额，不发布）'),
    dict(name='GJD_PostClose_1900', mode='postclose',
         sc=['/SC', 'DAILY', '/ST', '19:00'],
         desc='盘后初值第 2 次有界重试'),
    dict(name='GJD_PostClose_2130', mode='postclose',
         sc=['/SC', 'DAILY', '/ST', '21:30'],
         desc='盘后初值第 3 次有界重试'),
    dict(name='GJD_Morning_1000', mode='morning',
         sc=['/SC', 'DAILY', '/ST', '10:00'],
         desc='次晨复核：检查最近待复核交易日并发布；DAILY 含周六，不按工作日过滤'),
    dict(name='GJD_Weekly_Report', mode='weekly',
         sc=['/SC', 'WEEKLY', '/D', 'MON', '/ST', '09:00'],
         desc='每周一整理延迟、重复提醒、故障和未解释事件；只出研究建议，不改阈值'),
]

MODES = {
    'intraday': 'intraday.py --loop',
    'watchdog': 'intraday.py --watchdog',
    'postclose': 'postclose.py --retries 3 --wait 20',
    'morning': 'morning_review.py',
    'weekly': 'weekly_report.py',
}


def log(msg):
    IDIR.mkdir(parents=True, exist_ok=True)
    line = '%s %s\n' % (now(), msg)
    with LOG.open('a', encoding='utf-8') as f:
        f.write(line)
    print(line.rstrip(), flush=True)


def tz_check():
    """所有日期与调度按 Asia/Shanghai；本机时区不符或启用夏令时时拒绝安装。"""
    offset = -time.timezone / 3600.0
    daylight_on = bool(time.daylight and time.localtime().tm_isdst > 0)
    ok = abs(offset - 8.0) < 0.01 and not daylight_on
    return ok, dict(offset_hours=offset, daylight_saving_active=daylight_on,
                    tzname=time.tzname[0],
                    local_time=datetime.now().astimezone().isoformat())


def prerequisites():
    problems = []
    ok, tz = tz_check()
    if not ok:
        problems.append('本机时区不是 UTC+08:00 或启用了夏令时：%r' % tz)
    for name in ('intraday.py', 'postclose.py', 'morning_review.py',
                 'weekly_report.py', 'config/intraday_rules.json'):
        if not (ROOT / name).exists():
            problems.append('缺少文件 ' + name)
    return problems, tz


def build_runner():
    """生成纯 ASCII 启动器；schtasks 的 /TR 只需一个无空格的路径 + 一个模式参数。"""
    py = Path(sys.executable)
    lines = [
        '@echo off',
        'setlocal',
        'cd /d "%s"' % ROOT,
        'set "PY=%s"' % py,
        'set "TASKLOG=%s"' % (IDIR / 'windows_task.log'),
        'if not exist "%s" mkdir "%s"' % (IDIR, IDIR),
        'echo [%DATE% %TIME%] start mode=%1 >> "%TASKLOG%"',
    ]
    jumps = []
    for mode, cmd in MODES.items():
        lines.append('if "%%~1"=="%s" goto %s' % (mode, mode))
        jumps.append(mode)
    lines.append('echo unknown mode %1 >> "%TASKLOG%"')
    lines.append('goto end')
    for mode, cmd in MODES.items():
        lines.append(':%s' % mode)
        lines.append('"%%PY%%" -X utf8 %s >> "%%TASKLOG%%" 2>&1' % cmd)
        lines.append('goto end')
    lines.append(':end')
    lines.append('endlocal')
    RUNNER.write_text('\n'.join(lines) + '\n', encoding='ascii')
    return RUNNER


def schtasks(args):
    p = subprocess.run(['schtasks.exe'] + args, capture_output=True)
    text = (p.stdout + b'\n' + p.stderr).decode('gbk', 'replace').strip()
    return p.returncode, text


def task_command(t, dry=False):
    tr = '"%s" %s' % (RUNNER, t['mode'])
    args = ['/Create', '/TN', t['name'], '/TR', tr, '/F', '/RL', 'LIMITED'] + t['sc']
    if dry:
        return 'schtasks.exe ' + ' '.join(args)
    return schtasks(args)


def install(dry=False):
    problems, tz = prerequisites()
    if problems:
        raise SystemExit('前置检查失败：' + '; '.join(problems))
    if not dry:
        runner = build_runner()
        log('启动器已生成 %s' % runner)
    out = []
    for t in TASKS:
        out.append('%s | %s | %s' % (t['name'], ' '.join(t['sc']), t['desc']))
        if dry:
            print(task_command(t, dry=True))
        else:
            rc, text = task_command(t)
            log('安装 %s rc=%d %s' % (t['name'], rc, text[:200].replace('\n', ' ')))
            if rc != 0:
                raise SystemExit('安装 %s 失败：%s' % (t['name'], text))
    if not dry:
        write_json(INSTALL_RECORD, dict(
            installed_at=now(), timezone=tz, runner=str(RUNNER),
            python=sys.executable, tasks=[dict(name=t['name'], schedule=t['sc'],
                                              mode=t['mode'], desc=t['desc']) for t in TASKS],
            note='任务按本机时区运行；已核实为 UTC+08:00，与 Asia/Shanghai 一致'))
        log('计划任务安装完成，共 %d 个；记录 %s' % (len(TASKS), INSTALL_RECORD))
    return out


def uninstall(dry=False):
    for t in TASKS:
        args = ['/Delete', '/TN', t['name'], '/F']
        if dry:
            print('schtasks.exe ' + ' '.join(args))
        else:
            rc, text = schtasks(args)
            log('删除 %s rc=%d %s' % (t['name'], rc, text[:160].replace('\n', ' ')))
    if not dry and INSTALL_RECORD.exists():
        write_json(INSTALL_RECORD, dict(read_json(INSTALL_RECORD) or {},
                                       uninstalled_at=now(), active=False))
    return


def status():
    rc, text = schtasks(['/Query', '/FO', 'CSV'])
    found = [line for line in text.splitlines() if 'GJD_' in line]
    print('本机时区：%s（UTC+08:00 无夏令时要求）' % tz_check()[1])
    print('已安装的 GJD 任务：%d' % len(found))
    for line in found:
        print('  ' + line.strip())
    rec = read_json(INSTALL_RECORD)
    if rec:
        print('安装记录：%s，任务数 %d，uninstalled_at=%s'
              % (rec.get('installed_at'), len(rec.get('tasks', [])), rec.get('uninstalled_at')))
    return dict(returncode=rc, found=found, record=rec)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument('--install', action='store_true', help='生成启动器并创建/覆盖计划任务')
    g.add_argument('--uninstall', action='store_true', help='删除全部 GJD 计划任务')
    g.add_argument('--status', action='store_true', help='查询已安装任务与安装记录')
    g.add_argument('--list', action='store_true', help='只打印任务清单，不操作本机')
    g.add_argument('--check', action='store_true', help='只做前置检查，不安装')
    p.add_argument('--dry-run', action='store_true', help='只打印将执行的 schtasks 命令')
    a = p.parse_args()

    if a.list:
        ok, tz = tz_check()
        print('时区 UTC%+.1f / %s / 夏令时=%s' % (tz['offset_hours'], tz['tzname'],
                                                tz['daylight_saving_active']))
        for t in TASKS:
            print('%-26s %-34s %s' % (t['name'], ' '.join(t['sc']), t['desc']))
        return
    if a.check:
        problems, tz = prerequisites()
        print('前置检查：%s' % ('通过' if not problems else '失败'))
        print('  ' + repr(tz))
        for x in problems:
            print('  - ' + x)
        raise SystemExit(1 if problems else 0)
    if a.status:
        status()
        return
    if a.install:
        install(a.dry_run)
        return
    if a.uninstall:
        uninstall(a.dry_run)
        return


if __name__ == '__main__':
    main()
