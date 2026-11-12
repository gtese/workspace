---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: 8c4394cfff83f2eb5d568afaa7d5d896_518e8c83de3911f1997d52540024e231
    ReservedCode1: QY6brqpr7Hb251rwpStF5tIFSPK49YxMXzQxR1cy0jOOI0hfp1bMnqZEp9Nsfyf6yMmXIb0d6DqyWKaj9hWMrw/9H2cdzl+hcKSdVtLzzTPu4GBxE4nx2gSyRRJuF0XwEIjH+6eGWVn3LtFTVf/npVtPxT4OmHkd0vYRPEVpwImEm9+o8AAyOgkcoKg=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: 8c4394cfff83f2eb5d568afaa7d5d896_518e8c83de3911f1997d52540024e231
    ReservedCode2: QY6brqpr7Hb251rwpStF5tIFSPK49YxMXzQxR1cy0jOOI0hfp1bMnqZEp9Nsfyf6yMmXIb0d6DqyWKaj9hWMrw/9H2cdzl+hcKSdVtLzzTPu4GBxE4nx2gSyRRJuF0XwEIjH+6eGWVn3LtFTVf/npVtPxT4OmHkd0vYRPEVpwImEm9+o8AAyOgkcoKg=
---

# pdk_mover — PDK 中转区 → NAS 正式区 自动迁移

把 EDA 中转区里的 PDK 交付文件，自动搬进 NAS 正式区对应项目目录。跑在 `opsnas.tri.local`（172.16.50.107），cron 每 15 分钟一轮，有动作才发邮件。

当前版本：**v4**（2026-11-04 上线）

---

## 1. 规则（v4 只有一条）

> 中转区白名单目录下的文件，只要正式区存在对应目标目录，就 `mv` 过去（**同名直接覆盖**），**源端一律不留**；正式区缺目录则原地不动，记告警等人工建目录。

相比 v2/v3 的关键变化：

| 项 | v2 | v3 | v4（当前） |
|---|---|---|---|
| 目标同名文件 | 跳过，记 conflict（源文件冻结在中转区） | 内容一致则删源、不一致按 CONFLICT_POLICY | **直接覆盖，源端不留** |
| 子目录 | 只扫白名单目录一层 | 递归 | 递归，目标侧子目录须已存在 |
| 空目录 | 保留 | 回收 | 回收（`find -mindepth 1 -type d -empty -delete`） |
| 目标缺目录 | 告警跳过 | 告警跳过 | 告警跳过，**源文件保留**，同目录只报一次 |
| 配置分支 | — | `CONFLICT_POLICY` 多分支 | 策略分支全部删除，配置里的 `CONFLICT_POLICY` 已注释 |

**风险**：同名覆盖不保留旧文件、无备份，正式区旧版被新版直接替换且不可回滚。这是 v4 有意为之（PDK 迭代以新为准），务必确认上游不会误传同名旧版。

---

## 2. 拓扑与路径映射

```
中转区 (NFS, 可写)                              正式区 (CIFS, 只读发布)
/eda/workspace/transfer/backend/nas_cifs/pdk/release   /nas_cifs/pdk/release
        └── tsmc/n6/                                     └── tsmc/n6/
                ├── io/{cdl,db,gds,lef,lib}                     ├── io/{...}
                ├── ram/{avm,cdl,db,gds,lef,libs}               ├── ram/{...}
                └── rom/{avm,cdl,db,gds,lef,libs}               └── rom/{...}
                            └──── 相对路径完全一致，逐目录对搬 ────┘
```

| 角色 | 路径 | 类型 |
|---|---|---|
| 源根 | `/eda/workspace/transfer/backend/nas_cifs/pdk/release` | NFS `172.16.20.13:/fs/eda_nas/eda_workspace` |
| 目标根 | `/nas_cifs/pdk/release` | CIFS `//172.16.20.14/data_pdk/release`，`sec=ntlmv2`，`file_mode=0640`，`dir_mode=0750` |

源根下的「项目相对路径」（如 `tsmc/n6`）两端保持一致，这是自动寻址的依据。

---

## 3. 权限模型

```bash
# 中转区根目录（一次性，已执行）
chown -R root:group_backupend /eda/workspace/transfer/backend
chmod 2775 /eda/workspace/transfer/backend
```

- `group_backupend`（GID `1423602213`）对应 AD 组 `Group_BackupEnd@tri.local`。
- `setgid`（2775）保证成员新建子目录自动继承该组，不因个人主组不同而丢写权限。
- **白名单目录必须本身可写**：`drwxr-s---`（0750）时属组无写权限，成员能进不能放。正确形态是 `2775`：

