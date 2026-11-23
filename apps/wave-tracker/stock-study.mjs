import { impulseChecks } from '../../tools/wave-tracker/scenarios.mjs';

const PRICE = 2, LOW = 3, CLOSE = 4;
const EPS = 1e-8;
const cents = n => Number(n.toFixed(2));
const ratio = n => Number(n.toFixed(4));

function monday(day) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  return date.toISOString().slice(0, 10);
}

export function aggregateWeeks(daily, session = daily.at(-1)[0]) {
  const calendar = new Map();
  for (const row of daily) {
    if (row[0] > session) continue;
    const key = monday(row[0]);
    if (!calendar.has(key)) calendar.set(key, { key, bar: [...row], highOn: row[0], lowOn: row[0] });
    const week = calendar.get(key);
    const bar = week.bar;
    if (row[PRICE] > bar[PRICE]) { bar[PRICE] = row[PRICE]; week.highOn = row[0]; }
    if (row[LOW] < bar[LOW]) { bar[LOW] = row[LOW]; week.lowOn = row[0]; }
    bar[0] = row[0];
    bar[CLOSE] = row[CLOSE];
  }
  const weeks = [...calendar.values()];
  const weekDay = new Date(`${session}T00:00:00Z`).getUTCDay();
  return weeks.filter(week => week.key < monday(session) || weekDay === 5);
}

function points(rows, dates, labels, weekly) {
  const anchors = dates.map((day, i) => {
    const high = i % 2 === 0;
    const idx = rows.findIndex(w => weekly ? w.key === monday(day) : w.bar[0] === day);
    const row = rows[idx];
    if (!row) throw new Error(`行情没有定义的锚点 ${day}`);
    if (weekly && day !== (high ? row.highOn : row.lowOn)) throw new Error(`锚点 ${day} 与该周期极值不一致`);
    return { date: day, bar: row.bar[0], price: row.bar[high ? PRICE : LOW], label: labels[i], idx };
  });
  if (anchors.some((point, i) => i > 0 && point.idx <= anchors[i - 1].idx)) throw new Error('波浪锚点时间有重叠');
  if (anchors.some((point, i) => i > 0 && (i % 2 ? point.price >= anchors[i - 1].price : point.price <= anchors[i - 1].price))) throw new Error('波浪锚点方向与高低价不一致');
  return anchors;
}

function currentLow(rows, start, label) {
  const tail = rows.slice(start.idx + 1);
  if (!tail.length) return null;
  const index = tail.reduce((best, row, i) => row.bar[LOW] < tail[best].bar[LOW] ? i : best, 0);
  const row = tail[index];
  return { date: row.lowOn || row.bar[0], bar: row.bar[0], price: row.bar[LOW], label, idx: start.idx + 1 + index };
}

function confirmation(rows, low, level) {
  const sub = rows.slice(low.idx + 1);
  let streak = 0;
  for (const row of sub) {
    streak = row.bar[CLOSE] > level + EPS ? streak + 1 : 0;
    if (streak === 2) return row.bar[0];
  }
  return null;
}

function abc(rows, setting, weekly) {
  const labels = weekly ? ['起点', 'A', 'B'] : ['起点', 'a', 'b'];
  const p = points(rows, setting.main, labels, weekly);
  const [origin, a, b] = p;
  const size = origin.price - a.price;
  const watch = setting.watch ? points(rows, [setting.watch], ['反弹高点'], weekly)[0].price : b.price;
  const low = currentLow(rows, b, weekly ? 'C?' : 'c?');
  if (!low) throw new Error('ABC 缺少 B 以后的行情');
  const verifiedOn = confirmation(rows, low, watch);
  return { type: 'abc', anchors: [...p, low], progress: verifiedOn ? (weekly ? 'C结束候选' : 'c结束候选') : (weekly ? 'C浪延伸中，末端待确认' : 'c段延伸中，末端待确认'),
    ratioLabel: weekly ? 'C / A' : 'c / a', ratio: ratio((b.price - low.price) / size), recovery: ratio((b.price - a.price) / size),
    levels: [.618, .809, 1, 1.236, 1.382].map(r => ({ label: `${r} 倍`, price: cents(b.price - r * size) })).filter(p => p.price > 0),
    floor: cents(low.price), watch: cents(watch), verifiedOn, unit: weekly ? '周' : '日', elapsed: rows.length - 1 - b.idx };
}

function impulse(rows, setting, weekly) {
  const p = points(rows, setting.alt, ['起点', '1', '2', '3', '4'], weekly);
  const [origin, one, two, three, four] = p;
  const last = p.at(-1);
  const low = currentLow(rows, last, four ? '5?' : '3?');
  if (!low) throw new Error('五浪备选缺少末段行情');
  const all = [...p, low];
  const invalid = impulseChecks(all, 'down').filter(message => message !== '第3浪尚未越过第1浪终点' || Boolean(four));
  const w1 = origin.price - one.price;
  const w3 = two.price - (three || low).price;
  const fiveMin = four && w3 < w1 ? cents(four.price - w3) : null;
  const floor = cents(low.price);
  const watch = cents(last.price);
  const verifiedOn = confirmation(rows, low, watch);
  const progress = invalid.length ? '当前普通五浪数法失效' : verifiedOn ? `${four ? '5' : '3'}浪低点候选，已连续收复其起跌位` : four ? '第5浪延伸中，末端待确认' : '第3浪发展中，尚无第4浪确认';
  return { type: 'impulse', anchors: all, progress, invalid, ratioLabel: '3 / 1', ratio: ratio(w3 / w1), recovery: ratio((two.price - one.price) / w1),
    levels: [{ label: '3/1 = 1.618', price: cents(two.price - 1.618 * w1) }].filter(p => p.price > 0),
    fifthRatio: four ? ratio((four.price - low.price) / w1) : null, overlap: cents(one.price), shortestLine: fiveMin > 0 ? fiveMin : null,
    floor, watch, verifiedOn, unit: weekly ? '周' : '日', elapsed: rows.length - 1 - last.idx };
}

function review(rows, setting, weekly) {
  const main = abc(rows, setting, weekly);
  const alt = impulse(rows, setting, weekly);
  const first = Math.min(main.anchors[0].idx, alt.anchors[0].idx);
  const rejected = setting.rejected ? impulse(rows, { alt: setting.rejected }, weekly) : null;
  return { bars: rows.slice(Math.max(0, first - 8)).map(r => r.bar), main, alt, reason: setting.reason,
    rejected: rejected ? { anchors: rejected.anchors, invalid: rejected.invalid } : null, close: rows.at(-1).bar[CLOSE], date: rows.at(-1).bar[0] };
}

export function buildStudy(item, bars, date) {
  const daily = bars.filter(row => row[0] <= date).map(bar => ({ bar }));
  const weekly = aggregateWeeks(bars, date);
  return { symbol: item.symbol, name: item.name, track: item.track, day: review(daily, item.day, false), week: review(weekly, item.week, true) };
}

if (process.argv.includes('--stdin')) {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const bundle = JSON.parse(input);
  const results = bundle.items.map(({ item, bars, compared }) => ({ ...buildStudy(item, bars, bundle.date), compared }));
  process.stdout.write(JSON.stringify({ revision: bundle.revision, date: bundle.date, basis: bundle.basis, results }) + '\n');
}
