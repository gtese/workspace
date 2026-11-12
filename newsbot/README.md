# newsbot ｜ 新闻抓取 → 四类分类 → 飞书分群推送

内网 AI 新闻聚合推送系统：定时抓取 RSS + 微信公众号文章 → 四类关键词分类 → 按类目推送到对应飞书群（卡片形式，RSS / 公众号双栏）。

- 部署服务器：`172.16.50.122`（`linyiyao`，Rocky Linux 8.10）
- 部署根目录：`/opt/newsbot`
- 运行环境：`/opt/newsbot/venv`（Python 3.9.25）
- 本仓库副本同步时间：**2026-11-12**（详情见 [SYNC.md](SYNC.md)）

> 本仓库为部署机的**脱敏副本**：飞书机器人 webhook 与 we-mp-rss 登录口令均已脱敏，真实值只存在于部署机，见 [docs/脱敏说明.md](docs/脱敏说明.md)。

---

## 一、当前状态（2026-11-12 现场核对）

| 项 | 状态 |
| --- | --- |
| crontab（`linyiyao`） | 两条任务均已注释停用，标注 `2026-10-29 改由 TrendRadar 推送` |
| 最后一次实际运行 | `2026-10-28 21:30`，`run done \| pushed=42`（c1 研发 20 条 RSS + 12 条公众号 / c2 5 条 / c3 2 条 / c4 3 条） |
| 容器侧 | `we-mp-rss` 已不在运行；同机现存 `wewe-rss`、`trendradar`、`trendradar-webui`、`trendradar-mcp` |
| 结论 | **本项目当前处于归档态**，采集与推送职责已由 TrendRadar 体系承接；代码与配置保留作回归/复用参考 |

停用前最后一轮运行（2026-10-28 21:30）四类均有命中，双栏卡片正常下发，`mp_fallback=12` 说明兜底策略生效。

---

## 二、四类定义与目标群

| 类别 | 内容 | 推送群 |
| --- | --- | --- |
| c1 | AI 模型 / 推理芯片 / 计算架构 | 研发部门群 |
| c2 | AI EDA / Agentic 工程 | agentic 部门群 |
| c3 | AI 硬件客户需求 | 高管群 |
| c4 | 模型 / 芯片 / EDA 公司融资 | 高管群 |

未命中任何类别的**公众号**条目不会丢弃，统一兜底进 c1（研发群）；RSS 条目则按 `min_score` 丢弃。

---

## 三、目录结构

```
newsbot/
├── run.sh                       定时执行入口（cron 调用）
├── config/
│   ├── config.yaml              运行参数 / 飞书群 / 四类锚点与关键词 / 全局排除正则
│   ├── sources.yaml             RSS 新闻源清单（hint 倾向 · allow 类目白名单 · enabled 开关）
│   └── mp_sources.yaml          公众号源清单（we-mp-rss 输出的 feed id 列表，21 个）
├── src/
│   ├── fetcher.py               RSS / 公众号 feed 抓取与归一化
│   ├── classifier.py            四类分类（锚点门槛 + 关键词加权 + allow 白名单 + 排除正则）
│   ├── pusher.py                飞书自定义机器人推送（interactive 卡片 + 签名 + 文本兜底）
│   └── main.py                  主流程编排、去重台账、按类配额与调度
├── scripts/
│   └── sync_mp.py               公众号增量同步：新号自动并入采集任务与 mp_sources.yaml
├── ops/
│   ├── probe_rss.py             RSS 可达性探针（批量测源）
│   ├── probe_rss2.py            第二轮探针（补充源）
│   ├── srv_probe.py             部署机现场探针（依赖/连通性）
│   └── srv_patch.py             sources.yaml 批量补丁脚本
└── docs/
    ├── 历史部署记录-20260928.md  上线时的完整部署记录（环境基线、源实测、演练数据）
    └── 脱敏说明.md              本次同步的脱敏项与处理方式
```

部署机与仓库的差异：本仓库**不含** `venv/`、`logs/`、`state/`（已推送去重台账）、`*.bak*` 与 macOS 元数据 `._*`。

---

## 四、关键实现要点

