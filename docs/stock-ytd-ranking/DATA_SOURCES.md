# 股票 YTD 多源数据与可靠性设计

> 本文档记录股票 YTD 工具的数据源职责、复权规则、质量闸门、故障切换、真实接口验证和当前生产前置条件。产品口径仍以 PRD.md 为准。

## 1. 文档信息

| 字段 | 内容 |
| --- | --- |
| 版本 | v1.3 |
| 状态 | 数据层实现基线 |
| 创建日期 | 2026-07-12 |
| 最后更新 | 2026-07-14 |
| 主参考源 | 东方财富 |
| 沪深独立计算 | Baostock 前复权日线 |
| 北交所独立计算 | 新浪原始日线与前复权因子 |
| 证券主数据 | 上交所、深交所、北交所公开清单 |
| 异常复核源 | 腾讯财经、雪球 |
| 连续性兜底 | 上一份完整已发布快照 |

## 2. 核心结论

多源不是把多个结果求平均，而是给每个数据源明确职责：

1. 三家交易所公开清单定义当前上市 A 股股票池，行情列表不得自证股票池完整性。
2. Baostock 同一批次前复权日线用于沪深 computedYtd、交易日历和沪深300价格指数。
3. 新浪同源原始收盘价与前复权因子用于北交所 computedYtd。
4. 东方财富提供 referenceYtd，腾讯和雪球用于哨兵与异常复核。
5. computedYtd 通过质量闸门后成为 publishedYtd；允许按交易所固定分源，不允许单股跨源混算。
6. 东财不可用时允许发布完整 computed-fallback；Baostock 或新浪任一计算分区不可用时保留上一份完整快照并标注 isStale。
7. 不允许用未复权收盘价代替复权收益。
8. Published envelope 同时携带一份有覆盖边界的上交所交易日历，用于动态计算 expectedAsOf；不得用自然工作日猜测交易日。
9. 新年度首个完整交易日结束前，baseDate 与 asOf 可以是同一基准交易日，此时个股和沪深300 YTD 均重置为 0，不继续沿用上一年度累计收益。

## 3. 数据源职责

| 数据源 | 使用能力 | 角色 | 不能承担的职责 |
| --- | --- | --- | --- |
| 东方财富 | 全市场 f25、单股 ulist、名称、代码、上市日期 | 最新 YTD 参考锚点 | 不能单独生成正式高精度排名 |
| 上交所、深交所、北交所 | 当前上市证券清单和上市日期 | 独立股票池及数量基线 | 不提供统一复权收益 |
| Baostock | 沪深前复权日线、交易日历、沪深300 | SH/SZ 独立计算与指数 | 不支持北交所，不作为证券池唯一事实源 |
| 新浪财经 | 北交所原始日线、qfq 因子 | BSE 独立计算 | 大量抓取可能限流，不承担沪深全市场主计算 |
| 腾讯财经 | 单股 qfq 日线 | 单股哨兵、公司行动和异常值复核 | 不做五千只股票全量抓取；北交所历史覆盖不完整 |
| 雪球 | current_year_percent 批量行情 | 沪深北批量哨兵 | 两位小数，单批过大易超时 |
| 上一发布快照 | 已通过全部质量门槛的数据 | 故障时连续服务 | 不代表最新，必须展示实际日期 |

AkShare 的很多 A 股接口最终仍来自东财，因此“东财 + AkShare”不视为两个独立数据源。

## 4. 复权与 YTD 公式

正式计算可以使用同一数据源、同一计算版本的两端原始收盘价和复权因子：

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
- 原始价与因子模式同时记录 baseAdjFactorDate 和 lastAdjFactorDate，且必须分别证明对应价格日期使用的有效因子。
- 前复权 K 线模式记录 baseAdjustedClose、lastAdjustedClose 和对应价格日期，不伪造原始价或因子。
- 保存 computedYtd、referenceYtd、publishedYtd 和 deviationBp，不互相覆盖。
- 该收益是复权价格收益，不含个人红利税、交易税费和账户成本。

