# 大杂烩工具站

一个移动端优先的轻量 H5 工具站。当前已落地错别字校对，并实现股票 YTD 与市场排名工具的查询链路和日终数据基础设施。

## 股票 YTD 与市场排名

- 页面：`/tools/stock-ytd-ranking/`。
- 搜索接口：`GET /api/stock-search?q=新易`。
- 结果接口：`GET /api/stock-ytd?symbol=300502.SZ&includeBse=false`。
- 沪深300接口：`GET /api/stock-benchmark`，与个股结果独立加载和失败重试。
- 数据健康接口：`GET /api/stock-health`，状态为 `READY`、`DEGRADED`、`DEMO` 或 `NOT_READY`。
- 快照网关：`GET /api/stock-snapshot`，从私有 Vercel Blob 返回带 ETag 的 Published envelope。
- 日终刷新：`GET /api/stock-refresh`，仅接受 `CRON_SECRET` Bearer 鉴权；Vercel Cron 在工作日北京时间 18:30 触发。
- 本地与 Preview 未配置正式快照时使用明确标注的 Fixture；Vercel Production 和普通生产运行时无条件禁止 Fixture。
- 生产查询只读取 `STOCK_SNAPSHOT_URL` 指向的 Published envelope，不在用户请求中抓取或计算全市场行情。
- 正式统计口径、数据职责和质量闸门以 `docs/stock-ytd-ranking/PRD.md` 与 `DATA_SOURCES.md` 为准。

### 日终 Worker

配置具备所需权限和额度的 `TUSHARE_TOKEN` 后运行：

```bash
node scripts/refresh-stock-ytd.js
```

可显式指定本地存储目录或强制重跑同一交易日：

```bash
node scripts/refresh-stock-ytd.js --store-dir=.stock-ytd-data --force
```

Worker 使用 Tushare 主数据、交易日历、日线、复权因子和沪深300，东财 `f25` 作为参考校验；通过质量闸门后写入不可变快照，再原子更新 `current.json`。新年度首个完整交易日结束前会生成基准日收益为 0 的重置快照，避免继续展示上一年度累计 YTD。

`.stock-ytd-data/` 只用于本地验证，已被 Git 忽略。生产使用私有 Vercel Blob：不可变快照写入 `stock-ytd/snapshots/`，通过条件写更新 `stock-ytd/current.json`，刷新锁使用 owner token、ETag 条件续租和过期回收。Blob 凭据只由 Vercel 注入，不进入前端或仓库。

### 首次真实数据验收

首次接入 Token 时使用独立 shadow 目录运行严格验收，不直接写入日常快照目录：

```bash
node scripts/run-stock-ytd-first-batch.js --store-dir=.stock-ytd-data/first-batch-YYYYMMDD --require-as-of=YYYY-MM-DD --expected-sh=NNNN --expected-sz=NNNN --expected-bse=NNN
```

`--require-as-of` 先由 Tushare 交易日历做轻量校验；指定日期尚未成为最近完整交易日时不会继续抓取全市场。`--expected-sh/sz/bse` 必须填写从交易所或已授权独立证券清单人工确认的当日当前上市 A 股数量，不能照抄本次 Tushare 返回值；缺少三项中的任何一项都会在联网前阻断。目标目录必须不存在或为空。Worker 只写入目标目录下的 `candidate/`，shadow 根目录不会生成可被生产读取器直接接受的 `current.json`，审计通过后也不会自动提升。入口会依次检查 Tushare 权限、沪深北主数据分布与覆盖率、东财全市场分页、新易盛和贵州茅台的腾讯复权哨兵，再调用 Worker；外部基线、诊断和发布三方的股票池总数及分交易所数量必须一致。只有 `validated`、`PUBLISHED`、覆盖率不低于 99.8%、无质量警告、无隔离记录、全市场跨源偏差均不超过 5bp 且发布后审计全部通过时才返回 0。`computed-fallback` 可以被普通 Worker 发布，但不能冒充首次多源验收通过。

