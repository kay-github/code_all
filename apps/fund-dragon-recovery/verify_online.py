"""Verify production readiness, exact public bytes, and committed release sources."""
from __future__ import annotations
import hashlib,json,os,subprocess,time,urllib.request
from v3_common import *


def verify(attempts=30,delay=10):
    from publish import REPO,DEST,content_hash
    from v3_pipeline import latest
    a,p=latest();base='https://1.688680.xyz';receipt=read(DEST/'data/release.json')
    print('开始生产验收',a['build_id'],flush=True)
    env=dict(os.environ)
    for k in list(env):
        if k.lower() in {'http_proxy','https_proxy','all_proxy'}:env.pop(k)
    def fetch(path):
        req=urllib.request.Request(base+path,headers={'User-Agent':'Mozilla/5.0','Cache-Control':'no-cache'})
        with urllib.request.urlopen(req,timeout=35) as r:return dict(status=r.status,url=r.url,body=r.read())
    state=None
    for i in range(attempts):
        result=subprocess.run(['cmd','/d','/c','vercel','inspect',base,'--format=json','--scope','chenxiaokais-projects'],
            cwd=REPO,env=env,capture_output=True,text=True,encoding='utf8',timeout=45)
        if result.returncode==0:
            try:state=json.loads(result.stdout)
            except ValueError:state=None
        print('生产状态',state.get('readyState') if state else '未取得',flush=True)
        try:
            live=json.loads(fetch('/tools/fund-dragon-recovery/data/latest.json')['body'])
            print('公开构建',live.get('build_id'),flush=True)
            if state and state.get('readyState')=='READY' and live.get('build_id')==a['build_id']:break
        except Exception as exc:print('公开构建待复核',type(exc).__name__,str(exc)[:160],flush=True)
        if i==0 or i%6==0:print('等待生产部署',a['build_id'],'当前',state.get('readyState') if state else '未知',flush=True)
        if i==attempts-1:raise RuntimeError('生产构建或数据尚未核对成功；未记录上线通过')
        time.sleep(delay)
    paths=['/jjhc','/fund-dragon-recovery','/tools/fund-dragon-recovery/index.html',
        '/tools/fund-dragon-recovery/data/latest.json','/tools/fund-dragon-recovery/data/observations.csv',
        '/tools/fund-dragon-recovery/data/release.json','/assets/site-theme.js','/assets/workspace-theme.css']
    # Sequential reads keep this small production check observable and avoid
    # concurrent Windows TLS/proxy initialization during release verification.
    responses={}
    for path in paths:
        responses[path]=fetch(path)
        print('生产HTTP核对',path,responses[path]['status'],flush=True)
    checks=[]
    def check(name,condition):
        if not condition:raise AssertionError(name)
        checks.append(name)
    for path,r in responses.items():check('HTTP200 '+path,r['status']==200)
    for path in paths[:3]:
        content=responses[path]['body'].replace(b'\r\n',b'\n')
        check('public page matches '+path,hashlib.sha256(content).hexdigest()==receipt['files']['tools/fund-dragon-recovery/index.html'])
    for name in ['latest.json','observations.csv']:
        path='/tools/fund-dragon-recovery/data/'+name
        check('public data hash '+name,hashlib.sha256(responses[path]['body'].replace(b'\r\n',b'\n')).hexdigest()==receipt['files']['tools/fund-dragon-recovery/data/'+name])
    check('public release receipt',json.loads(responses['/tools/fund-dragon-recovery/data/release.json']['body'])==receipt)
    commit=subprocess.run(['git','rev-parse','HEAD'],cwd=REPO,capture_output=True,text=True,check=True).stdout.strip()
    print('公开文件已对齐，核对提交中的源码与数据',flush=True)
    for f,h in receipt['files'].items():
        r=subprocess.run(['git','show','HEAD:'+f],cwd=REPO,capture_output=True,check=True)
        b=r.stdout if f.endswith('.gz') else r.stdout.replace(b'\r\n',b'\n')
        check('committed '+f,hashlib.sha256(b).hexdigest()==h and content_hash(REPO/f)==h)
    proof=dict(passed=True,build_id=a['build_id'],business_date=a['end'],checked_at=now(),commit=commit,
        deployment={k:state.get(k) for k in ['id','url','readyState','target']},
        url=base+'/jjhc',checks=checks,verification_limit='HTTP/数据/脚本已核验；未做真实Chrome视觉验收')
    write(p/'online_verification.json',proof)
    print('线上核对通过',a['build_id'],len(checks),'项',base+'/jjhc',flush=True)
    return proof


if __name__=='__main__':verify()
