#!/usr/bin/env bash
# 在 172.16.50.150 上以 root 执行：安装 backup-center 服务端。
# 前置：先把项目源码与二进制分发目录拷到本机：
#   rsync -av ~/deepseek/workspace/backup-center/ root@172.16.50.150:/tmp/backup-center-src/
#   rsync -av ~/deepseek/workspace/backup-center/deploy/dist/ root@172.16.50.150:/tmp/backup-center-dist/
set -euo pipefail

SRC="/tmp/backup-center-src"
DIST="/tmp/backup-center-dist"
HOSTNAME_="backup.tri.local"
WEB_PORT=443
AGENT_PORT=8443
REPO_PATH="/data2/backup/restic"
CERT=""
KEY=""
NODE_BIN=""
SKIP_START=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --src) SRC="$2"; shift 2 ;;
    --dist) DIST="$2"; shift 2 ;;
    --hostname) HOSTNAME_="$2"; shift 2 ;;
    --web-port) WEB_PORT="$2"; shift 2 ;;
    --agent-port) AGENT_PORT="$2"; shift 2 ;;
    --repo) REPO_PATH="$2"; shift 2 ;;
    --cert) CERT="$2"; shift 2 ;;
    --key) KEY="$2"; shift 2 ;;
    --node) NODE_BIN="$2"; shift 2 ;;
    --skip-start) SKIP_START=1; shift ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

[[ $(id -u) -eq 0 ]] || { echo "请用 root 执行" >&2; exit 1; }
[[ -d "$SRC/server/src" ]] || { echo "缺少源码目录：$SRC/server/src" >&2; exit 1; }
[[ -x "$DIST/restic/linux/amd64/restic" ]] || { echo "缺少 restic：$DIST/restic/linux/amd64/restic" >&2; exit 1; }

log() { printf '[install] %s\n' "$*"; }

# 1. 用户与目录
if ! id backup >/dev/null 2>&1; then
  useradd -r -m -d /var/lib/backup-center -s /sbin/nologin backup
  log "已创建系统用户 backup"
fi
install -d -m 0700 -o backup -g backup /var/lib/backup-center /var/log/backup-center
install -d -m 0700 -o backup -g backup "$REPO_PATH"
install -d -m 0755 /mnt/backup-center /opt/backup-center /etc/backup-center
install -d -m 0700 -o backup -g backup /etc/backup-center /etc/backup-center/tls /etc/backup-center/storage /run/backup-center
install -d -m 0755 /opt/backup-center/bin /opt/backup-center/dist /opt/backup-center/server

# 2. Node 运行时
if [[ -z "$NODE_BIN" ]]; then
  if [[ -x /eda/apps/deepseek/bin/node ]]; then NODE_BIN=/eda/apps/deepseek/bin/node
  elif [[ -x "$SRC/server/dev/bin/node" ]]; then NODE_BIN="$SRC/server/dev/bin/node"
  else echo "找不到 node 二进制，请用 --node 指定" >&2; exit 1; fi
fi
install -m 0755 "$NODE_BIN" /opt/backup-center/bin/node

# 3. 服务端代码与静态资源
rm -rf /opt/backup-center/server/src
cp -a "$SRC/server/src" /opt/backup-center/server/src
rm -rf /opt/backup-center/server/public
cp -a "$SRC/server/public" /opt/backup-center/server/public
chown -R root:root /opt/backup-center/server
chmod -R a+rX /opt/backup-center/server

# 4. 二进制
install -m 0755 "$DIST/restic/linux/amd64/restic" /opt/backup-center/bin/restic
[[ -x "$DIST/rclone/linux/amd64/rclone" ]] && install -m 0755 "$DIST/rclone/linux/amd64/rclone" /opt/backup-center/bin/rclone
[[ -x "$DIST/backup-mountd" ]] && install -m 0755 "$DIST/backup-mountd" /opt/backup-center/bin/backup-mountd

# 5. 代理分发（install.sh + agent + restic）
install -m 0755 "$DIST/install.sh" /opt/backup-center/dist/install.sh
rm -rf /opt/backup-center/dist/agent /opt/backup-center/dist/restic
cp -a "$DIST/agent" /opt/backup-center/dist/agent
cp -a "$DIST/restic" /opt/backup-center/dist/restic
chmod -R a+rX /opt/backup-center/dist
# 供未信任企业根 CA 的客户端下载（/agent/ca.crt）
if [[ -f /etc/pki/ca-trust/source/anchors/tri-local-enterprise-root-ca.crt ]]; then
  install -m 0644 /etc/pki/ca-trust/source/anchors/tri-local-enterprise-root-ca.crt /opt/backup-center/dist/ca.crt
