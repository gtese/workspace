"""备份数据库与录音文件。

用法（backend 目录）：
  ../.venv/bin/python scripts/backup.py                    # 备份到 ../backups
  ../.venv/bin/python scripts/backup.py --out /data/bak --keep 14
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.maintenance import backup  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description="备份 feishu-minutes 的数据库与音频")
    ap.add_argument("--out", type=Path, default=None, help="输出目录，默认 <项目>/backups")
    ap.add_argument("--keep", type=int, default=7, help="保留最近几份")
    args = ap.parse_args()
    archive = backup(args.out, args.keep)
    print(archive)
    print(f"大小 {archive.stat().st_size / 1048576:.1f} MB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
