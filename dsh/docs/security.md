# 安全说明

## 目的与边界

本方案要解决的是：**用户能在服务器/桌面 VM 上使用 DeepSeek，但拿不到真实的 DeepSeek API Key。**

采用的边界：

- 真实 DeepSeek Key 只保存在 Open WebUI 后台的连接配置里（管理员可见）；
- 用户侧只有 Open WebUI 的 API Key，且只能访问内网的 `chat.tri.local`；
- 即使用户拿到这个 Key，也拿不到 DeepSeek 官方 Key，也无法在公司网络之外直接调用（前提是 `chat.tri.local` 仅内网可达）。

## 当前实现的取舍

| 项 | 现状 | 影响 |
|---|---|---|
| Key 粒度 | **所有用户共用一个 OWUI Key** | 无法按人限流/吊销/审计；任意用户泄露 key 后只能整体轮换 |
| Key 可见性 | `/eda/apps/deepseek/etc/dsh.env` 权限 644 | 登录用户可 `cat` 到共享 key，也可绕过 dsh 直接调 OWUI（仍在内网范围内） |
| 网络边界 | `chat.tri.local` 仅内网/VPN 可达 | 外部无法使用；若未来发布到公网，需重新评估 |
| 真实 DS Key | 仅存在于 OWUI 管理后台 | 用户不可见，符合目标 |
| 用户隔离 | 每人自己的 `~/.dsh` / 进程 | 会话、文件互不可见 |
| 共享 dsh Web 服务 | **未使用** | dsh 是单操作者模型，共享实例无法隔离，本方案每用户各自起进程 |

> 共享 key 是产品要求（“都用同一个 key”），不是安全缺陷；如果后续需要按人计量/吊销，见“演进方向”。

## 密钥管理

- **不要**把 `/eda/apps/deepseek/etc/dsh.env` 提交到 git（仓库只保留 `config/dsh.env.example`）。
- 轮换：
  ```bash
  sudo DSH_API_KEY='sk-新key' /path/to/dsh/scripts/deploy-desktop.sh
  ```
  已经在运行的 dsh 进程仍持有旧环境变量，重启后生效。
- Key 只应发放给 dsh 启动器使用；OWUI 中可随时删除/禁用该 key。

## 内部 CA

- `config/pki/tri-enterprise-root.pem` 是**公开证书**（公钥，不是私钥），可以入库；
- 指纹记录在 `docs/inventory.md`，可用于核对；
- 启动器只对 dsh/shim 进程设置 `NODE_EXTRA_CA_CERTS`，不修改系统信任库，缩小影响面；
- 如需系统级信任，单独评估（会把内部 CA 加进全系统信任）。

## shim 的安全性

`dsh-owui-shim.mjs`：

- 只监听 `127.0.0.1` 随机端口；
- 不落盘、不记录请求体/密钥（调试日志也不含 key）；
- 原样转发 `x-api-key` 给 OWUI，不自行持有密钥；
- 随 dsh 进程生命周期启动/退出。

## 用户可见与不可见

| 用户可见 | 用户不可见 |
|---|---|
| 共享 OWUI Key（`/etc/dsh.env`、进程环境） | 真实 DeepSeek API Key |
| 自己的 `~/.dsh` 会话与工作区 | 其他用户的会话/工作区 |
| `chat.tri.local` 可访问 | OWUI 管理员配置、上游连接凭据 |

## 演进方向（需要时）

1. **按人 key**：在 OWUI 为每个用户创建 API Key，写入各自的 `~/.config/dsh/env`（600）；启动器已支持该文件覆盖，无需改代码。
2. **按人配额**：OWUI 前加 LiteLLM/One-API 之类的网关，按 key 配预算/限速/审计；dsh 侧只改 `DEEPSEEK_BASE_URL` 与 key。
3. **更严格隔离**：把每个用户的 dsh 放进独立容器 + SSO 门户；成本更高，当前场景不需要。
4. **撤销共享 key**：删除 `/etc/dsh.env` 中的 `DEEPSEEK_API_KEY` 行，改为每用户 key，或直接停用流程。

## 事故响应

1. 怀疑共享 key 泄露：在 OWUI 删除/轮换 key → 在 107 更新 `/etc/dsh.env` → 通知用户重启 `dsh`；
2. 确认影响面：OWUI 侧按 key 的调用日志/额度记录（当前共享 key 只能看到总量）；
3. 若需长期按人追溯，切换到“按人 key”方案。
