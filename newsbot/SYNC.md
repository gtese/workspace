# SYNC ｜ 同步记录

## 本次同步

| 项 | 内容 |
| --- | --- |
| 同步时间 | 2026-11-12 |
| 源主机 | `172.16.50.122`（Rocky Linux 8.10） |
| 源路径 | `/opt/newsbot`（另有 `src/probe*.py`、`srv_*.py`） |
| 目标路径 | `~/deepseek/workspace/newsbot/`（本仓库子目录） |
| 传输方式 | paramiko 密码登录 + `sudo` 打包 `tar.gz`，SFTP 回传后本地解包 |
| 仓库 | `https://github.com/gtese/workspace.git`（branch `main`） |
| 脱敏执行 | 见 [docs/脱敏说明.md](docs/脱敏说明.md) |

## 纳入清单（14 个文件）

| 部署机路径 | 仓库路径 | 说明 |
| --- | --- | --- |
| `README.md` | `docs/历史部署记录-20260928.md` | 上线时的原始部署记录，原样归档 |
| `run.sh` | `run.sh` | cron 入口 |
| `config/config.yaml` | `config/config.yaml` | **已脱敏**（3 个 webhook UUID） |
| `config/sources.yaml` | `config/sources.yaml` | RSS 源清单 |
| `config/mp_sources.yaml` | `config/mp_sources.yaml` | 公众号源清单（21 个） |
| `src/fetcher.py` | `src/fetcher.py` | 抓取与归一化 |
| `src/classifier.py` | `src/classifier.py` | 四类分类 |
| `src/pusher.py` | `src/pusher.py` | 飞书推送 |
| `src/main.py` | `src/main.py` | 主流程 |
| `src/probe.py` | `ops/probe_rss.py` | RSS 探针（改名归类） |
| `src/probe2.py` | `ops/probe_rss2.py` | RSS 探针二轮（改名归类） |
| `srv_probe.py` | `ops/srv_probe.py` | 部署机现场探针 |
| `srv_patch.py` | `ops/srv_patch.py` | sources.yaml 批量补丁 |
| `scripts/sync_mp.py` | `scripts/sync_mp.py` | **已脱敏**（登录口令改为环境变量） |

## 未纳入清单（及原因）

| 内容 | 原因 |
| --- | --- |
| `venv/`（36 MB） | 二进制环境，可由依赖清单重建 |
| `logs/`（380 KB） | 运行日志，含推送正文与时间流水，不入仓 |
| `state/seen.json`、`schedule.json` 及备份 | 运行态去重台账，随环境变化 |
| `config/*.bak*`、`src/*.bak.*` | 历史版本残留，无归档价值 |
| `._*`（macOS 元数据） | 跨机传输污染文件 |
| `/opt/we-mp-rss/data/wx.lic` | 微信读书 Cookie，**禁止入仓** |

## 脱敏动作

| 位置 | 原形态 | 现形态 |
| --- | --- | --- |
| `config/config.yaml` `feishu.groups.{rnd,agentic,exec}.webhook` | `https://open.feishu.cn/open-apis/bot/v2/hook/<真实 UUID>` | `https://open.feishu.cn/open-apis/bot/v2/hook/<REDACTED-ROBOT-UUID>` |
| `scripts/sync_mp.py` `get_token()` | 硬编码 `username=admin&password=<明文口令>` | 读 `WEMP_USER` / `WEMP_PASS` 环境变量 |
| `scripts/sync_mp.py` `BASE` | 硬编码 `http://127.0.0.1:8001` | 优先读 `WEMP_BASE`，默认回落同值 |

脱敏后对仓库全量复扫（webhook UUID / password= / app_secret / Bearer / xoxb / AKIA / sk- 等模式）：除 `ops/probe_rss.py` 中自研的全 0 假地址 `hook/00000000-...` 外无命中。

## 现场核对数据（2026-11-12）

- crontab（`linyiyao`）：两条任务均注释停用，标注 `2026-10-29 改由 TrendRadar 推送`
- 最后运行：`2026-10-28 21:30` → `fetched=578 (rss=354, mp=224) | excluded=17 | new=238`，`classified {'c1':48,'c2':6,'c3':2,'c4':9} | dropped=173 | mp_fallback=12`，`pushed=42`
- 运行环境：Python 3.9.25；feedparser 6.0.12 / requests 2.32.5 / lxml 6.1.3 / PyYAML 6.0.3
- 同机容器：`wewe-rss`、`trendradar`、`trendradar-webui`、`trendradar-mcp`（`we-mp-rss` 已不在）
