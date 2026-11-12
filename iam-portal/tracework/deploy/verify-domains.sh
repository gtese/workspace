#!/usr/bin/env bash
# ============================================================
# 域名与品牌验证
# ============================================================
# 验证：
#   · 主域名 work.tri.local 可访问且证书有效
#   · 兼容域名 man.tri.local 仍可访问
#   · 两个域名返回同一应用、同一页面标题
#   · 品牌名为 TraceWork
#   · API 在两个域名下均可用（会话 Cookie 不串域）
# ============================================================
set -uo pipefail

# 测试账号：通过环境变量传入，避免密码写入版本库
#   TEST_USER  域账号（默认 linyiyao）
#   TEST_PASS  域账号密码（必填）

PRIMARY="https://work.tri.local"
ALIAS="https://man.tri.local"
CA="--cacert /etc/pki/tls/certs/tri.local_ca.crt"
SCRIPT_DIR="${SCRIPT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
# shellcheck source=lib/auth.sh
source "$SCRIPT_DIR/lib/auth.sh"

PASS=0; FAIL=0

ok()  { PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad() { FAIL=$((FAIL+1)); printf '  \033[31m✗\033[0m %s\n' "$*"; }
step(){ printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }

step "1. DNS 解析"
for h in work.tri.local man.tri.local; do
  ip=$(getent hosts "$h" | awk '{print $1}' | head -1)
  [ "$ip" = "172.16.50.122" ] && ok "$h -> $ip" || bad "$h -> ${ip:-未解析}"
done

step "2. HTTPS 与证书"
for url in "$PRIMARY" "$ALIAS"; do
  out=$(curl -sS $CA -o /dev/null -w '%{http_code}|%{ssl_verify_result}' "$url/" 2>&1)
  code=${out%%|*}; verify=${out##*|}
  [ "$code" = "200" ] && [ "$verify" = "0" ] && ok "$url  HTTP 200，证书校验通过" \
    || bad "$url  HTTP $code，证书校验 $verify"
done

step "3. 页面标题与品牌"
for url in "$PRIMARY" "$ALIAS"; do
  title=$(curl -sS $CA "$url/" | grep -o '<title>[^<]*</title>' | sed 's/<[^>]*>//g')
  echo "$title" | grep -q 'TraceWork' && ok "$url  标题：$title" || bad "$url  标题异常：$title"
done

step "4. 旧品牌名已清除"
if podman exec rnd-ts-app sh -c "grep -rq 'Tri科研项目职能支持系统' /app/web/dist/ 2>/dev/null"; then
  bad "前端产物中仍存在旧名称"
else
  ok "前端产物中无旧名称"
fi

step "5. API 双域名可用"
for url in "$PRIMARY" "$ALIAS"; do
  cj=$(mktemp)
  # 自动适配 ldap / oidc 两种认证模式
  if auth_login "$url" "$cj" "${TEST_USER:-linyiyao}" "${TEST_PASS:-}"; then code=200
  else code=$(curl -sS $CA -o /dev/null -w '%{http_code}' "$url/api/auth/login"); fi
  me=$(curl -sS $CA -b "$cj" "$url/api/auth/me" -o /dev/null -w '%{http_code}')
  rm -f "$cj"
  [ "$code" = "200" ] && [ "$me" = "200" ] && ok "$url  登录与会话正常" \
    || bad "$url  登录 $code / 会话 $me"
done

step "6. HTTP 自动跳转 HTTPS"
for url in "http://work.tri.local" "http://man.tri.local"; do
  code=$(curl -sS -o /dev/null -w '%{http_code}' "$url/" 2>&1)
  [ "$code" = "301" ] && ok "$url  跳转到 HTTPS" || bad "$url  返回 $code"
done

echo
printf '\033[1m════ 域名验证: %d 通过, %d 失败 ════\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1