(() => {
  const byId = id => document.getElementById(id);
  const labels = { trend: '120 日趋势', incumbent: '现版因子', equal: '同池等权' };
  const keys = Object.keys(labels);
  const executions = { filled: '已按开盘模拟成交', deferred: '开盘触及交易限制，留待后续开盘', none: '当日无调仓' };
  const percent = new Intl.NumberFormat('zh-CN', {
    style: 'percent', maximumFractionDigits: 2, minimumFractionDigits: 2, signDisplay: 'exceptZero',
  });
  const localClock = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short' });
  let shown;
  let busy = false;

  function node(tag, text, className) {
    const item = document.createElement(tag);
    if (text != null) item.textContent = text;
    if (className) item.className = className;
    return item;
  }

  function pct(value) {
    return value == null ? '—' : percent.format(value);
  }

  function expectedDay() {
    const [date, time] = localClock.format(new Date()).split(' ');
    const day = new Date(date + 'T00:00:00Z');
    if (time < '17:15') day.setUTCDate(day.getUTCDate() - 1);
    while ([0, 6].includes(day.getUTCDay())) day.setUTCDate(day.getUTCDate() - 1);
    return day.toISOString().slice(0, 10);
  }

  function render(data) {
    const { days, spec, asOf, signal, sectors, review } = data;
    const last = days.at(-1);
    const captions = new Map(sectors.map(({ code, name }) => [code, name]));
    const names = codes => codes.map(code => captions.get(code)).join('、') || '无';
    byId('trial-start').textContent = '启动日 ' + spec.start + ' · 规则 ' + spec.version;
    byId('trial-status').textContent = !last
      ? '开盘计划已锁定，等待首个交易日收盘'
      : '已记录 ' + days.length + ' 个交易日 · 行情截至 ' + asOf + (asOf < expectedDay() ? ' · 等待新日线（可能休市）' : '');
    byId('trial-results').replaceChildren(...keys.map(key => {
      const record = last?.groups[key];
      const row = node('tr');
      row.append(node('th', labels[key]), node('td', pct(record?.total), 'fit'),
        node('td', pct(record?.maxDrawdown), 'fit'), node('td', pct(record?.exposure), 'fit'));
      row.firstElementChild.scope = 'row';
      return row;
    }));
    byId('trial-evaluation').textContent = review
      ? '首轮已完成 ' + review.sessions + ' 个交易日 · ' + review.asOf +
        (review.passed ? ' · 达到替换前复核条件' : ' · 本轮未达到替换门槛')
      : '首轮验证 ' + days.length + ' / ' + spec.reviewSessions + ' 个交易日';
    byId('trial-signal-date').textContent = '信号确认于 ' + signal.date + (last ? ' · 双周评估' : ' · 开盘初始化依据');
    byId('trial-signals').replaceChildren(...keys.map(key => {
      const { selected, entered, exited } = signal.groups[key];
      const prior = last?.groups[key];
      const item = node('li');
      item.append(node('strong', labels[key]), node('p', !last ? '开盘计划 ' + names(selected) :
        '入场 ' + names(entered) + ' · 离场 ' + names(exited) + ' · 目标 ' + names(selected)));
      if (prior) {
        const queued = data.pending[key] ? ' · 有待执行的目标' : '';
        item.append(node('p', '实际模拟持有 ' + names(prior.held) + ' · ' + executions[prior.execution] + queued));
      }
      return item;
    }));
    byId('trial-sectors').replaceChildren(...sectors.map(({ code, name, distance }) => {
      const trend = signal.groups.trend;
      const status = !last ? (trend.selected.includes(code) ? '计划持有' : '观察') :
        trend.entered.includes(code) ? '入场' : trend.exited.includes(code) ? '离场' :
        trend.selected.includes(code) ? '继续入选' : '观察';
      const row = node('tr');
      const title = node('td', name);
      title.append(node('small', code, 'ticker'));
      row.append(title, node('td', pct(distance), 'fit'), node('td', status));
      return row;
    }));
    byId('trial-days').replaceChildren(...days.slice().reverse().map(day => {
      const row = node('tr');
      row.append(node('td', day.date, 'fit'));
      for (const key of keys) {
        const summary = day.groups[key];
        const cell = node('td', pct(summary.total), 'fit');
        cell.append(node('small', '回撤 ' + pct(summary.drawdown), 'ticker'));
        row.append(cell);
      }
      return row;
    }));
    byId('trial-stress-results').replaceChildren(...keys.map(key => {
      const row = node('tr');
      row.append(node('th', labels[key]), node('td', pct(data.stress[key]), 'fit'),
        node('td', data.sharpe[key] == null ? '—' : data.sharpe[key].toFixed(2), 'fit'));
      row.firstElementChild.scope = 'row';
      return row;
    }));
    byId('trial-stress').hidden = !last;
    byId('trial-history').hidden = !last;
    byId('trial-data').hidden = false;
    shown = data;
  }

  async function refresh() {
    if (busy) return;
    busy = true;
    const button = byId('trial-refresh');
    button.disabled = true;
    try {
      const response = await fetch('/api/investment-market?view=sector-rotation-trial', { cache: 'no-cache', signal: AbortSignal.timeout(8_000) });
      if (!response.ok) throw Error('前瞻对照暂不可用');
      const data = await response.json();
      if (!data.spec?.version || !Array.isArray(data.days)) throw Error('前瞻快照格式无效');
      if (!shown || data.days.length >= shown.days.length) render(data);
    } catch {
      byId('trial-status').textContent = shown
        ? '暂时无法获取更新，显示已读取的记录 · 截至 ' + shown.asOf
        : '前瞻对照暂不可用，可稍后刷新。';
    } finally {
      busy = false;
      button.disabled = false;
    }
  }

  byId('trial-refresh').addEventListener('click', refresh);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  setInterval(() => { if (!document.hidden) refresh(); }, 5 * 60_000);
  refresh();
})();
