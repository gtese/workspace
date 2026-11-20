# BCP 业务连续性计划（backup-center）

> 版本：v1.1（2026-11-20）　|　适用范围：TRI 集中备份平台（172.16.50.150）
> 关联文档：[灾难恢复](灾难恢复.md)、[运维手册](运维手册.md)、[项目文档](项目文档.md)

## 1. 服务分级与依赖

| 服务 | 说明 | 关键度 | 依赖 |
|---|---|---|---|
| 备份控制面 | Web/API、调度、审批、元数据、恢复编排 | **关键** | 150 主机、SQLite、主密钥、CA、Keycloak |
| 备份仓库 | restic 仓库（/data2/backup/restic、projects） | **关键** | /data2 磁盘、文件系统 |
| 代理 | Linux/macOS 客户端采集与恢复 | 重要 | 150:8443、本地文件系统 |
| 身份 | Keycloak SSO（Group_Roots） | 重要 | sso.tri.local、AD |
| 监控/告警 | 邮件/Webhook、Prometheus | 重要 | SMTP/Webhook 目标 |

**单点事实**：控制面与仓库同处 150；/data2 为单块 SATA；当前无异地副本；150 同时也是 Slurm 计算节点。

## 2. BIA 与目标（建议基线）

| 场景 | RPO | RTO | 说明 |
|---|---|---|---|
| 单文件误删/误改 | ≤ 24h（按计划） | **≤ 15 分钟** | 通过 Web 快照浏览 + 文件级恢复 |
| 单主机文件系统损坏 | ≤ 24h | ≤ 2 小时 | 重装后代理恢复，或直接下载数据 |
| 备份仓库损坏 | ≤ 24h + 副本延迟 | ≤ 8 小时 | 需异地/离线副本；当前为缺口 |
| 150 控制面整机丢失 | ≤ 24h（控制面导出） | ≤ 4 小时 | 冷备重建 + 恢复 master.key/DB/CA |
| 勒索软件加密仓库 | 按离线副本周期 | ≤ 8 小时 | 需要不可变/离线副本；当前为缺口 |
| Keycloak 故障 | 0 | ≤ 15 分钟 | 本地应急 admin 登录 |

> RPO/RTO 是管理目标，不是当前实测能力；当前自动化程度见第 3、4 节。

## 3. 3-2-1-1-0 现状评估

| 原则 | 现状 | 结论 |
|---|---|---|
| 3 份副本 | 生产仓库 + 本机 db-backups + 手工离线加密导出 | **部分**：缺自动化异地仓库副本 |
| 2 种介质 | /data2 SATA + USB 离线盘（手工） | **部分**：依赖人工轮换 |
| 1 份异地 | 无 | **不符合（P1）** |
| 1 份离线/不可变 | 有手工加密导出到 USB | **部分**：无 WORM/对象锁；服务器 root 可删仓库 |
| 0 错误（可恢复验证） | 每周 restic check、每月 1% 读校验、**自动恢复演练**（本轮新增） | **改善**：仍需定期人工确认演练结果 |

## 4. 故障场景与处置

### 4.1 控制面（150）宕机
1. 确认 150 电源/系统；尝试 systemd 重启（`backup-center`、`backup-mountd`）。
2. 无法恢复：按《灾难恢复》在备用机安装同版本，恢复 `master.key`、`backup.db`、`ca/`、`config.json`、`tls/`。
3. 启动后核对节点证书、仓库路径、计划；代理会自动重连。
4. 目标 RTO ≤ 4h；每季度演练一次冷备重建。

### 4.2 仓库损坏/误删
1. 立即停用相关计划，保留现场。
2. `restic check --read-data-subset=10%` 确认损坏范围。
3. 从异地/离线副本恢复仓库目录；无副本则从快照重建（受 RPO 限制）。
4. 复盘权限与操作审计；启用不可变副本前禁止直接删除。

### 4.3 勒索软件
1. 隔离 150 与代理网络；不要挂载备份盘到受感染主机。
2. 使用**离线/不可变副本**恢复；校验副本完整性后再上线。
3. 轮换仓库密码、CA、管理员凭据；审计异常登录/恢复。

### 4.4 Keycloak/AD 故障
1. 使用本地应急 admin 登录（仅 admin，密码离线保管）。
2. IdP 恢复后验证 Group_Roots 映射；非管理员仍拒绝登录。

### 4.5 主密钥/CA 丢失
- 主密钥丢失 = 仓库密码不可解；CA 丢失 = 代理证书无法续签。
- 只能从离线导出恢复；恢复后需验证历史快照可读、代理可续期。

## 5. 恢复顺序

