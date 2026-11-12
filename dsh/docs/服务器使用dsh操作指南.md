# DeepSeek Harness（dsh）服务器使用操作指南

> 适用环境：已由管理员部署 dsh 的 Rocky Linux 8 桌面 VM（如 trivm131 / trivm132 / trivm133）。
> 当前服务器版本：**dsh 0.2.2-rc.1**（Node.js 24.18.1，安装目录 `/eda/apps/deepseek`）。
> 文档更新：2026-11-12。

---

## 1. 概述

dsh 是运行在服务器桌面环境中的 AI Agent（智能体）工具。用户输入 `dsh` 即可打开 Web 界面，让模型在**自己的账号和权限范围内**读写文件、执行命令、处理文档等。

- 模型请求通过公司内网 Open WebUI（`https://chat.tri.local/api`）转发，**用户不需要配置任何 API Key**。
- 真实的 DeepSeek Key 只保存在 Open WebUI 后台，不在用户机器上。
- 每个用户运行自己的 dsh 进程，使用自己的 `~/.dsh` 数据目录，互不影响。

---

## 2. 适用对象与前置条件

| 对象 | 说明 |
|---|---|
| 用户 | 有 Rocky 8 桌面 VM 账号，能打开终端即可 |
| 网络 | 能访问内网 `chat.tri.local`（通常默认放行） |
| 终端 | 图形桌面里的终端（Terminal）或 SSH 登录（见附录 A） |
| 权限 | 普通用户即可，**不需要 root** |

---

## 3. 快速开始（3 步）

1. 打开终端，进入你要让 dsh 工作的目录（可省略，默认当前目录）：

   ```bash
   cd ~/my-project
   ```

2. 输入：

   ```bash
   dsh
   ```

3. 浏览器会自动打开 DeepSeek Harness 界面，直接开始对话即可。

- 如果浏览器没有自动弹出：把终端里打印的 `http://127.0.0.1:<端口>/?token=...` 复制到浏览器打开。
- 首次启动需要初始化，稍等几秒。
- 关闭终端会结束本次 dsh 进程，但**历史对话不会丢**（见 4.6）。

---

## 4. 界面使用

### 4.1 会话（Session）

- 左侧栏可新建、切换、重命名、归档会话；同一个窗口可以并行处理多件事。
- 每个会话独立保存上下文；长对话可新建会话重新开始。
- 会话默认绑定当前**工作区**（工作目录）。

### 4.2 工作区（Workspace）

- dsh 默认把启动时所在目录作为工作区根目录。
- 需要操作哪个项目，就先 `cd` 到哪个项目目录再 `dsh`；不同目录会形成不同工作区。
- 也可以在界面里切换/添加工作区。

### 4.3 模型

- 默认模型为 `deepseek-flash`，可在会话的模型选择器里切换（如 `deepseek-v4-pro`）。
- 模型列表与鉴权由管理员统一配置，用户无需填写 Key 或地址。

### 4.4 工具调用与权限

- dsh 可以调用 bash、文件读写、搜索、文档处理等工具；执行前可能弹出**审批提示**，确认后才会执行。
- 默认沙箱为 `workspace-write`：只能修改工作区目录和临时目录，不能写系统其他位置。
- 更高权限（`danger-full-access`）只在明确需要且由用户在会话中选择时使用；请谨慎开启。
- 工具以**你自己的账号权限**运行：你能访问的文件它能访问，你访问不了的它也访问不了；不会自动获得 root。

### 4.5 终端 / 文件 / 插件

- 右侧栏可打开终端、文件浏览、文档预览等面板。
- 插件在「设置 → 插件」中管理；安装插件需要访问网络或内网 npm 镜像，内网受限时联系管理员。

### 4.6 会话历史与持久化

- 历史保存在当前 VM 的 `~/.dsh/sessions/` 下，**关闭浏览器/终端不会丢失**；下次 `dsh` 可继续。
- 中断瞬间正在生成的那一轮可能不完整；已完成的对话都会保留。
- 换一台 VM 看不到另一台的历史（`~/.dsh` 在每个 VM 本地）。
- 在界面删除会话或清空 `~/.dsh` 才会真正丢失。

---

## 5. 命令行用法

| 命令 | 作用 |
|---|---|
| `dsh` | 启动 Web 界面（桌面自动开浏览器；无图形会话时只打印 URL） |
| `dsh --version` | 查看版本 |
| `dsh web --port 18080` | 指定端口启动 Web 界面 |
| `dsh --profile headless "任务"` | 一次性任务，结果直接输出到终端 |
| `dsh plugin --profile web add <包>` | 安装插件 |
| `dsh --help` | 查看 CLI 帮助 |

示例：

```bash
# 一次性分析任务，不开界面
dsh --profile headless "统计当前目录代码行数并总结"

# 指定端口（固定端口便于做 SSH 隧道）
dsh web --port 18080
```

---

## 6. 数据与配置位置

