const fmt = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const p = value => fmt.format(value);
const r = value => `${value.toFixed(3)} 倍`;
const percent = value => `${(value * 100).toFixed(1)}%`;

function make(tag, body, cls) {
  const node = document.createElement(tag);
  if (body !== undefined) node.textContent = body;
  if (cls) node.className = cls;
  return node;
}

function controls(items, select, name) {
  const group = make('div', undefined, 'stock-controls');
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', name);
  for (const [i, label] of items.entries()) {
    const button = make('button', label);
    button.type = 'button';
    button.setAttribute('aria-pressed', String(i === 0));
    button.addEventListener('click', () => {
      for (const child of group.children) child.setAttribute('aria-pressed', String(child === button));
      select(i);
    });
    group.append(button);
  }
  return group;
}

function scenarioCard(scenario, title, weekly) {
  const card = make('article', undefined, `stock-card ${scenario.type}`);
  card.append(make('h3', title), make('p', scenario.progress, 'status'));
  const levels = [
    [scenario.ratioLabel, r(scenario.ratio)],
    [scenario.type === 'abc' ? 'B 对 A 回补' : '第2浪回撤', percent(scenario.recovery)],
    ['末段低点', p(scenario.floor)], ['收盘复核线', p(scenario.watch)],
  ];
  if (scenario.fifthRatio != null) levels.push(['5 / 1', r(scenario.fifthRatio)]);
  if (scenario.type === 'impulse') levels.push(['第4浪重叠界线', p(scenario.overlap)]);
  const grid = make('dl', undefined, 'levels');
  for (const [title, value] of levels) {
    const pair = make('div');
    pair.append(make('dt', title), make('dd', value, 'num'));
    grid.append(pair);
  }
  card.append(grid);
  const path = make('ol', undefined, 'stock-anchors');
  for (const point of scenario.anchors) {
    const item = make('li');
    item.append(make('strong', `${point.label} · ${p(point.price)}`), make('small', point.date));
    path.append(item);
  }
  card.append(path);
  const sessions = weekly ? '周' : '日';
  const stability = scenario.verifiedOn ? `${scenario.verifiedOn} 已连续两${sessions}收在 ${p(scenario.watch)} 上方。` :
    `连续两${sessions}收在 ${p(scenario.watch)} 上方，复核目前的延伸判断。`;
  card.append(make('p', `${stability} 再破 ${p(scenario.floor)} 会改写当前末端低点。`, 'stock-trigger'));
  if (scenario.type === 'impulse') {
    const checks = [`若第4浪高点进入 ${p(scenario.overlap)} 上方的第1浪区间，普通推动数法失效。`];
    if (scenario.shortestLine != null) checks.push(`第5浪下破 ${p(scenario.shortestLine)} 会使第3浪成为最短，推翻这组计数。`);
    if (scenario.invalid.length) checks.push(`已触发 ${scenario.invalid.join('、')}。`);
    card.append(make('p', checks.join(' '), 'stock-trigger'));
  }
  if (scenario.levels.length) {
    const band = scenario.levels.map(line => `${line.label} ${p(line.price)}`).join('　');
    card.append(make('p', `同级长度投影　${band}`, 'muted stock-projection'));
  }
  return card;
}

function chart(canvas, period, active, hover) {
  if (!canvas.clientWidth || !period) return;
  const ctx = canvas.getContext('2d');
  const width = canvas.clientWidth, height = canvas.clientHeight;
  const pixel = Math.min(devicePixelRatio || 1, 2);
  canvas.width = width * pixel;
  canvas.height = height * pixel;
  ctx.scale(pixel, pixel);
  const css = getComputedStyle(document.documentElement);
  const color = token => css.getPropertyValue(token).trim();
  const dates = new Map(period.bars.map((row, i) => [row[0], i]));
  const scenario = period[active];
  const left = 51, right = width - 13, top = 19, bottom = height - 25;
  const min = Math.min(...period.bars.map(b => b[3])), max = Math.max(...period.bars.map(b => b[2]));
  const margin = Math.max((max - min) * 0.08, 1);
  const x = i => left + i * (right - left) / Math.max(1, period.bars.length - 1);
  const y = value => bottom - (value - min + margin) / (max - min + 2 * margin) * (bottom - top);
  const line = (x0, y0, x1, y1) => {
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
  };
  ctx.font = '12px system-ui';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < 5; i++) {
    const price = min + (max - min) / 4 * i;
    const Y = y(price);
    ctx.strokeStyle = color('--line');
    ctx.fillStyle = color('--muted');
    ctx.fillText(Math.round(price), 4, Y);
    line(left, Y, right, Y);
  }
  const ticks = width > 650 ? 7 : 4;
  for (let i = 0; i < ticks; i++) {
    const index = Math.round(i * (period.bars.length - 1) / (ticks - 1));
    ctx.fillStyle = color('--muted'); ctx.textAlign = i === ticks - 1 ? 'right' : 'left';
    ctx.fillText(period.bars[index][0].slice(5), x(index), height - 10);
  }
  ctx.textAlign = 'left';
  const half = Math.min(4, Math.max(.8, (right - left) / period.bars.length * .30));
  for (const [i, row] of period.bars.entries()) {
    const X = x(i), O = y(row[1]), C = y(row[4]);
    ctx.strokeStyle = color(row[4] >= row[1] ? '--positive' : '--negative');
    ctx.fillStyle = ctx.strokeStyle;
    line(X, y(row[2]), X, y(row[3]));
    ctx.fillRect(X - half, Math.min(O, C), half * 2, Math.max(1, Math.abs(O - C)));
  }
  ctx.setLineDash([4, 4]);
  for (const [price, token] of [[scenario.watch, '--positive'], [scenario.floor, '--negative']]) {
    ctx.strokeStyle = color(token);
    line(left, y(price), right, y(price));
  }
  ctx.setLineDash([]);
  const hue = color(active === 'main' ? '--accent' : '--group-text');
  for (const [i, point] of scenario.anchors.entries()) {
    const X = x(dates.get(point.bar)), Y = y(point.price);
    ctx.strokeStyle = hue; ctx.fillStyle = hue; ctx.lineWidth = 2.4;
    if (i) {
      const last = scenario.anchors[i - 1];
      line(x(dates.get(last.bar)), y(last.price), X, Y);
    }
    ctx.beginPath(); ctx.arc(X, Y, 4, 0, Math.PI * 2); ctx.fill();
    const label = width < 550 ? point.label : `${point.label} ${p(point.price)}`;
    const tx = Math.max(left, Math.min(right - ctx.measureText(label).width, X + 5));
    const ty = Math.max(top - 8, Math.min(bottom + 1, Y + (i % 2 ? 13 : -10)));
    ctx.fillStyle = color('--surface'); ctx.fillRect(tx - 2, ty - 7, ctx.measureText(label).width + 4, 14);
    ctx.fillStyle = hue; ctx.fillText(label, tx, ty);
  }
  if (hover != null) {
    ctx.strokeStyle = color('--muted'); ctx.lineWidth = 1;
    line(x(hover), top, x(hover), bottom);
  }
  return { left, right };
}

