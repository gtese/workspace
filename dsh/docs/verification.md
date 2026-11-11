# 验证记录

验证日期：2026-11-06
验证账号：普通用户 `linyiyao`（无 sudo、未设置任何 DEEPSEEK_* 环境变量）

原始输出见 [`../data/verification-2026-11-06.txt`](../data/verification-2026-11-06.txt)。

## 验证项与结果

| # | 主机 | 验证项 | 命令 | 结果 |
|---|---|---|---|---|
| 1 | trivm131 | 版本 | `dsh --version` | `0.2.0-rc.2` ✅ |
| 2 | trivm131 | 对话 | `dsh --profile headless "你好，请只回复：端到端-ok"` | `端到端-ok` ✅ |
| 3 | trivm131 | 工具调用 | `dsh --profile headless "运行 whoami 命令，然后只回复命令的输出"` | `linyiyao` ✅ |
| 4 | trivm131 | Web UI | `dsh`（无图形会话） | 打印 token URL；无 token 401；带 token 303；cookie 后 index 200 ✅ |
| 5 | trivm131 | 进程清理 | 退出 Web 后 | 无残留 dsh / shim 进程 ✅ |
| 6 | opsnas 107 | 版本 | `dsh --version` | `0.2.0-rc.2` ✅ |
| 7 | opsnas 107 | 对话 | `dsh --profile headless "你好，请只回复：107-ok"` | `107-ok` ✅ |
| 8 | 两台 | 共享配置 | 不设置环境变量直接运行 | 自动读取 `/eda/apps/deepseek/etc/dsh.env`，无需输入 Key ✅ |
| 9 | trivm132 | 版本 | `dsh --version` | `0.2.0-rc.2` ✅ |
| 10 | trivm132 | 对话 | `dsh --profile headless "你好，请只回复：132-ok"` | `132-ok` ✅ |
| 11 | trivm132 | 工具调用 | `whoami` | `linyiyao` ✅ |
| 12 | trivm132 | Web UI | `dsh` | 打印 token URL；401/303 正常 ✅ |
| 13 | trivm133 | 版本/对话/工具/Web | 同上 | `133-ok` / `linyiyao` / 401+303 ✅ |

## 前置链路验证（排障用）

以下为定位问题时做过的单项检查，可作为回归基线：

| 检查 | 命令 | 预期 |
|---|---|---|
| OWUI 版本 | `curl -sk https://chat.tri.local/api/version` | `{"version":"0.12.4",...}` |
| OWUI 模型 | `curl -s https://chat.tri.local/api/models -H "Authorization: Bearer <key>"` | 含 `deepseek-flash`、`deepseek-v4-pro` |
| OWUI Messages 非流式 | `POST https://chat.tri.local/api/v1/messages` | 200，返回 `content:[{type:"text"...}]` |
| OWUI Messages 工具 | 同上 + `tools` | 200，返回 `tool_use` |
| OWUI Messages **流式** | 同上 + `"stream":true` | ⚠️ 0.12.4 只返回空 `message_start/delta/stop`，需要用 shim |
| CA 信任 | `NODE_EXTRA_CA_CERTS=... node -e 'fetch("https://chat.tri.local/api/models")'` | 401（TLS 通过） |

## 已知未覆盖项

- 图片/附件输入（Open WebUI 的 Files API 路径）未验证；文本与工具调用已验证。
- 多用户并发场景未做压力测试。
- 桌面环境里浏览器自动打开未在无头会话中实测（依赖 `xdg-open`/Firefox，已在主机上确认存在）。

## 2026-11-11 升级到 0.2.2-rc.1

- 升级方式：opsnas 107 上 `npm install -g --prefix /eda/apps/deepseek @deepseek-ai/dsh@0.2.2-rc.1`
- 备份：`/eda/apps/deepseek-backup-0.2.0-rc.2-20261111.tar.gz`（116MB）
- 四台主机（107/131/132/133，共享 NFS）`dsh --version` 均为 `0.2.2-rc.1`
- 在 trivm132 以普通用户执行 `verify.sh --tool --web`：

```
== 版本
   OK  dsh --version -> 0.2.2-rc.1
== headless 对话
   输出: verify-ok
   OK  模型对话正常
== 工具调用（whoami）
   输出: linyiyao
   OK  bash 工具正常
== Web UI 启动与认证
   no-token=401 token=303
   OK  Web UI/token 正常
全部通过
```

- 原生模块检查：`require("koffi")`、`require("node-pty")` 正常，`node-pty` 的 `pty.spawn("/bin/echo")` 正常（npm allow-scripts 跳过 install 脚本不影响）。
