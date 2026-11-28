const { CALENDAR, SECTORS, bucket, rankAt, loadKlines, completedThrough, previousWorkday } = require('./sectorRotation');

const SPEC = Object.freeze({
  version: 'ma120-20261130-v1',
  start: '2026-11-30',
  warmupThrough: '2026-11-27',
  trendDays: 120,
  baseCost: 0.001,
  stressCost: 0.002,
  reviewSessions: 120,
});
const PATH = 'investment/sector-rotation/ma120-20261130-v1.json';
const COMPARATORS = ['trend', 'incumbent', 'equal'];
const CODES = SECTORS.map(({ code }) => code);
const DAY = 86_400_000;
const sum = numbers => numbers.reduce((left, right) => left + right, 0);
const round = number => Number(number.toFixed(8));

async function loadMarket({ from, through, after, fetcher = fetch }) {
  const calendar = await loadKlines(CALENDAR, from, through, fetcher);
  const dates = [...calendar.keys()].sort();
  if (dates.at(-1) <= after) return { dates };
  const panels = await Promise.all(CODES.map(async code => {
    const [front, adjusted, raw] = await Promise.all([
      loadKlines(code, from, through, fetcher),
      loadKlines(code, from, through, fetcher, { adjust: '2' }),
      loadKlines(code, from, through, fetcher, { adjust: '0', execution: true }),
    ]);
    return { code, front, adjusted, raw };
  }));
  return {
    dates,
    front: Object.fromEntries(panels.map(({ code, front }) => [code, front])),
    adjusted: Object.fromEntries(panels.map(({ code, adjusted }) => [code, adjusted])),
    raw: Object.fromEntries(panels.map(({ code, raw }) => [code, raw])),
  };
}

function quote(series, code, date) {
  const bar = series[code]?.get(date);
  if (!bar) throw Error(code + ' 缺少 ' + date + ' 的完整日线');
  return bar;
}

function trendDistances(market, index) {
  const dates = market.dates.slice(index + 1 - SPEC.trendDays, index + 1);
  if (dates.length !== SPEC.trendDays) throw Error('120 日均线历史长度不足');
  return CODES.map(code => {
    const closes = dates.map(date => quote(market.adjusted, code, date).close);
    return closes.at(-1) / (sum(closes) / SPEC.trendDays) - 1;
  });
}

function targetWeights(market, index, distances) {
  for (const code of CODES) {
    for (const date of market.dates.slice(index - 20, index + 1)) quote(market.front, code, date);
  }
  const leaders = rankAt(market.front, market.dates, index).slice(0, 5).map(({ code }) => code);
  return {
    trend: distances.map(distance => distance > 0 ? 0.1 : 0),
    incumbent: CODES.map(code => leaders.includes(code) ? 0.2 : 0),
    equal: CODES.map(() => 0.1),
  };
}

const choices = weights => CODES.filter((_, index) => weights[index] > 0);

function decision(date, weights, prior) {
  return { date, groups: Object.fromEntries(COMPARATORS.map(key => {
    const selected = choices(weights[key]);
    const previous = prior?.groups[key].selected ?? [];
    return [key, {
      selected,
      entered: selected.filter(code => !previous.includes(code)),
      exited: previous.filter(code => !selected.includes(code)),
    }];
  })) };
}

async function lockOpeningPlan(now = new Date(), load = loadMarket) {
  if (now >= new Date(SPEC.start + 'T09:30:00+08:00')) {
    throw Error('开盘计划只能在验证开始前锁定');
  }
  const market = await load({ from: '2026-02-01', through: SPEC.warmupThrough });
  if (market.dates.at(-1) !== SPEC.warmupThrough) throw Error('锁定日行情尚未到齐');
  const reviewIndex = market.dates.findIndex(date => bucket(date) === bucket(SPEC.warmupThrough));
  if (reviewIndex < SPEC.trendDays - 1) throw Error('锁定日均线历史不足');
  const weights = targetWeights(market, reviewIndex, trendDistances(market, reviewIndex));
  return {
    version: SPEC.version, lockedAt: now.toISOString(), asOf: SPEC.warmupThrough, codes: CODES,
    opening: decision(market.dates[reviewIndex], weights), weights,
    distances: trendDistances(market, market.dates.length - 1).map(round),
  };
}

