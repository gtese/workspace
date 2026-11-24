"""定时清理：30 天前的音频、孤儿目录。

cron 示例（每天 04:00）：
0 4 * * * cd /opt/feishu-minutes/backend && ../.venv/bin/python scripts/cleanup.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import get_settings  # noqa: E402
from app.maintenance import cleanup_expired, cleanup_orphan_files  # noqa: E402


def main() -> int:
    days = get_settings().retention_days
    removed = cleanup_expired(days)
    orphans = cleanup_orphan_files(1)
    print(f"清理完成: 过期音频 {removed} 条（>{days} 天）, 孤儿目录 {orphans} 个")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
