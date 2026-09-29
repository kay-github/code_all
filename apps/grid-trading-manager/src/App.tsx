import { useCallback, useEffect, useState } from 'react';
import { AppData, Variety, genId } from './engine/types';
import { cloneSeed } from './engine/seed';
import { addJournalQty, applyJournalChange, revertLastChange } from './engine/journal';
import { loadData, parseImport, saveData, STORAGE_KEY } from './storage';
import { applyTheme, loadThemeChoice, resolveTheme, saveThemeChoice, ThemeChoice } from './theme';
import { useAccount } from './hooks/useAccount';
import { useCloudSync } from './hooks/useCloudSync';
import OverviewPage from './components/OverviewPage';
import SettingsPage from './components/SettingsPage';
import WorkbenchPage from './components/WorkbenchPage';
import ConfigPage from './components/ConfigPage';

type Tab = 'varieties' | 'settings';
type StackRoute =
  | { page: 'workbench'; id: string }
  | { page: 'config'; id: string };

export default function App() {
  const [data, setData] = useState<AppData | null>(null);
  const [dataKey, setDataKey] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState<{ msg: string; raw: string | null } | null>(null);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('varieties');
  const [stack, setStack] = useState<StackRoute | null>(null);
  const [theme, setTheme] = useState<ThemeChoice>(() => loadThemeChoice());

  // 账号与云备份（FR-10）：未登录时完全惰性，不发任何请求
  const account = useAccount();

  // 应用主题（含「跟随系统」时监听系统偏好变化）
  useEffect(() => {
    applyTheme(resolveTheme(theme));
    if (theme !== 'auto' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyTheme(resolveTheme('auto'));
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [theme]);

  const onThemeChange = useCallback((c: ThemeChoice) => {
    setTheme(c);
    saveThemeChoice(c);
  }, []);
  const onToggleTheme = useCallback(() => {
    const next = resolveTheme(theme) === 'dark' ? 'light' : 'dark';
    setTheme(next);
    saveThemeChoice(next);
  }, [theme]);

  const expectedKey = account.userId ? `${STORAGE_KEY}:${account.userId}` : STORAGE_KEY;
  useEffect(() => {
    if (account.checking) return;
    setData(null);
    setDataKey(null);
    setLoadErr(null);
    setStack(null);
    const res = loadData(window.localStorage, expectedKey);
    if (res.error) setLoadErr({ msg: res.error, raw: res.raw });
    else if (res.data) setData(res.data);
    else setData(cloneSeed()); // 首次使用 → 默认 4 品种（FR-07）
    setDataKey(expectedKey);
  }, [account.checking, expectedKey]);

  useEffect(() => {
    if (!data || dataKey !== expectedKey) return;
    const result = saveData(window.localStorage, data, dataKey);
    setSaveErr(result.ok ? null : result.error ?? '本地保存失败');
  }, [data, dataKey, expectedKey]);

  // 云端同步（FR-10）：未登录时 phase='off'，零请求。云端只是镜像，本地始终是真值。
  const replaceData = useCallback((d: AppData) => setData(d), []);
  const sync = useCloudSync({
    data: dataKey === expectedKey ? data : null,
    replaceData,
    signedIn: account.signedIn && dataKey === expectedKey,
    userId: dataKey === expectedKey ? account.userId : null,
  });

  const findVariety = useCallback(
    (id: string) => data?.varieties.find((v) => v.id === id) ?? null,
    [data],
  );

  const upsertVariety = useCallback((v: Variety) => {
    setData((d) => {
      if (!d) return d;
      const idx = d.varieties.findIndex((x) => x.id === v.id);
      const varieties = idx >= 0 ? d.varieties.map((x) => (x.id === v.id ? v : x)) : [...d.varieties, v];
      return { ...d, varieties };
    });
  }, []);

  const deleteVariety = useCallback((id: string) => {
    setData((d) => (d ? { ...d, varieties: d.varieties.filter((x) => x.id !== id) } : d));
  }, []);

  const duplicateVariety = useCallback((id: string) => {
    setData((d) => {
      if (!d) return d;
      const src = d.varieties.find((x) => x.id === id);
      if (!src) return d;
      const copy: Variety = JSON.parse(JSON.stringify(src));
      copy.id = genId();
      copy.name = src.name + ' 副本';
      const idx = d.varieties.findIndex((x) => x.id === id);
      const varieties = [...d.varieties];
      varieties.splice(idx + 1, 0, copy);
      return { ...d, varieties };
    });
  }, []);

  const resetAll = useCallback(() => setData(cloneSeed()), []);

  const importData = useCallback((text: string) => {
    const parsed = parseImport(text); // 非法时抛错，由调用方捕获展示
    setData(parsed);
  }, []);

  if (loadErr) {
    return (
      <div className="phone">
        <div className="error-screen">
          <div className="error-icon">⚠️</div>
          <h2>本地数据无法读取</h2>
          <p className="muted">{loadErr.msg}</p>
          {loadErr.raw && (
            <button
              className="btn"
              onClick={() => {
                const blob = new Blob([loadErr.raw!], { type: 'application/json' });
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = 'grid-data-recovery.json';
                a.click();
              }}
            >
              导出原始数据（抢救备份）
            </button>
          )}
          <button className="btn btn-danger" onClick={() => { setLoadErr(null); resetAll(); }}>
            放弃并恢复默认数据
          </button>
        </div>
      </div>
    );
  }

  if (account.checking || dataKey !== expectedKey || !data) return <div className="phone"><p className="muted loading-text">加载中…</p></div>;

  // 存储写入失败提示（全局可见，可关闭）
  const saveBanner = saveErr ? (
    <div className="banner banner-error save-banner" role="alert">
      <span>⚠️ {saveErr}</span>
      <button className="btn btn-mini" onClick={() => setSaveErr(null)}>知道了</button>
    </div>
  ) : null;

  // ---- 栈页（详情/配置），隐藏底部 Tab ----
  if (stack?.page === 'workbench') {
    const v = findVariety(stack.id);
    if (v) {
      return (
        <>
          {saveBanner}
          <WorkbenchPage
            key={v.id}
            variety={v}
            theme={resolveTheme(theme)}
            onToggleTheme={onToggleTheme}
            onBack={() => setStack(null)}
            onOpenConfig={() => setStack({ page: 'config', id: v.id })}
            onUpdateJournal={(rowId, field, qty) => {
              // FR-08：D/G 为唯一计算真值；applyJournalChange 同时追加审计流水
              upsertVariety(applyJournalChange(v, rowId, field, qty));
            }}
            onAddJournal={(rowId, field, delta) => {
              // FR-11：重复触发时按「本次触发量」累加，仍然写成 D/G 累计量（口径不变）
              upsertVariety(addJournalQty(v, rowId, field, delta));
            }}
            onUndo={() => {
              const res = revertLastChange(v);
              if (res.entry) upsertVariety(res.variety);
              return res.entry ? 'ok' : (res.reason === 'empty' ? 'empty' : 'stale');
            }}
            onUpdateBasePrice={(bp) => upsertVariety({ ...v, basePrice: bp })}
            onUpdateQuote={(patch) => upsertVariety({ ...v, ...patch })}
          />
        </>
      );
    }
  }

  if (stack?.page === 'config') {
    const v = findVariety(stack.id);
    if (v) {
      return (
        <>
          {saveBanner}
          <ConfigPage
            key={v.id}
            variety={v}
            theme={resolveTheme(theme)}
            onToggleTheme={onToggleTheme}
            existingNames={data.varieties.map((x) => x.name)}
            onBack={() => setStack({ page: 'workbench', id: v.id })}
            onSave={(nv) => {
              upsertVariety(nv);
              setStack({ page: 'workbench', id: nv.id });
            }}
          />
        </>
      );
    }
  }

  // ---- 根层：Tab 页 ----
  return (
    <div className="phone">
      {tab === 'varieties' ? (
        <OverviewPage
          data={data}
          onOpen={(id) => setStack({ page: 'workbench', id })}
          onConfig={(id) => setStack({ page: 'config', id })}
          onCreate={(form) => {
            const v: Variety = {
              id: genId(),
              name: form.name.trim(),
              code: form.code.trim(),
              basePrice: form.basePrice,
              gridStep: form.gridStep,
              nets: [{ type: '小网', startGrid: 0, endGrid: 5, anchorGrid: null }],
              journal: {},
              ledger: [],
            };
            upsertVariety(v);
            setStack({ page: 'config', id: v.id });
          }}
          onDuplicate={duplicateVariety}
          onDelete={deleteVariety}
        />
      ) : (
        <SettingsPage
          data={data}
          theme={theme}
          account={account}
          sync={sync}
          onThemeChange={onThemeChange}
          onImport={importData}
          onReset={resetAll}
        />
      )}

      <nav className="tabbar">
        <button className={'tab-item' + (tab === 'varieties' ? ' active' : '')} onClick={() => setTab('varieties')}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="7" height="7" rx="1.5" />
            <rect x="14" y="3" width="7" height="7" rx="1.5" />
            <rect x="3" y="14" width="7" height="7" rx="1.5" />
            <rect x="14" y="14" width="7" height="7" rx="1.5" />
          </svg>
          <span>品种</span>
        </button>
        <button
          role="tab"
          aria-selected={tab === 'settings'}
          className={'tab-item' + (tab === 'settings' ? ' active' : '')}
          onClick={() => setTab('settings')}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
          <span>设置</span>
        </button>
      </nav>
    </div>
  );
}
