# OOD / EDA Desktop 项目资料

> Open OnDemand 3.1.16 ｜ 对外地址：**https://edas.tri.local** ｜ SSO：sso.tri.local

## 1. 当前能力

- 浏览器登录 OOD，Keycloak OIDC 单点登录
- Interactive Apps → **EDA Desktop**
- 用户选择 **150 / 151 / 152 / 153 / 154 / 155** 单个节点
- 下拉菜单显示节点：CPU 可用/已用/总、内存可用/已用/总、运行作业数、状态
- 默认选择空闲 CPU 最多的节点，避免默认落到满载节点
- 用户填写 **CPU cores**，提交自动转成 `--cpus-per-task=<N>`
- 用户填写 **Memory (GB)**，提交自动转成 `--mem=<N>G`
- 固定 `--nodes=1`，不允许多节点桌面
- 所有作业（含 Desktop）最长 128 小时
- 节点分区：150/151/152/153/155 使用 `eda15x`；154 使用 `node154`（仅 `group_dedv` 成员可提交）
- 首页新增集群概览：节点数、用户数、当前/历史作业、CPU、可用 CPU、总内存与可用内存、节点明细
- Active Jobs 增加 Partition/Host/Memory/CPUs 列，以及 Stop、Remove from List 操作
- 新增 Node Isolation 管理应用：把节点隔离给指定 AD 组（创建 `iso_<host>` 分区），带审计

## 2. 文档

| 文档 | 内容 |
|---|---|
| [用户手册](docs/用户手册.md) | 登录、启动桌面、连接 VNC、EDA 使用 |
| [运维手册](docs/运维手册.md) | Apache/PUN/OIDC/VNC/websockify 配置与排障 |
| [变更记录](docs/变更记录.md) | 2026-11-11 迁移和修复记录 |
| [**图文用户指南**](docs/图文用户指南.md) | Web 登录、GUI 桌面、Web Shell 提交作业（带截图） |
| [**Slurm 与 OOD 用户操作手册**](docs/Slurm与OOD用户操作手册.md) | 两系统介绍、内网/VPN 登录、命令行/GUI 提交、注意事项 |
| [2026-11-26 集群与 OOD 改版](docs/2026-11-26-集群与OOD改版.md) | 节点/分区调整、Active Jobs、首页统计、Node Isolation、已知影响 |

## 3. 配置（脱敏）

```text
config/ood_portal.sanitized.yml
config/apache-ood-portal.sanitized.conf
config/clusters-tricluster.yml
config/bc_desktop-eda.yml.erb
config/bc_desktop-submit-ood.yml.erb
config/keycloak-ood-client.sanitized.json
config/ood-env
config/ondemand-ood.yml
config/dashboard-initializer-ood.rb
config/shell-manifest.yml
config/myjobs-env
config/custom.css
config/ood-jobctl
config/ood-jobctl.sudoers
config/node-isolation/         # app.js / manifest / config / helper / sudoers
code/dashboard/                # 首页统计、Active Jobs 定制源码
```

所有 `oidc_client_secret`、`oidc_crypto_passphrase`、`OIDCClientSecret`、`OIDCCryptoPassphrase` 均已替换为 `<redacted>`。

## 4. 关键路径

- OOD 门户配置：`/etc/ood/config/ood_portal.yml`
- 集群配置：`/etc/ood/config/clusters.d/tricluster.yml`
- Desktop 子应用：`/etc/ood/config/apps/bc_desktop/eda.yml.erb`
- 提交配置：`/etc/ood/config/apps/bc_desktop/submit/ood.yml.erb`
- Apache 生成配置：`/etc/httpd/conf.d/ood-portal.conf`
- 用户 PUN 数据：`/home/<user>/ondemand` → `/eda/workspace/users/<user>/ondemand`
- 首页统计：`/var/www/ood/apps/sys/dashboard/app/helpers/cluster_summary_helper.rb` + `app/views/widgets/_cluster_summary.html.erb`
- Active Jobs 定制：Dashboard 的 controller/view/javascript
- Node Isolation：`/var/www/ood/apps/sys/node-isolation/` + `/usr/local/sbin/node-isolationctl`
- 全局主题：`/var/www/ood/public/custom.css`

## 5. 维护要点

1. 修改 `servername` / `OOD_ALLOWED_HOSTS` 后必须清理 PUN：
   ```bash
   /opt/ood/nginx_stage/sbin/nginx_stage nginx_clean -f
   ```
2. 修改 `ood_portal.yml` 后重新生成 Apache：
   ```bash
   /opt/ood/ood-portal-generator/sbin/update_ood_portal
   systemctl try-restart httpd
   ```
3. Keycloak client `ood` 的 redirect URI 必须为 `https://edas.tri.local/*`


## 7. 2026-11-26 状态更新

- Slurm 节点：150-155；131-133 已移除，`eda` 分区已删除；150 已并入 `eda15x`。
- `node154` 仍为 154 独占分区，仅 `group_dedv` 可提交。
- OOD 首页新增集群概览；Active Jobs 支持停作业/从列表移除；Node Isolation 应用已上线。
- 注意：应用 Slurm 节点/分区变更时，原有运行作业被取消；后续变更须先排空队列并获得确认。

## 8. OOD RPM 版本说明

当前存在 `ondemand-3.1.16` 与 `ondemand-apache/nginx/ruby/runtime-3.1.6` 混用；仓库暂无 3.1.16 基础组件。UI 已通过 `custom.css` 统一，后续应在维护窗口统一包版本。
