# 故障排查

## 1. `/usr/local/bin/dsh: 权限不够` / `Permission denied`

**原因**：`/usr/local/bin/dsh` 或其指向的启动器没有执行位（常见于用 `sudo tee` 创建文件，默认 0644）。

**处理**：
```bash
ls -l /usr/local/bin/dsh /eda/apps/deepseek/bin/dsh-desktop
sudo ./scripts/add-host-link.sh        # 重建软链
# 如共享启动器本身缺执行位，在 107 上：
sudo chmod 755 /eda/apps/deepseek/bin/dsh-desktop
```

## 2. `EMPTY_RESPONSE: DeepSeek Messages returned no content`

**原因**：dsh 直连了 Open WebUI 的 Anthropic 流式接口，而 OWUI 0.12.4 流式返回空内容（只有 `message_start/delta/stop`）。

**处理**：
- 确认 `DEEPSEEK_BASE_URL` 仍是 `https://chat.tri.local/api`（启动器会自动起 shim）；
- 确认 `shim` 文件存在且可执行：
  ```bash
  ls -l /eda/apps/deepseek/bin/dsh-owui-shim.mjs
  ```
- 手动排障（前台运行 shim，看请求/响应）：
  ```bash
  PORT_FILE=$(mktemp)
  DSH_SHIM_DEBUG=1 /eda/apps/deepseek/bin/node \
    /eda/apps/deepseek/bin/dsh-owui-shim.mjs "$PORT_FILE" &
  PORT=$(cat "$PORT_FILE")
  DEEPSEEK_BASE_URL="http://127.0.0.1:$PORT" dsh --profile headless "回复 ok"
  ```
- 如果 OWUI 升级后已修复流式，可把 `DEEPSEEK_BASE_URL` 指回 OWUI 并移除 shim。

## 3. `self signed certificate in certificate chain` / `fetch failed`

**原因**：`chat.tri.local` 使用公司内部 CA，而 Node 不读系统信任库。

**处理**：
- 确认启动器已设置 `NODE_EXTRA_CA_CERTS`：
  ```bash
  grep -n NODE_EXTRA_CA_CERTS /eda/apps/deepseek/bin/dsh-desktop
  ls -l /eda/apps/deepseek/certs/tri-enterprise-root.pem
  ```
- 用 Node 验证 TLS：
  ```bash
  NODE_EXTRA_CA_CERTS=/eda/apps/deepseek/certs/tri-enterprise-root.pem \
    /eda/apps/deepseek/bin/node -e 'fetch("https://chat.tri.local/api/models").then(r=>console.log(r.status)).catch(e=>console.log(e.message))'
  # 期望 401（TLS 通过，只是没带 key）
  ```
- 若证书更新，替换 `certs/tri-enterprise-root.pem` 后重跑 `deploy-desktop.sh`。

## 4. `401` / `MISSING_CREDENTIAL` / 模型调用认证失败

**原因**：共享 OWUI Key 失效、被删、或该用户被禁用。

**处理**：
```bash
# 用 key 直接测 OWUI
curl -s -o /dev/null -w '%{http_code}\n' https://chat.tri.local/api/models \
  -H "Authorization: Bearer <key>"    # 期望 200

# 更新共享 key
sudo DSH_API_KEY='sk-新key' ./scripts/deploy-desktop.sh
```

## 5. 模型不存在 / 404 / 404 model not found

**原因**：dsh 默认发 `deepseek-flash`，但 Open WebUI 里没有这个 id。

**处理**：确认 OWUI 的模型 id：
```bash
curl -s https://chat.tri.local/api/models -H "Authorization: Bearer <key>" | \
  python3 -c 'import sys,json;print([m["id"] for m in json.load(sys.stdin)["data"]])'
```
期望包含 `deepseek-flash`、`deepseek-v4-pro`。若不同，在 OWUI 里创建同名模型，或在 dsh 的 profile patch 里改默认模型。

## 6. Web UI 能打开但对话报错

按顺序检查：

1. `dsh --profile headless "回复 ok"` 是否能通（不经过浏览器，直接验证模型链路）；
2. 若 headless 正常、Web 不正常：看启动器是否被 `--no-open`/端口问题影响，重启 `dsh`；
3. 若 headless 也失败：按第 2、3、4 条排查 shim / CA / key。

