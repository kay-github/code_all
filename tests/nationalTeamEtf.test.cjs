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
 assert.equal(Object.keys(data.exchange.instruments).length,15);assert.equal(data.exchange.stage,'次晨复核');
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
 nodes.search.value='510330';nodes.search.handlers.input();assert.equal((nodes.fundRows.innerHTML.match(/<tr>/g)||[]).length,1);
 nodes.themeToggle.onclick();assert.equal(document.documentElement.dataset.siteTheme,'dark');
 nodes.themeToggle.onclick();assert.equal(document.documentElement.dataset.siteTheme,'light');
});

test('empty discovery and incomplete official data show gaps without zero totals',()=>{
 const d=structuredClone(data);d.discovery.queue=[];d.exchange.latest.complete=false;d.exchange.latest.net_estimate=null;
 d.exchange.instruments['510300'].latest=null;
 const {nodes}=render(390,d);
 assert.ok(nodes.interpretation.textContent.includes('暂不展示核心池完整合计'));
 assert.ok(nodes.discoveryRows.innerHTML.includes('尚无有效扫描数据'));
 assert.ok(nodes.kpis.innerHTML.includes('—'));
});
