# 大杂烩工具站

移动端优先的轻量工具站，线上地址为 <https://1.688680.xyz/>。

## 最新关键进度（截至 2026-09-30）

网格交易管理器已于 2026-09-29 完成 Vercel 独立部署：首页入口直接打开本站页面，注册、登录、恢复密码和云备份均使用同域接口，不再依赖 Workbuddy。任何人都可注册，各账号的本机缓存与云端快照分别隔离。

迁移同时修复了本地保存失败未提示、账号切换可能混用数据，以及切换账号时恢复码未清除的问题。2026-09-30 复查生产部署为 `Ready`，首页、两项工具页面和健康接口均返回 `200`；未登录访问网格账号与数据接口返回 `401`。核心功能验收、已确认决策和当前限制见 [项目进度记录](docs/project-status.md)。

首页当前按顺序提供：

1. 错别字校对：`/tools/typo-proofreader/`，短链接 `/cbz`。
2. 临时笔记本：跳转至 <https://note.688680.xyz/>。
3. 飞机大战：`/shooter.html`。
4. 网格交易管理器：<https://1.688680.xyz/tools/grid-trading-manager/>，独立账号与云端同步，数据保存在 Vercel 私有 Blob 存储。

## 错别字校对

校对工具是本站的核心功能，支持两个模式：

- `typo`：修正错别字、同音或形近误写、多字漏字和明显错误标点。
- `deep`：在 `typo` 基础上，最小化修正逻辑不通和重复表达；不做润色、扩写或改变原意。

前端只调用同源 `/api/proofread`。服务端依次尝试已配置的大模型，所有模型失败时自动回退到内置中文错词规则；结果包含修正文和原文高亮所需的 `corrections`。

更完整的接口、模型和监控说明见 [docs/typo-proofreader/README.md](docs/typo-proofreader/README.md)。

## 网格交易管理器

源码和构建说明见 [apps/grid-trading-manager/README.md](apps/grid-trading-manager/README.md)。前端构建为单文件，发布文件是 `tools/grid-trading-manager/index.html`；账号与云备份使用同源 `/api/grid/` 接口。

## 运行与验证

```bash
vercel dev

node tests/proofreader.test.js
node tests/modelProofreader.test.js
node tests/apiProofread.test.js
node tests/proofreadMonitor.test.js
node --test tests/gridService.test.js
# 网格交易前端：在 apps/grid-trading-manager 中运行 npm test && npm run build
vercel build --yes
```

## 部署与配置

推送到 GitHub `main` 后，Vercel 会自动部署；也可以使用 `vercel --prod --yes` 直接发布。模型密钥、监控密钥和通知配置只放在 Vercel 环境变量或 GitHub Actions Secrets 中，绝不写入仓库。

`@vercel/blob` 用于校对服务监控状态和网格交易管理器的私有账号快照。网格交易的 `BLOB_READ_WRITE_TOKEN`、`GRID_SESSION_SECRET` 仅放在 Vercel Production 环境变量中。
