#!/usr/bin/env bash
# ============================================================
# 系统级安装（需要 sudo）：SELinux / 证书 / nginx / 定时任务
# 用法：sudo ./ops/install-host.sh [--check-only]
# ============================================================
# 注意：本脚本假定项目已 clone 到 $HOME/projects/oidc-work 且 deploy/certs 里已有证书。
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
: "${SUDO_USER:?请用 sudo 执行}"
OWNER_HOME="$(getent passwd "$SUDO_USER" | cut -d: -f6)"
CHECK_ONLY=""
[[ "${1:-}" == "--check-only" ]] && CHECK_ONLY=1

say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
ok()  { printf '   \033[32m✓\033[0m %s\n' "$*"; }

say "1. SELinux：允许 nginx 主动连接后端端口"
if [[ "$(getenforce)" == "Enforcing" ]]; then
  getsebool httpd_can_network_connect || true
  [[ -z "$CHECK_ONLY" ]] && setsebool -P httpd_can_network_connect on
  ok "httpd_can_network_connect = $(getsebool httpd_can_network_connect | awk '{print $3}')"
else
  ok "SELinux 非 Enforcing，跳过"
fi

say "2. 证书安装到 $PWD"
install_cert() { install -m "$2" "$1" "/etc/pki/tls/oidc/$(basename "$1")"; }
if [[ -z "$CHECK_ONLY" ]]; then
  mkdir -p /etc/pki/tls/oidc
  install -m 0644 "$ROOT/deploy/certs/tri.local_ca.crt"   /etc/pki/tls/oidc/tri.local_ca.crt
  install -m 0644 "$ROOT/deploy/certs/tri.local.crt"      /etc/pki/tls/oidc/tri.local.crt
  install -m 0600 "$ROOT/deploy/certs/tri.local.key"      /etc/pki/tls/oidc/tri.local.key
  install -m 0644 "$ROOT/deploy/certs/tri.local_ca.crt"   /etc/pki/ca-trust/source/anchors/tri.local_ca.crt
  update-ca-trust extract
fi
ok "证书就位（私钥 600）"

say "3. nginx 站点"
if [[ -z "$CHECK_ONLY" ]]; then
  install -m 0644 "$ROOT/deploy/nginx/sso.tri.local.conf" /etc/nginx/conf.d/sso.tri.local.conf
  nginx -t && systemctl reload nginx
  systemctl enable nginx >/dev/null 2>&1 || true
fi
ok "nginx 已加载 sso.tri.local"

say "4. 定时任务（备份 + 清理 + 健康巡检）"
if [[ -z "$CHECK_ONLY" ]]; then
  mkdir -p "$OWNER_HOME/oidc-backups"
  cat > /etc/cron.d/tri-oidc-backup <<CRON
SHELL=/bin/bash
PATH=/usr/local/bin:/usr/bin:/bin
30 2 * * * $SUDO_USER $ROOT/deploy/deploy.sh backup >> $OWNER_HOME/oidc-backups/backup.log 2>&1
15 3 * * * $SUDO_USER $ROOT/ops/backup-cleanup.sh >> $OWNER_HOME/oidc-backups/backup.log 2>&1
CRON
  cat > /etc/cron.d/tri-oidc-health <<CRON
SHELL=/bin/bash
PATH=/usr/local/bin:/usr/bin:/bin
*/5 * * * * $SUDO_USER $ROOT/ops/healthcheck.sh >> $OWNER_HOME/oidc-backups/health.log 2>&1
CRON
  chmod 644 /etc/cron.d/tri-oidc-backup /etc/cron.d/tri-oidc-health
fi
ok "cron.d 配置完成"

say "5. 内核与用户命名空间"
echo "user.max_user_namespaces = $(sysctl -n user.max_user_namespaces)"
grep -q "^user.max_user_namespaces" /etc/sysctl.d/99-oidc-podman.conf 2>/dev/null || \
  echo "user.max_user_namespaces = 15000" > /etc/sysctl.d/99-oidc-podman.conf
grep "$SUDO_USER" /etc/subuid && grep "$SUDO_USER" /etc/subgid
ok "rootless podman 前置条件就绪"

say "完成。后续：以 $SUDO_USER 身份执行 ./deploy/deploy.sh all <域账号> <域口令>"