## 5. 真实接口验证

首轮验证时间为 2026-07-12，免费源迁移验证时间为 2026-07-14。

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
- 一次完整抓取成功返回 5,875 条唯一行情记录，包含沪深和北交所相关记录。
- 该数量不是最终 A 股股票池数量；2026-07-14 三家交易所清单过滤后为沪 2,307、深 2,893、北交所 327，共 5,527 只，并排除上交所 CDR。
- 连续重复全市场抓取时出现过网络断链，三次重试后仍失败，证明东财公开接口不能作为唯一事实源。
- GitHub Hosted Runner 或本地环境无法连接 `push2.eastmoney.com` 时，整批切换到同契约的 `push2delay.eastmoney.com`；禁止在同一批次混合两个主机的分页结果。
- 适配器在分页之间默认增加 100ms 间隔，并保存失败页码、已接收数量和预期总量。

### 5.4 已知接口限制

- 当前执行环境多次无法访问东财 push2his 历史 K 线域名，因此不把它作为唯一复权验证入口。
- 腾讯能够稳定返回沪深单股 qfqday。
- 腾讯北交所部分代码只返回 day 或历史为空，不能作为北交所全量独立复权源。
- 东财 f25 仅有两位小数，会产生大量显示精度并列，不能直接作为高精度排序键。
- Baostock 对交易所目标沪深 5,200 只覆盖缺失为 0；随机 100 只端点检查 100% 成功，串行全量估算约 25 分钟。
- 新浪北交所均匀抽取 20 只，历史与因子 20/20 成功；串行全量估算约 21 分钟。
- 2026-07-14 本地全量 Worker 实测耗时 758.187 秒：官方在市清单共 5,527 只，基准日前上市 5,450 只，YTD 成功 5,450 只，覆盖率 100%，抓取失败 0；其余 77 只为当年新股并按规则保留。
- 同批 v2 快照共 5,527 条记录，JSON 约 9.55 MiB，发布 payload gzip 约 0.74 MiB，分别低于 12 MiB Blob 读取上限和 4 MiB 发布请求上限。
- Baostock 与新浪沪深复权样本差异低于 0.03bp；新浪北交所使用 rawClose ÷ qfqFactor 的未四舍五入结果。
- Baostock 沪深300端点属于独立局部请求，失败时重试 2 次并退避；端点仍不可用才阻止本批发布。
- Baostock 全量任务在个股循环前读取沪深300，并每处理 1,000 只沪深股票主动重建会话；单股请求重试耗尽后重登录并完整重试一次，避免长连接重置扩散为后续批量失败。GitHub Actions 全任务时限为 180 分钟。
- PyTDX 沪深可用但公开节点握手不稳定且不覆盖北交所；Yahoo、腾讯不具备北交所全量覆盖，均不作为正式计算源。

## 6. 质量闸门

| 条件 | 处理 |
| --- | --- |
| computedYtd 与 referenceYtd 差值不超过 5bp | 通过 |
| 差值大于 5bp 且不超过 20bp | 保留 computedYtd，标记警告并进入腾讯复核 |
| 差值大于 20bp | 隔离该股票，不进入当日排名 |
| 无独立 computedYtd，只有东财 f25 | reference-only，默认禁止生产发布 |
| 证券代码重复或日期无效 | 阻止候选快照发布 |
| Baostock/Sina 返回非正价格、非正因子或错日记录 | 隔离记录；覆盖率跌破门槛时阻止批次 |
| asOf 不等于 expectedAsOf | 阻止新快照发布 |
| 全市场有效覆盖低于 99.8% | 阻止新快照发布 |
| 未提供证券主数据生成的 expectedUniverseCount | 阻止新快照发布，不能用本次返回条数自证完整 |

