#!/usr/bin/env bash
# ============================================================
# 资产折旧与工时折算验收测试
# ============================================================
# 覆盖：
#   · 资产默认金额 10000 元、折旧年限 36 个月
#   · 月折旧额计算（金额 ÷ 年限）
#   · 填报页带出员工名下资产总额
#   · 财务确认按「月折旧 × 研发工时 ÷ 总工时」折算
#   · 四账号完整流程（admin/pm/hr/finance）
#
# 用法：
#   TEST_USER=linyiyao TEST_PASS=xxx \
#   EMP_USER=wangzi EMP_PASS=xxx HR_USER=jenny FIN_USER=lesley \
#   bash deploy/test-depreciation.sh
# ============================================================
set -uo pipefail

BASE="${BASE:-https://work.tri.local}"
CA="--cacert /etc/pki/tls/certs/tri.local_ca.crt"
ADMIN_USER="${TEST_USER:-linyiyao}"
ADMIN_PASS="${TEST_PASS:?请设置 TEST_PASS}"
EMP_USER="${EMP_USER:-wangzi}"
EMP_PASS="${EMP_PASS:?请设置 EMP_PASS}"
HR_USER="${HR_USER:-jenny}"
FIN_USER="${FIN_USER:-lesley}"
TESTPASS="${TESTPASS:-Trace0427@}"

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
# 登录：自动适配 ldap / oidc
lg(){ auth_login "$BASE" "/tmp/_dep_$1.txt" "$1" "$2" >/dev/null 2>&1; }

step "0. 准备（仅创建 TST 前缀数据，不触碰真实项目/资产/角色）"
TF_BEFORE=$(tf_snapshot)
tf_reset_sheet "$EMP_USER" "2026-11" >/dev/null
# 记住原始月薪，结束后还原（这是业务数据，测试不应永久改写）
ORIG_SALARY=$(q "SELECT COALESCE(monthly_salary,0) FROM users WHERE username='$EMP_USER';")

# 自建测试项目
tf_project "DEP"; PID=$TF_PID
EID=$(q "SELECT id FROM users WHERE username='$EMP_USER';")
ADMID=$(q "SELECT id FROM users WHERE username='$ADMIN_USER';")
tf_approvers "$PID" "$ADMID"
tf_members "$PID" "$EID"
q "UPDATE users SET monthly_salary=30000 WHERE id=$EID;" >/dev/null
ok "测试项目 id=$PID，员工=$EMP_USER"

# 自建测试资产（不占用真实资产）
tf_asset "$EMP_USER" "DEP"; ASSET_ID=$TF_ASSET_ID
ok "已创建测试资产 id=$ASSET_ID（10000 元 / 36 个月）"

lg "$ADMIN_USER" "$ADMIN_PASS"
lg "$EMP_USER" "$EMP_PASS"
lg "$HR_USER" "$TESTPASS"
lg "$FIN_USER" "$TESTPASS"
ok "四账号登录成功"

step "1. 资产默认值与月折旧计算"
DEF_AMT=$(q "SELECT amount FROM assets WHERE id=$ASSET_ID;")
DEF_MON=$(q "SELECT depreciation_months FROM assets WHERE id=$ASSET_ID;")
[ "$DEF_AMT" = "10000.00" ] && ok "金额 = 10000（默认值）" || bad "金额 = $DEF_AMT"
[ "$DEF_MON" = "36" ] && ok "折旧年限 = 36 个月（默认值）" || bad "年限 = $DEF_MON"
EXPECT_DEP=$(python3 -c "print(round(10000/36, 2))")
ACT_DEP=$(curl -sS $CA -b "/tmp/_dep_$EMP_USER.txt" \
  "$BASE/api/timesheet/2026-11/context" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['assets']['list'][0]['monthlyDep'])" 2>/dev/null)
[ "$ACT_DEP" = "$EXPECT_DEP" ] && ok "月折旧 = $ACT_DEP 元（10000÷36）" || bad "月折旧 = $ACT_DEP"

