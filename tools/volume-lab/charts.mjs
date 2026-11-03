import {intradayModel,historyModel,valid} from './model.mjs';
export const fmt=(v,d=2)=>valid(v)?Number(v).toLocaleString('zh-CN',{minimumFractionDigits:d,maximumFractionDigits:d}):'—';
export const compact=(v,unit='')=>valid(v)?Math.abs(v)>=1e8?fmt(v/1e8,2)+' 亿'+unit:Math.abs(v)>=1e4?fmt(v/1e4,2)+' 万'+unit:fmt(v,0)+' '+unit:'—';
export const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function chartOption(view,data,{mode,days,theme,calendar,prepared},unit){
  const light=theme==='light',c=light?{text:'#708174',grid:'#dce5da',bg:'#fff',strong:'#25372e',up:'#c65048',down:'#228668',a:'#207e62',b:'#9679c5',d:'#b28c46'}:{text:'#92a599',grid:'#2b3c32',bg:'#17221e',strong:'#e5eee7',up:'#ee958b',down:'#7bceaf',a:'#9ce7cf',b:'#bba3e0',d:'#e2c385'};
  const history=view==='history',model=history?(prepared||historyModel(data,days)):intradayModel(data,mode);
  if(!model||(history&&!model.rows.length))return null;
  const map=history?new Map(model.rows.map(p=>[p.date,p])):null;
  const rows=history&&calendar?.length?calendar.map(date=>map.get(date)||{date,done:true,volume:null,ma5:null,ma20:null,ma60:null,ratio:null,close:null}):model.rows,labels=rows.map(p=>history?p.date:p.minute);
  const common={backgroundColor:'transparent',animation:false,textStyle:{fontFamily:'Segoe UI, Microsoft YaHei, sans-serif',color:c.text},
    legend:{top:14,left:'center',itemWidth:15,itemHeight:3,itemGap:13,textStyle:{color:c.text,fontSize:10}},
    grid:[{left:62,right:20,top:60,height:'47%'},{left:62,right:20,top:'75%',height:'15%'}],
    tooltip:{trigger:'axis',confine:true,axisPointer:{type:'cross'},backgroundColor:c.bg,borderColor:c.grid,textStyle:{color:c.strong,fontSize:11},
      formatter:params=>{
        const label=params[0]?.axisValue,p=rows.find(r=>(history?r.date:r.minute)===label);
        if(!p||label==='午休')return '';
        return '<b>'+esc(label)+(history&&!p.done?' · 未收盘':'')+'</b><br>'+params.filter(v=>valid(v.value)).map(v=>v.marker+esc(v.seriesName)+'：'+(v.seriesName.includes('量比')?fmt(v.value)+'×':compact(v.value,unit))).join('<br>')+(history?'<br>收盘 '+fmt(p.close,unit==='份'?3:2):valid(p.price)?'<br>价格 '+fmt(p.price,unit==='份'?3:2):'');
      }},
    axisPointer:{link:[{xAxisIndex:'all'}]},
    xAxis:[0,1].map(i=>({type:'category',gridIndex:i,data:labels,boundaryGap:true,axisTick:{show:false},axisLine:{lineStyle:{color:c.grid}},axisLabel:{show:i===1,color:c.text,fontSize:9,hideOverlap:true,
      interval:history?'auto':(_index,value)=>['09:30','10:30','11:30','13:00','14:00','15:00'].includes(value),formatter:v=>history?v.slice(5):v},splitLine:{show:false}})),
    yAxis:[{type:'value',min:0,gridIndex:0,splitNumber:3,axisLabel:{color:c.text,fontSize:9,formatter:v=>Math.abs(v)>=1e8?fmt(v/1e8,1)+'亿':Math.abs(v)>=1e4?fmt(v/1e4,0)+'万':fmt(v,0)},splitLine:{lineStyle:{color:c.grid,opacity:.55}}},
      {type:'value',min:0,gridIndex:1,splitNumber:2,axisLabel:{color:c.text,fontSize:9,formatter:v=>fmt(v,1)+'×'},splitLine:{lineStyle:{color:c.grid,opacity:.45}}}],
  };
  const line=(name,data,color,extra={})=>({name,type:'line',data,symbol:'none',connectNulls:false,lineStyle:{color,width:2,...extra},itemStyle:{color},emphasis:{focus:'series'}});
  const ratios={name:history?'日量比':'近5分钟量比',type:'bar',xAxisIndex:1,yAxisIndex:1,data:history?rows.map(p=>p.ratio):model.ratios,barMaxWidth:12,itemStyle:{color:c.d,opacity:.75},
    markLine:{symbol:'none',silent:true,label:{show:false},lineStyle:{type:'dashed',color:c.text,opacity:.5},data:[{yAxis:1},{yAxis:2}]}};
  if(history){
    common.legend.data=['成交量','5日均量','20日均量','60日均量'];
    common.series=[{name:'成交量',type:'bar',data:rows.map(p=>({value:p.volume,itemStyle:{color:p.up?c.up:c.down,opacity:p.done?.72:.35}})),barMaxWidth:15},
      ...['ma5','ma20','ma60'].map((k,i)=>line(['5日均量','20日均量','60日均量'][i],rows.map(p=>p[k]),[c.d,c.a,c.b][i])),ratios];
    common.dataZoom=[{type:'inside',xAxisIndex:[0,1],filterMode:'none'},{type:'slider',xAxisIndex:[0,1],bottom:1,height:13,borderColor:c.grid,showDetail:false,brushSelect:false}];
  }else{
    common.legend.data=['今日','上一交易日','历史同刻均量'];
    common.series=model.series.map((values,i)=>line(common.legend.data[i],values,[c.a,c.b,c.d][i],{width:i?1.8:2.7,type:i===1?'dashed':'solid'}));common.series.push(ratios);
  }
  return common;
}
