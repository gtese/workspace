#!/usr/bin/env bash
# 部署后清理 Cloudflare 边缘缓存（页面 HTML 在边缘缓存 60 秒）
# 用法：./deploy/cloudflare/purge.sh
set -euo pipefail
set -a
. "$HOME/.mm/cloudflare-v2txt"
set +a
ZONE="${CF_ZONE_V2TXT:-8fefd51284e4eee1488f82e9a25205f0}"
BASE="${BASE_URL:-https://app.v2txt.cn}"
curl -sS -m 30 -X POST \
  -H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json" \
  --data "{\"files\":[\"$BASE/e/ent2\",\"$BASE/app\",\"$BASE/login\",\"$BASE/home\",\"$BASE/feishu-callback\"]}" \
  "https://api.cloudflare.com/client/v4/zones/$ZONE/purge_cache" \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print("purge:", "ok" if d.get("success") else d.get("errors"))'
