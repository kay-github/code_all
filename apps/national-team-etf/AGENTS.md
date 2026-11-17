# AGENTS.md · 接手说明（AI / 人都先读这一页）

> 目标：让任何接手的人或 AI 在 10 分钟内知道「现在是什么状态、数据可信到哪一层、改哪里、怎么验证」，
> 不重复踩已知的坑。最后更新 **2026-11-17 20:35**（作者：上一轮接手的会话）。
>
> 读完这页后按顺序读：`README.md` → `../国家队追踪_经验库.md` → `docs/持续追踪实施说明.md` → `docs/存量刻度说明.md`。

---

## 0. 这是什么

跟踪「国家队可能经过的 ETF 通道」的申赎变化。**只做通道估算，不做身份认定**：
份额变化能确认，钱是谁的不能确认。所有结论必须带身份等级（I0 未知 / I1 核心通道角色 / I2 已核验历史持有人 / I3 同日实名交易）。

- 代码源（改这里）：`D:/work_code2/gjd_research`
- 站点仓库（发布目标，git 在 `D:/code_all`）：页面 `D:/code_all/tools/national-team-etf/`，源码快照 `D:/code_all/apps/national-team-etf/`
- 线上：<https://1.688680.xyz/gjd/> 与 <https://1.688680.xyz/gjd/cycle>
- 发布方式是 **GitHub main → Vercel CI 自动部署**：只改工作区文件不提交，下一次 CI 会把页面静默回滚成旧版。

---

## 1. 60 秒确认现状（只读，照抄）

```bash
cd D:/work_code2/gjd_research
python -X utf8 -c "
import json;from pathlib import Path
for p in ['data/v2/latest.json','data/postclose/latest.json','data/intraday/postclose.json','data/intraday/latest.json']:
    d=json.load(open(p,encoding='utf-8')) if Path(p).exists() else {}
    print(p, {k:d.get(k) for k in ('build_id','end','business_date','generated_at','stage','pending_review','superseded_by') if k in d})
"
```

判读方法：

| 文件 | 含义 | 谁写 |
| --- | --- | --- |
| `data/v2/latest.json` | **正式区指针**（定稿级，唯一可引用） | `pipeline.py` 构建时 |
| `data/postclose/latest.json` | **盘后初值**（初值级，不可定稿） | `update.py --phase close --publish-postclose` |
| `data/intraday/postclose.json` | 旧路径兼容副本，**`morning_review` 靠它判断"有待复核交易日"** | 同上，必须同时写两份 |
| `data/intraday/latest.json` | 盘中留档（线索级，不产生份额） | `intraday.py --platform-tick` |

`正式.build_id 的日期段 < 当天` 是常态，不是漏更新——盘后与次日两道工序本来就有时差。

---

## 2. 当前状态快照（2026-11-17 收盘后）

| 项 | 值 |
| --- | --- |
| 正式区（定稿级） | 业务日 **2026-11-16**，构建 `20261117T202602_0800_d394157474`，官方份额 15/15 |
| 盘后初值（初值级） | 业务日 **2026-11-17**，构建 `20261117T195518_0800_c412ab3e4e`，官方披露 0/15，反推净申赎 +24.48 亿 |
| 盘中留档（线索级） | 11-17 **缺失**（14:30 平台任务未触发） |
| 10 份刻度（反推口径） | 11-16 = 5.7069 份 / 本轮净新增 3.2307 份；11-17 初值 = 5.7215 / 3.2453 |
| 平台定时任务 | 3 个 ACTIVE，但 **11-17 三次全部被中断**，见 §8 |

11-16 两个口径的差额值得记住：反推 **+144.48 亿**（舍入区间 112.07–176.86），交易所正式份额 **+167.01 亿**，
差 +22.5 亿仍在舍入区间内。「初值不可当定稿」不是保守文案——同一天可以差 20 亿以上。

---

## 3. 最重要的一条：三个版本，三种可信度

同一天的数据分三次成型，**后一版替代前一版，引用时必须认准版本**。

| 版本 | 时点 | 来源 | 可信度 | 落在哪 |
| --- | --- | --- | --- | --- |
| 盘中 | 交易时段每 60 秒（浏览器端） | 供应商快照 JSONP | 线索级：无逐笔方向，**不产生份额** | 页面「盘中观察区」 |
| 盘后 | 当日 19:30 后 | 收盘行情 + 供应商换手率**反推**份额 | 初值级：T 日分母可能是昨收份额，收盘后被修订 | `data/postclose/latest.json`，页面独立区 |
| 次日 | 次日 10:00 复核后 | 交易所**正式**份额 | 定稿级：可引用 | 正式区（10 份刻度、各 CSV、`release.json`） |