报告只输出日期、数量、覆盖率、偏差分桶、错误码和关键股票审计结果，不输出全市场记录、原始价格、复权因子或 Token。不要把 Token 写进命令历史、`.env` 或仓库；应由密钥管理的运行器注入，或在本机 PowerShell 使用隐藏输入临时注入当前进程：

```powershell
$secret = Read-Host "TUSHARE_TOKEN" -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
try {
  $env:TUSHARE_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
}
node scripts/run-stock-ytd-first-batch.js --store-dir=.stock-ytd-data/first-batch-YYYYMMDD --require-as-of=YYYY-MM-DD --expected-sh=NNNN --expected-sz=NNNN --expected-bse=NNN
Remove-Item Env:TUSHARE_TOKEN
```

### Published envelope

生产 `STOCK_SNAPSHOT_URL` 返回：

```json
{
  "envelopeVersion": "stock-ytd-current.v1",
  "snapshotId": "stock-ytd-20260710-...",
  "expectedAsOf": "2026-07-10",
  "refreshStatus": "PUBLISHED",
  "tradingCalendar": {
    "version": "sse-trading-calendar.v1",
    "coveredFrom": "2025-12-01",
    "coveredThrough": "2026-08-24",
    "openDates": ["2025-12-31", "2026-07-10"]
  },
  "snapshot": {}
}
```

示例中的 `openDates` 为缩略展示；真实 envelope 必须列出 `coveredFrom` 至 `coveredThrough` 范围内的全部开市日。

响应必须使用 HTTPS、提供基于实际响应表示的 ETag，并可选择 Bearer 鉴权。完整 envelope 较大时，网关对支持 gzip 的调用方返回压缩表示，读取端仍按解压后的大小执行上限校验。`tradingCalendar` 用于在 18:30 截止点后或缓存降级时继续以真实交易日历计算 `expectedAsOf/isStale`，不能用自然工作日猜测。

### 股票环境变量

- `TUSHARE_TOKEN`：日终 Worker 使用的 Tushare Token，仅配置在服务端。
- `CRON_SECRET`：保护 `/api/stock-refresh` 的独立服务端密钥；未配置时刷新接口拒绝执行。
- `BLOB_READ_WRITE_TOKEN` / `BLOB_STORE_ID`：由 Vercel Blob 连接自动注入，不要手工写入仓库。
- `STOCK_SNAPSHOT_DIR`：本地文件快照目录，默认 `.stock-ytd-data`。
- `STOCK_SNAPSHOT_URL`：生产 Published envelope 的 HTTPS 地址。
- `STOCK_SNAPSHOT_AUTH_TOKEN`：读取 envelope 时可选的 Bearer Token。
- `STOCK_SNAPSHOT_TIMEOUT_MS`：读取快照超时，默认 5000ms，最大 20000ms。
- `STOCK_SNAPSHOT_CACHE_TTL_MS`：服务端 L1 缓存时间，默认 60000ms，最大 300000ms。
- `STOCK_SNAPSHOT_MAX_BYTES`：快照响应大小上限，默认 12MiB，最大 50MiB。
- `STOCK_REFRESH_LOCK_STALE_MS`：本地或 Blob Worker 锁心跳失效阈值，默认 2 小时，最小 60 秒。
- `STOCK_TRADING_CALENDAR_HORIZON_DAYS`：持久化交易日历的前瞻天数，默认 45 天，可配置 7 至 370 天。
- `STOCK_YTD_FIXTURE_ENABLED=0`：在非生产环境显式关闭 Fixture；不能用于在生产开启 Fixture。

