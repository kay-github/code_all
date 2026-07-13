# 股票 YTD 多源数据与可靠性设计

> 本文档记录股票 YTD 工具的数据源职责、复权规则、质量闸门、故障切换、真实接口验证和当前生产前置条件。产品口径仍以 PRD.md 为准。

## 1. 文档信息

| 字段 | 内容 |
| --- | --- |
| 版本 | v1.2 |
| 状态 | 数据层实现基线 |
| 创建日期 | 2026-07-12 |
| 最后更新 | 2026-07-13 |
| 主参考源 | 东方财富 |
| 独立计算及整源备用 | Tushare Pro |
| 异常复核源 | 腾讯财经 |
| 连续性兜底 | 上一份完整已发布快照 |

## 2. 核心结论

多源不是把多个结果求平均，而是给每个数据源明确职责：

1. 东方财富提供用户可见的最新 YTD 参考值 referenceYtd。
2. Tushare 的原始收盘价和复权因子用于独立计算 computedYtd。
3. 腾讯前复权 K 线用于分红送股样本、哨兵股票和异常股票复核。
4. computedYtd 通过质量闸门后成为 publishedYtd。
5. 东财整体不可用时，只允许整份切换到通过质量闸门的 Tushare 快照。
6. 东财和 Tushare 都不可用时，继续提供上一份完整快照并标注 isStale。
7. 不允许用未复权收盘价代替复权收益。
8. Published envelope 同时携带一份有覆盖边界的上交所交易日历，用于动态计算 expectedAsOf；不得用自然工作日猜测交易日。
9. 新年度首个完整交易日结束前，baseDate 与 asOf 可以是同一基准交易日，此时个股和沪深300 YTD 均重置为 0，不继续沿用上一年度累计收益。

## 3. 数据源职责

| 数据源 | 使用能力 | 角色 | 不能承担的职责 |
| --- | --- | --- | --- |
| 东方财富 | 全市场 f25、单股 ulist、名称、代码、上市日期 | 最新 YTD 参考锚点 | 不能单独生成正式高精度排名 |
| Tushare Pro | stock_basic（含交易所与币种）、trade_cal、daily、adj_factor、index_daily | 主数据、交易日、独立复权计算、整源备用 | 未配置 Token 时不可用 |
| 腾讯财经 | 单股 qfq 日线 | 单股哨兵、公司行动和异常值复核 | 不做五千只股票全量抓取；北交所历史覆盖不完整 |
| 交易所或中证数据 | 证券清单、指数复核 | 定期审计 | 不作为当前统一复权数据源 |
| 上一发布快照 | 已通过全部质量门槛的数据 | 故障时连续服务 | 不代表最新，必须展示实际日期 |

AkShare 的很多 A 股接口最终仍来自东财，因此“东财 + AkShare”不视为两个独立数据源。

## 4. 复权与 YTD 公式

正式计算使用同一数据源、同一计算版本的两端原始收盘价和复权因子：

    baseAdjustedPrice = baseRawClose × baseAdjFactor
    lastAdjustedPrice = lastRawClose × lastAdjFactor
    computedYtd = lastAdjustedPrice ÷ baseAdjustedPrice - 1

也可以使用同一供应商生成的前复权 K 线：

    computedYtd = currentQfqClose ÷ baseQfqClose - 1

强约束：

- 基准价格和统计价格必须各自对应同一天的复权因子。
- 不能把一个数据源的价格与另一个数据源的复权因子混算。
- 每个日终批次重新计算两端比值，不依赖上一日 YTD 累乘。
- 供应商修订复权因子后，应重新生成当年快照。
- 停牌股票记录 basePriceDate 和 lastPriceDate，不能伪装成基准日或统计日当日成交。
- 同时记录 baseAdjFactorDate 和 lastAdjFactorDate，且必须分别等于对应价格日期。
- 保存 computedYtd、referenceYtd、publishedYtd 和 deviationBp，不互相覆盖。
- 该收益是复权价格收益，不含个人红利税、交易税费和账户成本。

