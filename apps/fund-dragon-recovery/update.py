"""Single manual update entry point; installs no schedules."""
from __future__ import annotations
import argparse
from datetime import datetime
from v3_common import *


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--end',default=datetime.now(TZ).date().isoformat())
    p.add_argument('--analyze-only',action='store_true',help='recompute one immutable snapshot, no market/NAV refresh')
    p.add_argument('--review',action='store_true',help='fetch priority fund portfolios even with --analyze-only')
    p.add_argument('--validate-only',action='store_true')
    p.add_argument('--publish',action='store_true',help='stage the verified release locally')
    p.add_argument('--deploy',action='store_true',help='scoped Git commit/push, followed by public verification')
    p.add_argument('--skip-quotes',action='store_true',help=argparse.SUPPRESS)
    p.add_argument('--skip-kp',action='store_true',help=argparse.SUPPRESS)
    args=p.parse_args()
    from v3_validate import validate
    if args.validate_only:validate();return
    if args.skip_quotes:
        print('旧 --skip-quotes 映射为完整快照复算；不混合新净值与旧行情。',flush=True)
        args.analyze_only=True
    from v3_pipeline import build
    if not args.analyze_only:
        from v3_sources import collect
        collect(args.end)
    raw=read(DATA/'raw_latest.json')
    if not raw:raise RuntimeError('无原始快照，请先运行 update.py')
    analysis,path=build(raw['manifest'])
    if not args.analyze_only or args.review:
        from v3_enrich import enrich
        enrich(analysis['raw_manifest'],path)
        analysis,path=build(read(DATA/'raw_latest.json')['manifest'])
    validate(path)
    if args.publish or args.deploy:
        from publish import stage,deploy
        _,files=stage()
        if args.deploy:
            deploy(files)
            from verify_online import verify
            verify()
    print('完成',analysis['build_id'],'STOP_SIGNAL=False；持续跟踪，不创建定时任务。',flush=True)


if __name__=='__main__':main()
