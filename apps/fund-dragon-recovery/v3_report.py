"""All public views are generated from the same immutable analysis dataset."""
from __future__ import annotations
import html,json
from pathlib import Path


def public_data(a):
    public={k:a[k] for k in ['version','build_id','end','report_period','built_at','collected_at','summary','scope','limitations']}
    public['market']={a['end']:a['market'][a['end']]}
    public['history']=a['history']
    public['quality']=dict(catalogue_count=a['quality']['catalogue_count'],peer_coverage=a['quality']['peer_coverage'],
        nav_fetch_errors=a['quality']['nav_fetch_errors'],price_fetch_errors=a['quality']['price_fetch_errors'],
        nav_issues=sum(len(v) for v in a['quality']['nav_issues'].values()),
        report_pages_complete=a['quality']['report_pages_complete'],disclosure_issues=a['quality']['disclosure_issues'])
    public['rows']=[]
    for r in a['rows']:
        x={k:r[k] for k in ['code','name','company','category','members','membership_status','seed_group','nav_date','nav_source','recent_return_coverage','nav_frequency_warning','adjusted_p','fund_review','hist']}
        x['signal']={k:r['signal'][k] for k in ['level','label','confirmed_transaction']}
        x['models']={'broad':{n:{k:v for k,v in f.items() if k in ['usable','value','r2','low','high','reason']} for n,f in r['models']['broad'].items()}}
        x['change']={s:{k:v for k,v in f.items() if k in ['usable','identifiable','value','low','high','idio_std_pp','recent','reason']} for s,f in r['change'].items()}
        x['holdout']={k:v for k,v in r['holdout'].items() if k in ['usable','gain']}
        x['facts']={k:r['facts'][k] for k in ['current','current_status','last_known']}
        if x['facts']['last_known']:
            x['facts']['last_known']={k:x['facts']['last_known'][k] for k in ['code','period','known_sum_pct']}
        public['rows'].append(x)
    def rounded(v):
        if isinstance(v,float):return round(v,7)
        if isinstance(v,dict):return {k:rounded(x) for k,x in v.items()}
        if isinstance(v,list):return [rounded(x) for x in v]
        return v
    return rounded(public)


def render(a,folder):
    public=public_data(a)
    payload=json.dumps(public,ensure_ascii=False,allow_nan=False,separators=(',',':')).replace('<','\\u003c')
    page=TEMPLATE.replace('__DATA__',payload).replace('__END__',html.escape(a['end'])).replace('__BUILD__',html.escape(a['build_id']))
    folder=Path(folder)
    for name in ['report.html','combined.html','association.html']:(folder/name).write_text(page,encoding='utf8')


