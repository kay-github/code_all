const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const local=process.env.FUND_TRACK_LOCAL_TEST==='1';
const root=process.env.FUND_TRACK_SITE_DIR||path.resolve(__dirname,'../tools/fund-dragon-recovery');
const page=fs.readFileSync(path.join(root,local?'report.html':'index.html'),'utf8');
const data=JSON.parse(page.match(/<script type="application\/json" id="dataset">([\s\S]*?)<\/script>/)[1]);
const script=[...page.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)].filter(m=>!m[1].includes('src=')&&!m[1].includes('application/json')).map(m=>m[2]).join('\n');
function render(dataset=data){
 const ids=[...page.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);
 assert.equal(new Set(ids).size,ids.length,'unique DOM identifiers');
 const nodes=Object.fromEntries(ids.map(id=>[id,{innerHTML:'',textContent:'',value:'',disabled:false,handlers:{},addEventListener(k,f){this.handlers[k]=f;},showModal(){this.open=true;},close(){this.open=false;}}]));
 nodes.dataset.textContent=JSON.stringify(dataset);nodes.state.value='all';nodes.origin.value='all';nodes.kind.value='all';
 const document={getElementById:id=>nodes[id],documentElement:{dataset:{}},querySelectorAll:()=>[]};
 const context={document,window:{},Blob,URL,setTimeout};vm.runInNewContext(script,context);
 return {nodes,document,context};
}
test('single build, current signal restrictions and disclosed facts',()=>{
 assert.ok(page.includes(`content="${data.build_id}"`));
 assert.equal(data.rows.length,data.summary.groups);
 assert.equal(data.rows.filter(r=>r.nav_date===data.end).length,data.summary.latest_nav_count);
 for(const r of data.rows){assert.equal(r.signal.confirmed_transaction,false);if(r.nav_date!==data.end)assert.equal(r.signal.level,null);if(r.signal.level===3)assert.equal(r.fund_review.status,'passed');if(r.facts.current)assert.equal(r.facts.current.period,data.report_period);}
});
test('search, pagination, filters, detail and theme run with real dataset',()=>{
 const {nodes,document,context}=render();
 assert.equal((nodes.fundRows.innerHTML.match(/<tr>/g)||[]).length,Math.min(40,data.rows.length));
 assert.equal((nodes.mobileRows.innerHTML.match(/class="item"/g)||[]).length,Math.min(40,data.rows.length));
 nodes.next.onclick();assert.ok(nodes.count.textContent.includes('第2/'));
 const r=data.rows[0];nodes.search.value=r.code;nodes.search.handlers.input();assert.ok(nodes.count.textContent.includes('第1/'));
 assert.ok(nodes.fundRows.innerHTML.includes(r.name));context.detail(r.code);assert.equal(nodes.detail.open,true);
 assert.ok(nodes.detailBody.innerHTML.includes('个基其他重仓股对照'));nodes.closeDetail.onclick();assert.equal(nodes.detail.open,false);
 nodes.search.value='不存在的基金xyz';nodes.search.handlers.input();assert.ok(nodes.fundRows.innerHTML.includes('没有符合条件'));
 nodes.search.value='';nodes.state.value='strong';nodes.state.handlers.change();
 assert.equal((nodes.mobileRows.innerHTML.match(/class="item"/g)||[]).length,Math.min(40,data.rows.filter(r=>r.signal.level===3).length));
 nodes.state.value='all';nodes.kind.value='enhanced_index';nodes.kind.handlers.change();
 assert.equal((nodes.mobileRows.innerHTML.match(/class="item"/g)||[]).length,Math.min(40,data.rows.filter(r=>r.category==='enhanced_index').length));
 nodes.theme.onclick();assert.equal(document.documentElement.dataset.siteTheme,'dark');nodes.theme.onclick();assert.equal(document.documentElement.dataset.siteTheme,'light');
});
test('empty dataset and unknown NAV remain explicit',()=>{
 const d=structuredClone(data);d.rows=[];d.summary.groups=0;d.summary.latest_nav_count=0;d.summary.latest_nav_coverage=0;
 const {nodes}=render(d);assert.ok(nodes.fundRows.innerHTML.includes('没有符合条件'));assert.ok(nodes.kpis.innerHTML.includes('0.0%'));
 const r=data.rows.find(r=>r.nav_date!==data.end);if(r){const v=render();v.context.detail(r.code);assert.ok(v.nodes.detailBody.innerHTML.includes(r.nav_date||'缺失'));}
});
test('untrusted strings are escaped and cannot inject HTML',()=>{
 const d=structuredClone(data);d.rows=[structuredClone(data.rows[0])];d.rows[0].name='<img src=x onerror=alert(1)>';
 const {nodes}=render(d);assert.ok(nodes.fundRows.innerHTML.includes('&lt;img'));assert.ok(!nodes.fundRows.innerHTML.includes('<img'));
});
test('responsive and accessibility rules exist; this does not replace visual browser QA',()=>{
 assert.ok(page.includes('@media(max-width:760px)'));assert.ok(page.includes('min-height:44px'));assert.ok(page.includes(':focus-visible'));
 assert.ok(page.includes('/assets/site-theme.js'));assert.ok(page.includes('/assets/workspace-theme.css'));assert.ok(page.includes('<dialog'));
 assert.ok(!page.includes('08:40 自动更新'));assert.ok(!page.includes('已清仓'));
});
if(!local){
 test('public JSON and normalized release file hashes reconcile',()=>{
  const pub=JSON.parse(fs.readFileSync(path.join(root,'data/latest.json'),'utf8'));
  assert.deepEqual(pub,data);
  const receipt=JSON.parse(fs.readFileSync(path.join(root,'data/release.json'),'utf8'));assert.equal(receipt.build_id,data.build_id);
  for(const [file,hash] of Object.entries(receipt.files)){
   let b=fs.readFileSync(path.resolve(root,'../..',file));if(!file.endsWith('.gz'))b=Buffer.from(b.toString('utf8').replace(/\r\n/g,'\n'));
   assert.equal(crypto.createHash('sha256').update(b).digest('hex'),hash,file);
  }
 });
}