- **双栏卡片**：`pusher.build_card` 按类目出卡，左栏传统 RSS、右栏公众号；发送失败自动降级纯文本。
- **分类算法**：`anchors` 锚点门槛 → 关键词加权（标题 ×3、摘要 ×1，长词权重更高，源 `hint` +2）→ `allow` 源级类目白名单 → `min_score`(3) 阈值 → 全局 `exclude_patterns` 兜底剔除（车评/行情/A股/预售等）。
- **配额**：`max_per_group_per_run: 25`、`max_per_source_per_run: 3`（压制 arXiv 类高频源刷屏）、`max_age_hours: 72`。
- **去重**：`state/seen.json` 记录已推送标题键，保留 14 天。
- **限频**：卡片间 `rate_limit_seconds: 1.2`（飞书自定义机器人 5 次/秒上限）。
- **公众号采集**：`scripts/sync_mp.py` 轮询 we-mp-rss 接口，发现新号后同时更新两个定时采集任务的 `mps_id`、追加 `mp_sources.yaml`、`job/fresh` 重载调度器，并写 `logs/mp_sync.log`。

---

## 五、依赖（venv，实测版本）

```
requests==2.32.5   feedparser==6.0.12   beautifulsoup4==4.15.0   lxml==6.1.3
PyYAML==6.0.3      python-dateutil==2.9.0.post0
```

> 坑位记录：`/home/linyiyao` 是 CIFS 网络盘，不支持符号链接，venv 必须建在本地盘（`/opt/newsbot`）。系统 Python 3.6.8 过旧不可用，需 dnf 安装 python39。

---

## 六、运维命令速查

```bash
# 演练（不真实发送）
/opt/newsbot/venv/bin/python /opt/newsbot/src/main.py --dry-run

# 真实推送（需 webhook 已填、dry_run=false）
/opt/newsbot/venv/bin/python /opt/newsbot/src/main.py

# 单源调试 / 查看分类得分明细
/opt/newsbot/venv/bin/python /opt/newsbot/src/main.py --dry-run --source 量子位 --explain 5

# 强制重推（清空去重台账后再跑）
mv /opt/newsbot/state/seen.json /opt/newsbot/state/seen.json.$(date +%F) && \
/opt/newsbot/venv/bin/python /opt/newsbot/src/main.py --dry-run

# 公众号增量同步（凭据走环境变量）
WEMP_USER=admin WEMP_PASS=<部署机口令> /opt/newsbot/venv/bin/python /opt/newsbot/scripts/sync_mp.py --dry-run

# 日志
tail -50 /opt/newsbot/logs/newsbot.log
tail -50 /opt/newsbot/logs/mp_sync.log
```

定时任务历史上的三种形态：

```
*/30 * * * * /opt/newsbot/run.sh                              # 最初：每 30 分钟
30 9 * * * /opt/newsbot/run.sh                                # 改为：每日 09:30
*/30 * * * * .../sync_mp.py                                   # 公众号同步：每 30 分钟
# 2026-10-29 起以上两条全部注释停用（改由 TrendRadar 推送）
```

---

## 七、已知问题与后续可增强

- 机器之心、集微网、36氪、Synopsys 中文等源无有效 RSS（返回 HTML），需自建 RSSHub；Intel Newsroom 403，电子发烧友/创业邦 404。
- 2026-10-13 起 `sources.yaml` 已移除全部英文源，仅保留中文源。
- 可增强：自建 RSSHub 补源、推送时段控制（避免夜间打扰）、接入大模型做二次语义分类、卡片交互反馈反哺规则调优。

---

## 八、凭据与安全

| 敏感项 | 仓库内形态 | 真实值位置 |
| --- | --- | --- |
| 飞书 3 个群机器人 webhook | `hook/<REDACTED-ROBOT-UUID>` 占位 | 部署机 `config/config.yaml` |
| we-mp-rss 登录口令 | 环境变量 `WEMP_USER` / `WEMP_PASS` 注入 | 部署机执行环境 |
| 微信读书 Cookie（`wx.lic`） | 未同步、未记录 | 部署机 `/opt/we-mp-rss/data/` |

`ops/probe_rss.py` 中的 `hook/00000000-0000-0000-0000-000000000000` 是探针用的假地址，非真实凭据。
