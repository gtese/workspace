#!/usr/bin/env bash
# 卸载服务端（默认保留数据目录与仓库；--purge 才删除）
set -euo pipefail
[[ $(id -u) -eq 0 ]] || { echo "请用 root 执行" >&2; exit 1; }
PURGE=0
[[ "${1:-}" == "--purge" ]] && PURGE=1
systemctl disable --now backup-center.service backup-mountd.service 2>/dev/null || true
rm -f /etc/systemd/system/backup-center.service /etc/systemd/system/backup-mountd.service /etc/tmpfiles.d/backup-center.conf
systemctl daemon-reload
if [[ "$PURGE" -eq 1 ]]; then
  rm -rf /opt/backup-center /etc/backup-center /var/lib/backup-center /var/log/backup-center /mnt/backup-center
  echo "已删除程序与数据（仓库目录 /data2/backup/restic 需人工确认后删除）"
else
  echo "已停止并移除服务；/opt/backup-center、/etc/backup-center、/var/lib/backup-center、/data2/backup/restic 保留"
fi
