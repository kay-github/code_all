import { evaluate, parseCsv, validateBars } from './scenarios.mjs?v=2';

const $ = id => document.getElementById(id);
const canvas = $('lab-chart');
const fmt = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
let series = null, fixed = null, view = null;
let sequence = 0;

function message(text) {
  $('lab-status').textContent = text;
}

function describe(level, name) {
  return `${name} ${level.date} · ${fmt.format(level.price)}${level.confirmed ? `（${level.confirmed} 确认）` : ''}`;
}

function number(value, digits = 3) {
  return value == null ? '待观察' : value.toFixed(digits);
}

function panel(title, body) {
  const element = document.createElement('div');
  const strong = document.createElement('strong');
  strong.textContent = title;
  const p = document.createElement('p');
  p.textContent = body;
  element.append(strong, p);
  return element;
}

function render() {
  if (!series) return;
  const asOf = $('lab-date').value || series.bars.at(-1)[0];
  const bars = series.bars.filter(row => row[0] <= asOf);
  view = null;
  try {
    if (bars.length < 20) throw new Error('截至所选日期的行情不足 20 根');
    const result = evaluate(bars, { direction: $('lab-direction').value, scale: Number($('lab-scale').value), dates: fixed });
    const names = ['起点', 'A / 1', 'B / 2', '3', '4', '5'];
    message(`${series.name} · ${series.basis} · 截至 ${bars.at(-1)[0]} · ${fixed ? '手动锚点' : '自动锚点'}`);
    $('lab-anchors').textContent = result.fixed ? result.impulse.map((point, i) => describe(point, names[i])).join('　｜　') : result.reason;
    if (result.fixed) {
      const status = {
        waiting: '等待第3浪越过第1浪终点并确认转折', three: '第3浪候选已出现，等待第4浪转折',
        four: '观察第4浪之后的第5浪', five: '五个候选端点已出现', truncated: '第5浪候选未刷新第3浪极值，属于截短候选',
        invalid: `该普通五浪计数失效。${result.invalid.join('。')}`,
      }[result.impulseStatus];
      const abc = result.bBeyond ? 'B 越过起点，需按扩张调整另行核对。' :
        `B 回撤 ${number(result.bRetraction * 100, 1)}%；C/A ${number(result.cRatio)}。整段 38.2% 回补/回撤线 ${result.retest == null ? '待观察' : fmt.format(result.retest)}。`;
      const cards = [panel('ABC 情景', abc), panel('普通五浪情景',
        `${status}。第3/第1浪 ${number(result.impulseRatio)}。${result.overlapWatch ? '第4浪还未确认，当前已触及第1浪区间。' : ''}`)];
      if (result.internal) {
        const inner = result.internal;
        const anchors = inner.points.slice(1).map((point, i) => `C${i + 1} ${point.date} ${fmt.format(point.price)}`).join('；');
        const lines = inner.levels.map(level => `${level.ratio} 倍 ${fmt.format(level.price)}`).join('，');
        cards.push(panel('C 浪内部候选', `${anchors}。C3/C1 ${number(inner.c3Ratio)}，C5/C1 ${number(inner.c5Ratio)}。${lines ? `C5/C1 投影 ${lines}。` : ''}${inner.invalid.length ? `内部普通五浪约束：${inner.invalid.join('、')}。` : ''}`));
      }
      $('lab-result').replaceChildren(...cards);
    } else $('lab-result').replaceChildren();
    $('lab-alternatives').replaceChildren(...(result.alternatives || []).map(candidate => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = `查看 ${candidate.dates[0]} 起点候选`;
      button.addEventListener('click', () => {
        fixed = candidate.dates;
        ['lab-o', 'lab-a', 'lab-b'].forEach((id, i) => { $(id).value = fixed[i]; });
        $('lab-manual').open = true;
        render();
      });
      return button;
    }));
    view = { bars, result };
    draw();
  } catch (error) {
    $('lab-anchors').textContent = '';
    $('lab-result').replaceChildren();
    $('lab-alternatives').replaceChildren();
    canvas.width = canvas.width;
    message(error.message);
  }
}

