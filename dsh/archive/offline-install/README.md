# Rocky Linux 8 离线安装 DeepSeek Harness（dsh）

> 适用：内网/无外网的 Rocky 8 x86_64 服务器，管理员或普通用户安装 dsh CLI + Web GUI。
> 版本：默认 `0.2.0-rc.2`（与本机桌面版一致；npm 上目前还有更新的 RC，可改 `DSH_VERSION`）。
> 目标机：Rocky 8 / x86_64（glibc 2.28）。

## 最短路径（TL;DR）

```bash
# 1. 联网机器（有 Docker/Podman）构建；或到联网 Rocky 8 上跑 --native
./build-offline-bundle.sh

# 2. 拷到服务器
scp out/dsh-0.2.0-rc.2-rocky8-x86_64.tar.gz* user@rock8:/tmp/

# 3. 服务器上安装（管理员用 sudo；普通用户加 --user）
sudo ./install-offline.sh /tmp/dsh-0.2.0-rc.2-rocky8-x86_64.tar.gz

# 4. 每个用户在自己账号下启动
export DEEPSEEK_API_KEY=sk-...
dsh --profile web --no-open --port 18080

# 5. 本地开隧道，浏览器打开终端打印的带 token 的 URL
ssh -L 18080:127.0.0.1:18080 user@rock8
```

## 为什么不能只拷一个 `dsh` 文件

dsh 不是单个可执行文件，它是一棵 npm 依赖树，并且包含**平台相关的原生模块**：

- 需要 Node.js 运行时（官方打包用的是 Node 24.18.1）；
- 原生模块：`node-pty`、`koffi`、`sharp`、`@deepseek-ai/node-addon-system`、`node-addon-require-builtin` 等；
- 数百个 `@deepseek-ai/dsh-*` 包和前端静态资源。

所以正确做法是：**在一台联网的、与目标同平台（Linux x86_64 / glibc 2.28）的机器上，把 Node + 全部依赖装进一个目录，整体打包，再搬到服务器解压。** 服务器上不需要 Node、npm、编译工具，也不访问任何软件源。

Rocky 8 的 glibc 是 2.28，正好满足 Node 24 官方 linux-x64 二进制的要求（glibc ≥ 2.28），所以可以直接跑。

## 方案总览

| 角色 | 要求 |
|---|---|
| 构建机（有网） | macOS + Docker Desktop，或任意 x86_64 Linux + Docker/Podman，或联网的 Rocky 8（`--native`） |
| 服务器（无网） | Rocky 8 x86_64，能解压 tar.gz，普通用户可写自己的 home，1 GB 左右空闲磁盘 |
| 产物 | `dsh-<版本>-rocky8-x86_64.tar.gz`（Node + dsh + pnpm，约几百 MB） |

构建脚本：`build-offline-bundle.sh`　安装脚本：`install-offline.sh`

---

## 1. 构建离线包（在一台能上外网的机器上）

### 1.1 有 Docker/Podman（推荐）

```bash
cd dsh-offline
./build-offline-bundle.sh
```

脚本会用 `rockylinux:8` 镜像（显式 `--platform linux/amd64`，保证 glibc 和原生模块与服务器一致）做这些事：

1. `dnf` 装编译工具（`gcc`、`g++`、`make`、`python3`，以及 `gcc-toolset-13` 兜底）；
2. 下载 Node.js `v24.18.1` linux-x64 到 `/opt/dsh`；
3. `npm install -g --prefix /opt/dsh @deepseek-ai/dsh@0.2.0-rc.2 pnpm@11`；
4. 用包内 Node 跑 `dsh --version` 冒烟检查；
5. `chmod -R a+rX` 后打成 `out/dsh-0.2.0-rc.2-rocky8-x86_64.tar.gz` 并生成 sha256。

成功标志：最后输出 `dsh --version` 的版本号，并且能看到：

```
out/dsh-0.2.0-rc.2-rocky8-x86_64.tar.gz
out/dsh-0.2.0-rc.2-rocky8-x86_64.tar.gz.sha256
```

可以用环境变量换版本：

```bash
DSH_VERSION=0.2.1-rc.5 ./build-offline-bundle.sh
```

> 构建机走公司代理才能出网时，给 `docker run` 再加 `-e HTTPS_PROXY -e HTTP_PROXY -e NO_PROXY`；`dnf` 也需要代理时，在容器里写 `/etc/dnf/dnf.conf` 的 `proxy=`。
>
> Apple 芯片的 Mac 上会走 x86_64 模拟，`node-pty` 等编译会比较慢（十几分钟量级），但产物仍是 x86_64，可正常拷到服务器。想快就找一台 x86_64 的联网 Linux 来构建。

### 1.2 没有 Docker：直接用一台联网的 Rocky 8

```bash
scp -r dsh-offline user@有网的rocky8:~/
ssh user@有网的rocky8
cd ~/dsh-offline && sudo ./build-offline-bundle.sh --native
```

原生模式会在这台机器上装 `gcc-toolset`、Node 和依赖，产物同样在 `out/`。**必须用 x86_64 的 Linux**，不要用 macOS 原生或 ARM 机器原生构建。

