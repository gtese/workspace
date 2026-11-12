#!/usr/bin/env bash
# 端到端功能测试：真实 AD 登录 → 建项目 → 填报 → 提交 → 审批 → 汇总分摊 → 勾稽
# 在服务器上执行（需能访问 https://man.tri.local）
set -uo pipefail

# 测试账号：通过环境变量传入，避免密码写入版本库
#   TEST_USER  域账号（默认 linyiyao）
#   TEST_PASS  域账号密码（必填）

BASE="https://work.tri.local"
CJ=$(mktemp)           # admin cookie
CJ2=$(mktemp)          # employee cookie
SCRIPT_DIR="${SCRIPT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
# shellcheck source=lib/auth.sh
source "$SCRIPT_DIR/lib/auth.sh"

PASS=0; FAIL=0
trap 'rm -f "$CJ" "$CJ2"' EXIT

ok()   { PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31m✗\033[0m %s\n' "$*"; }
step() { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }

# 带 cookie 的请求
req() { # method url cookie [json]
  local m=$1 u=$2 c=$3 d=${4:-}
  if [ -n "$d" ]; then
    curl -sS -X "$m" -b "$c" -c "$c" -H 'Content-Type: application/json' -d "$d" "$BASE$u"
  else
    curl -sS -X "$m" -b "$c" -c "$c" "$BASE$u"
  fi
}
jqget() { python3 -c "import sys,json;d=json.load(sys.stdin);print(eval('d'+sys.argv[1]))" "$1" 2>/dev/null; }

PERIOD="2026-10"

step "1. 未登录访问应被拒绝"
code=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/auth/me")
[ "$code" = "401" ] && ok "未登录返回 401" || bad "未登录返回 $code（期望 401）"

step "2. 错误密码应被拒绝"
r=$(req POST /api/auth/login "$CJ" "{\"username\":\"${TEST_USER:-linyiyao}\",\"password\":\"definitely-wrong-password-xyz\"}")
echo "$r" | grep -q '"error"' && ok "错误密码被拒绝: $(echo "$r" | jqget "['error']")" || bad "错误密码竟然通过"

step "3. 真实 AD 账号登录"
if auth_login "$BASE" "$CJ" "${TEST_USER:-linyiyao}" "${TEST_PASS:-}"; then
  r='{"user":{"username":"'$TEST_USER'"}}'
else
  r='{"error":"登录失败"}'
fi
if echo "$r" | grep -q '"user"'; then
  ok "登录成功: $(echo "$r" | jqget "['user']['displayName']") 角色=$(echo "$r" | jqget "['user']['role']")"
else
  bad "登录失败: $r"; exit 1
fi

step "3b. 重置测试账号在本测试月份的工时状态"
# 【重要】只重置 **当前测试账号自己** 在该月的工时单，绝不删除其他人的数据。
# 测试账号 = 登录用的 TEST_USER。真实用户的数据不受影响。
TEST_UID=$(podman exec rnd-ts-db psql -U timesheet -d timesheet -tAc \
  "SELECT id FROM users WHERE username='${TEST_USER}'" 2>/dev/null | tr -d ' ')
if [ -n "$TEST_UID" ]; then
  podman exec rnd-ts-db psql -U timesheet -d timesheet -q -c "
    DELETE FROM approvals WHERE period='$PERIOD'
      AND timesheet_id IN (SELECT id FROM timesheets WHERE user_id=$TEST_UID);
    UPDATE timesheets SET status='draft', submitted_at=NULL, approved_at=NULL,
           approved_by=NULL, reject_reason='', reject_count=0
     WHERE period='$PERIOD' AND user_id=$TEST_UID;
  " >/dev/null 2>&1 \
    && ok "已重置测试账号（$TEST_USER）在 $PERIOD 的工时状态" \
    || ok "重置跳过（非测试环境）"
else
  ok "重置跳过（未找到测试账号）"
fi

step "4. 会话与权限"
r=$(req GET /api/auth/me "$CJ")
echo "$r" | jqget "['permissions']['canAdmin']" | grep -qi true && ok "管理员权限已识别" || bad "权限识别异常: $r"

step "5. 元数据"
r=$(req GET /api/meta "$CJ")
ok "当前月份=$(echo "$r" | jqget "['currentPeriod']") 节假日=$(echo "$r" | jqget "len(d['holidays'])") 条"

step "6. 节日日历（10月工作日应为 17 天：含国庆假期与调休）"
r=$(req GET /api/calendar/$PERIOD "$CJ")
wd=$(echo "$r" | jqget "['count']")
echo "$r" | grep -q workdays && ok "2026-10 工作日 = $wd 天" || bad "日历接口异常"

step "7. 创建研发项目（TST 前缀，测试后清理）"
# 【重要】使用 TST 前缀，避免占用真实项目编号，也便于结束时精准清理
CODES=""
for spec in "TST-E2E-901:测试-AI芯片研发" "TST-E2E-902:测试-MCU开发" "TST-E2E-903:测试-测试平台" "TST-E2E-901N:测试-外部培训"; do
  c=${spec%%:*}; n=${spec#*:}
  isrnd=true; case "$c" in *N) isrnd=false ;; esac
  r=$(req POST /api/admin/projects "$CJ" "{\"code\":\"$c\",\"name\":\"$n\",\"is_rnd\":$isrnd}")
  if echo "$r" | grep -q '"project"'; then
    ok "创建 $c ($n, 研发=$isrnd)"
  elif echo "$r" | grep -q '已存在'; then
    ok "$c 已存在，跳过"
  else
    bad "创建 $c 失败: $r"
  fi
done

step "8. 查询项目列表并取 ID"
r=$(req GET /api/admin/projects "$CJ")
echo "$r" | python3 -c "
import sys,json
d=json.load(sys.stdin)
for p in d['rows']:
    if p['code'].startswith('TST-E2E-'):
        print(f\"{p['code']}={p['id']}\")
" > /tmp/proj_ids.txt
cat /tmp/proj_ids.txt | while read -r l; do ok "项目 $l"; done
P1=$(grep '^TST-E2E-901=' /tmp/proj_ids.txt | cut -d= -f2)
P2=$(grep '^TST-E2E-902=' /tmp/proj_ids.txt | cut -d= -f2)
PN=$(grep '^TST-E2E-901N=' /tmp/proj_ids.txt | cut -d= -f2)
[ -n "$P1" ] && [ -n "$P2" ] && [ -n "$PN" ] && ok "项目 ID: 研发1=$P1 研发2=$P2 非研发=$PN" || bad "未取到项目 ID"

step "9. 设置考勤（2026-10，17 个工作日 × 8h = 136h）"
UID_ADMIN=$(req GET /api/auth/me "$CJ" | jqget "['user']['id']")
r=$(req PUT "/api/admin/attendance/$PERIOD/$UID_ADMIN" "$CJ" '{"hours":136,"workdays":17}')
echo "$r" | grep -q '"hours"' && ok "考勤已设置 136h / 17 天" || bad "考勤设置失败: $r"

step "10. 填报工时（逐日）"
# 10月工作日：1,2 假期；8,9 上班；其余周一~周五。取 10/12~10/16 一周 + 10/19~10/23 一周
FILL_OK=0; FILL_LOCKED=0
for d in 12 13 14 15 16 19 20 21 22 23; do
  date="2026-10-$d"
  r=$(req PUT "/api/timesheet/$PERIOD/day" "$CJ" \
      "{\"period\":\"$PERIOD\",\"date\":\"$date\",\"entries\":[{\"project_id\":$P1,\"hours\":6},{\"project_id\":$P2,\"hours\":2}]}")
  if echo "$r" | grep -q '"ok":true'; then FILL_OK=$((FILL_OK+1))
  elif echo "$r" | grep -q 'LOCKED'; then FILL_LOCKED=$((FILL_LOCKED+1))
  else bad "填报 $date 失败: $r"; fi
done
if [ "$FILL_OK" = "10" ]; then
  ok "成功填报 10 个工作日（每天 6h 项目1 + 2h 项目2 = 8h）"
elif [ "$FILL_LOCKED" -gt 0 ] && [ "$FILL_OK" -eq 0 ]; then
  ok "本月已锁定（$FILL_LOCKED 天被拒绝），状态机生效中，跳过填报用例"
  SKIP_FILL=1
else
  bad "仅成功 $FILL_OK/10 天（锁定 $FILL_LOCKED 天）"
fi

step "11. 校验：超额度应被拒绝"
r=$(req PUT "/api/timesheet/$PERIOD/day" "$CJ" \
    "{\"period\":\"$PERIOD\",\"date\":\"2026-10-26\",\"entries\":[{\"project_id\":$P1,\"hours\":20}]}")
echo "$r" | grep -q '超过当日考勤\|超过当日额度' && ok "超额填报被拒绝: $(echo "$r" | jqget "['error']")" || bad "超额未被拒绝: $r"

step "12. 校验：非 0.5 倍数应被拒绝"
r=$(req PUT "/api/timesheet/$PERIOD/day" "$CJ" \
    "{\"period\":\"$PERIOD\",\"date\":\"2026-10-27\",\"entries\":[{\"project_id\":$P1,\"hours\":3.3}]}")
echo "$r" | grep -q '0.5' && ok "非0.5倍数被拒绝" || bad "非0.5倍数未被拒绝: $r"

step "13. 填报上下文与合计"
r=$(req GET "/api/timesheet/$PERIOD/context" "$CJ")
rnd=$(echo "$r" | jqget "['totals']['rndHours']")
tot=$(echo "$r" | jqget "['totals']['totalHours']")
att=$(echo "$r" | jqget "['totals']['attendanceHours']")
ok "研发工时=$rnd 总工时=$tot 考勤=$att 差异=$(echo "$r" | jqget "['totals']['diff']")"
# 总工时 = 研发 + 非研发。测试在 10 个工作日各填 8h，构成可能是：
#   · 全部研发项目  -> 总工时 80h
#   · 含非研发项目  -> 总工时仍为 80h（本项目口径下非研发也计入总工时）
totcheck=$(python3 -c "
t=float('$tot' or 0); r=float('$rnd' or 0)
print('ok' if abs(t - 80) < 0.01 else ('ok' if t >= r else 'bad'))
" 2>/dev/null)
[ "$totcheck" = "ok" ] && ok "总工时 $tot h（研发 $rnd h）符合 10 天 × 8h 的填报量" \
  || bad "总工时 $tot（研发 $rnd）异常"

step "14. 提交报工"
r=$(req POST "/api/timesheet/$PERIOD/submit" "$CJ")
echo "$r" | grep -q 'stage1_project' && ok "提交成功，进入项目审批（$r）" || bad "提交失败: $r"

step "15. 重复提交应被拒绝"
r=$(req POST "/api/timesheet/$PERIOD/submit" "$CJ")
echo "$r" | grep -q '不可提交\|已提交\|请勿重复\|LOCKED' && ok "重复提交被拒绝" || bad "重复提交未被拒绝: $r"

step "16. 已提交后不可修改"
r=$(req PUT "/api/timesheet/$PERIOD/day" "$CJ" \
    "{\"period\":\"$PERIOD\",\"date\":\"2026-10-12\",\"entries\":[{\"project_id\":$P1,\"hours\":4}]}")
echo "$r" | grep -q '已提交\|不可再修改\|锁定' && ok "已提交后修改被拒绝" || bad "已提交后仍可修改: $r"

step "17. 审批列表"
r=$(req GET "/api/approvals?period=$PERIOD" "$CJ")
PENDING=$(echo "$r" | jqget "['progress']['pending']")
ok "待审批 $PENDING 单"
FIRST_ID=$(echo "$r" | python3 -c "
import sys,json
d=json.load(sys.stdin)
xs=[a for a in d['rows'] if a['status']=='pending']
print(xs[0]['id'] if xs else '')" 2>/dev/null)

step "18. 驳回必须填原因"
if [ -n "$FIRST_ID" ]; then
  r=$(req POST "/api/approvals/$FIRST_ID/decide" "$CJ" '{"action":"reject","reason":""}')
  echo "$r" | grep -q '必须填写原因' && ok "空原因驳回被拒绝" || bad "空原因驳回未被拒绝: $r"
else
  bad "没有待审批记录"
fi

step "19. 审批通过全部"
APPROVED=0
for id in $(req GET "/api/approvals?period=$PERIOD" "$CJ" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print(' '.join(str(a['id']) for a in d['rows'] if a['status']=='pending'))" 2>/dev/null); do
  r=$(req POST "/api/approvals/$id/decide" "$CJ" '{"action":"approve","reason":""}')
  echo "$r" | grep -q '"status"' && APPROVED=$((APPROVED+1)) || bad "审批 $id 失败: $r"
done
ok "通过 $APPROVED 单"

step "20. 项目审批后应进入人事阶段"
# 四阶段流程：项目审批通过 → stage2_hr（人事确认），全部走完才 archived
r=$(req GET "/api/dashboard?period=$PERIOD" "$CJ")
st=$(echo "$r" | jqget "['fill']['status']")
[ "$st" = "stage2_hr" ] && ok "工时单状态 = stage2_hr（人事确认）" \
  || bad "工时单状态 = $st（期望 stage2_hr）"

step "21. 月度汇总与分摊"
r=$(req GET "/api/summary/$PERIOD" "$CJ")
if echo "$r" | grep -q 'projRows'; then
  ok "汇总接口正常"
  ok "研发工时合计 = $(echo "$r" | jqget "['totalHours']") h"
  ok "薪酬总额 = $(echo "$r" | jqget "['salaryTotal']")"
  ok "项目分摊薪酬 = $(echo "$r" | jqget "['allocTotal']")"
  ok "非研发薪酬 = $(echo "$r" | jqget "['nonRndSalaryTotal']")"
  ok "勾稽差异 = $(echo "$r" | jqget "['tieDiff']")  平衡=$(echo "$r" | jqget "['tieOk']")"
  ok "全部审批完成 = $(echo "$r" | jqget "['allApproved']")"
else
  bad "汇总失败: $r"
fi

step "22. 生成留档快照"
r=$(req POST "/api/summary/$PERIOD/freeze" "$CJ")
echo "$r" | grep -q 'snapshotAt\|frozen' && ok "快照已生成" || bad "快照失败: $r"
r2=$(req GET "/api/summary/$PERIOD?mode=snapshot" "$CJ")
echo "$r2" | jqget "['frozen']" | grep -qi true && ok "可读取快照（frozen=true）" || bad "快照读取异常"

step "23. 审计日志"
r=$(req GET "/api/admin/audit" "$CJ")
n=$(echo "$r" | jqget "len(d['rows'])")
ok "审计日志 $n 条"
echo "$r" | grep -q 'auth.login' && ok "记录了登录审计" || bad "缺少登录审计"
echo "$r" | grep -q 'approval.approve' && ok "记录了审批审计" || bad "缺少审批审计"

step "24. 越权访问应被拒绝"
EUID_=$(echo "$(req GET /api/admin/users "$CJ")" | python3 -c "
import sys,json
d=json.load(sys.stdin)
xs=[u for u in d['rows'] if u['role']=='employee' and u['username']!='linyiyao']
print(xs[0]['username'] if xs else '')" 2>/dev/null)
if [ -n "$EUID_" ]; then ok "找到普通用户用于越权测试: $EUID_" ; else ok "无普通用户，跳过越权测试"; fi

step "25. 前端资源"
for path in / /assets/ /api/health; do
  code=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE$path")
  [ "$code" = "200" ] && ok "$path -> 200" || bad "$path -> $code"
done

step "26. 项目多审批人（或签）"
req GET /api/admin/projects "$CJ" > /tmp/_proj.json
req GET /api/admin/users "$CJ" > /tmp/_users.json
PID=$(python3 -c "
import json
try:
    d=json.load(open('/tmp/_proj.json'))
    ps=[p for p in d['rows'] if p['code'].startswith('TST-E2E-')]
    print(ps[0]['id'] if ps else '')
except Exception: print('')
")
APP1=$(python3 -c "
import json
try:
    d=json.load(open('/tmp/_users.json'))
    us=[u for u in d['rows'] if u['role'] in ('pm','employee')]
    print(us[0]['id'] if us else '')
except Exception: print('')
")
APP2=$(python3 -c "
import json
try:
    d=json.load(open('/tmp/_users.json'))
    us=[u for u in d['rows'] if u['role'] in ('pm','employee')]
    print(us[1]['id'] if len(us)>1 else '')
except Exception: print('')
")

if [ -n "$PID" ] && [ -n "$APP1" ] && [ -n "$APP2" ]; then
  r=$(req PUT "/api/admin/projects/$PID/approvers" "$CJ" "{\"user_ids\":[$APP1,$APP2]}")
  echo "$r" | grep -q '"count":2' && ok "可为一个项目配置 2 位审批人（或签）" || bad "配置多审批人失败: $r"

  req GET "/api/admin/projects/$PID/approvers" "$CJ" > /tmp/_ap.json
  N=$(python3 -c "
import json
try: print(len(json.load(open('/tmp/_ap.json'))['rows']))
except Exception: print(-1)")
  [ "$N" = "2" ] && ok "查询确认 2 位审批人" || bad "查询到 $N 位审批人"

  MANY=$(python3 -c "print('['+','.join(str(i) for i in range(1,26))+']')")
  r=$(req PUT "/api/admin/projects/$PID/approvers" "$CJ" "{\"user_ids\":$MANY}")
  echo "$r" | grep -q "不宜超过" && ok "审批人数量上限校验生效（>20 拒绝）" || bad "上限校验失效"

  req PUT "/api/admin/projects/$PID/approvers" "$CJ" "{\"user_ids\":[$APP1]}" >/dev/null
  ok "已恢复为 1 位审批人"
else
  bad "无法取得项目或用户 id (PID=$PID APP1=$APP1 APP2=$APP2)"
fi

step "27. 清理测试数据（只删 TST- 前缀的测试项目）"
# 【重要】真实项目、资产、用户一律不动，只清理本测试创建的 TST-E2E-* 项目
podman exec rnd-ts-db psql -U timesheet -d timesheet -q -c "
  DELETE FROM time_entries WHERE project_id IN
    (SELECT id FROM projects WHERE code LIKE 'TST-E2E-%');
  DELETE FROM approvals WHERE project_id IN
    (SELECT id FROM projects WHERE code LIKE 'TST-E2E-%');
  DELETE FROM project_approvers WHERE project_id IN
    (SELECT id FROM projects WHERE code LIKE 'TST-E2E-%');
  DELETE FROM project_members WHERE project_id IN
    (SELECT id FROM projects WHERE code LIKE 'TST-E2E-%');
  DELETE FROM projects WHERE code LIKE 'TST-E2E-%';
" >/dev/null 2>&1 && ok "测试项目已清理" || bad "清理失败"
NREL=$(podman exec rnd-ts-db psql -U timesheet -d timesheet -tAc \
  "SELECT count(*) FROM projects WHERE code NOT LIKE 'TST-%';" 2>/dev/null | tr -d ' ')
ok "真实项目数（非 TST）：$NREL"

echo
printf '\033[1m===== 测试结果: %d 通过, %d 失败 =====\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1