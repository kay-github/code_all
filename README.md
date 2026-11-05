# 大杂烩工具站

移动端优先的轻量工具站，线上地址为 <https://1.688680.xyz/>。

## 最新关键进度（截至 2026-09-30）

网格交易管理器已于 2026-09-29 完成 Vercel 独立部署：首页入口直接打开本站页面，注册、登录、恢复密码和云备份均使用同域接口，不再依赖 Workbuddy。任何人都可注册，各账号的本机缓存与云端快照分别隔离。

迁移同时修复了本地保存失败未提示、账号切换可能混用数据，以及切换账号时恢复码未清除的问题。2026-09-30 复查生产部署为 `Ready`，首页、两项工具页面和健康接口均返回 `200`；未登录访问网格账号与数据接口返回 `401`。核心功能验收、已确认决策和当前限制见 [项目进度记录](docs/project-status.md)。

首页和侧栏按分类展示工具。工作台保留已打开工具的页面状态，切换时可以继续先前的操作。

- **投资交易**包含 333 投资理论和网格交易管理器。
- **效率工具**包含主站 `/notes` 的临时笔记本，原域名继续服务。
- **市场研究**包含股票回撤研究室、量能观察台、光通信跌幅榜和国家队 ETF 追踪。

## 333投资理论

- **仓位**以加权平均法从流水计算持股、成本、现金、已实现和浮动盈亏。三个仓位目标可调整，默认各 30%，另有 10% 未分配。
- **目标**按远期、中期和短期保存目标，可在页面中检查价格、市值、PE TTM、指数点位和涨跌幅条件。
- **方向**分别记录已披露基本面、机构预测和技术资金观察。市场情绪和拥挤度读取有日期的金融工作台快照。

账本默认保存在浏览器，可导出或恢复 JSON。网格交易账号可用于手动上传和恢复云备份，333 和网格数据分别存储。后台推送和自动研报采集留待后续。

## 首页入口管理

后台地址：<https://1.688680.xyz/admin>。可修改网站名称和简介，新增、删除、排序、隐藏入口，编辑名称、描述、链接、文字图标、配色，以及是否新窗口打开。每个入口可直接上传图片作为图标，上传后显示预览，点击「保存更改」后首页生效；支持移除图片恢复文字图标，也保留可选图片链接。首页保持原有默认入口作为网络故障时的兜底。

前端只调用同源 `/api/site/auth`、`/api/site/config` 和 `/api/site/image`。配置、登录限流和会话保存在已有 Vercel 私有 Blob 的独立 `tool-site/` 路径，不影响网格账号或工作门户。公开配置接口只返回显示中的入口；后台完整配置和写入操作需要有效会话。并发编辑通过版本号和 ETag 检查，冲突时要求重新加载。

图片上传支持 JPG、PNG、WebP、GIF 和 AVIF，原文件最大 10 MB、4000 万像素。浏览器先将图片压缩至最长边 256 像素，再上传；服务端校验登录、CSRF、请求来源、文件大小、真实格式和尺寸，并使用 Sharp 重新编码为 WebP、清除元数据。动态图仅取首帧。服务器接收的压缩文件最大 2 MB，不接受 SVG 或脚本。图片以内容哈希存入私有 Blob 的 `tool-site/icons/`，通过同源图片接口公开读取，接口不能访问其他私有文件。重复内容复用同一地址；更换或移除图片只解除入口关联，保留旧文件避免影响其他使用同图的入口。

仅在 Vercel Production 中配置 `SITE_ADMIN_PASSWORD_HASH` 和 `SITE_SESSION_SECRET`，另需已有的 `BLOB_READ_WRITE_TOKEN`。密码区分大小写，不做空格或大小写转换；不在代码中设置默认密码。哈希格式为 `scrypt:32768:<16字节盐的hex>:<32字节派生密钥的hex>`，scrypt 使用 N=32768、r=8、p=1，盐按 hex 文本作为输入；会话密钥至少 32 个字符，建议使用 32 字节随机值的 hex。所有密钥或哈希均不可提交。修改哈希或会话密钥会使已有会话失效。

登录限制跨函数实例共享：每 IP 每 15 分钟最多 8 次失败尝试，全站每 15 分钟最多 40 次尝试。成功登录重置该 IP 的失败计数，但保留全站计数。会话 4 小时过期，退出会在服务端撤销；令牌仅通过 `__Host-` 前缀的 Secure、HttpOnly、SameSite=Strict Cookie 传递。写入另有严格同源校验和 CSRF 令牌，页面设置 CSP、禁止嵌入和搜索收录。后台认证只接受主域名 `1.688680.xyz`，本地测试允许 localhost/127.0.0.1。

验证：`npm run test:site`，发布前执行 `vercel build --yes`。固定密码仍应保密；若泄露，需重新生成哈希并更新生产环境变量，然后重新部署。

## 股票回撤研究室

使用说明、行情复权约定、API、算法和本地启动见 [tools/stock-rebound-lab/README.md](tools/stock-rebound-lab/README.md)。本地执行 `npm run dev:stocks`，测试执行 `npm run test:stocks`。在线版无需登录，持仓与研究记录保存在浏览器；支持 JSON/CSV 导入导出及 Excel 情景导出。

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