function newAccount() {
  return {
    cash: 1, positions: CODES.map(() => 0), value: 1, peak: 1, worst: 0,
    returnSum: 0, returnSquares: 0, samples: 0,
  };
}

function initialState(seed) {
  if (seed.version !== SPEC.version || seed.asOf !== SPEC.warmupThrough ||
      seed.codes.join(',') !== CODES.join(',') || Date.parse(seed.lockedAt) >= Date.parse(SPEC.start + 'T09:30:00+08:00')) {
    throw Error('开盘计划与锁定规则不一致');
  }
  const accounts = () => Object.fromEntries(COMPARATORS.map(key => [key, newAccount()]));
  return {
    version: SPEC.version, asOf: seed.asOf, generatedAt: seed.lockedAt,
    base: accounts(), stress: accounts(), pending: { ...seed.weights }, stressPending: { ...seed.weights },
    signals: [seed.opening], distances: seed.distances, days: [], review: null,
  };
}

function executableInputs(market, index) {
  const date = market.dates[index], yesterday = market.dates[index - 1];
  return CODES.map(code => {
    const adjusted = quote(market.adjusted, code, date);
    const previous = quote(market.adjusted, code, yesterday);
    const raw = quote(market.raw, code, date);
    const gap = adjusted.open / previous.close;
    const intraday = adjusted.close / adjusted.open;
    if (![gap, intraday, gap * intraday].every(ratio => Number.isFinite(ratio) && ratio > 0.8 && ratio < 1.2)) {
      throw Error(code + ' ' + date + ' 复权价格跳变，等待核对');
    }
    const limit = ratio => Math.round(raw.previousClose * ratio * 1000 + 1e-7) / 1000;
    return { gap, intraday, canBuy: raw.volume > 0 && raw.open < limit(1.1), canSell: raw.volume > 0 && raw.open > limit(0.9) };
  });
}

function rebalanceAtOpen(account, input, weights, cost) {
  const openValue = account.cash + sum(account.positions);
  const legs = weights.map((weight, i) => weight * openValue - account.positions[i]);
  const tolerance = 1e-8 * openValue;
  if (legs.some((leg, index) => (leg > tolerance && !input[index].canBuy) ||
      (leg < -tolerance && !input[index].canSell))) return 'deferred';
  for (const [index, leg] of legs.entries()) {
    if (leg >= -tolerance) continue;
    account.positions[index] += leg;
    account.cash -= leg * (1 - cost);
  }
  const buys = sum(legs.filter(leg => leg > tolerance));
  const scale = buys > 0 ? Math.max(0, Math.min(1, account.cash / (buys * (1 + cost)))) : 0;
  for (const [index, leg] of legs.entries()) {
    if (leg <= tolerance) continue;
    account.positions[index] += leg * scale;
    account.cash -= leg * scale * (1 + cost);
  }
  return 'filled';
}

function markDay(account, input, weights, cost) {
  account.positions = account.positions.map((value, index) => value * input[index].gap);
  const execution = weights ? rebalanceAtOpen(account, input, weights, cost) : 'none';
  account.positions = account.positions.map((value, index) => value * input[index].intraday);
  const invested = sum(account.positions);
  const value = account.cash + invested;
  const daily = value / account.value - 1;
  account.value = value;
  account.peak = Math.max(account.peak, value);
  account.worst = Math.min(account.worst, value / account.peak - 1);
  account.returnSum += daily;
  account.returnSquares += daily * daily;
  account.samples += 1;
  return {
    execution, total: round(value - 1), daily: round(daily),
    drawdown: round(value / account.peak - 1), maxDrawdown: round(account.worst),
    exposure: round(invested / value), held: choices(account.positions),
  };
}

function sharpe(account) {
  const { samples, returnSum, returnSquares } = account;
  if (samples < 2) return null;
  const variance = (returnSquares - returnSum * returnSum / samples) / (samples - 1);
  return variance > 0 ? round(returnSum / samples / Math.sqrt(variance) * Math.sqrt(252)) : null;
}

