(() => {
  'use strict';

  const byId = id => document.getElementById(id);
  const labels = {
    early: '启动观察',
    confirmed: '放量确认',
    accel: '加速确认',
    running: '趋势延续',
    leaders: '龙头先动',
    watch: '继续观察',
    cooldown: '冷却中',
    extended: '涨幅已扩大',
    missing: '数据待齐',
  };
  const stageLabels = { early: '早期命中', late: '波段内首报', miss: '未触发' };
  let validation = null;
  let legFilter = 'key';

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function pct(value, digits = 1, signed = false) {
    if (value === null || value === undefined || Number.isNaN(value)) return '—';
    const text = `${Math.abs(value * 100).toFixed(digits)}%`;
    return signed && value > 0 ? `+${text}` : value < 0 ? `-${text}` : text;
  }

  function pp(value) {
    if (value === null || value === undefined) return '—';
    return `${value > 0 ? '+' : ''}${(value * 100).toFixed(1)}pp`;
  }

  function num(value, digits = 1) {
    if (value === null || value === undefined || Number.isNaN(value)) return '—';
    return Number(value).toFixed(digits);
  }

  function metric(label, value, className = '') {
    const pair = element('div', '', className);
    pair.append(element('dt', label), element('dd', value));
    return pair;
  }

  function badge(stage) {
    return element('span', labels[stage] || stage, `wave-badge ${stage}`);
  }

  function themeLeader(etfs) {
    const active = Math.max(...etfs.map(etf => etf.leaders_active || 0));
    const total = Math.max(...etfs.map(etf => etf.leaders_total || 0));
    return { active, total };
  }

  function card(etf, date, stale) {
    const node = element('article', '', 'wave-card');
    node.id = `card-${etf.code}`;
    const header = element('div', '', 'wave-card-header');
    const heading = element('h3', etf.name);
    heading.append(element('small', etf.code));
    header.append(heading, badge(etf.status));
    node.append(header, element('p', etf.reason || '等待新的 ETF 结构。', 'wave-description'));

    const breadth = element('div', '行业温度计 · 龙头量价共振', 'wave-breadth');
    const meter = element('span', '', 'wave-meter');
    const fill = element('i');
    fill.style.width = `${etf.leaders_total ? (etf.leaders_active / etf.leaders_total) * 100 : 0}%`;
    meter.append(fill);
    breadth.append(meter, element('strong', `${etf.leaders_active} / ${etf.leaders_total}`));
    node.append(breadth);

    const metrics = element('dl', '', 'wave-metrics');
    const values = etf.values;
    if (values) {
      metrics.append(
        metric('5 日相对沪深300', pp(values.relative5)),
        metric('成交额 / 20 日均值', `${num(values.amount_ratio, 2)}×`),
        metric('距前 20 日高点', pct(values.to_high20, 1, true)),
        metric('距 20 日线', pct(values.to_ma20, 1, true)),
      );
    } else {
      metrics.append(metric('行情', '待补齐'), metric('龙头覆盖', `${etf.leaders_available} / ${etf.leaders_total}`));
    }
    node.append(metrics);

    const chips = element('div', '', 'wave-reasons');
    const reasons = etf.conditions_text && etf.conditions_text.length ? etf.conditions_text : ['暂无新增结构'];
    chips.append(...reasons.slice(0, 4).map(reason => element('span', reason)));
    node.append(chips);

    const footer = element('div', '', 'wave-card-footer');
    if (etf.last_alert) {
      const today = !stale && etf.last_alert === date;
      footer.append(element('span', today ? `本期新触发 · ${etf.last_alert}` : `最近提醒 · ${etf.last_alert}`,
        today ? 'wave-new' : ''));
    } else {
      footer.append(element('span', '区间内暂无提醒'));
    }
    const source = element('a', '基金资料');
    source.href = etf.source;
    source.target = '_blank';
    source.rel = 'noopener noreferrer';
    source.setAttribute('aria-label', `${etf.name}基金资料`);
    footer.append(source);
    node.append(footer);
    return node;
  }

  function renderKpis(snapshot, stale) {
    const counts = snapshot.status_counts || {};
    const active = (counts.early || 0) + (counts.confirmed || 0) + (counts.accel || 0);
    const box = byId('wave-kpis');
    const items = [
      ['跟踪主题', `${snapshot.universe.themes}`],
      ['行业 ETF', `${snapshot.universe.etfs}`],
      ['数据日新触发', `${snapshot.new_today}`],
      ['启动 / 确认', `${active}`],
      ['样本外覆盖', validation ? pct(validation.primary.coverage, 1) : '—'],
    ];
    box.replaceChildren(...items.map(([label, value], index) => {
      const item = element('div', '', `wave-kpi${index === 2 && snapshot.new_today ? ' hot' : ''}`);
      item.append(element('span', label), element('strong', value));
      return item;
    }));
    const statusText = Object.entries(counts).filter(([, value]) => value)
      .map(([key, value]) => `${labels[key] || key} ${value}`).join(' · ');
    byId('wave-stamp').textContent = stale
      ? `快照滞后 · ${snapshot.data_date} 收盘`
      : `${snapshot.data_date} 收盘 · 覆盖 ${pct(snapshot.coverage, 0)} · ${statusText}`;
  }

  function renderToday(snapshot, stale) {
    const today = snapshot.history.filter(event => event.date === snapshot.data_date);
    const unique = new Map();
    const priority = { confirmed: 3, early: 2, accel: 1 };
    for (const event of today) {
      const existing = unique.get(event.code);
      if (!existing || (priority[event.stage] || 0) > (priority[existing.stage] || 0)) unique.set(event.code, event);
    }
    const list = byId('wave-today-list');
    byId('wave-today-count').textContent = unique.size ? `${unique.size} 条` : '无新触发';
    if (!unique.size) {
      const empty = element('p', stale ? '当前快照没有当日新触发，下面展示最近一次状态。' : '今天没有新的启动观察；已有关注对象继续按原状态跟踪。',
        'wave-empty');
      list.replaceChildren(empty);
      return;
    }
    list.replaceChildren(...Array.from(unique.values(), event => {
      const row = element('a', '', 'wave-alert-row');
      row.href = `#card-${event.code}`;
      const main = element('div', '', 'wave-alert-main');
      main.append(element('strong', event.name), element('span', event.theme),
        element('small', `龙头 ${event.leaders_active} 只共振`));
      row.append(main, badge(event.stage), element('span', event.description, 'wave-alert-note'));
      return row;
    }));
  }

  function renderGroups(snapshot, stale) {
    const themes = new Map();
    for (const etf of snapshot.etfs) {
      if (!themes.has(etf.theme)) themes.set(etf.theme, []);
      themes.get(etf.theme).push(etf);
    }
    byId('wave-groups').replaceChildren(...Array.from(themes, ([theme, etfs]) => {
      const section = element('section', '', `wave-group${etfs.length > 1 ? ' wave-wide' : ''}`);
      const head = element('div', '', 'wave-group-head');
      const title = element('h2', theme);
      const leader = themeLeader(etfs);
      head.append(title, element('span', `龙头温度计 ${leader.active} / ${leader.total}`, 'wave-group-meta'));
      const grid = element('div', '', 'wave-cards');
      grid.append(...etfs.map(etf => card(etf, snapshot.data_date, stale)));
      section.append(head, grid);
      return section;
    }));
  }

  function renderHistory(snapshot) {
    const events = snapshot.history.slice(0, 30);
    byId('wave-history').replaceChildren(...(events.length ? events.map(event => {
      const item = element('li');
      const date = element('time', event.date);
      date.dateTime = event.date;
      const main = element('div', '', 'wave-history-main');
      main.append(element('strong', event.name), element('span', `${event.theme} · 龙头 ${event.leaders_active} 只`));
      item.append(date, main, badge(event.stage));
      return item;
    }) : [element('li', '当前快照暂无提醒。', 'wave-empty')]));
  }

  function renderValidation() {
    if (!validation) {
      byId('validation').hidden = true;
      return;
    }
    const p = validation.primary;
    const r = validation.random;
    const kpis = [
      ['主升浪样本', `${p.waves} 段`],
      ['提醒覆盖', `${p.hit} / ${p.waves} · ${pct(p.coverage, 1)}`],
      ['早期覆盖', `${p.early} / ${p.waves} · ${pct(p.early_coverage, 1)}`],
      ['首报滞后中位', `${num(p.median_delay, 0)} 日`],
      ['早期命中率', pct(p.early_precision, 1)],
      ['年提醒 / ETF', num(p.annual_alerts, 1)],
    ];
    byId('val-kpis').replaceChildren(...kpis.map(([label, value], index) => {
      const item = element('div', '', `wave-kpi${index === 4 ? ' warn' : ''}`);
      item.append(element('span', label), element('strong', value));
      return item;
    }));

    const rules = [
      { label: '启动观察（组合）', stats: p, primary: true },
      { label: '加速确认（thrust）', stats: validation.acceleration, primary: true },
      ...validation.rules,
    ];
    byId('val-rules').replaceChildren(...rules.map(rule => {
      const stats = rule.stats || rule.oos;
      const row = element('tr', '', rule.primary ? 'wave-rule-primary' : '');
      const name = element('th', rule.label);
      name.scope = 'row';
      if (rule.primary) name.append(element('small', '上线层'));
      row.append(name,
        element('td', pct(stats.coverage, 1)),
        element('td', pct(stats.early_coverage, 1)),
        element('td', pct(stats.precision, 1)),
        element('td', pct(stats.early_precision, 1), stats.early_precision < 0.1 ? 'warn-cell' : ''),
        element('td', num(stats.annual_alerts, 1)));
      return row;
    }));

    byId('val-cohorts').replaceChildren(...validation.cohorts.map(cohort => {
      const row = element('tr');
      const name = element('th', cohort.label);
      name.scope = 'row';
      const s = cohort.stats;
      row.append(name, element('td', `${s.hit} / ${s.waves}`), element('td', pct(s.coverage, 1)),
        element('td', pct(s.early_coverage, 1)), element('td', pct(s.early_precision, 1)), element('td', num(s.annual_alerts, 1)));
      return row;
    }));

    renderLegs();
    const forward = validation.forward;
    const rows = [
      ['全部启动观察', forward.all],
      ['早期命中样本（事后条件）', forward.early_hit_sample],
      ['2026 年样本', forward.by_year['2026']],
      ['同期任意日基准', { count: forward.baseline.count, avg: forward.baseline.avg, win: forward.baseline.win, avg_excess: null }],
    ];
    byId('val-forward').replaceChildren(...rows.filter(([, item]) => item).map(([label, item]) => {
      const row = element('tr');
      const name = element('th', label);
      name.scope = 'row';
      row.append(name, element('td', num(item.count, 0)), element('td', pct(item.avg, 1, true)),
        element('td', pct(item.win, 1)), element('td', item.avg_excess === null ? '—' : pp(item.avg_excess)));
      return row;
    }));

    const holdingLabels = { etf_only: '仅 ETF 自身信号', two_of_five: '2/5 龙头确认', three_of_five: '3/5 龙头确认' };
    byId('val-holdings').replaceChildren(...Object.entries(validation.holdings).map(([key, stats]) => {
      const row = element('tr', '', key === 'etf_only' ? 'wave-rule-primary' : '');
      const name = element('th', holdingLabels[key] || key);
      name.scope = 'row';
      row.append(name, element('td', pct(stats.coverage, 1)), element('td', pct(stats.early_coverage, 1)),
        element('td', pct(stats.early_precision, 1)), element('td', num(stats.annual_alerts, 1)));
      return row;
    }));
  }

  function renderLegs() {
    if (!validation) return;
    const legs = validation.legs.filter(leg => legFilter === 'all' || leg.key);
    byId('val-legs').replaceChildren(...legs.map(leg => {
      const row = element('tr', '', leg.stage === 'miss' ? 'wave-miss' : '');
      const name = element('th');
      name.scope = 'row';
      name.append(element('strong', `${leg.name} ${leg.code}`), element('small', leg.theme));
      row.append(name, element('td', `${leg.low} → ${leg.high}`), element('td', pct(leg.gain, 1, true)),
        element('td', leg.early_signal || leg.signal || '—'),
        element('td', leg.delay === null || leg.delay === undefined ? '—' : `${leg.delay} 日`),
        element('td', pct(leg.fraction, 1)),
        element('td', stageLabels[leg.stage] || leg.stage));
      return row;
    }));
  }

  function switchLegFilter(next) {
    legFilter = next;
    for (const button of document.querySelectorAll('[data-leg-filter]')) {
      button.classList.toggle('on', button.dataset.legFilter === next);
    }
    renderLegs();
  }

  function render(snapshot, stale) {
    byId('wave-status').classList.toggle('wave-delayed', stale);
    const latest = snapshot.history.filter(event => event.date === snapshot.data_date).length;
    byId('wave-status').textContent = stale
      ? `快照待更新 · 当前显示 ${snapshot.data_date} 收盘结果`
      : `${snapshot.data_date} 收盘 · ${snapshot.universe.themes} 个主题 · ${snapshot.universe.etfs} 只 ETF · ${latest ? `${snapshot.new_today} 条新提醒` : '暂无新提醒'}`;
    renderKpis(snapshot, stale);
    renderToday(snapshot, stale);
    renderGroups(snapshot, stale);
    renderHistory(snapshot);
  }

  async function getJSON(path) {
    const response = await fetch(path, { cache: 'no-store' });
    if (!response.ok) throw new Error(`${path}: ${response.status}`);
    return response.json();
  }

  async function load() {
    const status = byId('wave-status');
    const retry = byId('wave-retry');
    retry.hidden = true;
    status.textContent = '正在读取 ETF 收盘数据…';
    try {
      const snapshot = await getJSON('data/main-wave.json');
      const meta = await getJSON('data/meta.json').catch(() => null);
      validation = await getJSON('data/main-wave-validation.json').catch(() => null);
      const stale = !!(meta && meta.data_date > snapshot.data_date) ||
        Date.now() - Date.parse(`${snapshot.data_date}T15:00:00+08:00`) > 4 * 86400000;
      render(snapshot, stale);
      renderValidation();
      byId('wave-content').hidden = false;
    } catch (error) {
      console.error(error);
      status.textContent = `主升浪快照暂时无法读取${error.message ? `（${error.message}）` : ''}。`;
      retry.hidden = false;
    }
  }

  byId('wave-theme').addEventListener('click', () => window.ToolSiteTheme?.toggle());
  byId('wave-retry').addEventListener('click', load);
  for (const button of document.querySelectorAll('[data-leg-filter]')) {
    button.addEventListener('click', () => switchLegFilter(button.dataset.legFilter));
  }
  load();
})();
