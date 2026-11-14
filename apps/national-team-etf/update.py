"""One manual update: collect, build, test, validate, then optionally deploy.

No scheduling is installed. Close-day data remain a local preview until next-morning checks pass.
"""
import argparse
from datetime import datetime,timedelta
from pathlib import Path
import subprocess
import sys
from v2_common import ROOT, DATA, now, read_json, write_json


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--end',help='请求截止日期，周末及休市日自动保留实际业务日')
    p.add_argument('--offline',action='store_true',help='只重算已留档的原始批次')
    p.add_argument('--deploy',action='store_true',help='核验通过后提交本项目白名单并推送上线')
    p.add_argument('--phase',choices=['close','final'],default='final')
    args=p.parse_args()
    if args.offline and args.end:p.error('--offline不能指定新日期；使用留档批次的实际业务日')
    # Avoid publishing an intraday/latest-day denominator under a final label.
    today=datetime.fromisoformat(now()).date()
    end=args.end or ((today-timedelta(days=1)).isoformat() if args.phase=='final' else today.isoformat())
    def run(*cmd):subprocess.run([sys.executable,'-X','utf8',*cmd],cwd=ROOT,check=True)
    lock=DATA/'update.lock';DATA.mkdir(parents=True,exist_ok=True)
    try:
        stream=lock.open('x',encoding='utf8')
    except FileExistsError:raise SystemExit('另一次更新尚未结束。确认进程已退出后再移除 data/v2/update.lock，不并发写最新指针。')
    try:
        with stream:stream.write(now())
        run('-m','unittest','discover','-s','tests','-v')
        if not args.offline:run('collect_data.py','--end',end)
        run('pipeline.py')
        import pipeline
        from v2_release import assess
        a,path=pipeline.latest();gate=assess(a);write_json(path/'release_gate.json',gate)
        if args.phase=='close' and not gate['passed']:
            print('已生成收盘初值本地预览；正式发布检查尚未通过：',gate['problems'])
            if args.deploy:raise SystemExit('初值不自动覆盖生产页；次晨以 --phase final 复核')
            return
        if not gate['passed']:raise SystemExit('更新未通过发布检查，线上保留上一版：'+str(gate['problems']))
        run('validate_v2.py')
        run('publish.py',*(['--deploy'] if args.deploy else []))
    finally:
        lock.unlink(missing_ok=True)


if __name__=='__main__':main()
