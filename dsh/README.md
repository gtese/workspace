# DeepSeek Harness 内网桌面部署（dsh）

在 Rocky Linux 8 桌面环境中，用户输入 `dsh` 即可打开 DeepSeek Harness Web UI 并通过公司内网 Open WebUI 调用 DeepSeek 模型。真实的 DeepSeek API Key 只保存在 Open WebUI 后台，用户只能接触到一个内网受限的 Open WebUI Key。

> 当前服务器版本：**dsh 0.2.2-rc.1**（2026-11-11 从 0.2.0-rc.2 升级，`verify.sh --tool --web` 全部通过）。
>
> 状态：已在 `opsnas.tri.local`（172.16.50.107，安装/可写节点）和 `trivm131/132/133.tri.local`（172.16.50.131-133，桌面节点）验证通过（2026-11-06），验证记录见 [`data/verification-2026-11-06.txt`](data/verification-2026-11-06.txt)。

## 用户怎么用

```bash
dsh                          # 启动 Web UI，桌面会自动打开浏览器
dsh --profile headless "..." # 一次性任务，直接输出结果
dsh --version
```

无需设置任何环境变量，也无需输入 API Key（共享配置已预置）。

## 架构

```
桌面 VM 里的 dsh
  /usr/local/bin/dsh -> /eda/apps/deepseek/bin/dsh-desktop   (启动器)
        │ 读取 /eda/apps/deepseek/etc/dsh.env（BASE_URL + 共享 key）
        │ 启动本地兼容代理（127.0.0.1:随机端口）
        ▼
  dsh (Node) ── Anthropic Messages 流式请求 ──► dsh-owui-shim.mjs
        ▲                                            │ 非流式 /api/v1/messages
        │ Anthropic SSE（shim 合成）                  ▼
        └──────────────────────────────────  Open WebUI (chat.tri.local:443)
                                                     │ 管理员配置的真实 DeepSeek Key
                                                     ▼
                                              DeepSeek API
```

详见 [`docs/architecture.md`](docs/architecture.md)。

## 组件与路径

| 路径 | 作用 | 权限 |
|---|---|---|
| `/eda/apps/deepseek` | 共享安装目录（NFS），Node 24 + dsh + pnpm | 755 root |
| `/eda/apps/deepseek/bin/dsh-desktop` | 桌面启动器（默认 `web --port 0`、自动开浏览器、管理 shim） | 755 root |
| `/eda/apps/deepseek/bin/dsh-owui-shim.mjs` | Open WebUI 流式兼容代理 | 755 root |
| `/eda/apps/deepseek/etc/dsh.env` | 共享配置：模型网关 + 共享 OWUI Key | 644 root |
| `/eda/apps/deepseek/certs/tri-enterprise-root.pem` | 公司内部根证书（供 Node 访问 `*.tri.local`） | 644 root |
| `/usr/local/bin/dsh` | 软链到启动器（每台 VM 各自建立） | root |
| `~/.dsh` | 每用户运行数据（会话、配置、凭据） | 用户 |
| `~/.config/dsh/env` | 可选的每用户覆盖配置 | 用户 600 |

## 运维入口

在**可写节点**（opsnas 107）上执行：

```bash
# 首次安装 Node + dsh（需要临时放行 nodejs.org / registry.npmjs.org）
sudo ./scripts/install-online.sh

# 部署/更新启动器、shim、共享配置、CA，并建立本机软链
sudo DSH_API_KEY='sk-...' ./scripts/deploy-desktop.sh
```

在**每台桌面 VM** 上执行一次：

```bash
sudo ./scripts/add-host-link.sh
```

验证（普通用户，无需 sudo）：

```bash
./scripts/verify.sh --tool --web
```

## 文档

- [`docs/architecture.md`](docs/architecture.md)：组件、数据流、为什么需要 shim、隔离与权限模型
- [`docs/deployment.md`](docs/deployment.md)：安装、升级、回滚、新增 VM 的完整步骤
- [`docs/verification.md`](docs/verification.md)：验证项与结果
- [`docs/inventory.md`](docs/inventory.md)：主机/版本/路径/哈希/证书清单
- [`docs/troubleshooting.md`](docs/troubleshooting.md)：常见故障排查
- [`docs/security.md`](docs/security.md)：共享 Key 的安全模型、轮换与后续演进
- [`docs/faq.md`](docs/faq.md)：会话历史持久化、root 权限、Key 可见性等常见问题
- [`docs/用户手册.md`](docs/用户手册.md)：给普通用户的使用说明（启动、历史、注意事项）

## 注意

- 真实 DeepSeek Key **不在**本仓库、也不在用户机器上；仓库里只有 `config/dsh.env.example` 模板。
- `config/dsh.env` 属于部署密钥，已在 `.gitignore` 中忽略；线上实际文件在 `/eda/apps/deepseek/etc/dsh.env`。
- Open WebUI 当前版本（0.12.4）的 Anthropic 流式接口存在返回空内容的问题，因此需要本地 shim；OWUI 升级修复后可评估移除。
