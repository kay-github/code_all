// Pure calculations shared by the browser and Node's test runner. Prices use ONE adjustment basis.
export const finite = (v) => v !== '' && v != null && Number.isFinite(Number(v));
const num = (v, fallback = 0) => finite(v) ? Number(v) : fallback;
export function validateBars(rows) {
  if (!Array.isArray(rows)) throw new Error('日线数据必须是数组');
  const unique = new Map();
  for (const row of rows) {
    const time = String(row.time || row.date || '').slice(0, 10);
    const values = ['open', 'high', 'low', 'close'].map(k => Number(row[k]));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(time) || !Number.isFinite(Date.parse(time)) ||
      new Date(time).toISOString().slice(0, 10) !== time || values.some(v => !Number.isFinite(v) || v <= 0)) throw new Error('日线日期或价格无效：' + time);
    const [open, high, low, close] = values;
    if (high + 0.011 < Math.max(open, close, low) || low - 0.011 > Math.min(open, close, high)) throw new Error('日线高低价矛盾：' + time);
    unique.set(time, { time, open, high: Math.max(high, open, close), low: Math.min(low, open, close), close,
      volume: Math.max(0, num(row.volume)), amount: finite(row.amount) ? Number(row.amount) : null });
  }
  return [...unique.values()].sort((a, b) => a.time.localeCompare(b.time));
}
export function simulate(p) {
  const low = num(p.low), rebound = num(p.rebound), shares = Math.max(0, num(p.shares));
  const base = num(p.base), capital = num(p.capital), profit = num(p.profit), cost = num(p.cost), high = num(p.high);
  const target = low * (1 + rebound / 100);
  return { target, value: target * shares, currentValue: base * shares, change: (target - base) * shares,
    pnl: (target - cost) * shares, marketCap: capital > 0 ? target * capital : null,
    pe: profit > 0 && capital > 0 ? target * capital / profit : null,
    fromHigh: high > 0 ? target / high - 1 : null,
    fromBase: base > 0 ? target / base - 1 : null };
}
export function maxDrawdown(bars, mode = 'close') {
  if (bars.length < 2) return null;
  const upper = b => mode === 'intraday' ? b.high : b.close;
  const lower = b => mode === 'intraday' ? b.low : b.close;
  let peak = 0, result = null;
  for (let i = 1; i < bars.length; i++) {
    const dd = 1 - lower(bars[i]) / upper(bars[peak]);
    if (dd > 0 && (!result || dd > result.drawdown)) result = { peak, trough: i, peakPrice: upper(bars[peak]), lowPrice: lower(bars[i]), drawdown: dd, days: i - peak };
    // Update AFTER comparison: a daily high cannot precede that same day's low with certainty.
    if (upper(bars[i]) >= upper(bars[peak])) peak = i;
  }
  if (!result) return null;
  result.recovery = bars.findIndex((b, i) => i > result.trough && upper(b) >= result.peakPrice);
  result.recoveryDays = result.recovery < 0 ? null : result.recovery - result.trough;
  return result;
}
export function reboundLegs(bars, start, end, mode = 'close', confirmation = .2, retrace = .1) {
  const hi = i => mode === 'intraday' ? bars[i].high : bars[i].close;
  const lo = i => mode === 'intraday' ? bars[i].low : bars[i].close;
  const legs = []; let trough = start, peak = start, rising = false, confirmed = null;
  function push() {
    if (peak <= trough) return;
    const later = bars.slice(peak + 1, end + 1);
    const minLater = later.length ? Math.min(...later.map(b => mode === 'intraday' ? b.low : b.close)) : null;
    legs.push({ trough, peak, confirmed, low: lo(trough), high: hi(peak), gain: hi(peak) / lo(trough) - 1, days: peak - trough,
      newLow: minLater != null && minLater < lo(trough), afterDrop: minLater == null ? null : minLater / hi(peak) - 1 });
  }
  for (let i = start + 1; i <= end; i++) {
    if (!rising) {
      if (lo(i) < lo(trough)) trough = i;
      if (i > trough && hi(i) >= lo(trough) * (1 + confirmation)) { rising = true; peak = i; confirmed = i; }
    } else if (i > peak && lo(i) <= hi(peak) * (1 - retrace)) {
      push(); rising = false; trough = i; peak = i;
    } else if (hi(i) > hi(peak)) peak = i;
  }
  if (rising) push();
  return legs;
}
export function drawdownEvents(bars, threshold = .3, mode = 'close') {
  if (bars.length < 2) return [];
  const hi = i => mode === 'intraday' ? bars[i].high : bars[i].close;
  const lo = i => mode === 'intraday' ? bars[i].low : bars[i].close;
  let anchor = 0, active = null;
  const events = [];
  function finish(end, recovery) {
    if (!active) return;
    const e = { ...active, end, recovery, peakPrice: hi(active.peak), lowPrice: lo(active.trough) };
    e.drawdown = 1 - e.lowPrice / e.peakPrice; e.days = e.trough - e.peak;
    e.recoveryDays = recovery == null ? null : recovery - e.trough;
    e.legs = reboundLegs(bars, e.peak, end, mode);
    e.hits = Object.fromEntries([20, 30, 50, 100].map(p => {
      let at = -1;
      for (let i = e.trough + 1; i <= end; i++) if (hi(i) >= e.lowPrice * (1 + p / 100)) { at = i; break; }
      return [p, at < 0 ? null : at - e.trough];
    }));
    e.maxRebound = end > e.trough ? Math.max(...bars.slice(e.trough + 1, end + 1).map((_, j) => hi(e.trough + 1 + j))) / e.lowPrice - 1 : 0;
    events.push(e); active = null;
  }
  for (let i = 1; i < bars.length; i++) {
    if (1 - lo(i) / hi(anchor) >= threshold && !active) active = { peak: anchor, trough: i, trigger: i };
    if (active && lo(i) < lo(active.trough)) active.trough = i;
    // Include a later day's low even if it also makes a new high. If that day's low is
    // the new trough, only its closing recovery establishes high/low order conclusively.
    if (hi(i) >= hi(anchor)) {
      const ambiguous = mode === 'intraday' && active?.trough === i && bars[i].close < hi(anchor);
      if (!ambiguous) { finish(i, i); anchor = i; }
    }
  }
  finish(bars.length - 1, null);
  return events.sort((a, b) => b.drawdown - a.drawdown);
}
export function eventStudy(bars, { threshold = .6, window = 20, trigger = 'close', volume = false, first = true, excludeOverlap = true, lookback = 0 } = {}) {
  window = Math.max(1, Math.floor(window));
  const signals = []; let peak = 0, wasBelow = false, lockUntil = -1;
  for (let i = 1; i < bars.length; i++) {
    if (lookback > 0) {
      peak = Math.max(0, i - lookback);
      for (let j = peak + 1; j < i; j++) if (bars[j].high >= bars[peak].high) peak = j;
    }
    const price = trigger === 'low' ? bars[i].low : bars[i].close;
    const below = price <= bars[peak].high * (1 - threshold);
    const vols = bars.slice(Math.max(0, i - 20), i);
    const volumeOK = !volume || (vols.length === 20 && bars[i].volume > vols.reduce((s, b) => s + b.volume, 0) / 20 * 1.5);
    if (below && (!first || !wasBelow) && volumeOK && (!excludeOverlap || i > lockUntil)) {
      // Signals are observed at the CLOSE of day i, including a low-price touch. Never fill at an unknowable intraday low.
      const entry = bars[i].close, future = bars.slice(i + 1, i + window + 1);
      const complete = future.length === window;
      signals.push({ index: i, date: bars[i].time, entry, complete, availableDays: future.length,
        return: complete ? future.at(-1).close / entry - 1 : null,
        mfe: complete ? Math.max(...future.map(b => b.high)) / entry - 1 : null,
        mae: complete ? Math.min(...future.map(b => b.low)) / entry - 1 : null,
        newLow: complete ? future.some(b => b.low < bars[i].low) : null });
      lockUntil = i + window;
    }
    wasBelow = below;
    if (!lookback && bars[i].high >= bars[peak].high) peak = i;
  }
  const samples = signals.filter(s => s.complete), n = samples.length;
  const avg = key => n ? samples.reduce((s, v) => s + v[key], 0) / n : null;
  const ratio = fn => n ? samples.filter(fn).length / n : null;
  const sorted = samples.map(s => s.return).sort((a, b) => a - b);
  return { signals, samples, n, incomplete: signals.length - n, mean: avg('return'), median: n ? (sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2 : null,
    up: ratio(s => s.return > 0), mfe: avg('mfe'), mae: avg('mae'), newLow: ratio(s => s.newLow), rebound20: ratio(s => s.mfe >= .2), rebound50: ratio(s => s.mfe >= .5) };
}
export function mapEvent(event, anchor) {
  const leg = event.legs[0];
  return { firstLow: leg ? anchor * leg.low / event.peakPrice : null, rebound: leg ? anchor * leg.high / event.peakPrice : null,
    finalLow: anchor * event.lowPrice / event.peakPrice, reboundGain: leg?.gain ?? null };
}
export function debtPlan(p) {
  const shares = Math.max(0, Math.floor(num(p.shares))), cash = Math.max(0, num(p.cash)), debt = Math.max(0, num(p.debt));
  const cushion = Math.max(0, num(p.cushion)), fee = Math.max(0, Math.min(.99, num(p.fee) / 100));
  const price = Math.max(0, num(p.sellPrice)), net = price * (1 - fee), lot = p.lot === false ? 1 : 100;
  const requiredCash = Math.max(0, debt + cushion - cash);
  const needed = requiredCash === 0 ? 0 : net > 0 ? Math.ceil(requiredCash / net / lot) * lot : Infinity;
  const sold = Math.min(shares, Math.max(0, Math.floor(num(p.sellQty, Number.isFinite(needed) ? needed : shares))));
  const remaining = shares - sold, afterCash = cash + sold * net - debt;
  return { needed: Number.isFinite(needed) ? needed : null, sold, remaining, afterCash, shortfall: Math.max(0, cushion - afterCash),
    risk: [.1, .2, .3].map(drop => remaining * price * drop), sufficient: needed <= shares };
}
export function valuations(rows, { capital, base, target, pe = 15 }) {
  return rows.map((r, i) => { const profit = finite(r.profit) ? Number(r.profit) : null, previous = i ? num(rows[i - 1].profit) : 0;
    return { ...r, eps: capital > 0 && profit != null ? profit / capital : null, growth: previous > 0 && profit != null ? profit / previous - 1 : null,
      currentPE: profit > 0 && capital > 0 ? base * capital / profit : null, targetPE: profit > 0 && capital > 0 ? target * capital / profit : null,
      impliedPrice: profit > 0 && capital > 0 && pe > 0 ? profit * pe / capital : null };
  });
}
export function aggregateBars(bars, period = 'day') {
  if (period === 'day') return bars;
  const result = [];
  for (const b of bars) {
    const d = new Date(b.time + 'T00:00:00Z');
    if (period === 'week') d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7);
    const key = period === 'month' ? b.time.slice(0, 7) : d.toISOString().slice(0, 10);
    const last = result.at(-1);
    if (last?.key === key) { last.high = Math.max(last.high, b.high); last.low = Math.min(last.low, b.low); last.close = b.close; last.volume += b.volume; last.amount = (last.amount || 0) + (b.amount || 0); }
    else result.push({ ...b, key });
  }
  return result;
}
export function movingAverage(bars, length) {
  let sum = 0;
  return bars.flatMap((b, i) => { sum += b.close; if (i >= length) sum -= bars[i - length].close;
    return i >= length - 1 ? [{ time: b.time, value: sum / length }] : []; });
}