参考源本身也必须先通过批次级质量检查：如果同一参考源导致超过 0.2% 的独立计算记录超过 20bp、覆盖率跌破 99.8% 或出现大面积日期/口径异常，则整批丢弃 referenceYtd，重新发布完整 `computed-fallback`；不得因为不可信参考源隔离独立计算结果。
| 未提供交易日历生成的 expectedBaseDate 或 expectedAsOf | 阻止新快照发布，不能由候选快照自证日期 |
| 将覆盖率阈值降低到 99.8% 以下 | 只允许诊断，阻止生产发布 |
| 关闭主数据或复权审计闸门 | 只允许诊断，阻止生产发布 |
| 正式排名记录缺少 computedSource | 阻止发布，返回 MISSING_COMPUTED_SOURCE |
| SH/SZ computedSource 不是 baostock，或 BSE computedSource 不是 sina | 阻止发布，返回 COMPUTED_SOURCE_EXCHANGE_MISMATCH |
| computedSource 不在 baostock/sina 白名单 | 阻止发布，返回 UNSUPPORTED_COMPUTED_SOURCE；参考源不得覆盖排名值 |
| 有效证券数超过 expectedUniverseCount | 阻止发布，检查股票池污染 |
| 股票池为空 | 阻止新快照发布 |
| 复权审计字段缺失 | 默认不进入正式排名 |
| 东财整体不可用但两个计算分区完整 | 发布 computed-fallback 整源快照并告警 |
| Baostock 或新浪计算分区不完整 | 保留上一份快照，不移动 current 指针 |
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

主数据直接读取三家交易所公开清单：上交所仅接受主板 A 股和科创板普通 A 股并排除 689 前缀 CDR，深交所读取 A 股列表，北交所读取上市公司列表。交易所、代码、上市日期缺失或重复时记录进入 `DATA_QUALITY_REJECTED`，不得靠行情代码前缀补猜后发布。

完成主数据过滤后，再按标准证券代码与东财 referenceYtd 相交。

## 8. 故障切换

### 8.1 正常模式

    Baostock SH/SZ computedYtd
    + 新浪 BSE computedYtd
    + 东财 referenceYtd
    + 腾讯哨兵复核
    → 质量闸门
    → 正式快照

### 8.2 东财失败

    完整 Baostock + 新浪 computedYtd
    + 交易日历和主数据完整
    → computed-fallback 整份快照
    → 显示数据源告警

不得把参考源值写入 computedYtd，也不得在 SH/SZ 与 BSE 的固定计算分区之外随机逐股拼源。

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
- L1 快照缓存使用同一份持久化交易日历跨越 16:00 截止点动态更新 expectedAsOf/isStale；快照网关失败时仍需显示缓存降级告警。

## 9. 日终数据流程

1. 获取未来一段时间的交易日历；端点失败时只允许使用仍在覆盖范围内的上一份已校验日历。
2. 用交易日历确定 baseDate 和 expectedAsOf。
3. 获取三家交易所公开清单并建立目标股票池。
4. 获取 Baostock 沪深前复权端点、交易日历和沪深300。
5. 获取新浪北交所原始价格及对应前复权因子。
6. 计算 computedYtd。
7. 获取东财 referenceYtd；年度重置快照不使用上一年度 f25 作为新年度参考。
8. 计算 deviationBp 并调用腾讯复核异常样本。
9. 应用资格、日期、覆盖率和重复代码校验。
10. 生成沪深与沪深加北交所两套高精度排序。
11. 计算沪深300价格指数 YTD。
12. 写入不可变 Candidate 快照。
13. GitHub Actions 使用 OIDC 调用受保护发布 API；Vercel 校验记录、索引、排序池、覆盖率、基准和交易日历一致后原子更新 current envelope。
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
- 用户 API 始终 `Cache-Control: no-store`；L1 只存在服务端，且缓存有效期不会跨过上海时间 16:00 而不重新校验新鲜度。

### 9.2 本地文件存储边界

`lib/stockSnapshotFileStore.js` 是最小本地实现：不可变快照写入 `snapshots/`，`current.json` 原子替换，`refresh.lock` 防止同目录并发刷新。锁包含随机 owner token 并定期刷新文件心跳，只有所有者可以释放；主锁或 recovery guard 的心跳超过阈值后才允许回收，避免 PID 重用造成永久死锁。

