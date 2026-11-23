// Bars are [YYYY-MM-DD, open, high, low, close] on one adjustment basis.
export const VERSION = '2026-11-23.4';
export const SWING_SCALE = 3;
const DATE = 0, HIGH = 2, LOW = 3, CLOSE = 4;
export const ABC_LEVELS = [0.618, 0.809, 1, 1.236, 1.382, 1.618];

export function validateBars(bars) {
  if (!Array.isArray(bars) || bars.length < 20) throw new Error('至少需要 20 根有效日线');
  let previous = '';
  for (const bar of bars) {
    const [date, open, high, low, close] = bar;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date || date <= previous ||
        ![open, high, low, close].every(p => Number.isFinite(p) && p > 0) ||
        low > Math.min(open, close) || high < Math.max(open, close)) {
      throw new Error(`检查日线日期、OHLC 或排序（${date || '空日期'}）`);
    }
    previous = date;
  }
  return bars;
}

export function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  const header = lines.shift()?.toLowerCase().replace(/\s/g, '');
  if (header !== 'date,open,high,low,close') throw new Error('CSV 首行为 date,open,high,low,close');
  return validateBars(lines.filter(line => line.trim()).map(line => {
    const cells = line.split(',').map(s => s.trim().replace(/^"(.*)"$/, '$1'));
    if (cells.length !== 5) throw new Error('CSV 每行应有五列');
    return [cells[0], ...cells.slice(1).map(Number)];
  }));
}

// A pivot becomes known on the first subsequent close reversing by scale × ATR(14).
// New extremes on a bar take priority over a reversal on that same bar.
export function confirmedPivots(bars, scale = SWING_SCALE) {
  if (!Number.isFinite(scale) || scale <= 0) throw new Error('转折尺度必须为正数');
  const ranges = [];
  const result = [];
  let side = null, high = null, low = null;
  for (const [i, bar] of bars.entries()) {
    const previous = bars[i - 1]?.[CLOSE] ?? bar[CLOSE];
    ranges.push(Math.max(bar[HIGH] - bar[LOW], Math.abs(bar[HIGH] - previous), Math.abs(bar[LOW] - previous)));
    if (ranges.length > 14) ranges.shift();
    const distance = scale * ranges.reduce((sum, v) => sum + v, 0) / ranges.length;
    if (!distance) continue;
    if (side !== 'low' && (!high || bar[HIGH] > high.price)) high = { index: i, date: bar[DATE], price: bar[HIGH], kind: 'high' };
    if (side !== 'high' && (!low || bar[LOW] < low.price)) low = { index: i, date: bar[DATE], price: bar[LOW], kind: 'low' };
    if (i < 14) continue;
    const last = result.at(-1)?.index ?? -1;
    const top = side !== 'low' && high.index >= last + 2 && i > high.index && bar[CLOSE] <= high.price - distance;
    const bottom = side !== 'high' && low.index >= last + 2 && i > low.index && bar[CLOSE] >= low.price + distance;
    if (top && (!bottom || high.index > low.index)) {
      result.push({ ...high, confirmed: bar[DATE] });
      side = 'low';
      low = { index: i, date: bar[DATE], price: bar[LOW], kind: 'low' };
    } else if (bottom) {
      result.push({ ...low, confirmed: bar[DATE] });
      side = 'high';
      high = { index: i, date: bar[DATE], price: bar[HIGH], kind: 'high' };
    }
  }
  return result;
}

const directionSign = direction => direction === 'up' ? -1 : 1;
const firstKind = direction => direction === 'up' ? 'low' : 'high';
const oppositeKind = kind => kind === 'high' ? 'low' : 'high';
const at = (bar, kind) => bar[kind === 'high' ? HIGH : LOW];

export function manualAnchors(bars, dates, direction) {
  if (dates.length !== 3 || dates.some((date, i) => !date || (i && date <= dates[i - 1]))) {
    throw new Error('填写三个依时间顺序排列的交易日');
  }
  return dates.map((date, i) => {
    const index = bars.findIndex(bar => bar[DATE] === date);
    if (index < 0) throw new Error(`${date} 不在截至当日的行情中`);
    const kind = i === 1 ? oppositeKind(firstKind(direction)) : firstKind(direction);
    return { index, date, price: at(bars[index], kind), kind, confirmed: null };
  });
}

