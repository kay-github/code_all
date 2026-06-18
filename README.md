# 大杂烩工具站

一个移动端优先的轻量 H5 工具站。当前已落地独立子功能：错别字校对。

## 产品方案

### 工具定位

- 面向手机端快速使用的极简工具。
- 用户通过独立链接直接进入具体功能页，无需从首页跳转。
- 页面围绕输入、校对、结果、复制和演示状态展示五个核心动作。

### 错别字校对规则

- 仅修正错别字、多字、漏字和明显错误标点。
- 不调整原文句式、语序、用词和表达逻辑。
- 不做润色、扩写、缩写或风格调整。
- 无错时原样返回。
- 结果区域只展示修正后的完整文本。

### 移动端交互

- 大高度输入框，适合粘贴长文本。
- 提供示例文本，便于现场演示。
- 展示本地校对服务和模型状态。
- 主按钮固定为单一核心动作：开始校对。
- 校对中禁用按钮并显示加载状态。
- 空内容提交给出轻提示。
- 超长文本提交前拦截，默认限制 5000 字。
- 结果支持一键复制，并反馈复制成功。

## 技术方案

- 选型：原生 HTML + CSS + JavaScript。
- Demo 服务：Python 标准库 HTTP 服务 + 开源中文纠错模型。
- 模型：`shibing624/macbert4csc-base-chinese`，通过 `pycorrector` 加载，首次调用会自动下载模型，无需 API Key。
- 路由：
  - `/index.html`：工具站入口。
  - `/tools/typo-proofreader/index.html`：错别字校对独立页面。
- API：前端默认请求 `/api/proofread`；正式上线建议继续由后端保存 API Key，H5 只请求自己的后端接口。

### 免费模型选型

- `pycorrector` 是开源中文文本纠错工具包，Apache 2.0 协议。
- `pycorrector` 官方文档推荐 MacBERT 模型用于中文拼写纠错。
- `shibing624/macbert4csc-base-chinese` 可直接通过 `MacBertCorrector` 使用，适合 demo 快速落地。
- 当前 demo 本地推理，不依赖第三方付费 API，不需要在前端或仓库保存密钥。
- 如需更强的多字、漏字和语法级纠错，可后续把 `TYPO_MODEL` 替换为更大的 CTC/GPT 类开源模型，前端接口无需变化。

## 开发规则

- 保持代码精简，基础功能不用重框架和复杂状态管理。
- 移动端优先，按钮高度不低于 48px，避免横向滚动。
- 页面功能只围绕核心任务，不增加弹窗、广告、历史记录、登录等非必要能力。
- 所有 API 配置集中在页面脚本顶部，便于后续替换。
- 不在仓库中提交真实 API Key、令牌或私密配置。
- 校对提示词必须保持强约束，禁止模型进行润色或解释。

## 本地运行 Demo

安装依赖：

```bash
pip install -r requirements.txt
```

启动服务：

```bash
python server.py
```

访问：

- 工具站首页：`http://127.0.0.1:4173/`
- 错别字校对：`http://127.0.0.1:4173/tools/typo-proofreader/`

首次点击“开始校对”时，服务会下载并加载模型，耗时取决于网络和机器性能。后续请求会复用已加载模型。

### 环境变量

- `TYPO_HOST`：服务监听地址，默认 `127.0.0.1`。
- `TYPO_PORT`：服务端口，默认 `4173`。
- `TYPO_MODEL`：纠错模型，默认 `shibing624/macbert4csc-base-chinese`。
- `TYPO_MAX_TEXT_CHARS`：单次校对最大字符数，默认 `5000`。
- `TYPO_MAX_CHUNK_CHARS`：后端分段推理长度，默认 `220`。

### 接口验证

健康检查：

```bash
curl http://127.0.0.1:4173/api/health
```

校对接口：

```bash
curl -X POST http://127.0.0.1:4173/api/proofread \
  -H "Content-Type: application/json" \
  -d '{"text":"今天新情很好，我想去公圆玩。"}'
```

预期返回 JSON 中包含 `result`、`text` 或 `correctedText` 字段。

## 模型来源

- Hugging Face：`shibing624/macbert4csc-base-chinese`
- Python 工具包：`pycorrector`

该模型适合作为免费 demo 使用。正式产品如需更强的多字、漏字、复杂标点处理，可在后端替换为更强模型，但前端接口可以保持不变。