边界是硬的：

- 盘后初值 **只能**写独立文件，**不进正式区、不改 `release.json`**（`publish.deploy_postclose()` 单文件白名单）。
- 次日权威版发布后，盘后初值自动打 `superseded_by`、`pending_review=false`，**保留原值**用于回看当时判断。
- 两版都算「份额变化 × 当日均价」，但 **分母来源不同，禁止拼接**。

---

## 4. 文件地图

### 核心（改这些要重新走完整发布链）

| 文件 | 职责 |
| --- | --- |
| `cfg.py` | 日期口径单点（`END`/`PREV`/`RANGE_A`），换日期只改它 |
| `collect_data.py` | 采集：固定池 61 只历史 + 全量目录分页 + 新候选 + 核心 15 正式份额 |
| `pipeline.py` | 构建：标准化、份额反推、风险回放、10 份刻度、产出全部同版产物 |
| `v2_sources.py` | 行情源（腾讯 bfq 日线、快照、交叉校验） |
| `v2_exchange.py` | 交易所正式份额：单位检查、累积、修订记录、`next_morning_collected` |
| `v2_engine.py` | 单只/家族净申赎、5/10/20 日窗口、舍入边界 |
| `v2_tracking.py` | 分通道风险（L0–L3）与事件记忆 |
| `v2_inventory.py` | 10 份存量刻度 |
| `v2_stages.py` | 盘后初值摘要（抹平双口径、置信度文案） |
| `v2_release.py` | 发布闸门 `assess()`，22 项硬条件 |
| `v2_report.py` | 生成 `report.html` / `cycle.html`（含三阶段版本条与全部内联 CSS/JS，70KB） |
| `validate_v2.py` | 独立验收（含 Node VM 精简 DOM 执行页面脚本） |
| `publish.py` | 白名单提交 + push + `deploy_postclose()` 独立通道 |
| `update.py` | 唯一手动总入口（`--phase close/final`） |
| `morning_review.py` | 次晨 10:00 复核入口，判断「有无待复核交易日」 |
| `intraday.py` | 盘中留档、事件、通知队列 |
| `postclose.py` | 只刷新官方份额，**不产出初值**（别单独当盘后任务用） |

### 薄封装（`analyze.py` `today.py` `netflow.py` 等 20 多个）

只有 160 字节左右，全部转调 `compat_v2.main('xxx')`。**不要改它们，也不要以为逻辑在里面。**

### 数据与产物

```
data/v2/raw/<ts>_0800/            不可覆盖原始批次（catalogue/history/discovery/indices/exchange + manifest）
data/v2/builds/<build_id>/        不可覆盖构建：analysis.json.gz、ledger.json.gz、report.html、
                                  daily_flow.csv、official_flow.csv、inventory.csv、release_gate.json
data/v2/latest.json               正式区指针
data/postclose/latest.json        盘后初值
tests/                            98 项 Python 单测 + 1 个 Node 页面契约测试
```

### 产物字段速查（研究时最常用）

```python
# analysis.json.gz
a['end']                                    # 实际业务日（由行情日线决定，不是请求日）
a['instruments'][code]['latest']            # net / shares / market_value / close / volume_ratio
                                            # flow_ratio / flags / risk{level,state,why}
a['instruments'][code]['latest']['w5']      # {net, low, high, positive_days, negative_days, ratio}
a['families'][家族]['series']               # 家族口径逐日聚合
a['exchange']['instruments'][code]          # 正式份额 série、latest_available、next_morning_collected
a['inventory']['latest']                    # total_units / net_added_units / current_yi
# ledger.json.gz['series'][code]            # 逐日 close/turnover/amount/shares/net
# daily_flow.csv                            # 列：date, core15_net_estimate_yi, rounding_low/high, coverage, state
```

---

## 5. 六条不可违反的口径铁律

