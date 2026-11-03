import { finite, validateBars, simulate, maxDrawdown, drawdownEvents, eventStudy, mapEvent, debtPlan, valuations, aggregateBars, movingAverage } from './analysis.mjs';
import { abcScenario, fifthScenario, ABC_RATIOS, FIFTH_RATIOS } from './waves.mjs';
import { workspaceMode, workspaceCalculation, savedScenarioCalculation } from './workspace.mjs';
import * as storage from './storage.mjs';
import { escapeHTML as esc, download, csv, parseCSV, makeXLSX } from './export.mjs';
const $ = id => document.getElementById(id), $$ = s => [...document.querySelectorAll(s)];
const fmt = (n, d = 2) => finite(n) ? Number(n).toLocaleString('zh-CN',{ minimumFractionDigits:d, maximumFractionDigits:d }) : '—';
const pct = (n,d = 2) => finite(n) ? (n > 0 ? '+' : '') + fmt(n * 100,d) + '%' : '—';
const ratioText = n => finite(n) ? Number(n).toLocaleString('zh-CN',{maximumFractionDigits:6}) : '—';
const tone = n => n > 0 ? 'up' : n < 0 ? 'down' : '';
const money = n => finite(n) ? Math.abs(n) >= 10000 ? fmt(n/10000) + ' 万元' : fmt(n) + ' 元' : '—';
const dateText = v => v ? new Date(v).toLocaleString('zh-CN',{ timeZone:'Asia/Shanghai', hour12:false }) : '未知';
const today = () => new Intl.DateTimeFormat('sv-SE',{ timeZone:'Asia/Shanghai' }).format(new Date());
const currentYear = () => Number(today().slice(0,4));
const defaults = [{symbol:'300502.SZ',name:'新易盛'},{symbol:'300308.SZ',name:'中际旭创'},{symbol:'300394.SZ',name:'天孚通信'},{symbol:'601138.SH',name:'工业富联'},{symbol:'300476.SZ',name:'胜宏科技'}];
const simIds = ['reference-high','low','rebound','shares','cost','base','capital','profit'];
const waveIds = ['wave-high','wave-low','wave-b-ratio','wave-c-ratio','wave-third-start','wave-third-end','wave-fourth-low','wave-fifth-ratio','wave-show-c'];
const riskIds = ['cash','debt','debt-type','due','sell-price','sell-qty','fee','cushion','lot'];
const state = { stock:defaults[0], watch:[], quote:null, history:null, nominal:null, bars:[], tab:'overview', mode:'normal', period:'day', range:'all', generation:0, forecasts:[], scenarios:[], positions:[], events:[], selectedEvent:0, form:{}, autoHigh:true, waveMode:'abc', waveAutoHigh:true, waveAutoThird:true, autoBase:true, autoCapital:true, autoSell:true, settings:{}, study:null, chart:null, candles:null, marker:null, mappingChart:null, start:'', end:'', picking:false, picks:[], warnings:new Map(), busy:false };
let saveTimer, toastTimer, searchTimer, searchGeneration = 0;
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true,3200); }
function warn(key, message) { if (message) state.warnings.set(key,message); else state.warnings.delete(key); $('message').textContent = [...state.warnings.values()].join(' · '); $('message').hidden = state.warnings.size === 0; }
async function persist(key,value) { try { await storage.set(key,value); } catch { warn('storage','本机存储空间不足或不可用，请导出备份；当前计算仍可使用'); } }
function fieldValues(ids) { return Object.fromEntries(ids.map(id => [id,$(id).type === 'checkbox' ? $(id).checked : $(id).value])); }
function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(saveForm,180); }
async function saveForm() {
  const value = { ...state.form, ...fieldValues([...simIds,...riskIds]), forecasts:state.forecasts, autoHigh:state.autoHigh, wave:{...state.form.wave,...fieldValues(waveIds),mode:state.waveMode,autoHigh:state.waveAutoHigh,autoThird:state.waveAutoThird}, autoBase:state.autoBase, autoCapital:state.autoCapital, autoSell:state.autoSell };
  await persist('form:' + state.stock.symbol,value); state.form = value;
}
function parameters() { return Object.fromEntries(simIds.map(id => [id,$(id).value])); }
function simParams() { return { ...parameters(), high:$('reference-high').value }; }
function nominalHigh() { const b = state.nominal?.bars || (state.history?.adjust === 'qfq' ? state.history.bars : []); return b.length ? Math.max(...b.map(b => b.high)) : null; }
function nominalLow() { const b = state.nominal?.bars || []; return b.length ? Math.min(...b.map(b => b.low)) : null; }
function nominalFrom(h) {
  if (!h) return null;
  const scale = h.referenceScale ?? (h.adjust === 'qfq' ? 1 : null);
  if (!(scale > 0)) return null;
  return {...h,bars:h.bars.map(b=>({...b,open:b.open*scale,high:b.high*scale,low:b.low*scale,close:b.close*scale}))};
}
function rowsTable(headers,rows) { return rows.length ? '<table><thead><tr>'+headers.map(h=>'<th>'+h+'</th>').join('')+'</tr></thead><tbody>'+rows.map((r)=>'<tr'+(r.className?' class="'+r.className+'"':'')+'>'+r.map(c=>'<td>'+c+'</td>').join('')+'</tr>').join('')+'</tbody></table>' : '<div class="empty">暂无可分析的数据。可刷新行情，或导入历史日线 CSV。</div>'; }
function card(label,value,note,cls='') { return '<div class="stat-card"><span>'+label+'</span><b class="'+cls+'">'+value+'</b><small>'+note+'</small></div>'; }
function resultLine(label,value,cls='') { return '<div class="result-line"><span>'+label+'</span><b class="'+cls+'">'+value+'</b></div>'; }
async function api(action,params={},force=false) {
  const search = new URLSearchParams({ action,...params,...(force?{force:'1'}:{}) });
  const response = await fetch('/api/stock?' + search,{ signal:AbortSignal.timeout(action === 'history' ? 55000 : 16000), cache:force?'reload':'default' });
  let json; try { json = await response.json(); } catch { throw new Error('行情服务响应异常'); }
  if (!response.ok) throw new Error(json.error || '行情服务暂不可用'); return json;
}
function quotePhase(q) {
  if (!q?.time) return '尚未获取行情';
  const day = q.time.slice(0,10), t = new Date(q.time).toLocaleTimeString('en-GB',{ timeZone:'Asia/Shanghai', hour12:false });
  if (day !== today()) return '最近交易行情';
  if (t >= '15:00:00') return '当日收盘行情';
  return '日内延迟行情（非交易所实时）';
}
function renderQuote() {
  const q = state.quote;
  $('stock-name').textContent = state.stock.name; $('stock-code').textContent = state.stock.symbol;
  $('quote-price').innerHTML = fmt(q?.price) + '<small>元</small>';
  $('quote-price').className = 'quote-price ' + tone(q?.change);
  $('quote-change').textContent = q ? (q.change>0?'+':'') + fmt(q.change)+' ('+pct(q.changePct == null ? null : q.changePct/100)+')' : '等待行情';
  $('quote-change').className = tone(q?.change);
  $('quote-status').title = q ? `${q.source} · ${quotePhase(q)} · ${dateText(q.time)}${q.local?' · 本机缓存':q.cached?' · 服务端缓存':''}` : '行情尚未获取。可填写研究参数，或导入本机历史数据。';
  $('quote-detail').textContent=$('quote-status').title;
  $('quote-status').textContent=q?quotePhase(q)+' · '+dateText(q.time)+(q.local?' · 本机缓存':''):'暂无行情，可继续手动测算';
  $('network-state').textContent = !navigator.onLine ? '离线 · 本机研究' : q?.local || q?.stale ? '缓存数据' : q ? '行情已连接' : '等待行情';
  const stats = [['今日最高',q?.high,'元'],['今日最低',q?.low,'元'],['成交量',q?.volume == null?null:q.volume/1e4,'万股'],['成交额',q?.amount == null?null:q.amount/1e8,'亿元'],['换手率',q?.turnover,'%'],['总市值',q?.marketCap,'亿元'],['流通市值',q?.floatCap,'亿元'],['总股本',q?.capital,'亿股']];
  $('quote-grid').innerHTML = stats.map(([label,value,unit])=>'<div class="quote-stat"><span>'+label+'</span><b>'+fmt(value,label==='总股本'?4:2)+'</b><small>'+unit+'</small></div>').join('');
  $('favorite').textContent = state.watch.some(s=>s.symbol===state.stock.symbol) ? '★ 当前股票已自选':'☆ 加入当前股票';
}
function renderWatch() {
  $('watch-count').textContent = String(state.watch.length).padStart(2,'0');
  $('watchlist').innerHTML = state.watch.map((s,i)=>'<button class="watch-item '+(s.symbol===state.stock.symbol?'active':'')+'" data-stock="'+esc(s.symbol)+'"><span class="watch-icon">'+String(i+1).padStart(2,'0')+'</span><span><b>'+esc(s.name)+'</b><small>'+esc(s.symbol)+'</small></span><span class="watch-arrow">↗</span></button>').join('') || '<div class="empty">搜索股票加入自选</div>';
}
async function applyForm() {
  const symbol = state.stock.symbol, form = await storage.get('form:'+symbol) || {};
  if (symbol !== state.stock.symbol) return;
  const initial = symbol === '300502.SZ';
  const values = { 'reference-high':'', low:initial?194:'', rebound:100, shares:initial?7000:0, cost:'', base:'', capital:'', profit:initial?180:'', cash:0, debt:0, 'debt-type':'ordinary', due:'', 'sell-price':'', 'sell-qty':'', fee:.1, cushion:0, lot:true,...form };
  for (const id of [...simIds,...riskIds]) { if ($(id).type==='checkbox') $(id).checked = Boolean(values[id]); else $(id).value = id==='rebound'&&finite(values[id])?Number(Number(values[id]).toFixed(6)):values[id]??''; }
  state.autoBase = form.autoBase !== false; state.autoCapital = form.autoCapital !== false; state.autoSell = form.autoSell !== false;
  state.forecasts = Array.from({length:5},(_,i)=>{ const year = currentYear()+i, saved = Array.isArray(form.forecasts) ? form.forecasts.find(f=>f.year===year) : null; return {year, profit:saved?.profit ?? (initial&&i===0?180:''), conservative:saved?.conservative ?? '', optimistic:saved?.optimistic ?? ''}; });
  state.autoHigh=form.autoHigh!==false;
  const wave=form.wave||{};state.waveMode=wave.mode==='fifth'?'fifth':'abc';state.waveAutoHigh=wave.autoHigh!==false;state.waveAutoThird=wave.autoThird!==false;
  const waveValues={'wave-high':'','wave-low':initial?190:'','wave-b-ratio':38.2,'wave-c-ratio':61.8,'wave-third-start':initial?33.5:'','wave-third-end':'','wave-fourth-low':initial?192:'','wave-fifth-ratio':78.6,'wave-show-c':false,...wave};
  for(const id of waveIds){if($(id).type==='checkbox')$(id).checked=Boolean(waveValues[id]);else $(id).value=waveValues[id]??'';}
  if(state.mode!=='normal')state.waveMode=state.mode;
  state.form = form;
  $('rebound-range').value = Math.min(200,Number($('rebound').value));
}
function setFromQuote(q) {
  if (state.autoBase || !$('base').value) $('base').value = q.price;
  if (state.autoCapital || !$('capital').value) $('capital').value = finite(q.capital) ? Number(q.capital).toFixed(6) : '';
  if (state.autoSell || !$('sell-price').value) $('sell-price').value = q.price;
  if (!$('low').value) $('low').value = q.low || q.price;
  if(!$('wave-low').value)$('wave-low').value=q.low||q.price;
  if(!$('wave-fourth-low').value)$('wave-fourth-low').value=q.low||q.price;
}
async function loadStock(stock, force=false) {
  clearTimeout(saveTimer);
  if (state.stock && state.generation && !state.skipSave) await saveForm();
  state.skipSave=false;
  state.generation++; const generation = state.generation;
  state.stock = stock; state.quote = null; state.history = null; state.nominal = null; state.bars = []; state.start = ''; state.end = ''; state.selectedEvent = 0; state.picks = []; state.warnings.clear(); warn('quote','');
  $('range-start').value = ''; $('range-end').value = ''; $('manual-selection').textContent = '';
  await applyForm(); if (generation !== state.generation) return;
  renderWatch(); renderQuote(); renderSim(); renderValuation(); renderRisk(); renderSaved();
  await persist('selected',stock);
  const adjust = $('adjust').value;
  const [localQuote,localHistory,localNominal] = await Promise.all([storage.get('quote:'+stock.symbol),storage.get('history:'+stock.symbol+':'+adjust),storage.get('history:'+stock.symbol+':qfq')]);
  if (generation !== state.generation) return;
  if (localQuote) { state.quote = {...localQuote,local:true}; setFromQuote(state.quote); }
  if (localHistory) { state.history = {...localHistory,local:true}; state.nominal = nominalFrom(state.history); } if (localNominal) state.nominal = nominalFrom({...localNominal,local:true});
  renderQuote(); updateHistory(); renderSim();
  await refreshData(force,generation);
}
async function refreshData(force=false,generation=state.generation) {
  const symbol = state.stock.symbol, adjust = $('adjust').value;
  state.busy = true; $('refresh').disabled = true; $('refresh').textContent = '⟳ 更新中';
  const quoteTask = (async()=>{ try { const q=await api('quote',{symbol},force); if(generation!==state.generation)return; state.quote=q; state.stock.name=q.name; state.watch=state.watch.map(s=>s.symbol===symbol?{...s,name:q.name}:s); setFromQuote(q); renderQuote();renderWatch();renderSim();renderValuation();renderRisk(); await persist('quote:'+symbol,q);await persist('watch',state.watch);warn('quote',q.stale?'行情源中断，当前为服务端缓存':''); } catch(e){if(generation!==state.generation)return;warn('quote',state.quote?'行情更新失败，沿用 '+dateText(state.quote.time)+' 的缓存':e.message);renderQuote();} })();
  const historyTask = (async()=>{ try { const h=await api('history',{symbol,adjust},force); h.bars=validateBars(h.bars);if(generation!==state.generation)return;state.history=h;const nominal=nominalFrom(h);if(nominal){state.nominal=nominal;warn('nominal','');}await persist('history:'+symbol+':'+adjust,h);if(h.adjust!==adjust)await persist('history:'+symbol+':'+h.adjust,h);warn('history',[h.warning,h.complete?'':'历史源存在截断；结果只代表已加载区间'].filter(Boolean).join('；'));updateHistory();renderSim(); } catch(e){if(generation!==state.generation)return;warn('history',state.history?'历史更新失败，沿用 '+dateText(state.history.fetchedAt)+' 的缓存':e.message);updateHistory();} })();
  const nominalTask = adjust!=='none'?Promise.resolve():(async()=>{ try { const h=await api('history',{symbol,adjust:'qfq'},force);h.bars=validateBars(h.bars);if(generation!==state.generation)return;state.nominal=nominalFrom(h);await persist('history:'+symbol+':qfq',h);renderSim(); } catch { if(generation===state.generation)warn('nominal','复权参考暂不可用，跨口径价格映射暂停'); } })();
  await Promise.allSettled([quoteTask,historyTask,nominalTask]);
  if (generation!==state.generation)return;
  state.busy=false;$('refresh').disabled=false;$('refresh').textContent='⟳ 刷新数据';renderActive();scheduleSave();
}
function filteredBars() { return (state.history?.bars||[]).filter(b=>(!state.start||b.time>=state.start)&&(!state.end||b.time<=state.end)); }
function closedBars() {
  const time = new Date().toLocaleTimeString('en-GB',{ timeZone:'Asia/Shanghai', hour12:false });
  return state.bars.filter(b=>b.time<today()||(b.time===today()&&time>='15:05:00'));
}
function updateHistory() {
  state.bars=filteredBars(); const bars=state.bars,h=state.history;
  if(h?.adjust)$('adjust').value=h.adjust;
  $('chart-empty').hidden=bars.length>0;
  $('chart-empty').textContent=state.busy?'正在获取历史行情…':'暂未获取历史行情，可刷新或导入历史 CSV';
  $('history-summary').textContent=bars.length?`${bars[0].time} — ${bars.at(-1).time} · ${fmt(bars.length,0)} 个交易日${h.complete?'':' · 数据可能截断'}`:'暂无历史日线';
  $('history-source').textContent=h?`${h.source} · ${adjustLabel(h.adjust)} · 获取 ${dateText(h.fetchedAt)}${h.local?' · 本机缓存':''}`:'历史数据尚不可用';
  if (h?.adjust==='none')warn('basis','当前不复权：除权可能形成机械跳空，不适合跨期涨跌比较；建议前复权或后复权');else warn('basis','');
  if(bars.length){const dd=maxDrawdown(bars), high=Math.max(...bars.map(b=>b.high)),low=Math.min(...bars.map(b=>b.low));
    $('history-metrics').innerHTML='<div><span>区间最高 / 最低 · '+adjustLabel(h.adjust)+'</span><b>'+fmt(high)+' / '+fmt(low)+'</b><small>同一口径日内极值，不等于最大回撤</small></div><div><span>收盘价最大回撤</span><b class="down">'+pct(dd?-dd.drawdown:0)+'</b><small>'+(dd?bars[dd.peak].time+' → '+bars[dd.trough].time:'区间未出现回撤')+'</small></div><div><span>高点至低点耗时</span><b>'+(dd?dd.days:'—')+' <small style="display:inline">交易日</small></b><small>'+(dd?dd.recoveryDays==null?'截至区间末尚未恢复前高':'低点后 '+dd.recoveryDays+' 日恢复前高':'—')+'</small></div>';
  }else $('history-metrics').innerHTML='<div><span>区间最高 / 最低</span><b>—</b></div><div><span>收盘价最大回撤</span><b>—</b></div><div><span>回撤耗时</span><b>—</b></div>';
  drawChart();renderLowPresets();renderHistory();renderBacktest();
}
function adjustLabel(v){return {qfq:'前复权',hfq:'后复权',none:'不复权'}[v]||'未知口径';}
function chartColors(){const style=getComputedStyle(document.documentElement);return Object.fromEntries(['panel','text','muted','line','up','down','accent'].map(k=>[k,style.getPropertyValue('--'+k).trim()]));}
function chartOptions(height){const c=chartColors();return {autoSize:true,height,layout:{background:{type:'solid',color:c.panel},textColor:c.muted,fontSize:10,attributionLogo:false},grid:{vertLines:{color:c.line+'55'},horzLines:{color:c.line+'88'}},rightPriceScale:{borderColor:c.line,scaleMargins:{top:.1,bottom:$('chart-indicators').checked?.24:.08}},timeScale:{borderColor:c.line,timeVisible:false,rightOffset:5},crosshair:{mode:0},localization:{locale:'zh-CN'}};}
function drawChart(){
  if(!window.LightweightCharts||!$('history-details').open)return;
  const L=window.LightweightCharts,c=chartColors(),bars=aggregateBars(state.bars,state.period);
  if(state.chart){state.chart.remove();state.chart=null;}
  if(!bars.length)return;
  const chart=L.createChart($('chart'),chartOptions($('chart').clientHeight));state.chart=chart;
  const candles=chart.addSeries(L.CandlestickSeries,{upColor:c.up,downColor:c.down,borderVisible:false,wickUpColor:c.up,wickDownColor:c.down,priceFormat:{type:'price',precision:3,minMove:.001}});state.candles=candles;candles.setData(bars);
  if($('chart-indicators').checked){
  const volume=chart.addSeries(L.HistogramSeries,{priceFormat:{type:'volume'},priceScaleId:'volume',lastValueVisible:false,priceLineVisible:false});volume.priceScale().applyOptions({scaleMargins:{top:.82,bottom:0}});volume.setData(bars.map(b=>({time:b.time,value:b.volume,color:(b.close>=b.open?c.up:c.down)+'55'})));
  [5,10,20,60].forEach((n,i)=>{const series=chart.addSeries(L.LineSeries,{color:['#c9df8a','#7db9c2','#c4a0d3','#cfa36b'][i],lineWidth:1,lastValueVisible:false,priceLineVisible:false,crosshairMarkerVisible:false});series.setData(movingAverage(bars,n));});
  }
  const high=bars.reduce((p,b,i)=>b.high>bars[p].high?i:p,0),low=bars.reduce((p,b,i)=>b.low<bars[p].low?i:p,0),dd=maxDrawdown(bars);
  const markers=[{time:bars[high].time,position:'aboveBar',color:c.accent,shape:'arrowDown',text:'高 '+fmt(bars[high].high)},{time:bars[low].time,position:'belowBar',color:c.muted,shape:'arrowUp',text:'低 '+fmt(bars[low].low)}].sort((a,b)=>a.time.localeCompare(b.time));
  state.marker=L.createSeriesMarkers(candles,markers);
  if(dd){const path=chart.addSeries(L.LineSeries,{color:'#e5b879',lineWidth:2,lineStyle:2,lastValueVisible:false,priceLineVisible:false,crosshairMarkerVisible:false});path.setData([{time:bars[dd.peak].time,value:dd.peakPrice},{time:bars[dd.trough].time,value:dd.lowPrice}]);}
  chart.timeScale().fitContent();if(state.range!=='all'){const n=Number(state.range);chart.timeScale().setVisibleLogicalRange({from:Math.max(0,bars.length-n),to:bars.length+3});}
  chart.subscribeCrosshairMove(param=>{if(!param.time||!param.point||param.point.x<0||param.point.y<0){$('chart-tooltip').hidden=true;return;}const b=param.seriesData.get(candles);if(!b)return;$('chart-tooltip').hidden=false;$('chart-tooltip').innerHTML=esc(String(param.time))+'　开 '+fmt(b.open,3)+'　高 '+fmt(b.high,3)+'　低 '+fmt(b.low,3)+'　收 '+fmt(b.close,3);});
  chart.subscribeClick(param=>{if(!state.picking||!param.time)return;const b=bars.find(b=>b.time===param.time);if(!b)return;state.picks.push(b);if(state.picks.length===1){$('manual-selection').textContent='已选高点 '+b.time+'，请选择后续低点';return;}const[a,z]=state.picks;if(z.time<=a.time||z.low>=a.high){state.picks=[];toast('请选择时间更晚、价格更低的低点');return;}state.picking=false;$('pick-range').textContent='选取高低点';$('manual-selection').textContent=`${a.time} 高 ${fmt(a.high)} → ${z.time} 低 ${fmt(z.low)} · 回撤 ${fmt((1-z.low/a.high)*100)}%（${adjustLabel(state.history.adjust)}）`;});
}
function renderLowPresets(){
  const b=state.nominal?.bars||[],high=nominalHigh(),opts=[];
  if(b.length){for(const[n,label]of[[1,'最近交易日'],[20,'近20日'],[60,'近60日'],[120,'近120日']])opts.push([Math.min(...b.slice(-n).map(b=>b.low)),label+'最低（复权归一参考）']);
    const dd=maxDrawdown(b,'intraday');if(dd)opts.push([dd.lowPrice,'历史最大回撤的实际低点（事后）']);
    const events=drawdownEvents(b,.01,'intraday').filter(e=>e.recovery==null);if(events[0])opts.push([events[0].lowPrice,'本轮尚未恢复前高的最低价']);
    for(const d of[60,65,70,75,76.8,80])opts.push([high*(1-d/100),'复权参考高点回撤 '+d+'%（假设映射）']);}
  $('low-presets').innerHTML='<option value="">选择历史价格 / 回撤幅度</option>'+opts.map(([v,t])=>'<option value="'+v+'">'+t+' · '+fmt(v)+' 元</option>').join('');
}
function matrixRows(){const p=simParams();return [...new Set([20,30,50,70,100,110,...(finite(p.rebound)&&Number(p.rebound)>=0?[Number(p.rebound)]:[])])].sort((a,b)=>a-b).map(r=>{const s=simulate({...p,rebound:r});return {r,...s};});}
function syncReferencePrices(){
  const high=nominalHigh();
  if(high>0){if(state.autoHigh)$('reference-high').value=Number(high.toFixed(5));if(state.waveAutoHigh)$('wave-high').value=Number(high.toFixed(5));if(state.waveAutoThird)$('wave-third-end').value=Number(high.toFixed(5));}
}
function renderCorePosition(){
  const valid=finite($('shares').value)&&Number($('shares').value)>=0&&Number.isInteger(Number($('shares').value)),shares=valid?Number($('shares').value):null,price=state.quote?.price;
  $('header-position').innerHTML='持有 <b>'+fmt(shares,0)+'</b> 股 <span>·</span> 当前持仓市值 <b>'+money(price==null||shares==null?null:price*shares)+'</b>';
}
function renderMarket(){
  const p=simParams(),s=simulate(p);
  $('position-detail').innerHTML=resultLine('比较基准价对应持仓市值',Number(p.base)>0?money(s.currentValue):'—')+resultLine('相对实际成本盈亏',finite(p.cost)&&Number(p.base)>0?money((Number(p.base)-Number(p.cost))*Number(p.shares)):'未填持仓成本');
}
function renderSim(){
  syncReferencePrices();
  const p=simParams(),s=simulate(p),valid=Number(p.low)>0,hasBase=Number(p.base)>0,high=Number(p.high),drop=high>0&&valid?Number(p.low)/high-1:null;
  renderCorePosition();
  $('assumption-note').textContent=(state.autoHigh?'高点来自行情':'高点为手动假设')+' · '+(state.nominal?.referenceLabel||'复权参考待获取')+(state.nominal?.referenceDate?' · 归一至 '+state.nominal.referenceDate:'')+'。'+(state.stock.symbol==='300502.SZ'?'初始194元和7000股仅为研究示例。':'');
  $('drop-summary').innerHTML='高点 → 假设低点 <b class="'+tone(drop)+'">'+pct(drop)+'</b>';
  $('rebound-range').value=Math.min(200,Math.max(0,Number(p.rebound)||0));
  $('rebound-presets').innerHTML=[30,50,100].map(n=>'<button data-rebound="'+n+'" class="'+(Number(p.rebound)===n?'active':'')+'">+'+n+'%</button>').join('');
  $('rebound-extra').innerHTML=[10,20,40,60,70,80,110,150,200].map(n=>'<button data-rebound="'+n+'" class="'+(Number(p.rebound)===n?'active':'')+'">+'+n+'%</button>').join('');
  $('scenario-matrix').innerHTML=valid?rowsTable(['从低点反弹','目标价 · 元','较比较基准','持仓市值'],matrixRows().map(v=>{const r=['<button data-rebound="'+v.r+'">+'+fmt(v.r,finite(v.r)&&v.r%1?2:0)+'%</button>',fmt(v.target),'<span class="'+tone(v.fromBase)+'">'+(hasBase?pct(v.fromBase):'—')+'</span>',money(v.value)];if(v.r===Number(p.rebound))r.className='highlight';return r;})):'<div class="empty">填写假设低点，即可测算价格与持仓市值。</div>';
  $('cross-matrix').innerHTML=high>0?rowsTable(['高点回撤','假设低点','反弹20%','反弹50%','反弹100%','反弹110%'],[60,65,70,75,76.8,80].map(d=>{const low=high*(1-d/100);return[d+'%',fmt(low),...[20,50,100,110].map(r=>'<button data-map-low="'+low+'" data-map-rebound="'+r+'">'+fmt(low*(1+r/100))+'</button>')];})):'<div class="empty">填写参考高点后可显示回撤矩阵。</div>';
  if(state.tab==='valuation')renderValuation();if(state.tab==='risk')renderRisk();if(state.tab==='market')renderMarket();renderWave();
}
function currentResult(){return workspaceCalculation(state.mode,simParams(),waveInputs());}
function renderWorkspace(){
  const s=currentResult(),wave=state.mode!=='normal';
  $$('[data-mode-fields]').forEach(el=>el.hidden=el.dataset.modeFields!==state.mode);
  $$('[data-mode]').forEach(el=>{const active=el.dataset.mode===state.mode;el.classList.toggle('active',active);el.setAttribute('aria-pressed',String(active));});
  $('wave-ratios').hidden=!wave;$('wave-reference').hidden=!wave;
  $$('[data-reference]').forEach(el=>el.hidden=el.dataset.reference!==(wave?'wave':'normal'));
  $$('[data-comparison]').forEach(el=>el.hidden=el.dataset.comparison!==(wave?'wave':'normal'));
  $('wave-c-details').hidden=state.mode!=='abc';$('wave-apply').hidden=!wave;
  $('third-reference-summary').textContent='三浪参考 '+fmt($('wave-third-start').value)+' → '+fmt($('wave-third-end').value)+' 元 · 修改';
  const canSave=s.valid&&finite($('shares').value)&&Number($('shares').value)>=0&&Number.isInteger(Number($('shares').value));
  $('save-scenario').disabled=!canSave;$('copy-result').disabled=!canSave;$('export-xlsx').disabled=!canSave;$('wave-apply').disabled=!s.valid;
  if(!s.valid){$('price-path').innerHTML='';$('main-result').innerHTML='<div class="empty">'+esc(s.error)+'</div>';$('calculation-formula').textContent='';$('reference-results').innerHTML='';return;}
  const edge=r=>finite(r)?'<span class="path-edge '+tone(r)+'"><b>'+ (r<0?'跌 '+fmt(-r*100):'涨 '+fmt(r*100))+'%</b><span>→</span></span>':'<span class="path-edge">→</span>';
  const node=(label,value)=>'<span class="path-node"><small>'+esc(label)+'</small><b>'+fmt(value)+'</b></span>';
  $('price-path').innerHTML=node(s.labels[0],s.high)+edge(s.drop)+node(s.labels[1],s.low)+edge(s.rise)+node(s.labels[2],s.target);
  const shares=Number($('shares').value),base=state.quote?.price;
  $('main-result').innerHTML='<div class="core-result-grid"><div><span>'+esc(s.labels[2])+' · 元</span><b>'+fmt(s.target)+'</b></div><div><span>目标持仓市值</span><b>'+fmt(s.value==null?null:s.value/10000)+'<small>万元</small></b></div></div>'+(base>0&&s.value!=null?'<p class="holding-delta">较当前持仓 <b class="'+tone(s.target-base)+'">'+((s.target-base)>=0?'+':'')+money((s.target-base)*shares)+'</b></p>':'');
  $('calculation-formula').textContent='目标价 = '+s.formula+'。';
  const compared=simulate({...simParams(),low:s.target,rebound:0});
  $('reference-results').innerHTML=resultLine('目标价较参考高点',s.high>0?pct(s.target/s.high-1):'—')+resultLine('目标价较当前股价',base>0?pct(s.target/base-1):'—')+resultLine('目标价较所填比较基准',Number($('base').value)>0?pct(compared.fromBase):'—');
}
function waveInputs(){return{high:$('wave-high').value,low:$('wave-low').value,bPercent:$('wave-b-ratio').value,cPercent:$('wave-c-ratio').value,thirdStart:$('wave-third-start').value,thirdEnd:$('wave-third-end').value,fourthLow:$('wave-fourth-low').value,extensionPercent:$('wave-fifth-ratio').value,shares:$('shares').value};}
function waveCalculation(){const p=waveInputs();return state.waveMode==='fifth'?fifthScenario(p):abcScenario(p);}
function waveSamples(){const p=waveInputs(),fifth=state.waveMode==='fifth',key=fifth?'extensionPercent':'bPercent',chosen=Number(p[key]);return [...new Set([...(fifth?FIFTH_RATIOS:ABC_RATIOS),...(finite(p[key])&&chosen>=0?[chosen]:[])])].sort((a,b)=>a-b).map(r=>({ratio:r,...(fifth?fifthScenario({...p,[key]:r}):abcScenario({...p,[key]:r}))}));}
function wavePath(points){
  points=points.filter(p=>finite(p.price)&&Number(p.price)>0);if(points.length<2)return '';
  const prices=points.map(p=>Number(p.price)),min=Math.min(...prices),max=Math.max(...prices),spread=max-min||1;
  const coords=points.map((p,i)=>({...p,x:58+i*564/(points.length-1),y:163-(Number(p.price)-min)/spread*114}));
  return '<svg viewBox="0 0 680 214" role="img" aria-label="'+esc(points.map(p=>p.name+' '+fmt(p.price)+'元').join('，'))+'"><line x1="35" x2="645" y1="184" y2="184" stroke="var(--line)"/><polyline points="'+coords.map(p=>p.x+','+p.y).join(' ')+'" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-dasharray="6 5"/>'+coords.map((p,i)=>'<circle cx="'+p.x+'" cy="'+p.y+'" r="4" fill="var(--panel)" stroke="var(--accent)" stroke-width="2"/><text x="'+p.x+'" y="'+(p.y-19)+'" text-anchor="middle" fill="var(--text)" font-size="14">'+fmt(p.price)+'</text><text x="'+p.x+'" y="204" text-anchor="middle" fill="var(--muted)" font-size="11">'+esc(p.name)+'</text>').join('')+'</svg>';
}
function renderWave(){
  const fifth=state.waveMode==='fifth',p=waveInputs(),s=waveCalculation(),ratios=fifth?FIFTH_RATIOS:ABC_RATIOS,selected=fifth?p.extensionPercent:p.bPercent;
  $('wave-assumption-note').textContent=state.stock.symbol==='300502.SZ'?'190 / 33.5 / 192 元为研究示例，可自行修改。':'请使用同一复权口径，自行指定浪段价格。';
  const presets=fifth?[78.6,100]:[38.2,50,61.8];
  const chips=rs=>rs.map(r=>'<button data-wave-ratio="'+r+'" class="'+(Number(selected)===r?'active':'')+'">'+r+'%</button>').join('');
  $('wave-ratio-presets').innerHTML=chips(presets);$('wave-ratio-extra').innerHTML=chips(ratios.filter(r=>!presets.includes(r)));
  if(!s.valid){$('wave-table').innerHTML='<div class="empty">'+esc(s.error)+'</div>';$('wave-path').innerHTML='';$('wave-leg-summary').textContent='';$('wave-c-result').textContent='';renderWorkspace();return;}
  $('wave-leg-summary').innerHTML=fifth?'三浪长度 <b>'+fmt(s.length)+' 元</b> · 四浪回补三浪涨幅 <b>'+fmt(s.fourthRetracement*100)+'%</b>':'A 浪下跌 <b>'+pct(s.drawdown)+'</b> · 下跌金额 <b>'+fmt(s.length)+' 元</b>';
  $('wave-table').innerHTML=rowsTable([fifth?'五浪 / 三浪长度':'B 浪回补 A 浪跌幅','目标价 · 元',fifth?'较四浪底部涨幅':'较 A 浪终点涨幅','持仓市值'],waveSamples().map(v=>{const row=['<button data-wave-ratio="'+v.ratio+'">'+ratioText(v.ratio)+'%</button>',fmt(v.target),pct(v.rise),money(v.value)];if(v.ratio===Number(selected))row.className='highlight';return row;}));
  const showC=!fifth&&$('wave-show-c').checked;
  $('wave-c-result').innerHTML=showC?(s.cValid?resultLine('C 浪假设目标',fmt(s.cTarget)+' 元')+resultLine('该价持仓市值',money(s.cValue))+resultLine('较 B 浪目标回落',pct(s.cChange),'down'):'<p class="field-note down">'+esc(s.cError)+'</p>'):'<p class="field-note">开启后，用 B 目标价减去 A 浪下跌金额 × 所填比例。</p>';
  const points=fifth?[{name:'三浪起点',price:p.thirdStart},{name:'三浪终点',price:p.thirdEnd},{name:'假设四浪底部',price:p.fourthLow},{name:'五浪目标',price:s.target}]:[{name:'A 浪起点',price:p.high},{name:'假设 A 浪终点',price:p.low},{name:'B 浪目标',price:s.target},...(showC&&s.cValid?[{name:'C 浪假设目标',price:s.cTarget}]:[])];
  $('wave-path').innerHTML=wavePath(points);renderWorkspace();
}
function restoreWave(w){for(const id of waveIds){if(w[id]==null)continue;if($(id).type==='checkbox')$(id).checked=Boolean(w[id]);else $(id).value=w[id];}state.waveMode=w.mode==='fifth'?'fifth':'abc';state.waveAutoHigh=false;state.waveAutoThird=false;renderWave();}
function wavePriceParameters(){const p=waveInputs(),s=waveCalculation();if(!s.valid)return null;const fifth=state.waveMode==='fifth';return{...simParams(),high:fifth?p.thirdEnd:p.high,'reference-high':fifth?p.thirdEnd:p.high,low:fifth?p.fourthLow:p.low,rebound:Number((s.rise*100).toFixed(6))};}
function exportWave(){const p=waveInputs(),fifth=state.waveMode==='fifth',s=waveCalculation();if(!s.valid)return;const rows=[['股票',state.stock.name,state.stock.symbol],['场景',fifth?'手动五浪 / 三浪长度假设':'手动熊市 ABC 假设'],...(fifth?[['三浪起点',Number(p.thirdStart)],['三浪终点',Number(p.thirdEnd)],['四浪假设底部',Number(p.fourthLow)]]:[['A浪起点',Number(p.high)],['假设A浪终点',Number(p.low)]]),['持有股数',Number(p.shares)],[],[fifth?'五浪/三浪长度（%）':'B浪回补A浪跌幅（%）','目标价（元）','从假设低点上涨（%）','持仓市值（元）'],...waveSamples().map(v=>[v.ratio,v.target,v.rise*100,v.value]),[],['说明','手动浪型假设；锚点须使用同一复权口径；比例不是未来概率。']];if(!fifth&&$('wave-show-c').checked)rows.push(['C/A长度（%）',Number(p.cPercent)],['C假设目标（元）',s.cTarget??'非正价格，假设无效'],['C价持仓市值（元）',s.cValue??'不适用']);download(state.stock.symbol+'-'+(fifth?'五浪':'ABC')+'-推演.xlsx',makeXLSX(rows,'浪型推演'));toast('浪型价格与持仓市值已导出');}
function bindWave(){
  document.addEventListener('click',e=>{const el=e.target.closest('button');if(!el)return;if(el.dataset.mode)setMode(el.dataset.mode);if(el.dataset.waveRatio){$(state.waveMode==='fifth'?'wave-fifth-ratio':'wave-b-ratio').value=el.dataset.waveRatio;renderWave();scheduleSave();}});
  waveIds.forEach(id=>$(id).addEventListener('input',()=>{if(id==='wave-high')state.waveAutoHigh=false;if(id==='wave-third-end')state.waveAutoThird=false;renderWave();scheduleSave();}));
  $('wave-apply').onclick=()=>{const p=wavePriceParameters();if(!p)return;for(const id of['reference-high','low','rebound'])$(id).value=p[id];state.autoHigh=false;renderSim();activateTab('overview');scheduleSave();toast('已应用价格与实际反弹涨幅');};

}
function renderHistory(){
  const b=state.bars,mode=$('dd-mode').value,threshold=Math.min(.99,Math.max(.01,Number($('dd-threshold').value)/100||.3)),dd=maxDrawdown(b,mode);
  state.events=drawdownEvents(b,threshold,mode);
  $('dd-summary').innerHTML=card('历史最大回撤',pct(dd?-dd.drawdown:null),adjustLabel(state.history?.adjust)+' · '+(mode==='close'?'收盘价':'跨日高低价'),'down')+card('高点 → 低点',dd?dd.days+' 日':'—',dd?b[dd.peak].time+' → '+b[dd.trough].time:'数据不足')+card('低点后收复前高',dd?.recoveryDays==null?'未恢复':dd.recoveryDays+' 日','截至所选区间末日')+card('独立深跌事件',String(state.events.length),'回到该轮前高后才能开启新一轮');
  $('events-table').innerHTML=rowsTable(['高点日期','低点日期','高 → 低','最大回撤','下跌交易日','低点后最大反弹','恢复前高',''],state.events.map((e,i)=>[b[e.peak].time,b[e.trough].time,fmt(e.peakPrice)+' → '+fmt(e.lowPrice),'<span class="down">'+pct(-e.drawdown)+'</span>',e.days,pct(e.maxRebound),e.recovery==null?'进行中':e.recoveryDays+' 日','<button data-event="'+i+'">研究此轮 →</button>']));
  if(state.selectedEvent>=state.events.length)state.selectedEvent=0;renderEventDetail();
}
function renderEventDetail(){
  if(state.mappingChart){state.mappingChart.remove();state.mappingChart=null;}
  const e=state.events[state.selectedEvent],b=state.bars;if(!e){$('event-detail').innerHTML='<div class="empty">当前阈值下没有独立深跌事件。可调整阈值或分析区间。</div>';return;}
  const anchor=nominalHigh(),m=anchor?mapEvent(e,anchor):null;
  $('event-detail').innerHTML='<div class="panel-header" style="padding:0 0 18px"><div><span class="eyebrow">HISTORICAL PATH · '+b[e.peak].time+'</span><h2>从回撤，到反弹，再到下一步</h2></div><span class="mini-badge">事后路径研究</span></div><div class="event-timeline">'+[['前期高点',e.peakPrice,b[e.peak].time],['首次阶段低点',e.legs[0]?.low,e.legs[0]?b[e.legs[0].trough].time:'未确认20%反弹'],['首次反弹高点',e.legs[0]?.high,e.legs[0]?b[e.legs[0].peak].time:'—'],['整轮最终低点',e.lowPrice,b[e.trough].time]].map(([l,p,d])=>'<div class="timeline-point"><small>'+l+'</small><b>'+fmt(p)+'</b><small>'+d+'</small></div>').join('')+'</div>'+rowsTable(['从最终低点起（事后）','反弹20%','反弹30%','反弹50%','反弹100%'],[['首次触及所需交易日',...[20,30,50,100].map(p=>e.hits[p]==null?'未触及':e.hits[p]+' 日')]])+'<h3 style="margin:24px 0 12px">过程中确认的阶段反弹</h3>'+rowsTable(['低点 → 反弹峰值','反弹幅度','反弹耗时','之后再创新低','峰值后最大下跌'],e.legs.map(l=>[b[l.trough].time+' → '+b[l.peak].time,pct(l.gain),l.days+' 日',l.newLow?'是':'否（截至区间末）',pct(l.afterDrop)]))+'<div class="mapping-controls"><label>映射锚点 · 当前元 / 股<input id="mapping-anchor" type="number" min="0.001" step=".01" value="'+(anchor?anchor.toFixed(3):'')+'"></label><button id="apply-event" class="button primary" '+(!e.legs.length?'disabled':'')+'>将首次反弹应用到模拟器</button><span class="muted">默认使用当前股票复权归一参考高点</span></div><div id="mapping-result"></div><div id="normalized-chart" class="normalized-chart"></div><p class="method-note">此功能仅复现历史价格路径的数学比例，不代表未来一定重演。低点为事后识别，所选区间尚未结束时，“最终低点”仅代表截至目前的最低价。两条曲线均按各自起点归一化为100；映射价格与该百分比路径成正比。</p>';
  renderMapping();
}
function renderMapping(){
  const e=state.events[state.selectedEvent],b=state.bars;if(!e||!$('mapping-anchor'))return;const anchor=Number($('mapping-anchor').value);if(!(anchor>0)){$('mapping-result').innerHTML='<p class="method-note">请填写映射锚点。</p>';return;}
  const m=mapEvent(e,anchor),p=simParams();
  $('mapping-result').innerHTML=rowsTable(['历史比例映射','假设价格 · 元','个人持仓市值','公司市值 · 亿元','相对当前基准'],[['第一阶段低点',m.firstLow],['首次反弹高点',m.rebound],['整轮最低点',m.finalLow]].map(([l,v])=>[l,fmt(v),v==null?'—':money(v*Number(p.shares)),v==null||!(Number(p.capital)>0)?'—':fmt(v*Number(p.capital)),v==null||!(Number(p.base)>0)?'—':money((v-Number(p.base))*Number(p.shares))]));
  if(state.mappingChart){state.mappingChart.remove();state.mappingChart=null;}
  if(!window.LightweightCharts||state.tab!=='history')return;
  const L=window.LightweightCharts,c=chartColors(),chart=L.createChart($('normalized-chart'),{...chartOptions(240),timeScale:{tickMarkFormatter:t=>'T+'+String(typeof t==='number'?t/86400:''),rightOffset:2},localization:{locale:'zh-CN',timeFormatter:t=>'第 '+Math.round(Number(t)/86400)+' 个交易日'}});state.mappingChart=chart;
  const series=chart.addSeries(L.LineSeries,{color:c.accent,lineWidth:2,title:'历史路径'});
  series.setData(b.slice(e.peak,e.end+1).map((v,i)=>({time:(i+1)*86400,value:v.close/e.peakPrice*100})));
  const current=state.nominal?.bars||[];if(current.length){let pi=current.reduce((p,v,i)=>v.high>current[p].high?i:p,0);const now=chart.addSeries(L.LineSeries,{color:'#7db9c2',lineWidth:2,title:'当前高点后'});now.setData(current.slice(pi).map((v,i)=>({time:(i+1)*86400,value:v.close/current[pi].high*100})));}
  chart.timeScale().fitContent();
}
function renderBacktest(){
  const b=closedBars(),threshold=Math.min(.99,Math.max(.01,Number($('bt-threshold').value)/100||.6)),window=Number($('bt-window').value);
  const s=eventStudy(b,{threshold,window,trigger:$('bt-trigger').value,first:$('bt-first').checked,excludeOverlap:$('bt-overlap').checked,volume:$('bt-volume').checked,lookback:Number($('bt-lookback').value)});state.study=s;
  $('backtest-warning').textContent=s.n<10?`仅 ${s.n} 个完整历史样本，样本过少，统计不可靠；这些样本比例不能视为未来概率。${s.incomplete?'另有 '+s.incomplete+' 个未满观察期样本已排除。':''}`:`共 ${s.n} 个完整样本；${s.incomplete} 个未满观察期样本已排除。结果为单股票历史条件统计，不代表未来概率。`;
  const metrics=[['完整样本数',String(s.n),`${window} 个交易日观察窗`],['平均后续涨跌',pct(s.mean),'收盘到未来窗口末收盘',tone(s.mean)],['中位数涨跌',pct(s.median),'完整样本中位数',tone(s.median)],['上涨样本占比',pct(s.up,1).replace('+',''),'样本窗口末收涨'],['平均 MFE',pct(s.mfe),'窗口内最大有利变动',tone(s.mfe)],['平均 MAE',pct(s.mae),'窗口内最大不利变动',tone(s.mae)],['再次创新低',pct(s.newLow,1).replace('+',''),'相对触发日最低价'],['触及 +20% / +50%',pct(s.rebound20,1).replace('+','')+' / '+pct(s.rebound50,1).replace('+',''),'相对触发日收盘的最高价']];
  $('backtest-stats').innerHTML=metrics.map(r=>card(...r)).join('');
  $('backtest-table').innerHTML=rowsTable(['信号日期','基准收盘','后续涨跌','MFE','MAE','再创新低','样本状态'],s.signals.map(v=>[v.date,fmt(v.entry),'<span class="'+tone(v.return)+'">'+pct(v.return)+'</span>',pct(v.mfe),pct(v.mae),v.newLow==null?'—':v.newLow?'是':'否',v.complete?'完整':'仅 '+v.availableDays+' 日，排除']));
}
function renderValuation(){
  const p=simParams(),selected=currentResult(),s=simulate({...p,low:selected.valid?selected.target:0,rebound:0}),rows=valuations(state.forecasts,{capital:Number(p.capital),base:Number(p.base),target:selected.valid?selected.target:null,pe:Number($('valuation-pe').value)});
  $('valuation-scenario').innerHTML=resultLine('公司当前总市值',state.quote?.marketCap!=null?fmt(state.quote.marketCap)+' 亿元':'—')+resultLine('反弹目标价对应总市值',selected.valid&&s.marketCap!=null?fmt(s.marketCap)+' 亿元':'—')+resultLine('所填利润对应目标 PE',selected.valid&&s.pe!=null?fmt(s.pe)+' 倍':'不适用');
  $('valuation-basis').textContent='股本 '+fmt(Number(p.capital),4)+' 亿股 · 所有利润均为手动假设';
  const year=$('valuation-year').value;$('valuation-year').innerHTML=state.forecasts.map(r=>'<option value="'+r.year+'">'+r.year+' 年</option>').join('');if(state.forecasts.some(r=>r.year===Number(year)))$('valuation-year').value=year;
  function forecastInput(r,k){return '<input class="table-input" type="number" step=".1" data-year="'+r.year+'" data-forecast="'+k+'" aria-label="'+r.year+'年'+({profit:'中性',conservative:'保守',optimistic:'乐观'}[k])+'利润假设（亿元）" value="'+esc(r[k])+'" placeholder="自行填写">';}
  $('valuation-table').innerHTML=rowsTable(['年度 / 来源','保守利润 · 亿','中性利润 · 亿','乐观利润 · 亿','中性 EPS · 元','利润同比','基准价 PE','目标价 PE','反推目标价 · 元'],rows.map(r=>[r.year+'<small>用户手动假设</small>',forecastInput(r,'conservative'),forecastInput(r,'profit'),forecastInput(r,'optimistic'),fmt(r.eps),pct(r.growth),Number(p.base)>0?fmt(r.currentPE):'—',finite(r.targetPE)?fmt(r.targetPE):'—',fmt(r.impliedPrice)]));
  renderValuationMatrix();
}
function updateForecastResults(){
  const p=simParams(),s=currentResult(),computed=valuations(state.forecasts,{capital:Number(p.capital),base:Number(p.base),target:s.target,pe:Number($('valuation-pe').value)});
  const trs=$('valuation-table').querySelectorAll('tbody tr');
  computed.forEach((r,i)=>{const cells=trs[i]?.querySelectorAll('td');if(!cells)return;[fmt(r.eps),pct(r.growth),Number(p.base)>0?fmt(r.currentPE):'—',Number(p.low)>0?fmt(r.targetPE):'—',fmt(r.impliedPrice)].forEach((v,j)=>cells[j+4].textContent=v);});
  renderValuationMatrix();
}
function renderValuationMatrix(){
  const r=state.forecasts.find(r=>r.year===Number($('valuation-year').value)),capital=Number($('capital').value),pes=[8,10,12,15,18,20,25,30,40];
  $('valuation-matrix').innerHTML=rowsTable(['利润假设 · 亿元',...pes.map(n=>n+'× PE')],r?['conservative','profit','optimistic'].map((k,i)=>[[['保守','中性','乐观'][i],fmt(r[k])].join(' · '),...pes.map(pe=>Number(r[k])>0&&capital>0?fmt(Number(r[k])*pe/capital):'不适用')]):[]);
}
function riskParams(){const r=fieldValues(riskIds);return{...r,shares:$('shares').value,sellPrice:r['sell-price'],sellQty:r['sell-qty'],lot:r.lot};}
function renderRisk(){
  const p=riskParams(),s=debtPlan(p),position=simParams(),current=simulate(position);
  $('debt-note').textContent=p['debt-type']==='margin'?'已选择券商融资融券：本页只测算现金缺口。缺少担保品折算率、合约与维持担保比例，不能计算强平线。':'普通借款按本息、可用现金与到期日测算，不计算券商强平价。';
  const due=p.due?Math.ceil((Date.parse(p.due+'T00:00:00+08:00')-Date.parse(today()+'T00:00:00+08:00'))/864e5):null;
  $('risk-result').innerHTML='<div class="risk-highlight"><span>覆盖债务并保留安全垫所需卖出</span><b>'+(Number(p.sellPrice)>0?fmt(s.needed,0)+' 股':'填写卖出价')+'</b><p>'+(s.sufficient?'当前股数可覆盖该偿债假设':'当前持股不足以覆盖缺口')+(due==null?'':due<0?' · 到期日已过 '+Math.abs(due)+' 天':' · 距到期 '+due+' 天')+'</p></div><div class="risk-metrics">'+resultLine('当前持仓市值',Number(position.base)>0?money(current.currentValue):'—')+resultLine('相对实际持仓成本盈亏',finite(position.cost)&&Number(position.base)>0?money((Number(position.base)-Number(position.cost))*Number(position.shares)):'未填持仓成本')+resultLine('本次假设卖出 / 剩余',fmt(s.sold,0)+' / '+fmt(s.remaining,0)+' 股')+resultLine('卖出并偿债后的现金',money(s.afterCash),tone(s.afterCash))+resultLine('距离安全垫尚缺',money(s.shortfall),s.shortfall>0?'down':'')+resultLine('剩余仓位再跌 10% 的损失',money(s.risk[0]),'down')+resultLine('剩余仓位再跌 20% 的损失',money(s.risk[1]),'down')+resultLine('剩余仓位再跌 30% 的损失',money(s.risk[2]),'down')+'</div>';
  $('positions-table').innerHTML=rowsTable(['保存时间 / 方案','股数','成本价','借款本息','卖出价',''],state.positions.filter(v=>v.symbol===state.stock.symbol).map(v=>[esc(v.name)+'<small>'+dateText(v.at)+'</small>',fmt(v.form.shares,0),fmt(v.form.cost),money(v.form.debt),fmt(v.form['sell-price']),'<button data-position="'+esc(v.id)+'">载入</button>　<button data-delete-position="'+esc(v.id)+'">删除</button>']));
}
function renderSaved(){
  $('saved-table').innerHTML=rowsTable(['股票 / 情景','起涨价','反弹幅度','目标价','个人持仓市值','公司市值 · 亿','假设 PE','保存时基准',''],state.scenarios.map(v=>{const s=savedScenarioCalculation(v);return[esc(v.stock.name)+' · '+esc(v.name)+'<small>'+dateText(v.at)+'</small>',fmt(v.params.low),fmt(v.params.rebound,0)+'%',fmt(s.target),money(s.value),fmt(s.marketCap),fmt(s.pe),fmt(v.params.base),'<button data-load-scenario="'+esc(v.id)+'">载入</button>　<button data-delete-scenario="'+esc(v.id)+'">删除</button>'];}));
}
function setMode(mode,remember=true){
  state.mode=workspaceMode(mode);if(state.mode!=='normal')state.waveMode=state.mode;
  state.tab=state.mode==='normal'?'overview':'wave';$('action-menu').open=false;
  if($('more-dialog').open)$('more-dialog').close();
  if(remember){state.settings.lastMode=state.mode;persist('settings',state.settings);scheduleSave();}
  renderSim();
}
function activateTab(tab){
  if(tab==='overview'||tab==='wave'){setMode(tab==='wave'?state.waveMode:'normal');return;}
  state.tab=tab;$$('[data-tab]').forEach(el=>el.classList.toggle('active',el.dataset.tab===tab));$$('[data-panel]').forEach(el=>el.hidden=el.dataset.panel!==tab);
  if(!$('more-dialog').open)$('more-dialog').showModal();renderActive();
}
function renderActive(){if(state.tab==='market')renderMarket();if(state.tab==='history'){renderHistory();renderMapping();}if(state.tab==='backtest')renderBacktest();if(state.tab==='valuation')renderValuation();if(state.tab==='risk')renderRisk();if(state.tab==='saved')renderSaved();renderWorkspace();}
function applyTheme(){document.documentElement.dataset.theme=state.settings.theme||'dark';if(state.settings.reverse){const style=chartColors();document.documentElement.style.setProperty('--up',state.settings.theme==='light'?'#21845e':'#78c6a2');document.documentElement.style.setProperty('--down',state.settings.theme==='light'?'#c24f43':'#f18c7f');}else{document.documentElement.style.removeProperty('--up');document.documentElement.style.removeProperty('--down');}$('color-toggle').textContent=state.settings.reverse?'绿涨红跌':'红涨绿跌';$('theme-toggle').textContent=state.settings.theme==='light'?'☾ 切换深色':'☼ 切换浅色';renderQuote();drawChart();renderActive();}
function scenarioRows(){const p=simParams();return[['股票',state.stock.name,state.stock.symbol],['最新行情时间',dateText(state.quote?.time)],['参考高点（元）',finite(p.high)?Number(p.high):'未填'],['假设低点（元）',Number(p.low)],['持股（股）',Number(p.shares)],['比较基准价（元）',finite(p.base)?Number(p.base):'未填'],['历史参考口径',state.nominal?.referenceLabel||'未获取'],[],['从低点反弹（%）','目标价（元）','较比较基准（%）','持仓市值（元）'],...matrixRows().map(v=>[v.r,v.target,Number(p.base)>0?v.fromBase*100:'未填基准',v.value]),[],['说明','数学情景，不代表未来价格。']];}
async function exportBackup(){await saveForm();const data=await storage.getAll();download('回撤研究室-本机备份-'+today()+'.json',JSON.stringify({app:'stock-rebound-lab',version:1,exportedAt:new Date().toISOString(),data},null,2),'application/json');toast('备份已导出，包含本机持仓设置');}
function historyCSV(){const h=state.history;if(!h)return toast('暂无历史数据可导出');const rows=[['symbol','adjust','time','open','high','low','close','volume','amount'],...h.bars.map(b=>[state.stock.symbol,h.adjust,b.time,b.open,b.high,b.low,b.close,b.volume,b.amount])];download(state.stock.symbol+'-'+h.adjust+'-日线.csv',csv(rows),'text/csv;charset=utf-8');}
async function importData(file){
  if(!file)return;if(file.size>20*1024*1024)throw new Error('文件超过20MB，请拆分后导入');const text=await file.text();
  if(file.name.toLowerCase().endsWith('.json')){
    const backup=JSON.parse(text);if(backup.app!=='stock-rebound-lab'||backup.version!==1||!backup.data||typeof backup.data!=='object')throw new Error('不是有效的 v1 研究室备份');
    const entries=Object.entries(backup.data).filter(([k])=>/^(watch|selected|settings|scenarios|positions|quote:\d{6}\.(SZ|SH|BJ)|form:\d{6}\.(SZ|SH|BJ)|history:\d{6}\.(SZ|SH|BJ):(qfq|hfq|none))$/.test(k));
    if(entries.length>1000)throw new Error('备份记录过多');
    const validStock=v=>v&&/^\d{6}\.(SZ|SH|BJ)$/.test(v.symbol)&&typeof v.name==='string'&&v.name.length<=80;
    for(const[k,v]of entries){
      if(k.startsWith('history:')){if(!v||!['qfq','hfq','none'].includes(v.adjust)||!k.startsWith('history:'+v.symbol+':'))throw new Error('历史股票/口径无效');v.bars=validateBars(v.bars);if(v.bars.length>12000)throw new Error('单只股票日线超过12000条');v.source='用户导入备份 · '+String(v.source||'来源未知').slice(0,60);}
      if(['watch','scenarios','positions'].includes(k)&&!Array.isArray(v))throw new Error('备份列表格式无效');
      if(k==='watch'&&v.some(s=>!validStock(s)))throw new Error('自选股格式无效');
      if(k==='selected'&&!validStock(v))throw new Error('所选股票无效');
      if(k==='scenarios'&&v.some(s=>!s||typeof s.id!=='string'||!validStock(s.stock)||!s.params||typeof s.params!=='object'))throw new Error('情景档案格式无效');
      if(k==='positions'&&v.some(s=>!s||typeof s.id!=='string'||!/^\d{6}\.(SZ|SH|BJ)$/.test(s.symbol)||!s.form||typeof s.form!=='object'))throw new Error('持仓方案格式无效');
      if((k.startsWith('form:')||k==='settings')&&(!v||typeof v!=='object'||Array.isArray(v)))throw new Error('设置格式无效');
      if(k.startsWith('quote:')&&(!v||k!=='quote:'+v.symbol||!(Number(v.price)>0)||!Number.isFinite(Date.parse(v.time))))throw new Error('缓存行情格式无效');
    }
    for(const[k,v]of entries)await persist(k,v);
    toast('备份已导入，正在恢复研究');await initialize(true);return;
  }
  const rows=parseCSV(text);if(rows.length<3)throw new Error('CSV 至少需要表头和2条日线');const headers=rows[0].map(s=>s.trim().toLowerCase());const aliases={time:['time','date','日期'],open:['open','开盘'],high:['high','最高'],low:['low','最低'],close:['close','收盘'],volume:['volume','成交量'],amount:['amount','成交额']};
  const columns=Object.fromEntries(Object.entries(aliases).map(([k,ns])=>[k,headers.findIndex(h=>ns.includes(h))]));if(['time','open','high','low','close'].some(k=>columns[k]<0))throw new Error('CSV 必须包含 time/date、open、high、low、close（也支持中文日期、开盘、最高、最低、收盘）');
  const si=headers.indexOf('symbol'),ai=headers.indexOf('adjust');const symbol=si>=0?rows[1][si]:state.stock.symbol,adjust=ai>=0?rows[1][ai]:null;
  if(symbol!==state.stock.symbol)throw new Error('CSV 股票与当前股票不同，请先切换到 '+symbol);if(!['qfq','hfq','none'].includes(adjust))throw new Error('CSV 需增加 adjust 列，明确 qfq（前复权）/ hfq / none，不能推断复权口径');
  if(rows.slice(1).some(r=>(si>=0&&r[si]!==symbol)||r[ai]!==adjust))throw new Error('同一 CSV 不能混入不同股票或复权口径');
  const bars=validateBars(rows.slice(1).map(r=>Object.fromEntries(Object.entries(columns).map(([k,i])=>[k,i<0?null:r[i]]))));if(bars.length>12000)throw new Error('日线超过12000条');
  const h={symbol,adjust,bars,source:'用户导入 CSV（真实性未验证）',fetchedAt:new Date().toISOString(),basis:'import:'+adjust,complete:false,start:bars[0].time,end:bars.at(-1).time};await persist('history:'+symbol+':'+adjust,h);$('adjust').value=adjust;state.history=h;if(adjust==='qfq')state.nominal=h;state.start='';state.end='';updateHistory();renderSim();warn('history','当前使用用户导入的历史数据，其真实性与完整性未经行情源验证');toast('已导入 '+bars.length+' 条日线');
}
function report(){renderRisk();renderBacktest();const p=simParams(),active=currentResult(),e=maxDrawdown(state.bars),b=state.bars;const activeTable=active.valid?rowsTable(['当前测算','数值'],[[active.labels[0],fmt(active.high)+' 元'],[active.labels[1],fmt(active.low)+' 元'],[active.labels[2],fmt(active.target)+' 元'],['从假设低点涨幅',pct(active.rise)],['目标持仓市值',money(active.value)],['计算公式',esc(active.formula)]]):'<p>'+esc(active.error)+'</p>';const doc='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>股票研究报告</title><style>body{font:14px/1.8 system-ui;max-width:1100px;margin:40px auto;padding:20px;color:#253021}h1{font-size:27px}h2{margin-top:30px}table{border-collapse:collapse;width:100%;font-size:12px}th,td{border:1px solid #dce3d7;padding:9px;text-align:right}th:first-child,td:first-child{text-align:left}small,p{color:#687461}button{display:none}@media print{body{margin:0}}</style><h1>'+esc(state.stock.name)+' · 历史回撤与反弹研究</h1><p>'+esc(state.stock.symbol)+' · 生成 '+dateText(new Date())+'</p><p>行情来源：'+esc(state.quote?.source||'无')+'；行情时间：'+dateText(state.quote?.time)+'；历史：'+esc(state.history?.source||'无')+'，'+adjustLabel(state.history?.adjust)+'，覆盖 '+(b.length?b[0].time+' 至 '+b.at(-1).time:'无')+'。'+(state.history?.complete?'源返回未截断。':'数据完整性未确认。')+'</p><h2>当前选中测算</h2>'+activeTable+'<h2>按涨幅测算与原有研究参数</h2>'+rowsTable(['参数','数值'],[['起涨价',fmt(p.low)+' 元'],['股数',fmt(p.shares,0)+' 股'],['成本',fmt(p.cost)+' 元'],['基准价',fmt(p.base)+' 元'],['公司股本',fmt(p.capital,4)+' 亿股'],['归母利润假设',fmt(p.profit)+' 亿元（用户手动假设）']])+rowsTable(['反弹','目标价','持仓市值','较基准变化','公司市值 · 亿','假设PE'],matrixRows().map(v=>[v.r+'%',fmt(v.target),money(v.value),money(v.change),fmt(v.marketCap),fmt(v.pe)]))+'<h2>历史最大回撤（收盘价）</h2><p>'+(e?fmt(e.drawdown*100)+'%；'+b[e.peak].time+' → '+b[e.trough].time+'；历时 '+e.days+' 个交易日。':'数据不足')+'</p><h2>历史事件研究</h2><p>阈值 '+esc($('bt-threshold').value)+'%，窗口 '+esc($('bt-window').value)+' 个交易日；触发 '+esc($('bt-trigger').selectedOptions[0].text)+'；过去高点范围 '+esc($('bt-lookback').selectedOptions[0].text)+'；首次穿越 '+($('bt-first').checked?'是':'否')+'；排除重叠 '+($('bt-overlap').checked?'是':'否')+'；放量筛选 '+($('bt-volume').checked?'是':'否')+'。完整样本 '+(state.study?.n||0)+'；平均涨跌 '+pct(state.study?.mean)+'；中位数 '+pct(state.study?.median)+'。样本比例不能视为未来概率。</p><h2>现金与持仓</h2>'+document.getElementById('risk-result').innerHTML+'<h2>研究边界</h2><p>此功能仅复现历史价格路径的数学比例，不代表未来一定重演。低点与反弹峰值为事后识别；回测使用触发日收盘基准且排除未满窗口的样本，不含费率滑点；利润和未来价格是用户假设。本报告仅为计算记录。</p></html>';download(state.stock.symbol+'-研究报告-'+today()+'.html',doc,'text/html;charset=utf-8');toast('已导出可打印为 PDF 的分析报告');}
async function searchStocks(){const q=$('search').value.trim(),version=++searchGeneration;if(!q){$('search-results').innerHTML='';return;}$('search-results').innerHTML='<div class="empty">搜索中…</div>';try{const r=await api('search',{q});if(version!==searchGeneration)return;$('search-results').innerHTML=r.items.length?r.items.map(s=>'<button class="search-result" data-result-symbol="'+esc(s.symbol)+'" data-result-name="'+esc(s.name)+'">'+esc(s.name)+'<small>'+esc(s.symbol)+'</small></button>').join(''):'<div class="empty">未找到沪深京 A 股</div>';}catch(e){if(version===searchGeneration)$('search-results').innerHTML='<div class="empty">'+esc(e.message)+'</div>';}}
function bind(){
  document.addEventListener('click',async event=>{const el=event.target.closest('button');if(!el)return;try{
    if(el.dataset.close)$(el.dataset.close).close();
    if(el.dataset.tab)activateTab(el.dataset.tab);if(el.dataset.openTab)activateTab(el.dataset.openTab);
    if(el.dataset.stock){const s=state.watch.find(s=>s.symbol===el.dataset.stock);$('stock-dialog').close();if(s&&s.symbol!==state.stock.symbol)await loadStock({...s});}
    if(el.dataset.resultSymbol){const stock={symbol:el.dataset.resultSymbol,name:el.dataset.resultName};if(!state.watch.some(s=>s.symbol===stock.symbol)){state.watch.push(stock);await persist('watch',state.watch);}$('search').value='';$('search-results').innerHTML='';$('stock-dialog').close();await loadStock(stock);}
    if(el.dataset.rebound){$('rebound').value=el.dataset.rebound;renderSim();scheduleSave();}
    if(el.dataset.mapLow){$('low').value=Number(el.dataset.mapLow).toFixed(3);$('rebound').value=el.dataset.mapRebound;renderSim();scheduleSave();toast('已应用回撤映射假设');}
    if(el.dataset.period){state.period=el.dataset.period;$$('[data-period]').forEach(b=>b.classList.toggle('active',b===el));drawChart();}
    if(el.dataset.range){state.range=el.dataset.range;$$('[data-range]').forEach(b=>b.classList.toggle('active',b===el));drawChart();}
    if(el.dataset.event){state.selectedEvent=Number(el.dataset.event);renderEventDetail();}
    if(el.id==='apply-event'){const e=state.events[state.selectedEvent],a=Number($('mapping-anchor').value),m=mapEvent(e,a);if(!(a>0)||m.firstLow==null)return toast('请先输入有效映射锚点');$('reference-high').value=a;state.autoHigh=false;$('low').value=m.firstLow.toFixed(3);$('rebound').value=(m.reboundGain*100).toFixed(2);activateTab('overview');renderSim();scheduleSave();toast('历史比例已应用，仅作为假设路径');}
    if(el.dataset.loadScenario){const s=state.scenarios.find(s=>s.id===el.dataset.loadScenario);if(s){if(s.stock.symbol!==state.stock.symbol)await loadStock({...s.stock});for(const id of(s.wave?['shares','cost','base','capital','profit']:simIds))$(id).value=s.params[id]??(id==='reference-high'?s.params.high:'')??'';if(!s.wave)state.autoHigh=false;state.autoBase=false;state.autoCapital=false;if(s.wave){restoreWave(s.wave);activateTab('wave');}else activateTab('overview');scheduleSave();toast('已载入保存时的假设参数');}}
    if(el.dataset.deleteScenario){state.scenarios=state.scenarios.filter(s=>s.id!==el.dataset.deleteScenario);await persist('scenarios',state.scenarios);renderSaved();toast('情景已移除');}
    if(el.dataset.position){const p=state.positions.find(p=>p.id===el.dataset.position);if(p){for(const id of [...simIds,...riskIds]){if($(id).type==='checkbox')$(id).checked=p.form[id]!==false;else $(id).value=p.form[id]??'';}state.autoHigh=!finite(p.form['reference-high']);state.autoBase=false;state.autoCapital=false;state.autoSell=false;setMode('normal');renderSim();renderRisk();scheduleSave();toast('持仓方案已载入');}}
    if(el.dataset.deletePosition){state.positions=state.positions.filter(p=>p.id!==el.dataset.deletePosition);await persist('positions',state.positions);renderRisk();toast('持仓方案已移除');}
  }catch(e){toast(e.message||'操作未完成');}});
  $('search-form').addEventListener('submit',e=>{e.preventDefault();clearTimeout(searchTimer);searchStocks();});$('search').addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(searchStocks,450);});$('search').addEventListener('keydown',e=>{if(e.key==='Escape'){$('search-results').innerHTML='';searchGeneration++;}});
  bindWave();$('chart-indicators').onchange=drawChart;$('use-history-high').onclick=()=>{state.autoHigh=true;renderSim();scheduleSave();};
  $('stock-switch').onclick=()=>{$('stock-dialog').showModal();$('search').focus();};$('holding-edit').onclick=()=>{$('holding-dialog').showModal();$('shares').focus();};$('more-open').onclick=()=>activateTab('market');
  $('more-dialog').addEventListener('close',()=>{state.tab=state.mode==='normal'?'overview':'wave';renderWorkspace();});
  for(const id of['stock-dialog','holding-dialog','more-dialog'])$(id).addEventListener('click',e=>{const r=$(id).getBoundingClientRect();if(e.target===$(id)&&(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom))$(id).close();});
  $('history-details').addEventListener('toggle',()=>{if($('history-details').open)drawChart();});
  $('refresh').onclick=()=>refreshData(true);
  $('favorite').onclick=async()=>{const found=state.watch.some(s=>s.symbol===state.stock.symbol);state.watch=found?state.watch.filter(s=>s.symbol!==state.stock.symbol):[...state.watch,{...state.stock}];await persist('watch',state.watch);renderWatch();renderQuote();toast(found?'已移出自选':'已加入自选');};
  $('theme-toggle').onclick=()=>{state.settings.theme=state.settings.theme==='light'?'dark':'light';applyTheme();persist('settings',state.settings);};$('color-toggle').onclick=()=>{state.settings.reverse=!state.settings.reverse;applyTheme();persist('settings',state.settings);};
  simIds.forEach(id=>$(id).addEventListener('input',()=>{if(id==='reference-high')state.autoHigh=false;if(id==='base')state.autoBase=false;if(id==='capital')state.autoCapital=false;renderSim();scheduleSave();}));$('rebound-range').oninput=()=>{$('rebound').value=$('rebound-range').value;renderSim();scheduleSave();};
  $('low-presets').onchange=()=>{if($('low-presets').value){$('low').value=Number($('low-presets').value).toFixed(3);renderSim();scheduleSave();}};
  $('adjust').onchange=async()=>{state.generation++;const generation=state.generation;state.history=null;state.bars=[];updateHistory();const h=await storage.get('history:'+state.stock.symbol+':'+$('adjust').value);if(generation!==state.generation)return;if(h){state.history={...h,local:true};updateHistory();}await refreshData(false,generation);};
  $('range-apply').onclick=()=>{const a=$('range-start').value,z=$('range-end').value;if(a&&z&&a>z)return toast('起日应早于或等于止日');state.start=a;state.end=z;updateHistory();renderSim();};$('range-reset').onclick=()=>{state.start='';state.end='';$('range-start').value='';$('range-end').value='';updateHistory();renderSim();};
  $('pick-range').onclick=()=>{state.picking=!state.picking;state.picks=[];$('pick-range').textContent=state.picking?'取消选取':'选取高低点';$('manual-selection').textContent=state.picking?'请先点击图中高点，再点击后续低点':'';};
  ['dd-mode','dd-threshold'].forEach(id=>$(id).addEventListener('change',renderHistory));['bt-threshold','bt-window','bt-trigger','bt-lookback','bt-first','bt-overlap','bt-volume'].forEach(id=>$(id).addEventListener('change',renderBacktest));
  document.addEventListener('input',e=>{if(e.target.id==='mapping-anchor')renderMapping();});
  $('valuation-pe').onchange=renderValuation;$('valuation-year').onchange=renderValuationMatrix;
  $('valuation-table').addEventListener('input',e=>{const k=e.target.dataset.forecast,year=Number(e.target.dataset.year);if(k){const r=state.forecasts.find(r=>r.year===year);r[k]=e.target.value;updateForecastResults();scheduleSave();}});
  riskIds.forEach(id=>$(id).addEventListener('input',()=>{if(id==='sell-price')state.autoSell=false;renderRisk();scheduleSave();}));
  $('save-scenario').onclick=async()=>{const result=currentResult();if(!result.valid)return toast(result.error);const wave=state.mode!=='normal',p=wave?wavePriceParameters():simParams();const record={id:crypto.randomUUID(),stock:{...state.stock},name:wave?(state.waveMode==='fifth'?'五浪长度 '+$('wave-fifth-ratio').value+'%':'ABC 回补 '+$('wave-b-ratio').value+'%'):fmt(Number(p.low))+' 起涨 / +'+p.rebound+'%',at:new Date().toISOString(),params:p,source:state.history?.source||null,historyBasis:state.history?.basis||null,quoteTime:state.quote?.time||null};if(wave)record.wave={...fieldValues(waveIds),mode:state.waveMode};state.scenarios.unshift(record);await persist('scenarios',state.scenarios);renderSaved();toast('情景已保存，可在其他操作中查看');};
  $('copy-result').onclick=async()=>{const r=currentResult();if(!r.valid)return toast(r.error);const text=state.stock.name+' '+state.stock.symbol+'\n'+r.labels[0]+' '+fmt(r.high)+' 元 → '+r.labels[1]+' '+fmt(r.low)+' 元 → '+r.labels[2]+' '+fmt(r.target)+' 元\n实际从假设低点涨幅 '+pct(r.rise)+'；持股 '+$('shares').value+' 股；目标持仓市值 '+money(r.value)+'\n计算：'+r.formula+'\n未来价格为数学情景假设。';try{await navigator.clipboard.writeText(text);toast('当前测算结果已复制');}catch{showInfo('<p style="white-space:pre-wrap">'+esc(text)+'</p>');}$('action-menu').open=false;};
  $('save-position').onclick=async()=>{state.positions.unshift({id:crypto.randomUUID(),symbol:state.stock.symbol,name:'持仓 '+(state.positions.filter(p=>p.symbol===state.stock.symbol).length+1),at:new Date().toISOString(),form:fieldValues([...simIds,...riskIds])});await persist('positions',state.positions);renderRisk();toast('持仓方案已保存');};
  $('export-xlsx').onclick=()=>{if(state.mode!=='normal'){exportWave();return;}download(state.stock.symbol+'-反弹情景-'+today()+'.xlsx',makeXLSX(scenarioRows()));toast('Excel 情景文件已导出');};$('import-file').onchange=async()=>{try{await importData($('import-file').files[0]);}catch(e){toast(e.message);}finally{$('import-file').value='';}};
  $('backup-mobile').onclick=exportBackup;$('import-mobile').onclick=()=>$('import-file').click();$('export-history').onclick=historyCSV;$('report').onclick=report;$('export-backtest').onclick=()=>{const s=state.study;if(!s?.signals.length)return toast('没有可导出的事件样本');download(state.stock.symbol+'-事件回测.csv',csv([['日期','基准收盘','窗口完整','后续涨跌比例','MFE比例','MAE比例','再创新低'],...s.signals.map(v=>[v.date,v.entry,v.complete?'是':'否',v.return,v.mfe,v.mae,v.newLow==null?'':v.newLow?'是':'否'])]),'text/csv;charset=utf-8');};
  $('methodology').onclick=()=>showInfo('<p>行情通过本站同源 <code>/api/stock</code> 代理公开数据；行情优先腾讯、备用东方财富，日线优先东方财富、备用腾讯分页。数据以提供方时间为准，可能延迟，不提供交易所 Level-2。主备源都失败时，使用本浏览器缓存并显示原始时间。</p><p>默认前复权。不复权不适合跨除权日比较。不同源和复权口径的日线整批替换，不拼接；前复权遇非正价格自动整段转后复权并提示；价格预设以同一完成交易日不复权/后复权之比等比归一（不是传统前复权）。前复权随除权事件重算，因此刷新整段历史而非仅追加。日周月图由同一份日线聚合；所有回撤与事件统计使用日线。价格映射、低点预设与估值默认使用当前口径的前复权参考，不直接拿后复权价当当前交易价格。</p><p>回撤先有高点、后有低点。日内口径只比较前一交易日及以前高点与之后最低价。事件恢复前高后结束，未恢复保留为同一轮。统计严格限定在已加载区间，不承诺被截断或导入的数据覆盖全部上市历史。最后一个尚未收盘的交易日不进入事件回测。</p><p>股票设置和行情按代码、复权口径分别存储。持仓、债务、利润参数只保存在本浏览器，不发送到行情服务。首次联网后会缓存页面用于离线访问；无痕模式或清除站点数据可能移除记录。</p><p>股本来源为最新行情快照，目标公司市值假定未来股本不变。所有预测利润均为用户假设；亏损或零利润时 PE 不适用。偿债综合费率须自行填写，不能代替真实交割费用。</p><p>新易盛的 194 元、618.87 元是需求中提供的研究参考；618.87 元不作为计算出的历史高点。默认 7000 股、180 亿元利润仅初始化新易盛的研究参数，不表示真实持仓或机构预测。其他股票不继承这些值。</p><p>资料：<a href="https://akshare.akfamily.xyz/data/stock/stock_quote.html" target="_blank" rel="noopener">AKShare 数据源文档</a> · <a href="https://www.tradingview.com/" target="_blank" rel="noopener">TradingView Lightweight Charts™</a>。本工具没有交易权限。</p>');$('close-dialog').onclick=()=>$('info-dialog').close();$('info-dialog').addEventListener('click',e=>{if(e.target===$('info-dialog'))$('info-dialog').close();});
  window.addEventListener('offline',()=>{renderQuote();warn('offline','当前离线，使用已保存数据；可继续计算与导出');});window.addEventListener('online',()=>{warn('offline','');refreshData();});
  window.addEventListener('pagehide',()=>saveForm());
}
function showInfo(html){$('info-content').innerHTML=html;$('info-dialog').showModal();}
async function initialize(reload=false){
  if(!reload)await storage.openStorage();const [watch,selected,settings,scenarios,positions]=await Promise.all(['watch','selected','settings','scenarios','positions'].map(storage.get));
  state.watch=Array.isArray(watch)?watch:defaults.map(s=>({...s}));state.settings=settings||{};state.mode=workspaceMode(state.settings.lastMode);if(state.mode!=='normal')state.waveMode=state.mode;state.scenarios=Array.isArray(scenarios)?scenarios:[];state.positions=Array.isArray(positions)?positions:[];if(reload){clearTimeout(saveTimer);state.skipSave=true;}
  applyTheme();$('storage-info').textContent=storage.storageMode+' · 数据结构 v1 · 按股票与复权口径分开保存';
  const selectedStock=selected&&/^\d{6}\.(SH|SZ|BJ)$/.test(selected.symbol)?selected:defaults[0];await loadStock({...selectedStock});
}
bind();initialize().catch(e=>{warn('init','初始化未完成：'+e.message);$('refresh').disabled=false;});
if('serviceWorker'in navigator)navigator.serviceWorker.register('./sw.js').catch(()=>warn('sw','浏览器未允许离线页面缓存；本机研究数据仍可保存'));
setInterval(async()=>{const china=new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Shanghai'})),mins=china.getHours()*60+china.getMinutes();if(!navigator.onLine||document.hidden||state.busy||china.getDay()===0||china.getDay()===6||!((mins>=570&&mins<=690)||(mins>=780&&mins<=905)))return;const generation=state.generation;try{const q=await api('quote',{symbol:state.stock.symbol});if(generation!==state.generation)return;state.quote=q;setFromQuote(q);renderQuote();renderSim();await persist('quote:'+state.stock.symbol,q);}catch{/* Visible snapshot retains its actual timestamp. */}},60000);
