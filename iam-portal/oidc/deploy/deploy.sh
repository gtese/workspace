#!/usr/bin/env bash
# ============================================================
# 企业统一身份平台（Keycloak）— 部署脚本
# ============================================================
# 用法（在项目根目录执行）：
#   ./deploy/deploy.sh all           # 一键：构建镜像 → 起服务 → 装 nginx → 配置 realm → 验收
#   ./deploy/deploy.sh build         # 只构建 Keycloak 运行时镜像（含企业根 CA）
#   ./deploy/deploy.sh up            # 起/更新容器
#   ./deploy/deploy.sh nginx         # 安装 sso.tri.local 反代站点
#   ./deploy/deploy.sh provision     # 配置 realm（幂等，可重复执行）
#   ./deploy/deploy.sh sync-groups   # 只刷新 AD 组成员关系（改角色模型后必跑）
#   ./deploy/deploy.sh verify [用户名] [密码]   # 端到端验收
#   ./deploy/deploy.sh status        # 状态与健康检查
#   ./deploy/deploy.sh logs [服务]   # 跟进日志
#   ./deploy/deploy.sh backup        # 备份数据库
#   ./deploy/deploy.sh down          # 停止服务（保留数据卷）
#
# 前置条件：
#   - rootless podman（volumes/网络走用户命名空间）+ podman-compose
#   - 用户 linyiyao 有 sudo（安装 nginx、证书、systemd 用户单元）
#   - deploy/.env 已按 .env.example 填好
# ============================================================
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY="$ROOT/deploy"
COMPOSE="$DEPLOY/compose.yaml"
DOMAIN="sso.tri.local"
CERT_DIR="/etc/pki/tls/oidc"
NGINX_CONF="/etc/nginx/conf.d/sso.tri.local.conf"
BACKUP_DIR="$HOME/oidc-backups"