## 5. 真实接口验证

验证时间为 2026-07-12，行情统计日为 2026-07-10。

### 5.1 新易盛

| 项目 | 结果 |
| --- | ---: |
| 东财 f25 | 70.34% |
| 腾讯前复权基准收盘 | 307.057 |
| 腾讯前复权当前收盘 | 523.050 |
| 腾讯前复权计算 YTD | 70.3429656% |
| 两源差异 | 0.2966bp |
| 结论 | 通过 |

### 5.2 贵州茅台现金分红影响

| 项目 | 结果 |
| --- | ---: |
| 东财 f25 | -10.69% |
| 腾讯前复权计算 YTD | -10.6863847% |
| 两源差异 | 0.3615bp |
| 腾讯不复权计算 YTD | -12.5038% |
| 不复权相对前复权误差 | 约 181.7bp |

结论：东财 f25 与腾讯前复权结果一致；直接使用未复权价格会把现金分红造成的机械除息误认为真实亏损。

### 5.3 全市场接口

- 东财 clist 实测单页最多返回 100 条，即使请求更大的 pz。
- 适配器因此固定 pz 不超过 100，按证券代码稳定排序，读取 total 后逐页获取。
- 一次完整抓取成功返回 5,874 条唯一行情记录，包含沪深和北交所相关记录。
- 该数量不是最终 A 股股票池数量，其中可能包含定向转让等非普通股票，必须与 Tushare 或交易所证券主数据相交。
- 连续重复全市场抓取时出现过网络断链，三次重试后仍失败，证明东财公开接口不能作为唯一事实源。
- 适配器在分页之间默认增加 100ms 间隔，并保存失败页码、已接收数量和预期总量。

### 5.4 已知接口限制

- 当前执行环境多次无法访问东财 push2his 历史 K 线域名，因此不把它作为唯一复权验证入口。
- 腾讯能够稳定返回沪深单股 qfqday。
- 腾讯北交所部分代码只返回 day 或历史为空，不能作为北交所全量独立复权源。
- 东财 f25 仅有两位小数，会产生大量显示精度并列，不能直接作为高精度排序键。
- Tushare 的端点批量数据缺口会触发按股票历史回补；默认回看至当前可比股票中最早的上市日期，避免用固定回看年限误删长期停牌股票。

## 6. 质量闸门

| 条件 | 处理 |
| --- | --- |
| computedYtd 与 referenceYtd 差值不超过 5bp | 通过 |
| 差值大于 5bp 且不超过 20bp | 保留 computedYtd，标记警告并进入腾讯复核 |
| 差值大于 20bp | 隔离该股票，不进入当日排名 |
| 无独立 computedYtd，只有东财 f25 | reference-only，默认禁止生产发布 |
| 证券代码重复或日期无效 | 阻止候选快照发布 |
| Tushare 端点返回非正收盘价、非正复权因子或错日记录 | 阻止该批次，返回 TUSHARE_INVALID_ENDPOINT_ROW |
| asOf 不等于 expectedAsOf | 阻止新快照发布 |
| 全市场有效覆盖低于 99.8% | 阻止新快照发布 |
| 未提供证券主数据生成的 expectedUniverseCount | 阻止新快照发布，不能用本次返回条数自证完整 |
| 未提供交易日历生成的 expectedBaseDate 或 expectedAsOf | 阻止新快照发布，不能由候选快照自证日期 |
| 将覆盖率阈值降低到 99.8% 以下 | 只允许诊断，阻止生产发布 |
| 关闭主数据或复权审计闸门 | 只允许诊断，阻止生产发布 |
| 正式排名记录缺少 computedSource | 阻止发布，返回 MISSING_COMPUTED_SOURCE |
| 一份快照包含多个 computedSource | 阻止发布，返回 MIXED_COMPUTED_SOURCES |
| computedSource 不是当前允许的 Tushare 计算源 | 阻止发布，返回 UNSUPPORTED_COMPUTED_SOURCE；腾讯不得覆盖排名值 |
| 有效证券数超过 expectedUniverseCount | 阻止发布，检查股票池污染 |
| 股票池为空 | 阻止新快照发布 |
| 复权审计字段缺失 | 默认不进入正式排名 |
| 东财整体不可用但 Tushare 完整 | 发布 computed-fallback 整源快照并告警 |
| 东财和 Tushare 都不可用 | 保留上一份快照，不移动 current 指针 |
| Published envelope 缺少有效交易日历、snapshotId 或 ETag | 阻止生产读取 |
| records、stocks 索引、预排序池或 coverage 彼此不一致 | 阻止发布或读取，返回快照完整性错误 |
| expectedAsOf 相对上一 envelope 倒退 | 阻止更新 current |

