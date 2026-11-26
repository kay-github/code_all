const { createHash, timingSafeEqual } = require('node:crypto');
const { escapeHtml, formatBeijing } = require('./pushplus');

const CONFIG = 'investment/v1/goal-alerts.json';
const STATE = 'investment/v1/goal-alert-deliveries.json';
const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' });
const units = { marketCap: '亿元', price: '元', changePct: '%', peTTM: '倍' };
const macroUnits = { AU9999: '元/克', CL: '美元/桶', 'BTC-USD': '美元' };
const format = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });

const digest = value => createHash('sha256').update(value).digest();
function matchesSecret(actual, expected) {
  return typeof actual === 'string' && Boolean(expected) && timingSafeEqual(digest(actual), digest(expected));
}
function matchesImport(token, config, now = Date.now()) {
  return /^[a-f0-9]{48}$/.test(token || '') && now < Date.parse(config?.importExpiresAt)
    && matchesSecret(digest(token).toString('hex'), config.importHash);
}

const investmentStatePath = id => `investment/v1/states/${id}.json`;

function activeGoals(config, snapshot) {
  const legacy = new Map((config?.goals ?? []).filter(goal => config.alertIds?.includes(goal.id)).map(goal => [goal.id, goal]));
  if (!snapshot) return [...legacy.values()];
  return (snapshot.goals ?? []).filter(goal => (goal.dueAt || goal.symbol) &&
    (goal.remind === true || (goal.remind !== false && sameRule(goal, legacy.get(goal.id)))));
}

function sameRule(goal, rule) {
  return rule && goal.symbol === rule.symbol && Boolean(goal.index) === Boolean(rule.index) &&
    goal.metric === rule.metric && goal.operator === rule.operator && goal.threshold === rule.threshold;
}

function goalAlertsForAccount(config, userId, snapshot) {
  if (!userId || config?.ownerId !== userId) return [];
  return activeGoals(config, snapshot).map(({ id, dueAt, symbol, index, metric, operator, threshold }) =>
    dueAt ? { id, dueAt } : { id, symbol, index: Boolean(index), metric, operator, threshold });
}
const keyOf = goal => goal.index ? 'index:' + goal.symbol : goal.symbol;

function observation(goal, quote, now, today, close) {
  const value = quote?.[goal.metric];
  const timestamp = Date.parse(quote?.time);
  const age = now - timestamp;
  const macro = Object.hasOwn(macroUnits, goal.symbol);
  const inWindow = age >= -60_000 && (macro ? age <= 20 * 60_000 : age <= 35 * 60_000 || timestamp >= close);
  if (!quote || quote.stale || (!quote.suspended && !Number.isFinite(value)) || !inWindow ||
      (!macro && day.format(timestamp) !== today)) return null;
  return { goal, value, timestamp, source: quote.source, suspended: quote.suspended };
}

function card({ goal, value, timestamp, source }) {
  const unit = goal.index && goal.metric === 'price' ? '点' : macroUnits[goal.symbol] ?? units[goal.metric] ?? '';
  const due = Boolean(goal.dueAt);
  const main = due ? formatBeijing(timestamp) : format.format(value);
  const detail = due ? '预设提醒时间已到（北京时间）'
    : `触发条件 ${escapeHtml(goal.symbol)} ${escapeHtml(goal.operator)} ${format.format(goal.threshold)} ${unit}`;
  return `<div style="max-width:440px;margin:0 auto;font-family:system-ui,sans-serif;color:#223446">
  <div style="background:#eaf1f6;border:1px solid #cedbe5;border-radius:14px;padding:18px">
    <div style="font-size:12px;color:#466580;font-weight:700">333 投资理论 · ${escapeHtml(goal.horizon)}目标</div>
    <h2 style="margin:9px 0 8px;font-size:21px">${escapeHtml(goal.title)}</h2>
    <div style="font-size:${due ? '23' : '31'}px;font-weight:750;color:#245b89">${main} <span style="font-size:14px">${unit}</span></div>
    <div style="font-size:13px;margin-top:4px;color:#486278">${detail}</div>
    ${goal.note ? `<p style="margin:12px 0 0;font-size:14px;line-height:1.5">${escapeHtml(goal.note.slice(0, 200))}</p>` : ''}
    ${due ? '' : `<div style="font-size:12px;color:#486278;margin-top:12px">行情时间 ${formatBeijing(timestamp)}（北京时间）${source ? ` · ${escapeHtml(source === '东方财富' ? '东方财富（备用）' : source)}` : ''}</div>`}
    <a href="https://1.688680.xyz/tools/investment-theory/?tab=goal&kind=${due ? 'time' : 'point'}" style="display:inline-block;margin-top:12px;color:#205786">查看投资目标 →</a>
  </div></div>`;
}