该实现用于本地和单机验证，不是 Vercel Serverless 的持久化方案，也不是跨主机分布式锁。生产必须改用对象存储保存不可变快照、KV/数据库保存 current 指针，并使用具备条件写或租约能力的分布式协调机制。

### 9.3 生产 Blob 存储

`lib/stockSnapshotBlobStore.js` 使用私有 Vercel Blob 保存生产数据：先以确定性名称写入不可变快照，再通过 ETag `ifMatch` 条件写切换 `current.json`。首个 current 使用禁止覆盖写入，避免两个发布者同时初始化；读取路径始终绕过 CDN 缓存。

`current.json` 条件写冲突时必须重新读取最新 envelope，确认快照日期不倒退后用新 ETag 重试；如果完整不可变快照已经写入但 current 尚未切换，可以由 GitHub Actions OIDC 或人工 `CRON_SECRET` 通过 `/api/stock-publish?recoverAsOf=YYYY-MM-DD` 提升该日期最新且重新通过生产校验的快照。恢复只复用 current 中仍覆盖目标日期的交易日历，不暴露 Blob URL，也不得跨日期选择候选。

`stock-ytd/interval/daily/<date>.json` 保存区间统计的逐日 YTD 回填文件（契约与灌入流程见 INTERVAL_STATS.md §4.3）：写入仅经 `/api/stock-publish?intervalDailyDate=` 鉴权入口且允许覆盖（因子修订重灌）；读取由区间统计接口作为基准日数据源，优先于同日期完整快照。`stock-ytd/interval/series.json` 为随灌入增量维护的逐日演变聚合（两池阈值计数/中位数/沪深300收盘），同一鉴权边界，供 `?series=1` 与同区间基准对比读取。

`refresh.lock` 使用禁止覆盖获取租约，内容包含随机 owner token、创建时间和心跳时间。持有者通过 ETag 条件写续租，并只在 owner token 仍匹配时条件删除；超过失效阈值的租约通过 ETag 条件删除后竞争重建。`/api/stock-snapshot` 只返回 current envelope，不返回私有 Blob URL、存储凭据或重定向；大响应对支持 gzip 的调用方使用确定性压缩，并基于实际响应字节生成 ETag。`/api/stock-publish` 的正常发布只接受 gzip 候选快照，按日期恢复只接受无正文的显式恢复参数；两者都校验 GitHub Actions OIDC 或人工 `CRON_SECRET`，并只返回白名单批次摘要。

## 10. 当前代码

