"""One manual update: collect, build, test, validate, then optionally deploy.

No scheduling is installed. Close-day data remain a local preview until next-morning checks pass.

三阶段：`--phase close` 只出盘后初值（可独立发布，标注初值级）；
`--phase final` 才走权威份额复核与正式区发布。
"""
import argparse
from datetime import datetime,timedelta
from pathlib import Path
import gzip
import json
import subprocess
import sys
from v2_common import ROOT, DATA, now, read_json, write_json
from v2_stages import build as build_stage, mark_superseded

POSTCLOSE=DATA.parent/'postclose'/'latest.json'


def publish_provisional(a,path,deploy):
    """生成并可选发布盘后初值。绝不触碰正式区，也不改 release 回执。"""
    with gzip.open(path/'ledger.json.gz','rt',encoding='utf-8') as f:
        series=(json.load(f) or {}).get('series') or {}
    summary=build_stage(a,series)
    POSTCLOSE.parent.mkdir(parents=True,exist_ok=True)
    write_json(POSTCLOSE,summary)
    # 兼容旧的盘后初值路径：morning_review 靠它判断「是否存在待复核交易日」。
    # 不写这一份，次晨复核会以为业务日没变而静默跳过，今天的初值就永远进不了正式区。
    legacy=dict(generated_at=summary['generated_at'],business_date=summary['business_date'],
        disclosure_stage=summary['official']['disclosure_stage'],pending_review=True,
        coverage=summary['official']['coverage'],expected=summary['official']['expected'],
        complete=summary['official']['complete'],
        complete_total_policy='覆盖不足时不展示核心15只完整合计，缺口不补0',
        note='深交所T日晚间初值仅供参考，以T+1早间更新为准；本文件不覆盖生产页、不作为正式发布依据',
        next_step=summary['next_step'])
    write_json(DATA.parent/'intraday'/'postclose.json',legacy)
    pn=summary.get('primary_net_yi')
    print('盘后快照已生成：业务日 %s · %s · %s %s 亿 · 官方披露 %d/%d · 疑似抹平 %d/%d 只'%(
        summary['business_date'],summary.get('stage_label') or '盘后',
        summary.get('primary_label') or '净申赎',
        '—' if pn is None else round(pn,2),
        summary['official']['coverage'],summary['official']['expected'],
        summary['flattened']['count'],summary['vendor']['expected_members'] or 0),flush=True)
    if deploy:
        import publish as P
        print('已发布盘后初值',P.deploy_postclose(summary),flush=True)
    return summary


def supersede_previous(final):
    """权威版本发布后，把上一份盘后初值标记为已被替代，保留当时的判断依据。"""
    prev=read_json(POSTCLOSE)
    if not prev or not prev.get('pending_review'):
        return None
    if str(prev.get('business_date') or '')>str(final['end']):
        return None
    fixed=mark_superseded(prev,final['build_id'])
    write_json(POSTCLOSE,fixed)
    print('盘后初值已标记为被 %s 替代'%final['build_id'],flush=True)
    return fixed


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--end',help='请求截止日期，周末及休市日自动保留实际业务日')
    p.add_argument('--offline',action='store_true',help='只重算已留档的原始批次')
    p.add_argument('--deploy',action='store_true',help='核验通过后提交本项目白名单并推送上线')
    p.add_argument('--publish-postclose',action='store_true',
                   help='盘后阶段：把当日初值摘要推到独立位置，不进入正式区、不改 release 回执')
    p.add_argument('--phase',choices=['close','final'],default='final')
    args=p.parse_args()
    if args.publish_postclose and args.phase!='close':
        p.error('--publish-postclose 只能与 --phase close 一起使用；权威版本走 --deploy')
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
            if args.publish_postclose:publish_provisional(a,path,True)
            return
        if not gate['passed']:raise SystemExit('更新未通过发布检查，线上保留上一版：'+str(gate['problems']))
        run('validate_v2.py')
        run('publish.py',*(['--deploy'] if args.deploy else []))
        if args.phase=='final' and args.deploy:
            # 盘后初值的替代标记是附属动作：推送失败只告警，不回滚已完成的正式发布。
            try:
                fixed=supersede_previous(a)
                if fixed:
                    import publish as P
                    P.deploy_postclose(fixed)
            except Exception as exc:
                print('盘后初值替代标记未发布（不影响正式版）：%r'%exc,flush=True)
    finally:
        lock.unlink(missing_ok=True)


if __name__=='__main__':main()