生产 Blob、快照网关和工作日调度已经接入。首次提供真实数据前仍需在 Vercel Production 直接配置轮换后的 `TUSHARE_TOKEN` 与独立 `CRON_SECRET`，运行严格首批 shadow 验收，确认 Tushare 端点权限/额度和数据源商用授权，并验证一次全量刷新能在 300 秒函数时限内完成。完成至少 10 个交易日影子对比和告警接入前，不应宣称已具备无人值守的数据 SLA。

### 股票工具测试

Node 单元与接口测试继续使用 `node tests/<name>.test.js` 运行。浏览器端回归覆盖 320px 移动端和桌面端：

```bash
npm install
npx playwright install chromium
npm run test:e2e
```

## 产品方案

### 工具定位

- 面向手机端快速使用的极简工具。
- 用户通过独立链接直接进入具体功能页，无需从首页跳转。
- 页面围绕输入、校对、结果、复制和演示状态展示五个核心动作。

### 错别字校对规则

- 仅修正错别字、多字、漏字和明显错误标点。
- 不调整原文句式、语序、用词和表达逻辑。
- 不做润色、扩写、缩写或风格调整。
- 无错时原样返回。
- 结果区域只展示修正后的完整文本。

### 移动端交互

- 大高度输入框，适合粘贴长文本。
- 提供示例文本，便于现场演示。
- 展示校对服务和规则/模型状态。
- 主按钮固定为单一核心动作：开始校对。
- 校对中禁用按钮并显示加载状态。
- 空内容提交给出轻提示。
- 超长文本提交前拦截，默认限制 5000 字。
- 结果支持一键复制，并反馈复制成功。

## 技术方案

- 选型：原生 HTML + CSS + JavaScript。
- 线上服务：Vercel Serverless Function + 讯飞 OpenAI 兼容 Qwen 模型，内置中文错词规则作为兜底。
- 本地增强：可选 Python 标准库 HTTP 服务 + 开源中文纠错模型。
- 路由：
  - `/index.html`：工具站入口。
  - `/tools/typo-proofreader/index.html`：错别字校对独立页面。
  - `/tools/stock-ytd-ranking/index.html`：股票 YTD 开发页面。
- API：前端默认请求同源 `/api/proofread`，Vercel 上由后端代理调用模型，前端不接触密钥。

### 校对方案

- 线上默认使用 `lib/modelProofreader.js` 调用大模型 OpenAI 兼容接口，适合处理 `反映物业不足为，要求物业旅行指责` 这类语义级错词。
- 支持多个免费模型提供商按顺序故障转移（讯飞 → 智谱 → 硅基流动 → 阿里云百炼）：某家返回 401/403/429（额度超限）或超时、宕机时自动切换到下一家，并短暂冷却失败的提供商（429/鉴权错误默认冷却 10 分钟，其余 1 分钟）。
- `lib/proofreader.js` 保留轻量中文错词规则，大模型全部未配置或全部失败时自动兜底。
- 密钥只配置在 Vercel 环境变量中，不写入前端或仓库。
- 本地如需开源模型增强，可运行 `server.py`，使用 `pycorrector` 加载 `shibing624/macbert4csc-base-chinese`。
- 后续若接入云端模型或自托管模型，只需替换 `/api/proofread` 的后端实现，前端接口无需变化。

## 开发规则

- 保持代码精简，基础功能不用重框架和复杂状态管理。
- 移动端优先，按钮高度不低于 48px，避免横向滚动。
- 页面功能只围绕核心任务，不增加弹窗、广告、历史记录、登录等非必要能力。
- 所有 API 配置集中在页面脚本顶部，便于后续替换。
- 不在仓库中提交真实 API Key、令牌或私密配置。
- 校对提示词必须保持强约束，禁止模型进行润色或解释。

## Vercel 部署

推送到 GitHub 后，Vercel 会自动部署静态页面和 `/api/*` Serverless Functions。

需要配置的生产环境变量（每家提供商只需配置 APIKey 即可启用，其余均有默认值）：

