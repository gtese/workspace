# @linyiyao/dsh-standing-rules

把用户维护的「常驻规范」注入到 DSH 每次模型请求的 system prompt 中：打开任何一个新对话，agent 一开始就带着这些规范，不需要每次重复交代。

规则正文放在 DSH home 下的 Markdown 文件里（默认 `~/.dsh/rules.md`），插件只负责读取和注入，改规则不用改代码、不用重启。

当前 seed 的规则覆盖：

- 密码/凭据统一存 `~/.mm/`（0600），禁止落库、落提交、落回复；
- 项目代码与文档放 `~/deepseek/workspace/<项目名>/`，并同步到 workspace 的 git 仓库；
- 提交前敏感信息扫描、交付前先验证等习惯。

## 工作方式

- 注册一个 system-prompt section：`user:standing-rules`，`order: 100`（紧接部署 persona，在工具指引之前）。
- 每次提示词组装时读取规则文件（按 `mtime + size` 缓存，文件没变不重复读）。
- 修改 `~/.dsh/rules.md` → 下一次请求即生效，无需重启 DSH、无需重装插件。
- 文件不存在、为空或不可读时静默跳过，绝不让提示词组装失败。
- 超过 `maxBytes` 时按字节截断，并在末尾附截断提示。

## 配置

配置写在 bundle 的 [`cordis.patch.yml`](cordis.patch.yml) 里：

```yaml
- insert:
    - id: standing-rules
      name: '@linyiyao/dsh-standing-rules'
      config:
        rulesFile: '$DSH_HOME/rules.md'
        maxBytes: 32768
        order: 100
```

| 字段 | 默认值 | 说明 |
|---|---|---|
| `rulesFile` | `$DSH_HOME/rules.md` | 规则文件路径；支持 `~`、`$HOME`、`$DSH_HOME`；相对路径按 `$DSH_HOME` 解析 |
| `maxBytes` | `32768` | 注入内容的字节上限，超出截断 |
| `order` | `100` | system prompt 段落顺序；调大可放到工具指引之后 |

默认的 `~/.dsh/rules.md` 已按 [`rules.example.md`](rules.example.md) 初始化，直接编辑即可。

## 安装 / 迁移

本机已安装到 `desktop` profile（`cordis.patch.yml` 由 bundle 提供，profile 只记录依赖和 bundle 选择）：

```bash
# 通过 DSH 的 plugin_manager 工具或 Web「插件」页安装本地链接包
plugin_manager install_bundle link:/Users/linyiyao/deepseek/workspace/dsh-standing-rules
```

安装后 profile 的 `package.json` 会记录：

```json
{
  "dependencies": { "@linyiyao/dsh-standing-rules": "link:..." },
  "dsh": { "profile": { "bundles": [..., "@linyiyao/dsh-standing-rules"] } }
}
```

启用 HMR 的 profile 会立即生效；没有 HMR 的 profile 需要重启 DSH。

## 验证

```bash
cd ~/deepseek/workspace/dsh-standing-rules && node --test test/
```

端到端验证：新对话的 system prompt 中会出现 `## Standing rules (user-defined; apply to every conversation)` 和 `Source: /Users/<user>/.dsh/rules.md`。也可以看会话日志（`~/.dsh/sessions/.../session.v4.jsonl.zstd`）里的 `system/message` 事件。

## 卸载

```bash
plugin_manager remove_bundle @linyiyao/dsh-standing-rules
```

规则文件 `~/.dsh/rules.md` 会保留，可手动删除。只想临时停用可先把 `cordis.patch.yml` 里的 `id: standing-rules` 改为 `disabled: true`，或从 profile 的 bundle 列表移除。

## 与内置 `AGENTS.md` 机制的关系

DSH 自带的 `@deepseek-ai/dsh-agent-instructions` 会加载 `~/.dsh/AGENTS.md`、`~/.agents/AGENTS.md` 以及项目内 `AGENTS.md`，以 **user 消息**的形式注入历史；本插件则把单一全局文件以 **system prompt** 段落注入。两者可以共存：

- 想要「强约束、始终生效、单一文件」→ 用本插件；
- 想要「按项目目录自动加载、跟随仓库分发」→ 用内置 `AGENTS.md`（把规则写到 `~/.dsh/AGENTS.md` 即可，不需要写代码）。
