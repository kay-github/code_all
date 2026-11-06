const { createHash, timingSafeEqual } = require('node:crypto');
const { escapeHtml, formatBeijing } = require('./pushplus');

const CONFIG = 'investment/v1/goal-alerts.json';
const STATE = 'investment/v1/goal-alert-deliveries.json';
const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' });
const units = { marketCap: '亿元', price: '元', changePct: '%', peTTM: '倍' };
const format = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });

const digest = value => createHash('sha256').update(value).digest();
function matchesSecret(actual, expected) {
  return typeof actual === 'string' && Boolean(expected) && timingSafeEqual(digest(actual), digest(expected));
}
function matchesImport(token, config, now = Date.now()) {
  return /^[a-f0-9]{48}$/.test(token || '') && now < Date.parse(config?.importExpiresAt)
    && matchesSecret(digest(token).toString('hex'), config.importHash);
}

function goalAlertsForAccount(config, userId) {
  if (!userId || config?.ownerId !== userId) return [];
  return config.goals.filter(goal => config.alertIds.includes(goal.id))
    .map(({ id, symbol, index, metric, operator, threshold }) => ({ id, symbol, index: Boolean(index), metric, operator, threshold }));
}
const keyOf = goal => goal.index ? 'index:' + goal.symbol : goal.symbol;

function trigger(goal, quote, now) {
  const value = quote?.[goal.metric];
  const timestamp = Date.parse(quote?.time);
  const age = now - timestamp;
  if (!Number.isFinite(value) || quote.stale || quote.suspended || !(age >= -60_000 && age <= 35 * 60_000) ||
      day.format(timestamp) !== day.format(now)) return null;
  if (goal.operator === '>=' ? value < goal.threshold : value > goal.threshold) return null;
  return { goal, value, timestamp };
}

function card({ goal, value, timestamp }) {
  const unit = goal.index && goal.metric === 'price' ? '点' : units[goal.metric] ?? '';
  return `<div style="max-width:440px;margin:0 auto;font-family:system-ui,sans-serif;color:#223446">
  <div style="background:#eaf1f6;border:1px solid #cedbe5;border-radius:14px;padding:18px">
    <div style="font-size:12px;color:#466580;font-weight:700">333 投资理论 · ${escapeHtml(goal.horizon)}目标</div>
    <h2 style="margin:9px 0 8px;font-size:21px">${escapeHtml(goal.title)}</h2>
    <div style="font-size:31px;font-weight:750;color:#245b89">${format.format(value)} <span style="font-size:14px">${unit}</span></div>
    <div style="font-size:13px;margin-top:4px;color:#486278">触发条件 ${escapeHtml(goal.operator)} ${format.format(goal.threshold)} ${unit}</div>
    ${goal.note ? `<p style="margin:12px 0 0;font-size:14px;line-height:1.5">${escapeHtml(goal.note)}</p>` : ''}
    <div style="font-size:12px;color:#486278;margin-top:12px">行情时间 ${formatBeijing(timestamp)}（北京时间）</div>
    <a href="https://1.688680.xyz/tools/investment-theory/?tab=goal" style="display:inline-block;margin-top:12px;color:#205786">查看投资目标 →</a>
  </div></div>`;
}

async function runGoalAlerts({ store, config, quotes, send, now = Date.now(), dryRun = false }) {
  const goals = config.goals.filter(goal => config.alertIds.includes(goal.id));
  const { quotes: values } = await quotes([...new Set(goals.map(keyOf))].join(','));
  const matches = goals.map(goal => trigger(goal, values[keyOf(goal)], now)).filter(Boolean);
  const stats = { monitored: goals.length, quotes: Object.keys(values).length, matched: matches.length, sent: 0 };
  if (dryRun || !matches.length) return stats;

  // Reserve before calling PushPlus so concurrent checks never send the same goal twice.
  let reservation;
  for (let attempt = 0; attempt < 4; attempt++) {
    const stored = await store.read(STATE);
    const ledger = stored?.value ?? {};
    const pending = matches.filter(({ goal }) => !Object.hasOwn(ledger, goal.id));
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
      title: reservation.length === 1 ? '目标达成 · ' + reservation[0].goal.title : '333 投资目标达成',
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
      for (const { goal } of reservation) {
        if (ledger[goal.id]?.status !== 'pending' || ledger[goal.id].at !== now) continue;
        if (sent) ledger[goal.id] = { status: 'sent', at: now, serial: result.serial };
        else delete ledger[goal.id];
      }
      try { await store.write(STATE, ledger, stored.etag); return; }
      catch (error) { if (!store.isConflict(error)) throw error; }
    }
    throw Error('Goal alert state conflict');
  }
}

module.exports = { CONFIG, STATE, matchesSecret, matchesImport, goalAlertsForAccount, runGoalAlerts };
