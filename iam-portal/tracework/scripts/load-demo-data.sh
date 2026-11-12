#!/usr/bin/env bash
# ============================================================
# 演示数据装载脚本
# ============================================================
# 用法（在服务器上执行）：
#   sudo bash scripts/load-demo-data.sh
#
# 作用：把一组贴近真实的 2026-10 月度数据写入数据库，用于演示与验收。
#   01_demo_base.sql      项目、人员、薪酬、考勤
#   02_demo_entries.sql   逐日工时填报（425 条明细）
#   03_demo_workflow.sql  审批流转，覆盖已通过/待审/已驳回三种状态
#
# 注意：
#   · 这三个文件**不是**数据库迁移，不会被应用启动时自动执行。
#     它们含清空业务数据的语句，只应显式手动运行。
#   · 可重复执行（幂等）。
#   · 不会修改 AD 同步来的用户身份信息，只设置业务属性。
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTAINER="${DB_CONTAINER:-rnd-ts-db}"
DB_USER="${POSTGRES_USER:-timesheet}"
DB_NAME="${POSTGRES_DB:-timesheet}"

log()  { printf '\033[1;34m[demo]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

command -v podman >/dev/null || die "未找到 podman"
podman container exists "$CONTAINER" 2>/dev/null || die "容器 $CONTAINER 不存在，请先启动系统"

run_sql() {
  local f="$1"
  [ -f "$f" ] || die "缺少文件 $f"
  log "执行 $(basename "$f") ..."
  # ON_ERROR_STOP=1：任一语句失败即中止并回滚，避免半套数据
  podman exec -i "$CONTAINER" \
    psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -q < "$f"
}

for f in "$SCRIPT_DIR/01_demo_base.sql" \
         "$SCRIPT_DIR/02_demo_entries.sql" \
         "$SCRIPT_DIR/03_demo_workflow.sql"; do
  run_sql "$f"
done

log "演示数据装载完成"
echo
log "=== 数据概览 ==="
podman exec "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -c "
SELECT
  (SELECT count(*) FROM projects)                              AS 项目数,
  (SELECT count(*) FROM users WHERE monthly_salary > 0)        AS 有薪酬人员,
  (SELECT count(*) FROM time_entries)                          AS 工时明细,
  (SELECT count(*) FROM timesheets)                            AS 工时单,
  (SELECT count(*) FROM approvals)                             AS 审批单;"

podman exec "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -c "
SELECT status AS 工时单状态, count(*) AS 人数
  FROM timesheets WHERE period = '2026-10'
 GROUP BY status ORDER BY 2 DESC;"

echo
log "打开 https://man.tri.local 查看效果"