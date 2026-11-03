import test from 'node:test';import assert from 'node:assert/strict';
import {movingAverage,historyModel,comparisonDates,intradayModel,ratio,marketWindow} from '../tools/volume-lab/model.mjs';
const daily=Array.from({length:80},(_,i)=>({date:new Date(Date.UTC(2026,7,1+i)).toISOString().slice(0,10),open:10,close:10+i,high:100,low:5,volume:(i+1)*100}));
test('日均量先全历史预热再裁剪，60日均线不因短窗口丢失',()=>{
  const a=historyModel({daily,asOf:'2026-11-03T16:00:00+08:00'},10),b=historyModel({daily},120,new Date('2026-11-03T16:00:00+08:00'));
  assert.equal(a.rows.length,10);assert.equal(a.rows[0].ma60,b.rows.at(-10).ma60);assert.equal(a.latest.ma5,7800);assert.equal(a.latest.ratio,8000/7050);
});
test('未收盘当日不混入均量，当日量只与已完成均量比较',()=>{
  const rows=[...daily,{date:'2026-11-03',open:10,close:11,high:12,low:9,volume:100}];
  const r=historyModel({daily:rows,asOf:'2026-11-03T10:05:00+08:00'},120,new Date('2026-11-03T18:00:00+08:00'));
  assert.equal(r.live,true);assert.equal(r.latest.done,false);assert.equal(r.latest.ma20,null);assert.equal(r.vs20,100/7050);
  assert.equal(historyModel({daily:rows,asOf:'2026-11-03T15:10:00+08:00'}).live,false);
});
test('不足样本、零均量、空值不生成无穷或伪量比',()=>{
  assert.equal(ratio(1,0),null);assert.equal(ratio(null,100),null);assert.equal(ratio(0,100),0);assert.deepEqual(movingAverage([1,2],5),[null,null]);
  assert.equal(historyModel({daily:daily.slice(0,2)}).latest.ratio,null);
});
test('盘中累计与5分曲线口径切换正确，午休插入断点',()=>{
  const d={timeline:[{minute:'11:30',today:100,previous:50,average20:80,window5:20,previous_window5:10,average_window5:5},{minute:'13:00',today:120,window5:null}],latest:{minute:'13:00'}};
  const a=intradayModel(d,'cum'),b=intradayModel(d,'window');assert.deepEqual(a.series[0],[100,null,120]);assert.deepEqual(b.series[0],[20,null,null]);assert.deepEqual(a.ratios,[4,null,null]);assert.equal(a.rows[1].minute,'午休');
});
test('页面自动轮询按北京时间交易窗口，周末和午休停止请求',()=>{
  assert.equal(marketWindow(new Date('2026-11-03T10:00:00+08:00')),true);assert.equal(marketWindow(new Date('2026-11-03T12:00:00+08:00')),false);assert.equal(marketWindow(new Date('2026-11-01T10:00:00+08:00')),false);
});
test('双图按真实日期对齐；停牌缺日和新上市短历史不按序号错位',()=>{
  const a={daily:daily.slice(-5)},b={daily:[daily.at(-4),daily.at(-1)]};
  assert.deepEqual(comparisonDates([a,b],5),daily.slice(-5).map(x=>x.date));
  assert.equal(historyModel(b).rows.length,2); // alignment never invents missing market bars
});
