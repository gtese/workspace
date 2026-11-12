#!/usr/bin/env bash
# ============================================================
# 自动同步守护 —— 监视本地改动并自动推送到 GitLab
# ============================================================
# 用法：
#   bash deploy/auto-sync.sh          # 前台运行，每 60 秒检查一次
#   bash deploy/auto-sync.sh --once   # 只检查一次
#
# 停止：Ctrl+C
# ============================================================
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INTERVAL="${INTERVAL:-60}"

cd "$REPO_DIR" || exit 1

sync_once() {
  # 无改动则跳过
  if git diff --quiet && git diff --cached --quiet \
     && [ -z "$(git ls-files --others --exclude-standard)" ]; then
    return 0
  fi
  echo "[$(date '+%H:%M:%S')] 检测到改动，开始同步 ..."
  if bash "$REPO_DIR/deploy/sync.sh" "chore: 自动同步 $(date '+%Y-%m-%d %H:%M:%S')" 2>&1 \
     | grep -E "同步完成|error"; then
    :
  fi
}

if [ "${1:-}" = "--once" ]; then
  sync_once
  exit 0
fi

echo "自动同步已启动（每 ${INTERVAL} 秒检查一次，Ctrl+C 停止）"
trap 'echo; echo "自动同步已停止"; exit 0' INT TERM
while true; do
  sync_once
  sleep "$INTERVAL"
done
