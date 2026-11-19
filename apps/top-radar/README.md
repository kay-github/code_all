# 逃顶雷达 / TOP RADAR

只做一件事：在板块/主题的高位，用情绪、上涨难度、资金面和技术面，给出一个分档的减仓提示。不是基本面估值工具，不预测目标价，不替代交易纪律。

## 线上入口

- 实时雷达：`https://1.688680.xyz/taoding`
- 方法与 2026-06 复盘：`https://1.688680.xyz/taoding/method`
- 控制台：`https://1.688680.xyz/taoding/admin`

## 架构

- 腾讯 qfq 日线主源；东财 qfq、新浪（用 qfq 因子还原）备用；`meta.sources` 记录每轮实际来源
- `engine/features.py`：等权指数、广度、情绪、资金、龙头/基准超额
- `engine/score.py`：R（位置分位）/ E（情绪背离）/ C（破位确认）→ 五档
- `engine/update.py`：registry + pool → `data/sectors/<id>.json` + `data/summary.json`
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

- 每次跑批重新拉取**前复权**日线；发生除权除息时，腾讯会把历史价格整体重算，指数点位会变（例如半导体设备 2026-11-18 线上为 5.0193），但 R 用的是滚动分位，档位判断不受点位基准影响。
- 2026-11-19 生产数据：光模块 3.8975 / R17.4 / 正常（休眠，保留 11-18 数据）；半导体设备 5.0193 / R21.8 / 正常（26/26，`meta.sources = {"tencent":27}`）。
- 国产光刻机 `litho_cn`：28 只（15 core + 13 ext），2026-11-18 指数 3.0713 / R20.9 / 正常；覆盖整机映射、涂胶显影、光刻胶、掩膜、光学/光源、检测与精密零部件。
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

## 推送规则

- 只在档位变化时推，同一轮同一板块只推一次。
- 红色 / 深红：变化当天即时推。
- 橙色：进入橙色推一次；之后每 7 天最多补一次“仍在橙色”。
- 解除：从橙色及以上回到正常 / 观察，推一次。
- 数据超过 2 个交易日未更新（`stale=true`）不推。
- PushPlus 单推，不建群组；token 只存在 Vercel 环境变量 `PUSHPLUS_TOKEN`。

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
