const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const crypto=require('node:crypto');
const root=path.resolve(__dirname,'../tools/national-team-etf');
const page=fs.readFileSync(path.join(root,'index.html'),'utf8');
const cycle=fs.readFileSync(path.join(root,'cycle.html'),'utf8');
const publicData=JSON.parse(fs.readFileSync(path.join(root,'data/latest.json'),'utf8'));
const data=JSON.parse(page.match(/<script type="application\/json" id="dataset">([\s\S]*?)<\/script>/)[1]);
const script=[...page.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)].filter(m=>!m[1].includes('src=')&&!m[1].includes('application/json')).map(m=>m[2]).join('\n');

test('release file checksums survive Git newline normalization',()=>{
 const receipt=JSON.parse(fs.readFileSync(path.join(root,'data/release.json'),'utf8'));
 for(const [file,expected] of Object.entries(receipt.files)){
  let bytes=fs.readFileSync(path.resolve(root,'../..',file));
  if(!file.endsWith('.gz'))bytes=Buffer.from(bytes.toString('utf8').replace(/\r\n/g,'\n'),'utf8');
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),expected,file);
 }
});

test('pages, public snapshot, and release receipt share one build and business date',()=>{
 const receipt=JSON.parse(fs.readFileSync(path.join(root,'data/release.json'),'utf8'));
 assert.equal(data.build_id,publicData.build_id);assert.equal(data.build_id,receipt.build_id);
 assert.equal(data.end,publicData.business_date);assert.ok(cycle.includes(`content="${data.build_id}"`));
 assert.equal(data.exchange.latest.net_estimate,publicData.latest.net_estimate);
 assert.deepEqual(data.inventory.latest,publicData.inventory.latest);
 assert.equal(data.inventory.reference_date,publicData.inventory.reference_date);
 assert.equal(Object.keys(data.exchange.instruments).length,15);assert.equal(data.exchange.stage,'次晨复核');
});

test('inventory has a fixed denominator, separate total and net increase, and explicit estimate labels',()=>{
 const i=data.inventory,r=i.latest;
 assert.equal(i.reference_date,'2025-12-31');assert.equal(i.price_date,'2026-11-13');assert.equal(i.baseline_units,10);
 assert.ok(Math.abs(r.total_units-i.cycle_start_units-r.net_added_units)<1e-9);
 assert.ok(Math.abs(r.total_units-r.current_yi/i.reference_yi*10)<1e-9);
 assert.ok(Math.abs(r.net_added_units-(r.current_yi-i.cycle_start_yi)/i.reference_yi*10)<1e-9);
 assert.ok(page.indexOf('id="inventory"')<page.indexOf('id="intraday"'));
 assert.ok(page.includes('ETF通道估算 · 非国家队实名仓位'));
 const csv=fs.readFileSync(path.join(root,'data/inventory.csv'),'utf8').trim().split(/\r?\n/);
 const fields=csv.at(-1).split(',');assert.equal(fields[0],data.end);assert.equal(fields.at(-1),data.build_id);
 assert.ok(Math.abs(Number(fields[5])-r.total_units)<1e-9);assert.ok(Math.abs(Number(fields[7])-r.net_added_units)<1e-9);
});

test('official total and five-day amount reconcile; unsupported windows stay incomplete',()=>{
 const items=Object.values(data.exchange.instruments);
 const amount=items.reduce((s,x)=>s+x.latest.net_estimate,0);
 assert.ok(Math.abs(amount-data.exchange.latest.net_estimate)<1e-7);
 assert.equal(items.filter(x=>x.latest.share_change<0).length,data.exchange.latest.outflow_count);
 for(const x of items){
  const r=x.latest;assert.ok(Math.abs((r.shares-r.previous_shares*r.share_factor)*r.vwap/1e8-r.net_estimate)<1e-7);
  const m=x.tracking.latest;
  for(const n of [5,10,20])if(x.tracking.observed_sessions<=n)assert.equal(m['w'+n].complete,false);
 }
 assert.ok(Math.abs(items.reduce((s,x)=>s+x.w5.net_estimate,0)-data.exchange.w5.net_estimate)<1e-7);
});

function render(width,dataset=data){
 const ids=[...page.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);
 const nodes=Object.fromEntries(ids.map(id=>[id,{innerHTML:'',textContent:'',value:'',checked:false,clientWidth:width,
  handlers:{},addEventListener(k,f){this.handlers[k]=f;}}]));
 nodes.dataset.textContent=JSON.stringify(dataset);nodes.pool.value='core';nodes.direction.value='out';
 const document={getElementById:id=>nodes[id],documentElement:{dataset:{}}};
 const context={document,window:{addEventListener(){}},setTimeout};vm.runInNewContext(script,context);
 return {nodes,document,context};
}

