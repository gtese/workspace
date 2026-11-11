#!/bin/bash
# 在线安装 DeepSeek Harness 到共享 NFS 目录 /eda/apps/deepseek
# 适用: Rocky Linux 8 x86_64（在可写节点上以 root 执行，如 opsnas 172.16.50.107）
#
# 前置条件（防火墙/代理临时放行）:
#   nodejs.org         下载 Node.js 官方 linux-x64 tar.gz
#   registry.npmjs.org 安装 @deepseek-ai/dsh 及其依赖
# 如公司有内部 npm 代理，可设置 NPM_REGISTRY 指向内部源，省掉 registry 放行。
#
# 用法:
#   sudo ./install-online.sh
#   sudo DSH_VERSION=0.2.2-rc.1 NODE_VERSION=24.18.1 ./install-online.sh

set -euo pipefail

PREFIX="${DSH_PREFIX:-/eda/apps/deepseek}"
DSH_VERSION="${DSH_VERSION:-0.2.2-rc.1}"
NODE_VERSION="${NODE_VERSION:-24.18.1}"
PNPM_VERSION="${PNPM_VERSION:-11}"
NPM_REGISTRY="${NPM_REGISTRY:-}"

[ "$(id -u)" = 0 ] || { echo "请用 root 执行（sudo）" >&2; exit 1; }
[ "$(uname -m)" = "x86_64" ] || { echo "本脚本按 x86_64 编写" >&2; exit 1; }

echo "== 1/5 系统依赖（走内部源）"
dnf -y install tar gzip curl ca-certificates

echo "== 2/5 安装 Node.js v${NODE_VERSION} 到 ${PREFIX}"
mkdir -p "$PREFIX"
TMP_NODE="$(mktemp /tmp/node.XXXXXX.tar.gz)"
trap 'rm -f "$TMP_NODE"' EXIT
curl -fsSL -o "$TMP_NODE" \
  "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.gz"
tar -xzf "$TMP_NODE" -C "$PREFIX" --strip-components=1

echo "== 3/5 安装 @deepseek-ai/dsh@${DSH_VERSION} 与 pnpm@${PNPM_VERSION}"
export PATH="$PREFIX/bin:$PATH"
if [ -n "$NPM_REGISTRY" ]; then
  npm install -g --prefix "$PREFIX" --registry "$NPM_REGISTRY" --no-audit --no-fund \
    "@deepseek-ai/dsh@${DSH_VERSION}" "pnpm@${PNPM_VERSION}"
else
  npm install -g --prefix "$PREFIX" --no-audit --no-fund \
    "@deepseek-ai/dsh@${DSH_VERSION}" "pnpm@${PNPM_VERSION}"
fi

echo "== 4/5 权限（所有用户可读可执行）"
chmod -R a+rX "$PREFIX"

echo "== 5/5 验证"
"$PREFIX/bin/dsh" --version
"$PREFIX/bin/node" -v

cat <<EOF

安装完成: $PREFIX
  Node:   $PREFIX/bin/node
  dsh:    $PREFIX/bin/dsh
  pnpm:   $PREFIX/bin/pnpm

下一步:
  1) 部署启动器/共享配置/证书: sudo ./deploy-desktop.sh
  2) 每台桌面 VM 建软链:       sudo ./add-host-link.sh
EOF