1. 基础设施（网络、存储、150 系统）→ 2. 控制面（DB/主密钥/CA）→ 3. 仓库挂载与校验 → 4. 代理重连/证书 → 5. 按业务优先级恢复数据（EDA 项目 > 系统配置 > 其他）→ 6. 复盘与告警关闭。

## 6. 演练与指标

| 演练 | 频率 | 负责 | 证据 |
|---|---|---|---|
| 自动恢复演练（单个小文件 + `--verify`） | 每 30 天/节点+池 | 平台自动 | `repo_checks kind=restore-drill`，失败告警 |
| 人工全量恢复演练 | 每半年 | 备份管理员 + 数据 owner | 恢复记录、耗时 |
| 冷备重建（控制面） | 每季度 | 基础设施 | DR 导出包恢复记录 |
| 勒索/离线副本切换 | 每年 | 安全 + 基础设施 | 桌面演练报告 |

**SLO/指标**（Prometheus `/api/metrics`）：
- `backup_plan_last_success_age_seconds` / `backup_plan_rpo_seconds`：RPO 合规
- `backup_last_restore_drill_ok_timestamp`：演练新鲜度
- `backup_check_last_ok_timestamp`：仓库校验
- `backup_repo_used_ratio`、`backup_tls_cert_expires_seconds`、`backup_active_tasks`
- `/healthz?deep=1`：DB、仓库挂载、restic、TLS 证书

## 7. 角色与沟通

| 角色 | 职责 |
|---|---|
| 备份管理员（Group_Roots） | 计划、审批、恢复、演练、容量 |
| 基础设施 | 150/存储/网络/冷备机 |
| 安全 | 密钥托管、勒索响应、审计复核 |
| 数据 owner | 恢复优先级、验收恢复结果 |

应急沟通：值班群 + 邮件；P1 事件 15 分钟内通报，1 小时内给出初步影响范围。

## 8. 30/60/90 天改进路线

- **30 天**：配置 SMTP/Webhook 告警；把 `dr-export.timer` 指向两个真实挂载点；完成一次人工全量恢复。
- **60 天**：增加异地仓库副本（NAS/对象存储，最好开启对象锁/不可变）；每月审阅 RPO 报表。
- **90 天**：冷备机自动化重建脚本；半年 DR 演练；评估对象锁/WORM 与四眼删除审批。

## 9. 替代方案调研（2026-11）

| 方案 | 类型 | 优势 | 局限/适用性 |
|---|---|---|---|
| Veeam | 商业 | 虚拟化/企业生态成熟、应用一致性、即时恢复 | Windows 控制台、按实例授权；文件级 Linux/macOS 与内网 SSO 需额外组件，成本高（[Veeam 替代分析](https://hackceleration.com/labs/switch/veeam)） |
| Rubrik / Cohesity | 商业 | 不可变、SLA 管理、勒索恢复、规模化 | 一体机/订阅成本高，适合大型机房（[替代分析](https://hackceleration.com/labs/switch/veeam)） |
| Nakivo / Acronis / Datto | 商业 | 轻量、VM/终端、托管服务 | 文件级多租户与自建 SSO 适配有限 |
| Proxmox Backup Server | 开源 | 去重、加密、校验、 prune、与 PVE 深度集成 | 主要面向 PVE 虚拟机；Linux/macOS 文件代理与多租户审批需另配（[官方](https://www.proxmox.com/en/products/proxmox-backup-server/overview)） |
| UrBackup | 开源 | 文件+镜像、Web UI、客户端/服务器、部署简单 | 企业 SSO、多池、细粒度审批与审计弱于本项目（[官方](https://www.urbackup.org/)） |
| Kopia / restic + Backrest | 开源 | 去重加密、仓库灵活、CLI 成熟 | 控制面/多租户/审批/审计需自建（本项目即此路线） |
| Bacula / Bareos | 开源 | 企业级调度、磁带、插件生态 | 部署运维复杂，学习曲线陡 |

**结论**：本项目“restic + 自研控制面”在**多节点审批、Keycloak Group_Roots、多备份池、文件级恢复、内网 mTLS**上匹配度最高；商业产品在**不可变副本、HA、SLA 报表、生态**上更成熟。BCP 优化应优先补齐**异地/不可变副本、演练、监控告警**，而不是替换引擎。

## 10. 参考

- [GigeNET: Best Open Source Backup Software (2026)](https://www.gigenet.com/blog/open-source-backup-solutions/)
- [Hack'celeration: Veeam alternatives](https://hackceleration.com/labs/switch/veeam)
- [Proxmox Backup Server](https://www.proxmox.com/en/products/proxmox-backup-server/overview)
- [UrBackup](https://www.urbackup.org/)
- [Virtualization Review: 备份可达性/勒索风险](https://virtualizationreview.com/articles/2026/11/18/recovery-expert-if-you-can-get-to-your-backups-so-can-an-attacker.aspx)