### 1.3 服务器能临时出网（可选）

如果只是“平时不通外网、申请后可以临时通”，最省事的是在服务器上直接：

```bash
# 只对 dsh 临时放开 registry.npmjs.org / nodejs.org，然后
sudo dnf -y install tar xz
curl -fsSL -o /tmp/node.tar.xz https://nodejs.org/dist/v24.18.1/node-v24.18.1-linux-x64.tar.xz
sudo mkdir -p /opt/dsh && sudo tar -xJf /tmp/node.tar.xz -C /opt/dsh --strip-components=1
sudo env PATH=/opt/dsh/bin:$PATH /opt/dsh/bin/npm install -g --prefix /opt/dsh \
  @deepseek-ai/dsh@0.2.0-rc.2 pnpm@11
```

后面的安装/使用步骤与离线包一致。

---

## 2. 拷贝到服务器

```bash
scp out/dsh-0.2.0-rc.2-rocky8-x86_64.tar.gz* user@rock8:/tmp/
ssh user@rock8
cd /tmp && sha256sum -c dsh-0.2.0-rc.2-rocky8-x86_64.tar.gz.sha256
tar -tzf /tmp/dsh-0.2.0-rc.2-rocky8-x86_64.tar.gz | head   # 应看到 dsh/bin/node 等
```

---

## 3. 安装

### 3.1 系统级（管理员，推荐）

装到 `/opt/dsh`，全机共享**程序**，每个用户仍然在自己的账号下运行自己的实例。

```bash
sudo ./install-offline.sh /tmp/dsh-0.2.0-rc.2-rocky8-x86_64.tar.gz
```

脚本会：

- 解压到 `/opt/dsh`（含 Node、dsh、pnpm）；
- 写 `/usr/local/bin/dsh` 包装脚本，固定用包内 Node/pnpm，避免服务器上旧 Node 抢先生效；
- 跑一次 `restorecon`（Rocky 8 默认 SELinux enforcing）；
- 验证 `dsh --version`。

> 不往 `/etc/profile.d` 里加 PATH，避免把全机默认的 `node` 换成包内 Node；只有 `dsh` 进程自己会用包内运行时。

### 3.2 用户级（普通用户，不需要 root）

```bash
./install-offline.sh --user /tmp/dsh-0.2.0-rc.2-rocky8-x86_64.tar.gz
```

装到 `~/opt/dsh`，入口是 `~/.local/bin/dsh`。同一份 tar.gz，装到谁都读不到的地方也行——重启/升级只影响自己。

注意两点：

- 每个人一份会多占几百 MB；全组用还是系统级（`/opt/dsh`）更省空间。
- 如果 home 是 **noexec** 挂载（HPC 上很常见），用户级安装无法执行，请改用系统级安装或把包解压到有执行权限的目录。

### 3.3 手动安装（不想用脚本）

```bash
sudo tar -xzf dsh-0.2.0-rc.2-rocky8-x86_64.tar.gz -C /opt
sudo tee /usr/local/bin/dsh >/dev/null <<'EOF'
#!/bin/sh
PATH="/opt/dsh/bin:$PATH"; export PATH
exec /opt/dsh/bin/node /opt/dsh/lib/node_modules/@deepseek-ai/dsh/lib/bin.js "$@"
EOF
sudo chmod 755 /usr/local/bin/dsh
sudo restorecon -R /opt/dsh 2>/dev/null || true
dsh --version
```

---

## 4. 首次运行

每个用户在自己账号下：

```bash
export DEEPSEEK_API_KEY=sk-...        # 或你们内网模型网关的 key
dsh --profile web --no-open --port 18080
```

终端会打印类似 `dsh web: http://127.0.0.1:18080/?token=...`。服务器没有浏览器、也**不要**把 GUI 开到 0.0.0.0（dsh 会直接拒绝），用 SSH 端口转发：

```bash
# 在自己的 Mac 上
ssh -L 18080:127.0.0.1:18080 user@rock8
```

然后把终端里打印的**带 token 的完整 URL** 贴到本地浏览器。首次启动会自动初始化 `~/.dsh`（profile、会话目录、凭据），不需要联网。

验证服务已起来（另开一个终端）：

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18080/
# 期望 401：服务器在跑，只是没带 token
```

一次性/批处理任务不需要 GUI：

```bash
dsh --profile headless "把 tests 跑一遍并总结失败原因"
```

---

## 5. 离线环境还要准备什么（重要）

### 5.1 模型端点：离线安装 ≠ 离线使用

dsh 本身不包含模型。服务器如果完全不通外网，`api.deepseek.com` 也访问不了，界面能打开但对话会失败。两条路：

- **内网模型网关**：dsh 的 DeepSeek 适配器默认请求 `https://api.deepseek.com/anthropic`，协议是 **Messages（Anthropic Messages）兼容**。网关兼容的话，设 `DEEPSEEK_BASE_URL=https://你的网关/anthropic` 再启动即可，或者在 **Settings → 模型** 里改 API 地址与凭据；也可以装 `dsh-llm-pi-ai` 适配器接其他提供方。
- **出口代理**：给服务器（或 dsh 进程）放行到 DeepSeek API 的 HTTPS 出口，通常通过 `HTTPS_PROXY` 一类环境变量。

