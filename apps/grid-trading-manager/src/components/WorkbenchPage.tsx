// 网格工作台页（移动端）：汇总卡 + 网类型分段筛选 + 档位卡列表（渐进式披露）
// P2 扩展：手动输入当前价 → 标注已触发买入档/可卖出档（离线，不参与计算）

import { useEffect, useMemo, useRef, useState } from 'react';
import { NetType, Variety } from '../engine/types';
import { computeSummary, expandRows, RowView } from '../engine/engine';
import { buildTriggerDeltas, roundQty, triggerHistory, triggerKey } from '../engine/journal';
import { fmtMoney, fmtPct, fmtScaled, PRICE_SCALE, QTY_SCALE } from '../engine/money';
import { varietyToCsv, csvFileName } from '../csv';
import { varietyToXlsxBlob, xlsxFileName } from '../xlsx';
import { AddTriggerSheet, fmtQty, QtyChip, Sheet, TriggerSheetData } from './ui';

interface Props {
  variety: Variety;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  onBack: () => void;
  onOpenConfig: () => void;
  onUpdateJournal: (rowId: string, field: 'buyQty' | 'sellQty', qty: number) => void;
  /** FR-11 触发累加：把「本档又触发了一次」记成一笔，累加到 D/G 累计量上 */
  onAddJournal: (rowId: string, field: 'buyQty' | 'sellQty', delta: number) => void;
  /** 撤销上一条录入；返回 ok=已撤销、empty=无流水、stale=该行其后已被改动（不可安全回退） */
  onUndo: () => 'ok' | 'empty' | 'stale';
  onUpdateBasePrice: (bp: number | null) => void;
  onUpdateQuote: (patch: { quoteUrl?: string | null; lastPrice?: number | null; lastPriceAt?: number | null }) => void;
}

type Filter = '全部' | NetType;
const FILTERS: Filter[] = ['全部', '小网', '中网', '大网'];

const RULE_LABEL: Record<RowView['sellRule'], string> = {
  first: '首档：基准价×(1+步长)',
  anchor: '锚点行',
  prev: '上一档买入价',
};

const FIELD_LABEL = { buyQty: '买入数量', sellQty: '卖出数量' } as const;

// ---- FR-09 行情解析工具（模块级，避免每次渲染重建） ----
/** JSON 中优先作为「当前价」的字段名 */
const PRICE_KEYS = ['price', 'last', 'lastPrice', 'lastprice', 'f43', 'current', 'currentPrice', 'now', 'close', 'zkj', 'dwj'];
/** 明确不是价格、必须跳过的字段（否则标的代码 159691 会被误当价格） */
const CODE_KEYS = new Set(['code', 'symbol', 'id', 'fundcode', 'stockcode', 'secid', 'ticker', 'name', 'market']);
const plausiblePrice = (n: number): boolean => Number.isFinite(n) && n > 0 && n < 1e6;

/** 从纯文本中提取价格：兼容新浪/腾讯行情串，其次优先「带小数」的数字 */
function parsePriceText(s: string): number | null {
  const quoted = s.match(/"([^"]+)"/);
  if (quoted) {
    const raw = quoted[1];
    const parts = raw.split(raw.includes('~') ? '~' : ',');
    // 两家行情串的「现价」均在第 4 个字段（索引 3），退化时试 1/2
    for (const i of [3, 1, 2]) {
      const n = Number(parts[i]);
      if (plausiblePrice(n)) return n;
    }
  }
  const nums = s.match(/\d+(?:\.\d+)?/g) ?? [];
  const decimal = nums.find((x) => x.includes('.') && plausiblePrice(Number(x)));
  if (decimal) return Number(decimal);
  const plain = nums.find((x) => plausiblePrice(Number(x)) && !/^\d{6}$/.test(x));
  return plain ? Number(plain) : null;
}

