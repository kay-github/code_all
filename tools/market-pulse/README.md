# 资金面盘面说明（/pulse）

每天生成两份 A 股资金面复盘：**午盘 11:30** 与 **收盘 15:00**。页面重点是“钱”：主力/超大单、主动全单、ETF 申赎、融资余额，以及行业与个股的“新钱 / 回补 / 持续流入”。

## 线上

- 页面：https://1.688680.xyz/pulse
- 历史档案：https://1.688680.xyz/pulse/history
- 数据：`/tools/market-pulse/data/latest.json`（收盘）、`/data/am/latest.json`（午盘）
- 历史索引：`/tools/market-pulse/data/index.json`
- 单日归档：`/data/archive/YYYY-MM-DD.json`、`/data/am/archive/YYYY-MM-DD.json`
- 根站卡片：`assets/site-defaults.js` 的 `marketPulse`、`marketPulseHistory`

## 自动更新（不依赖本机）

GitHub Actions 两条正式链路：

- 午盘：`.github/workflows/market-pulse-morning.yml`，工作日北京时间 11:36–12:36 五个窗口，`MP_SESSION=am`；另监听 `Market tracker updates` 完成事件，12:23 那次直接触发（11:20 / 下午的完成事件会被午盘窗口跳过）
- 收盘：`.github/workflows/market-pulse-daily.yml`，工作日北京时间 16:11–18:41 六个窗口，`MP_SESSION=pm`；另监听 `top-radar-daily` 完成事件，15:10 那次被 `run_daily.py` 的 16:05 门槛跳过，16:10 那次直接触发
- 云端看门狗：`.github/workflows/pulse-cloud-watchdog.yml`，工作日北京时间 11:00–21:50 每 10 分钟检查一次，数据缺失/过旧时用仓库自带的 `GITHUB_TOKEN` 调 GitHub API dispatch 对应 workflow；另监听 `top-radar-daily` 完成事件，在 16:10 附近补一次触发。它不跑管线，也不需要 PAT。
- 失败不会覆盖上一版；线上保留最近一次成功页面。
- **本机 `MarketPulseDaily` / `MarketPulseMorning` 计划任务已于 2026-11-27 停用**，不再作为兜底。需要本机补跑时用下面的命令，手动执行即可。

白名单提交 `tools/market-pulse/index.html`、`app.js`、`data/`（含 `data/index.json`）、`pipeline/run_status*.json`，Vercel 自动部署。GitHub Actions 的 schedule 会延迟/漏触发，所以保留多窗口 + 看门狗 + top-radar 直接触发三层。

## 日期与历史

- 默认 `/pulse` 显示最近交易日；顶部“交易日”下拉可回看历史。
- `?date=YYYY-MM-DD&session=pm|am` 可直接打开某天某个节点；`session` 省略时优先收盘。
- `/pulse/history` 按日期倒序列出双节点，并提供 `index.json` 入口；AI 做趋势分析先读索引，再按单日 `path` 取全文。
- 每次 AM/PM 渲染都会重扫归档并更新 `data/index.json`，不需要额外任务。

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
$env:MP_OUT_DIR="D:\code_all_pulse\tools\market-pulse"
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