| 路径 | 内容 | 说明 |
|---|---|---|
| `/usr/local/bin/dsh` | 启动器软链 | 指向共享安装目录 |
| `/eda/apps/deepseek/` | dsh 程序（共享 NFS） | 用户只读，不可修改 |
| `~/.dsh/` | 会话、工作区数据、本机凭据 | 用户私有，权限 700/600 |
| `~/.dsh/sessions/` | 历史会话 | 按工作区分目录，仅追加 |
| `~/.config/dsh/env` | 可选的用户级配置覆盖 | 例如换成自己的 OWUI Key |
| `/eda/apps/deepseek/etc/dsh.env` | 共享配置（模型地址 + 共享 Key） | 管理员维护，644，用户可读 |

---

## 7. 安全注意事项

1. **不要用 `sudo dsh`**：dsh 以你的身份运行即可，不需要 root；用 root 运行会让 agent 拥有 root 权限。
2. 终端打印的带 `token` 的 URL 等同于你的登录凭证，**不要发给别人**。
3. 不要把 dsh 的 Web 端口用 `--host 0.0.0.0` 暴露到网络；默认只监听本机。
4. 共享的 Open WebUI Key 对所有登录用户可见（这是当前统一 Key 方案的取舍），但只能在内网访问 OWUI；真实的 DeepSeek Key 不在用户侧。
5. 不要把自己账号的密码、SSH 私钥等敏感信息明文放在工作区，agent 以你的权限运行时可以读到。

---

## 8. 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| `dsh: command not found` | 本机入口未建立，联系管理员执行 `sudo ln -sfn /eda/apps/deepseek/bin/dsh-desktop /usr/local/bin/dsh` |
| `/usr/local/bin/dsh: 权限不够` | 启动器/软链权限问题，联系管理员跑 `scripts/add-host-link.sh` |
| 浏览器没有自动打开 | 复制终端里的带 token URL 手动打开；或确认在图形桌面终端运行 |
| 对话报模型/网络错误 | 先看终端输出；管理员检查 `chat.tri.local` 与 `/eda/apps/deepseek/etc/dsh.env` |
| `EMPTY_RESPONSE` / 模型无响应 | 通常与 Open WebUI 或兼容 shim 有关，联系管理员排查 |
| `fetch failed` / 证书错误 | 内部 CA 或 `NODE_EXTRA_CA_CERTS` 问题，联系管理员 |
| 历史对话“不见了” | 确认是否换了 VM、换了工作目录、或在界面中删除了会话 |
| 端口被占用 | 默认端口由系统分配一般不会冲突；固定端口时换一个 |

---

## 9. 管理员运维要点

> 完整步骤见 `docs/deployment.md`，排错见 `docs/troubleshooting.md`。

### 9.1 安装 / 升级

在可写节点（opsnas 172.16.50.107）执行：

```bash
# 首次安装（需临时放行 nodejs.org / registry.npmjs.org，或使用内网 npm 镜像）
sudo DSH_VERSION=0.2.2-rc.1 ./scripts/install-online.sh

# 部署/更新启动器、兼容 shim、共享配置、CA，并建立本机软链
sudo DSH_API_KEY='sk-...' ./scripts/deploy-desktop.sh
```

### 9.2 新增桌面 VM

```bash
sudo ./scripts/add-host-link.sh   # 只是建 /usr/local/bin/dsh 软链，可重复执行
```

### 9.3 升级后验证

在任一桌面 VM 上用普通用户执行：

```bash
./scripts/verify.sh --tool --web
```

预期：版本、对话、工具调用、Web token 认证全部 OK。

### 9.4 回滚

```bash
sudo rm -rf /eda/apps/deepseek/lib/node_modules/@deepseek-ai/dsh
sudo tar -C /eda/apps/deepseek/lib/node_modules/@deepseek-ai \
  -xzf /eda/apps/deepseek-backup-0.2.0-rc.2-20261111.tar.gz
dsh --version
```

### 9.5 共享 Key 轮换

```bash
sudo DSH_API_KEY='sk-新key' ./scripts/deploy-desktop.sh
# 已运行的 dsh 需重启后生效
```

### 9.6 相关仓库与文档

- 项目仓库：<https://git.tri.local/it/dsh>
- 工作区归档：`workspace/dsh/`
- 架构说明：`docs/architecture.md`
- 部署手册：`docs/deployment.md`
- 用户手册：`docs/用户手册.md`
- 排错手册：`docs/troubleshooting.md`
- 安全说明：`docs/security.md`

---

## 附录 A：SSH 场景

没有图形桌面（或通过 SSH 使用）时，Web 界面不会自动打开浏览器，需要端口转发：

```bash
# 服务器上
dsh web --port 18080
# 终端会打印 http://127.0.0.1:18080/?token=...

# 本地电脑上
ssh -L 18080:127.0.0.1:18080 <user>@<服务器>
# 浏览器打开终端里打印的完整 URL（含 token）
```

## 附录 B：重置个人 dsh 状态

```bash
# 备份后重置（会丢失本地会话历史）
mv ~/.dsh ~/.dsh.bak.$(date +%Y%m%d)
dsh
```

## 附录 C：获取帮助

- 使用问题：先查本指南第 8 节
- 管理员：`docs/troubleshooting.md`，或联系平台维护人
- 版本/更新记录：`docs/verification.md`、`data/`
