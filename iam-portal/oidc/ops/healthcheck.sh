#!/usr/bin/env bash
# Keycloak 健康巡检（每 5 分钟，由 /etc/cron.d/tri-oidc-health 调用）
# 输出格式：<时间> OK | WARN ... | FAIL ...
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CA="$ROOT/deploy/certs/tri.local_ca.crt"
B=https://sso.tri.local
ts=$(date '+%F %T')
fail=0
for p in 19000 19001; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$p/health/ready" || echo 000)
  [ "$code" = "200" ] || { echo "$ts WARN kc:$p ready=$code"; fail=1; }
done
code=$(curl -s -o /dev/null -w '%{http_code}' --cacert "$CA" \
  "$B/realms/tri/.well-known/openid-configuration" || echo 000)
[ "$code" = "200" ] || { echo "$ts FAIL discovery=$code"; fail=1; }
used=$(df --output=pcent "$HOME" | tail -1 | tr -dc '0-9')
[ "${used:-0}" -ge 90 ] && echo "$ts WARN disk_home=${used}%"
[ $fail -eq 0 ] && echo "$ts OK"
exit 0
