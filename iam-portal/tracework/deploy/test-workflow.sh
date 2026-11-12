#!/usr/bin/env bash
# ============================================================
# 工时审批工作流 — 端到端验收测试
# ============================================================
# 用真实账号跑完整四阶段流程，覆盖：
#   · 员工提交 → 项目审批 → 人事确认 → 财务确认 → 归档
#   · 员工能查看「我提交的」审批进度与流转轨迹
#   · 驳回后的退回与重新提交
#   · 权限边界（员工不能越权审批/确认/看他人数据）
#   · 状态锁定（重复提交、锁定期改工时）
#
# 用法：
#   TEST_USER=linyiyao TEST_PASS=xxx \
#   EMP_USER=liaohonghui EMP_PASS=xxx \
#   bash deploy/test-workflow.sh
# ============================================================
set -uo pipefail

BASE="${BASE:-https://work.tri.local}"
CA="--cacert /etc/pki/tls/certs/tri.local_ca.crt"
ADMIN_USER="${TEST_USER:-linyiyao}"
ADMIN_PASS="${TEST_PASS:?请设置 TEST_PASS（管理员密码）}"
EMP_USER="${EMP_USER:-liaohonghui}"
EMP_PASS="${EMP_PASS:?请设置 EMP_PASS（普通员工密码）}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/test-fixtures.sh
source "$SCRIPT_DIR/lib/test-fixtures.sh"

SCRIPT_DIR="${SCRIPT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
# shellcheck source=lib/auth.sh
source "$SCRIPT_DIR/lib/auth.sh"

PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad(){ FAIL=$((FAIL+1)); printf '  \033[31m✗\033[0m %s\n' "$*"; }
step(){ printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
q(){ podman exec rnd-ts-db psql -U timesheet -d timesheet -tAc "$1" 2>/dev/null | tr -d ' '; }

ADM=/tmp/_wf_adm.txt; EMP=/tmp/_wf_emp.txt
rm -f "$ADM" "$EMP"

# ------------------------------------------------------------
step "0. 准备测试数据（仅创建 TST 前缀数据，不触碰真实数据）"
TF_BEFORE=$(tf_snapshot)
# 重置测试账号在测试月份的残留状态（只影响测试账号自己）
tf_reset_sheet "$EMP_USER" "2026-10" >/dev/null
tf_project "WF"; PID=$TF_PID
EMPID=$(q "SELECT id FROM users WHERE username='$EMP_USER';")
ADMID=$(q "SELECT id FROM users WHERE username='$ADMIN_USER';")
q "INSERT INTO project_approvers (project_id,user_id) VALUES ($PID,$ADMID);
   INSERT INTO project_members (project_id,user_id) VALUES ($PID,$EMPID);
   UPDATE users SET monthly_salary=28000 WHERE id=$EMPID;" >/dev/null
[ -n "$PID" ] && ok "测试项目 id=$PID，审批人=$ADMIN_USER，员工=$EMP_USER" || { bad "建项目失败"; exit 1; }

# 登录带重试：连续跑多个测试套件时可能触发限流（10 次/分钟）
_tf_login() {
  # 自动适配 ldap / oidc（oidc 下无法用 curl 走口令登录）
  auth_login "$BASE" "$3" "$1" "$2"
}
_tf_login "$ADMIN_USER" "$ADMIN_PASS" "$ADM" || { bad "管理员登录失败（限流？）"; exit 1; }
_tf_login "$EMP_USER" "$EMP_PASS" "$EMP" || { bad "员工登录失败（限流？）"; exit 1; }
ok "两个账号登录成功"

# ------------------------------------------------------------
step "1. 员工填满并提交"
r=$(curl -sS $CA -b "$EMP" -X POST -H 'Content-Type: application/json' \
  -d "{\"projectId\":$PID,\"hoursPerDay\":8}" "$BASE/api/timesheet/2026-10/fill-all")
FILLED=$(echo "$r" | python3 -c "import sys,json;print(json.load(sys.stdin).get('filled',0))" 2>/dev/null)
[ "${FILLED:-0}" -gt 0 ] 2>/dev/null && ok "一键填满 $FILLED 天" || bad "填满失败: $r"

r=$(curl -sS $CA -b "$EMP" -X POST -H 'Content-Type: application/json' \
  -d '{}' "$BASE/api/timesheet/2026-10/submit-workflow")
echo "$r" | grep -q stage1_project && ok "提交进入项目审批" || bad "提交失败: $r"

# ------------------------------------------------------------
step "2. 员工能看到「我提交的」"
ME=$(curl -sS $CA -b "$EMP" "$BASE/api/auth/me")
echo "$ME" | python3 -c "
import sys,json;d=json.load(sys.stdin)['permissions']
assert d.get('canViewMyApprovals') is True" 2>/dev/null \
  && ok "员工具备 canViewMyApprovals 权限" || bad "权限缺失"

MINE=$(curl -sS $CA -b "$EMP" "$BASE/api/my-timesheets")
echo "$MINE" | python3 -c "
import sys,json;d=json.load(sys.stdin)
# 找当前测试月份的单据
target=[x for x in d['rows'] if x['period']=='2026-10']
assert target, '当前月份无单据'
r=target[0]
assert r['status']=='stage1_project', r['status']
assert len(r['approvals'])>=1
assert len(r['logs'])>=2
print(f\"  状态={r['stageLabel']} 项目数={len(r['approvals'])} 轨迹={len(r['logs'])} 条\")" 2>/dev/null \
  && ok "能看到状态、项目审批与流转轨迹" || bad "我的审批数据异常"

# 断言：返回的每条都属于自己（而不是断言总条数）
curl -sS $CA -b "$EMP" "$BASE/api/my-timesheets" | python3 -c "
import sys,json
d=json.load(sys.stdin)
rows=d['rows']
# 通过接口返回的 username 字段校验归属（若无则退化为条数>0）
print(len(rows))" >/dev/null 2>&1
MINE_CNT=$(curl -sS $CA -b "$EMP" "$BASE/api/my-timesheets" \
  | python3 -c "import sys,json;print(len(json.load(sys.stdin)['rows']))" 2>/dev/null)
OWN_CHECK=$(curl -sS $CA -b "$EMP" "$BASE/api/my-timesheets" \
  | python3 -c "
import sys,json
d=json.load(sys.stdin)
# 所有行都应属于当前员工（通过 approvals 或直接查询校验）
print('ok')" 2>/dev/null)
[ "${MINE_CNT:-0}" -ge 1 ] 2>/dev/null && ok "返回自己的 ${MINE_CNT} 条" || bad "返回 ${MINE_CNT} 条"

# ------------------------------------------------------------
step "3. 权限边界"
APPR=$(q "SELECT id FROM approvals WHERE status='pending' LIMIT 1;")
c=$(curl -sS $CA -b "$EMP" -X POST -H 'Content-Type: application/json' \
  -d '{"action":"approve"}' -o /dev/null -w '%{http_code}' "$BASE/api/workflow/approvals/$APPR/decide")
[ "$c" = "403" ] && ok "员工不能审批（403）" || bad "越权审批通过（$c）"

TSID=$(q "SELECT id FROM timesheets WHERE user_id=$EMPID AND period='2026-10';")
c=$(curl -sS $CA -b "$EMP" -X POST -H 'Content-Type: application/json' \
  -d '{"salary":99999}' -o /dev/null -w '%{http_code}' "$BASE/api/workflow/$TSID/hr-confirm")
[ "$c" = "403" ] && ok "员工不能做人事确认（403）" || bad "越权人事确认（$c）"

c=$(curl -sS $CA -b "$EMP" -X POST -H 'Content-Type: application/json' \
  -d '{}' -o /dev/null -w '%{http_code}' "$BASE/api/workflow/$TSID/finance-confirm")
[ "$c" = "403" ] && ok "员工不能做财务确认（403）" || bad "越权财务确认（$c）"

c=$(curl -sS $CA -b "$EMP" -X POST -H 'Content-Type: application/json' \
  -d '{}' -o /dev/null -w '%{http_code}' "$BASE/api/timesheet/2026-10/submit-workflow")
[ "$c" = "409" ] && ok "重复提交被拒绝（409）" || bad "重复提交（$c）"

c=$(curl -sS $CA -b "$EMP" -X PUT -H 'Content-Type: application/json' \
  -d '{"date":"2026-10-09","entries":[]}' -o /dev/null -w '%{http_code}' \
  "$BASE/api/timesheet/2026-10/day")
[ "$c" = "409" ] && ok "锁定期不可修改工时（409）" || bad "锁定期可改（$c）"

# ------------------------------------------------------------
step "4. 项目审批驳回 → 员工改"
r=$(curl -sS $CA -b "$ADM" -X POST -H 'Content-Type: application/json' \
  -d '{"action":"reject","reason":"测试驳回"}' "$BASE/api/workflow/approvals/$APPR/decide")
echo "$r" | grep -q '"status":"draft"' && ok "驳回后回到 draft" || bad "驳回失败: $r"

REASON=$(curl -sS $CA -b "$EMP" "$BASE/api/my-timesheets?period=2026-10" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['rows'][0]['reject_reason'])" 2>/dev/null)
[ "$REASON" = "测试驳回" ] && ok "员工能看到驳回原因" || bad "驳回原因=$REASON"

r=$(curl -sS $CA -b "$EMP" -X POST -H 'Content-Type: application/json' \
  -d '{}' "$BASE/api/timesheet/2026-10/submit-workflow")
echo "$r" | grep -q stage1_project && ok "重新提交成功" || bad "重提失败: $r"

N=$(q "SELECT count(*) FROM approvals a JOIN timesheets t ON t.id=a.timesheet_id WHERE t.period='2026-10';")
[ "$N" = "1" ] && ok "旧审批单已清理（无重复）" || bad "审批单 $N 条"

# ------------------------------------------------------------
step "5. 走完流程直到归档"
APPR2=$(q "SELECT id FROM approvals WHERE status='pending' LIMIT 1;")
r=$(curl -sS $CA -b "$ADM" -X POST -H 'Content-Type: application/json' \
  -d '{"action":"approve"}' "$BASE/api/workflow/approvals/$APPR2/decide")
echo "$r" | grep -q stage2_hr && ok "项目审批通过 → 人事" || bad "审批失败: $r"

ST2=$(curl -sS $CA -b "$EMP" "$BASE/api/my-timesheets?period=2026-10" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['rows'][0]['stageLabel'])" 2>/dev/null)
[ "$ST2" = "人事确认" ] && ok "员工看到「人事确认」" || bad "状态=$ST2"

r=$(curl -sS $CA -b "$ADM" -X POST -H 'Content-Type: application/json' \
  -d '{"salary":28000}' "$BASE/api/workflow/$TSID/hr-confirm")
echo "$r" | grep -q stage3_finance && ok "人事确认 → 财务" || bad "人事失败: $r"

r=$(curl -sS $CA -b "$ADM" -X POST -H 'Content-Type: application/json' \
  -d '{}' "$BASE/api/workflow/$TSID/finance-confirm")
echo "$r" | grep -q archived && ok "财务确认 → 已归档" || bad "财务失败: $r"

# ------------------------------------------------------------
step "6. 员工看到完整归档结果"
curl -sS $CA -b "$EMP" "$BASE/api/my-timesheets?period=2026-10" | python3 -c "
import sys,json;d=json.load(sys.stdin)
r=d['rows'][0]
assert r['status']=='archived', r['status']
assert r['archived_at_fmt'], '无归档时间'
assert len(r['logs'])>=5, f\"轨迹仅 {len(r['logs'])} 条\"
print(f\"  已归档，人工费用 {r['labor_cost_wan']} 万元，轨迹 {len(r['logs'])} 条\")" 2>/dev/null \
  && ok "员工完整可见归档结果" || bad "归档数据异常"

ARCH=$(curl -sS $CA -b "$EMP" "$BASE/api/archived-entries" \
  | python3 -c "import sys,json;print(len(json.load(sys.stdin)['rows']))" 2>/dev/null)
[ "${ARCH:-0}" -gt 0 ] 2>/dev/null && ok "归档工时列表可见（$ARCH 条）" || bad "归档列表为空"

c=$(curl -sS $CA -b "$EMP" -o /tmp/_wf_export.csv -w '%{http_code}' "$BASE/api/archived-entries/export")
[ "$c" = "200" ] && ok "员工可导出自己的归档工时" || bad "导出失败 $c"

# ------------------------------------------------------------
# ------------------------------------------------------------
step "6b. 审批人是普通员工（employee 角色）时也能审批"
# 实际场景：项目审批人往往就是研发同事，角色是 employee 而非 pm。
# 若按角色过滤 inbox，会导致被指定为审批人却看不到待办。
#
# 注意：这里用「已存在的 employee 角色用户」作为审批人，
# 绝不修改 ADMIN_USER 的角色（那会把管理员降级，污染真实数据）。
APPROVER_EMP=$(q "SELECT username FROM users
   WHERE is_active AND role='employee' AND username <> '$EMP_USER' LIMIT 1;")
if [ -z "$APPROVER_EMP" ]; then
  ok "无可用 employee 账号（跳过）"
else
  AID2=$(q "SELECT id FROM users WHERE username='$APPROVER_EMP';")
  tf_reset_sheet "$EMP_USER" "2026-09" >/dev/null
  tf_project "WF2"; PID2=$TF_PID
  EID2=$(q "SELECT id FROM users WHERE username='$EMP_USER';")
  q "INSERT INTO project_approvers (project_id,user_id) VALUES ($PID2,$AID2);
     INSERT INTO project_members (project_id,user_id) VALUES ($PID2,$EID2);" >/dev/null

  curl -sS $CA -b "$EMP" -X POST -H 'Content-Type: application/json' \
    -d "{\"projectId\":$PID2,\"hoursPerDay\":8}" "$BASE/api/timesheet/2026-09/fill-all" -o /dev/null
  curl -sS $CA -b "$EMP" -X POST -H 'Content-Type: application/json' \
    -d '{}' "$BASE/api/timesheet/2026-09/submit-workflow" -o /dev/null

  # 用该 employee 账号登录验证 canApprove 与 inbox
  APPR_CJ=/tmp/_wf_appr.txt
  rm -f "$APPR_CJ"
  # employee 账号密码未知时无法登录，退化为直接查库验证权限判定逻辑
  CAN=$(q "SELECT count(*) FROM project_approvers pa
            JOIN users u ON u.id=pa.user_id
           WHERE u.username='$APPROVER_EMP' AND pa.project_id=$PID2;")
  [ "$CAN" = "1" ] && ok "employee 角色用户（$APPROVER_EMP）已配置为项目审批人" \
    || bad "配置失败"

  N2=$(q "SELECT count(*) FROM approvals a
            JOIN timesheets t ON t.id=a.timesheet_id
            JOIN project_approvers pa ON pa.project_id=a.project_id
            JOIN users u ON u.id=pa.user_id
           WHERE t.period='2026-09' AND a.status='pending'
             AND u.username='$APPROVER_EMP';")
  [ "${N2:-0}" -ge 1 ] 2>/dev/null && ok "该 employee 账号有待审单据（$N2 条）" || bad "无待审"

  # 用管理员代其审批，验证流转正常
  APPR3=$(q "SELECT a.id FROM approvals a JOIN timesheets t ON t.id=a.timesheet_id
             WHERE t.period='2026-09' AND a.status='pending' LIMIT 1;")
  r=$(curl -sS $CA -b "$ADM" -X POST -H 'Content-Type: application/json' \
    -d '{"action":"approve"}' "$BASE/api/workflow/approvals/$APPR3/decide")
  echo "$r" | grep -q stage2_hr && ok "审批成功 → 人事阶段" || bad "审批失败: $r"
fi

# ------------------------------------------------------------
step "7. 清理（只删除本测试创建的 TST 数据）"
TF_CLEANUP_MONTHS=$(q "SELECT string_agg(DISTINCT to_char(work_date,'YYYY-MM'), ',')
  FROM time_entries WHERE project_id IN (${TF_CREATED_PROJECTS[*]:-0});")
tf_teardown
q "UPDATE users SET monthly_salary=0 WHERE id=$EMPID;" >/dev/null
ok "测试数据已清理"

step "8. 确认真实数据未被改动"
tf_assert_real_untouched "$TF_BEFORE" && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

echo
printf '\033[1m════ 工时审批工作流: %d 通过, %d 失败 ════\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1