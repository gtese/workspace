#!/usr/bin/env bash
# 把 workspace/backup-center 同步到内网 GitLab（保护分支 main 不支持 force push，
# 因此用 subtree split + merge 的方式提交）。
# 用法：./scripts/sync-gitlab.sh [GitLab 仓库 URL]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKSPACE_DIR="$(cd "$PROJECT_DIR/.." && pwd)"
REPO="${1:-${GITLAB_REPO:-https://git.tri.local/it/backup.git}}"
BRANCH="backup-center-main"

echo "[sync] workspace: $WORKSPACE_DIR"
echo "[sync] project:   $PROJECT_DIR"
echo "[sync] gitlab:    $REPO"

cd "$WORKSPACE_DIR"
git branch -D "$BRANCH" >/dev/null 2>&1 || true
git subtree split --prefix=backup-center -b "$BRANCH" >/dev/null
echo "[sync] split: $(git rev-parse --short "$BRANCH")"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
git clone -q "$REPO" "$TMP/repo"
cd "$TMP/repo"
git fetch -q "$WORKSPACE_DIR" "$BRANCH:import"
git checkout -q import
git merge --allow-unrelated-histories -X ours -m "合并 backup-center 项目历史" origin/main >/dev/null || true
GIT_TERMINAL_PROMPT=0 git push origin import:main
echo "[sync] 完成：$REPO (main)"
