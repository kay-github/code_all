const source = 'https://cdn.efunds.com.cn/etf-net/';
export const indices = [
  ['000001', '上证指数'], ['000300', '沪深300'], ['399006', '创业板指'],
  ['000688', '科创50'], ['399001', '深证成指'], ['HSI', '恒生指数'], ['000985', '中证全指（全A）'],
];
const dateFormat = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', dateStyle: 'short' });
const timeFormat = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', timeStyle: 'short' });
const positive = value => Number.isFinite(value) && value > 0;
const percentile = value => Number.isFinite(value) && value >= 0 && value <= 100;
const round = value => Math.round(value * 100) / 100;
const hasMultiples = point => positive(point?.[5]) && positive(point?.[6]);

function isDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const millis = Date.parse(value);
  return Number.isFinite(millis) && new Date(millis).toISOString().slice(0, 10) === value;
}

function closedSession(code, now) {
  const today = dateFormat.format(now);
  const cutoff = code === 'HSI' ? '16:15' : '15:05';
  const includeToday = timeFormat.format(now) >= cutoff;
  return day => day < today || (day === today && includeToday);
}

function latestCloseDate(code, closes, now) {
  if (!Array.isArray(closes)) throw new Error('收盘点位格式变化');
  const closed = closedSession(code, now);
  const last = closes.reduce((day, row) =>
    row.trdDt > day && row.trdCode === code && positive(row.pxClose) && isDay(row.trdDt) &&
      closed(row.trdDt) ? row.trdDt : day, '');
  if (!last) throw new Error('缺少已收盘点位');
  return last;
}

export function indexSnapshot(code, name, valuations, closes, now = new Date()) {
  if (!Array.isArray(valuations) || !Array.isArray(closes)) throw new Error('日终数据格式变化');
  const closed = closedSession(code, now);
  const closeByDate = new Map(closes.filter(row => row.trdCode === code && positive(row.pxClose))
    .map(row => [row.trdDt, row.pxClose]));
  const accepted = valuations.filter(row => row.trdCode === code && isDay(row.trdDt) &&
    closed(row.trdDt) &&
    positive(row.pETtm) && positive(row.pBLf) && percentile(row.pETtm10Y) && percentile(row.pBLf10Y));
  const usable = [...new Map(accepted.map(row => [row.trdDt, row])).values()]
    .sort((a, b) => a.trdDt.localeCompare(b.trdDt));
  const last = usable.findLast(row => closeByDate.has(row.trdDt) &&
    percentile(row.pETtmBgn) && percentile(row.pBLfBgn));
  if (!last) throw new Error('缺少同日收盘点位或两种口径的 PE、PB 分位');
  const date = last.trdDt;
  // Bgn is the provider's percentile from the start of its history through that trading day.
  const history = usable.filter(row => row.trdDt <= date)
    .map(row => [
      row.trdDt, round(row.pETtm10Y), round(row.pBLf10Y),
      percentile(row.pETtmBgn) ? round(row.pETtmBgn) : null,
      percentile(row.pBLfBgn) ? round(row.pBLfBgn) : null,
      row.pETtm, row.pBLf,
    ]);
  if (history.length < 2) throw new Error('估值历史不足');
  return { code, name, date, close: round(closeByDate.get(date)), pe: last.pETtm, pb: last.pBLf, history };
}

