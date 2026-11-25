(function(){
  const D = window.DATA;
  if (!D) {
    document.body.innerHTML = '<div style="padding:40px;font:14px sans-serif">数据未加载。</div>';
    return;
  }
  // Charts must never block the text report. If ECharts fails to load (CDN
  // blocked, slow edge response), render the full narrative/tables with a
  // no-op chart shim and leave the chart canvases empty.
  if (!window.echarts) {
    const noop = () => {};
    window.echarts = {
      __shim: true,
      init: () => ({setOption: noop, resize: noop, on: noop, off: noop, dispose: noop,
        getOption: () => ({}), showLoading: noop, hideLoading: noop}),
      graphic: {LinearGradient: function(){}},
      registerTheme: noop,
    };
  }
  const fmt = (v, d=1) => {
    v = Number(v);
    const body = Math.abs(v).toLocaleString('zh-CN', {minimumFractionDigits:d, maximumFractionDigits:d});
    return (v > 0 ? '+' : '') + (v < 0 ? '-' : '') + body;
  };
  const cls = v => v >= 0 ? 'up' : 'down';
  const el = id => document.getElementById(id);

  // ---------- narrative ----------
  function renderNarrative(){
    const N = D.narrative || {};
    document.title = `盘面说明 · ${D.date} · 资金面`;
    el('hero-title').innerHTML = N.hero_title || '盘面说明';
    el('hero-dek').innerHTML = N.hero_dek || '';
    el('lead-grid').innerHTML = (N.lead_cards || []).map(c=>`
      <article class="lead-card">
        <div class="kicker">${c.kicker}</div>
        <h3>${c.title}</h3>
        <p>${c.body}</p>
      </article>`).join('');
    el('signal-grid').innerHTML = (N.signals || []).map(s=>`
      <div class="signal ${s.cls}">
        <span class="badge">${s.status}</span>
        <span class="st">${s.kicker}</span>
        <b>${s.title}</b>
        <p>${s.body}</p>
      </div>`).join('');
    if (el('signal-title')) {
      const okCount = (N.signals || []).filter(s=>s.cls==='ok').length;
      el('signal-title').textContent = `大资金建仓判断：四个信号，目前 ${okCount} 个成立`;
    }
    const notes = {
      'reversal-note':'reversal_note', 'flows-note':'flows_note', 'etf-note':'etf_note',
      'etf-decomp-note':'etf_decomp_note', 'margin-desc':'margin_desc', 'active-desc':'active_desc',
      'etf-desc':'etf_desc', 'signal-note':'signal_note', 'zt-note':'zt_note', 'margin-note':'margin_note',
      'conclusion':'conclusion', 'industry-note':'industry_note', 'scatter-note':'scatter_note',
      'concept-note':'concept_note', 'stock-note':'stock_note', 'topin-note':'topin_note',
      'divergence-note':'divergence_note', 'lhb-note':'lhb_note', 'topout-note':'topout_note',
      'refill-note':'refill_note', 'stock-quality-note':'stock_quality_note'
    };
    for (const [id, key] of Object.entries(notes)) {
      if (el(id)) el(id).innerHTML = N[key] || '';
    }
    if (el('etf-date')) el('etf-date').textContent = D.etf.date;
    if (el('lhb-date')) el('lhb-date').textContent = D.lhb.date || '待披露';
    const lhbToday = D.lhb.date && D.lhb.date === D.date;
    if (el('lhb-title')) el('lhb-title').textContent = D.lhb.date
      ? `龙虎榜机构席位：${lhbToday ? '今日已披露' : '最近披露日 ' + D.lhb.date}`
      : '龙虎榜机构席位：待披露';
    if (el('lhb-sub')) el('lhb-sub').textContent = lhbToday
      ? '今日龙虎榜已披露；看机构净买/净卖'
      : '今日龙虎榜 17:00 后披露；先看最近一日的机构净买/净卖';
    if (el('zt-title')) {
      const z = D.zt || {};
      el('zt-title').textContent = `涨停 ${z.count ?? 0} 只，最高 ${z.max_height ?? 0} 板`;
      el('zt-sub').textContent = `东财涨停池；首板 ${z.first ?? 0}、2 板 ${z.second ?? 0}、3 板 ${z.third ?? 0}、5 板+ ${z.fifth_plus ?? 0}；炸板 ${z.broken ?? 0}（${z.break_rate ?? 0}%）`;
    }
    if (el('margin-title')) {
      const m = D.margin || {};
      const s = m.series || [];
      const n = Math.max(0, s.length - 1);
      const chg = s.length ? s[s.length - 1].total - s[0].total : 0;
      const amt = Math.abs(chg).toLocaleString('zh-CN', { maximumFractionDigits: 0 });
      el('margin-title').textContent = `融资余额：${n} 个交易日${chg >= 0 ? '增' : '缩'}了 ${amt} 亿`;
      el('margin-sub').textContent = `沪深两市融资余额合计；T+1 披露，最新 ${m.date || '—'}`;
    }
    if (el('caveat-etf-date')) el('caveat-etf-date').textContent = D.etf.date;
    if (el('caveat-margin-date')) el('caveat-margin-date').textContent = D.margin.date;
    if (el('footer-date')) el('footer-date').textContent = D.date + ' · ' + D.weekday;
    if (el('opp-margin')) el('opp-margin').textContent = D.margin.total_fin.toLocaleString('zh-CN',{maximumFractionDigits:1}) + ' 亿';
    if (el('opp-active')) el('opp-active').textContent = fmt(D.flows.ths.total,1) + ' 亿';
    if (el('opp-etf')) el('opp-etf').textContent = fmt(D.etf.d5,1) + ' 亿';
  }

  // ---------- hero ----------
  el('hero-meta').textContent = `${D.date} · ${D.weekday} · 收盘后`;
  el('hero-chips').innerHTML = `
    <span class="chip">上证 <strong class="${cls(D.indices[0].change_pct)}">${D.indices[0].price.toFixed(2)}</strong><span class="${cls(D.indices[0].change_pct)}">${fmt(D.indices[0].change_pct,2)}%</span></span>
    <span class="chip">创业板 <strong class="${cls(D.indices[2].change_pct)}">${D.indices[2].price.toFixed(2)}</strong><span class="${cls(D.indices[2].change_pct)}">${fmt(D.indices[2].change_pct,2)}%</span></span>
    <span class="chip">成交额 <strong>${D.turnover.total.toLocaleString('zh-CN',{maximumFractionDigits:0})} 亿</strong></span>
    <span class="chip">涨停 <strong class="up">${D.breadth.limit_up} 家</strong><span class="down">跌停 ${D.breadth.limit_down} 家</span></span>`;

  // ---------- KPI ----------
  const kpis = [
    ['上证指数', D.indices[0].price.toFixed(2), fmt(D.indices[0].change_pct,2)+'%', cls(D.indices[0].change_pct)],
    ['创业板指', D.indices[2].price.toFixed(2), fmt(D.indices[2].change_pct,2)+'%', cls(D.indices[2].change_pct)],
    ['两市成交额', D.turnover.total.toLocaleString('zh-CN',{maximumFractionDigits:0})+' 亿', '含北证 '+D.turnover.bj.toFixed(0)+' 亿', ''],
    ['上涨 / 下跌', D.breadth.up+' / '+D.breadth.down, '平盘 '+D.breadth.flat+'，停牌 '+D.breadth.suspended, 'up'],
    ['涨停 / 跌停', D.breadth.limit_up+' / '+D.breadth.limit_down, '真实 '+D.breadth.real_limit_up+' / '+D.breadth.real_limit_down, 'up'],
    ['沪市主力', D.flows.em_sh.main_yi ? fmt(D.flows.em_sh.main_yi,1)+' 亿' : '未取到', D.flows.em_sh.super_yi ? '超大单 '+fmt(D.flows.em_sh.super_yi,1)+' 亿' : '接口限流，见口径说明', 'up'],
    ['全 A 超大单', fmt(D.flows.sina.super_total,1)+' 亿', '沪 '+D.flows.sina.sh.toFixed(0)+' / 深 '+D.flows.sina.sz.toFixed(0), 'up'],
    ['ETF 5 日', fmt(D.etf.d5,1)+' 亿', '最新 '+D.etf.date+' 单日 '+fmt(D.etf.net,1), 'up'],
  ];
  el('kpis').innerHTML = kpis.map(k=>`
    <div class="kpi"><div class="label">${k[0]}</div>
      <div class="value ${k[3]}">${k[1]}</div>
      <div class="sub">${k[2]}</div></div>`).join('');

  // ---------- reversal ----------
  el('reversal').innerHTML = D.indices.map(i=>{
    const lowPct = (i.low / i.prev_close - 1) * 100;
    const highPct = (i.high / i.prev_close - 1) * 100;
    const pos = Math.max(2, Math.min(98, i.close_pos));
    return `<div class="rev-row">
      <div class="rev-name">${i.name}</div>
      <div class="rev-px">${i.price.toFixed(2)}<small class="${cls(i.change_pct)}">${fmt(i.change_pct,2)}%</small></div>
      <div class="rev-track">
        <div class="rev-fill" style="width:${pos}%"></div>
        <div class="rev-dot" style="left:${pos}%"></div>
        <span class="rev-lohi lo">低 ${lowPct.toFixed(2)}%</span>
        <span class="rev-lohi hi">高 ${highPct.toFixed(2)}%</span>
      </div>
      <div class="rev-note">从低点 <strong>+${i.reversal_from_low.toFixed(2)}%</strong> · 收盘位置 ${i.close_pos.toFixed(0)}% · 振幅 ${i.amplitude.toFixed(2)}%</div>
    </div>`;
  }).join('');

  // ---------- charts registry ----------
  const charts = [];
  const pendingCharts = [];
  const inited = {};
  const noop = () => {};
  function mk(id){
    const node = el(id);
    if (window.echarts && !window.echarts.__shim) {
      const c = window.echarts.init(node, null, {renderer:'canvas'});
      charts.push(c);
      return c;
    }
    // ECharts is loaded asynchronously. Queue the option now and replay it when
    // the real library arrives; the page never blocks on the ~1MB script.
    const lazy = {__lazy:{node, options:[]},
      setOption(opt){ this.__lazy.options.push(opt); },
      resize: noop, on: noop, off: noop, dispose: noop, getOption: () => ({}),
      showLoading: noop, hideLoading: noop};
    pendingCharts.push(lazy);
    return lazy;
  }
  window.__pulseOnReady = function(){
    if (!window.echarts || window.echarts.__shim) return;
    pendingCharts.forEach(p => {
      const c = window.echarts.init(p.__lazy.node, null, {renderer:'canvas'});
      p.__lazy.options.forEach(o => c.setOption(o));
      charts.push(c);
    });
    pendingCharts.length = 0;
    charts.forEach(c => c.resize());
  };
  if (window.echarts && !window.echarts.__shim) window.__pulseOnReady();

  const C = {red:'#c33a32', red2:'#e06055', green:'#1f7a5c', green2:'#3a9b78', gold:'#b0832f', blue:'#39658c', ink:'#1b1e26', muted:'#6e707a'};
  const axis = {axisLine:{lineStyle:{color:'rgba(27,30,38,.18)'}}, axisTick:{show:false}, axisLabel:{color:C.muted, fontSize:11}, splitLine:{lineStyle:{color:'rgba(27,30,38,.07)'}}};
  const tip = {backgroundColor:'rgba(27,30,38,.92)', borderWidth:0, textStyle:{color:'#fff', fontSize:12}, padding:[7,10]};

  // ---------- flows ----------
  function initFlows(){
    const c = mk('chart-flows');
    const rows = [
      {name:'同花顺 · 全A全单', v:D.flows.ths.total},
      {name:'新浪 · 全A超大单', v:D.flows.sina.super_total},
      {name:'东财 · 沪市超大单', v:D.flows.em_sh.super_yi},
      {name:'东财 · 沪市主力', v:D.flows.em_sh.main_yi},
    ].filter(r=>Math.abs(r.v) > 0.001);
    c.setOption({
      grid:{left:118,right:66,top:12,bottom:24},
      tooltip:{...tip, trigger:'axis', axisPointer:{type:'shadow'}, formatter:s=>`${s[0].name}<br><b>${fmt(s[0].value,2)} 亿</b>`},
      xAxis:{type:'value', ...axis, axisLabel:{...axis.axisLabel, formatter:'{value}'}},
      yAxis:{type:'category', data:rows.map(r=>r.name), ...axis, splitLine:{show:false}, axisLabel:{...axis.axisLabel, color:C.ink, fontSize:12}},
      series:[{
        type:'bar', data:rows.map(r=>r.v), barWidth:18,
        itemStyle:{borderRadius:[0,6,6,0], color:p=>p.value>=0?C.red:C.green},
        label:{show:true, position:'right', formatter:p=>fmt(p.value,1), color:C.ink, fontWeight:650, fontSize:12}
      }]
    });
  }

  // ---------- ETF ----------
  function initEtf(){
    const c = mk('chart-etf');
    const seq = D.etf.seq;
    c.setOption({
      grid:{left:44,right:16,top:24,bottom:28},
      tooltip:{...tip, trigger:'axis', formatter:s=>`${s[0].name}<br>净申赎 <b>${fmt(s[0].value,2)} 亿</b>`},
      xAxis:{type:'category', data:seq.map(x=>x.date.slice(5)), ...axis, axisLabel:{...axis.axisLabel, interval:0, rotate:0}},
      yAxis:{type:'value', ...axis, axisLabel:{...axis.axisLabel, formatter:'{value}'}},
      series:[{
        type:'bar', data:seq.map(x=>x.net), barWidth:'52%',
        itemStyle:{borderRadius:[4,4,0,0], color:p=>p.value>=0?C.red:C.green},
        label:{show:true, position:'top', formatter:p=>Math.abs(p.value)>=100?fmt(p.value,0):'', color:C.ink, fontSize:10},
        markLine:{silent:true, symbol:'none', lineStyle:{color:'rgba(27,30,38,.25)', type:'dashed'}, data:[{yAxis:0}]}
      }]
    });
  }

  // ---------- ETF decomposition ----------
  function initEtfDecomp(){
    const c = mk('chart-etf-decomp');
    const rows = (D.etf.decomp && D.etf.decomp.buckets || []).slice().sort((a,b)=>a.net-b.net);
    const colorMap = {red:C.red, red2:C.red2, blue:C.blue, green:C.green, gold:C.gold, muted:C.muted};
    c.setOption({
      grid:{left:96,right:88,top:18,bottom:26},
      tooltip:{...tip, trigger:'axis', axisPointer:{type:'shadow'}, formatter:s=>{
        const r = rows[s[0].dataIndex];
        return `${r.name}（${r.style}）<br>5 日净申赎 <b>${fmt(r.net,2)} 亿</b><br>占 15 只宽基合计 <b>${fmt(r.share,1)}%</b>`;
      }},
      xAxis:{type:'value', ...axis, axisLabel:{...axis.axisLabel, formatter:'{value}'}},
      yAxis:{type:'category', data:rows.map(r=>r.name), ...axis, splitLine:{show:false}, axisLabel:{...axis.axisLabel, color:C.ink, fontSize:11}},
      series:[{
        type:'bar', data:rows.map(r=>({value:r.net, itemStyle:{color:colorMap[r.tone]||C.muted}})), barWidth:17,
        itemStyle:{borderRadius:[0,6,6,0]},
        label:{show:true, position:'right', formatter:p=>{
          const r = rows[p.dataIndex];
          return `${fmt(r.net,1)} 亿 · ${r.share.toFixed(0)}%`;
        }, color:C.ink, fontSize:11, fontWeight:650},
        markLine:{silent:true, symbol:'none', label:{show:false}, lineStyle:{color:'rgba(27,30,38,.25)', type:'dashed'}, data:[{xAxis:0}]}
      }]
    });
  }

  // ---------- industry refill ----------
  function initRefill(){
    const c = mk('chart-refill');
    const rows = (D.flow_quality && D.flow_quality.industries || []).slice(0,12).sort((a,b)=>a.ratio-b.ratio);
    const maxRatio = Math.max(120, ...rows.map(r=>r.ratio||0));
    c.setOption({
      grid:{left:96,right:118,top:14,bottom:26},
      tooltip:{...tip, trigger:'axis', axisPointer:{type:'shadow'}, formatter:s=>{
        const r = rows[s[0].dataIndex];
        return `${r.name}<br>今日 <b>${fmt(r.net,2)} 亿</b> · 前4日 ${fmt(r.prior4,2)} 亿<br>回补比例 <b>${r.ratio.toFixed(0)}%</b> · ${r.label}`;
      }},
      xAxis:{type:'value', max:Math.ceil(maxRatio*1.1), ...axis, axisLabel:{...axis.axisLabel, formatter:'{value}%'}},
      yAxis:{type:'category', data:rows.map(r=>r.name), ...axis, splitLine:{show:false}, axisLabel:{...axis.axisLabel, color:C.ink, fontSize:11}},
      series:[{
        type:'bar', data:rows.map(r=>({value:r.ratio, itemStyle:{color:r.ratio>=100?C.red:r.ratio>=50?C.gold:C.muted}})), barWidth:14,
        itemStyle:{borderRadius:[0,5,5,0]},
        label:{show:true, position:'right', formatter:p=>{
          const r = rows[p.dataIndex];
          return `+${r.net.toFixed(1)} 亿 · ${r.ratio.toFixed(0)}%`;
        }, color:C.ink, fontSize:10, fontWeight:600},
        markLine:{silent:true, symbol:'none', label:{show:true, color:C.muted, fontSize:9}, lineStyle:{color:'rgba(176,131,47,.4)', type:'dashed'}, data:[{xAxis:50,label:{formatter:'50%'}},{xAxis:100,label:{formatter:'100%'}}]}
      }]
    });
  }

  // ---------- industry ----------
  let indMetric = 'net';
  function industryOption(metric){
    const list = D.industries.slice().sort((a,b)=>b[metric]-a[metric]);
    const top = list.slice(0,10), bottom = list.slice(-6);
    const rows = [...top, ...bottom].reverse();
    return {
      grid:{left:92,right:74,top:14,bottom:24},
      tooltip:{...tip, trigger:'axis', axisPointer:{type:'shadow'}, formatter:s=>{
        const r = rows[s[0].dataIndex];
        return `${r.name}<br>今日 <b>${fmt(r.net,2)} 亿</b><br>5日 ${fmt(r.net5,2)} 亿 · 10日 ${fmt(r.net10,2)} 亿<br>涨跌 ${fmt(r.chg,2)}% · 成交 ${r.amount.toFixed(0)} 亿`;
      }},
      xAxis:{type:'value', ...axis, axisLabel:{...axis.axisLabel, formatter:'{value}'}},
      yAxis:{type:'category', data:rows.map(r=>r.name), ...axis, splitLine:{show:false}, axisLabel:{...axis.axisLabel, color:C.ink, fontSize:11}},
      series:[{
        type:'bar', data:rows.map(r=>({value:r[metric], itemStyle:{color:r[metric]>=0?C.red:C.green}})), barWidth:14,
        itemStyle:{borderRadius:[0,5,5,0]},
        label:{show:true, position:'right', formatter:p=>fmt(p.value,1), color:C.ink, fontSize:10, fontWeight:600}
      }]
    };
  }
  function initIndustry(){
    const c = mk('chart-industry');
    c.setOption(industryOption(indMetric));
    document.querySelectorAll('[data-ind]').forEach(btn=>{
      btn.addEventListener('click',()=>{
        document.querySelectorAll('[data-ind]').forEach(b=>b.classList.remove('active'));
        btn.classList.add('active');
        indMetric = btn.dataset.ind;
        c.setOption(industryOption(indMetric), {notMerge:true});
      });
    });
  }

  // ---------- scatter ----------
  function initScatter(){
    const c = mk('chart-scatter');
    const key = ['通信设备','半导体','元件','银行','保险','白酒'];
    const data = D.industries.map(r=>({
      name:r.name, value:[r.net5, r.net, r.amount], chg:r.chg, net5:r.net5, net:r.net,
      symbolSize: Math.max(7, Math.min(30, Math.sqrt(Math.max(r.amount,1))*1.05))
    }));
    c.setOption({
      grid:{left:56,right:26,top:30,bottom:46},
      tooltip:{...tip, formatter:p=>`${p.data.name}<br>5日 <b>${fmt(p.data.net5,2)} 亿</b> · 今日 <b>${fmt(p.data.net,2)} 亿</b><br>今日涨跌 ${fmt(p.data.chg,2)}% · 成交 ${p.data.value[2].toFixed(0)} 亿`},
      xAxis:{type:'value', ...axis, name:'5日净额（亿）', nameLocation:'middle', nameGap:28, nameTextStyle:{color:C.muted,fontSize:11}},
      yAxis:{type:'value', ...axis, name:'今日净额（亿）', nameLocation:'middle', nameGap:38, nameTextStyle:{color:C.muted,fontSize:11}},
      series:[{
        type:'scatter', data:data,
        itemStyle:{color:p=>{
          const x=p.data.value[0], y=p.data.value[1];
          if (x>=0 && y>=0) return 'rgba(195,58,50,.78)';
          if (x<0 && y>=0) return 'rgba(176,131,47,.85)';
          if (x>=0 && y<0) return 'rgba(31,122,92,.72)';
          return 'rgba(110,112,122,.55)';
        }, borderColor:'rgba(255,255,255,.85)', borderWidth:1},
        label:{show:true, formatter:p=>key.includes(p.data.name)?p.data.name:'', position:'top', color:C.ink, fontSize:10, fontWeight:650,
          backgroundColor:'rgba(255,255,255,.72)', padding:[1,3], borderRadius:3},
        labelLayout:{hideOverlap:true},
        emphasis:{scale:1.15},
        markLine:{silent:true, symbol:'none', label:{show:false}, lineStyle:{color:'rgba(27,30,38,.22)', width:1}, data:[{xAxis:0},{yAxis:0}]}
      }],
      graphic:[
        {type:'text', left:'12%', top:26, style:{text:'5日流出 · 今日回补', fill:'#b0832f', fontSize:11, fontWeight:650}},
        {type:'text', right:'6%', top:26, style:{text:'5日 + 今日双流入', fill:'#c33a32', fontSize:11, fontWeight:650}},
        {type:'text', left:'12%', bottom:14, style:{text:'双流出', fill:'#6e707a', fontSize:11, fontWeight:650}},
        {type:'text', right:'6%', bottom:14, style:{text:'5日流入 · 今日流出', fill:'#1f7a5c', fontSize:11, fontWeight:650}}
      ]
    });
  }

  // ---------- concepts ----------
  function initConcept(){
    const c = mk('chart-concept');
    const exclude = ['融资融券','深股通','沪股通','2026中报预增','人民币贬值受益','证金持股','高股息精选','同花顺漂亮100','同花顺中特估100','超级品牌'];
    const list = D.concepts.filter(x=>!exclude.includes(x.name)).sort((a,b)=>b.net-a.net).slice(0,12).reverse();
    c.setOption({
      grid:{left:110,right:60,top:12,bottom:20},
      tooltip:{...tip, trigger:'axis', axisPointer:{type:'shadow'}, formatter:s=>{
        const r=list[s[0].dataIndex]; return `${r.name}<br>今日 <b>${fmt(r.net,2)} 亿</b><br>5日 ${fmt(r.net5,2)} 亿 · 成分 ${r.stocks} 只`;
      }},
      xAxis:{type:'value', ...axis},
      yAxis:{type:'category', data:list.map(x=>x.name), ...axis, splitLine:{show:false}, axisLabel:{...axis.axisLabel, color:C.ink, fontSize:11}},
      series:[{type:'bar', data:list.map(x=>({value:x.net,itemStyle:{color:x.net>=0?C.red:C.green}})), barWidth:13,
        itemStyle:{borderRadius:[0,5,5,0]},
        label:{show:true, position:'right', formatter:p=>fmt(p.value,1), color:C.ink, fontSize:10, fontWeight:600}}]
    });
  }

  // ---------- stocks ----------
  function initStocks(){
    const c = mk('chart-stocks');
    const list = D.stocks.featured.slice().reverse();
    c.setOption({
      grid:{left:96,right:64,top:28,bottom:24},
      legend:{top:0, right:0, itemWidth:10, itemHeight:10, textStyle:{color:C.muted,fontSize:11}, data:['超大单净额','全单净额']},
      tooltip:{...tip, trigger:'axis', axisPointer:{type:'shadow'}, formatter:s=>{
        const r=list[s[0].dataIndex]; return `${r.name} <span style="opacity:.7">${r.code}</span><br>涨跌 ${fmt(r.chg,2)}% · 成交 ${r.amount.toFixed(1)} 亿<br>超大单 <b>${fmt(r.super,2)} 亿</b><br>全单 <b>${fmt(r.net,2)} 亿</b><br>5日 ${fmt(r.d5,2)} 亿`;
      }},
      xAxis:{type:'value', ...axis},
      yAxis:{type:'category', data:list.map(x=>x.name), ...axis, splitLine:{show:false}, axisLabel:{...axis.axisLabel, color:C.ink, fontSize:11}},
      series:[
        {name:'超大单净额', type:'bar', data:list.map(x=>x.super), barWidth:9, itemStyle:{color:C.red, borderRadius:[0,4,4,0]},
          label:{show:false}},
        {name:'全单净额', type:'bar', data:list.map(x=>x.net), barWidth:9, itemStyle:{color:C.gold, borderRadius:[0,4,4,0]},
          label:{show:true, position:'right', formatter:p=>fmt(p.value,1), color:C.ink, fontSize:10, fontWeight:600}}
      ]
    });
  }

  // ---------- zt donut ----------
  function initZt(){
    const c = mk('chart-zt');
    const ladder = D.zt.ladder || {};
    const data = [
      {name:`首板 ${Number(ladder['1']||0)}`, value:Number(ladder['1']||0), itemStyle:{color:'#e6b8b3'}},
      {name:`2板 ${Number(ladder['2']||0)}`, value:Number(ladder['2']||0), itemStyle:{color:'#d9867e'}},
      {name:`3板 ${Number(ladder['3']||0)}`, value:Number(ladder['3']||0), itemStyle:{color:'#c33a32'}},
      {name:`4板 ${Number(ladder['4']||0)}`, value:Number(ladder['4']||0), itemStyle:{color:'#a52d27'}},
      {name:`5板+ ${Number(D.zt.fifth_plus||0)}`, value:Number(D.zt.fifth_plus||0), itemStyle:{color:'#7d1f1a'}}
    ].filter(x=>x.value>0);
    c.setOption({
      tooltip:{...tip, formatter:p=>`${p.name}：<b>${p.value} 只</b>（${p.percent}%）`},
      title:{text:String(D.zt.count), subtext:`涨停 / 最高 ${D.zt.max_height} 板`, left:'center', top:'36%', textStyle:{fontSize:26,fontWeight:750,color:C.ink}, subtextStyle:{fontSize:11,color:C.muted}},
      legend:{bottom:0, left:'center', itemWidth:8, itemHeight:8, itemGap:10, textStyle:{fontSize:10,color:C.muted}},
      series:[{type:'pie', radius:['44%','66%'], center:['50%','44%'], avoidLabelOverlap:true,
        itemStyle:{borderColor:'#fff',borderWidth:2}, label:{show:false}, labelLine:{show:false},
        data:data}]
    });
  }

  // ---------- margin ----------
  function initMargin(){
    const c = mk('chart-margin');
    const s = D.margin.series;
    const vals = s.map(x=>x.total);
    const min = Math.floor((Math.min(...vals) - 300) / 500) * 500;
    const max = Math.ceil((Math.max(...vals) + 300) / 500) * 500;
    c.setOption({
      grid:{left:56,right:18,top:22,bottom:26},
      tooltip:{...tip, trigger:'axis', formatter:x=>`${x[0].name}<br>融资余额 <b>${Number(x[0].value).toLocaleString('zh-CN',{maximumFractionDigits:0})} 亿</b>`},
      xAxis:{type:'category', data:s.map(x=>x.date.slice(5)), ...axis, axisLabel:{...axis.axisLabel, interval:0, fontSize:10}},
      yAxis:{type:'value', min:min, max:max, ...axis, axisLabel:{...axis.axisLabel, formatter:v=>v.toLocaleString('zh-CN')}},
      series:[{type:'line', data:s.map(x=>x.total), smooth:true, symbolSize:5,
        lineStyle:{color:C.green, width:2.5}, itemStyle:{color:C.green},
        areaStyle:{color:{type:'linear',x:0,y:0,x2:0,y2:1,colorStops:[{offset:0,color:'rgba(31,122,92,.18)'},{offset:1,color:'rgba(31,122,92,.02)'}]}},
        markPoint:{symbol:'pin', symbolSize:44, data:[{coord:[s.length-1, s[s.length-1].total], value:Math.round(s[s.length-1].total).toLocaleString('zh-CN')}], itemStyle:{color:C.green}, label:{show:false}, symbolOffset:[0,-14]}
      }]
    });
  }

  // ---------- tables ----------
  function qcls(label){
    if (!label) return 'muted';
    if (label.includes('新钱') || label.includes('加速')) return 'new';
    if (label.includes('强回补')) return 'strong';
    if (label.includes('弱回补') || label.includes('衰减')) return 'weak';
    if (label.includes('持续')) return 'steady';
    if (label.includes('转出') || label.includes('流出')) return 'dist';
    return 'muted';
  }
  function qualityBadge(r){
    if (!r || !r.label) return '<span class="state muted">—</span>';
    const ratio = r.ratio == null ? '' : ` ${r.ratio.toFixed(0)}%`;
    return `<span class="state ${qcls(r.label)}">${r.label}${ratio}</span>`;
  }

  function renderStockQuality(mode='new_money'){
    const rows = (D.stocks && D.stocks[mode] || []).slice(0,12);
    const html = `<thead><tr><th>#</th><th>股票</th><th>今日净额</th><th>前4日</th><th>比例</th><th>5日净额</th><th>类型</th></tr></thead><tbody>` +
      rows.map((s,i)=>`<tr>
        <td class="num">${i+1}</td>
        <td class="name"><strong>${s.name}</strong><br><span style="color:#8a8c94;font-size:10px">${s.code}${s.sector?` · ${s.sector}`:''}</span></td>
        <td class="num ${cls(s.net)}">${fmt(s.net,2)}</td>
        <td class="num ${cls(s.prior4)}">${fmt(s.prior4,2)}</td>
        <td class="num">${s.ratio==null?'—':fmt(s.ratio,0)+'%'}</td>
        <td class="num ${cls(s.d5)}">${fmt(s.d5,2)}</td>
        <td>${qualityBadge(s)}</td>
      </tr>`).join('') + '</tbody>';
    el('table-stock-quality').innerHTML = html;
  }

  function renderTopIn(){
    const rows = D.stocks.top_in.slice(0,12);
    const html = `<thead><tr><th>#</th><th>股票</th><th>涨跌</th><th>成交额</th><th>全单净额</th><th>超大单</th><th>5日净额</th><th>质量</th></tr></thead><tbody>` +
      rows.map((s,i)=>`<tr>
        <td class="num">${i+1}</td>
        <td class="name"><strong>${s.name}</strong><br><span style="color:#8a8c94;font-size:10px">${s.code}${s.sector?` · ${s.sector}`:''}</span></td>
        <td class="num ${cls(s.chg)}">${fmt(s.chg,2)}%</td>
        <td class="num">${s.amount.toFixed(1)} 亿</td>
        <td class="num ${cls(s.net)}">${fmt(s.net,2)}</td>
        <td class="num ${cls(s.super)}">${fmt(s.super,2)}</td>
        <td class="num ${cls(s.d5)}">${fmt(s.d5,2)}</td>
        <td>${qualityBadge(s)}</td>
      </tr>`).join('') + '</tbody>';
    el('table-top-in').innerHTML = html;
  }

  function renderTopOut(){
    const rows = D.stocks.top_out.slice(0,12);
    const html = `<thead><tr><th>#</th><th>股票</th><th>涨跌</th><th>成交额</th><th>全单净额</th><th>超大单</th><th>5日净额</th></tr></thead><tbody>` +
      rows.map((s,i)=>`<tr>
        <td class="num">${i+1}</td>
        <td class="name"><strong>${s.name}</strong><br><span style="color:#8a8c94;font-size:10px">${s.code}${s.sector?` · ${s.sector}`:''}</span></td>
        <td class="num ${cls(s.chg)}">${fmt(s.chg,2)}%</td>
        <td class="num">${s.amount.toFixed(1)} 亿</td>
        <td class="num ${cls(s.net)}">${fmt(s.net,2)}</td>
        <td class="num ${cls(s.super)}">${fmt(s.super,2)}</td>
        <td class="num ${cls(s.d5)}">${fmt(s.d5,2)}</td>
      </tr>`).join('') + '</tbody>';
    el('table-top-out').innerHTML = html;
  }

  function renderDivergence(){
    const rows = D.divergence.big_buy_sell.slice(0,10);
    const html = `<thead><tr><th>股票</th><th>涨跌</th><th>全单净额</th><th>超大单</th><th>解读</th></tr></thead><tbody>` +
      rows.map(s=>`<tr>
        <td class="name"><strong>${s.name}</strong><br><span style="color:#8a8c94;font-size:10px">${s.code}</span></td>
        <td class="num ${cls(s.chg)}">${fmt(s.chg,2)}%</td>
        <td class="num ${cls(s.net)}">${fmt(s.net,2)}</td>
        <td class="num ${cls(s.super)}">${fmt(s.super,2)}</td>
        <td><span class="tag">大单接 · 中小单出</span></td>
      </tr>`).join('') + '</tbody>';
    el('table-divergence').innerHTML = html;
  }

  function renderLhb(){
    const buys = D.lhb.top_buy.slice(0,6);
    const sells = D.lhb.top_sell.slice(0,5);
    const row = (s, sign) => `<tr>
      <td class="name"><strong>${s.name}</strong><br><span style="color:#8a8c94;font-size:10px">${s.code}</span></td>
      <td class="num ${sign>0?'pos':'neg'}">${fmt(s.net,2)} 亿</td>
      <td class="num">${s.buyers} / ${s.sellers}</td>
      <td style="white-space:normal;color:#666;font-size:11px;min-width:180px">${s.reason}</td>
    </tr>`;
    el('table-lhb').innerHTML = `<thead><tr><th>股票</th><th>机构净额</th><th>买方 / 卖方</th><th>上榜原因</th></tr></thead><tbody>` +
      buys.map(s=>row(s,1)).join('') + sells.map(s=>row(s,-1)).join('') + '</tbody>';
  }

  function renderSectors(){
    const keys = ['通信设备','半导体','元件','银行','保险','白酒','电力','自动化设备','医疗服务','影视院线','游戏','文化传媒','消费电子','光学光电子','汽车零部件','电池','贵金属','工程机械'];
    const rows = D.industries.filter(x=>keys.includes(x.name)).sort((a,b)=>b.net-a.net);
    const html = `<thead><tr><th>行业</th><th>今日涨跌</th><th>今日净额</th><th>5日净额</th><th>10日净额</th><th>成交额</th><th>领涨股</th><th>状态</th></tr></thead><tbody>` +
      rows.map(r=>{
        let state = '—', stateCls = 'out';
        if (r.net>0 && r.net5>0) { state = '双流入'; stateCls = 'buy'; }
        else if (r.net>0 && r.net5<0) { state = '5日流出·今日回补'; stateCls = 'refill'; }
        else if (r.net<0 && r.net5>0) { state = '5日流入·今日流出'; stateCls = 'sell'; }
        else { state = '双流出'; stateCls = 'out'; }
        return `<tr>
          <td class="name"><strong>${r.name}</strong></td>
          <td class="num ${cls(r.chg)}">${fmt(r.chg,2)}%</td>
          <td class="num ${cls(r.net)}">${fmt(r.net,2)}</td>
          <td class="num ${cls(r.net5)}">${fmt(r.net5,2)}</td>
          <td class="num ${cls(r.net10)}">${fmt(r.net10,2)}</td>
          <td class="num">${r.amount.toFixed(0)} 亿</td>
          <td>${r.leader||'—'}</td>
          <td><span class="state ${stateCls}">${state}</span>${r.ratio!=null?`<br><span style="font-size:10px;color:#8a8c94">${r.ratio.toFixed(0)}%</span>`:''}</td>
        </tr>`;
      }).join('') + '</tbody>';
    el('table-sectors').innerHTML = html;
  }

  // ---------- init ----------
  function initOverview(){
    initFlows(); initEtf(); initEtfDecomp(); initZt(); initMargin();
  }
  function initFlowTab(){ initIndustry(); initRefill(); initScatter(); initConcept(); }
  function initStockTab(){ initStocks(); }

  renderNarrative();
  initOverview();
  renderTopIn(); renderTopOut(); renderDivergence(); renderLhb(); renderSectors(); renderStockQuality('new_money');
  document.querySelectorAll('[data-quality]').forEach(btn=>{
    btn.addEventListener('click',()=>{
      document.querySelectorAll('[data-quality]').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      renderStockQuality(btn.dataset.quality);
    });
  });

  function scrollToTabTop(panel){
    if (!panel || !panel.classList.contains('active')) return;
    const tabs = document.querySelector('.tabs');
    const tabsH = tabs ? tabs.offsetHeight : 0;
    const y = panel.getBoundingClientRect().top + window.pageYOffset - tabsH - 10;
    // Tab switching should land at the top of the selected panel. Disable the
    // global smooth-scroll only for this jump, so it doesn't animate past it.
    const root = document.documentElement;
    const oldBehavior = root.style.scrollBehavior;
    root.style.scrollBehavior = 'auto';
    window.scrollTo(0, Math.max(0, y));
    root.style.scrollBehavior = oldBehavior;
  }

  const tabMap = {overview:initOverview, flow:initFlowTab, stocks:initStockTab, method:()=>{}};
  document.querySelectorAll('.tab-btn').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const tab = btn.dataset.tab;
      const switched = !btn.classList.contains('active');
      document.querySelectorAll('.tab-btn').forEach(b=>b.classList.toggle('active', b===btn));
      document.querySelectorAll('.panel').forEach(p=>p.classList.toggle('active', p.id==='panel-'+tab));
      if(switched){
        requestAnimationFrame(()=>scrollToTabTop(document.getElementById('panel-'+tab)));
      }
      if(!inited[tab]){
        inited[tab] = true;
        setTimeout(()=>{ tabMap[tab] && tabMap[tab](); charts.forEach(c=>c.resize()); }, 30);
      } else {
        setTimeout(()=>charts.forEach(c=>c.resize()), 20);
      }
    });
  });
  inited.overview = true;

  window.addEventListener('resize', ()=>charts.forEach(c=>c.resize()));
  el('gen-time').textContent = (D.rendered_at || D.generated_at).replace('T',' ');
})();