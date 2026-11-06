import {
  buckets, legacyBucket, horizons, directions, metrics, tradeTypes, initialState, chinaDay,
  SELF, holderTrades, portfolio, replay, validateState, mergeImport, evaluateGoals, quoteKey,
} from './model.mjs';
import { drawShare } from './share.mjs';
import { syncDecision } from './cloud-sync.mjs';

const $ = id => document.getElementById(id);
const field = (form, name) => form.elements.namedItem(name);
const readForm = form => Object.fromEntries(new FormData(form));
const fmt = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const money = value => Number.isFinite(value) ? `¥${fmt.format(value / 100)}` : '待行情';
const pct = value => Number.isFinite(value) ? `${fmt.format(value)}%` : '—';
const stamp = value => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
const difference = value => value > 0 ? 'positive' : value < 0 ? 'negative' : '';
const uuid = () => crypto.randomUUID();

let user = null;
let storageKey = '';
let savedLocal = null;
let state = initialState();
let remoteRev = null;
let pending = false;
let cloud = null;
let quotes = {};
let fetchingQuotes = false;
let loadingSnapshot = false;
let snapshot = null;
let accountBusy = false;
let holderId = SELF;
let editingHolder = false;
let shareSnapshot = null;
const drafts = new Map();
const path = '/api/grid/investment';
const activeHolder = () => state.holders.find(holder => holder.id === holderId);
const holderName = () => activeHolder()?.name ?? '本人';
const allocationForHolder = () => activeHolder()?.allocation ?? state.allocation;
const bucketName = bucket => bucket === legacyBucket ? '原基础仓' : allocationForHolder()[buckets.indexOf(bucket)]?.name;

