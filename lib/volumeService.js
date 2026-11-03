const ORIGIN = 'https://finance.688680.xyz';
const DEFAULTS = [
  ['510300.SH','华泰柏瑞沪深300ETF'],['510310.SH','易方达沪深300ETF'],
  ['300502.SZ','新易盛'],['300308.SZ','中际旭创'],['300750.SZ','宁德时代'],
];
const TIMELINE = [9,10,11,13,14,15].flatMap(h => Array.from({length:h===9?30:h===11?31:h===15?1:60},(_,i)=>`${h.toString().padStart(2,'0')}:${(i+(h===9?30:0)).toString().padStart(2,'0')}`));
const number = v => v!==null && v!==undefined && v!=='' && Number.isFinite(Number(v)) ? Number(v) : null;
const nonnegative = v => number(v)>=0 && number(v)!==null ? number(v) : null;
const validDate = v => typeof v==='string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0,10)===v;
const china = now => new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(now).split(' ');
function instrument(input) {
  const m=String(input||'').trim().toUpperCase().match(/^(?:(SH|SZ))?(\d{6})(?:\.(SH|SZ))?$/);
  const code=m?.[2], exchange=code && /^(60|68|50|51|52|56|58)/.test(code)?'SH':code&&/^(00|30|159)/.test(code)?'SZ':null;
  if(!m||!exchange||(m[1]&&m[1]!==exchange)||(m[3]&&m[3]!==exchange))throw Object.assign(Error('请输入沪深股票或场内 ETF 代码'),{status:400});
  const kind=/^(50|51|52|56|58|159)/.test(code)?'ETF':'股票';
  return {symbol:`${code}.${exchange}`,code,exchange,kind,unit:kind==='ETF'?'份':'股',key:exchange.toLowerCase()+code};
}
const catalog = () => DEFAULTS.map(([code,name])=>({...instrument(code),name}));
function timestamp(v) {
  if(typeof v!=='string')return null;
  if(/^\d{14}$/.test(v))return `${v.slice(0,4)}-${v.slice(4,6)}-${v.slice(6,8)}T${v.slice(8,10)}:${v.slice(10,12)}:${v.slice(12,14)}+08:00`;
  return Number.isFinite(Date.parse(v))?v:null;
}
const cleanName = (value,fallback) => typeof value==='string'&&value.trim()?value.trim().slice(0,80):fallback;
function cleanQuote(raw) {
  if(!(number(raw?.price)>0))return null;
  return {price:number(raw.price),changePct:number(raw.change_pct??raw.changePct),previousClose:number(raw.previous_close??raw.previousClose),
    volume:nonnegative(raw.volume_cum??raw.volume),time:timestamp(raw.quote_time??raw.time),
    high:number(raw.high),low:number(raw.low),open:number(raw.open),amount:nonnegative(raw.amount)};
}
function cleanDetail(raw,item,now=new Date()) {
  const data=raw.data, date=validDate(data?.trade_date)?data.trade_date:null;
  const [today,time]=china(now), map=new Map((Array.isArray(data?.timeline)?data.timeline:[]).map(p=>[p.minute,p]));
  const fields=['today','previous','average20','window5','previous_window5','average_window5','price'];
  const timeline=TIMELINE.map(minute=>{
    const p=map.get(minute)||{},future=date===today&&minute>=time;
    return {minute,...Object.fromEntries(fields.map(k=>[k,future&&['today','window5','price'].includes(k)?null:nonnegative(p[k])])),
      sample_count:Math.max(0,Math.min(20,number(p.sample_count)||0)),window_sample_count:Math.max(0,Math.min(20,number(p.window_sample_count)||0))};
  });
  return {instrument:{...item,name:cleanName(raw.instrument?.name,item.code)},quote:cleanQuote(raw.quote),tradeDate:date,
    previousDay:validDate(data?.previous_day)?data.previous_day:null,historyDays:(data?.history_days||[]).filter(validDate).slice(-20),
    timeline,latest:[...timeline].reverse().find(p=>p.today!==null)||null,collection:'persistent',source:'金融工作台 · 腾讯分钟采集',
    warning:raw.source_status?.status==='error'?'采集源当前异常，显示已保存的数据':date&&date<today?'当前为 '+date+' 的最近可得分钟数据':''};
}
function windowMinutes(minute) {
  const index=TIMELINE.indexOf(minute),start=minute<='11:30'?0:TIMELINE.indexOf('13:00');
  return index-start>=4?TIMELINE.slice(index-4,index+1):[];
}
function parseMinutes(rows,date,now=new Date()) {
  if(!validDate(date))throw Error('分钟日期无效');
  const [today,time]=china(now), values=new Map();
  for(const raw of rows||[]){
    const [stamp,price,hands]=String(raw).trim().split(/\s+/),minute=stamp?.slice(0,2)+':'+stamp?.slice(2,4);
    if(!/^\d{4}$/.test(stamp)||!TIMELINE.includes(minute)||!(number(price)>0)||nonnegative(hands)===null||(date===today&&minute>=time))continue;
    values.set(minute,{minute,price:Number(price),volume:Number(hands)*100});
  }
  let previous=0,previousIndex=-1;
  return new Map([...values.values()].sort((a,b)=>a.minute.localeCompare(b.minute)).map(p=>{
    const index=TIMELINE.indexOf(p.minute),contiguous=index===previousIndex+1;
    const increment=p.volume>=previous&&(contiguous||index===0)?p.volume-previous:null;
    previous=p.volume;previousIndex=index;return [p.minute,{...p,increment}];
  }));
}
function shortDetail(days,item,quote,now=new Date()) {
  const parsed=(days||[]).flatMap(day=>{
    const d=String(day.date||''),date=/^\d{8}$/.test(d)?`${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`:d;
    return validDate(date)?[{date,points:parseMinutes(day.data,date,now)}]:[];
  }).sort((a,b)=>a.date.localeCompare(b.date)).slice(-5);
  if(!parsed.length)throw Error('暂无分钟数据');
  const current=parsed.at(-1),prior=parsed.at(-2),history=parsed.slice(0,-1);
  const window=(day,minute)=>{const times=windowMinutes(minute);return times.length&&times.every(m=>day?.points.get(m)?.increment!==null&&day?.points.get(m)?.increment!==undefined)?times.reduce((s,m)=>s+day.points.get(m).increment,0):null;};
  const mean=xs=>xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null;
  const timeline=TIMELINE.map(minute=>{
    const samples=history.map(d=>d.points.get(minute)?.volume).filter(v=>v!==undefined),windows=history.map(d=>window(d,minute)).filter(v=>v!==null);
    return {minute,today:current.points.get(minute)?.volume??null,price:current.points.get(minute)?.price??null,
      previous:prior?.points.get(minute)?.volume??null,average20:mean(samples),sample_count:samples.length,
      window5:window(current,minute),previous_window5:window(prior,minute),average_window5:mean(windows),window_sample_count:windows.length};
  });
  return {instrument:{...item,name:quote.name},quote:cleanQuote(quote),tradeDate:current.date,previousDay:prior?.date??null,historyDays:history.map(d=>d.date),timeline,
    latest:[...timeline].reverse().find(p=>p.today!==null)||null,collection:'short-history',source:'腾讯近五日分时',warning:'短历史模式：仅使用可得样本；尚未建立完整 20 日同刻基线'};
}
function cleanHistory(raw,item) {
  const daily=(Array.isArray(raw.daily)?raw.daily:[]).filter(p=>validDate(p.date)&&['open','close','high','low'].every(k=>number(p[k])>0)&&nonnegative(p.volume)!==null)
    .map(p=>Object.fromEntries(['date','open','close','high','low','volume'].map(k=>[k,k==='date'?p.date:Number(p[k])]))).sort((a,b)=>a.date.localeCompare(b.date)).slice(-700);
  if(!daily.length)throw Error('日线数据暂不可用');
  return {instrument:item,daily,source:raw.source==='tencent'?'金融工作台 · 腾讯日K':cleanName(raw.source,'金融工作台 · 腾讯日K'),adjustment:cleanName(raw.adjustment,'来源复权口径'),
    asOf:timestamp(raw.history_cache?.fetched_at),stale:raw.history_cache?.stale===true};
}
async function loadVolume(action,params={}, {fetcher=fetch,now=new Date()}={}) {
  const deadline=Date.now()+22000;
  async function request(url,json=true){
    const r=await fetcher(url,{signal:AbortSignal.timeout(Math.max(1,Math.min(10000,deadline-Date.now()))),headers:{'User-Agent':'Mozilla/5.0',Referer:'https://gu.qq.com/'}});
    if(!r.ok)throw Object.assign(Error('数据源暂不可用'),{upstreamStatus:r.status});
    return json?r.json():new TextDecoder('gb18030').decode(await r.arrayBuffer());
  }
  if(action==='catalog')return {items:catalog()};
  if(action==='search'){
    const q=String(params.q||'').trim();if(!q||q.length>32)throw Object.assign(Error('搜索词请输入 1—32 个字符'),{status:400});
    const rows=await request(ORIGIN+'/api/search?q='+encodeURIComponent(q));
    return {items:(Array.isArray(rows)?rows:[]).flatMap(row=>{try{return[{...instrument(row.symbol),name:cleanName(row.name,row.code)}];}catch{return[];}}).slice(0,12)};
  }
  if(!['detail','history'].includes(action))throw Object.assign(Error('不支持的读取类型'),{status:400});
  const item=instrument(params.symbol),path=ORIGIN+'/api/instruments/'+item.key;
  if(action==='history'){
    let raw;try{raw=await request(path+'/market');}catch{raw=await request(ORIGIN+'/api/market/overlay/'+item.key);}
    return cleanHistory(raw,item);
  }
  try{return cleanDetail(await request(path+'/detail'),item,now);}catch{
    const [minutes,text]=await Promise.all([request('https://web.ifzq.gtimg.cn/appstock/app/day/query?code='+item.key),request('https://qt.gtimg.cn/q='+item.key,false)]);
    const f=text.match(/="([^"]+)"/)?.[1].split('~');if(!f||f[2]!==item.code||!(number(f[3])>0))throw Error('报价暂不可用');
    const quote={name:cleanName(f[1],item.code),price:number(f[3]),previousClose:number(f[4]),open:number(f[5]),volume:number(f[6])*100,
      time:timestamp(f[30]),changePct:number(f[32]),high:number(f[33]),low:number(f[34]),amount:number(f[37])===null?null:Number(f[37])*10000};
    return shortDetail(minutes.data?.[item.key]?.data,item,quote,now);
  }
}
const cache=new Map(),pending=new Map();
async function cachedVolume(action,params={},options) {
  if(!['catalog','search','detail','history'].includes(action))throw Object.assign(Error('不支持的读取类型'),{status:400});
  const key=action+':'+(action==='search'?String(params.q||''):action==='catalog'?'':instrument(params.symbol).symbol),old=cache.get(key),ttl=action==='detail'?20000:action==='history'?60000:3600000;
  if(old&&Date.now()-old.at<ttl&&!params.force){cache.delete(key);cache.set(key,old);return old.value;}
  if(pending.has(key))return pending.get(key);
  const work=loadVolume(action,params,options).then(value=>{cache.delete(key);cache.set(key,{at:Date.now(),value});while(cache.size>80)cache.delete(cache.keys().next().value);return value;})
    .catch(error=>{if(old&&Date.now()-old.at<86400000&&['detail','history'].includes(action))return {...old.value,stale:true,warning:'数据更新失败，显示上次结果，请核对数据时间'};throw error;}).finally(()=>pending.delete(key));
  pending.set(key,work);return work;
}
module.exports={instrument,catalog,TIMELINE,cleanDetail,cleanHistory,parseMinutes,shortDetail,windowMinutes,loadVolume,cachedVolume};
