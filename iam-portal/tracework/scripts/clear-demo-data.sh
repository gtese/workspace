#!/usr/bin/env bash
# ============================================================
# 清除演示/测试数据
# ============================================================
# 用途：把系统恢复为「干净可用」状态，准备录入真实数据。
#
# 用法（在服务器上执行）：
#   sudo bash scripts/clear-demo-data.sh            # 执行清理（自动先备份）
#   sudo bash scripts/clear-demo-data.sh --no-backup # 不备份直接清理
#   sudo bash scripts/clear-demo-data.sh --dry-run   # 只看将删除多少数据
#
# 删除：工时明细、工时单、审批、考勤、费用、台账、快照、文档记录、
#       全部项目、公司档案
# 保留：AD 用户、节假日日历、IT 资产、审计日志
#
# 同时清除员工上的演示属性：月薪、工号、标准考勤工时、研发类型
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SQL="$SCRIPT_DIR/clear-demo-data.sql"
CONTAINER="${DB_CONTAINER:-rnd-ts-db}"
DB_USER="${POSTGRES_USER:-timesheet}"
DB_NAME="${POSTGRES_DB:-timesheet}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/tracework}"

log()  { printf '\033[1;34m[clear]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

[ -f "$SQL" ] || die "缺少 $SQL"
podman container exists "$CONTAINER" 2>/dev/null || die "容器 $CONTAINER 不存在"

q() { podman exec "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc "$1" 2>/dev/null | tr -d ' '; }

# ------------------------------------------------------------
# 显示将删除的数据量
# ------------------------------------------------------------
log "当前数据量："
podman exec "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -c "
SELECT '工时明细' AS 表, count(*) AS 行数 FROM time_entries
UNION ALL SELECT '工时单', count(*) FROM timesheets
UNION ALL SELECT '审批单', count(*) FROM approvals
UNION ALL SELECT '考勤', count(*) FROM attendance
UNION ALL SELECT '费用明细', count(*) FROM cost_entries
UNION ALL SELECT '备查台账', count(*) FROM ledger_rows
UNION ALL SELECT '项目', count(*) FROM projects;"

if [ "${1:-}" = "--dry-run" ]; then
  log "（--dry-run 模式，未做任何修改）"
  exit 0
fi

# ------------------------------------------------------------
# 备份
# ------------------------------------------------------------
if [ "${1:-}" != "--no-backup" ]; then
  mkdir -p "$BACKUP_DIR"
  F="$BACKUP_DIR/pre-clear-$(date +%Y%m%d-%H%M%S).sql.gz"
  log "备份数据库到 $F ..."
  podman exec "$CONTAINER" pg_dump -U "$DB_USER" "$DB_NAME" | gzip > "$F"
  log "备份完成：$(du -h "$F" | cut -f1)"
else
  warn "跳过备份（--no-backup）"
fi

# ------------------------------------------------------------
# 执行清理
# ------------------------------------------------------------
log "执行清理 ..."
podman exec -i "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -q < "$SQL"

log "清理完成，当前状态："
podman exec "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -c "
SELECT 'AD用户' AS 项, count(*)::text AS 数量 FROM users
UNION ALL SELECT '节假日日历', count(*)::text FROM calendar_days
UNION ALL SELECT 'IT资产', count(*)::text FROM assets
UNION ALL SELECT '项目', count(*)::text FROM projects
UNION ALL SELECT '工时明细', count(*)::text FROM time_entries
UNION ALL SELECT '有月薪的人', count(*)::text FROM users WHERE monthly_salary > 0
UNION ALL SELECT '有工号的人', count(*)::text FROM users WHERE employee_no IS NOT NULL;"
