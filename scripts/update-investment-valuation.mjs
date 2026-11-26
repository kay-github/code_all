import { readFile, rename, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const output = new URL('../tools/investment-theory/valuations.json', import.meta.url);
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

function isDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const millis = Date.parse(value);
  return Number.isFinite(millis) && new Date(millis).toISOString().slice(0, 10) === value;
}

export function indexSnapshot(code, name, valuations, closes, now = new Date()) {
  if (!Array.isArray(valuations) || !Array.isArray(closes)) throw new Error('日终数据格式变化');
  const today = dateFormat.format(now);
  const cutoff = code === 'HSI' ? '16:15' : '15:05';
  const closeByDate = new Map(closes.filter(row => row.trdCode === code && positive(row.pxClose))
    .map(row => [row.trdDt, row.pxClose]));
  const accepted = valuations.filter(row => row.trdCode === code && isDay(row.trdDt) &&
    (row.trdDt < today || (row.trdDt === today && timeFormat.format(now) >= cutoff)) &&
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
    ]);
  if (history.length < 2) throw new Error('估值历史不足');
  return { code, name, date, close: round(closeByDate.get(date)), pe: last.pETtm, pb: last.pBLf, history };
}

export async function refresh(previous, fetchRows, now = new Date()) {
  const results = await Promise.allSettled(indices.map(async ([code, name]) => {
    const [valuations, closes] = await Promise.all([
      fetchRows(code, 'valuation_percentile'), fetchRows(code, 'eod_price'),
    ]);
    return indexSnapshot(code, name, valuations, closes, now);
  }));
  const warnings = [];
  let succeeded = 0;
  const next = indices.map(([code], position) => {
    const result = results[position];
    const saved = previous.find(row => row.code === code);
    if (result.status === 'fulfilled' && (!saved || result.value.date >= saved.date)) {
      succeeded++;
      const snapshot = result.value;
      // Keep older published observations if the source shortens its history.
      const earlier = saved?.history.filter(([day]) => day < snapshot.history[0][0]) ?? [];
      return earlier.length ? { ...snapshot, history: earlier.concat(snapshot.history) } : snapshot;
    }
    warnings.push(code + ' · ' + (result.status === 'rejected' ? result.reason.message : '来源日期早于已发布日期'));
    return saved;
  });
  if (!succeeded || next.some(row => !row)) throw new Error(warnings.join(' / '));
  return { next, warnings };
}

async function fetchRows(code, kind) {
  const response = await fetch(new URL('index_' + kind + '_' + code + '.json', source), {
    signal: AbortSignal.timeout(25_000),
    headers: { 'Cache-Control': 'no-cache' },
  });
  if (!response.ok) throw new Error(kind + ' HTTP ' + response.status);
  return response.json();
}

async function main() {
  const text = await readFile(output, 'utf8').catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return '';
  });
  const { next, warnings } = await refresh(text ? JSON.parse(text).indices : [], fetchRows);
  for (const warning of warnings) console.warn('::warning::' + warning);
  const payload = '{\n  "indices": [\n' + next.map(item => '    ' + JSON.stringify(item)).join(',\n') + '\n  ]\n}\n';
  if (payload !== text) {
    const temp = new URL(output.href + '.tmp');
    await writeFile(temp, payload);
    await rename(temp, output);
    console.log('Published valuation snapshot');
  } else {
    console.log('No changes');
  }
  console.log(next.map(item => item.code + ' ' + item.date + ' (' + item.history.length + ' days)').join(' / '));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
