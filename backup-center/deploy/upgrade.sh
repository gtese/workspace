#!/usr/bin/env bash
# 升级服务端代码/二进制（保留数据与配置）
set -euo pipefail
SRC="${1:-/tmp/backup-center-src}"
DIST="${2:-/tmp/backup-center-dist}"
[[ $(id -u) -eq 0 ]] || { echo "请用 root 执行" >&2; exit 1; }
backup_dir="/var/backups/backup-center/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$backup_dir"
cp -a /opt/backup-center/server "$backup_dir/server"
cp -a /opt/backup-center/dist "$backup_dir/dist" 2>/dev/null || true
systemctl stop backup-center.service
rm -rf /opt/backup-center/server/src /opt/backup-center/server/public
cp -a "$SRC/server/src" /opt/backup-center/server/src
cp -a "$SRC/server/public" /opt/backup-center/server/public
install -m 0755 "$DIST/restic/linux/amd64/restic" /opt/backup-center/bin/restic
[[ -x "$DIST/backup-mountd" ]] && install -m 0755 "$DIST/backup-mountd" /opt/backup-center/bin/backup-mountd
rm -rf /opt/backup-center/dist/agent /opt/backup-center/dist/restic
cp -a "$DIST/agent" /opt/backup-center/dist/agent
cp -a "$DIST/restic" /opt/backup-center/dist/restic
install -m 0755 "$DIST/install.sh" /opt/backup-center/dist/install.sh
chmod -R a+rX /opt/backup-center
systemctl start backup-center.service
sleep 1
curl -fsSk https://127.0.0.1:443/healthz || { echo "健康检查失败，回滚参考 $backup_dir" >&2; exit 1; }
echo "升级完成；旧版本备份在 $backup_dir"