1. **反推份额 ≠ 正式份额**。`份额 = 成交量(手)×10000 ÷ 换手率(%)`，分母口径未经验证。
2. **净申赎 ≠ 份额变化 ≠ 两端点份额差**。三条数不能互相替代（科创50 三段法最典型）。
3. **缺口不补 0**。核心 15 不齐就不展示合计，宁可空着。
4. **T 日不写定稿**。当日反推值一律标初值，等交易所正式份额复核。
5. **身份未知就写 I0**。放量、同步申赎、折溢价都不能独自确认国家队；不输出「国家队概率」。
6. **闸门不绕过**。`v2_release.assess` 拒绝就是拒绝，改去补数据，不要放宽阈值。

---

## 6. 五个常见任务的 SOP

### A. 研究某个交易日（只读，不改数据）

```bash
cd D:/work_code2/gjd_research
python -X utf8 -c "
import json,gzip
B='data/v2/builds/<build_id>/'
a=json.load(gzip.open(B+'analysis.json.gz','rt',encoding='utf-8'))
core=[k for k,v in a['instruments'].items() if v.get('core')]
for c in core:
    L=a['instruments'][c]['latest']; r=L.get('risk') or {}
    print(c, a['instruments'][c]['name'], '%+.2f 亿'%L['net'], '量比%.2f'%(L.get('volume_ratio') or 0), 'L%s %s'%(r.get('level'),r.get('state')))
"
```

判断顺序（**别跳步**）：① 成交额/量比/相对指数 → ② 份额变化方向与集中度 → ③ 抹平判定 → ④ 5/10/20 日累计 → ⑤ 风险状态分层 → ⑥ 才谈身份（默认 I0）。

### B. 更新数据并发布

```bash
# 盘后（当日收盘，只出初值）：采集→构建→初值→只推一个 JSON
python -X utf8 update.py --phase close --publish-postclose
# 次日（正式）：采集→构建→闸门→验收→白名单提交→push→Vercel
python -X utf8 update.py --phase final --deploy
# 补做历史某日（例：错过次晨复核）
python -X utf8 update.py --phase final --end 2026-11-16 --deploy
```

`--phase close` 输出「正式发布检查尚未通过」是**预期**，不是失败。

### C. 只改页面样式/文案

`v2_report.py` 里是内联 HTML/CSS/JS。改完**必须**走 `update.py --phase final --deploy`（不能只 `publish.py --deploy`）：
`current_hash` 由代码文件算出，不重新构建会被拒。若当日正式份额未齐导致闸门不过，用 `--end <上一已核验日>` 补做发布。

### D. 排障：线上没更新

按顺序查，别猜：

1. `git log --oneline -3`（在 `D:/code_all`）——有没有提交
2. `data/release.json` 与 `data/latest.json` 的 `build_id` 是否一致
3. 线上 `<meta name="gjd-build-id">` 是否等于本地构建号（**只认 meta + 四项数据文件**，别用宽正则扫全页，会命中 `inventory.provenance.build_id` 误报）
4. HTML 有差异时先按 Git 规则做 `\r\n → \n` 归一化再比 md5
5. Vercel 约 20–50 秒生效，用「HTML 里是否出现新字样」轮询，别按字节长度猜

### E. 排障：本机 automation 没跑

先看 `~/.workbuddy/logs/automation.log`（UTC 时间，+8 为北京时间），区分三类：

`run finished ... success=true` / `[CANCELLED] unknown_interrupted`（会话被掐） / `Conversation ended before automation request completed`（用户开新对话把会话顶掉）。
后两类只能手动补跑 §6B，并考虑加兜底时点。

---

## 7. 采集与口径要点（容易搞错的细节）

- **`end` 由行情日线最新可用日决定**，不是请求日。腾讯 bfq 日线在当天 17:30 前常常还没有当日 bar，所以 17:28 构建出来的 `end` 会落在前一个交易日——这是正常现象，不是采集失败。
- **深交所份额**：T 日晚间值仅供参考，`next_morning_collected` 的判定是 `fetched.date > end` 且（`fetched.date > end+1天` 或 `fetched.hour >= 9`）。所以 19:30 的采集对当日必然不过次晨关，次日 10:00 才过。
- **上交所份额**：清算后数据一般 17:00 后才出。
- **10 份刻度**：基准 `2025-12-31 = 10 份`，本轮起点 `2026-07-16`（锚点 07-15），固定价格 `2026-11-13`。改基准/价格/样本/起点必须升 `version`。这是 **ETF 通道估算，不是国家队实名仓位**。
- **10 份刻度只认反推份额**：`v2_inventory.point()` 里 `share_source != 'vendor_turnover_estimate'` 直接抛 `不得混入不同份额口径`。所以正式区发布**不会**改变历史刻度值；正式份额敞口（`official_flow.csv`）是另一条独立序列，两者差额只能用舍入边界解释，不能拼成一条曲线。
- **风险等级 L0–L3** 在 `analysis.json.gz` 的 `latest.risk`，**不在**日表的 `flags` 里；`flags` 只放数据质量标记（如 `flow_within_rounding_uncertainty`）。
- **`core15.latest.net` 是反推口径**，不是正式份额口径（正式值看 `official_flow.csv` 汇总）。看页面质量区时会同时出现两个数，别当成互相矛盾。

