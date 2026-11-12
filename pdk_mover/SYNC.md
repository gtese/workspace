# SYNC — 与内网源仓库的同步关系

## 源仓库

| 项 | 值 |
|---|---|
| 主仓库 | `https://git.tri.local/it/filetran.git`（内网 GitLab，仅内网可达） |
| 分支 | `main` |
| 当前对应提交 | `0ee2a81` feat!: v4 简化搬运规则（目标存在即覆盖、源端不留） |
| 运行主机 | `opsnas.tri.local`（172.16.50.107），cron 每 15 分钟 |

本目录是源仓库的**公开镜像**，用于跨设备查阅与备份；实际部署请从内网源仓库拉取。

## 目录对应

| 本目录 | 源仓库 |
|---|---|
| `README.md` / `CHANGELOG.md` / `install.sh` | 同名 |
| `bin/` | `bin/`（`legacy/` 为历史版本归档） |
| `etc/` | `etc/` |
| `docs/` | `docs/` |
| `data/` | 本目录独有：验证记录与现场数据 |

## 脱敏规则（镜像时执行）

1. **凭据一律不入库**：`SMTP_PASS` 保持 `${SMTP_PASS:-}` 从 `/etc/pdk_mover.conf` 读取，模板为 `__CHANGE_ME__`。
2. **邮箱占位**：文档与镜像脚本中收件人统一为 `ops-pdk@example.com` / `ops-oncall@example.com`；内网源仓库的 `etc/pdk_mover.conf.example` 保留真实默认值，以便现场安装。
3. **sudo 口令**：任何脚本、文档、提交记录中均不得出现；运维脚本运行时从 `~/.mm`（0600）读取。
4. **不镜像**：`/etc/pdk_mover.conf`（含 SMTP 口令）、`*.exp`（expect 登录脚本）、`secrets/`、`*.key`、`*.pem`。

## 同步方法（手动）

```bash
# 内网拉取
git clone https://git.tri.local/it/filetran.git ~/tmp/filetran

# 镜像到本目录（保留 docs/ 与 data/，不覆盖 local 说明）
rsync -a --exclude '.git' --exclude 'etc/pdk_mover.conf' \
      ~/tmp/filetran/{README.md,CHANGELOG.md,install.sh,bin,etc,docs} \
      ~/deepseek/workspace/pdk_mover/

# 脱敏检查（必须为零命中）
grep -rnE "Trace@|ssuwlatgq|SMTP_PASS=[^\"'$]" ~/deepseek/workspace/pdk_mover/ || echo "clean"

# 提交
cd ~/deepseek/workspace && git add pdk_mover && git commit -m "docs: sync pdk_mover (v4)"
```

## 历史泄露提示

源仓库 v1 提交 `5d21288` 中曾硬编码过 SMTP 口令（v2 提交 `7b7ca76` 起已改为读取配置）。当前工作树与镜像均无明文，但旧提交仍可检出。

已建议：更换该邮箱口令；如需彻底清除，在源仓库执行历史重写（`git filter-repo --replace-text`）并强推，同时通知所有克隆方重新克隆。本镜像不含该历史。

## 安全提醒

本目录推送至 GitHub 公开仓库（`github.com/gtese/workspace`），提交前务必执行上面的脱敏检查。
