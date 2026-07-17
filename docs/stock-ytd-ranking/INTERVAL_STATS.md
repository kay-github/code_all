# 区间涨跌分布（Interval Stats）设计文档

> 本文档是"区间涨跌分布"功能的指导性文件，定义产品口径、数学公式、数据架构、API 契约与扩展路线。产品总口径仍以 PRD.md 为准；数据层约束以 DATA_SOURCES.md 为准。

## 1. 文档信息

| 字段 | 内容 |
| --- | --- |
| 版本 | v1.1 |
| 状态 | Phase 1 已上线；Phase 2（回填 + 日历选择器）已实现，待执行回填任务 |
| 创建日期 | 2026-07-16 |
| 依赖文档 | PRD.md §18 v2.1 决策记录、DATA_SOURCES.md §9.3 |
| 数据来源 | 已发布的不可变 Published 快照（私有 Vercel Blob） |

## 2. 产品定义

### 2.1 用户问题

"从某月某日（比如前阵子大跌那天）到现在，跌幅超过 30%、35%、40%、45%、50% 的股票各有多少只？"

用户会在市场大跌或大涨后反复查询同一个基准日；不需要盘中实时数据，日频（每交易日收盘后 16:07 起更新）足够；使用者是通过链接访问的普通朋友，无 AI、无账号。

### 2.2 一句话定位

选一个基准日，一眼看到全市场自该日以来的涨跌分布与极端涨跌名单。

### 2.3 功能范围

- 基准日：可用日期 = 回填日频文件 ∪ 已发布快照的交易日（回填执行后最早可到上年末 2025-12-31，即"年初以来"），且与当前快照同一年度 baseDate。
- 统计终点：最新已发布快照（`current.json`），不支持自选终点（API 预留 `to` 参数，本期不实现）。
- 阈值梯度（累计计数，"跌超 30%" 包含 "跌超 50%"）：

      跌幅：10、15、20、25、30、35、40、45、50、60、70、80（%）
      涨幅：10、15、20、25、30、35、40、45、50、60、80、100（%）

- 每档可展开名单：代码、名称、区间涨跌幅，按涨跌幅排序，分页。
- 北交所开关：沿用现有产品 includeBse 口径，默认沪深。
- 明确不做：盘中实时、跨年区间、自选终点日（见 §8 路线图）。

## 3. 数学口径

### 3.1 合成公式

设基准日 D、最新交易日 A，两日快照的个股 YTD 均以同一年度基准日（上年末收盘）为基期：

    区间收益 R(D→A) = (1 + YTD_A) ÷ (1 + YTD_D) − 1

### 3.2 恒等性推导

记 P^t(s) 为以 t 日为锚的 s 日前复权价（s ≤ t），YTD_t = P^t(t)/P^t(base) − 1。

若 D 与 A 之间发生**送转**（乘性调整，系数 1/m），重锚定对所有 s ≤ 事件日统一缩放：P^A(s) = P^D(s)/m。代入：

    (1+YTD_A)/(1+YTD_D) = [P^A(A)/P^A(base)] × [P^D(base)/P^D(D)]
                        = P^A(A) × m/P^D(base) × P^D(base)/P^D(D)
                        = P^A(A)/P^A(D)

即严格等于以最新锚点计的 D→A 前复权区间收益。**送转场景恒等式严格成立，历史快照永远不需要重算。**

### 3.3 现金分红的近似误差

现金分红的前复权是仿射修正（先减派息再除送转比），重锚定不是纯乘性：P^A(s) = (P^D(s) − d)/m。此时：

    合成值 ÷ 真值 = (1 − d/P^D(D)) ÷ (1 − d/P^D(base))

误差量级 ≈ 单次股息率 × (P^D(base)/P^D(D) − 1)。例：区间内除息 1%（相对基准日价）、且股票自年初已跌 30%，偏差约 0.43pp。

结论：**仅当区间内发生现金分红时存在偏差，典型 <0.5pp**；相对 5pp 的桶间隔可忽略，但恰好卡在阈值边界的个股可能跳桶。7–8 月是 A 股分红密集期，此声明必须在页面展示。

### 3.4 精度汇总

| 误差源 | 量级 | 何时出现 |
| --- | --- | --- |
| f25 两位小数舍入（两端合成） | ≤ ±0.03pp | 恒有 |
| 现金分红仿射修正 | 典型 <0.5pp | 仅区间内除息的个股 |
| 送转 | 0 | — |
| 跨方法论合成（computed 基准 × reported 当前） | ≤ 0.4bp（哨兵实测两源差） | 基准日为 2026-07-13~07-15 |

