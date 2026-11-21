# 逃顶雷达 / TOP RADAR

只做一件事：在板块/主题的高位，用情绪、上涨难度、资金面和技术面，给出一个分档的减仓提示。不是基本面估值工具，不预测目标价，不替代交易纪律。

## 线上入口

- 实时雷达：`https://1.688680.xyz/taoding`
- 方法与 2026-06 复盘：`https://1.688680.xyz/taoding/method`
- 控制台：`https://1.688680.xyz/taoding/admin`

## 架构

- 腾讯 qfq 日线主源；东财 qfq、新浪（用 qfq 因子还原）备用；`meta.sources` 记录每轮实际来源
- `engine/features.py`：等权指数、广度、情绪、资金、龙头/基准超额
- `engine/score.py`：R（位置分位）/ E（情绪背离）/ C（破位确认）→ 五档；同时计算 V2 影子档
- `engine/update.py`：registry + pool → `data/sectors/<id>.json` + `data/summary.json` + `data/v2_shadow.json` + `data/escape_shadow.json`
- GitHub Actions 每工作日 15:10 / 16:10（北京时间）跑，白名单 commit 数据
- Vercel 静态页面读 JSON；`/api/top-radar` 负责配置、手动触发、测试推送

Vercel 不跑 pandas/duckdb；重活全部在 GitHub Actions。配置可通过 API 写入 Vercel Blob（`top-radar/v1/...`），读不到时回退仓库同名文件。

## 每日命令

```bash
cd D:\code_all\apps\top-radar\engine

python -X utf8 update.py --sector all --backfill      # 强制全量重抓（首次/新增板块）
python -X utf8 update.py --sector enabled            # 只跑监控板块；有缓存时跳过已是最新的标的
python -X utf8 update.py --sector all --no-fetch      # 只用本地 bars 复算
python -X utf8 update.py --sector optical --asof 2026-06-16 --no-fetch
python -X utf8 push.py --dry-run                      # 推送演练
```

`--sector` 可传 `all`、`enabled` 或单个 id。`--asof` 只回放到该日，不改变线上数据，除非随后手动发布。

## 数据口径

- 指数：池内 core + ext 全部股票的等权日收益累乘。某日缺数据不计入；`meta.effective_n` 是当日有效只数。
- 覆盖率闸门：只发布“有效只数 ≥ 85% 池内只数”的最近交易日。15:10 跑数时若只有一半股票出日线，会退回上一个完整交易日。
- R：`25*pct(ret250) + 25*pct(ret60) + 20*pct(dist60) + 15*pct(crowd) + 15*pct(rsi14)`，252 日滚动分位，缺失填 50。
- crowd：优先 `amt_share`（池内成交额 / 全市场成交额），缺失回退 `amt_ratio60`。
- hot：60 日内 `max(RSI)>=85` 或 `max(涨停)>=8` 或 `max(ret60)>=50%` 或 `max(成交额占比分位)>=0.95`。
- near：`dd250 >= -8%`。
- C：C1 当日跌破 MA20；C2 20 日内反抽失败 ≥2 次；C3 单日 ≤-4% 且量 ≥1.3 倍；C4 MA20 斜率转负。
- 红：`R>=75 & hot & near & C>=1`，10 日 latch。
- 深红：红 latch 内 `dd250<=-8% & C>=1`，20 日 latch。
- 橙：`R>=70 & hot & near & ~红 latch`，10 日 latch。
- 观察：`R>=55`。

线上 R 与研究报告的 R 不完全相同：线上把全市场成交额补齐到 2021 年，`crowd` 统一用 `amt_share`，绝对值会略高（2026-06-16 研究版 79.2 → 线上 87.9）。档位结论不变；方法页已写明。

### 线上数据基准

- 每次跑批重新拉取**前复权**日线；发生除权除息时，腾讯会把历史价格整体重算，指数点位会变（例如半导体设备 2026-11-18 曾为 5.0193），但 R 用的是滚动分位，档位判断不受点位基准影响。
- 2026-11-20 生产复算：光模块 3.7231 / R15.8 / 正常（数据源 11-19，休眠）；半导体设备 4.2081 / R18.0 / 正常；国产光刻机 3.1389 / R17.0 / 正常；创业板指 2212.127，自 2026-06-25 高点的深跌 -49.4%。
- 国产光刻机 `litho_cn`：28 只（15 core + 13 ext），覆盖整机映射、涂胶显影、光刻胶、掩膜、光学/光源、检测与精密零部件。
- 本地旧缓存里半导体设备 4.7219 是旧前复权基准，不要再当线上现值；以页面 / `summary.json` 为准。

