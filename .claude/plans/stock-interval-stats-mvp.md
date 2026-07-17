# 区间涨跌分布（Interval Stats）MVP 设计与实施计划

> 目标：上线一个网页工具——选一个基准日 D，显示"自 D 以来到最新交易日，跌幅（或涨幅）超过 10/15/20/25/30/35/40/45/50/60/70/80% 的股票各有多少只"，可展开名单。朋友通过链接直接使用，无需 AI。

## 0. 核心口径（写进指导性文件的关键结论）

- **合成公式**：`区间收益 = (1 + YTD_今日) ÷ (1 + YTD_基准日) − 1`。前复权/东财 reported 口径下这是恒等式（分红除权的重锚定在比值中消掉），**历史快照永远不需要重算**。
- **数据来源**：全部来自已存在的不可变 Published 快照（Blob `stock-ytd/snapshots/stock-ytd-YYYYMMDD-*.json`，2026-07-13 起每日自动累积）。查询层不抓任何行情。
- **可选基准日**：有历史快照的交易日（≥2026-07-13），且必须与当前快照同一年度 baseDate（跨年守卫，Phase 3 才放开）。
- **股票池**：两份快照中都有有效 YTD 的股票（双方 `ineligibilityReason=null` 且 ytd 非空）；基准日后上市的新股自然被排除；北交所沿用现有 includeBse 开关口径。
- **精度声明**：f25 两位小数合成后误差约 ±0.03pp，卡在阈值边界（如恰好 -30.00%）的个股可能跳桶；作为口径说明展示，不影响分布统计的有效性。
- **停牌**：`lastPriceDate < asOf` 的股票照常纳入但单独计数展示（"其中 N 只含停牌股价格"）。
- **性能**：同一 `(基准日, 最新日)` 组合结果确定。基准日快照压缩后 <1MiB、解析提取成 ~300KB 紧凑映射后按 snapshotId 进程内永久缓存（不可变）。冷查询 2–4s，热查询 <100ms。

## 1. 分支基线（前置，必须先做）

分支 `codex/stock-ytd-ranking-mvp` 落后 origin/main 12 个提交、领先 0 个 → 直接 fast-forward。

1. 把未提交 WIP（blob store 租约覆盖写 + 对应 doc/test 改动）提交到独立分支 `wip/blob-lease-overwrite` 存档（main 的 normalizeEtag 已修复根因，该兜底不属于本次范围，留待以后单独评审）。
2. `git checkout codex/stock-ytd-ranking-mvp && git merge --ff-only origin/main`。
3. 在最新基线上开发本功能。

## 2. 文档（先于代码，遵守 PRD 治理）

**新文件 `docs/stock-ytd-ranking/INTERVAL_STATS.md`**（指导性文件）：
- 上面第 0 节全部口径 + 公式推导（含分红重锚定为何消掉）
- 三阶段路线图：
  - Phase 1（本次）：基准日 ≥2026-07-13，随时间自动变长，零维护
  - Phase 2（回填）：一次性 Baostock 任务生成年内更早交易日的同格式紧凑日频文件 `stock-ytd/interval/daily/<date>.json`，查询层零改动
  - Phase 3（跨年）：口径切换为纯价格区间收益，需新逻辑，独立立项
- API 契约、错误码、缓存策略、边界情况表

**`docs/stock-ytd-ranking/PRD.md` §18 追加 v2.1 决策记录**（3 条）：
- 新增区间涨跌分布功能，数据只读已发布不可变快照，不新增抓取
- 区间收益用 YTD 比值合成，f25 两位小数精度声明
- 基准日范围受快照历史约束，扩展走同格式回填不改查询层

**`docs/stock-ytd-ranking/DATA_SOURCES.md`** §10 代码清单补新文件条目。

## 3. 代码改动

### 3.1 `lib/stockSnapshotBlobStore.js`（扩展，只读能力）
- `listAvailableSnapshotDates()`：list `stock-ytd/snapshots/` 前缀，从文件名解析出日期集合（分页、去重、排序）
- `loadLatestSnapshotForDate(asOf)`：复用现有 `listSnapshotsForDate` + `readObject`，取该日期最新且解析/校验通过的快照（等价 `promoteLatestSnapshot` 的读取部分，不写 current）

