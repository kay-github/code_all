// 移动端通用组件：底部弹层（Sheet）、数量 Chip、ActionSheet

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { fmtScaled, QTY_SCALE } from '../engine/money';
import { LedgerEntry } from '../engine/types';
import { roundQty } from '../engine/journal';

/** 底部弹层（iOS Action Sheet 风格） */
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="sheet-grabber" />
        <div className="sheet-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">✕</button>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}

/** 居中确认弹窗（危险操作用） */
export function Dialog({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title}>{children}</div>
    </div>
  );
}

/** 数量（4 位小数）→ 显示串 */
export function fmtQty(n: number): string {
  return fmtScaled(Math.round(n * QTY_SCALE), QTY_SCALE, 4) ?? '0';
}

/** 长按「＋」的触发阈值（毫秒）；超过则视为「要填自定义量」而非「一键累加」 */
const LONG_PRESS_MS = 450;
/** 长按期间允许的指针漂移（像素），超出即认定用户在滚动列表，取消长按 */
const LONG_PRESS_SLOP = 8;

/**
 * 数量 Chip（移动端行内录入，PRD FR-04）：
 * 点击 Chip 变输入框（inputMode=decimal 呼起数字键盘）→
 * 确认按钮/Enter 提交，Esc 取消；非法输入红框还原（BR-08）。
 *
 * FR-11「触发累加」扩展：Chip 右侧挂一个「＋」。
 * - 已有该档上次触发量 → 点「＋」直接累加（不必心算 1+1），长按改为手输本次量
 * - 尚无触发历史     → 点「＋」直接打开「记一笔触发」面板要求手输
 * - pending（该档被当前价标注为已触发）→ 「＋」转琥珀色，主动提示「这里该记账了」
 */
export function QtyChip({
  q4, onCommit, tone,
  quickAdd = null, pending = false, onAdd, onOpenAddSheet,
}: {
  q4: number;
  onCommit: (qty: number) => void;
  tone?: 'buy' | 'sell';
  /** 默认累加量（该档最近一次触发量）；null = 无历史，点「＋」改为打开面板手输 */
  quickAdd?: number | null;
  /** 该档处于「已触发」状态 → 「＋」高亮为待录入 */
  pending?: boolean;
  /** 执行累加 */
  onAdd?: (delta: number) => void;
  /** 打开「记一笔触发」面板（长按「＋」，或无默认量时点击） */
  onOpenAddSheet?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [invalid, setInvalid] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const pressTimer = useRef<number | null>(null);
  const pressFrom = useRef<{ x: number; y: number } | null>(null);
  const longFired = useRef(false);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  // 组件卸载时清掉未决的长按定时器，避免在已卸载组件上回调
  useEffect(() => () => {
    if (pressTimer.current !== null) window.clearTimeout(pressTimer.current);
  }, []);

  const clearTimer = () => {
    if (pressTimer.current !== null) {
      window.clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  };

  /** 结束一次按压：清定时器 + 清起点（起点清空后 pointermove 不再判定漂移） */
  const endPress = () => {
    clearTimer();
    pressFrom.current = null;
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (!onOpenAddSheet) return;
    longFired.current = false;           // 每次按下都重置，避免上一次长按吞掉这一次点击
    clearTimer();
    pressFrom.current = { x: e.clientX, y: e.clientY };
    pressTimer.current = window.setTimeout(() => {
      pressTimer.current = null;
      longFired.current = true;
      onOpenAddSheet();
    }, LONG_PRESS_MS);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const from = pressFrom.current;
    if (!from) return;
    if (Math.abs(e.clientX - from.x) > LONG_PRESS_SLOP || Math.abs(e.clientY - from.y) > LONG_PRESS_SLOP) endPress();
  };

  const handleAdd = () => {
    if (longFired.current) { longFired.current = false; return; } // 长按已处理，吞掉后续 click
    if (quickAdd != null && onAdd) onAdd(quickAdd);
    else onOpenAddSheet?.();
  };

  const display = q4 === 0 ? '' : fmtScaled(q4, QTY_SCALE, 4);

  const tryCommit = () => {
    const t = draft.trim();
    if (t === '') { onCommit(0); setEditing(false); return; }
    if (!/^\d+(\.\d{1,4})?$/.test(t)) {
      setInvalid(true);
      setTimeout(() => setInvalid(false), 700);
      return;
    }
    onCommit(Number(t));
    setEditing(false);
  };

  if (!editing) {
    return (
      <span className="qty-wrap">
        <button
          className={'qty-chip' + (tone ? ' qty-' + tone : '') + (invalid ? ' invalid' : '')}
          onClick={() => { setDraft(display ?? ''); setEditing(true); }}
          title="直接设置累计数量"
        >
          {display || '＋ 录入'}
        </button>
        {(onAdd || onOpenAddSheet) ? (
          <button
            type="button"
            className={'qty-add' + (tone ? ' qty-add-' + tone : '') + (pending ? ' pending' : '')}
            aria-label={quickAdd != null ? `累加 ${fmtQty(quickAdd)}` : '录入本次触发量'}
            title={
              quickAdd != null
                ? `再次触发？一键累加 ${fmtQty(quickAdd)}（长按可填自定义量）`
                : '再次触发？点击录入本次触发量'
            }
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endPress}
            onPointerLeave={endPress}
            onPointerCancel={endPress}
            onContextMenu={(e) => e.preventDefault()}
            onClick={handleAdd}
          >＋</button>
        ) : null}
      </span>
    );
  }
  return (
    <span className={'qty-edit' + (invalid ? ' invalid' : '')}>
      <input
        ref={inputRef}
        className="qty-input"
        value={draft}
        inputMode="decimal"
        placeholder="0"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') tryCommit();
          else if (e.key === 'Escape') setEditing(false);
        }}
        onBlur={tryCommit}
        autoFocus
      />
      <button className="qty-ok" onClick={tryCommit}>✓</button>
    </span>
  );
}