| 文件 | 职责 |
| --- | --- |
| lib/stockYtd.js | 复权公式、前复权 K 线计算、严格排名和并列处理 |
| lib/stockSources.js | 东财、腾讯和历史 Tushare 适配，超时、重试、分页和错误分类 |
| lib/stockSnapshot.js | 多源比对、按交易所计算源隔离、质量闸门、双股票池快照和查询 |
| lib/stockRefresh.js | 主源、整源备用、刷新日期校验、发布失败和上一快照兜底编排 |
| lib/tushareYtd.js | 旧 Tushare 适配器，仅保留历史回归测试，不进入生产调度 |
| lib/stockFixture.js | 仅供本地纵向切片使用的开发快照；生产环境默认禁用 |
| lib/stockTradingDates.js | 上海时区 16:00 截止点、交易日历持久化契约、覆盖校验和年度重置边界 |
| lib/stockBenchmark.js | 沪深300价格指数端点计算与发布校验 |
| lib/stockPublishedSnapshot.js | HTTPS Published envelope 读取、ETag/L1 缓存、强完整性校验和降级提示 |
| lib/stockSnapshotFileStore.js | 本地不可变快照、current 原子替换和带所有权的刷新锁 |
| lib/stockSnapshotBlobStore.js | 私有 Vercel Blob 不可变快照、ETag 条件 current 写入和分布式刷新租约 |
| lib/stockDailyWorker.js | 候选快照统一构建和历史本地 Worker；生产抓取由 Python 长任务承担 |
| lib/stockPublishAuth.js | GitHub Actions OIDC 与人工 Bearer 发布鉴权 |
| api/stock-search.js | Published 快照股票名称与代码搜索接口 |
| api/stock-ytd.js | Published 快照个股 YTD 与双股票池排名读取接口；为兼容已有调用可携带 benchmark |
| api/stock-benchmark.js | Published 快照沪深300独立读取接口，支持前端独立加载和错误隔离 |
| api/stock-health.js | 数据模式、快照日期、质量和缓存降级健康状态 |
| api/stock-snapshot.js | 私有 Blob Published envelope 网关，返回 ETag 且禁止缓存和重定向 |
| api/stock-publish.js | OIDC/CRON_SECRET 保护的 gzip 快照校验与 Blob 原子发布入口 |
| tools/stock-ytd-ranking/index.html | 移动优先股票搜索与结果页面 |
| lib/stockEmYtd.js | 东财 f25 全市场直取、腾讯哨兵闸门、盘中结算闸门与 reported 快照构建 |
| scripts/refresh-stock-ytd-em.js | reported 管线命令行入口：读取网关日历、构建快照、OIDC 发布与 no-op 幂等；发布成功后顺带上传当日区间日频文件（snapshot-em-f25.v1，失败不推翻快照发布） |
| lib/stockIntervalStats.js | 区间涨跌分布：快照紧凑映射提取、YTD 比值合成、阈值分桶与样本资格（见 INTERVAL_STATS.md） |
| api/stock-interval-stats.js | 区间涨跌分布查询接口：分布统计、名单钻取、可用基准日列表（日频文件优先于快照） |
| tools/stock-interval-stats/index.html | 区间涨跌分布移动优先页面（日历式基准日选择器） |
| scripts/backfill_interval_daily.py | 区间统计回填 Worker：全年逐交易日 qfq YTD 矩阵（沪深 Baostock、北交所新浪） |
| scripts/upload-interval-daily.js | 回填数据集拆日 gzip 上传至 stock-publish intervalDailyDate 模式 |
| scripts/check-stock-sources.js | 在线哨兵与全市场抓取检查 |
| scripts/refresh-stock-ytd.js | 日终 Worker 命令行入口，支持本地目录和同日强制重跑 |
| scripts/run-stock-ytd-first-batch.js | 首次真实数据严格验收、shadow 发布与脱敏质量报告 |
| scripts/free_stock_ytd.py | 官方清单、Baostock 与新浪免费源全量数据集 Worker |
| scripts/publish-free-stock-ytd.js | 构建正式快照、东财参考校验、OIDC 发布和 dry-run 审计 |
| .github/workflows/stock-ytd.yml | 工作日长任务调度、手工重跑和 OIDC 发布 |
| tests/stockYtd.test.js | 分红、送股、复权和排名测试 |
| tests/stockSources.test.js | 供应商字段、分页、超时、重试和单位转换测试 |
| tests/stockSnapshot.test.js | 多源偏差、计算源隔离、上海时区日期、覆盖率和股票池测试 |
| tests/stockRefresh.test.js | 整源切换、刷新日期强校验、发布失败和上一快照连续服务测试 |
| tests/tushareYtd.test.js | Tushare 送股、分红、停牌、全年停牌、新股保留、主数据过滤、历史回补、无效端点行、回补上限和缺因子测试 |
| tests/stockSourceMonitor.test.js | 哨兵日期、市场完整性、Tushare 计算覆盖率和假绿退出测试 |
| tests/stockFixture.test.js | 开发快照、双股票池与生产禁用保护测试 |
| tests/apiStockSearch.test.js | 股票搜索契约、输入校验与生产禁用测试 |
| tests/apiStockYtd.test.js | YTD结果、北交所切换、新股与错误契约测试 |
| tests/apiStockBenchmark.test.js | 沪深300独立接口、缺失数据与错误隔离契约测试 |
| tests/stockPage.test.js | 页面入口、核心控件、接口引用和响应式基线测试 |
| tests/e2e/stock-ytd-ranking.spec.js | Playwright 移动端与桌面端选股、北交所局部更新、局部重试和竞态测试 |
| tests/stockTradingDates.test.js | 16:00 截止点、交易日历覆盖和年度重置测试 |
| tests/stockBenchmark.test.js | 沪深300端点、重复值、缺失值和日期一致性测试 |
| tests/stockPublishedSnapshot.test.js | envelope、结构完整性、ETag、超时、大小、缓存与动态 freshness 测试 |
| tests/stockSnapshotFileStore.test.js | 原子发布、动态日期、防倒退、锁所有权和崩溃遗留锁测试 |
| tests/stockSnapshotBlobStore.test.js | Blob 条件发布、不可变冲突、锁所有权和过期租约恢复测试 |
| tests/stockDailyWorker.test.js | 正常发布、幂等、整源备用、质量失败、日历降级和跨年重置测试 |
| tests/apiStockSnapshot.test.js | 快照网关 ETag、304、未就绪和错误脱敏测试 |
| tests/apiStockRefresh.test.js | 刷新密钥、配置保护、响应白名单和并发冲突测试 |
| tests/apiStockHealth.test.js | READY、DEGRADED、DEMO 与 NOT_READY 状态测试 |
| tests/stockFirstBatch.test.js | 首批次零副作用预检、诊断短路、严格发布和报告脱敏测试 |
| tests/free_stock_ytd_test.py | 官方主数据、交易日、复权端点和缺失数据单元测试 |
| tests/stockPublishAuth.test.js | GitHub OIDC 签名、claims、工作流身份和人工密钥鉴权测试 |
| tests/apiStockPublish.test.js | gzip 限制、OIDC/人工鉴权、发布校验和响应脱敏测试 |
| tests/freeStockPublisher.test.js | 免费源数据集、东财参考降级、OIDC 申请、压缩和发布请求测试 |
| tests/stockEmYtd.test.js | reported 管线：f25 记录、哨兵闸门、结算闸门和基准构建测试 |
| tests/stockIntervalStats.test.js | 区间合成恒等式、分红仿射误差方向、样本资格、阈值边界和跨年守卫测试 |
| tests/apiStockIntervalStats.test.js | 区间分布接口契约、参数校验、名单分页、可用日期和脱敏测试 |
| tests/stockIntervalPage.test.js | 区间分布页面入口、日历控件和接口引用基线测试 |
| tests/backfill_interval_daily_test.py | 回填逐日序列、停牌沿用、缺基准价和交易日过滤单元测试 |

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
    node tests/apiStockBenchmark.test.js
    node tests/stockPage.test.js
    node tests/stockTradingDates.test.js
    node tests/stockBenchmark.test.js
    node tests/stockPublishedSnapshot.test.js
    node tests/stockSnapshotFileStore.test.js
    node tests/stockSnapshotBlobStore.test.js
    node tests/stockDailyWorker.test.js
    node tests/apiStockSnapshot.test.js
    node tests/apiStockRefresh.test.js
    node tests/apiStockHealth.test.js
    node tests/stockFirstBatch.test.js
    node tests/stockEmYtd.test.js
    node tests/stockIntervalStats.test.js
    node tests/apiStockIntervalStats.test.js
    node tests/stockIntervalPage.test.js
    npm run test:stock-free
    npm run test:stock-python

