// 数据模型 —— 与 PRD 第 4 章一一对应
// 档位全部以「档数」（整数）存储：level = gridIndex × gridStep（PRD BR-12 防浮点误差）

export type NetType = '小网' | '中网' | '大网';

export interface Net {
  type: NetType;
  startGrid: number; // 起始档数（含）
  endGrid: number;   // 结束档数（含）
  anchorGrid?: number | null; // 锚点档数（非首个网必填；首网无锚点）
}

export interface JournalEntry {
  buyQty: number;  // 累计买入份数（源表 D 列）
  sellQty: number; // 累计卖出份数（源表 G 列）
}

/** 交易流水条目（FR-08 P1）：审计记录，只增不删，不参与任何计算 */
export interface LedgerEntry {
  ts: number;                                // 变更时间戳（毫秒）
  rowId: string;                             // `${netIndex}:${gridIndex}`
  field: 'buyQty' | 'sellQty';
  from: number;                              // 旧值
  to: number;                                // 新值
  /**
   * 变更方式（FR-11）：
   *   'add' = 增量累加（本档又触发一次，本次触发量 = to − from）
   *   'set' = 直接设值（原有录入路径）
   * 旧数据无此字段 → 视作 'set'，但「上次触发量」会按「最近一次增量」退化推断。
   */
  op?: 'add' | 'set';
  revert?: boolean;                          // true = 由「撤销」产生的反向补偿条目
}

export interface Variety {
  id: string;
  name: string;
  code: string;
  basePrice: number | null; // 基准价（源表 C2），null = 未填
  gridStep: number;         // 网格步长（小数，如 0.02）
  nets: Net[];
  journal: Record<string, JournalEntry>; // key = rowId = `${netIndex}:${gridIndex}`
  ledger?: LedgerEntry[];   // 交易流水（可选，向后兼容旧数据）
  // FR-09 自动行情（P2 扩展，全部可选、可整体裁剪）
  quoteUrl?: string | null;     // 行情源 URL：返回当前价（JSON 含 price/last/f43，或纯文本含数值）。留空=手动标注
  lastPrice?: number | null;    // 最近一次自动行情取得的当前价（定点？否——已是真实价格浮点，仅作标注）
  lastPriceAt?: number | null;  // 最近一次行情成功时间戳（毫秒）
}

export interface AppData {
  version: 1;
  varieties: Variety[];
}

export function genId(): string {
  return 'v_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}
