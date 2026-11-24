#!/bin/sh
set -e

: "${FM_DATA_DIR:=/app/data}"
mkdir -p "$FM_DATA_DIR/recordings" "$FM_DATA_DIR/outbox"

# 可选：等待 Postgres 就绪（仅当显式配置了 postgres 连接）
if echo "${FM_DATABASE_URL:-}" | grep -q '^postgresql'; then
  python - <<'PY'
import os, time
import sqlalchemy
url = os.environ["FM_DATABASE_URL"]
for i in range(60):
    try:
        sqlalchemy.create_engine(url, pool_pre_ping=True).connect().close()
        print("database ready")
        break
    except Exception as exc:
        print("waiting for database...", exc)
        time.sleep(2)
else:
    raise SystemExit("database not ready")
PY
fi

exec "$@"
