#!/usr/bin/env bash
# 在 Cloudflare 侧把隧道、DNS、入口配置一次配好（在本机跑，不在服务器上跑）
#
# 前置：
#   ~/.mm/cloudflare-v2txt   CF_API_TOKEN / CF_ACCOUNT_ID
#   ~/.mm/cloudflared-v2txt  TUNNEL_TOKEN / TUNNEL_ID（可省略，脚本会查）
#
# 用法：
#   ./deploy/cloudflare/setup.sh app.v2txt.cn
set -euo pipefail

HOSTNAME="${1:-app.v2txt.cn}"
ZONE_NAME="${ZONE_NAME:-v2txt.cn}"
SERVICE_URL="${SERVICE_URL:-http://172.16.50.166:8080}"

set -a
. "$HOME/.mm/cloudflare-v2txt"
[ -f "$HOME/.mm/cloudflared-v2txt" ] && . "$HOME/.mm/cloudflared-v2txt"
set +a

AID="$CF_ACCOUNT_ID"
T="$CF_API_TOKEN"
api() { curl -sS -m 20 -H "Authorization: Bearer $T" -H "Content-Type: application/json" "$@"; }

echo "== 1. 查找 zone $ZONE_NAME"
ZONE_ID=$(api "https://api.cloudflare.com/client/v4/zones?name=$ZONE_NAME" \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);r=d.get("result") or [];print(r[0]["id"] if r else "")')
if [ -z "$ZONE_ID" ]; then
  echo "!! 域名还没加到 Cloudflare。请先在控制台 Add a site，或在 Token 上补 Account → Zone → Edit 权限。"
  exit 1
fi
echo "   zone_id=$ZONE_ID"

echo "== 2. 确认隧道"
if [ -z "${TUNNEL_ID:-}" ]; then
  TUNNEL_ID=$(api "https://api.cloudflare.com/client/v4/accounts/$AID/cfd_tunnel?is_deleted=false" \
    | python3 -c 'import sys,json;d=json.load(sys.stdin);r=d.get("result") or [];print(r[0]["id"] if r else "")')
fi
[ -n "$TUNNEL_ID" ] || { echo "!! 没有可用隧道，先 cloudflared tunnel create v2txt"; exit 1; }
echo "   tunnel_id=$TUNNEL_ID"

echo "== 3. 写入 ingress 配置（$HOSTNAME → $SERVICE_URL）"
api -X PUT "https://api.cloudflare.com/client/v4/accounts/$AID/cfd_tunnel/$TUNNEL_ID/configurations" \
  --data "{\"config\":{\"ingress\":[{\"hostname\":\"$HOSTNAME\",\"service\":\"$SERVICE_URL\"},{\"service\":\"http_status:404\"}]}}" \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print("   ok" if d.get("success") else d.get("errors"))'

echo "== 4. 创建 DNS 记录（CNAME → $TUNNEL_ID.cfargotunnel.com，proxied）"
api -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records" \
  --data "{\"type\":\"CNAME\",\"name\":\"$HOSTNAME\",\"content\":\"$TUNNEL_ID.cfargotunnel.com\",\"proxied\":true}" \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print("   ok" if d.get("success") else ("   已存在/失败: "+str(d.get("errors"))))'

echo "== 5. 当前 NS（应与 Cloudflare 分配的完全一致）"
api "https://api.cloudflare.com/client/v4/zones/$ZONE_ID" \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);r=d["result"];print("   status:",r["status"]);print("   ns:",", ".join(r.get("name_servers") or []))'