for(const width of [320,390,1440])test(`view calculations at ${width}px: data, search, theme`,()=>{
 const {nodes,document,context}=render(width);
 assert.equal(context.window.GJD.officialNet,publicData.latest.net_estimate);
 assert.equal((nodes.officialRows.innerHTML.match(/<tr>/g)||[]).length,15);
 assert.equal((nodes.officialMobile.innerHTML.match(/class="cardrow"/g)||[]).length,15);
 assert.equal((nodes.fundRows.innerHTML.match(/<tr>/g)||[]).length,15);
 assert.ok(nodes.inventoryTitle.textContent.includes(data.inventory.latest.total_units.toFixed(1)));
 assert.ok(nodes.inventoryKpis.innerHTML.includes('当前总存量'));
 assert.ok(nodes.inventoryKpis.innerHTML.includes('本轮净新增'));
 assert.equal(context.window.GJD.inventoryUnits,data.inventory.latest.total_units);
 nodes.search.value='510330';nodes.search.handlers.input();assert.equal((nodes.fundRows.innerHTML.match(/<tr>/g)||[]).length,1);
 nodes.themeToggle.onclick();assert.equal(document.documentElement.dataset.siteTheme,'dark');
 nodes.themeToggle.onclick();assert.equal(document.documentElement.dataset.siteTheme,'light');
});

test('missing inventory suppresses the current ratio and negative net increase remains negative',()=>{
 const missing=structuredClone(data);missing.inventory.complete=false;missing.inventory.latest.complete=false;
 missing.inventory.latest.total_units=null;missing.inventory.latest.net_added_units=null;
 const a=render(390,missing);assert.ok(a.nodes.inventoryTitle.textContent.includes('数据不足'));
 assert.ok(a.nodes.inventoryKpis.innerHTML.includes('—'));assert.equal(a.context.window.GJD.inventoryUnits,null);
 const d=structuredClone(data);d.inventory.latest.net_added_units=-.25;
 const b=render(390,d);assert.ok(b.nodes.inventoryKpis.innerHTML.includes('-0.25'));
});

test('empty discovery and incomplete official data show gaps without zero totals',()=>{
 const d=structuredClone(data);d.discovery.queue=[];d.exchange.latest.complete=false;d.exchange.latest.net_estimate=null;
 d.exchange.instruments['510300'].latest=null;
 const {nodes}=render(390,d);
 assert.ok(nodes.interpretation.textContent.includes('暂不展示核心池完整合计'));
 assert.ok(nodes.discoveryRows.innerHTML.includes('尚无有效扫描数据'));
 assert.ok(nodes.kpis.innerHTML.includes('—'));
});

test('inline favicon prevents the root /favicon.ico 404',()=>{
 assert.match(page,/<link rel="icon" href="data:/);
 assert.match(cycle,/<link rel="icon" href="data:/);
});

// 精简 DOM 走到「实时通道未启用」静态降级就 return，测不到盘中 render()。
// pill 曾只在真实浏览器路径被调用，因未定义而每轮抛 ReferenceError，DOM 测试却全绿。
// 这里补齐浏览器能力强制执行实时分支，把这类错误变成可观测的 DOM 缺口。
function renderLive(dataset=data){
 const ids=[...page.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);
 const nodes=Object.fromEntries(ids.map(id=>[id,{innerHTML:'',textContent:'',value:'',checked:false,clientWidth:1440,
  handlers:{},addEventListener(k,f){this.handlers[k]=f;}}]));
 nodes.dataset.textContent=JSON.stringify(dataset);nodes.pool.value='core';nodes.direction.value='out';
 const jsonp=[],intervals=[],rejections=[];let timerId=0;
 const head={appendChild(s){jsonp.push(s);}};
 const document={getElementById:id=>nodes[id],documentElement:{dataset:{}},head,
  createElement:()=>({charset:'',src:'',onload:null,onerror:null,remove(){}})};
 // 9 秒兜底与下载用的长定时器不真正注册，避免测试进程被挂住。
 const fakeSetTimeout=(fn,ms)=>ms>=1000?++timerId:setTimeout(fn,ms);
 const context={document,window:{addEventListener(){}},setTimeout:fakeSetTimeout,
  fetch:()=>Promise.resolve({ok:false,json:()=>Promise.resolve(null)}),
  setInterval:(fn,ms)=>{intervals.push({fn,ms});return intervals.length;},clearInterval:()=>{}};
 const onReject=e=>rejections.push(e);
 process.on('unhandledRejection',onReject);
 try{vm.runInNewContext(script,context);}
 catch(e){process.removeListener('unhandledRejection',onReject);throw e;}
 return {nodes,context,jsonp,intervals,rejections,off:()=>process.removeListener('unhandledRejection',onReject)};
}

test('browser-capable intraday render has no uncaught ReferenceError (pill stays global)',async()=>{
 const e=renderLive();
 try{
  assert.equal(e.jsonp.length,1,'浏览器环境应发起一次 JSONP 行情请求');
  e.jsonp[0].onload();
  for(let i=0;i<4;i++)await new Promise(r=>setImmediate(r));
  assert.deepEqual(e.rejections,[],'实时 render() 抛出了未捕获异常；常见原因是 pill 未定义为全局');
  assert.notEqual(e.nodes.intradayStage.textContent,'实时通道未启用','必须走实时分支，不能是静态降级');
  assert.match(e.nodes.intradayStage.textContent,/盘中实时|行情过期/);
  assert.match(e.nodes.intradayStatus.innerHTML,/<span class="pill/,'render() 应生成完整状态标签');
  assert.ok(e.nodes.intradayStatus.innerHTML.includes('身份：I0'));
  assert.ok(e.nodes.intradayStatus.innerHTML.includes('采集器快照：未发布'));
  assert.ok(e.intervals.some(x=>x.ms===60000),'应注册 60 秒轮询');
 }finally{e.off();}
});