---

## 8. 已知失效模式（会骗你的东西）

| 现象 | 真实原因 | 正确做法 |
| --- | --- | --- |
| 份额反推值几乎不动、当日净申赎≈0 | T 日换手率分母仍是昨收份额 | 看 `flattened.ratio_median`（≈1.000000 即被抹平）、严格 `count`(1±1e-5)、宽 `near_count`(1±1e-3)。**只报一个口径会低估或夸大** |
| 最新交易日流量被系统性抹平 | 同上，T+1 才换登记份额 | 当日只算临时值，次日用 `recheck_prevday.py` / `recompute_prevday.py` 复核；未复核标的标 unavailable，**不按 0 计入汇总** |
| 量放大但份额几乎不动 | 二级市场换手，不是申购 | 比对 `amount` 与 `net`，别把放量当承接 |
| 页面一个数在动、一个不动 | 同一代码跨区域同步时拿未重算的行当权威源 | 按代码算一次再分发到每一行 |
| 页面「盘中」卡说"等盘后初值"但盘后卡已有当日 | 盘中卡日期与文案不同源 | 2026-11-17 已修：两处统一用 `idate` |
| automation 显示 ACTIVE 但当天没产出 | 会话被中断（不是脚本报错） | 查 `automation.log`；手动补跑；加兜底时点 |
| 按成交额取前 100 会漏采 | 榜单是动态的 | 固定样本 `data/sample.json` 锁 51 只（旧版路径 `data/legacy_v1/sample.json`） |
| 线上 md5 与本地不一致 | CRLF vs LF | 归一化后再比 |

---

## 9. 交付前验证清单

```bash
cd D:/work_code2/gjd_research
python -X utf8 -m unittest discover -s tests -v      # 98 项
python -X utf8 validate_v2.py                        # 独立验收（含页面脚本 Node VM 执行）
node --test tests/site_release.test.cjs              # 只在站点仓库 root 有效，见下
```

- Node 页面测试**不能**在本目录直接跑：它按 `__dirname/../tools/national-team-etf` 找页面。`publish.py` 会把它拷成 `D:/code_all/tests/nationalTeamEtf.test.cjs` 再在站点仓库 root 执行。
- 改过页面脚本，**必须**用真实浏览器抽查 console（`playwright` 在 `C:/Users/bokaichen/.workbuddy/binaries/node/workspace/node_modules/playwright`）：
  Node VM 是精简 DOM，`renderLive()` 会走静态降级，测试全绿也可能线上报错（历史上 `pill is not defined` 就是这样上线的）。
- 本机 `HTTP_PROXY=http://127.0.0.1:7890`：访问 `127.0.0.1` 要 `--no-proxy-server`；访问线上要显式 `proxy: {server:'http://127.0.0.1:7890'}`。

---

## 10. 不要做的事

- ❌ 把盘后初值写进正式区，或改 `release.json`
- ❌ 绕过 / 放宽 `v2_release.assess` 的闸门；也**不要**用 `publish.py --deploy` 代替 `update.py` 走正式链
- ❌ 手改 `data/v2/raw/` 或 `data/v2/builds/`（不可覆盖，修订要留旧值）
- ❌ 用当日反推值当定稿引用，或据此下"国家队在买"的结论
- ❌ 缺口补 0、把多日差分塞进一天
- ❌ 在 `D:/work_code2/gjd_research` 与 `D:/code_all/apps/national-team-etf` 两处同时改源码（后者是发布快照）
- ❌ 创建 schtasks / `.cmd` 启动器（用户明确反对 cmd 窗口抢焦点；`scheduler.py --install` 已封死）
- ❌ 提交时夹带其他项目的改动（`publish.py` 只提白名单，保留其余工作区修改）
