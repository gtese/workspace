# 变更记录

## 2026-11-23
- 新增 `docs/恢复手册.md`：文件级/单机/控制面/仓库/密钥/Keycloak/勒索场景实操步骤。
- `recover.mjs` 适配多备份池（`--repo-id`），未指定时列出可选池。
- 恢复接口空 `includes` 校验（400），防止整快照覆盖。
- 登录策略调整：`Group_Roots` 自动 admin；其他域账号在「用户与角色」预置并启用后可按 operator/viewer/auditor 登录；未预置账号仍拒绝。
- zhoutao（operator）恢复登录能力；恢复快照需 operator/admin。
- 修复恢复接口安全校验：禁止空 `includes`（防止整快照覆盖），校验目标路径/覆盖策略/多池 repository_id。
- 文档同步登录与 RBAC 说明。

## 2026-11-20
- 项目文档成型：`docs/项目文档.md`、README 更新、内网 GitLab 仓库 `it/backup` 发布。
- **BCP 评估与 5 轮优化**：
  1. 计划 RPO/SLA：超时告警 + 客户端在线自动补备；RPO 指标。
  2. 自动恢复演练：每 30 天从最新快照还原小文件并 `--verify`，失败告警。
  3. 深健康 `/healthz?deep=1`、Prometheus 指标扩展（RPO/演练/证书/队列）、logrotate。
  4. 控制面 DR 自动导出脚本 + systemd timer（加密到两个挂载点，待配置真实异地介质）。
  5. `docs/BCP.md`：RTO/RPO、3-2-1-1-0 差距、故障处置、演练计划、替代方案调研。

## 2026-11-19
- 修复节点删除后仍显示：软删除记录默认从列表/统计过滤，计划自动停用。
- 接入命令内置**企业根 CA**（base64），避免首次 `curl -k`；修正误用平台代理 CA 的问题。
- 文档补充一次性 token、节点接入/删除、保留策略说明。
- 多备份池 prune/check 按 (节点, 池) 维度执行。

## 2026-11-18
- Keycloak SSO 启用：`backup-center` client、groups/roles mapper、`backup:admin` 授予 `Group_Roots`；其他员工 viewer。
- 多备份池：`client_repo_keys`、按池浏览/下载/恢复、路径安全校验。
- 修复审批中心只加载 pending、恢复干跑与 SELinux xattr、REST 协议/证书链问题。
- 生产验收：安装、备份、增量、恢复、校验、审计。
