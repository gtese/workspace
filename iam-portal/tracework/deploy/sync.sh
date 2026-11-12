#!/usr/bin/env bash
# ============================================================
# 变更同步脚本 —— 提交并推送到 GitLab
# ============================================================
# 用途：把本地改动提交并推送到 https://git.tri.local/it/tracework.git
#
# 用法：
#   bash sync.sh                    # 自动生成提交信息
#   bash sync.sh "feat: 新增功能"    # 指定提交信息
#   bash sync.sh --dry-run          # 只看有哪些改动，不提交
#
# 安全检查：
#   · 推送前扫描是否误提交了私钥、.env、硬编码密码
#   · 有敏感内容立即中止
# ============================================================
set -euo pipefail

REPO_DIR="${REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
REMOTE="${REMOTE:-origin}"
BRANCH="${BRANCH:-main}"

info() { printf '\033[1;34m[sync]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

cd "$REPO_DIR"
git rev-parse --git-dir >/dev/null 2>&1 || die "当前目录不是 Git 仓库：$REPO_DIR"

# ------------------------------------------------------------
# 1. 检查是否有改动
# ------------------------------------------------------------
if git diff --quiet && git diff --cached --quiet && [ -z "$(git ls-files --others --exclude-standard)" ]; then
  info "没有需要同步的改动"
  exit 0
fi

info "检测到以下改动："
git status --short | sed 's/^/    /'

if [ "${1:-}" = "--dry-run" ]; then
  info "（--dry-run 模式，未提交）"
  exit 0
fi

# ------------------------------------------------------------
# 2. 安全检查 —— 防止敏感信息入库
# ------------------------------------------------------------
info "执行敏感信息检查 ..."
git add -A

FAIL=0
# 2.1 私钥 / .env
while IFS= read -r f; do
  case "$f" in
    *.key|*.pfx|*.p12|*.env|.env|*/.env)
      echo "  ✗ 敏感文件被加入暂存区：$f" >&2
      FAIL=1
      ;;
  esac
done < <(git diff --cached --name-only)

# 2.2 已知密码（可扩展）
# 已知敏感值从 deploy/.secret-patterns 读取（该文件已在 .gitignore 中排除）
# 若文件不存在，则使用通用规则：命中常见密码字段赋值模式
PATTERNS_FILE="$REPO_DIR/deploy/.secret-patterns"
if [ -f "$PATTERNS_FILE" ]; then
  while IFS= read -r pw; do
    [ -z "$pw" ] && continue
    case "$pw" in \#*) continue ;; esac
    if git diff --cached -U0 | grep -qF -- "+$pw"; then
      echo "  ✗ 暂存内容中发现已知敏感值" >&2
      FAIL=1
    fi
  done < "$PATTERNS_FILE"
else
  # 通用规则：password/secret 后面直接跟引号包裹的字面量
  # 排除明显是占位符的字面量：xxx / *** / <...> / your-xxx / CHANGE_ME / 全同字符
  HITS=$(git diff --cached -U0 | grep -vE '^\+\s*#' \
    | grep -iE '^\+.*(password|passwd|secret|token)\s*[:=]\s*["'"'"'][^"'"'"'$]{6,}["'"'"']' \
    | grep -viE 'x{6,}|\*{3,}|<[^>]+>|your[-_]?|example|placeholder|CHANGE[-_]?ME|dummy|sample|fake|test' \
    | head -5)
  if [ -n "$HITS" ]; then
    echo "  ✗ 暂存内容中疑似硬编码凭据：" >&2
    echo "$HITS" | sed 's/^/      /' >&2
    FAIL=1
  fi
fi

# 2.3 私钥内容特征
if git diff --cached -U0 | grep -qE "^\+.*BEGIN[ -]+(RSA |EC |OPENSSH )?PRIV"'ATE'; then
  echo "  ✗ 暂存内容中发现私钥" >&2
  FAIL=1
fi

if [ "$FAIL" -ne 0 ]; then
  git reset -q
  die "安全检查未通过，已取消提交。请移除敏感内容后重试。"
fi
info "安全检查通过"

# ------------------------------------------------------------
# 3. 生成提交信息并提交
# ------------------------------------------------------------
MSG="${1:-}"
if [ -z "$MSG" ]; then
  # 根据改动文件自动归类
  CHANGED=$(git diff --cached --name-only)
  PREFIX="chore"
  echo "$CHANGED" | grep -q "^server/src/" && PREFIX="feat"
  echo "$CHANGED" | grep -q "^web/src/views/" && PREFIX="feat"
  echo "$CHANGED" | grep -qE "^(docs/|README|CONTRIBUTING)" && [ "$PREFIX" = "chore" ] && PREFIX="docs"
  echo "$CHANGED" | grep -q "^deploy/" && [ "$PREFIX" = "chore" ] && PREFIX="chore"

  FILES=$(echo "$CHANGED" | head -5 | sed 's/^/  - /')
  COUNT=$(echo "$CHANGED" | wc -l | tr -d ' ')
  [ "$COUNT" -gt 5 ] && FILES="$FILES
  - ... 等共 $COUNT 个文件"

  MSG="$PREFIX: 同步更新（$(date '+%Y-%m-%d %H:%M')）

变更文件：
$FILES"
fi

info "提交：$(echo "$MSG" | head -1)"
git commit -q -m "$MSG"

# ------------------------------------------------------------
# 4. 推送
# ------------------------------------------------------------
info "推送到 $REMOTE/$BRANCH ..."
if git push "$REMOTE" "$BRANCH" 2>&1 | tail -3; then
  info "同步完成"
  git log --oneline -1 | sed 's/^/    /'
else
  die "推送失败，请检查网络或凭据"
fi