单只股票被隔离不等于整批失败，但隔离导致覆盖率跌破门槛时必须阻止整批发布。
被质量闸门阻断的 Candidate 快照不得进入用户查询；诊断读取必须显式使用 allowBlocked。

## 7. 股票池与主数据

东财行情列表不能直接等同于产品股票池。正式股票池必须先由独立证券主数据定义：

- 当前上市 A 股。
- 上交所、深交所，北交所按用户开关加入。
- 包含主板、创业板和科创板。
- 默认包含 ST 与 *ST。
- 排除 B 股、基金、ETF、REIT、可转债、存托凭证、指数、定向转让和已退市证券。
- 基准日之后上市的股票标记为 NEW_LISTING，不进入标准 YTD 排名。

Tushare 主数据适配器显式读取 `exchange` 和 `curr_type`：仅接受人民币普通股，排除 USD/HKD 等非 CNY 的 B 股与 `market=CDR` 的存托凭证；交易所、币种或市场字段缺失，以及交易所与代码后缀冲突时，记录进入 `DATA_QUALITY_REJECTED`，不得靠代码前缀补猜后发布。

完成主数据过滤后，再按标准证券代码与东财 referenceYtd 相交。

## 8. 故障切换

### 8.1 正常模式

    Tushare computedYtd
    + 东财 referenceYtd
    + 腾讯哨兵复核
    → 质量闸门
    → 正式快照

### 8.2 东财失败

    完整 Tushare computedYtd
    + 交易日历和主数据完整
    → computed-fallback 整份快照
    → 显示数据源告警

不得把部分东财股票和部分 Tushare 股票随机拼成一份未标识来源的快照。

### 8.3 少量个股异常

- 大于 5bp 的记录进入腾讯复核。
- 大于 20bp 的记录默认隔离。
- MVP 不自动用腾讯值覆盖全市场记录。
- 后续如果允许逐股共识修复，修复比例上限不得超过股票池的 0.2%，并必须保留审计字段。

### 8.4 全部源失败

- 不生成空快照。
- 不移动 currentSnapshotId。
- 继续读取上一份 Published 快照；读取时再次要求 `productionPublishable=true`，被阻断的 Candidate 不能作为上一快照兜底。
- 接口返回真实 asOf、expectedAsOf、publishedAt 和 isStale。
- 本轮刷新必须显式传入交易日历生成的 expectedAsOf，且候选 asOf、候选 expectedAsOf 均须与其一致；漏传或不一致时不得发布，也不得把旧快照标成未过期。
- 最近一次成功获取的交易日历随 current envelope 持久化；日历端点短时失败时可继续使用覆盖范围内的已校验日历。覆盖到期后必须进入降级或失败状态，不得按周一至周五推算。
- L1 快照缓存使用同一份持久化交易日历跨越 18:30 截止点动态更新 expectedAsOf/isStale；快照网关失败时仍需显示缓存降级告警。

## 9. 日终数据流程

