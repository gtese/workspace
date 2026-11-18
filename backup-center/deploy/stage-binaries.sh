#!/usr/bin/env bash
# 在 Mac（可访问 GitHub）上执行：下载并校验 restic/rclone，收集 agent 产物到 deploy/dist。
# 输出目录可整体 rsync 到 150，再由 deploy/install-server.sh 安装。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$ROOT/deploy/dist"
RESTIC_VERSION="${RESTIC_VERSION:-0.18.0}"
RCLONE_VERSION="${RCLONE_VERSION:-1.76.0}"
AGENT_VERSION="${AGENT_VERSION:-0.1.0}"
mkdir -p "$DIST/restic/linux/amd64" "$DIST/restic/darwin/arm64" "$DIST/restic/darwin/amd64" \
  "$DIST/rclone/linux/amd64" "$DIST/agent/$AGENT_VERSION"

log() { printf '[stage] %s\n' "$*"; }

fetch_restic() { # os arch
  local os="$1" arch="$2" asset="restic_${RESTIC_VERSION}_${os}_${arch}.bz2"
  local url="https://github.com/restic/restic/releases/download/v${RESTIC_VERSION}/${asset}"
  local out="$DIST/restic/${os}/${arch}/restic"
  log "下载 $asset"
  curl -4 -fsSL --retry 3 --connect-timeout 20 -o "/tmp/${asset}" "$url"
  if ! grep -q "  ${asset}$" "/tmp/restic-sums" 2>/dev/null; then :; fi
  if [[ -f /tmp/restic-sums ]]; then
    (cd /tmp && grep "  ${asset}$" /tmp/restic-sums | shasum -a 256 -c -)
  fi
  bzip2 -dc "/tmp/${asset}" > "$out"
  chmod +x "$out"
  rm -f "/tmp/${asset}"
  log "restic ${os}/${arch} -> $out"
}

if [[ ! -f /tmp/restic-sums ]]; then
  log "下载 restic SHA256SUMS"
  curl -4 -fsSL --retry 3 --connect-timeout 20 -o /tmp/restic-sums \
    "https://github.com/restic/restic/releases/download/v${RESTIC_VERSION}/SHA256SUMS"
fi

for pair in linux/amd64 darwin/arm64 darwin/amd64; do
  fetch_restic "${pair%/*}" "${pair#*/}"
done

# rclone（仅服务端 FTP 后端需要）
if [[ ! -x "$DIST/rclone/linux/amd64/rclone" ]]; then
  log "下载 rclone ${RCLONE_VERSION} (linux/amd64)"
  curl -4 -fsSL --retry 3 --connect-timeout 20 -o /tmp/rclone.zip \
    "https://downloads.rclone.org/rclone-v${RCLONE_VERSION}-linux-amd64.zip"
  unzip -q -o /tmp/rclone.zip -d /tmp/rclone-extract
  install -m 0755 "/tmp/rclone-extract/rclone-v${RCLONE_VERSION}-linux-amd64/rclone" "$DIST/rclone/linux/amd64/rclone"
  rm -rf /tmp/rclone.zip /tmp/rclone-extract
fi

# agent 产物（由 scripts/build-agent.sh 生成）
for pair in linux-amd64 darwin-arm64 darwin-amd64; do
  src="$ROOT/deploy/bin/agent/${pair}/backup-agent"
  [[ -f "$src" ]] || { echo "缺少 agent 产物：$src（先运行 scripts/build-agent.sh）" >&2; exit 1; }
  os="${pair%%-*}"; arch="${pair##*-}"
  install -m 0755 "$src" "$DIST/agent/$AGENT_VERSION/$os/$arch/backup-agent"
done

# 挂载助手
if [[ -x "$ROOT/deploy/bin/backup-mountd" ]]; then
  install -m 0755 "$ROOT/deploy/bin/backup-mountd" "$DIST/backup-mountd"
fi

install -m 0755 "$ROOT/agent/packaging/install.sh" "$DIST/install.sh"

(
  cd "$DIST"
  find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 shasum -a 256 > SHA256SUMS
)
log "完成：$DIST"
log "下一步：rsync -av $DIST/ root@172.16.50.150:/tmp/backup-center-dist/"