## 7. 浏览器没有自动打开

- 确认是在桌面终端里运行（有 `DISPLAY` 或 `WAYLAND_DISPLAY`）；
- 手工打开终端里打印的带 token URL；
- 或显式启动：`dsh web --port 18080` 后手动打开 `http://127.0.0.1:18080/?token=...`。

## 8. `dsh plugin` 报 `pnpm was not found`

- 确认通过 `/usr/local/bin/dsh`（启动器）调用，启动器会把 `/eda/apps/deepseek/bin` 放入 PATH；
- 插件安装仍需访问 npm/内网镜像；离线环境请用本地 tgz：
  ```bash
  dsh plugin --profile web add /path/plugin.tgz
  ```

## 9. 只读文件系统 / 无法写入 `/eda/apps`

部分节点 `/eda/apps` 是 `ro` 挂载。安装、升级、改配置、改 key 都在 **opsnas 107** 上做；桌面节点只读运行。

## 10. 残留进程

启动器在退出时会清理 dsh 子进程和 shim。若有残留：
```bash
pkill -f 'dsh-owui-shim.mjs'
pkill -f '@deepseek-ai/dsh/lib/bin.js'
```

## 11. 其它

- `--host 0.0.0.0` 被 dsh 主动拒绝，属安全设计；不要绕过。
- 端口默认 `--port 0`（系统分配），多人多机不会冲突；需要固定端口时用 `dsh web --port <端口>`。
- 用户数据在 `~/.dsh`，重置用户的 dsh 状态可 `mv ~/.dsh ~/.dsh.bak` 后重新运行。

## 12. 裸 `dsh` 报 `error: --profile <name> is required`

**原因**：用户的 PATH 里先命中了**自己的旧版 dsh**（如 `~/.local/bin/dsh`），它是标准 CLI，而不是共享启动器；标准 CLI 裸跑要求 `--profile`。共享启动器 `/usr/local/bin/dsh` 才会默认 `web --port 0`。

**排查**：
```bash
command -v dsh
type -a dsh
cat ~/.local/bin/dsh      # 看是否指向 ~/.local/share/deepseek-harness
/usr/local/bin/dsh --version   # 共享版本应为 0.2.2-rc.1
```

**处理**（二选一）：
- 把 `~/.local/bin/dsh` 备份改名，让 PATH 落到 `/usr/local/bin/dsh`；
- 或把 `~/.local/bin/dsh` 改成转发共享启动器：
  ```bash
  mv ~/.local/bin/dsh ~/.local/bin/dsh.personal
  printf '#!/bin/sh\nexec /usr/local/bin/dsh "$@"\n' > ~/.local/bin/dsh
  chmod 755 ~/.local/bin/dsh
  ```
  切换前建议备份 `~/.dsh`（旧版本 profile 会在首次启动时迁移）。

## 13. `dsh web` 报 `EADDRINUSE: address already in use 127.0.0.1:3080`

**原因**：同一台桌面 VM 是多人共用，默认端口 3080 已被**其他用户**的 dsh web 占用；个人安装的 `dsh web` 默认用 3080。

**排查**：
```bash
ss -ltnp | grep ':3080'
ps -eo user,pid,lstart,cmd | grep -E 'dsh.*web' | grep -v grep
```

**处理**：
- 用共享启动器 `dsh`（默认 `--port 0` 随机端口，不会冲突）；
- 或自己的 dsh 显式指定端口：`dsh web --port 0` / `dsh web --port <唯一端口>`；
- 不要 kill 别人的 dsh 进程，也不要让多个人共用默认端口。

## 14. 启动失败日志在哪

dsh 启动失败时会在用户 home 写诊断日志：

```
~/.dsh/logs/startup-<时间戳>-<uuid>.log
```

其中包含 `dshVersion`、`nodeVersion`、`profile`、失败插件、错误堆栈（如 `EADDRINUSE`）。个人 npm 安装的安装日志在 `~/.local/share/deepseek-harness/logs/npm-install.log`。
