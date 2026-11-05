export const buckets = ['base', 'flex', 'core'];
export const defaults = [
  { name: '基础仓', target: 30 }, { name: '机动仓', target: 30 }, { name: '主仓', target: 30 },
];
export const horizons = ['远期', '中期', '短期'];
export const metrics = { price: '价格 / 点位', marketCap: '总市值（亿元）', peTTM: 'PE TTM', changePct: '日涨跌幅（%）' };
export const directions = ['已披露基本面', '机构预测', '技术与资金', '情绪观察'];
export const tradeTypes = {
  opening: '期初持仓', buy: '买入', sell: '卖出', deposit: '入金',
  withdrawal: '出金', dividend: '现金分红', adjustment: '送转 / 股数调整',
};
export const initialState = () => ({ version: 1, allocation: structuredClone(defaults), trades: [], goals: [], research: [] });
export const chinaDay = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());

function number(value, label, min, max) {
  const n = typeof value === 'number' || (typeof value === 'string' && value.trim()) ? Number(value) : NaN;
  if (!Number.isFinite(n) || n < min || n > max) throw Error(`${label}超出允许范围`);
  return n;
}
function int(value, label, min, max) {
  const n = number(value, label, min, max);
  if (!Number.isInteger(n)) throw Error(`${label}须为整数`);
  return n;
}
function text(value, label, max, required = false) {
  if (typeof value !== 'string' || value.trim().length > max || (required && !value.trim())) throw Error(`${label}格式不正确`);
  return value.trim();
}
function day(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString().slice(0, 10) !== value) throw Error('日期无效');
  return value;
}
function choice(value, items, label) {
  if (!items.includes(value)) throw Error(`${label}无效`);
  return value;
}
export function instrument(input, index = false) {
  const match = String(input ?? '').trim().toUpperCase().match(/^(?:(SH|SZ|BJ))?(\d{6})(?:\.(SH|SZ|BJ))?$/);
  const code = match?.[2];
  const tag = match?.[1] || match?.[3];
  const exchange = index ? tag : code?.startsWith('159') ? 'SZ' :
    /^(50|51|52|56|58|6)/.test(code || '') ? 'SH' : /^[03]/.test(code || '') ? 'SZ' :
    /^[489]/.test(code || '') ? 'BJ' : null;
  if (!exchange || (match[1] && match[1] !== exchange) || (match[3] && match[3] !== exchange) ||
      (index && !((exchange === 'SH' && code.startsWith('000')) || (exchange === 'SZ' && code.startsWith('399'))))) {
    throw Error(index ? '指数须填写带交易所的代码，如 000001.SH' : '请输入 A 股或场内 ETF 代码');
  }
  return `${code}.${exchange}`;
}
export const quoteKey = (symbol, index) => index ? `index:${symbol}` : symbol;
const cents = (value, label) => Math.round(number(value, label, 0, 1e9) * 100);
const id = value => text(value, '记录编号', 60, true);

function trade(row) {
  const type = choice(row.type, Object.keys(tradeTypes), '流水类型');
  const base = { id: id(row.id), type, date: day(row.date), note: text(row.note ?? '', '备注', 240) };
  if (type === 'deposit' || type === 'withdrawal') return { ...base, amount: cents(row.amount, '金额') / 100 };
  const held = { ...base, bucket: choice(row.bucket, buckets, '所属仓位'), symbol: instrument(row.symbol) };
  if (type === 'dividend') return { ...held, amount: cents(row.amount, '金额') / 100 };
  if (type === 'adjustment') return { ...held, qty: int(row.qty, '调整股数', -1e8, 1e8) };
  return { ...held, qty: int(row.qty, '股数', 1, 1e8), price: number(row.price, '价格', 0, 1e5), fee: cents(row.fee || 0, '费用') / 100 };
}

