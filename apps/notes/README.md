# Quick Space

Quick Space 是一个免登录的跨设备临时笔记本，适合在少量可信用户之间传递文本、图片、视频和文件。

## 工具站集成

本应用迁自 `D:\code_note\myapp_note` 的 `7ff02a1`，在工具站仓库的 `apps/notes` 构建。应用路径为 `/notes`，后台为 `/notes/admin`，API 和静态资源也位于这个前缀下。登录会话只作用于 `/notes`。用户进入新入口后用原密码重新解锁。

- 本地启动后访问 `http://localhost:3000/notes`。联调和 CI 使用独立 PostgreSQL。
- 生产继续使用现有 `myapp-note` Vercel 项目的数据库、Blob、管理员密码、会话密钥和数据密钥。只改入口时沿用数据库结构和密码哈希。普通构建使用 `bun run build`，数据库迁移单独运行。
- 部署切换前先执行下方备份与恢复流程，再暂存生产部署。验证原密码、笔记、附件字节和回滚地址后切换。新版本的旧链接兼容仅针对 `note.688680.xyz` 的首页和空间页，跳到同一域名下的 `/notes`。切换前应完成旧页面里的保存和上传。
- 主站 `vercel.json` 将 `/notes` 转发到 `myapp-note`。生产项目连接工具站仓库的 `main`，以 `apps/notes` 为构建根目录。菜单使用 `/notes/`，原域名也访问同一份数据。

如果主站转发异常，先把工具入口恢复为 `https://note.688680.xyz/`，使用户可以经旧域名继续访问。

## 功能

- 首页展示全部空间；公共空间默认可读，私有空间需要密码
- 文本写入、文件上传、粘贴图片和删除资源需要空间写权限
- 管理员可创建、修改、删除空间，并进入任意空间
- 空间内容每 25 秒以及页面重新聚焦时检查更新
- 文本保存使用原子版本检查，冲突时由用户确认是否覆盖
- 多文件上传按 3 个一组并发执行，分别报告成功、失败和后台登记状态
- 未保存文本在远端刷新时保留，关闭或刷新页面前会触发浏览器提醒

## 技术栈

- Next.js App Router + React + TypeScript
- Bun
- Prisma + PostgreSQL
- Vercel Blob（大文件）+ PostgreSQL（元数据和小文件兜底）
- AES-256-GCM 应用层加密

## 环境变量

先复制示例文件：

```bash
cp .env.example .env
```

生产环境必须设置以下变量：

| 变量 | 用途 |
| --- | --- |
| `DATABASE_URL` | PostgreSQL 连接串；也支持下文列出的 Vercel Postgres 回退变量 |
| `ADMIN_PASSWORD` | 管理后台密码，必须使用未公开的独立强密码 |
| `SESSION_SECRET` | Cookie 签名密钥 |
| `DATA_ENCRYPTION_KEY` | 内容加密密钥，必须与 `SESSION_SECRET` 不同 |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob 私有存储读写令牌 |
| `DEFAULT_SPACE_SLUG` | 默认公共空间路径 |
| `DEFAULT_SPACE_TITLE` | 默认公共空间标题 |

可用 `openssl rand -base64 48` 分别生成 `SESSION_SECRET` 和 `DATA_ENCRYPTION_KEY`。两个值必须独立生成，不能复用。

Vercel 注入的下列 PostgreSQL 变量可作为 `DATABASE_URL` 回退：

- `POSTGRES_PRISMA_URL`
- `POSTGRES_URL`
- `POSTGRES_PRISMA_POSTGRES_URL`
- `POSTGRES_PRISMA_PRISMA_DATABASE_URL`

非 Vercel 部署若使用 Blob 客户端直传，还需将公开 HTTPS 站点根地址设置为 `VERCEL_BLOB_CALLBACK_URL`，例如 `https://space.example.com`。SDK 会自动附加 `/api/blob/upload` 路径。该地址必须能被 Vercel Blob 服务访问；本机开发需要公网隧道，否则应不配置 Blob 令牌并使用数据库上传兜底。

