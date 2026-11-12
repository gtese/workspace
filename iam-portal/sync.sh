#!/bin/bash
# 把 git.tri.local/it/{oidc,portal,tracework} 的最新代码同步到 workspace/iam-portal/
#
# 用法：./iam-portal/sync.sh
#   - 各子目录为只读快照（不含 .git），同步后自动提交到 workspace 仓库
#   - 不改动任何明文密钥：仓库本身不含凭据（见 README §6）
set -uo pipefail

WS="/Users/linyiyao/deepseek/workspace"
DEST="$WS/iam-portal"
CACHE="/tmp/iam-portal-sync"
CA="$HOME/.config/git/git-tri-ca.crt"
LOCK="/tmp/iam-portal-sync.lock"

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

if ! mkdir "$LOCK" 2>/dev/null; then
  log "另一个同步正在进行（$LOCK 存在），本次跳过"; exit 0
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

mkdir -p "$CACHE"
CHANGED=0

for r in oidc portal tracework; do
  log "同步 $r"
  if [ -d "$CACHE/$r/.git" ]; then
    git -c http.sslCAInfo="$CA" -C "$CACHE/$r" fetch --quiet origin main || { log "  拉取失败，跳过"; continue; }
    git -C "$CACHE/$r" reset --hard --quiet origin/main || continue
  else
    rm -rf "$CACHE/$r"
    git -c http.sslCAInfo="$CA" clone --quiet https://git.tri.local/it/$r.git "$CACHE/$r" || { log "  克隆失败，跳过"; continue; }
  fi

  # 只替换内容，保留 REPO.md
  rsync -a --delete --exclude='.git' --exclude='REPO.md' "$CACHE/$r/" "$DEST/$r/" || { log "  复制失败"; continue; }

  # 刷新版本信息
  {
    echo "--- $r ---"; echo ""
    echo "来源：https://git.tri.local/it/$r.git"
    echo "快照提交：$(git -C "$CACHE/$r" log --oneline -1)"
    echo "快照时间：$(date '+%Y-%m-%d %H:%M')"
    echo ""
    echo "本目录为只读快照（不含 .git），最新代码以仓库为准。"
  } > "$DEST/$r/REPO.md"
done

cd "$WS" || exit 1
if [ -n "$(git status --porcelain iam-portal)" ]; then
  CHANGED=1
  git add iam-portal
  git -c user.name="$(git config user.name || echo dsh-sync)" \
      -c user.email="$(git config user.email || echo dsh-sync@local)" \
      commit --quiet -m "docs: sync iam-portal materials ($(date '+%F'))"
  log "已提交到 workspace 仓库"
else
  log "无变化"
fi

log "完成（changed=$CHANGED）。推送：cd $WS && git push"
