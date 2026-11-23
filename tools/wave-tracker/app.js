(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const chart = $('chart');
  const fmt = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const price = value => fmt.format(value);
  const percent = value => `${(value * 100).toFixed(2)}%`;
  const multiple = value => `${value.toFixed(3)} 倍`;
  let data;
  let selected = 0;
  let range = 'all';
  let screen = null;
  let hovered = null;

  function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  }

  function levels(target, pairs) {
    $(target).replaceChildren(...pairs.map(([label, value]) => {
      const item = node('div');
      item.append(node('dt', label), node('dd', value, 'num'));
      return item;
    }));
  }

  function videoLink(id, label) {
    const link = node('a', label);
    link.href = `https://weibo.com/2/detail/${id}`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    return link;
  }

  function renderStudy(index) {
    const study = index.videoStudy;
    $('author-study').hidden = !study;
    if (!study) return;
    $('study-intro').textContent = study.note;
    levels('study-ratios', [['C5 区间端点的 C/A', multiple(study.endpointRatio)],
      ['C1 点数', price(study.c1Length)], ['内部 C3 / C1', multiple(study.c3Ratio)],
      ['内部 C5 / C1 候选', multiple(study.c5Ratio)], ['C5 区间低点', price(study.c5Low.price)],
      ['C4 右端之后的交易日', `${study.c5Sessions} 日`]]);
    $('study-lines').replaceChildren(...study.lines.map(line => {
      const row = node('tr');
      const link = node('td');
      link.append(videoLink(line.video, `${line.video === '5368345092164598' ? '11-23' : '11-16'} · ${line.time}`));
      row.append(node('td', line.of), node('td', multiple(line.ratio)),
        node('td', line.drawn == null ? '约1100' : price(line.drawn)), node('td', price(line.computed)), link);
      return row;
    }));
    $('study-time').textContent = study.timing;
  }

  function renderRulebook() {
    const types = {structural: '结构', heuristic: '经验标尺', case: '案例', implementation: '工具口径'};
    $('rulebook').replaceChildren(...(data.rulebook || []).map(rule => {
      const block = node('div', undefined, 'source');
      block.append(node('strong', `${types[rule.kind]} · ${rule.title}`), node('p', rule.definition));
      for (const [i, source] of rule.sources.entries()) {
        if (i) block.append(document.createTextNode(' · '));
        block.append(videoLink(source.id, source.time || '查看原帖'));
      }
      return block;
    }));
  }

  function renderSources() {
    $('profile').href = data.profile;
    $('source-list').replaceChildren(...data.evidence.map(entry => {
      const block = node('div', undefined, 'source');
      const link = videoLink(entry.id, entry.title);
      const date = node('time', entry.date);
      date.dateTime = entry.date;
      block.append(date, link, node('p', entry.note));
      return block;
    }));
  }

  function renderCycle() {
    const c = data.cycle;
    const sh = c.shBreak ? `${c.shBreak} 已刷新此前低点` : `${c.shWindow}，此前低点 ${price(c.shReference)}`;
    const star = `固定参照 ${price(c.starReference)}。${c.starBreak ? `${c.starBreak} 周收盘确认破位` : c.starPriceBreak ? `${c.starPriceBreak} 首次盘中跌破，等待周收确认` : '尚未跌破'}`;
    $('cycle-checks').replaceChildren(...[['上证 · 12月创新低', sh], ['科创50 · 19周样本低点', star]].map(([label, value]) => {
      const item = node('div');
      item.append(node('strong', label), node('span', value));
      return item;
    }));
  }

  function renderButtons() {
    $('indices').replaceChildren(...data.indices.map((index, i) => {
      const button = node('button', undefined, 'index');
      button.type = 'button';
      button.setAttribute('aria-pressed', String(i === selected));
      const title = node('span', index.name, 'index-title');
      title.append(node('small', index.symbol.slice(2)));
      const line = node('span', undefined, 'index-price num');
      line.append(node('strong', price(index.bars.at(-1)[4])), node('span', `${index.change > 0 ? '+' : ''}${percent(index.change)}`, index.change > 0 ? 'up' : index.change < 0 ? 'down' : ''));
      button.append(title, line);
      button.addEventListener('click', () => {
        selected = i;
        for (const [j, sibling] of [...$('indices').children].entries()) sibling.setAttribute('aria-pressed', String(j === i));
        renderIndex();
      });
      return button;
    }));
  }

  function renderIndex() {
    const index = data.indices[selected];
    const a = index.abc;
    const f = index.five;
    $('instrument').textContent = `${index.name} · 日线`;
    $('chart-meta').textContent = `${index.symbol.slice(2)} · ${index.source} · ${index.checks.length === 2 ? '近20日双源核对' : '本期单源行情'} · 点`;
    const month = index.monthWatch;
    const timing = month ? ` 他同时观察创业板能否在11月走完C5。${month.breach ? `${month.breach.date} 跌破此前低点，触发其时间复核条件。` : `12月观察低点 ${price(month.priorLow)}。`}` : '';
    $('author-view').textContent = index.view + timing;
    renderStudy(index);
    $('abc-status').textContent = a.stage;
    $('abc-note').textContent = `B浪回补了 A 浪跌幅的 ${percent(a.bRetraction)}。B 后最低为 ${price(a.cExtreme.price)}（${a.cExtreme.date}），用来量 C 浪的最大下行幅度。`;
    levels('abc-levels', [['C / A', multiple(a.cRatio)], ['A、C 等长位', price(a.equal)], ['末段低点', price(a.floor)], ['收复观察线', price(a.retest)], ['整段回补38.2%', price(a.retracement)]]);
    $('five-status').textContent = f.stage;
    $('five-note').textContent = `暂用 A / B 的锚点作第1 / 第2浪。第3浪候选低点为 ${price(f.low.price)}（${f.low.date}）。${f.wave3Ratio < 1.618 ? '当前长度低于延伸三浪的经验标尺。' : '当前长度已达到延伸三浪的经验标尺。'}`;
    levels('five-levels', [['第3 / 第1浪', multiple(f.wave3Ratio)], ['1.618 倍位置', f.extension > 0 ? price(f.extension) : '超出价格范围'],
      ['第4浪反弹观察线', price(f.threshold)], ['普通五浪重叠界线', price(index.anchors[1].price)],
      ...(f.rebound ? [['第4浪候选高点', price(f.rebound.price)]] : []), ...(f.five ? [['第5浪候选低点', price(f.five.price)]] : [])]);
    $('anchors').replaceChildren(...index.anchors.map(p => node('span', `${p.label} · ${p.date} · ${price(p.price)}`, 'num')));
    $('history').replaceChildren(...data.history.slice().reverse().map(row => {
      const item = row.indices[index.symbol];
      const tr = node('tr');
      tr.append(...[row.date, price(item.close), multiple(item.ratio), item.abc, item.five].map(v => node('td', v)));
      return tr;
    }));
    hovered = null;
    $('chart-tip').hidden = true;
    draw();
  }

  function draw() {
    if (!data || !chart.clientWidth) return;
    const index = data.indices[selected];
    const path = range === 'all' ? index.bars.filter(row => row[0] >= index.start) : index.bars.slice(-60);
    const width = chart.clientWidth;
    const height = chart.clientHeight;
    const scale = Math.min(devicePixelRatio || 1, 2);
    const ctx = chart.getContext('2d');
    if (!ctx) return;
    chart.width = Math.round(width * scale);
    chart.height = Math.round(height * scale);
    ctx.scale(scale, scale);
    const css = getComputedStyle(document.documentElement);
    const color = key => css.getPropertyValue(key).trim();
    const left = 53, right = width - 13, top = 19, bottom = height - 25;
    const points = index.anchors.map(p => ({ ...p, at: path.findIndex(row => row[0] === p.date) })).filter(p => p.at >= 0);
    const min = Math.min(...path.map(bar => bar[3]), index.abc.floor);
    const max = Math.max(...path.map(bar => bar[2]), index.abc.retest);
    const pad = Math.max((max - min) * .08, 1);
    const x = i => left + i / (path.length - 1) * (right - left);
    const y = value => bottom - (value - min + pad) / (max - min + 2 * pad) * (bottom - top);
    screen = { path, left, right };
    ctx.font = '12px system-ui';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
      const value = min - pad + i * (max - min + 2 * pad) / 4;
      const row = y(value);
      ctx.strokeStyle = color('--line');
      ctx.beginPath(); ctx.moveTo(left, row); ctx.lineTo(right, row); ctx.stroke();
      ctx.fillStyle = color('--muted');
      ctx.fillText(Math.round(value).toLocaleString('zh-CN'), left - 6, row);
    }
    const ticks = width < 500 ? 4 : 7;
    for (let i = 0; i < ticks; i++) {
      const j = Math.round(i * (path.length - 1) / (ticks - 1));
      const align = i === 0 ? 'left' : (i === ticks - 1 ? 'right' : 'center');
      ctx.textAlign = align;
      ctx.fillText(path[j][0].slice(5), x(j), height - 10);
    }
    for (const [value, hue] of [[index.abc.retest, '--positive'], [index.abc.floor, '--negative']]) {
      ctx.strokeStyle = color(hue);
      ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.moveTo(left, y(value)); ctx.lineTo(right, y(value)); ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.strokeStyle = color('--accent');
    ctx.lineWidth = 2;
    ctx.beginPath();
    path.forEach((row, i) => i === 0 ? ctx.moveTo(x(i), y(row[4])) : ctx.lineTo(x(i), y(row[4])));
    ctx.stroke();
    ctx.strokeStyle = color('--muted');
    ctx.lineWidth = 1.4;
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    points.forEach((p, i) => i === 0 ? ctx.moveTo(x(p.at), y(p.price)) : ctx.lineTo(x(p.at), y(p.price)));
    ctx.stroke();
    ctx.setLineDash([]);
    const short = { '末段前高': '前高', '末段低点': '低点', 'C5区间低点': 'C5?', 'C4 右端': 'C4' };
    for (const [i, p] of points.entries()) {
      const px = x(p.at), py = y(p.price);
      ctx.fillStyle = color('--surface');
      ctx.beginPath(); ctx.arc(px, py, 3.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      const label = (width < 650 ? short[p.label] : null) || p.label;
      const labelWidth = ctx.measureText(label).width;
      const tx = Math.max(left, Math.min(right - labelWidth, px + (width < 650 && i % 2 ? -labelWidth - 4 : 4)));
      const ty = Math.max(top - 7, Math.min(bottom - 2, py + (i % 2 ? 13 : -12)));
      ctx.fillStyle = color('--surface');
      ctx.fillRect(tx - 2, ty - 7, labelWidth + 4, 14);
      ctx.fillStyle = color('--text');
      ctx.textAlign = 'left';
      ctx.fillText(label, tx, ty);
    }
    if (hovered !== null && path[hovered]) {
      ctx.strokeStyle = color('--control-line');
      ctx.lineWidth = 1;
      const at = x(hovered);
      ctx.beginPath(); ctx.moveTo(at, top); ctx.lineTo(at, bottom); ctx.stroke();
    }
  }

  function pointer(event) {
    if (!screen) return;
    const pos = (event.clientX - chart.getBoundingClientRect().left - screen.left) / (screen.right - screen.left);
    const index = Math.min(screen.path.length - 1, Math.max(0, Math.round(pos * (screen.path.length - 1))));
    if (index === hovered) return;
    hovered = index;
    const [date, , high, low, close] = screen.path[index];
    $('chart-tip').textContent = `${date} · 收 ${price(close)} · 高 ${price(high)} · 低 ${price(low)}`;
    $('chart-tip').hidden = false;
    draw();
  }

  async function load() {
    const status = $('load');
    status.textContent = '正在读取最近一期分析。';
    try {
      const response = await fetch('/tools/wave-tracker/data/latest.json', { cache: 'no-cache' });
      if (!response.ok) throw new Error(String(response.status));
      const payload = await response.json();
      if (payload.schema !== 1 || payload.indices?.length !== 3 || !payload.history?.length) throw new Error('数据格式不完整');
      data = payload;
      $('day').textContent = data.date;
      $('build').textContent = `数据构建 ${data.build} · 观点版本 ${data.revision}`;
      status.hidden = true;
      $('dashboard').hidden = false;
      renderButtons();
      renderSources();
      renderRulebook();
      renderCycle();
      renderIndex();
    } catch (error) {
      $('day').textContent = '加载失败';
      $('dashboard').hidden = true;
      status.hidden = false;
      status.textContent = '暂时读不到分析数据。';
      const retry = node('button', '重新加载');
      retry.type = 'button';
      retry.addEventListener('click', load, { once: true });
      status.append(retry);
    }
  }

  $('study-link').addEventListener('click', () => { if (data && $('author-study').hidden) $('indices').firstElementChild.click(); });
  $('ranges').addEventListener('click', event => {
    const button = event.target.closest('button[data-range]');
    if (!button) return;
    range = button.dataset.range;
    for (const sibling of $('ranges').children) sibling.setAttribute('aria-pressed', String(sibling === button));
    hovered = null;
    $('chart-tip').hidden = true;
    draw();
  });
  chart.addEventListener('pointermove', pointer);
  chart.addEventListener('pointerleave', () => {
    if (hovered === null) return;
    hovered = null;
    $('chart-tip').hidden = true;
    draw();
  });
  new ResizeObserver(draw).observe(chart);
  document.addEventListener('sitethemechange', draw);
  load();
})();
