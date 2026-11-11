# 部署清单（2026-11-06）

## 主机

| 主机 | IP | 角色 | 系统 | `/eda/apps` |
|---|---|---|---|---|
| opsnas.tri.local | 172.16.50.107 | 安装/可写节点（部署入口） | Rocky Linux 8.10 x86_64 | NFS rw |
| trivm131.tri.local | 172.16.50.131 | 桌面节点（已验证） | Rocky Linux 8.10 x86_64 | NFS ro |
| trivm132.tri.local | 172.16.50.132 | 桌面节点（已验证） | Rocky Linux 8.10 x86_64 | NFS ro |
| trivm133.tri.local | 172.16.50.133 | 桌面节点（已验证） | Rocky Linux 8.10 x86_64 | NFS ro |

## 软件版本

| 软件 | 版本 | 路径 |
|---|---|---|
| Node.js | v24.18.1 | `/eda/apps/deepseek/bin/node` |
| @deepseek-ai/dsh | **0.2.2-rc.1**（2026-11-11 升级） | `/eda/apps/deepseek/lib/node_modules/@deepseek-ai/dsh` |
| dsh 依赖包数量 | 200 | `.../dsh/node_modules` |
| pnpm | 11.28.11 | `/eda/apps/deepseek/bin/pnpm` |
| npm | 11.16.0 | 随 Node 自带 |
| Open WebUI | 0.12.4 | `https://chat.tri.local`（OIDC 登录） |
| Open WebUI 模型 | `deepseek-flash`、`deepseek-v4-pro` | 与 dsh 默认模型 id 一致 |

## 文件与校验和

| 文件 | 权限/属主 | SHA-256 |
|---|---|---|
| `/eda/apps/deepseek/bin/dsh-desktop` | 755 root:root | `7cf8b8b259f6e50c70928190fca3b9d171b702e7db747f5a31730181e93d34ff` |
| `/eda/apps/deepseek/bin/dsh-owui-shim.mjs` | 755 root:root | `b567f0fdee4af94a491d53c95ba32e1bfaabed6e530b4b7ce116050e1899b990` |
| `/eda/apps/deepseek/etc/dsh.env` | 644 root:root | `d44356b8ceccecf2a21a4c4314b36e1a9e0696c19764dd1473483ce359ffd698`（含共享 key，不入库） |
| `/eda/apps/deepseek/certs/tri-enterprise-root.pem` | 644 root:root | `522b76da2b540fecc6452f076ec00d6d674c9c034d522ac3e3c0d6def7794c98` |
| `/eda/apps/deepseek/bin/node` | 755 user:user | `f3432a45b03b2da0d270095fdd8813dc34cbea73f5fc8b18c7a384b7cf9b333a` |
| `/usr/local/bin/dsh` | symlink root:root | `-> /eda/apps/deepseek/bin/dsh-desktop` |

## 升级记录

| 日期 | 版本 | 操作 | 备份 |
|---|---|---|---|
| 2026-11-05 | 0.2.0-rc.2 | 首次安装 | - |
| 2026-11-11 | 0.2.2-rc.1 | `npm install -g --prefix /eda/apps/deepseek @deepseek-ai/dsh@0.2.2-rc.1`（added 139 / removed 25 / changed 515 packages） | `/eda/apps/deepseek-backup-0.2.0-rc.2-20261111.tar.gz`（116MB） |

升级后 `dsh` 包目录约 902MB。npm 11.16 的 allow-scripts 提示 koffi / node-pty / dsh-subprocess-local 等 install 脚本未执行，已实测原生模块与 pty 均正常。

## 存储与挂载

```
172.16.20.13:/fs/eda_nas/eda_apps  nfs  rw,nosuid,nodev,vers=3,sec=sys  -> /eda/apps   (107)
172.16.20.13:/fs/eda_nas/eda_apps  nfs  ro,nosuid,nodev,vers=3,sec=sys  -> /eda/apps   (131)
```

- 容量：20T（已用 6.1T，约 31%，2026-11-06）
- 安装目录占用：约 717MB
- SELinux：Enforcing（`nfs_t`，Node/dsh 可正常执行）

## 内部 CA

| 项 | 值 |
|---|---|
| Subject / Issuer | `DC=local, DC=tri, CN=Enterprise Root CA`（自签根） |
| 有效期 | 2026-10-22 ～ 2046-10-22 |
| SHA-256 指纹 | `B4:30:C8:4A:27:93:6B:EE:97:4C:F6:46:A2:2B:8F:7A:A9:0A:CF:D2:4E:96:3C:6F:4E:C8:81:37:95:C2:45:EF` |
| 用途 | `chat.tri.local` 等 `*.tri.local` 证书签发根 |

## 用户数据

| 路径 | 内容 | 权限 |
|---|---|---|
| `~/.dsh/` | 会话、profile、`storages`、`.credentials.yaml` | 用户；credentials 600 |
| `~/.config/dsh/env` | 可选的用户级覆盖（如个人 key） | 用户 600 |

## 相关 DNS

| 名称 | 地址 | 用途 |
|---|---|---|
| `chat.tri.local` | 172.16.50.122 | 内网 Open WebUI（模型网关） |
| `git.tri.local` | 172.16.50.109 | GitLab（本仓库） |
| `opsnas.tri.local` | 172.16.50.107 | NFS 可写节点 / 部署入口 |
| `trivm131.tri.local` | 172.16.50.131 | 桌面节点 |