产品口径：区间涨跌幅标注为"约"，整体精度按 ±0.5pp 声明；分布统计有效，个股精确值以行情软件为准。Phase 2 回填高精度前复权价后可消除分红项误差。

### 3.5 样本资格

| 规则 | 处理 |
| --- | --- |
| 两份快照中均 `isEligible` 且 ytd 非空 | 纳入统计 |
| 基准日后上市新股（基准快照无记录或 NEW_LISTING） | 排除，计入 `excludedNewSinceBase` |
| 基准日在、最新快照缺失（退市等） | 排除，计入 `excludedMissingCurrent` |
| 任一侧被隔离/无效 | 排除，计入 `excludedIneligible` |
| `lastPriceDate < asOf`（停牌，尽力识别） | 纳入但单独计数 `suspendedCount`；reported 快照无逐股停牌信息，不承诺完整识别 |
| 两份快照 baseDate 不同（跨年） | 拒绝查询，`BASE_YEAR_MISMATCH` |

## 4. 数据架构

### 4.1 两层结构

    查询层  api/stock-interval-stats + 前端页面
            ↓ 只依赖 "日期 D → 全市场 YTD 紧凑映射"
    数据层  日期解析顺序：
            ① 进程内缓存（按 snapshotId，不可变、永不过期）
            ② 回填日频文件  stock-ytd/interval/daily/<date>.json（小、高精度，优先）
            ③ 已发布不可变快照  stock-ytd/snapshots/stock-ytd-YYYYMMDD-*.json

查询层不感知数据来自哪一层；可用基准日 = 两个来源的日期并集。

### 4.3 回填日频文件（Phase 2，已实现）

单日文件契约 `stock-ytd-interval-daily.v1`：

```json
{
  "version": "stock-ytd-interval-daily.v1",
  "asOf": "2026-03-18",
  "baseDate": "2025-12-31",
  "methodologyVersion": "backfill-qfq.v1",
  "generatedAt": "...",
  "records": {
    "600519.SH": { "exchange": "SH", "ytd": -0.1069 },
    "000001.SZ": { "exchange": "SZ", "ytd": 0.02, "lastPriceDate": "2026-03-17" }
  }
}
```

- 基准日当天（上年末收盘）文件 ytd 全为 0，使"年初以来"走同一查询路径。
- 停牌日沿用最近可用收盘并记录 `lastPriceDate`；未上市/缺基准价的股票直接缺席。
- 生成：`scripts/backfill_interval_daily.py`（沪深 Baostock qfq、北交所新浪原始价×因子，与日常管线同口径；单日覆盖率 <99.5% 的交易日整日丢弃）。
- 上传：`scripts/upload-interval-daily.js` 逐日 gzip POST `/api/stock-publish?intervalDailyDate=<date>`，OIDC/CRON_SECRET 鉴权，服务端逐条校验（版本、日期一致、记录数下限、ytd 有界、symbol 白名单格式）后允许覆盖写（因子修订可重灌）。
- 触发：GitHub Actions `stock-ytd.yml` 手工 dispatch，勾选 `backfill_daily`（必须在该 workflow 内运行——OIDC 只信任它的身份），全程约 25–70 分钟。
- 回填文件为高精度 qfq 计算，凡命中即消除 §3.3/§3.4 中 f25 舍入与分红仿射两项误差。
- 日频文件可携带可选 `csi300Close`（当日沪深300收盘价，回填端 Baostock `sh.000300`、刷新端快照 benchmark）——"同期沪深300"对比的基准日锚点。
- 逐日演变聚合 `interval/series.json`（`stock-ytd-interval-series.v1`）：灌入日频文件时在鉴权入口增量维护，按日存 hs（沪深）/all（含北交所）两池的阈值计数与年内中位数及 csi300Close；`?series=1` 直接返回，用户请求不逐日读 Blob。跨年度基期整体重置；周六全量回填即全量重建。
- Phase 2.5（已实现）：`scripts/refresh-stock-ytd-em.js` 在每晚快照发布成功后顺带生成并上传当日日频文件（methodologyVersion `snapshot-em-f25.v1`，精度与快照同为东财 f25 口径），使该日日后作为基准日时的冷查询走日频快路径；上传失败不推翻快照发布，仅该日退回快照慢路径。回填任务重跑时会以 `backfill-qfq.v1` 覆盖同名文件（更高精度，谁后写谁生效）。

### 4.2 约束（继承 DATA_SOURCES）

