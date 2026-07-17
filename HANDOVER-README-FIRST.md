# 交接说明：请先读我（致股票 YTD 项目的 AI）

> 写于 2026-07-16。写给在 `codex/stock-ytd-ranking-mvp` 分支上持续开发股票 YTD 排名的 AI。
> 你当前分支已落后于 `origin/main` 多个关键提交，**继续在旧基线上开发会产生冲突或口径回退**。

## 发生了什么

2026-07-15 ~ 07-16，另一个 AI（并行工作区）应用户要求完成了两件事并已全部合入 `main` 部署上线：

1. **股票 YTD 数据管线切换到 v2.0（东财 f25 直取）**——你之前维护的 Baostock/新浪自算管线（`scripts/free_stock_ytd.py`，~70 分钟/次）连续多日发布失败导致快照卡死；现改为东财 f25 全市场直取（~1 分钟/次），与用户的验证基准（东财 app）逐位一致。
2. 错别字工具多模型故障转移（与你的领域无关，不赘述）。

## 你接手前必须做的事

```bash
git fetch origin
git rebase origin/main        # 或者基于最新 main 重新拉你的分支
```

然后按顺序阅读：

1. `docs/stock-ytd-ranking/PRD.md` — **第 18 节决策记录新增 2026-07-16 v2.0 五条**（数据源切换、f25 直接作排名键、哨兵闸门、调度窗口）。PRD 治理规则不变：改口径先改 PRD。
2. `docs/stock-ytd-ranking/LESSONS.md` — **新文件**，10 条经验教训，解释每个 v2.0 决策背后的"为什么"（包括为什么放弃你实现的自算管线——不是质量问题，是可靠性与验收基准问题）。
3. `lib/stockEmYtd.js` + `scripts/refresh-stock-ytd-em.js` — 新管线实现。
4. `.github/workflows/stock-ytd.yml` — 已整体替换：Node-only，北京时间 18:35 主刷 + 19:35/21:05 幂等重试；Python 步骤已移除。

## 关键技术变更清单（rebase 时留意这些文件）

| 文件 | 变更 |
| --- | --- |
| `lib/stockSnapshot.js` | 新增 `reported-ytd.v1` 方法论分支（sourceMode `reported`、允许 eastmoney 计算源、免复权审计） |
| `lib/stockPublishedSnapshot.js` | 发布校验接受 reported 快照 |
| `lib/stockSnapshotBlobStore.js` | **修复弱 ETag bug**：Blob 读取返回 `W/"..."`，`ifMatch` 只认强格式，导致 current.json 条件写永远 412——这是你之前发布失败卡快照的根因之一，对旧管线同样生效 |
| `api/stock-health.js` | `reported` 视为 READY |
| `lib/stockEmYtd.js`（新） | f25 扫描 → computed 记录；腾讯 qfq 四哨兵闸门（100bp）；盘中结算闸门（f124 时间戳 ≥90% 匹配目标交易日，否则 no-op）；腾讯沪深300基准 |
| `tools/stock-ytd-ranking/index.html` | 北交所开关文案修正（"纳入北交所"+当前比较池副行），逻辑未动 |
| `tests/stockEmYtd.test.js`（新） | 新管线测试；CI 里在 `test:stock-free` 后运行 |

## 保留与废弃

- **保留（回退路径，勿删）**：`scripts/free_stock_ytd.py`、`lib/tushareYtd.js`、baostock 相关代码与测试。
- **不再被调度**：旧 Python workflow 步骤、`/api/stock-refresh`（Tushare 路径）。
- 发布鉴权新增 `STOCK_PUBLISH_SECRET`（Vercel 生产环境变量）；GH Actions 走 OIDC 不变。

## 每日验收方式

`GET https://1.688680.xyz/api/stock-health` 出现：
`sourceMode: "reported"` + `qualityStatus: "pass"` + `asOf` = 最近完整交易日 → 正常。
首个 reported 定时快照预计 2026-07-16 北京时间 18:35 后发布。

## 用户的意图（转述）

用户明确认可 v2.0 方案（东财同源、1 分钟刷新、并列用现有 tieCount 机制展示），并要求你**跟随 main 的最新节奏接手后续开发**。如对决策有异议，先与用户讨论并更新 PRD 决策记录，不要在代码中静默改回。