## 五档与动作

| 档 | 名称 | 默认动作 |
|---|---|---|
| 0 | 正常 | 正常持有 |
| 1 | 观察 | 正常持有，停止加仓 |
| 2 | 橙色预警 | 停止加仓；止损上移至最近 10 日低点 |
| 3 | 红色高危 | 减仓 1/3（保守可减 1/2）；剩余止损设 MA20 下方 2% |
| 4 | 深红清仓 | 再减 1/3 或清仓；不接飞刀，等重新站上 MA20 且广度恢复 |

分档不是自动交易指令；减仓比例按个人风险承受调整。

## V2 双轨（2026-11-20 上线）

V2 是 2026-11 多行业验证后的收紧版规则。当前只做影子：进入计算、仪表盘和 `data/v2_shadow.json` 日志，**不接管 PushPlus**；旧 `tier` / `action` 仍是推送唯一依据。

- 橙色：`(R>=70 OR E>=3) & hot & near & vol20>=0.20`
- 趋势红：`R>=80 & hot & near & vol20>=0.20 & 质量C`
- 衰竭红：`R>=98 & hot & near & vol20>=0.20 & E>=3`
- 深红：V2 红色后 10 日内，`dd250<=-8% & C>=1`
- 质量C：`C1>=1 OR C3>=1 OR (C2>=1 AND ret60>=0.40)`；C4 单独不算
- 动作：红色目标仓位 50%（满仓先减 1/2，橙色后再红减 1/3）；深红再降到 25% 或清仓
- 纠错：红色后 5 个交易日内创新 20 日新高且 R>=75，减掉的仓位补回一半；`v2_recover` 只做标记

切换推送的前置条件：至少积累一段实盘触发、误报和踏空样本，并确认 V2 与旧规则的分歧可解释；在此之前不把 V2 写进 `push.py`。

## 逃命顶 · 阶段反弹（2026-11-20 上线）

独立子功能：跟踪“深跌之后那段关键阶段反弹的顶部”，不是下一轮牛市顶部。旧规则用一年高位做参照，深跌后的反弹通常离一年高还有 20%–50%，天然不触发；逃命顶改用本轮跌幅的回撤位、反弹自身高点和 MA20/60。

