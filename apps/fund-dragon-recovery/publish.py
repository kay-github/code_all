"""Publish only a verified, current v3 release; preserve unrelated repository work."""
from __future__ import annotations
import argparse,hashlib,os,re,shutil,subprocess,sys
from v3_common import *
from v3_pipeline import latest,assess_release,load_snapshot
from v3_validate import acceptance_fingerprint
from v3_report import public_data

REPO=Path(os.environ.get('FUND_TRACK_REPO',ROOT.parents[1] if (ROOT.parents[1]/'.git').exists() else 'D:/code_all'))
DEST=REPO/'tools/fund-dragon-recovery'
SOURCE=REPO/'apps/fund-dragon-recovery'
MODULES=['v3_common.py','v3_sources.py','v3_engine.py','v3_pipeline.py','v3_report.py','v3_enrich.py','v3_expand_pool.py','v3_validate.py',
         'update.py','publish.py','verify_online.py','compat_v3.py','track.py','render.py','render_keepers.py',
         'build_combined.py','find_keepers.py','verify_beta.py','fetch_nav.py','fetch_all.py','fetch_holders.py',
         'build_pool.py','wide_pool.py','fix_weights.py','patch_pool.py','probe_scale.py','seed_image.csv','README.md','requirements.txt']


def content_hash(p):
    data=p.read_bytes()
    if p.suffix!='.gz':data=data.replace(b'\r\n',b'\n')
    return hashlib.sha256(data).hexdigest()


def stage():
    a,p=latest();bm=read(p/'manifest.json');accept=read(p/'acceptance.json');gate=assess_release(a)
    if not gate['passed']:raise RuntimeError('发布门禁失败 '+str(gate['problems']))
    if not accept or not accept.get('passed') or accept['build_id']!=a['build_id'] or accept['analysis_hash']!=bm['analysis_hash']:
        raise RuntimeError('缺少当前构建的独立验收')
    if bm['code_hash']!=code_fingerprint() or accept['acceptance_hash']!=acceptance_fingerprint():
        raise RuntimeError('代码或验收逻辑已变化，请重新构建验收')
    config=dict(rules=read(CONFIG/'rules.json'),securities=read(CONFIG/'securities.json'),verified_reports=read(CONFIG/'verified_reports.json'))
    if digest(config)!=bm['configuration_hash']:raise RuntimeError('配置已变化，请重新构建验收')
    _,m,_=load_snapshot(a['raw_manifest'],True)
    if digest(m)!=bm['raw_manifest_hash']:raise RuntimeError('原始快照与构建不一致')
    files=[]
    def copy(src,dst):
        dst.parent.mkdir(parents=True,exist_ok=True)
        if src.resolve()!=dst.resolve():shutil.copyfile(src,dst)
        files.append(str(dst.relative_to(REPO)).replace('\\','/'))
    copy(p/'report.html',DEST/'index.html')
    copy(p/'observations.csv',DEST/'data/observations.csv')
    write(DEST/'data/latest.json',public_data(a));files.append('tools/fund-dragon-recovery/data/latest.json')
    for name in MODULES:copy(ROOT/name,SOURCE/name)
    for folder in ['config','tests','docs']:
        for f in (ROOT/folder).rglob('*'):
            if f.is_file() and '__pycache__' not in f.parts and f.suffix in {'.json','.py','.cjs','.md'}:copy(f,SOURCE/f.relative_to(ROOT))
    copy(ROOT/'tests/site_release.test.cjs',REPO/'tests/fundDragonRecovery.test.cjs')
    write(SOURCE/'release.json',dict(build_id=a['build_id'],business_date=a['end'],version=VERSION,code_hash=bm['code_hash'],
        configuration_hash=bm['configuration_hash'],raw_manifest_hash=bm['raw_manifest_hash'],acceptance_hash=accept['acceptance_hash']))
    files.append('apps/fund-dragon-recovery/release.json')
    write(SOURCE/'validation-summary.json',dict(build_id=a['build_id'],passed=accept['passed'],checks=len(accept['checks']),
        verified_at=accept['checked_at'],summary=a['summary'],limitations=accept['verification_limits']))
    files.append('apps/fund-dragon-recovery/validation-summary.json')
    (SOURCE/'.gitignore').write_text('data/\noutput/\n__pycache__/\n*.pyc\n',encoding='utf8');files.append('apps/fund-dragon-recovery/.gitignore')
    receipt=dict(build_id=a['build_id'],business_date=a['end'],checked_at=now(),
        hash_format='sha256; text CRLF normalized to LF; gzip raw bytes',files={f:content_hash(REPO/f) for f in sorted(set(files))})
    write(DEST/'data/release.json',receipt);files.append('tools/fund-dragon-recovery/data/release.json')
    home=REPO/'assets/site-defaults.js'
    text=home.read_text(encoding='utf8')
    lines=text.splitlines(keepends=True)
    for i,line in enumerate(lines):
        if "id: 'fundRecovery'" in line:
            lines[i]=re.sub(r"description: '[^']*'", "description: '根据净值与定报观察双龙回补线索，区分收益关联和已披露持仓。'",line)
            break
    else:raise RuntimeError('未找到双龙站点入口，请核对主页配置')
    home.write_text(''.join(lines),encoding='utf8');files.append('assets/site-defaults.js')
    subprocess.run(['node','--test','tests/fundDragonRecovery.test.cjs'],cwd=REPO,check=True)
    print('发布文件已准备',len(files),'个',a['build_id'],flush=True)
    return a,sorted(set(files))


def deploy(files):
    def git(*args):
        proxy=os.environ.get('FUND_TRACK_GIT_PROXY') or os.environ.get('HTTPS_PROXY') or os.environ.get('https_proxy') or ''
        r=subprocess.run(['git','-c','http.proxy='+proxy,'-c','https.proxy='+proxy,'-c','core.quotepath=false',*args],cwd=REPO,capture_output=True,text=True,encoding='utf8')
        if r.returncode:raise RuntimeError(r.stderr or r.stdout)
        return r.stdout.strip()
    staged=git('diff','--cached','--name-only').splitlines()
    if any(f not in files for f in staged):raise RuntimeError('保留暂存区的其他工作，未提交')
    git('fetch','origin','main')
    if git('rev-list','--count','origin/main..HEAD')!='0':raise RuntimeError('存在其他本地未推送提交，未一起推送')
    if git('rev-list','--count','HEAD..origin/main')!='0':git('merge','--ff-only','origin/main')
    git('add','--',*files)
    if git('diff','--cached','--name-only'):
        git('commit','-m','Rebuild fund dragon tracker with verified data and conservative exposure signals')
        git('push','origin','main')
    print('已推送',git('rev-parse','HEAD'),'；需继续核验生产 Ready 和公开数据。',flush=True)


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--deploy',action='store_true');args=p.parse_args()
    _,files=stage()
    if args.deploy:
        deploy(files)
        from verify_online import verify
        verify()