function recentAnchors(bars, pivots, direction) {
  const kind = firstKind(direction), sign = directionSign(direction);
  const candidates = [];
  for (let i = pivots.length - 3; i >= 0 && candidates.length < 8; i--) {
    const triple = pivots.slice(i, i + 3);
    const [start, a, b] = triple;
    if (bars.length - b.index > 145) break;
    if (start.kind === kind && sign * (start.price - b.price) > 0 && sign * (b.price - a.price) > 0) candidates.push(triple);
  }
  return candidates;
}

function extreme(bars, first, end, kind) {
  let point = null;
  for (let i = first; i <= end; i++) {
    const price = at(bars[i], kind);
    if (!point || (kind === 'high' ? price >= point.price : price <= point.price)) point = { index: i, date: bars[i][DATE], price, kind };
  }
  return point;
}

export function impulseChecks(anchors, direction) {
  const s = directionSign(direction);
  const [start, one, two, three, four, five] = anchors;
  const invalid = [];
  if (s * (two.price - start.price) >= 0) invalid.push('第2浪越过第1浪起点');
  if (three && s * (three.price - one.price) >= 0) invalid.push('第3浪尚未越过第1浪终点');
  if (four && s * (four.price - one.price) > 0) invalid.push('第4浪进入第1浪区间');
  if (five && s * (two.price - three.price) < Math.min(s * (start.price - one.price), s * (four.price - five.price))) {
    invalid.push('第3浪短于第1浪与第5浪');
  }
  return invalid;
}

function evaluateFixed(bars, pivots, fixed, direction) {
  const sign = directionSign(direction);
  const kind = firstKind(direction), terminalKind = oppositeKind(kind);
  const [start, a, b] = fixed;
  const aSize = sign * (start.price - a.price), bSize = sign * (b.price - a.price);
  if (aSize <= 0 || bSize <= 0) throw new Error('起点、A/1 和 B/2 须按方向形成先推进再回撤');
  const next = pivots.filter(p => p.index > b.index);
  const firstThree = next.find(p => p.kind === terminalKind && sign * (a.price - p.price) > 0);
  const firstFour = firstThree && next.find(p => p.index > firstThree.index && p.kind === kind);
  const firstFive = firstFour && next.find(p => p.index > firstFour.index && p.kind === terminalKind);
  const impulse = [...fixed, ...[firstThree, firstFour, firstFive].filter(Boolean)];
  const invalid = impulseChecks(impulse, direction);
  const premature = extreme(bars, b.index + 1, firstThree?.index ?? bars.length - 1, kind);
  if (!invalid.length && premature && sign * (premature.price - start.price) >= 0) invalid.push('出现第3浪证据前已回到第1浪起点');
  if (firstFour && firstFive && sign * (firstFour.price - firstFive.price) <= 0) invalid.push('第5浪候选未向推进方向运行');
  const liveFour = firstThree && !firstFour ? extreme(bars, firstThree.index + 1, bars.length - 1, kind) : null;
  const overlapWatch = !invalid.length && !!liveFour && sign * (liveFour.price - a.price) > 0;
  const truncated = firstFive && sign * (firstFive.price - firstThree.price) >= 0;
  const c = extreme(bars, b.index + 1, bars.length - 1, terminalKind);
  const cSize = c ? sign * (b.price - c.price) : null;
  const cRatio = cSize > 0 ? cSize / aSize : null;
  const retest = c && cRatio !== null ? c.price + sign * .382 * (sign * (start.price - c.price)) : null;
  const bBeyond = sign * (b.price - start.price) > 0;
  const impulseStatus = invalid.length ? 'invalid' : firstFive ? (truncated ? 'truncated' : 'five') : firstFour ? 'four' : firstThree ? 'three' : 'waiting';
  return { direction, fixed, pivots, c, cRatio, retest, bRetraction: bSize / aSize, bBeyond, impulse, impulseStatus, invalid, overlapWatch,
    impulseRatio: firstThree ? sign * (b.price - firstThree.price) / aSize : null,
    cLevels: ABC_LEVELS.map(ratio => ({ ratio, price: b.price - sign * ratio * aSize })).filter(level => level.price > 0) };
}

