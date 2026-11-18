#!/usr/bin/env bash
# 交叉编译 backup-center 代理（CGO_ENABLED=0），输出到 deploy/bin/agent/<os>-<arch>/。
# 产物：backup-agent、sha256（单文件清单）、deploy/bin/agent/SHA256SUMS（聚合清单）。
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT_DIR/deploy/bin/agent"
GO="${GO:-go}"
if ! command -v "$GO" >/dev/null 2>&1; then
    for candidate in /opt/homebrew/bin/go /usr/local/go/bin/go; do
        if [[ -x "$candidate" ]]; then
            GO="$candidate"
            break
        fi
    done
fi
if ! command -v "$GO" >/dev/null 2>&1; then
    printf '[build-agent] 错误: 未找到 go，可设置 GO=/path/to/go\n' >&2
    exit 1
fi

VERSION="${VERSION:-$(git -C "$ROOT_DIR" describe --tags --always --dirty 2>/dev/null || echo "0.1.0-dev")}"
TARGETS=("linux/amd64" "darwin/arm64" "darwin/amd64")

mkdir -p "$OUT_DIR"
: > "$OUT_DIR/SHA256SUMS"

for target in "${TARGETS[@]}"; do
    os="${target%%/*}"
    arch="${target##*/}"
    dir="$OUT_DIR/${os}-${arch}"
    mkdir -p "$dir"
    printf '[build-agent] %s/%s -> %s\n' "$os" "$arch" "$dir/backup-agent"
    (
        cd "$ROOT_DIR/agent"
        CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" "$GO" build \
            -trimpath \
            -ldflags "-s -w -X main.version=$VERSION" \
            -o "$dir/backup-agent" \
            ./cmd/backup-agent
    )
    if command -v sha256sum >/dev/null 2>&1; then
        hash="$(sha256sum "$dir/backup-agent" | awk '{print $1}')"
    else
        hash="$(shasum -a 256 "$dir/backup-agent" | awk '{print $1}')"
    fi
    printf '%s  backup-agent\n' "$hash" > "$dir/sha256"
    printf '%s  %s-%s/backup-agent\n' "$hash" "$os" "$arch" >> "$OUT_DIR/SHA256SUMS"
done

printf '[build-agent] 完成，版本 %s\n' "$VERSION"
printf '[build-agent] 清单: %s/SHA256SUMS\n' "$OUT_DIR"
cat "$OUT_DIR/SHA256SUMS"
