"""国家队ETF持续追踪 · 调度说明（时区 Asia/Shanghai）。

本机 Windows 计划任务已于 2026-11-15 全部卸载：每分钟拉起 `_scheduled_run.cmd`
会弹出控制台窗口抢焦点，持续打断用户。调度改由 WorkBuddy 平台定时任务承担
（低频、无本机常驻进程、无 cmd 窗口）；盘中 60 秒实时观察由页面浏览器端 JSONP
提供，用户打开页面才运行，不依赖本机进程。

本文件保留 TASKS / MODES / build_runner 只供卸载、查询与历史回放排查；
--install 已禁用，避免误装把 cmd 调度带回来。业务纪律仍由各脚本自己保证。

平台侧能力降级（必须如实说明）：本地采集降为交易时段每日 1 次留档，
没有连续分钟样本，5/15/30 分钟窗口与实时行情以页面浏览器端为准，
本地事件等级上限 L1，不升级 L2/L3；提醒延迟为任务周期级，不保证秒级或即时。
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
    dict(name='GJD_Intraday_Tick', mode='tick',
         sc=['/SC', 'MINUTE', '/MO', '1'],
         desc='每分钟唤醒一次，脚本按交易时段自行节流：连续竞价 60 秒，其余 300 秒；不依赖常驻进程'),
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

# WorkBuddy 平台定时任务：唯一现行调度来源（由 automation_update 配置，本文件不创建）。
# 改这里必须同步改 automation 配置与 docs/持续追踪实施说明.md。
# RRULE 约束：BYDAY 允许多值，BYHOUR 只能是单个整数（实测多值被拒，见经验库 E21）。
PLATFORM_TASKS = [
    dict(name='国家队ETF盘中留档与提醒（14:30）',
         rrule='FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=14;BYMINUTE=30',
         entry='python -X utf8 intraday.py --platform-tick',
         desc='交易时段单轮低频留档 + 通知队列消费；等级上限 L1；休市跳过'),
    dict(name='国家队ETF盘后初值核对（19:30）',
         rrule='FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=19;BYMINUTE=30',
         entry='python -X utf8 postclose.py --retries 3 --wait 20',
         desc='只刷交易所正式份额，不跑全量历史，不发布、不覆盖生产页'),
    dict(name='国家队ETF次晨复核与发布（10:00，含周六）',
         rrule='FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA;BYHOUR=10;BYMINUTE=0',
         entry='python -X utf8 morning_review.py',
         desc='含周六；无待复核静默跳过，有修订才发布并核对线上四项；周一顺带跑周报'),
]

MODES = {
    'intraday': 'intraday.py --loop',
    'tick': 'intraday.py --scheduled',
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
        'echo [%DATE:~0,10% %TIME%] start mode=%1 >> "%TASKLOG%"',
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
    raise SystemExit(
        '本机计划任务已停用（2026-11-15）：schtasks 每分钟拉起 cmd 窗口会持续打断用户。\n'
        '请使用 WorkBuddy 平台定时任务；清单见 `python scheduler.py --platform-plan`，'
        '配置说明见 docs/持续追踪实施说明.md。')
    # 以下仅为历史卸载/回放保留，永远不会执行。
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
    g.add_argument('--platform-plan', action='store_true', help='打印现行 WorkBuddy 平台定时任务清单')
    p.add_argument('--dry-run', action='store_true', help='只打印将执行的 schtasks 命令')
    a = p.parse_args()

    if a.platform_plan:
        print('现行调度：WorkBuddy 平台定时任务（本机 schtasks 已于 2026-11-15 全部卸载）')
        for t in PLATFORM_TASKS:
            print('%s\n  RRULE %s\n  入口 %s\n  职责 %s' %
                  (t['name'], t['rrule'], t['entry'], t['desc']))
        print('盘中 60 秒实时观察由页面浏览器端 JSONP 提供；本地为低频留档，等级上限 L1。')
        return

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
