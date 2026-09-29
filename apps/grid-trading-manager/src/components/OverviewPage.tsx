// 品种总览页（移动端：组合汇总 + 卡片流 + FAB 新建 + ActionSheet 菜单）
//
// v1.3 补强：
//   1) 顶部新增**跨品种组合汇总**（总利润/总收益率/总持仓/基准价设置情况），直击 PRD §1.1 痛点；
//   2) 新增**一键导出全部品种**（多 sheet XLSX / 汇总 CSV）；
//   3) 未设基准价的卡片补「设置基准价」引导按钮（PRD 8.2 要求）；
//   4) 卡片显示孤儿录入条数（BR-13 可见化）；
//   5) 每张卡只展开一次（原实现重复 expandRows）。

import { useMemo, useRef, useState } from 'react';
import { AppData, Variety } from '../engine/types';
import { computePortfolio, computeSummary, expandRows, orphanJournalIds } from '../engine/engine';
import { fmtMoney, fmtPct, fmtScaled, QTY_SCALE } from '../engine/money';
import { validateVarietyBase } from '../engine/validation';
import { allVarietiesToCsv, allCsvFileName } from '../csv';
import { allVarietiesToXlsxBlob, allXlsxFileName } from '../xlsx';
import { Sheet, Dialog } from './ui';

interface Props {
  data: AppData;
  onOpen: (id: string) => void;
  onConfig: (id: string) => void;
  onCreate: (form: { name: string; code: string; basePrice: number | null; gridStep: number }) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
}

