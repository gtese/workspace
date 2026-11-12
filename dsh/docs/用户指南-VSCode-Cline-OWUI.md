# 用户指南：获取 OWUI API Key 并在 VSCode + Cline 中使用 DeepSeek-V4.1-Flash

> 适用：公司内网/公司 VPN 环境；VSCode（macOS / Windows / Linux 桌面均可）。
> 模型：Open WebUI 中的 **DeepSeek-V4.1-Flash**，模型 ID 为 `deepseek-flash`。
> 目标：在 VSCode 的 Cline 扩展里通过 Open WebUI 调用 DeepSeek，无需直接接触真实 DeepSeek Key。

---

## 第 1 步：获取 Open WebUI API Key

1. 浏览器打开内网地址：<https://chat.tri.local>
2. 用公司统一身份（SSO）登录。
3. 点击左下角**头像/你的名字** → **设置（Settings）** → **账户（Account）** → **API Keys**。
4. 点击**创建 API Key**（Create / Generate），给它起个名字（例如 `vscode-cline`）。
5. **立即复制**弹出的 `sk-...` 字符串并妥善保存（通常只显示一次）。
6. 如果找不到 API Keys 入口：说明管理员未开启全局 API Keys 开关或你的用户组无权限，请联系平台管理员。

> 安全提示：API Key 等同于你的访问凭证，不要发到群里、不要提交到 git。不需要时可以在同一页面删除/重新生成。

---

## 第 2 步：在 VSCode 中安装 Cline

1. 打开 VSCode。
2. 按 `Ctrl+Shift+X`（macOS：`Cmd+Shift+X`）打开扩展面板。
3. 搜索 **Cline**（发布者 Cline，扩展 ID `saoudrizwan.claude-dev`）。
4. 点击 **Install**。
5. 安装完成后，左侧活动栏会出现 Cline 图标；点击打开。

> 内网无法访问 VSCode 市场时：从可上网的机器下载 Cline 的 `.vsix`，拷贝到目标机器，在扩展面板右上角 `...` → **Install from VSIX** 安装。

6. 首次打开 Cline，选择 **Use your own API key**（使用自己的 API Key）。

---

## 第 3 步：在 Cline 中填写 OWUI 配置

打开 Cline → 右上角**设置（齿轮）**，按下表填写：

| 配置项 | 填写内容 |
|---|---|
| **API Provider** | `OpenAI Compatible`（注意：不是 OpenAI） |
| **Base URL** | `https://chat.tri.local/api`（结尾不要加 `/v1`，也不要加 `/chat/completions`） |
| **API Key** | 第 1 步复制的 `sk-...` |
| **Model ID** | `deepseek-flash`（这是 DeepSeek-V4.1-Flash 的模型 ID，不是显示名） |

可选项（不同 Cline 版本位置略有差异）：

- **Context Window**：`1048576`
- **Max Output Tokens**：`393216`
- **Supports Images**：先不勾（图片输入路径尚未验证；文字对话和代码任务不受影响）
- **Enable streaming / 流式输出**：如果出现回答空白或解析错误，**关闭**该选项（原因见第 5 节）

保存后，在 Cline 对话框输入一句测试：

```text
你好，请只回复：cline-ok
```

能正常回复就说明配置成功。

---

## 第 4 步（可选）：先验证 OWUI 服务是否通

在终端里执行（把 `sk-...` 换成你的 Key）：

```bash
# 1) 列出可用模型，确认 deepseek-flash 在列表里
curl -s https://chat.tri.local/api/models \
  -H "Authorization: Bearer sk-你的Key"

# 2) 非流式对话测试，应返回 choices[0].message.content
curl -s https://chat.tri.local/api/chat/completions \
  -H "Authorization: Bearer sk-你的Key" \
  -H 'content-type: application/json' \
  -d '{"model":"deepseek-flash","stream":false,
       "messages":[{"role":"user","content":"只回复：ok"}]}'
```

如果两步都正常，说明 Key、网络、模型 ID 都没问题，Cline 里的问题通常只是配置项不对。

---

## 第 5 节：常见问题

| 现象 | 原因 / 处理 |
|---|---|
| `401 Unauthorized` | Key 错误、被删除或过期；重新生成 API Key 并粘贴 |
| `404 model not found` / 模型不存在 | Model ID 必须填 `deepseek-flash`（显示名 DeepSeek-V4.1-Flash 不能填） |
| 连接超时 / `fetch failed` | 不在内网或未连公司 VPN；`chat.tri.local` 仅内网可达 |
| `self-signed certificate in certificate chain` | 系统/扩展不信任公司内部 CA：macOS 已默认信任；仍报错时，从终端启动 VSCode 前 `export NODE_EXTRA_CA_CERTS=/path/to/tri-enterprise-root.pem`（Windows 需把企业根证书装进“受信任的根证书颁发机构”） |
| 回答空白 / 只显示思考过程 / 解析错误 | OWUI 当前版本的流式返回格式对部分扩展不兼容：在 Cline 里关闭流式输出；或联系管理员在 OWUI 模型设置里关闭 **Stream Chat Response**；也可改用 Roo Code / Continue 等支持非流式或 Responses 协议的客户端 |
| `429` / 额度不足 | 联系管理员检查 OWUI 侧的额度/限流 |
| 工具调用（读写文件、执行命令）不生效 | 取决于客户端与 OWUI 的协议转换；纯对话/代码问答最稳，复杂 agent 工具建议使用服务器上的 dsh |

---

## 第 6 节：安全与建议

1. 使用**个人** OWUI API Key，不要使用多人共享的 Key（共享 Key 泄露后只能整体轮换）。
2. 不要把 Key 写进会提交到 git 的 `.vscode/settings.json`；Cline 会把它存在自己的密钥存储里。
3. 不要把 Key 发给同事或贴在聊天工具里；怀疑泄露时立即在 OWUI 删除并重建。
4. Cline 的“自动执行命令/自动编辑文件”默认行为请按需收紧，避免误操作。

---

## 附录：模型 ID 对照

| OWUI 显示名 | Model ID（填这个） |
|---|---|
| DeepSeek-V4.1-Flash | `deepseek-flash` |
| DeepSeek-V4-Pro | `deepseek-v4-pro` |

模型列表以 `https://chat.tri.local/api/models` 返回为准；显示名和 ID 不一定相同。
