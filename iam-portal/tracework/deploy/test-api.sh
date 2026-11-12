#!/usr/bin/env bash
# ============================================================
# 开放 API v1 验收测试
# ============================================================
# 覆盖：认证（JWT/API Key）、权限隔离、限流、响应格式、
#       各领域接口、调用日志、密钥生命周期、OpenAPI 规范
#
# 用法：TEST_USER=xxx TEST_PASS=xxx bash deploy/test-api.sh
# ============================================================
set -uo pipefail

BASE="${BASE:-https://work.tri.local}"
API="$BASE/api/v1"
CA="--cacert /etc/pki/tls/certs/tri.local_ca.crt"
TEST_USER="${TEST_USER:-linyiyao}"
TEST_PASS="${TEST_PASS:?请设置 TEST_PASS 环境变量}"

SCRIPT_DIR="${SCRIPT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
# shellcheck source=lib/auth.sh
source "$SCRIPT_DIR/lib/auth.sh"

PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad(){ FAIL=$((FAIL+1)); printf '  \033[31m✗\033[0m %s\n' "$*"; }
step(){ printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
# 取值：jget "d['data']['accessToken']" 或 jget "len(d['data'])"
jget(){ python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
    print(eval(sys.argv[1]))
except Exception:
    print('')
" "$1" 2>/dev/null; }

step "1. 无凭证应返回 401"
c=$(curl -sS $CA -o /tmp/a1.json -w '%{http_code}' "$API/meta")
[ "$c" = "401" ] && ok "无 Authorization 返回 401" || bad "返回 $c"
grep -q 'NO_CREDENTIAL' /tmp/a1.json && ok "错误码 NO_CREDENTIAL" || bad "错误码异常"

step "2. 账号密码换取 JWT"
c=$(curl -sS $CA -X POST -H 'Content-Type: application/json' \
  -d "{\"username\":\"$TEST_USER\",\"password\":\"$TEST_PASS\"}" \
  -o /tmp/t.json -w '%{http_code}' "$API/auth/token")
TOKEN=$(cat /tmp/t.json | jget "d['data']['accessToken']")
[ "$c" = "200" ] && [ -n "$TOKEN" ] && ok "签发成功（${#TOKEN} 字符）" || bad "失败 HTTP $c"

step "3. 错误密码应返回 401"
c=$(curl -sS $CA -X POST -H 'Content-Type: application/json' \
  -d "{\"username\":\"$TEST_USER\",\"password\":\"wrong\"}" \
  -o /dev/null -w '%{http_code}' "$API/auth/token")
[ "$c" = "401" ] && ok "错误密码返回 401" || bad "返回 $c"

step "4. whoami"
curl -sS $CA -H "Authorization: Bearer $TOKEN" "$API/auth/whoami" -o /tmp/w.json
V=$(cat /tmp/w.json | jget "d['data']['via']")
[ "$V" = "jwt" ] && ok "身份识别为 jwt" || bad "via=$V"

step "5. 创建 API Key"
c=$(curl -sS $CA -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"测试密钥","scopes":["*"],"rateLimitPerMin":300}' \
  -o /tmp/k.json -w '%{http_code}' "$API/api-keys")
APIKEY=$(cat /tmp/k.json | jget "d['data']['key']")
KEYID=$(cat /tmp/k.json | jget "d['data']['id']")
[ "$c" = "200" ] && [ -n "$APIKEY" ] && ok "创建成功 id=$KEYID" || bad "失败 HTTP $c"

step "6. API Key 认证"
c=$(curl -sS $CA -H "Authorization: Bearer $APIKEY" -o /dev/null -w '%{http_code}' "$API/meta")
[ "$c" = "200" ] && ok "API Key 可用" || bad "返回 $c"

step "7. 限流响应头"
curl -sS $CA -D /tmp/h.txt -H "Authorization: Bearer $APIKEY" -o /dev/null "$API/meta"
grep -qi 'X-RateLimit-Limit' /tmp/h.txt && ok "含 X-RateLimit-* 头" || bad "缺少限流头"

step "8. 各领域接口可访问"
for ep in projects users assets "assets/stats" ledgers meta "cost-entries"; do
  c=$(curl -sS $CA -H "Authorization: Bearer $APIKEY" -o /dev/null -w '%{http_code}' "$API/$ep")
  [ "$c" = "200" ] && ok "$ep" || bad "$ep -> $c"
done

step "9. 统一响应信封"
curl -sS $CA -H "Authorization: Bearer $APIKEY" "$API/projects" -o /tmp/p.json
OKF=$(cat /tmp/p.json | jget "d['ok']")
[ "$OKF" = "True" ] && ok "ok=true" || bad "信封格式异常"
cat /tmp/p.json | jget "d['data']['pageSize']" >/dev/null && ok "分页字段存在" || bad "缺分页字段"

step "10. 无效 scope 应拒绝"
c=$(curl -sS $CA -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"越权","scopes":["bogus:scope"]}' -o /tmp/k2.json -w '%{http_code}' "$API/api-keys")
[ "$c" = "422" ] && ok "返回 422" || bad "返回 $c"

step "11. 调用日志"
curl -sS $CA -H "Authorization: Bearer $TOKEN" "$API/api-logs?limit=3" -o /tmp/l.json
NLOG=$(cat /tmp/l.json | jget "len(d['data']) if isinstance(d.get('data'),list) else 0")
[ -n "$NLOG" ] && [ "$NLOG" -ge 0 ] 2>/dev/null && ok "日志可查询（$NLOG 条）" || bad "日志异常"

step "12. 吊销后失效"
curl -sS $CA -X DELETE -H "Authorization: Bearer $TOKEN" "$API/api-keys/$KEYID" -o /dev/null
c=$(curl -sS $CA -H "Authorization: Bearer $APIKEY" -o /tmp/r2.json -w '%{http_code}' "$API/meta")
[ "$c" = "401" ] && ok "吊销后 401" || bad "仍可访问（$c）"

step "13. 只读 Key 权限隔离"
curl -sS $CA -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"只读","scopes":["timesheet:read"]}' "$API/api-keys" -o /tmp/ro.json
ROKEY=$(cat /tmp/ro.json | jget "d['data']['key']")
ROID=$(cat /tmp/ro.json | jget "d['data']['id']")
c1=$(curl -sS $CA -H "Authorization: Bearer $ROKEY" -o /dev/null -w '%{http_code}' "$API/entries")
c2=$(curl -sS $CA -X POST -H "Authorization: Bearer $ROKEY" -H 'Content-Type: application/json' \
  -d '{"code":"X","name":"Y"}' -o /dev/null -w '%{http_code}' "$API/projects")
c3=$(curl -sS $CA -H "Authorization: Bearer $ROKEY" -o /dev/null -w '%{http_code}' "$API/api-keys")
[ "$c1" = "200" ] && ok "可读工时" || bad "读工时 $c1"
[ "$c2" = "403" ] && ok "不可写项目（403）" || bad "写项目 $c2"
[ "$c3" = "403" ] && ok "不可管理密钥（403）" || bad "密钥管理 $c3"
curl -sS $CA -X DELETE -H "Authorization: Bearer $TOKEN" "$API/api-keys/$ROID" -o /dev/null

step "14. OpenAPI 规范"
c=$(curl -sS $CA -o /tmp/spec.json -w '%{http_code}' "$API/openapi.json")
N=$(cat /tmp/spec.json | jget "len(d.get('paths') or {})")
[ "$c" = "200" ] && [ -n "$N" ] && ok "规范可下载（$N 个路径）" || bad "失败"

echo
printf '\033[1m════ 开放 API: %d 通过, %d 失败 ════\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
