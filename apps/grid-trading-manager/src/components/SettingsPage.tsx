// 设置页（Tab 2）：数据导入导出 / 备份 / 恢复默认 / 关于

import { useMemo, useRef, useState } from 'react';
import { AppData } from '../engine/types';
import { exportFileName, parseImport, storageBytes, STORAGE_KEY } from '../storage';
import { fmtPct } from '../engine/money';
import { useDownload } from './ui';
import { ThemeChoice } from '../theme';
import { Sheet } from './ui';
import { AccountApi } from '../hooks/useAccount';
import { CloudSyncApi } from '../hooks/useCloudSync';
import AccountBlock from './AccountBlock';

interface Props {
  data: AppData;
  theme: ThemeChoice;
  account: AccountApi;
  sync: CloudSyncApi;
  onThemeChange: (c: ThemeChoice) => void;
  onImport: (text: string) => void;
  onReset: () => void;
}

const THEME_LABEL: Record<ThemeChoice, string> = { light: '浅色', auto: '自动', dark: '深色' };

export default function SettingsPage({ data, theme, account, sync, onThemeChange, onImport, onReset }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const download = useDownload();
  const [toast, setToast] = useState<string | null>(null);
  const [showReset, setShowReset] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  // FR-06 P1：导入前预览差异并确认
  const [pending, setPending] = useState<{ text: string; data: AppData } | null>(null);
  const showToast = (m: string) => { setToast(m); setTimeout(() => setToast(null), 2400); };

  // 本地存储占用（估算）：localStorage 上限制约 5 MB，便于用户在接近上限前导出清理
  const usageText = useMemo(() => {
    const bytes = storageBytes(window.localStorage);
    if (bytes == null) return '不可用';
    const kb = bytes / 1024;
    return kb >= 1024 ? (kb / 1024).toFixed(2) + ' MB' : kb.toFixed(1) + ' KB';
  }, []);

  const doImport = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result);
      try {
        const parsed = parseImport(text); // 非法时抛错
        setPending({ text, data: parsed });
      } catch (e) {
        showToast(e instanceof Error ? e.message : '导入失败');
      }
    };
    reader.readAsText(file);
  };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>设置</h1>
          <p className="muted sub">数据与备份</p>
        </div>
      </header>

      <AccountBlock account={account} sync={sync} />

      <section className="group-block">
        <h4 className="group-title">外观主题</h4>
        <div className="seg">
          {(['light', 'auto', 'dark'] as ThemeChoice[]).map((c) => (
            <button
              key={c}
              className={'seg-item' + (theme === c ? ' active' : '')}
              onClick={() => onThemeChange(c)}
              aria-pressed={theme === c}
            >
              {THEME_LABEL[c]}
            </button>
          ))}
        </div>
        <p className="muted small" style={{ marginTop: 8 }}>「自动」将跟随系统的浅色 / 深色设置。</p>
      </section>

      <section className="group-block">
        <h4 className="group-title">数据</h4>
        <div className="cell-list">
          <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) doImport(f); e.target.value = ''; }} />
          <button className="cell" onClick={() => fileRef.current?.click()}>
            <span className="cell-icon">📥</span>
            <span className="cell-label">导入数据</span>
            <span className="cell-value muted">JSON</span>
          </button>
          <button className="cell" onClick={() => { download(JSON.stringify(data, null, 2), exportFileName()); showToast('已导出'); }}>
            <span className="cell-icon">📤</span>
            <span className="cell-label">导出数据</span>
            <span className="cell-value muted">{data.varieties.length} 品种</span>
          </button>
          <button
            className="cell"
            onClick={() => {
              const key = account.userId ? `${STORAGE_KEY}:${account.userId}` : STORAGE_KEY;
              const raw = window.localStorage.getItem(key) ?? '{}';
              download(raw, 'grid-data-raw-backup.json');
              showToast('已备份原始数据');
            }}
          >
            <span className="cell-icon">🗄</span>
            <span className="cell-label">备份本地原始数据</span>
            <span className="cell-value muted">localStorage</span>
          </button>
          <div className="cell" style={{ cursor: 'default' }}>
            <span className="cell-icon">💾</span>
            <span className="cell-label">本地存储占用</span>
            <span className="cell-value muted">{usageText}</span>
          </div>
        </div>
      </section>

      <section className="group-block">
        <h4 className="group-title">重置</h4>
        <div className="cell-list">
          <button className="cell danger" onClick={() => setShowReset(true)}>
            <span className="cell-icon">♻️</span>
            <span className="cell-label">恢复默认 4 品种</span>
            <span className="cell-value muted">覆盖全部</span>
          </button>
        </div>
      </section>

      <section className="group-block">
        <h4 className="group-title">帮助</h4>
        <div className="cell-list">
          <button className="cell" onClick={() => setShowAbout(true)}>
            <span className="cell-icon">ℹ️</span>
            <span className="cell-label">关于本应用</span>
            <span className="cell-value muted">v1.5</span>
          </button>
        </div>
      </section>

      {pending && (
        <Sheet title="确认导入" onClose={() => setPending(null)}>
          <p>
            将导入 <b>{pending.data.varieties.length}</b> 个品种，
            覆盖当前 <b>{data.varieties.length}</b> 个品种，且不可撤销。
          </p>
          <div className="cell-list" style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '0 12px', marginBottom: 10 }}>
            {pending.data.varieties.map((v) => (
              <div className="cell" key={v.id} style={{ cursor: 'default' }}>
                <span className="cell-label">{v.name}</span>
                <span className="cell-value muted">
                  {v.code ? v.code + ' · ' : ''}步长 {fmtPct(Math.round(v.gridStep * 10000))} · {v.nets.length} 网
                </span>
              </div>
            ))}
          </div>
          <p className="muted small">建议先「导出数据」备份当前数据。</p>
          <div className="sheet-actions">
            <button className="btn" onClick={() => setPending(null)}>取消</button>
            <button className="btn btn-danger" onClick={() => { onImport(pending.text); setPending(null); showToast('导入成功'); }}>确认导入</button>
          </div>
        </Sheet>
      )}

      {showReset && (
        <Sheet title="恢复默认数据" onClose={() => setShowReset(false)}>
          <p>将用默认 4 个品种（港股红利 / 豆粕ETF / 消费ETF / 恒生科技）覆盖当前全部数据，操作不可撤销。建议先「导出数据」备份。</p>
          <div className="sheet-actions">
            <button className="btn" onClick={() => setShowReset(false)}>取消</button>
            <button className="btn btn-danger" onClick={() => { onReset(); setShowReset(false); showToast('已恢复默认数据'); }}>确认恢复</button>
          </div>
        </Sheet>
      )}

      {showAbout && (
        <Sheet title="关于" onClose={() => setShowAbout(false)}>
          <div className="about">
            <h3>网格交易管理器</h3>
            <p className="muted">v1.5（移动版 · 双皮肤 · 轻量账号与云备份 · 触发累加）</p>
            <ul className="muted small">
              <li>计算逻辑严格遵循《网格交易网页应用 PRD》，与源表格《网格交易.xlsx》逐格对齐（106 行验收通过）。</li>
              <li>默认状态下数据仅保存在本机浏览器 localStorage 中，不上传任何服务器。</li>
              <li>若你登录了账号：本机数据会额外同步一份到云端（按账号隔离，只有本人凭登录态可读写），本机始终保留完整数据。</li>
              <li>卖出价三规则：首档 = 基准价×(1+步长)；锚点行 = 基准价×(1−锚点档位)；其余 = 上一档买入价。</li>
              <li>导出：单品种 CSV / XLSX，或总览页「全部 XLSX」（含汇总表，多工作表）。</li>
              <li>同一档重复触发时，点数量右侧「＋」一键累加本次量（长按可自填）；仍写入累计数量，口径不变。</li>
              <li>录入可「↶ 撤销上一条」，撤销以反向流水记录，审计历史只增不删。</li>
            </ul>
          </div>
          <div className="sheet-actions">
            <button className="btn btn-primary" onClick={() => setShowAbout(false)}>知道了</button>
          </div>
        </Sheet>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
