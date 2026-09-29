# 大杂烩工具站

移动端优先的轻量工具站，线上地址为 <https://1.688680.xyz/>。

首页当前按顺序提供：

1. 错别字校对：`/tools/typo-proofreader/`，短链接 `/cbz`。
2. 临时笔记本：跳转至 <https://note.688680.xyz/>。
3. 飞机大战：`/shooter.html`。
4. 网格交易管理器：跳转至 <https://grid-trading-manager.app.workbuddy.host/>，保留原站点的账号和云端同步功能。

## 错别字校对

校对工具是本站的核心功能，支持两个模式：

- `typo`：修正错别字、同音或形近误写、多字漏字和明显错误标点。
- `deep`：在 `typo` 基础上，最小化修正逻辑不通和重复表达；不做润色、扩写或改变原意。

前端只调用同源 `/api/proofread`。服务端依次尝试已配置的大模型，所有模型失败时自动回退到内置中文错词规则；结果包含修正文和原文高亮所需的 `corrections`。

更完整的接口、模型和监控说明见 [docs/typo-proofreader/README.md](docs/typo-proofreader/README.md)。

## 运行与验证

```bash
vercel dev

node tests/proofreader.test.js
node tests/modelProofreader.test.js
node tests/apiProofread.test.js
node tests/proofreadMonitor.test.js
vercel build --yes
```

## 部署与配置

推送到 GitHub `main` 后，Vercel 会自动部署；也可以使用 `vercel --prod --yes` 直接发布。模型密钥、监控密钥和通知配置只放在 Vercel 环境变量或 GitHub Actions Secrets 中，绝不写入仓库。

`@vercel/blob` 仅用于校对服务监控状态，不承载行情、YTD 或其他股票数据。