export default function WorkbenchPage({ variety, theme, onToggleTheme, onBack, onOpenConfig, onUpdateJournal, onAddJournal, onUndo, onUpdateBasePrice, onUpdateQuote }: Props) {
  const rows = useMemo(() => expandRows(variety), [variety]);
  const summary = useMemo(() => computeSummary(rows), [rows]);
  const [filter, setFilter] = useState<Filter>('全部');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [bpDraft, setBpDraft] = useState<string | null>(null);
  const [bpInvalid, setBpInvalid] = useState(false);
  const [showLedger, setShowLedger] = useState(false);
  const [showPrice, setShowPrice] = useState(false);
  const [priceDraft, setPriceDraft] = useState(variety.lastPrice != null ? String(variety.lastPrice) : '');
  const [autoQuote, setAutoQuote] = useState(false);
  const [quoteBusy, setQuoteBusy] = useState(false);
  const [toast, setToast] = useState<{ text: string; undo?: boolean } | null>(null);
  /** FR-11：当前打开的「记一笔触发」面板目标 */
  const [addSheet, setAddSheet] = useState<{ rowId: string; field: 'buyQty' | 'sellQty' } | null>(null);
  const toastTimer = useRef<number | null>(null);
  useEffect(() => () => { if (toastTimer.current !== null) window.clearTimeout(toastTimer.current); }, []);
  /** 带撤销入口的提示：累加录入后给 4.2s 反悔窗口，长于普通提示 */
  const showToast = (text: string, opts?: { undo?: boolean; ms?: number }) => {
    setToast({ text, undo: opts?.undo });
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(
      () => { toastTimer.current = null; setToast(null); },
      opts?.ms ?? (opts?.undo ? 4200 : 2400),
    );
  };

  // ---- FR-09 自动行情：稳健解析当前价 ----
  // 兼容三类响应：① JSON（优先 price/last/f43 等字段，并跳过 code/name 等非价格字段）
  //               ② 新浪/腾讯行情文本（"名称,今开,昨收,现价,…" / "1~名称~代码~现价~…"）
  //               ③ 任意含数字的文本（优先带小数者——价格通常是小数，标的代码是 6 位整数）
  const findPrice = (o: unknown, depth = 0): number | null => {
    if (o == null || depth > 8) return null;
    if (typeof o === 'number') return plausiblePrice(o) ? o : null;
    if (typeof o === 'string') return parsePriceText(o);
    if (Array.isArray(o)) {
      for (const it of o) { const p = findPrice(it, depth + 1); if (p != null) return p; }
      return null;
    }
    if (typeof o === 'object') {
      const obj = o as Record<string, unknown>;
      for (const k of PRICE_KEYS) {
        if (k in obj) { const p = findPrice(obj[k], depth + 1); if (p != null) return p; }
      }
      for (const k of Object.keys(obj)) {
        if (CODE_KEYS.has(k.toLowerCase())) continue;
        const p = findPrice(obj[k], depth + 1);
        if (p != null) return p;
      }
    }
    return null;
  };

  const refreshQuote = async () => {
    const url = (variety.quoteUrl ?? '').trim();
    if (!url) { showToast('未配置行情源 URL'); return; }
    setQuoteBusy(true);
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      let price: number | null = null;
      try { price = findPrice(JSON.parse(text)); } catch { price = findPrice(text); }
      if (price == null) {
        throw new Error('未识别出价格（返回片段：' + text.slice(0, 48).replace(/\s+/g, ' ') + '…）');
      }
      const at = Date.now();
      onUpdateQuote({ lastPrice: price, lastPriceAt: at });
      setPriceDraft(String(price));
      showToast('行情已更新 ¥' + price);
    } catch (e) {
      showToast('行情获取失败：' + (e instanceof Error ? e.message : '未知错误') + '（可能受 CORS 限制）');
    } finally {
      setQuoteBusy(false);
    }
  };

  // 轮询开关：开启后每 30s 刷新一次
  useEffect(() => {
    if (!autoQuote) return;
    const t = setInterval(() => { void refreshQuote(); }, 30000);
    return () => clearInterval(t);
  }, [autoQuote]); // eslint-disable-line react-hooks/exhaustive-deps

  const downloadCsv = () => {
    const blob = new Blob([varietyToCsv(variety)], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = csvFileName(variety);
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    showToast('已导出 CSV');
  };

  const downloadXlsx = () => {
    const blob = varietyToXlsxBlob(variety);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = xlsxFileName(variety);
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    showToast('已导出 XLSX');
  };

  const ledger = variety.ledger ?? [];
  const rowMap = useMemo(() => new Map(rows.map((r) => [r.rowId, r])), [rows]);

  // ---- FR-11 触发累加 ----
  // 「每档每字段的上次触发量」一次遍历算好（161 档 × 逐行扫流水会白跑 O(n·m)），
  // 作为行内「＋」的默认累加量；没有历史的档不进 Map，点「＋」改为要求手输。
  const quickAddMap = useMemo(() => buildTriggerDeltas(variety), [variety]);

  /** 行内「＋」一键累加：直接按上次触发量记一笔，并给出可撤销提示 */
  const doQuickAdd = (rowId: string, field: 'buyQty' | 'sellQty', delta: number) => {
    const cur = variety.journal[rowId]?.[field] ?? 0;
    const r = rowMap.get(rowId);
    const where = r ? `第 ${r.netIndex + 1} 网 ${fmtPct(r.levelBp)} ${field === 'buyQty' ? '买入' : '卖出'}` : rowId;
    onAddJournal(rowId, field, delta);
    showToast(`${where} ＋${fmtQty(delta)} → 累计 ${fmtQty(roundQty(cur + delta))}`, { undo: true });
  };

  /** 「记一笔触发」面板的数据包（面板只负责表达，不碰数据） */
  const addTarget = useMemo((): TriggerSheetData | null => {
    if (!addSheet) return null;
    const r = rowMap.get(addSheet.rowId);
    if (!r) return null;
    const isBuy = addSheet.field === 'buyQty';
    const price = fmtScaled(isBuy ? r.buyU4 : r.sellU4, PRICE_SCALE, 4);
    return {
      unitLabel: isBuy ? '买入' : '卖出',
      subtitle: `第 ${r.netIndex + 1} 网 · ${r.netType} · 档位 ${fmtPct(r.levelBp)} · ${isBuy ? '买价' : '卖价'} ${price ?? '—'}`,
      current: variety.journal[addSheet.rowId]?.[addSheet.field] ?? 0,
      defaultDelta: quickAddMap.get(triggerKey(addSheet.rowId, addSheet.field)) ?? null,
      history: triggerHistory(variety, addSheet.rowId, addSheet.field, 5),
    };
  }, [addSheet, rowMap, variety, quickAddMap]);

  /** 撤销上一条录入（FR-08 扩展）：流水只增不删，撤销 = 追加一条反向补偿条目 */
  const doUndo = () => {
    const r = onUndo();
    if (r === 'ok') showToast('已撤销上一条录入');
    else if (r === 'stale') showToast('无法撤销：该行其后已被改动');
    else showToast('暂无可撤销的录入');
  };

  // ---- P2 当前价标注（纯展示） ----
  const curPriceU4 = useMemo(() => {
    const t = priceDraft.trim();
    if (!/^\d+(\.\d{1,4})?$/.test(t) || Number(t) <= 0) return null;
    return Math.round(Number(t) * PRICE_SCALE);
  }, [priceDraft]);
  const hitBuyCount = curPriceU4 === null ? 0 : rows.filter((r) => r.buyU4 !== null && r.buyU4 >= curPriceU4).length;
  const hitSellCount = curPriceU4 === null ? 0 : rows.filter((r) => r.sellU4 !== null && r.sellU4 <= curPriceU4).length;

  const baseDisplay = variety.basePrice === null ? '' : (fmtScaled(Math.round(variety.basePrice * PRICE_SCALE), PRICE_SCALE, 4) ?? '');

  const commitBase = () => {
    if (bpDraft === null) return;
    const t = bpDraft.trim();
    setBpDraft(null);
    if (t === '') { onUpdateBasePrice(null); return; }
    if (!/^\d+(\.\d{1,4})?$/.test(t) || Number(t) <= 0) {
      setBpInvalid(true);
      setTimeout(() => setBpInvalid(false), 700);
      return;
    }
    onUpdateBasePrice(Number(t));
  };

  const toggleRow = (rowId: string) => {
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      return next;
    });
  };

  // 按网分组（应用筛选）
  const groups = useMemo(() => {
    const visible = rows.filter((r) => filter === '全部' || r.netType === filter);
    const gs: { netIndex: number; netType: NetType; rows: RowView[] }[] = [];
    for (const r of visible) {
      const last = gs[gs.length - 1];
      if (last && last.netIndex === r.netIndex) last.rows.push(r);
      else gs.push({ netIndex: r.netIndex, netType: r.netType, rows: [r] });
    }
    return gs;
  }, [rows, filter]);

  const profitCls = (p: bigint | null) => (p === null || p === 0n ? '' : p > 0n ? 'up' : 'down');
  const rate = summary.profitRate === null ? null : (summary.profitRate * 100).toFixed(2) + '%';

  return (
    <div className="phone stack-page">
      {/* 导航栏 */}
      <header className="navbar">
        <button className="icon-btn" aria-label="返回" onClick={onBack}>‹</button>
        <div className="navbar-title">
          <h2>{variety.name}</h2>
          <span className="muted small">{variety.code} · 步长 {fmtPct(Math.round(variety.gridStep * 10000))}</span>
        </div>
        <button className="icon-btn" aria-label="切换浅色/深色" onClick={onToggleTheme}>{theme === 'dark' ? '☀️' : '🌙'}</button>
        <button className="btn btn-mini" onClick={downloadCsv}>⬇️ CSV</button>
        <button className="btn btn-mini" onClick={downloadXlsx}>⬇️ XLSX</button>
        <button className="btn btn-mini" onClick={onOpenConfig}>⚙️ 配置</button>
      </header>

      {/* 汇总卡（吸顶） */}
      <div className="sticky-area">
        <div className="summary-card">
          <div className="summary-main">
            <div>
              <span className="muted small">合计利润</span>
              <div className={'summary-big ' + profitCls(summary.totalProfitH8)}>
                {summary.totalProfitH8 === null ? '—' : '¥' + fmtMoney(summary.totalProfitH8)}
              </div>
            </div>
            <div className="bp-box">
              <span className="muted small">基准价</span>
              <input
                className={'bp-input' + (bpInvalid ? ' invalid' : '')}
                value={bpDraft ?? baseDisplay}
                placeholder="未设置"
                inputMode="decimal"
                onChange={(e) => setBpDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') commitBase(); else if (e.key === 'Escape') setBpDraft(null); }}
                onBlur={commitBase}
              />
            </div>
          </div>
          <div className="chips">
            <span className="chip">总买入 <i className="derived">衍生</i> {summary.totalBuyH8 === null ? '—' : '¥' + fmtMoney(summary.totalBuyH8)}</span>
            <span className="chip">总卖出 <i className="derived">衍生</i> {summary.totalSellH8 === null ? '—' : '¥' + fmtMoney(summary.totalSellH8)}</span>
            <span className="chip">持仓 {fmtScaled(summary.totalRemainingQ4, QTY_SCALE, 4)}</span>
            <span className="chip">收益率 <i className="derived">衍生</i> {rate ?? '—'}</span>
            <span className="chip net-chip-小网">小网 {summary.profitByType.小网 === null ? '—' : '¥' + fmtMoney(summary.profitByType.小网)}</span>
            <span className="chip net-chip-中网">中网 {summary.profitByType.中网 === null ? '—' : '¥' + fmtMoney(summary.profitByType.中网)}</span>
            <span className="chip net-chip-大网">大网 {summary.profitByType.大网 === null ? '—' : '¥' + fmtMoney(summary.profitByType.大网)}</span>
            <button className="chip chip-btn" onClick={() => setShowLedger(true)}>📜 流水 {ledger.length}</button>
            {variety.quoteUrl ? (
              <>
                <button className="chip chip-btn" onClick={() => void refreshQuote()} disabled={quoteBusy}>
                  {quoteBusy ? '🔄 刷新中…' : '🔄 行情'}
                </button>
                <button
                  className={'chip chip-btn' + (autoQuote ? ' on' : '')}
                  onClick={() => setAutoQuote((a) => !a)}
                  title="开启后每 30 秒自动刷新行情"
                >{autoQuote ? '⏱ 自动' : '⏱ 手动'}</button>
              </>
            ) : null}
            {curPriceU4 === null ? (
              <button className="chip chip-btn" onClick={() => setShowPrice(true)}>📍 当前价</button>
            ) : (
              <button
                className="chip chip-btn"
                title="点击修改，长按无效；点 ✕ 清除"
                onClick={() => setShowPrice(true)}
              >
                📍 当前价 {fmtScaled(curPriceU4, PRICE_SCALE, 4)}
                <span
                  role="button"
                  aria-label="清除当前价"
                  style={{ marginLeft: 4, color: 'var(--muted)' }}
                  onClick={(e) => { e.stopPropagation(); setPriceDraft(''); }}
                >✕</span>
              </button>
            )}
          </div>
          {curPriceU4 !== null && (
            <div className="muted small" style={{ marginTop: 8 }}>
              当前价标注（扩展，不参与计算）：已触发买入 <b className="up">{hitBuyCount}</b> 档 · 可卖出 <b className="down">{hitSellCount}</b> 档
              {variety.lastPriceAt ? ` · 行情于 ${new Date(variety.lastPriceAt).toLocaleTimeString('zh-CN', { hour12: false })}` : ''}
            </div>
          )}
        </div>

        {/* 网类型分段筛选 */}
        <div className="seg" role="tablist">
          {FILTERS.map((f) => (
            <button key={f} className={'seg-item' + (filter === f ? ' active' : '')} onClick={() => setFilter(f)}>{f}</button>
          ))}
        </div>
      </div>

      {variety.basePrice === null && (
        <div className="banner">
          基准价未设置（源表 C2）：在上方输入基准价后开始计算价格、金额与利润；数量录入不受影响。
        </div>
      )}

      {/* 档位卡列表 */}
      <div className="page">
        {groups.map((g) => (
          <section key={g.netIndex}>
            <div className={'group-head net-head-' + g.netType}>
              <b>第 {g.netIndex + 1} 网 · {g.netType}</b>
              <span className="muted small">{g.rows.length} 档</span>
            </div>
            {g.rows.map((r) => {
              const isOpen = expanded.has(r.rowId);
              return (
                <div className={'row-item' + (isOpen ? ' open' : '') + (r.oversell ? ' oversell' : '')} key={r.rowId}>
                  <div className="row-head" onClick={() => toggleRow(r.rowId)}>
                    <span className={'net-pill net-' + r.netType}>{r.netType}</span>
                    <span className="level">
                      {fmtPct(r.levelBp)}
                      {r.sellRule === 'anchor' && (
                        <span className="anchor-mark" title={`锚点：卖出价回到 ${fmtPct(r.anchorBp!)} 档买入价`}>⚓</span>
                      )}
                    </span>
                    <span className="row-profit">
                      <span className={'num ' + profitCls(r.profitH8)}>{fmtMoney(r.profitH8) ?? '—'}</span>
                      {r.oversell && <span className="warn-mark" title="卖出数量超过买入数量（软警告）">⚠</span>}
                      {r.priceInvalid && (
                        <span className="invalid-mark" title="档位 ≥ 100%：买入价 ≤ 0（源表未定义此情形，请到配置页缩小结束档数或步长）">⛔</span>
                      )}
                      <span className="chev">{isOpen ? '⌃' : '⌄'}</span>
                    </span>
                  </div>
                  <div className="row-qty">
                    <div className="q q-buy">
                      <span className="muted small">买</span>
                      <b className="p-buy">{fmtScaled(r.buyU4, PRICE_SCALE, 4) ?? '—'}</b>
                      <QtyChip
                        q4={r.buyQtyQ4}
                        tone="buy"
                        pending={curPriceU4 !== null && r.buyU4 !== null && r.buyU4 >= curPriceU4}
                        quickAdd={quickAddMap.get(triggerKey(r.rowId, 'buyQty')) ?? null}
                        onAdd={(d) => doQuickAdd(r.rowId, 'buyQty', d)}
                        onOpenAddSheet={() => setAddSheet({ rowId: r.rowId, field: 'buyQty' })}
                        onCommit={(q) => onUpdateJournal(r.rowId, 'buyQty', q)}
                      />
                    </div>
                    <div className="q q-sell">
                      <span className="muted small">卖</span>
                      <b className="p-sell">{fmtScaled(r.sellU4, PRICE_SCALE, 4) ?? '—'}</b>
                      <QtyChip
                        q4={r.sellQtyQ4}
                        tone="sell"
                        pending={curPriceU4 !== null && r.sellU4 !== null && r.sellU4 <= curPriceU4}
                        quickAdd={quickAddMap.get(triggerKey(r.rowId, 'sellQty')) ?? null}
                        onAdd={(d) => doQuickAdd(r.rowId, 'sellQty', d)}
                        onOpenAddSheet={() => setAddSheet({ rowId: r.rowId, field: 'sellQty' })}
                        onCommit={(q) => onUpdateJournal(r.rowId, 'sellQty', q)}
                      />
                    </div>
                  </div>
                  {isOpen && (
                    <div className="row-detail">
                      <div><span className="muted small">买入金额</span><b>{fmtMoney(r.buyAmountH8) ?? '—'}</b></div>
                      <div><span className="muted small">卖出金额</span><b>{fmtMoney(r.sellAmountH8) ?? '—'}</b></div>
                      <div><span className="muted small">剩余数量</span><b className={r.oversell ? 'down' : ''}>{fmtScaled(r.remainingQ4, QTY_SCALE, 4)}</b></div>
                      <div>
                        <span className="muted small">卖出规则</span>
                        <b className="muted">{r.sellRule === 'anchor' ? `${RULE_LABEL[r.sellRule]}：${fmtPct(r.anchorBp!)} 档` : RULE_LABEL[r.sellRule]}</b>
                      </div>
                      {curPriceU4 !== null && (
                        <div>
                          <span className="muted small">当前价标注</span>
                          <b className="muted">
                            {[
                              r.buyU4 !== null && r.buyU4 >= curPriceU4 ? '买入已触发' : null,
                              r.sellU4 !== null && r.sellU4 <= curPriceU4 ? '可卖出' : null,
                            ].filter(Boolean).join(' · ') || '未触发'}
                          </b>
                        </div>
                      )}
                      {(() => {
                        const d = quickAddMap.get(triggerKey(r.rowId, 'buyQty'));
                        return d != null ? (
                          <div><span className="muted small">上次触发量</span><b className="muted">买 {fmtQty(d)}</b></div>
                        ) : null;
                      })()}
                    </div>
                  )}
                </div>
              );
            })}
          </section>
        ))}
        <p className="muted small footnote">
          ⚓ = 锚点行 · 点击档位行展开金额明细 · 颜色遵循 A 股习惯（盈利红 / 亏损绿）<br />
          「＋」= 本档再次触发时一键累加（长按可填本次量）· 琥珀色「＋」= 当前价已触发/可卖出，待记账
        </p>
      </div>

      {/* FR-11 「记一笔触发」：把「本次量」与「累计量」分开表达，重复触发不必再心算 */}
      {addTarget && (
        <AddTriggerSheet
          data={addTarget}
          onClose={() => setAddSheet(null)}
          onConfirm={(value, mode) => {
            const { rowId, field } = addSheet!;
            if (mode === 'add') doQuickAdd(rowId, field, roundQty(value - addTarget.current));
            else {
              onUpdateJournal(rowId, field, value);
              showToast(`${addTarget.unitLabel}累计已设为 ${fmtQty(value)}`);
            }
            setAddSheet(null);
          }}
        />
      )}

      {/* 交易流水（FR-08 P1）：审计记录，只增不删，不参与计算 */}
      {showLedger && (
        <Sheet title={`交易流水（${ledger.length} 条）`} onClose={() => setShowLedger(false)}>
          {ledger.length === 0 ? (
            <p className="muted small">暂无流水。在档位卡中录入/修改买卖数量后会自动记录。</p>
          ) : (
            <>
              <div className="ledger-tools">
                <button className="btn btn-mini" onClick={doUndo}>↶ 撤销上一条</button>
                <span className="muted small">撤销不删历史，只追加一条反向记录</span>
              </div>
              <div className="ledger-list">
                {[...ledger].reverse().slice(0, 300).map((e, i) => {
                  const r = rowMap.get(e.rowId);
                  return (
                    <div className={'ledger-item' + (e.revert ? ' revert' : '')} key={ledger.length - 1 - i}>
                      <span className="ledger-time">{new Date(e.ts).toLocaleString('zh-CN', { hour12: false })}</span>
                      <span className="muted small">
                        {r ? `第 ${e.rowId.split(':')[0] + 1} 网 · ${fmtPct(r.levelBp)}` : e.rowId}
                      </span>
                      <span className={'ledger-field f-' + (e.field === 'buyQty' ? 'buy' : 'sell')}>
                        {e.revert ? '↶ ' : ''}{FIELD_LABEL[e.field]}
                      </span>
                      <span className="num">
                        {fmtScaled(Math.round(e.from * QTY_SCALE), QTY_SCALE, 4)} → {fmtScaled(Math.round(e.to * QTY_SCALE), QTY_SCALE, 4)}
                      </span>
                    </div>
                  );
                })}
                {ledger.length > 300 && <p className="muted small">仅显示最近 300 条（完整记录保存在数据中）。</p>}
              </div>
            </>
          )}
        </Sheet>
      )}

      {/* 当前价标注（P2 扩展，离线手动输入） */}
      {showPrice && (
        <Sheet title="当前价标注" onClose={() => setShowPrice(false)}>
          <p className="muted small">手动输入标的当前价，用于标注：买入价 ≥ 当前价 的档 =「已触发」；卖出价 ≤ 当前价 的档 =「可卖出」。仅作展示，不参与计算。被标注的档，其数量右侧「＋」会转为琥珀色，提示「这里待记账」；具体标注文字见行内展开明细。若已在配置页填写「行情源 URL」，可点汇总卡上的「🔄 行情」一键获取当前价。</p>
          <input
            className="input"
            value={priceDraft}
            inputMode="decimal"
            placeholder="输入当前价，留空清除标注"
            onChange={(e) => setPriceDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') setShowPrice(false); }}
            autoFocus
          />
          <div className="sheet-actions">
            <button className="btn" onClick={() => { setPriceDraft(''); setShowPrice(false); }}>清除标注</button>
            <button className="btn btn-primary" onClick={() => setShowPrice(false)}>确定</button>
          </div>
        </Sheet>
      )}

      {toast && (
        <div className="toast">
          {toast.undo ? (
            <span className="toast-row">
              <span>{toast.text}</span>
              <button
                className="link-btn"
                onClick={() => { doUndo(); setToast(null); }}
              >撤销</button>
            </span>
          ) : toast.text}
        </div>
      )}
    </div>
  );
}
