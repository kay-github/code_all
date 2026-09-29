// P2 导出：真正的 .xlsx（零依赖，ZIP store + OOXML），支持多工作表
//
// v1.3 升级：
//   - 由「单品种单表」升级为**通用多工作表构建器**（Excel 原生多 sheet）；
//   - 增加列宽（cols）与**冻结首行**（sheetViews/pane），长表翻阅更顺手；
//   - 数字列套用数字格式：数量 0.#### / 金额 #,##0.00（Excel 内可直接求和，不再是一堆裸小数）；
//   - 列定义与单元格映射统一来自 exportModel.ts（单一真源，与 CSV 保证一致）。
// 仍不依赖 SheetJS 等第三方库，保证单文件离线可用。

import { Variety } from './engine/types';
import { Cell, safeName, todayStamp, sheetForVariety, portfolioSheet, Sheet } from './exportModel';
import { buildZip } from './zip';

// 风格索引：0=常规 1=表头加粗 2=数量(0.####) 3=金额(#,##0.00)
const STYLE_GENERAL = 0;
const STYLE_BOLD = 1;
const STYLE_QTY = 2;
const STYLE_MONEY = 3;

// 自定义数字格式 id（164+ 为用户自定义区）
const FMT_QTY = 164;   // 0.####
const FMT_MONEY = 165; // #,##0.00

const WIDTHS_VARIETY = [8, 8, 11, 11, 13, 11, 11, 13, 13, 11];
const WIDTHS_PORTFOLIO = [16, 10, 8, 10, 13, 13, 13, 11, 13, 6, 6];
const PORTFOLIO_HEADERS_LEN = WIDTHS_PORTFOLIO.length;

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!));
}

function colLetter(idx: number): string {
  let s = '';
  let n = idx;
  while (n >= 0) { s = String.fromCharCode((n % 26) + 65) + s; n = Math.floor(n / 26) - 1; }
  return s;
}

function styleFor(c: Cell, bold: boolean): number {
  if (bold) return STYLE_BOLD;
  if (c && c.kind === 'n') return c.fmt === 'money' ? STYLE_MONEY : STYLE_QTY;
  return STYLE_GENERAL;
}

function cellXml(ref: string, c: Cell, bold: boolean): string {
  const s = styleFor(c, bold);
  const sAttr = s === STYLE_GENERAL ? '' : ` s="${s}"`;
  if (c == null) return `<c r="${ref}"${sAttr}/>`;
  if (c.kind === 's') {
    return `<c r="${ref}" t="inlineStr"${sAttr}><is><t xml:space="preserve">${escapeXml(c.v)}</t></is></c>`;
  }
  return `<c r="${ref}"${sAttr}><v>${c.v}</v></c>`;
}

function colsXml(widths: number[]): string {
  return '<cols>' + widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('') + '</cols>';
}

function buildSheetXml(rows: Cell[][], widths: number[]): string {
  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'];
  lines.push('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">');
  // 冻结首行
  lines.push('<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>');
  lines.push('<sheetFormatPr defaultRowHeight="15"/>');
  lines.push(colsXml(widths));
  lines.push('<sheetData>');
  rows.forEach((row, ri) => {
    const r = ri + 1;
    const cells = row.map((c, ci) => cellXml(`${colLetter(ci)}${r}`, c, ri === 0)).join('');
    lines.push(`<row r="${r}">${cells}</row>`);
  });
  lines.push('</sheetData>');
  lines.push('</worksheet>');
  return lines.join('');
}

const CT_HEAD = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2"><numFmt numFmtId="${FMT_QTY}" formatCode="0.####"/><numFmt numFmtId="${FMT_MONEY}" formatCode="#,##0.00"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border/></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="4">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="${FMT_QTY}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="${FMT_MONEY}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
</styleSheet>`;

const encoder = new TextEncoder();

/** Excel 工作表名约束：≤31 字符、不得含 []:*?/\、同一工作簿内唯一 */
function normalizeSheetNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((raw, i) => {
    let n = (raw || `Sheet${i + 1}`).replace(/[[\]:*?/\\]/g, '_').trim() || `Sheet${i + 1}`;
    if (n.length > 31) n = n.slice(0, 31);
    let candidate = n;
    let k = 2;
    while (used.has(candidate)) {
      const suffix = `(${k++})`;
      candidate = n.slice(0, 31 - suffix.length) + suffix;
    }
    used.add(candidate);
    return candidate;
  });
}

/** 通用多工作表 XLSX 构建 */
export function buildXlsxBlob(sheets: Sheet[]): Blob {
  const list = sheets.length > 0 ? sheets : [{ name: 'Sheet1', rows: [] as Cell[][] }];
  const names = normalizeSheetNames(list.map((s) => s.name));

  const parts: { name: string; data: Uint8Array }[] = [];
  const overrides: string[] = [];

  list.forEach((s, i) => {
    const path = `xl/worksheets/sheet${i + 1}.xml`;
    const widths = i === 0 && list.length === 1 ? WIDTHS_VARIETY : (s.name === '汇总' ? WIDTHS_PORTFOLIO : WIDTHS_VARIETY);
    parts.push({ name: path, data: encoder.encode(buildSheetXml(s.rows, widths)) });
    overrides.push(`<Override PartName="/${path}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);
  });

  const contentTypes = CT_HEAD + '\n' + overrides.join('\n') + '\n</Types>';

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${names.map((n, i) => `<sheet name="${escapeXml(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
</workbook>`;

  const styleRid = `rId${list.length + 1}`;
  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${list.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n')}
<Relationship Id="${styleRid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  const zip = buildZip([
    { name: '[Content_Types].xml', data: encoder.encode(contentTypes) },
    { name: '_rels/.rels', data: encoder.encode(ROOT_RELS) },
    { name: 'xl/workbook.xml', data: encoder.encode(workbook) },
    { name: 'xl/_rels/workbook.xml.rels', data: encoder.encode(workbookRels) },
    { name: 'xl/styles.xml', data: encoder.encode(STYLES) },
    ...parts,
  ]);
  return new Blob([zip], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

/** 单品种工作簿（保持 sheet1 为数据表，向后兼容既有校验） */
export function varietyToXlsxBlob(v: Variety): Blob {
  return buildXlsxBlob([sheetForVariety(v)]);
}

/** 全品种工作簿：首个 sheet 为「汇总」，其后每品种一个 sheet */
export function allVarietiesToXlsxBlob(varieties: Variety[]): Blob {
  return buildXlsxBlob([portfolioSheet(varieties), ...varieties.map(sheetForVariety)]);
}

export function xlsxFileName(v: Variety): string {
  return `grid-${safeName(v.name)}-${todayStamp()}.xlsx`;
}

export function allXlsxFileName(): string {
  return `grid-全部品种-${todayStamp()}.xlsx`;
}
