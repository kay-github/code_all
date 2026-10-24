# 工作台与管理后台

- 前台：`https://b.688680.xyz/`，入口为 `index.html`。
- 后台：`https://b2.688680.xyz/`，备用入口为 `https://b.688680.xyz/houtai`。
- 后台页面为 `houtai.html`，通过同源 `/api/portal/auth` 登录，通过 `/api/portal/config` 管理入口的名称、URL、备注，支持新增、删除和上移/下移排序，最多 50 个入口，也可保存空列表。结构调整与字段修改统一保存后生效。
- 独立内嵌模式：`https://b.688680.xyz/iframe`，首页按钮可进入。顶部按钮与首页使用同一份云端配置，下方 iframe 显示所选入口，可通过 URL hash 定位入口。配置刷新不会重新加载当前地址未变的表单。
- 第三方的 iframe 限制、登录或 Cookie 策略仍由第三方决定，页面保留新窗口打开功能；HTTPS 页面中的 HTTP 入口（包括现有内网系统）显示新窗口访问提示，避免混合内容阻止加载。
- 配置存入现有私有 Vercel Blob 的独立 `work-portal/config.json`。初始值在 `lib/portalService.js`，已有配置不会被重新部署覆盖。
- Production 环境使用 `PORTAL_ADMIN_PASSWORD_HASH`（scrypt 盐值与摘要）和 `PORTAL_SESSION_SECRET`。密码不写入前端或仓库；登录会话保存在 HttpOnly Cookie 中，有效期八小时。
- 保存使用配置版本号和 Blob ETag，冲突时要求重新加载。前台始终读取最新配置，不使用第三方脚本或字体。

验证：`node --test tests/portalService.test.js`，涉及 API 的发布还需运行 `vercel build --yes`。推送本项目 `main` 后由 Vercel 自动部署。
