#!/usr/bin/env bash
# ============================================================
# 企业应用门户（portal.tri.local）— 部署/运维脚本
# ============================================================
# 用法（在项目根目录）：
#   ./deploy/deploy.sh build     构建镜像
#   ./deploy/deploy.sh up        启动/更新容器
#   ./deploy/deploy.sh nginx     安装 nginx 站点（需 sudo）
#   ./deploy/deploy.sh update    改完 src/apps.js 后：重建镜像并重启
#   ./deploy/deploy.sh status    状态与健康检查
#   ./deploy/deploy.sh logs      查看日志
#   ./deploy/deploy.sh down      停止
#   ./deploy/deploy.sh systemd   注册开机自启（systemd 用户单元）
# ============================================================
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY="$ROOT/deploy"
COMPOSE="$DEPLOY/compose.yaml"
DOMAIN="portal.tri.local"
NGINX_CONF="/etc/nginx/conf.d/portal.tri.local.conf"

say()  { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
ok()   { printf '   \033[32m✓\033[0m %s\n' "$*"; }
die()  { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

load_env() {
  [[ -f "$DEPLOY/.env" ]] || die "缺少 $DEPLOY/.env（cp deploy/.env.example deploy/.env 后填写）"
  set -a; . "$DEPLOY/.env"; set +a
}
compose() { ( cd "$DEPLOY" && podman-compose -f compose.yaml "$@" ); }

cmd_build() {
  say "构建门户镜像"
  ( cd "$ROOT" && podman build -t localhost/tri-portal:1.0.0 -f Dockerfile . )
  ok "localhost/tri-portal:1.0.0"
}

cmd_up() {
  say "启动门户容器"
  compose up -d
  for i in $(seq 1 20); do
    if curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${HOST_PORT:-8095}/healthz 2>/dev/null | grep -q 200; then
      ok "门户已就绪"; return 0
    fi
    sleep 2
  done
  compose logs --tail 30; die "门户未在 40 秒内就绪"
}

cmd_nginx() {
  say "安装 nginx 站点 $DOMAIN"
  sudo install -m 0644 "$DEPLOY/nginx-portal.tri.local.conf" "$NGINX_CONF"
  if [[ "$(getenforce 2>/dev/null)" == "Enforcing" ]]; then
    sudo setsebool -P httpd_can_network_connect on || true
  fi
  sudo nginx -t && sudo systemctl reload nginx
  ok "nginx 已重载"
  printf '   探测 https://%s -> ' "$DOMAIN"
  curl -s --cacert "$DEPLOY/certs/tri.local_ca.crt" -o /dev/null -w '%{http_code}\n' "https://$DOMAIN/" || true
}

cmd_update() { cmd_build; cmd_up; }

cmd_status() {
  say "容器"; compose ps
  say "健康"; curl -s http://127.0.0.1:${HOST_PORT:-8095}/healthz; echo
  say "站点"; printf '   https://%s -> ' "$DOMAIN"
  curl -s --cacert "$DEPLOY/certs/tri.local_ca.crt" -o /dev/null -w '%{http_code}\n' "https://$DOMAIN/" || true
}

cmd_systemd() {
  local unit_dir="$HOME/.config/systemd/user"; mkdir -p "$unit_dir"
  cat > "$unit_dir/tri-portal.service" <<U
[Unit]
Description=企业应用门户（portal.tri.local）
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$DEPLOY
ExecStart=/usr/bin/podman-compose -f $COMPOSE up -d
ExecStop=/usr/bin/podman-compose -f $COMPOSE down

[Install]
WantedBy=default.target
U
  systemctl --user daemon-reload
  systemctl --user enable tri-portal.service >/dev/null
  loginctl enable-linger "$(id -un)" 2>/dev/null || true
  ok "tri-portal.service 已启用"
}

case "${1:-}" in
  build)  load_env; cmd_build ;;
  up)     load_env; cmd_up ;;
  nginx)  load_env; cmd_nginx ;;
  update) load_env; cmd_update ;;
  status) load_env; cmd_status ;;
  logs)   load_env; ( cd "$DEPLOY" && podman-compose -f compose.yaml logs -f --tail 100 ) ;;
  down)   load_env; compose down; ok "已停止" ;;
  systemd) load_env; cmd_systemd ;;
  *) sed -n '2,16p' "$0"; exit 1 ;;
esac
