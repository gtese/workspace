# Slurm 项目资料

> 集群：tricluster ｜ 控制节点 trivm123 ｜ 计算节点 eda150-155（131-133 已移除）

## 1. 当前架构

| 角色 | 主机 | IP | 说明 |
|---|---|---|---|
| 控制/提交 | trivm123 | 172.16.50.123 | slurmctld / slurmdbd / OOD |
| 计算节点 | eda150 | 172.16.50.150 | 384 核 / 400 GB |
| 计算节点 | eda151-155 | 172.16.50.151-155 | 112 核 / 1900 GB（154 为 group_dedv 独占）|

分区：

```text
eda15x  Default=YES  Nodes=172.16.50.[150-153,155]
node154             Nodes=172.16.50.154  AllowGroups=group_dedv
```

> 131-133 已从 Slurm 移除，`eda` 分区已删除；150 已并入 `eda15x`。154 仅 `group_dedv` 可提交。

## 2. 手册

| 文档 | 内容 |
|---|---|
| [用户手册](docs/02-用户手册.md) | 登录、分区、共享目录、提交、License、FAQ |
| [新人快速上手](docs/07-新人快速上手.md) | 堡垒机登录、建目录、单命令/脚本、查看作业 |
| [提交作业指南](docs/06-提交作业指南.md) | EDA 作业示例与错误处理 |
| [Innovus 图形界面脚本注释指南](docs/08-Innovus图形界面脚本注释指南.md) | `innovus-gui-15x.sh` 逐段注解、参数速查、排错、二次开发 |
| [配置文件说明](docs/04-配置文件.md) | slurm.conf、cgroup、OOD、SELinux、防火墙 |
| [2026-11-26 节点与分区调整](docs/2026-11-26-节点与分区调整.md) | 移除 131-133、删除 eda、150 并入 eda15x、作业影响说明 |
| [Slurm 与 OOD 用户操作手册](../ood/docs/Slurm与OOD用户操作手册.md) | 登录、命令行作业、GUI 桌面、FAQ |

根目录 [README](../README.md) 和 `docs/` 下还有安装、管理、故障案例等完整文档。

## 3. 配置文件（脱敏）

```text
config/slurm.conf
config/cgroup.conf
config/slurmdbd.conf.sanitized
config/job_submit.lua
```

- `slurmdbd.conf` 中的数据库密码已替换为 `<redacted>`
- 实际密钥只保存在服务器，不进入 Git

## 4. 关键策略

- `MinJobAge=259200`（72 小时）
- `PrivateData=none`
- `job_submit.lua`：提交到 `eda15x` 必须显式指定 `--mem` 或 `--mem-per-cpu`
- `srun --x11` / OOD Desktop 图形方案见 OOD 项目资料

## 5. GUI 启动脚本（共享目录 `/eda/workspace/share/`）

把 EDA 工具的图形界面通过 Slurm + `ssh -Y` 投到用户自己的 RDP 桌面：

| 脚本 | 用途 |
|---|---|
| `innovus-gui-15x.sh` | 申请 1 个 eda15x 节点并打开 Innovus GUI（注解见 [docs/08](docs/08-Innovus图形界面脚本注释指南.md)） |
| `verdi-gui-15x.sh` | 申请 1 个 eda15x 节点并打开 Verdi GUI（看波形/调试） |

两者用法一致：交互向导，或 `-n 154 -c 2 -m 32 -t 24 -y -- <工具参数>`；`--dry-run` 只预演；
关闭工具或 Ctrl-C 会自动 `scancel` 释放节点。

仓库内对应源码：[`scripts/verdi-gui-15x.sh`](scripts/verdi-gui-15x.sh)

## 6. 常用运维

```bash
sinfo
squeue
scontrol show node 172.16.50.151
scontrol reconfigure
```

## 6. 变更记录

- 2026-11-09：`MinJobAge` 调整为 72 小时
- 2026-11-09：默认分区切换为 `eda15x`
- 2026-11-09：分区合并为 `eda` 与 `eda15x`
- 2026-11-11：OOD 桌面和节点选择完善
- 2026-11-25：154 建立 `node154` 独占分区（仅 group_dedv）
- 2026-11-26：移除 131-133、删除 `eda` 分区；150 并入 `eda15x`。变更期间原有运行作业被取消，后续须先排空队列并确认