浏览器端到端测试：

    npm run test:e2e

免费源 Worker：

    python scripts/free_stock_ytd.py --output .stock-ytd-data/free-dataset.json
    node scripts/publish-free-stock-ytd.js --input .stock-ytd-data/free-dataset.json --dry-run

Python Worker 先读取三家交易所清单和 Baostock 交易日历，再串行抓取沪深前复权端点并限并发抓取北交所新浪历史与因子。报告只输出分交易所数量、耗时、覆盖率和错误代码，不输出全市场价格或因子。`expectedUniverseCount` 来自官方清单中基准日或之前上市的证券；低于 99.8% 时 Node 快照质量闸门阻止发布。

生产由 `.github/workflows/stock-ytd.yml` 在工作日北京时间 20:30 执行；股票数据流水线自身合入 `main` 时也会运行一次，普通站点改动不会触发全量任务。Workflow 具备 `id-token: write`，发布脚本向 GitHub OIDC 端点申请 audience 为 `stock-ytd-publish` 的短期 JWT；Vercel 仅接受 `kay-github/code_all` 主分支指定 Workflow 的签名 Token。无需在 GitHub 保存数据供应商 Token 或 Blob Token。

东财与腾讯在线哨兵仍可独立运行，但旧 Tushare 首批次脚本只作为历史回归工具，不再是生产发布前置条件。

