"""Reports are views of a single verified build, never handwritten market conclusions."""
from __future__ import annotations
import html
import json
import copy
import json as _json
from pathlib import Path
from v2_common import INDEX as _INDEX

def render(a,folder):
    folder=Path(folder)
    data={k:v for k,v in a.items() if k not in ('pools','families')}
    data['pools']={k:{**v,'series':v['series'][-100:]} for k,v in a['pools'].items()}
    data['families']={k:{z:y for z,y in v.items() if z!='series'} for k,v in a['families'].items()}
    data['exchange']=copy.deepcopy(a['exchange'])
    for item in data['exchange']['instruments'].values():
        item['series']=item['series'][-100:]
        item.get('tracking',{}).pop('series',None)
    for item in data['exchange'].get('families',{}).values():item.pop('series',None)
    data['exchange'].get('tracking',{}).pop('series',None)
    data['exchange']['series']=data['exchange']['series'][-100:]
    payload=json.dumps(data,ensure_ascii=False,allow_nan=False).replace('</','<\\/')
    page=(TEMPLATE.replace('__DATA__',payload).replace('__END__',html.escape(a['end']))
          .replace('__BUILD__',html.escape(a['build_id']))
          .replace('__INDEX__',_json.dumps(_INDEX,ensure_ascii=False).replace('</','<\\/')))
    (folder/'report.html').write_text(page,encoding='utf-8')
    phases=''.join('<tr>'+''.join(f'<td>{html.escape(str(p[x]))}</td>' for x in ['label','start','end'])+
                   f'<td>{p["flow"]:+,.1f} 亿</td><td>{p["valid_observations"]}/{p["expected_observations"]}</td></tr>' for p in a['history_phases'])
    ev=a['pools']['core15']['evaluation']
    cycle=page.split('<main>')[0]+f'''<main>
    <div class="eyebrow">历史复盘 · 与当日追踪共用构建 {html.escape(a['build_id'])}</div>
    <h1>ETF 通道变化的历史底稿</h1><p class="lead">截至 {html.escape(a['end'])}，当前核心15只回溯；区间名称仅供展示，不作为状态引擎的先验。</p>
    <div class="notice">旧版“国家队成本、浮亏、实现收益”已撤回。份额净变化无法还原同一账户的库存与成交批次，也看不到全部二级市场换手。</div>
    <section><h2>统一口径后的区间估算</h2><div class="scroll"><table><thead><tr><th>区间</th><th>起点</th><th>终点</th><th>有效观测净申赎估算</th><th>有效/预期基金日</th></tr></thead><tbody>{phases}</tbody></table></div>
    <p class="note">金额单位：亿元。份额使用原生交易单位，不复权价格；510310 在 2024-09-23 按官方 0.49977589 合并比例转换前日份额。缺失不算0，未登记的疑似份额行动隔离。当前核心池回溯存在样本选择偏差。</p></section>
    <section><h2>历史回放检验的边界</h2><p>核心池形成 {ev['n']} 个可观察后续10日的持续流出事件。后续资金持续性代理命中 {ev['proxy_hits']} 次。它不是国家队身份识别准确率，也不是交易胜率。</p>
    <p>规则仅使用当天及此前数据；当前回放使用事后修订日线，并未伪称保留了历史每一天的原始发布版本。新版本起保存原始快照及每次修订，之后才能检验真实发布时点的效果。</p></section>
    <section><h2>不再作为判据的旧推论</h2><ul><li>成本线以下不会卖。</li><li>上涨才派发、下跌赎回不是派发。</li><li>只盯一只ETF没有死角。</li><li>根据复权均价比推算一个系数，单边缩放历史份额。</li><li>规模变化或份额下降能够直接确认买卖主体。</li></ul></section>
    <a href="/gjd/">返回当日追踪</a></main></body></html>'''
    (folder/'cycle.html').write_text(cycle.replace('href="#','href="/gjd/#').replace('<title>国家队观察 · ETF通道追踪 ','<title>ETF通道历史复盘 ').replace('<button id="themeToggle" aria-label="切换深浅色">深浅色</button>','<button onclick="window.ToolSiteTheme?.toggle()" aria-label="切换深浅色">深浅色</button>'),encoding='utf-8')