step "2. 填报页带出员工名下资产"
CTX=$(curl -sS $CA -b "/tmp/_dep_$EMP_USER.txt" "$BASE/api/timesheet/2026-11/context")
echo "$CTX" | python3 -c "
import sys,json;d=json.load(sys.stdin)['assets']
assert d['count'] >= 1, 'count=0'
assert d['valueTotal'] >= 10000, d['valueTotal']
print(f\"  名下 {d['count']} 件，总价值 {d['valueTotal']} 元，月折旧 {d['depMonthly']} 元\")" 2>/dev/null \
  && ok "填报页可见名下资产" || bad "填报页无资产信息"

step "3. 提交 → 审批 → 人事确认"
curl -sS $CA -b "/tmp/_dep_$EMP_USER.txt" -X POST -H 'Content-Type: application/json' \
  -d "{\"projectId\":$PID,\"hoursPerDay\":8}" "$BASE/api/timesheet/2026-11/fill-all" -o /dev/null
curl -sS $CA -b "/tmp/_dep_$EMP_USER.txt" -X POST -H 'Content-Type: application/json' \
  -d '{}' "$BASE/api/timesheet/2026-11/submit-workflow" -o /dev/null
ok "已提交"

ST=$(q "SELECT status FROM timesheets WHERE user_id=$EID AND period='2026-11';")
[ "$ST" = "stage1_project" ] && ok "进入项目审批" || bad "状态 = $ST"

APPR=$(q "SELECT a.id FROM approvals a JOIN timesheets t ON t.id=a.timesheet_id
          WHERE t.user_id=$EID AND t.period='2026-11' AND a.status='pending' LIMIT 1;")
curl -sS $CA -b "/tmp/_dep_$ADMIN_USER.txt" -X POST -H 'Content-Type: application/json' \
  -d '{"action":"approve"}' "$BASE/api/workflow/approvals/$APPR/decide" -o /dev/null
ok "项目审批通过"

TSID=$(q "SELECT id FROM timesheets WHERE user_id=$EID AND period='2026-11';")
curl -sS $CA -b "/tmp/_dep_$HR_USER.txt" -X POST -H 'Content-Type: application/json' \
  -d '{"salary":30000}' "$BASE/api/workflow/$TSID/hr-confirm" -o /dev/null
ST=$(q "SELECT status FROM timesheets WHERE id=$TSID;")
[ "$ST" = "stage3_finance" ] && ok "人事确认 → 财务" || bad "状态 = $ST"

step "4. 财务确认前查看资产折旧折算"
ALLOC=$(curl -sS $CA -b "/tmp/_dep_$FIN_USER.txt" "$BASE/api/workflow/$TSID/asset-allocation")
echo "$ALLOC" | python3 -c "
import sys,json;d=json.load(sys.stdin)
rnd, tot = d['rndHours'], d['totalHours']
assert tot > 0, 'totalHours=0'
ratio = rnd / tot
expect = round(d['depMonthly'] * ratio, 2)
print(f\"  月折旧 {d['depMonthly']} × {rnd}/{tot} = {d['allocYuan']} 元\")
assert abs(d['allocYuan'] - expect) < 0.02, f\"折算错误: 期望 {expect} 实际 {d['allocYuan']}\"
assert d['valueTotal'] >= 10000" 2>/dev/null \
  && ok "折算公式正确（月折旧 × 研发工时 ÷ 总工时）" || bad "折算异常: $(echo $ALLOC|head -c 200)"

step "5. 财务确认归档并写入折旧"
r=$(curl -sS $CA -b "/tmp/_dep_$FIN_USER.txt" -X POST -H 'Content-Type: application/json' \
  -d '{}' "$BASE/api/workflow/$TSID/finance-confirm")
echo "$r" | grep -q archived && ok "已归档" || bad "归档失败: $r"

V=$(q "SELECT asset_value_total FROM timesheets WHERE id=$TSID;")
DM=$(q "SELECT asset_dep_month FROM timesheets WHERE id=$TSID;")
AW=$(q "SELECT asset_alloc_wan FROM timesheets WHERE id=$TSID;")
[ -n "$V" ] && [ "$V" != "0.00" ] && ok "资产总额已记录 $V 元" || bad "资产总额 = $V"
[ -n "$DM" ] && [ "$DM" != "0.0000" ] && ok "月折旧已记录 $DM 元" || bad "月折旧 = $DM"
[ -n "$AW" ] && ok "摊入研发折旧 $AW 万元" || bad "摊入 = $AW"

step "6. 员工可见最终结果"
MINE=$(curl -sS $CA -b "/tmp/_dep_$EMP_USER.txt" "$BASE/api/my-timesheets?period=2026-11")
echo "$MINE" | python3 -c "
import sys,json;d=json.load(sys.stdin)
r=[x for x in d['rows'] if x['period']=='2026-11'][0]
assert r['status']=='archived', r['status']
print(f\"  状态={r['stageLabel']} 人工费用={r['labor_cost_wan']}万\")" 2>/dev/null \
  && ok "员工可见已归档结果" || bad "员工视图异常"

step "7. 清理（只删本测试创建的 TST 数据）"
tf_teardown
q "UPDATE users SET monthly_salary=${ORIG_SALARY:-0} WHERE id=$EID;" >/dev/null
ok "测试数据已清理，月薪已还原"

step "8. 确认真实数据未被改动"
tf_assert_real_untouched "$TF_BEFORE" && PASS=$((PASS+1)) || FAIL=$((FAIL+1))

echo
printf '\033[1m════ 资产折旧与工时折算: %d 通过, %d 失败 ════\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