TEMPLATE=r'''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="fund-track-build" content="__BUILD__"><title>光模块双龙 · 仓位回补状态 __END__</title>
<script src="/assets/site-theme.js"></script><link rel="stylesheet" href="/assets/workspace-theme.css">
<style>
:root{--bg:#f1f5f9;--surface:#fff;--inset:#edf2f7;--line:#dce4ed;--text:#172536;--muted:#64748b;--accent:#2563eb;--red:#d8404d;--green:#16845d;--amber:#996308;--violet:#7c3aed}
@media(prefers-color-scheme:dark){:root:not([data-site-theme="light"]){--bg:#0e1520;--surface:#172231;--inset:#111c2b;--line:#2c3d50;--text:#e3ebf4;--muted:#a3b1c3;--accent:#79b2ff;--red:#ff7b85;--green:#5ac69c;--amber:#edc170;--violet:#b79bff}}
:root[data-site-theme="dark"]{--bg:#0e1520;--surface:#172231;--inset:#111c2b;--line:#2c3d50;--text:#e3ebf4;--muted:#a3b1c3;--accent:#79b2ff;--red:#ff7b85;--green:#5ac69c;--amber:#edc170;--violet:#b79bff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.65 system-ui,"Microsoft YaHei",sans-serif}
header,main{max-width:1240px;margin:auto;padding:20px 24px}
header{display:flex;gap:16px;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg);z-index:20}
nav{display:flex;flex-wrap:wrap;gap:12px;align-items:center;font-size:14px}
a{color:var(--accent)}h1{font-size:clamp(24px,3.4vw,32px);line-height:1.35;margin:6px 0 10px}
h2{font-size:19px;margin:0 0 14px}h3{font-size:15px;margin:0 0 8px}
p{margin:8px 0}.lead,.note,small{color:var(--muted)}.note,small{font-size:12px;overflow-wrap:anywhere}
small{display:block}.eyebrow{font-size:12px;color:var(--muted);letter-spacing:.02em}
section,.card{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:20px;margin:16px 0}
.hero{border-left:3px solid var(--accent);padding:24px}
.state{display:inline-flex;align-items:center;gap:8px;font-size:13px;font-weight:600;padding:5px 12px;border-radius:999px;background:var(--inset);border:1px solid var(--line);margin-bottom:10px}
.dot{width:9px;height:9px;border-radius:50%;background:var(--amber)}
.big{font:700 clamp(30px,5vw,46px)/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:-.02em}
.kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-top:18px}
.kpi{background:var(--inset);border:1px solid var(--line);border-radius:10px;padding:14px}
.kpi b{font:700 26px/1.3 ui-monospace,monospace;display:block;letter-spacing:-.01em}
.kpi small{font-size:12px;margin-top:2px}
.up{color:var(--red)}.dn{color:var(--green)}.warn{color:var(--amber)}.mut{color:var(--muted)}
.pill{display:inline-block;font-size:12px;padding:2px 8px;background:var(--inset);border:1px solid var(--line);border-radius:6px;white-space:nowrap}
.pill.ok{color:var(--green);border-color:var(--green)}.pill.bad{color:var(--red);border-color:var(--red)}
input,select,button{font:inherit;color:var(--text);background:var(--surface);border:1px solid var(--line);border-radius:8px;min-height:44px;padding:8px 12px}
button{cursor:pointer}button:hover{border-color:var(--accent)}:focus-visible{outline:3px solid var(--accent);outline-offset:3px}
.tools{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:14px 0}.tools input{min-width:0;flex:1}
.mobile .item{padding:14px 0;border-bottom:1px solid var(--line);display:flex;flex-direction:column;gap:6px}
.mobile .item>b{font-size:15px;line-height:1.35}
.mobile .item>small{color:var(--muted);font-size:12px}
.metrics{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:2px 0}
.metrics>span{font:600 15px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace}
.metrics small{display:block;font:400 11px/1.6 inherit;color:var(--muted);letter-spacing:0}
.mobile .item>button{width:100%;margin-top:2px}
.empty{padding:20px;color:var(--muted);text-align:center}
dialog{border:1px solid var(--line);border-radius:14px;padding:22px 24px 24px;background:var(--surface);color:var(--text);width:min(780px,92vw);max-width:min(780px,92vw);max-height:86vh;overflow:auto;box-shadow:0 24px 64px rgba(0,0,0,.28)}
dialog::backdrop{background:rgba(10,14,22,.55)}
dialog .close{position:absolute;top:12px;right:12px;min-height:36px;padding:4px 12px;font-size:13px}
dialog h2{margin:0 52px 8px 0;font-size:19px;line-height:1.35}
dialog p{margin:8px 0;font-size:13px;line-height:1.7}
dialog .scroll{margin:10px 0}
.scroll{overflow:auto;max-width:100%}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{padding:9px 8px;border-bottom:1px solid var(--line);text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
th{font-size:12px;color:var(--muted);background:var(--inset);position:sticky;top:0}
th:first-child,td:first-child{text-align:left}
td.name{max-width:240px;min-width:160px;white-space:normal}
.chart{width:100%;height:auto;display:block;margin:6px 0 2px}
.cmp{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:6px}
.cmp>div{background:var(--inset);border:1px solid var(--line);border-radius:10px;padding:14px}
.cmp b{font:700 24px/1.3 ui-monospace,monospace;display:block}
.bar{height:26px;border-radius:6px;background:var(--inset);display:flex;overflow:hidden;margin:8px 0 4px;border:1px solid var(--line)}
.bar i{display:block;height:100%}
.legend{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--muted);margin-top:6px}
.legend span{display:inline-flex;align-items:center;gap:6px}
.sw{width:10px;height:10px;border-radius:3px;display:inline-block}
.two{display:grid;grid-template-columns:1fr 1fr;gap:16px}
ol.rank{margin:0;padding-left:22px}ol.rank li{margin:7px 0;font-size:13px}
details{border-top:1px solid var(--line);padding:12px 0}summary{cursor:pointer;font-weight:600;padding:4px 0}
.pager{display:flex;gap:12px;align-items:center;justify-content:center;margin-top:14px}
.mobile{display:none}
@media(max-width:760px){header{flex-wrap:wrap;row-gap:8px}header strong{flex:1 0 100%;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}nav{flex:1 0 100%;flex-wrap:nowrap;overflow-x:auto;gap:14px;padding-bottom:4px;scrollbar-width:none}nav::-webkit-scrollbar{display:none}nav a,#theme{white-space:nowrap}nav #theme{position:sticky;right:0;margin-left:auto;background:var(--bg);box-shadow:-8px 0 8px -6px var(--bg)}header,main{padding:14px}.kpis{grid-template-columns:1fr 1fr}.cmp{grid-template-columns:1fr}.two{grid-template-columns:1fr}section,.card{padding:14px}.desktop{display:none}.mobile{display:block}.tools{display:grid;grid-template-columns:auto minmax(0,1fr);gap:8px 10px;align-items:center}.tools input{flex-basis:auto;width:100%}.tools select,.tools button{width:100%}.tools button{grid-column:1/-1}input,select{font-size:16px}h2{font-size:18px}}
</style></head><body>
<header><strong>光模块双龙 · 仓位回补状态</strong><nav><a href="/">工具站</a><a href="#statePanel">状态</a><a href="#trend">对照巅峰</a><a href="#funds">个基明细</a><a href="#disclosures">披露持仓</a><a href="#quality">方法边界</a><button id="theme" aria-label="切换深浅色">深浅色</button></nav></header>
<main>
<section class="hero" id="statePanel">
  <div class="eyebrow">数据日 __END__ · 已公布净值与收盘行情</div>
  <h1 id="verdict"></h1>
  <p class="lead" id="verdictText"></p>
  <div class="kpis" id="kpis"></div>
</section>

<section id="trend"><h2>当前 vs 巅峰：仓位回来了多少</h2>
<p class="note" id="trendNote"></p>
<div class="cmp" id="cmp"></div>
<svg class="chart" id="chart" viewBox="0 0 720 250" role="img" aria-label="中位恢复度历史轨迹"></svg>
<div class="legend"><span><i class="sw" style="background:var(--accent)"></i>中位恢复度（隐含仓位÷披露权重）</span><span><i class="sw" style="background:var(--muted)"></i>0.8 达标线</span><span><i class="sw" style="background:var(--line)"></i>0 基准线</span></div>
<div style="margin-top:16px"><h3>当前恢复度分布</h3><div class="bar" id="distBar"></div><div class="legend" id="distLegend"></div></div>
</section>

<section id="highlights"><h2>两极名单</h2><p class="note">按「当前恢复度」排序。恢复度＝隐含仓位β20 ÷ 季报披露双龙权重；负值表示双龙上涨时净值反而跑输，不代表做空。只列披露权重≥3%的观察组。</p>
<div class="two"><div><h3>最像已买回</h3><ol class="rank" id="topList"></ol></div><div><h3>最不像买回</h3><ol class="rank" id="bottomList"></ol></div></div></section>

<section id="funds"><h2>个基明细</h2><p class="note" id="fundsNote">默认只看核心对照（披露权重达标），按当前恢复度降序；可切到全部观察组或小权重。β 为控制市场与产业链后的收益敏感度；未列前十大不等于零持仓。</p>
<div class="tools"><label for="search">基金搜索</label><input id="search" placeholder="代码、名称或基金公司"><label for="pool">样本</label><select id="pool"><option value="core">核心对照</option><option value="all">全部观察组</option><option value="small">小权重（仅供参考）</option></select><label for="state">线索</label><select id="state"><option value="all">全部观察组</option><option value="strong">较强线索</option><option value="warming">升温与分歧线索</option><option value="weakening">收益关联走弱</option><option value="unknown">数据或辨识度不足</option></select><label for="kind">类别</label><select id="kind"><option value="all">全部类别</option><option value="active_domestic">主动基金</option><option value="enhanced_index">指数增强观察</option></select><label for="origin">来源</label><select id="origin"><option value="all">全部来源</option><option value="seed">原始观察种子</option><option value="expanded">两期披露扩展</option></select><button id="download">下载本页数据</button></div>
<div class="scroll desktop"><table><thead><tr><th>基金 / 观察组</th><th>当前恢复度</th><th>巅峰恢复度</th><th>距巅峰</th><th>β20</th><th>披露双龙权重<small style="display:block;font-weight:400">最近可确认</small></th><th>线索</th><th>核查</th></tr></thead><tbody id="fundRows"></tbody></table></div>
<div class="mobile" id="mobileRows"></div>
<div class="pager"><button id="prev">上一页</button><span id="count" class="note"></span><button id="next">下一页</button></div>
<p class="note" id="weightNote"></p>
</section>

<section id="disclosures"><h2>最近报告期可确认的披露持仓</h2><p id="disclosureScope" class="note"></p><div class="scroll"><table><thead><tr><th>基金 / 披露代码</th><th>报告期</th><th>新易盛权重</th><th>中际旭创权重</th><th>已列权重合计</th><th>来源核验</th></tr></thead><tbody id="disclosureRows"></tbody></table></div>
<p class="note">列表随上方搜索及筛选同步，只显示该页观察组。未列入前十大、本期反查未见记录或份额关联未核验，均不代表零持仓。历史权重不能直接当作今天的仓位。</p></section>
<section id="quality"><h2>数据、样本与验证边界</h2><div id="qualitySummary"></div>
<details><summary>恢复度怎么算，能不能当真实仓位</summary>
<p>恢复度＝隐含仓位（20日β，控制沪深300、创业板、剔除双龙的产业链篮子与两只股票相对收益后估计）÷季报披露的双龙权重。1.0 表示净值表现与季报满配时的应有贡献吻合，0 表示毫无关联，负值表示反向。</p>
<p>它是<b>收益关联的换算</b>，不是真实持股。β 有估计误差，披露权重来自季报（截至报告期），两者不在同一时点；小权重基金做分母会放大噪声，因此核心对照只取披露权重≥3% 的观察组。峰值取可回溯窗口内的最高中位恢复度，不代表历史最优仓位。</p>
<p>恢复度大于 1 甚至到 2 以上时，含义是「净值对双龙的敏感度超过季报满配」，常见原因是除双龙外还持有篮子外的其他光模块个股，或小规模基金的估计噪声；<b>不能把它读成买回了几倍</b>。反过来负值表示双龙上涨时净值反而跑输，也不等于做空。</p>
<p>页面不再设「0.8 即确认回补」的机械判定，也不由模型自动停止追踪。真实买卖仍需后续持仓资料验证。</p></details>
<details><summary>计算方法和数据处理</summary><p>对基金原始净值收益回归，市场暴露自由估计；同时控制宽基、创业板、剔除双龙的产业链篮子，以及两只股票的收益差异。所有窗口按交易日对齐，缺失和过期净值不补0、不冒充当日信号；分红调整收益保留原始说明。</p><p>宽窄两套模型分别估计20/40/60日关联。前后20日变化使用联合协方差计算，样本不足、因子共线或独有波动不足会明确标记。全体观察组进行Benjamini-Yekutieli多重比较修正。</p><p>顺序留出检验比较含双龙因子的模型与市场/板块对照模型对之后10日收益的解释，不能证明买卖行为。</p></details>
<details><summary>来源与持续追踪</summary><p>净值及定报反查由东方财富公开接口提供，原始响应、URL、采集时间和哈希按批次留档。报告原文已做样本核验，大多数基金仍是第三方定报汇总。宽窄行情篮子使用同源前复权日线，不以实时快照伪造历史收盘。</p><p>样本来自最近两期主动及指数增强披露持有人并集及原始观察种子，不设高权重门槛。两期报告都未列出的新建仓基金可能遗漏。未汇总无法确认的当前基金规模、当前持股市值或买入金额。</p><p><a href="https://www.csrc.gov.cn/shenzhen/c105614/c7602038/content.shtml">证监局：持仓披露非实时</a> · <a href="https://web.stanford.edu/~wfsharpe/art/sa/sa.htm">收益风格分析的模型假设</a></p></details>
</section>
<footer class="note">业务日 __END__ · 构建 __BUILD__<br>真实最新持仓与交易仍需后续持仓资料验证。历史回看采用当前样本和修订后数据，不冒充当时已知持仓或实时样本外结果。</footer>
</main>
<dialog id="detail"><button id="closeDetail" class="close">关闭</button><div id="detailBody"></div></dialog>
<script type="application/json" id="dataset">__DATA__</script><script>
const D=JSON.parse(document.getElementById('dataset').textContent),$=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=(x,n=3)=>x===null||x===undefined?'—':Number(x).toLocaleString('zh-CN',{minimumFractionDigits:n,maximumFractionDigits:n});
const pct1=x=>x===null||x===undefined?'—':fmt(x*100,1)+'%';
const signed=(x,n=3)=>x===null||x===undefined?'—':(x>0?'+':'')+fmt(x,n);
const S=D.summary,H=D.history||{timeline:[],latest:{rec:null,pas:null},dist:{latest:{}}};
const recNow=r=>r.hist?r.hist.rec_now:null,recPeak=r=>r.hist?r.hist.rec:null,wt=r=>r.hist?r.hist.weight:null;
const TH=H.threshold===undefined||H.threshold===null?3:H.threshold;
const gated=r=>wt(r)!==null&&wt(r)>=TH;
const usable=D.rows.filter(r=>recNow(r)!==null);
function stateOf(m){const v=m===null||m===undefined?0:m;return v>=0.8?'已基本买回':v>=0.4?'部分回补':v>=0?'微弱关联':'反向（未买回）';}
const medRec=H.latest?H.latest.rec:null,passRec=H.latest?H.latest.pas:null;
$('verdict').textContent=medRec===null?'当前缺少可比的恢复度样本':stateOf(medRec)+'：中位恢复度 '+signed(medRec,2)+(passRec!==null?'，达标 '+pct1(passRec):'');
const peakH=(H.timeline||[]).reduce((a,b)=>a&&a.rec>=b.rec?a:b,null);
$('verdictText').textContent=(H.peak_date?'可回溯窗口内的最高中位恢复度出现在 '+H.peak_date+'（'+signed(peakH?peakH.rec:null,2)+'），当前为 '+signed(medRec,2)+'。':'')+' 恢复度＝隐含仓位÷季报披露权重，衡量净值能否对应上双龙涨跌，不是真实持股。数据日 '+D.end+'，同日净值覆盖 '+fmt(S.latest_nav_coverage*100,1)+'%（'+S.latest_nav_count+'/'+S.groups+' 组）。';
$('kpis').innerHTML=[
 ['当前中位恢复度',signed(medRec,2),medRec>=0.8?'与季报仓位基本对应':'低于季报满配水平'],
 ['达标组数（≥0.8）',passRec===null?'—':pct1(passRec),'其中 '+(H.dist&&H.dist.latest?H.dist.latest.back80:0)+' 组'],
 ['负关联占比',(function(){const l=H.dist&&H.dist.latest;if(!l||!l.total)return '—';return pct1(l.neg/l.total);})(),'双龙上涨时净值反而跑输'],
 ['同日净值覆盖',fmt(S.latest_nav_coverage*100,1)+'%',`${S.latest_nav_count}/${S.groups} 个观察组`]
].map(([k,v,n])=>`<div class="kpi"><small>${esc(k)}</small><b>${esc(v)}</b><small>${esc(n)}</small></div>`).join('');
$('trendNote').textContent='核心对照只统计披露权重≥'+H.threshold+'% 的 '+H.core_n+' 个观察组，避免小权重做分母放大噪声；其中当日可算出恢复度的 '+(H.dist&&H.dist.latest?H.dist.latest.total:H.core_n)+' 组参与下面的分布与中位。恢复度按同一套20日模型回溯，越靠左样本越少。';
function card(title,e,cls){const r=e?e.rec:null;return `<div><small>${esc(title)}</small><b class="${cls||''}">${signed(r,2)}</b><small>达标 ${e?pct1(e.pas):'—'} · 负关联 ${e?pct1(e.neg):'—'}</small></div>`;}
const t=H.timeline||[];
$('cmp').innerHTML=t.length?card('巅峰 · '+H.peak_date,peakH,'up')+card('11-11 双龙暴涨日',t.find(e=>e.d==='2026-11-11')||null)+card('当前 · '+D.end,H.latest,medRec<0?'dn':''):'<div><small>无历史样本</small><b>—</b></div>';
(function(){const el=$('chart');if(!t.length){el.innerHTML='';return;}
 const W=720,Hh=250,pad={l:46,r:58,t:14,b:28},iw=W-pad.l-pad.r,ih=Hh-pad.t-pad.b;
 const vals=t.map(e=>e.rec).filter(v=>v!==null);const lo=Math.min(0,...vals),hi=Math.max(0.8,...vals);
 const pad2=(hi-lo)*.12||.1,ymin=lo-pad2,ymax=hi+pad2;
 const X=i=>pad.l+(t.length<2?iw/2:i*iw/(t.length-1));
 const Y=v=>pad.t+ih-(v-ymin)/(ymax-ymin)*ih;
 let g='';
 const zy=Y(0),ty=Y(0.8);
 g+=`<line x1="${pad.l}" y1="${zy}" x2="${W-pad.r}" y2="${zy}" stroke="var(--line)" stroke-width="1"/>`;
 g+=`<line x1="${pad.l}" y1="${ty}" x2="${W-pad.r}" y2="${ty}" stroke="var(--muted)" stroke-width="1" stroke-dasharray="4 4"/>`;
 g+=`<text x="${pad.l-6}" y="${zy+4}" text-anchor="end" font-size="10" fill="var(--muted)">0</text>`;
 g+=`<text x="${pad.l-6}" y="${ty+4}" text-anchor="end" font-size="10" fill="var(--muted)">0.8</text>`;
 const pts=t.map((e,i)=>e.rec===null?null:[X(i),Y(e.rec)]).filter(Boolean);
 if(pts.length>1){g+=`<polyline fill="none" stroke="var(--accent)" stroke-width="2.2" points="${pts.map(p=>p.join(',')).join(' ')}"/>`;}
 const lab=[];const placeLabel=(cx,cy)=>{for(const ly of [cy-9,cy+18,cy-22,cy+31,cy-35,cy+44]){if(ly<12||ly>Hh-30)continue;if(!lab.some(o=>Math.abs(o.x-cx)<62&&Math.abs(o.y-ly)<12)){lab.push({x:cx,y:ly});return ly;}}lab.push({x:cx,y:cy-9});return cy-9;};
 t.forEach((e,i)=>{if(e.rec===null)return;const cx=X(i),cy=Y(e.rec);
  const key=e.d===H.peak_date||e.d==='2026-11-11'||e.d===D.end;
  g+=`<circle cx="${cx}" cy="${cy}" r="${key?4.2:2.4}" fill="${key?'var(--accent)':'var(--accent)'}" opacity="${key?1:.55}"/>`;
  if(key){const ly=placeLabel(cx,cy);const anchor=cx>W-pad.r-24?'end':'middle';g+=`<text x="${anchor==='end'?cx+4:cx}" y="${ly}" text-anchor="${anchor}" font-size="10" fill="var(--text)">${esc(e.d.slice(5))} ${signed(e.rec,2)}</text>`;}});
 const step=Math.max(1,Math.ceil(t.length/6));
 t.forEach((e,i)=>{if(i%step&&i!==t.length-1)return;const anchor=i===t.length-1?'end':'middle';g+=`<text x="${anchor==='end'?X(i)+4:X(i)}" y="${Hh-8}" text-anchor="${anchor}" font-size="10" fill="var(--muted)">${esc(e.d.slice(5))}</text>`;});
 el.innerHTML=g;})();
(function(){const l=H.dist&&H.dist.latest;if(!l||!l.total){$('distBar').innerHTML='';$('distLegend').innerHTML='<span>无样本</span>';return;}
 const seg=[[l.back80,'var(--green)','已基本买回 ≥0.8'],[l.part,'var(--accent)','部分 0.3~0.8'],[l.weak,'var(--amber)','微弱 0~0.3'],[l.neg,'var(--red)','反向 <0']];
 $('distBar').innerHTML=seg.map(([n,c])=>n?`<i style="width:${n/l.total*100}%;background:${c}" title="${n}组"></i>`:'').join('');
 $('distLegend').innerHTML=seg.map(([n,c,t])=>`<span><i class="sw" style="background:${c}"></i>${esc(t)} · ${n}组（${pct1(n/l.total)}）</span>`).join('');})();
(function(){const pool=D.rows.filter(r=>recNow(r)!==null&&wt(r)>=H.threshold);
 const line=r=>`<li>${esc(r.name)} <span class="mut">${esc(r.code)}</span> · 恢复度 ${signed(recNow(r),2)} <span class="mut">（权重 ${fmt(wt(r),1)}%，β20 ${fmt(r.models.broad['20'].value,3)}）</span></li>`;
 const up=[...pool].sort((a,b)=>recNow(b)-recNow(a)).slice(0,5).map(line).join('');
 const dn=[...pool].sort((a,b)=>recNow(a)-recNow(b)).slice(0,5).map(line).join('');
 $('topList').innerHTML=up||'<li>无可用样本</li>';$('bottomList').innerHTML=dn||'<li>无可用样本</li>';})();
$('disclosureScope').textContent=`截至报告期 ${D.report_period}，当前观察池共 ${S.share_entries} 个份额条目，归并为 ${S.groups} 个观察组。其中指数增强 ${S.categories.enhanced_index??0} 组单列观察。只有原始报告确认过的份额关系标记为已核验。`;
$('qualitySummary').innerHTML=`<p>主数据采集完成 ${esc(D.collected_at)}；构建 ${esc(D.built_at)}。来源目录 ${D.quality.catalogue_count} 个条目；披露反查分页${D.quality.report_pages_complete?'完整':'不完整'}，不代表全市场基金覆盖。</p><p>当前有 ${S.model_usable} 组可以计算40日模型，${S.identifiable} 组的前后变化在两套模型中都具有足够辨识度。净值检查发现 ${D.quality.nav_issues} 条缺口/差异。固定行情篮子近80日完整覆盖：宽 ${D.quality.peer_coverage.peer_broad.complete}/${D.quality.peer_coverage.peer_broad.expected}，窄 ${D.quality.peer_coverage.peer_core.complete}/${D.quality.peer_coverage.peer_core.expected}。</p><p>净值采集失败 ${Object.keys(D.quality.nav_fetch_errors).length} 个份额条目：${Object.keys(D.quality.nav_fetch_errors).map(esc).join('、')||'无'}。复权行情缺失 ${Object.keys(D.quality.price_fetch_errors).length} 只。原始报告已核验 ${S.verified_portfolios} 个基金样本。尚未获得真实最新持仓真值，不报告仓位识别准确率。</p>`;
$('theme').onclick=()=>{if(window.ToolSiteTheme)window.ToolSiteTheme.toggle();else document.documentElement.dataset.siteTheme=document.documentElement.dataset.siteTheme==='dark'?'light':'dark';};
let page=0,filtered=[],size=40;
function chosen(){const q=$('search').value.trim().toLowerCase(),pool=$('pool').value,state=$('state').value,origin=$('origin').value,kind=$('kind').value;
 return D.rows.filter(r=>(r.code+r.name+(r.company??'')).toLowerCase().includes(q)).filter(r=>kind==='all'||r.category===kind)
  .filter(r=>pool==='all'||(pool==='core'&&gated(r))||(pool==='small'&&!gated(r)))
  .filter(r=>origin==='all'||origin==='seed'&&r.seed_group||origin==='expanded'&&!r.seed_group)
  .filter(r=>state==='all'||state==='strong'&&r.signal.level===3||state==='warming'&&r.signal.level>0||state==='weakening'&&r.signal.label==='收益关联走弱'||state==='unknown'&&r.category!=='enhanced_index'&&(r.signal.level===null||r.signal.label.includes('辨识')))
  .sort((a,b)=>{if(gated(a)!==gated(b))return gated(a)?-1:1;const x=recNow(a),y=recNow(b);if(x===null&&y===null)return 0;if(x===null)return 1;if(y===null)return -1;return y-x;});}
function show(){filtered=chosen();const max=Math.max(0,Math.ceil(filtered.length/size)-1);page=Math.min(page,max);const rows=filtered.slice(page*size,(page+1)*size);
$('fundRows').innerHTML=rows.map(r=>{const g=e=>e===null?'—':`<b class="${e<0?'dn':e>=0.8?'up':''}"${Math.abs(e)>2?' title="恢复度绝对值>2：隐含敏感度远超季报满配，可能持有篮子外的其他光模块个股或存在估计噪声，不能当作加仓倍数"':''}>${signed(e,2)}</b>`;const ok=gated(r),cell=v=>ok?g(v):'<span class="mut" title="披露双龙权重低于门槛，恢复度无法稳定换算">不换算</span>';const pk=recPeak(r),nw=recNow(r);
 return `<tr><td class="name"><b>${esc(r.name)}</b><small>${esc(r.code)} · ${r.members.length}个份额条目${r.nav_date!==D.end?' · 净值'+esc(r.nav_date??'缺失'):''}</small></td><td>${cell(nw)}</td><td>${cell(pk)}</td><td>${ok&&nw!==null&&pk!==null?signed(nw-pk,2):'—'}</td><td>${r.models.broad['20'].usable?fmt(r.models.broad['20'].value):'—'}</td><td>${wt(r)===null?'—':`<span title="最近可确认披露 ${esc(r.facts.current?r.facts.current.period:(r.facts.last_known?r.facts.last_known.period:'未知'))}">${fmt(wt(r),2)}%</span>`}</td><td><span class="pill ${r.signal.level===3?'ok':''}">${esc(r.signal.label)}</span></td><td><button data-code="${esc(r.code)}" class="detailBtn">详情</button></td></tr>`;}).join('')||'<tr><td colspan="8" class="empty">没有符合条件的观察组</td></tr>';
$('mobileRows').innerHTML=rows.map(r=>`<div class="item"><b>${esc(r.name)}</b><small>${esc(r.code)} · 净值日 ${esc(r.nav_date??'缺失')}</small><span class="pill ${r.signal.level===3?'ok':''}">${esc(r.signal.label)}</span><div class="metrics"><span><small>当前恢复度</small>${gated(r)?signed(recNow(r),2):'不换算'}</span><span><small>巅峰恢复度</small>${gated(r)?signed(recPeak(r),2):'不换算'}</span><span><small>β20</small>${r.models.broad['20'].usable?fmt(r.models.broad['20'].value):'—'}</span><span><small>披露权重</small>${wt(r)===null?'—':fmt(wt(r),2)+'%'}</span></div><button data-code="${esc(r.code)}" class="detailBtn">核查详情与来源</button></div>`).join('')||'<div class="empty">没有符合条件的观察组</div>';
$('disclosureRows').innerHTML=rows.map(r=>{const f=r.facts.current;if(!f)return `<tr><td class="name">${esc(r.name)}<small>${esc(r.code)}</small></td><td>${D.report_period}</td><td colspan="4">该期反查未见目标记录，不能判断为零持仓</td></tr>`;const a=f.stocks['300502'],b=f.stocks['300308'],source=a??b;return `<tr><td class="name">${esc(r.name)}<small>披露代码 ${esc(f.code)}${f.code!==r.code?' · 与净值代码不同':''}</small></td><td>${esc(f.period)}</td><td>${a&&a.weight_pct!==undefined?fmt(a.weight_pct,2)+'%':'未披露'}</td><td>${b&&b.weight_pct!==undefined?fmt(b.weight_pct,2)+'%':'未披露'}</td><td>${fmt(f.known_sum_pct,2)}%<small>${f.both_reported?'两只均有记录':'仅已列部分'}</small></td><td><a href="${esc(source.original_source??source.source)}">${source.verified_original?'原报样本已核验':'第三方定报汇总'}</a></td></tr>`;}).join('')||'<tr><td colspan="6">没有符合条件的观察组</td></tr>';
$('count').textContent=`${filtered.length}组 · 第${page+1}/${Math.max(1,max+1)}页`;$('prev').disabled=page===0;$('next').disabled=page===max;
document.querySelectorAll('.detailBtn').forEach(b=>b.onclick=()=>detail(b.dataset.code));}
function detail(code){const r=D.rows.find(x=>x.code===code),f=r.facts.current,source=(f?.stocks['300502']??f?.stocks['300308']);const p=r.models.broad['40'],c=r.change.broad,a=r.change.core,rv=r.fund_review;
$('detailBody').innerHTML=`<h2>${esc(r.name)} · ${esc(r.code)}</h2><p><span class="pill ${r.signal.level===3?'ok':''}">${esc(r.signal.label)}</span></p><p>当前恢复度 <b>${gated(r)?signed(recNow(r),2):'不换算'}</b>，巅峰恢复度 ${gated(r)?signed(recPeak(r),2):'不换算'}（${r.hist&&r.hist.peak_date?esc(r.hist.peak_date):'无'}），披露双龙权重 ${wt(r)===null?'未披露':fmt(wt(r),2)+'%'}。${gated(r)?'':'该组权重低于 '+TH+'% 门槛，恢复度不参与排序与统计，避免小分母放大噪声。'}</p><p>${esc(r.membership_status)}；组内份额：${r.members.map(esc).join('、')}。</p><p>净值日 ${esc(r.nav_date??'缺失')}；最近60交易日有效收益覆盖 ${fmt(r.recent_return_coverage*100,1)}%。${r.nav_frequency_warning?'零变动净值过多，更新频度或辨识度需核查。':''}</p><div class="scroll"><table><thead><tr><th>模型</th><th>前后变化</th><th>区间</th><th>独有波动标准差</th></tr></thead><tbody>${[['宽篮子',c],['窄篮子',a]].map(([n,x])=>`<tr><td>${n}</td><td>${signed(x.value)}</td><td>${x.usable?'['+signed(x.low)+', '+signed(x.high)+']':esc(x.reason??'不足')}</td><td>${fmt(x.idio_std_pp)}pp</td></tr>`).join('')}</tbody></table></div><p>40日模型 R² ${fmt(p.r2)}；修正p值 ${fmt(r.adjusted_p,5)}。R²衡量收益拟合，不是仓位准确率。</p><p>之后10日顺序留出解释增益：${r.holdout.usable&&r.holdout.gain!==null?fmt(r.holdout.gain*100,1)+'%':'数据不足'}，与仅市场/板块模型相比；不代表真实买卖命中。</p><p>个基其他重仓股对照：${esc({passed:"通过收益稳健性检验",not_supported:"原升温证据未获支持",insufficient:"数据或辨识度不足",not_reviewed:"待核查"}[rv.status]??rv.status)}。${esc(rv.reason??rv.note)}${rv.coverage!==undefined?"；已知其他重仓股行情覆盖 "+fmt(rv.coverage*100,1)+"%":""}</p>${rv.source?`<p><a href="${esc(rv.source)}">个基持仓对照来源</a> · 报告期 ${esc(rv.period??"未取得")}</p>`:""}<p>最近已知披露：${r.facts.last_known?esc(r.facts.last_known.period)+" 已列目标权重 "+fmt(r.facts.last_known.known_sum_pct,2)+"%":"尚无目标记录"}，不是实时仓位。</p><p>当前报告期：${esc(r.facts.current_status)}。${f?'已列双龙权重合计 '+fmt(f.known_sum_pct,2)+'%，披露代码 '+esc(f.code)+'。':''}</p>${source?`<p><a href="${esc(source.original_source??source.source)}">核查持仓来源</a></p>`:''}<p><a href="${esc(r.nav_source)}">净值原始来源</a></p><p class="note">以上是收益敏感度和披露资料，不能确认当前持有多少股。未列入前十大不代表没有持仓。</p>`;
$('detail').showModal();}
$('closeDetail').onclick=()=>$('detail').close();
$('weightNote').textContent='「披露双龙权重」取最近一期能确认的双龙合计权重：本期（'+D.report_period+'）反查无记录时沿用上一期。因此恢复度衡量的是相对上一期已知仓位的吻合程度，不表示今天仍持有该份额。';
const po=$('pool');if(po&&po.options&&po.options[0])po.options[0].text='核心对照 · 披露权重≥'+TH+'%';
$('fundsNote').textContent='默认只看核心对照（披露双龙权重≥'+TH+'%），按当前恢复度降序；可切换全部观察组或小权重。β 为控制市场与产业链后的收益敏感度；未列前十大不等于零持仓。';
for(const id of ['search','pool','state','origin','kind'])$(id).addEventListener(id==='search'?'input':'change',()=>{page=0;show();});
$('prev').onclick=()=>{page=Math.max(0,page-1);show();};$('next').onclick=()=>{page++;show();};
$('download').onclick=()=>{const b=new Blob([JSON.stringify(D,null,2)],{type:'application/json'}),u=URL.createObjectURL(b),a=document.createElement('a');a.href=u;a.download='双龙回补状态_'+D.end+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);};
show();window.FUND_TRACK={buildId:D.build_id,date:D.end,groups:S.groups,confirmedTransactions:0};
</script></body></html>'''