1. 获取未来一段时间的交易日历；端点失败时只允许使用仍在覆盖范围内的上一份已校验日历。
2. 用交易日历确定 baseDate 和 expectedAsOf。
3. 获取并归档各数据源原始响应和哈希。
4. 用证券主数据建立目标股票池。
5. 获取基准端和统计端原始价格及复权因子。
6. 计算 computedYtd。
7. 获取东财 referenceYtd；年度重置快照不使用上一年度 f25 作为新年度参考。
8. 计算 deviationBp 并调用腾讯复核异常样本。
9. 应用资格、日期、覆盖率和重复代码校验。
10. 生成沪深与沪深加北交所两套高精度排序。
11. 计算沪深300价格指数 YTD。
12. 写入不可变 Candidate 快照。
13. 校验记录、索引、排序池、覆盖率、基准和交易日历一致后，原子更新 current envelope。
14. 校验失败时保留上一份 Published 快照，并更新服务状态和动态 expectedAsOf。

Raw、Candidate 和 Published 三层数据不能混用。

### 9.1 Published envelope 契约

生产查询读取的不是裸 snapshot，而是以下 envelope：

```json
{
  "envelopeVersion": "stock-ytd-current.v1",
  "snapshotId": "stock-ytd-20260710-...",
  "expectedAsOf": "2026-07-10",
  "refreshStatus": "PUBLISHED",
  "refreshedAt": "2026-07-10T11:00:00.000Z",
  "errorCodes": [],
  "warningCodes": [],
  "tradingCalendar": {
    "version": "sse-trading-calendar.v1",
    "coveredFrom": "2025-12-01",
    "coveredThrough": "2026-08-24",
    "openDates": ["2025-12-31", "2026-07-10"]
  },
  "snapshot": {}
}
```

示例中的 `openDates` 为缩略展示；真实 envelope 必须包含覆盖区间内的全部开市日。

约束：

- 生产必须通过 HTTPS 读取，响应必须提供 ETag；可通过 `STOCK_SNAPSHOT_AUTH_TOKEN` 增加 Bearer 鉴权。
- 禁止重定向，默认超时 5 秒，默认响应上限 12MiB；失败时只允许降级到本进程最近一次已完整校验的缓存。
- envelope snapshotId 必须与 snapshot 内标识一致，expectedAsOf 不得早于 asOf，也不得相对上一 current 倒退。
- snapshot 原始 expectedAsOf 必须等于其 asOf，证明它发布时是当前批次；对外动态 expectedAsOf 由 envelope 和交易日历叠加得到。
- refreshStatus 为 `PUBLISHED` 或 `SERVING_PREVIOUS`。后者、computed-fallback、部分校验和缓存降级都必须转成用户可见的非阻断提示。
- 用户 API 始终 `Cache-Control: no-store`；L1 只存在服务端，且缓存有效期不会跨过上海时间 18:30 而不重新校验新鲜度。

### 9.2 本地文件存储边界

`lib/stockSnapshotFileStore.js` 是最小本地实现：不可变快照写入 `snapshots/`，`current.json` 原子替换，`refresh.lock` 防止同目录并发刷新。锁包含随机 owner token 并定期刷新文件心跳，只有所有者可以释放；主锁或 recovery guard 的心跳超过阈值后才允许回收，避免 PID 重用造成永久死锁。

该实现用于本地和单机验证，不是 Vercel Serverless 的持久化方案，也不是跨主机分布式锁。生产必须改用对象存储保存不可变快照、KV/数据库保存 current 指针，并使用具备条件写或租约能力的分布式协调机制。

## 10. 当前代码

