#!/bin/bash
# 探测 Open WebUI 上每个模型 id 是否真的可用（来自 /api/models 的列表）。
# 用法: ./check-owui-models.sh [env文件]
#   默认读取 /eda/apps/deepseek/etc/dsh.env（DSH 共享配置）
set -uo pipefail
ENV_FILE="${1:-/eda/apps/deepseek/etc/dsh.env}"
[ -f "$ENV_FILE" ] && . "$ENV_FILE"
: "${DEEPSEEK_BASE_URL:?需要 DEEPSEEK_BASE_URL}"
: "${DEEPSEEK_API_KEY:?需要 DEEPSEEK_API_KEY}"
BASE="${DEEPSEEK_BASE_URL%/}"
FAIL=0

MODELS="$(curl -s -m 15 "$BASE/models" -H "Authorization: Bearer $DEEPSEEK_API_KEY" \
  | python3 -c 'import sys,json
try:
  print("\n".join(m["id"] for m in json.load(sys.stdin).get("data",[])))
except Exception:
  pass')"
[ -n "$MODELS" ] || { echo "无法获取模型列表：$BASE/models"; exit 1; }

while IFS= read -r m; do
  [ -z "$m" ] && continue
  BODY="$(mktemp)"
  CODE="$(curl -s -m 60 -o "$BODY" -w '%{http_code}' "$BASE/v1/messages" \
    -H "x-api-key: $DEEPSEEK_API_KEY" -H 'content-type: application/json' \
    -d "{\"model\":$(python3 -c 'import json,sys;print(json.dumps(sys.argv[1]))' "$m"),\"max_tokens\":512,\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}]}")"
  CONTENT_TYPE="$(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print("content" if d.get("content") else "empty")' "$BODY" 2>/dev/null || echo bad-json)"
  if [ "$CODE" = "200" ] && [ "$CONTENT_TYPE" = "content" ]; then
    echo "OK    $m"
  elif [ "$CODE" = "200" ]; then
    echo "WARN  $m  (HTTP 200 但内容为空：$CONTENT_TYPE)"
  else
    FAIL=1
    echo "FAIL  $m  (HTTP $CODE: $(head -c 200 "$BODY"))"
  fi
  rm -f "$BODY"
done <<< "$MODELS"

exit "$FAIL"
