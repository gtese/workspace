# EDAS / Open OnDemand 访问地址迁移

**变更日期**：2026-11-11  
**新地址**：<https://edas.tri.local>  
**旧地址**：`https://trivm123.tri.local`（已停用）

---

## 1. 变更内容

| 项目 | 变更前 | 变更后 |
|---|---|---|
| OOD 对外 URL | `https://trivm123.tri.local` | `https://edas.tri.local` |
| DNS | trivm123 | `edas.tri.local -> 172.16.50.123` |
| Keycloak client `ood` | redirect `https://trivm123.tri.local/*` | redirect `https://edas.tri.local/*` |
| OOD clusters.d | url/login host trivm123 | edas |
| Portal 集群门户卡片 | `https://trivm123.tri.local` | `https://edas.tri.local` |

旧 URL 当前返回 404，不再对外提供服务。

---

## 2. 关键配置

### OOD

文件：

- `/etc/ood/config/ood_portal.yml`
- `/etc/ood/config/clusters.d/tricluster.yml`
- `/etc/ood/config/apps/bc_desktop/form.yml`
- `/etc/ood/config/apps/bc_desktop/submit.yml.erb`

核心值：

```yaml
servername: edas.tri.local
logout_redirect: '/oidc?logout=https%3A%2F%2Fedas.tri.local'
```

Apache 配置由以下命令重新生成：

```bash
/opt/ood/ood-portal-generator/sbin/update_ood_portal
systemctl try-restart httpd
```

### Keycloak

realm：`tri`  
client：`ood`

```json
{
  "clientId": "ood",
  "rootUrl": "https://edas.tri.local",
  "adminUrl": "https://edas.tri.local",
  "redirectUris": ["https://edas.tri.local/*"],
  "webOrigins": ["https://edas.tri.local"],
  "attributes": {
    "post.logout.redirect.uris": "https://edas.tri.local/*"
  }
}
```

### Portal

`src/apps.js` 中 slurm 卡片：

```js
url: 'https://edas.tri.local'
```

已重新构建并部署：

```bash
cd /opt/tri-portal
./deploy/deploy.sh update
```

---

## 3. 验证记录

| 检查 | 结果 |
|---|---|
| DNS：`edas.tri.local` | 172.16.50.123 |
| 证书 SAN | `*.tri.local`, `tri.local`（覆盖 edas） |
| 新 URL 未登录访问 | 302 → `sso.tri.local`，redirect_uri = `https://edas.tri.local/oidc` |
| OIDC 完整登录 | 成功，最终返回 `https://edas.tri.local/pun/sys/dashboard` 200 |
| 旧 URL | 404 |
| Portal 容器 | 已重建，卡片 URL 已更新 |

---

## 4. 回滚要点

1. OOD：
   ```bash
   cp -a /etc/ood/config/ood_portal.yml.bak-edas-* /etc/ood/config/ood_portal.yml
   cp -a /etc/ood/config/clusters.d/tricluster.yml.bak-edas-* /etc/ood/config/clusters.d/tricluster.yml
   /opt/ood/ood-portal-generator/sbin/update_ood_portal
   systemctl try-restart httpd
   ```
2. Keycloak：把 client `ood` 的 rootUrl/redirectUris/webOrigins/post.logout 改回旧地址。
3. Portal：把 `src/apps.js` 改回旧地址并执行 `./deploy/deploy.sh update`。

---

## 5. 安全说明

本目录中的配置均为**脱敏副本**：

- 不包含 Keycloak client secret
- 不包含 OIDC crypto passphrase
- 不包含 `.env`、数据库密码、LDAP 密码、管理员密码

实际密钥只保存在服务器对应配置文件中，权限 `600`，不进入 Git。

---

## 6. 关联提交

| 仓库 | 提交 |
|---|---|
| `it/slurm` | `b1359f9` docs: OOD 访问地址迁移到 edas.tri.local |
| `it/oidc` | `0f91ffb` docs: .env.example 中 OOD 地址更新为 edas.tri.local |
| `it/portal` | `ad4b066` docs: 集群门户卡片地址改为 edas.tri.local |
| `workspace` | `6bc00e0` docs: add EDAS OOD migration dossier |

---

## 7. Portal 运行数据

Portal 源码默认卡片已更新，但运行中的 Portal 使用 Docker/Podman 数据卷中的
`/app/data/portal-config.json` 覆盖默认值。

已更新并重启：

```bash
# 在 172.16.50.122 上
podman exec tri-portal node -e '...将 slurm.url 改为 https://edas.tri.local...'
systemctl restart tri-portal
```

验证：

```text
GET https://portal.tri.local/api/apps
=> slurm.url = https://edas.tri.local
```

备份文件：容器内 `/app/data/portal-config.json.bak-edas-*`。
