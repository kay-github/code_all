import {
  buckets, horizons, directions, metrics, tradeTypes, initialState, chinaDay,
  SELF, holderTrades, portfolio, replay, validateState, evaluateGoals, quoteKey,
} from './model.mjs';
import { drawShare } from './share.mjs';

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
async function api(url, method = 'GET', data) {
  const response = await fetch(url, {
    method, cache: 'no-store', signal: AbortSignal.timeout(12_000),
    ...(data === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(Error(body.error || '请求失败'), { status: response.status });
  return body;
}

function persist(next, revision = remoteRev) {
  if (!storageKey) throw Error('账本正在加载，请稍后再试。');
  const clean = validateState(next);
  if (localStorage.getItem(storageKey) !== savedLocal) throw Error('此账本已在另一个页面更新，请刷新后重试。');
  const serialized = JSON.stringify({ state: clean, remoteRev: revision });
  localStorage.setItem(storageKey, serialized);
  savedLocal = serialized;
  state = clean;
  remoteRev = revision;
}
function account(nextUser) {
  const key = 'investment-theory:v1:' + (nextUser?.id ?? 'guest');
  user = nextUser;
  $('account-status').textContent = user ? `当前账号 · ${user.username}` : '本机账本';
  $('login-form').hidden = Boolean(user);
  $('cloud-actions').hidden = !user;
  if (storageKey === key) return;
  storageKey = key;
  quotes = {};
  state = initialState();
  holderId = SELF;
  drafts.clear();
  resetTradeForm();
  closeHolderDialogs();
  remoteRev = null;
  savedLocal = null;
  try {
    savedLocal = localStorage.getItem(key);
    const saved = JSON.parse(savedLocal || 'null');
    if (saved) {
      state = validateState(saved.state);
      remoteRev = Number.isSafeInteger(saved.remoteRev) && saved.remoteRev > 0 ? saved.remoteRev : null;
    }
  } catch { notice('读取本机账本失败，可以从 JSON 或云备份恢复。', true); }
  renderLedger();
  void refreshQuotes();
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
function rowCard(title, meta, body, collection, id) {
  const article = el('article', 'entry');
  const header = el('header');
  header.append(el('strong', '', title), removeButton(title, collection, id));
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
    const rows = marked.filter(row => row.bucket === buckets[index]);
    const value = rows.some(row => row.market === null) ? null : rows.reduce((sum, row) => sum + row.market, 0);
    const actual = basis > 0 ? value / basis * 100 : null;
    const card = el('section', 'bucket');
    const heading = el('h3', '', bucket.name);
    heading.append(el('span', 'target', `目标 ${pct(bucket.target)}`));
    const stats = el('p', 'bucket-stats');
    stats.append(el('strong', '', pct(actual)), el('span', 'meta', money(value)));
    const delta = actual === null ? null : actual - bucket.target;
    card.append(heading, stats, allocationBar(actual, bucket.target), el('p', 'meta', delta === null
      ? (rows.length ? '占比待行情或净资产' : '暂无持仓') : `偏离目标 ${delta > 0 ? '+' : ''}${fmt.format(delta)} 个百分点`));
    if (!rows.length) return card;
    const group = el('details', 'panel holding-group');
    group.open = true;
    group.dataset.bucket = buckets[index];
    group.append(el('summary', '', `${bucket.name} · ${rows.length} 个持仓`));
    for (const row of rows) {
      const position = el('div', 'position-row');
      const quoteStatus = row.quote?.stale ? ' · 缓存' : row.quote?.suspended ? ' · 停牌' : '';
      position.append(
        el('strong', '', row.quote?.name ? `${row.quote.name} · ${row.symbol}` : row.symbol),
        el('p', 'meta', `${fmt.format(row.qty)} 股/份 · 成本 ¥${(row.cost / row.qty / 100).toFixed(3)}`),
        el('p', 'meta', `现价 ${row.quote?.price ?? '—'}${quoteStatus} · 市值 ${money(row.market)}`),
        el('p', difference(row.profit), `浮盈亏 ${money(row.profit)}`),
      );
      group.append(position);
    }
    groups.push(group);
    return card;
  });
  const residual = 100 - allocation.reduce((sum, row) => sum + row.target, 0);
  $('allocation-foot').textContent = `未分配目标 ${pct(Math.max(0, residual))} · 账本现金占比 ${pct(basis > 0 ? cash / basis * 100 : null)}`;
  $('allocations').replaceChildren(...cards);
  const closed = new Set([...$('holdings').querySelectorAll('details:not([open])')].map(group => group.dataset.bucket));
  for (const group of groups) if (closed.has(group.dataset.bucket)) group.open = false;
  $('holdings').replaceChildren(...groups);
}
function renderAllocationEditor() {
  const allocation = allocationForHolder();
  const fields = allocation.flatMap((row, index) => [
    [`name-${index}`, `仓位 ${index + 1} 名称`, row.name],
    [`target-${index}`, `仓位 ${index + 1} 目标占比（%）`, row.target],
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
  options(field($('trade-form'), 'bucket'), buckets.map((bucket, index) => [bucket, allocation[index].name]));
}
function renderTrades() {
  const trades = holderTrades(state.trades, holderId);
  const allocation = allocationForHolder();
  $('trade-count').textContent = `（${trades.length}）`;
  $('trades').replaceChildren(...trades.reverse().sort((a, b) => b.date.localeCompare(a.date)).map(row => {
    const details = [row.date, row.symbol, allocation[buckets.indexOf(row.bucket)]?.name,
      row.qty !== undefined ? `${fmt.format(row.qty)} 股/份` : null,
      row.price !== undefined ? `¥${row.price} / 股` : null,
      row.amount !== undefined ? money(Math.round(row.amount * 100)) : null,
    ].filter(Boolean);
    return rowCard(tradeTypes[row.type], details.join(' · '), row.note, 'trades', row.id);
  }));
}
function renderGoals() {
  $('goals').replaceChildren(...horizons.map(horizon => {
    const group = el('section', 'goal-group');
    group.append(el('h3', '', horizon));
    const rows = state.goals.filter(row => row.horizon === horizon);
    if (!rows.length) group.append(el('p', 'muted', '暂无目标'));
    for (const row of rows) {
      const quote = row.symbol ? quotes[quoteKey(row.symbol, row.index)] : null;
      const condition = row.symbol ? `${row.symbol} · ${metrics[row.metric]} ${row.operator} ${row.threshold}` : '文字目标';
      const card = rowCard(row.title, condition, row.note, 'goals', row.id);
      if (quote && Number.isFinite(quote[row.metric])) {
        card.append(el('p', 'meta', `最近读数 ${quote[row.metric]} · ${stamp(quote.time)}${quote.stale ? ' · 缓存' : ''}`));
      }
      if (row.hit) card.append(el('p', 'positive', `最近触发 ${row.hit.value} · ${stamp(row.hit.time)}`));
      group.append(card);
    }
    return group;
  }));
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
  for (const [name, value] of Object.entries(drafts.get(next) ?? {})) field(form, name).value = value;
  tradeFields();
  void refreshQuotes();
}
function closeHolderDialogs() {
  $('holder-dialog').close();
  $('share-dialog').close();
  shareSnapshot = null;
}
function replaceLedger(data, revision) {
  persist(data, revision);
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
function snapshotCard(title, data, showZone = false) {
  const card = el('div');
  card.append(el('h3', '', title));
  if (!data?.items?.length) { card.append(el('p', 'muted', '快照暂不可用')); return card; }
  const list = el('ul');
  for (const item of data.items) {
    const entry = el('li');
    entry.append(el('span', '', item.name), el('span', 'meta', [
      Number.isFinite(item.score) ? fmt.format(item.score) : '暂无分数',
      showZone ? item.zone : null, item.date, item.stale ? '旧快照' : null,
    ].filter(Boolean).join(' · ')));
    list.append(entry);
  }
  card.append(el('p', 'meta', ['金融工作台快照', data.model, data.stale ? '缓存' : null].filter(Boolean).join(' · ')), list);
  return card;
}
async function refreshSnapshot(force = false) {
  if (loadingSnapshot || (snapshot && !force)) return;
  loadingSnapshot = true;
  $('sentiment-refresh').disabled = true;
  try {
    snapshot = await api('/api/investment-market?view=sentiment');
    $('sentiment').replaceChildren(snapshotCard('恐贪指数', snapshot.fear, true), snapshotCard('关注板块拥挤度', snapshot.crowding));
  } catch { $('sentiment').replaceChildren(el('p', 'muted', '快照暂不可用，可稍后刷新。')); }
  finally { loadingSnapshot = false; $('sentiment-refresh').disabled = false; }
}

function tradeFields() {
  const type = $('trade-type').value;
  const stock = !['deposit', 'withdrawal'].includes(type);
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
    notice('已保存到本机账本。');
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
  if (active.dataset.tab === 'direction') void refreshSnapshot();
}
tabs.forEach((tab, index) => {
  tab.addEventListener('click', () => selectTab(tab));
  tab.addEventListener('keydown', event => {
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!delta) return;
    event.preventDefault();
    const active = tabs[(index + delta + tabs.length) % tabs.length];
    selectTab(active);
    active.focus();
  });
  tab.disabled = false;
});
$('data-toggle').addEventListener('click', () => {
  $('data-panel').hidden = !$('data-panel').hidden;
  $('data-toggle').setAttribute('aria-expanded', String(!$('data-panel').hidden));
});
$('login-form').addEventListener('submit', accountAction(async event => {
  const form = event.currentTarget;
  const data = await api('/api/grid/auth', 'POST', { action: 'login', ...readForm(form) });
  form.reset();
  account(data.user);
  notice('已打开此账号的本机账本。');
}));
$('logout').addEventListener('click', accountAction(async () => {
  await api('/api/grid/auth', 'POST', { action: 'logout' });
  account(null);
  notice('已切回未登录的本机账本。');
}));
$('cloud-save').addEventListener('click', accountAction(async () => {
  const remote = await api(path);
  const currentRev = remote.kind === 'ok' ? remote.rev : null;
  if (currentRev !== remoteRev) throw Error('云端版本有变化。请先导出本机账本，再读取云备份核对。');
  const saved = await api(path, 'PUT', { baseRev: currentRev, data: state });
  persist(state, saved.rev);
  notice('云备份已保存。');
}));
$('cloud-load').addEventListener('click', accountAction(async () => {
  const saved = await api(path);
  if (saved.kind === 'empty') return notice('当前账号还没有云备份。');
  if (!confirm('用云备份替换当前本机账本？可以先导出本机账本。')) return;
  replaceLedger(saved.data, saved.rev);
  notice('云备份已恢复。');
}));
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
    if (key !== storageKey || !confirm('用此文件替换当前本机账本？')) return;
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
$('trade-open').addEventListener('click', () => {
  $('trade-editor').open = true;
  $('trade-type').focus();
});
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
account(await api('/api/grid/auth').then(result => result.user).catch(() => null));
setInterval(() => { if (visible() && tradingWindow()) void refreshQuotes(); }, 60_000);