export async function refresh(previous, load, now = new Date(), {
  skipCurrent = false, etags = {}, knownCloseDates = {},
} = {}) {
  const closeDates = {};
  const nextETags = {};
  const results = await Promise.allSettled(indices.map(async ([code, name]) => {
    const closes = await load(code, 'eod_price');
    const closeDate = latestCloseDate(code, closes, now);
    closeDates[code] = closeDate;
    const saved = previous.find(row => row.code === code);
    const savedPoint = saved?.history.at(-1);
    if (skipCurrent && closeDate === saved?.date && fullRanks(savedPoint) && hasMultiples(savedPoint)) return saved;
    const etag = hasMultiples(savedPoint) && closeDate === knownCloseDates[code] ? etags[code] : undefined;
    let receivedETag;
    const valuations = await load(code, 'valuation_percentile', {
      etag,
      onETag: value => { receivedETag = value; },
    });
    if (valuations === null && etag) return saved;
    const snapshot = indexSnapshot(code, name, valuations, closes, now);
    if (receivedETag) nextETags[code] = receivedETag;
    return snapshot;
  }));
  const warnings = [];
  let succeeded = 0;
  const next = indices.map(([code], position) => {
    const result = results[position];
    const saved = previous.find(row => row.code === code);
    if (result.status === 'fulfilled' && (!saved || result.value.date >= saved.date)) {
      succeeded++;
      const snapshot = result.value;
      if (snapshot === saved) return saved;
      // Keep older published observations if the source shortens its history.
      const earlier = saved?.history.filter(([day]) => day < snapshot.history[0][0]) ?? [];
      return earlier.length ? { ...snapshot, history: earlier.concat(snapshot.history) } : snapshot;
    }
    warnings.push(code + ' · ' + (result.status === 'rejected' ? result.reason.message : '来源日期早于已发布日期'));
    return saved;
  });
  if ((!succeeded && !(skipCurrent && Object.keys(closeDates).length)) || next.some(row => !row)) {
    throw new Error(warnings.join(' / '));
  }
  return { next, warnings, closeDates, etags: nextETags };
}

export async function fetchRows(code, kind, { timeout = 25_000, etag, onETag } = {}) {
  const headers = { 'Cache-Control': 'no-cache' };
  if (etag) headers['If-None-Match'] = etag;
  const response = await fetch(new URL('index_' + kind + '_' + code + '.json', source), {
    signal: AbortSignal.timeout(timeout),
    headers,
  });
  if (response.status === 304 && etag) return null;
  if (!response.ok) throw new Error(kind + ' HTTP ' + response.status);
  const rows = await response.json();
  onETag?.(response.headers.get('etag'));
  return rows;
}

export const valuationPath = 'investment/v1/index-valuations.json';
const fullRanks = point => percentile(point?.[3]) && percentile(point?.[4]);

export function valuationSnapshot(fallback, saved) {
  const indices = fallback.indices.map(row => {
    const current = saved?.indices?.find(item => item.code === row.code);
    if (!current || current.date < row.date) return row;
    if (current.date === row.date && hasMultiples(row.history.at(-1)) && !hasMultiples(current.history.at(-1))) return row;
    return current;
  });
  const closeDates = { ...fallback.closeDates };
  for (const [code, day] of Object.entries(saved?.closeDates ?? {})) {
    if (!closeDates[code] || closeDates[code] < day) closeDates[code] = day;
  }
  return { indices, closeDates };
}

const cloudFetch = (code, kind, options) => fetchRows(code, kind, {
  ...options, timeout: kind === 'eod_price' ? 8_000 : 18_000,
});

export async function refreshStoredValuations(store, fallback, load = cloudFetch, now = new Date()) {
  let saved = await store.read(valuationPath);
  const baseline = valuationSnapshot(fallback, saved?.value);
  const { next, warnings, closeDates, etags } = await refresh(baseline.indices, load, now, {
    skipCurrent: true, etags: saved?.value.etags, knownCloseDates: baseline.closeDates,
  });
  const update = { indices: next, closeDates };
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = valuationSnapshot(fallback, saved?.value);
    const merged = valuationSnapshot(update, current);
    const previousETags = saved?.value.etags ?? {};
    const changed = !saved || merged.indices.some(row => row !== saved.value.indices.find(item => item.code === row.code)) ||
      Object.entries(merged.closeDates).some(([code, date]) => current.closeDates[code] !== date) ||
      Object.entries(etags).some(([code, etag]) => previousETags[code] !== etag);
    if (changed) {
      try {
        await store.write(valuationPath, { ...merged, etags: { ...previousETags, ...etags } }, saved?.etag ?? null);
      } catch (error) {
        if (!store.isConflict(error)) throw error;
        saved = await store.read(valuationPath);
        continue;
      }
    }
    return { changed, checkedAt: now.toISOString(), warnings, indices: merged.indices.map(({ code, date }) => ({
      code, date, closeDate: merged.closeDates[code] ?? null,
    })) };
  }
  throw new Error('估值快照同时更新，请稍后再试');
}
