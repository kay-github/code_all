# 全市场非货币 ETF 申赎背景（辅助）

来源：SkillHub `china-etf-flow-premarket`。这里只做 **背景与交叉校验**，不进入核心 15 只正式份额、10 份刻度和发布闸门。

## 运行

```bash
python -m pip install -r market_flow/requirements-market-flow.txt
python -X utf8 market_flow/market_flow_update.py --trade-date 20261124 --out data/market_flow
```

默认输出到 `gjd_research/data/market_flow/`：

- `latest.json`：页面读取的最新一期
- `reports/etf_flow_YYYYMMDD.json/.csv/.md`：按日留存
- `history.csv`：每日汇总

## 口径边界

- 数据源只用 AkShare：上交所/深交所份额，交易日历，同花顺/东方财富/深交所净值补充；排除货币 ETF。
- 份额变化 × 净值/市价是**估算**，不是原始申赎成交额。
- 全市场总量包含债券、商品、跨境；`summary.stock_net_flow_yi` 才是股票型。
- 不能识别买卖主体，身份仍为 I0；不能替代核心 15 只正式份额。
