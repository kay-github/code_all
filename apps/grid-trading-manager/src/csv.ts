// P2 导出：单品种 / 全品种 CSV（UTF-8 BOM，Excel 可直接打开）
//
// 列定义与单元格映射统一来自 exportModel.ts（单一真源），保证与 XLSX 导出列结构完全一致。
// 数字列写纯文本数值（不带千分位），Excel 打开即识别为数字可直接参与运算。

import { Variety } from './engine/types';
import { Cell, safeName, todayStamp } from './exportModel';
import { sheetForVariety, portfolioSheet } from './exportModel';

function esc(s: string): string {
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** 单元格 → CSV 文本（与 xlsx 的数值口径一致） */
function cellToCsv(c: Cell): string {
  if (c == null) return '';
  if (c.kind === 's') return esc(c.v);
  return c.fmt === 'money' ? c.v.toFixed(2) : String(round4(c.v));
}

function round4(v: number): number {
  return Number(v.toFixed(4));
}

function sheetToCsv(rows: Cell[][]): string {
  const lines = rows.map((r) => r.map(cellToCsv).join(','));
  return '\ufeff' + lines.join('\r\n'); // BOM 保证 Excel 正确识别 UTF-8 中文
}

export function varietyToCsv(v: Variety): string {
  return sheetToCsv(sheetForVariety(v).rows);
}

export function csvFileName(v: Variety): string {
  return `grid-${safeName(v.name)}-${todayStamp()}.csv`;
}

/** 全品种 CSV：以组合汇总表呈现（每品种一行），便于横向比较与统计 */
export function allVarietiesToCsv(varieties: Variety[]): string {
  return sheetToCsv(portfolioSheet(varieties).rows);
}

export function allCsvFileName(): string {
  return `grid-汇总-${todayStamp()}.csv`;
}
