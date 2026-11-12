#!/usr/bin/env bash
# ============================================================
# IT 资产模块验收测试
# ============================================================
# 覆盖：资产金额字段、清除使用人、note 空值、CSV 导出
# 用法：TEST_USER=xxx TEST_PASS=xxx bash deploy/test-assets.sh
# ============================================================
set -uo pipefail

BASE="${BASE:-https://work.tri.local}"
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
B="$BASE"
R="$CA"
CJ=/tmp/ta2.txt
# 自动适配 ldap / oidc 两种认证模式
auth_login "$B" "$CJ" "${TEST_USER}" "${TEST_PASS}" || { echo "登录失败"; exit 1; }

step "1. 新建资产带金额"
r=$(curl -sS $R -b $CJ -X POST -H 'Content-Type: application/json' \
  -d '{"asset_no":"TEST-AMT-001","device_type":"笔记本","brand":"测试","amount":8888.88}' "$B/api/assets")
NID=$(echo "$r" | python3 -c "import sys,json;print(json.load(sys.stdin)['asset']['id'])" 2>/dev/null)
AMT=$(echo "$r" | python3 -c "import sys,json;print(json.load(sys.stdin)['asset']['amount'])" 2>/dev/null)
[ -n "$NID" ] && ok "创建成功 id=$NID" || bad "创建失败: $r"
[ "$AMT" = "8888.88" ] && ok "金额正确 $AMT" || bad "金额=$AMT"

step "2. 修改金额"
curl -sS $R -b $CJ -X PATCH -H 'Content-Type: application/json' -d '{"amount":9999.99}' "$B/api/assets/$NID" -o /tmp/a2.json
AMT2=$(python3 -c "import json;print(json.load(open('/tmp/a2.json'))['asset']['amount'])" 2>/dev/null)
[ "$AMT2" = "9999.99" ] && ok "金额已更新 9999.99" || bad "金额=$AMT2"

step "3. 清除使用人（原报错场景）"
# 先挂使用人
curl -sS $R -b $CJ -X PATCH -H 'Content-Type: application/json' -d '{"holder_account":"liusen"}' "$B/api/assets/$NID" -o /dev/null
c=$(curl -sS $R -b $CJ -X PATCH -H 'Content-Type: application/json' \
  -d '{"holder_account":"","holder_name":"","borrower_external":"","note":null}' \
  "$B/api/assets/$NID" -o /tmp/a3.json -w '%{http_code}')
[ "$c" = "200" ] && ok "清除使用人 HTTP 200（已修复）" || bad "HTTP $c"
ST=$(python3 -c "import json;print(json.load(open('/tmp/a3.json'))['asset']['status'])" 2>/dev/null)
[ "$ST" = "在库" ] && ok "状态自动变为在库" || bad "状态=$ST"

step "4. note 传 null 不报错"
for v in 'null' '""' '"测试备注"'; do
  c=$(curl -sS $R -b $CJ -X PATCH -H 'Content-Type: application/json' -d "{\"note\":$v}" "$B/api/assets/$NID" -o /dev/null -w '%{http_code}')
  [ "$c" = "200" ] && ok "note=$v -> 200" || bad "note=$v -> $c"
done

step "5. 金额为空"
c=$(curl -sS $R -b $CJ -X PATCH -H 'Content-Type: application/json' -d '{"amount":null}' "$B/api/assets/$NID" -o /dev/null -w '%{http_code}')
[ "$c" = "200" ] && ok "金额可清空" || bad "HTTP $c"

step "6. CSV 导出含金额列"
curl -sS $R -b $CJ -o /tmp/amt.csv "$B/api/assets/export"
head -1 /tmp/amt.csv | grep -q "资产金额" && ok "导出含「资产金额(元)」列" || bad "缺金额列"

step "7. 清理"
curl -sS $R -b $CJ -X DELETE "$B/api/assets/$NID" -o /dev/null
ok "测试资产已删除"

echo
printf '\033[1m════ 资产金额与清除使用人: %d 通过, %d 失败 ════\033[0m\n' "$PASS" "$FAIL"
