// 精度工具（PRD BR-12：内部定点/整数运算，禁止裸浮点累加）
//
// 价格单位 U4   = 0.0001 元（源表价格最多 4 位小数）
// 数量单位 Q4   = 0.0001 份（BR-14 允许小数数量，按 4 位小数收纳）
// 金额单位 H8   = 0.00000001 元（u4 × q4 恰为整数 H8，金额/利润全程 BigInt 精确）

export const PRICE_SCALE = 10000;
export const QTY_SCALE = 10000;

/** 浮点 → 定点整数（四舍五入），用于基准价与录入数量的收纳 */
export function toScaled(x: number, scale: number): number {
  return Math.round(x * scale);
}

/**
 * 精确计算 round(baseU4 * num / den)，半进位。
 * 用 BigInt 中间量保证 baseU4=12300、num=7000、den=10000 → 8610（无浮点尾差，GT-10）。
 */
export function ratioU4(baseU4: number, num: number, den: number): number {
  const a = BigInt(Math.round(baseU4)) * BigInt(num);
  const d = BigInt(den);
  return Number((a * 2n + d) / (d * 2n));
}

/** 金额显示：H8 BigInt → 千分位字符串（默认 2 位小数，半进位） */
export function fmtMoney(m: bigint | null, dp = 2): string | null {
  if (m === null) return null;
  const neg = m < 0n;
  const a = neg ? -m : m;
  const scale = 10n ** BigInt(dp);
  const unit = 100000000n / scale; // H8 → 显示单位的换算因子（dp ≤ 8）
  const rounded = (a + unit / 2n) / unit;
  const intPart = rounded / scale;
  const frac = (rounded % scale).toString().padStart(dp, '0');
  const intStr = intPart.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + intStr + (dp > 0 ? '.' + frac : '');
}

/** 定点数量/价格显示：整数 (scaled) → 去尾零小数字符串 */
export function fmtScaled(v: number | null, scale: number, maxDp: number): string | null {
  if (v === null) return null;
  let str = (v / scale).toFixed(maxDp);
  if (str.includes('.')) str = str.replace(/0+$/, '').replace(/\.$/, '');
  return str === '-0' ? '0' : str;
}

/** 档位百分数显示：bp（基点，1bp=0.01%）→ "30%" / "2.5%" */
export function fmtPct(bp: number): string {
  const v = bp / 100;
  let str = v.toFixed(2);
  if (str.includes('.')) str = str.replace(/0+$/, '').replace(/\.$/, '');
  return str + '%';
}
