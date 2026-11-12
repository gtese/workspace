#!/usr/bin/env bash
# 删除 30 天前的 Keycloak 备份（由 /etc/cron.d/tri-oidc-backup 调用）
set -u
DIR="${OIDC_BACKUP_DIR:-$HOME/oidc-backups}"
find "$DIR" -name 'keycloak-*.sql.gz' -mtime +30 -print -delete 2>/dev/null || true
