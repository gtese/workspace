#!/usr/bin/env bash
# ============================================================
# 流程节点开关与自动跳过
# ============================================================
# 用法：TEST_USER=xxx TEST_PASS=xxx bash deploy/test-workflow-settings.sh
# ============================================================
set -uo pipefail
BASE="${BASE:-https://work.tri.local}"
CA="--cacert /etc/pki/tls/certs/tri.local_ca.crt"
TEST_USER="${TEST_USER:-linyiyao}"
TEST_PASS="${TEST_PASS:?请设置 TEST_PASS 环境变量}"
HAVE_EMP_PASS=1

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
B="$BASE"; R="$CA"
CJ=/tmp/sk.txt
auth_login "$B" "$CJ" "$TEST_USER" "$TEST_PASS" >/dev/null 2>&1
q(){ podman exec rnd-ts-db psql -U timesheet -d timesheet -tAc "$1" 2>/dev/null | tr -d ' '; }

step "0. 准备：创建 TST 测试项目（不触碰真实数据）"
TF_BEFORE=$(tf_snapshot)
tf_reset_sheet "liaohonghui" "2026-10" >/dev/null
tf_project "SKIP"; PID=$TF_PID
EID=$(q "SELECT id FROM users WHERE username='liaohonghui';")
ADMID=$(q "SELECT id FROM users WHERE username='linyiyao';")
ORIG_SALARY=$(q "SELECT COALESCE(monthly_salary,0) FROM users WHERE id=$EID;")
tf_approvers "$PID" "$ADMID"
tf_members "$PID" "$EID"
q "UPDATE users SET monthly_salary=28000 WHERE id=$EID;"
echo "  项目=$PID 员工=$EID"

run_case() {
  local name="$1" ep="$2" eh="$3" ef="$4"
  step "$name"
  curl -sS $R -b $CJ -X PUT -H 'Content-Type: application/json' \
    -d "{\"enableProject\":$ep,\"enableHr\":$eh,\"enableFinance\":$ef}" \
    "$B/api/workflow/settings" -o /tmp/s.json
  python3 -c "import json;d=json.load(open('/tmp/s.json'));print('  配置链:', ' → '.join(d.get('chain',[])))" 2>/dev/null
  # 清空本测试项目上一场景的工时数据（不影响真实数据）
  # 注意：必须连 timesheets 一起删，否则上一场景归档后的状态会残留，
  # 导致下一场景提交时报「已归档不可提交」。
  q "DELETE FROM time_entries WHERE project_id=$PID;"
  q "DELETE FROM approvals WHERE project_id=$PID;"
  q "DELETE FROM timesheets WHERE user_id=$EID AND period='2026-10';"
  q "DELETE FROM timesheet_stage_logs WHERE timesheet_id NOT IN (SELECT id FROM timesheets);"
  # 员工填并提交
  EMP=/tmp/sk_e.txt
  auth_login "$B" "$EMP" "liaohonghui" "${EMP_PASS:-Trace0427@}" >/dev/null 2>&1
  curl -sS $R -b $EMP -X POST -H 'Content-Type: application/json' -d "{\"projectId\":$PID,\"hoursPerDay\":8}" "$B/api/timesheet/2026-10/fill-all" -o /dev/null
  r=$(curl -sS $R -b $EMP -X POST -H 'Content-Type: application/json' -d '{}' "$B/api/timesheet/2026-10/submit-workflow")
  echo "  提交后: $r"
  SUB_ST=$(echo "$r" | python3 -c "import sys,json;print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
  echo "  提交后状态: $SUB_ST"
}

run_case "A. 全开（项目→人事→财务→归档）" true true true
curl -sS $R -b $CJ "$B/api/timesheet/2026-10/progress?userId=$EID" | python3 -c "
import sys,json;d=json.load(sys.stdin);print('  进度:',d['label'])" 2>/dev/null
ST=$(q "SELECT status FROM timesheets WHERE user_id=$EID AND period='2026-10';")
[ "$ST" = "stage1_project" ] && ok "停在项目审批" || bad "状态=$ST"

run_case "B. 关闭人事（项目→财务→归档）" true false true
ST=$(q "SELECT status FROM timesheets WHERE user_id=$EID AND period='2026-10';")
[ "$ST" = "stage1_project" ] && ok "停在项目审批" || bad "状态=$ST"
# 审批通过后应直接到财务
APPR=$(q "SELECT id FROM approvals WHERE status='pending' LIMIT 1;")
r=$(curl -sS $R -b $CJ -X POST -H 'Content-Type: application/json' -d '{"action":"approve"}' "$B/api/workflow/approvals/$APPR/decide")
echo "  审批后: $r"
echo "$r" | grep -q stage3_finance && ok "跳过人事，直接到财务" || bad "未跳转: $r"

run_case "C. 关闭项目+人事（填报→财务→归档）" false false true
ST=$(q "SELECT status FROM timesheets WHERE user_id=$EID AND period='2026-10';")
[ "$ST" = "stage3_finance" ] && ok "提交后直接到财务" || bad "状态=$ST"

run_case "D. 全关（提交即归档）" false false false
ST=$(q "SELECT status FROM timesheets WHERE user_id=$EID AND period='2026-10';")
[ "$ST" = "archived" ] && ok "提交即归档" || bad "状态=$ST"
N=$(q "SELECT count(*) FROM approvals a JOIN timesheets t ON t.id=a.timesheet_id WHERE t.user_id=$EID;")
[ "$N" = "0" ] && ok "未生成审批单" || bad "生成了 $N 条审批单"

echo
printf '\033[1m════ 节点跳过: %d 通过, %d 失败 ════\033[0m\n' "$PASS" "$FAIL"
# 恢复默认流程设置
curl -sS $R -b $CJ -X PUT -H 'Content-Type: application/json' \
  -d '{"enableProject":true,"enableHr":true,"enableFinance":true}' "$B/api/workflow/settings" -o /dev/null

step "清理"
tf_teardown
q "UPDATE users SET monthly_salary=${ORIG_SALARY:-0} WHERE id=$EID;" >/dev/null
ok "测试数据已清理"

step "确认真实数据未被改动"
tf_assert_real_untouched "$TF_BEFORE" && PASS=$((PASS+1)) || FAIL=$((FAIL+1))