`ALLOW_PRODUCTION_MIGRATIONS` 不是常驻运行时配置。只在受控的生产迁移任务中临时设为 `1`，不要配置到普通预览或应用运行环境。

## 本地启动

```bash
bun install
bun run prisma:generate
bunx prisma migrate deploy
bun run dev
```

打开 `http://localhost:3000/notes`。

`bun run prisma:push` 只允许用于可随时丢弃的本地数据库。正常的 schema 变更应创建迁移：

```bash
bunx prisma migrate dev --name describe_the_change
```

迁移文件必须提交到 `prisma/migrations/`。

## 数据库迁移

### 新数据库

新数据库直接执行全部已提交迁移：

```bash
bunx prisma migrate deploy
bunx prisma migrate status
```

### 从旧版 `db push` 数据库升级

旧部署可能已经有业务表，但没有 `_prisma_migrations` 历史。不能直接对非空数据库执行 baseline，也不能继续在生产环境运行 `db push`。

1. 先备份 PostgreSQL，并在测试恢复库演练以下步骤。
2. 核对现有 `Space`、`Note`、`Asset`、`AuditLog` 表与 `20260224000000_baseline` 一致。
3. 仅在确认 baseline 的结构已经存在后，将其标记为已应用：

```bash
bunx prisma migrate resolve --applied 20260224000000_baseline
ALLOW_PRODUCTION_MIGRATIONS=1 bun run prisma:migrate:deploy
bunx prisma migrate status
```

`20260816000000_reliability_hardening` 会创建 PostgreSQL 限流表和查询索引。不要把尚未执行的迁移标记为已应用。若 `migrate status` 已显示 baseline，跳过 `resolve`。

**生产环境禁止 `prisma db push`。** 生产发布只允许 `prisma migrate deploy`，也不要使用 `migrate dev`。应用回滚不会自动回滚数据库结构，失败时优先编写向前修复迁移。

## 加密格式与 v1 升级

新写入的数据使用独立 `DATA_ENCRYPTION_KEY`：

- 文本格式：`enc:v2:`
- PostgreSQL 二进制附件前缀：`ENC2`
- 算法：AES-256-GCM

读取逻辑继续兼容旧 `enc:v1:` / `ENC1` 数据。旧版 v1 可能使用当时的 `DATA_ENCRYPTION_KEY`，也可能在未配置数据密钥时回退使用当时的 `SESSION_SECRET`。

升级时遵循以下顺序：

1. 备份数据库、Blob 文件和当前密钥。
2. 如果旧部署已经配置独立 `DATA_ENCRYPTION_KEY`，必须原样沿用。
3. 如果旧部署没有数据密钥，创建新的独立 `DATA_ENCRYPTION_KEY`，同时保持旧 `SESSION_SECRET` 不变，以便读取 v1 数据。
4. 部署后，新建或重新保存的文本会写成 v2；v1 数据不会自动批量改写。
5. 文本可通过读取后重新保存迁移；数据库附件需在旧密钥仍可用时下载验证、重新上传，并确认新附件可读后再删除旧附件。
6. 确认所有 v1 数据清零后，才可轮换旧 `SESSION_SECRET`。

v2 一旦写入，旧版本应用无法识别或解密新格式。部署后的故障应优先使用当前版本的向前修复；不要把应用直接回滚到只支持 v1 的提交。确需应用回退时，必须先提供兼容 v2 的回退版本，并保持当前数据密钥可用。

可用以下只读查询盘点 v1 数据：

```sql
SELECT id, "spaceId" FROM "Note" WHERE content LIKE 'enc:v1:%';

SELECT id, "spaceId"
FROM "Asset"
WHERE storage = 'db'
  AND "data" IS NOT NULL
  AND substring("data" FROM 1 FOR 4) = decode('454e4331', 'hex');
```

仓库目前没有自动批量重加密工具。记录较多时应编写一次性、可校验且可恢复的迁移程序；在完成前不要单独修改 `DATA_ENCRYPTION_KEY` 或遗失旧 `SESSION_SECRET`。