function scoreReview(state) {
  const base = state.base;
  const candidateSharpe = sharpe(base.trend);
  const comparisons = ['incumbent', 'equal'].map(key => {
    const referenceSharpe = sharpe(base[key]);
    return {
      reference: key,
      net: base.trend.value >= base[key].value,
      drawdown: base.trend.worst > base[key].worst,
      sharpe: candidateSharpe !== null && referenceSharpe !== null && candidateSharpe > referenceSharpe,
      stress: state.stress.trend.value >= state.stress[key].value,
    };
  });
  return {
    asOf: state.asOf, sessions: state.days.length, comparisons,
    passed: comparisons.every(check => check.net && check.drawdown && check.sharpe && check.stress),
  };
}

function advance(state, market, now) {
  const baseIndex = market.dates.indexOf(state.asOf);
  if (baseIndex < 0) throw Error('无法和已发布的最后交易日对齐');
  const next = structuredClone(state);
  for (let i = baseIndex + 1; i < market.dates.length; i++) {
    const date = market.dates[i];
    if (date < SPEC.start || date > completedThrough(now)) continue;
    const input = executableInputs(market, i);
    const groups = {};
    for (const key of COMPARATORS) {
      const placed = markDay(next.base[key], input, next.pending[key], SPEC.baseCost);
      // The same blocked order is retried for each book. Fees can change very small rebalances.
      const stress = markDay(next.stress[key], input, next.stressPending[key], SPEC.stressCost);
      if (placed.execution === 'filled') next.pending[key] = null;
      if (stress.execution === 'filled') next.stressPending[key] = null;
      groups[key] = placed;
    }
    const distances = trendDistances(market, i);
    next.distances = distances.map(round);
    if (bucket(date) !== bucket(market.dates[i - 1])) {
      const weights = targetWeights(market, i, distances);
      next.pending = { ...weights };
      next.stressPending = { ...weights };
      next.signals.push(decision(date, weights, next.signals.at(-1)));
    }
    next.asOf = date;
    next.generatedAt = now.toISOString();
    next.days.push({ date, groups });
    if (next.days.length === SPEC.reviewSessions) next.review = scoreReview(next);
  }
  return next;
}

function checkedState(state, seed) {
  if (!state) return initialState(seed);
  if (state.version !== SPEC.version) throw Error('前瞻账本规则版本不一致');
  return state;
}

function published(state, seed) {
  const data = checkedState(state, seed);
  return {
    spec: SPEC, lockedAt: seed.lockedAt, asOf: data.asOf, generatedAt: data.generatedAt,
    source: '东方财富日线', opening: seed.opening,
    sectors: SECTORS.map((sector, i) => ({ ...sector, distance: data.distances[i] })),
    signal: data.signals.at(-1), signals: data.signals.slice(-8),
    pending: Object.fromEntries(COMPARATORS.map(key => [key, Boolean(data.pending[key])])),
    days: data.days, review: data.review,
    stress: Object.fromEntries(COMPARATORS.map(key => [key, round(data.stress[key].value - 1)])),
    sharpe: Object.fromEntries(COMPARATORS.map(key => [key, sharpe(data.base[key])])),
  };
}

async function refresh({ store, seed, now = new Date(), load = loadMarket }) {
  const through = completedThrough(now);
  let saved = await store.read(PATH);
  let market;
  for (let attempt = 0; attempt < 3; attempt++) {
    const state = checkedState(saved?.value, seed);
    if (saved && state.asOf >= previousWorkday(through)) {
      return { status: through < SPEC.start ? 'scheduled' : 'current', date: state.asOf, sessions: state.days.length };
    }
    if (through >= SPEC.start && !market) {
      const from = new Date(Date.parse(state.asOf) - 270 * DAY).toISOString().slice(0, 10);
      market = await load({ from, through, after: state.asOf });
    }
    const advanced = market?.dates.at(-1) > state.asOf ? advance(state, market, now) : state;
    if (saved && advanced === state) return { status: 'waiting', date: state.asOf, sessions: state.days.length };
    try {
      await store.write(PATH, advanced, saved?.etag ?? null);
      return {
        status: through < SPEC.start ? 'scheduled' : advanced === state ? 'waiting' : 'published',
        date: advanced.asOf, sessions: advanced.days.length,
      };
    } catch (error) {
      if (!store.isConflict(error)) throw error;
      saved = await store.read(PATH);
    }
  }
  throw Error('前瞻账本正在更新，请重试');
}

module.exports = { SPEC, PATH, advance, initialState, lockOpeningPlan, published, refresh };