- `XFYUN_API_KEY`：讯飞 MaaS OpenAI 协议 APIKey，使用服务控制台提供的完整 key。
- `XFYUN_OPENAI_BASE_URL`：默认 `https://maas-api.cn-huabei-1.xf-yun.com/v2`。
- `XFYUN_MODEL`：服务卡片上的 `modelId`，默认 `xopqwen36v35b`。
- `XFYUN_LORA_ID`：服务卡片上的 `resourceId`，当前为 `0`。
- `ZHIPU_API_KEY`：智谱 BigModel APIKey（bigmodel.cn）。
- `ZHIPU_MODEL`：默认 `glm-4-flash-250414`（免费模型）。
- `SILICONFLOW_API_KEY`：硅基流动 APIKey（siliconflow.cn）。
- `SILICONFLOW_MODEL`：默认 `Qwen/Qwen2.5-7B-Instruct`（免费模型）。
- `DASHSCOPE_API_KEY`：阿里云百炼 APIKey。
- `DASHSCOPE_MODEL`：默认 `qwen-turbo`。
- `TYPO_PROVIDER_ORDER`：可选，逗号分隔的提供商顺序（`xfyun,zhipu,siliconflow,dashscope`），默认按此顺序。
- `TYPO_QUOTA_COOLDOWN_MS` / `TYPO_FAILOVER_COOLDOWN_MS`：可选，额度超限/一般失败后的冷却毫秒数。

健康检查 `/api/health` 会返回每个提供商的配置与冷却状态，便于排查。

线上访问：

- 工具站首页：`https://<your-vercel-domain>/`
- 错别字校对：`https://<your-vercel-domain>/tools/typo-proofreader/`
- 健康检查：`https://<your-vercel-domain>/api/health`

## 本地运行

### Vercel 本地预览

如果已安装 Vercel CLI，可直接运行：

```bash
vercel dev
```

访问：

- 工具站首页：`http://127.0.0.1:3000/`
- 错别字校对：`http://127.0.0.1:3000/tools/typo-proofreader/`
- A股年内表现：`http://127.0.0.1:3000/tools/stock-ytd-ranking/`

### 本地 MacBERT 增强版

安装依赖：

```bash
pip install -r requirements-local.txt
```

启动服务：

```bash
python server.py
```

访问：

- 工具站首页：`http://127.0.0.1:4173/`
- 错别字校对：`http://127.0.0.1:4173/tools/typo-proofreader/`

首次点击“开始校对”时，服务会下载并加载模型，耗时取决于网络和机器性能。后续请求会复用已加载模型。

### 环境变量

- `TYPO_HOST`：服务监听地址，默认 `127.0.0.1`。
- `TYPO_PORT`：服务端口，默认 `4173`。
- `TYPO_MODEL`：纠错模型，默认 `shibing624/macbert4csc-base-chinese`。
- `TYPO_MAX_TEXT_CHARS`：单次校对最大字符数，默认 `5000`。
- `TYPO_MAX_CHUNK_CHARS`：后端分段推理长度，默认 `220`。

### 接口验证

健康检查：

```bash
curl http://127.0.0.1:4173/api/health
```

校对接口：

```bash
curl -X POST http://127.0.0.1:4173/api/proofread \
  -H "Content-Type: application/json" \
  -d '{"text":"今天新情很好，我想去公圆玩。"}'
```

预期返回 JSON 中包含 `result`、`text` 或 `correctedText` 字段。

## 模型来源

- Vercel 线上：讯飞 MaaS OpenAI 兼容 Qwen 模型。
- 规则兜底：`built-in-chinese-typo-rules`
- Hugging Face：`shibing624/macbert4csc-base-chinese`
- Python 工具包：`pycorrector`

Vercel 线上版本优先使用大模型处理语义级错词，规则库保证基础可用性。本地 MacBERT 适合作为免费增强版测试；正式产品如需更强模型，可在后端替换，但前端接口可以保持不变。