## Blob 上传与可信边界

Blob 直传采用服务端完成回调，而不是接受客户端提交任意 Blob URL：

1. `/api/blob/upload` 校验空间写权限、文件名、MIME、大小和限流，再签发 10 分钟客户端令牌。
2. Vercel Blob 上传完成后调用同一路由的 `onUploadCompleted`。
3. 服务端用 Blob `head` 校验实际大小和类型，再以 URL 派生的稳定 ID 幂等写入 `Asset`。
4. 客户端只轮询 `GET /api/spaces/[slug]/assets/register?blobUrl=...` 确认登记；旧的客户端 POST 登记已禁用。

只有满足以下条件的 URL 才会被登记、签名、代理读取或删除：HTTPS、主机名以 `.blob.vercel-storage.com` 结尾、不含用户名/密码、路径非空。上传回调发现空间不存在或大小不匹配时会尝试删除 Blob。应监控 `blob-upload:*` 日志；回调长期不可达仍可能产生未登记对象，需要通过 Blob 控制台与 `Asset.blobUrl` 定期核对。

## PostgreSQL 限流

限流桶存放在 `RateLimitBucket`，使用 PostgreSQL 原子 upsert，因此多个 Serverless 实例共享计数，不依赖单进程内存：

- 管理员解锁：每 IP 每 5 分钟 12 次
- 空间解锁：每 IP + 空间每 5 分钟 16 次
- Blob 上传令牌：每 IP 每 5 分钟 60 次
- 数据库上传兜底：每 IP + 空间每 5 分钟 30 次

超限返回 429。约 1% 的限流请求会顺带清理已过期 24 小时以上的桶。`RateLimitBucket` 不存在或数据库不可用时相关请求会失败，因此部署前必须完成 reliability migration。

## 测试与 CI

提交前统一运行：

```bash
bun run check
```

该命令依次执行 ESLint、TypeScript `--noEmit` 和 Bun 测试。当前测试覆盖：

- v2 文本/二进制加解密、v1 `SESSION_SECRET` 兼容和篡改检测
- 同一基准版本的原子并发保存
- Vercel Blob URL 信任边界与安全下载响应头

`.github/workflows/ci.yml` 使用 PostgreSQL 16 临时服务，执行以下门禁：

- 锁文件安装与 Prisma Client 生成
- Prisma schema 校验、全部迁移回放和 schema parity 检查
- 依赖漏洞审计、ESLint、TypeScript、Bun 测试和生产构建

本地可用 `bun run check` 复现代码检查；连接隔离数据库后可额外执行 `bun run prisma:migrate:check`。不要让 PR 或预览环境连接生产数据库。涉及真实 Blob 回调和双浏览器同步的流程仍需在 staging 做集成/E2E 验证。

## 生产部署

1. 确认 PostgreSQL 与 Blob 备份可恢复。
2. 为目标环境配置全部必需变量；`ADMIN_PASSWORD`、`SESSION_SECRET`、`DATA_ENCRYPTION_KEY` 必须是互不复用的生产值。
3. 非 Vercel 环境配置可公开访问的 `VERCEL_BLOB_CALLBACK_URL`。
4. 执行 `bun run check`，并在 staging 验证迁移。
5. 对旧 `db push` 数据库完成一次 baseline；随后在明确授权的生产迁移步骤执行：

```bash
ALLOW_PRODUCTION_MIGRATIONS=1 bun run prisma:migrate:deploy
```

6. 发布应用。普通 `bun run build` 只生成 Prisma Client 并构建 Next.js，不修改数据库；`bun run build:production` 也要求 `ALLOW_PRODUCTION_MIGRATIONS=1` 才会在构建后部署迁移。推荐将迁移作为单独、单实例的受控发布步骤。
7. 冒烟验证：首页、公共/私有空间解锁、文本保存冲突、Blob 上传登记、下载和删除。
8. 检查 Vercel Function Runtime Logs，重点关注 `ratelimit`、`blob-upload`、`asset-download` 和解密错误。

部署后的基础回归可使用会自动清理临时空间的脚本：

