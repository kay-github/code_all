import { finite } from './analysis.mjs';

export const ABC_RATIOS = [23.6, 38.2, 50, 61.8, 78.6];
export const FIFTH_RATIOS = [61.8, 78.6, 100, 127.2, 161.8];
const positive = v => finite(v) && Number(v) > 0;
function position(price, shares) {
  return finite(shares) && Number(shares) >= 0 && Number.isInteger(Number(shares)) ? price * Number(shares) : null;
}

// A manually specified bearish ABC path. B retracement is a fraction of A's PRICE LENGTH,
// not the percentage rise from A's low. All anchors must use the same adjustment basis.
export function abcScenario({ high, low, bPercent = 38.2, cPercent = 61.8, shares = 0 }) {
  if (!positive(high) || !positive(low) || Number(high) <= Number(low)) return { valid:false, error:'A 浪起点须高于假设终点，且价格均大于零' };
  if (!finite(bPercent) || Number(bPercent) < 0 || Number(bPercent) > 200) return { valid:false, error:'B 浪回补比例请输入 0—200%' };
  const start = Number(high), bottom = Number(low), length = start - bottom;
  const target = bottom + length * Number(bPercent) / 100;
  const cInputValid = finite(cPercent) && Number(cPercent) >= 0 && Number(cPercent) <= 500;
  const cTarget = cInputValid ? target - length * Number(cPercent) / 100 : null;
  const cValid = cTarget != null && cTarget > 0;
  return { valid:true, length, drawdown:bottom / start - 1, target, rise:target / bottom - 1,
    fromHigh:target / start - 1, value:position(target,shares), cTarget:cValid ? cTarget : null, cValid,
    cError:cValid ? null : cInputValid ? '该 C 浪倍数推算出非正价格，请调整假设' : 'C 浪长度比例请输入 0—500%',
    cChange:cValid ? cTarget / target - 1 : null, cValue:cValid ? position(cTarget,shares) : null };
}

// The user's chosen wave-5 / wave-3 length comparison, not an automatic Elliott wave count.
export function fifthScenario({ thirdStart, thirdEnd, fourthLow, extensionPercent = 78.6, shares = 0 }) {
  if (!positive(thirdStart) || !positive(thirdEnd) || !positive(fourthLow) ||
      !(Number(thirdStart) < Number(fourthLow) && Number(fourthLow) < Number(thirdEnd))) {
    return { valid:false, error:'请按同一价格口径填写：三浪起点 < 四浪假设底部 < 三浪终点' };
  }
  if (!finite(extensionPercent) || Number(extensionPercent) < 0 || Number(extensionPercent) > 500) return { valid:false, error:'五浪长度比例请输入 0—500%' };
  const length = Number(thirdEnd) - Number(thirdStart);
  const target = Number(fourthLow) + length * Number(extensionPercent) / 100;
  return { valid:true, length, target, rise:target / Number(fourthLow) - 1, fromHigh:target / Number(thirdEnd) - 1,
    fourthRetracement:(Number(thirdEnd) - Number(fourthLow)) / length,
    value:position(target,shares), exceedsThird:target > Number(thirdEnd) };
}
