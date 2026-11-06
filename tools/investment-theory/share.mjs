const format = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const signed = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2, signDisplay: 'exceptZero' });
const currency = value => Number.isFinite(value) ? `¥${format.format(value / 100)}` : '待行情';
const profitText = value => Number.isFinite(value)
  ? `${value > 0 ? '+' : value < 0 ? '−' : ''}¥${format.format(Math.abs(value) / 100)}` : '待行情';
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
  const positions = includePositions ? holdings(book.rows) : [];
  const shown = positions.slice(0, 10);
  const width = 680;
  const gutter = 28;
  const inner = width - 2 * gutter;
  const detailHeight = includePositions ? 74 + Math.max(1, shown.length) * 52 : 0;
  const height = 441 + detailHeight;
  const scale = 2;
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw Error('当前浏览器无法生成图片。');
  ctx.scale(scale, scale);
  ctx.textBaseline = 'top';
  const ink = '#edf4fa', muted = '#a9bed0', accent = '#a8cef2';
  const border = '#355067', surface = '#1b2f42';
  const pnl = value => value > 0 ? '#ffb1bb' : value < 0 ? '#99dfc2' : ink;
  const face = '"Segoe UI", "Microsoft YaHei", "PingFang SC", system-ui, sans-serif';
  function line(text, x, y, { size = 17, color = ink, weight = 400, max = inner, align = 'left' } = {}) {
    ctx.font = `${weight} ${size}px ${face}`;
    const measured = ctx.measureText(text).width;
    if (measured > max) ctx.font = `${weight} ${Math.floor(size * max / measured)}px ${face}`;
    ctx.textAlign = align;
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }
  function panel(x, y, w, h, radius, fill, stroke) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, radius);
    ctx.fillStyle = fill;
    ctx.fill();
    if (stroke) { ctx.strokeStyle = stroke; ctx.stroke(); }
  }
  function divider(x, y, w, h = 1) {
    ctx.fillStyle = border;
    ctx.fillRect(x, y, w, h);
  }

  const backdrop = ctx.createRadialGradient(width - 44, 6, 12, width - 44, 6, 560);
  backdrop.addColorStop(0, '#294862');
  backdrop.addColorStop(1, '#112030');
  ctx.fillStyle = backdrop;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#85b6e3';
  ctx.fillRect(0, 0, width, 4);

  panel(gutter, 26, 48, 34, 8, '#a8cef2');
  line('333', 52, 32, { size: 20, color: '#162c42', weight: 800, max: 38, align: 'center' });
  line('投资理论', 86, 33, { size: 18, weight: 700, color: accent });
  line('持仓收益快照', width - gutter, 35, { size: 17, weight: 650, color: accent, align: 'right' });
  line(name, gutter, 73, { size: 36, weight: 750 });

  const rate = Number.isFinite(book.returnPct) ? `${signed.format(book.returnPct).replace('-', '−')}%` : '—';
  const hero = ctx.createLinearGradient(gutter, 125, width - gutter, 261);
  hero.addColorStop(0, '#2b475f');
  hero.addColorStop(1, '#1c344a');
  panel(gutter, 128, inner, 139, 17, hero, border);
  line('持仓收益率', 49, 150, { size: 18, color: accent, weight: 650 });
  line(rate, 46, 176, { size: 63, color: pnl(book.returnPct), weight: 780, max: 318 });
  divider(388, 153, 1, 88);
  line('浮动盈亏', 410, 155, { size: 18, color: muted });
  line(profitText(book.floating), 410, 190, { size: 35, color: pnl(book.floating), weight: 730, max: 219 });

  panel(gutter, 281, inner, 81, 13, surface, border);
  divider(340, 297, 1, 49);
  line('持仓市值', 49, 294, { size: 16, color: muted });
  line(currency(book.market), 49, 318, { size: 28, weight: 730, max: 268 });
  line('已实现盈亏', 360, 294, { size: 16, color: muted });
  line(profitText(book.realized), 360, 318, { size: 28, color: pnl(book.realized), weight: 730, max: 269 });

  if (includePositions) {
    line('持仓明细', gutter, 384, { size: 20, weight: 700 });
    const count = shown.length === positions.length ? `${shown.length} 个标的` : `显示 ${shown.length} / ${positions.length} 个标的`;
    line(count, width - gutter, 386, { size: 16, color: muted, align: 'right' });
    panel(gutter, 415, inner, detailHeight - 44, 13, surface, border);
    if (shown.length) {
      line('证券', 49, 423, { size: 15, color: muted });
      line('股数 / 份额', 423, 423, { size: 15, color: muted, align: 'right' });
      line('浮动盈亏', 629, 423, { size: 15, color: muted, align: 'right' });
      shown.forEach((row, index) => {
        const y = 445 + index * 52;
        divider(49, y, 580);
        line(row.name || row.symbol, 49, y + (row.name ? 6 : 15), { size: 18, weight: 650, max: 220 });
        if (row.name) line(row.symbol, 49, y + 28, { size: 14, color: muted });
        line(format.format(row.qty), 423, y + 16, { size: 17, max: 128, align: 'right' });
        line(profitText(row.profit), 629, y + 15, { size: 18, color: pnl(row.profit), weight: 650, max: 187, align: 'right' });
      });
    } else {
      line('暂无持仓', 49, 443, { size: 17, color: muted });
    }
  }
  const quoteDate = !book.newestQuote ? '暂无可用行情' : book.oldestQuote === book.newestQuote
    ? time(book.newestQuote) : time(book.oldestQuote) + ' – ' + time(book.newestQuote);
  const note = book.newestQuote ? (book.market === null ? ' · 部分持仓待行情' : book.rows.some(row => row.quote?.stale) ? ' · 含缓存行情' : ' · 延迟行情') : '';
  const footer = 378 + detailHeight;
  divider(gutter, footer, inner);
  line(`生成 ${time(createdAt)}（北京时间）`, gutter, footer + 11, { size: 15, color: muted });
  line(`行情 ${quoteDate}${note}`, gutter, footer + 34, { size: 15, color: muted });
  canvas.setAttribute('aria-label', `${name}的持仓收益图，收益率 ${rate}，持仓市值 ${currency(book.market)}，浮动盈亏 ${profitText(book.floating)}`);
}
