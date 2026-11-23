# 资金面盘面说明（/pulse）

每天收盘后自动生成的一份 A 股资金面复盘。页面重点是“钱”：主力/超大单、主动全单、ETF 申赎、融资余额，以及行业与个股的“新钱 / 回补 / 持续流入”。

## 线上

- 页面：https://1.688680.xyz/pulse
- 数据：`/tools/market-pulse/data/latest.json`，历史归档在 `data/archive/`
- 根站卡片：`assets/site-defaults.js` 的 `marketPulse`

## 自动更新

GitHub Actions：`.github/workflows/market-pulse-daily.yml`

- 工作日北京时间 **16:10** 主跑，**17:10** 补龙虎榜并二次更新
- 失败不会覆盖上一版；线上保留最近一次成功页面
- 白名单提交 `tools/market-pulse/index.html`、`tools/market-pulse/data/`，Vercel 自动部署
- 管线 9 步：东财沪市快照（可选）→ 腾讯指数/同花顺行业概念个股/涨停/两融 → 同花顺收盘重抓 → 新浪超大单 → 同花顺 5/10 日 → 深交所两融序列 → 龙虎榜机构 → 结构化数据 → 页面渲染

## 页面内容

- 总览：数据驱动标题/导语、三张结论卡、8 个指数深 V 条、资金四口径、**ETF 5 日拆解（大盘宽基 vs 中小盘）**、杠杆/主动/ETF 三方对照、四信号、涨停梯队、融资余额曲线
- 行业与主题：今日/5 日/10 日切换、**新钱/回补比例图**、散点、主题 Top 12、关键行业表（含质量/回补比例）
- 主线与个股：超大单 vs 全单、全单 Top 12（含质量列）、**个股资金质量表（新钱/强回补/持续流入三档切换）**、涨停分歧、龙虎榜机构席位、资金流出 Top 12
- 工具与方法：数据源矩阵、管线、口径与局限

## 本地跑

```powershell
cd D:\work_code2\market_pulse
python scripts\run_daily.py 2026-11-23
```

或只重算/重渲染：

```powershell
python scripts\build_analysis.py 2026-11-23
python scripts\render_page.py 2026-11-23
```

线上产物：

```powershell
$env:MP_ONLINE="1"
$env:MP_OUT_DIR="D:\code_all\tools\market-pulse"
python scripts\render_page.py 2026-11-23
```

## 数据与口径

- 腾讯行情：指数、成交额
- 东财 push2：沪市主力/超大单（可选；收盘后常被限流，失败则留空，不用 0 替代）
- 同花顺：行业/概念/个股主动买卖全单，今日 + 5 日 + 10 日
- 新浪 MoneyFlow：全 A 超大单/小单
- 东财 datacenter：涨停池、龙虎榜、两融
- 国家队 ETF：15 只宽基 ETF 申赎估算，来自 `tools/national-team-etf/data/official_flow.csv`
- “回补比例” = 今日净额 / |前 4 日净额|；前 4 日 = 滚动 5 日 - 今日。>100% 新钱，50%–100% 强回补，0–50% 弱回补
- ETF 拆解按跟踪指数归类，只是估算，不是实名仓位

本页只做盘面与资金行为解释，不构成投资建议。
