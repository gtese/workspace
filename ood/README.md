# OOD / EDA Desktop 项目资料

> Open OnDemand 3.1.16 ｜ 对外地址：**https://edas.tri.local** ｜ SSO：sso.tri.local

## 1. 当前能力

- 浏览器登录 OOD，Keycloak OIDC 单点登录
- Interactive Apps → **EDA Desktop**
- 用户选择 **150 / 151 / 152 / 153 / 154 / 155** 单个节点
- 下拉菜单显示节点：总内存、已用、可用、运行作业数、状态
- 用户填写 **Memory (GB)**，提交自动转成 `--mem=<N>G`
- 固定 `--nodes=1`，不允许多节点桌面
- 不再填写分区：150 自动用 `eda`，151-155 自动用 `eda15x`

## 2. 文档

| 文档 | 内容 |
|---|---|
| [用户手册](docs/用户手册.md) | 登录、启动桌面、连接 VNC、EDA 使用 |
| [运维手册](docs/运维手册.md) | Apache/PUN/OIDC/VNC/websockify 配置与排障 |
| [变更记录](docs/变更记录.md) | 2026-11-11 迁移和修复记录 |
| [**图文用户指南**](docs/图文用户指南.md) | 🆕 Web 登录、GUI 桌面、Web Shell 提交作业（带截图） |

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
```

所有 `oidc_client_secret`、`oidc_crypto_passphrase`、`OIDCClientSecret`、`OIDCCryptoPassphrase` 均已替换为 `<redacted>`。

## 4. 关键路径

- OOD 门户配置：`/etc/ood/config/ood_portal.yml`
- 集群配置：`/etc/ood/config/clusters.d/tricluster.yml`
- Desktop 子应用：`/etc/ood/config/apps/bc_desktop/eda.yml.erb`
- 提交配置：`/etc/ood/config/apps/bc_desktop/submit/ood.yml.erb`
- Apache 生成配置：`/etc/httpd/conf.d/ood-portal.conf`
- 用户 PUN 数据：`/home/<user>/ondemand` → `/eda/workspace/users/<user>/ondemand`

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