export function countSubwaves(start, end, pivots) {
  let matching = oppositeKind(start.kind);
  let count = 0;
  for (const p of pivots) {
    if (p.index >= end.index) break;
    if (p.index <= start.index || p.kind !== matching) continue;
    matching = oppositeKind(matching);
    count++;
  }
  // The endpoint is the last swing. Discard an interior turn of the same kind
  // at the very end, as it does not add a full reversal before the endpoint.
  return count + Number(matching === end.kind);
}

export function reviewZigzag(bars, result, scale, pivots) {
  if (!result.fixed || !result.c || result.cRatio == null || result.bBeyond) return null;
  const fine = pivots ?? confirmedPivots(bars, scale / 2);
  const points = [...result.fixed, result.c];
  const counts = points.slice(1).map((point, i) => countSubwaves(points[i], point, fine));
  return { counts, matches: counts.every((count, i) => count === [5, 3, 5][i]),
    terminalConfirmed: fine.some(point => point.index === result.c.index && point.kind === result.c.kind) };
}

export function evaluate(bars, options = {}) {
  const direction = options.direction === 'up' ? 'up' : 'down';
  const pivots = options.pivots ?? confirmedPivots(bars, options.scale ?? SWING_SCALE);
  const anchors = options.dates ? [manualAnchors(bars, options.dates, direction)] : recentAnchors(bars, pivots, direction);
  if (!anchors.length) return { direction, fixed: null, pivots, reason: '在这个尺度下，尚无三个可用的同级锚点' };
  const candidates = anchors.map(points => evaluateFixed(bars, pivots, points, direction));
  // A smaller, newly completed B must not hide the developing 4/5 of the larger candidate.
  // Completed and developing candidates age out by their last observable turning point.
  const size = bars.length;
  const ranked = candidates.map((candidate, i) => {
    const endpoint = candidate.impulse.at(-1);
    const lastAge = size - 1 - endpoint.index;
    const valid = candidate.impulseStatus !== 'invalid';
    const evidence = Math.max(0, (candidate.impulse.length - 3) * 12 - lastAge);
    const score = (valid ? evidence : 0) - i / 10;
    return { candidate, score };
  }).sort((a, b) => b.score - a.score);
  const result = ranked[0].candidate;
  const b = result.fixed[2];
  const terminalKind = oppositeKind(firstKind(direction));
  const c1 = pivots.find(p => p.index > b.index && p.kind === terminalKind);
  const c2 = c1 && pivots.find(p => p.index > c1.index && p.kind !== terminalKind);
  const sign = directionSign(direction);
  let internal = null;
  if (c2 && sign * (b.price - c1.price) > 0 && sign * (c2.price - c1.price) > 0 && sign * (b.price - c2.price) > 0) {
    const inner = evaluateFixed(bars, pivots, [b, c1, c2], direction);
    const four = inner.impulse[4];
    const c5 = inner.impulse[5] ?? (four ? extreme(bars, four.index + 1, size - 1, terminalKind) : null);
    const length = sign * (b.price - c1.price);
    const levels = four ? [.618, .809, 1].map(ratio => ({ ratio, price: four.price - sign * ratio * length })).filter(x => x.price > 0) : [];
    internal = { points: inner.impulse, invalid: inner.invalid, c3Ratio: inner.impulseRatio, c5Ratio: c5 ? sign * (four.price - c5.price) / length : null, levels };
  }
  const alternatives = ranked.slice(1, 4).map(({ candidate }) => ({ dates: candidate.fixed.map(point => point.date), status: candidate.impulseStatus }));
  return { ...result, internal, alternatives };
}
