// 计算引擎（PRD BR-11：纯函数，与 UI 分离，可独立单测）
// 规则来源：PRD 3.2/3.3/3.4 —— 全部经源表格逐格验证

import { Net, NetType, Variety } from './types';
import { PRICE_SCALE, QTY_SCALE, ratioU4 } from './money';

export type SellRule = 'first' | 'anchor' | 'prev';

export interface RowView {
  rowId: string;        // `${netIndex}:${gridIndex}`
  netIndex: number;
  netType: NetType;
  isNetFirstRow: boolean;
  gridIndex: number;    // 档数
  levelBp: number;      // 档位（基点，1bp = 0.01%）
  sellRule: SellRule;
  anchorBp: number | null;        // 锚点档位（基点），仅 anchor 行
  buyU4: number | null;           // 买入价格（U4）；basePrice 未填时为 null
  sellU4: number | null;          // 卖出价格（U4）
  buyQtyQ4: number;               // 买入数量（Q4）
  sellQtyQ4: number;              // 卖出数量（Q4）
  buyAmountH8: bigint | null;     // 买入金额 = 买价 × 买量（源表 E = C*D）
  sellAmountH8: bigint | null;    // 卖出金额 = 卖价 × 卖量（源表 H = F*G）
  profitH8: bigint | null;        // 利润 = (卖价 − 买价) × 卖量（源表 I）
  remainingQ4: number;            // 剩余数量 = 买量 − 卖量（源表 J）
  oversell: boolean;              // 卖出数量 > 买入数量（软警告，BR-08）
  priceInvalid: boolean;          // 档位 ≥ 100%（买入价 ≤ 0），软警告：源表未定义此情形
}

export interface Summary {
  totalProfitH8: bigint | null;   // 合计利润（源表 K2 = ΣI）
  totalBuyH8: bigint | null;      // 总买入金额（衍生，BR-15）
  totalSellH8: bigint | null;     // 总卖出金额（衍生）
  totalRemainingQ4: number;       // 总剩余持仓（衍生）
  profitRate: number | null;      // 已实现收益率 = 合计利润 ÷ 总买入金额（衍生）
  profitByType: Record<NetType, bigint | null>; // 按网类型小计（衍生，FR-05 P1）
}

/** 步长 → 基点整数（0.02 → 200bp） */
export function stepToBp(gridStep: number): number {
  return Math.round(gridStep * 10000);
}

/**
 * 展开品种为行视图（网列表 → 行，BR-04；价格三规则 BR-03）。
 * basePrice 为 null 时价格/金额/利润字段为 null（GT-04），数量字段照常工作。
 */
export function expandRows(v: Variety): RowView[] {
  const stepBp = stepToBp(v.gridStep);
  const baseU4 = v.basePrice === null ? null : Math.round(v.basePrice * PRICE_SCALE);
  const rows: RowView[] = [];

  v.nets.forEach((net: Net, ni: number) => {
    for (let g = net.startGrid; g <= net.endGrid; g++) {
      const rowId = `${ni}:${g}`;
      const j = v.journal[rowId];
      const buyQtyQ4 = toQtyQ4(j?.buyQty);
      const sellQtyQ4 = toQtyQ4(j?.sellQty);

      let sellRule: SellRule;
      let anchorBp: number | null = null;
      let sellU4: number | null = null;
      if (g === 0) {
        // 规则①：首档行，卖出价 = 基准价 × (1 + 步长)   [源表 F2 = $C$2*(1+B3)]
        sellRule = 'first';
        if (baseU4 !== null) sellU4 = ratioU4(baseU4, 10000 + stepBp, 10000);
      } else if (ni > 0 && g === net.startGrid) {
        // 规则②：网锚点行，卖出价 = 基准价 × (1 − 锚点档位)   [源表 F = C{锚点行}]
        sellRule = 'anchor';
        anchorBp = (net.anchorGrid ?? 0) * stepBp;
        if (baseU4 !== null) sellU4 = ratioU4(baseU4, 10000 - anchorBp, 10000);
      } else {
        // 规则③：上一档买入价 = 基准价 × (1 − (档位 − 步长))   [源表 F = C{上一行}，已验证价格等价]
        sellRule = 'prev';
        if (baseU4 !== null) sellU4 = ratioU4(baseU4, 10000 - (g - 1) * stepBp, 10000);
      }

      const buyU4 = baseU4 === null ? null : ratioU4(baseU4, 10000 - g * stepBp, 10000);
      const buyAmountH8 =
        buyU4 === null ? null : BigInt(buyU4) * BigInt(buyQtyQ4);
      const sellAmountH8 =
        sellU4 === null ? null : BigInt(sellU4) * BigInt(sellQtyQ4);
      const profitH8 =
        buyU4 === null || sellU4 === null
          ? null
          : BigInt(sellU4 - buyU4) * BigInt(sellQtyQ4);

      rows.push({
        rowId,
        netIndex: ni,
        netType: net.type,
        isNetFirstRow: g === net.startGrid,
        gridIndex: g,
        levelBp: g * stepBp,
        sellRule,
        anchorBp,
        buyU4,
        sellU4,
        buyQtyQ4,
        sellQtyQ4,
        buyAmountH8,
        sellAmountH8,
        profitH8,
        remainingQ4: buyQtyQ4 - sellQtyQ4,
        oversell: sellQtyQ4 > buyQtyQ4,
        priceInvalid: buyU4 !== null && buyU4 <= 0,
      });
    }
  });

  return rows;
}

