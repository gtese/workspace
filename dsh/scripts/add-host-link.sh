#!/bin/bash
# 在每一台 Rocky 8 桌面 VM 上建立 /usr/local/bin/dsh 软链（一次性，可重复执行）。
# 启动器、兼容代理、共享配置都在共享 NFS 上，更新只需在 opsnas 上做。
set -euo pipefail

PREFIX="${DSH_PREFIX:-/eda/apps/deepseek}"
TARGET="$PREFIX/bin/dsh-desktop"

[ "$(id -u)" = 0 ] || { echo "请用 root 执行（sudo）" >&2; exit 1; }
[ -x "$TARGET" ] || { echo "找不到可执行的 $TARGET（检查 /eda/apps 挂载）" >&2; exit 1; }

ln -sfn "$TARGET" /usr/local/bin/dsh
echo "已建立: /usr/local/bin/dsh -> $TARGET"
dsh --version
