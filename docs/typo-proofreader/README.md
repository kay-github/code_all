# 错别字校对工具（typo-proofreader）

移动端优先的中文错别字校对页面，`https://1.688680.xyz/cbz` 直达。本文档只覆盖错别字工具，记录关键信息与经验教训；全站规则见根目录 `README.md` 与 `AGENTS.md`。

## 关键信息

### 文件清单

| 文件 | 职责 |
| --- | --- |
| `tools/typo-proofreader/index.html` | 前端页面（原生 HTML/CSS/JS，无框架） |
| `api/proofread.js` | 校对接口：模型优先，内置规则兜底，返回 `attempts` 故障转移轨迹 |
| `api/health.js` | 健康检查：返回每个提供商的配置/冷却状态 |
| `lib/modelProofreader.js` | 提供商注册表 + 顺序故障转移 + 冷却记忆 + prompt/响应清洗 |
| `lib/proofreader.js` | 内置中文错词规则与 diff 标红（最终兜底） |
| `tests/proofreader.test.js` `tests/modelProofreader.test.js` `tests/apiProofread.test.js` | `node tests/<name>.test.js` 直接运行 |

### 多提供商故障转移（2026-07-15 上线）

- 默认顺序：讯飞 xfyun → 智谱 zhipu → 硅基流动 siliconflow → 阿里云百炼 dashscope（槽位预留），全部 OpenAI 兼容 `/chat/completions`，纯配置驱动，加新提供商只需在 `PROVIDER_DEFINITIONS` 加一项。
- 触发切换：HTTP 4xx/5xx、超时（AbortController）、网络异常、空结果。
- 冷却：429/401/403 默认 10 分钟（`TYPO_QUOTA_COOLDOWN_MS`），其余 1 分钟（`TYPO_FAILOVER_COOLDOWN_MS`）；冷却期内直接跳过该提供商。注意冷却存于 serverless 实例内存，跨实例不共享，属可接受的近似。
- 顺序可用 `TYPO_PROVIDER_ORDER` 重排。
- 所有提供商失败时回退内置规则库，接口永远返回 200。

### 已接入模型与环境变量（只配在 Vercel，勿入仓库）

| 提供商 | 模型 | 环境变量 | 备注 |
| --- | --- | --- | --- |
| 讯飞星辰 MaaS | `xopqwen36v35b`（Qwen 35B） | `XFYUN_API_KEY` `XFYUN_OPENAI_BASE_URL` `XFYUN_MODEL` `XFYUN_LORA_ID` | 需 `lora_id` header |
| 智谱 BigModel | `glm-4-flash-250414`（长期免费） | `ZHIPU_API_KEY` `ZHIPU_MODEL` | |
| 硅基流动 | `Qwen/Qwen3-8B`（免费） | `SILICONFLOW_API_KEY` `SILICONFLOW_MODEL` | 必须 `enable_thinking:false` |
| 阿里云百炼 | `qwen-turbo`（默认，未接入） | `DASHSCOPE_API_KEY` `DASHSCOPE_MODEL` | 槽位预留 |

### 验证方式

- 健康：`GET https://1.688680.xyz/api/health`，看 `providers[].configured/coolingDown`。
- 校对：`POST /api/proofread`，body `{"text":"今天新情很好，我们去公圆打蓝球"}`；响应 `provider` 显示实际生效的提供商，`attempts` 显示之前失败了谁、错误是什么。
- 典型验证句：`反映物业不足为，要求物业旅行指责` → `反映物业不作为，要求物业履行职责`。

## 经验教训

1. **单一免费提供商必然抖动，兜底要在架构层做。** 讯飞 key 与额度完全正常、控制台无异常，但生产环境**间歇性**返回 500 `AppIdNoAuthError`（讯飞错误码 11200，疑似免费档网关并发/授权抖动）——同一分钟内一次成功一次失败。逐台排查 key 是浪费时间，正确做法是接口返回 `attempts` 轨迹，一次请求就能看到每家的真实错误。
2. **免费平台优先选 OpenAI 兼容接口。** 讯飞/智谱/硅基流动/百炼都提供 `/chat/completions` 兼容层，故障转移可以做成纯配置注册表；避开 WebSocket 版或私有协议（旧版讯飞星火、百度 ERNIE 旧接口），那些每家都要单写适配。
3. **推理型模型要显式关思考。** Qwen3、部分 GLM 有思考模式，纠错场景必须 `enable_thinking:false`，否则慢且可能把推理过程混进输出。
4. **冷却时长要区分错误类型。** 额度/鉴权错误（429/401/403）短期内重试必然还失败，冷却要长（10 分钟）；瞬时抖动（5xx/超时）冷却要短（1 分钟），否则一次抖动就把好提供商屏蔽太久。
5. **提示词用 few-shot 锚定行为。** system prompt 强约束（只改错字、禁止润色）+ 一组 user/assistant 示例对，比单纯指令可靠得多；响应还要过 `cleanModelText` 剥掉代码围栏和引号——不同模型包装习惯不同。
6. **模型结果再过一遍规则库。** `api/proofread.js` 把模型输出再跑 `proofreadText`，模型漏掉的已知错词由规则补上；模型返回原文而规则有发现时，采用规则结果。
7. **Windows 本地 curl 调 api.siliconflow.cn 会因 schannel 证书吊销检查失败（CRYPT_E_REVOCATION_OFFLINE）**，需加 `--ssl-revoke-best-effort`；Node/Vercel 环境不受影响，别误判成平台故障。
8. **与其他并行开发共存：** 本工具改动全程在独立 git worktree + 独立分支进行（另一 AI 在主 checkout 上做股票工具），推送前 `git fetch && git rebase origin/main`，文件互不重叠则零冲突。
9. **key 在聊天/日志暴露过就要轮换。** 本次三个 key 均在对话中出现过，应到各平台控制台轮换后更新 Vercel 环境变量。
