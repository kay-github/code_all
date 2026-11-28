# 趋势买卖点（/trend）

对沪深300、中证500、中证1000、创业板指、科创50 的日K线，用同一套趋势规则标注买入/卖出点，并在收盘后把新信号推到 PushPlus。

## 规则

- 入场：收盘价 > 过去 25 日最高价 × 1.005，且收盘价 > MA250，且 MA250 > 60 个交易日前的 MA250（严格）
- 初始止损：次日开盘价 − 2 × ATR22
- 跟踪止损：max(22 日最高价 − 3 × ATR22, 初始止损)，只上移
- 离场：收盘价 < 有效止损 × 0.995
- 执行：T 日收盘出信号，T+1 开盘成交；回测计单边 5bp 成本
- 只做多，卖出后空仓

参数在 2005–2018 样本内锁定，2019 年以后不调参。科创50 2019-12-31 才有数据，等于全程样本外，可信度低于其他四个指数。

## 数据

- 主源：东方财富指数日线（不复权，含成交额），成交量按“手”×100 换算为股
- 备源：腾讯 `web.ifzq.gtimg.cn` 指数 `day` 节点
- 15:05 前剔除当日未收盘 bar；校验重复日期、非法 OHLC、未来日期、单日跳变 > 35%
- `data/history/*.csv` 为全历史，`data/signals.json` 为页面信号与回测，`data/validation.json` 为验证报告

## 更新与验证

```bash
python -X utf8 update.py                 # 抓数 + 重建 + 推送
python -X utf8 update.py --no-push       # 只更新数据
python -X utf8 update.py --rebuild --no-push  # 不抓数，用现有 CSV 重建
python -X utf8 update.py --check         # 只检查数据
```

GitHub Actions：`.github/workflows/trend-signals-daily.yml`，工作日北京时间 15:35 / 16:05 / 16:35 三个窗口。推送去重状态在 `data/push_state.json`，必须随数据一起提交。

推送优先用 `PUSHPLUS_TOKEN`；未配置时回退到站点已有的 `/api/top-radar?action=notify`（需要 GitHub Secret `MONITOR_SECRET`），不额外保存 token。

## 发布

- 页面：`tools/trend-signals/`，路由 `/trend`、`/trends`
- 首页卡片：`assets/site-defaults.js` 的 `trendSignals`
- 内嵌映射：`assets/site-home.js` 的 `toolPaths` / `aliases`
- 路由与 no-store：`vercel.json`
- 发布只 add 本工具目录、`vercel.json`、`assets/site-defaults.js`、`assets/site-home.js` 和 workflow，绝不 `git add -A`

## 页面交互

- 滚轮缩放（鼠标为锚点）、拖动平移、双击复位、触屏双指缩放
- 十字光标 OHLC / 成交量 / 成交额 / 均线提示
- Shift+拖动或“区间统计”按钮：区间涨跌、振幅、最大回撤、成交量、成交额、日均成交额、年化波动
- 日/周/月聚合；MA5/10/20/60/250、BOLL、MACD 开关
- B/S 标记、持仓带、持仓止损线、待执行 B?/S?；策略净值 vs 买入持有、KPI、交易记录、年度收益、方法与验证报告

## 已知局限

- 中证500 全样本最大回撤 −37.5%（2015-08-18 买入后 4 个交易日跳空跌 18%，2N 硬止损被穿透）
- 沪深300 样本外年化仅 +2.0%，跑输买入持有约 2pp/年；价值在把回撤从 −45.6% 压到 −14.4%
- 组合夏普 95% Bootstrap 区间跨 0；风险控制有效，不是每年稳赚
- 卖出是风险退出，不是看空预测；卖出后 60/120 日也可能上涨

历史回测不构成投资建议。指数不能直接交易，实盘可用对应 ETF 或股指期货，需自行承担基差、跟踪误差、保证金与流动性风险。