export function replay(trades) {
  const positions = new Map();
  let cash = 0, realized = 0;
  for (const row of [...trades].sort((a, b) => a.date.localeCompare(b.date))) {
    if (row.type === 'deposit' || row.type === 'withdrawal') {
      cash += Math.round(row.amount * 100) * (row.type === 'deposit' ? 1 : -1);
      continue;
    }
    const key = `${row.bucket}/${row.symbol}`;
    const position = positions.get(key) ?? { symbol: row.symbol, bucket: row.bucket, qty: 0, cost: 0 };
    const amount = Math.round((row.qty ?? 0) * (row.price ?? 0) * 100);
    const fee = Math.round((row.fee ?? 0) * 100);
    if (!Number.isSafeInteger(amount)) throw Error('成交金额过大');
    if (row.type === 'opening' || row.type === 'buy') {
      position.qty += row.qty;
      position.cost += amount + fee;
      if (row.type === 'buy') cash -= amount + fee;
    } else if (row.type === 'sell') {
      if (row.qty > position.qty) throw Error(`${row.date} ${row.symbol} 卖出数量超过该仓位持股`);
      const cost = Math.round(position.cost / position.qty * row.qty);
      position.qty -= row.qty;
      position.cost -= cost;
      cash += amount - fee;
      realized += amount - fee - cost;
    } else if (row.type === 'dividend') {
      const dividend = Math.round(row.amount * 100);
      cash += dividend;
      realized += dividend;
    } else {
      if (position.qty <= 0 || position.qty + row.qty <= 0) throw Error(`${row.symbol} 股数调整需要有效的剩余持仓`);
      position.qty += row.qty;
    }
    if (![cash, realized, position.qty, position.cost].every(Number.isSafeInteger)) throw Error('账本金额或数量过大');
    positions.set(key, position);
  }
  return { cash, realized, positions: [...positions.values()].filter(item => item.qty) };
}

function goal(row) {
  const base = { id: id(row.id), horizon: choice(row.horizon, horizons, '投资期限'),
    title: text(row.title, '目标名称', 80, true), note: text(row.note ?? '', '投资逻辑', 1000) };
  if (!row.symbol) return base;
  const index = row.index === true;
  const metric = choice(row.metric, index ? ['price', 'changePct'] : Object.keys(metrics), '条件指标');
  return { ...base, symbol: instrument(row.symbol, index), index, metric,
    operator: choice(row.operator, ['>=', '<='], '比较方式'), threshold: number(row.threshold, '阈值', -1e7, 1e7),
    hit: row.hit ? { time: text(row.hit.time, '行情时间', 40, true), value: number(row.hit.value, '触发值', -1e7, 1e7) } : null,
    matched: row.matched === true };
}

function research(row) {
  const source = text(row.source ?? '', '来源链接', 500);
  if (source && !/^https?:\/\//i.test(source)) throw Error('来源链接须以 http 或 https 开头');
  return { id: id(row.id), kind: choice(row.kind, directions, '观察类型'), date: day(row.date),
    title: text(row.title, '观察标题', 100, true), period: text(row.period ?? '', '报告期', 40),
    institution: text(row.institution ?? '', '机构', 80), note: text(row.note ?? '', '观察内容', 2000), source };
}
function checkedRows(rows, parse, max) {
  if (!Array.isArray(rows) || rows.length > max) throw Error('记录数量不符合要求');
  const items = rows.map(parse);
  if (new Set(items.map(row => row.id)).size !== items.length) throw Error('记录编号重复');
  return items;
}
export function validateState(state) {
  if (state?.version !== 1 || !Array.isArray(state.allocation) || state.allocation.length !== 3) throw Error('投资账本格式不兼容');
  const allocation = state.allocation.map(row => ({
    name: text(row.name, '仓位名称', 16, true), target: number(row.target, '目标占比', 0, 100),
  }));
  if (allocation.reduce((sum, row) => sum + row.target, 0) > 100 + 1e-8) throw Error('三个仓位目标占比之和不能超过 100%');
  const trades = checkedRows(state.trades, trade, 2000);
  replay(trades);
  return { version: 1, allocation, trades, goals: checkedRows(state.goals, goal, 200), research: checkedRows(state.research, research, 300) };
}

export function evaluateGoals(goals, quotes, now = Date.now()) {
  return goals.map(row => {
    if (!row.symbol) return row;
    const quote = quotes[quoteKey(row.symbol, row.index)];
    const value = quote?.[row.metric];
    const age = now - Date.parse(quote?.time);
    if (!Number.isFinite(value) || !(age >= -60_000 && age <= 15 * 60_000) || quote.stale || quote.suspended ||
        (row.metric === 'peTTM' && value <= 0)) return row;
    const matched = row.operator === '>=' ? value >= row.threshold : value <= row.threshold;
    return { ...row, matched, hit: matched && !row.matched ? { time: quote.time, value } : row.hit };
  });
}
