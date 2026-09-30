# 错别字校对工具

线上页面：<https://1.688680.xyz/tools/typo-proofreader/>。短链接：<https://1.688680.xyz/cbz>。

这是一个移动端优先的中文校对工具。用户输入文本后，页面展示修正后的完整文本，并在原文中标红本次发现的疑似错误范围。

## 功能边界

页面提供两个校对模式：

| 模式 | 请求值 | 行为 |
| --- | --- | --- |
| 错别字校对 | `typo` | 修正错别字、同音或形近误写、多字漏字和明显错误标点。 |
| 深度校对 | `deep` | 在 `typo` 基础上，最小化修正逻辑不通、关联词误用和重复表达。 |

两种模式都不做润色、扩写、缩写或改变原意。未发现明显错误时，返回原文。

典型验证句：`反映物业不足为，要求物业旅行指责` 应修正为 `反映物业不作为，要求物业履行职责`。

页面中可勾选“优先用 Google 模型”。该选项只会把已配置的 Gemini 提到故障转移链首位，失败后仍会依次尝试其他已配置服务。

## 架构

| 文件 | 职责 |
| --- | --- |
| `tools/typo-proofreader/index.html` | 原生 HTML、CSS、JavaScript 前端；双模式、原文高亮、复制和状态展示。 |
| `api/proofread.js` | 同源校对接口；模型优先、规则兜底、响应与错误处理。 |
| `api/health.js` | 返回可用提供商、冷却状态和文本长度上限。 |
| `lib/modelProofreader.js` | 提供商注册、模型请求、故障转移、冷却与响应清洗。 |
| `lib/proofreader.js` | 内置中文错词规则与 diff 高亮范围计算。 |
| `api/proofread-monitor.js` | 受保护的模型探活与告警入口。 |
| `lib/proofreadMonitor.js`、`lib/pushplus.js` | 监控分级、状态机和 PushPlus 通知。 |
| `.github/workflows/typo-monitor.yml` | 每两小时触发一次监控端点。 |

## API

### 校对

`POST /api/proofread`

请求体：

```json
{
  "text": "反映物业不足为，要求物业旅行指责",
  "mode": "typo",
  "preferGoogle": false
}
```

- `text` 必填；也兼容 OpenAI 风格的 `messages` 最后一条用户文本和 `input` 字段。
- `mode` 只能是 `typo` 或 `deep`，省略或非法值按 `typo` 处理。
- `preferGoogle` 为 `true` 时优先尝试 Gemini。

成功响应包含：

```json
{
  "result": "反映物业不作为，要求物业履行职责",
  "corrections": [],
  "mode": "typo",
  "model": "实际模型名称",
  "provider": "实际提供商名称",
  "attempts": [],
  "fallback": false
}
```

`result`、`text` 与 `correctedText` 始终是同一份修正文。`corrections` 用于前端标红原文；`attempts` 记录本次已失败的模型尝试；`fallback` 为 `true` 表示所有模型不可用，结果来自内置规则。

空文本返回 `400`，文本超过服务端上限返回 `413`，非 `POST` 请求返回 `405`。接口支持 `OPTIONS` 和跨域响应头。

### 健康检查

`GET /api/health` 返回当前可用提供商、每家配置与冷却状态，以及 `maxTextChars`。它不返回任何密钥。

### 监控

`POST` 或 `GET /api/proofread-monitor` 需要 `x-monitor-secret`，或 `Authorization: Bearer <MONITOR_SECRET>`。GitHub Actions 使用 `POST`；该接口仅供监控和运维使用，不应暴露密钥给前端。

它会探测每个已配置提供商。连续失败达到确认轮次后才升级告警，避免短暂网络波动造成通知噪声。若 Vercel 注入 `BLOB_READ_WRITE_TOKEN`，监控状态会存入私有 Blob；未配置时校对功能不受影响，但响应会标记状态未持久化。

## 模型与故障转移

默认尝试顺序为：讯飞、智谱、硅基流动、阿里云百炼、Google Gemini。`TYPO_PROVIDER_ORDER` 可以重新排序；未配置密钥的服务会自动跳过。

| 提供商 | 必需变量 | 可选变量 |
| --- | --- | --- |
| 讯飞 | `XFYUN_API_KEY` | `XFYUN_OPENAI_BASE_URL`、`XFYUN_MODEL`、`XFYUN_LORA_ID`、`XFYUN_TIMEOUT_MS` |
| 智谱 | `ZHIPU_API_KEY` | `ZHIPU_BASE_URL`、`ZHIPU_MODEL`、`ZHIPU_TIMEOUT_MS` |
| 硅基流动 | `SILICONFLOW_API_KEY` | `SILICONFLOW_BASE_URL`、`SILICONFLOW_MODEL`、`SILICONFLOW_TIMEOUT_MS` |
| 阿里云百炼 | `DASHSCOPE_API_KEY` | `DASHSCOPE_BASE_URL`、`DASHSCOPE_MODEL`、`DASHSCOPE_TIMEOUT_MS` |
| Google Gemini | `GEMINI_API_KEY` | `GEMINI_BASE_URL`、`GEMINI_MODEL`、`GEMINI_TIMEOUT_MS` |

模型请求使用 OpenAI 兼容的 `/chat/completions` 格式。401、403、429 默认进入较长冷却；其他失败与超时使用较短冷却。可用 `TYPO_QUOTA_COOLDOWN_MS` 与 `TYPO_FAILOVER_COOLDOWN_MS` 调整。

## 监控与通知配置

- `MONITOR_SECRET`：保护监控端点；同时配置为 Vercel Production 环境变量和 GitHub Actions Secret。
- `PUSHPLUS_TOKEN`：可选，配置后在等级变化时发送通知。
- `PUSHPLUS_ENDPOINT`、`PUSHPLUS_TOPIC`、`PUSHPLUS_TIMEOUT_MS`：可选 PushPlus 配置。
- `MONITOR_CONFIRM_ROUNDS`、`MONITOR_FALLBACK_KEYS`、`MONITOR_QUIET_START`、`MONITOR_QUIET_END`、`MONITOR_HEALTH_URL`：可选监控策略配置。
- `BLOB_READ_WRITE_TOKEN`：由 Vercel 私有 Blob 连接注入；本工具用它持久化监控状态，网格交易管理器也使用同一服务端配置保存账号记录和云端快照，按不同路径存储。

不要将上述密钥写入仓库、截图、聊天记录或浏览器前端。若密钥已暴露，应立即在对应平台轮换。

## 验证与发布

```bash
node tests/proofreader.test.js
node tests/modelProofreader.test.js
node tests/apiProofread.test.js
node tests/proofreadMonitor.test.js
vercel build --yes
```

推送至 GitHub `main` 会触发生产部署。需要立即发布时，使用：

```bash
vercel --prod --yes --scope chenxiaokais-projects
```