function el(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined) node.textContent = value;
  return node;
}
function notice(message, error = false) {
  const status = $('status');
  status.hidden = !message;
  status.className = error ? 'status error' : 'status';
  status.textContent = message;
}
function options(select, entries) {
  const previous = select.value;
  select.replaceChildren(...entries.map(([value, label]) => new Option(label, value)));
  if (entries.some(([value]) => value === previous)) select.value = previous;
}
async function api(url, method = 'GET', data, headers = {}) {
  const response = await fetch(url, {
    method, cache: 'no-store', signal: AbortSignal.timeout(12_000),
    headers: data === undefined ? headers : { ...headers, 'Content-Type': 'application/json' },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(Error(body.error || '请求失败'), { status: response.status });
  return body;
}

function saveLocal(next, revision, unsynced) {
  if (!storageKey) throw Error('账本正在加载，请稍后再试。');
  if (localStorage.getItem(storageKey) !== savedLocal) throw Error('此账本已在另一个页面更新，请刷新后重试。');
  const serialized = JSON.stringify({ state: next, remoteRev: revision, pending: unsynced });
  localStorage.setItem(storageKey, serialized);
  savedLocal = serialized;
  state = next;
  remoteRev = revision;
  pending = unsynced;
}
function persist(next) {
  saveLocal(validateState(next), remoteRev, Boolean(cloud));
  if (cloud?.phase === 'synced') syncStatus(cloud, 'pending', '已存本机，等待同步…');
  scheduleSync(cloud);
}
function syncStatus(context, phase, message) {
  context.phase = phase;
  $('sync-status').dataset.phase = phase;
  $('sync-text').textContent = message;
  $('sync-retry').hidden = phase !== 'error';
  $('sync-conflict').hidden = phase !== 'conflict';
  $('sync-login').hidden = phase !== 'auth';
  $('login-form').hidden = phase !== 'auth';
}
function scheduleSync(context, delay = 650) {
  if (!context || context !== cloud || context.task || ['conflict', 'auth'].includes(context.phase)) return;
  clearTimeout(context.timer);
  context.timer = setTimeout(() => syncCloud(context), delay);
}
function syncCloud(context, choice) {
  if (!context || context !== cloud || context.phase === 'auth') return;
  if (context.task) return context.task;
  if (context.phase === 'conflict' && !choice) return;
  clearTimeout(context.timer);
  context.task = runCloudSync(context, choice).finally(() => {
    context.task = null;
    context.checkedAt = Date.now();
    if (context !== cloud) return;
    if (context.retryDelay !== null) scheduleSync(context, context.retryDelay);
    else if (context.phase === 'pending') scheduleSync(context);
  });
  return context.task;
}
async function runCloudSync(context, choice) {
  const chosenState = state;
  const headers = { 'X-Investment-Account': context.id };
  context.retryDelay = null;
  syncStatus(context, 'working', pending ? '正在同步云账本…' : '正在检查云账本…');
  try {
    const remote = await api(path, 'GET', undefined, headers);
    if (context !== cloud) return;
    if (remote.kind === 'ok' && Number.isSafeInteger(remote.rev) && remote.rev > 0) remote.data = validateState(remote.data);
    else if (remote.kind !== 'empty') throw Error('云账本数据无法读取。');
    const revision = remote.kind === 'ok' ? remote.rev : null;
    const decision = choice
      ? (revision === context.conflictRev && state === chosenState ? choice : 'conflict')
      : syncDecision({ state, pending, remoteRev }, remote);
    if (decision === 'conflict') {
      context.conflictRev = revision;
      syncStatus(context, 'conflict', '本机和云端的账本版本不同，请选择保留哪一份。');
      return;
    }
    if (decision === 'download') {
      saveLocal(remote.data ?? initialState(), revision, false);
      if (holderId !== SELF && !activeHolder()) {
        holderId = SELF;
        resetTradeForm();
        closeHolderDialogs();
      }
      renderLedger();
      void refreshQuotes();
    } else if (decision === 'upload') {
      const uploaded = state;
      const result = await api(path, 'PUT', { baseRev: revision, data: uploaded }, headers);
      if (context !== cloud) return;
      if (!Number.isSafeInteger(result.rev) || result.rev < 1) throw Error('云账本版本无法确认。');
      saveLocal(state, result.rev, state !== uploaded);
    } else if (pending || remoteRev !== revision) {
      saveLocal(state, revision, false);
    }
    syncStatus(context, pending ? 'pending' : 'synced', pending ? '已存本机，等待同步…' : '云账本已同步');
  } catch (error) {
    if (context !== cloud) return;
    if (error.status === 401) {
      syncStatus(context, 'auth', '登录已失效，重新登录后继续同步。');
    } else if (error.status === 409) {
      context.retryDelay = 0;
      syncStatus(context, 'pending', '云端版本已变化，正在重新检查…');
    } else {
      if (error instanceof TypeError || ['TimeoutError', 'AbortError'].includes(error.name) || error.status === 429 || error.status >= 500) {
        context.retryDelay = 10_000;
      }
      const reason = context.retryDelay === null ? error.message : '连接云账本失败，稍后自动重试。';
      syncStatus(context, 'error', pending ? `改动已保存在本机。${reason}` : reason);
    }
  }
}
function account(nextUser) {
  const key = 'investment-theory:v1:' + (nextUser?.id ?? 'guest');
  if (cloud) clearTimeout(cloud.timer);
  cloud = nextUser ? { id: nextUser.id, task: null, timer: null, retryDelay: null } : null;
  user = nextUser;
  $('account-status').textContent = user ? `当前账号 · ${user.username}` : '本机账本';
  $('login-form').hidden = Boolean(user);
  $('cloud-actions').hidden = !user;
  $('sync-status').hidden = !user;
  if (storageKey !== key) {
    storageKey = key;
    quotes = {};
    state = initialState();
    holderId = SELF;
    drafts.clear();
    resetTradeForm();
    closeHolderDialogs();
    remoteRev = null;
    savedLocal = null;
    pending = false;
    try {
      savedLocal = localStorage.getItem(key);
      const saved = JSON.parse(savedLocal || 'null');
      if (saved) {
        state = validateState(saved.state);
        remoteRev = Number.isSafeInteger(saved.remoteRev) && saved.remoteRev > 0 ? saved.remoteRev : null;
        pending = saved.pending ?? (remoteRev !== null || JSON.stringify(state) !== JSON.stringify(initialState()));
      }
    } catch { notice('读取本机账本失败，可以从 JSON 或云备份恢复。', true); }
    renderLedger();
    if (!cloud) void refreshQuotes();
  } else {
    renderGoals();
  }
  const context = cloud;
  if (!$('goal').hidden) void refreshGoalReminders();
  return syncCloud(context)?.then(() => { if (context === cloud) void refreshQuotes(); });
}
function accountAction(callback) {
  return async event => {
    event.preventDefault();
    if (accountBusy) return;
    accountBusy = true;
    const buttons = [...$('data-panel').querySelectorAll('button')];
    buttons.forEach(button => { button.disabled = true; });
    try { await callback(event); }
    catch (error) { notice(error.message, true); }
    finally {
      accountBusy = false;
      buttons.forEach(button => { button.disabled = false; });
    }
  };
}

function removeButton(label, collection, id) {
  const button = el('button', '', '删除');
  button.type = 'button';
  button.setAttribute('aria-label', '删除' + label);
  button.addEventListener('click', () => {
    if (!confirm(`删除「${label}」？`)) return;
    try {
      persist({ ...state, [collection]: state[collection].filter(row => row.id !== id) });
      render();
      notice('已删除');
    } catch (error) { notice(error.message, true); }
  });
  return button;
}
function rowCard(title, meta, body, collection, id, badge) {
  const article = el('article', 'entry');
  const header = el('header');
  const heading = el('div', 'entry-title');
  heading.append(el('strong', '', title));
  if (badge) heading.append(badge);
  header.append(heading, removeButton(title, collection, id));
  article.append(header);
  if (meta) article.append(el('p', 'meta', meta));
  if (body) article.append(el('p', 'body', body));
  return article;
}
function allocationBar(actual, target) {
  const track = el('div', 'allocation-track');
  track.setAttribute('aria-hidden', 'true');
  const fill = el('span', 'allocation-fill');
  fill.style.width = `${Math.min(100, Math.max(0, actual ?? 0))}%`;
  const marker = el('span', 'allocation-marker');
  marker.style.left = `${target}%`;
  track.append(fill, marker);
  return track;
}
function renderPositions() {
  const { rows: marked, cash, realized, basis, floating, returnPct } = portfolio(state.trades, holderId, quotes);
  const allocation = allocationForHolder();
  const kpis = [
    ['投资净资产', money(basis), ''],
    ['账本现金', money(cash), cash < 0 ? 'negative' : ''],
    ['已实现盈亏', money(realized), difference(realized)],
    ['持仓浮动盈亏', money(floating), difference(floating)],
    ['持仓收益率', pct(returnPct), difference(returnPct)],
  ];
  $('kpis').replaceChildren(...kpis.map(([label, value, color]) => {
    const item = el('div');
    item.append(el('dt', '', label), el('dd', color, value));
    return item;
  }));
  const groups = [];
  const cards = allocation.map((bucket, index) => {
    const isCash = index === 0;
    const rows = isCash ? [] : marked.filter(row => row.bucket === buckets[index]);
    const value = isCash ? cash : rows.some(row => row.market === null) ? null : rows.reduce((sum, row) => sum + row.market, 0);
    const actual = basis > 0 && value !== null ? value / basis * 100 : null;
    const card = el('section', 'bucket');
    const heading = el('h3', '', bucket.name);
    heading.append(el('span', 'target', `目标 ${pct(bucket.target)}`));
    const stats = el('p', 'bucket-stats');
    stats.append(el('strong', '', pct(actual)), el('span', 'meta', money(value)));
    const delta = actual === null ? null : actual - bucket.target;
    card.append(heading, stats, allocationBar(actual, bucket.target), el('p', 'meta', delta === null
      ? (isCash || rows.length ? '占比待行情或净资产' : '暂无持仓') : `偏离目标 ${delta > 0 ? '+' : ''}${fmt.format(delta)} 个百分点`));
    return card;
  });
  for (const bucket of [...buckets.slice(1), legacyBucket]) {
    const rows = marked.filter(row => row.bucket === bucket);
    if (!rows.length) continue;
    const group = el('details', 'panel holding-group');
    group.open = true;
    group.dataset.bucket = bucket;
    const summary = el('summary');
    summary.append(el('span', 'group-title', bucketName(bucket)), el('span', 'count', `${rows.length} 个持仓`));
    group.append(summary);
    for (const row of rows) {
      const position = el('article', 'position-row');
      const identity = el('div', 'position-identity');
      identity.append(el('strong', '', row.quote?.name || row.symbol));
      if (row.quote?.name) identity.append(el('span', 'meta symbol', row.symbol));
      const metrics = el('dl', 'position-metrics');
      const quoteStatus = row.quote?.stale ? ' · 缓存' : row.quote?.suspended ? ' · 停牌' : '';
      const values = [
        ['股数 / 份额', fmt.format(row.qty)],
        ['每股成本', `¥${(row.cost / row.qty / 100).toFixed(3)}`],
        [`现价${quoteStatus}`, row.quote?.price ?? '—'],
        ['市值', money(row.market)],
        ['浮动盈亏', money(row.profit), difference(row.profit)],
      ];
      for (const [label, value, color] of values) {
        const metric = el('div');
        metric.append(el('dt', '', label), el('dd', color, value));
        metrics.append(metric);
      }
      position.append(identity, metrics);
      group.append(position);
    }
    groups.push(group);
  }
  const residual = 100 - allocation.reduce((sum, row) => sum + row.target, 0);
  $('allocation-foot').textContent = `未分配目标 ${pct(Math.max(0, residual))}${marked.some(row => row.bucket === legacyBucket) ? ' · 原基础仓持仓见下方明细' : ''}`;
  $('allocations').replaceChildren(...cards);
  const holdings = $('holdings');
  const focusedBucket = holdings.querySelector('summary:focus')?.parentElement.dataset.bucket;
  const closed = new Set([...holdings.querySelectorAll('details:not([open])')].map(group => group.dataset.bucket));
  for (const group of groups) if (closed.has(group.dataset.bucket)) group.open = false;
  $('holding-section').hidden = false;
  $('holding-empty').hidden = groups.length > 0;
  holdings.replaceChildren(...groups);
  groups.find(group => group.dataset.bucket === focusedBucket)?.querySelector('summary').focus({ preventScroll: true });
}
function renderAllocationEditor() {
  const allocation = allocationForHolder();
  const fields = allocation.flatMap((row, index) => [
    ...(index === 0 ? [] : [[`name-${index}`, `仓位 ${index + 1} 名称`, row.name]]),
    [`target-${index}`, `${row.name}目标占比（%）`, row.target],
  ]);
  $('allocation-fields').replaceChildren(...fields.map(([name, label, value]) => {
    const wrap = el('label', '', label);
    const input = el('input');
    input.name = name;
    input.required = true;
    if (typeof value === 'number') { input.type = 'number'; input.step = 'any'; input.min = '0'; input.max = '100'; }
    else input.maxLength = 16;
    input.value = value;
    wrap.append(input);
    return wrap;
  }));
  tradeFields();
}
function renderTrades() {
  const trades = holderTrades(state.trades, holderId);
  $('trade-count').textContent = `（${trades.length}）`;
  $('trades').replaceChildren(...trades.reverse().sort((a, b) => b.date.localeCompare(a.date)).map(row => {
    const details = [row.date, row.symbol, bucketName(row.bucket) ?? allocationForHolder()[0].name,
      row.qty !== undefined ? `${fmt.format(row.qty)} 股/份` : null,
      row.price !== undefined ? `¥${row.price} / 股` : null,
      row.amount !== undefined ? money(Math.round(row.amount * 100)) : null,
    ].filter(Boolean);
    return rowCard(tradeTypes[row.type], details.join(' · '), row.note, 'trades', row.id);
  }));
}
function renderGoals() {
  $('goal-reminder-status').hidden = !cloud?.remindersUnavailable;
  $('goals').replaceChildren(...horizons.map(horizon => {
    const group = el('section', 'goal-group');
    const rows = state.goals.filter(row => row.horizon === horizon);
    const heading = el('div', 'goal-heading');
    heading.append(el('h3', '', horizon), el('span', 'count', `${rows.length} 项`));
    group.append(heading);
    if (!rows.length) group.append(el('p', 'goal-empty muted', '暂无目标'));
    for (const row of rows) {
      const quote = row.symbol ? quotes[quoteKey(row.symbol, row.index)] : null;
      const condition = row.symbol ? `${row.symbol} · ${metrics[row.metric]} ${row.operator} ${row.threshold}` : '文字目标';
      const rule = cloud?.goalReminders?.get(row.id);
      const enabled = rule && rule.symbol === row.symbol && rule.index === Boolean(row.index) &&
        rule.metric === row.metric && rule.operator === row.operator && rule.threshold === row.threshold;
      const badge = enabled ? el('span', 'goal-reminder', '微信推加已开启') : null;
      const card = rowCard(row.title, condition, row.note, 'goals', row.id, badge);
      if (quote && Number.isFinite(quote[row.metric])) {
        card.append(el('p', 'meta', `最近读数 ${quote[row.metric]} · ${stamp(quote.time)}${quote.stale ? ' · 缓存' : ''}`));
      }
      if (row.hit) card.append(el('p', 'positive', `最近触发 ${row.hit.value} · ${stamp(row.hit.time)}`));
      group.append(card);
    }
    return group;
  }));
}
async function refreshGoalReminders() {
  const context = cloud;
  if (!context || context.remindersLoading || Date.now() - (context.remindersCheckedAt ?? 0) < 30_000) return;
  context.remindersLoading = true;
  try {
    const { rules } = await api(`${path}?view=reminders`, 'GET', undefined, { 'X-Investment-Account': context.id });
    context.goalReminders = new Map(rules.map(rule => [rule.id, rule]));
    context.remindersUnavailable = false;
    context.remindersCheckedAt = Date.now();
  } catch {
    context.goalReminders = null;
    context.remindersUnavailable = true;
  } finally {
    context.remindersLoading = false;
    if (context === cloud) renderGoals();
  }
}
function renderResearch() {
  $('research').replaceChildren(...[...state.research].reverse().sort((a, b) => b.date.localeCompare(a.date)).map(row => {
    const card = rowCard(row.title, [row.kind, row.date, row.period, row.institution].filter(Boolean).join(' · '), row.note, 'research', row.id);
    if (row.source) {
      const source = el('a', 'text-link', '查看来源 ↗');
      source.href = row.source;
      source.target = '_blank';
      source.rel = 'noopener noreferrer';
      card.append(source);
    }
    return card;
  }));
}
function render() { renderPositions(); renderTrades(); renderGoals(); renderResearch(); }

function renderLedger() {
  options($('holder-select'), [[SELF, '本人'], ...state.holders.map(holder => [holder.id, holder.name])]);
  $('holder-select').value = holderId;
  $('holder-select').disabled = false;
  $('holder-add').disabled = state.holders.length >= 50;
  $('holder-edit').hidden = holderId === SELF;
  $('share-open').disabled = false;
  $('trade-open').disabled = false;
  $('trade-editor').hidden = false;
  $('trade-holder').textContent = holderName();
  renderAllocationEditor();
  render();
}
function resetTradeForm() {
  const form = $('trade-form');
  form.reset();
  field(form, 'date').value = chinaDay();
  tradeFields();
}
function selectHolder(next) {
  if (next === holderId) return;
  const form = $('trade-form');
  drafts.set(holderId, Object.fromEntries([...form.elements].filter(input => input.name).map(input => [input.name, input.value])));
  holderId = next;
  $('holdings').replaceChildren();
  resetTradeForm();
  renderLedger();
  const { bucket, ...draft } = drafts.get(next) ?? {};
  for (const [name, value] of Object.entries(draft)) field(form, name).value = value;
  tradeFields();
  const select = field(form, 'bucket');
  if ([...select.options].some(option => option.value === bucket)) select.value = bucket;
  void refreshQuotes();
}
function closeHolderDialogs() {
  $('holder-dialog').close();
  $('share-dialog').close();
  shareSnapshot = null;
}
function replaceLedger(data) {
  persist(data);
  if (holderId !== SELF && !activeHolder()) holderId = SELF;
  drafts.clear();
  resetTradeForm();
  closeHolderDialogs();
  $('holdings').replaceChildren();
  renderLedger();
  void refreshQuotes();
}

function visible() { return !document.hidden && !window.frameElement?.hasAttribute('hidden'); }
function tradingWindow() {
  const china = new Date(Date.now() + 8 * 3600_000);
  const minute = china.getUTCHours() * 60 + china.getUTCMinutes();
  return china.getUTCDay() % 6 !== 0 && ((minute >= 570 && minute <= 690) || (minute >= 780 && minute <= 900));
}
async function refreshQuotes(showStatus = false) {
  if (fetchingQuotes || !storageKey) return;
  const keys = [...new Set([
    ...replay(state.trades, holderId).positions.map(row => row.symbol),
    ...state.goals.filter(row => row.symbol).map(row => quoteKey(row.symbol, row.index)),
  ])];
  if (!keys.length) {
    $('quote-status').textContent = '录入持仓后可刷新行情。';
    if (showStatus) notice('暂无需要检查的标的。');
    return;
  }
  fetchingQuotes = true;
  const key = storageKey;
  const holder = holderId;
  const buttons = [...document.querySelectorAll('.refresh-quotes')];
  buttons.forEach(button => { button.disabled = true; });
  $('quote-status').textContent = '正在读取行情…';
  try {
    const received = {};
    for (let offset = 0; offset < keys.length && key === storageKey; offset += 72) {
      const batches = [0, 24, 48].map(start => keys.slice(offset + start, offset + start + 24)).filter(batch => batch.length);
      const results = await Promise.allSettled(batches.map(batch => api('/api/investment-market?' + new URLSearchParams({ symbols: batch.join(',') }))));
      for (const result of results) if (result.status === 'fulfilled') Object.assign(received, result.value.quotes);
    }
    if (key !== storageKey || holder !== holderId) return;
    for (const symbol of keys) {
      if (received[symbol]) quotes[symbol] = received[symbol];
      else if (quotes[symbol]) quotes[symbol] = { ...quotes[symbol], stale: true };
    }
    const goals = evaluateGoals(state.goals, quotes);
    const hits = goals.filter((row, index) => row.hit && row.hit !== state.goals[index].hit);
    if (JSON.stringify(goals) !== JSON.stringify(state.goals)) persist({ ...state, goals });
    const valid = Object.values(received).filter(quote => !quote.stale);
    const newest = valid.map(quote => Date.parse(quote.time)).reduce((max, time) => Math.max(max, time), 0);
    $('quote-status').textContent = newest
      ? `腾讯财经 · ${valid.length}/${keys.length} 个标的 · 最新 ${stamp(newest)} · 延迟行情`
      : '行情暂不可用。已加载报价显示为缓存。';
    renderPositions();
    renderGoals();
    if (hits.length) notice(`${hits.length} 条投资目标触发，见「目标」。`);
    else if (showStatus) notice(newest ? '已检查持仓和投资目标。' : '暂无可用行情。', !newest);
  } catch (error) { notice(error.message, true); }
  finally {
    fetchingQuotes = false;
    buttons.forEach(button => { button.disabled = false; });
    if (key !== storageKey || holder !== holderId) void refreshQuotes();
  }
}
function svgNode(tag, attributes) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  return node;
}
function fearGauge(item) {
  const card = el('article', 'fear-card');
  const svg = svgNode('svg', { viewBox: '0 0 120 69', role: 'img', 'aria-label': Number.isFinite(item.score) ? `${item.score} 分` : '暂无分数' });
  // Use the five fg-v2 boundaries so the marker and upstream zone label agree.
  const zones = [[0, 25], [25, 45], [45, 55], [55, 75], [75, 100]];
  zones.forEach(([from, to], index) => svg.append(svgNode('path', {
    d: 'M 12 61 A 48 48 0 0 1 108 61', pathLength: 100,
    'stroke-dasharray': `${to - from - 1} 100`, 'stroke-dashoffset': -from,
    class: `fear-arc fear-arc-${index}`,
  })));
  if (Number.isFinite(item.score)) {
    const angle = Math.PI * (1 - item.score / 100);
    svg.append(svgNode('circle', { cx: 60 + 48 * Math.cos(angle), cy: 61 - 48 * Math.sin(angle), r: 4, class: 'fear-pointer' }));
  }
  const value = svgNode('text', { x: 60, y: 56, 'text-anchor': 'middle', class: 'fear-value' });
  value.textContent = Number.isFinite(item.score) ? fmt.format(item.score) : '—';
  svg.append(value);
  card.append(el('h4', '', item.name), svg, el('p', 'fear-zone', item.zone ?? '暂无数据'));
  card.append(el('p', 'meta', [item.date, item.stale ? '缓存' : null].filter(Boolean).join(' · ')));
  return card;
}
function fearPanel(data) {
  const panel = el('div', 'fear-panel');
  panel.append(el('h3', '', '核心指数恐贪仪表盘'));
  const gauges = el('div', 'fear-gauges');
  gauges.append(...(data?.items ?? []).map(fearGauge));
  panel.append(gauges, el('p', 'meta', ['金融工作台', data?.model, '0 偏恐慌 · 100 偏贪婪'].filter(Boolean).join(' · ')));
  return panel;
}
function boardPanel(title, data, subtitle) {
  const card = el('section');
  card.append(el('h3', '', title));
  if (!data?.items?.length) { card.append(el('p', 'muted', '快照暂不可用')); return card; }
  card.append(el('p', 'meta', subtitle));
  const list = el('ul', 'board-scores');
  for (const item of data.items) {
    const entry = el('li');
    const bar = el('span', 'board-track');
    const fill = el('span', 'board-fill');
    bar.setAttribute('aria-hidden', 'true');
    fill.style.width = `${item.score ?? 0}%`;
    bar.append(fill);
    entry.append(el('strong', '', item.name), bar,
      el('span', 'board-value', Number.isFinite(item.score) ? fmt.format(item.score) : '—'),
      el('span', 'meta', [item.zone, item.date, item.stale || data.stale ? '缓存' : null].filter(Boolean).join(' · ') ||
        (Number.isFinite(item.score) ? '日期未提供' : '暂无快照')));
    list.append(entry);
  }
  card.append(list);
  return card;
}
async function refreshSnapshot(force = false) {
  if (loadingSnapshot || (snapshot && !force)) return;
  loadingSnapshot = true;
  $('sentiment-refresh').disabled = true;
  try {
    snapshot = await api('/api/investment-market?view=sentiment');
    const boards = el('div', 'board-panels');
    boards.append(
      boardPanel('一级行业情绪', snapshot.industry, 'TMT（电子、通信、计算机、传媒）及其他大行业 · 恐贪分'),
      boardPanel('大主题拥挤度', snapshot.crowding, '精选主题 · 金融工作台拥挤度快照'),
    );
    $('sentiment').replaceChildren(fearPanel(snapshot.fear), boards);
  } catch { $('sentiment').replaceChildren(el('p', 'muted', '快照暂不可用，可稍后刷新。')); }
  finally { loadingSnapshot = false; $('sentiment-refresh').disabled = false; }
}

function tradeFields() {
  const type = $('trade-type').value;
  const stock = !['deposit', 'withdrawal'].includes(type);
  const choices = buckets.slice(1);
  if (['sell', 'dividend', 'adjustment'].includes(type) && replay(state.trades, holderId).positions.some(row => row.bucket === legacyBucket)) {
    choices.push(legacyBucket);
  }
  options(field($('trade-form'), 'bucket'), choices.map(bucket => [bucket, bucketName(bucket)]));
  const pricing = ['opening', 'buy', 'sell'].includes(type);
  const visibleFields = [
    ...(stock ? ['bucket', 'symbol'] : []), ...(pricing || type === 'adjustment' ? ['qty'] : []),
    ...(pricing ? ['price', 'fee'] : ['deposit', 'withdrawal', 'dividend'].includes(type) ? ['amount'] : []),
  ];
  for (const label of document.querySelectorAll('[data-trade-field]')) {
    const input = label.querySelector('input, select');
    const key = label.dataset.tradeField;
    label.hidden = !visibleFields.includes(key);
    input.disabled = label.hidden;
    input.required = !label.hidden && key !== 'fee';
  }
  field($('trade-form'), 'qty').min = type === 'adjustment' ? '-100000000' : '1';
  $('qty-label').textContent = type === 'adjustment' ? '调整股数（增加为正）' : '股数 / 份额';
  $('trade-hint').textContent = type === 'opening' ? '用于补录已有持仓，账本现金另行录入。' : '';
}
function goalFields() {
  const form = $('goal-form');
  const index = field(form, 'kind').value === 'index';
  const symbol = field(form, 'symbol');
  symbol.placeholder = index ? '例 000001.SH' : '例 300502.SZ';
  field(form, 'threshold').required = Boolean(symbol.value.trim());
  options(field(form, 'metric'), Object.entries(metrics).filter(([key]) => !index || key === 'price' || key === 'changePct'));
}
function bindForm(id, submit) {
  $(id).addEventListener('submit', event => {
    event.preventDefault();
    try { submit(event.currentTarget); }
    catch (error) { notice(error.message, true); }
  });
}
bindForm('allocation-form', form => {
  const input = readForm(form);
  const allocation = buckets.map((_, index) => ({ name: input[`name-${index}`], target: input[`target-${index}`] }));
  persist(holderId === SELF ? { ...state, allocation } : {
    ...state, holders: state.holders.map(holder => holder.id === holderId ? { ...holder, allocation } : holder),
  });
  renderAllocationEditor();
  render();
  notice('仓位设置已保存。');
});
for (const [formId, collection] of [['trade-form', 'trades'], ['goal-form', 'goals'], ['research-form', 'research']]) {
  bindForm(formId, form => {
    const input = readForm(form);
    const row = { ...input, id: uuid(), index: input.kind === 'index', holderId };
    persist({ ...state, [collection]: [...state[collection], row] });
    render();
    form.reset();
    for (const date of form.querySelectorAll('input[type=date]')) date.value = chinaDay();
    tradeFields();
    goalFields();
    notice(cloud ? '已保存，云端同步状态见上方。' : '已保存到本机账本。');
    if (collection !== 'research') void refreshQuotes();
  });
}

const tabs = [...document.querySelectorAll('[data-tab]')];
function selectTab(active) {
  for (const tab of tabs) {
    const selected = active === tab;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    $(tab.dataset.tab).hidden = !selected;
  }
  if (active.dataset.tab === 'goal') void refreshGoalReminders();
  if (active.dataset.tab === 'direction') void refreshSnapshot();
}
async function importLinkedData() {
  const match = location.hash.match(/^#add-(goals|ledger)=([a-f0-9]{48})$/);
  if (!match || !storageKey) return;
  const [, kind, token] = match;
  const isLedger = kind === 'ledger';
  const keyAtStart = storageKey;
  const context = cloud;
  try {
    if (context?.task) await context.task;
    if (context !== cloud || location.hash !== match[0]) return;
    if (context && !['synced', 'pending'].includes(context.phase)) throw Error('请先完成云账本同步，再打开导入链接。');
    const response = await fetch(`/api/investment-market?view=${isLedger ? 'ledger-import' : 'goal-template'}`, {
      headers: { Authorization: 'Bearer ' + token }, cache: 'no-store', signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) throw Error('导入链接无效、过期或服务暂不可用。');
    const data = await response.json();
    if (location.hash !== match[0]) return;
    if (storageKey !== keyAtStart) throw Error('账本已切换，请重新打开导入链接。');
    const source = isLedger ? data.holders?.[0] : null;
    if (isLedger && !source) throw Error('导入文件缺少持有人。');
    const merged = mergeImport(state, data);
    const addedGoals = merged.goals.length - state.goals.length;
    const changed = addedGoals || merged.trades.length !== state.trades.length || merged.holders.length !== state.holders.length;
    if (changed) persist(merged);
    const imported = source && state.holders.find(row => row.id === source.id || row.name === source.name);
    selectTab($(isLedger ? 'tab-position' : 'tab-goal'));
    if (imported && imported.id !== holderId) selectHolder(imported.id);
    else if (changed) { renderLedger(); void refreshQuotes(); }
    history.replaceState(null, '', location.pathname + location.search);
    notice(isLedger ? (changed ? '持仓、现金与目标已合并到当前账本。' : '这些记录已存在。') :
      (addedGoals ? `已添加 ${addedGoals} 个投资目标。` : '这些目标已存在。'));
  } catch (error) { notice(error.message, true); }
}
tabs.forEach((tab, index) => {
  tab.addEventListener('click', () => selectTab(tab));
  tab.addEventListener('keydown', event => {
    let target;
    switch (event.key) {
      case 'ArrowRight': target = (index + 1) % tabs.length; break;
      case 'ArrowLeft': target = (index + tabs.length - 1) % tabs.length; break;
      case 'Home': target = 0; break;
      case 'End': target = tabs.length - 1; break;
      default: return;
    }
    event.preventDefault();
    const active = tabs[target];
    selectTab(active);
    active.focus();
  });
  tab.disabled = false;
});
function showDataPanel(open) {
  $('data-panel').hidden = !open;
  $('data-toggle').setAttribute('aria-expanded', String(open));
}
$('data-toggle').addEventListener('click', () => showDataPanel($('data-panel').hidden));
$('login-form').addEventListener('submit', accountAction(async event => {
  const form = event.currentTarget;
  const data = await api('/api/grid/auth', 'POST', { action: 'login', ...readForm(form) });
  form.reset();
  notice('');
  await account(data.user);
}));
$('logout').addEventListener('click', accountAction(async () => {
  await api('/api/grid/auth', 'POST', { action: 'logout' });
  account(null);
  notice('已切回未登录的本机账本。');
}));
$('sync-retry').addEventListener('click', () => syncCloud(cloud));
$('sync-login').addEventListener('click', () => {
  showDataPanel(true);
  field($('login-form'), 'username').focus();
});
$('sync-use-local').addEventListener('click', () => {
  if (confirm('用此浏览器的账本替换当前云端版本？')) void syncCloud(cloud, 'upload');
});
$('sync-use-cloud').addEventListener('click', () => {
  if (confirm('用云端版本替换此浏览器的账本？可先导出本机 JSON。')) void syncCloud(cloud, 'download');
});
$('export').addEventListener('click', () => {
  const link = el('a');
  link.download = `333投资理论-${chinaDay()}.json`;
  link.href = URL.createObjectURL(new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }));
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 5000);
});
$('import').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', async event => {
  const file = event.target.files[0];
  const key = storageKey;
  event.target.value = '';
  if (!file) return;
  try {
    if (file.size > 4 * 1024 * 1024) throw Error('备份文件超过 4 MB。');
    const imported = validateState(JSON.parse(await file.text()));
    if (key !== storageKey || !confirm(cloud ? '恢复此文件并同步到当前账号的云账本？' : '用此文件替换当前本机账本？')) return;
    replaceLedger(imported);
    notice('JSON 备份已恢复。');
  } catch (error) { notice(error.message, true); }
});

