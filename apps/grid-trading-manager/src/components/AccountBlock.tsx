import { useState } from 'react';
import type { AccountApi, AuthStep } from '../hooks/useAccount';
import type { CloudSyncApi } from '../hooks/useCloudSync';
import { Sheet } from './ui';

interface Props { account: AccountApi; sync: CloudSyncApi }
const USERNAME_RE = /^[a-zA-Z0-9_]{3,32}$/;

function fmtSyncTime(ts: number | null): string {
  if (!ts) return '尚未同步';
  return new Date(ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function AccountBlock({ account, sync }: Props) {
  const { signedIn, username, open, step, error, notice, busy, recoveryCode } = account;
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [showDelete, setShowDelete] = useState(false);

  const goto = (next: AuthStep) => {
    setPassword(''); setCode(''); account.clearMessages(); account.setStep(next);
  };
  const close = () => {
    setPassword(''); setCode(''); account.closePanel();
  };
  const validName = () => {
    if (!USERNAME_RE.test(name.trim())) {
      account.fail('账号名须为 3–32 位英文字母、数字或下划线');
      return false;
    }
    return true;
  };
  const validPassword = () => {
    if (password.length < 10 || password.length > 128) {
      account.fail('密码须为 10–128 位');
      return false;
    }
    return true;
  };
  const submit = async () => {
    if (!validName()) return;
    if (!validPassword()) return;
    let ok = false;
    if (step === 'login') ok = await account.login(name.trim(), password);
    if (step === 'register') ok = await account.register(name.trim(), password);
    if (step === 'reset') {
      if (!code.trim()) return account.fail('请输入恢复码');
      ok = await account.resetPassword(name.trim(), code.trim(), password);
    }
    setPassword('');
    if (ok && step === 'login') close();
  };

  const errorBox = error ? (
    <div className="banner banner-error auth-msg" role="alert">
      <span>⚠️ {error.text}</span>
      <span className="diag">{error.code ?? 'error'}{error.status ? ` · ${error.status}` : ''}</span>
    </div>
  ) : null;
  const noticeBox = notice ? <p className="muted small auth-msg">✓ {notice}</p> : null;
  const syncText = !signedIn ? '未开启'
    : sync.phase === 'checking' ? '正在比对云端…'
    : sync.phase === 'choosing' ? '有待确认的差异'
    : sync.phase === 'error' ? '上次同步未成功（本机数据未受影响）'
    : sync.phase === 'ready' ? (sync.working ? '同步中…' : `已同步 · ${fmtSyncTime(sync.lastSyncAt)}`)
    : '未开启';
  const conflict = sync.conflict;

  return <>
    <section className="group-block">
      <h4 className="group-title">账号与云备份</h4>
      <div className="cell-list">
        <div className="cell" style={{ cursor: 'default' }}>
          <span className="cell-icon">{signedIn ? '☁️' : '📴'}</span>
          <span className="cell-label">{signedIn ? '已登录' : '未登录'}</span>
          <span className="cell-value muted">{account.checking ? '确认中…' : username ?? '仅本机保存'}</span>
        </div>
        {signedIn && <div className="cell" style={{ cursor: 'default' }}>
          <span className="cell-icon">🔄</span><span className="cell-label">同步状态</span>
          <span className="cell-value muted">{syncText}</span>
        </div>}
        <button className="cell" onClick={() => account.openPanel(signedIn ? 'idle' : 'login')}>
          <span className="cell-icon">🔑</span>
          <span className="cell-label">{signedIn ? '账号管理' : '登录 / 注册'}</span>
          <span className="cell-value muted">{signedIn ? '同步与退出' : '云备份'}</span>
        </button>
        {signedIn && <button className="cell" disabled={sync.working} onClick={sync.syncNow}>
          <span className="cell-icon">⬆️</span><span className="cell-label">上传本机改动</span>
          <span className="cell-value muted">{sync.working ? '进行中…' : '立即同步'}</span>
        </button>}
        {signedIn && <button className="cell danger" onClick={() => setShowDelete(true)}>
          <span className="cell-icon">🗑</span><span className="cell-label">删除云端数据</span>
          <span className="cell-value muted">本机保留</span>
        </button>}
      </div>
      {!open && errorBox}{!open && noticeBox}
      {signedIn && sync.failure && <p className="muted small auth-foot">{sync.failure.message}</p>}
      <p className="muted small auth-foot">未登录也可使用，数据保存在本机。登录后可在多台设备同步各自账号的数据。</p>
    </section>

    {conflict && <Sheet title={conflict.reason === 'first-login' ? '云端已有数据' : '检测到两端都有改动'}
      onClose={() => { /* user must decide */ }}>
      <p>本机与云端的数据不同。请选择保留哪一份，放弃的那份无法恢复。</p>
      <p className="muted small">本机 {conflict.localCount} 个品种；云端 {conflict.remoteCount ?? '未知'} 个品种。</p>
      <div className="sheet-actions auth-actions-col">
        <button className="btn" onClick={sync.exportLocal}>先导出本机数据</button>
        <button className="btn btn-primary" disabled={sync.working} onClick={() => void sync.resolve('local')}>用本机覆盖云端</button>
        <button className="btn" disabled={sync.working} onClick={() => void sync.resolve('cloud')}>用云端覆盖本机</button>
      </div>
    </Sheet>}

    {showDelete && <Sheet title="删除云端数据" onClose={() => setShowDelete(false)}>
      <p>将删除此账号的云端备份，无法恢复。本机数据保留，之后编辑可能重新上传。</p>
      <div className="sheet-actions">
        <button className="btn" onClick={() => setShowDelete(false)}>取消</button>
        <button className="btn btn-danger" disabled={sync.working}
          onClick={() => { void sync.deleteCloud().then((failure) => {
            setShowDelete(false);
            if (failure) account.fail(`删除失败：${failure.message}`);
          }); }}>确认删除</button>
      </div>
    </Sheet>}

    {open && <Sheet title={step === 'register' ? '注册' : step === 'reset' ? '恢复账号' : step === 'login' ? '登录' : '账号'} onClose={close}>
      {recoveryCode && <div className="banner auth-msg" role="status">
        <b>请保存一次性恢复码</b>
        <p>忘记密码时需要它。此码只显示一次，重置密码后会更换。</p>
        <code style={{ overflowWrap: 'anywhere', userSelect: 'all' }}>{recoveryCode}</code>
        <div className="sheet-actions">
          <button className="btn" onClick={() => void navigator.clipboard.writeText(recoveryCode)}>复制恢复码</button>
          <button className="btn btn-primary" onClick={account.dismissRecoveryCode}>我已保存</button>
        </div>
      </div>}
      {step === 'idle' && <>
        <div className="cell-list auth-card">
          <div className="cell"><span className="cell-label">当前账号</span><span className="cell-value muted">{username ?? '未登录'}</span></div>
          <div className="cell"><span className="cell-label">同步状态</span><span className="cell-value muted">{syncText}</span></div>
        </div>
        {errorBox}{noticeBox}
        <div className="sheet-actions">
          {signedIn ? <button className="btn btn-danger" disabled={busy || Boolean(recoveryCode)} onClick={() => void account.signOut()}>退出登录</button>
            : <><button className="btn" onClick={() => goto('register')}>注册</button>
              <button className="btn btn-primary" onClick={() => goto('login')}>登录</button></>}
        </div>
      </>}
      {step !== 'idle' && <>
        <div className="field-list">
          <label className="field"><span>账号名</span>
            <input className="input" autoComplete="username" value={name}
              onChange={(e) => setName(e.target.value)} placeholder="3–32 位字母、数字或下划线" />
          </label>
          {step === 'reset' && <label className="field"><span>恢复码</span>
            <input className="input" autoComplete="off" value={code}
              onChange={(e) => setCode(e.target.value)} placeholder="注册时保存的恢复码" />
          </label>}
          <label className="field"><span>{step === 'reset' ? '新密码' : '密码'}</span>
            <input className="input" type="password" autoComplete={step === 'login' ? 'current-password' : 'new-password'}
              value={password} onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }} placeholder="至少 10 位" />
          </label>
        </div>
        {errorBox}{noticeBox}
        <div className="sheet-actions">
          <button className="btn" disabled={busy} onClick={() => goto('login')}>返回登录</button>
          <button className="btn btn-primary" disabled={busy} onClick={() => void submit()}>
            {busy ? '处理中…' : step === 'login' ? '登录' : step === 'register' ? '注册' : '重置密码'}
          </button>
        </div>
        {step === 'login' && <p className="muted small auth-foot">
          <button className="link-btn" onClick={() => goto('register')}>注册新账号</button> ·
          <button className="link-btn" onClick={() => goto('reset')}>忘记密码</button>
        </p>}
        {step === 'register' && <p className="muted small auth-foot">任何人都可注册。请妥善保存注册后显示的恢复码。</p>}
        {step === 'reset' && <p className="muted small auth-foot">没有恢复码将无法重置密码。重置后其他设备需重新登录。</p>}
      </>}
    </Sheet>}
  </>;
}