```bash
SMOKE_BASE_URL=https://space.example.com ADMIN_PASSWORD='...' bun run smoke:production
```

脚本覆盖全局安全头、管理员会话、原子并发保存、清空冲突和 HTML 附件强制下载。真实 Blob 回调仍需在存储处于 Active 状态时单独验证。

不要把生产数据库迁移委托给多个共享同一数据库的预览部署。首次升级和密钥迁移应安排维护窗口。

## 备份与恢复

PostgreSQL 是空间、文本、附件元数据和数据库兜底附件的权威数据源；Vercel Blob 保存直传文件的实际字节。只备份数据库不能恢复 Blob 文件。

建议至少每日备份，并在迁移、依赖升级或密钥轮换前额外备份：

```bash
pg_dump --format=custom --no-owner --no-acl \
  --dbname "$DATABASE_URL" \
  --file "quick-space-$(date +%Y%m%d-%H%M%S).dump"
```

同时导出或复制 Vercel Blob 对象，并保留原 URL/路径清单。密钥应保存在独立的密钥管理器中，不要放进数据库备份或仓库。

恢复流程：

1. 先恢复到隔离环境，确认目标数据库地址，避免覆盖生产库。
2. 配置备份时对应的 `DATA_ENCRYPTION_KEY`；若仍有 v1 数据，还必须配置备份时的 `SESSION_SECRET`。
3. 用专门的恢复连接串还原 PostgreSQL：

```bash
pg_restore --no-owner --no-acl \
  --dbname "$RESTORE_DATABASE_URL" \
  quick-space-YYYYMMDD-HHMMSS.dump
```

确认恢复结果后，将 `DATABASE_URL` 指向该恢复库并执行 `bunx prisma migrate deploy`，补齐备份时间点之后的迁移。不要在未核对 `RESTORE_DATABASE_URL` 时加入 `--clean` 或指向生产库。

4. 恢复 Blob 对象并核对每个 `Asset.blobUrl`。若无法保持原 URL，需经过可信 URL 校验后更新元数据并逐个验证下载。
5. 运行 `bun run check`，完成读、写、上传、下载、冲突和权限冒烟测试后再切换流量。

定期在 staging 做完整恢复演练；未演练的备份不能视为可恢复。

## 生产密钥轮换

- `ADMIN_PASSWORD`：更新环境变量并重新部署。管理员 Cookie 绑定当前密码的密钥化指纹，因此新部署生效后旧管理员会话会失效。
- 空间密码：通过管理端修改；密码哈希指纹变化会立即使该空间旧会话失效。
- `SESSION_SECRET`：轮换会使全部管理员和空间 Cookie 失效。若仍有使用旧会话密钥加密的 v1 数据，必须先完成 v1 迁移。
- `DATA_ENCRYPTION_KEY`：不能只改环境变量。v2 只读取当前数据密钥，直接更换会使现有 v2 数据不可读；必须在维护窗口使用旧密钥解密、用新密钥重加密、校验和备份后再切换。仓库目前未提供自动轮换工具。
- `BLOB_READ_WRITE_TOKEN`：在 Vercel 侧轮换后更新所有运行环境并重新部署，再验证上传、签名下载和删除。
- 数据库凭据：先创建新凭据、更新 `DATABASE_URL` 并验证连接，确认所有实例切换后再撤销旧凭据。

每次轮换都应记录时间、操作者、受影响环境、备份位置、验证结果和回滚条件，且不得把真实密钥写入 Git、日志或工单正文。

## 默认限制与性能说明

- 单文件上限 50MB；空间路径为 `[a-zA-Z0-9_-]`，长度 `3~30`
- 默认公共空间仅在首次缺失时创建
- 空间页只查询附件元数据，首页附件数使用 `_count`
- 审计日志通过 `next/server` 的 `after()` 在响应后写入
- Blob 下载通过鉴权后的 10 分钟签名 CDN URL；签名失败时使用受信任 SDK 代理
- 下载响应为 `private, no-store`，主动内容强制作为附件并使用 `nosniff`