TEMPLATE=r'''<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="gjd-build-id" content="__BUILD__"><title>国家队观察 · ETF通道追踪 __END__</title>
<script src="/assets/site-theme.js"></script><link rel="stylesheet" href="/assets/workspace-theme.css">
<style>
:root{--bg:#f1f5f9;--surface:#fff;--inset:#edf2f7;--line:#dce4ed;--text:#172536;--muted:#64748b;--accent:#2563eb;--group-bg:#e6edf5;--group-text:#334155;--red:#d8404d;--green:#16845d;--amber:#996308}
@media(prefers-color-scheme:dark){:root:not([data-site-theme="light"]){--bg:#0e1520;--surface:#172231;--inset:#111c2b;--line:#2c3d50;--text:#e3ebf4;--muted:#a3b1c3;--accent:#79b2ff;--group-bg:#233247;--group-text:#c8d8ea;--red:#ff7b85;--green:#5ac69c;--amber:#edc170}}
:root[data-site-theme="dark"]{--bg:#0e1520;--surface:#172231;--inset:#111c2b;--line:#2c3d50;--text:#e3ebf4;--muted:#a3b1c3;--accent:#79b2ff;--group-bg:#233247;--group-text:#c8d8ea;--red:#ff7b85;--green:#5ac69c;--amber:#edc170}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.65 system-ui,"Microsoft YaHei",sans-serif}main,header{max-width:1260px;margin:auto;padding:22px 24px}header{display:flex;justify-content:space-between;gap:12px;align-items:center;border-bottom:1px solid var(--line)}nav{display:flex;flex-wrap:wrap;gap:14px}a{color:var(--accent)}h1{font-size:clamp(25px,4vw,36px);line-height:1.3;margin:8px 0 12px;letter-spacing:-.7px}h2{font-size:20px;margin:0 0 10px}h3{font-size:16px;margin:16px 0 8px}.eyebrow{font-size:12px;letter-spacing:1px;color:var(--muted)}.lead{color:var(--muted);max-width:880px}.notice{padding:14px 16px;border-left:3px solid var(--amber);background:var(--surface);border-radius:8px;color:var(--amber);margin:18px 0}.kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:20px 0}.kpi,section{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:18px}.kpi .value{font:700 clamp(23px,3vw,30px)/1.4 ui-monospace,monospace;font-variant-numeric:tabular-nums}.kpi .label,.note{color:var(--muted);font-size:12px}.note{margin-top:10px;overflow-wrap:anywhere}section{margin:16px 0}.up{color:var(--red)}.dn{color:var(--green)}.risk{color:var(--amber)}.mono{font-family:ui-monospace,monospace;font-variant-numeric:tabular-nums}.pill{display:inline-block;background:var(--inset);border:1px solid var(--line);border-radius:5px;padding:2px 7px;font-size:12px;white-space:normal}.tools{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:12px 0}input,select,button{font:inherit;color:var(--text);background:var(--surface);border:1px solid var(--line);border-radius:7px;min-height:44px;padding:8px 12px}input{min-width:0;flex:1}button{cursor:pointer}button:hover{border-color:var(--accent)}:focus-visible{outline:3px solid var(--accent);outline-offset:3px}.scroll{overflow:auto;max-width:100%}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:right;padding:10px 8px;border-bottom:1px solid var(--line);font-variant-numeric:tabular-nums}th{font-size:12px;color:var(--muted);background:var(--inset);white-space:nowrap}td:first-child,th:first-child{text-align:left}td{white-space:nowrap}td.name{max-width:220px;white-space:normal;min-width:130px}small{display:block;color:var(--muted);font-size:11px;white-space:normal}details{border-top:1px solid var(--line);margin:10px 0;padding-top:10px}summary{cursor:pointer;min-height:44px;padding:10px 0;font-weight:600}svg{width:100%;height:200px;display:block}.legend{display:flex;gap:15px;color:var(--muted);font-size:12px}.statusline{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.twocol{display:grid;grid-template-columns:1fr 1fr;gap:16px}.empty{padding:20px;color:var(--muted)}footer{font-size:12px;color:var(--muted);padding:20px 0 60px;overflow-wrap:anywhere}.mobile-cards{display:none}.cardrow{padding:12px 0;border-bottom:1px solid var(--line)}.cardmetrics{display:grid;grid-template-columns:1fr 1fr;gap:5px 12px;margin-top:8px}.cardmetrics span{font-size:13px}.cardmetrics small{font-size:11px}
@media(max-width:760px){header,main{padding:16px}header{align-items:flex-start;flex-direction:column}.kpis{grid-template-columns:1fr 1fr}.twocol{grid-template-columns:1fr}.desktop-core{display:none}.mobile-cards{display:block}input,select{font-size:16px}section{padding:14px}h2{font-size:19px}.tools>*{max-width:100%}.tools input{flex-basis:100%}.name{max-width:140px}nav a{min-height:36px}}
.statusline{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0}#intradayRows th:first-child,#intradayRows td:first-child,#postcloseBody th:first-child{text-align:left}.intraday-bad{color:var(--amber)}.intraday-ok{color:var(--muted)}
</style></head><body>
<header><strong>国家队观察 <span class="pill">v2.1</span></strong><nav><a href="#intraday">盘中观察</a><a href="#postclose">盘后初值</a><a href="#official">正式份额与预警</a><a href="#channels">历史反推</a><a href="#discover">异常线索</a><a href="#quality">数据核对</a><a href="/gjd/cycle">历史复盘</a><button id="themeToggle" aria-label="切换深浅色">深浅色</button></nav></header>
<main><div class="eyebrow">公开数据观察 · __END__ 收盘</div>
<h1>先看资金变化，再核验是谁</h1><p class="lead">核心15只优先核对交易所正式份额；历史反推和新发现线索继续保留。份额减少可以确认，国家队身份需要独立证据。</p>
<div class="statusline"><span class="pill" id="coreState"></span><span class="pill">当日买卖主体未确认</span><span class="pill" id="coverage"></span></div>
<div class="kpis" id="kpis"></div><div class="notice" id="interpretation"></div>
<section id="intraday"><h2>当日盘中观察区 <span class="pill" id="intradayStage">加载中</span></h2>
<p class="note" id="intradayScope">业务日、行情时间、采集时间、延迟、覆盖范围与身份状态分别显示。本区是线索，不是正式份额，也不是国家队买卖确认。</p>
<div class="statusline" id="intradayStatus"></div>
<div class="kpis" id="intradayKpis"></div>
<div class="scroll"><table><thead><tr><th>ETF / 家族</th><th>现价</th><th>涨跌%</th><th>相对指数</th><th>折溢价%</th><th>放量倍数</th><th>通道线索</th><th>反向证据</th></tr></thead><tbody id="intradayRows"></tbody></table></div>
<p class="note" id="intradayEvents"></p>
<p class="note">实时行情由浏览器直接读取供应商快照（JSONP），不产生每分钟 Git 提交或完整部署；本地采集器的规则与事件摘要为最近一次发布快照，非实时。缺可靠逐笔/主动成交方向时标注「方向待确认」。核心ETF角色、放量、折溢价、同步交易都不能证明国家队身份；不输出国家队概率或盘中买入金额。</p></section>
<section id="postclose"><h2>盘后初值 · 独立观察区</h2>
<p class="note" id="postcloseScope"></p>
<div id="postcloseBody"></div>
<p class="note">收盘初值只作本地预览与观察，不覆盖上方已核验的正式份额结果。覆盖数不足时不展示核心15只完整合计；深交所当晚初值以次日早间更新为准，须复核后才可正式发布。盘中没有净申购不能单独判定盘中承接线索错误——二级市场买卖可能不改变总份额。</p></section>
<section id="official"><h2>交易所正式份额 · 核心15只</h2><p class="note" id="officialScope"></p><div class="scroll desktop-core"><table><thead><tr><th>ETF / 家族</th><th>前日 / 亿份</th><th>当日 / 亿份</th><th>变化 / 亿份</th><th>变化比例</th><th>敞口估算 / 亿元</th><th>5日 / 亿元</th><th>正式份额状态</th><th>来源</th></tr></thead><tbody id="officialRows"></tbody></table></div><div id="officialMobile" class="mobile-cards"></div><details><summary>最近交易日的正式份额变化</summary><div class="scroll"><table><thead><tr><th>日期</th><th>敞口估算 / 亿元</th><th>减少 / 增加</th><th>覆盖</th></tr></thead><tbody id="officialDays"></tbody></table></div></details><p class="note">正式份额确认的是基金净申赎。金额按份额变化×当日不复权成交均价估算，表示证券敞口变化；不是国家队实际现金流。无法据此识别赎回账户，也不能覆盖全部二级市场卖出。</p></section>
<section><h2>核心正式份额 · 分通道减仓观察</h2><p class="note">使用相同固定核心成员，正式份额独立计算5/10/20日与事件状态；未覆盖的窗口不补历史反推。短期回补不自动清除旧事件。规则阈值尚未用实名交易校准。</p><div class="scroll"><table><thead><tr><th>家族</th><th>当日 / 亿元</th><th>5日</th><th>10日</th><th>20日</th><th>状态</th></tr></thead><tbody id="officialFamilies"></tbody></table></div></section>
<section><h2>历史补充 · 核心通道近100日换手率反推</h2><div class="legend"><span>红：净申购</span><span>绿：净赎回</span><span>金额单位：亿元；缺失留空</span></div><p class="note">以下为供应商换手率反推序列，分母可能滞后或修订。与上方正式披露独立计算，避免混接两种口径；当日判断优先看上方正式份额。</p><div id="chart"></div></section>
<section id="channels"><h2>历史反推 · 分通道减仓观察</h2><p class="note">本表是换手率反推的历史观察状态，不能替代上方正式份额。份额回撤按过去63个交易日峰值计算，跨份额合并已换至同一单位。5/10/20日均使用逐日估算相加。短暂回补不会自动解除持续流出观察。</p>
<div class="tools"><label for="pool">观察范围</label><select id="pool"><option value="core">核心15只</option><option value="fixed">固定境内扩展池</option><option value="candidates">新发现候选</option><option value="all">全部已核算标的</option></select><input id="search" aria-label="搜索ETF代码、名称或家族" placeholder="搜索代码、名称或家族"><label><input type="checkbox" id="onlyRisk" style="min-height:0">仅看流出观察</label></div>
<div class="scroll desktop-core"><table><thead><tr><th>ETF / 跟踪家族</th><th>今日估算</th><th>5日</th><th>10日</th><th>20日</th><th>份额回撤</th><th>预警状态</th><th>身份依据</th></tr></thead><tbody id="fundRows"></tbody></table></div><div id="mobileRows" class="mobile-cards"></div><p id="fundCount" class="note"></p>
<details><summary>状态与身份如何分开判断</summary><p>“流出线索”保留尚未超出误差的小变化；“持续流出/加速”结合累计净赎回、规模比例和持续性；“暂缓/持续观察”保留事件过程；连续有效回补才解除。它们描述资金通道，不等于国家队减持确认。</p><p>I0：身份未知。I1：核心通道线索，角色本身不证明身份。I2：有已核验的历史持有人或政策关联资料，仍不证明当日交易。I3：当日、标的和方向都有实名公开证据。未经校准不展示概率。行为候选另看累计份额、历史异常、成交活跃和跨家族一致性；这些条件可能相关，不自动升级身份等级。</p><p>研究阈值：5日净赎回占期初规模0.5%、或稳健份额回撤1%，并结合持续天数；加速阈值为5日2%或单日1%。阈值可改、尚未以实名交易真值校准。</p></details></section>
<section><h2>固定境内池 · 家族视角</h2><p class="note" id="familyScope"></p><div class="scroll"><table><thead><tr><th>家族</th><th>今日</th><th>5日</th><th>10日</th><th>流出广度</th><th>覆盖</th><th>状态</th></tr></thead><tbody id="familyRows"></tbody></table></div></section>
<section id="discover"><h2>供应商目录发现 · 小线索也保留</h2><p class="note" id="discoveryScope"></p><div class="tools"><label for="direction">线索排序</label><select id="direction"><option value="out">5日流出</option><option value="in">5日流入</option><option value="small">今日小额变化</option></select><button id="download">下载本页数据</button></div><div class="scroll"><table><thead><tr><th>ETF / 家族</th><th>今日估算</th><th>5日估算</th><th>舍入范围是否跨0</th><th>样本关系</th></tr></thead><tbody id="discoveryRows"></tbody></table></div><p class="note">分页完整仅指本次供应商目录，不代表已核对交易所全量ETF，可能遗漏新上市或未收录产品。目录按当前信息分类，尚未核实的家族会明确标记。发现队列不悄然改动固定历史总额；新候选需要登记后才能变更观察池版本。</p></section>
<section id="quality"><h2>数据可信程度</h2><div id="qualitySummary"></div><details><summary>误差、缺口与跨源核对</summary><div id="qualityDetails"></div></details><details><summary>方法、来源与识别边界</summary><p>估算份额＝成交量(手)×10000÷换手率(%)。相邻交易日份额差按真实份额合并比例换算，再乘当日不复权成交均价。份额对应证券敞口变化，未必是现金流，也不提供买卖主体。</p><p>换手率两位小数的舍入区间按±0.005个百分点传播；5日累计利用共享端点误差，不简单相加每日误差。区间不是统计置信区间，未涵盖分母日期错误、数据源修订等风险。</p><p>不把快照贴成历史日线，不用复权价格计算历史规模，不以指数涨跌、成本线、政策语言关闭监控。未登记的疑似份额行动会隔离；缺失不记0。</p><p><a href="https://etf.sse.com.cn/fund/quertion/">上交所ETF机制</a> · <a href="https://www.sse.com.cn/disclosure/fund/announcement/c/new/2024-09-23/510310_20240923_G18B.pdf">510310官方合并比例</a></p></details></section>
<section><h2>历史检验正在验证什么</h2><p id="evaluation"></p><p class="note">未来资金变化可以检验撤退预警的用途，不能证明买卖主体。历史回放使用当前修订数据；新版本开始逐次保存发布资料，后续可做真正的时点回放。</p></section>
<footer>数据截止 __END__ · 构建 __BUILD__<br>核心近期正式份额与历史行情反推分别留存，金额均为敞口变化估算。不能观测所有二级市场交易；国家队成本、持仓盈亏、实现收益不在可确认数据范围内。</footer>
</main><script type="application/json" id="dataset">__DATA__</script><script>
const D=JSON.parse(document.getElementById('dataset').textContent),$=id=>document.getElementById(id);
$('themeToggle').onclick=()=>{if(window.ToolSiteTheme){window.ToolSiteTheme.toggle();}else{document.documentElement.dataset.siteTheme=document.documentElement.dataset.siteTheme==='dark'?'light':'dark';}};
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num=(x,d=1)=>x===null||x===undefined?'—':(x>0?'+':'')+x.toLocaleString('zh-CN',{minimumFractionDigits:d,maximumFractionDigits:d});
const val=x=>`<span class="mono ${x>0?'up':x<0?'dn':''}">${num(x)}</span>`;
const range=w=>w&&w.low!==null?`${num(w.low)} 至 ${num(w.high)} 亿`:'数据不足';
const core=D.pools.core15.latest,ev=D.pools.core15.evaluation;
const O=D.exchange,of=O.latest;
$('coreState').textContent=of.complete?'正式份额：'+(O.tracking?.latest?.risk.state??'待积累')+' · '+O.stage:'正式份额尚未齐全';$('coverage').textContent='正式份额及估值覆盖 '+of.valid_members+'/'+of.expected_members;
$('kpis').innerHTML=[['今日正式份额敞口估算',of.net_estimate,'份额差 × 当日成交均价；非实际现金流'],['5日正式份额敞口估算',O.w5.net_estimate,O.w5.complete?'最近5个交易日，逐日相加':'连续官方份额或价格尚不完整'],['今日减少的核心ETF',of.outflow_count,'核心15只；身份未确认'],['固定境内观察池',D.pools.fixed_domestic.members.length,'核心15只 + 扩展通道；不含跨境']].map(([label,x,note],i)=>`<div class="kpi"><div class="label">${esc(label)}</div><div class="value ${i<2?(x>0?'up':'dn'):''}">${i<2?num(x):x}<small>${i<2?'亿元':'只'}</small></div><div class="label">${esc(note)}</div></div>`).join('');
const atRisk=D.pools.core15.members.map(c=>D.instruments[c]).filter(x=>x.latest?.risk.memory.active).sort((a,b)=>(a.latest.w5.net??0)-(b.latest.w5.net??0));
$('interpretation').textContent=of.complete?`正式份额显示：${of.outflow_count}只减少、${of.inflow_count}只增加，合计敞口变化估算 ${num(of.net_estimate)} 亿元。${O.w5.complete?'近5日累计 '+num(O.w5.net_estimate)+' 亿元。':''}这支持跟踪通道减仓线索，尚不能确认国家队当日买卖。`:'正式份额或估值尚未齐全，缺口不补0；保留已取得的逐只结果，暂不展示核心池完整合计。';
$('officialScope').textContent=`业务日 ${D.end}；资料状态：${O.stage}。正式份额与不复权价格配对覆盖 ${of.valid_members}/15。上交所口径为当日清算后份额；深交所按业务日记账，T日晚间初值以T+1早间更新为准。两日均取自同一交易所披露序列，份额披露精度为100份。`;
const ors=Object.values(O.instruments).sort((a,b)=>(a.latest?.net_estimate??Infinity)-(b.latest?.net_estimate??Infinity));
const shares=x=>x===null||x===undefined?'—':(x/1e8).toLocaleString('zh-CN',{minimumFractionDigits:4,maximumFractionDigits:4});
$('officialRows').innerHTML=ors.map(x=>{let r=x.latest;return `<tr><td class="name"><b>${esc(x.name)}</b><small>${x.code} · ${esc(x.family)}</small></td><td>${shares(r?.previous_shares)}</td><td>${shares(r?.shares)}</td><td>${r?.share_change===null||!r?'—':num(r.share_change/1e8,4)}</td><td>${r?.share_change_pct===null||!r?'—':num(r.share_change_pct,2)+'%'}</td><td>${val(r?.net_estimate)}</td><td>${val(x.w5.net_estimate)}</td><td><span class="pill risk">${esc(x.tracking?.latest?.risk.state??'数据不足')}</span><small>已观察${x.tracking?.observed_sessions??0}日${x.tracking?.peak_window_complete?'':'；回撤窗口未满63日'}</small></td><td><a href="${esc(x.url||x.source_page||'#')}">${x.source==='sse'?'上交所':x.source==='szse'?'深交所':'待获取'}</a><small>${esc(x.fetched_at||x.error||'尚无记录')}${x.source==='szse'?(x.next_morning_collected?' · 次日早间后采集':' · 当晚初值仍待复核'):''}</small></td></tr>`}).join('');
$('officialMobile').innerHTML=ors.map(x=>{let r=x.latest;return `<div class="cardrow"><b>${esc(x.name)}</b><small>${x.code} · ${esc(x.family)}</small><span class="pill risk">${esc(x.tracking?.latest?.risk.state??'数据不足')}</span><div class="cardmetrics"><span><small>份额变化 / 亿份</small>${r?.share_change===null||!r?'—':num(r.share_change/1e8,4)}</span><span><small>敞口估算 / 亿元</small>${val(r?.net_estimate)}</span><span><small>5日 / 亿元</small>${val(x.w5.net_estimate)}</span><span><small>份额变化比例</small>${r?.share_change_pct===null||!r?'—':num(r.share_change_pct,2)+'%'}</span></div><small>已观察${x.tracking?.observed_sessions??0}日 · ${esc(x.fetched_at??'待获取')}</small></div>`}).join('');
$('officialFamilies').innerHTML=Object.entries(O.families??{}).sort((a,b)=>(a[1].latest?.w5.net??Infinity)-(b[1].latest?.w5.net??Infinity)).map(([name,x])=>{const r=x.latest;return `<tr><td>${esc(name)}<small>核心${x.members.length}只</small></td><td>${val(r?.net)}</td><td>${val(r?.w5.complete?r.w5.net:null)}</td><td>${val(r?.w10.complete?r.w10.net:null)}</td><td>${val(r?.w20.complete?r.w20.net:null)}</td><td>${esc(r?.risk.state??'数据不足')}</td></tr>`}).join('');
$('officialDays').innerHTML=O.series.filter(x=>x.complete).slice(-10).reverse().map(x=>`<tr><td>${x.date}</td><td>${val(x.net_estimate)}</td><td>${x.outflow_count} / ${x.inflow_count}</td><td>${x.valid_members}/15</td></tr>`).join('')||'<tr><td colspan="4">连续正式份额尚不完整</td></tr>';
let chart=D.pools.core15.series;
function drawChart(){const max=Math.max(1,...chart.map(x=>Math.abs(x.net??0))),W=Math.max(280,$('chart').clientWidth),H=200,mid=94,step=(W-70)/chart.length;
$('chart').innerHTML=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="核心15只近100交易日净申赎柱形图"><line x1="42" x2="${W-12}" y1="${mid}" y2="${mid}" stroke="var(--line)"/><text x="0" y="20" fill="var(--muted)" font-size="11">${Math.round(max)}</text><text x="18" y="98" fill="var(--muted)" font-size="11">0</text>${chart.map((r,i)=>r.net===null?'':`<rect x="${42+i*step}" y="${r.net>0?mid-r.net/max*72:mid}" width="${Math.max(1,step*.72)}" height="${Math.abs(r.net)/max*72}" fill="${r.net>0?'var(--red)':'var(--green)'}"><title>${r.date} ${num(r.net)}亿元</title></rect>`).join('')}<text x="42" y="190" fill="var(--muted)" font-size="12">${chart[0].date}</text><text x="${W-12}" y="190" text-anchor="end" fill="var(--muted)" font-size="12">${chart.at(-1).date}</text></svg>`;}
drawChart();window.addEventListener('resize',drawChart);
function funds(){const mode=$('pool').value,q=$('search').value.trim().toLowerCase(),only=$('onlyRisk').checked;let rs=Object.values(D.instruments).filter(x=>mode==='all'||mode==='core'&&x.core||mode==='fixed'&&x.pool==='fixed_watch'||mode==='candidates'&&x.pool==='discovery_candidate').filter(x=>(x.code+x.name+x.family).toLowerCase().includes(q)).filter(x=>!only||x.latest?.risk.memory.active);rs.sort((a,b)=>(b.latest?.risk.memory.peak_level??-1)-(a.latest?.risk.memory.peak_level??-1)||(a.latest?.w5.net??Infinity)-(b.latest?.w5.net??Infinity));
$('fundRows').innerHTML=rs.map(x=>{let r=x.latest;return `<tr><td class="name"><b>${esc(x.name)}</b><small>${x.code} · ${esc(x.family)}</small></td>${r?[val(r.net),val(r.w5.net),val(r.w10.net),val(r.w20.net),`<span class="mono">${(r.share_dd*100).toFixed(1)}%</span>`,`<span class="pill risk">${esc(r.stale?'数据陈旧':r.risk.state)}</span>`,`<span class="pill">${esc(x.identity_evidence.level)}</span><small>${esc(x.behavior_clues.label)}</small>`].map(y=>'<td>'+y+'</td>').join(''):'<td colspan="7">数据不足</td>'}</tr>`}).join('')||'<tr><td colspan="8" class="empty">没有符合条件的ETF</td></tr>';
$('mobileRows').innerHTML=rs.map(x=>{let r=x.latest;return `<div class="cardrow"><b>${esc(x.name)}</b><small>${x.code} · ${esc(x.family)}</small><span class="pill risk">${esc(r?.stale?'数据陈旧':r?.risk.state??'数据不足')}</span> <span class="pill">${esc(x.identity_evidence.level)}</span><small>${esc(x.behavior_clues.label)}</small>${r?`<div class="cardmetrics"><span><small>今日 / 亿元</small>${val(r.net)}</span><span><small>5日 / 亿元</small>${val(r.w5.net)}</span><span><small>10日 / 亿元</small>${val(r.w10.net)}</span><span><small>份额回撤</small>${(r.share_dd*100).toFixed(1)}%</span></div>`:''}</div>`}).join('')||'<div class="empty">没有符合条件的ETF</div>';$('fundCount').textContent=`显示 ${rs.length} 只；金额均为亿元，— 表示缺数据。身份等级与风险状态互相独立。`;}
['pool','search','onlyRisk'].forEach(id=>$(id).addEventListener(id==='search'?'input':'change',funds));funds();
$('familyScope').textContent=`以下家族使用固定境内扩展池 ${D.pools.fixed_domestic.members.length} 只；与上方核心15只不是同一分母。流出广度只统计超出舍入误差的单日净赎回。`;
$('familyRows').innerHTML=Object.entries(D.families).sort((a,b)=>(a[1].latest?.w5.net??0)-(b[1].latest?.w5.net??0)).map(([name,v])=>{let r=v.latest;return `<tr><td>${esc(name)}<small>${v.members.length}只</small></td><td>${val(r?.net)}</td><td>${val(r?.w5.net)}</td><td>${val(r?.w10.net)}</td><td>${r?.outflow_breadth===null?'—':((r?.outflow_breadth??0)*100).toFixed(0)+'%'}</td><td>${r?.valid_members??0}/${r?.expected_members??v.members.length}</td><td>${esc(r?.stale?'数据陈旧':r?.risk.state??'数据不足')}</td></tr>`}).join('');
$('discoveryScope').textContent=`当前目录 ${D.discovery.catalogue_count} 只，分页${D.discovery.catalogue_complete?'完整':'不完整'}；扫描境内股票候选 ${D.discovery.scanned} 只，其中 ${D.discovery.valid_current} 只取到当日日线；目录中 ${D.discovery.cross_border_excluded} 只跨境单独排除。`;
function discovery(){let mode=$('direction').value,rs=D.discovery.queue.filter(x=>x.current);rs.sort((a,b)=>mode==='small'?Math.abs(a.net??Infinity)-Math.abs(b.net??Infinity):mode==='in'?(b.w5.net??-Infinity)-(a.w5.net??-Infinity):(a.w5.net??Infinity)-(b.w5.net??Infinity));$('discoveryRows').innerHTML=rs.slice(0,30).map(x=>`<tr><td class="name">${esc(x.name)}<small>${x.code} · ${esc(x.family)}</small></td><td>${val(x.net)}</td><td>${val(x.w5.net)}</td><td>${x.net===null?'数据不足':x.net_low<=0&&x.net_high>=0?'是，保留线索':'否，方向较稳'}</td><td>${x.in_fixed?'固定观察':'新发现候选'}</td></tr>`).join('')||'<tr><td colspan="5">尚无有效扫描数据</td></tr>';}$('direction').addEventListener('change',discovery);discovery();
$('qualitySummary').innerHTML=`<p>核心15只正式份额估值覆盖 <b>${of.valid_members}/15</b>；历史换手率反推覆盖 ${core.valid_members}/${core.expected_members}。正式份额敞口估算 ${num(of.net_estimate)} 亿元，反推 ${num(core.net)} 亿元，${of.complete?'相差 '+num(of.net_estimate-core.net)+' 亿元':'缺口未填补'}。${ors.filter(x=>x.latest?.outside_vendor_rounding).length}只当日正式份额落在反推舍入范围之外，不能仅靠舍入边界解释。</p><p>两条序列各自相邻日计算，完整历史反推未被短期官方数据悄然拼接覆盖。正式份额历史持续累积，已记录 ${(O.revisions??[]).length} 次数值修订；修订保留旧值和来源。历史披露份额锚点 ${D.quality.official_share_observations} 个。全部视图来自同一构建 <span class="mono">${esc(D.build_id)}</span>，修订后整表重算；缺失不会补0。</p>`;
$('qualityDetails').innerHTML=`<p>指数当日缺口：${esc(D.quality.missing_indices.join('、')||'无')}；不使用另一指数替代。隔离/异常记录 ${D.quality.issues.length} 条。</p><p>核心池5日舍入边界：${range(core.w5)}。边界只反映换手率舍入，不涵盖所有数据风险。</p><ul>${D.quality.crosscheck.map(x=>`<li>${x.code}：${esc(x.status)}${x.error?'（本次接口未取得可核验结果）':''}</li>`).join('')}</ul><p>历史披露锚点：</p><ul>${D.quality.official_share_checks.map(x=>`<li>${x.code} ${x.date}：${x.deviation_pct===null?'无同日记录':'反推份额偏差 '+x.deviation_pct.toFixed(4)+'%'}，<a href="${esc(x.source)}">原始报告</a></li>`).join('')}</ul><p>当日独立对账没有通过的标的不会显示“已核验准确”。</p>`;
$('evaluation').textContent=`当前修订数据回放中，核心池有 ${ev.n} 个可观察后续10日的持续流出事件，后续资金持续性代理命中 ${ev.proxy_hits} 次。身份准确率、召回率尚无真实交易标签，未给出数值。`;
$('download').onclick=()=>{const b=new Blob([JSON.stringify(D,null,2)],{type:'application/json'}),url=URL.createObjectURL(b),link=document.createElement('a');link.href=url;link.download='国家队观察_'+D.end+'_'+D.version+'.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000)};
window.GJD={buildId:D.build_id,end:D.end,coreNet:core.net,officialNet:of.net_estimate,coreCount:D.pools.core15.members.length};
/* 盘后初值独立观察区：数据不齐不包装成核心15只完整合计 */
(function(){
  const stage=String(O.stage||'未提供'),complete=!!of.complete,n=of.valid_members||0,exp=of.expected_members||15;
  $('postcloseScope').textContent=`业务日 ${D.end}；披露阶段：${stage}；正式份额与估值配对覆盖 ${n}/${exp}。本区不改动上方最后一版已核验结果。`;
  const pending=stage.indexOf('次晨')<0;
  const rows=[['阶段',pending?'初值 / 待次晨复核':'已复核'],['业务日',D.end],['覆盖数',n+'/'+exp],
    ['待复核状态',pending?'是：不得覆盖生产页':'否'],['完整合计',(complete&&n===exp)?'可展示':'不展示：覆盖不足，缺口不补0']];
  $('postcloseBody').innerHTML='<div class="scroll"><table><thead><tr><th>项目</th><th>值</th></tr></thead><tbody>'+
    rows.map(([k,v])=>`<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')+'</tbody></table></div>'+
    `<p class="note">该业务日正式份额敞口估算 ${(complete&&n===exp)?num(of.net_estimate)+' 亿元':'（覆盖不足，不展示合计）'}。此为估算敞口变化，不是实际现金流，也不能识别赎回账户。</p>`;
  // 低频同步的采集器初值摘要；不可达时保留上方静态结果，绝不把缺失解释成「数据没更新」。
  if(typeof fetch==='function'){
    fetch('/tools/national-team-etf/data/intraday/postclose.json',{cache:'no-store'})
      .then(r=>r.ok?r.json():null).catch(()=>null).then(x=>{
        if(!x||!x.business_date)return;
        const cn=x.coverage??0,ce=x.expected??exp,cst=String(x.disclosure_stage||'收盘初值 / 待次晨复核');
        $('postcloseScope').textContent=`业务日 ${x.business_date}；披露阶段：${cst}；覆盖 ${cn}/${ce}。本区不改动上方最后一版已核验结果（正式份额业务日 ${D.end}）；初值摘要随正式发布低频同步，不是实时推送。`;
        const crs=[['阶段',x.pending_review?'初值 / 待次晨复核':'已复核'],['业务日',x.business_date],
          ['覆盖数',cn+'/'+ce],['待复核状态',x.pending_review?'是：不得覆盖生产页':'否'],
          ['完整合计',(x.complete&&cn===ce)?'可展示':'不展示：覆盖不足，缺口不补0'],
          ['采集时间',x.generated_at||'—']];
        $('postcloseBody').innerHTML='<div class="scroll"><table><thead><tr><th>项目</th><th>值</th></tr></thead><tbody>'+
          crs.map(([k,v])=>`<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')+'</tbody></table></div>'+
          `<p class="note">${esc(x.note||'')} 该区不含完整合计；缺口不补0，初值不得当作正式发布依据。</p>`;
      });
  }
})();
/* 当日盘中观察区：浏览器 JSONP 实时行情 + 低频采集器快照 */
(function(){
  const IDXMAP=__INDEX__,CORE=D.pools.core15.members.slice();
  const IDXSYM=[...new Set(Object.values(IDXMAP))];
  const symOf=c=>(/^[56789]/.test(c)?'sh':'sz')+c;
  const nameOf=c=>(D.instruments[c]&&D.instruments[c].name)||c;
  const famOf=c=>(D.instruments[c]&&D.instruments[c].family)||'行业主题/待核验';
  const $=id=>document.getElementById(id);
  const buf=[];let S=null,liveOK=false,lastFetch=null;
  // 精简 DOM / 无网络环境（含独立验收的 Node VM）不启动实时通道，保留静态结果。
  if(typeof fetch!=='function'||typeof setInterval!=='function'||
     typeof document.createElement!=='function'||!document.head){
    $('intradayStage').textContent='实时通道未启用';
    $('intradayStatus').innerHTML='<span class="pill">当前环境不支持实时行情脚本</span>';
    $('intradayKpis').innerHTML='<div class="kpi"><div class="label">状态</div><div class="value" style="font-size:20px">仅静态快照</div></div>';
    $('intradayRows').innerHTML='<tr><td colspan="8">实时行情未初始化；这不解释为没有托底，正式份额以上方已核验结果为准。</td></tr>';
    $('intradayEvents').textContent='盘中规则与事件摘要需浏览器环境与采集器快照；此处不推断资金行为。';
    return;
  }
  function parseVar(sym){
    const v=window['v_'+sym];if(typeof v!=='string')return null;
    const f=v.split('~');if(f.length<40)return null;
    const g=i=>{const x=parseFloat(f[i]);return isFinite(x)?x:null;};
    return {price:g(3),pct:g(32),amount:g(37),vol:g(6),premium:f.length>77?g(77):null,
            iopv:f.length>78?g(78):null,qt:f[30]||''};
  }
  function qtDate(s){return s&&s.length>=14?`${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)} ${s.slice(8,10)}:${s.slice(10,12)}:${s.slice(12,14)}`:'—';}
  function fetchLive(){
    return new Promise(resolve=>{
      const all=[...CORE.map(symOf),...IDXSYM];
      const s=document.createElement('script');s.charset='GBK';
      s.src='https://qt.gtimg.cn/q='+all.join(',')+'&r='+Date.now();
      let settled=false;const done=ok=>{if(settled)return;settled=true;s.remove();resolve(ok);};
      s.onload=()=>done(true);s.onerror=()=>done(false);
      document.head.appendChild(s);setTimeout(()=>done(false),9000);
    });
  }
  function render(){
    const now=new Date();lastFetch=now.toISOString();
    const idxPct={};Object.entries(IDXMAP).forEach(([fam,sym])=>{const r=parseVar(sym);if(r)idxPct[fam]=r.pct;});
    const rows=CORE.map(c=>{
      const r=parseVar(symOf(c));if(!r)return null;
      const fam=famOf(c),ip=(idxPct[fam]===undefined?null:idxPct[fam]);
      return {code:c,name:nameOf(c),family:fam,price:r.price,pct:r.pct,index_pct:ip,
        relative:(r.pct!==null&&ip!==null)?r.pct-ip:null,premium:r.premium,iopv:r.iopv,
        amount:r.amount,qt:r.qt};
    }).filter(Boolean);
    const snap={};rows.forEach(r=>snap[r.code]=r);
    const keyTime=rows.length?rows.map(r=>r.qt).sort().pop():'';
    if(!buf.length||buf[buf.length-1].__key!==keyTime)buf.push({...snap,__key:keyTime,__at:now.toISOString()});
    if(buf.length>45)buf.shift();
    const q=keyTime.length>=14?new Date(+keyTime.slice(0,4),+keyTime.slice(4,6)-1,+keyTime.slice(6,8),
      +keyTime.slice(8,10),+keyTime.slice(10,12),+keyTime.slice(12,14)):null;
    const lag=q?Math.round((now-q)/1000):null;
    const stale=(!q||lag>180||q.toDateString()!==now.toDateString());
    const cold=buf.length<5;
    const support=rows.filter(r=>r.relative!==null&&r.relative>0.15).length;
    const retreat=rows.filter(r=>r.relative!==null&&r.relative<-0.15).length;
    const breadth=rows.length?Math.max(support,retreat)/rows.length:0;
    const leader=support>retreat*2?'承接线索':retreat>support*2?'撤退线索':'方向待确认';
    $('intradayStage').textContent=stale?'行情过期 / 非交易时段':'盘中实时';
    $('intradayStatus').innerHTML=
      pill('业务日 '+(keyTime.length>=8?`${keyTime.slice(0,4)}-${keyTime.slice(4,6)}-${keyTime.slice(6,8)}`:'—'))+
      pill('行情时间 '+qtDate(keyTime))+
      pill('采集时间 '+now.toLocaleTimeString('zh-CN',{hour12:false}))+
      pill('延迟 '+(lag===null?'—':lag+' 秒'),lag===null||lag>180)+
      pill('覆盖 '+rows.length+'/'+CORE.length,rows.length<CORE.length)+
      pill('身份：I0 当日买卖主体未确认')+
      pill(S?('采集器快照 '+(S.generated_at||'—').slice(11,19)):'采集器快照：未发布',!S);
    $('intradayKpis').innerHTML=[
      ['观察方向',leader,'多通道线索，不是身份判断'],
      ['同步广度',(breadth*100).toFixed(0)+'%','同向标的 / 有效标的'],
      ['5/15/30分钟窗口',cold?'冷启动':'可用','页面打开期间累积；'+buf.length+' 个采样点'],
      ['数据源状态',liveOK?'实时通道可用':'实时通道不可用',liveOK?'供应商快照':'不可解释为没有托底'],
    ].map(([a,b,c])=>`<div class="kpi"><div class="label">${esc(a)}</div><div class="value" style="font-size:20px">${esc(b)}</div><div class="label">${esc(c)}</div></div>`).join('');
    $('intradayRows').innerHTML=rows.map(r=>{
      const ch=[];if(r.relative!==null&&Math.abs(r.relative)>=0.15)ch.push(r.relative>0?'相对指数偏强':'相对指数偏弱');
      if(r.premium!==null&&Math.abs(r.premium)>=0.25)ch.push('折溢价偏离');
      const ce=(r.relative!==null&&r.relative>0&&r.premium!==null&&r.premium<0)?'价格偏强但折价':'';
      return `<tr><td class="name"><b>${esc(r.name)}</b><small>${r.code} · ${esc(r.family)}</small></td>`+
        `<td>${r.price===null?'—':r.price.toFixed(3)}</td><td>${num(r.pct,2)}</td>`+
        `<td>${num(r.relative,2)}</td><td>${num(r.premium,2)}</td>`+
        `<td>—<small>需本地基线</small></td><td>${esc(ch.join('、')||'无')}</td><td>${esc(ce||'—')}</td></tr>`;
    }).join('')||'<tr><td colspan="8">实时行情不可用；保留最近一次采集器快照，不解释为「没有托底」。</td></tr>';
    const alerts=(S&&S.alerts)||[];
    $('intradayEvents').textContent=S
      ? `本地采集器：${S.level||'—'}；冷启动 ${S.cold_start?'是':'否'}（已积累 ${S.baseline_days||0}/${S.baseline_min_days||5} 个交易日）；`+
        `事件 ${S.event_summary?S.event_summary.active:0} 个进行中；最近一次快照提醒 ${alerts.length} 条。`+
        (alerts.length?'提醒含方向、依据、持续时间、反向证据、时效与待核验事项；同一事件状态不变时静默。':'')+
        ' 方向数据：无可靠逐笔/主动成交方向，标注待确认。'
      : '本地采集器快照尚未发布；本表仅展示浏览器端实时线索，不含规则升级与事件历史。';
  }
  fetch('/tools/national-team-etf/data/intraday/latest.json',{cache:'no-store'})
    .then(r=>r.ok?r.json():null).catch(()=>null).then(x=>{S=x;});
  async function loop(){liveOK=await fetchLive();render();}
  loop();setInterval(loop,60000);
})();
</script></body></html>'''
