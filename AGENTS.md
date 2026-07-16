# AGENTS.md

## Project Overview

- 项目名称：大杂烩工具站。
- 当前核心功能：移动端优先的中文错别字校对工具。
- 前端入口：`index.html` 和 `tools/typo-proofreader/index.html`。
- 线上 API：Vercel Serverless Functions，主要在 `api/proofread.js` 和 `api/health.js`。
- 线上域名：`https://1.688680.xyz/tools/typo-proofreader/`。
- GitHub 推送到 `main` 后，Vercel 会自动部署生产环境。

## Current Correction Pipeline

- 前端始终请求同源接口 `/api/proofread`，不要在前端直连模型服务。
- `api/proofread.js` 优先调用大模型（OpenAI 兼容接口），`lib/modelProofreader.js` 内置多提供商顺序故障转移：讯飞 → 智谱 → 硅基流动 → 阿里云百炼，某家 401/403/429/超时/宕机时自动切换并短暂冷却。
- `lib/modelProofreader.js` 封装提供商注册表、模型调用、prompt 和响应清洗。
- `lib/proofreader.js` 保留内置中文错词规则，作为模型不可用时的兜底。
- 模型返回修正文后，后端用 diff 生成 `corrections`，前端据此把原文错误字/标点标红。
- 典型验证句：`反映物业不足为，要求物业旅行指责` 应修正为 `反映物业不作为，要求物业履行职责`。

## Environment And Secrets

- 不要把 API Key、APISecret、APPID、token、cookie 或任何私密配置写入仓库。
- 模型提供商配置只放在 Vercel 环境变量中：
  - 讯飞：`XFYUN_API_KEY`、`XFYUN_OPENAI_BASE_URL`、`XFYUN_MODEL`、`XFYUN_LORA_ID`
  - 智谱：`ZHIPU_API_KEY`、`ZHIPU_MODEL`（默认 `glm-4-flash-250414`）
  - 硅基流动：`SILICONFLOW_API_KEY`、`SILICONFLOW_MODEL`
  - 阿里云百炼：`DASHSCOPE_API_KEY`、`DASHSCOPE_MODEL`
  - 顺序与冷却：`TYPO_PROVIDER_ORDER`、`TYPO_QUOTA_COOLDOWN_MS`、`TYPO_FAILOVER_COOLDOWN_MS`
- `.vercel/`、`.env*`、`.venv/` 等本地文件不要提交。
- 如果密钥在聊天、日志或截图中暴露，应提醒用户去平台控制台轮换密钥。

## Development Principles

- 优先用最少、最直接的代码解决问题，避免引入框架、构建链或复杂状态管理。
- 不要为了兼容未知场景增加大量抽象；确有产品需要时再扩展。
- 保持前端接口稳定：优先在 `/api/proofread` 后端内部替换能力。
- 前端只负责输入、发起校对、展示结果、标红原文错误和复制结果。
- 后端负责模型调用、规则兜底、错误处理和高亮范围生成。
- 修改功能时尽量补充或更新测试，尤其是用户明确提出的错句。
- 不要提交无关文件；当前可能存在无关未跟踪目录，提交前务必检查 `git status`。

## Useful Commands

- 运行规则和 diff 测试：`node tests/proofreader.test.js`
- 运行模型调用封装测试：`node tests/modelProofreader.test.js`
- 运行 API 集成测试：`node tests/apiProofread.test.js`
- Vercel 构建验证：`vercel build --yes`
- 查看线上部署：`vercel ls --scope chenxiaokais-projects`
- 查看生产环境变量列表：`vercel env ls --scope chenxiaokais-projects`

## Deployment Notes

- 提交前至少运行相关 Node 测试；涉及 Vercel API 时运行 `vercel build --yes`。
- 推送到 GitHub 后等待 Vercel 生产部署 `Ready`，再验证公开域名。
- 如果 `git push` 因全局本地代理 `127.0.0.1:10808` 不可用失败，可仅对单次命令禁用代理：
  - `git -c http.proxy= -c https.proxy= push origin main`
- 不要修改用户全局 Git 配置，除非用户明确要求。

## Product Behavior To Preserve

- 空输入时提示用户输入文本。
- 校对中禁用主按钮并显示加载状态。
- 校对完成后展示 toast，让用户感知操作完成。
- 下方显示修正后的完整文本。
- 上方原文中把本次发现的疑似错字或错误标点标红。
- 如果未发现错误，返回原文并提示未发现明显错误。

## Planned Stock YTD Ranking Tool

- 股票 YTD 与市场排名工具的产品、统计口径、UI 和验收基线位于 docs/stock-ytd-ranking/PRD.md。
- 多源数据职责、复权规则、质量闸门和容灾基线位于 docs/stock-ytd-ranking/DATA_SOURCES.md；历次数据管线重构的经验教训见 docs/stock-ytd-ranking/LESSONS.md。
- 2026-07-16 起主数据源为东财 f25 直取（reported-ytd.v1，`lib/stockEmYtd.js` + `scripts/refresh-stock-ytd-em.js`），Baostock/新浪自算管线保留为回退路径。
- 开始设计或开发 /tools/stock-ytd-ranking/ 前必须完整阅读以上两份文档。
- 如需改变 YTD 公式、比较股票池、北交所规则、排名分母、沪深300口径或 UI 颜色语义，应先更新 PRD 的决策与变更记录，不要只修改代码。
