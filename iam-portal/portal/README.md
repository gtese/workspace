# 企业应用门户（portal.tri.local）

员工登录公司统一身份后，在一个页面看到自己可用的所有内部系统，点一下即进入。

| 项 | 值 |
|---|---|
| 访问地址 | **https://portal.tri.local** |
| 部署主机 | `trivm122.tri.local`（172.16.50.122），容器 `tri-portal`，`127.0.0.1:8095` |
| 技术栈 | Node.js 20 零依赖 + nginx 反代 |
| 认证 | 公司统一身份 sso.tri.local（OIDC，授权码 + PKCE S256） |
| 当前应用 | chat、work（已接 SSO）、gitlab、**slurm（Open OnDemand，已接 SSO）** |
| 编辑功能 | 管理员可在页面拖动排序、增删改卡片（v1.1.0，2026-11-04） |
| 验收 | 登录链路 12/12；编辑功能 10/10 |

## 文档

- [部署文档](docs/部署文档.md)：员工用法、应用清单、架构、部署、运维、验收记录、已知限制、下一步

## 常用命令

```bash
./deploy/deploy.sh status    # 状态与健康检查
./deploy/deploy.sh update    # 改了 src/apps.js 后重建并重启
./deploy/deploy.sh logs      # 日志
python3 deploy/scripts/verify.py <域账号> <口令>   # 端到端验收
```

## 增删应用（两种方式）

1. **页面编辑（推荐）**：管理员登录 → 右上角 **✏️ 编辑** → 拖动排序 / 增删改 → 保存（立即生效）
2. **改代码默认值**：改 `src/apps.js` 的 `DEFAULT_APPS` → `./deploy/deploy.sh update`

> 页面里的自定义优先于代码默认值，存在 `tri-portal-data` 数据卷，容器重建不丢。
> 每次保存自动备份到 `/app/data/backups/`（保留 30 份）。

## 验收

```bash
python3 deploy/scripts/verify.py <域账号> <口令>        # 登录链路 12 项
python3 deploy/scripts/verify-edit.py <管理员账号> <口令>  # 编辑功能 10 项
```
