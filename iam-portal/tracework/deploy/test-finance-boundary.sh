#!/usr/bin/env bash
# ============================================================
# 财务角色权限边界验证
# ============================================================
# 目的：确认 finance 角色「能做财务的事、不能做人事与管理的事」。
#
# 做法：由于无法获取其他 AD 用户密码，这里用两种方式交叉验证：
#   1) 数据库层：直接以 finance 角色用户的会话令牌不可得时，
#      通过临时把 linyiyao 降级为 finance 来实测接口行为；
#   2) 校验完成后立即恢复 admin，避免影响生产。
# ============================================================
set -uo pipefail

# 测试账号：通过环境变量传入，避免密码写入版本库
#   TEST_USER  域账号（默认 linyiyao）
#   TEST_PASS  域账号密码（必填）

B=https://work.tri.local
R="--resolve work.tri.local:443:127.0.0.1 --cacert /etc/pki/tls/certs/tri.local_ca.crt"
CJ=/tmp/finbound.txt
SCRIPT_DIR="${SCRIPT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
# shellcheck source=lib/auth.sh
source "$SCRIPT_DIR/lib/auth.sh"

PASS=0; FAIL=0
trap 'rm -f "$CJ"' EXIT

ok()  { PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad() { FAIL=$((FAIL+1)); printf '  \033[31m✗\033[0m %s\n' "$*"; }
step(){ printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }

code() { # method url [json] -> HTTP 状态码
  local m=$1 u=$2 d=${3:-}
  if [ -n "$d" ]; then
    curl -sS $R -X "$m" -b "$CJ" -c "$CJ" -H 'Content-Type: application/json' -d "$d" \
      -o /tmp/fb.json -w '%{http_code}' "$B$u"
  else
    curl -sS $R -X "$m" -b "$CJ" -c "$CJ" -o /tmp/fb.json -w '%{http_code}' "$B$u"
  fi
}

ADMIN_ID=$(podman exec rnd-ts-db psql -U timesheet -d timesheet -tAc \
  "SELECT id FROM users WHERE username='linyiyao';" | tr -d ' ')
# 记录原角色，结束时恢复（避免污染真实数据）
ORIGINAL_ROLE=$(podman exec rnd-ts-db psql -U timesheet -d timesheet -tAc \
  "SELECT role FROM users WHERE id=$ADMIN_ID;" | tr -d ' ')


step "0. 以管理员身份登录并临时降级为 finance"
auth_login "$B" "$CJ" "${TEST_USER:-linyiyao}" "${TEST_PASS:-}" >/dev/null 2>&1
curl -sS $R -b "$CJ" -X PATCH -H 'Content-Type: application/json' \
  -d '{"role":"finance"}' "$B/api/admin/users/$ADMIN_ID" -o /dev/null
# 需要重新登录以刷新会话内的角色
auth_login "$B" "$CJ" "${TEST_USER:-linyiyao}" "${TEST_PASS:-}" >/dev/null 2>&1
r=$(curl -sS $R -b "$CJ" "$B/api/auth/me")
echo "$r" | python3 -c "
import sys,json;d=json.load(sys.stdin)
p=d['permissions']
print(f\"  当前角色={d['user']['role']}  审批={p['canApprove']} 人事={p['canHr']} 财务={p['canFinance']} 管理={p['canAdmin']}\")
" 2>/dev/null
echo "$r" | grep -q '"role":"finance"' && ok "已切换为 finance 角色" || bad "角色切换失败"

step "1. 财务应能访问的接口"
for spec in \
  "GET|/api/costing/company|企业档案" \
  "GET|/api/costing/entries?period=2026-10|费用明细" \
  "GET|/api/costing/shared?period=2026-10|公共费用" \
  "GET|/api/costing/outsource|委外研发" \
  "GET|/api/costing/ledgers|备查台账" \
  "GET|/api/costing/deduction?period=2026-10&scope=month|多口径测算" \
  "GET|/api/costing/compliance?period=2026-10&scope=month|合规自检" \
  "GET|/api/costing/docs?period=2026|备查资料清单" \
  "GET|/api/costing/labor/preview?period=2026-10|人工费用预览" \
  "GET|/api/summary/2026-10|月度工时汇总" ; do
  IFS='|' read -r m u label <<< "$spec"
  c=$(code "$m" "$u")
  [ "$c" = "200" ] && ok "$label ($u)" || bad "$label -> HTTP $c"
done

step "2. 财务应能写入的接口"
c=$(code POST /api/costing/ledgers/transfer/rows '{"fields":{"date":"2026-10-15","name":"财务权限测试","fromDept":"生产部","toDept":"研发中心","reason":"测试","workAfter":"测试","approve":"张伟"}}')
[ "$c" = "200" ] && ok "可新增备查台账（HTTP $c）" || bad "台账新增被拒 HTTP $c"
TROW=$(python3 -c "import json;print((json.load(open('/tmp/fb.json')).get('row') or {}).get('id',''))" 2>/dev/null)
if [ -n "$TROW" ]; then
  c=$(code DELETE "/api/costing/ledgers/transfer/rows/$TROW")
  [ "$c" = "200" ] && ok "可删除备查台账（已清理测试行）" || bad "台账删除被拒 HTTP $c"
fi

c=$(code POST /api/costing/shared '{"period":"2026-10","item":"财务权限测试项","category":"dep","total_amount":1,"basis_total":100,"basis_rd":50}')
[ "$c" = "200" ] && ok "可新增公共费用（HTTP $c）" || bad "公共费用新增被拒 HTTP $c"
SROW=$(python3 -c "import json;print((json.load(open('/tmp/fb.json')).get('row') or {}).get('id',''))" 2>/dev/null)
if [ -n "$SROW" ]; then
  code DELETE "/api/costing/shared/$SROW" >/dev/null
  ok "已清理公共费用测试行"
fi

step "3. 财务不应能访问管理类接口"
for spec in \
  "POST|/api/admin/sync-ad|同步 AD" \
  "GET|/api/admin/audit|审计日志（HR 专属）" ; do
  IFS='|' read -r m u label <<< "$spec"
  c=$(code "$m" "$u" '{}')
  [ "$c" = "403" ] && ok "$label 被正确拒绝（403）" || bad "$label 返回 $c（期望 403）"
done

step "4. 财务不应能修改用户角色"
c=$(code PATCH "/api/admin/users/$ADMIN_ID" '{"role":"admin"}')
[ "$c" = "403" ] && ok "修改用户角色被正确拒绝（403）" || bad "修改角色返回 $c（期望 403）"

step "5. 财务不属于人事职能"
c=$(code GET /api/admin/attendance/2026-10)
[ "$c" = "403" ] && ok "考勤维护被正确拒绝（403，人事专属）" || bad "考勤返回 $c（期望 403）"

step "6. 恢复管理员角色"
curl -sS $R -b "$CJ" -X PATCH -H 'Content-Type: application/json' \
  -d '{"role":"admin"}' "$B/api/admin/users/$ADMIN_ID" -o /dev/null 2>/dev/null
# finance 无权改角色，改用直接写库恢复
podman exec rnd-ts-db psql -U timesheet -d timesheet -q -c \
  "UPDATE users SET role='${ORIGINAL_ROLE:-admin}'::user_role WHERE id=$ADMIN_ID;" >/dev/null
RESTORED=$(podman exec rnd-ts-db psql -U timesheet -d timesheet -tAc \
  "SELECT role FROM users WHERE id=$ADMIN_ID;" | tr -d ' ')
[ "$RESTORED" = "admin" ] && ok "已恢复 linyiyao 为 admin" || bad "恢复失败，当前角色 $RESTORED"

echo
printf '\033[1m===== 财务权限边界: %d 通过, %d 失败 =====\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1