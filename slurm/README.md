# Slurm 项目资料

> 集群：tricluster ｜ 控制节点 trivm123 ｜ 计算节点 eda151-155

## 1. 当前架构

| 角色 | 主机 | IP | 说明 |
|---|---|---|---|
| 控制/提交 | trivm123 | 172.16.50.123 | slurmctld / slurmdbd / OOD |
| 计算节点 | eda151-155 | 172.16.50.151-155 | 112 核 / 1900 GB、单机 2 TB 级内存 |

分区：

```text
eda15x  Default=YES  Nodes=172.16.50.[151-155]
```

> 老节点 131-133、150 仍保留在兼容分区 `eda`，但新作业默认进入 `eda15x`。

## 2. 手册

| 文档 | 内容 |
|---|---|
| [用户手册](docs/02-用户手册.md) | 登录、分区、共享目录、提交、License、FAQ |
| [新人快速上手](docs/07-新人快速上手.md) | 堡垒机登录、建目录、单命令/脚本、查看作业 |
| [提交作业指南](docs/06-提交作业指南.md) | EDA 作业示例与错误处理 |
| [配置文件说明](docs/04-配置文件.md) | slurm.conf、cgroup、OOD、SELinux、防火墙 |
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

## 5. 常用运维

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
