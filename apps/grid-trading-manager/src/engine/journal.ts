// 录入变更与交易流水（PRD FR-08 P1 / FR-11）
// 纯函数：D/G 累计值是唯一计算真值，流水只做审计追加
//
// FR-11「触发累加」设计要点：
//   数据层不动 —— journal 仍是每档一个累计量，累加 = 读完旧值再加上本次量后覆盖写，
//   仍然走 applyJournalChange。好处是导出/云同步/撤销/全部既有口径零改动，
//   而「每次触发多少」由 ledger 的 op='add' 条目分毫不差地留下来。
//   因此「上次触发量」不需要新增任何持久化字段，从流水反推即可。

import { LedgerEntry, Variety } from './types';

/** 数量统一收纳为 4 位小数（与 storage.sanitizeQty 同口径，避免浮点尾差累积） */
export function roundQty(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 10000) / 10000;
}

/** 累加量/触发量在流水 Map 中的键 */
export function triggerKey(rowId: string, field: 'buyQty' | 'sellQty'): string {
  return rowId + '|' + field;
}

/**
 * 录入某一档的累计数量（绝对值覆盖写）。
 * op='set' 为原有录入路径；op='add' 由 addJournalQty 内部使用。
 */
export function applyJournalChange(
  v: Variety,
  rowId: string,
  field: 'buyQty' | 'sellQty',
  qty: number,
  op: 'add' | 'set' = 'set',
): Variety {
  const cur = v.journal[rowId] ?? { buyQty: 0, sellQty: 0 };
  const from = cur[field];

  const journal = { ...v.journal };
  const next = { ...cur, [field]: qty };
  if (next.buyQty === 0 && next.sellQty === 0) delete journal[rowId];
  else journal[rowId] = next;

  if (from === qty) return { ...v, journal }; // 值未变化，不产生流水

  const entry: LedgerEntry = { ts: Date.now(), rowId, field, from, to: qty, op };
  return { ...v, journal, ledger: [...(v.ledger ?? []), entry] };
}

/**
 * 触发累加（FR-11）：qty_new = qty_old + delta。
 * 语义 =「本档又触发了一次」：网格重复触发时不必再心算 1+1，直接记「这一笔」。
 * delta 必须为正；非法值抛错由调用方兜住（UI 侧已做输入校验）。
 */
export function addJournalQty(
  v: Variety,
  rowId: string,
  field: 'buyQty' | 'sellQty',
  delta: number,
): Variety {
  const d = roundQty(delta);
  if (d <= 0) throw new Error('累加量必须为正数');
  const cur = v.journal[rowId] ?? { buyQty: 0, sellQty: 0 };
  const next = roundQty(cur[field] + d);
  return applyJournalChange(v, rowId, field, next, 'add');
}

/**
 * 推导「每档每字段的上次触发量」（FR-11）——行内「＋」一键累加用的默认值。
 *
 * 规则：按流水时间顺序遍历，遇到 op='add' 或（旧数据的）正向增量就记下，
 * 后来者覆盖先前者，最终每个键留下的是**最近一次真实触发量**。
 * - 跳过 revert 条目（撤销不是触发）
 * - 跳过 op='set'（直接设值不是触发，也不拿它的差值冒充触发量）
 * - 无历史 → Map 中无该键，UI 侧回落到「手输本次量」
 *
 * 兼容 v1.4 及以前的旧数据（无 op 字段）：那时没有「本次触发量」的概念，
 * 只能按「最近一次正向增量」退化推断。**一旦流水里出现过 op 标记，就整体按
 * v1.5 口径处理并关掉这条兜底** —— 否则「直接设值」的差值会被误判成一次大额
 * 触发，等于给脏数据留了注入错误默认量的口子。
 */
export function buildTriggerDeltas(v: Variety): Map<string, number> {
  const ledger = v.ledger ?? [];
  const modern = ledger.some((e) => e.op === 'add' || e.op === 'set');
  const m = new Map<string, number>();
  for (const e of ledger) {
    if (e.revert || e.op === 'set') continue;
    if (e.op !== 'add' && modern) continue; // 新格式下，无 op 的条目不再当作触发
    const d = roundQty(e.to - e.from);
    if (d > 0) m.set(triggerKey(e.rowId, e.field), d);
  }
  return m;
}

/** 某档某字段的触发历史（倒序，含撤销条目，供面板展示） */
export function triggerHistory(
  v: Variety,
  rowId: string,
  field: 'buyQty' | 'sellQty',
  limit = 5,
): LedgerEntry[] {
  const out: LedgerEntry[] = [];
  const ledger = v.ledger ?? [];
  for (let i = ledger.length - 1; i >= 0 && out.length < limit; i--) {
    const e = ledger[i];
    if (e.rowId === rowId && e.field === field) out.push(e);
  }
  return out;
}

export interface RevertResult {
  variety: Variety;
  entry: LedgerEntry | null; // null = 无可撤销项
  reason?: 'empty' | 'stale'; // empty = 无流水；stale = 该行已被后续改动覆盖
}

/**
 * 撤销最近一次录入变更（FR-08 扩展，记账容错）。
 *
 * 审计原则不破：流水**只增不删**——撤销不删除原条目，而是追加一条反向补偿条目（标注 revert）。
 * 安全前提：仅当该行的当前值仍等于最近条目的 to 值时才回退（否则说明其后又改过，
 * 强行回退会得到用户未预期的结果），此时返回 reason='stale' 由 UI 提示。
 *
 * 对 FR-11 累加录入天然适用：回退的是 last.from，与「加/设」语义无关。
 */
export function revertLastChange(v: Variety): RevertResult {
  const ledger = v.ledger ?? [];
  if (ledger.length === 0) return { variety: v, entry: null, reason: 'empty' };

  const last = ledger[ledger.length - 1];
  const cur = v.journal[last.rowId] ?? { buyQty: 0, sellQty: 0 };
  if (cur[last.field] !== last.to) return { variety: v, entry: null, reason: 'stale' };

  const journal = { ...v.journal };
  const next = { ...cur, [last.field]: last.from };
  if (next.buyQty === 0 && next.sellQty === 0) delete journal[last.rowId];
  else journal[last.rowId] = next;

  const entry: LedgerEntry = {
    ts: Date.now(),
    rowId: last.rowId,
    field: last.field,
    from: last.to,
    to: last.from,
    op: 'set',
    revert: true,
  };
  return { variety: { ...v, journal, ledger: [...ledger, entry] }, entry };
}
