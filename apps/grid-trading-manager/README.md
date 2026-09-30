# 网格交易管理器

移动端优先的单文件 React 应用。计算引擎、账本、导入导出、行情与界面来自原项目；本站把账号与云同步改成了同源 Vercel API。

线上地址：<https://1.688680.xyz/tools/grid-trading-manager/>。截至 2026-09-30，独立迁移已上线，GitHub `main` 与生产部署一致。完整验收记录和关键提交见 [项目进度记录](../../docs/project-status.md)。

## 使用

无需账号即可离线使用，数据留在当前浏览器。注册后使用账号名与至少 10 位密码登录；注册时给出一次性恢复码，忘记密码时用它重置。任何人都可注册。每个账号的本地缓存按账号 ID 分开，云端快照只允许持有该账号会话的请求读写。访客数据不自动并入账号；需要转移时先导出 JSON，登录后再导入。

云端采用 Vercel 私有 Blob 存储，每个账号一份快照，按版本号和 ETag 条件写入。两台设备同时修改时弹窗让用户选择，不自动合并。删除云端备份不影响本机数据，后续编辑或其他设备上传可能重新生成备份。

账号名为 3–32 位英文字母、数字或下划线，统一转为小写；密码为 10–128 位。密码保存带盐 scrypt 摘要，随机恢复码保存 SHA-256 摘要。会话使用 HttpOnly、Secure、SameSite=Strict Cookie，有效期 30 天；重置密码会轮换恢复码并使原会话失效。恢复码只在注册及重置成功时返回，网站无法找回丢失的恢复码；登录其他账号或退出会清除页面中的旧恢复码。

## 同步行为与边界

- 修改先保存到本机，再合并 2.5 秒内的连续改动上传；本地保存失败会显示提示。
- 登录或刷新页面时拉取云端版本，再根据本机改动情况采纳、上传或提示冲突。页面常驻时不实时拉取其他设备的修改。
- 设置页“上传本机改动”执行上传；查看其他设备的新内容需要刷新页面。
- 访客与每个账号使用不同的本地存储键，账号切换期间等待相应数据加载后再启用同步。
- 云端只存当前快照，单份最多 `2 MiB`、最多 1000 个品种；不提供历史快照或账号注销。
- 自动行情通过浏览器请求用户配置的 URL，需允许跨域访问；默认不内置行情数据服务。

## 代码与接口

| 位置 | 职责 |
| --- | --- |
| `src/engine/` | 网格、金额精度、网结构校验、交易流水及触发量累加。 |
| `src/storage.ts`、`src/App.tsx` | 数据编解码、按账号落盘及保存失败提示。 |
| `src/hooks/useAccount.ts` | 账号表单与登录态；无登录痕迹时不自动请求账号接口。 |
| `src/hooks/useCloudSync.ts`、`src/cloud/` | 同源请求、登录后比对、延迟上传和冲突选择。 |
| `../../api/grid/` | 账号与快照接口。 |
| `../../lib/gridService.js` | 认证、恢复码、数据隔离和版本校验。 |
| `../../lib/gridStore.js`、`../../lib/gridHttp.js` | 私有 Blob 条件读写、Cookie、来源检查与错误响应。 |

| 接口 | 请求与行为 |
| --- | --- |
| `GET /api/grid/auth` | 查询当前用户；未登录返回 `401`。 |
| `POST /api/grid/auth` | JSON 的 `action` 为 `register`、`login`、`reset` 或 `logout`；注册/登录使用 `username`、`password`，重置另需 `recoveryCode`。 |
| `GET /api/grid/state` | 返回 `kind: empty`，或含 `rev`、`data`、`updatedAt` 的当前快照。 |
| `PUT /api/grid/state` | 提交 `data`、`baseRev`、`clientId`；首次写入的 `baseRev` 为 `null`，版本不符返回 `409`。 |
| `DELETE /api/grid/state` | 删除当前登录账号的云端快照。 |

写操作检查同源 `Origin`，带请求体时使用 `application/json`；所有账号与数据响应均为 `no-store`。快照接口根据会话确定所有者，不接受客户端指定的账号 ID。错误响应包含可读的 `error` 与诊断 `code`。

## 开发和部署

从仓库根目录运行（PowerShell）：

```powershell
npm --prefix apps/grid-trading-manager install
npm --prefix apps/grid-trading-manager test
npm --prefix apps/grid-trading-manager run build
Copy-Item apps/grid-trading-manager/dist/index.html tools/grid-trading-manager/index.html -Force
node --test tests/gridService.test.js
```

浏览器离线冒烟使用 Python Playwright 与系统 Edge；Windows 下设置输出编码后运行：

```powershell
$env:PYTHONIOENCODING = 'utf-8'
python apps/grid-trading-manager/smoke_test.py
```

该脚本验证本机功能和表单，不走真实注册与云同步。Vite 开发服务可用于前端预览，账号功能依赖同源 Vercel API。

Vercel 项目须连接私有 Blob 存储，并在 Production 设置 `BLOB_READ_WRITE_TOKEN` 与随机的 `GRID_SESSION_SECRET`（至少 32 字符）。它们只供服务端使用，不进入前端或 Git。会话密钥更换后现有登录会话将失效。

源码 `apps/`、测试 `tests/` 被 `.vercelignore` 排除；Vercel 发布的是已复制的 `tools/grid-trading-manager/index.html` 和服务端函数。前端修改后必须一起提交新的单文件产物，不能只提交源码。涉及 API 修改时运行 `vercel build --prod --yes --scope chenxiaokais-projects`，推送 `main` 后等待生产部署 `Ready` 并验证公开域名。

## 迁移范围

原 Workbuddy 账号与云端数据不迁移；这是用户确认过的选择。原 PRD 中邮件验证码、发布域名绑定、Workbuddy SDK/RLS 条款已由独立轻量账号方案替代；计算和本地功能仍沿用原 PRD。