- 用户查询只读已发布快照，**不在用户请求中抓取任何行情**。
- 基准快照读取与 `api/stock-snapshot.js` 同一信任边界：服务端直读私有 Blob，不暴露 Blob URL、凭据或重定向。
- 当前快照走现有 `loadStockSnapshot()`（HTTPS 网关 + L1 缓存 + 16:00 动态新鲜度），降级语义（isStale、SERVING_PREVIOUS、缓存降级警告）原样透传。
- 同日多份快照取上传时间最新且通过解析校验者（与 `promoteLatestSnapshot` 的候选选择规则一致）；解析失败的快照跳过并尝试次新。
- 紧凑映射只保留 `symbol/code/name/exchange/ytd/lastPriceDate`，单日约 300KB，按 snapshotId 进程内缓存。

## 5. API 契约

`GET /api/stock-interval-stats`，响应 `Cache-Control: no-store`，CORS 与现有 API 一致，错误脱敏（不回传内部错误细节）。

### 5.1 分布统计（主模式）

    GET /api/stock-interval-stats?baseDate=2026-07-14&includeBse=false

    200 {
      "baseDate": "2026-07-14",            // 实际使用的基准快照 asOf
      "asOf": "2026-07-16",
      "expectedAsOf": "2026-07-16",
      "isStale": false,
      "dataMode": "published",
      "warning": null,
      "yearBaseDate": "2025-12-31",
      "methodologyVersions": { "base": "...", "current": "reported-ytd.v1" },
      "includeBse": false,
      "matchedCount": 5432,
      "suspendedCount": 12,
      "excluded": { "newSinceBase": 3, "missingCurrent": 1, "ineligible": 91 },
      "declines": [ { "thresholdPct": 10, "count": 812 }, ... ],   // 累计
      "gains":    [ { "thresholdPct": 10, "count": 1401 }, ... ],  // 累计
      "precisionNote": "区间涨跌幅为前复权口径合成值，约 ±0.5pp"
    }

### 5.2 名单（钻取模式）

    GET /api/stock-interval-stats?baseDate=2026-07-14&includeBse=false&list=-30&limit=100&offset=0

`list` 为阈值百分数（负数=跌超，正数=涨超）。返回该档全部命中的总数与当前分页记录（`symbol/code/name/exchange/intervalReturn/isSuspended`），跌幅榜按区间收益升序、涨幅榜降序，同值按 symbol 排序保证稳定分页。`limit` 上限 200。

### 5.3 可用日期

    GET /api/stock-interval-stats?dates=1

    200 { "availableBaseDates": ["2026-07-13", ...], "asOf": "2026-07-16" }

来源：list Blob `snapshots/` 前缀解析文件名日期，排除 ≥ 当前 asOf 的日期；进程内缓存 1 小时。

### 5.4 错误码

| 码 | HTTP | 场景 |
| --- | --- | --- |
| `INVALID_BASE_DATE` | 400 | 缺失/格式错误/不早于当前 asOf |
| `INVALID_INCLUDE_BSE` / `INVALID_LIST_PARAMS` | 400 | 参数非法 |
| `BASE_SNAPSHOT_MISSING` | 404 | 该日期无可用快照；响应附 `availableBaseDates` 供前端引导 |
| `BASE_YEAR_MISMATCH` | 409 | 基准快照与当前快照年度基期不同 |
| `STOCK_DATA_UNAVAILABLE` | 503 | 当前快照不可用（沿用现有语义） |
| `INTERNAL_ERROR` | 500 | 其他，脱敏 |

## 6. 缓存与性能

| 路径 | 预期耗时 | 说明 |
| --- | --- | --- |
| 热查询（映射已缓存） | <100ms | 5,500 次除法 + 分桶 |
| 冷查询（新基准日/冷启动） | 2–4s | 读 ~10MiB 基准快照 + 解析 + 提取映射 |
| 名单分页 | <100ms | 统计结果按 (baseDate, snapshotId, includeBse) 进程内缓存后切片 |

用户模式是"反复查同一基准日"，热路径覆盖绝大多数请求。若冷查询体验不达标，Phase 2 的 `interval/daily/*.json` 持久化派生缓存（单日 ~50KB gzip）可把冷查询降到 ~300ms，属于既定扩展点而非重构。

## 7. 边界情况

