const format = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const currency = value => Number.isFinite(value) ? '¥' + format.format(value / 100) : '待行情';
const time = value => new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short',
}).format(value);

function holdings(rows) {
  const bySymbol = new Map();
  for (const row of rows) {
    const total = bySymbol.get(row.symbol) ?? { symbol: row.symbol, name: row.quote?.name, qty: 0, market: 0, profit: 0 };
    total.qty += row.qty;
    total.market = row.market === null || total.market === null ? null : total.market + row.market;
    total.profit = row.profit === null || total.profit === null ? null : total.profit + row.profit;
    bySymbol.set(row.symbol, total);
  }
  return [...bySymbol.values()].sort((a, b) => (b.market ?? -1) - (a.market ?? -1));
}

export function drawShare(canvas, snapshot, includePositions) {
  const { name, book, createdAt } = snapshot;
  const positions = holdings(book.rows);
  const shown = includePositions ? positions.slice(0, 10) : [];
  canvas.width = 900;
  canvas.height = 420 + (includePositions ? 48 + shown.length * 52 : 0);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw Error('当前浏览器无法生成图片。');
  const ink = '#eaf1f6', muted = '#b0c3d2', accent = '#a8c8ed', surface = '#213548';
  const pnl = value => value > 0 ? '#ffacb4' : value < 0 ? '#8ed7b9' : ink;
  function line(text, x, y, { size = 23, color = ink, bold = false, max = 800 } = {}) {
    ctx.fillStyle = color;
    ctx.font = `${bold ? '700' : '400'} ${size}px "Microsoft YaHei", "PingFang SC", system-ui, sans-serif`;
    ctx.fillText(text, x, y, max);
  }
  ctx.fillStyle = '#162635';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  line('333 投资理论  /  持仓快照', 36, 43, { size: 20, bold: true, color: accent });
  line(name + ' · 持仓收益', 36, 97, { size: 37, bold: true });
  line('生成时间  ' + time(createdAt) + '（北京时间）', 38, 135, { size: 19, color: muted });
  const metrics = [
    ['持仓市值', currency(book.market), ink],
    ['持仓浮动盈亏', currency(book.floating), pnl(book.floating)],
    ['持仓收益率', Number.isFinite(book.returnPct) ? format.format(book.returnPct) + '%' : '—', pnl(book.returnPct)],
    ['已实现盈亏', currency(book.realized), pnl(book.realized)],
  ];
  metrics.forEach(([label, value, color], i) => {
    const x = 36 + (i % 2) * 420, y = 158 + Math.floor(i / 2) * 99;
    ctx.fillStyle = surface;
    ctx.fillRect(x, y, 408, 89);
    line(label, x + 16, y + 28, { size: 20, color: muted });
    line(value, x + 16, y + 66, { size: 31, bold: true, color, max: 375 });
  });
  if (includePositions) {
    line(`持仓明细 · ${shown.length}/${positions.length} 个标的`, 36, 394, { size: 20, color: accent });
    shown.forEach((row, index) => {
      const y = 437 + index * 52;
      line(row.name ? `${row.name} ${row.symbol}` : row.symbol, 36, y, { size: 21, bold: true, max: 310 });
      line(format.format(row.qty) + ' 股/份', 364, y, { size: 20, color: muted, max: 172 });
      line('浮盈亏  ' + currency(row.profit), 565, y, { size: 20, color: pnl(row.profit), max: 300 });
    });
  }
  const quoteDate = !book.newestQuote ? '暂无行情' : book.oldestQuote === book.newestQuote
    ? time(book.newestQuote) : time(book.oldestQuote) + ' – ' + time(book.newestQuote);
  const note = book.market === null ? '部分持仓待行情' : book.rows.some(row => row.quote?.stale) ? '含缓存行情' : '延迟行情';
  line(`行情 ${quoteDate}${book.newestQuote ? '  ·  ' + note : ''}`, 36, canvas.height - 20, { size: 18, color: muted });
}