### 3.2 `lib/stockIntervalStats.js`（新）
- `extractYtdMap(snapshot)` → 紧凑映射 `{asOf, baseDate, methodologyVersion, records: {symbol → {code, name, exchange, ytd, lastPriceDate}}}`（只留必要字段）
- `computeIntervalStats(baseMap, currentMap, {includeBse})`：
  - 守卫：`baseMap.baseDate === currentMap.baseDate`（同年度）、`baseMap.asOf < currentMap.asOf`
  - 匹配双方均有效的 symbol，合成区间收益
  - 输出：双向累计阈值分桶（跌超/涨超 10~80%）、universe/matched/excluded/suspended 计数、按区间收益排序的完整记录（供名单查询切片）
- 跨方法论版本（`adjusted` 基准 × `reported` 当前）允许，响应中携带 `methodologyVersions` 供前端展示

### 3.3 `api/stock-interval-stats.js`（新）
- `GET ?baseDate=YYYY-MM-DD&includeBse=false` → 分布统计 + 元信息（asOf、expectedAsOf、isStale、dataMode、warning，沿用现有降级提示语义）
- `GET ?baseDate=...&list=-30&limit=100&offset=0` → 跌超 30% 名单（排序稳定，limit ≤200）
- `GET ?dates=1` → 可用基准日列表（内存缓存 1 小时）
- 当前快照走现有 `loadStockSnapshot()`（HTTPS 网关 + L1 + 18:30 新鲜度，全部复用）；基准快照走 blob store 直读（与 `api/stock-snapshot.js` 同一信任边界）
- 紧凑映射按 snapshotId 进程内缓存；错误脱敏、`Cache-Control: no-store`、CORS 与现有 API 一致
- 错误码：`INVALID_BASE_DATE` / `BASE_SNAPSHOT_MISSING`（附最近可用日期）/ `BASE_YEAR_MISMATCH` / `STOCK_DATA_UNAVAILABLE`

### 3.4 `tools/stock-interval-stats/index.html`（新页面）
- 复用现有 stock-ytd-ranking 页面的视觉语言（浅色金融工具风、移动优先）
- 控件：基准日选择（仅可用日期可选）、跌幅/涨幅切换、北交所开关
- 主体：横向条形分布（每档阈值一行：阈值、只数、占比条），点击展开该档名单（代码/名称/区间涨跌幅，分页加载）
- 头部展示：`基准日 → 最新交易日`、样本数、停牌计数、isStale/降级警告、精度与免责说明
- `vercel.json` 加短链 rewrite（如 `/qjfb` → 该页面，最终名称可再定）

### 3.5 测试（4 个新文件 + 1 个扩展）
- `tests/stockIntervalStats.test.js`：合成恒等式（含分红重锚定用例）、同年度守卫、双池匹配、阈值边界、停牌计数、跨版本合成
- `tests/stockSnapshotBlobStore.test.js`：追加 `listAvailableSnapshotDates` / `loadLatestSnapshotForDate`（多快照同日取最新、损坏快照跳过）用例
- `tests/apiStockIntervalStats.test.js`：参数校验、缺快照 404 契约、名单分页、no-store、错误脱敏
- `tests/stockIntervalPage.test.js`：页面入口、控件、API 引用基线（仿 `stockPage.test.js`）
- CI：`.github/workflows`/`package.json` 测试清单补齐

## 4. 验收

1. 本地：全部新测试 + 既有 stock 测试套件通过
2. 部署后：`curl 'https://1.688680.xyz/api/stock-interval-stats?dates=1'` 返回 ≥1 个可用日期；选 2026-07-13 为基准日实测分布，抽 2–3 只股票与东财 app 区间涨跌幅人工对照（容差 ±0.05pp）
3. 页面手机端可用，链接可直接分享

## 5. 明确不做（本次）

- 盘中实时数据（沿用每日 18:35 后更新）
- 2026-07-13 之前的基准日（Phase 2 回填）
- 跨年区间（Phase 3）
- 持久化派生缓存 `interval/daily/*.json` 的写入管线（Phase 2 一并做，MVP 用进程内缓存足够）
