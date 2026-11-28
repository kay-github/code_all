(() => {
  const element = id => document.getElementById(id);
  const labels = { enter: '入场', exit: '离场', hold: '继续入选', watch: '观察' };
  const signed = new Intl.NumberFormat('zh-CN', { style: 'percent', signDisplay: 'exceptZero', maximumFractionDigits: 2 });
  const score = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2, signDisplay: 'exceptZero' });
  const percentage = new Intl.NumberFormat('zh-CN', { style: 'percent', maximumFractionDigits: 2 });
  const clock = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short' });
  let snapshot;
  let busy = false;

  function create(tag, text, className) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function renderRanking() {
    const filter = element('filter').value;
    const rows = snapshot.current.filter(row => filter === 'all' || row.signal === filter);
    element('ranking').replaceChildren(...rows.map(row => {
      const tr = create('tr');
      const sector = create('td', row.name);
      sector.append(create('small', row.code, 'ticker'));
      const signClass = row.return10 > 0 ? 'up' : row.return10 < 0 ? 'down' : '';
      const signalClass = row.signal === 'enter' ? 'up' : row.signal === 'exit' ? 'down' : '';
      tr.append(create('td', String(row.rank)), sector, create('td', score.format(row.score * 100), 'fit'), create('td', signed.format(row.return10), signClass + ' fit'),
        create('td', labels[row.signal], signalClass));
      return tr;
    }));
    if (!rows.length) {
      const row = create('tr');
      const cell = create('td', '本期没有该状态的板块。');
      cell.colSpan = 5;
      row.append(cell);
      element('ranking').append(row);
    }
  }

  function render(data) {
    snapshot = data;
    const { latest, current, history, backtest } = data;
    const byCode = new Map(current.map(row => [row.code, row]));
    function showList(id, codes) {
      const items = codes.map(code => {
        const li = create('li', byCode.get(code).name);
        li.append(create('small', code));
        return li;
      });
      element(id).replaceChildren(...(items.length ? items : [create('li', '无')]));
    }
    showList('entered', latest.entered);
    showList('exited', latest.exited);
    showList('held', latest.selected.filter(code => !latest.entered.includes(code)));
    const reference = latest.referenceDate ? '次日收盘参考 ' + latest.referenceDate : '等待下一个交易日收盘';
    element('signal-date').textContent = '确认于 ' + latest.signalDate + ' · ' + reference;
    element('history').replaceChildren(...history.map(event => {
      const names = codes => codes.map(code => byCode.get(code).name).join('、') || '无';
      const li = create('li');
      li.append(create('strong', event.signalDate), create('p', '入场 ' + names(event.entered) + ' · 离场 ' + names(event.exited)));
      return li;
    }));
    element('sample').textContent = backtest.start + ' 至 ' + backtest.end + ' · 近约 900 个自然日滚动样本';
    const difference = (backtest.strategy.total - backtest.benchmark.total) * 100;
    element('assessment').textContent = '本样本内，因子轮动较同池等权' +
      (difference < 0 ? '落后 ' : '领先 ') + Math.abs(difference).toFixed(2) + ' 个百分点。';
    element('results').replaceChildren(...[['因子轮动', backtest.strategy], ['纯涨幅轮动', backtest.momentum], ['同池等权', backtest.benchmark]].map(([name, value]) => {
      const row = create('tr');
      row.append(create('td', name), create('td', signed.format(value.total)), create('td', percentage.format(value.drawdown)));
      return row;
    }));
    element('dashboard').hidden = false;
    renderRanking();
  }

  function expectedWorkday() {
    const [day, time] = clock.format(new Date()).split(' ');
    const date = new Date(day + 'T00:00:00Z');
    if (time < '16:45') date.setUTCDate(date.getUTCDate() - 1);
    while ([0, 6].includes(date.getUTCDay())) date.setUTCDate(date.getUTCDate() - 1);
    return date.toISOString().slice(0, 10);
  }

  function status(prefix, notice) {
    element('status').textContent = snapshot
      ? prefix + ' · 行情截至 ' + snapshot.asOf + ' · ' + snapshot.source
      : prefix;
    element('status').parentElement.dataset.level = notice ? 'notice' : 'normal';
  }

  async function request(path) {
    const response = await fetch(path, { cache: 'no-cache', signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw Error('快照读取失败');
    const data = await response.json();
    if (data.schema !== 1 || !data.current?.length) throw Error('快照格式无效');
    return data;
  }

  async function refresh() {
    if (busy) return;
    busy = true;
    element('refresh').disabled = true;
    try {
      const data = await request('/api/investment-market?view=sector-rotation');
      if (!snapshot || data.asOf >= snapshot.asOf) render(data);
      const older = snapshot.asOf < expectedWorkday();
      const notice = older || data.fallback;
      status(older ? '最新核对日期较早，可能遇到休市或更新延迟' : data.fallback ? '已载入发布快照' : '已载入收盘快照', notice);
    } catch {
      try {
        if (!snapshot) render(await request('/tools/sector-rotation/snapshot.json'));
        status('更新服务暂不可用，显示最近一次可用快照', true);
      } catch {
        status('板块轮动数据暂不可用，请稍后刷新。', true);
      }
    } finally {
      busy = false;
      element('refresh').disabled = false;
    }
  }

  element('theme').addEventListener('click', () => window.ToolSiteTheme.toggle());
  element('filter').addEventListener('change', renderRanking);
  element('refresh').addEventListener('click', refresh);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  setInterval(() => { if (!document.hidden) refresh(); }, 5 * 60_000);
  refresh();
})();