离线部署前先把这条确认了，不然装完只能看界面。

### 5.2 命令沙箱：Rocky 8 需要 bubblewrap

Rocky 8 内核是 4.18，没有 Landlock；dsh 的受限沙箱在 Linux 上要用 **bubblewrap（bwrap）**。Rocky 8 的 BaseOS 里有 `bubblewrap-0.4.0-1.el8.x86_64.rpm`，离线装法：

```bash
# 在一台联网的 Rocky 8 上（同版本仓库）预取 RPM：
sudo dnf -y install dnf-plugins-core
mkdir rpms && dnf download --resolve --destdir rpms bubblewrap
# 把 rpms/ 拷到服务器后：
sudo dnf -y install ./rpms/*.rpm      # 或 rpm -Uvh ./rpms/*.rpm
bwrap --ro-bind / / true && echo bwrap-ok
```

不装 bwrap 的后果：受限模式会因为“没有可用沙箱后端”拒绝执行命令，只能用 `danger-full-access`——共享服务器上不建议。

### 5.3 插件（离线）

`dsh plugin` 现在不需要额外装（`pnpm` 已打进离线包），但插件包本身要离线搬运：

```bash
# 有网机器
npm pack <插件包名>@<版本>            # 得到 xxx.tgz
# 服务器
dsh plugin --profile web add /path/xxx.tgz
```

插件如果还有自己的依赖，pnpm 仍会想联网；团队长期用建议在内网架一个 npm 镜像（Nexus/Verdaccio），或者只固定用少量随包分发的插件。

### 5.4 可选：LibreOffice

Office 技能（docx/pptx/xlsx 预览、转 PDF）需要系统里有 LibreOffice；不装不影响核心功能，相关能力会报不可用。离线装 `libreoffice` 同样用 `dnf download --resolve` 预取 RPM。

---

## 6. 升级与回滚

1. 有网机器上用新 `DSH_VERSION` 重新构建；
2. 服务器上让用户停掉自己的 `dsh` 进程；
3. `sudo ./install-offline.sh --force 新包.tar.gz` 覆盖 `/opt/dsh`（会先删旧目录再解压）；
4. 旧 tar.gz 保留，出问题用同样命令装回去即可。

注意 RC 版本之间有破坏性变更，团队内最好统一版本并记录在案。

---

## 7. 排错速查

| 现象 | 原因 / 处理 |
|---|---|
| `GLIBC_2.xx not found`、`version 'GLIBC_2.34' not found` | 构建机 glibc 比 Rocky 8 新（如在 Ubuntu 24.04 上构建）。必须在 `rockylinux:8` 容器或 Rocky 8 上构建 |
| `dsh: node: command not found` 或用了旧 Node | 用 `/usr/local/bin/dsh` 包装脚本，或确保 PATH 里 `/opt/dsh/bin` 在前 |
| `dsh: pnpm was not found` | 用 `/usr/local/bin/dsh` 入口（它会自动设置 PATH）；若绕过包装脚本直接跑 `node .../bin.js`，请自行 `export PATH=/opt/dsh/bin:$PATH` |
| 启动报 `no sandbox backend is usable on this host` | 装 bubblewrap（见 5.2）；或临时把权限档位调成 `danger-full-access` |
| `EADDRINUSE` | 每用户换端口：`--port 18081` 等；或 `--port 0` 让系统分配 |
| 浏览器打开是 401/空白 | 必须用**带 token 的**启动 URL；token 只在该进程生命周期内有效，重启后重新复制 |
| `Permission denied` 执行 `/opt/dsh/...` | `chmod -R a+rX /opt/dsh`；SELinux 用 `ausearch -m avc -ts recent` 查，再 `restorecon -R /opt/dsh` |
| home 下 `~/opt/dsh/bin/node: Permission denied` | home 分区挂载了 `noexec`；改用系统级安装（`/opt`）或换到有执行权限的目录 |
| 首次启动很慢或 profile 初始化失败 | 检查 `~/.dsh` 是否可写、home 磁盘是否满、`$HOME` 是否指向 NFS 且无写权限 |
| Web 页面能开但对话报错 | 模型端点不可达/未配置（见 5.1） |

---

## 8. 多用户注意

- 共享的只是 `/opt/dsh` 这份**只读程序**；
- 每个用户在自己的账号下起自己的 `dsh`，用各自的 `~/.dsh`、各自的模型 key、各自的工作目录；
- **不要**在一个共享账号下起一个 `dsh web` 让全组浏览器连：dsh 的 Web 是单操作者模型（一个进程一个 token 对应一个 operator），没有账号隔离；`--host 0.0.0.0` 会被官方明确拒绝（避免把远程代码执行暴露到网络上）。

---

## 文件清单

- `build-offline-bundle.sh` —— 在联网机器（Docker/Podman，或 Rocky 8 `--native`）上构建离线包；
- `install-offline.sh` —— 在服务器上做系统级/用户级安装；
- `README.md` —— 本文件。