function draw() {
  if (!view || !canvas.clientWidth) return;
  const { bars, result } = view;
  const total = bars.length;
  const from = result.fixed ? Math.max(0, result.fixed[0].index - 8) : Math.max(0, total - 110);
  const rows = bars.slice(from);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  const dpi = Math.min(2, devicePixelRatio || 1);
  canvas.width = Math.round(w * dpi);
  canvas.height = Math.round(h * dpi);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpi, dpi);
  const css = getComputedStyle(document.documentElement);
  const color = name => css.getPropertyValue(name).trim();
  const low = Math.min(...rows.map(row => row[3])), high = Math.max(...rows.map(row => row[2]));
  const padding = Math.max((high - low) * 0.08, low * 0.005);
  const x = i => 55 + i / Math.max(1, rows.length - 1) * (w - 70);
  const y = price => 11 + (high + padding - price) / (high - low + 2 * padding) * (h - 34);
  ctx.font = '12px system-ui';
  ctx.textBaseline = 'middle';
  const line = (x1, y1, x2, y2, style) => {
    ctx.strokeStyle = style;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  };
  for (let i = 0; i < 5; i++) {
    const value = low + (high - low) * i / 4;
    ctx.fillStyle = color('--muted');
    ctx.fillText(fmt.format(value), 1, y(value));
    line(53, y(value), w - 15, y(value), color('--line'));
  }
  ctx.strokeStyle = color('--accent');
  ctx.beginPath();
  rows.forEach((row, i) => i ? ctx.lineTo(x(i), y(row[4])) : ctx.moveTo(x(i), y(row[4])));
  ctx.stroke();
  ctx.fillStyle = color('--muted');
  ctx.fillText(rows[0][0], 55, h - 8);
  ctx.fillText(rows.at(-1)[0], Math.max(55, w - 78), h - 8);
  if (!result.fixed) return;
  const fixed = result.fixed;
  const b = fixed[2];
  ctx.setLineDash([4, 3]);
  const projectionLines = result.cLevels.filter(level => level.ratio === 1 || level.ratio === 1.618);
  if (result.retest !== null) projectionLines.push({ ratio: '回补/回撤38.2%', price: result.retest });
  for (const level of projectionLines.filter(level => level.price >= low - padding && level.price <= high + padding)) {
    const Y = y(level.price);
    line(x(b.index - from), Y, w - 15, Y, color('--control-line'));
    ctx.fillStyle = color('--muted');
    ctx.fillText(`${level.ratio} · ${fmt.format(level.price)}`, Math.max(55, w - 130), Math.max(9, Y - 9));
  }
  ctx.setLineDash([]);
  const linePath = (points, labels, hue) => {
    for (const [i, point] of points.entries()) {
      const X = x(point.index - from), Y = y(point.price);
      if (i) {
        const origin = points[i - 1];
        line(x(origin.index - from), y(origin.price), X, Y, color(hue));
      }
      ctx.fillStyle = color(hue);
      ctx.beginPath(); ctx.arc(X, Y, 3.2, 0, Math.PI * 2); ctx.fill();
      ctx.fillText(labels[i], Math.min(w - 31, X + 4), Math.max(9, Y - 8));
    }
  };
  linePath(result.c ? [...fixed, result.c] : fixed, ['起点', 'A/1', 'B/2', 'C?'], '--negative');
  if (result.impulse.length > 3) linePath(result.impulse.slice(2), ['', '3?', '4?', '5?'], '--positive');
}

function setSeries(value) {
  series = { ...value, bars: validateBars(value.bars) };
  fixed = null;
  const date = $('lab-date');
  date.min = series.bars[19][0];
  date.max = series.bars.at(-1)[0];
  date.value = date.max;
  $('lab-content').hidden = false;
  render();
}

function completedCutoff() {
  const now = new Date();
  const china = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short' }).format(now);
  const [day, time] = china.split(' ');
  return time >= '15:35' ? day : new Date(Date.parse(day) - 86400000).toISOString().slice(0, 10);
}

$('lab-symbol-form').addEventListener('submit', async e => {
  e.preventDefault();
  const symbol = $('lab-symbol').value.trim();
  if (!/^(?:SH|SZ)?[036]\d{5}(?:\.(?:SH|SZ))?$/i.test(symbol)) return message('输入沪深个股代码。指数可导入日线 CSV。');
  const id = ++sequence;
  message('正在读取日线。');
  try {
    const endpoint = new URL('/api/stock', location.origin);
    endpoint.search = new URLSearchParams({ action: 'history', adjust: 'qfq', symbol });
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(55000) });
    const body = await response.json();
    if (id !== sequence) return;
    if (!response.ok) throw new Error(body.error || '行情暂时无法读取');
    const cutoff = completedCutoff();
    setSeries({ name: body.name || symbol, basis: `${body.source} · ${body.adjust === 'hfq' ? '后复权' : '前复权'}`,
      bars: body.bars.filter(row => row.time <= cutoff).map(row => [row.time, row.open, row.high, row.low, row.close]) });
  } catch (error) {
    if (id === sequence) message(`${error.message}。也可导入本机日线 CSV。`);
  }
});

$('lab-file').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file) return;
  const id = ++sequence;
  try {
    if (file.size > 2_000_000) throw new Error('CSV 请控制在 2 MB 内');
    const bars = parseCsv(await file.text());
    if (id === sequence) setSeries({ name: file.name, basis: '导入日线', bars });
  } catch (error) {
    if (id === sequence) message(error.message);
  } finally {
    event.target.value = '';
  }
});

for (const control of ['lab-date', 'lab-direction', 'lab-scale']) $(control).addEventListener('change', render);
$('lab-anchor-form').addEventListener('submit', e => {
  e.preventDefault();
  fixed = ['lab-o', 'lab-a', 'lab-b'].map(id => $(id).value);
  render();
});
$('lab-auto').addEventListener('click', () => { fixed = null; render(); });
new ResizeObserver(draw).observe(canvas);
document.addEventListener('sitethemechange', draw);
