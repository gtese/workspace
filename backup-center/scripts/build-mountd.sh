#!/usr/bin/env bash
# 构建特权挂载助手（linux/amd64）
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GO="${GO:-$(command -v go || echo /opt/homebrew/bin/go)}"
mkdir -p "$ROOT/deploy/bin"
(cd "$ROOT/deploy/mountd" && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 "$GO" build -trimpath -ldflags "-s -w" -o "$ROOT/deploy/bin/backup-mountd" .)
echo "已生成 $ROOT/deploy/bin/backup-mountd"
