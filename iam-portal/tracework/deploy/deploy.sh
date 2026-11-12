#!/usr/bin/env bash
# 研发工时填报与分摊系统 —— 一键部署 / 升级脚本
# 在目标服务器上以 root 执行：
#   sudo bash deploy.sh install     # 首次安装（含 nginx 与证书）
#   sudo bash deploy.sh upgrade     # 重新构建并滚动重启应用
#   sudo bash deploy.sh status      # 查看状态
#   sudo bash deploy.sh backup      # 备份数据库
#
# 前置条件：源码位于 $SRC_DIR，且 deploy/.env 已配置完成。
set -euo pipefail

APP_NAME="rnd-timesheet"
SRC_DIR="${SRC_DIR:-/opt/rnd-timesheet}"
NGINX_CONF="/etc/nginx/conf.d/man.tri.local.conf"
CERT_DIR="/etc/pki/tls/certs"
KEY_DIR="/etc/pki/tls/private"
DOMAIN="man.tri.local"

log()  { printf '\033[1;34m[deploy]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

need_root() { [ "$(id -u)" -eq 0 ] || die "请以 root 执行（sudo bash deploy.sh ...）"; }

check_env() {
  [ -f "$SRC_DIR/deploy/.env" ] || die "缺少 $SRC_DIR/deploy/.env，请先复制 .env.example 并填写"
  # 逐行解析，兼容含空格的值（如 'Group_Roots,Domain Admins'）。
  # 直接 source 会把未加引号的含空格值当成命令执行，故这里手工解析。
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    key=${line%%=*}
    val=${line#*=}
    key=$(printf '%s' "$key" | tr -d '[:space:]')
    [ -n "$key" ] || continue
    # 去掉成对的单/双引号
    case "$val" in
      \"*\") val=${val#\"}; val=${val%\"} ;;
      \'*\') val=${val#\'}; val=${val%\'} ;;
    esac
    export "$key=$val"
  done < "$SRC_DIR/deploy/.env"

  [ "${POSTGRES_PASSWORD:-}" ] || die ".env 中缺少 POSTGRES_PASSWORD"
  [ "${SESSION_SECRET:-}" ] || die ".env 中缺少 SESSION_SECRET"
  [ "${LDAP_BIND_PASSWORD:-}" ] || die ".env 中缺少 LDAP_BIND_PASSWORD"
  if [ "${#SESSION_SECRET}" -lt 32 ]; then die "SESSION_SECRET 长度必须 >= 32 字符"; fi
}

install_packages() {
  log "安装依赖包（nginx / podman-compose / openldap-clients / bind-utils）"
  dnf install -y nginx podman podman-compose openldap-clients bind-utils >/dev/null
}

install_certs() {
  log "安装 TLS 证书"
  [ -f "$SRC_DIR/deploy/certs/${DOMAIN}.crt" ] || die "缺少 deploy/certs/${DOMAIN}.crt"
  [ -f "$SRC_DIR/deploy/certs/${DOMAIN}.key" ] || die "缺少 deploy/certs/${DOMAIN}.key"

  install -m 0644 "$SRC_DIR/deploy/certs/${DOMAIN}.crt" "$CERT_DIR/${DOMAIN}.crt"
  install -m 0600 "$SRC_DIR/deploy/certs/${DOMAIN}.key" "$KEY_DIR/${DOMAIN}.key"
  chown root:root "$CERT_DIR/${DOMAIN}.crt" "$KEY_DIR/${DOMAIN}.key"

  if [ -f "$SRC_DIR/deploy/certs/tri.local_ca.crt" ]; then
    install -m 0644 "$SRC_DIR/deploy/certs/tri.local_ca.crt" "$CERT_DIR/tri.local_ca.crt"
    # 让系统信任企业根 CA，便于容器内校验与 curl 访问
    install -m 0644 "$SRC_DIR/deploy/certs/tri.local_ca.crt" /etc/pki/ca-trust/source/anchors/tri.local_ca.crt
    update-ca-trust extract
  fi

  log "校验证书与私钥是否匹配"
  crt_mod=$(openssl x509 -noout -modulus -in "$CERT_DIR/${DOMAIN}.crt" | openssl md5)
  key_mod=$(openssl rsa  -noout -modulus -in "$KEY_DIR/${DOMAIN}.key" | openssl md5)
  [ "$crt_mod" = "$key_mod" ] || die "证书与私钥不匹配"
  openssl x509 -noout -subject -dates -in "$CERT_DIR/${DOMAIN}.crt"
}

install_nginx() {
  log "配置 nginx 站点 $DOMAIN"
  install -m 0644 "$SRC_DIR/deploy/nginx-man.tri.local.conf" "$NGINX_CONF"

  # 关闭默认站点，避免 80 端口冲突
  if [ -f /etc/nginx/conf.d/default.conf ]; then
    mv /etc/nginx/conf.d/default.conf /etc/nginx/conf.d/default.conf.disabled
  fi

  nginx -t || die "nginx 配置校验失败"
  systemctl enable --now nginx >/dev/null
  systemctl reload nginx
  log "nginx 已启动"
}

build_app() {
  log "构建应用镜像（首次较慢，需要拉取基础镜像）"
  cd "$SRC_DIR"
  podman build -t "localhost/${APP_NAME}:1.0.0" -f deploy/Containerfile . \
    || die "镜像构建失败"
}

start_stack() {
  log "启动数据库与应用容器"
  cd "$SRC_DIR/deploy"
  podman-compose -f compose.yaml --env-file .env up -d || die "容器启动失败"

  log "等待应用就绪 ..."
  for i in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:3000/api/health" >/dev/null 2>&1; then
      log "应用已就绪"
      return 0
    fi
    sleep 2
  done
  warn "应用在 120 秒内未就绪，请检查日志： podman logs rnd-ts-app"
  return 1
}

setup_firewall() {
  if systemctl is-active --quiet firewalld; then
    log "开放防火墙 80/443 端口"
    firewall-cmd --permanent --add-service=http  >/dev/null || true
    firewall-cmd --permanent --add-service=https >/dev/null || true
    firewall-cmd --reload >/dev/null || true
  fi
}

selinux_allow() {
  if command -v getenforce >/dev/null && [ "$(getenforce)" != "Disabled" ]; then
    log "配置 SELinux 允许 nginx 反向代理到本机端口"
    setsebool -P httpd_can_network_connect 1 || warn "setsebool 失败，如访问 502 请手动处理"
  fi
}

autostart_containers() {
  # 让容器在宿主机重启后自动拉起
  log "生成系统服务以便开机自启"
  cat > /etc/systemd/system/${APP_NAME}.service <<UNIT
[Unit]
Description=研发工时填报与分摊系统
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=${SRC_DIR}/deploy
ExecStart=/usr/bin/podman-compose -f compose.yaml --env-file .env up -d
ExecStop=/usr/bin/podman-compose -f compose.yaml --env-file .env down
TimeoutStartSec=300

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable ${APP_NAME}.service >/dev/null
  log "已注册 ${APP_NAME}.service"
}

do_install() {
  need_root
  check_env
  install_packages
  install_certs
  selinux_allow
  build_app
  start_stack
  install_nginx
  setup_firewall
  autostart_containers

  echo
  log "==============================================="
  log " 部署完成，请访问： https://${DOMAIN}"
  log "==============================================="
  echo
  log "首次使用：用域账号登录（需在 ${LDAP_ALLOWED_GROUPS} 组内）。"
  log "登录后请在「系统管理」中为人员配置工号、薪酬与角色。"
}

do_upgrade() {
  need_root
  check_env
  build_app
  cd "$SRC_DIR/deploy"
  podman-compose -f compose.yaml --env-file .env up -d --force-recreate app
  sleep 3
  curl -fsS http://127.0.0.1:3000/api/health >/dev/null && log "升级完成，健康检查通过" || warn "健康检查未通过，请查看日志"
}

do_status() {
  echo "---- 容器 ----"
  podman ps -a --filter "name=rnd-ts" --format "{{.Names}}\t{{.Status}}\t{{.Ports}}"
  echo
  echo "---- 应用健康 ----"
  curl -fsS http://127.0.0.1:3000/api/health || echo "(无响应)"
  echo
  echo "---- nginx ----"
  systemctl is-active nginx
  echo
  echo "---- 站点探测 ----"
  curl -fsS -o /dev/null -w "https://%{remote_ip} -> HTTP %{http_code}\n" "https://${DOMAIN}/api/health" --resolve "${DOMAIN}:443:127.0.0.1" || true
}

do_backup() {
  need_root
  check_env
  local out="${1:-/var/backups/rnd-timesheet}"
  mkdir -p "$out"
  local f="$out/timesheet-$(date +%Y%m%d-%H%M%S).sql.gz"
  log "备份数据库到 $f"
  podman exec rnd-ts-db pg_dump -U "${POSTGRES_USER:-timesheet}" "${POSTGRES_DB:-timesheet}" | gzip > "$f"
  log "完成：$(du -h "$f" | cut -f1)"
  # 保留最近 30 份
  ls -1t "$out"/timesheet-*.sql.gz 2>/dev/null | tail -n +31 | xargs -r rm -f
}

case "${1:-}" in
  install) do_install ;;
  upgrade) do_upgrade ;;
  status)  do_status ;;
  backup)  do_backup "${2:-}" ;;
  *) cat <<USAGE
用法: bash deploy.sh <命令>

  install   首次安装（依赖、证书、镜像、容器、nginx、开机自启）
  upgrade   重新构建并滚动重启应用
  status    查看容器/健康/nginx 状态
  backup    备份数据库（可指定输出目录）

环境变量:
  SRC_DIR   源码目录，默认 /opt/rnd-timesheet
USAGE
  ;;
esac