/** 「记一笔触发」面板：本次量与累计量分开表达，避免重复触发时反复心算 */
export interface TriggerSheetData {
  /** 标题前缀，如「买入」「卖出」 */
  unitLabel: string;
  /** 上下文：第 N 网 · 档位 X% · 买价 Y */
  subtitle: string;
  /** 当前累计量 */
  current: number;
  /** 上次触发量（null = 无历史） */
  defaultDelta: number | null;
  /** 该档该字段的触发历史（倒序） */
  history: LedgerEntry[];
}

const ADD_PRESETS = [1, 2, 5, 10];
const VALID_QTY = /^\d+(\.\d{1,4})?$/;

export function AddTriggerSheet({
  data, onConfirm, onClose,
}: {
  data: TriggerSheetData;
  onConfirm: (value: number, mode: 'add' | 'set') => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<'add' | 'set'>('add');
  const [draft, setDraft] = useState(() => (data.defaultDelta != null ? fmtQty(data.defaultDelta) : ''));
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const trimmed = draft.trim();
  const ok = VALID_QTY.test(trimmed);
  const inputQty = ok ? Number(trimmed) : 0;
  const valid = ok && (mode === 'set' || inputQty > 0);
  const result = !valid ? null : mode === 'add' ? roundQty(data.current + inputQty) : roundQty(inputQty);

  const bump = (d: number) => {
    setDraft(fmtQty(roundQty((VALID_QTY.test(draft.trim()) ? Number(draft) : 0) + d)));
  };

  const switchMode = (m: 'add' | 'set') => {
    if (m === mode) return;
    setMode(m);
    setDraft(m === 'add' ? (data.defaultDelta != null ? fmtQty(data.defaultDelta) : '') : (data.current > 0 ? fmtQty(data.current) : ''));
  };

  return (
    <Sheet title={`记一笔${data.unitLabel}触发`} onClose={onClose}>
      <p className="muted small trigger-sub">{data.subtitle}</p>

      <div className="trigger-cards">
        <div className="trigger-card">
          <span className="k">当前累计</span>
          <div className="v">{fmtQty(data.current)}</div>
        </div>
        <div className="trigger-card">
          <span className="k">{mode === 'add' ? '累加后' : '设为'}</span>
          <div className={'v ' + (result === null ? 'muted' : '')}>{result === null ? '—' : fmtQty(result)}</div>
        </div>
      </div>

      <p className="muted small trigger-label">
        {mode === 'add' ? `本次${data.unitLabel}数量` : `直接设为（累计${data.unitLabel}数量）`}
      </p>
      <input
        ref={inputRef}
        className={'input' + (trimmed !== '' && !ok ? ' invalid' : '')}
        value={draft}
        inputMode="decimal"
        placeholder="0"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && valid) onConfirm(result!, mode); }}
      />

      {mode === 'add' && (
        <div className="trigger-quick">
          {data.defaultDelta != null && (
            <button
              className={'btn btn-mini' + (draft === fmtQty(data.defaultDelta) ? ' on' : '')}
              onClick={() => setDraft(fmtQty(data.defaultDelta!))}
            >上次 {fmtQty(data.defaultDelta)}</button>
          )}
          {ADD_PRESETS.map((d) => (
            <button key={d} className="btn btn-mini" onClick={() => bump(d)}>＋{d}</button>
          ))}
          <button className="btn btn-mini" onClick={() => bump(0.5)}>＋0.5</button>
        </div>
      )}

      <p className="muted small trigger-label">该档最近记录</p>
      {data.history.length === 0 ? (
        <p className="muted small">暂无记录。这是本档第一次录入。</p>
      ) : (
        <div className="trigger-hist">
          {data.history.map((e, i) => (
            <div className={'trigger-hist-row' + (e.revert ? ' revert' : '')} key={data.history.length - 1 - i}>
              <span className="ledger-time">{new Date(e.ts).toLocaleString('zh-CN', { hour12: false })}</span>
              <span className="muted small">{e.revert ? '↶ 撤销' : e.op === 'add' ? '触发累加' : '直接设值'}</span>
              <span className="num">
                {e.revert ? `${fmtQty(e.from)} → ${fmtQty(e.to)}` : e.op === 'add' ? `＋${fmtQty(e.to - e.from)}` : `设为 ${fmtQty(e.to)}`}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="trigger-mode">
        {mode === 'add' ? (
          <button className="link-btn" onClick={() => switchMode('set')}>改成直接设值</button>
        ) : (
          <button className="link-btn" onClick={() => switchMode('add')}>改回累加录入</button>
        )}
      </div>

      <div className="sheet-actions">
        <button className="btn" onClick={onClose}>取消</button>
        <button
          className="btn btn-primary"
          disabled={!valid}
          onClick={() => valid && onConfirm(result!, mode)}
        >
          {result === null ? '确认' : mode === 'add' ? `确认累加 → ${fmtQty(result)}` : `确认设为 ${fmtQty(result)}`}
        </button>
      </div>
    </Sheet>
  );
}

export function useDownload() {
  return (content: string, filename: string) => {
    const blob = new Blob([content], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
}
