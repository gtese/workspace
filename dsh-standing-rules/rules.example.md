# 常驻工作规范

> 本文件由 DSH 插件 `@linyiyao/dsh-standing-rules` 注入到每次请求的 system prompt。
> 直接编辑本文件即可生效（下一次请求即可看到），不需要重启 DSH。

## 1. 凭据与密码（`~/.mm`）

- 所有密码、口令、token、API key、私钥统一存放在 `~/.mm/` 下：目录权限 `0700`，文件权限 `0600`。
- 任何仓库文件、脚本、配置、README、日志、提交信息、对话回复中都不得出现明文凭据。
- 需要凭据时从 `~/.mm/<服务名>` 读取，或在运行期用环境变量注入；只引用文件路径、变量名，绝不回显内容。
- 代码与文档一律使用环境变量或占位符（如 `${WEMP_PASS}`、`<redacted>`），不得硬编码明文。
- 提交/同步到 git 前先做敏感信息扫描，命中即改为占位符并说明：
  `grep -rnE "password *=|secret|api[_-]?key|AKIA|sk-|xoxb|Bearer|BEGIN [A-Z ]*PRIVATE KEY" <项目目录>`
- 绝不把 `~/.mm` 纳入任何 git 仓库、备份或同步目录。

## 2. 项目目录与 git 同步（`~/deepseek/workspace`）

- 长期项目的代码与文档放在 `~/deepseek/workspace/<项目名>/` 下，子目录名与项目名一致。新项目先建同名子目录，不要把项目文件直接堆在 `~/deepseek` 根目录。
- `~/deepseek/workspace` 是一个 git 仓库（origin：`https://github.com/gtese/workspace.git`）。完成一批改动后：
  1. 只 `git add <项目名>`（或明确列出的路径），不要 `git add -A`，避免带入无关目录或敏感文件；
  2. 提交信息用中文，写清项目与改动要点；
  3. 执行 `git -C ~/deepseek/workspace push origin main`；如果凭据不可用，先本地提交，并在回复中明确告知用户「已提交、未推送」。
- 一次性临时脚本放 `/tmp`（或 `~/deepseek/scripts`），不提交进 workspace 仓库。
- 上游资料同步示例：`~/deepseek/workspace/sync-dsh.sh` 把 `git.tri.local/it/dsh` 同步到 `workspace/dsh/`，并按 `SYNC.md` 格式记录源提交与同步时间；同类同步沿用该模式。
- 提交前检查 `git status` 与 `git diff --cached`，确认改动范围只包含本项目预期的文件。

## 3. 交付习惯

- 改完先验证（构建、测试或最小可复现）再提交；无法验证时明确说明原因。
- 文档默认用中文；命令、代码、路径、配置键名保持原样。
- 回复用户时先给结论和下一步，不要只贴大段日志。