## 11. 环境与安全

- `STOCK_SNAPSHOT_URL` 是生产 Published envelope 的 HTTPS 地址；可选 `STOCK_SNAPSHOT_AUTH_TOKEN` 只用于服务端 Bearer 鉴权。
- `STOCK_SNAPSHOT_TIMEOUT_MS`、`STOCK_SNAPSHOT_CACHE_TTL_MS`、`STOCK_SNAPSHOT_MAX_BYTES` 分别控制读取超时、L1 TTL 和响应大小上限。
- `STOCK_SNAPSHOT_DIR` 仅指定本地文件存储目录；`STOCK_REFRESH_LOCK_STALE_MS` 控制本地锁心跳失效阈值，默认 2 小时且最小 60 秒。
- 生产 Blob 凭据只由 Vercel 注入；GitHub Actions 使用短期 OIDC，不持有 Blob Token。`CRON_SECRET` 仅作为人工发布兜底。
- `stock-ytd/current.json` 使用 Blob ETag 条件写，`stock-ytd/refresh.lock` 使用禁止覆盖、owner token、条件续租和过期回收；读取网关不暴露 Blob URL 或凭据。
- `STOCK_TRADING_CALENDAR_HORIZON_DAYS` 控制交易日历前瞻覆盖，默认 45 天，允许 7 至 370 天。
- OIDC JWT、Token 和原始行情不进入前端、日志、测试 Fixture 或仓库。
- 所有用户查询只读取 Published 快照，不在用户请求中抓取全市场。
- 刷新入口必须使用独立服务端密钥保护。
- 每日原始行情和快照不能提交到 Git。
- 上线前必须确认各数据源商用授权与调用额度。

### 11.1 首次生产发布验收

- 2026-07-14 GitHub Actions run `29304436877` 在 Ubuntu Hosted Runner 完成首次全量正式发布；全任务约 71 分钟，其中行情采集约 70 分 20 秒，OIDC 校验与发布约 32 秒。
- Vercel 发布快照为 `stock-ytd-20260713-a57badc3855121f2`，`asOf=expectedAsOf=2026-07-13`，覆盖率 100%，`isStale=false`。
- 东财参考源本批网络失败，快照按设计以 `computed-fallback` 发布并在健康接口显示 `DEGRADED`；Baostock/Sina 主计算、搜索、沪深与含北交所排名、沪深300独立接口均正常。
- GitHub Actions 仅使用 OIDC 短期 JWT，未配置数据供应商 Token 或 Blob Token；Vercel 完成服务端复权重算校验与 Blob 原子切换。

## 12. 生产前仍需完成

当前实现目标已经移除 Tushare 生产依赖，并将超出 Serverless 时限的抓取迁移到 GitHub Actions。生产提升仍需持续完成：

1. 建立 Worker 失败、SERVING_PREVIOUS、computed-fallback、日历覆盖不足和连续过期告警，并完成至少 10 个交易日影子对比。
2. 保存每批官方证券清单哈希、分交易所数量和源端点版本，支持股票池漂移审计。
3. 完成各公开数据源商用授权、再分发边界和调用频率确认。
4. 评估增量历史缓存；当前日终重新读取 YTD 端点优先保证复权修订可被重新计算。

在以上事项完成前，当前数据层适合作为可验证的工程基础和原型，不应宣称已经具备无人值守的生产级数据 SLA。
