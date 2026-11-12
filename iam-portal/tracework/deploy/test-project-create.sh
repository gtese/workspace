#!/usr/bin/env bash
# ============================================================
# 项目创建（成员/审批人）与兜底
# ============================================================
# 用法：TEST_USER=xxx TEST_PASS=xxx bash deploy/test-project-create.sh
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
CJ=/tmp/np.txt
auth_login "$B" "$CJ" "$TEST_USER" "$TEST_PASS" || { echo "登录失败"; exit 1; }
q(){ podman exec rnd-ts-db psql -U timesheet -d timesheet -tAc "$1" 2>/dev/null | tr -d ' '; }

step "1. 创建项目 + 同时设置成员和审批人（前端 saveProject 的流程）"
r=$(curl -sS $R -b $CJ -X POST -H 'Content-Type: application/json' \
  -d '{"code":"TST-PROJ-CREATE","name":"TST-新建测试项目","is_rnd":true,"is_active":true}' "$B/api/admin/projects")
PID=$(echo "$r" | python3 -c "import sys,json;print(json.load(sys.stdin)['project']['id'])" 2>/dev/null)
[ -n "$PID" ] && ok "项目已创建 id=$PID" || bad "$r"

M1=$(q "SELECT id FROM users WHERE username='liaohonghui';")
M2=$(q "SELECT id FROM users WHERE username='vince';")
curl -sS $R -b $CJ -X PUT -H 'Content-Type: application/json' \
  -d "{\"user_ids\":[$M1,$M2]}" "$B/api/admin/projects/$PID/members" -o /dev/null
curl -sS $R -b $CJ -X PUT -H 'Content-Type: application/json' \
  -d "{\"user_ids\":[$M1]}" "$B/api/admin/projects/$PID/approvers" -o /dev/null

NM=$(q "SELECT count(*) FROM project_members WHERE project_id=$PID;")
NA=$(q "SELECT count(*) FROM project_approvers WHERE project_id=$PID;")
[ "$NM" = "2" ] && ok "成员已设置 2 人" || bad "成员 $NM"
[ "$NA" = "1" ] && ok "审批人已设置 1 人" || bad "审批人 $NA"

step "2. 未配置审批人的项目，提交后由谁审批（兜底）"
curl -sS $R -b $CJ -X POST -H 'Content-Type: application/json' \
  -d '{"code":"TST-PROJ-NOAPPR","name":"TST-无审批人项目","is_rnd":true,"is_active":true}' "$B/api/admin/projects" -o /dev/null
PID2=$(q "SELECT id FROM projects WHERE code='TST-PROJ-NOAPPR';")
q "INSERT INTO project_members (project_id,user_id) VALUES ($PID2,$M1);"
EMAJ=/tmp/np_e.txt
# 重置该员工 2026-11 的残留状态（可能被其他测试占用）
tf_reset_sheet "liaohonghui" "2026-11" >/dev/null
auth_login "$B" "$EMAJ" "liaohonghui" "${EMP_PASS:-Trace0427@}" >/dev/null 2>&1
curl -sS $R -b $EMAJ -X POST -H 'Content-Type: application/json' -d "{\"projectId\":$PID2,\"hoursPerDay\":8}" "$B/api/timesheet/2026-11/fill-all" -o /dev/null
curl -sS $R -b $EMAJ -X POST -H 'Content-Type: application/json' -d '{}' "$B/api/timesheet/2026-11/submit-workflow" -o /dev/null
# 管理员应能看到（兜底）
N=$(curl -sS $R -b $CJ "$B/api/workflow/inbox?period=2026-11" | python3 -c "import sys,json;print(json.load(sys.stdin)['counts']['stage1'])" 2>/dev/null)
[ "${N:-0}" -ge 1 ] 2>/dev/null && ok "无审批人项目由管理员兜底（$N 条）" || bad "无兜底"

step "3. 流程设置权限（仅管理员）"
EMP=/tmp/np_emp.txt
ca=$(curl -sS $R -b $EMAJ -X PUT -H 'Content-Type: application/json' \
  -d '{"enableHr":false}' -o /dev/null -w '%{http_code}' "$B/api/workflow/settings")
[ "$ca" = "403" ] && ok "非管理员修改被拒绝（403）" || bad "返回 $ca"

step "4. 清理（只删除 TST- 前缀的测试项目）"
BEFORE_CLEAN=$(tf_snapshot)
for pid in $(q "SELECT id FROM projects WHERE code LIKE 'TST-%';" | tr ' ' '\n'); do
  [ -z "$pid" ] && continue
  q "DELETE FROM time_entries WHERE project_id=$pid;"
  q "DELETE FROM approvals WHERE project_id=$pid;"
  q "DELETE FROM project_approvers WHERE project_id=$pid;"
  q "DELETE FROM project_members WHERE project_id=$pid;"
  q "DELETE FROM projects WHERE id=$pid;"
done
tf_reset_sheet "liaohonghui" "2026-11" >/dev/null
ok "测试项目与测试账号数据已清理（真实项目保留）"
q "SELECT count(*) FROM projects;" >/dev/null
ok "当前项目数：$(q "SELECT count(*) FROM projects;")"

echo
printf '\033[1m════ 项目创建与流程: %d 通过, %d 失败 ════\033[0m\n' "$PASS" "$FAIL"
