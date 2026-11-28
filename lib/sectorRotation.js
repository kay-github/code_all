const PATH = 'investment/sector-rotation/v1.json';
const DAY = 86_400_000;
const PERIOD_ANCHOR = Date.parse('2024-01-01');
const LOOKBACK = 20;
const SLOTS = 5;
const COST = 0.001;
const CALENDAR = '000001';
const SECTORS = [
  ['512690', '酒类'], ['515030', '新能源车'], ['515790', '光伏'],
  ['512760', '芯片'], ['515220', '煤炭'], ['512170', '医疗'],
  ['516960', '机械设备'], ['512710', '军工龙头'], ['512400', '有色金属'], ['512800', '银行'],
].map(([code, name]) => ({ code, name }));

const clock = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short',
});
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const bucket = date => Math.floor((Date.parse(date) - PERIOD_ANCHOR) / (14 * DAY));
const asDate = stamp => new Date(stamp).toISOString().slice(0, 10);
const rounded = value => Number(value.toFixed(6));

function completedThrough(now = new Date()) {
  const [day, time] = clock.format(now).split(' ');
  return time >= '15:15' ? day : asDate(Date.parse(day) - DAY);
}

function parseKlines(payload, code, through, execution = false) {
  const data = payload?.data;
  if (data?.code !== code || !Array.isArray(data.klines)) throw Error(code + ' 日线缺失');
  const bars = new Map();
  for (const line of data.klines) {
    const [date, openText, closeText, volumeText, changeText] = line.split(',');
    if (!datePattern.test(date)) throw Error(code + ' 交易日无效');
    if (date > through) continue;
    const open = Number(openText), close = Number(closeText);
    if (!Number.isFinite(open) || !Number.isFinite(close) || open <= 0 || close <= 0 || bars.has(date)) throw Error(code + ' 日线无效');
    if (execution) {
      const volume = Number(volumeText), change = Number(changeText);
      if (!volumeText || !changeText || !Number.isFinite(volume) || volume < 0 || !Number.isFinite(change) || close - change <= 0) {
        throw Error(code + ' 成交量或参考昨收无效');
      }
      bars.set(date, { open, close, volume, previousClose: close - change });
    } else {
      bars.set(date, { open, close });
    }
  }
  return bars;
}

async function loadKlines(code, from, through, fetcher, { adjust = code === CALENDAR ? '0' : '1', execution = false } = {}) {
  const params = new URLSearchParams({
    secid: '1.' + code, klt: '101', fqt: adjust,
    beg: from.replaceAll('-', ''), end: through.replaceAll('-', ''),
    fields1: 'f1,f2,f3,f4,f5,f6', fields2: execution ? 'f51,f52,f53,f56,f60' : 'f51,f52,f53',
  });
  const hosts = ['push2his.eastmoney.com', '33.push2his.eastmoney.com'];
  for (const host of hosts) {
    try {
      const response = await fetcher('https://' + host + '/api/qt/stock/kline/get?' + params, {
        signal: AbortSignal.timeout(6_500),
      });
      if (!response.ok) throw Error('HTTP ' + response.status);
      const bars = parseKlines(await response.json(), code, through, execution);
      if (bars.size < 100) throw Error('历史长度不足');
      return bars;
    } catch (error) {
      if (host === hosts.at(-1)) throw Error(code + ' 行情不可用', { cause: error });
    }
  }
}

function isWorkday(date) {
  const day = new Date(date + 'T00:00:00Z').getUTCDay();
  return day !== 0 && day !== 6;
}

function previousWorkday(through) {
  let date = through;
  while (!isWorkday(date)) date = asDate(Date.parse(date) - DAY);
  return date;
}

function rankAt(series, dates, i, useSplit = true) {
  return SECTORS.map(sector => {
    const bars = series[sector.code];
    const return10 = bars.get(dates[i]).close / bars.get(dates[i - 10]).close - 1;
    let intraday = 0;
    let overnight = 0;
    for (let j = i - LOOKBACK + 1; j <= i; j++) {
      const { open, close } = bars.get(dates[j]);
      intraday += close / open - 1;
      overnight += open / bars.get(dates[j - 1]).close - 1;
    }
    return { ...sector, return10, score: intraday - overnight };
  }).sort((a, b) => (useSplit ? b.score - a.score : b.return10 - a.return10) || a.code.localeCompare(b.code));
}