/** 触发浏览器下载（Blob） */
function saveBlob(blob: Blob, filename: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export default function OverviewPage({ data, onOpen, onConfig, onCreate, onDuplicate, onDelete }: Props) {
  const [showCreate, setShowCreate] = useState(false);
  const [menuTarget, setMenuTarget] = useState<Variety | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Variety | null>(null);
  const [deleteInput, setDeleteInput] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const showToast = (m: string) => { setToast(m); setTimeout(() => setToast(null), 2400); };
  const dupName = useRef('');

  // 每种品种只展开一次：行 / 汇总 / 孤儿数一次算清（原实现 expandRows 被调用两次）
  const cards = useMemo(
    () => data.varieties.map((v) => {
      const rows = expandRows(v);
      return { v, count: rows.length, summary: computeSummary(rows), orphans: orphanJournalIds(v).length };
    }),
    [data],
  );

  const portfolio = useMemo(() => computePortfolio(data.varieties), [data]);

  const downloadAll = (kind: 'xlsx' | 'csv') => {
    if (kind === 'xlsx') {
      saveBlob(allVarietiesToXlsxBlob(data.varieties), allXlsxFileName());
    } else {
      saveBlob(new Blob([allVarietiesToCsv(data.varieties)], { type: 'text/csv;charset=utf-8' }), allCsvFileName());
    }
    showToast('已导出全部品种（' + kind.toUpperCase() + '）');
  };

  const profitEl = (profit: bigint | null) => {
    if (profit === null) return <span className="muted">—</span>;
    const cls = profit > 0n ? 'up' : profit < 0n ? 'down' : '';
    return <b className={cls}>{'¥' + fmtMoney(profit)}</b>;
  };

  const rate = portfolio.profitRate === null ? null : (portfolio.profitRate * 100).toFixed(2) + '%';

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>网格交易</h1>
          <p className="muted sub">{data.varieties.length} 个品种 · 数据保存在本机</p>
        </div>
      </header>

      {/* 组合汇总（跨品种，FR-05 扩展） */}
      {cards.length > 0 && (
        <section className="portfolio-card">
          <div className="portfolio-main">
            <div>
              <span className="muted small">组合合计利润</span>
              <div className={'summary-big ' + (portfolio.totalProfitH8 === null || portfolio.totalProfitH8 === 0n ? '' : portfolio.totalProfitH8 > 0n ? 'up' : 'down')}>
                {portfolio.totalProfitH8 === null ? '—' : '¥' + fmtMoney(portfolio.totalProfitH8)}
              </div>
            </div>
            <div className="portfolio-actions">
              <button className="btn btn-mini" onClick={() => downloadAll('xlsx')} title="导出全部品种为一个 Excel（含汇总表）">⬇️ 全部 XLSX</button>
              <button className="btn btn-mini" onClick={() => downloadAll('csv')} title="导出组合汇总为 CSV">⬇️ 汇总 CSV</button>
            </div>
          </div>
          <div className="chips">
            <span className="chip">总买入 <i className="derived">衍生</i> {portfolio.totalBuyH8 === null ? '—' : '¥' + fmtMoney(portfolio.totalBuyH8)}</span>
            <span className="chip">收益率 <i className="derived">衍生</i> {rate ?? '—'}</span>
            <span className="chip">总持仓 {fmtScaled(portfolio.totalRemainingQ4, QTY_SCALE, 4)}</span>
            <span className="chip">已设基准价 {portfolio.withBase}/{portfolio.count}</span>
          </div>
          {portfolio.withoutBase > 0 && (
            <p className="muted small" style={{ margin: '8px 0 0' }}>
              提示：{portfolio.withoutBase} 个品种未设基准价（价格/金额/利润暂不计算），不影响录入数量与持仓。
            </p>
          )}
        </section>
      )}

      {cards.length === 0 && (
        <div className="empty">
          <p className="muted">暂无品种</p>
          <p className="muted small">点击右下角 ＋ 新建，或到「设置」恢复默认数据</p>
        </div>
      )}

      <div className="vlist">
        {cards.map(({ v, count, summary, orphans }) => (
          <div className="vcard" key={v.id} onClick={() => onOpen(v.id)}>
            <div className="vcard-top">
              <div className="vcard-title">
                <h3>{v.name}</h3>
                <span className="muted small">{v.code || '—'}</span>
                <span className="vcard-step">{fmtPct(Math.round(v.gridStep * 10000))}</span>
              </div>
              <button
                className="icon-btn"
                aria-label="更多操作"
                onClick={(e) => { e.stopPropagation(); setMenuTarget(v); }}
              >
                ⋯
              </button>
            </div>
            <div className="vcard-stats">
              <div className="stat">
                <span className="muted small">基准价</span>
                {v.basePrice === null
                  ? <em className="unset">未设置</em>
                  : <span>{fmtScaled(Math.round(v.basePrice * 10000), 10000, 4)}</span>}
              </div>
              <div className="stat">
                <span className="muted small">合计利润</span>
                {profitEl(summary.totalProfitH8)}
              </div>
              <div className="stat">
                <span className="muted small">持仓</span>
                <span>{fmtScaled(summary.totalRemainingQ4, QTY_SCALE, 4)}</span>
              </div>
            </div>
            {v.basePrice === null && (
              <div className="vcard-guide">
                <span className="muted small">设基准价后启用价格/金额/利润</span>
                <button
                  className="btn btn-mini btn-primary"
                  onClick={(e) => { e.stopPropagation(); onConfig(v.id); }}
                >设置基准价</button>
              </div>
            )}
            <div className="vcard-foot muted small">
              {v.code ? v.code + ' · ' : ''}{count} 档 · 点击进入
              {orphans > 0 ? ` · ${orphans} 条孤儿数据` : ''}
            </div>
          </div>
        ))}
      </div>

      <button className="fab" aria-label="新建品种" onClick={() => setShowCreate(true)}>＋</button>

      {menuTarget && (
        <Sheet title={menuTarget.name} onClose={() => setMenuTarget(null)}>
          <div className="action-list">
            <button className="action-item" onClick={() => { onConfig(menuTarget.id); setMenuTarget(null); }}>
              ⚙️ 配置网格结构
            </button>
            <button
              className="action-item"
              onClick={() => {
                dupName.current = menuTarget.name + ' 副本';
                onDuplicate(menuTarget.id);
                setMenuTarget(null);
                showToast('已复制为「' + dupName.current + '」');
              }}
            >
              ⧉ 复制品种
            </button>
            <button className="action-item danger" onClick={() => { setDeleteTarget(menuTarget); setDeleteInput(''); setMenuTarget(null); }}>
              🗑 删除品种
            </button>
          </div>
        </Sheet>
      )}

      {deleteTarget && (
        <Dialog title="删除品种" onClose={() => setDeleteTarget(null)}>
          <h3>删除品种</h3>
          <p>即将删除 <b>{deleteTarget.name}</b> 的全部网格配置与录入数据，且不可恢复。</p>
          <p className="muted small">输入品种名称以确认：<b>{deleteTarget.name}</b></p>
          <input className="input" value={deleteInput} onChange={(e) => setDeleteInput(e.target.value)} placeholder={deleteTarget.name} />
          <div className="sheet-actions">
            <button className="btn" onClick={() => setDeleteTarget(null)}>取消</button>
            <button className="btn btn-danger" disabled={deleteInput !== deleteTarget.name} onClick={() => { onDelete(deleteTarget.id); setDeleteTarget(null); showToast('已删除'); }}>
              确认删除
            </button>
          </div>
        </Dialog>
      )}

      {showCreate && (
        <CreateSheet
          existingNames={data.varieties.map((v) => v.name)}
          onCancel={() => setShowCreate(false)}
          onSubmit={(form) => { setShowCreate(false); onCreate(form); }}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function CreateSheet({ existingNames, onCancel, onSubmit }: {
  existingNames: string[];
  onCancel: () => void;
  onSubmit: (form: { name: string; code: string; basePrice: number | null; gridStep: number }) => void;
}) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [base, setBase] = useState('');
  const [step, setStep] = useState('2');
  const [errors, setErrors] = useState<string[]>([]);

  const submit = () => {
    const baseNum = base.trim() === '' ? null : Number(base);
    const stepNum = Number(step) / 100;
    const errs = validateVarietyBase({ name, code, basePrice: baseNum, gridStep: stepNum, existingNames });
    if (errs.length > 0) { setErrors(errs); return; }
    onSubmit({ name, code, basePrice: baseNum, gridStep: stepNum });
  };

  return (
    <Sheet title="新建品种" onClose={onCancel}>
      <div className="field-list">
        <label className="field">
          <span>品种名称 *</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="如：创业板ETF" autoFocus />
        </label>
        <label className="field">
          <span>标的代码</span>
          <input className="input" value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" placeholder="如：159915（选填）" />
        </label>
        <label className="field">
          <span>基准价（选填）</span>
          <input className="input" value={base} onChange={(e) => setBase(e.target.value)} inputMode="decimal" placeholder="留空表示暂不设置" />
        </label>
        <label className="field">
          <span>网格步长 % *</span>
          <input className="input" value={step} onChange={(e) => setStep(e.target.value)} inputMode="decimal" />
        </label>
      </div>
      {errors.length > 0 && <ul className="error-list">{errors.map((e, i) => <li key={i}>{e}</li>)}</ul>}
      <p className="muted small">创建后将进入网格配置页设置小/中/大网结构。</p>
      <div className="sheet-actions">
        <button className="btn" onClick={onCancel}>取消</button>
        <button className="btn btn-primary" onClick={submit}>创建</button>
      </div>
    </Sheet>
  );
}
