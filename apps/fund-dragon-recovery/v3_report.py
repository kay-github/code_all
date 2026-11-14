"""All public views are generated from the same immutable analysis dataset."""
from __future__ import annotations
import html,json
from pathlib import Path


def public_data(a):
    public={k:a[k] for k in ['version','build_id','end','report_period','built_at','collected_at','summary','scope','limitations']}
    public['market']={a['end']:a['market'][a['end']]}
    public['quality']=dict(catalogue_count=a['quality']['catalogue_count'],peer_coverage=a['quality']['peer_coverage'],
        nav_fetch_errors=a['quality']['nav_fetch_errors'],price_fetch_errors=a['quality']['price_fetch_errors'],
        nav_issues=sum(len(v) for v in a['quality']['nav_issues'].values()),
        report_pages_complete=a['quality']['report_pages_complete'],disclosure_issues=a['quality']['disclosure_issues'])
    public['rows']=[]
    for r in a['rows']:
        x={k:r[k] for k in ['code','name','company','category','members','membership_status','seed_group','nav_date','nav_source','recent_return_coverage','nav_frequency_warning','adjusted_p','fund_review']}
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
<meta name="fund-track-build" content="__BUILD__"><title>光模块双龙 · 公募回补线索与披露持仓 __END__</title>
<script src="/assets/site-theme.js"></script><link rel="stylesheet" href="/assets/workspace-theme.css">
<style>
:root{--bg:#f1f5f9;--surface:#fff;--inset:#edf2f7;--line:#dce4ed;--text:#172536;--muted:#64748b;--accent:#2563eb;--red:#d8404d;--green:#16845d;--amber:#996308}
@media(prefers-color-scheme:dark){:root:not([data-site-theme="light"]){--bg:#0e1520;--surface:#172231;--inset:#111c2b;--line:#2c3d50;--text:#e3ebf4;--muted:#a3b1c3;--accent:#79b2ff;--red:#ff7b85;--green:#5ac69c;--amber:#edc170}}
:root[data-site-theme="dark"]{--bg:#0e1520;--surface:#172231;--inset:#111c2b;--line:#2c3d50;--text:#e3ebf4;--muted:#a3b1c3;--accent:#79b2ff;--red:#ff7b85;--green:#5ac69c;--amber:#edc170}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.65 system-ui,"Microsoft YaHei",sans-serif}header,main{max-width:1320px;margin:auto;padding:20px 24px}header{display:flex;gap:16px;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line)}nav{display:flex;flex-wrap:wrap;gap:12px;align-items:center}a{color:var(--accent)}h1{font-size:clamp(25px,4vw,36px);line-height:1.3;margin:8px 0 12px}h2{font-size:20px;margin:0 0 12px}p{margin:8px 0}.lead,.note,small{color:var(--muted)}.note,small{font-size:12px;overflow-wrap:anywhere}small{display:block}.eyebrow{font-size:12px;color:var(--muted)}section,.kpi,.notice{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:18px;margin:16px 0}.notice{border-left:3px solid var(--amber)}.kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.kpi{margin:0}.kpi b{font:700 28px/1.4 ui-monospace,monospace}.kpi small{font-size:12px}.up{color:var(--red)}.dn{color:var(--green)}.pill{display:inline-block;font-size:12px;padding:2px 7px;background:var(--inset);border:1px solid var(--line);border-radius:5px}.risk{color:var(--amber)}input,select,button{font:inherit;color:var(--text);background:var(--surface);border:1px solid var(--line);border-radius:7px;min-height:44px;padding:8px 12px}button{cursor:pointer}.tools{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:14px 0}.tools input{min-width:0;flex:1}button:hover{border-color:var(--accent)}:focus-visible{outline:3px solid var(--accent);outline-offset:3px}.scroll{overflow:auto;max-width:100%}table{width:100%;border-collapse:collapse;font-size:13px}th,td{padding:10px 8px;border-bottom:1px solid var(--line);text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}th{font-size:12px;color:var(--muted);background:var(--inset)}th:first-child,td:first-child{text-align:left}td.name{max-width:230px;min-width:150px;white-space:normal}details{border-top:1px solid var(--line);margin-top:12px;padding-top:8px}summary{cursor:pointer;min-height:44px;padding:8px 0}.pager{display:flex;gap:12px;align-items:center;justify-content:center;margin-top:14px}.mono{font-family:ui-monospace,monospace;font-variant-numeric:tabular-nums}.mobile{display:none}.item{padding:14px 0;border-bottom:1px solid var(--line)}.metrics{display:grid;grid-template-columns:1fr 1fr;gap:6px 12px;margin:10px 0}.muted{color:var(--muted)}.empty{padding:22px;color:var(--muted)}footer{font-size:12px;color:var(--muted);padding:22px 0 50px;overflow-wrap:anywhere}.cols{display:grid;grid-template-columns:1fr 1fr;gap:16px}dialog{background:var(--surface);color:var(--text);border:1px solid var(--line);border-radius:12px;max-width:800px;width:calc(100% - 32px);max-height:85vh;overflow:auto}dialog::backdrop{background:#0007}.close{float:right}
@media(max-width:760px){header,main{padding:16px}header{align-items:flex-start;flex-direction:column}.kpis{grid-template-columns:1fr 1fr}.cols{grid-template-columns:1fr}section{padding:14px}.desktop{display:none}.mobile{display:block}.tools input{flex-basis:100%}input,select{font-size:16px}.tools>*{max-width:100%}h2{font-size:19px}}
</style></head><body>
<header><strong>光模块双龙观察 <span class="pill">v3</span></strong><nav><a href="/">工具站</a><a href="#clues">回补线索</a><a href="#disclosures">披露持仓</a><a href="#quality">核对与边界</a><button id="theme" aria-label="切换深浅色">深浅色</button></nav></header>
<main><div class="eyebrow">已公布净值与收盘行情 · __END__</div><h1>追踪回补线索，核对已披露仓位</h1>
<p class="lead">新易盛（300502）与中际旭创（300308）。定期报告确认过去的持仓；最新净值帮助寻找收益关联变化。两类证据分开展示。</p>
<div class="notice"><b id="verdict"></b><p id="verdictText"></p></div><div class="kpis" id="kpis"></div>
<section id="clues"><h2>回补 / 增配线索</h2><p class="note">Δβ 对比最近20个交易日与此前20日，窗口不重叠。β 是控制市场和产业链后的收益敏感度；负值不证明做空，正值也不确认持有。较强线索还需宽窄模型一致、多重比较修正和顺序留出检验。</p>
<div class="tools"><label for="search">基金搜索</label><input id="search" placeholder="代码、名称或基金公司"><label for="state">线索</label><select id="state"><option value="all">全部观察组</option><option value="strong">较强线索</option><option value="warming">升温与分歧线索</option><option value="weakening">收益关联走弱</option><option value="unknown">数据或辨识度不足</option></select><label for="kind">类别</label><select id="kind"><option value="all">全部类别</option><option value="active_domestic">主动基金</option><option value="enhanced_index">指数增强观察</option></select><label for="origin">来源</label><select id="origin"><option value="all">全部来源</option><option value="seed">原始观察种子</option><option value="expanded">两期披露扩展</option></select><button id="download">下载本页数据</button></div>
<div class="scroll desktop"><table><thead><tr><th>基金 / 观察组</th><th>最新净值日</th><th>β20</th><th>β40</th><th>β60</th><th>Δβ / 近似区间</th><th>修正p值</th><th>当前线索</th><th>核查</th></tr></thead><tbody id="fundRows"></tbody></table></div><div class="mobile" id="mobileRows"></div><div class="pager"><button id="prev">上一页</button><span id="count" class="note"></span><button id="next">下一页</button></div>
<details><summary>如何理解线索强弱</summary><p>“较强”仍然只是收益模型中的候选：宽窄两套对照、区间、辨识度、解释力、多重比较修正、留出表现，以及加入个基已披露其他重仓股的检验共同通过。“初步”保留尚不稳健的升温；负向关联缓和、模型分歧和点估计变化单独保留。暂无证据不等于没有回补。</p><p>区间基于模型残差的近似HAC估计，不覆盖所有模型遗漏和结构变化，不是实际仓位的置信区间。修正p值不能当作买入概率，也不是实际持仓识别错误率。</p></details></section>
<section id="disclosures"><h2>最新报告期内可确认的披露持仓</h2><p id="disclosureScope" class="note"></p><div class="scroll"><table><thead><tr><th>基金 / 披露代码</th><th>报告期</th><th>新易盛权重</th><th>中际旭创权重</th><th>已列权重合计</th><th>来源核验</th></tr></thead><tbody id="disclosureRows"></tbody></table></div><p class="note">列表随上方搜索及筛选同步，只显示该页观察组。未列入前十大、本期反查未见记录或份额关联未核验，均不代表零持仓。历史权重不能直接当作今天的仓位，也不能仅凭权重变化确认主动买卖。</p></section>
<section id="quality"><h2>数据、样本与验证边界</h2><div id="qualitySummary"></div><details><summary>计算方法和数据处理</summary><p>对基金原始净值收益回归，市场暴露自由估计；同时控制宽基、创业板、剔除双龙的产业链篮子，以及两只股票的收益差异。所有窗口按交易日对齐，缺失和过期净值不补0、不冒充当日信号；分红调整收益保留原始说明。</p><p>宽窄两套模型分别估计20/40/60日关联。前后20日变化使用联合协方差计算，样本不足、因子共线或独有波动不足会明确标记。全体观察组进行Benjamini-Yekutieli多重比较修正；这些近似统计仍依赖模型假设。</p><p>顺序留出检验比较含双龙因子的模型与市场/板块对照模型对之后10日收益的解释，不能证明买卖行为。没有以某个历史峰值校准“满仓”，没有0.8即回补的机械判断，也不会由模型自动停止持续追踪。</p></details><details><summary>来源与持续追踪</summary><p>净值及定报反查由东方财富公开接口提供，原始响应、URL、采集时间和哈希按批次留档。报告原文已做样本核验，大多数基金仍是第三方定报汇总。宽窄行情篮子使用同源前复权日线，不以实时快照伪造历史收盘。</p><p>样本来自最近两期主动及指数增强披露持有人并集及原始观察种子，不设高权重门槛。指数增强单列观察，不据净值判定主动回补。两期报告都未列出的新建仓基金可能遗漏；名称归并组不等于所有份额关系都已确认。未汇总无法确认的当前基金规模、当前持股市值或买入金额。</p><p><a href="https://www.csrc.gov.cn/shenzhen/c105614/c7602038/content.shtml">证监局：持仓披露非实时</a> · <a href="https://web.stanford.edu/~wfsharpe/art/sa/sa.htm">收益风格分析的模型假设</a></p></details></section>
<footer>业务日 __END__ · 构建 __BUILD__<br>真实最新持仓与交易仍需后续持仓资料验证。历史模型回看采用当前样本和修订后数据，不冒充当时已知持仓或实时样本外结果。</footer>
</main><dialog id="detail"><button id="closeDetail" class="close">关闭</button><div id="detailBody"></div></dialog>
<script type="application/json" id="dataset">__DATA__</script><script>
const D=JSON.parse(document.getElementById('dataset').textContent),$=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=(x,n=3)=>x===null||x===undefined?'—':Number(x).toLocaleString('zh-CN',{minimumFractionDigits:n,maximumFractionDigits:n});
const signed=(x,n=3)=>x===null||x===undefined?'—':(x>0?'+':'')+fmt(x,n);
const fitVal=x=>x?.usable?fmt(x.value):'—';
const delta=x=>x?.usable?`${signed(x.value)}<small>[${signed(x.low)}, ${signed(x.high)}]</small>`:'—';
const pct=x=>x===null||x===undefined?'未披露':fmt(x,2)+'%';
const S=D.summary,strong=D.rows.filter(r=>r.signal.level===3).length;
$('verdict').textContent=strong?`${strong}个观察组出现较强收益升温线索，仍待持仓核查`:'当前以逐组线索跟踪，尚无可确认的实时回补交易';
$('verdictText').textContent=`已公布净值日为 ${D.end}；同日覆盖 ${S.latest_nav_count}/${S.groups} 个观察组。模型不能还原公募今天实际持有双龙多少股，未把负系数写成清仓。`;
$('kpis').innerHTML=[['最新净值同日覆盖',fmt(S.latest_nav_coverage*100,1)+'%',`${S.latest_nav_count}/${S.groups} 个观察组`],['较强回补/增配线索',strong,'模型候选，不是确认买入'],['可区分前后变化',S.identifiable,'宽窄对照均通过辨识检查'],['最新持仓报告期',D.report_period.slice(0,4)+'Q'+Math.ceil(Number(D.report_period.slice(5,7))/3),D.report_period+' 期末；非实时仓位']].map(([k,v,n])=>`<div class="kpi"><small>${esc(k)}</small><b>${esc(v)}</b><small>${esc(n)}</small></div>`).join('');
$('disclosureScope').textContent=`截至报告期 ${D.report_period}，当前观察池共 ${S.share_entries} 个份额条目，归并为 ${S.groups} 个观察组。其中指数增强 ${S.categories.enhanced_index??0} 组单列观察。只有原始报告确认过的份额关系标记为已核验；其余只是名称归并，不能当作已经确认的独立基金数量。`;
$('qualitySummary').innerHTML=`<p>主数据采集完成 ${esc(D.collected_at)}；构建 ${esc(D.built_at)}。来源目录 ${D.quality.catalogue_count} 个条目；披露反查分页${D.quality.report_pages_complete?'完整':'不完整'}，不代表全市场基金覆盖。</p><p>当前有 ${S.model_usable} 组可以计算40日模型，${S.identifiable} 组的前后变化在两套模型中都具有足够辨识度。净值检查发现 ${D.quality.nav_issues} 条缺口/差异，含序列首日缺前值，按日期隔离处理。</p><p>固定行情篮子近80日完整覆盖：宽 ${D.quality.peer_coverage.peer_broad.complete}/${D.quality.peer_coverage.peer_broad.expected}，窄 ${D.quality.peer_coverage.peer_core.complete}/${D.quality.peer_coverage.peer_core.expected}。净值采集失败 ${Object.keys(D.quality.nav_fetch_errors).length} 个份额条目：${Object.keys(D.quality.nav_fetch_errors).map(esc).join('、')||'无'}。复权行情缺失 ${Object.keys(D.quality.price_fetch_errors).length} 只（含个基对照）：${Object.keys(D.quality.price_fetch_errors).map(esc).join('、')||'无'}；未用未复权价格代替。</p><p>原始报告已核验 ${S.verified_portfolios} 个基金样本。个基对照覆盖 ${Object.entries(S.fund_review_states).filter(([k])=>k!=='not_reviewed').reduce((n,[,v])=>n+v,0)} 组；缺资料或未通过的候选保留观察。尚未获得真实最新持仓真值，不报告仓位识别准确率、召回率或交易收益。</p>`;
$('theme').onclick=()=>{if(window.ToolSiteTheme)window.ToolSiteTheme.toggle();else document.documentElement.dataset.siteTheme=document.documentElement.dataset.siteTheme==='dark'?'light':'dark';};
let page=0,filtered=[],size=40;
function chosen(){const q=$('search').value.trim().toLowerCase(),state=$('state').value,origin=$('origin').value,kind=$('kind').value;return D.rows.filter(r=>(r.code+r.name+(r.company??'')).toLowerCase().includes(q)).filter(r=>kind==='all'||r.category===kind).filter(r=>origin==='all'||origin==='seed'&&r.seed_group||origin==='expanded'&&!r.seed_group).filter(r=>state==='all'||state==='strong'&&r.signal.level===3||state==='warming'&&r.signal.level>0||state==='weakening'&&r.signal.label==='收益关联走弱'||state==='unknown'&&r.category!=='enhanced_index'&&(r.signal.level===null||r.signal.label.includes('辨识')));}
function show(){filtered=chosen();const max=Math.max(0,Math.ceil(filtered.length/size)-1);page=Math.min(page,max);const rows=filtered.slice(page*size,(page+1)*size);
$('fundRows').innerHTML=rows.map(r=>`<tr><td class="name"><b>${esc(r.name)}</b><small>${r.code} · ${r.members.length}个份额条目</small></td><td>${esc(r.nav_date??'缺失')}${r.nav_date!==D.end?'<small>过期，不生成当日信号</small>':''}</td><td>${fitVal(r.models.broad['20'])}</td><td>${fitVal(r.models.broad['40'])}</td><td>${fitVal(r.models.broad['60'])}</td><td>${delta(r.change.broad)}</td><td>${fmt(r.adjusted_p,4)}</td><td><span class="pill risk">${esc(r.signal.label)}</span></td><td><button data-code="${r.code}" class="detailBtn">详情</button></td></tr>`).join('')||'<tr><td colspan="9" class="empty">没有符合条件的观察组</td></tr>';
$('mobileRows').innerHTML=rows.map(r=>`<div class="item"><b>${esc(r.name)}</b><small>${r.code} · 净值日 ${esc(r.nav_date??'缺失')}</small><span class="pill risk">${esc(r.signal.label)}</span><div class="metrics"><span><small>β40（收益关联）</small>${fitVal(r.models.broad['40'])}</span><span><small>前后20日 Δβ</small>${signed(r.change.broad.value)}</span><span><small>Δβ近似区间</small>${r.change.broad.usable?'['+signed(r.change.broad.low)+', '+signed(r.change.broad.high)+']':'—'}</span><span><small>多重比较修正p值</small>${fmt(r.adjusted_p,4)}</span></div><button data-code="${r.code}" class="detailBtn">核查详情与来源</button></div>`).join('')||'<div class="empty">没有符合条件的观察组</div>';
$('disclosureRows').innerHTML=rows.map(r=>{const f=r.facts.current;if(!f)return `<tr><td class="name">${esc(r.name)}<small>${r.code}</small></td><td>${D.report_period}</td><td colspan="4">该期反查未见目标记录，不能判断为零持仓</td></tr>`;const a=f.stocks['300502'],b=f.stocks['300308'],source=a??b;return `<tr><td class="name">${esc(r.name)}<small>披露代码 ${f.code}${f.code!==r.code?' · 与净值代码不同':''}</small></td><td>${f.period}</td><td>${pct(a?.weight_pct)}</td><td>${pct(b?.weight_pct)}</td><td>${pct(f.known_sum_pct)}<small>${f.both_reported?'两只均有记录':'仅已列部分'}</small></td><td><a href="${esc(source.original_source??source.source)}">${source.verified_original?'原报样本已核验':'第三方定报汇总'}</a></td></tr>`;}).join('')||'<tr><td colspan="6">没有符合条件的观察组</td></tr>';
$('count').textContent=`${filtered.length}组 · 第${page+1}/${Math.max(1,max+1)}页`;$('prev').disabled=page===0;$('next').disabled=page===max;
document.querySelectorAll('.detailBtn').forEach(b=>b.onclick=()=>detail(b.dataset.code));}
function detail(code){const r=D.rows.find(x=>x.code===code),f=r.facts.current,source=(f?.stocks['300502']??f?.stocks['300308']);const p=r.models.broad['40'],c=r.change.broad,a=r.change.core,rv=r.fund_review;
$('detailBody').innerHTML=`<h2>${esc(r.name)} · ${r.code}</h2><p><span class="pill risk">${esc(r.signal.label)}</span></p><p>${esc(r.membership_status)}；组内份额：${r.members.map(esc).join('、')}。</p><p>净值日 ${esc(r.nav_date??'缺失')}；最近60交易日有效收益覆盖 ${fmt(r.recent_return_coverage*100,1)}%。${r.nav_frequency_warning?'零变动净值过多，更新频度或辨识度需核查。':''}</p><div class="scroll"><table><thead><tr><th>模型</th><th>前后变化</th><th>区间</th><th>独有波动标准差</th></tr></thead><tbody>${[['宽篮子',c],['窄篮子',a]].map(([n,x])=>`<tr><td>${n}</td><td>${signed(x.value)}</td><td>${x.usable?'['+signed(x.low)+', '+signed(x.high)+']':esc(x.reason??'不足')}</td><td>${fmt(x.idio_std_pp)}pp</td></tr>`).join('')}</tbody></table></div><p>40日模型 R² ${fmt(p.r2)}；修正p值 ${fmt(r.adjusted_p,5)}。R²衡量收益拟合，不是仓位准确率。</p><p>之后10日顺序留出解释增益：${r.holdout.usable&&r.holdout.gain!==null?fmt(r.holdout.gain*100,1)+'%':'数据不足'}，与仅市场/板块模型相比；不代表真实买卖命中。</p><p>个基其他重仓股对照：${esc({passed:"通过收益稳健性检验",not_supported:"原升温证据未获支持",insufficient:"数据或辨识度不足",not_reviewed:"待核查"}[rv.status]??rv.status)}。${esc(rv.reason??rv.note)}${rv.coverage!==undefined?"；已知其他重仓股行情覆盖 "+fmt(rv.coverage*100,1)+"%":""}</p>${rv.source?`<p><a href="${esc(rv.source)}">个基持仓对照来源</a> · 报告期 ${esc(rv.period??"未取得")}</p>`:""}<p>最近已知披露：${r.facts.last_known?esc(r.facts.last_known.period)+" 已列目标权重 "+pct(r.facts.last_known.known_sum_pct):"尚无目标记录"}，不是实时仓位。</p><p>当前报告期：${esc(r.facts.current_status)}。${f?'已列双龙权重合计 '+pct(f.known_sum_pct)+'，披露代码 '+f.code+'。':''}</p>${source?`<p><a href="${esc(source.original_source??source.source)}">核查持仓来源</a></p>`:''}<p><a href="${esc(r.nav_source)}">净值原始来源</a></p><p class="note">以上是收益敏感度和披露资料，不能确认当前持有多少股。未列入前十大不代表没有持仓；不同份额的组合关系尚未全部核验。</p>`;
$('detail').showModal();}
$('closeDetail').onclick=()=>$('detail').close();
for(const id of ['search','state','origin','kind'])$(id).addEventListener(id==='search'?'input':'change',()=>{page=0;show();});
$('prev').onclick=()=>{page=Math.max(0,page-1);show();};$('next').onclick=()=>{page++;show();};
$('download').onclick=()=>{const b=new Blob([JSON.stringify(D,null,2)],{type:'application/json'}),u=URL.createObjectURL(b),a=document.createElement('a');a.href=u;a.download='双龙回补观察_'+D.end+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);};
show();window.FUND_TRACK={buildId:D.build_id,date:D.end,groups:S.groups,confirmedTransactions:0};
</script></body></html>'''