function scheduledGoal(goal, now) {
  if (goal.dueAt || Object.hasOwn(macroUnits, goal.symbol)) return true;
  const local = new Date(now + 8 * 3600_000);
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  return local.getUTCDay() % 6 !== 0 && ((minute >= 570 && minute <= 705) || minute >= 780);
}

async function runGoalAlerts({ store, config, snapshot, quotes, send, now = Date.now(), dryRun = false, scheduled = false }) {
  const delivered = scheduled ? (await store.read(STATE))?.value ?? {} : {};
  const goals = activeGoals(config, snapshot).filter(goal => !scheduled ||
    (!Object.hasOwn(delivered, goal.id) && scheduledGoal(goal, now)));
  const timed = goals.filter(goal => goal.dueAt);
  const market = goals.filter(goal => goal.symbol && !goal.dueAt);
  const keys = [...new Set(market.map(keyOf))];
  const values = {};
  const batches = [];
  for (let i = 0; i < keys.length; i += 24) batches.push(keys.slice(i, i + 24));
  const results = await Promise.allSettled(batches.map(async batch => quotes(batch.join(','))));
  for (const result of results) if (result.status === 'fulfilled') Object.assign(values, result.value.quotes);
  const today = day.format(now);
  const close = Date.parse(today + 'T15:00:00+08:00');
  const checked = market.map(goal => observation(goal, values[keyOf(goal)], now, today, close)).filter(Boolean);
  const matches = checked.filter(({ goal, value, suspended }) => !suspended &&
    !(goal.metric === 'peTTM' && value <= 0) && (goal.operator === '>=' ? value >= goal.threshold : value <= goal.threshold));
  matches.push(...timed.filter(goal => now >= Date.parse(goal.dueAt))
    .map(goal => ({ goal, timestamp: Date.parse(goal.dueAt) })));
  const rows = Object.values(values);
  const sources = {};
  for (const quote of rows) {
    if (quote.source) sources[quote.source] = (sources[quote.source] ?? 0) + 1;
  }
  const stats = { monitored: goals.length, quotes: rows.length, sources,
    unchecked: market.length - checked.length, matched: matches.length, sent: 0 };
  if (dryRun || !matches.length) return stats;

  // Reserve before calling PushPlus so concurrent checks never send the same goal twice.
  let reservation;
  for (let attempt = 0; attempt < 4; attempt++) {
    const stored = await store.read(STATE);
    const ledger = stored?.value ?? {};
    const pending = matches.filter(({ goal }) => !Object.hasOwn(ledger, goal.id)).slice(0, 8);
    if (!pending.length) return stats;
    const reserved = { ...ledger, ...Object.fromEntries(pending.map(({ goal }) => [goal.id, { status: 'pending', at: now }])) };
    try {
      await store.write(STATE, reserved, stored?.etag ?? null);
      reservation = pending;
      break;
    } catch (error) { if (!store.isConflict(error)) throw error; }
  }
  if (!reservation) throw Error('Goal alert state conflict');

  let result;
  try {
    result = await send({
      title: reservation.length === 1
        ? (reservation[0].goal.dueAt ? '时间到了 · ' : '目标达成 · ') + reservation[0].goal.title
        : '333 投资目标提醒',
      content: reservation.map(card).join('<br>'), template: 'html',
    });
  } catch (error) {
    // An explicit rejection can be retried. A timeout leaves the reservation
    // in place because the provider may already have accepted the message.
    if (/^PUSHPLUS_SEND_FAILED:4\d{2}:/.test(error?.message)) await record(false);
    throw error;
  }
  await record(true);
  return { ...stats, sent: reservation.length };

  async function record(sent) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const stored = await store.read(STATE);
      if (!stored) throw Error('Goal alert state missing');
      const ledger = { ...stored.value };
      for (const { goal, timestamp, value } of reservation) {
        if (ledger[goal.id]?.status !== 'pending' || ledger[goal.id].at !== now) continue;
        if (sent) ledger[goal.id] = { status: 'sent', at: now, serial: result.serial, timestamp, value };
        else delete ledger[goal.id];
      }
      try { await store.write(STATE, ledger, stored.etag); return; }
      catch (error) { if (!store.isConflict(error)) throw error; }
    }
    throw Error('Goal alert state conflict');
  }
}

module.exports = { CONFIG, STATE, investmentStatePath, matchesSecret, matchesImport, goalAlertsForAccount, runGoalAlerts };