```bash
R=/eda/workspace/transfer/backend/nas_cifs/pdk/release/tsmc/n6
chmod 2775 "$R"/io "$R"/ram "$R"/rom
for d in io/cdl io/db io/gds io/lef io/lib \
         ram/avm ram/cdl ram/db ram/gds ram/lef ram/libs \
         rom/avm rom/cdl rom/db rom/gds rom/lef rom/libs; do
    chmod 2775 "$R/$d"
done
```

> 骨架用 `rsync -rlD` 从 CIFS 同步会继承源端 `dir_mode=0750`，导致上述目录建成 0750 而组不可写。每次新增节点后必须补一次 `chmod`，或用 `install -d -m 2775` 建目录。

- 迁移由 root 执行，写入 CIFS 时按挂载参数映射，落地文件属主 `root:group_pdk_ro`、权限 `0640`。
- 正式区 `dir_mode=0750`，普通账号无读权限，需 root 核对。

---

## 4. 迁移范围：项目 × 目录白名单

**项目**（`PROJECTS`）：相对源根的两级路径，如 `tsmc/n6`。新增节点只在配置里加一项，脚本不改。

**叶子目录**（`ALLOW_DIRS`，所有项目共用）：

| 一级 | 二级子目录 |
|---|---|
| `io` | `cdl` `db` `gds` `lef` `lib` |
| `ram` | `avm` `cdl` `db` `gds` `lef` `libs` |
| `rom` | `avm` `cdl` `db` `gds` `lef` `libs` |

共 17 个目录，即 tsmc/n6 下唯一需要接收文件的位置。其余目录（`kits/*`、`ip/pll` 等参考资料）不扫描、不搬运，即使误放文件也不会被带走 —— 天然防护。

v4 起对每个叶子目录做**递归**扫描：源端 `ram/db/sub/x.db` 会搬到正式区 `ram/db/sub/x.db`，前提是该子目录在正式区已存在。

源端不存在的叶子目录自动跳过；**目标端**不存在则记失败告警，**绝不自动创建**，防止正式区出现本不该有的目录。

---

## 5. 仓库结构

```
pdk_mover/
├── README.md                       本文档
├── CHANGELOG.md                    版本变更记录
├── install.sh                      一键部署（--purge-old 清理 v1 遗留）
├── bin/
│   ├── pdk_mover.sh                迁移主脚本（v4，线上部署版）
│   ├── pdk_mover_mailer.py         通用 SMTP 发信器（正文由主脚本生成）
│   ├── cleanup_conflicts.sh        一次性工具：清理中转区与正式区内容相同的重复文件
│   └── legacy/
│       ├── pdk_mover_v2.sh         v2 归档（同名跳过策略）
│       └── pdk_mover_v3.sh         v3 归档（dedup / CONFLICT_POLICY 多分支）
├── etc/
│   ├── pdk_mover.conf.example      配置模板（含占位口令）
│   └── cron.d/pdk_mover            每 15 分钟
└── docs/
    ├── 2026-11-04-v4规则变更与部署.md
    └── 运维速查.md
```

> `/etc/pdk_mover.conf` 含 SMTP 口令，**不入库**，`.gitignore` 已排除。

---

## 6. 部署

```bash
git clone https://git.tri.local/it/filetran.git
cd filetran
sudo ./install.sh          # 升级时保留已有 /etc/pdk_mover.conf
```

首次安装后必须编辑 `/etc/pdk_mover.conf` 填入 `SMTP_PASS`，确认 `PROJECTS`、`ALLOW_DIRS`。随后先演练：

```bash
DRYRUN=1 /usr/local/sbin/pdk_mover.sh && tail -5 /var/log/pdk_mover.log
```

依赖：Rocky Linux 8（或同级）、`bash`、`python3`（3.6+）、`flock`（util-linux）、`crond`；目标机需已挂载上述 NFS 与 CIFS。

### 从 v1（pdk_n6_*）升级

```bash
sudo ./install.sh --purge-old
```

会移除 `/etc/cron.d/pdk_n6_mover` 与 `/usr/local/sbin/pdk_n6_*`，日志保留。配置需重新填一次 `SMTP_PASS`。

### 从 v2/v3 升到 v4

```bash
sudo cp -a /usr/local/sbin/pdk_mover.sh /usr/local/sbin/pdk_mover.sh.bak.$(date +%Y%m%d_%H%M%S)
sudo ./install.sh
# 配置里若还有 CONFLICT_POLICY，注释掉（v4 已不读该变量）
DRYRUN=1 /usr/local/sbin/pdk_mover.sh
```

---

## 7. 运行机制

cron 每 15 分钟触发 `pdk_mover.sh`，单轮流程：