function toQtyQ4(x: unknown): number {
  const n = typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0;
  return Math.round(n * QTY_SCALE);
}

const NET_TYPES: NetType[] = ['小网', '中网', '大网'];

/** 汇总（BR-07 / BR-15） */
export function computeSummary(rows: RowView[]): Summary {
  // 总剩余持仓 = Σ(买量 − 卖量)，只依赖 D/G 两列，与基准价无关（BR-06 / GT-04「数量正常」）
  // —— 因此无论基准价是否已填都必须求和（修正 v1.2 中「未设基准价则持仓恒为 0」的口径缺陷）
  let remaining = 0;
  for (const r of rows) remaining += r.remainingQ4;

  const baseFilled = rows.length > 0 && rows[0].buyU4 !== null;
  const byType: Record<NetType, bigint | null> = { 小网: null, 中网: null, 大网: null };
  if (!baseFilled) {
    return {
      totalProfitH8: null,
      totalBuyH8: null,
      totalSellH8: null,
      totalRemainingQ4: remaining,
      profitRate: null,
      profitByType: byType,
    };
  }

  let buy = 0n, sell = 0n, profit = 0n;
  const byTypeAcc: Record<NetType, bigint> = { 小网: 0n, 中网: 0n, 大网: 0n };
  for (const r of rows) {
    buy += r.buyAmountH8 ?? 0n;
    sell += r.sellAmountH8 ?? 0n;
    profit += r.profitH8 ?? 0n;
    byTypeAcc[r.netType] += r.profitH8 ?? 0n;
  }
  for (const t of NET_TYPES) byType[t] = byTypeAcc[t];
  const profitRate = buy === 0n ? null : Number(profit) / Number(buy);
  return { totalProfitH8: profit, totalBuyH8: buy, totalSellH8: sell, totalRemainingQ4: remaining, profitRate, profitByType: byType };
}

/** 跨品种组合汇总（FR-05 扩展）——把 N 个品种聚合为「一个账户」口径 */
export interface Portfolio {
  count: number;                 // 品种总数
  withBase: number;              // 已设基准价的品种数
  withoutBase: number;           // 未设基准价的品种数（价格类指标暂不计算）
  totalProfitH8: bigint | null;  // 合计利润（仅计入已设基准价的品种）；全部未设 → null
  totalBuyH8: bigint | null;     // 总买入金额（同上口径）
  totalRemainingQ4: number;      // 总持仓（与基准价无关，全部品种计入）
  profitRate: number | null;     // 组合已实现收益率 = 合计利润 ÷ 总买入金额
}

export function computePortfolio(varieties: Variety[]): Portfolio {
  let profit = 0n, buy = 0n, remaining = 0, withBase = 0;
  for (const v of varieties) {
    const rows = expandRows(v);
    const s = computeSummary(rows);
    remaining += s.totalRemainingQ4;
    if (rows.length > 0 && rows[0].buyU4 !== null) {
      withBase++;
      profit += s.totalProfitH8 ?? 0n;
      buy += s.totalBuyH8 ?? 0n;
    }
  }
  return {
    count: varieties.length,
    withBase,
    withoutBase: varieties.length - withBase,
    totalProfitH8: withBase > 0 ? profit : null,
    totalBuyH8: withBase > 0 ? buy : null,
    totalRemainingQ4: remaining,
    profitRate: buy === 0n ? null : Number(profit) / Number(buy),
  };
}

/** journal 中不再对应任何行的孤儿条目（BR-13） */
export function orphanJournalIds(v: Variety): string[] {
  const valid = new Set<string>();
  v.nets.forEach((net, ni) => {
    for (let g = net.startGrid; g <= net.endGrid; g++) valid.add(`${ni}:${g}`);
  });
  return Object.keys(v.journal).filter((k) => !valid.has(k));
}
