# 架构说明

## 目标

- 用户在 Rocky Linux 8 桌面 VM 上直接输入 `dsh`，即可使用 DeepSeek Harness Web UI。
- 用户不需要配置模型地址、CA、API Key。
- 真实 DeepSeek API Key 不下发到用户机器；用户只持有一个**内网 Open WebUI** 的共享 API Key。

## 组件

| 组件 | 位置 | 说明 |
|---|---|---|
| Node.js 24.18.1 | `/eda/apps/deepseek/bin/node` | 与 dsh 官方打包运行时一致；官方 linux-x64 构建要求 glibc ≥ 2.28，Rocky 8 满足 |
| dsh CLI | `/eda/apps/deepseek/lib/node_modules/@deepseek-ai/dsh` | `@deepseek-ai/dsh@0.2.2-rc.1`，含 200 个依赖与已构建前端 |
| pnpm | `/eda/apps/deepseek/bin/pnpm` | 供 `dsh plugin` 管理插件 |
| 启动器 | `/eda/apps/deepseek/bin/dsh-desktop` | 读取共享配置、启动 shim、默认 `web --port 0`、无图形会话自动 `--no-open`、透传子命令 |
| 兼容代理 | `/eda/apps/deepseek/bin/dsh-owui-shim.mjs` | 把 dsh 的 Anthropic 流式请求转成 Open WebUI 非流式调用，再合成 SSE |
| 共享配置 | `/eda/apps/deepseek/etc/dsh.env` | `DEEPSEEK_BASE_URL` + 共享 OWUI Key，644 |
| 内部 CA | `/eda/apps/deepseek/certs/tri-enterprise-root.pem` | 供 Node 信任 `*.tri.local`（Node 不读系统信任库） |
| 每机软链 | `/usr/local/bin/dsh` | 指向共享启动器 |
| 用户数据 | `~/.dsh`、`~/.config/dsh/env` | 会话/凭据在用户 home；可选覆盖配置 |

## 数据流

1. 用户执行 `dsh`（`/usr/local/bin/dsh` 软链）。
2. 启动器加载 `/eda/apps/deepseek/etc/dsh.env`，必要时再加载 `~/.config/dsh/env` 覆盖。
3. 若 `DEEPSEEK_BASE_URL` 指向 `chat.tri.local`，启动器用临时端口文件启动 `dsh-owui-shim.mjs`（仅监听 `127.0.0.1`），把 `DEEPSEEK_BASE_URL` 改为本地 shim 地址。
4. 启动器以子进程运行 dsh（默认 `web --port 0`）；有 `DISPLAY`/`WAYLAND_DISPLAY` 时由 dsh 自动打开桌面浏览器，否则自动 `--no-open` 只打印带 token 的 URL。
5. dsh 通过 Anthropic Messages SDK 向 `http://127.0.0.1:<shim>/v1/messages` 发流式请求（`x-api-key` = 共享 OWUI Key）。
6. shim 去掉 `stream` 字段，改用非流式调用 `https://chat.tri.local/api/v1/messages`，带上同一 `x-api-key`。
7. Open WebUI 把 Anthropic Messages 请求转成上游 OpenAI 兼容请求，用管理员配置的真实 DeepSeek Key 调 DeepSeek，再把结果转回 Anthropic JSON。
8. shim 把 JSON 响应合成为标准 Anthropic SSE（`message_start` / `content_block_start` / `content_block_delta` / `content_block_stop` / `message_delta` / `message_stop`），dsh 解析后驱动 Web UI 或 headless 输出。
9. 用户退出后，启动器清理 shim 与 dsh 子进程。

## 为什么需要 shim

Open WebUI 0.12.4 的 Anthropic Messages 兼容端点：

- **非流式**请求正常（文本与 `tool_use` 都能返回）；
- **流式**请求只返回 `message_start`、`message_delta`、`message_stop`，没有任何 `content_block`，dsh 因此报 `EMPTY_RESPONSE: DeepSeek Messages returned no content`。

dsh 的 DeepSeek 适配器只走流式路径，所以加一个本地 shim 做协议转换。该 shim：

- 只监听 `127.0.0.1` 随机端口；
- 不持有密钥，原样转发请求里的 `x-api-key`；
- 支持文本块与 `tool_use` 块（已验证 bash 工具调用）；
- 额外一次本地 HTTP 跳转，延迟可忽略。

若 Open WebUI 后续修复流式转换，可评估移除 shim（把 `DEEPSEEK_BASE_URL` 指回 OWUI 即可）。

## 信任与证书

- `chat.tri.local` 使用公司 `Enterprise Root CA` 签发的证书；
- Rocky 8 系统信任库默认没有该根证书，`curl` 会报 `self signed certificate in certificate chain`；
- Node.js 又使用**内置 Mozilla CA**，不读系统信任库，因此必须设置 `NODE_EXTRA_CA_CERTS`；
- 启动器只对 dsh/shim 进程设置 `NODE_EXTRA_CA_CERTS=/eda/apps/deepseek/certs/tri-enterprise-root.pem`，不影响系统其他程序。
- 可选：如需 `curl` 等工具也信任，把该证书放入 `/etc/pki/ca-trust/source/anchors/` 后 `update-ca-trust`（未在本次部署中执行，避免扩大系统变更）。

## 隔离与权限模型

- 程序放在共享 NFS（`/eda/apps`），可写节点 107 为 `rw`，桌面节点 131 为 `ro`；运行只读安装目录，写入用户 home。
- 每个用户独立运行自己的 dsh 进程，使用自己的 `~/.dsh`（会话、工作区、凭据），互不可见。
- 不使用共享的 dsh Web 服务：dsh 的 Web 是单操作者模型（一个进程一个 token 对应一个操作者），共享实例无法做到用户隔离。
- 启动器/软链为 root 所有；普通用户只能读/执行共享程序。
- 共享 OWUI Key 对所有用户可见（`/etc/dsh.env` 644），这是当前“统一 key”方案的有意取舍，详见 `security.md`。

## 多主机布局

- 启动器、shim、共享配置、CA 全部在 NFS 上，**只需在 107 更新**；桌面 VM 通过只读挂载自动使用新版本。
- `/usr/local/bin/dsh` 是每台机器本地软链，新 VM 需执行一次 `scripts/add-host-link.sh`。
- dsh 本体升级（`npm install -g --prefix /eda/apps/deepseek ...`）也在 107 上做，其余节点无需操作。
