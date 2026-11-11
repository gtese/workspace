#!/bin/bash
# 在可写节点（opsnas 172.16.50.107）部署桌面启动器、兼容代理、共享配置和内部 CA。
# 用法:
#   sudo DSH_API_KEY='sk-...' ./deploy-desktop.sh
#   # 已部署过、只想更新脚本时（沿用现有 /etc/dsh.env 里的 key）:
#   sudo ./deploy-desktop.sh
set -euo pipefail

PREFIX="${DSH_PREFIX:-/eda/apps/deepseek}"
SRC="$(cd "$(dirname "$0")" && pwd)"
BASE_URL="${DEEPSEEK_BASE_URL:-https://chat.tri.local/api}"
KEY="${DSH_API_KEY:-}"

[ "$(id -u)" = 0 ] || { echo "请用 root 执行（sudo）" >&2; exit 1; }
[ -d "$PREFIX/lib/node_modules/@deepseek-ai/dsh" ] || {
  echo "未发现 dsh 安装：$PREFIX（先跑 install-online.sh）" >&2; exit 1;
}

# 已部署过且未显式给 key：沿用现有 key，避免误清空
if [ -z "$KEY" ] && [ -f "$PREFIX/etc/dsh.env" ]; then
  KEY="$(sed -n "s/^export DEEPSEEK_API_KEY=//p" "$PREFIX/etc/dsh.env" | tr -d "'\"")"
fi
[ -n "$KEY" ] || { echo "缺少 DSH_API_KEY（或已有 $PREFIX/etc/dsh.env）" >&2; exit 1; }

echo "== 1/5 安装启动器与兼容代理"
install -d -m 755 "$PREFIX/bin" "$PREFIX/etc" "$PREFIX/certs"
install -m 755 "$SRC/dsh-desktop" "$PREFIX/bin/dsh-desktop"
install -m 755 "$SRC/dsh-owui-shim.mjs" "$PREFIX/bin/dsh-owui-shim.mjs"

echo "== 2/5 安装内部 CA（public cert）"
install -m 644 "$SRC/../config/pki/tri-enterprise-root.pem" "$PREFIX/certs/tri-enterprise-root.pem"

echo "== 3/5 写共享配置 $PREFIX/etc/dsh.env"
umask 022
cat > "$PREFIX/etc/dsh.env" <<EOF
# DeepSeek Harness 共享配置（管理员维护）
# 模型走内网 Open WebUI；所有人共用同一个 OWUI API Key（按需轮换）
export DEEPSEEK_BASE_URL=${BASE_URL}
export DEEPSEEK_API_KEY=${KEY}
EOF
chmod 644 "$PREFIX/etc/dsh.env"

echo "== 4/5 建立 /usr/local/bin/dsh 软链"
ln -sfn "$PREFIX/bin/dsh-desktop" /usr/local/bin/dsh
chmod -R a+rX "$PREFIX/bin" "$PREFIX/etc" "$PREFIX/certs"
command -v restorecon >/dev/null 2>&1 && restorecon -R "$PREFIX" || true

echo "== 5/5 验证"
dsh --version

cat <<EOF

部署完成:
  launcher: $PREFIX/bin/dsh-desktop
  shim:     $PREFIX/bin/dsh-owui-shim.mjs
  config:   $PREFIX/etc/dsh.env (644)
  ca:       $PREFIX/certs/tri-enterprise-root.pem
  link:     /usr/local/bin/dsh -> $PREFIX/bin/dsh-desktop

其他桌面 VM 只需建软链（可反复执行）:
  sudo ./add-host-link.sh
EOF
