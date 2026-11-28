/* 趋势买卖点 · 前端
 * 数据：data/history/*.csv（东财指数日线，成交量=股，成交额=元）
 * 信号：data/signals.json（与回测同一套状态机）
 */
(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const fmt = new Intl.NumberFormat('zh-CN');
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const pct = (x, d = 2) => x == null || !isFinite(x) ? '—' : (x * 100).toFixed(d) + '%';
  const signed = (x, d = 2) => x == null || !isFinite(x) ? '—' : (x >= 0 ? '+' : '') + (x * 100).toFixed(d) + '%';
  const num = (x, d = 2) => x == null || !isFinite(x) ? '—' : x.toFixed(d);
  const cnDate = s => s ? s.slice(0, 4) + '-' + s.slice(5, 7) + '-' + s.slice(8, 10) : '—';

  const COLORS = {
    ma5: '#e0a45c', ma10: '#7aa6d6', ma20: '#9a86c9', ma60: '#5bb39a', ma250: '#c7d0d9',
    boll: 'rgba(122,166,214,.55)'
  };

  const APP = {
    meta: null, sig: null, val: null,
    code: 'sh000300', period: 'day',
    raw: null, bars: null, ind: null,
    events: [], state: null,
    view: { count: 180, end: 0 },
    frame: 0,
    hover: null, range: null, selecting: null, rangeMode: false,
    pointers: new Map(), pan: null, pinch: null,
    showMA: true, showBOLL: false, showMACD: true,
    ready: false
  };

  const TABS = ['overview', 'trades', 'years', 'method', 'validation'];

  /* ---------- 数据 ---------- */
  async function getJSON(url) {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(url + ' ' + r.status);
    return r.json();
  }

  function parseCSV(text) {
    const lines = text.trim().split(/\r?\n/);
    const head = lines[0].split(',');
    const idx = { date: head.indexOf('date'), open: head.indexOf('open'), high: head.indexOf('high'), low: head.indexOf('low'), close: head.indexOf('close'), volume: head.indexOf('volume'), amount: head.indexOf('amount') };
    const out = { dates: [], o: [], h: [], l: [], c: [], v: [], a: [] };
    for (let i = 1; i < lines.length; i++) {
      const p = lines[i].split(',');
      if (p.length < 6) continue;
      out.dates.push(p[idx.date]);
      out.o.push(+p[idx.open]); out.h.push(+p[idx.high]); out.l.push(+p[idx.low]); out.c.push(+p[idx.close]);
      out.v.push(+p[idx.volume]); out.a.push(idx.amount >= 0 ? +p[idx.amount] : 0);
    }
    return out;
  }

  async function loadIndex(code) {
    if (APP.cache && APP.cache[code]) return APP.cache[code];
    const text = await (await fetch(`data/history/${code}.csv`, { cache: 'no-store' })).text();
    const raw = parseCSV(text);
    APP.cache = APP.cache || {};
    APP.cache[code] = raw;
    return raw;
  }

  /* ---------- 周期聚合 ---------- */
  function isoWeek(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const day = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - day);
    const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    const week = Math.ceil((((t - y0) / 86400000) + 1) / 7);
    return t.getUTCFullYear() + '-W' + String(week).padStart(2, '0');
  }

  function aggregate(raw, period) {
    if (period === 'day') {
      const map = new Map();
      raw.dates.forEach((d, i) => map.set(d, i));
      return { ...raw, map };
    }
    const out = { dates: [], o: [], h: [], l: [], c: [], v: [], a: [], map: new Map(), key: [] };
    const groups = new Map();
    for (let i = 0; i < raw.dates.length; i++) {
      const d = raw.dates[i];
      const key = period === 'week' ? isoWeek(d) : d.slice(0, 7);
      let g = groups.get(key);
      if (!g) {
        g = { dates: [], o: raw.o[i], h: raw.h[i], l: raw.l[i], c: raw.c[i], v: 0, a: 0, firstDate: d };
        groups.set(key, g);
      }
      g.h = Math.max(g.h, raw.h[i]); g.l = Math.min(g.l, raw.l[i]);
      g.c = raw.c[i]; g.v += raw.v[i]; g.a += raw.a[i]; g.dates.push(d);
      g.lastDate = d;
    }
    for (const [key, g] of groups) {
      const bi = out.dates.length;
      const label = period === 'week' ? g.lastDate : key;
      out.dates.push(label); out.o.push(g.o); out.h.push(g.h); out.l.push(g.l); out.c.push(g.c); out.v.push(g.v); out.a.push(g.a);
      out.key.push(key);
      g.dates.forEach(d => out.map.set(d, bi));
    }
    return out;
  }

  /* ---------- 指标 ---------- */
  function sma(v, n) {
    const out = new Float64Array(v.length).fill(NaN);
    let s = 0;
    for (let i = 0; i < v.length; i++) {
      s += v[i];
      if (i >= n) s -= v[i - n];
      if (i >= n - 1) out[i] = s / n;
    }
    return out;
  }
  function ema(v, n) {
    const a = 2 / (n + 1), out = new Float64Array(v.length);
    for (let i = 0; i < v.length; i++) out[i] = i ? a * v[i] + (1 - a) * out[i - 1] : v[i];
    return out;
  }
  function rma(v, n) {
    const a = 1 / n, out = new Float64Array(v.length);
    for (let i = 0; i < v.length; i++) out[i] = i ? a * v[i] + (1 - a) * out[i - 1] : v[i];
    return out;
  }
  function boll(c, n = 20, k = 2) {
    const mid = sma(c, n), up = new Float64Array(c.length).fill(NaN), low = new Float64Array(c.length).fill(NaN);
    for (let i = n - 1; i < c.length; i++) {
      let s = 0;
      for (let j = i - n + 1; j <= i; j++) s += (c[j] - mid[i]) ** 2;
      const sd = Math.sqrt(s / n);
      up[i] = mid[i] + k * sd; low[i] = mid[i] - k * sd;
    }
    return { mid, up, low };
  }
  function macd(c) {
    const e12 = ema(c, 12), e26 = ema(c, 26);
    const dif = e12.map((x, i) => x - e26[i]);
    const dea = ema(dif, 9);
    const hist = dif.map((x, i) => x - dea[i]);
    return { dif, dea, hist };
  }
  function computeInd(b) {
    return {
      ma5: sma(b.c, 5), ma10: sma(b.c, 10), ma20: sma(b.c, 20), ma60: sma(b.c, 60), ma250: sma(b.c, 250),
      boll: boll(b.c, 20, 2), macd: macd(b.c)
    };
  }

  /* ---------- 初始化 ---------- */
  async function init() {
    try {
      const [meta, sig, val] = await Promise.all([
        getJSON('data/meta.json'), getJSON('data/signals.json'), getJSON('data/validation.json')
      ]);
      APP.meta = meta; APP.sig = sig; APP.val = val;
      $('#dataDate').textContent = meta.data_date;
      checkStale(meta.data_date);
      buildIndexTabs();
      bindGlobal();
      renderMethod();
      renderValidation();
      const params = new URLSearchParams(location.search);
      const wantCode = params.get('code'), wantTab = params.get('tab');
      await selectIndex(wantCode && APP.sig.indices[wantCode] ? wantCode : 'sh000300', false);
      if (wantTab) {
        const btn = $(`#tabs [data-tab="${wantTab}"]`);
        if (btn) btn.click();
      }
    } catch (e) {
      console.error(e);
      $('#loading').textContent = '数据加载失败：' + e.message;
    }
  }

  function checkStale(date) {
    const d = new Date(date + 'T15:00:00+08:00');
    const days = (Date.now() - d.getTime()) / 86400000;
    if (days > 4) {
      const el = $('#stale');
      el.hidden = false;
      el.textContent = `数据可能已过期：最新数据日 ${date}，距今 ${Math.floor(days)} 天。自动更新可能失败，请稍后刷新或查看更新日志。`;
    }
  }

  function buildIndexTabs() {
    const box = $('#indexTabs');
    box.innerHTML = '';
    for (const [code, info] of Object.entries(APP.sig.indices)) {
      const b = document.createElement('button');
      b.dataset.code = code; b.textContent = info.short || info.name;
      b.title = info.name + ' · ' + info.code;
      b.addEventListener('click', () => selectIndex(code));
      box.appendChild(b);
    }
  }

  async function selectIndex(code, fromHash = true) {
    APP.code = code;
    APP.ready = false;
    $('#loading').hidden = false;
    $('#loading').textContent = '载入行情…';
    $$('#indexTabs button').forEach(b => b.classList.toggle('on', b.dataset.code === code));
    try {
      APP.raw = await loadIndex(code);
      const info = APP.sig.indices[code];
      APP.events = info.events || [];
      APP.state = info.state;
      APP.ready = true;
      applyPeriod(true);
      $('#loading').hidden = true;
      renderHeader();
      renderState();
      renderPanels();
      if (fromHash) history.replaceState(null, '', '?code=' + code);
    } catch (e) {
      console.error(e);
      $('#loading').textContent = '行情加载失败：' + e.message;
    }
  }

  function applyPeriod(reset) {
    APP.bars = aggregate(APP.raw, APP.period);
    APP.ind = computeInd(APP.bars);
    if (reset) {
      const n = APP.bars.dates.length;
      APP.view.count = Math.min(180, n);
      APP.view.end = n;
    } else {
      APP.view.count = Math.min(APP.view.count, APP.bars.dates.length);
      APP.view.end = APP.bars.dates.length;
    }
  }

  /* ---------- 头部与状态 ---------- */
  function currentInfo() { return APP.sig.indices[APP.code]; }

  function renderHeader() {
    const info = currentInfo(), lv = info.levels, st = info.state, s = info.stats;
    $('#idxName').textContent = info.name;
    $('#idxCode').textContent = info.code;
    $('#lastPrice').textContent = num(lv.close);
    const chg = $('#dayChg');
    chg.textContent = signed(lv.chg);
    chg.className = 'chg ' + (lv.chg >= 0 ? 'up' : 'dn');
    $('#ma250').textContent = num(lv.ma250);
    $('#distMa').textContent = signed(s.dist_ma250);
    $('#range52').textContent = num(s.low52) + ' – ' + num(s.high52);
    const pos52 = s.high52 > s.low52 ? (lv.close - s.low52) / (s.high52 - s.low52) : null;
    $('#range52').title = pos52 == null ? '' : '52周分位 ' + pct(pos52, 0);
  }

  function renderState() {
    const info = currentInfo(), lv = info.levels, st = info.state, s = info.stats;
    const pill = $('#statePill'), title = $('#stateTitle'), sub = $('#stateSub');
    const lastEvent = APP.events[APP.events.length - 1];
    let cls = 'flat', label = '空仓';
    if (st.pos === 1 && st.pending === 'SELL') { cls = 'pending'; label = '待卖出'; }
    else if (st.pos === 1) { cls = 'long'; label = '持仓'; }
    else if (st.pending === 'BUY') { cls = 'pending'; label = '待买入'; }
    pill.className = 'state-pill ' + cls;
    pill.textContent = label;

    if (st.pos === 1) {
      const entry = APP.raw.dates.indexOf(st.entry_date);
      const hold = entry >= 0 ? APP.raw.dates.length - 1 - entry : null;
      const pnl = st.entry_px ? lv.close / st.entry_px - 1 : null;
      title.textContent = `持仓中 · 入场 ${st.entry_date}`;
      sub.textContent = `成本 ${num(st.entry_px)} · 浮盈 ${signed(pnl)} · 已持有 ${hold ?? '—'} 个交易日`;
    } else {
      title.textContent = `${info.short || info.name} · 未持仓`;
      sub.textContent = lastEvent ? `上次 ${lastEvent.type === 'SELL' ? '卖出' : '买入'} ${lastEvent.exec_date}${lastEvent.ret != null ? ' · 单笔 ' + signed(lastEvent.ret) : ''}` : '尚无历史信号';
    }

    const conds = [];
    if (st.pos === 0) {
      const breakout = lv.buy_trigger != null && lv.close > lv.buy_trigger;
      const above = lv.ma250 != null && lv.close > lv.ma250;
      const slope = lv.ma250_slope_up;
      const dTrigger = lv.buy_trigger ? (lv.buy_trigger / lv.close - 1) : null;
      const dMa = lv.ma250 ? (lv.ma250 / lv.close - 1) : null;
      conds.push(`<span class="cond ${breakout ? 'pass' : 'fail'}">① 突破25日高 ${num(lv.buy_trigger)}${breakout ? '' : '<em>还差 ' + pct(dTrigger) + '</em>'}</span>`);
      conds.push(`<span class="cond ${above ? 'pass' : 'fail'}">② 站上年线 ${num(lv.ma250)}${above ? '' : '<em>还差 ' + pct(dMa) + '</em>'}</span>`);
      conds.push(`<span class="cond ${slope ? 'pass' : 'fail'}">③ 年线向上${slope ? '' : '<em>未转向</em>'}</span>`);
      $('#conditions').innerHTML = conds.join('');
      if (st.pending === 'BUY') $('#nextTrigger').innerHTML = '<b>买入已触发</b><br>下一交易日开盘执行';
      else if (breakout && above && slope) $('#nextTrigger').innerHTML = '<b>三项已满足</b><br>等待收盘确认';
      else if (!slope) $('#nextTrigger').innerHTML = '<b>年线仍向下</b><br>突破也不买，先等趋势转向';
      else $('#nextTrigger').innerHTML = `<b>同时满足三项才买</b><br>当前不满足，继续空仓`;
    } else {
      const dStop = st.stop ? (lv.close / st.stop - 1) : null;
      const entry = APP.raw.dates.indexOf(st.entry_date);
      const hold = entry >= 0 ? APP.raw.dates.length - 1 - entry : null;
      conds.push(`<span class="cond ${dStop != null && dStop < 0.02 ? 'fail' : 'pass'}">止损 ${num(st.stop)}<em>距 ${signed(dStop)}</em></span>`);
      conds.push(`<span class="cond ${lv.ma250_slope_up ? 'pass' : 'fail'}">年线${lv.ma250_slope_up ? '向上' : '向下'}</span>`);
      conds.push(`<span class="cond ${lv.close > lv.hh25 ? 'pass' : 'fail'}">25日高 ${num(lv.hh25)}</em></span>`);
      $('#conditions').innerHTML = conds.join('');
      if (st.pending === 'SELL') $('#nextTrigger').innerHTML = '<b>卖出已触发</b><br>下一交易日开盘执行';
      else $('#nextTrigger').innerHTML = `<b>收盘跌破 ${num(st.stop)} 卖出</b><br>持有 ${hold ?? '—'} 个交易日`;
    }
  }

  /* ---------- 画布基础 ---------- */
  const cv = () => $('#kline');
  function fitCanvas(c, minH = 280) {
    const r = c.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(320, Math.round(r.width)), h = Math.max(minH, Math.round(r.height));
    const pxW = Math.round(w * dpr), pxH = Math.round(h * dpr);
    if (c.width !== pxW || c.height !== pxH) { c.width = pxW; c.height = pxH; }
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }
  function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function themeColors() {
    return { text: css('--text'), muted: css('--muted'), line: css('--line'), grid: css('--chart-grid'),
      up: css('--up'), down: css('--down'), amber: css('--amber'), accent: css('--accent'), surface: css('--surface'), inset: css('--inset') };
  }
  function rgba(hex, a) {
    const h = (hex || '').trim();
    if (h.startsWith('rgb')) return h.replace(/rgba?\(([^)]+)\)/, (m, p) => 'rgba(' + p.split(',').slice(0, 3).join(',') + ',' + a + ')');
    const s = h.replace('#', '');
    if (s.length === 3) return `rgba(${parseInt(s[0] + s[0], 16)},${parseInt(s[1] + s[1], 16)},${parseInt(s[2] + s[2], 16)},${a})`;
    if (s.length === 6) return `rgba(${parseInt(s.slice(0, 2), 16)},${parseInt(s.slice(2, 4), 16)},${parseInt(s.slice(4, 6), 16)},${a})`;
    return h;
  }

  function layout(w, h) {
    const padL = 9, padR = 62, padT = 10, padB = 20, gap = 6;
    const macdH = APP.showMACD ? Math.max(62, h * 0.155) : 0;
    const volH = Math.max(44, h * 0.13);
    const mainTop = padT, mainBottom = h - padB - macdH - volH - gap * 2;
    const volTop = mainBottom + gap, volBottom = volTop + volH;
    const macdTop = volBottom + gap, macdBottom = h - padB;
    return { padL, padR, padT, padB, gap, plotW: w - padL - padR, mainTop, mainBottom, volTop, volBottom, macdTop, macdBottom };
    }

  function scheduleChart() {
    if (APP.frame) return;
    APP.frame = requestAnimationFrame(() => { APP.frame = 0; renderChart(); });
  }

  function renderChart() {
    const c = cv();
    if (!c) return;
    const { ctx, w, h } = fitCanvas(c);
    APP.w = w; APP.h = h;
    const L = layout(w, h);
    const col = themeColors();
    ctx.clearRect(0, 0, w, h);
    if (!APP.ready || !APP.bars) return;
    const b = APP.bars, n = b.dates.length;
    let count = clamp(Math.round(APP.view.count), 30, n);
    let end = clamp(Math.round(APP.view.end), count, n);
    APP.view.count = count; APP.view.end = end;
    const start = end - count;
    const bw = L.plotW / count;
    const xAt = i => L.padL + (i - start + 0.5) * bw;
    const vis = i => i >= start && i < end;

    let lo = Infinity, hi = -Infinity;
    for (let i = start; i < end; i++) { if (b.l[i] < lo) lo = b.l[i]; if (b.h[i] > hi) hi = b.h[i]; }
    if (!isFinite(lo)) return;
    const pad = (hi - lo) * 0.035 || 1;
    lo -= pad; hi += pad;
    const yP = v => L.mainBottom - (v - lo) / (hi - lo) * (L.mainBottom - L.mainTop);

    let vmax = 0;
    for (let i = start; i < end; i++) vmax = Math.max(vmax, b.v[i]);
    vmax = vmax || 1;
    const yV = v => L.volBottom - v / vmax * (L.volBottom - L.volTop);

    // 网格与价格轴
    ctx.save();
    ctx.strokeStyle = col.grid; ctx.lineWidth = 1;
    ctx.fillStyle = col.muted; ctx.font = '10px ui-monospace, Consolas, monospace'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let k = 0; k <= 4; k++) {
      const y = L.mainTop + (L.mainBottom - L.mainTop) * k / 4;
      const v = hi - (hi - lo) * k / 4;
      ctx.beginPath(); ctx.moveTo(L.padL, y); ctx.lineTo(L.padL + L.plotW, y); ctx.stroke();
      ctx.fillText(num(v), w - 8, y);
    }
    // 日期轴（画在最底部，不与量窗/MACD 重叠；悬停时只留十字光标日期）
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const ticks = Math.min(6, count);
    if (!APP.hover) for (let k = 0; k < ticks; k++) {
      const i = Math.round(start + (count - 1) * k / Math.max(1, ticks - 1));
      const x = xAt(i);
      if (x < L.padL + 20 || x > L.padL + L.plotW - 20) continue;
      ctx.strokeStyle = col.grid; ctx.beginPath(); ctx.moveTo(x, L.macdBottom); ctx.lineTo(x, L.macdBottom + 3); ctx.stroke();
      const label = APP.period === 'month' ? b.dates[i].slice(0, 7) : b.dates[i].slice(2, 10);
      ctx.fillStyle = col.muted;
      ctx.fillText(label, x, h - 17);
    }
    ctx.restore();

    // 价格区裁剪
    ctx.save();
    ctx.beginPath(); ctx.rect(L.padL, L.mainTop, L.plotW, L.mainBottom - L.mainTop); ctx.clip();

    // 持仓带
    const positions = buildPositions();
    for (const p of positions) {
      const i0 = b.map.get(p.buy), i1 = p.sell ? b.map.get(p.sell) : n - 1;
      if (i0 == null || i1 == null) continue;
      if (i1 < start || i0 >= end) continue;
      const x0 = xAt(Math.max(i0, start)), x1 = xAt(Math.min(i1, end - 1));
      ctx.fillStyle = 'rgba(208,138,58,.32)';
      ctx.fillRect(x0 - bw / 2, L.mainBottom - 4, Math.max(1, x1 - x0 + bw), 3);
    }

    // K 线
    for (let i = start; i < end; i++) {
      const up = b.c[i] >= b.o[i];
      const color = up ? col.up : col.down;
      const x = xAt(i);
      const bodyW = Math.max(1, Math.min(bw * 0.72, 16));
      ctx.strokeStyle = color; ctx.fillStyle = color;
      ctx.beginPath(); ctx.moveTo(x, yP(b.h[i])); ctx.lineTo(x, yP(b.l[i])); ctx.lineWidth = bw < 2 ? 1 : 1.2; ctx.stroke();
      const y1 = yP(Math.max(b.o[i], b.c[i])), y2 = yP(Math.min(b.o[i], b.c[i]));
      let hh = Math.max(1, y2 - y1);
      if (bw >= 2) ctx.fillRect(x - bodyW / 2, y1, bodyW, hh);
      else ctx.fillRect(x - 0.5, y1, 1, hh);
    }

    // 均线 / BOLL
    const line = (arr, color, width = 1, dash = []) => {
      ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash); ctx.beginPath();
      let started = false;
      for (let i = start; i < end; i++) {
        const v = arr[i];
        if (!isFinite(v)) { started = false; continue; }
        const x = xAt(i), y = yP(v);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke(); ctx.restore();
    };
    if (APP.showBOLL) {
      ctx.save();
      ctx.beginPath();
      let has = false;
      for (let i = start; i < end; i++) { const v = APP.ind.boll.up[i]; if (!isFinite(v)) continue; const x = xAt(i), y = yP(v); has ? ctx.lineTo(x, y) : (ctx.moveTo(x, y), has = true); }
      for (let i = end - 1; i >= start; i--) { const v = APP.ind.boll.low[i]; if (!isFinite(v)) continue; ctx.lineTo(xAt(i), yP(v)); }
      if (has) { ctx.closePath(); ctx.fillStyle = 'rgba(122,166,214,.07)'; ctx.fill(); }
      ctx.restore();
      line(APP.ind.boll.up, COLORS.boll, 1, [4, 3]);
      line(APP.ind.boll.low, COLORS.boll, 1, [4, 3]);
      line(APP.ind.boll.mid, COLORS.boll, 1);
    }
    if (APP.showMA) {
      line(APP.ind.ma5, COLORS.ma5, 1);
      line(APP.ind.ma10, COLORS.ma10, 1);
      line(APP.ind.ma20, COLORS.ma20, 1.2);
      line(APP.ind.ma60, COLORS.ma60, 1.2);
      line(APP.ind.ma250, COLORS.ma250, 1.5);
    }

    // 当前持仓止损线
    if (APP.state.pos === 1 && APP.state.stop) {
      const y = yP(APP.state.stop);
      if (y > L.mainTop && y < L.mainBottom) {
        ctx.save(); ctx.strokeStyle = col.down; ctx.setLineDash([5, 4]); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(L.padL, y); ctx.lineTo(L.padL + L.plotW, y); ctx.stroke();
        ctx.fillStyle = col.down; ctx.font = '10px ui-monospace, Consolas, monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
        ctx.fillText('止损 ' + num(APP.state.stop), L.padL + 4, y - 3); ctx.restore();
      }
    }

    // B/S 标记
    const evByBar = new Map();
    for (const e of APP.events) {
      const i = b.map.get(e.sig_date); if (i == null) continue;
      if (!evByBar.has(i)) evByBar.set(i, []);
      evByBar.get(i).push(e);
    }
    const dense = count > 420;
    for (const [i, evs] of evByBar) {
      if (!vis(i)) continue;
      const x = xAt(i);
      for (const e of evs) {
        const buy = e.type === 'BUY';
        const y = buy ? yP(b.l[i]) + 12 : yP(b.h[i]) - 12;
        const color = buy ? col.up : col.down;
        if (dense || bw < 3) {
          ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, 2, 0, Math.PI * 2); ctx.fill();
        } else {
          ctx.fillStyle = color;
          ctx.beginPath();
          if (buy) { ctx.moveTo(x, y - 7); ctx.lineTo(x - 6, y + 2); ctx.lineTo(x + 6, y + 2); }
          else { ctx.moveTo(x, y + 7); ctx.lineTo(x - 6, y - 2); ctx.lineTo(x + 6, y - 2); }
          ctx.closePath(); ctx.fill();
          ctx.fillStyle = '#fff'; ctx.font = 'bold 9px ui-monospace, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(buy ? 'B' : 'S', x, y + (buy ? -1 : 1));
        }
      }
    }
    // 待执行信号
    if (APP.state.pending) {
      const i = n - 1, x = xAt(i), buy = APP.state.pending === 'BUY';
      const y = buy ? yP(b.l[i]) + 18 : yP(b.h[i]) - 18;
      ctx.save(); ctx.strokeStyle = col.amber; ctx.setLineDash([3, 3]); ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = col.amber; ctx.font = 'bold 9px ui-monospace, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(buy ? 'B?' : 'S?', x, y); ctx.restore();
    }
    ctx.restore();

    // 成交量
    ctx.save();
    ctx.strokeStyle = col.grid; ctx.beginPath(); ctx.moveTo(L.padL, L.volTop); ctx.lineTo(L.padL + L.plotW, L.volTop); ctx.stroke();
    for (let i = start; i < end; i++) {
      const x = xAt(i), up = b.c[i] >= b.o[i];
      ctx.fillStyle = up ? rgba(col.up, .55) : rgba(col.down, .55);
      const y = yV(b.v[i]);
      ctx.fillRect(x - Math.max(1, Math.min(bw * .7, 12)) / 2, y, Math.max(1, Math.min(bw * .7, 12)), L.volBottom - y);
    }
    ctx.fillStyle = col.muted; ctx.font = '9px ui-monospace, monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText('成交量', L.padL + 3, L.volTop + 3);
    ctx.textAlign = 'right'; ctx.fillText(volFmt(vmax), w - 8, L.volTop + 3);
    ctx.restore();

    // MACD
    if (APP.showMACD) {
      const m = APP.ind.macd;
      let mmax = 0;
      for (let i = start; i < end; i++) mmax = Math.max(mmax, Math.abs(m.dif[i] || 0), Math.abs(m.dea[i] || 0), Math.abs(m.hist[i] || 0));
      mmax = mmax || 1;
      const mid = (L.macdTop + L.macdBottom) / 2;
      const yM = v => mid - v / mmax * (L.macdBottom - L.macdTop) / 2;
      ctx.save();
      ctx.strokeStyle = col.grid; ctx.beginPath(); ctx.moveTo(L.padL, mid); ctx.lineTo(L.padL + L.plotW, mid); ctx.stroke();
      for (let i = start; i < end; i++) {
        const h = m.hist[i];
        if (!isFinite(h)) continue;
        ctx.fillStyle = h >= 0 ? rgba(col.up, .6) : rgba(col.down, .6);
        const y0 = yM(h), y1 = yM(0);
        ctx.fillRect(xAt(i) - Math.max(1, bw * .35) / 2, Math.min(y0, y1), Math.max(1, bw * .35), Math.abs(y1 - y0) || 1);
      }
      ctx.strokeStyle = COLORS.ma5; ctx.lineWidth = 1; ctx.beginPath();
      let st = false;
      for (let i = start; i < end; i++) { const v = m.dif[i]; if (!isFinite(v)) continue; const x = xAt(i), y = yM(v); st ? ctx.lineTo(x, y) : (ctx.moveTo(x, y), st = true); }
      ctx.stroke();
      ctx.strokeStyle = COLORS.ma20; ctx.beginPath(); st = false;
      for (let i = start; i < end; i++) { const v = m.dea[i]; if (!isFinite(v)) continue; const x = xAt(i), y = yM(v); st ? ctx.lineTo(x, y) : (ctx.moveTo(x, y), st = true); }
      ctx.stroke();
      ctx.fillStyle = col.muted; ctx.font = '9px ui-monospace, monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText('MACD(12,26,9)', L.padL + 3, L.macdTop + 3);
      ctx.restore();
    }

    // 最新价线
    if (end === n) {
      const last = b.c[n - 1], y = yP(last);
      ctx.save(); ctx.strokeStyle = col.muted; ctx.setLineDash([2, 4]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(L.padL, y); ctx.lineTo(L.padL + L.plotW, y); ctx.stroke(); ctx.setLineDash([]);
      const up = n > 1 ? last >= b.c[n - 2] : true;
      const label = num(last);
      ctx.font = 'bold 10px ui-monospace, monospace';
      const tw = ctx.measureText(label).width + 10;
      ctx.fillStyle = up ? col.up : col.down;
      ctx.fillRect(w - tw - 3, y - 9, tw, 18);
      ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(label, w - tw / 2 - 3, y);
      ctx.restore();
    }

    // 十字光标
    if (APP.hover && APP.hover.i >= start && APP.hover.i < end) {
      const i = APP.hover.i, x = xAt(i), y = clamp(APP.hover.y, L.mainTop, L.mainBottom);
      ctx.save(); ctx.strokeStyle = rgba(col.muted, .55); ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, L.mainTop); ctx.lineTo(x, L.macdBottom); ctx.moveTo(L.padL, y); ctx.lineTo(L.padL + L.plotW, y); ctx.stroke();
      // 日期标签
      const dl = b.dates[i];
      ctx.setLineDash([]); ctx.font = '10px ui-monospace, monospace';
      const tw = ctx.measureText(dl).width + 10;
      ctx.fillStyle = col.inset; ctx.fillRect(x - tw / 2, L.macdBottom + 1, tw, 15);
      ctx.strokeStyle = col.line; ctx.strokeRect(x - tw / 2, L.macdBottom + 1, tw, 15);
      ctx.fillStyle = col.text; ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillText(dl, x, L.macdBottom + 3);
      // 价格标签
      const price = lo + (L.mainBottom - y) / (L.mainBottom - L.mainTop) * (hi - lo);
      const pl = num(price);
      ctx.fillStyle = col.inset; ctx.fillRect(w - 58, y - 8, 54, 16);
      ctx.strokeStyle = col.line; ctx.strokeRect(w - 58, y - 8, 54, 16);
      ctx.fillStyle = col.text; ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillText(pl, w - 9, y);
      ctx.restore();
    }

    // 区间选择框
    if (APP.range || APP.selecting) {
      const r = APP.selecting || APP.range;
      const i0 = Math.min(r.a, r.b), i1 = Math.max(r.a, r.b);
      if (i1 >= start && i0 < end) {
        const x0 = xAt(Math.max(i0, start)) - bw / 2, x1 = xAt(Math.min(i1, end - 1)) + bw / 2;
        ctx.save(); ctx.fillStyle = 'rgba(208,138,58,.12)'; ctx.fillRect(x0, L.mainTop, x1 - x0, L.mainBottom - L.mainTop);
        ctx.strokeStyle = 'rgba(208,138,58,.65)'; ctx.lineWidth = 1; ctx.strokeRect(x0, L.mainTop, x1 - x0, L.mainBottom - L.mainTop);
        ctx.restore();
      }
    }

    const from = b.dates[start], to = b.dates[end - 1];
    $('#viewInfo').textContent = `${from} → ${to} · ${count} 根`;
  }

  function buildPositions() {
    const out = [];
    let open = null;
    for (const e of APP.events) {
      if (e.type === 'BUY') open = { buy: e.exec_date, buyPx: e.px, sig: e.sig_date, sell: null, ret: null, hold: null, stop: e.stop };
      else if (open) { open.sell = e.exec_date; open.ret = e.ret; open.hold = e.hold; out.push(open); open = null; }
    }
    if (open) out.push(open);
    return out;
  }

  function volFmt(v) {
    if (v == null || !isFinite(v)) return '—';
    if (v >= 1e8) return (v / 1e8).toFixed(2) + '亿股';
    if (v >= 1e4) return (v / 1e4).toFixed(1) + '万股';
    return v.toFixed(0) + '股';
  }
  function amtFmt(v) {
    if (v == null || !isFinite(v)) return '—';
    if (v >= 1e12) return (v / 1e12).toFixed(2) + '万亿';
    if (v >= 1e8) return (v / 1e8).toFixed(1) + '亿';
    if (v >= 1e4) return (v / 1e4).toFixed(0) + '万';
    return v.toFixed(0);
  }

  function bindGlobal() {
    $$('#periodSeg button').forEach(b => b.addEventListener('click', () => {
      $$('#periodSeg button').forEach(x => x.classList.remove('on')); b.classList.add('on');
      APP.period = b.dataset.period; APP.range = null; $('#rangePanel').hidden = true;
      applyPeriod(true); renderChart();
    }));
    $$('#indSeg button').forEach(b => b.addEventListener('click', () => {
      b.classList.toggle('on');
      APP.showMA = $('#indSeg [data-ind="ma"]').classList.contains('on');
      APP.showBOLL = $('#indSeg [data-ind="boll"]').classList.contains('on');
      APP.showMACD = $('#indSeg [data-ind="macd"]').classList.contains('on');
      renderChart();
    }));
    $('#rangeBtn').addEventListener('click', () => {
      APP.rangeMode = !APP.rangeMode; $('#rangeBtn').classList.toggle('on', APP.rangeMode);
      if (!APP.rangeMode) { APP.range = null; $('#rangePanel').hidden = true; renderChart(); }
      $('#chartHint').textContent = APP.rangeMode ? '区间统计已开启：在图上拖动选择' : '滚轮缩放 · 拖动平移 · Shift+拖动区间统计 · 双击复位';
    });
    $('#fsBtn').addEventListener('click', () => {
      const card = $('#chartCard');
      if (!document.fullscreenElement) card.requestFullscreen?.();
      else document.exitFullscreen?.();
    });
    $('#themeBtn').addEventListener('click', () => window.ToolSiteTheme?.toggle());
    document.addEventListener('sitethemechange', () => { renderChart(); renderEquity(); });
    $$('#tabs button').forEach(b => b.addEventListener('click', () => {
      $$('#tabs button').forEach(x => x.classList.remove('on')); b.classList.add('on');
      TABS.forEach(t => $('#panel-' + t).classList.toggle('on', t === b.dataset.tab));
      if (b.dataset.tab === 'overview') renderEquity();
    }));
    $$('#tradeFilter button').forEach(b => b.addEventListener('click', () => {
      $$('#tradeFilter button').forEach(x => x.classList.remove('on')); b.classList.add('on');
      renderTrades(b.dataset.f);
    }));
    bindChartEvents();
    const ro = new ResizeObserver(() => { if (APP.ready) scheduleChart(); });
    ro.observe($('#chartShell'));
  }

  /* ---------- 图表交互 ---------- */
  function idxAt(clientX) {
    const c = cv(), r = c.getBoundingClientRect(), L = layout(APP.w || r.width, APP.h || r.height);
    const n = APP.bars.dates.length, count = APP.view.count, start = APP.view.end - count;
    const bw = L.plotW / count;
    const x = clientX - r.left;
    return clamp(start + Math.floor((x - L.padL) / bw), 0, n - 1);
  }

  function zoomAt(clientX, factor) {
    if (!APP.ready) return;
    const n = APP.bars.dates.length;
    const idx = idxAt(clientX);
    const old = APP.view.count;
    const next = clamp(Math.round(old * factor), 30, n);
    if (next === old) return;
    const start = APP.view.end - old;
    const ratio = clamp((idx - start) / old, 0, 1);
    let ns = idx - ratio * next;
    let ne = ns + next;
    if (ne > n) { ne = n; ns = n - next; }
    if (ns < 0) { ns = 0; ne = next; }
    APP.view.count = next; APP.view.end = Math.round(ne);
    renderChart();
  }

  function bindChartEvents() {
    const c = cv(), shell = $('#chartShell');
    shell.tabIndex = 0;
    c.addEventListener('pointerdown', e => {
      if (!APP.ready) return;
      try { shell.focus({ preventScroll: true }); } catch {}
      try { c.setPointerCapture(e.pointerId); } catch {}
      APP.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (APP.pointers.size === 2) {
        const [a, b] = [...APP.pointers.values()];
        APP.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), count: APP.view.count, mid: (a.x + b.x) / 2 };
        APP.pan = null; APP.selecting = null;
        return;
      }
      if (e.shiftKey || APP.rangeMode) {
        const i = idxAt(e.clientX);
        APP.selecting = { a: i, b: i };
        APP.range = null; $('#rangePanel').hidden = true;
        APP.hover = null; $('#chartTip').hidden = true;
        renderChart();
      } else {
        APP.pan = { x: e.clientX, end: APP.view.end };
        APP.hover = null; $('#chartTip').hidden = true;
        c.style.cursor = 'grabbing';
      }
    });
    c.addEventListener('pointermove', e => {
      if (!APP.ready) return;
      const p = APP.pointers.get(e.pointerId);
      if (p) { p.x = e.clientX; p.y = e.clientY; }
      if (APP.pointers.size === 2 && APP.pinch) {
        const [a, b] = [...APP.pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (APP.pinch.dist > 0) {
          const nx = clamp(Math.round(APP.pinch.count * (APP.pinch.dist / dist)), 30, APP.bars.dates.length);
          if (nx !== APP.view.count) {
            const old = APP.view.count, idx = idxAt(APP.pinch.mid), start = APP.view.end - old;
            const ratio = clamp((idx - start) / old, 0, 1);
            let ns = idx - ratio * nx, ne = ns + nx;
            if (ne > APP.bars.dates.length) { ne = APP.bars.dates.length; ns = ne - nx; }
            if (ns < 0) { ns = 0; ne = nx; }
            APP.view.count = nx; APP.view.end = Math.round(ne);
            renderChart();
          }
        }
        return;
      }
      if (APP.selecting) {
        APP.selecting.b = idxAt(e.clientX);
        scheduleChart();
        return;
      }
      if (APP.pan) {
        const L = layout(APP.w, APP.h), bw = L.plotW / APP.view.count;
        const ne = clamp(Math.round(APP.pan.end - (e.clientX - APP.pan.x) / bw), APP.view.count, APP.bars.dates.length);
        if (ne !== APP.view.end) { APP.view.end = ne; scheduleChart(); }
        return;
      }
      const i = idxAt(e.clientX);
      const r = cv().getBoundingClientRect();
      APP.hover = { i, y: e.clientY - r.top };
      scheduleChart();
      showTip(i, e.clientX, e.clientY);
    });
    const up = e => {
      APP.pointers.delete(e.pointerId);
      if (APP.selecting) {
        if (APP.selecting.a !== APP.selecting.b) {
          APP.range = { a: Math.min(APP.selecting.a, APP.selecting.b), b: Math.max(APP.selecting.a, APP.selecting.b) };
          showRange(APP.range);
        } else {
          APP.range = null; $('#rangePanel').hidden = true;
        }
        APP.selecting = null; renderChart();
      }
      if (APP.pointers.size < 2) APP.pinch = null;
      APP.pan = null; c.style.cursor = 'crosshair';
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('pointerleave', () => {
      if (APP.pointers.size) return;
      APP.hover = null; $('#chartTip').hidden = true; renderChart();
    });
    c.addEventListener('wheel', e => {
      if (!APP.ready) return;
      e.preventDefault();
      zoomAt(e.clientX, e.deltaY > 0 ? 1.14 : 1 / 1.14);
    }, { passive: false });
    c.addEventListener('dblclick', () => {
      APP.view.count = Math.min(180, APP.bars.dates.length);
      APP.view.end = APP.bars.dates.length;
      APP.range = null; $('#rangePanel').hidden = true;
      renderChart();
    });
    shell.addEventListener('keydown', e => {
      if (!APP.ready) return;
      const n = APP.bars.dates.length;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const d = e.key === 'ArrowLeft' ? -12 : 12;
        APP.view.end = clamp(APP.view.end + d, APP.view.count, n);
        renderChart();
      } else if (e.key === '+' || e.key === '=') { e.preventDefault(); const r = cv().getBoundingClientRect(); zoomAt(r.left + r.width / 2, 1 / 1.12); }
      else if (e.key === '-') { e.preventDefault(); const r = cv().getBoundingClientRect(); zoomAt(r.left + r.width / 2, 1.12); }
      else if (e.key === '0' || e.key === 'Home') { e.preventDefault(); APP.view.count = Math.min(180, n); APP.view.end = n; renderChart(); }
    });
  }

  function showTip(i, clientX, clientY) {
    const b = APP.bars, tip = $('#chartTip'), shell = $('#chartShell');
    if (i == null || i < 0 || i >= b.dates.length) { tip.hidden = true; return; }
    const prev = i > 0 ? b.c[i - 1] : b.o[i];
    const chg = b.c[i] / prev - 1;
    const evs = APP.events.filter(e => b.map.get(e.sig_date) === i);
    const ma = APP.ind;
    const rows = [
      ['开', num(b.o[i])], ['高', num(b.h[i])], ['低', num(b.l[i])], ['收', num(b.c[i])],
      ['涨跌', signed(chg)], ['振幅', pct((b.h[i] - b.l[i]) / prev)],
      ['成交量', volFmt(b.v[i])], ['成交额', amtFmt(b.a[i])],
      ['MA5 / 20', num(ma.ma5[i]) + ' / ' + num(ma.ma20[i])],
      ['MA250', num(ma.ma250[i])]
    ];
    let html = `<div class="tt-date">${b.dates[i]}${APP.period !== 'day' ? ' · ' + (APP.period === 'week' ? '周K' : '月K') : ''}</div>`;
    for (const [k, v] of rows) html += `<div class="tt-row"><span>${k}</span><b>${v}</b></div>`;
    if (evs.length) {
      for (const e of evs) {
        html += `<div class="tt-sig"><span style="color:${e.type === 'BUY' ? 'var(--up)' : 'var(--down)'};font-weight:600">${e.type === 'BUY' ? 'B 买入信号' : 'S 卖出信号'}</span><div class="tt-row"><span>执行</span><b>${e.exec_date} @ ${num(e.px)}</b></div>${e.ret != null ? `<div class="tt-row"><span>单笔收益</span><b>${signed(e.ret)} · 持有${e.hold}日</b></div>` : ''}</div>`;
      }
    }
    tip.innerHTML = html;
    tip.hidden = false;
    const r = shell.getBoundingClientRect();
    let x = clientX - r.left + 14, y = clientY - r.top + 14;
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    if (x + tw > r.width - 8) x = clientX - r.left - tw - 14;
    if (y + th > r.height - 8) y = clientY - r.top - th - 14;
    tip.style.left = Math.max(4, x) + 'px'; tip.style.top = Math.max(4, y) + 'px';
  }

  function rangeStats(a, b) {
    const i0 = Math.min(a, b), i1 = Math.max(a, b), d = APP.bars;
    const c0 = d.c[i0], c1 = d.c[i1];
    let hi = -Infinity, lo = Infinity, peak = c0, dd = 0, sumV = 0, sumA = 0;
    const rets = [];
    for (let i = i0; i <= i1; i++) {
      hi = Math.max(hi, d.h[i]); lo = Math.min(lo, d.l[i]);
      peak = Math.max(peak, d.c[i]); dd = Math.min(dd, d.c[i] / peak - 1);
      sumV += d.v[i]; sumA += d.a[i];
      if (i > i0) rets.push(d.c[i] / d.c[i - 1] - 1);
    }
    const ann = rets.length > 2 ? Math.sqrt(252) * Math.sqrt(rets.reduce((s, x) => s + x * x, 0) / rets.length - (rets.reduce((s, x) => s + x, 0) / rets.length) ** 2) : null;
    return { i0, i1, days: i1 - i0 + 1, ret: c1 / c0 - 1, hi, lo, amp: (hi - lo) / c0, dd, sumV, sumA, ann };
  }

  function showRange(r) {
    const s = rangeStats(r.a, r.b);
    const p = $('#rangePanel');
    p.hidden = false;
    p.innerHTML = `<button class="rp-close" aria-label="关闭">×</button><h3>区间统计 · ${APP.bars.dates[s.i0]} → ${APP.bars.dates[s.i1]}</h3>
      <div class="rp-row"><span>交易日</span><b>${s.days} ${APP.period === 'day' ? '日' : (APP.period === 'week' ? '周' : '月')}</b></div>
      <div class="rp-row"><span>区间涨跌</span><b class="${s.ret >= 0 ? 'up' : 'dn'}">${signed(s.ret)}</b></div>
      <div class="rp-row"><span>最高 / 最低</span><b>${num(s.hi)} / ${num(s.lo)}</b></div>
      <div class="rp-row"><span>振幅</span><b>${pct(s.amp)}</b></div>
      <div class="rp-row"><span>区间最大回撤</span><b class="dn">${pct(s.dd)}</b></div>
      <div class="rp-row"><span>成交量合计</span><b>${volFmt(s.sumV)}</b></div>
      <div class="rp-row"><span>成交额合计</span><b>${amtFmt(s.sumA)}</b></div>
      <div class="rp-row"><span>日均成交额</span><b>${amtFmt(s.sumA / s.days)}</b></div>
      <div class="rp-row"><span>年化波动</span><b>${pct(s.ann)}</b></div>`;
    p.querySelector('.rp-close').addEventListener('click', () => { p.hidden = true; APP.range = null; renderChart(); });
  }

  /* ---------- 概览 ---------- */
  function kpiCard(k, v, d, cls = '') {
    return `<div class="kpi"><div class="k">${k}</div><div class="v ${cls}">${v}</div><div class="d">${d || ''}</div></div>`;
  }

  function renderKPI() {
    const info = currentInfo(), bt = info.backtest || {}, full = bt.full || {}, bh = bt.bh || {}, oos = (bt.OOS || {}).strategy || {};
    const box = $('#kpiGrid');
    box.innerHTML = [
      kpiCard('全样本年化', pct(full.cagr), `${info.start} 起 · ${full.trades || 0} 笔`, full.cagr >= 0 ? 'up' : 'dn'),
      kpiCard('全样本最大回撤', pct(full.maxdd), `买入持有 ${pct(bh.maxdd)}`, 'dn'),
      kpiCard('全样本夏普', num(full.sharpe), `持仓占比 ${pct(full.exposure, 0)}`),
      kpiCard('样本外年化', pct(oos.cagr), `2019 起 · ${oos.trades || 0} 笔`, oos.cagr >= 0 ? 'up' : 'dn'),
      kpiCard('样本外最大回撤', pct(oos.maxdd), `买入持有 ${pct((bt.OOS || {}).bh && bt.OOS.bh.maxdd)}`, 'dn'),
      kpiCard('当前状态', info.state.pos ? '持仓' : '空仓', info.state.pos ? `成本 ${num(info.state.entry_px)}` : `等待 ${num(info.levels.buy_trigger)} 突破`, info.state.pos ? 'up' : 'muted')
    ].join('');
  }

  function equitySeries() {
    const raw = APP.raw, byExec = new Map();
    for (const e of APP.events) byExec.set(e.exec_date, e);
    let v = 1, b = 1, holding = false;
    const eq = [1], bh = [1];
    for (let i = 1; i < raw.dates.length; i++) {
      const e = byExec.get(raw.dates[i]);
      if (e && e.type === 'BUY') { v *= raw.c[i] / e.px; holding = true; }
      else if (e && e.type === 'SELL' && holding) { v *= e.px / raw.c[i - 1]; holding = false; }
      else if (holding) v *= raw.c[i] / raw.c[i - 1];
      b *= raw.c[i] / raw.c[i - 1];
      eq.push(v); bh.push(b);
    }
    return { eq, bh };
  }

  function renderEquity() {
    const c = $('#equityChart');
    if (!c || !APP.ready) return;
    const { ctx, w, h } = fitCanvas(c, 160);
    const col = themeColors();
    ctx.clearRect(0, 0, w, h);
    const { eq, bh } = equitySeries();
    const n = eq.length;
    const L = { l: 38, r: 10, t: 8, b: 18 };
    const lo = Math.min(...eq, ...bh), hi = Math.max(...eq, ...bh);
    if (!isFinite(lo) || !isFinite(hi) || hi <= 0) return;
    const l0 = Math.log(Math.max(lo, 0.1)), l1 = Math.log(hi);
    const y = v => L.t + (h - L.t - L.b) - (Math.log(Math.max(v, .1)) - l0) / (l1 - l0) * (h - L.t - L.b);
    const x = i => L.l + (i / (n - 1)) * (w - L.l - L.r);
    // grid / y labels
    ctx.strokeStyle = col.grid; ctx.fillStyle = col.muted; ctx.font = '9px ui-monospace, monospace'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    const ticks = [1, 2, 5, 10, 20];
    for (const t of ticks) {
      if (t < lo * .95 || t > hi * 1.05) continue;
      const yy = y(t); ctx.beginPath(); ctx.moveTo(L.l, yy); ctx.lineTo(w - L.r, yy); ctx.stroke(); ctx.fillText(t + '×', L.l - 4, yy);
    }
    // x labels
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const y0 = +APP.raw.dates[0].slice(0, 4), y1 = +APP.raw.dates[n - 1].slice(0, 4);
    const step = Math.max(2, Math.round((y1 - y0) / 6));
    for (let yr = Math.ceil(y0 / step) * step; yr <= y1; yr += step) {
      const i = APP.raw.dates.findIndex(d => +d.slice(0, 4) === yr);
      if (i < 0) continue;
      ctx.strokeStyle = col.grid; ctx.beginPath(); ctx.moveTo(x(i), L.t); ctx.lineTo(x(i), h - L.b); ctx.stroke();
      ctx.fillStyle = col.muted; ctx.fillText(yr, x(i), h - L.b + 3);
    }
    // fill
    ctx.beginPath(); ctx.moveTo(x(0), y(eq[0]));
    for (let i = 1; i < n; i++) ctx.lineTo(x(i), y(eq[i]));
    ctx.lineTo(x(n - 1), h - L.b); ctx.lineTo(x(0), h - L.b); ctx.closePath();
    ctx.fillStyle = rgba(col.amber, .08); ctx.fill();
    // lines
    for (const [arr, color, width, dash] of [[bh, col.muted, 1, [4, 3]], [eq, col.amber, 1.8, []]]) {
      ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash); ctx.beginPath();
      for (let i = 0; i < n; i++) { const xx = x(i), yy = y(arr[i]); i ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy); }
      ctx.stroke(); ctx.restore();
    }
    // final labels in legend
    $('#eqStrategy').textContent = `趋势策略 ${eq[n - 1].toFixed(2)}×`;
    $('#eqBh').textContent = `买入持有 ${bh[n - 1].toFixed(2)}×`;
    $('#equityNote').textContent = `${APP.raw.dates[0].slice(0, 4)}–${APP.raw.dates[n - 1].slice(0, 4)} · 对数刻度 · 含 5bp 单边成本`;
  }

  function renderStats() {
    const info = currentInfo(), lv = info.levels, s = info.stats;
    const amount = APP.raw.a[APP.raw.a.length - 1];
    const items = [
      ['最新收盘', num(lv.close)],
      ['日涨跌', signed(lv.chg), lv.chg >= 0 ? 'up' : 'dn'],
      ['年初至今', signed(s.ytd), s.ytd >= 0 ? 'up' : 'dn'],
      ['52周区间', num(s.low52) + ' – ' + num(s.high52)],
      ['20日年化波动', pct(s.vol20)],
      ['距年线', signed(s.dist_ma250), s.dist_ma250 >= 0 ? 'up' : 'dn'],
      ['ATR22', num(lv.atr22)],
      ['最新成交额', amtFmt(amount)]
    ];
    $('#statList').innerHTML = items.map(([k, v, cls]) => `<div class="stat-item"><div class="k">${k}</div><div class="v ${cls || ''}">${v}</div></div>`).join('');
  }

  function renderTrades(filter = 'all') {
    const info = currentInfo();
    const evs = APP.events.filter(e => filter === 'all' || e.type === filter);
    const pos = buildPositions();
    const wins = pos.filter(p => p.sell && p.ret > 0).length;
    const closed = pos.filter(p => p.sell).length;
    const avgHold = closed ? pos.filter(p => p.sell).reduce((s, p) => s + p.hold, 0) / closed : null;
    $('#tradeSummary').textContent = `${APP.events.length} 个信号 · ${APP.events.filter(e => e.type === 'BUY').length} 次买入 · 胜率 ${closed ? pct(wins / closed) : '—'} · 平均持有 ${avgHold ? avgHold.toFixed(0) + ' 日' : '—'}`;
    const rows = evs.slice().reverse().map(e => {
      const buy = e.type === 'BUY';
      return `<tr><td>${e.sig_date}</td><td>${e.exec_date}</td><td class="${buy ? 'up' : 'dn'}">${buy ? '买入 B' : '卖出 S'}</td><td>${num(e.px)}</td><td>${num(e.sig_close)}</td><td>${e.hold ?? '—'}</td><td class="${e.ret == null ? '' : e.ret >= 0 ? 'up' : 'dn'}">${e.ret == null ? '—' : signed(e.ret)}</td><td>${num(e.stop)}</td></tr>`;
    });
    if (info.state.pos === 1) {
      const pnl = info.state.entry_px ? info.levels.close / info.state.entry_px - 1 : null;
      rows.unshift(`<tr><td>${info.state.entry_date}</td><td>持仓中</td><td class="up">持仓</td><td>${num(info.state.entry_px)}</td><td>—</td><td>—</td><td class="${pnl >= 0 ? 'up' : 'dn'}">${signed(pnl)}</td><td>${num(info.state.stop)}</td></tr>`);
    }
    $('#tradeTable tbody').innerHTML = rows.join('') || '<tr><td colspan="8" class="muted">暂无符合条件的记录</td></tr>';
  }

  function renderYears() {
    const info = currentInfo(), bt = info.backtest || {};
    const years = bt.years || {}, bh = bt.bh_years || {};
    const { eq } = equitySeries();
    const dates = APP.raw.dates;
    const rows = Object.keys(years).sort((a, b) => b - a).map(y => {
      const sret = years[y], bret = bh[y];
      let peak = -Infinity, dd = 0;
      for (let i = 0; i < dates.length; i++) {
        if (!dates[i].startsWith(y)) continue;
        peak = Math.max(peak, eq[i]);
        if (peak > 0) dd = Math.min(dd, eq[i] / peak - 1);
      }
      return `<tr><td>${y}</td><td class="${sret >= 0 ? 'up' : 'dn'}">${signed(sret)}</td><td class="${bret >= 0 ? 'up' : 'dn'}">${signed(bret)}</td><td class="${sret - bret >= 0 ? 'up' : 'dn'}">${signed(sret - bret)}</td><td class="dn">${pct(dd)}</td></tr>`;
    });
    $('#yearTable tbody').innerHTML = rows.join('') || '<tr><td colspan="5" class="muted">暂无数据</td></tr>';
  }

  function renderPanels() {
    renderKPI();
    renderStats();
    renderTrades($('#tradeFilter .on')?.dataset.f || 'all');
    renderYears();
    renderEquity();
  }

  /* ---------- 方法页 ---------- */
  function renderMethod() {
    $('#panel-method').innerHTML = `
      <div class="method-intro">
        <h2>一套只做“顺势”的规则，不做预测</h2>
        <p>这套系统不猜底、不猜顶。它只回答两个问题：<b>趋势有没有成立？</b> 成立就买，跌破跟踪止损就卖。所有参数在 2005–2018 年样本内确定，2019 年以后作为样本外验证，不重新调参。</p>
      </div>
      <div class="theory-grid">
        <article><span class="theory-no">01</span><h3>海龟法则 · 唐奇安突破</h3><p>25 日高点突破入场，把“新高”当作趋势成立的客观证据；入场即设 2N（2×ATR）硬止损，先控制单笔风险，再谈收益。</p><em>Richard Dennis / Turtle Rules</em></article>
        <article><span class="theory-no">02</span><h3>Faber · 年线战术配置</h3><p>收盘价在 250 日年线之上才允许做多，年线本身还要高于 60 个交易日前，避免在长期下行趋势里反复接飞刀。</p><em>Meb Faber, A Quantitative Approach to Tactical Asset Allocation</em></article>
        <article><span class="theory-no">03</span><h3>Moskowitz · 时序动量</h3><p>同一资产过去 12 个月的收益为正才持有；本工具用“价格 &gt; 年线 + 年线向上”作为日频可实现的中期动量代理。</p><em>Time Series Momentum, JFE 2012</em></article>
        <article><span class="theory-no">04</span><h3>Weinstein · 四阶段</h3><p>只在第二阶段（上升趋势）参与，第三阶段（顶部盘整）退出，第四阶段（下跌）空仓。年线过滤就是阶段判定。</p><em>Stan Weinstein, Secrets for Profiting in Bull and Bear Markets</em></article>
        <article><span class="theory-no">05</span><h3>吊灯止损 · Chandelier Exit</h3><p>22 日最高价 − 3×ATR22，持仓期只上移。它让利润奔跑，又在波动放大时自动收紧退出，不依赖主观判断。</p><em>Chuck LeBeau / TA-Lib Chandelier Exit</em></article>
        <article><span class="theory-no">06</span><h3>A 股本土证据</h3><p>深交所 1990–2011 均线策略研究、国泰海通 2026 年 250 日均线择时研究、兴业证券不定期择时，都指向同一结论：均线/突破类规则能改善回撤与风险调整收益，但不能保证每年跑赢。</p><em>深交所研究报告 / 国泰海通 / 兴业证券</em></article>
      </div>
      <div class="rule-card">
        <div class="sub-head"><h2>锁定规则（不可事后改参数）</h2><span>参数来自样本内 2005–2018，样本外 2019–2026 未调参</span></div>
        <div class="rule-grid">
          <div><label>入场 · 突破</label><code>收盘 &gt; 过去25日最高 × 1.005</code></div>
          <div><label>入场 · 趋势</label><code>收盘 &gt; MA250 且 MA250 &gt; MA250[60日前]</code></div>
          <div><label>初始止损</label><code>次日开盘价 − 2 × ATR22</code></div>
          <div><label>跟踪止损</label><code>max(22日最高 − 3×ATR22, 初始止损)，只上移</code></div>
          <div><label>离场</label><code>收盘 &lt; 有效止损 × 0.995</code></div>
          <div><label>执行与成本</label><code>T日收盘出信号，T+1开盘成交；单边5bp</code></div>
        </div>
        <div class="rule-note"><b>为什么卖出后不等更低点再买？</b> 因为趋势系统不知道底在哪。卖出是风险控制，趋势重新成立（突破 + 年线向上）就按规则买回，哪怕价格更高。回测里很多“卖飞”正是这套系统的成本，也是它避开大回撤的来源。</div>
      </div>
      <div class="sub-card">
        <div class="sub-head"><h2>为什么不用 ADX、MACD 金叉做主信号</h2><span>都测过，样本外拖累</span></div>
        <div class="note-body">
          <p>360 组参数扫描里，ADX≥20 硬过滤整体拖累样本外：趋势末段 ADX 往往最高，等它确认时买点已经贵了；MACD 金叉在震荡市假信号太多。它们适合做辅助观察，不适合做这套规则的开关。</p>
          <p>均线周期也做了 150/200/250 对比。MA250（年线）在五个指数上最均衡，且是 A 股最常用的长期趋势刻度，不是为了让回测好看而挑出来的。</p>
        </div>
      </div>
      <div class="sub-card">
        <div class="sub-head"><h2>推送与使用</h2><span>PushPlus</span></div>
        <div class="note-body">
          <p>每个交易日收盘后（约 15:35）更新数据；<b>只有当天出现新的 B 或 S 信号才推送</b>，没有信号不打扰。推送标题写明指数与方向，内容含收盘价、触发价、次日开盘执行、止损位与风险提示。</p>
          <p>网页端所有 B/S 标记、持仓带、净值曲线、年度收益、验证数据都由同一份规则生成。页面不提供“荐股”或“目标价”，只提供规则状态。</p>
          <p class="muted">历史回测不构成投资建议。指数不能直接交易，实盘可用对应 ETF 或股指期货，需自行承担基差、跟踪误差、保证金与流动性风险。</p>
        </div>
      </div>
      <div class="sub-card">
        <div class="sub-head"><h2>主要参考</h2><span>理论原文与本土研究</span></div>
        <ul class="refs">
          <li><a href="https://www.turtletrader.com/rules/" target="_blank" rel="noopener">Original Turtle Trading Rules</a> — 20/55 日突破、10/20 日离场、2N 止损。</li>
          <li><a href="https://trendfollowing.com/whitepaper/CMT-Simple.pdf" target="_blank" rel="noopener">Meb Faber, A Quantitative Approach to Tactical Asset Allocation</a> — 10 月均线（约 200 日）择时。</li>
          <li><a href="https://www.sciencedirect.com/science/article/pii/S0304405X11002613" target="_blank" rel="noopener">Moskowitz, Ooi &amp; Pedersen, Time Series Momentum (JFE 2012)</a> — 时序动量。</li>
          <li><a href="https://www.szse.cn/aboutus/research/reports/P020180509546029354977.pdf" target="_blank" rel="noopener">深交所《A股市场均线策略有效性与收益率随机特征的研究》</a> — 1990–2011 上证均线策略超额收益。</li>
          <li><a href="https://tulipchips.com/ta/chandelier-exit" target="_blank" rel="noopener">Chandelier Exit 指标口径</a> — 22 日高 / 3×ATR。</li>
        </ul>
      </div>`;
  }

  /* ---------- 验证页 ---------- */
  function renderValidation() {
    const v = APP.val;
    if (!v) return;
    const panel = $('#panel-validation');
    panel.innerHTML = `
      <div class="validation-head">
        <h2>验证报告：先看它哪里会失效</h2>
        <p>样本内 2005–2018 定参数，样本外 2019–2026 不调参。下面所有数字都含 5bp 单边成本、T+1 开盘成交；最大回撤按逐日净值计算。</p>
      </div>
      <div class="kpi-grid" id="valKpi"></div>
      <div class="sub-card">
        <div class="sub-head"><h2>分指数：全样本与样本外</h2><span>年化 / 最大回撤 / 夏普</span></div>
        <div class="table-wrap"><table class="tbl" id="valTable"><thead><tr><th>指数</th><th>区间</th><th>策略年化</th><th>策略回撤</th><th>夏普</th><th>笔数</th><th>买入持有年化</th><th>买入持有回撤</th><th>最差单笔</th></tr></thead><tbody></tbody></table></div>
      </div>
      <div class="grid-2">
        <div class="sub-card"><div class="sub-head"><h2>参数高原</h2><span>样本外夏普中位数</span></div><div class="heatmap" id="heatmap"></div><p class="tiny">横轴：吊灯止损 ATR 倍数；纵轴：突破天数。25 日 / 3.0×ATR 位于高原中部，不是孤峰。</p></div>
        <div class="sub-card"><div class="sub-head"><h2>成本与随机入场</h2><span>稳健性对照</span></div><div class="table-wrap"><table class="tbl compact" id="costTable"><thead><tr><th>单边成本</th><th>全样本中位年化</th><th>样本外中位年化</th></tr></thead><tbody></tbody></table></div><p class="tiny" id="randomNote">—</p></div>
      </div>
      <div class="sub-card">
        <div class="sub-head"><h2>五个指数等权组合（2020–2026）</h2><span>仅用于统计显著性</span></div>
        <div class="portfolio-row" id="portfolioRow"></div>
      </div>
      <div class="sub-card caveat">
        <div class="sub-head"><h2>必须说清的局限</h2><span>不藏</span></div>
        <ul>
          <li><b>样本外置信区间很宽。</b>除创业板指外，其余指数样本外夏普的 95% Bootstrap 区间都跨 0；这套规则是“风险控制有效”，不是“每年稳赚”。</li>
          <li><b>2015 年中证500 最大回撤 −37.5%。</b>2015-08-18 买入后 4 个交易日跳空跌 18%，2N 硬止损被跳空穿透。这是真实的尾部风险，不能用“最大回撤只有 20%”误导。</li>
          <li><b>沪深300 样本外年化只有 +2.0%。</b>2019–2026 大盘震荡，趋势策略跑输买入持有约 2pp/年，但回撤从 −45.6% 压到 −14.4%。它的价值是防守，不是进攻。</li>
          <li><b>科创50 没有真正的样本内。</b>指数 2019-12-31 才有数据，等于全程样本外；只有 7 笔交易，年化 +5.5%、回撤 −13.4%，只能当观察，不能当作和沪深300 同等级的验证。</li>
          <li><b>信号滞后。</b>T 日收盘才确认，T+1 开盘才成交；跳空、涨跌停、ETF 跟踪误差都会让实盘偏离回测。</li>
          <li><b>只做多。</b>卖出后空仓，不做空；空仓期没有收益，也可能错过 V 型反转的第一段。</li>
        </ul>
      </div>`;
    const p = v.portfolio || {}, ps = p.strategy || {}, pb = p.bh || {};
    $('#valKpi').innerHTML = [
      kpiCard('组合年化', pct(ps.cagr), `${p.start || ''} 起 · 五指数等权`, ps.cagr >= 0 ? 'up' : 'dn'),
      kpiCard('组合最大回撤', pct(ps.maxdd), `买入持有 ${pct(pb.maxdd)}`, 'dn'),
      kpiCard('组合夏普', num(ps.sharpe), `95% CI ${p.sharpe_ci ? p.sharpe_ci.map(x => num(x, 2)).join(' / ') : '—'}`),
      kpiCard('买入持有年化', pct(pb.cagr), `回撤 ${pct(pb.maxdd)}`),
      kpiCard('样本外长度', '7.9 年', '沪深300 · 2019-01 至 2026-11'),
      kpiCard('参数', '25 / 3.0', '突破日 / ATR倍数', 'muted')
    ].join('');

    const rows = (v.indices || []).map(x => {
      const f = x.full || {}, fb = x.bh || {};
      const o = (x.OOS || {}).strategy || {}, ob = (x.OOS || {}).bh || {};
      const oosStart = x.start > '2019-01-01' ? x.start : '2019-01-01';
      return `<tr><td rowspan="2" class="idx-cell">${x.name || x.code}</td><td>全样本 ${x.start} → ${x.end}</td><td class="${f.cagr >= 0 ? 'up' : 'dn'}">${pct(f.cagr)}</td><td class="dn">${pct(f.maxdd)}</td><td>${num(f.sharpe)}</td><td>${f.trades ?? '—'}</td><td class="${fb.cagr >= 0 ? 'up' : 'dn'}">${pct(fb.cagr)}</td><td class="dn">${pct(fb.maxdd)}</td><td class="dn">${pct(x.worst_trade)}</td></tr>
        <tr class="oos-row"><td>样本外 ${oosStart} → ${x.end}</td><td class="${o.cagr >= 0 ? 'up' : 'dn'}">${pct(o.cagr)}</td><td class="dn">${pct(o.maxdd)}</td><td title="95% Bootstrap CI ${(x.OOS.sharpe_ci || []).map(v => num(v, 2)).join(' / ') || '—'}">${num(o.sharpe)}</td><td>${o.trades ?? '—'}</td><td class="${ob.cagr >= 0 ? 'up' : 'dn'}">${pct(ob.cagr)}</td><td class="dn">${pct(ob.maxdd)}</td><td class="muted">—</td></tr>`;
    });
    $('#valTable tbody').innerHTML = rows.join('');

    const plate = v.plateau || [];
    const flat = plate.flat ? plate.flat() : plate.flatMap(r => r);
    const vals = flat.map(x => x.oos_sharpe).filter(x => x != null);
    const mn = Math.min(...vals), mx = Math.max(...vals);
    const head = plate[0] ? plate[0].map(x => x.mult) : [2, 2.5, 3, 3.5, 4];
    let hm = '<div class="hm-head"></div>' + head.map(x => `<div class="hm-head">${x}×</div>`).join('');
    for (const row of plate) {
      hm += `<div class="hm-row">${row[0].entry}日</div>`;
      for (const x of row) {
        const val = x.oos_sharpe;
        const a = val == null ? 0 : .08 + .40 * (val - mn) / Math.max(.0001, mx - mn);
        hm += `<div class="hm-cell" style="background:rgba(201,135,58,${a.toFixed(2)});color:${a > .34 ? '#fff' : 'var(--text)'}" title="样本内 ${x.is_sharpe ?? '—'} / 样本外 ${val ?? '—'}">${val == null ? '—' : val.toFixed(2)}</div>`;
      }
    }
    $('#heatmap').innerHTML = hm;

    const cost = v.cost || {};
    $('#costTable tbody').innerHTML = Object.keys(cost).sort((a, b) => +a - +b).map(k => {
      const c = cost[k];
      return `<tr><td>${(+k * 10000).toFixed(0)} bp</td><td>${pct(c.full_median_cagr)}</td><td>${pct(c.oos_median_cagr)}</td></tr>`;
    }).join('');

    const x0 = (v.indices || [])[0];
    if (x0 && x0.random) {
      const r = x0.random, f = x0.full;
      $('#randomNote').textContent = `随机入场对照（${x0.name}，相同交易次数与持仓天数分布）：策略年化 ${pct(f.cagr)}、最大回撤 ${pct(f.maxdd)}；随机入场年化中位 ${pct(r.cagr_med)}（5–95%：${pct(r.cagr_p5)} ~ ${pct(r.cagr_p95)}），回撤中位 ${pct(r.dd_med)}。收益略高于随机，回撤显著更低。`;
    }

    $('#portfolioRow').innerHTML = [
      kpiCard('组合年化', pct(ps.cagr), '2020–2026', ps.cagr >= 0 ? 'up' : 'dn'),
      kpiCard('组合回撤', pct(ps.maxdd), '买入持有 ' + pct(pb.maxdd), 'dn'),
      kpiCard('组合夏普', num(ps.sharpe), '日频，无风险利率 0'),
      kpiCard('买入持有年化', pct(pb.cagr), '同期等权'),
      kpiCard('买入持有回撤', pct(pb.maxdd), '同期等权', 'dn'),
      kpiCard('夏普 95% CI', p.sharpe_ci ? `${num(p.sharpe_ci[1], 2)}` : '—', p.sharpe_ci ? `${num(p.sharpe_ci[0], 2)} ~ ${num(p.sharpe_ci[2], 2)}` : '—')
    ].join('');
  }





  init();
})();