export function renderStockStudy(root, payload) {
  let selected = 0, unit = 'day', active = 'main', hover = null, screen = null;
  const overview = make('p', `${payload.date} 收盘 · ${payload.basis}`, 'muted');
  const bar = make('div', undefined, 'stock-top');
  const canvas = make('canvas');
  canvas.setAttribute('role', 'img');
  const meta = make('p', undefined, 'stock-meta');
  const tooltip = make('output', '', 'chart-tip'); tooltip.hidden = true;
  const notes = make('p', undefined, 'muted stock-projection');
  const cards = make('div', undefined, 'stock-cards');
  const hint = make('p', '虚线为末段低点与收复观察线。日线和周线分别用连续两根收盘确认。这里的浪型是按既有规则对个股复算的候选。', 'muted');
  const chartWrap = make('div', undefined, 'chart-wrap');
  chartWrap.append(canvas, tooltip);
  const archive = make('details');
  archive.append(make('summary', '查看发布记录'));
  const archiveRows = make('div');
  archive.append(archiveRows);
  const pick = controls(payload.results.map(x => x.name), i => { selected = i; render(); }, '股票');
  const periodSwitch = controls(['日线', '周线'], i => { unit = i ? 'week' : 'day'; render(); }, '图表周期');
  const scenarioSwitch = controls(['主案 ABC', '备选五浪'], i => { active = i ? 'alt' : 'main'; render(); }, '画线方案');
  bar.append(periodSwitch, scenarioSwitch);
  root.replaceChildren(overview, pick, bar, meta, chartWrap, hint, notes, cards, archive,
    make('p', `数据构建 ${payload.build} · 规则 ${payload.revision}`, 'muted stock-projection'));
  const getPeriod = () => payload.results[selected][unit];
  const redraw = () => { screen = chart(canvas, getPeriod(), active, hover); };
  function render() {
    const stock = payload.results[selected], period = getPeriod();
    const weekly = unit === 'week';
    hover = null; tooltip.hidden = true;
    const label = `${stock.name} ${stock.symbol.slice(2)} · ${weekly ? '最近完成周' : '收盘日'} ${period.date} · ${p(period.close)} 元`;
    meta.textContent = `${label} · 最近 ${stock.compared} 日双源核对`; canvas.setAttribute('aria-label', `${label}，${active === 'main' ? 'ABC 主案' : '五浪备选'}`);
    const rejected = period.rejected;
    const fallback = rejected ? `另核对一组从 ${rejected.anchors[0].date} 起的普通五浪。第1浪低点 ${p(rejected.anchors[1].price)}，第4浪高 ${p(rejected.anchors[4].price)}，${rejected.invalid.join('、')}。` : '';
    notes.textContent = `${period.reason} ${fallback}`;
    cards.replaceChildren(scenarioCard(period.main, '主案 · ABC', weekly), scenarioCard(period.alt, '备选 · 普通五浪', weekly));
    archiveRows.replaceChildren(...payload.history.slice().reverse().map(record => {
      const entry = record.results[stock.symbol];
      if (!entry) return make('p', record.date, 'muted');
      const state = weekly ? [entry.week, entry.weekAlt] : [entry.day, entry.dayAlt];
      return make('p', `${record.date} · ${p(entry.close)} 元 · ${state.join(' / ')}`);
    }));
    redraw();
  }
  canvas.addEventListener('pointermove', event => {
    if (!screen) return;
    const rows = getPeriod().bars;
    const offset = (event.clientX - canvas.getBoundingClientRect().left - screen.left) / (screen.right - screen.left);
    hover = Math.max(0, Math.min(rows.length - 1, Math.round(offset * (rows.length - 1))));
    const [date, , high, low, close] = rows[hover];
    tooltip.textContent = `${date} · 收 ${p(close)} · 高 ${p(high)} · 低 ${p(low)}`;
    tooltip.hidden = false; redraw();
  });
  canvas.addEventListener('pointerleave', () => { hover = null; tooltip.hidden = true; redraw(); });
  new ResizeObserver(redraw).observe(canvas);
  document.addEventListener('sitethemechange', redraw);
  render();
}
