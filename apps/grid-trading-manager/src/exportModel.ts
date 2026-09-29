// 导出层共享模型（单一真源，DRY）
//
// 背景：v1.2 中 csv.ts 与 xlsx.ts 各自维护表头与列映射，存在「同一份数据两套列定义」的漂移风险，
// 而 PRD FR-06 明确要求二者列结构一致。本模块把「行 → 单元格数组」的映射收敛到一处：
//   - csv.ts / xlsx.ts 只负责把 Cell[] 序列化成各自格式；
//   - 新增列、调整含义只需改这里，两个导出器自动同步。
//
// 数字列：xlsx 写真实数值（Excel 可运算）并按 NumFmt 套数字格式；csv 写纯文本数值（不带千分位，
// 便于 Excel 直接识别为数字）。空值一律输出空白单元格（两格式一致；UI 层仍显示「—」）。

import { Variety } from './engine/types';
import { computePortfolio, computeSummary, expandRows, RowView } from './engine/engine';
import { PRICE_SCALE, QTY_SCALE } from './engine/money';

/** 单品种工作表的列（与源表格 A–J 对齐） */
export const EXPORT_HEADERS = [
  '类型', '档位', '买入价格', '买入数量', '买入金额',
  '卖出价格', '卖出数量', '卖出金额', '利润金额', '剩余数量',
] as const;

/** 组合汇总工作表的列 */
export const PORTFOLIO_HEADERS = [
  '品种', '代码', '步长', '基准价', '合计利润',
  '总买入金额', '总卖出金额', '剩余持仓', '已实现收益率', '网数', '档数',
] as const;

/** 数字列的显示口径：qty = 最多 4 位小数去尾零；money = 两位小数分位 */
export type NumFmt = 'qty' | 'money';

export type Cell =
  | { kind: 's'; v: string }
  | { kind: 'n'; v: number; fmt: NumFmt }
  | null;

// ---- 单元格构造器 ----
export const strCell = (v: string): Cell => ({ kind: 's', v });
export const numCell = (v: number | null, fmt: NumFmt = 'qty'): Cell =>
  v == null || !Number.isFinite(v) ? null : { kind: 'n', v, fmt };
/** 档位（基点 → 百分数文本，如 200 → "2%"） */
export const pctCell = (bp: number): Cell => ({ kind: 's', v: fmtBp(bp) });
/** 定点价格/数量（U4/Q4 整数 → 数值） */
export const scaledCell = (scaled: number | null, fmt: NumFmt = 'qty'): Cell =>
  scaled == null ? null : { kind: 'n', v: round(scaled / PRICE_SCALE, 4), fmt };
/** 金额/利润（H8 BigInt → 数值，2 位） */
export const moneyCell = (h8: bigint | null): Cell =>
  h8 == null ? null : { kind: 'n', v: round(Number(h8) / 1e8, 2), fmt: 'money' };

function round(v: number, dp: number): number {
  return Number(v.toFixed(dp));
}

/** 基点 → 百分数文本（去尾零） */
export function fmtBp(bp: number): string {
  const s = (bp / 100).toFixed(2);
  return (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s) + '%';
}

// ---- 行 → 单元格 ----
export function rowToCells(r: RowView): Cell[] {
  return [
    strCell(r.netType),
    pctCell(r.levelBp),
    scaledCell(r.buyU4),
    numCell(r.buyQtyQ4 / QTY_SCALE, 'qty'),
    moneyCell(r.buyAmountH8),
    scaledCell(r.sellU4),
    numCell(r.sellQtyQ4 / QTY_SCALE, 'qty'),
    moneyCell(r.sellAmountH8),
    moneyCell(r.profitH8),
    numCell(r.remainingQ4 / QTY_SCALE, 'qty'),
  ];
}

/** 合计行（合计利润置于「利润金额」列，对应源表 K2） */
export function totalRowCells(totalProfitH8: bigint | null): Cell[] {
  const cells: Cell[] = new Array(EXPORT_HEADERS.length).fill(null);
  cells[0] = strCell('合计利润');
  cells[8] = moneyCell(totalProfitH8);
  return cells;
}

// ---- 工作表模型 ----
export interface Sheet {
  name: string;
  rows: Cell[][];
}

/** 单品种工作表：表头 + 全部档位行 + 合计利润行 */
export function sheetForVariety(v: Variety): Sheet {
  const rows = expandRows(v);
  const sum = computeSummary(rows);
  return {
    name: v.name || 'Sheet1',
    rows: [EXPORT_HEADERS.map((h) => strCell(h)), ...rows.map(rowToCells), totalRowCells(sum.totalProfitH8)],
  };
}

/** 组合汇总工作表：每品种一行 + 末行合计 */
export function portfolioSheet(varieties: Variety[]): Sheet {
  const head = PORTFOLIO_HEADERS.map((h) => strCell(h));
  const body: Cell[][] = [];
  let totalProfit = 0n;
  let totalBuy = 0n;
  let totalSell = 0n;
  let totalRemaining = 0;
  let anyBase = false;

  for (const v of varieties) {
    const rows = expandRows(v);
    const s = computeSummary(rows);
    if (rows.length > 0 && rows[0].buyU4 !== null) {
      anyBase = true;
      totalProfit += s.totalProfitH8 ?? 0n;
      totalBuy += s.totalBuyH8 ?? 0n;
      totalSell += s.totalSellH8 ?? 0n;
    }
    totalRemaining += s.totalRemainingQ4;
    body.push([
      strCell(v.name),
      strCell(v.code || ''),
      pctCell(Math.round(v.gridStep * 10000)),
      numCell(v.basePrice, 'qty'),
      moneyCell(s.totalProfitH8),
      moneyCell(s.totalBuyH8),
      moneyCell(s.totalSellH8),
      numCell(s.totalRemainingQ4 / QTY_SCALE, 'qty'),
      s.profitRate == null ? strCell('—') : strCell((s.profitRate * 100).toFixed(2) + '%'),
      numCell(v.nets.length, 'qty'),
      numCell(rows.length, 'qty'),
    ]);
  }

  const p = computePortfolio(varieties);
  const foot: Cell[] = new Array(PORTFOLIO_HEADERS.length).fill(null);
  foot[0] = strCell('合计');
  foot[4] = anyBase ? moneyCell(totalProfit) : null;
  foot[5] = anyBase ? moneyCell(totalBuy) : null;
  foot[6] = anyBase ? moneyCell(totalSell) : null;
  foot[7] = numCell(totalRemaining / QTY_SCALE, 'qty');
  foot[8] = p.profitRate == null ? strCell('—') : strCell((p.profitRate * 100).toFixed(2) + '%');

  return { name: '汇总', rows: [head, ...body, foot] };
}

// ---- 文件名（统一口径） ----
export function todayStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

export function safeName(name: string, fallback = 'variety'): string {
  return (name || fallback).replace(/[^\w一-龥-]/g, '_');
}