$('holder-select').addEventListener('change', event => selectHolder(event.target.value));
function openHolderDialog(edit) {
  editingHolder = edit;
  $('holder-dialog-title').textContent = edit ? '修改持有人姓名' : '新增持有人';
  $('holder-error').textContent = '';
  field($('holder-form'), 'name').value = edit ? holderName() : '';
  $('holder-dialog').showModal();
}
$('holder-add').addEventListener('click', () => openHolderDialog(false));
$('holder-edit').addEventListener('click', () => openHolderDialog(true));
$('holder-cancel').addEventListener('click', () => $('holder-dialog').close());
$('holder-form').addEventListener('submit', event => {
  event.preventDefault();
  const name = field(event.currentTarget, 'name').value;
  const holder = editingHolder ? activeHolder() : { id: uuid() };
  if (!holder) return;
  try {
    const update = { ...holder, name };
    const holders = editingHolder ? state.holders.map(row => row.id === holderId ? update : row) : [...state.holders, update];
    persist({ ...state, holders });
    $('holder-dialog').close();
    if (editingHolder) renderLedger();
    else selectHolder(holder.id);
  } catch (error) { $('holder-error').textContent = error.message; }
});
function openTradeEditor() {
  $('trade-editor').open = true;
  $('trade-type').focus();
}
$('trade-open').addEventListener('click', openTradeEditor);
$('holding-add').addEventListener('click', openTradeEditor);
function renderShare() {
  if (shareSnapshot) drawShare($('share-canvas'), shareSnapshot, $('share-details').checked);
}
$('share-open').addEventListener('click', () => {
  shareSnapshot = { name: holderName(), book: portfolio(state.trades, holderId, quotes), createdAt: Date.now() };
  $('share-details').checked = false;
  try {
    renderShare();
    $('share-dialog').showModal();
  } catch (error) { notice(error.message, true); }
});
$('share-details').addEventListener('change', renderShare);
$('share-dialog').addEventListener('close', () => { shareSnapshot = null; });
$('share-save').addEventListener('click', () => {
  const name = shareSnapshot?.name;
  if (!name) return;
  $('share-canvas').toBlob(blob => {
    if (!blob) return notice('生成图片失败，请重试。', true);
    const link = el('a');
    link.download = `持仓收益-${name}-${chinaDay()}.png`;
    link.href = URL.createObjectURL(blob);
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 5000);
  }, 'image/png');
});

