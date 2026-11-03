import {ratio,historyModel,marketWindow,valid} from './model.mjs';
import {chartOption,fmt,compact,esc} from './charts.mjs';
const $=id=>document.getElementById(id),$$=q=>[...document.querySelectorAll(q)];
const seed=[['510300.SH','华泰柏瑞沪深300ETF'],['510310.SH','易方达沪深300ETF'],['300502.SZ','新易盛'],['300308.SZ','中际旭创'],['300750.SZ','宁德时代']].map(([symbol,name])=>({symbol,name}));
const key='volume-lab-v1',safeSymbol=s=>typeof s==='string'&&/^(?:(?:60|68|50|51|52|56|58)\d{4}\.SH|(?:00|30)\d{4}\.SZ|159\d{3}\.SZ)$/.test(s);
let saved={};try{saved=JSON.parse(localStorage.getItem(key)||'{}')||{};}catch{}
const state={watch:Array.isArray(saved.watch)?saved.watch.filter(x=>x&&safeSymbol(x.symbol)&&typeof x.name==='string').slice(0,40):seed,
  symbols:[safeSymbol(saved.symbols?.[0])?saved.symbols[0]:seed[0].symbol,safeSymbol(saved.symbols?.[1])?saved.symbols[1]:seed[1].symbol],
  layout:saved.layout==='single'?'single':'double',view:saved.view==='history'?'history':'intraday',mode:saved.mode==='window'?'window':'cum',days:[60,120,250].includes(saved.days)?saved.days:120,
  theme:saved.theme==='light'?'light':'dark',focus:0,cache:new Map(),charts:new Map(),chartKeys:new Map(),generation:0,errors:new Map(),busy:false};
