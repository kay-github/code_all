const PATH = 'investment/crowding/sw-v1.json';
const MARKET = '801003';
const HISTORY_DAYS = 121;
const SOURCE = 'https://www.swsresearch.com/institute_sw/allIndex/releasedIndex';
const TREND = 'https://www.swsresearch.com/institute-sw/api/index_publish/trend/';
const QUOTES = 'https://push2his.eastmoney.com/api/qt/stock/kline/get';
const china = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short' });

const groups = [
  ['市场风格', [
    ['dividend', '红利', '中证红利 000922', '1.000922'],
    ['value', '传统蓝筹', '沪深300价值 000919', '1.000919'],
    ['small', '中小盘', '中证1000 000852', '1.000852'],
  ]],
  ['大金融', [
    ['bank', '银行', '申万银行', '801780'],
    ['nonbank', '非银金融', '申万非银金融', '801790'],
  ]],
  ['科技', [
    ['tmt', 'TMT', '电子、通信、计算机、传媒', '801080', '801770', '801750', '801760'],
    ['ai', 'AI', '中证人工智能主题 930713', '2.930713'],
    ['communication', '通信', '申万通信 · TMT 重点观察', '801770'],
  ]],
  ['制造', [
    ['equipment', '电力设备', '申万电力设备', '801730'],
    ['auto', '汽车', '申万汽车', '801880'],
    ['machinery', '机械设备', '申万机械设备', '801890'],
    ['defense', '国防军工', '申万国防军工', '801740'],
  ]],
  ['资源周期', [
    ['metals', '有色金属', '申万有色金属', '801050'],
    ['energy', '能源', '煤炭、石油石化', '801950', '801960'],
  ]],
  ['消费与防御', [
    ['consumer', '大消费', '申万消费', '801260'],
    ['medicine', '医药', '申万医药生物', '801150'],
    ['utility', '公用事业', '申万公用事业', '801160'],
  ]],
].map(([name, rows]) => ({
  name, directions: rows.map(([id, name, basis, ...codes]) => ({ id, name, basis, codes })),
}));

const directions = groups.flatMap(group => group.directions);
const official = directions.filter(row => !row.codes[0].includes('.'));
const references = directions.filter(row => row.codes[0].includes('.'));
const codes = [...new Set(official.flatMap(row => row.codes))];
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

function parseSeries(payload, code, through, from = '') {
  if (!Array.isArray(payload?.data)) throw Error(code + ' 缺少日线');
  const amounts = new Map();
  for (const row of payload.data) {
    const date = row?.bargaindate;
    if (!datePattern.test(date)) throw Error(code + ' 交易日无效');
    if (date > through || date < from) continue;
    const value = row.bargainsum;
    if (row.swindexcode !== code || !Number.isFinite(value) || value < 0 || amounts.has(date)) {
      throw Error(code + ' 成交额或交易日无效');
    }
    amounts.set(date, value);
  }
  return amounts;
}

async function fetchSeries(code, through, from) {
  const url = new URL(TREND);
  url.search = new URLSearchParams({ swindexcode: code, period: 'DAY' });
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(7500) });
    if (!response.ok) throw Error('HTTP ' + response.status);
    return parseSeries(await response.json(), code, through, from);
  } catch (error) {
    throw Error('申万 ' + code + ' 读取失败', { cause: error });
  }
}

function parseReference(payload, code, through, from) {
  const [market, symbol] = code.split('.');
  if (payload?.data?.code !== symbol || payload.data.market !== Number(market) || !Array.isArray(payload.data.klines)) {
    throw Error(code + ' 缺少指数日线');
  }
  const amounts = new Map();
  for (const row of payload.data.klines) {
    const [date, , , , , , raw] = row.split(',');
    if (!datePattern.test(date)) throw Error(code + ' 交易日无效');
    if (date > through || date < from) continue;
    if (!/^\d+(?:\.\d+)?$/.test(raw) || !Number.isFinite(Number(raw)) || amounts.has(date)) throw Error(code + ' 成交额无效');
    // East Money f57 is in yuan, while Shenwan bargainsum is in 100 million yuan.
    amounts.set(date, Number(raw) / 100_000_000);
  }
  return amounts;
}

async function fetchReference(code, through, from) {
  const url = new URL(QUOTES);
  url.search = new URLSearchParams({
    secid: code, klt: '101', fqt: '0', beg: from.replaceAll('-', ''), end: through.replaceAll('-', ''),
    fields1: 'f1,f2,f3,f4,f5,f6', fields2: 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61',
  });
  const response = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!response.ok) throw Error(code + ' HTTP ' + response.status);
  return parseReference(await response.json(), code, through, from);
}

function calculateDays(market, byCode) {
  const dates = [...market.keys()].sort().slice(-HISTORY_DAYS);
  return dates.map(date => {
    const total = market.get(date);
    if (!(total > 0)) throw Error('申万 A 指成交额缺失');
    const shares = Object.fromEntries(official.map(({ id, codes }) => {
      const amounts = codes.map(code => byCode.get(code)?.get(date));
      if (amounts.some(value => value === undefined)) return [id, null];
      const sum = amounts.reduce((total, value) => total + value, 0);
      if (sum > total) throw Error(id + ' 成交额超过基准');
      return [id, sum / total * 100];
    }));
    return { date, marketAmount: total, shares };
  });
}