| 文件 | 职责 |
| --- | --- |
| lib/stockYtd.js | 复权公式、前复权 K 线计算、严格排名和并列处理 |
| lib/stockSources.js | 东财、腾讯、Tushare 适配，超时、重试、分页和错误分类 |
| lib/stockSnapshot.js | 多源比对、计算源隔离、质量闸门、双股票池快照和查询 |
| lib/stockRefresh.js | 主源、整源备用、刷新日期校验、发布失败和上一快照兜底编排 |
| lib/tushareYtd.js | Tushare 主数据/行情请求、端点缺口按股历史回补、停牌向前选价、同日复权因子匹配和记录构建 |
| lib/stockFixture.js | 仅供本地纵向切片使用的开发快照；生产环境默认禁用 |
| lib/stockTradingDates.js | 上海时区 18:30 截止点、交易日历持久化契约、覆盖校验和年度重置边界 |
| lib/stockBenchmark.js | 沪深300价格指数端点计算与发布校验 |
| lib/stockPublishedSnapshot.js | HTTPS Published envelope 读取、ETag/L1 缓存、强完整性校验和降级提示 |
| lib/stockSnapshotFileStore.js | 本地不可变快照、current 原子替换和带所有权的刷新锁 |
| lib/stockDailyWorker.js | 日终数据抓取、候选构建、完整校验、发布及上一快照降级编排 |
| api/stock-search.js | Published 快照股票名称与代码搜索接口 |
| api/stock-ytd.js | Published 快照个股 YTD、双股票池排名与沪深300读取接口 |
| api/stock-health.js | 数据模式、快照日期、质量和缓存降级健康状态 |
| tools/stock-ytd-ranking/index.html | 移动优先股票搜索与结果页面 |
| scripts/check-stock-sources.js | 在线哨兵与全市场抓取检查 |
| scripts/refresh-stock-ytd.js | 日终 Worker 命令行入口，支持本地目录和同日强制重跑 |
| tests/stockYtd.test.js | 分红、送股、复权和排名测试 |
| tests/stockSources.test.js | 供应商字段、分页、超时、重试和单位转换测试 |
| tests/stockSnapshot.test.js | 多源偏差、计算源隔离、上海时区日期、覆盖率和股票池测试 |
| tests/stockRefresh.test.js | 整源切换、刷新日期强校验、发布失败和上一快照连续服务测试 |
| tests/tushareYtd.test.js | Tushare 送股、分红、停牌、全年停牌、新股保留、主数据过滤、历史回补、无效端点行、回补上限和缺因子测试 |
| tests/stockSourceMonitor.test.js | 哨兵日期、市场完整性、Tushare 计算覆盖率和假绿退出测试 |
| tests/stockFixture.test.js | 开发快照、双股票池与生产禁用保护测试 |
| tests/apiStockSearch.test.js | 股票搜索契约、输入校验与生产禁用测试 |
| tests/apiStockYtd.test.js | YTD结果、北交所切换、新股与错误契约测试 |
| tests/stockPage.test.js | 页面入口、核心控件、接口引用和响应式基线测试 |
| tests/stockTradingDates.test.js | 18:30 截止点、交易日历覆盖和年度重置测试 |
| tests/stockBenchmark.test.js | 沪深300端点、重复值、缺失值和日期一致性测试 |
| tests/stockPublishedSnapshot.test.js | envelope、结构完整性、ETag、超时、大小、缓存与动态 freshness 测试 |
| tests/stockSnapshotFileStore.test.js | 原子发布、动态日期、防倒退、锁所有权和崩溃遗留锁测试 |
| tests/stockDailyWorker.test.js | 正常发布、幂等、整源备用、质量失败、日历降级和跨年重置测试 |
| tests/apiStockHealth.test.js | READY、DEGRADED、DEMO 与 NOT_READY 状态测试 |

测试：

    node tests/stockYtd.test.js
    node tests/stockSources.test.js
    node tests/stockSnapshot.test.js
    node tests/stockRefresh.test.js
    node tests/tushareYtd.test.js
    node tests/stockSourceMonitor.test.js
    node tests/stockFixture.test.js
    node tests/apiStockSearch.test.js
    node tests/apiStockYtd.test.js
    node tests/stockPage.test.js
    node tests/stockTradingDates.test.js
    node tests/stockBenchmark.test.js
    node tests/stockPublishedSnapshot.test.js
    node tests/stockSnapshotFileStore.test.js
    node tests/stockDailyWorker.test.js
    node tests/apiStockHealth.test.js

在线哨兵：

    node scripts/check-stock-sources.js

