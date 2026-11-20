#!/bin/bash
# 办公网 VPN 网关快速验证（在办公网终端执行）
# 只做只读检查，不修改任何配置

set -uo pipefail
IKUAI_DNS="${IKUAI_DNS:-192.168.9.1}"
NODE_IP="${NODE_IP:-8.211.181.28}"
pass=0; fail=0

chk() { # chk <名称> <实际> <期望包含>
  local name="$1" got="$2" want="$3"
  if [[ "$got" == *"$want"* ]]; then echo "  ✅ $name: $got"; pass=$((pass+1));
  else echo "  ❌ $name: $got (期望包含 $want)"; fail=$((fail+1)); fi
}

echo "== 出口 IP =="
chk "ifconfig.me" "$(curl -s --max-time 15 ifconfig.me 2>/dev/null)" "$NODE_IP"
chk "ipinfo.io（未分流，应为办公室出口）" "$(curl -s --max-time 10 https://ipinfo.io/ip 2>/dev/null)" "223.167.143.174"

echo "== 干净解析（经 iKuai）=="
chk "www.google.com" "$(dig +short +time=5 +tries=1 @$IKUAI_DNS www.google.com 2>/dev/null | head -1)" "."
chk "api.anthropic.com" "$(dig +short +time=5 +tries=1 @$IKUAI_DNS api.anthropic.com 2>/dev/null | head -1)" "."
chk "github.com" "$(dig +short +time=5 +tries=1 @$IKUAI_DNS github.com 2>/dev/null | head -1)" "."

echo "== HTTP 连通性 =="
for u in https://api.github.com/zen https://api.openai.com/v1/models https://api.anthropic.com/v1/messages https://www.google.com/; do
  code=$(curl -s -o /dev/null -m 25 -w '%{http_code}' "$u" 2>/dev/null)
  if [[ "$code" =~ ^(200|301|302|401|403|405)$ ]]; then echo "  ✅ $u -> $code"; pass=$((pass+1));
  else echo "  ❌ $u -> $code"; fail=$((fail+1)); fi
done
chk "baidu（直连对照）" "$(curl -s -o /dev/null -m 10 -w '%{http_code}' https://www.baidu.com/ 2>/dev/null)" "200"

echo "== 内网域名 =="
chk "man.tri.local" "$(dscacheutil -q host -a name man.tri.local 2>/dev/null | grep ip_address | head -1)" "172.16."

echo "== 结果：$pass 通过 / $fail 失败 =="
exit $(( fail > 0 ? 1 : 0 ))
