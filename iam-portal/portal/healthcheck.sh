#!/usr/bin/env bash
# 门户健康巡检（由 /etc/cron.d/tri-portal-health 每 5 分钟调用，只写异常）
set -u
code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${HOST_PORT:-8095}/healthz || echo 000)
if [ "$code" != "200" ]; then
  echo "$(date '+%F %T') WARN portal healthz=$code"
fi
