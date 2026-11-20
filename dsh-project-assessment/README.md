# @linyiyao/dsh-project-assessment

按需触发的「项目上线交付评估」插件：在对话里输入 `/评估 [项目/范围/关注点]`，agent 会先加载完整的评估规范，再按规范收集证据、分级问题并给出 **Go / Conditional Go / No-Go** 结论。

评估规范是一份可编辑的 Markdown（[skill/project-assessment.md](skill/project-assessment.md)），已综合并优化了用户提供的专家提示词：独立第三方立场、证据分级（E1–E4）、执行协议（盘点 → 证据收集 → 场景测试 → 分级 → 决策 → 报告）、A–J 维度、P0–P3 分级、9 段式报告模板、快速检查清单和常见失败模式。

## 两种触发方式

| 输入 | 行为 | 机制 |
|---|---|---|
| `/评估`、`/评估 pdk_mover 重点看权限和回滚` | 本插件在 `agent/pre-step` 检测到直接用户消息以 `/评估` 开头，把完整评估规范注入该步骤 | 自定义 pre-step 注入（确定性，不依赖模型猜） |
| `/project-assessment` | 原生 user-invocable skill 调用，DSH 的 `tool-skill` 把技能正文注入步骤 | 标准 skill 机制 |

> 为什么 `/评估` 不是原生命令：DSH 的斜杠命令名只接受小写 ASCII（`/^[a-z][a-z0-9_-]*$/`），中文不能注册为命令。但 Web 输入框对**未命中的** `/` 行会按普通消息发送（见 `dsh-client-ui-conversation` 的 `SubmitMachine.onAdjudicated`：无法识别的命令返回 `undefined` → 正常发送），所以 `/评估` 会作为用户消息到达 agent，本插件据此做确定性注入。

## 工作方式

```
用户: /评估 pdk_mover 重点看权限
        │
        ▼
Web 输入框（未命中任何命令/skill → 作为普通消息提交）
        │
        ▼
agent/pre-step 瀑布
  ├─ tool-skill：处理 /project-assessment 手势（另一种入口）
  └─ 本插件：匹配 /^[／/]\s*评估(?=$|空白或标点)/
        │  读取 skill/project-assessment.md
        │  注入 <skill_content name="project-assessment">…</skill_content>
        ▼
模型按规范执行评估（可调用 read/grep/bash 等工具收集证据）
```

- 技能注册：本插件向 `ctx.skills` 注册 provider，使 `project-assessment` 出现在 `/` 菜单和模型 skill 目录中；`get()` 每次重新读文件。
- 热更新：目录 watcher 在规范文件变化时使 skill 目录失效；`/评估` 注入每次都重新读文件。改规范不需要重装/重启。
- 零常驻开销：不注册任何 system prompt 段——只有真正触发时才注入（规范正文约 3k tokens）。

## 配置

bundle 的 [cordis.patch.yml](cordis.patch.yml) 默认无需配置：

```yaml
- insert:
    - id: project-assessment
      name: '@linyiyao/dsh-project-assessment'
```

可选配置：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `skillFile` | 包内 `skill/project-assessment.md` | 覆盖评估规范文件路径，支持 `~` |

## 安装 / 迁移

```bash
plugin_manager install_bundle link:/Users/linyiyao/deepseek/workspace/dsh-project-assessment
```

安装后 profile 的 `package.json` 会记录 `link:` 依赖和 bundle；启用 HMR 的 profile 立即生效，否则重启 DSH。

## 验证

```bash
cd ~/deepseek/workspace/dsh-project-assessment && node --test test/
```

端到端验证：安装后在 Web 对话框输入 `/评估 测试项目`，模型应输出评估报告；也可以看会话日志里新出现的 `skill-invocation` 用户消息（含 `<skill_content name="project-assessment">`）。

## 卸载

```bash
plugin_manager remove_bundle @linyiyao/dsh-project-assessment
```

## 调整评估规范

直接编辑 [skill/project-assessment.md](skill/project-assessment.md)（或配置 `skillFile` 指向你的副本），下一次 `/评估` 立即使用新内容。建议保留：触发解析、执行协议、证据分级、P0–P3 定义、Go/Conditional/No-Go 判定、9 段式输出。