say()  { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
ok()   { printf '   \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '   \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

load_env() {
  [[ -f "$DEPLOY/.env" ]] || die "缺少 $DEPLOY/.env（cp deploy/.env.example deploy/.env 后填写）"
  set -a; . "$DEPLOY/.env"; set +a
  : "${POSTGRES_PASSWORD:?需在 .env 设置}" "${LDAP_BIND_PASSWORD:?需在 .env 设置}"
  : "${KC_BOOTSTRAP_ADMIN_USERNAME:?}" "${KC_BOOTSTRAP_ADMIN_PASSWORD:?}"
  export KC_ADMIN_USER="$KC_BOOTSTRAP_ADMIN_USERNAME"
  export KC_ADMIN_PASSWORD="$KC_BOOTSTRAP_ADMIN_PASSWORD"
  export KC_BASE_URL="https://$DOMAIN"
  export KC_REALM="${KC_REALM:-tri}"
}

compose() { ( cd "$DEPLOY" && podman-compose -f compose.yaml "$@" ); }

# ---------------------------------------------------------------- 步骤
cmd_build() {
  say "1/6 构建 Keycloak 运行时镜像（内置企业根 CA）"
  [[ -f "$DEPLOY/certs/tri.local_ca.crt" ]] || die "缺少 deploy/certs/tri.local_ca.crt"
  # 构建上下文用 deploy/certs（含企业根 CA）；Dockerfile 只 COPY 该目录下的证书。
  # 镜像内已执行 `kc.sh build`（预构建），因此 compose 可以直接 `start --optimized`。
  podman build -f "$ROOT/docker/keycloak/Containerfile" \
      -t localhost/tri-oidc-keycloak:1.0.0 \
      --build-arg KEYCLOAK_IMAGE="${KEYCLOAK_IMAGE:-docker.1panel.live/keycloak/keycloak:26.8.1}" \
      "$DEPLOY/certs"
  ok "镜像 localhost/tri-oidc-keycloak:1.0.0"
}

cmd_up() {
  say "2/6 启动服务（PostgreSQL + Keycloak × 2）"
  compose up -d
  say "等待 Keycloak 就绪（首次启动约 60~120 秒）"
  for i in $(seq 1 60); do
    if curl -sk -o /dev/null -w '%{http_code}' http://127.0.0.1:19000/health/ready 2>/dev/null | grep -q 200; then
      ok "kc-1 就绪"; break
    fi
    sleep 3
    [[ $i -eq 60 ]] && { compose logs --tail 40 kc-1; die "Keycloak 未在 3 分钟内就绪"; }
  done
  curl -sk -o /dev/null -w '' http://127.0.0.1:19001/health/ready 2>/dev/null || true
  ok "容器状态：" && compose ps
}

cmd_nginx() {
  say "3/6 安装 nginx 站点 $DOMAIN（TLS 终止 + 反代）"
  [[ -f "$CERT_DIR/tri.local.crt" ]] || die "缺少证书 $CERT_DIR/tri.local.crt"
  # SELinux（Rocky 8 默认 Enforcing）：nginx 不允许主动连接其他端口，
  # 不加这条会得到 502 + 日志 "connect() to 127.0.0.1:18080 failed (13: Permission denied)"
  if command -v getenforce >/dev/null && [[ "$(getenforce)" == "Enforcing" ]]; then
    sudo setsebool -P httpd_can_network_connect on
    ok "SELinux：httpd_can_network_connect=on"
  fi
  sudo install -m 0644 "$DEPLOY/nginx/sso.tri.local.conf" "$NGINX_CONF"
  sudo nginx -t
  sudo systemctl reload nginx
  sudo systemctl enable nginx >/dev/null 2>&1 || true
  ok "nginx 已重载"
  # 自检：经 nginx 访问 OIDC discovery（issuer 必须是对外域名）
  printf '   discovery -> '
  curl -s --cacert "$DEPLOY/certs/tri.local_ca.crt" -o /dev/null -w '%{http_code}\n' \
    "https://$DOMAIN/realms/master/.well-known/openid-configuration" || true
}

ensure_admin() {
  # Keycloak 26.x 的 bootstrap-admin 需要独占 HTTP/管理端口，
  # 因此在独立容器里执行（不占用正在运行的实例端口）。
  if python3 "$DEPLOY/scripts/configure.py" verify-admin >/dev/null 2>&1; then
    return 0
  fi
  [[ -n "${KC_BOOTSTRAP_ADMIN_PASSWORD:-}" ]] || die "管理员登录失败且 .env 中无 KC_BOOTSTRAP_ADMIN_PASSWORD"
  say "创建引导管理员 $KC_BOOTSTRAP_ADMIN_USERNAME"
  podman run --rm --network oidc --userns=keep-id \
    -e KC_DB=postgres \
    -e KC_DB_URL="jdbc:postgresql://${PGHOST:-db}:5432/${POSTGRES_DB:-keycloak}" \
    -e KC_DB_USERNAME="${POSTGRES_USER:-keycloak}" \
    -e KC_DB_PASSWORD="$POSTGRES_PASSWORD" \
    -e KC_BOOTSTRAP_ADMIN_PASSWORD="$KC_BOOTSTRAP_ADMIN_PASSWORD" \
    -e KC_HTTP_PORT=28080 -e KC_HTTP_MANAGEMENT_PORT=29000 \
    localhost/tri-oidc-keycloak:1.0.0 bootstrap-admin user --no-prompt --optimized \
      --username "$KC_BOOTSTRAP_ADMIN_USERNAME" --password:env KC_BOOTSTRAP_ADMIN_PASSWORD
  ok "管理员已创建（首次登录后请在控制台修改密码）"
}

cmd_sync_groups() {
  say "重新物化 AD 组成员关系（切换角色模型后必跑）"
  python3 "$DEPLOY/scripts/configure.py" sync-groups
  ok "组成员关系已刷新；受影响用户需重新登录才能看到新角色"
}

cmd_provision() {
  say "4/6 配置 realm（AD 联邦 / 组→角色 / client / 审计）"
  ensure_admin
  python3 "$DEPLOY/scripts/configure.py" apply
  ok "realm 配置完成"
}

cmd_verify() {
  say "5/6 端到端验收"
  local user="${1:-${VERIFY_USER:-}}"
  local pass="${2:-${VERIFY_PASSWORD:-}}"
  if [[ -z "$user" || -z "$pass" ]]; then
    warn "未提供账号，跳过 OIDC 端到端验收（可：./deploy/deploy.sh verify <域账号> <密码>）"
  else
    python3 "$DEPLOY/scripts/verify-oidc.py" "$user" "$pass"
  fi
  python3 "$DEPLOY/scripts/configure.py" verify
}

cmd_systemd() {
  say "6/6 注册开机自启（systemd 用户单元）"
  local unit_dir="$HOME/.config/systemd/user"
  mkdir -p "$unit_dir"
  cat > "$unit_dir/tri-oidc.service" <<EOF
[Unit]
Description=TRI 统一身份平台（Keycloak）
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$DEPLOY
ExecStart=/usr/bin/podman-compose -f $COMPOSE up -d
ExecStop=/usr/bin/podman-compose -f $COMPOSE down
TimeoutStartSec=300

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable tri-oidc.service >/dev/null
  loginctl enable-linger "$(id -un)" 2>/dev/null || true
  ok "tri-oidc.service 已启用（开机自启，无需登录）"
}

cmd_status() {
  say "服务状态"
  compose ps
  say "健康检查"
  for p in 19000 19001; do
    printf '   127.0.0.1:%s/health/ready  ->  ' "$p"
    curl -sk -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:$p/health/ready" || echo "不可达"
  done
  printf '   https://%s/realms/tri/.well-known/openid-configuration  ->  ' "$DOMAIN"
  curl -s --cacert "$DEPLOY/certs/tri.local_ca.crt" -o /dev/null -w '%{http_code}\n' \
    "https://$DOMAIN/realms/tri/.well-known/openid-configuration" || echo "不可达"
  say "集群成员"
  compose logs --tail 0 kc-1 2>/dev/null | grep -i "cluster" | tail -3 || true
}

cmd_logs() { compose logs -f --tail 100 "${1:-}"; }

cmd_backup() {
  say "备份 Keycloak 数据库"
  mkdir -p "$BACKUP_DIR"
  local f="$BACKUP_DIR/keycloak-$(date +%Y%m%d-%H%M%S).sql.gz"
  ( cd "$DEPLOY" && podman-compose -f compose.yaml exec -T db \
      sh -c "pg_dump -U '${POSTGRES_USER:-keycloak}' '${POSTGRES_DB:-keycloak}'" ) | gzip > "$f"
  chmod 600 "$f"
  ok "已备份：$f（$(du -h "$f" | cut -f1)）"
}

cmd_down() { say "停止服务（数据卷保留）"; compose down; ok "已停止"; }

cmd_all() {
  load_env
  cmd_build
  cmd_up
  cmd_nginx
  cmd_provision
  cmd_verify "${1:-}" "${2:-}"
  cmd_systemd
  say "部署完成：https://$DOMAIN"
}

# ---------------------------------------------------------------- 入口
case "${1:-}" in
  all)       shift; cmd_all "$@" ;;
  build)     load_env; cmd_build ;;
  up)        load_env; cmd_up ;;
  nginx)     load_env; cmd_nginx ;;
  provision) load_env; cmd_provision ;;
  verify)    load_env; cmd_verify "${2:-}" "${3:-}" ;;
  systemd)   load_env; cmd_systemd ;;
  status)    load_env; cmd_status ;;
  logs)      load_env; cmd_logs "${2:-}" ;;
  backup)    load_env; cmd_backup ;;
  down)      load_env; cmd_down ;;
  *) sed -n '2,30p' "$0"; exit 1 ;;
esac