默认哨兵要求 TUSHARE_TOKEN、交易日历、主数据、沪深300，以及每一端不晚于端点的有效收盘价和价格日同日复权因子全部可用，否则非零退出。端点当日批量缺口会触发按股票同时回补 daily 和 adj_factor 历史。仅做本地东财与腾讯诊断时可以显式放宽：

    node scripts/check-stock-sources.js --allow-missing-tushare

同时检查全市场分页：

    node scripts/check-stock-sources.js --market

在线哨兵依赖公开网络，不作为离线单元测试的一部分。

Tushare 全市场检查使用以下覆盖率口径：

    eligibleComputed = computedYtd 非空且无 ineligibilityReason 的记录数
    computedCoverage = eligibleComputed / expectedUniverseCount

`expectedUniverseCount` 来自当前上市且基准日或之前已上市的 Tushare 主数据；当年新股仍保留在主数据和查询记录中，但不进入该分母。`computedCoverage` 低于 0.998 时返回 `COMPUTED_YTD_COVERAGE_LOW`，检查状态为 `FAIL` 并非零退出。报告同时输出 expectedUniverse、eligibleComputed、computedCoverage、baseBackfill 和 currentBackfill。

按股历史回补设有上游保护：数据集默认每个端点最多回补 500 只，在线哨兵默认最多 200 只、并发度为 4；超过上限抛出 `TUSHARE_BACKFILL_LIMIT_EXCEEDED`，哨兵状态为 `UNAVAILABLE` 并默认非零退出。基准端和统计端依次回补，避免两个端点叠加并发。

## 11. 环境与安全

- Tushare Token 只从 TUSHARE_TOKEN 环境变量读取。
- `STOCK_SNAPSHOT_URL` 是生产 Published envelope 的 HTTPS 地址；可选 `STOCK_SNAPSHOT_AUTH_TOKEN` 只用于服务端 Bearer 鉴权。
- `STOCK_SNAPSHOT_TIMEOUT_MS`、`STOCK_SNAPSHOT_CACHE_TTL_MS`、`STOCK_SNAPSHOT_MAX_BYTES` 分别控制读取超时、L1 TTL 和响应大小上限。
- `STOCK_SNAPSHOT_DIR` 仅指定本地文件存储目录；`STOCK_REFRESH_LOCK_STALE_MS` 控制本地锁心跳失效阈值，默认 2 小时且最小 60 秒。
- `STOCK_TRADING_CALENDAR_HORIZON_DAYS` 控制交易日历前瞻覆盖，默认 45 天，允许 7 至 370 天。
- Token 不进入前端、日志、测试 Fixture 或仓库。
- 所有用户查询只读取 Published 快照，不在用户请求中抓取全市场。
- 刷新入口必须使用独立服务端密钥保护。
- 每日原始行情和快照不能提交到 Git。
- 上线前必须确认各数据源商用授权与调用额度。

## 12. 生产前仍需完成

当前已经完成复权计算、多源适配、候选快照、质量闸门、批次内端点缺口回补、停牌向前选价、日终 Worker、Published envelope 读取、本地原子存储、动态交易日 freshness 和在线哨兵，但以下生产能力尚未落地：

1. 配置具备所需权限与额度的 TUSHARE_TOKEN。
2. 完成 Tushare 初始全量历史落库、每日增量持久化及调度编排；当前按股回补是批次内兜底，不替代持久化历史仓库。
3. 用生产对象存储/KV/数据库替换 `.stock-ytd-data/` 本地文件实现，并提供受保护、带 ETag 的 HTTPS envelope 网关。
4. 配置每日 18:30 后运行的日终任务，并在自然年切换时生成 0 收益重置快照；不能只依赖用户请求触发。
5. 建立 Worker 失败、SERVING_PREVIOUS、computed-fallback、日历覆盖不足和连续过期告警，并完成至少 10 个交易日影子对比。
6. 配置生产 `STOCK_SNAPSHOT_URL`、读取鉴权和密钥轮换机制。
7. 完成数据源商用授权与调用额度确认。

在以上事项完成前，当前数据层适合作为可验证的工程基础和原型，不应宣称已经具备无人值守的生产级数据 SLA。
