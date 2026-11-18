# backup-center — 集中式文件备份平台

> 部署主机：`172.16.50.150`（`eda.tri.local`）
> 访问地址：`https://backup.tri.local`（DNS 待添加；临时可用 `https://backup.tri.local`）

## 能力

- Web 集中管理：节点审批接入、目录/文件选择、备份计划、快照版本、文件级恢复、审计、告警
- 代理模式：Linux（systemd）/ macOS（launchd），只出站，mTLS 双向认证
- 引擎：restic 0.18.0（首次全备 + 永久增量去重、zstd 压缩、AES-256 加密、快照保留）
- 数据面：Node 内置 restic REST 协议（mTLS + append-only + 每个节点独立仓库）
- 存储位置：本地目录 / NFS / SMB(CIFS) / FTP(S)
- 身份：Keycloak SSO + 本地应急管理员，RBAC（admin/operator/viewer/auditor）

## 目录

```text
docs/架构.md      架构与接口契约（先读）
server/           Node 24 零依赖管理端
agent/            Go 备份代理
ui/               Vue 3 前端（构建到 server/public）
deploy/           systemd、安装脚本、挂载助手、二进制分发清单
scripts/          构建/验收/巡检脚本
```

## 开发

```bash
# 服务端（无需 npm install）
node server/src/main.mjs --config server/dev/config.json
node --test server/test/

# 前端
cd ui && npm ci && npm run dev       # /api 代理到 http://127.0.0.1:9443
npm run build                        # 产物到 ../server/public

# 代理
cd agent && go test ./...
../scripts/build-agent.sh
```

## 部署

见 [docs/部署手册.md](docs/部署手册.md)、[运维手册](docs/运维手册.md)、[用户手册](docs/用户手册.md)、[灾难恢复](docs/灾难恢复.md)、[验收报告](docs/验收报告.md)。

生产地址：`https://backup.tri.local`（`backup.tri.local` DNS 待添加）。

## 版本

| 组件 | 版本 |
|---|---|
| restic | 0.18.0 |
| rclone（仅 FTP 后端） | 1.76.0 |
| Node | 24.18.1（本机复制，不用 dnf） |
| Go | 1.27+（仅构建期） |
