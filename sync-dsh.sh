#!/bin/bash
# 把 https://git.tri.local/it/dsh 的最新项目资料同步到 workspace/dsh。
# 可手动执行，也可交给 DSH 定时任务定期执行。
set -uo pipefail

REPO="/Users/linyiyao/deepseek/dsh-git"
WS="/Users/linyiyao/deepseek/workspace"
DEST="$WS/dsh"
LOCK="/tmp/dsh-sync.lock"

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

# 简单互斥，避免定时任务和手动执行撞车
if ! mkdir "$LOCK" 2>/dev/null; then
  log "另一个同步正在进行（$LOCK 存在），本次跳过"
  exit 0
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

[ -d "$REPO/.git" ] || { log "找不到源仓库：$REPO"; exit 1; }
[ -d "$WS/.git" ] || { log "找不到 workspace 仓库：$WS"; exit 1; }

log "拉取源仓库"
git -C "$REPO" pull --ff-only --quiet 2>/tmp/dsh-sync-git.err || {
  # macOS keychain helper 的 credential lock 警告不影响结果，用 HEAD 是否可读判断真实失败
  if ! git -C "$REPO" rev-parse --verify HEAD >/dev/null 2>&1; then
    log "git pull 失败：$(tail -2 /tmp/dsh-sync-git.err 2>/dev/null)"
    exit 1
  fi
}
COMMIT="$(git -C "$REPO" rev-parse --short HEAD)"
OLD_COMMIT="$(grep -o '同步提交.*`[0-9a-f]\{7,\}`' "$DEST/SYNC.md" 2>/dev/null | grep -o '[0-9a-f]\{7,\}' | head -1)"

# 先看 workspace 是否已有未提交改动
if [ "$COMMIT" = "${OLD_COMMIT:-}" ] && [ -z "$(git -C "$WS" status --porcelain dsh)" ]; then
  log "已是最新（源提交 $COMMIT）"
  exit 0
fi

log "同步到 $DEST"
rsync -a --delete \
  --exclude='.git' --exclude='config/pki' --exclude='.DS_Store' --exclude='SYNC.md' \
  "$REPO"/ "$DEST"/

log "更新 SYNC.md（$OLD_COMMIT -> $COMMIT）"
python3 - "$DEST/SYNC.md" "$COMMIT" "$(date '+%Y-%m-%d %H:%M')" <<'PY'
import re, sys
path, commit, when = sys.argv[1:4]
s = open(path, encoding='utf-8').read()
s = re.sub(r'(- \*\*同步提交\*\*：`)[0-9a-f]+(`)', r'\g<1>' + commit + r'\g<2>', s)
s = re.sub(r'(- \*\*同步时间\*\*：).*', r'\g<1>' + when + '（Asia/Shanghai）', s)
open(path, 'w', encoding='utf-8').write(s)
PY

cd "$WS" || exit 1
git add dsh
if git diff --cached --quiet; then
  log "workspace 无实际变化，跳过提交"
  exit 0
fi
git commit -q -m "docs: sync dsh project materials (source ${COMMIT})"
log "workspace 已提交：$(git log -1 --format='%h %s')"

# 推送到 GitHub 需要凭据；此处只提示，不阻塞定时任务
if git status -sb | head -1 | grep -q 'ahead'; then
  log "本地已提交；如需同步到 GitHub，请在凭据可用时执行：git -C $WS push origin main"
fi
