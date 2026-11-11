# 部署与运维手册

## 1. 前置条件

| 项 | 要求 |
|---|---|
| 可写节点 | `opsnas.tri.local`（172.16.50.107），Rocky 8 x86_64，`/eda/apps` 为 `rw` |
| 桌面节点 | Rocky 8 x86_64 桌面 VM，`/eda/apps` 为 `ro` 也可运行 |
| 共享存储 | NFS `172.16.20.13:/fs/eda_nas/eda_apps`，挂载点 `/eda/apps` |
| Node/dsh 下载 | 首次安装需临时放行 `nodejs.org`、`registry.npmjs.org`（或用内部 npm 镜像） |
| 模型网关 | Open WebUI `https://chat.tri.local`，管理员已在其中配置真实 DeepSeek Key |
| 共享 Key | 一个 Open WebUI API Key（`sk-...`），供 dsh 调用 OWUI 使用 |
| 证书 | 公司 `Enterprise Root CA`（本仓库 `config/pki/tri-enterprise-root.pem`） |

## 2. 首次安装（在 opsnas 107 上，root）

### 2.1 安装 Node + dsh

```bash
git clone https://git.tri.local/it/dsh.git
cd dsh

# 如无内部 npm 镜像，先临时放行防火墙域名（nodejs.org / registry.npmjs.org）
sudo ./scripts/install-online.sh
```

脚本行为：

- `dnf install tar gzip curl ca-certificates`（内部源）；
- 下载 Node.js `v24.18.1` 官方 linux-x64 tar.gz 到 `/eda/apps/deepseek`；
- `npm install -g --prefix /eda/apps/deepseek @deepseek-ai/dsh@0.2.2-rc.1 pnpm@11`；
- 设置 `a+rX` 权限并用包内 Node 验证版本。

可覆盖的变量：`DSH_VERSION`、`NODE_VERSION`、`PNPM_VERSION`、`NPM_REGISTRY`、`DSH_PREFIX`。

> 服务器无外网时，可改用 `archive/offline-install/` 中的离线打包方案。

### 2.2 部署启动器 / shim / 共享配置 / CA

```bash
sudo DSH_API_KEY='sk-...' ./scripts/deploy-desktop.sh
```

脚本行为：

- 安装 `bin/dsh-desktop`、`bin/dsh-owui-shim.mjs`（755）；
- 安装 `certs/tri-enterprise-root.pem`（644）；
- 写 `etc/dsh.env`（644）：`DEEPSEEK_BASE_URL=https://chat.tri.local/api` + 共享 Key；
- 建立 `/usr/local/bin/dsh -> /eda/apps/deepseek/bin/dsh-desktop`；
- `chmod -R a+rX`、`restorecon`、验证 `dsh --version`。

> 已部署过、只更新脚本时，可不带 `DSH_API_KEY`，脚本会沿用 `etc/dsh.env` 中的 key。

### 2.3 每台桌面 VM 建立软链

```bash
sudo ./scripts/add-host-link.sh
```

该脚本可重复执行；`/eda/apps` 为只读挂载也能运行。

### 2.4 验证

```bash
./scripts/verify.sh --tool --web
```

预期：

- `dsh --version` 输出 `0.2.2-rc.1`；
- 对话返回 `verify-ok`；
- `--tool` 时工具调用返回当前用户名；
- `--web` 时 Web UI 打印 token URL，无 token 401、带 token 303。

详细验收记录见 `docs/verification.md`。

## 3. 新增桌面 VM

1. 确认 `/eda/apps` 可访问（autofs 通常按需挂载）：
   ```bash
   ls /eda/apps/deepseek/bin/dsh-desktop
   ```
2. 建立软链：
   ```bash
   chmod +x add-host-link.sh
   sudo ./add-host-link.sh
   ```
3. 用户直接运行 `dsh` 验证。

> 也可把 `add-host-link.sh` 放进桌面镜像/配置管理里，新 VM 自动执行。

## 4. 升级

### 4.1 更新启动器 / shim / 配置（不升级 dsh 本体）

在 opsnas 上：

```bash
cd /path/to/dsh    # 仓库
git pull
sudo ./scripts/deploy-desktop.sh
```

共享 NFS 上的文件立刻更新，桌面 VM 无需操作（下次运行 `dsh` 生效）。

### 4.2 升级 dsh 本体

```bash
# 先备份当前安装（可选）
sudo tar -C /eda/apps -czf /eda/apps/deepseek-backup-$(date +%F).tgz deepseek

# 重新安装指定版本（会重新解压 Node 并安装新 dsh）
sudo DSH_VERSION=0.2.2-rc.1 ./scripts/install-online.sh
sudo ./scripts/deploy-desktop.sh     # 确保启动器/配置同步
```

> 升级后建议先在一台 VM 上跑 `./scripts/verify.sh --tool --web`，再全量使用。

> **npm 11.16 的 allow-scripts**：升级时会提示部分包（koffi、node-pty、dsh-subprocess-local 等）的 install 脚本未执行。2026-11-11 升级到 0.2.2-rc.1 时已实测这些原生模块的预编译产物可直接加载（koffi、node-pty 加载正常，pty spawn 正常），因此不影响使用。若后续版本出现原生模块加载问题，可执行 `sudo npm approve-scripts <pkg>` 后 `sudo npm rebuild --prefix /eda/apps/deepseek <pkg>`。

### 4.3 替换共享 Key

```bash
sudo DSH_API_KEY='sk-新key' ./scripts/deploy-desktop.sh
# 或者直接编辑 /eda/apps/deepseek/etc/dsh.env 后无需重启（每次 dsh 启动时读取）
```

## 5. 回滚

1. 保留上一版 `deepseek` 目录备份（见上）；
2. 恢复：
   ```bash
   sudo mv /eda/apps/deepseek /eda/apps/deepseek.bad.$(date +%s)
   sudo tar -C /eda/apps -xzf /eda/apps/deepseek-backup-YYYY-MM-DD.tgz
   sudo ./scripts/add-host-link.sh
   ```
3. 用户重新运行 `dsh` 即可。

## 6. 常见运维注意

- `/eda/apps` 在部分节点是 **只读** 挂载：所有写操作（安装、升级、改配置）都在 opsnas 107 上做。
- `dsh plugin` 会把插件装到用户自己的 `~/.dsh/profiles/web`，不需要写共享目录；但插件下载需网络，离线环境需用本地 tgz 或内网 npm 镜像。
- 升级 Open WebUI 后，若其 Anthropic 流式接口修复，可评估移除 shim（见 `docs/troubleshooting.md`）。
- 不要提交 `/eda/apps/deepseek/etc/dsh.env` 到 git。
