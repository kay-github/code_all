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
    page=(TEMPLATE.replace('__DATA__',payload).replace('__FOCUS_BLOCK__',FOCUS_BLOCK).replace('__END__',html.escape(a['end']))
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
    segmeta=json.dumps(dict(build_id=a['build_id'],end=a['end'],
        members=[dict(code=c,name=a['instruments'][c]['name'],family=a['instruments'][c]['family'])
                 for c in a['pools']['core15']['members']]),
        ensure_ascii=False,separators=(',',':')).replace('</','<\\/')
    head=(page.split('<main>')[0]
          .replace('<title>国家队观察 · ETF通道追踪 ','<title>分段活跃度 · ETF通道追踪 ')
          .replace('href="#','href="/gjd/#')
          .replace('<button id="themeToggle" aria-label="切换深浅色">深浅色</button>',
                   '<button onclick="window.ToolSiteTheme?.toggle()" aria-label="切换深浅色">深浅色</button>')
          .replace('</style></head>',SEGMENTS_CSS+'</style></head>'))
    segments=(head+'<main>'+SEGMENTS_BODY.replace('__BUILD__',html.escape(a['build_id']))
              .replace('__END__',html.escape(a['end']))+'</main>'
              +'<script type="application/json" id="segmeta">'+segmeta+'</script>'
              +'<script>'+SEGMENTS_JS+'</script></body></html>')
    (folder/'segments.html').write_text(segments,encoding='utf-8')

FOCUS_BLOCK=r'''<section id="focus" class="focus-hero" aria-labelledby="focusHeadline">
<div class="statusline focus-status">
<time class="focus-date mono" datetime="__END__">__END__</time><span class="pill" id="focusStage">交易所正式份额</span>
</div>
<h1 id="focusHeadline"><span id="focusDirection">正式份额加载中</span> <span class="focus-amount" id="focusAmount"></span></h1>
<p class="lead" id="focusSubline"></p>
<details id="interpretation" class="focus-insight"><summary>指数净申赎明细</summary><ul id="interpretationRows"></ul></details>
<div class="focus-grid">
<section id="focusMovers" class="focus-card" aria-labelledby="focusMoversTitle">
<div class="focus-card-head"><h2 id="focusMoversTitle">净申购与净赎回排行</h2><a class="focus-more" href="#official">全部 15 只 →</a></div>
<div class="scroll desktop-core"><table><thead><tr><th>ETF / 家族</th><th>今日净申赎 / 亿</th><th>前日 / 亿</th><th>5日累计 / 亿</th><th>份额变化%</th><th>连续</th></tr></thead><tbody id="focusRows"></tbody></table></div>
<div id="focusMobile" class="mobile-cards"></div>
</section>
<section id="inventory" class="focus-card" aria-labelledby="inventoryTitle">
<div class="statusline"><span class="pill risk">ETF通道估算 · 非国家队实名仓位</span></div>
<h2 id="inventoryTitle">本轮刻度 <span class="note inventory-unit">单位：份</span></h2>
<p id="inventorySummary" class="lead"></p>
<div class="inventory-kpis" id="inventoryKpis"></div>
<div id="inventoryGauge" class="inventory-gauge"></div>
<p id="inventoryStage" class="focus-stage"></p>
<p class="note" id="inventoryBasis"></p>
<a class="focus-more inventory-mix-link" href="#inventoryMixCard">查看 ETF 构成 ↓</a>
<details><summary>基准、估算边界与上一轮峰值对照</summary><div id="inventoryMethod"></div>
<p class="note">“份”为归一化刻度。本轮净新增＝当前总存量减起点存量，已计入净减少。</p></details>
<details><summary>最近交易日的存量刻度</summary><div class="scroll"><table><thead><tr><th>业务日</th><th>当前总存量 / 份</th><th>本轮净新增 / 份</th><th>相对上一轮</th></tr></thead><tbody id="inventoryDays"></tbody></table></div>
<p class="note"><a href="/tools/national-team-etf/data/inventory.csv" download>下载存量 CSV</a></p></details>
</section>
<section id="inventoryMixCard" class="focus-card inventory-mix" aria-labelledby="inventoryMixTitle">
<div class="focus-card-head"><h2 id="inventoryMixTitle">核心 ETF 构成</h2><span class="note mix-date">业务日 __END__</span></div>
<div id="inventoryMix"></div>
</section>
</div>
</section>'''

TEMPLATE=r'''<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="gjd-build-id" content="__BUILD__"><title>国家队观察 · ETF通道追踪 __END__</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%230e639c'/%3E%3Cpath d='M6 23l6-7 4 4 9-11' stroke='white' stroke-width='2.5' fill='none'/%3E%3C/svg%3E">
<script src="/assets/site-theme.js"></script><link rel="stylesheet" href="/assets/workspace-theme.css">
<style>
:root{--bg:#f1f5f9;--surface:#fff;--inset:#edf2f7;--line:#dce4ed;--text:#172536;--muted:#64748b;--accent:#2563eb;--group-bg:#e6edf5;--group-text:#334155;--red:#d8404d;--green:#16845d;--amber:#996308}
@media(prefers-color-scheme:dark){:root:not([data-site-theme="light"]){--bg:#0e1520;--surface:#172231;--inset:#111c2b;--line:#2c3d50;--text:#e3ebf4;--muted:#a3b1c3;--accent:#79b2ff;--group-bg:#233247;--group-text:#c8d8ea;--red:#ff7b85;--green:#5ac69c;--amber:#edc170}}
:root[data-site-theme="dark"]{--bg:#0e1520;--surface:#172231;--inset:#111c2b;--line:#2c3d50;--text:#e3ebf4;--muted:#a3b1c3;--accent:#79b2ff;--group-bg:#233247;--group-text:#c8d8ea;--red:#ff7b85;--green:#5ac69c;--amber:#edc170}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.65 system-ui,"Microsoft YaHei",sans-serif}main,header{max-width:1260px;margin:auto;padding:22px 24px}header{display:flex;justify-content:space-between;gap:12px;align-items:center;border-bottom:1px solid var(--line)}nav{display:flex;flex-wrap:wrap;gap:14px}a{color:var(--accent)}h1{font-size:clamp(25px,4vw,36px);line-height:1.3;margin:8px 0 12px;letter-spacing:-.7px}h2{font-size:20px;margin:0 0 10px}h3{font-size:16px;margin:16px 0 8px}.eyebrow{font-size:12px;letter-spacing:1px;color:var(--muted)}.lead{color:var(--muted);max-width:880px}.notice{padding:14px 16px;border-left:3px solid var(--amber);background:var(--surface);border-radius:8px;color:var(--amber);margin:18px 0}.kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:20px 0}.kpi,section{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:18px}.kpi .value{font:700 clamp(23px,3vw,30px)/1.4 ui-monospace,monospace;font-variant-numeric:tabular-nums}.kpi .label,.note{color:var(--muted);font-size:12px}.note{margin-top:10px;overflow-wrap:anywhere}section{margin:16px 0}.up{color:var(--red)}.dn{color:var(--green)}.risk{color:var(--amber)}.mono{font-family:ui-monospace,monospace;font-variant-numeric:tabular-nums}.pill{display:inline-block;background:var(--inset);border:1px solid var(--line);border-radius:5px;padding:2px 7px;font-size:12px;white-space:normal}.tools{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:12px 0}input,select,button{font:inherit;color:var(--text);background:var(--surface);border:1px solid var(--line);border-radius:7px;min-height:44px;padding:8px 12px}input{min-width:0;flex:1}button{cursor:pointer}button:hover{border-color:var(--accent)}:focus-visible{outline:3px solid var(--accent);outline-offset:3px}.scroll{overflow:auto;max-width:100%}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:right;padding:10px 8px;border-bottom:1px solid var(--line);font-variant-numeric:tabular-nums}th{font-size:12px;color:var(--muted);background:var(--inset);white-space:nowrap}td:first-child,th:first-child{text-align:left}td{white-space:nowrap}td.name{max-width:220px;white-space:normal;min-width:130px}small{display:block;color:var(--muted);font-size:11px;white-space:normal}details{border-top:1px solid var(--line);margin:10px 0;padding-top:10px}summary{cursor:pointer;min-height:44px;padding:10px 0;font-weight:600}svg{width:100%;height:200px;display:block}.legend{display:flex;gap:15px;color:var(--muted);font-size:12px}.statusline{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.twocol{display:grid;grid-template-columns:1fr 1fr;gap:16px}.empty{padding:20px;color:var(--muted)}footer{font-size:12px;color:var(--muted);padding:20px 0 60px;overflow-wrap:anywhere}.mobile-cards{display:none}.cardrow{padding:12px 0;border-bottom:1px solid var(--line)}.cardmetrics{display:grid;grid-template-columns:1fr 1fr;gap:5px 12px;margin-top:8px}.cardmetrics span{font-size:13px}.cardmetrics small{font-size:11px}
@media(max-width:760px){header,main{padding:16px}header{align-items:flex-start;flex-direction:column}.kpis{grid-template-columns:1fr 1fr}.twocol{grid-template-columns:1fr}.desktop-core{display:none}.mobile-cards{display:block}input,select{font-size:16px}section{padding:14px}h2{font-size:19px}.tools>*{max-width:100%}.tools input{flex-basis:100%}.name{max-width:140px}nav a{min-height:36px}}
.statusline{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0}#intradayRows th:first-child,#intradayRows td:first-child,#postcloseBody th:first-child{text-align:left}.intraday-bad{color:var(--amber)}.intraday-ok{color:var(--muted)}
#inventory{border-top:3px solid var(--accent)}#inventoryTitle{font-size:clamp(25px,4vw,36px);line-height:1.35;margin:12px 0} .inventory-kpis{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:18px 0}.inventory-kpis .kpi{min-width:0;background:var(--inset)}.inventory-kpis .value{overflow-wrap:anywhere}@media(max-width:760px){.inventory-kpis{grid-template-columns:1fr}.inventory-kpis .kpi{padding:14px}}
/* ==== v2.3 视觉层：统一 token / 三级层级 / 语义状态 / 交互反馈 ====
   覆盖上方基础样式，基础样式保留作 fallback；不改动任何文案、数据与 id。 */
:root{
  --surface-2:#fbfdff;--row-alt:#f7fafd;--faint:#94a3b8;--line-strong:#cbd8e6;
  --accent-soft:#e8f0ff;--accent-line:#b9d0ff;
  --red-soft:#fdecee;--green-soft:#e7f6ef;--amber-soft:#fdf3dd;--info-soft:#eaf1fd;
  --red-line:#f5c2c7;--green-line:#b6e2ce;--amber-line:#efd99a;
  --shadow:0 1px 2px rgba(16,32,56,.04),0 10px 30px rgba(16,32,56,.07);
  --shadow-sm:0 1px 2px rgba(16,32,56,.045);
  --s1:4px;--s2:8px;--s3:12px;--s4:16px;--s5:24px;--s6:32px;--s7:48px;
  --r-card:14px;--r-ctl:9px;--r-pill:999px;--header-h:62px;
}
@media(prefers-color-scheme:dark){:root:not([data-site-theme="light"]){
  --surface-2:#172536;--row-alt:#18263a;--faint:#71859d;--line-strong:#354a63;
  --accent-soft:#16283f;--accent-line:#2b4a70;
  --red-soft:#3a1e26;--green-soft:#12312a;--amber-soft:#332913;--info-soft:#15273f;
  --red-line:#6b3038;--green-line:#255545;--amber-line:#5c4a1f;
  --shadow:0 1px 2px rgba(0,0,0,.22),0 10px 30px rgba(0,0,0,.28);
  --shadow-sm:0 1px 2px rgba(0,0,0,.2);
}}
:root[data-site-theme="dark"]{
  --surface-2:#172536;--row-alt:#18263a;--faint:#71859d;--line-strong:#354a63;
  --accent-soft:#16283f;--accent-line:#2b4a70;
  --red-soft:#3a1e26;--green-soft:#12312a;--amber-soft:#332913;--info-soft:#15273f;
  --red-line:#6b3038;--green-line:#255545;--amber-line:#5c4a1f;
  --shadow:0 1px 2px rgba(0,0,0,.22),0 10px 30px rgba(0,0,0,.28);
  --shadow-sm:0 1px 2px rgba(0,0,0,.2);
}
html{scroll-behavior:smooth}
body{font:14px/1.65 system-ui,-apple-system,"Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
::selection{background:var(--accent-soft);color:var(--text)}
main,header{max-width:1240px;padding:0 var(--s5)}
/* 吸顶导航：全宽背景 + 内容对齐 1240 栅格 */
header{position:sticky;top:0;z-index:50;display:flex;align-items:center;justify-content:space-between;
  gap:var(--s4);min-height:var(--header-h);max-width:none;width:100%;margin:0;
  padding-inline:max(var(--s5),calc((100% - 1240px)/2 + var(--s5)));
  background:var(--surface);border-bottom:1px solid var(--line);box-shadow:var(--shadow-sm)}
@supports(backdrop-filter:blur(1px)){
  header{background:color-mix(in srgb,var(--surface) 88%,transparent);backdrop-filter:blur(14px)}}
header>strong{display:inline-flex;align-items:center;gap:var(--s2);font-size:13.5px;letter-spacing:-.2px;white-space:nowrap}
header>strong .pill{font-size:10.5px;font-weight:600;letter-spacing:.3px;background:var(--accent-soft);border-color:var(--accent-line);color:var(--accent)}
nav{display:flex;align-items:center;justify-content:flex-end;gap:2px;flex-wrap:nowrap;min-width:0;flex:1;
  overflow-x:auto;scrollbar-width:none;overscroll-behavior-x:contain}
nav::-webkit-scrollbar{display:none}
nav a{display:inline-flex;align-items:center;white-space:nowrap;text-decoration:none;color:var(--muted);
  font-size:12.5px;font-weight:500;padding:6px 11px;border:1px solid transparent;border-radius:var(--r-pill);
  transition:color .18s,background .18s,border-color .18s}
nav a:hover{color:var(--accent);background:var(--accent-soft)}
nav a.is-active{color:var(--accent);background:var(--accent-soft);border-color:var(--accent-line);font-weight:650}
#themeToggle{position:sticky;right:0;flex:0 0 auto;margin-left:var(--s2);min-height:32px;padding:5px 12px;
  font-size:11.5px;font-weight:600;color:var(--muted);background:var(--surface);
  border:1px solid var(--line-strong);border-radius:var(--r-pill)}
#themeToggle:hover{color:var(--accent);border-color:var(--accent);background:var(--accent-soft)}
section[id]{scroll-margin-top:calc(var(--header-h) + var(--s3))}
/* 标题层级：降低 slogan，抬高核心数据 */
.eyebrow{font-size:10.5px;letter-spacing:1.7px;text-transform:uppercase;color:var(--faint);font-weight:650;margin-top:var(--s6)}
h1{font-size:clamp(23px,3vw,31px);line-height:1.3;margin:var(--s3) 0 var(--s2);letter-spacing:-.7px;font-weight:720;color:var(--text)}
h2{font-size:18px;line-height:1.4;margin:0 0 var(--s3);font-weight:700;letter-spacing:-.2px}
h3{font-size:14px;margin:var(--s4) 0 var(--s2)}
.lead{color:var(--muted);max-width:780px;font-size:13.5px;margin:0 0 var(--s5)}
.note,.kpi .label{color:var(--muted);font-size:11.5px;line-height:1.65}
.note{margin-top:var(--s3);overflow-wrap:anywhere}
/* 三级区块：主区块 / 辅助区块 / 焦点区 */
section{background:var(--surface);border:1px solid var(--line);border-radius:var(--r-card);
  padding:var(--s5);margin:var(--s4) 0;box-shadow:var(--shadow-sm)}
section>h2{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
section>h2::before{content:"";width:3px;height:17px;border-radius:2px;background:var(--accent);flex:0 0 auto}
section>h2 .pill{font-size:11px;font-weight:500}
main>section:not([id]){background:var(--surface-2);box-shadow:none;border-color:var(--line)}
main>section:not([id])>h2{font-size:16px}
main>section:not([id])>h2::before{background:var(--line-strong);height:14px}
#inventory{border-top:3px solid var(--accent);box-shadow:var(--shadow);margin-top:var(--s5);padding-bottom:var(--s4)}
#inventory>h2{font-size:clamp(25px,3.4vw,34px);line-height:1.3;letter-spacing:-1px;font-weight:750;margin:var(--s3) 0 var(--s2)}
#inventory>h2::before{display:none}
#inventoryTitle{margin:var(--s3) 0 var(--s2)}
/* 状态标签：语义配色，一眼区分风险/正常 */
.statusline{display:flex;flex-wrap:wrap;gap:var(--s2);align-items:center;margin:var(--s3) 0}
.pill{display:inline-flex;align-items:center;gap:5px;max-width:100%;padding:3px 10px;font-size:11.5px;
  line-height:1.55;font-weight:500;color:var(--muted);background:var(--inset);
  border:1px solid var(--line);border-radius:var(--r-pill);white-space:normal;overflow-wrap:anywhere}
.pill.risk{color:var(--amber);background:var(--amber-soft);border-color:var(--amber-line)}
.risk{color:var(--amber)}
/* 指标卡：统一语言、主次分离、hover 反馈 */
.kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:var(--s3);margin:var(--s4) 0}
.kpi{display:flex;flex-direction:column;gap:2px;min-width:0;background:var(--surface);
  border:1px solid var(--line);border-radius:12px;padding:var(--s4);box-shadow:var(--shadow-sm);
  transition:transform .18s ease,box-shadow .18s ease,border-color .18s ease}
.kpi:hover{transform:translateY(-2px);box-shadow:var(--shadow);border-color:var(--line-strong)}
.kpi .label{font-weight:500;letter-spacing:.2px}
.kpi .value{font:700 clamp(23px,2.6vw,30px)/1.3 ui-monospace,"SFMono-Regular",monospace;
  font-variant-numeric:tabular-nums;letter-spacing:-1px;white-space:nowrap;margin:2px 0;overflow-wrap:normal}
.kpi .value small{display:inline;font-size:10.5px;font-weight:500;letter-spacing:0;color:var(--faint);margin-left:5px}
.inventory-kpis{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:var(--s3);margin:var(--s4) 0}
.inventory-kpis .kpi{background:var(--inset);border-color:transparent;box-shadow:none}
.inventory-kpis .kpi:first-child{background:var(--accent-soft);border-color:var(--accent-line)}
.inventory-kpis .kpi:hover{box-shadow:var(--shadow-sm)}
.inventory-kpis .value{font-size:clamp(28px,3.4vw,40px);letter-spacing:-1.6px}
.up{color:var(--red)}.dn{color:var(--green)}
.mono{font-family:ui-monospace,"SFMono-Regular",monospace;font-variant-numeric:tabular-nums}
.notice{padding:var(--s3) var(--s4);margin:var(--s4) 0;color:var(--text);font-size:13px;
  background:var(--surface-2);border:1px solid var(--line);border-left:3px solid var(--amber);
  border-radius:0 10px 10px 0}
/* 长表：收进可滚动容器，表头吸顶，缩短整体滚动长度 */
.scroll{overflow:auto;max-width:100%;border:1px solid var(--line);border-radius:10px;background:var(--surface);
  scrollbar-width:thin;scrollbar-color:var(--line-strong) transparent;overscroll-behavior:contain}
.scroll::-webkit-scrollbar{width:9px;height:9px}
.scroll::-webkit-scrollbar-thumb{background:var(--line-strong);border:2px solid var(--surface);border-radius:9px}
.scroll::-webkit-scrollbar-track{background:transparent}
#intraday .scroll,#official .scroll,#channels .scroll,#discover .scroll{max-height:min(58vh,520px)}
table{width:100%;border-collapse:separate;border-spacing:0;font-size:12.5px}
th,td{text-align:right;padding:9px 12px;border-bottom:1px solid var(--line);font-variant-numeric:tabular-nums}
thead th{position:sticky;top:0;z-index:2;background:var(--inset);color:var(--muted);font-size:11px;
  font-weight:650;letter-spacing:.3px;white-space:nowrap;border-bottom:1px solid var(--line-strong)}
tbody tr:nth-child(even){background:var(--row-alt)}
tbody tr:hover{background:var(--accent-soft)}
tbody tr:last-child td{border-bottom:0}
th:first-child,td:first-child{text-align:left}
td{white-space:nowrap}
td.name{max-width:220px;min-width:130px;white-space:normal}
small{display:block;color:var(--faint);font-size:10.5px;line-height:1.5;white-space:normal}
#intradayRows th:first-child,#intradayRows td:first-child,#postcloseBody th:first-child{text-align:left}
.intraday-bad{color:var(--amber)}.intraday-ok{color:var(--muted)}
/* 折叠：面板化 + 箭头旋转反馈 */
details{margin:var(--s3) 0 0;border:1px solid var(--line);border-radius:10px;background:var(--surface-2);overflow:hidden}
summary{display:flex;align-items:center;gap:10px;min-height:42px;padding:10px var(--s4);
  cursor:pointer;list-style:none;font-size:12.5px;font-weight:650;color:var(--text);
  transition:background .18s ease}
summary::-webkit-details-marker{display:none}
summary::before{content:"";flex:0 0 auto;width:0;height:0;border-left:5px solid var(--muted);
  border-top:4px solid transparent;border-bottom:4px solid transparent;transition:transform .2s ease}
details[open]>summary::before{transform:rotate(90deg)}
details[open]>summary{border-bottom:1px solid var(--line)}
summary:hover{background:var(--accent-soft)}
details>:not(summary){margin-left:var(--s4);margin-right:var(--s4)}
details>:not(summary):last-child{margin-bottom:var(--s3)}
details>.scroll{max-height:none}
/* 工具栏与控件：统一尺寸、箭头、focus 与 hover */
.tools{display:flex;align-items:center;flex-wrap:wrap;gap:var(--s2);margin:var(--s3) 0;
  padding:var(--s3);background:var(--inset);border-radius:10px}
.tools label{font-size:11.5px;color:var(--muted);white-space:nowrap}
.tools label:has(input[type=checkbox]){display:inline-flex;align-items:center;gap:6px}
input,select,button{font:inherit;font-size:12.5px;color:var(--text);background:var(--surface);
  border:1px solid var(--line-strong);border-radius:var(--r-ctl);min-height:38px;padding:7px 11px;
  transition:border-color .18s ease,background .18s ease,box-shadow .18s ease}
input{min-width:0;flex:1;min-width:180px}
select{appearance:none;padding-right:30px;cursor:pointer;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%2394a3b8' stroke-width='1.5'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 11px center}
button{cursor:pointer;font-weight:600}
button:hover{border-color:var(--accent);background:var(--accent-soft)}
.tools button{color:var(--accent);border-color:var(--accent-line);background:var(--accent-soft)}
.tools input[type=checkbox]{flex:0 0 auto;width:16px;height:16px;min-width:0;min-height:0;padding:0;accent-color:var(--accent)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
/* 图表与图例 */
.legend{display:flex;flex-wrap:wrap;gap:var(--s4);color:var(--muted);font-size:11.5px;margin:var(--s2) 0}
.legend span{display:inline-flex;align-items:center;gap:6px}
.legend span::before{content:"";width:9px;height:9px;border-radius:2px;background:var(--line-strong)}
.legend span:first-child::before{background:var(--red)}
.legend span:nth-child(2)::before{background:var(--green)}
.legend span:nth-child(3)::before{display:none}
#chart{margin-top:var(--s3);padding:var(--s3);background:var(--surface-2);border:1px solid var(--line);border-radius:10px}
svg{width:100%;height:200px;display:block}
.twocol{display:grid;grid-template-columns:1fr 1fr;gap:var(--s4)}
.empty{padding:var(--s4);color:var(--muted)}
.mobile-cards{display:none}
.cardrow{padding:var(--s3) 0;border-bottom:1px solid var(--line)}
.cardmetrics{display:grid;grid-template-columns:1fr 1fr;gap:6px 12px;margin-top:var(--s2)}
.cardmetrics span{font-size:12.5px}.cardmetrics small{font-size:10.5px}
footer{margin-top:var(--s6);padding:var(--s5) 0 var(--s7);border-top:1px solid var(--line);
  font-size:11.5px;line-height:1.8;color:var(--faint);overflow-wrap:anywhere}
/* 回到顶部：滚动后出现，不占首屏 */
#backTop{position:fixed;right:22px;bottom:22px;z-index:60;width:42px;height:42px;padding:0;
  display:grid;place-items:center;font-size:17px;line-height:1;border-radius:50%;
  background:var(--surface);border:1px solid var(--line-strong);box-shadow:var(--shadow);
  opacity:0;pointer-events:none;transform:translateY(8px);
  transition:opacity .2s ease,transform .2s ease,border-color .2s ease,color .2s ease}
#backTop.is-visible{opacity:1;pointer-events:auto;transform:none}
#backTop:hover{color:var(--accent);border-color:var(--accent);background:var(--accent-soft)}
@media(max-width:760px){
  :root{--header-h:88px}
  header,main{padding-left:var(--s4);padding-right:var(--s4)}
  header{position:sticky;flex-direction:row;flex-wrap:wrap;align-items:center;gap:0;
    min-height:var(--header-h);padding-top:var(--s2);padding-bottom:var(--s2)}
  header>strong{font-size:13px}
  nav{order:3;flex:1 0 100%;display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:2px;margin-top:6px;padding:0}
  nav a{justify-content:center;min-height:32px;font-size:11.5px;padding:5px 2px}
  #themeToggle{position:absolute;right:var(--s4);top:9px;margin:0;min-height:30px;padding:4px 10px;font-size:11px}
  section,main>section:not([id]),#inventory{padding:var(--s4)}
  section{margin:var(--s3) 0}
  h1{font-size:23px;margin-top:var(--s4)}
  h2{font-size:16px}
  #inventory>h2{font-size:25px}
  .eyebrow{margin-top:var(--s5)}
  .kpis,.inventory-kpis{grid-template-columns:1fr 1fr;gap:var(--s2)}
  .kpi,.inventory-kpis .kpi{padding:var(--s3)}
  .inventory-kpis .kpi:first-child{grid-column:1/-1}
  .kpi .value{font-size:22px}
  .kpi .value small{display:block;margin:2px 0 0;font-size:10px}
  .inventory-kpis .value{font-size:30px}
  .twocol{grid-template-columns:1fr}
  .desktop-core{display:none}.mobile-cards{display:block}
  input,select{font-size:16px}
  .tools>*{max-width:100%}.tools input{flex-basis:100%;min-width:0}
  .name{max-width:140px}
  #intraday .scroll,#official .scroll,#channels .scroll,#discover .scroll{max-height:60vh}
  #backTop{right:14px;bottom:14px;width:38px;height:38px}
}
@media(prefers-reduced-motion:reduce){
  html{scroll-behavior:auto}
  *,*::before,*::after{transition:none!important;animation:none!important}
}
/* ==== 三阶段版本条：盘中 / 盘后 / 次日 ==== */
#stages{margin:var(--s5) 0 0;background:transparent;border:0;box-shadow:none;padding:0}
#stages>h2{margin-bottom:var(--s2)}
#intraday .kpis{grid-template-columns:repeat(2,minmax(0,1fr))}
.intraday-meta{display:flex;flex-wrap:wrap;gap:var(--s2)}
.stage-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:var(--s3);margin-top:var(--s3)}
.stage-card{display:flex;flex-direction:column;gap:6px;min-width:0;padding:var(--s4);
  background:var(--surface);border:1px solid var(--line);border-left:3px solid var(--line-strong);
  border-radius:var(--r-card);box-shadow:var(--shadow-sm);text-decoration:none;color:inherit;
  transition:transform .18s ease,box-shadow .18s ease,border-color .18s ease}
.stage-card:hover{transform:translateY(-2px);box-shadow:var(--shadow);border-color:var(--line-strong)}
.stage-card.is-active{border-left-color:var(--accent);background:var(--accent-soft);box-shadow:var(--shadow)}
.stage-head{display:flex;align-items:center;gap:var(--s2);flex-wrap:wrap}
.stage-name{font-size:14px;font-weight:750;letter-spacing:-.2px}
.stage-badge{font-size:10.5px;font-weight:650;letter-spacing:.2px;padding:2px 7px;border-radius:var(--r-pill);
  border:1px solid var(--line-strong);color:var(--muted);background:var(--surface-2);white-space:nowrap}
.stage-badge.tone-live{color:var(--accent);background:var(--accent-soft);border-color:var(--accent-line)}
.stage-badge.tone-provisional{color:var(--amber);background:var(--amber-soft);border-color:var(--amber-line)}
.stage-badge.tone-verified{color:var(--green);background:var(--green-soft);border-color:var(--green-line)}
.stage-date{font:700 19px/1.3 ui-monospace,monospace;font-variant-numeric:tabular-nums;letter-spacing:-.5px}
.stage-desc{font-size:12px;color:var(--text);line-height:1.5}
@media(max-width:760px){.stage-grid{grid-template-columns:1fr;gap:var(--s2)}
  .stage-card{padding:var(--s3)}}
/* ==== 焦点首屏：结论、分品种、刻度 ==== */
.focus-hero{background:transparent;border:0;box-shadow:none;padding:0;margin:var(--s4) 0 var(--s5)}
.focus-hero h1{display:flex;flex-wrap:wrap;align-items:baseline;gap:0 .4em;font-size:clamp(28px,4.2vw,42px);line-height:1.2;letter-spacing:-.8px;margin:var(--s3) 0 var(--s2)}
.focus-amount{white-space:nowrap;font-variant-numeric:tabular-nums}
.focus-amount:empty{display:none}
.focus-date{font-size:12px;color:var(--muted)}
.focus-hero #focusSubline{margin-bottom:var(--s3)}
.focus-status{margin:var(--s3) 0 var(--s2)}
#interpretation{margin:0 0 var(--s4)}
#interpretation[hidden]{display:none}
.focus-insight ul{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px var(--s4);padding:0;list-style:none}
.focus-insight li{padding:4px 0;color:var(--muted);font-size:12.5px}
.focus-grid{display:grid;grid-template-columns:minmax(0,1.45fr) minmax(0,1fr);gap:var(--s4);align-items:stretch}
.focus-card{background:var(--surface);border:1px solid var(--line);border-radius:var(--r-card);box-shadow:var(--shadow-sm);padding:var(--s4);margin:0;min-width:0}
.focus-card>h2{font-size:17px;margin:0 0 var(--s2)}
.focus-card-head{display:flex;align-items:center;justify-content:space-between;gap:var(--s2);flex-wrap:wrap;margin-bottom:var(--s2)}
.focus-card-head h2{margin:0;font-size:17px}
.focus-more{font-size:12px;text-decoration:none;white-space:nowrap}
.focus-card table{font-size:12.5px}
.focus-card th,.focus-card td{padding:8px}
.focus-card .scroll{max-height:430px;border:1px solid var(--line);border-radius:9px}
.focus-stage{font-size:12.5px;line-height:1.6;margin:var(--s2) 0;color:var(--text)}
.focus-stage b{font-size:14px}
.inventory-gauge{margin:var(--s3) 0 var(--s1)}
.gauge-track{position:relative;height:10px;background:var(--inset);border-radius:999px;border:1px solid var(--line)}
.gauge-fill{height:100%;border-radius:999px;background:linear-gradient(90deg,var(--accent-line),var(--accent));max-width:100%}
.gauge-start,.gauge-now{position:absolute;top:-4px;width:2px;height:18px;background:var(--muted)}
.gauge-start{opacity:.45}
.gauge-now{background:var(--accent);width:3px}
.gauge-labels{position:relative;display:flex;justify-content:space-between;font-size:10.5px;color:var(--muted);margin-top:5px}
.gauge-origin{position:absolute;transform:translateX(-50%);white-space:nowrap}
.inventory-mix{grid-column:1/-1}
.inventory-mix-link{display:inline-flex;align-items:center;min-height:32px}
.mix-date{margin:0}
.mix-context{display:flex;flex-wrap:wrap;justify-content:space-between;gap:4px 12px;margin:0 0 var(--s3)}
.mix-list{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:var(--s2);margin:0;padding:0;list-style:none}
.mix-row{display:flex;flex-direction:column;gap:8px;min-width:0;padding:var(--s3);background:var(--inset);border:1px solid var(--line);border-radius:9px}
.mix-label{display:grid;grid-template-columns:minmax(0,1fr) auto;column-gap:8px;align-items:baseline}
.mix-name{min-width:0;overflow-wrap:anywhere;font-size:13px;font-weight:650}
.mix-percent{font-size:14px;text-align:right}
.mix-code,.mix-units{font-size:11px;color:var(--muted)}
.mix-units{text-align:right;white-space:nowrap}
.mix-track{height:5px;margin-top:auto;background:var(--line);border-radius:999px}
.mix-track span{display:block;height:100%;border-radius:inherit;background:var(--accent)}
.inventory-mix details{margin:var(--s3) 0 0;background:var(--surface-2)}
.inventory-mix details>summary{min-height:44px}
.inventory-mix details .mix-list{margin:var(--s3)}
@media(max-width:1000px){.mix-list{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:560px){
  .mix-list{grid-template-columns:minmax(0,1fr)}
  .inventory-mix-link{min-height:44px}
  .inventory-mix details .mix-list{margin:var(--s2)}
}
.focus-grid #inventory{margin:0;min-width:0;border-top:1px solid var(--line);box-shadow:var(--shadow-sm);padding:var(--s4);border-radius:var(--r-card)}
.focus-grid #inventory>h2{font-size:19px;letter-spacing:-.4px;margin:var(--s2) 0}
.focus-grid #inventory .inventory-kpis{grid-template-columns:repeat(3,minmax(0,1fr));gap:var(--s2);margin:var(--s3) 0}
.focus-grid #inventory .inventory-kpis .kpi{padding:10px;border-radius:9px}
.focus-grid #inventory .inventory-kpis .value{font-size:22px;letter-spacing:-.5px}
.focus-grid #inventory .inventory-kpis .kpi:first-child{grid-column:auto}
.inventory-unit{margin:0 0 0 auto;font-weight:500}
.focus-grid #inventory .lead{margin-bottom:var(--s2)}
@media(max-width:860px){
  .focus-grid{grid-template-columns:1fr}
  .focus-grid #inventory,.focus-grid .inventory-mix{order:-1}
  .focus-hero h1{font-size:clamp(21px,5.8vw,32px)}
  .focus-insight ul{grid-template-columns:1fr}
  .focus-card .scroll{max-height:52vh}
  .focus-grid #inventory .inventory-kpis .kpi{padding:8px}
  .focus-grid #inventory .inventory-kpis .value{font-size:clamp(16px,4.8vw,22px)}
}
@media(max-width:300px){
  :root{--header-h:112px}
  header nav{grid-template-columns:repeat(3,minmax(0,1fr))}
  .focus-grid #inventory .inventory-kpis{grid-template-columns:minmax(0,1fr)}
  .focus-grid #inventory .inventory-kpis .kpi{flex-direction:row;align-items:baseline;justify-content:space-between;gap:4px}
}
</style></head><body>
<button id="backTop" aria-label="回到顶部" title="回到顶部">↑</button>
<header><strong>国家队观察</strong><nav><a href="#focus">最新一日</a><a href="#inventory">本轮刻度</a><a href="#official">全部明细</a><a href="/gjd/cycle">历史复盘</a><a href="/tools/national-team-etf/segments.html">分段成交</a><button id="themeToggle" aria-label="切换深浅色">深浅色</button></nav></header>
<main>
__FOCUS_BLOCK__
<section id="stages" aria-labelledby="stagesTitle"><h2 id="stagesTitle">数据版本</h2>
<div class="stage-grid" id="stageCards"></div></section>
<section id="intraday"><h2>盘中观察</h2>
<details><summary>行情与通道线索</summary>
<div class="statusline"><span class="pill" id="intradayStage">等待行情</span><span class="intraday-meta" id="intradayStatus"></span></div>
<div class="kpis" id="intradayKpis"></div>
<div class="scroll"><table><thead><tr><th>ETF / 家族</th><th>现价</th><th>涨跌%</th><th>相对指数</th><th>折溢价%</th><th>通道线索</th><th>反向证据</th></tr></thead><tbody id="intradayRows"></tbody></table></div>
<p class="note">行情约每 60 秒刷新。盘中只观察价格与成交线索，买卖主体未知。<a href="/tools/national-team-etf/segments.html">查看分段成交与放量</a></p>
<details><summary>云端留档与事件</summary><p class="note" id="intradayEvents"></p></details></details></section>
<section id="postclose"><h2>盘后初值</h2>
<details><summary>反推净申赎与刻度</summary>
<p class="note" id="postcloseScope"></p>
<div id="postcloseBody"></div></details></section>
<section id="official"><h2>交易所正式份额 · 核心15只</h2><details><summary>展开完整15只明细、来源与修订</summary><p class="note" id="officialScope"></p><div class="scroll desktop-core"><table><thead><tr><th>ETF / 家族</th><th>前日 / 亿份</th><th>当日 / 亿份</th><th>变化 / 亿份</th><th>变化比例</th><th>敞口估算 / 亿元</th><th>5日 / 亿元</th><th>正式份额状态</th><th>来源</th></tr></thead><tbody id="officialRows"></tbody></table></div><div id="officialMobile" class="mobile-cards"></div><details><summary>最近交易日的正式份额变化</summary><div class="scroll"><table><thead><tr><th>日期</th><th>敞口估算 / 亿元</th><th>减少 / 增加</th><th>覆盖</th></tr></thead><tbody id="officialDays"></tbody></table></div></details><p class="note">正式份额确认的是基金净申赎。金额按份额变化×当日不复权成交均价估算，表示证券敞口变化；不是国家队实际现金流。无法据此识别赎回账户，也不能覆盖全部二级市场卖出。</p></details></section>
<section><h2>核心正式份额 · 分通道减仓观察</h2><details><summary>展开分通道减仓观察</summary><p class="note">使用相同固定核心成员，正式份额独立计算5/10/20日与事件状态；未覆盖的窗口不补历史反推。短期回补不自动清除旧事件。规则阈值尚未用实名交易校准。</p><div class="scroll"><table><thead><tr><th>家族</th><th>当日 / 亿元</th><th>5日</th><th>10日</th><th>20日</th><th>状态</th></tr></thead><tbody id="officialFamilies"></tbody></table></div></details></section>
<section><h2>历史补充 · 核心通道近100日换手率反推</h2><details><summary>展开近100日反推图</summary><div class="legend"><span>红：净申购</span><span>绿：净赎回</span><span>金额单位：亿元；缺失留空</span></div><p class="note">以下为供应商换手率反推序列，分母可能滞后或修订。与上方正式披露独立计算，避免混接两种口径；当日判断优先看上方正式份额。</p><div id="chart"></div></details></section>
<section id="channels"><h2>历史反推 · 分通道减仓观察</h2><details><summary>展开历史反推与通道状态</summary><p class="note">本表是换手率反推的历史观察状态，不能替代上方正式份额。份额回撤按过去63个交易日峰值计算，跨份额合并已换至同一单位。5/10/20日均使用逐日估算相加。短暂回补不会自动解除持续流出观察。</p>
<div class="tools"><label for="pool">观察范围</label><select id="pool"><option value="core">核心15只</option><option value="fixed">固定境内扩展池</option><option value="candidates">新发现候选</option><option value="all">全部已核算标的</option></select><input id="search" aria-label="搜索ETF代码、名称或家族" placeholder="搜索代码、名称或家族"><label><input type="checkbox" id="onlyRisk" style="min-height:0">仅看流出观察</label></div>
<div class="scroll desktop-core"><table><thead><tr><th>ETF / 跟踪家族</th><th>今日估算</th><th>5日</th><th>10日</th><th>20日</th><th>份额回撤</th><th>预警状态</th><th>身份依据</th></tr></thead><tbody id="fundRows"></tbody></table></div><div id="mobileRows" class="mobile-cards"></div><p id="fundCount" class="note"></p>
<details><summary>状态与身份如何分开判断</summary><p>“流出线索”保留尚未超出误差的小变化；“持续流出/加速”结合累计净赎回、规模比例和持续性；“暂缓/持续观察”保留事件过程；连续有效回补才解除。它们描述资金通道，不等于国家队减持确认。</p><p>I0：身份未知。I1：核心通道线索，角色本身不证明身份。I2：有已核验的历史持有人或政策关联资料，仍不证明当日交易。I3：当日、标的和方向都有实名公开证据。未经校准不展示概率。行为候选另看累计份额、历史异常、成交活跃和跨家族一致性；这些条件可能相关，不自动升级身份等级。</p><p>研究阈值：5日净赎回占期初规模0.5%、或稳健份额回撤1%，并结合持续天数；加速阈值为5日2%或单日1%。阈值可改、尚未以实名交易真值校准。</p></details></details></section>
<section><h2>固定境内池 · 家族视角</h2><details><summary>展开家族视角</summary><p class="note" id="familyScope"></p><div class="scroll"><table><thead><tr><th>家族</th><th>今日</th><th>5日</th><th>10日</th><th>流出广度</th><th>覆盖</th><th>状态</th></tr></thead><tbody id="familyRows"></tbody></table></div></details></section>
<section id="discover"><h2>ETF 候选扫描</h2><details><summary>候选 ETF 与样本关系</summary><p class="note" id="discoveryScope"></p><div class="tools"><label for="direction">线索排序</label><select id="direction"><option value="out">5日流出</option><option value="in">5日流入</option><option value="small">今日小额变化</option></select><button id="download">下载本页数据</button></div><div class="scroll"><table><thead><tr><th>ETF / 家族</th><th>今日估算</th><th>5日估算</th><th>舍入范围是否跨0</th><th>样本关系</th></tr></thead><tbody id="discoveryRows"></tbody></table></div><p class="note">分页完整仅指本次供应商目录，不代表已核对交易所全量ETF，可能遗漏新上市或未收录产品。目录按当前信息分类，尚未核实的家族会明确标记。发现队列不悄然改动固定历史总额；新候选需要登记后才能变更观察池版本。</p></details></section>
<section id="quality"><h2>数据可信程度</h2><details><summary>展开数据质量、误差与跨源核对</summary><div id="qualitySummary"></div><details><summary>误差、缺口与跨源核对</summary><div id="qualityDetails"></div></details><details><summary>方法、来源与识别边界</summary><p>估算份额＝成交量(手)×10000÷换手率(%)。相邻交易日份额差按真实份额合并比例换算，再乘当日不复权成交均价。份额对应证券敞口变化，未必是现金流，也不提供买卖主体。</p><p>换手率两位小数的舍入区间按±0.005个百分点传播；5日累计利用共享端点误差，不简单相加每日误差。区间不是统计置信区间，未涵盖分母日期错误、数据源修订等风险。</p><p>不把快照贴成历史日线，不用复权价格计算历史规模，不以指数涨跌、成本线、政策语言关闭监控。未登记的疑似份额行动会隔离；缺失不记0。</p><p><a href="https://etf.sse.com.cn/fund/quertion/">上交所ETF机制</a> · <a href="https://www.sse.com.cn/disclosure/fund/announcement/c/new/2024-09-23/510310_20240923_G18B.pdf">510310官方合并比例</a></p></details><details><summary>历史回放检验</summary><p id="evaluation"></p></details></details></section>
<footer>正式数据截止 __END__ · 构建 __BUILD__</footer>
</main><script type="application/json" id="dataset">__DATA__</script><script>
const D=JSON.parse(document.getElementById('dataset').textContent),$=id=>document.getElementById(id);
$('themeToggle').onclick=()=>{if(window.ToolSiteTheme){window.ToolSiteTheme.toggle();}else{document.documentElement.dataset.siteTheme=document.documentElement.dataset.siteTheme==='dark'?'light':'dark';}};
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num=(x,d=1)=>x===null||x===undefined?'—':(x>0?'+':'')+x.toLocaleString('zh-CN',{minimumFractionDigits:d,maximumFractionDigits:d});
const val=x=>`<span class="mono ${x>0?'up':x<0?'dn':''}">${num(x)}</span>`;
const range=w=>w&&w.low!==null?`${num(w.low)} 至 ${num(w.high)} 亿`:'数据不足';
// 盘中实时区 render() 会调用 pill；精简 DOM 的验收环境走静态降级分支，测不到这里，
// 曾导致真实浏览器每轮抛 ReferenceError。保持全局定义，勿移进 IIFE。
const pill=(text,warn=false)=>`<span class="pill${warn?' risk':''}">${esc(text)}</span>`;
const I=D.inventory,ip=x=>x===null||x===undefined?'—':x.toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2});
function renderInventoryMix(point){
 const target=$('inventoryMix'),total=point?.current_yi,parts=point?.components??[];
 const members=new Set(I?.members??[]),codes=new Set(parts.map(x=>x.code));
 const sum=parts.reduce((s,x)=>s+x.current_yi,0);
 if(!Number.isFinite(total)||total<=0||parts.length!==members.size||codes.size!==members.size||
    parts.some(x=>!members.has(x.code)||!Number.isFinite(x.current_yi)||x.current_yi<=0)||
    Math.abs(sum-total)>total*1e-9){
  target.textContent='当前构成数据未齐，暂不展示占比。';
  return;
 }
 const names=new Map((I.components??[]).map(x=>[x.code,x.name]));
 const rows=parts.slice().sort((a,b)=>b.current_yi-a.current_yi);
 const scale=Math.ceil((rows[0].current_yi/total*100+1e-9)/5)*5;
 const draw=(items,start=1)=>`<ol class="mix-list" role="list" start="${start}">${items.map(x=>{
  const pct=x.current_yi/total*100,units=x.current_yi/total*point.total_units;
  return `<li class="mix-row" data-etf="${esc(x.code)}">
   <div class="mix-label"><span class="mix-name">${esc(names.get(x.code)??x.code)}</span><strong class="mix-percent mono">${pct.toFixed(2)}%</strong>
   <span class="mix-code mono">${esc(x.code)}</span><span class="mix-units mono">折合 ${units.toFixed(2)} 份</span></div>
   <div class="mix-track" aria-hidden="true"><span style="width:${(pct/scale*100).toFixed(3)}%"></span></div></li>`;
 }).join('')}</ol>`;
 const shown=6;
 target.innerHTML=`<p class="note mix-context"><span>占核心 ${members.size} 只 ETF 当前恒价总存量的比例</span><span>横条满格为 ${scale}%</span></p>
  ${draw(rows.slice(0,shown))}
  ${rows.length>shown?`<details><summary>展开其余 ${rows.length-shown} 只 ETF</summary>${draw(rows.slice(shown),shown+1)}</details>`:''}`;
}
function renderInventory(){
 const r=I?.latest,ok=I?.complete&&r?.complete&&r.date===D.end;
 renderInventoryMix(ok?r:null);
 $('inventorySummary').textContent=ok?`上一轮基准的 ${(r.current_ratio*100).toFixed(1)}% · 起点的 ${(r.total_units/I.cycle_start_units).toFixed(1)} 倍`:'当前存量数据未齐，暂不展示比例。';
 $('inventoryKpis').innerHTML=[['当前总存量',ok?r.total_units:null],['本轮净新增',ok?r.net_added_units:null],['本轮起点',I?.cycle_start_units??null]].map(([label,v],i)=>`<div class="kpi"><div class="label">${esc(label)}</div><div class="value">${i===1?num(v,2):ip(v)}</div></div>`).join('');
 $('inventoryBasis').textContent=I?`10 份基准 ${I.reference_date} · 固定价格 ${I.price_date}`:'基准待核对';
 $('inventoryMethod').innerHTML=I?`<p>10 份基准取上一轮 924 周期结束值。本轮从 ${I.cycle_start} 起算，起点存量取 ${I.cycle_anchor_date}。</p><p>恒价规模（亿元）：10 份基准 ${ip(I.reference_yi)}，起点 ${ip(I.cycle_start_yi)}${ok?`，当前 ${ip(r.current_yi)}，本轮净新增 ${num(r.net_added_yi,1)}`:''}。</p><p>以 ${I.alternative_reference_date} 历史峰值为 10 份时，当前为 ${ok?ip(r.alternative_units):'—'} 份。</p><p class="note">份额来自换手率反推，价格固定在 ${I.price_date}。换手率分母、舍入和历史修订会影响估算。</p>`:'<p>暂无可用基准。</p>';
 $('inventoryDays').innerHTML=(I?.series??[]).slice(-10).reverse().map(x=>`<tr><td>${esc(x.date)}</td><td>${ip(x.total_units)}</td><td>${num(x.net_added_units,2)}</td><td>${x.current_ratio===null?'—':(x.current_ratio*100).toFixed(1)+'%'}</td></tr>`).join('')||'<tr><td colspan="4">尚无完整观察记录</td></tr>';
 const g=$('inventoryGauge'),stage=$('inventoryStage');
 if(!ok){g.innerHTML='';stage.textContent='';return;}
 const s=(I.series||[]).filter(x=>x.complete!==false&&Number.isFinite(x.total_units));
 const d5=s.length>5?r.total_units-s[s.length-6].total_units:null;
 const d20=s.length>20?r.total_units-s[s.length-21].total_units:null;
 const peak=s.length?Math.max(...s.map(x=>x.total_units)):r.total_units;
 let label='低位徘徊';
 if(d20!==null&&d20>=.3&&d5!==null&&Math.abs(d5)<=.05)label='高位平台';
 else if(d20!==null&&d20>=.3&&d5!==null&&d5>.05)label='继续回补';
 else if(d5!==null&&d5<-.05)label='回吐中';
 else if(d20!==null&&d20<-.3)label='减仓中';
 const startPct=Math.max(0,Math.min(100,(I.cycle_start_units||0)/I.baseline_units*100));
 const curPct=Math.max(0,Math.min(100,(r.current_ratio||0)*100));
 g.innerHTML=`<div class="gauge-track" role="img" aria-label="当前 ${ip(r.total_units)} 份，起点 ${ip(I.cycle_start_units)} 份，基准 ${I.baseline_units} 份"><div class="gauge-fill" style="width:${curPct}%"></div><span class="gauge-start" style="left:${startPct}%"></span><span class="gauge-now" style="left:${curPct}%"></span></div><div class="gauge-labels"><span>0</span><span class="gauge-origin" style="left:${startPct}%">起点</span><span>${I.baseline_units} 份参照</span></div>`;
 stage.innerHTML=`阶段：<b>${esc(label)}</b> · 近20日 ${num(d20,2)} 份，近5日 ${num(d5,2)} 份${peak-r.total_units>.01?`，距本轮峰值 -${(peak-r.total_units).toFixed(2)} 份`:'，基本处于本轮峰值'}。`;
}
renderInventory();
const core=D.pools.core15.latest,ev=D.pools.core15.evaluation;
const O=D.exchange,of=O.latest;
function renderFocus(){
 const complete=!!(of&&of.complete&&Number.isFinite(of.net_estimate)&&of.valid_members===of.expected_members);
 const state=O.tracking?.latest?.risk.state;
 $('focusStage').textContent=complete?`交易所正式份额${state?` · ${state}`:''}`:'交易所份额';
 if(!complete){
  $('focusDirection').textContent='正式份额未齐全';
  $('focusAmount').textContent='';
  $('focusSubline').textContent=`覆盖 ${of?.valid_members??0}/${of?.expected_members??15}，暂不展示合计。`;
  $('focusRows').innerHTML='<tr><td colspan="6">已取得的逐只数据见「全部 15 只」。</td></tr>';
  $('focusMobile').innerHTML='<div class="empty">已取得的逐只数据见「全部 15 只」。</div>';
  $('interpretation').hidden=true;
  return;
 }
 const items=Object.values(O.instruments||{}).filter(x=>x&&x.latest&&Number.isFinite(x.latest.net_estimate));
 const rows=items.map(x=>{
  const ser=Array.isArray(x.series)?x.series:[];
  const idx=ser.findIndex(y=>y.date===x.latest.date);
  const prev=idx>0&&Number.isFinite(ser[idx-1]?.net_estimate)?ser[idx-1].net_estimate:null;
  const sign=Math.sign(x.latest.net_estimate);
  let streak=0;
  for(let i=ser.length-1;i>=0;i--){const v=ser[i].net_estimate;if(!Number.isFinite(v)||sign===0||Math.sign(v)!==sign)break;streak++;}
  return {x,net:x.latest.net_estimate,prev,w5:(x.w5&&x.w5.complete)?x.w5.net_estimate:null,
   pct:Number.isFinite(x.latest.share_change_pct)?x.latest.share_change_pct:null,streak};
 }).sort((a,b)=>b.net-a.net);
 const buys=rows.filter(r=>r.net>0).slice(0,3);
 const sells=rows.filter(r=>r.net<0).slice(-3).reverse();
 const show=[...buys,...sells];
 const fmtPct=v=>v===null||v===undefined?'—':(v>0?'+':'')+v.toFixed(2)+'%';
 const streakText=(n,sign)=>n>=2?(sign>0?`连续${n}日净申购`:`连续${n}日净赎回`):'—';
 const rowHtml=r=>`<tr><td class="name"><b>${esc(r.x.name)}</b><small>${r.x.code} · ${esc(r.x.family)}</small></td><td>${val(r.net)}</td><td>${val(r.prev)}</td><td>${val(r.w5)}</td><td>${fmtPct(r.pct)}</td><td>${streakText(r.streak,Math.sign(r.net))}</td></tr>`;
 $('focusRows').innerHTML=show.map(rowHtml).join('')||'<tr><td colspan="6">尚无可用正式份额</td></tr>';
 $('focusMobile').innerHTML=show.map(r=>`<div class="cardrow"><b>${esc(r.x.name)}</b><small>${r.x.code} · ${esc(r.x.family)}</small><div class="cardmetrics"><span><small>今日净申赎</small>${val(r.net)}</span><span><small>前日</small>${val(r.prev)}</span><span><small>5日累计</small>${val(r.w5)}</span><span><small>份额变化</small>${fmtPct(r.pct)}</span></div><small>${streakText(r.streak,Math.sign(r.net))}</small></div>`).join('')||'<div class="empty">尚无可用正式份额</div>';
 const dir=of.net_estimate>0?'净申购':of.net_estimate<0?'净赎回':'基本持平';
 $('focusDirection').textContent=`ETF 通道${dir}`;
 $('focusAmount').textContent=of.net_estimate===0?'':`${num(Math.abs(of.net_estimate)).slice(1)} 亿`;
 $('focusSubline').textContent=`${of.expected_members}只中 ${of.inflow_count}只增加、${of.outflow_count}只减少${O.w5?.complete?` · 近5日 ${num(O.w5.net_estimate)} 亿`:''} · 买卖主体未确认（I0）`;
 const fams=Object.entries(O.families||{}).map(([name,f])=>{
  const net=Number.isFinite(f?.latest?.net)?f.latest.net:null;
  const members=f?.members||[];
  const pos=members.filter(c=>Number.isFinite(O.instruments?.[c]?.latest?.net_estimate)&&O.instruments[c].latest.net_estimate>0).length;
  const neg=members.filter(c=>Number.isFinite(O.instruments?.[c]?.latest?.net_estimate)&&O.instruments[c].latest.net_estimate<0).length;
  return {name,net,members:members.length,pos,neg};
 }).filter(x=>x.net!==null);
 const posF=fams.filter(x=>x.net>0).sort((a,b)=>b.net-a.net);
 const negF=fams.filter(x=>x.net<0).sort((a,b)=>a.net-b.net);
 const buyText=posF.length?`主要净申购：${posF.slice(0,3).map(x=>`${x.name} ${num(x.net)}（${x.pos}/${x.members} 增加）`).join('、')}。`:'';
 const sellText=negF.length?`主要净赎回：${negF.slice(0,3).map(x=>`${x.name} ${num(x.net)}（${x.neg}/${x.members} 减少）`).join('、')}。`:'';
 const pace=O.w5?.complete?`此前 4 日合计：${num(O.w5.net_estimate-of.net_estimate)} 亿。`:'';
 const notes=[buyText,sellText,pace].filter(Boolean);
 $('interpretation').hidden=!notes.length;
 $('interpretationRows').innerHTML=notes.map(x=>`<li>${esc(x)}</li>`).join('');
}
renderFocus();
$('officialScope').textContent=`业务日 ${D.end}；资料状态：${O.stage}。正式份额与不复权价格配对覆盖 ${of.valid_members}/15。上交所口径为当日清算后份额；深交所按业务日记账，T日晚间初值以T+1早间更新为准。两日均取自同一交易所披露序列，份额披露精度为100份。`;
const ors=Object.values(O.instruments).sort((a,b)=>(a.latest?.net_estimate??Infinity)-(b.latest?.net_estimate??Infinity));
const shares=x=>x===null||x===undefined?'—':(x/1e8).toLocaleString('zh-CN',{minimumFractionDigits:4,maximumFractionDigits:4});
$('officialRows').innerHTML=ors.map(x=>{let r=x.latest;return `<tr><td class="name"><b>${esc(x.name)}</b><small>${x.code} · ${esc(x.family)}</small></td><td>${shares(r?.previous_shares)}</td><td>${shares(r?.shares)}</td><td>${r?.share_change===null||!r?'—':num(r.share_change/1e8,4)}</td><td>${r?.share_change_pct===null||!r?'—':num(r.share_change_pct,2)+'%'}</td><td>${val(r?.net_estimate)}</td><td>${val(x.w5.net_estimate)}</td><td><span class="pill risk">${esc(x.tracking?.latest?.risk.state??'数据不足')}</span><small>已观察${x.tracking?.observed_sessions??0}日${x.tracking?.peak_window_complete?'':'；回撤窗口未满63日'}</small></td><td><a href="${esc(x.url||x.source_page||'#')}">${x.source==='sse'?'上交所':x.source==='szse'?'深交所':'待获取'}</a><small>${esc(x.fetched_at||x.error||'尚无记录')}${x.source==='szse'?(x.next_morning_collected?' · 次日早间后采集':' · 当晚初值仍待复核'):''}</small></td></tr>`}).join('');
$('officialMobile').innerHTML=ors.map(x=>{let r=x.latest;return `<div class="cardrow"><b>${esc(x.name)}</b><small>${x.code} · ${esc(x.family)}</small><span class="pill risk">${esc(x.tracking?.latest?.risk.state??'数据不足')}</span><div class="cardmetrics"><span><small>份额变化 / 亿份</small>${r?.share_change===null||!r?'—':num(r.share_change/1e8,4)}</span><span><small>敞口估算 / 亿元</small>${val(r?.net_estimate)}</span><span><small>5日 / 亿元</small>${val(x.w5.net_estimate)}</span><span><small>份额变化比例</small>${r?.share_change_pct===null||!r?'—':num(r.share_change_pct,2)+'%'}</span></div><small>已观察${x.tracking?.observed_sessions??0}日 · ${esc(x.fetched_at??'待获取')}</small></div>`}).join('');
$('officialFamilies').innerHTML=Object.entries(O.families??{}).sort((a,b)=>(a[1].latest?.w5.net??Infinity)-(b[1].latest?.w5.net??Infinity)).map(([name,x])=>{const r=x.latest;return `<tr><td>${esc(name)}<small>核心${x.members.length}只</small></td><td>${val(r?.net)}</td><td>${val(r?.w5.complete?r.w5.net:null)}</td><td>${val(r?.w10.complete?r.w10.net:null)}</td><td>${val(r?.w20.complete?r.w20.net:null)}</td><td>${esc(r?.risk.state??'数据不足')}</td></tr>`}).join('');
$('officialDays').innerHTML=O.series.filter(x=>x.complete).slice(-10).reverse().map(x=>`<tr><td>${x.date}</td><td>${val(x.net_estimate)}</td><td>${x.outflow_count} / ${x.inflow_count}</td><td>${x.valid_members}/15</td></tr>`).join('')||'<tr><td colspan="4">连续正式份额尚不完整</td></tr>';
let chart=D.pools.core15.series;
function drawChart(){const max=Math.max(1,...chart.map(x=>Math.abs(x.net??0))),W=Math.max(280,$('chart').clientWidth||720),H=200,mid=94,step=(W-70)/chart.length;
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
window.GJD={buildId:D.build_id,end:D.end,coreNet:core.net,officialNet:of.net_estimate,coreCount:D.pools.core15.members.length,inventoryUnits:I?.complete?I.latest.total_units:null,inventoryNetUnits:I?.complete?I.latest.net_added_units:null};
/* 三阶段版本条：盘中 / 盘后 / 次日。三者各自成版，后一版替代前一版。 */
window.StageCards=(function(){
  const st={intraday:null,postclose:null};
  const $=id=>document.getElementById(id);
  function card(o){return `<a class="stage-card${o.active?' is-active':''}" href="${o.href}">`+
    `<div class="stage-head"><span class="stage-name">${esc(o.name)}</span><span class="stage-badge ${o.tone}">${esc(o.badge)}</span></div>`+
    `<div class="stage-date">${esc(o.date||'待更新')}</div>`+
    `${o.desc?`<div class="stage-desc">${esc(o.desc)}</div>`:''}</a>`;}
  function draw(){
    const el=$('stageCards');if(!el)return;
    const live=st.intraday,pc=st.postclose;
    const active=live?.fresh?'intraday':pc?.pending_review&&pc.business_date>D.end?'postclose':'verified';
    el.innerHTML=[
      card({name:'盘中',href:'#intraday',badge:'线索级',tone:'tone-live',date:live?.date,
        desc:live?.status||'等待实时行情',active:active==='intraday'}),
      card({name:'盘后',href:'#postclose',badge:pc?(pc.pending_review?'初值级':'已被替代'):'待生成',tone:'tone-provisional',
        date:pc?.business_date,
        desc:pc&&Number.isFinite(pc.vendor?.net_yi)?`反推净申赎 ${num(pc.vendor.net_yi)} 亿`:pc?'反推净额未齐':'',
        active:active==='postclose'}),
      card({name:'次日',href:'#official',badge:of.complete?'定稿级':'待复核',tone:'tone-verified',
        date:D.end,desc:of.complete?'交易所正式份额':'正式份额未齐',active:active==='verified'}),
    ].join('');
  }
  draw();
  return {set(k,v){
    const prev=st[k];
    if(prev===v||k==='intraday'&&prev?.date===v.date&&prev?.status===v.status)return;
    st[k]=v;draw();
  }};
})();
/* 盘后初值：三阶段里的第二版。份额由供应商换手率反推，收盘后可能被修订。 */
(function(){
  const f=u=>fetch(u,{cache:'no-store'}).then(r=>r.ok?r.json():null).catch(()=>null);
  function legacy(){
    $('postcloseScope').textContent='暂无可用盘后初值。';
    $('postcloseBody').innerHTML='<p class="note"><a href="#official">查看交易所正式份额</a></p>';
  }
  function table(rows){return '<div class="scroll"><table><thead><tr><th>项目</th><th>值</th></tr></thead><tbody>'+
      rows.map(([label,value])=>`<tr><td>${esc(label)}</td><td>${esc(value)}</td></tr>`).join('')+'</tbody></table></div>';}
  function render(x){
    const o=x.official||{},v=x.vendor||{},iv=x.inventory||{},fl=x.flattened||{};
    $('postcloseScope').textContent=`业务日 ${x.business_date} · ${x.pending_review?'待次日复核':'已由正式版替代'} · 反推结果不可作定稿`;
    const rows=[
      ['反推净申赎',Number.isFinite(v.net_yi)?num(v.net_yi)+' 亿元':'数据不足'],
      ['核心 15 只成交额',Number.isFinite(v.amount_yi)?num(v.amount_yi).replace(/^\+/,'')+' 亿元':'—'],
      ['10 份刻度',Number.isFinite(iv.total_units)?ip(iv.total_units)+' 份':'数据不足'],
      ['本轮净新增',Number.isFinite(iv.net_added_units)?num(iv.net_added_units,2)+' 份':'数据不足'],
      ['官方份额覆盖',(o.coverage??0)+'/'+(o.expected??15)],
    ];
    const diagnostics=[
      ['生成时间',x.generated_at||'—'],
      ['份额比值中位数',Number.isFinite(fl.ratio_median)?fl.ratio_median.toFixed(6):'—'],
      ['份额疑似抹平',Number.isFinite(fl.count)?`严格 ${fl.count} 只；宽口径 ${fl.near_count??'—'} 只`:'—'],
    ];
    $('postcloseBody').innerHTML=table(rows)+`<details><summary>数据核对</summary>${table(diagnostics)}
      <p class="note">${esc(x.revision_risk||'等待交易所次日复核。')}</p>
      ${x.superseded_by?`<p class="note">复核构建 ${esc(x.superseded_by)}</p>`:''}</details>`;
    if(window.StageCards)window.StageCards.set('postclose',x);
  }
  if(typeof fetch!=='function'){legacy();return;}
  f('/tools/national-team-etf/data/postclose/latest.json').then(x=>{
    if(x&&x.business_date){render(x);return;}
    f('/tools/national-team-etf/data/intraday/postclose.json').then(y=>{
      if(y&&y.business_date){
        render({business_date:y.business_date,generated_at:y.generated_at,pending_review:y.pending_review,
          official:{coverage:y.coverage,expected:y.expected},revision_risk:y.note||''});
      }else legacy();
    });
  });
})();
/* 当日盘中观察区：浏览器 JSONP 实时行情 + 低频采集器快照 */
(function(){
  const IDXMAP=__INDEX__,CORE=D.pools.core15.members.slice();
  const IDXSYM=[...new Set(Object.values(IDXMAP))];
  const symOf=c=>(/^[56789]/.test(c)?'sh':'sz')+c;
  const nameOf=c=>(D.instruments[c]&&D.instruments[c].name)||c;
  const famOf=c=>(D.instruments[c]&&D.instruments[c].family)||'行业主题/待核验';
  const $=id=>document.getElementById(id);
  // 精简 DOM / 无网络环境（含独立验收的 Node VM）不启动实时通道，保留静态结果。
  if(typeof fetch!=='function'||typeof setInterval!=='function'||
     typeof document.createElement!=='function'||!document.head){
    $('intradayStage').textContent='实时通道未启用';
    $('intradayRows').innerHTML='<tr><td colspan="7">当前环境无法加载实时行情。</td></tr>';
    $('intradayEvents').textContent='当前环境无法读取云端留档。';
    return;
  }
  function parseVar(sym){
    const v=window['v_'+sym];if(typeof v!=='string')return null;
    const f=v.split('~');if(f.length<40)return null;
    const g=i=>{const x=parseFloat(f[i]);return isFinite(x)?x:null;};
    return {price:g(3),pct:g(32),premium:f.length>77?g(77):null,qt:f[30]||''};
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
  function render(liveOK){
    const now=new Date();
    const idxPct={};Object.entries(IDXMAP).forEach(([fam,sym])=>{const r=parseVar(sym);if(r)idxPct[fam]=r.pct;});
    const rows=CORE.map(c=>{
      const r=parseVar(symOf(c));if(!r)return null;
      const fam=famOf(c),ip=(idxPct[fam]===undefined?null:idxPct[fam]);
      return {code:c,name:nameOf(c),family:fam,price:r.price,pct:r.pct,
        relative:(r.pct!==null&&ip!==null)?r.pct-ip:null,premium:r.premium,qt:r.qt};
    }).filter(Boolean);
    const keyTime=rows.length?rows.map(r=>r.qt).sort().pop():'';
    const q=keyTime.length>=14?new Date(+keyTime.slice(0,4),+keyTime.slice(4,6)-1,+keyTime.slice(6,8),
      +keyTime.slice(8,10),+keyTime.slice(10,12),+keyTime.slice(12,14)):null;
    const lag=q?Math.round((now-q)/1000):null;
    const stale=(!q||lag>180||q.toDateString()!==now.toDateString());
    const support=rows.filter(r=>r.relative!==null&&r.relative>0.15).length;
    const retreat=rows.filter(r=>r.relative!==null&&r.relative<-0.15).length;
    const breadth=rows.length?Math.max(support,retreat)/rows.length:0;
    const leader=support>retreat*2?'承接线索':retreat>support*2?'撤退线索':'方向待确认';
    const status=!liveOK?'行情请求失败':!rows.length?'暂无行情':stale?'行情过期 / 非交易时段':'盘中实时';
    $('intradayStage').textContent=status;
    window.StageCards.set('intraday',{date:q?qtDate(keyTime).slice(0,10):null,status,fresh:liveOK&&!stale});
    $('intradayStatus').innerHTML=
      (q?pill('行情时间 '+qtDate(keyTime))+pill('延迟 '+lag+' 秒',lag>180):'')+
      pill('覆盖 '+rows.length+'/'+CORE.length,rows.length<CORE.length);
    $('intradayKpis').innerHTML=[
      ['观察方向',rows.length?leader:'—'],
      ['同步广度',rows.length?(breadth*100).toFixed(0)+'%':'—'],
    ].map(([a,b])=>`<div class="kpi"><div class="label">${esc(a)}</div><div class="value" style="font-size:20px">${esc(b)}</div></div>`).join('');
    $('intradayRows').innerHTML=rows.map(r=>{
      const ch=[];if(r.relative!==null&&Math.abs(r.relative)>=0.15)ch.push(r.relative>0?'相对指数偏强':'相对指数偏弱');
      if(r.premium!==null&&Math.abs(r.premium)>=0.25)ch.push('折溢价偏离');
      const ce=(r.relative!==null&&r.relative>0&&r.premium!==null&&r.premium<0)?'价格偏强但折价':'';
      return `<tr><td class="name"><b>${esc(r.name)}</b><small>${r.code} · ${esc(r.family)}</small></td>`+
        `<td>${r.price===null?'—':r.price.toFixed(3)}</td><td>${num(r.pct,2)}</td>`+
        `<td>${num(r.relative,2)}</td><td>${num(r.premium,2)}</td>`+
        `<td>${esc(ch.join('、')||'无')}</td><td>${esc(ce||'—')}</td></tr>`;
    }).join('')||'<tr><td colspan="7">暂无可用行情。</td></tr>';
  }
  fetch('/tools/national-team-etf/data/intraday/latest.json',{cache:'no-store'})
    .then(r=>r.ok?r.json():null).catch(()=>null).then(snapshot=>{
      $('intradayEvents').textContent=snapshot
        ? `留档 ${snapshot.generated_at||'—'} · 等级 ${snapshot.level||'—'} · 进行中事件 ${snapshot.event_summary?.active??0} 个 · 本次提醒 ${snapshot.alerts?.length??0} 条`
        : '暂无云端留档。';
    });
  async function loop(){render(await fetchLive());}
  loop();setInterval(loop,60000);
})();
/* 阅读体验增强：吸顶导航滚动高亮 + 回到顶部。
   Node VM 精简 DOM 没有 querySelectorAll / IntersectionObserver，直接跳过，
   不影响数据渲染与静态降级路径（经验 E28）。 */
(function(){
  if(typeof document.querySelectorAll!=='function'||typeof window==='undefined'||
     typeof window.IntersectionObserver==='undefined'||
     typeof window.addEventListener!=='function')return;
  var links=Array.prototype.slice.call(document.querySelectorAll('nav a[href^="#"]'));
  var ids=[];
  links.forEach(function(a){
    if(!a.classList||!a.getAttribute)return;
    var id=a.getAttribute('href').slice(1);
    if(id&&document.getElementById(id))ids.push(id);
  });
  if(!ids.length)return;
  try{
    var io=new window.IntersectionObserver(function(entries){
      entries.forEach(function(en){
        if(!en.isIntersecting)return;
        links.forEach(function(a){
          a.classList.toggle('is-active',a.getAttribute('href')==='#'+en.target.id);
        });
      });
    },{rootMargin:'-90px 0px -68% 0px',threshold:0});
    ids.forEach(function(id){io.observe(document.getElementById(id))});
  }catch(e){return}
  var back=document.getElementById('backTop');
  if(back&&back.classList&&typeof window.scrollTo==='function'){
    var onScroll=function(){
      var y=window.scrollY||document.documentElement.scrollTop||0;
      back.classList.toggle('is-visible',y>600);
    };
    window.addEventListener('scroll',onScroll,{passive:true});
    back.addEventListener('click',function(){window.scrollTo({top:0,behavior:'smooth'})});
    onScroll();
  }
})();
/* 深链进入折叠区时自动展开对应 details；VM 精简 DOM 无 location，直接跳过。 */
(function(){
  if(typeof document==='undefined'||typeof location==='undefined'||typeof window==='undefined')return;
  function openHash(){
    var h=location.hash.slice(1);if(!h)return;
    var el=document.getElementById(h);if(!el||!el.querySelector)return;
    var d=el.querySelector('details');if(d&&!d.open)d.open=true;
  }
  if(typeof window.addEventListener==='function')window.addEventListener('hashchange',openHash);
  openHash();
})();
</script></body></html>'''

SEGMENTS_CSS=r'''<style>
.seg-legend{display:flex;gap:14px;flex-wrap:wrap;color:var(--muted);font-size:12px;margin:8px 0 0}
.seg-swatch{display:inline-block;width:12px;height:12px;border-radius:3px;background:var(--accent);vertical-align:-1px;margin-right:5px}
.seg-ref{stroke:var(--faint);stroke-dasharray:5 4;stroke-width:1}
.seg-lunch{stroke:var(--line-strong);stroke-dasharray:3 4}
.seg-axis{fill:var(--muted);font-size:11px}
.seg-bar{fill:var(--accent)}
.seg-bar.weak{fill:var(--line-strong)}
</style>'''

SEGMENTS_BODY=r'''<main><div class="eyebrow">盘中线索的补充视角 · 与当日追踪共用构建 __BUILD__</div>
<h1>15 分钟分段活跃度</h1>
<p class="lead">把最近一个交易日的成交额拆成 16 个已收齐的 15 分钟整段，与近 20 个交易日同段中位数对比。它回答「这一段有多活跃」，不回答「谁在买」。</p>
<div class="notice">成交活跃度 ≠ 份额变化 ≠ 国家队买入。二级市场换手可能不改变总份额；买卖身份默认 I0，未确认。分段缺失不补 0。</div>
<div class="statusline" id="segStatus"><span class="pill">加载中</span></div>
<div class="tools"><button id="segRefresh" type="button">重新抓取</button><span class="note" id="segUpdated"></span><a href="/gjd/#intraday">返回当日追踪</a></div>
<div class="kpis" id="segKpis"></div>
<section><h2>分段成交额 · 与同段中位数对比</h2>
<p class="note" id="segScope"></p>
<div id="segChart" aria-live="polite"></div>
<div class="seg-legend"><span><span class="seg-swatch"></span>当日已收整段成交额 ÷ 同段中位</span><span>虚线 = 1.0 倍（与中位持平）</span><span>上午 8 段 · 午后 8 段</span></div>
<p class="lead" id="segTotals"></p>
<p class="note">柱高为倍数，悬浮可看金额；金额均为亿元。缺段、缺基线或当日 5 分钟 K 未取到时留空，不补 0。</p></section>
<section><h2>分 ETF 最新已收段</h2>
<p class="note">只列已收齐的整段；「覆盖段数」是该 ETF 当日可比的整段数。按最新段倍数降序，— 表示缺数据。</p>
<div class="scroll"><table><thead><tr><th>ETF / 家族</th><th>最新已收段</th><th>本段 / 亿元</th><th>同段中位 / 亿元</th><th>倍数</th><th>覆盖段数</th><th>说明</th></tr></thead><tbody id="segRows"><tr><td colspan="7">加载中</td></tr></tbody></table></div></section>
<section><h2>口径与边界</h2>
<p>数据源：新浪 5 分钟 K（单源），与基线同一序列；不与其他供应商或分时快照拼接。基线取近 20 个交易日的完整日、同段中位数；只有 16 段齐全的交易日进入样本，样本不足 5 日视为冷启动，不做升级判断。</p>
<p>15:00 段包含收盘集合竞价（14:57–15:00），大额收盘成交会把该段倍数显著抬高；它不是连续竞价时段的可比活跃度，也不能据此判断买卖主体。</p>
<p>页面在浏览器端额外抓取当日 5 分钟 K。若当日日期未晚于基线日，则退回展示基线样本最后一日，并明确标注「样本内回看」，不用于前视判断。基线由本机盘后任务刷新，随下一次正式发布同步到线上。</p>
<p>本页不输出国家队概率、盘中买入金额或份额结论；份额与净申赎请看 <a href="/gjd/#official">正式份额</a> 与 <a href="/gjd/#postclose">盘后初值</a>。</p>
<p class="note">构建 <span class="mono">__BUILD__</span> · 业务日 __END__ · 页面脚本直接读取供应商 JSONP，不产生 Git 提交</p></section>
<a href="/gjd/">返回当日追踪</a></main>'''

SEGMENTS_JS=r'''(function(){
  const metaEl=document.getElementById('segmeta');
  if(!metaEl)return;
  const META=JSON.parse(metaEl.textContent);
  const $=id=>document.getElementById(id);
  const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const pill=(text,warn=false)=>`<span class="pill${warn?' risk':''}">${esc(text)}</span>`;
  const fix2=x=>x===null||x===undefined?'—':Number(x).toFixed(2);
  const yi=x=>x===null||x===undefined?'—':Number(x).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2});
  const hm=m=>String(Math.floor(m/60)).padStart(2,'0')+':'+String(m%60).padStart(2,'0');
  const SLOTS=(()=>{const out=[];[[570,690],[780,900]].forEach(([a,b])=>{for(let m=a+15;m<=b;m+=15)out.push({slot:hm(m),morning:m<=690,ends:[m-10,m-5,m].map(hm)});});return out;})();
  const symOf=c=>(/^[56789]/.test(c)?'sh':'sz')+c;
  const bjNow=()=>{const d=new Date();return new Date(d.getTime()+(d.getTimezoneOffset()+480)*60000);};
  const ID='I0 当日买卖主体未确认';
  let B=null;const bars={};const st={mode:'sample',day:'',errors:[],at:null};

  function parseBars(rows){
    const now=bjNow(),out=[];
    (rows||[]).forEach(r=>{
      const m=/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec((r&&r.day)||'');
      const a=Number(r&&r.amount);
      if(!m||!isFinite(a)||a<0)return;
      const t=new Date(+m[1],+m[2]-1,+m[3],+m[4],+m[5],0,0);
      if(t>new Date(now.getTime()-20000))return;
      out.push({day:m[1]+'-'+m[2]+'-'+m[3],hm:m[4]+':'+m[5],amount:a/1e8});
    });
    return out;
  }
  function codeSeg(c){
    const rows=bars[c];if(!rows||!rows.length)return null;
    let day='';rows.forEach(r=>{if(r.day>day)day=r.day;});
    const map={};rows.forEach(r=>{if(r.day===day)map[r.hm]=r.amount;});
    const seg={};
    SLOTS.forEach(s=>{let ok=true,sum=0;s.ends.forEach(h=>{const v=map[h];if(typeof v!=='number')ok=false;else sum+=v;});if(ok)seg[s.slot]=sum;});
    return {day,seg};
  }
  function jsonpOne(code){
    return new Promise(resolve=>{
      const name='gjdseg_'+code+'_'+Date.now()+'_'+Math.random().toString(36).slice(2,6);
      const s=document.createElement('script');
      s.charset='utf-8';
      s.src='https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20'+name+'=/CN_MarketDataService.getKLineData?symbol='+symOf(code)+'&scale=5&ma=no&datalen=48&_='+Date.now();
      let done=false;
      const finish=ok=>{
        if(done)return;done=true;
        try{s.remove();}catch(e){}
        const v=window[name];
        try{delete window[name];}catch(e){}
        resolve(ok&&Array.isArray(v)?v:null);
      };
      s.onload=()=>finish(true);s.onerror=()=>finish(false);
      if(!document.head||typeof document.head.appendChild!=='function'){finish(false);return;}
      document.head.appendChild(s);
      setTimeout(()=>finish(false),9000);
    });
  }
  function sumOf(list){
    const v=list.reduce((o,r)=>{if(r.ratio===null||r.ratio===undefined)return o;o.a+=r.amount;o.m+=r.median;o.n++;return o;},{a:0,m:0,n:0});
    return {amount:v.n?v.a:null,median:v.n?v.m:null,n:v.n,ratio:(v.n&&v.m>0)?v.a/v.m:null};
  }
  function computeMode(){
    let latest='';
    META.members.forEach(m=>{const x=codeSeg(m.code);if(x&&x.day>latest)latest=x.day;});
    const asOf=(B&&B.as_of_date)||'';
    st.mode=(latest&&asOf&&latest>asOf)?'live':'sample';
    st.day=st.mode==='live'?latest:(asOf||latest||'');
  }
  function summarize(){
    const rows=SLOTS.map(s=>({slot:s.slot,morning:s.morning,amount:null,median:null,n:0,ratio:null}));
    let used=0;
    META.members.forEach(m=>{
      const b=((B&&B.per_code)||{})[m.code];if(!b)return;
      const live=st.mode==='live'?codeSeg(m.code):null;
      let any=false;
      SLOTS.forEach((s,i)=>{
        const slotStats=(b.slots||{})[s.slot];
        if(!slotStats||slotStats.median===null||slotStats.median===undefined||!(slotStats.median>0))return;
        let a=null;
        if(st.mode==='live')a=(live&&live.day===st.day&&live.seg[s.slot]!==undefined)?live.seg[s.slot]:null;
        else a=(slotStats.prev===null||slotStats.prev===undefined)?null:slotStats.prev;
        if(a===null)return;
        rows[i].amount=(rows[i].amount??0)+a;
        rows[i].median=(rows[i].median??0)+slotStats.median;
        rows[i].n++;any=true;
      });
      if(any)used++;
    });
    rows.forEach(r=>{if(r.n&&r.median>0)r.ratio=r.amount/r.median;});
    return {rows,used};
  }
  function drawChart(rows){
    const el=$('segChart');if(!el)return;
    const W=Math.max(320,el.clientWidth||760),H=250,padL=46,padR=12,padT=20,padB=34;
    const plotW=W-padL-padR,plotH=H-padT-padB,base=padT+plotH;
    const values=rows.map(r=>r.ratio).filter(v=>v!==null&&v!==undefined);
    const max=Math.max(1.2,...values)*1.08;
    const bw=plotW/SLOTS.length;
    let svg=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="16个15分钟整段的成交额相对同段中位倍数">`;
    svg+=`<line x1="${padL}" x2="${W-padR}" y1="${base}" y2="${base}" stroke="var(--line)"/>`;
    const ref=base-plotH/max;
    svg+=`<line class="seg-ref" x1="${padL}" x2="${W-padR}" y1="${ref}" y2="${ref}"/>`;
    svg+=`<text class="seg-axis" x="${padL-6}" y="${ref+4}" text-anchor="end">1.0×</text>`;
    svg+=`<text class="seg-axis" x="${padL-6}" y="${padT+10}" text-anchor="end">${max.toFixed(1)}×</text>`;
    rows.forEach((r,i)=>{
      const x=padL+i*bw+bw*0.16;
      if(r.ratio===null||r.ratio===undefined){svg+=`<text class="seg-axis" x="${x+bw*0.34}" y="${base-6}" text-anchor="middle">—</text>`;return;}
      const h=Math.min(plotH,r.ratio/max*plotH);
      svg+=`<rect class="${r.ratio<1?'seg-bar weak':'seg-bar'}" x="${x}" y="${base-h}" width="${bw*0.68}" height="${Math.max(1,h)}" rx="2"><title>${r.slot} 合计 ${yi(r.amount)} 亿 / 同段中位 ${yi(r.median)} 亿 = ${fix2(r.ratio)}× · 覆盖 ${r.n} 只</title></rect>`;
      if(W>=680)svg+=`<text class="seg-axis" x="${x+bw*0.34}" y="${base+12}" text-anchor="middle">${fix2(r.ratio)}</text>`;
    });
    ['09:45','10:30','11:30','13:45','14:30','15:00'].forEach(lbl=>{
      const idx=SLOTS.findIndex(s=>s.slot===lbl);if(idx<0)return;
      svg+=`<text class="seg-axis" x="${padL+idx*bw+bw*0.34}" y="${H-4}" text-anchor="middle">${lbl}</text>`;
    });
    const mid=SLOTS.length/2;
    svg+=`<line class="seg-lunch" x1="${padL+mid*bw}" x2="${padL+mid*bw}" y1="${padT}" y2="${base}"/>`;
    svg+='</svg>';
    el.innerHTML=svg;
  }
  function chrome(summary){
    const b=B||{},live=st.mode==='live';
    const covered=summary.rows.filter(r=>r.ratio!==null).length;
    const am=sumOf(summary.rows.filter(r=>r.morning)),pm=sumOf(summary.rows.filter(r=>!r.morning)),day=sumOf(summary.rows);
    const latest=[...summary.rows].reverse().find(r=>r.ratio!==null&&r.ratio!==undefined);
    $('segStatus').innerHTML=[
      pill('业务日 '+(st.day||b.as_of_date||'—')),
      pill('基线 '+(b.as_of_date||'缺失')+' · 完整日 '+((b.complete_days||[]).length),!b.complete),
      pill(live?'模式：最近交易日':'模式：样本内回看',!live),
      pill('刷新 '+(st.at?st.at.toLocaleTimeString('zh-CN',{hour12:false}):'—')),
      pill('未取到 '+(st.errors.length||0)+' 只',st.errors.length>0),
      pill('身份：'+ID),
      pill('来源：新浪5分钟K')
    ].join('');
    $('segKpis').innerHTML=[
      ['最新已收段',latest?fix2(latest.ratio)+'×':'—',latest?latest.slot+' · 覆盖 '+latest.n+' 只':'尚无收齐的整段'],
      ['上午累计',am.ratio===null?'—':fix2(am.ratio)+'×',am.ratio===null?'缺段留空':yi(am.amount)+' / 中位 '+yi(am.median)+' 亿'],
      ['午后累计',pm.ratio===null?'—':fix2(pm.ratio)+'×',pm.ratio===null?'缺段留空':yi(pm.amount)+' / 中位 '+yi(pm.median)+' 亿'],
      ['已收整段',covered+'/16','覆盖 ETF '+summary.used+' 只；缺段不补0']
    ].map(([a,b,c])=>`<div class="kpi"><div class="label">${esc(a)}</div><div class="value" style="font-size:24px">${esc(b)}</div><div class="label">${esc(c)}</div></div>`).join('');
    $('segScope').textContent=live
      ? `最近交易日（${st.day}）为浏览器端抓取的新浪 5 分钟 K；基线截至 ${b.as_of_date}，早于该日，不构成前视比较。`
      : `没有晚于基线日（${b.as_of_date||'—'}）的完整分段，改为展示基线样本最后一日 ${st.day||'—'} 的分段；该日包含在中位数样本内，只作回看，不用于前视判断。`;
    if(!b.complete)$('segScope').textContent+=' 基线当前未通过完整性检查（勾稽或样本不足），以下倍数只作观察，不用于升级判断。';
    if(st.errors.length)$('segScope').textContent+=' 未取到当日 5 分钟 K 的代码已从合计中剔除，不补 0：'+st.errors.join('、')+'。';
    $('segTotals').textContent=day.ratio===null
      ? '当前没有可比的完整段：基线或当日 5 分钟 K 不足，缺口不补 0。'
      : `已收 ${day.n} 个整段合计 ${yi(day.amount)} 亿，同段中位合计 ${yi(day.median)} 亿，整体 ${fix2(day.ratio)}×；上午 ${am.ratio===null?'—':fix2(am.ratio)+'×'}，午后 ${pm.ratio===null?'—':fix2(pm.ratio)+'×'}。倍数只表示成交活跃度，不是净申购，也不是国家队买入金额。`;
    $('segUpdated').textContent=st.at?('本次抓取 '+st.at.toLocaleTimeString('zh-CN',{hour12:false})+' · 盘中每 5 分钟自动刷新'):'';
    const list=META.members.map(m=>{
      const b2=((B&&B.per_code)||{})[m.code];
      const liveSeg=st.mode==='live'?codeSeg(m.code):null;
      let last=null,count=0;
      SLOTS.forEach(s=>{
        const slotStats=b2&&b2.slots?b2.slots[s.slot]:null;
        if(!slotStats||!(slotStats.median>0))return;
        let a=null;
        if(st.mode==='live')a=(liveSeg&&liveSeg.day===st.day&&liveSeg.seg[s.slot]!==undefined)?liveSeg.seg[s.slot]:null;
        else a=(slotStats.prev===null||slotStats.prev===undefined)?null:slotStats.prev;
        if(a===null)return;
        count++;last={slot:s.slot,amount:a,median:slotStats.median,ratio:a/slotStats.median};
      });
      const notes=[];
      if(!b2)notes.push('无基线');
      if(st.mode==='live'&&(!liveSeg||liveSeg.day!==st.day))notes.push('当日5分钟K缺失');
      else if(st.mode==='live'&&Object.keys(liveSeg.seg).length<SLOTS.length)notes.push('部分整段未收齐，不补0');
      return {m,last,count,notes};
    });
    list.sort((x,y)=>(y.last?y.last.ratio:-1)-(x.last?x.last.ratio:-1));
    $('segRows').innerHTML=list.map(x=>`<tr><td class="name"><b>${esc(x.m.name)}</b><small>${esc(x.m.code)} · ${esc(x.m.family)}</small></td>`+
      `<td>${x.last?x.last.slot:'—'}</td><td>${x.last?yi(x.last.amount):'—'}</td><td>${x.last?yi(x.last.median):'—'}</td>`+
      `<td>${x.last?fix2(x.last.ratio)+'×':'—'}</td><td>${x.count}/16</td><td>${esc(x.notes.join('；')||'—')}</td></tr>`).join('')
      ||'<tr><td colspan="7">暂无可用分段</td></tr>';
    drawChart(summary.rows);
  }
  function renderMissing(){
    $('segStatus').innerHTML=[pill('基线缺失',true),pill('身份：'+ID),pill('来源：新浪5分钟K')].join('');
    $('segKpis').innerHTML='';
    $('segScope').textContent='尚未同步 15 分钟基线（data/intraday/baseline15.json）。基线由本机盘后任务生成，随下一次正式发布同步；缺口不补 0，也不代表没有交易。';
    $('segTotals').textContent='';
    $('segRows').innerHTML='<tr><td colspan="7">暂无可用基线，无法计算同段倍数</td></tr>';
    $('segChart').innerHTML='';
    $('segUpdated').textContent='';
  }
  function render(){computeMode();chrome(summarize());}
  function load(){
    st.at=new Date();st.errors=[];
    const p=(typeof fetch==='function')
      ?fetch('/tools/national-team-etf/data/intraday/baseline15.json',{cache:'no-store'}).then(r=>r.ok?r.json():null).catch(()=>null)
      :Promise.resolve(null);
    p.then(b=>{
      B=(b&&b.per_code&&Object.keys(b.per_code).length)?b:null;
      if(!B){renderMissing();return;}
      if(typeof document.createElement!=='function'||!document.head){chrome(summarize());return;}
      st.at=new Date();
      const codes=META.members.map(m=>m.code);
      Promise.all(codes.map(jsonpOne)).then(list=>{
        codes.forEach((c,i)=>{if(list[i])bars[c]=parseBars(list[i]);else st.errors.push(c);});
        render();
      });
    });
  }
  if(typeof window.addEventListener==='function')window.addEventListener('resize',()=>{if(B)drawChart(summarize().rows);});
  const btn=$('segRefresh');if(btn&&btn.addEventListener)btn.addEventListener('click',load);
  const t=bjNow(),mins=t.getHours()*60+t.getMinutes(),wd=t.getDay();
  if(typeof setInterval==='function'&&wd>=1&&wd<=5&&mins>=565&&mins<=910)setInterval(load,300000);
  load();
})();'''