- 深跌门槛 `D=38%`：35% 的 1,231 个 episode 中，224 个是 -35% 到 -38% 的浅跌样本；38% 去掉这批噪声，同时保留创业板 2021–2022（-39.7%）和光通信 2022（-38.1%）两个锚点。40% 会切掉光通信 2022，所以不做主口径。
- 反弹门槛 `G=20%`，阻力容差 `3%`，成熟度 `2of4`（天数/幅度/乖离/RSI）。
- 状态：`waiting` → `watch` → `warn` → `confirm`；`trend`（收复前高/修复 >80%）和 `failed`（跌破前低）结束跟踪。
- 动作：等待不操作；观察不新增；预警减 1/3；确认再减 1/3；反弹超过预警日高点 3% 撤销预警，回到观察。
- 推送：按状态变化推，`escape_push_state.json` 防重复；等待不推，观察/预警/确认/撤销/结束各推一次；不替代旧档位推送，也不按 sector 的 `enabled` 过滤。
- 固定宽基参考：创业板指 `399006` 为 `escape_shadow.primary`，科创50 `000688` 为 `escape_shadow.references[1]`；两者共用状态机，创业板保留完整路径图。
- 独立行业：光模块/光通信、存储芯片、半导体设备、国产光刻机各自使用同一状态机，独立记录与推送；存储池为 18 核心 + 45 延伸。
- 独立页面 `/taoding/escape` 展示两个宽基参考卡、创业板路径、状态轨迹、四道观察门槛和四个行业卡。
- 数据：`data/escape_shadow.json` 记录 `primary`、`references`、`sectors` 与状态事件；`summary.json` 增加 `escape_reference` 和 `escape_references`。
- 生产回放（D=38%，1,007 个 episode / 828 个逃命顶）：预警覆盖 69.4%，预警后 20 日内 ≥5% 回撤 41.5%、≥10% 28.9%，首次预警中位提前 3 个交易日；确认后 ≥5% 39.6%、≥10% 27.0%，中位晚于顶部 2 日；约 64% 的预警在 20 日内又创新高，所以只能减 1/3，不能一次清仓。
- 研究目录：`D:\work_code2\top_detector\escape_research\`（episode 库、规则回放、标签审计、验证报告）。

## 推送规则

- 只在档位变化时推，同一轮同一板块只推一次。
- 红色 / 深红：变化当天即时推。
- 橙色：进入橙色推一次；之后每 7 天最多补一次“仍在橙色”。
- 解除：从橙色及以上回到正常 / 观察，推一次。
- 数据超过 2 个交易日未更新（`stale=true`）不推。
- PushPlus 单推，不建群组；token 只存在 Vercel 环境变量 `PUSHPLUS_TOKEN`。
- 推送卡只保留“板块/档位/日期/R/指数/动作/触发原因”，先看结论和该做什么；完整指标在网页查看。控制台“测试 PushPlus”发送一条光模块 2026-06-09 的模拟红色信号，仅用于检查样式，不是实盘。
- V2 影子只上仪表盘和 `data/v2_shadow.json`，不进微信；同一板块的新旧档位不合并推送。

## 环境变量（Vercel）

| 变量 | 用途 | 必需 |
|---|---|---|
| `MONITOR_SECRET` | GitHub Actions 调 `notify` 的机器密钥；控制台也兼容，但人不需要填 | 是（仅在 notify） |
| `TOP_RADAR_ADMIN_PASSWORD` | 控制台通用密码；不配时用内置项目密码 | 否 |
| `PUSHPLUS_TOKEN` | PushPlus 单推 token | 是（推送） |
| `GITHUB_DISPATCH_TOKEN` | 立即跑一次触发 workflow_dispatch 的 GitHub PAT（actions:write + contents:write） | 否，没配时 503 |
| `TOP_RADAR_CONFIG_API` | 引擎读 registry/pool 的 API 根地址，默认 `https://1.688680.xyz/api/top-radar` | 否 |

GitHub Actions 需要 `MONITOR_SECRET`（已存在于仓库 Secrets）调 `action=notify`；不需要在 GitHub 存 PushPlus token。
控制台使用人类可记的通用密码（服务端默认内置，`TOP_RADAR_ADMIN_PASSWORD` 可覆盖），不再要求填写 `MONITOR_SECRET`。

## 新增板块

控制台“新增板块”填名称、代码列表（一行一个或逗号分隔）、可选龙头代码，保存后：

1. `/api/top-radar?action=add-sector` 抓腾讯名称、校验代码、写 `registry.json` + `pools/<id>.json` 到 Blob；
2. 下一次跑数（或点“立即跑一次”）自动回补 2020-12 起历史，生成 `data/sectors/<id>.json`；
3. 页面顶部自动出现新板块标签。

建议主题板块 20–60 只，龙头 + 二线都放。光模块 90 只（52 core + 38 ext），半导体设备 26 只（15 core + 11 ext），国产光刻机 28 只（15 core + 13 ext）。

## 已知边界

- 规则适合高波动、强主题、情绪极致、加速赶顶的板块；不适合低波动红利/银行/公用事业、无情绪极值的阴跌顶。
- 慢牛/渐进顶会早报：2023-06 提前 30 个交易日、信号价低 25.7%，但避开 -23.8%；代价是减仓期长、误触发多。
- 深红可能在恐慌底误触发；默认动作是“再减 1/3”，不是无条件清仓。四问不全时只当提示。
- 腾讯 `ifzq` 为主；被 WAF 拦时依次尝试东财 qfq、新浪（带 qfq 因子还原）。`meta.sources` 会记录本轮来源；若出现 `sina_raw` 说明复权因子接口也不可用，应当警惕。
- 数据起点 2020-12；2021 年初 R 分位样本不足，不要用那一段做严肃回测。
- 半导体设备池是候选池，可在控制台增删；光模块当前休眠（行情低谷、无信号），保留历史；国产光刻机为新增主题池，先跑一段时间看信号质量。

## 发布

```bash
cd D:\code_all
git add apps/top-radar api/health.js lib/topRadarApi.js .github/workflows/top-radar-daily.yml vercel.json .vercelignore
git commit -m "Update top radar"
git push
```

白名单提交，不要 `git add -A`；仓库里长期有其他工作流未提交改动。
