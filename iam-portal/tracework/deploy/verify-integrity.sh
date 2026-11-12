#!/usr/bin/env bash
# ============================================================
# 数据完整性审计
# ============================================================
# 检查项：
#   1. 孤儿数据（引用了不存在的记录）
#   2. 汇总值与实际明细不一致
#   3. 必填字段为空
#   4. 状态与数据矛盾（如已通过但无审批记录）
#   5. AD 同步状态一致性
#   6. 序列/约束可用性
#
# 用法：sudo bash /opt/rnd-timesheet/deploy/verify-integrity.sh
# 退出码：0 = 全部通过；1 = 存在问题
# ============================================================
set -uo pipefail

SCRIPT_DIR="${SCRIPT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
# shellcheck source=lib/auth.sh
source "$SCRIPT_DIR/lib/auth.sh"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad() { FAIL=$((FAIL+1)); printf '  \033[31m✗\033[0m %s\n' "$*"; }
step(){ printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
q()   { podman exec rnd-ts-db psql -U timesheet -d timesheet -tAc "$1" 2>/dev/null | tr -d ' '; }
qt()  { podman exec rnd-ts-db psql -U timesheet -d timesheet -c "$1" 2>/dev/null; }

# 断言某查询结果为 0
assert_zero() {
  local name="$1" sql="$2"
  local n; n=$(q "$sql")
  if [ "$n" = "0" ]; then ok "$name"; else bad "$name（发现 $n 条）"; fi
}

step "1. 孤儿数据检查（引用完整性）"
assert_zero "审批单 → 工时单" "SELECT count(*) FROM approvals a WHERE NOT EXISTS(SELECT 1 FROM timesheets t WHERE t.id=a.timesheet_id)"
assert_zero "审批单 → 项目"   "SELECT count(*) FROM approvals a WHERE NOT EXISTS(SELECT 1 FROM projects p WHERE p.id=a.project_id)"
assert_zero "审批单 → 用户"   "SELECT count(*) FROM approvals a WHERE NOT EXISTS(SELECT 1 FROM users u WHERE u.id=a.user_id)"
assert_zero "工时明细 → 项目" "SELECT count(*) FROM time_entries e WHERE NOT EXISTS(SELECT 1 FROM projects p WHERE p.id=e.project_id)"
assert_zero "工时明细 → 用户" "SELECT count(*) FROM time_entries e WHERE NOT EXISTS(SELECT 1 FROM users u WHERE u.id=e.user_id)"
assert_zero "费用明细 → 项目" "SELECT count(*) FROM cost_entries c WHERE c.project_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM projects p WHERE p.id=c.project_id)"
assert_zero "项目审批人 → 用户" "SELECT count(*) FROM project_approvers pa WHERE NOT EXISTS(SELECT 1 FROM users u WHERE u.id=pa.user_id)"
assert_zero "项目成员 → 用户"   "SELECT count(*) FROM project_members pm WHERE NOT EXISTS(SELECT 1 FROM users u WHERE u.id=pm.user_id)"
assert_zero "台账 → 项目"       "SELECT count(*) FROM ledger_rows l WHERE l.project_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM projects p WHERE p.id=l.project_id)"
assert_zero "委外合同 → 项目"   "SELECT count(*) FROM outsource_contracts o WHERE o.project_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM projects p WHERE p.id=o.project_id)"

step "2. 汇总值与明细一致性"
assert_zero "工时单合计 = 工时明细合计" "
  SELECT count(*) FROM timesheets t
   WHERE abs(t.total_hours - COALESCE((SELECT sum(e.hours) FROM time_entries e
           WHERE e.user_id=t.user_id AND to_char(e.work_date,'YYYY-MM')=t.period),0)) > 0.01"
assert_zero "工时单研发+非研发 = 合计" "
  SELECT count(*) FROM timesheets
   WHERE abs((rnd_hours + non_rnd_hours) - total_hours) > 0.01"

step "3. 必填字段检查"
assert_zero "用户名为空"     "SELECT count(*) FROM users WHERE username IS NULL OR trim(username)=''"
assert_zero "项目号为空"     "SELECT count(*) FROM projects WHERE trim(code)=''"
assert_zero "项目名为空"     "SELECT count(*) FROM projects WHERE trim(name)=''"
assert_zero "工时明细工时为负" "SELECT count(*) FROM time_entries WHERE hours <= 0"
assert_zero "费用明细金额为负(异常)" "SELECT count(*) FROM cost_entries WHERE amount < 0"

step "4. 状态与数据矛盾"
assert_zero "已通过工时单却无审批记录" "
  SELECT count(*) FROM timesheets t WHERE t.status='approved'
   AND NOT EXISTS(SELECT 1 FROM approvals a WHERE a.timesheet_id=t.id)"
assert_zero "已提交工时单却无审批记录" "
  SELECT count(*) FROM timesheets t WHERE t.status='submitted'
   AND NOT EXISTS(SELECT 1 FROM approvals a WHERE a.timesheet_id=t.id AND a.status='pending')"
assert_zero "审批单已通过但无处理人" "
  SELECT count(*) FROM approvals WHERE status IN ('approved','rejected') AND approver_id IS NULL"

step "5. AD 同步状态一致性"
assert_zero "ad_status 与 is_active 矛盾（active 却禁用）" "
  SELECT count(*) FROM users WHERE ad_status='active' AND is_active=FALSE"
assert_zero "ad_status 与 is_active 矛盾（deleted 却启用）" "
  SELECT count(*) FROM users WHERE ad_status IN ('deleted','disabled') AND is_active=TRUE"
assert_zero "已删除/禁用用户仍在项目审批人中" "
  SELECT count(*) FROM project_approvers pa JOIN users u ON u.id=pa.user_id
   WHERE u.ad_status IN ('deleted','disabled') OR u.is_active=FALSE"
assert_zero "已删除/禁用用户仍在项目成员中" "
  SELECT count(*) FROM project_members pm JOIN users u ON u.id=pm.user_id
   WHERE u.ad_status IN ('deleted','disabled') OR u.is_active=FALSE"

step "6. 数据覆盖率统计（非断言，仅供参考）"
qt "
SELECT
  (SELECT count(*) FROM users WHERE is_active)                       AS 在职用户,
  (SELECT count(*) FROM projects WHERE is_active)                    AS 启用项目,
  (SELECT count(*) FROM projects p WHERE p.is_active
     AND NOT EXISTS(SELECT 1 FROM project_approvers pa WHERE pa.project_id=p.id)) AS 无审批人项目,
  (SELECT count(*) FROM time_entries)                                AS 工时明细,
  (SELECT count(*) FROM cost_entries)                                AS 费用明细,
  (SELECT count(*) FROM ledger_rows)                                 AS 台账行,
  (SELECT count(*) FROM attendance)                                  AS 考勤记录;"

step "6b. IT 资产数据一致性"
assert_zero "资产使用人 → 不存在的用户" "
  SELECT count(*) FROM assets a WHERE a.holder_id IS NOT NULL
   AND NOT EXISTS(SELECT 1 FROM users u WHERE u.id=a.holder_id)"
assert_zero "使用人与外部借用方同时存在" "
  SELECT count(*) FROM assets WHERE holder_id IS NOT NULL AND borrower_external IS NOT NULL"
assert_zero "状态为「在用」但无使用人" "
  SELECT count(*) FROM assets WHERE status='在用' AND holder_id IS NULL AND borrower_external IS NULL"
assert_zero "有使用人但状态为「在库」" "
  SELECT count(*) FROM assets
   WHERE status='在库' AND (holder_id IS NOT NULL OR borrower_external IS NOT NULL)"
assert_zero "借用记录 → 不存在的资产" "
  SELECT count(*) FROM asset_assignments aa
   WHERE NOT EXISTS(SELECT 1 FROM assets a WHERE a.id=aa.asset_id)"
assert_zero "同一资产存在多条未归还记录" "
  SELECT count(*) FROM (
    SELECT asset_id FROM asset_assignments WHERE returned_at IS NULL
     GROUP BY asset_id HAVING count(*) > 1) t"
assert_zero "空资产编号" "SELECT count(*) FROM assets WHERE trim(asset_no)=''"
qt "
SELECT
  (SELECT count(*) FROM assets)                                        AS 资产总数,
  (SELECT count(*) FROM assets WHERE holder_id IS NOT NULL)            AS 挂接AD账号,
  (SELECT count(*) FROM assets WHERE borrower_external IS NOT NULL)    AS 外部借用,
  (SELECT count(*) FROM assets WHERE holder_id IS NULL
      AND borrower_external IS NULL)                                   AS 未分配;"

step "7. 关键约束存在性"
for c in "timesheets_user_id_period_key" "uq_cost_source_ref" "users_username_key" "projects_code_key"; do
  n=$(q "SELECT count(*) FROM pg_constraint WHERE conname='$c'")
  [ "$n" = "1" ] && ok "约束 $c 存在" || bad "约束 $c 缺失"
done

echo
printf '\033[1m════ 完整性审计: %d 通过, %d 失败 ════\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1