1. **读配置** → `flock -n /var/lib/pdk_mover/.lock`，上轮未结束则本轮跳过。
2. **遍历项目**：`PROJECTS` 中每项检查源/目标项目根，目标缺失 → 告警跳过。
3. **遍历白名单**：17 个叶子目录，各自 `find -type f -mmin +MIN_AGE` **递归**列出待搬文件。
4. **逐文件处理**：
   - 目标父目录不存在 → 保留源文件，记一条告警（同目录仅一条），继续下一个；
   - 目标父目录存在 → `mv` 到目标目录隐藏临时名 `.文件名.part.$$`，再 `rename` 为正式名（同名直接覆盖）—— 中断时不会留下半截文件占正式名；
   - 失败 → 清理临时文件，源文件保持原样，记失败。
5. **空目录回收**：每个叶子目录搬完后 `find -mindepth 1 -type d -empty -delete`（DRYRUN 跳过）。
6. **汇总发信**：本轮有迁移/覆盖/失败才发一封，按项目分节列出明细（每类最多 200 条）。
7. 写日志 `scanned/moved/overwritten/failed` 汇总行。

时延：文件放入后最迟约 2–17 分钟被迁移（2 分钟稳定期 + 最长 15 分钟轮询）。

---

## 8. 配置项（/etc/pdk_mover.conf）

| 变量 | 默认 | 说明 |
|---|---|---|
| `SRC_ROOT` | `/eda/workspace/transfer/backend/nas_cifs/pdk/release` | 源根 |
| `DST_ROOT` | `/nas_cifs/pdk/release` | 目标根 |
| `PROJECTS` | `tsmc/n6` | 启用项目，空格分隔 |
| `ALLOW_DIRS` | 17 个叶子目录 | 允许迁移的二级目录 |
| `MIN_AGE` | `2` | 写入稳定期（分钟） |
| `DRYRUN` | `0` | 1 = 只出计划不移动 |
| `LOG` / `WORK` | `/var/log/pdk_mover.log` / `/var/lib/pdk_mover` | 日志与运行目录 |
| `SMTP_HOST` / `SMTP_PORT` | `smtp.qiye.aliyun.com` / `25` | 阿里企业邮 |
| `MAIL_FROM` / `SMTP_USER` / `SMTP_PASS` | 见模板 | 发件与认证 |
| `MAIL_TO` / `MAIL_CC` | `ops-pdk@example.com` / `ops-oncall@example.com` | 收件 / 抄送 |

运行时可用环境变量临时覆盖，便于测试而不改配置（脚本会先暂存再由环境变量回写，环境变量优先于配置文件）：

```bash
DRYRUN=1 MIN_AGE=1 MAIL_TO_OVERRIDE=ops-oncall@example.com MAIL_CC_OVERRIDE= \
  CONF=/etc/pdk_mover.conf /usr/local/sbin/pdk_mover.sh
```

---

## 9. 新增一个工艺节点

```bash
# 1) 目标侧目录必须已存在（工具不会自动创建）
sudo ls -d /nas_cifs/pdk/release/tsmc/n5/io/lef

# 2) 源侧按需建好同名目录（属组 group_backupend，setgid 继承）
mkdir -p /eda/workspace/transfer/backend/nas_cifs/pdk/release/tsmc/n5/io/lef

# 3) 配置里追加项目
sudo sed -i 's/^PROJECTS=.*/PROJECTS="tsmc\/n6 tsmc\/n5"/' /etc/pdk_mover.conf

# 4) 演练确认
DRYRUN=1 /usr/local/sbin/pdk_mover.sh && tail -5 /var/log/pdk_mover.log
```

不同节点结构有差异时可调整 `ALLOW_DIRS`（缺的目录会被自动跳过，不影响其他项）。

---

## 10. 邮件通知

- 主题：`[PDK同步] 2026-11-04 12:00:00 迁移 N / 覆盖 M 个文件`；演练带 `DRYRUN` 标记。
- 正文：执行时间、源/目标根、合计计数，随后按项目分节列出「告警 / 已迁移 / 同名已覆盖 / 失败」明细。
- UTF-8 纯文本；先 `STARTTLS`，服务端不支持则明文，登录失败也继续投递（先保证文件到位）。

---

## 11. 日志与排障

| 位置 | 内容 |
|---|---|
| `/var/log/pdk_mover.log` | `[project]` 每项目一行、`[total]` 每轮一行、`[mail]` 结果 |
| `/var/lib/pdk_mover/` | 锁文件与运行期清单（自动清理） |
| `/etc/pdk_mover.conf` | 全部可调参数 |

```bash
tail -30 /var/log/pdk_mover.log
systemctl status crond
grep CRON /var/log/cron | tail -20
DRYRUN=1 /usr/local/sbin/pdk_mover.sh          # 只出计划
sudo find /nas_cifs/pdk/release/tsmc/n6/io/lef -maxdepth 1 -type f | head
```

