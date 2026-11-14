"""Stage and deploy one verified ETF release, with versioned source and documentation."""
from __future__ import annotations
import argparse
import hashlib
from pathlib import Path
import os
import shutil
import subprocess
import sys
import pipeline
from v2_common import ROOT,DATA,read_json,write_json,now,digest
from v2_release import assess

REPO=Path(os.environ.get('GJD_SITE_REPO',ROOT.parents[1] if (ROOT.parents[1]/'.git').exists() else 'D:/code_all'))
DEST=REPO/'tools/national-team-etf'
SOURCE=REPO/'apps/national-team-etf'
MODULES=['cfg.py','v2_common.py','v2_sources.py','v2_engine.py','v2_exchange.py','v2_tracking.py',
    'v2_release.py','v2_report.py','collect_data.py','pipeline.py','validate_v2.py','publish.py',
    'update.py','serve_preview.py','compat_v2.py','monitor.py']
DOCUMENTS=['国家队ETF数据研究方法_口径与坑.md','国家队追踪_经验库.md','国家队追踪_v2_改版与验证.md']


def content_hash(path):
    data=path.read_bytes()
    if path.suffix!='.gz':data=data.replace(b'\r\n',b'\n')
    return hashlib.sha256(data).hexdigest()


def copy(source,target):
    target.parent.mkdir(parents=True,exist_ok=True)
    if source.resolve()!=target.resolve():shutil.copyfile(source,target)
    return str(target.relative_to(REPO)).replace('\\','/')


def stage():
    a,path=pipeline.latest()
    gate=assess(a);write_json(path/'release_gate.json',gate)
    if not gate['passed']:raise RuntimeError('正式发布检查失败: '+str(gate['problems']))
    acceptance=read_json(path/'acceptance.json')
    if not acceptance or acceptance.get('build_id')!=a['build_id'] or not acceptance.get('passed'):
        raise RuntimeError('缺少当前构建通过的独立验收，请先运行 validate_v2.py')
    # Recheck every immutable raw input at publication time, not whichever raw pointer is latest.
    manifest,_=pipeline.load_snapshot(a['raw_manifest'])
    bm=read_json(path/'manifest.json')
    if digest(manifest)!=bm['raw_manifest_hash']:raise RuntimeError('原始输入批次与构建不符')
    current_hash=digest({p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in list(ROOT.glob('v2_*.py'))+[ROOT/'pipeline.py',ROOT/'collect_data.py',ROOT/'cfg.py']})
    if current_hash!=bm['code_hash']:raise RuntimeError('计算或页面代码已修改，请重新构建并验收')
    files=[]
    for src,dst in [('report.html','index.html'),('cycle.html','cycle.html')]:
        page=(path/src).read_text(encoding='utf8')
        if f'content="{a["build_id"]}"' not in page:raise RuntimeError('页面构建号不同')
        files.append(copy(path/src,DEST/dst))
    files.append(copy(path/'official_flow.csv',DEST/'data/official_flow.csv'))
    public=dict(version=a['version'],build_id=a['build_id'],business_date=a['end'],built_at=a['built_at'],
        data_stage=a['exchange']['stage'],core_members=a['pools']['core15']['members'],
        latest=a['exchange']['latest'],w5=a['exchange']['w5'],unit='亿元；份额为原生份额',
        valuation=a['exchange']['valuation'],identity='当日买卖主体未确认',
        source_urls={c:x['url'] for c,x in a['exchange']['instruments'].items()})
    write_json(DEST/'data/latest.json',public);files.append('tools/national-team-etf/data/latest.json')
    for name in MODULES+['README.md','README_v2.md','卖出侧观测手册.md']:
        files.append(copy(ROOT/name,SOURCE/name))
    for sub in ['config','tests']:
        for file in (ROOT/sub).rglob('*'):
            if file.is_file() and '__pycache__' not in file.parts and file.suffix in {'.py','.json','.gz'}:
                files.append(copy(file,SOURCE/file.relative_to(ROOT)))
    for name in DOCUMENTS:
        original=ROOT/'docs'/name if (ROOT/'docs'/name).exists() else ROOT.parent/name
        target=SOURCE/'docs'/name
        files.append(copy(original,target))
        content=target.read_text(encoding='utf8').replace('(gjd_research/README.md)','(../README.md)')
        content=content.replace('(gjd_audit_20261113/国家队追踪_现有版本审查报告.md)','(audits/国家队追踪_现有版本审查报告.md)')
        content=content.replace('(gjd_audit_20261114/正式ETF份额复核_20261113.md)','(audits/正式ETF份额复核_20261113.md)')
        target.write_text(content,encoding='utf8')
    for folder,name in [('gjd_audit_20261113','国家队追踪_现有版本审查报告.md'),('gjd_audit_20261114','正式ETF份额复核_20261113.md')]:
        original=ROOT.parent/folder/name
        if not original.exists():original=ROOT/'docs/audits'/name
        files.append(copy(original,SOURCE/'docs/audits'/name))
    write_json(SOURCE/'release.json',dict(build_id=a['build_id'],business_date=a['end'],version=a['version'],
        code_hash=bm['code_hash'],configuration_hash=bm['configuration_hash'],raw_manifest_hash=bm['raw_manifest_hash']))
    files.append('apps/national-team-etf/release.json')
    (SOURCE/'.gitignore').write_text('data/\noutput/\n__pycache__/\n*.pyc\n',encoding='utf8')
    files.append('apps/national-team-etf/.gitignore')
    files.append(copy(ROOT/'tests/site_release.test.cjs',REPO/'tests/nationalTeamEtf.test.cjs'))
    receipt=dict(build_id=a['build_id'],business_date=a['end'],version=a['version'],checked_at=now(),
        official_net_yi=a['exchange']['latest']['net_estimate'],official_net5_yi=a['exchange']['w5']['net_estimate'],
        checks=len(acceptance['checks']),hash_format='sha256; UTF-8 text CRLF normalized to LF; gzip raw bytes',
        files={f:content_hash(REPO/f) for f in sorted(set(files))})
    write_json(DEST/'data/release.json',receipt);files.append('tools/national-team-etf/data/release.json')
    print('已准备本地发布文件',a['build_id'],'白名单',len(files),'个文件',flush=True)
    return a,sorted(set(files))


def deploy(files):
    def git(*args):
        cmd=['git','-c','http.proxy=','-c','https.proxy=',*args]
        r=subprocess.run(cmd,cwd=REPO,text=True,encoding='utf8',capture_output=True)
        if r.returncode:raise RuntimeError(r.stderr or r.stdout)
        return r.stdout.strip()
    staged=git('diff','--cached','--name-only').splitlines()
    if any(x not in files for x in staged):raise RuntimeError('暂存区有其他工作，保留原样，未发布')
    git('fetch','origin','main')
    if git('rev-list','--count','origin/main..HEAD')!='0':raise RuntimeError('本地有其他未推送提交，未一起推送')
    if git('rev-list','--count','HEAD..origin/main')!='0':
        git('merge','--ff-only','origin/main')
    git('add','--',*files)
    if git('diff','--cached','--name-only'):
        git('commit','-m','Improve ETF tracking with official share history and verified releases')
        git('push','origin','main')
    print('已推送项目白名单；继续核对Vercel Ready及线上构建号',git('rev-parse','HEAD'),flush=True)


def main():
    p=argparse.ArgumentParser();p.add_argument('--deploy',action='store_true');a=p.parse_args()
    _,files=stage()
    subprocess.run(['node','--test','tests/nationalTeamEtf.test.cjs'],cwd=REPO,check=True)
    if a.deploy:deploy(files)


if __name__=='__main__':main()