async function addReferences(days, previous, load) {
  const from = days[0].date;
  const through = days.at(-1).date;
  const series = await Promise.allSettled(references.map(row => load(row.codes[0], through, from)));
  const previousByDate = new Map(previous.map(day => [day.date, day]));
  return days.map(({ date, marketAmount, shares }) => {
    const referenceAmounts = {};
    const referenceShares = Object.fromEntries(references.map(({ id }, index) => {
      const amount = series[index].value?.get(date) ?? previousByDate.get(date)?.referenceAmounts?.[id];
      if (!Number.isFinite(amount) || amount < 0 || amount > marketAmount) return [id, null];
      referenceAmounts[id] = amount;
      return [id, amount / marketAmount * 100];
    }));
    return { date, marketAmount, referenceAmounts, shares: { ...shares, ...referenceShares } };
  });
}

function publicSnapshot(value, now = Date.now()) {
  const days = value?.days ?? [];
  const latest = days.at(-1);
  const local = china.format(now);
  const today = local.slice(0, 10);
  const weekday = new Date(today + 'T12:00:00Z').getUTCDay() % 6 !== 0;
  const waiting = weekday && local.slice(11, 16) >= '16:15' && latest?.date !== today;
  const items = Object.fromEntries(directions.map(({ id }) => {
    const share = latest?.shares[id] ?? null;
    const past = days.at(-6)?.shares[id] ?? null;
    const baseline = days.slice(-HISTORY_DAYS, -1).map(day => day.shares[id]);
    const percentile = share !== null && baseline.length === 120 && baseline.every(Number.isFinite)
      ? baseline.reduce((sum, point) => sum + (point < share ? 1 : point === share ? 0.5 : 0), 0) / 120 * 100
      : null;
    return [id, { share, change5: share !== null && past !== null ? share - past : null, percentile }];
  }));
  return {
    groups: groups.map(({ name, directions }) => ({ name, directions: directions.map(({ id, name, basis }) => ({ id, name, basis })) })),
    status: latest ? waiting ? 'waiting' : 'ready' : 'unavailable',
    date: latest?.date ?? null, publishedAt: value?.publishedAt ?? null, sourceUrl: SOURCE,
    items, history: days.slice(-20).map(({ date, shares }) => ({ date, shares })),
  };
}

async function refreshCrowding({ store, load = fetchSeries, loadReference = fetchReference, now = Date.now() }) {
  const local = china.format(now);
  const today = local.slice(0, 10);
  const through = local.slice(11, 16) >= '16:15' ? today : new Date(Date.parse(today) - 86400_000).toISOString().slice(0, 10);
  const existing = await store.read(PATH);
  const previous = existing?.value?.days ?? [];
  const previousDate = previous.at(-1)?.date;
  let days = previous;
  if (previousDate !== today) {
    const from = new Date(Date.parse(through) - 220 * 86400_000).toISOString().slice(0, 10);
    const market = await load(MARKET, through, from);
    const marketDays = [...market.keys()].sort().slice(-HISTORY_DAYS);
    const date = marketDays.at(-1);
    if (marketDays.length < HISTORY_DAYS) throw Error('申万 A 指历史交易日不足');
    if (previousDate && date <= previousDate) return { status: 'waiting', date: previousDate };

    const byCode = new Map();
    for (let start = 0; start < codes.length; start += 5) {
      await Promise.all(codes.slice(start, start + 5).map(async code => {
        byCode.set(code, await load(code, through, marketDays[0]));
      }));
    }
    days = calculateDays(market, byCode);
    if (Object.values(days.at(-1).shares).some(value => value === null)) {
      return { status: 'waiting', date: previousDate ?? null };
    }
  } else if (references.every(({ id }) => Number.isFinite(previous.at(-1).shares[id]))) {
    return { status: 'current', date: today };
  }

  days = await addReferences(days, previous, loadReference);
  const date = days.at(-1).date;
  if (date === previousDate && JSON.stringify(days) === JSON.stringify(previous)) return { status: 'current', date };
  let row = existing;
  for (let attempt = 0; attempt < 3; attempt++) {
    const saved = row?.value?.days?.at(-1)?.date;
    if (saved && (saved > date || (row !== existing && saved === date))) return { status: 'current', date: saved };
    try {
      await store.write(PATH, { publishedAt: new Date(now).toISOString(), days }, row?.etag ?? null);
      return { status: date === today ? 'published' : 'waiting', date, sessions: days.length };
    } catch (error) {
      if (!store.isConflict(error)) throw error;
      row = await store.read(PATH);
    }
  }
  throw Error('日终快照正在更新，请重试');
}

module.exports = { PATH, parseSeries, parseReference, publicSnapshot, refreshCrowding };