fi

# 6. TLS 证书
if [[ -n "$CERT" && -n "$KEY" ]]; then
  install -m 0644 -o root -g backup "$CERT" /etc/backup-center/tls/server.crt
  install -m 0640 -o root -g backup "$KEY" /etc/backup-center/tls/server.key
  log "已安装证书：$CERT"
else
  log "未提供证书，生成本机自签证书（仅测试用）"
  openssl ecparam -name prime256v1 -genkey -noout -out /etc/backup-center/tls/server.key
  openssl req -x509 -new -key /etc/backup-center/tls/server.key -sha256 -days 365 \
    -subj "/CN=$HOSTNAME_" -out /etc/backup-center/tls/server.crt
  chown root:backup /etc/backup-center/tls/server.key /etc/backup-center/tls/server.crt
  chmod 0640 /etc/backup-center/tls/server.key
  chmod 0644 /etc/backup-center/tls/server.crt
fi

# 7. 配置
cat > /etc/backup-center/config.json <<JSON
{
  "tls": { "enabled": true, "cert": "/etc/backup-center/tls/server.crt", "key": "/etc/backup-center/tls/server.key" },
  "web": { "host": "0.0.0.0", "port": ${WEB_PORT} },
  "agent": { "host": "0.0.0.0", "port": ${AGENT_PORT} },
  "paths": {
    "data": "/var/lib/backup-center",
    "repos": "${REPO_PATH}",
    "log": "/var/log/backup-center",
    "storage": "/mnt/backup-center",
    "dist": "/opt/backup-center/dist"
  },
  "db": { "path": "/var/lib/backup-center/backup.db" },
  "restic": { "binary": "/opt/backup-center/bin/restic", "cache_dir": "/var/lib/backup-center/restic-cache" },
  "server": { "hostname": "${HOSTNAME_}", "public_url": "https://${HOSTNAME_}", "agent_url": "https://${HOSTNAME_}:${AGENT_PORT}" },
  "mountd": { "enabled": true, "socket": "/run/backup-center/mountd.sock" },
  "oidc": { "enabled": false, "issuer": "https://sso.tri.local/realms/tri", "client_id": "backup-center", "client_secret": "", "redirect_uri": "https://${HOSTNAME_}/auth/oidc/callback", "post_logout_uri": "https://${HOSTNAME_}/", "ca_file": "/etc/pki/ca-trust/source/anchors/tri-local-enterprise-root-ca.crt" },
  "smtp": { "enabled": false },
  "logging": { "level": "info" }
}
JSON
chown root:backup /etc/backup-center/config.json
chmod 0640 /etc/backup-center/config.json

# 8. systemd
install -m 0644 "$SRC/deploy/systemd/backup-center.service" /etc/systemd/system/backup-center.service
install -m 0644 "$SRC/deploy/systemd/backup-mountd.service" /etc/systemd/system/backup-mountd.service
install -m 0644 "$SRC/deploy/systemd/backup-center.tmpfiles" /etc/tmpfiles.d/backup-center.conf
systemd-tmpfiles --create /etc/tmpfiles.d/backup-center.conf
systemctl daemon-reload
systemctl enable backup-mountd.service backup-center.service >/dev/null

if [[ "$SKIP_START" -eq 0 ]]; then
  systemctl restart backup-mountd.service
  systemctl restart backup-center.service
  sleep 2
  if curl -fsSk "https://127.0.0.1:${WEB_PORT}/healthz" >/dev/null 2>&1; then
    log "服务已启动：https://${HOSTNAME_}"
  else
    log "健康检查失败，请查看：journalctl -u backup-center -n 100 --no-pager"
  fi
fi

if [[ -f /var/lib/backup-center/initial-admin.txt ]]; then
  log "初始管理员密码文件：/var/lib/backup-center/initial-admin.txt（首次登录后请修改并删除）"
fi
log "安装完成。节点接入请登录 Web 控制台生成一次性 token。"