let timer,controller,searchController,searchTimer,searchGeneration=0,toastTimer;
function persist(){try{localStorage.setItem(key,JSON.stringify(Object.fromEntries(['watch','symbols','layout','view','mode','days','theme'].map(k=>[k,state[k]]))));}catch{toast('浏览器未允许保存自选，当前页面仍可使用');}}
function toast(text){$('toast').textContent=text;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,2600);}
function cacheGet(k){const row=state.cache.get(k);if(!row)return null;if(Date.now()-row.at>300000){state.cache.delete(k);return null;}state.cache.delete(k);state.cache.set(k,row);return row;}
function cacheSet(k,data){state.cache.delete(k);state.cache.set(k,{data,at:Date.now()});while(state.cache.size>12)state.cache.delete(state.cache.keys().next().value);}
const timeText=v=>v&&Number.isFinite(Date.parse(v))?new Date(v).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'时间未提供';
const pct=v=>valid(v)?(v>0?'+':'')+fmt(v)+'%':'—';
const multiple=v=>valid(v)?fmt(v)+'×':'—';
const tone=v=>v>0?'up':v<0?'down':'';
const nameFor=s=>state.watch.find(x=>x.symbol===s)?.name||seed.find(x=>x.symbol===s)?.name||s.slice(0,6);
const read=(action,symbol)=>cacheGet(action+':'+symbol)?.data;
const historyModels=new WeakMap();
function modelFor(data){if(!data)return null;let models=historyModels.get(data);if(!models){models=new Map();historyModels.set(data,models);}if(!models.has(state.days))models.set(state.days,historyModel(data,state.days));return models.get(state.days);}
function renderWatch(){
  $$('[data-panel]').forEach(el=>el.classList.toggle('focused',Number(el.dataset.panel)===state.focus));
  $('watchlist').innerHTML=state.watch.map(x=>'<button class="watch-chip '+(state.symbols[state.focus]===x.symbol?'active':'')+'" data-pick="'+esc(x.symbol)+'">'+esc(x.name)+'<small>'+x.symbol.slice(0,6)+'</small></button>').join('');
  $('search-watchlist').innerHTML=state.watch.map(x=>'<div class="favorites-row"><button class="search-result" data-pick="'+esc(x.symbol)+'"><span>'+esc(x.name)+'</span><small>'+esc(x.symbol)+'</small></button><button class="remove-watch" data-remove="'+esc(x.symbol)+'" aria-label="移除'+esc(x.name)+'">×</button></div>').join('')||'<div class="empty">搜索标的，添加到自选。</div>';
  $('compare-note').textContent=state.layout==='double'?'自选切换'+(state.focus?'右图':'左图')+' · 时间联动':'自选切换当前图';
}
function controls(){
  document.documentElement.dataset.theme=state.theme;$('theme').textContent=state.theme==='dark'?'☼':'☾';
  for(const key of ['layout','view','mode','days'])$$('[data-'+key+']').forEach(b=>{const active=String(state[key])===b.dataset[key];b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});
  $('intraday-options').hidden=state.view!=='intraday';$('history-options').hidden=state.view!=='history';
  $('panels').classList.toggle('double',state.layout==='double');renderWatch();
}
const panelHTML=i=>'<section class="instrument-panel" data-panel="'+i+'" aria-label="'+(i?'右图':'左图')+'量能"><div class="panel-top"><div class="panel-label"><span class="panel-slot">'+(i?'B / 右图':'A / 左图')+'</span><button class="picker" data-select="'+i+'" aria-label="更换'+(i?'右图':'左图')+'标的"><strong id="name-'+i+'"></strong><span class="arrow">⌄</span></button></div><div id="meta-'+i+'" class="stock-meta"></div><div class="quote-line"><b id="price-'+i+'" class="quote-price">—</b><span id="change-'+i+'" class="quote-change">—</span></div><div id="quote-time-'+i+'" class="quote-time"></div><div id="metrics-'+i+'" class="panel-metrics"></div></div><div class="chart-caption"><span id="chart-title-'+i+'"></span><small id="chart-subtitle-'+i+'"></small></div><div class="chart-wrap"><div id="chart-'+i+'" class="chart" role="img" aria-label="'+(i?'右图':'左图')+'量能走势图"></div><div id="empty-'+i+'" class="chart-placeholder">正在读取数据…</div></div><div id="note-'+i+'" class="panel-note"></div><div id="warning-'+i+'" class="panel-warning" hidden></div><div class="source-line"><span id="source-'+i+'"></span><span id="status-'+i+'"></span></div><details class="more-quote"><summary>更多行情与数据状态</summary><div id="more-'+i+'" class="quote-grid"></div></details></section>';
function ensurePanels(){
  const count=state.layout==='double'?2:1;
  for(let i=0;i<2;i++){
    if(i<count&&!$('chart-'+i))$('panels').insertAdjacentHTML('beforeend',panelHTML(i));
    if(i>=count&&$('chart-'+i)){observer.unobserve($('chart-'+i));state.charts.get(i)?.dispose();state.charts.delete(i);state.chartKeys.delete(i);$('chart-'+i).closest('section').remove();}
    if(i<count)observer.observe($('chart-'+i));
  }
}
function draw(i,data,unit){
  const calendar=state.view==='history'&&state.layout==='double'?[...new Set(state.symbols.flatMap(s=>modelFor(read('history',s))?.rows.map(p=>p.date)||[]))].sort().slice(-state.days):null;
  const signature=JSON.stringify([state.symbols[i],state.view,state.mode,state.days,state.theme,calendar,state.view==='history'?[data.daily,data.asOf]:[data.timeline,data.tradeDate]]);
  if(state.chartKeys.get(i)===signature)return;
  if(!window.echarts){$('empty-'+i).hidden=false;$('empty-'+i).textContent='图表组件未加载，请刷新页面';return;}
  let chart=state.charts.get(i);if(!chart){chart=echarts.init($('chart-'+i));chart.group='volume-lab-comparison';state.charts.set(i,chart);echarts.connect('volume-lab-comparison');}
  const option=chartOption(state.view,data,{...state,calendar,prepared:state.view==='history'?modelFor(data):null},unit);if(!option)return;
  chart.setOption(option,{notMerge:true,lazyUpdate:false});state.chartKeys.set(i,signature);
}
function renderPanel(i){
  const symbol=state.symbols[i],d=read('detail',symbol),h=read('history',symbol),q=d?.quote,p=d?.latest,unit=d?.instrument.unit||(symbol.startsWith('5')||symbol.startsWith('159')?'份':'股'),history=state.view==='history',model=history?modelFor(h):null;
  $('name-'+i).textContent=d?.instrument.name||nameFor(symbol);$('meta-'+i).innerHTML='<span>'+esc(symbol)+'</span> · '+(unit==='份'?'ETF':'股票');
  const price=q?.price??p?.price??h?.daily.at(-1)?.close;
  $('price-'+i).innerHTML=fmt(price,unit==='份'?3:2)+'<small>元</small>';$('price-'+i).className='quote-price '+tone(q?.changePct);
  $('change-'+i).textContent=pct(q?.changePct);$('change-'+i).className='quote-change '+tone(q?.changePct);
  $('quote-time-'+i).textContent=q?.time?'报价 '+timeText(q.time):h?'日K数据 · '+h.daily.at(-1).date:'等待最新报价';
  const metric=(label,value,accent=false)=>'<div><span>'+label+'</span><b class="'+(accent?'accent':'')+'">'+value+'</b></div>';
  $('metrics-'+i).innerHTML=history?metric(model?.live?'当日累计量 · 未收盘':'最近日成交量',compact(model?.latest.volume,unit))+metric('对 5 日均量',multiple(model?.vs5))+metric('对 20 日均量',multiple(model?.vs20),true):
    metric('累计成交量',compact(p?.today,unit))+metric('上一日同刻',multiple(ratio(p?.today,p?.previous)))+metric('近5分 / 历史同窗',multiple(ratio(p?.window5,p?.average_window5)),true);
  $('chart-title-'+i).textContent=history?'每日成交量与均量':state.mode==='cum'?'同分钟累计成交量':'同窗口近 5 分钟成交量';
  $('chart-subtitle-'+i).textContent=history?'下图 · 日量比':'下图 · 近 5 分钟量比';
  const data=history?h:d,hasData=history?!!h?.daily.length:!!d?.timeline.some(x=>x.today!==null),error=state.errors.get((history?'history':'detail')+':'+symbol);
  $('empty-'+i).hidden=hasData;
  if(hasData)draw(i,data,unit);else{
    $('empty-'+i).textContent=error||(data?(history?'暂无可用日线':'暂未积累分钟数据，可先查看量能历史，稍后刷新'):((history?'历史':'分钟')+'数据加载中…'));
    state.charts.get(i)?.clear();state.chartKeys.delete(i);
  }
  const n=p?.sample_count??0,wn=p?.window_sample_count??0;
  $('note-'+i).textContent=history?model?`${model.latest.date}${model.live?' · 未收盘量，不参与均线':''} · ${model.total} 根日K；均量先按全历史计算再截取窗口。`:'日K数据独立加载，不影响盘中量能。':
    `${d?.tradeDate||'—'} · 已完成分钟 ${p?.minute||'—'} · 上一日 ${d?.previousDay||'—'}；同刻 ${n}/20 日，近5分同窗 ${wn}/20 日有效。`;
  const warning=[error,data?.warning,data?.stale?'数据源标记为旧缓存，请核对时间':'',!history&&d?.collection==='persistent'&&n<20?'历史样本不足20日，均值仅代表可得样本':''].filter(Boolean).join('；');
  $('warning-'+i).hidden=!warning;$('warning-'+i).textContent=warning;
  $('source-'+i).textContent=history?h?.source||'日K来源待获取':d?.source||'分钟来源待获取';
  const status=history?model?`${model.live?'盘中':'已收盘'} · ${h.adjustment}`:'等待数据':d?d.collection==='short-history'?'短历史模式':n===20?'20 日基线就绪':'基线积累中':'等待数据';
  $('status-'+i).textContent=status;$('status-'+i).className=warning?'status-warning':'status-good';
  $('more-'+i).innerHTML=[['昨收',fmt(q?.previousClose,unit==='份'?3:2)],['开盘',fmt(q?.open,unit==='份'?3:2)],['最高 / 最低',fmt(q?.high)+' / '+fmt(q?.low)],
    ['成交额',compact(q?.amount,'元')],['历史数据获取',h?.asOf?timeText(h.asOf):'尚未读取日K'],['采集方式',d?.collection==='persistent'?'后台持续采集':d?'可得近五日分时':'待确认']].map(([label,value])=>'<div><span>'+label+'</span><b>'+esc(value)+'</b></div>').join('');
}
function render(){controls();ensurePanels();for(let i=0;i<(state.layout==='double'?2:1);i++)renderPanel(i);}
const observer=new ResizeObserver(entries=>{for(const e of entries){const i=Number(e.target.id.slice(-1));state.charts.get(i)?.resize();}});
function stop(){clearTimeout(timer);controller?.abort();}
function schedule(){clearTimeout(timer);if(document.hidden)return;timer=setTimeout(()=>marketWindow()?refresh():schedule(),60000);}
async function refresh(force=false){
  stop();if(document.hidden)return;controller=new AbortController();const signal=controller.signal,g=++state.generation;state.busy=true;$('refresh').disabled=true;$('refresh').textContent='⟳ 更新中';
  $('poll-state').textContent='正在读取行情…';
  const actions=state.view==='history'?['detail','history']:['detail'],symbols=[...new Set(state.symbols.slice(0,state.layout==='double'?2:1))];
  render();
  await Promise.allSettled(symbols.flatMap(symbol=>actions.map(async action=>{
    const k=action+':'+symbol,cached=cacheGet(k),ttl=action==='detail'?25000:60000;
    if(cached&&!force&&Date.now()-cached.at<ttl)return;
    try{
      const response=await fetch('/api/volume?'+new URLSearchParams({action,symbol,...(force?{force:'1'}:{})}),{signal:AbortSignal.any([signal,AbortSignal.timeout(28000)])});
      const json=await response.json();if(!response.ok)throw Error(json.error||'读取失败');if(g!==state.generation||signal.aborted)return;
      cacheSet(k,json);state.errors.delete(k);for(let i=0;i<(state.layout==='double'?2:1);i++)if(action==='history'||state.symbols[i]===symbol)renderPanel(i);
    }catch(e){if(signal.aborted||g!==state.generation)return;state.errors.set(k,(cached?'更新失败，保留上次数据：':'')+(e.name==='TimeoutError'?'读取超时，请刷新重试':e.message));for(let i=0;i<(state.layout==='double'?2:1);i++)if(state.symbols[i]===symbol)renderPanel(i);}
  })));
  if(g!==state.generation||signal.aborted)return;state.busy=false;$('refresh').disabled=false;$('refresh').textContent='⟳ 刷新';
  $('poll-state').textContent=!navigator.onLine?'当前离线 · 可查看已加载数据':marketWindow()?'页面可见时 · 每 60 秒更新':'非交易时段 · 可手动刷新';schedule();
}
function select(symbol,name){
  if(!safeSymbol(symbol))return;if(!state.watch.some(x=>x.symbol===symbol)){if(state.watch.length>=40)return toast('最多保留40个本机自选');state.watch.push({symbol,name:name||nameFor(symbol)});}
  state.symbols[state.focus]=symbol;persist();$('search-dialog').close();refresh();
}
function openSearch(slot=state.focus){state.focus=slot;renderWatch();$('search-title').textContent='选择'+(state.layout==='double'?(slot?'右图':'左图'):'当前图')+'标的';$('search-input').value='';$('search-results').innerHTML='';$('search-dialog').showModal();$('search-input').focus();}
async function search(){
  searchController?.abort();searchController=new AbortController();const q=$('search-input').value.trim(),g=++searchGeneration;if(!q){$('search-results').innerHTML='';return;}
  $('search-results').innerHTML='<div class="empty">正在搜索…</div>';
  try{
    const r=await fetch('/api/volume?'+new URLSearchParams({action:'search',q}),{signal:AbortSignal.any([searchController.signal,AbortSignal.timeout(20000)])});const json=await r.json();if(g!==searchGeneration)return;if(!r.ok)throw Error(json.error);
    const items=[...seed.filter(x=>x.name.includes(q)||x.symbol.includes(q)),...(json.items||[])].filter((x,i,a)=>safeSymbol(x.symbol)&&a.findIndex(v=>v.symbol===x.symbol)===i);
    $('search-results').innerHTML=items.length?items.map(x=>'<button class="search-result" data-pick="'+esc(x.symbol)+'" data-name="'+esc(x.name)+'"><span>'+esc(x.name)+'</span><small>'+esc(x.symbol)+'</small></button>').join(''):'<div class="empty">未找到沪深股票或场内 ETF</div>';
  }catch(e){if(g===searchGeneration&&!searchController.signal.aborted)$('search-results').innerHTML='<div class="empty">'+esc(e.message)+'</div>';}
}
document.addEventListener('click',event=>{
  const b=event.target.closest('button');if(!b)return;
  if(b.dataset.layout){state.layout=b.dataset.layout;if(state.layout==='single')state.focus=0;persist();refresh();}
  if(b.dataset.view){state.view=b.dataset.view;persist();refresh();}
  if(b.dataset.mode){state.mode=b.dataset.mode;persist();render();}
  if(b.dataset.days){state.days=Number(b.dataset.days);persist();render();}
  if(b.dataset.select!==undefined)openSearch(Number(b.dataset.select));
  if(b.dataset.pick)select(b.dataset.pick,b.dataset.name);
  if(b.dataset.remove){state.watch=state.watch.filter(x=>x.symbol!==b.dataset.remove);persist();renderWatch();toast('已从本机自选移除');}
});
$('panels').addEventListener('pointerdown',e=>{const panel=e.target.closest('[data-panel]');if(panel){state.focus=Number(panel.dataset.panel);renderWatch();}});
$('theme').onclick=()=>{state.theme=state.theme==='dark'?'light':'dark';persist();render();};$('refresh').onclick=()=>refresh(true);$('watch-add').onclick=()=>openSearch();
$('search-form').onsubmit=e=>{e.preventDefault();clearTimeout(searchTimer);search();};$('search-input').oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(search,400);};
$('search-close').onclick=()=>$('search-dialog').close();$('search-dialog').addEventListener('close',()=>{searchController?.abort();clearTimeout(searchTimer);searchGeneration++;});
$('about').onclick=()=>$('about-dialog').showModal();$('about-close').onclick=()=>$('about-dialog').close();
for(const id of ['search-dialog','about-dialog'])$(id).addEventListener('click',e=>{const r=$(id).getBoundingClientRect();if(e.target===$(id)&&(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom))$(id).close();});
document.addEventListener('visibilitychange',()=>{if(document.hidden){stop();$('poll-state').textContent='页面隐藏 · 已暂停更新';}else refresh();});
window.addEventListener('offline',()=>{stop();$('poll-state').textContent='当前离线 · 显示已加载数据';});window.addEventListener('online',()=>refresh());
window.addEventListener('pagehide',()=>{stop();searchController?.abort();observer.disconnect();for(const c of state.charts.values())c.dispose();state.charts.clear();state.chartKeys.clear();state.cache.clear();});
window.addEventListener('pageshow',e=>{if(e.persisted)refresh();});
refresh();
