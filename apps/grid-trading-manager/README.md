# 网格交易管理器

移动端优先的单文件 React 应用。计算引擎、账本、导入导出、行情与界面来自原项目；本站把账号与云同步改成了同源 Vercel API。

## 使用

无需账号即可离线使用，数据留在当前浏览器。注册后使用账号名与至少 10 位密码登录；注册时给出一次性恢复码，忘记密码时用它重置。任何人都可注册。每个账号的本地缓存按账号 ID 分开，云端快照只允许持有该账号会话的请求读写。访客数据不自动并入账号；需要转移时先导出 JSON，登录后再导入。

云端采用 Vercel 私有 Blob 存储，每个账号一份快照，按版本号条件写入。两台设备同时修改时弹窗让用户选择，不自动合并。删除云端备份不影响本机数据。密码和恢复码以带盐 scrypt / SHA-256 摘要保存；会话使用 HttpOnly、Secure、SameSite=Strict Cookie。恢复码只在注册及重置成功时显示，网站无法找回丢失的恢复码。

## 开发和部署

```sh
npm install
npm test
npm run build
```

将 `dist/index.html` 复制到仓库的 `tools/grid-trading-manager/index.html`。Vercel 项目必须连接私有 Blob 存储，并在 Production 环境设置随机的 `GRID_SESSION_SECRET`（至少 32 字符）。`BLOB_READ_WRITE_TOKEN` 和会话密钥只供服务端使用，不进入前端或 Git。静态页面请求同域 `/api/grid/auth` 和 `/api/grid/state`。

原 Workbuddy 账号与云端数据不迁移；这是用户确认过的选择。原 PRD 中邮件验证码、发布域名绑定、Workbuddy SDK/RLS 条款已由独立轻量账号方案替代；计算和本地功能仍沿用原 PRD。