| 情况 | 行为 |
| --- | --- |
| 基准日 = 最新 asOf | 400 `INVALID_BASE_DATE` |
| 基准日是交易日但当日发布失败、无快照 | 404 + 可用日期列表 |
| 基准日快照为 computed 方法论（07-13~07-15） | 允许合成，响应携带双方 methodologyVersion |
| 当前快照 isStale / SERVING_PREVIOUS / 降级 | 照常统计，透传警告，页面非阻断展示 |
| 跨年（新年度重置后查上年度基准日） | 409 `BASE_YEAR_MISMATCH`，等 Phase 3 |
| 同日多份不可变快照 | 取最新上传且解析通过者 |
| 快照里 ytd = -1 以下或非有限值 | 该记录按 ineligible 排除（数据层已有闸门，双保险） |

## 8. 路线图

| 阶段 | 状态 | 基准日范围 | 数据工作 |
| --- | --- | --- | --- |
| Phase 1 | 已上线（2026-07-16） | ≥2026-07-13 的快照日 | 无 |
| Phase 2 | 已上线（2026-07-17，128 个基准日） | 2025-12-31 起任意交易日（含"年初以来"） | dispatch `stock-ytd.yml` + `backfill_daily`（见 §4.3）；此后每次执行会覆盖到最新完整交易日，可按需重跑 |
| Phase 2.5 | 已上线（2026-07-17） | 每个新交易日自动累积 | 日常发布管线在发布快照后顺带写当日日频文件（`snapshot-em-f25.v1`），新快照日期的基准冷查询走日频快路径 |
| 精度收敛 | 已上线（2026-07-17） | 每周六 10:35 全量回填 | f25 精度日期逐周洗成 qfq、修补空洞、重建演变聚合；单日增量与全量成本相同（耗时在每股查询而非天数） |
| 逐日演变 | 已上线（2026-07-17） | 年初基准宽度指标 | 页面"逐日演变"页签：跌超/涨超 X% 家数逐日曲线（series 聚合，O(1) 查询） |
| Phase 3（跨年） | 未立项 | 任意历史日期 | 口径切换为纯价格区间收益，需独立立项与 PRD 决策 |

## 9. 代码与测试清单

| 文件 | 职责 |
| --- | --- |
| lib/stockIntervalStats.js | 紧凑映射提取、区间收益合成、阈值分桶、样本资格 |
| lib/stockSnapshotBlobStore.js（扩展） | 历史快照只读能力 + 回填日频文件读写与日期列表 |
| api/stock-interval-stats.js | 三模式路由、日频文件→快照解析顺序、参数校验、进程内缓存、错误脱敏 |
| api/stock-publish.js（扩展） | `intervalDailyDate` 上传模式：鉴权、逐条校验、覆盖写 |
| scripts/backfill_interval_daily.py | 回填 Worker：全年逐交易日 qfq YTD 矩阵（沪深 Baostock、北交所新浪） |
| scripts/upload-interval-daily.js | 回填数据集拆日上传（OIDC 换新、401 重试、失败清单） |
| tools/stock-interval-stats/index.html | 移动优先分布页面（日历选择器 + 快捷日期、跌/涨/演变切换、档位间隔切换、北交所开关、名单钻取、URL 状态共享、名单复制/导出 CSV、零依赖 SVG 演变曲线） |
| .github/workflows/stock-ytd.yml（扩展） | `backfill_daily` 手工任务：装依赖 → 测试 → 生成 → 上传 |
| tests/stockIntervalStats.test.js | 恒等式（送转）、分红近似误差方向、资格规则、阈值边界、跨版本、跨年守卫 |
| tests/stockSnapshotBlobStore.test.js（扩展） | 快照历史读取 + 日频文件读写/列表/损坏兜底 |
| tests/apiStockIntervalStats.test.js | 三模式契约、日频优先解析、日期并集、分页稳定性、脱敏 |
| tests/apiStockPublish.test.js（扩展） | 日频上传模式鉴权、校验矩阵与响应契约 |
| tests/backfill_interval_daily_test.py | 逐日序列构建、停牌沿用、缺基准价、新股旗标、交易日过滤 |
| tests/stockIntervalPage.test.js | 页面入口、日历控件、演变视图、API 引用与内联脚本语法基线 |
| scripts/verify-stock-live.js | 生产完整性自检（READY/asOf/基准日空洞/series 覆盖），21:35 调度失败即告警 |
| tests/verifyStockLive.test.js | 自检脚本的覆盖计算与全流程桩测试 |

## 10. 验收清单

1. 全部新增测试 + 既有 stock 测试套件通过。
2. 部署后 `?dates=1` 返回 ≥1 个日期；以 2026-07-13 为基准日实测分布。
3. 抽 2–3 只股票（含一只区间内分红股）与东财 app 区间涨跌幅人工对照，偏差符合 §3.4 声明。
4. 手机端页面可用，链接可直接分享；isStale/降级时警告可见且非阻断。