| 现象 | 原因 | 处理 |
|---|---|---|
| 文件不搬 | 未满 MIN_AGE / 不在白名单目录 / cron 未触发 / 持锁 | 看日志轮次，`DRYRUN=1` 手工跑 |
| `目标目录不存在` 告警 | 正式区缺该目录（含子目录） | 先在正式区建好，本工具不会自动建 |
| 文件被覆盖掉了 | v4 同名直接覆盖 | 属预期行为；确需找回只能找上游重新生成 |
| 中转区出现空目录残留 | 空目录回收被 DRYRUN 跳过 | 正常；正式运行轮次会自动清理 |
| 邮件收不到 | 25 端口受限 / 口令错误 | `nc -vz smtp.qiye.aliyun.com 25`，核对 `SMTP_PASS` |
| 普通账号读正式区被拒 | `dir_mode=0750` + 属组 `group_pdk_ro` | 属正常隔离，用 root 查看 |

---

## 12. 回滚

```bash
# 回到上一版本脚本
sudo cp -a /usr/local/sbin/pdk_mover.sh.bak.<时间戳> /usr/local/sbin/pdk_mover.sh

# 或完全停用
sudo rm -f /etc/cron.d/pdk_mover
sudo systemctl reload crond
sudo rm -f /usr/local/sbin/pdk_mover.sh /usr/local/sbin/pdk_mover_mailer.py
sudo rm -rf /var/lib/pdk_mover
```

只停自动化，不动已迁移数据。

---

## 13. 已知限制

- 只处理普通文件，不搬符号链接。
- **同名覆盖不可逆**，无备份（v4 设计取舍）。
- 目标侧子目录须预先存在，工具只搬文件不建目录。
- 单实例设计，面向单台 opsnas；多机部署需确保源根不重叠。
- 跨文件系统 `mv` 实为「读源 + 写 NAS」，大文件占用带宽较久；`MIN_AGE` 用来避开传输中的文件。
- CIFS 深遍历极慢（实测 `find -type f` 全量扫描 10 分钟未完成），因此扫描限定在 17 个叶子目录内，不做全树遍历。
- 邮件依赖外部 SMTP，发信失败不影响迁移结果。

---

## 14. 验证记录

| 时间 | 内容 | 结果 |
|---|---|---|
| 2026-10-26 | v1 端到端演示：`io/lef/demo_1103.txt` 迁至正式区 | `scanned=1 moved=1 conflict=0 failed=0`，邮件成功，既有文件未受影响 |
| 2026-10-27 | 白名单核验：17 个叶子目录在源/目标两侧均存在 | 全部 OK |
| 2026-10-27 | v2 部署与 DRYRUN 演练 | 见 `/var/log/pdk_mover.log` |
| 2026-11-04 | v4 沙箱验证（`/root/pdk_v4_test_20261104_112957`）：新建、覆盖、子目录递归、空目录回收、缺目录告警 | 全部符合预期，源端无残留 |
| 2026-11-04 | v4 部署至 opsnas（保留 v3 备份 `pdk_mover.sh.bak.20261104_112957`） | 完成 |

---

## 15. 变更记录

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-10-26 | v1 | 单项目（tsmc/n6）迁移、邮件通知、cron 15 分钟 |
| 2026-10-27 | v2 | 多项目 + 17 目录白名单；配置外置 `/etc/pdk_mover.conf`；SMTP 口令移出脚本；原子落地；DRYRUN；目标目录缺失不自动创建；邮件按项目分节 |
| 2026-11-03 | v3 | 递归子目录；内容去重（大小+md5）后删除同内容源文件；`CONFLICT_POLICY` 处理同名不同内容；空目录回收 |
| 2026-11-04 | v4 | 规则简化为「目标存在即覆盖、源端不留」；删除全部策略分支与 `CONFLICT_POLICY`；保留递归与空目录回收；目标缺目录告警并保留源文件 |

---

## 16. 安全与脱敏约定

本仓库所有文件均可公开分发，**不含任何真实凭据**：

| 项 | 处理方式 |
|---|---|
| SMTP 口令 | 脚本一律 `SMTP_PASS="${SMTP_PASS:-}"` 从配置读取；模板中为 `__CHANGE_ME__` |
| 线上配置 `/etc/pdk_mover.conf` | 权限 `0600 root`，**不入库**，`.gitignore` 已排除 |
| sudo 口令 | 不落任何文件；运维脚本从 `~/.mm` 读取（0600） |
| 收件人邮箱 | 文档示例统一用 `ops-pdk@example.com` / `ops-oncall@example.com` 占位，实际值见线上配置 |
| API Key / Token | 本项目不涉及；如后续接入通知渠道，一律走环境变量或 `/etc` 外部配置 |

主机名、内网路径、AD 组名为运维必需信息，保留在文档中；这些不属于凭据。
*（内容由AI生成，仅供参考）*