options($('trade-type'), Object.entries(tradeTypes));
options(field($('research-form'), 'kind'), directions.map(name => [name, name]));
document.querySelectorAll('input[type=date]').forEach(input => { input.value = chinaDay(); });
$('trade-type').addEventListener('change', tradeFields);
field($('goal-form'), 'kind').addEventListener('change', goalFields);
field($('goal-form'), 'symbol').addEventListener('input', goalFields);
document.querySelectorAll('.refresh-quotes').forEach(button => button.addEventListener('click', () => refreshQuotes(true)));
$('sentiment-refresh').addEventListener('click', () => refreshSnapshot(true));
tradeFields();
goalFields();
let sessionUnknown = false;
async function restoreAccount() {
  try {
    const result = await api('/api/grid/auth');
    sessionUnknown = false;
    if (!accountBusy) await account(result.user);
  } catch (error) {
    sessionUnknown = error.status !== 401;
    if (!storageKey) account(null);
  }
}
await restoreAccount();
if (new URLSearchParams(location.search).get('tab') === 'goal') selectTab($('tab-goal'));
window.addEventListener('hashchange', () => { void importLinkedData(); });
void importLinkedData();
window.addEventListener('online', () => {
  if (sessionUnknown && !cloud && !accountBusy) void restoreAccount();
  else void syncCloud(cloud);
  if (!$('goal').hidden) void refreshGoalReminders();
});
window.addEventListener('focus', () => {
  if (cloud && Date.now() - cloud.checkedAt > 10_000) void syncCloud(cloud);
  if (!$('goal').hidden) void refreshGoalReminders();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden && pending) void syncCloud(cloud);
});
setInterval(() => { if (visible() && tradingWindow()) void refreshQuotes(); }, 60_000);
