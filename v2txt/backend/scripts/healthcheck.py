"""运维探活：输出 JSON 快照，异常退出码 1（可配 cron/监控）。

用法：../.venv/bin/python scripts/healthcheck.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.monitoring import snapshot  # noqa: E402


def main() -> int:
    s = snapshot()
    print(json.dumps(s, ensure_ascii=False, indent=2))
    ok = s.get("db_ok") and (s.get("disk_free_gb") is None or s["disk_free_gb"] >= 5)
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