function buildChanges(series, dates, useSplit) {
  const changes = [];
  let previous = [];
  for (let i = LOOKBACK; i < dates.length; i++) {
    const date = dates[i];
    if (bucket(date) === bucket(dates[i - 1])) continue;
    const selected = rankAt(series, dates, i, useSplit).slice(0, SLOTS).map(row => row.code);
    changes.push({
      signalDate: date, referenceDate: dates[i + 1] ?? null, selected,
      entered: selected.filter(code => !previous.includes(code)),
      exited: previous.filter(code => !selected.includes(code)),
    });
    previous = selected;
  }
  return changes;
}
function backtest(series, dates, changes) {
  const portfolio = { weights: SECTORS.map(() => 0), value: 1, high: 1, drawdown: 0 };
  const benchmark = { weights: SECTORS.map(() => 0), value: 1, high: 1, drawdown: 0 };
  const targets = new Map(changes.filter(change => change.referenceDate)
    .map(change => [change.referenceDate, change.selected]));
  const start = targets.keys().next().value;
  for (let i = dates.indexOf(start); i >= 0 && i < dates.length; i++) {
    const date = dates[i];
    const next = targets.get(date);
    const returns = SECTORS.map(({ code }) => series[code].get(date).close / series[code].get(dates[i - 1]).close - 1);
    for (const account of [portfolio, benchmark]) {
      const daily = account.weights.reduce((sum, weight, j) => sum + weight * returns[j], 0);
      account.value *= 1 + daily;
      account.weights = account.weights.map((weight, j) => weight * (1 + returns[j]) / (1 + daily));
      if (next) {
        const target = SECTORS.map(({ code }) => account === benchmark ? 1 / SECTORS.length : (next.includes(code) ? 1 / SLOTS : 0));
        const turnover = target.reduce((sum, weight, j) => sum + Math.abs(weight - account.weights[j]), 0);
        account.value *= 1 - turnover * COST;
        account.weights = target;
      }
      account.high = Math.max(account.high, account.value);
      account.drawdown = Math.min(account.drawdown, account.value / account.high - 1);
    }
  }
  return {
    start, end: dates.at(-1), legCost: COST,
    strategy: { total: rounded(portfolio.value - 1), drawdown: rounded(portfolio.drawdown) },
    benchmark: { total: rounded(benchmark.value - 1), drawdown: rounded(benchmark.drawdown) },
  };
}

function buildSnapshot(series, now = new Date()) {
  const through = completedThrough(now);
  const dates = [...series[CALENDAR].keys()].filter(date => date <= through).sort();
  const asOf = dates.at(-1);
  if (dates.length < 100 || Date.parse(through) - Date.parse(asOf) > 14 * DAY) {
    throw Error('上证指数交易日历缺失或过旧');
  }
  for (const { code } of SECTORS) {
    const bars = series[code];
    if (dates.some(date => !bars.has(date)) || [...bars.keys()].some(date => date <= through && !series[CALENDAR].has(date))) {
      throw Error(code + ' 与市场交易日历不一致');
    }
  }

  const changes = buildChanges(series, dates, true);
  const baseline = buildChanges(series, dates, false);
  const latest = changes.at(-1);
  const current = rankAt(series, dates, dates.length - 1).map((row, index) => {
    const selected = latest.selected.includes(row.code);
    return {
      ...row, rank: index + 1, return10: rounded(row.return10), score: rounded(row.score),
      signal: latest.entered.includes(row.code) ? 'enter' : latest.exited.includes(row.code) ? 'exit' : selected ? 'hold' : 'watch',
    };
  });
  return {
    schema: 1, asOf, generatedAt: now.toISOString(),
    source: '东方财富日线', current, latest,
    history: changes.slice(-9, -1).reverse(),
    backtest: { ...backtest(series, dates, changes), momentum: backtest(series, dates, baseline).strategy },
  };
}

async function fetchSnapshot({ now = new Date(), fetcher = fetch } = {}) {
  const through = completedThrough(now);
  const from = asDate(Date.parse(through) - 900 * DAY);
  const codes = [CALENDAR, ...SECTORS.map(sector => sector.code)];
  const pairs = await Promise.all(codes.map(async code => [code, await loadKlines(code, from, through, fetcher)]));
  return buildSnapshot(Object.fromEntries(pairs), now);
}

async function refreshStoredSnapshot({ store, seed, now = new Date(), load = fetchSnapshot }) {
  let existing = await store.read(PATH);
  const expected = previousWorkday(completedThrough(now));
  if (existing?.value?.asOf >= expected) return { status: 'current', date: existing.value.asOf };
  const snapshot = await load({ now });
  if (snapshot.asOf < seed.asOf) throw Error('行情早于发布快照');
  for (let attempt = 0; attempt < 3; attempt++) {
    if (existing?.value?.asOf >= snapshot.asOf) {
      return { status: 'unchanged', date: existing.value.asOf };
    }
    try {
      await store.write(PATH, snapshot, existing?.etag ?? null);
      return { status: 'published', date: snapshot.asOf };
    } catch (error) {
      if (!store.isConflict(error)) throw error;
      existing = await store.read(PATH);
    }
  }
  throw Error('板块轮动快照正在更新，请重试');
}

module.exports = {
  PATH, CALENDAR, SECTORS, bucket, rankAt, loadKlines, previousWorkday,
  buildSnapshot, completedThrough, fetchSnapshot, parseKlines, refreshStoredSnapshot,
};
