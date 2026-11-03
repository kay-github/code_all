export const valid = v => v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v));
export const ratio = (a,b) => valid(a)&&valid(b)&&Number(b)>0?Number(a)/Number(b):null;
export const WINDOWS=[60,120,250];
export function movingAverage(values,n){
  let sum=0;return values.map((v,i)=>{sum+=v;if(i>=n)sum-=values[i-n];return i>=n-1?sum/n:null;});
}
// Same daily volume convention as code_finance/volumeHistory.ts. Completed-day
// averages include that completed day; the unfinished daily bar is excluded.
export function historyModel(data,days=120,now=new Date()){
  const daily=data?.daily||[];if(!daily.length)return null;
  const at=data.asOf?new Date(data.asOf):now;
  const time=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(at);
  const live=daily.at(-1).date===time.slice(0,10)&&time.slice(11,16)<'15:05';
  const completed=live?daily.slice(0,-1):daily,volumes=completed.map(p=>p.volume),averages=[5,20,60].map(n=>movingAverage(volumes,n));
  const rows=daily.map((p,i)=>{
    const done=!live||i<daily.length-1,base=done?averages[1][i]:averages[1].at(-1),previous=daily[i-1]?.close??p.open;
    return {...p,done,up:p.close>=previous,changePct:previous>0?(p.close/previous-1)*100:null,
      ma5:done?averages[0][i]??null:null,ma20:done?averages[1][i]??null:null,ma60:done?averages[2][i]??null:null,ratio:ratio(p.volume,base)};
  });
  return {rows:rows.slice(-days),latest:rows.at(-1),live,total:daily.length,vs5:ratio(rows.at(-1).volume,averages[0].at(-1)),vs20:ratio(rows.at(-1).volume,averages[1].at(-1))};
}
export function intradayModel(detail,mode='cum'){
  const points=detail?.timeline||[],window=mode==='window';
  const key=window?['window5','previous_window5','average_window5']:['today','previous','average20'];
  const rows=points.flatMap(p=>[...(p.minute==='13:00'?[{minute:'午休',today:null,previous:null,average20:null,window5:null,previous_window5:null,average_window5:null,price:null}]:[]),p]);
  return {rows,columns:key,series:key.map(k=>rows.map(p=>p[k]??null)),ratios:rows.map(p=>ratio(p.window5,p.average_window5)),latest:detail?.latest};
}
export function comparisonDates(histories,days){
  return [...new Set(histories.flatMap(h=>historyModel(h,days)?.rows.map(p=>p.date)||[]))].sort().slice(-days);
}
export function marketWindow(now=new Date()){
  const d=new Date(now.toLocaleString('en-US',{timeZone:'Asia/Shanghai'})),m=d.getHours()*60+d.getMinutes();
  return d.getDay()>0&&d.getDay()<6&&((m>=565&&m<=695)||(m>=775&&m<=910));
}
