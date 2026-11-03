const test=require('node:test'),assert=require('node:assert/strict');
const {instrument,catalog,cleanDetail,cleanHistory,TIMELINE,windowMinutes,parseMinutes,shortDetail,loadVolume}=require('../lib/volumeService');
const now=new Date('2026-11-03T10:06:30+08:00'),item=instrument('510300.SH');
test('沪深ETF与股票分类、交易所、单位正确；拒绝其他代码和URL',()=>{
  for(const code of ['510300','sh510310','159919.SZ'])assert.equal(instrument(code).unit,'份');
  for(const code of ['300502','300308.SZ','300750.SZ'])assert.equal(instrument(code).kind,'股票');
  for(const code of ['https://bad','000001.SH','510300.SZ','300502.SH','399006.SZ','../../x'])assert.throws(()=>instrument(code));
  assert.deepEqual(catalog().map(x=>x.symbol),['510300.SH','510310.SH','300502.SZ','300308.SZ','300750.SZ']);
});
test('只读响应只返回白名单字段，不包含规则、凭据和账户台账',()=>{
  const raw={instrument:{name:'测试ETF',private_password:'secret'},quote:{price:4.1,quote_time:'20261103100500',token:'secret'},rules:[{password:'secret'}],positions:[1],data:{trade_date:'2026-11-03',history_days:['2026-11-02'],timeline:[{minute:'10:05',today:100,previous:50,average20:60,sample_count:20,secret:'hidden'}]}};
  const r=cleanDetail(raw,item,now),json=JSON.stringify(r);assert.equal(r.latest.today,100);assert.equal(r.quote.time,'2026-11-03T10:05:00+08:00');
  assert.doesNotMatch(json,/secret|password|positions|rules|token/);assert.equal(r.instrument.unit,'份');
});
test('未来/进行中分钟不冒充已完成分钟，缺失值不填零，样本保留实际数量',()=>{
  const r=cleanDetail({data:{trade_date:'2026-11-03',timeline:[{minute:'10:05',today:0,sample_count:4},{minute:'10:06',today:99},{minute:'10:07',today:100}]}},item,now);
  assert.equal(r.latest.minute,'10:05');assert.equal(r.latest.today,0);assert.equal(r.latest.sample_count,4);assert.equal(r.timeline[0].today,null);
});
test('5分钟窗口不穿过午休，开盘样本不足时为空',()=>{
  assert.equal(TIMELINE.length,242);assert.deepEqual(windowMinutes('13:00'),[]);assert.deepEqual(windowMinutes('13:03'),[]);
  assert.deepEqual(windowMinutes('13:04'),['13:00','13:01','13:02','13:03','13:04']);assert.equal(windowMinutes('09:34').length,5);
});
test('腾讯手转换股/份；缺口之后不伪造分钟增量',()=>{
  const p=parseMinutes(['0930 4 100 40000','0931 4 103 41200','0933 4 120 48000','0934 4 125 50000'],'2026-11-02',now);
  assert.equal(p.get('09:30').volume,10000);assert.equal(p.get('09:31').increment,300);assert.equal(p.get('09:33').increment,null);assert.equal(p.get('09:34').increment,500);
});
test('短历史模式按真实样本计算，零基线保留而不制造无穷量比',()=>{
  const rows=['0930 4 1 400','0931 4 2 800','0932 4 3 1200','0933 4 4 1600','0934 4 5 2000'];
  const r=shortDetail([{date:'20261102',data:rows},{date:'20261103',data:rows}],item,{name:'ETF',price:4,time:'20261103100500'},now);
  assert.equal(r.collection,'short-history');assert.equal(r.latest.sample_count,1);assert.equal(r.latest.window_sample_count,1);assert.equal(r.latest.window5,500);
  assert.match(r.warning,/短历史/);assert.equal(r.previousDay,'2026-11-02');
});
test('日线仅保留OHLC量和公开来源信息，剥离多余数据',()=>{
  const r=cleanHistory({daily:[{date:'2026-11-02',open:4,close:4.1,high:4.2,low:3.9,volume:500,secret:'hidden'}],rules:['hidden'],summary:{secret:'hidden'},history_cache:{fetched_at:'2026-11-03T02:00:00Z',stale:true}},item);
  assert.equal(r.daily.length,1);assert.equal(r.stale,true);assert.doesNotMatch(JSON.stringify(r),/secret|rules|hidden/);
});
test('搜索复用原接口并排除指数；代理只访问固定上游域名',async()=>{
  const urls=[];const r=await loadVolume('search',{q:'沪深300'},{fetcher:async url=>{urls.push(url);return Response.json([{symbol:'sh510300',name:'ETF'},{symbol:'sh000300',name:'指数'}]);}});
  assert.equal(r.items.length,1);assert.equal(r.items[0].symbol,'510300.SH');assert.equal(new URL(urls[0]).hostname,'finance.688680.xyz');
  await assert.rejects(loadVolume('write',{}),{status:400});
});
test('未加入采集的日线可走只读叠加接口，不调用任何写入接口',async()=>{
  const urls=[];const r=await loadVolume('history',{symbol:'300750'},{fetcher:async(url,opts)=>{urls.push(url);assert.equal(opts.method,undefined);return url.includes('/market/overlay/')?Response.json({daily:[{date:'2026-11-02',open:100,high:110,low:90,close:105,volume:300}]}):new Response('{}',{status:404});}});
  assert.equal(r.daily.length,1);assert.match(urls[1],/\/api\/market\/overlay\/sz300750$/);
});
test('HTTP拒绝写入和非法代码，不提供通用上游代理',async()=>{
  const handler=require('../api/volume');const call=async(method,query)=>{let body;const res={setHeader(){},end(s){body=JSON.parse(s);}};await handler({method,query,headers:{},socket:{remoteAddress:'volume-test'}},res);return{status:res.statusCode,body};};
  assert.equal((await call('POST',{})).status,405);assert.equal((await call('GET',{symbol:'https://bad'})).status,400);assert.equal((await call('GET',{action:'delete'})).status,400);
});
test('同标的并发读取合并；更新失败退回原时间的有标记缓存',async()=>{
  const {cachedVolume}=require('../lib/volumeService');let calls=0;
  const options={fetcher:async()=>{calls++;await new Promise(resolve=>setTimeout(resolve,10));return Response.json({instrument:{name:'测试'},quote:{price:100,quote_time:'20261103100500'},data:{trade_date:'2026-11-03',timeline:[{minute:'10:05',today:100,sample_count:5}]}});},now};
  const [a,b]=await Promise.all([cachedVolume('detail',{symbol:'601398.SH'},options),cachedVolume('detail',{symbol:'601398.SH'},options)]);
  assert.equal(calls,1);assert.deepEqual(a,b);
  const stale=await cachedVolume('detail',{symbol:'601398.SH',force:true},{fetcher:async()=>{throw Error('source down');}});
  assert.equal(stale.stale,true);assert.equal(stale.quote.time,a.quote.time);assert.equal(stale.latest.today,a.latest.today);assert.match(stale.warning,/上次结果/);
});
