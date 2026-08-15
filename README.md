# 大杂烩工具站

移动端优先的轻量工具站。首页提供错别字校对、临时笔记本和飞机大战。

## 错别字校对

- 页面：`/tools/typo-proofreader/`
- 接口：`POST /api/proofread`
- 健康检查：`GET /api/health`

前端始终请求同源 `/api/proofread`。服务端优先调用配置的大模型，并在模型服务不可用时使用内置中文错词规则兜底。

## 本地运行

```bash
vercel dev
```

打开 `http://127.0.0.1:3000/`，或直接访问 `http://127.0.0.1:3000/tools/typo-proofreader/`。

## 部署

推送到 GitHub `main` 后，Vercel 会自动部署。模型密钥只配置在 Vercel 环境变量中，不提交到仓库。

## 验证

```bash
node tests/proofreader.test.js
node tests/modelProofreader.test.js
node tests/apiProofread.test.js
vercel build --yes
```
